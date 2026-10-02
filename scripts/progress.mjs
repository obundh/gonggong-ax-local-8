import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = path.join(root, 'progress.json');
const output = path.join(root, 'BUILD_CHECKLIST.md');
const allowed = new Set(['pending', 'in_progress', 'done']);
const phaseInfo = {
  A: ['A. 이미지 기반 NTFS 기초', 'NTFS 볼륨·파티션 이미지와 검증된 공급자를 읽기 전용으로 분석한다.'],
  B: ['B. 실제 Windows 장치와 별도 출력', '실제 장치의 읽기 전용 접근과 원본과 다른 물리 장치 출력의 안전 조건을 연결한다.'],
  C: ['C. 안내 GUI와 일반 이름 검색', '버튼형 안내, 후보·미리보기, 현재 남은 파일의 이름 검색을 연결한다.'],
  D: ['D. 카빙', '기록 없는 영역에서 제한한 형식만 추출하고 임시 출력을 관리한다.'],
  E: ['E. 파일명 임베딩과 백업', '선택적 의미 검색과 지원 앱의 자동 저장·백업 경로를 더한다.'],
  F: ['F. 파일시스템·고급 복구 확대', '다른 파일시스템 및 확인된 복잡 속성·다중 구간 복구를 확대한다.']
};
const firstMilestone = new Set([
  ...Array.from({ length: 11 }, (_, n) => `NT-${String(n + 1).padStart(2, '0')}`),
  'OUT-04', 'OUT-06', 'OUT-07', 'OUT-08', 'OUT-13'
]);

function phaseFor(id) {
  if (/^NT-(12|13)$/.test(id)) return 'F';
  if (id.startsWith('NT-')) return 'A';
  if (id.startsWith('OUT-')) return 'B';
  if (id.startsWith('DP-')) return 'D';
  if (id === 'SYS-06' || /^CP-(0[7-9]|10)$/.test(id)) return 'E';
  return 'C';
}

function fail(message) {
  console.error(`progress 검증 실패: ${message}`);
  process.exitCode = 1;
}

const data = JSON.parse(fs.readFileSync(source, 'utf8'));
const blueprint = fs.readFileSync(path.join(root, 'BLUEPRINT.md'), 'utf8');
const blueprintIds = new Set([...blueprint.matchAll(/^\| ((?:UI|IN|NT|DP|CP|CA|OUT|JOB|SYS)-\d{2}) \|/gm)].map(match => match[1]));
const seen = new Set();
const features = [];
for (const group of data.groups ?? []) {
  for (const row of group.features ?? []) {
    const [id, text, stage] = row;
    if (!/^((UI|IN|NT|DP|CP|CA|OUT|JOB|SYS)-\d{2})$/.test(id ?? '')) fail(`잘못된 ID: ${id}`);
    if (seen.has(id)) fail(`중복 ID: ${id}`);
    seen.add(id);
    if (!text || !stage) fail(`${id}의 기능 설명 또는 단계가 비어 있습니다.`);
    const override = data.progress?.[id] ?? {};
    const status = override.status ?? (firstMilestone.has(id) ? 'in_progress' : data.defaultStatus);
    const evidence = override.evidence ?? '';
    if (!allowed.has(status)) fail(`${id}의 허용되지 않은 상태: ${status}`);
    if (status === 'done' && !String(evidence).trim()) fail(`${id}는 done인데 evidence가 없습니다.`);
    features.push({ id, text, stage, group: group.title, phase: phaseFor(id), status, evidence });
  }
}
if (features.length !== data.baselineTotal) fail(`고정 분모 ${data.baselineTotal}와 기능 수 ${features.length}가 다릅니다. 범위 변경을 명시적으로 기록하세요.`);
if (features.length !== blueprintIds.size || features.some(feature => !blueprintIds.has(feature.id))) fail('BLUEPRINT.md와 진행표의 기능 ID가 다릅니다.');
for (const id of Object.keys(data.progress ?? {})) if (!seen.has(id)) fail(`진행 상태에 알 수 없는 ID가 있습니다: ${id}`);
if (process.exitCode) process.exit();

const done = features.filter((feature) => feature.status === 'done').length;
const total = features.length;
const percent = total ? Math.floor((done / total) * 1000) / 10 : 0;
const percentText = `${percent.toFixed(1)}%`;
const byPhase = Object.fromEntries(Object.keys(phaseInfo).map((id) => [id, features.filter((feature) => feature.phase === id)]));
const statusLabel = { pending: '대기', in_progress: '진행 중', done: '완료' };

function markdown() {
  const lines = [
    '# RecoveryChat.GUI 개발 체크리스트',
    '',
    `**개발 진행률: ${done}/${total} (${percentText})**`,
    '',
    '이 수치는 BLUEPRINT 기능표의 모든 항목을 같은 비중으로 계산한 완료 기능 수이다. 조건부 항목도 기본 분모에 포함한다. 제외 항목은 기능표에 없으므로 분모에 넣지 않는다. 시간 추정이나 파일 복구 성공 확률이 아니다.',
    '',
    '## 현재 마일스톤',
    '',
    `- **${data.currentMilestone.title}** — ${data.currentMilestone.supports}`,
    `- 상태: ${statusLabel[data.currentMilestone.status] ?? data.currentMilestone.status}`,
    `- 다음: ${data.currentMilestone.next}`,
    `- 주의: ${data.currentMilestone.completionWarning}`,
    '',
    '## 단계 순서',
    ''
  ];
  for (const phase of Object.keys(phaseInfo)) {
    const rows = byPhase[phase];
    const phaseDone = rows.filter((row) => row.status === 'done').length;
    lines.push(`${Object.keys(phaseInfo).indexOf(phase) + 1}. **${phaseInfo[phase][0]}** — ${phaseInfo[phase][1]} (${phaseDone}/${rows.length})`);
  }
  for (const phase of Object.keys(phaseInfo)) {
    lines.push('', `## ${phaseInfo[phase][0]}`, '', '| ID | 기능 | 단계 | 상태 | 증거 |', '| --- | --- | --- | --- | --- |');
    for (const feature of byPhase[phase]) {
      lines.push(`| ${feature.id} | ${feature.text} | ${feature.stage} | ${statusLabel[feature.status]} | ${feature.evidence || '—'} |`);
    }
  }
  lines.push('', '## 갱신 방법', '', '`node scripts/progress.mjs --write`로 이 파일을 다시 만듭니다. `progress.json`에서 각 ID의 `status`를 `pending`, `in_progress`, `done` 중 하나로 지정하고, `done`에는 재현 가능한 시험·검토 증거를 `evidence`에 기록합니다.', '');
  return lines.join('\n');
}

if (process.argv.includes('--write')) {
  fs.writeFileSync(output, markdown(), 'utf8');
  console.log(`BUILD_CHECKLIST.md 생성: ${done}/${total} (${percentText})`);
} else {
  console.log(`개발 진행률: ${done}/${total} (${percentText}) — 완료 기능 수 기준이며 시간 추정·복구 성공 확률이 아닙니다.`);
  console.log(`현재: ${data.currentMilestone.title}; 정확한 지원 범위와 미확인 사항은 SUPPORT.md와 체크리스트를 따릅니다.`);
}
