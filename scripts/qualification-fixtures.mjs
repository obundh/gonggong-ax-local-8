// Fixture construction has access to originals. The separate engine worker does not.
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createFixture, fixtureGeometry as g, fixturePrimitives as p } from '../test/ntfs-fixtures.mjs';

const documents = JSON.parse(await readFile(process.argv[2], 'utf8'));
const root = path.resolve(process.argv[3]);
await mkdir(root); await mkdir(path.join(root, 'inputs')); await mkdir(path.join(root, 'oracle'));
const template = await createFixture(path.join(root, 'template'));
const originalImage = await readFile(template.imagePath);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const plans = [], cases = [];
const mftOffset = g.mftLcn * g.clusterSize;
const recordOffset = number => mftOffset + number * g.fileRecordSize;
const payloads = new Map();
for (const file of documents.files) {
  const bytes = await readFile(file.path);
  if (bytes.length !== file.size || sha(bytes) !== file.sha256) throw Error('Document manifest changed');
  payloads.set(file.id, bytes);
}
for (const cohort of ['development', 'evaluation']) {
  for (const layout of ['contiguous', 'fragmented', 'record-reused', 'header-overwritten', 'body-zero']) {
    const id = `${cohort}-${layout}`;
    const image = Buffer.from(originalImage);
    const originals = documents.files.filter(file => file.cohort === cohort);
    const targets = [];
    let cluster = 128;
    const putRecord = (number, record) => record.copy(image, recordOffset(number));
    // Two real directory records give repeated basenames distinct parent identities.
    for (const number of [43, 44]) putRecord(number, p.makeFileRecord({recordNumber: number, active: true,
      directory: true, name: number === 43 ? '첫번째_폴더' : '두번째_폴더'}));
    for (let index = 0; index < originals.length; index++) {
      const file = originals[index], bytes = payloads.get(file.id);
      const number = 45 + index, parent = file.level === 'medium' ? 44 : 43;
      const resident = bytes.length <= 128;
      const changed = Buffer.from(bytes);
      if (layout === 'body-zero') changed.fill(0);
      if (layout === 'header-overwritten') changed.fill(0xa5, 0, Math.min(128, changed.length));
      const runs = [];
      if (!resident) {
        const clusters = Math.ceil(bytes.length / g.clusterSize);
        const first = layout === 'fragmented' && clusters > 1 ? Math.ceil(clusters / 2) : clusters;
        runs.push({lcn: cluster, clusters: first}); cluster += first;
        if (first < clusters) {
          image.fill(0xa5, cluster * g.clusterSize, (cluster + 1) * g.clusterSize); cluster++;
          runs.push({lcn: cluster, clusters: clusters - first}); cluster += clusters - first;
        }
        if (cluster >= g.totalClusters - 1) throw Error('Fixture geometry exceeded');
        let position = 0;
        for (const run of runs) {
          const length = Math.min(changed.length - position, run.clusters * g.clusterSize);
          changed.copy(image, run.lcn * g.clusterSize, position, position + length); position += length;
        }
      }
      const attributes = [resident ? p.residentAttribute(0x80, changed, 2)
        : p.nonresidentAttribute(0x80, runs, bytes.length, 2)];
      putRecord(number, layout === 'record-reused'
        ? p.makeFileRecord({recordNumber: number, sequence: 8, active: true, name: `new-owner-${number}.bin`,
          attributes: [p.residentAttribute(0x80, Buffer.from(`Unrelated current owner ${number}`), 2)]})
        : p.makeFileRecord({recordNumber: number, sequence: 2, name: file.name, parentRecord: parent, attributes}));
      targets.push({id: file.id, name: file.name, originalPath: `${parent === 43 ? '첫번째_폴더' : '두번째_폴더'}/${file.name}`,
        kind: file.kind, level: file.level, size: file.size, sha256: file.sha256,
        recordNumber: number, resident, runs, originalFile: file.path,
        expected: {
          bodyIntact: !['header-overwritten', 'body-zero'].includes(layout),
          metadataExact: ['contiguous', 'fragmented'].includes(layout),
          deepExact: !resident && file.kind !== 'txt' && !['header-overwritten', 'body-zero'].includes(layout) && runs.length === 1,
          metadataAbsent: layout === 'record-reused',
          explanation: layout === 'record-reused' ? 'Old record overwritten, external content survives without original name'
            : layout === 'fragmented' ? 'Metadata describes separated extents; contiguous carving cannot reassemble them'
              : ['header-overwritten','body-zero'].includes(layout) ? 'Negative control: changed body is not the original'
                : 'Intact content and metadata; no USN journal exists in this synthetic fixture'
        }});
    }
    // Replace the MFT allocation bitmap after directory/current-owner records change.
    const bitmap = Buffer.alloc(g.mftRecordCount / 8);
    for (let n = 0; n < g.mftRecordCount; n++) {
      const off = recordOffset(n);
      if (image.toString('ascii', off, off + 4) === 'FILE' && (image.readUInt16LE(off + 22) & 1)) p.setBitmapBit(bitmap, n);
    }
    putRecord(0, p.makeFileRecord({recordNumber: 0, active: true, name: '$MFT', attributes: [
      p.nonresidentAttribute(0x80, [{lcn:g.mftLcn, clusters:g.mftRecordCount*g.fileRecordSize/g.clusterSize}], g.mftRecordCount*g.fileRecordSize, 2),
      p.residentAttribute(0xb0, bitmap, 3)]}));
    const input = path.join(root, 'inputs', `${id}.img`);
    const handle = await open(input, 'wx');
    try { await handle.writeFile(image); await handle.sync(); } finally { await handle.close(); }
    if (sha(await readFile(input)) !== sha(image)) throw Error('Fixture readback failed');
    plans.push({id, cohort, input, inputSha256:sha(image), size:image.length, modes:['metadata','deep']});
    cases.push({id, cohort, layout, synthetic:true, targets, sourceSha256:sha(image),
      limits:['Fabricated NTFS image, not a real deletion or SSD/TRIM trial',
        'Background parser fixtures intentionally include corrupt and unsupported records',
        'No original names, positions or hashes are passed to engine execution']});
  }
}
await writeFile(path.join(root, 'plan.json'), JSON.stringify({version:1, cases:plans},null,2), {flag:'wx'});
await writeFile(path.join(root, 'oracle', 'answers.json'), JSON.stringify({version:1, cases},null,2), {flag:'wx'});
console.log(JSON.stringify({root,images:plans.length,targets:cases.reduce((n,c)=>n+c.targets.length,0)}));
