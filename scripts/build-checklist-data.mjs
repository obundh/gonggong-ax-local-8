import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checklistPath = resolve(projectRoot, 'FORENSIC_READINESS_CHECKLIST.md');
const outputPath = resolve(projectRoot, 'ui', 'checklist-data.mjs');

const F04_ATTENTION =
  '2026-09-20 실기기 독립 감사에서 네이티브 저널 읽기가 JOURNAL_READ_FAILED(“매개 변수가 틀립니다”)로 0바이트에서 중단됐다. 후보 0개는 삭제 흔적이 없다는 증거가 아니며 실패 원인은 확정되지 않았다.';

const cleanInlineMarkdown = value => value
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/\*\*/g, '')
  .trim();

export function parseChecklist(markdown) {
  const headingPattern = /^## (\d+)단계 — (.+)$/gm;
  const headings = [...markdown.matchAll(headingPattern)];
  const stages = headings.map((heading, index) => {
    const id = Number(heading[1]);
    const sectionStart = heading.index + heading[0].length;
    const sectionEnd = headings[index + 1]?.index ?? markdown.length;
    const section = markdown.slice(sectionStart, sectionEnd);
    const status = section.match(/^현재 상태:\s*(.+)$/m)?.[1];
    const pass = section.match(/^단계 통과:\s*(.+)$/m)?.[1];
    const items = [...section.matchAll(
      /^- \[([ xX])\] \*\*([FR]\d{2}) ([^*]+?)\.\*\*\s+(.+)$/gm,
    )].map(match => ({
      id: match[2],
      title: match[3].trim(),
      description: cleanInlineMarkdown(match[4]),
      accepted: match[1].toLowerCase() === 'x',
      ...(match[4].match(/진행 판정: ([^.]+)\./) ? { disposition: match[4].match(/진행 판정: ([^.]+)\./)[1] } : {}),
      ...(match[4].match(/재개 조건: (.+)$/) ? { resumeCondition: match[4].match(/재개 조건: (.+)$/)[1] } : {}),
      ...(match[2] === 'F04' ? { attention: F04_ATTENTION } : {}),
    }));

    const description = [status, pass && `단계 통과: ${pass}`]
      .filter(Boolean)
      .map(cleanInlineMarkdown)
      .join(' ');

    return {
      id,
      title: heading[2].trim(),
      description,
      conditional: id === 10,
      items,
    };
  });

  const items = stages.flatMap(stage => stage.items);
  const requiredItems = items.filter(item => item.id.startsWith('F'));
  const conditionalItems = items.filter(item => item.id.startsWith('R'));
  const acceptedItems = requiredItems.filter(item => item.accepted);

  if (stages.length !== 10) throw new Error(`Expected 10 stages, found ${stages.length}`);
  if (requiredItems.length !== 54) throw new Error(`Expected 54 required items, found ${requiredItems.length}`);
  if (conditionalItems.length !== 6) throw new Error(`Expected 6 research items, found ${conditionalItems.length}`);
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Duplicate checklist IDs');

  return {
    checklistStages: stages,
    checklistMeta: {
      required: 54,
      accepted: acceptedItems.length,
      conditional: 6,
      asOf: '2026-09-27',
      note: '체크는 체크리스트 문서에 기록된 항목별 인수 증거를 뜻하며, 실제 삭제 파일 복구율을 뜻하지 않는다. F04는 2026-09-20 실기기 감사의 저널 읽기 오류를 함께 확인해야 한다.',
    },
  };
}

export function renderChecklistModule(markdown) {
  const { checklistStages, checklistMeta } = parseChecklist(markdown);
  return [
    '// Generated from FORENSIC_READINESS_CHECKLIST.md by scripts/build-checklist-data.mjs.',
    '// Run `node scripts/build-checklist-data.mjs` after changing the canonical checklist.',
    '',
    `export const checklistStages = ${JSON.stringify(checklistStages, null, 2)};`,
    '',
    `export const checklistMeta = ${JSON.stringify(checklistMeta, null, 2)};`,
    '',
  ].join('\n');
}

async function main() {
  const markdown = await readFile(checklistPath, 'utf8');
  await writeFile(outputPath, renderChecklistModule(markdown), 'utf8');
  process.stdout.write(`Wrote ${outputPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
