import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { checklistMeta, checklistStages } from '../ui/checklist-data.mjs';
import { renderChecklistModule } from '../scripts/build-checklist-data.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checklistPath = resolve(projectRoot, 'FORENSIC_READINESS_CHECKLIST.md');
const modulePath = resolve(projectRoot, 'ui', 'checklist-data.mjs');

test('checklist data has the canonical 54 required and 6 conditional IDs', () => {
  assert.deepEqual(checklistStages.map(stage => stage.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  const required = checklistStages.flatMap(stage => stage.items).filter(item => item.id.startsWith('F'));
  const conditional = checklistStages.flatMap(stage => stage.items).filter(item => item.id.startsWith('R'));

  assert.deepEqual(required.map(item => item.id), Array.from({ length: 54 }, (_, i) => `F${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(conditional.map(item => item.id), Array.from({ length: 6 }, (_, i) => `R${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(required.filter(item => item.accepted).map(item => item.id), ['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F08', 'F09', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F25', 'F26', 'F48', 'F49']);
  assert.ok(conditional.every(item => !item.accepted));
  assert.ok(checklistStages.slice(0, 9).every(stage => !stage.conditional));
  assert.equal(checklistStages[9].conditional, true);
  assert.deepEqual(checklistMeta, {
    required: 54,
    accepted: 21,
    conditional: 6,
    asOf: '2026-09-27',
    note: checklistMeta.note,
  });
});

test('generated module is synchronized with the canonical checklist markdown', async () => {
  const [markdown, moduleSource] = await Promise.all([
    readFile(checklistPath, 'utf8'),
    readFile(modulePath, 'utf8'),
  ]);

  assert.equal(moduleSource, renderChecklistModule(markdown));

  const canonicalItems = [...markdown.matchAll(/^- \[[ xX]\] \*\*([FR]\d{2}) /gm)].map(match => match[1]);
  assert.deepEqual(checklistStages.flatMap(stage => stage.items).map(item => item.id), canonicalItems);
  assert.ok(checklistStages.flatMap(stage => stage.items).every(item => item.description.includes('인수 기준:')));
});

test('F02 stays scoped to DOS aliases and F04 carries the real journal-read caveat', () => {
  const items = new Map(checklistStages.flatMap(stage => stage.items).map(item => [item.id, item]));
  const f02 = items.get('F02');
  const f04 = items.get('F04');

  assert.match(f02.title, /DOS 별칭 오류 수정/);
  assert.match(f02.description, /8\.3 별칭/);
  assert.match(f02.description, /하드링크나 충돌하는 이력은 임의 선택하지 않는다/);
  assert.equal('attention' in f02, false);

  assert.equal(f04.accepted, true);
  assert.match(f04.attention, /2026-09-20/);
  assert.match(f04.attention, /JOURNAL_READ_FAILED/);
  assert.match(f04.attention, /매개 변수가 틀립니다/);
  assert.match(f04.attention, /후보 0개는 삭제 흔적이 없다는 증거가 아니/);
});

test('all ten stages have an explicit disposition and every unaccepted item has a restart gate', () => {
  for (const item of checklistStages.flatMap(stage => stage.items)) {
    assert.ok(item.disposition, item.id);
    if (!item.accepted) { assert.ok(item.resumeCondition, item.id); assert.match(item.description, /보류 이유:/); }
  }
});
