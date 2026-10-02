// Engine-only child. Arguments contain no expected names, hashes, offsets or IDs.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

const [engineRootArg, imageArg, mode, outputArg] = process.argv.slice(2);
if (!engineRootArg || !imageArg || !['metadata','deep','deep-whole'].includes(mode) || !outputArg) throw Error('Invalid worker arguments');
const engineRoot = path.resolve(engineRootArg), image = path.resolve(imageArg), output = path.resolve(outputArg);
const moduleUrl = name => pathToFileURL(path.join(engineRoot, 'engine', name)).href;
const { openImageBytes } = await import(moduleUrl('byte-source.mjs'));
const { discoverVolumes, openPartitionBytes, getUnallocatedRanges } = await import(moduleUrl('volume-layout.mjs'));
const { openNtfsProvider } = await import(moduleUrl('ntfs-image.mjs'));
const { carveFiles } = await import(moduleUrl('carving.mjs'));
const hashFile = async file => { const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex'); };
await mkdir(output, {recursive:true});
const outputs = [], errors = [], scans = [], candidates = [];
const started = Date.now();
let reader;
const maxOutputs = 500;
try {
  reader = await openImageBytes(image);
  const layout = mode === 'deep-whole' ? null : await discoverVolumes(reader);
  if (mode === 'metadata') {
    if (!layout.complete || !layout.volumes.length) throw Error('No complete supported layout');
    for (const partition of layout.volumes) {
      if (partition.bootKind !== 'NTFS') throw Error('Qualification currently supports NTFS metadata only');
      const engine = await openNtfsProvider(openPartitionBytes(reader, partition));
      try {
        const scan = await engine.scanDeleted();
        scans.push({partitionId:partition.id, ...scan, candidates:undefined});
        for (const candidate of scan.candidates) {
          candidates.push({...candidate, partitionId:partition.id});
          if (candidate.status !== 'readable') continue;
          if (outputs.length >= maxOutputs) throw Error('Qualification output limit reached; incomplete trial');
          try {
            const result = await engine.recover(candidate.recordNumber, output);
            outputs.push({candidateId:candidate.id, name:candidate.name, recordNumber:candidate.recordNumber,
              path:result.path, size:(await stat(result.path)).size, sha256:await hashFile(result.path),
              originalIdentityVerified:result.originalIdentityVerified === true || result.outcome?.originalBytesVerified === true, result});
          } catch(error) { errors.push({candidateId:candidate.id, recordNumber:candidate.recordNumber, code:error.code, message:error.message}); }
        }
      } finally { await engine.close(); }
    }
  } else {
    if (mode !== 'deep-whole' && (!layout.complete || !layout.volumes.length)) throw Error('Verified unallocated range unavailable');
    const ranges = [];
    for (const partition of layout?.volumes ?? []) {
      const child = openPartitionBytes(reader, partition);
      try {
        const allocation = await getUnallocatedRanges(child);
        if (!allocation.supported || !allocation.complete) throw Error('Unallocated range incomplete');
        ranges.push(...allocation.ranges.map(r=>({offset:partition.offset+r.offset,length:r.length})));
      } finally { await child.close(); }
    }
    const scan = ranges.length || mode === 'deep-whole' ? await carveFiles(reader, output, {ranges:mode==='deep-whole'?undefined:ranges, maxCandidates:maxOutputs})
      : {candidates:[], complete:true, warnings:[], stats:{bytesRead:0,bytesTotal:0}};
    if (scan.truncated) throw Error('Qualification carving limit reached; incomplete trial');
    scans.push({...scan,candidates:undefined}); candidates.push(...scan.candidates);
    for (const candidate of scan.candidates) outputs.push({candidateId:candidate.id,name:candidate.name,
      path:candidate.path,size:(await stat(candidate.path)).size,sha256:await hashFile(candidate.path),
      originalIdentityVerified:candidate.originalIdentityVerified === true,status:candidate.status,nameIsGenerated:true});
  }
  const transcript = {mode,image,engineRoot,startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),
    elapsedMs:Date.now()-started,engineInput:'image and mode only; no oracle supplied',status:'completed',
    discoveryComplete:scans.every(s=>s.complete),scans,candidates,outputs,errors};
  await writeFile(path.join(output,'result.json'),JSON.stringify(transcript,(_k,v)=>typeof v==='bigint'?v.toString():v,2),{flag:'wx'});
  console.log(JSON.stringify({mode,candidates:candidates.length,outputs:outputs.length,errors:errors.length,elapsedMs:transcript.elapsedMs}));
} catch(error) {
  await writeFile(path.join(output,'worker-error.json'),JSON.stringify({mode,image,error:{code:error.code,message:error.message},outputs,errors},null,2),{flag:'wx'});
  throw error;
} finally { await reader?.close(); }
