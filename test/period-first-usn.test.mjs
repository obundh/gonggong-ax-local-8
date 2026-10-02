import assert from 'node:assert/strict';
import test from 'node:test';
import { readUsnDeletionEvents } from '../engine/usn-journal.mjs';
import { journalRecords, usnRecord } from './usn-fixture.mjs';

const start='2026-09-12T00:00:00.000Z',end='2026-09-12T23:59:59.999Z';
const parse=(bytes,options={})=>readUsnDeletionEvents({read:async(offset,length)=>bytes.subarray(offset,offset+length),ranges:[{offset:0,length:bytes.length}],deletedAfter:start,deletedBefore:end,...options});

test('period USN bounds include both endpoints and latest identity timestamp is chosen before filtering',async()=>{
  const bytes=journalRecords([
    usnRecord({recordNumber:24,deletedAt:'2026-09-13T00:00:00.000Z'}),
    usnRecord({recordNumber:24,deletedAt:start}),
    usnRecord({recordNumber:25,deletedAt:start}),
    usnRecord({recordNumber:26,deletedAt:end}),
    usnRecord({recordNumber:27,deletedAt:'2026-09-11T23:59:59.999Z'}),
    usnRecord({recordNumber:28,deletedAt:start,reason:0x100}),
  ]);
  const result=await parse(bytes);
  assert.deepEqual(result.events.map(event=>event.recordNumber),[26,25]);
  assert.equal(result.complete,true);
  assert.equal(result.stats.journalRecordsRead,6);
  await assert.rejects(parse(bytes,{deletedAfter:end,deletedBefore:start}),{code:'INVALID_DATE_RANGE'});
});

test('period USN identity includes generation and full parent reference',async()=>{
  const wrongParent=usnRecord({deletedAt:end});wrongParent.writeBigUInt64LE(5n|2n<<48n,16);
  const bytes=journalRecords([usnRecord({deletedAt:start,sequence:6}),usnRecord({deletedAt:start,sequence:7}),wrongParent]);
  const result=await parse(bytes);
  assert.equal(result.events.length,3);
  assert.equal(new Set(result.events.map(event=>event.sequence+':'+event.parent.sequence)).size,3);
});

test('period USN skips sparse prefixes and reports bounded tail coverage',async()=>{
  const base=2**30,first=usnRecord({recordNumber:24,deletedAt:start}),last=usnRecord({recordNumber:25,deletedAt:end});
  const bytes=journalRecords([first,last],base),reads=[];
  const result=await parse(bytes,{ranges:[{offset:base,length:bytes.length}],maxBytes:last.length,
    read:async(offset,length)=>{reads.push([offset,length]);return bytes.subarray(offset-base,offset-base+length);}});
  assert.deepEqual(reads,[[base+first.length,last.length]]);
  assert.deepEqual(result.events.map(event=>event.recordNumber),[25]);
  assert.equal(result.complete,false);assert.equal(result.truncated,true);
  assert.ok(result.warnings.some(item=>item.code==='USN_RANGE_LIMIT'));
});

test('period USN caps records/events and honors cancellation without treating a partial pass as complete',async()=>{
  const bytes=journalRecords([usnRecord({recordNumber:24,deletedAt:start}),usnRecord({recordNumber:25,deletedAt:end})]);
  for(const limits of [{maxRecords:1},{maxEvents:1}]){
    const result=await parse(bytes,limits);assert.equal(result.complete,false);assert.equal(result.truncated,true);assert.equal(result.events.length,1);
  }
  const controller=new AbortController();
  await assert.rejects(parse(bytes,{signal:controller.signal,control:{checkpoint:async()=>controller.abort()}}),{code:'CANCELLED'});
});

test('period USN rejects unsupported/truncated records and handles a valid cross-chunk record once',async()=>{
  const malformed=journalRecords([usnRecord({deletedAt:start,major:3}),usnRecord({deletedAt:start})]);
  const bad=await parse(malformed.subarray(0,malformed.length-7));
  assert.equal(bad.events.length,0);assert.equal(bad.complete,false);
  const prefix=Buffer.alloc(1024*1024-40),record=usnRecord({deletedAt:start,usn:prefix.length});
  const good=await parse(Buffer.concat([prefix,record]));
  assert.equal(good.events.length,1);assert.equal(good.stats.journalRecordsRead,1);
});
