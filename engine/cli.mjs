#!/usr/bin/env node
import { openNtfsImage } from './ntfs-image.mjs';

const usage = `파일 복구 엔진 · NTFS 볼륨 이미지 전용

검색: node engine/cli.mjs scan --image <볼륨.img>
복구: node engine/cli.mjs recover --image <볼륨.img> --record <번호> --destination <폴더>

현재 실제 드라이브와 전체 디스크 이미지는 지원하지 않습니다.
검색 결과는 JSON, 진행 상황은 stderr에 출력합니다. Ctrl+C로 취소할 수 있습니다.
복구 대상 폴더는 현재 하드 링크를 지원하는 파일시스템(예: NTFS)이 필요합니다.
복구본의 해시는 저장 데이터의 식별값이며 삭제 전 원본과 동일하다는 증거가 아닙니다.`;

function argumentsOf(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { command: 'help' };
  if (!['scan', 'recover'].includes(command)) throw new Error('scan 또는 recover 명령을 지정해주세요.');
  const result = { command };
  const allowed = new Set(command === 'scan' ? ['image'] : ['image', 'record', 'destination']);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!allowed.has(key) || !rest[i + 1] || Object.hasOwn(result, key)) throw new Error(`잘못되거나 중복된 옵션: ${rest[i]}`);
    result[key] = rest[i + 1];
  }
  if (!result.image) throw new Error('--image가 필요해요.');
  if (command === 'recover') {
    if (!/^\d+$/.test(result.record ?? '') || !Number.isSafeInteger(Number(result.record))) throw new Error('--record에는 파일 기록 번호를 입력해주세요.');
    if (!result.destination) throw new Error('--destination이 필요해요.');
    result.record = Number(result.record);
  }
  return result;
}

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
let image;
try {
  const options = argumentsOf(process.argv.slice(2));
  if (options.command === 'help') process.stdout.write(`${usage}\n`);
  else {
    image = await openNtfsImage(options.image);
    let lastProgress = 0;
    const onProgress = event => {
      const now = Date.now();
      const finished = event.stage === 'scan' ? event.recordsRead === event.recordsTotal : event.bytesWritten === event.bytesTotal;
      if (now - lastProgress >= 500 || finished) {
        process.stderr.write(`${JSON.stringify({ type: 'progress', ...event })}\n`);
        lastProgress = now;
      }
    };
    const scan = await image.scanDeleted({ signal: controller.signal, onProgress });
    if (options.command === 'scan') {
      process.stdout.write(`${JSON.stringify({ info: image.info, ...scan }, null, 2)}\n`);
    } else {
      const result = await image.recover(options.record, options.destination, { signal: controller.signal, onProgress });
      process.stdout.write(`${JSON.stringify({ info: image.info, ...result }, null, 2)}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ type: 'error', code: error.code ?? 'INVALID_ARGUMENT', message: error.message, details: error.details ?? {} })}\n`);
  process.exitCode = error.code === 'CANCELLED' ? 130 : 1;
} finally {
  if (image) await image.close();
}
