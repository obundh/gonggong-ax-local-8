import test from 'node:test';
import assert from 'node:assert/strict';
import { previewHwp } from '../engine/hwp-preview.mjs';
const END = 0xfffffffe, FREE = 0xffffffff;
function fixture() {
  const b = Buffer.alloc(2560); Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(b);
  b.writeUInt16LE(3,26); b.writeUInt16LE(0xfffe,28); b.writeUInt16LE(9,30); b.writeUInt16LE(6,32); b.writeUInt32LE(1,44); b.writeUInt32LE(1,48); b.writeUInt32LE(4096,56); b.writeUInt32LE(2,60); b.writeUInt32LE(1,64); b.writeUInt32LE(END,68);
  for (let at=76;at<512;at+=4)b.writeUInt32LE(FREE,at); b.writeUInt32LE(0,76);
  for(let at=512;at<1024;at+=4)b.writeUInt32LE(FREE,at); b.writeUInt32LE(0xfffffffd,512); for(let i=1;i<=3;i++)b.writeUInt32LE(END,512+i*4);
  const text=Buffer.from('분기 예산 보고서\r\n확인용 미리보기', 'utf16le');
  function entry(index,name,type,first,size,right=FREE,child=FREE){const at=1024+index*128;Buffer.from(name+'\0','utf16le').copy(b,at);b.writeUInt16LE((name.length+1)*2,at+64);b[at+66]=type;b[at+67]=1;b.writeUInt32LE(FREE,at+68);b.writeUInt32LE(right,at+72);b.writeUInt32LE(child,at+76);b.writeUInt32LE(first,at+116);b.writeBigUInt64LE(BigInt(size),at+120);}
  entry(0,'Root Entry',5,3,512,FREE,1);entry(1,'FileHeader',2,0,256,2);entry(2,'PrvText',2,4,text.length);
  for(let at=1536;at<2048;at+=4)b.writeUInt32LE(FREE,at);for(let i=0;i<3;i++)b.writeUInt32LE(i+1,1536+i*4);b.writeUInt32LE(END,1548);b.writeUInt32LE(END,1552);
  Buffer.from('HWP Document File','ascii').copy(b,2048);b[2048+35]=5;text.copy(b,2304);return b;
}
test('reads only bounded HWP 5 preview text through FAT and miniFAT',()=>{const r=previewHwp(fixture());assert.equal(r.type,'text');assert.match(r.text,/분기 예산 보고서/);assert.equal(r.truncated,true);assert.equal(r.validation.originalIdentityVerified,false);});
test('rejects protected documents, cyclic allocation, missing preview, and out-of-range directory',()=>{let b=fixture();b.writeUInt32LE(2,2084);assert.equal(previewHwp(b).reason,'HWP_PROTECTED_DOCUMENT');b=fixture();b.writeUInt32LE(0,1536);assert.equal(previewHwp(b).type,'unsupported');b=fixture();b[1024+256+66]=0;assert.equal(previewHwp(b).type,'unsupported');b=fixture();b.writeUInt32LE(9000,48);assert.equal(previewHwp(b).type,'unsupported');});
