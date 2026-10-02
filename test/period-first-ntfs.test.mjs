import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { openNtfsImage,openNtfsProvider } from '../engine/ntfs-image.mjs';
import { createFixture } from './ntfs-fixtures.mjs';
import { createUsnFixture,createLargeMftUsnFixture,createSparseHugeMftProviderFixture,journalRecords,usnRecord } from './usn-fixture.mjs';

const period={deletedAfter:'2026-09-12T00:00:00.000Z',deletedBefore:'2026-09-13T23:59:59.999Z'};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixtureCase(make,run){
  const temporary=await mkdtemp(path.join(os.tmpdir(),'rc-period-ntfs-'));let engine;
  try{const fixture=await make(path.join(temporary,'fixture'));engine=await openNtfsImage(fixture.imagePath);await run(engine,fixture);}
  finally{await engine?.close();assert.equal(path.dirname(path.resolve(temporary)).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());assert.ok(path.basename(temporary).startsWith('rc-period-ntfs-'));await rm(temporary,{recursive:true,force:true});}
}

test('period lookup resolves a journal beyond record 4096 without scanning the MFT and supports original preview bytes',async()=>{
  await fixtureCase(createLargeMftUsnFixture,async(engine,fixture)=>{
    const before=hash(await readFile(fixture.imagePath)),calls=[],original=engine.record.bind(engine);
    engine.record=async(number,signal)=>{calls.push(number);return original(number,signal);};
    engine.scanDeleted=()=>{throw new Error('full MFT scan must not run');};
    const published=[],result=await engine.scanDeletedPeriod({...period,onCandidate:candidate=>published.push(candidate)});
    assert.equal(engine.info.recordCount,8192);
    assert.deepEqual(result.candidates.map(candidate=>candidate.id),['ntfs:24:7']);
    assert.equal(result.coverage.discoveryStrategy,'directory-index');
    assert.equal(result.coverage.allDiskComplete,false);assert.equal(result.coverage.requiresFullScan,true);
    assert.equal(result.stats.recordsTotal,1);assert.equal(result.stats.recordsRead,1);
    assert.ok(calls.includes(5000));assert.ok(calls.length<40,`unexpected MFT walk: ${calls.length} reads`);
    assert.equal(published.length,1);
    const bytes=await engine.readCandidateBytes(24,{maxBytes:8192});
    assert.match((Buffer.isBuffer(bytes)?bytes:bytes.bytes).toString('utf8'),/회복 연진 테스트 문서/);
    assert.equal(hash(await readFile(fixture.imagePath)),before);
    console.log(JSON.stringify({periodLookup:{mftRecords:8192,journalRecord:5000,targetRecords:result.stats.recordsTotal,metadataRecordReads:calls.length,fullScanCalled:false}}));
  });
});

test('period lookup follows allocated INDX nodes with USA validation',async()=>{
  await fixtureCase(dir=>createUsnFixture(dir,{indexAllocation:true}),async engine=>{
    engine.scanDeleted=()=>{throw new Error('full scan forbidden');};
    const result=await engine.scanDeletedPeriod(period);
    assert.equal(result.coverage.discoveryStrategy,'directory-index');assert.equal(result.candidates.length,2);
  });
});

test('a virtual 3.1-million-record MFT resolves one period target without a global walk',async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'rc-period-ntfs-'));let engine;
  try{
    const fixture=await createSparseHugeMftProviderFixture(path.join(temporary,'fixture'));
    engine=await openNtfsProvider(fixture.provider);
    engine.scanDeleted=()=>{throw new Error('full MFT scan must not run');};
    const result=await engine.scanDeletedPeriod(period);
    assert.equal(engine.info.recordCount,3100000);
    assert.deepEqual(result.candidates.map(candidate=>candidate.id),['ntfs:24:7']);
    assert.equal(result.coverage.discoveryStrategy,'directory-index');
    assert.equal(result.stats.recordsTotal,1);assert.equal(result.stats.recordsRead,1);
    assert.ok(fixture.reads.length<60,`unexpected volume traversal: ${fixture.reads.length} reads`);
    assert.ok(fixture.reads.some(read=>read.offset===4*4096+3000000*1024));
    console.log(JSON.stringify({virtualLargeVolume:{mftRecords:3100000,journalRecord:3000000,targetRecords:1,providerReads:fixture.reads.length,fullScanCalled:false}}));
  }finally{
    await engine?.close();
    assert.equal(path.dirname(path.resolve(temporary)).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temporary).startsWith('rc-period-ntfs-'));
    await rm(temporary,{recursive:true,force:true});
  }
});

test('period lookup rejects retained event names, parent generations, and reused file generations',async()=>{
  const wrongParent=usnRecord({sequence:6});wrongParent.writeBigUInt64LE(5n|2n<<48n,16);
  const events=journalRecords([usnRecord({sequence:6,name:'different.txt'}),wrongParent,usnRecord({sequence:7}),usnRecord({sequence:65535})],8*4096);
  await fixtureCase(dir=>createUsnFixture(dir,{journalBytes:events}),async engine=>{
    const result=await engine.scanDeletedPeriod(period);assert.equal(result.candidates.length,0);assert.equal(result.stats.recordsTotal,1);
  });
});

test('missing journal produces a partial empty search without falling back to scanDeleted',async()=>{
  await fixtureCase(createFixture,async engine=>{
    engine.scanDeleted=()=>{throw new Error('full scan forbidden');};
    const result=await engine.scanDeletedPeriod(period);
    assert.equal(result.complete,false);assert.equal(result.candidates.length,0);assert.equal(result.stats.recordsTotal,0);
    assert.equal(result.coverage.requiresFullScan,true);assert.ok(result.warnings.length>0);
  });
});

test('changed target generation after discovery discards all unpublished candidates',async()=>{
  await fixtureCase(createUsnFixture,async engine=>{
    const original=engine.record.bind(engine);let targetReads=0;
    engine.record=async(number,signal)=>{const record=await original(number,signal);if(number===24&&++targetReads===2)return {...record,fingerprint:'changed-after-selection'};return record;};
    const published=[],result=await engine.scanDeletedPeriod({...period,onCandidate:c=>published.push(c)});
    assert.equal(targetReads,2);assert.equal(result.complete,false);assert.equal(result.candidates.length,0);assert.equal(published.length,0);
    assert.equal(result.stats.candidatesFound,0);assert.equal(engine.scanned.size,0);
  });
});

test('changed journal bytes before publication cannot leak period candidates',async()=>{
  await fixtureCase(createUsnFixture,async engine=>{
    const original=engine.readStream.bind(engine);let journalReads=0;
    engine.readStream=async(stream,offset,length,signal)=>{const bytes=await original(stream,offset,length,signal);if(stream.name==='$J'&&offset===8*4096&&++journalReads===2){const changed=Buffer.from(bytes);changed[changed.length-1]^=1;return changed;}return bytes;};
    const published=[],result=await engine.scanDeletedPeriod({...period,onCandidate:c=>published.push(c)});
    assert.ok(journalReads>=2,'journal data was read and verified');assert.equal(result.complete,false);assert.equal(result.candidates.length,0);assert.equal(published.length,0);assert.equal(result.stats.candidatesFound,0);
  });
});

test('period lookup is cancellable and candidate caps remain explicit',async()=>{
  await fixtureCase(createUsnFixture,async engine=>{
    const limited=await engine.scanDeletedPeriod({...period,maxCandidates:1});
    assert.equal(limited.truncated,true);assert.equal(limited.complete,false);assert.ok(limited.candidates.length<=1);
    const controller=new AbortController();
    await assert.rejects(engine.scanDeletedPeriod({...period,signal:controller.signal,control:{checkpoint:async()=>controller.abort()}}),{code:'CANCELLED'});
    assert.equal(engine.busy,false);
  });
});
