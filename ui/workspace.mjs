import { checklistStages, checklistMeta } from './checklist-data.mjs';
import { recoverySummary } from '../engine/recovery-outcome.mjs';

export const journeySteps = [
  { id: 'protect', title: '원본 보호', hint: '장치 · 작업 위치 점검' },
  { id: 'records', title: '삭제 기록', hint: '최근 이력 · 빈 기록' },
  { id: 'content', title: '본문 복구', hint: '선택 · 저장 · 내용 확인' },
  { id: 'deep', title: '정밀 검색', hint: '기록 없는 본문의 흔적' },
  { id: 'copies', title: '다른 사본', hint: '남아 있는 파일 · 자동 저장' },
];
const stageFor = state => state.mode === 'deep' ? 'deep' : ['copies', 'autosave', 'traces'].includes(state.mode) ? 'copies' : state.mode === 'salvage' ? 'content' : 'records';
const count = value => Number.isFinite(value) ? value.toLocaleString('ko-KR') : '—';
const statusNames = { waiting: '아직 확인 안 함', running: '확인 중', paused: '일시 정지', done: '검사 종료', attention: '확인 필요', error: '오류 발생', cancelled: '중단됨' };

const locationKey = location => JSON.stringify([location?.id ?? null, location?.path ?? null]);
export function readinessContext(state, selection, source = state.source) {
  return { selection, viewMode: state.viewMode, checkedSource: locationKey(source), observedSource: locationKey(state.source), destination: locationKey(state.destination) };
}
export function readinessContextMatches(checked, state, selection, source = state.source) {
  return Boolean(checked) && checked.selection === selection && checked.viewMode === state.viewMode && checked.checkedSource === locationKey(source) && checked.observedSource === locationKey(state.source) && checked.destination === locationKey(state.destination);
}

// A stage is completed only by an actual terminal engine event, never by time or route selection.
export function createJourneyModel() {
  let sourceId = null, active = null;
  const entries = new Map();
  return {
    reset() { sourceId = null; active = null; entries.clear(); },
    start(state, now = Date.now()) {
      if (sourceId !== state.source?.id) { entries.clear(); sourceId = state.source?.id; }
      active = stageFor(state);
      entries.set(active, { status: 'running', startedAt: now, jobId: state.jobId, label: statusNames.running });
    },
    event(event, state, now = Date.now()) {
      if (!event || event.jobId !== state.jobId && event.jobId !== state.recoveryJobId) return;
      if (!sourceId) sourceId = state.source?.id;
      const recovery = event.type.startsWith('recover-');
      const key = recovery ? 'content' : (active || stageFor(state));
      if (recovery) active = key;
      const prior = entries.get(key) || { startedAt: now, jobId: event.jobId };
      if (['progress', 'recover-progress'].includes(event.type)) entries.set(key, { ...prior, status: 'running', label: state.stats?.stage || statusNames.running });
      if (event.type === 'paused') entries.set(key, { ...prior, status: 'paused', label: '일시 정지' });
      if (event.type === 'resumed') entries.set(key, { ...prior, status: 'running', label: '확인 중' });
      if (event.type === 'complete') {
        const incomplete = event.complete === false || event.truncated === true || Boolean(event.warnings?.length);
        entries.set(key, { ...prior, status: incomplete ? 'attention' : 'done', label: incomplete ? '일부 범위 확인 필요' : '선택 범위 검사 종료', finishedAt: now });
      }
      if (event.type === 'recover-complete') {
        const summary = recoverySummary(event.results || []);
        const issues = summary.filesNotSaved || summary.damagedFilesWritten || summary.filesWrittenUnverified || summary.partialContent;
        entries.set('content', { ...prior, status: issues ? 'attention' : 'done', label: `저장 ${summary.filesWritten}개 · 원본 일치 ${summary.originalBytesVerified}개`, finishedAt: now });
      }
      if (['error', 'cancelled'].includes(event.type)) entries.set(key, { ...prior, status: event.type, label: statusNames[event.type], finishedAt: now });
    },
    snapshot() { return { sourceId, active, entries: Object.fromEntries(entries) }; },
  };
}

const node = (tag, attrs = {}, text) => {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
};
const text = (id, value) => { const el = document.getElementById(id); if (el && el.textContent !== value) el.textContent = value; };
const shortTitles = ['결과 판정과 오류 정리', '원본 보존 · 읽기 기반', '정답이 있는 시험 환경', '삭제 기록 · 이름 연결', '본문을 정확하게 복구', '정밀 검색 · 조각 복구', '다른 사본과 흔적', '실제 매체 · 성능 검증', '독립 도구 비교 검증', 'SSD 내부 · 조건부 연구'];

export function createWorkspace({ getState, getReadinessSource = () => getState().source, isBusy, onStage, onReadiness }) {
  const model = createJourneyModel(), buttons = new Map();
  let view = 'recovery', readiness = null, checkedContext = null;
  for (const [index, step] of journeySteps.entries()) {
    const li = node('li'), button = node('button', { type: 'button', class: 'journey-step', 'data-journey': step.id, 'data-state': 'waiting' });
    const number = node('span', { class: 'step-number', 'aria-hidden': 'true' }, String(index + 1).padStart(2, '0'));
    const copy = node('span', { class: 'step-copy' });
    copy.append(node('strong', {}, step.title), node('small', {}, step.hint), node('span', { class: 'step-status' }, statusNames.waiting));
    button.append(number, copy); button.addEventListener('click', () => { if (!button.disabled) { showView('recovery'); onStage(step.id); } });
    li.append(button); document.getElementById('journey-steps').append(li); buttons.set(step.id, button);
  }
  function showView(next) {
    view = next;
    document.getElementById('recovery-view').hidden = next !== 'recovery';
    document.getElementById('roadmap-view').hidden = next !== 'roadmap';
    document.getElementById('workspace-nav').setAttribute('aria-pressed', String(next === 'recovery'));
    document.getElementById('roadmap-nav').setAttribute('aria-pressed', String(next === 'roadmap'));
    text('workspace-breadcrumb', next === 'roadmap' ? '파일 복구 / 개발·검증 체크리스트' : '파일 복구 / 복구 작업');
    if (next === 'roadmap') document.getElementById('roadmap-title').focus({ preventScroll: true });
    else document.getElementById('program-title').focus({ preventScroll: true });
  }
  document.getElementById('workspace-nav').addEventListener('click', () => showView('recovery'));
  document.getElementById('roadmap-nav').addEventListener('click', () => showView('roadmap'));
  document.getElementById('back-to-workspace').addEventListener('click', () => showView('recovery'));
  document.getElementById('check-source-readiness').addEventListener('click', onReadiness);
  const summary = document.getElementById('roadmap-summary');
  const fraction = node('div', { class: 'roadmap-fraction' }, String(checklistMeta.accepted));
  fraction.append(node('small', {}, ` / ${checklistMeta.required}`));
  const explanation = node('div');
  explanation.append(node('strong', {}, '필수 항목의 기존 인수 기록'), node('p', {}, '복구 성공률과는 별개입니다. 실환경에서 더 확인할 항목과 조건부 연구는 따로 표시합니다.'));
  summary.append(fraction, explanation, node('progress', { max: String(checklistMeta.required), value: String(checklistMeta.accepted), 'aria-label': '필수 개발·검증 항목 인수 기록' }));
  for (const stage of checklistStages) {
    const button = node('button', { type: 'button', class: 'roadmap-stage', 'data-checklist-stage': String(stage.id), 'aria-pressed': String(stage.id === 1) });
    const label = node('span');
    label.append(node('strong', {}, shortTitles[stage.id - 1]), node('small', {}, stage.conditional ? '조건부 연구 · 별도 관리' : `${stage.items.filter(item => item.accepted).length} / ${stage.items.length} 인수${stage.id === 1 ? ' · 현장 보완' : ''}`));
    button.append(node('span', {}, String(stage.id).padStart(2, '0')), label);
    button.addEventListener('click', () => renderStage(stage.id));
    document.getElementById('roadmap-stages').append(button);
  }
  function renderStage(id) {
    const stage = checklistStages.find(item => item.id === id), detail = document.getElementById('roadmap-detail');
    detail.replaceChildren(node('span', { class: 'eyebrow' }, `STAGE ${String(id).padStart(2, '0')} / ${stage.conditional ? '조건부 연구' : '필수 검증'}`), node('h2', {}, stage.title), node('p', {}, stage.description));
    if (id === 1) detail.append(node('p', { class: 'roadmap-attention' }, '현장 보완: 2026-09-20 실제 C: 시험에서 삭제 이력 읽기 오류가 확인됐습니다. 기존 인수 완료와 실환경 문제를 함께 표시합니다.'));
    if (id === 2) detail.append(node('p', { class: 'roadmap-attention' }, '이미지 보관·해시 확인·중단 기록·고정 이미지 재개를 구현했습니다. 고정 시험은 통과했으며 실제 장치 수집 검증은 남아 있습니다.'));
    const list = node('ol', { class: 'checklist-items' });
    for (const item of stage.items) {
      const li = node('li'), heading = node('div', { class: 'checklist-item-heading' }), title = node('strong');
      title.append(node('span', { class: 'checklist-id' }, item.id), document.createTextNode(item.title));
      heading.append(node('span', { class: 'check-icon', 'data-accepted': String(item.accepted), 'aria-hidden': 'true' }, item.accepted ? '✓' : ''), title);
      li.append(heading, node('div', { class: 'checklist-item-state' }, item.attention ? '기존 인수 완료 · 실환경 보완 필요' : item.accepted ? '지정 범위 인수 완료' : item.disposition || (stage.conditional ? '조건 확보 후 연구' : '인수 기준 검증 필요')));
      const details = node('details'); details.append(node('summary', {}, '완료 기준 보기'), node('p', {}, item.description));
      if (item.attention) details.append(node('p', { class: 'roadmap-attention' }, item.attention));
      if (item.resumeCondition) details.append(node('p', { class: 'preview-note' }, '재개 조건: '+item.resumeCondition));
      li.append(details); list.append(li);
    }
    detail.append(list);
    document.querySelectorAll('[data-checklist-stage]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.checklistStage) === id)));
  }
  renderStage(1);
  function render(state = getState()) {
    let snapshot = model.snapshot();
    const previousJob = snapshot.entries[snapshot.active]?.jobId;
    if (snapshot.sourceId && snapshot.sourceId !== state.source?.id || previousJob && state.jobId && previousJob !== state.jobId && previousJob !== state.recoveryJobId) { model.reset(); snapshot = model.snapshot(); }
    const busy = isBusy(), chatBusy = state.viewMode === 'chat' && state.chatActive;
    const sourceSelection = document.getElementById('program-source')?.value;
    if (readiness && !readinessContextMatches(checkedContext, state, sourceSelection, getReadinessSource())) { readiness = null; checkedContext = null; }
    const selected = state.working || state.results || ['autosave', 'traces'].includes(state.mode) ? snapshot.active : state.programRoute === 'deep' ? 'deep' : state.programRoute === 'copies' ? 'copies' : 'records';
    for (const step of journeySteps) {
      const button = buttons.get(step.id);
      let entry = snapshot.entries[step.id] || { status: 'waiting', label: statusNames.waiting };
      if (step.id === 'protect' && readiness) entry = { status: readiness.overall === 'ready' ? 'done' : 'attention', label: readiness.overall === 'ready' ? '관측한 항목 점검 완료' : '확인할 조건이 있어요' };
      button.dataset.state = entry.status;
      if (selected === step.id) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
      const label = button.querySelector('.step-status'); if (label.textContent !== entry.label) label.textContent = entry.label;
      button.disabled = busy || chatBusy || (step.id !== 'content' && !window.recoveryAPI);
    }
    document.getElementById('check-source-readiness').disabled = busy || !window.recoveryAPI;
    const strip = document.querySelector('.source-readiness-strip'); strip.dataset.state = readiness?.overall || 'unknown';
    text('readiness-label', readiness ? readiness.overall === 'ready' ? '확인한 보호 조건을 충족합니다' : readiness.overall === 'blocked' ? '작업 위치를 바꾸거나 장치 상태를 확인하세요' : '점검을 마쳤어요 · 미확인 조건이 있습니다' : '검색 전에 원본과 작업 위치를 확인하세요');
    text('readiness-detail', readiness ? '점검 시점: ' + new Date(readiness.checkedAt).toLocaleTimeString('ko-KR') + ' · 검색·저장 시 장치 상태를 다시 확인합니다.' : '다른 물리 디스크에 작업 공간과 복구본을 두는지 점검합니다.');
    const result = state.results ? recoverySummary(state.results) : null;
    const current = snapshot.entries[snapshot.active];
    const phase = state.starting || state.preparing ? '검색 준비 중' : state.paused ? '일시 정지' : state.working ? state.stats?.stage || '검색 중' : state.results ? '파일별 결과 확인' : state.jobId ? current?.status === 'attention' ? '확인할 범위가 있어요' : current?.status === 'error' ? '작업 오류' : current?.status === 'cancelled' ? '검색 중단' : '후보 확인' : '검색 준비';
    text('session-phase', phase);
    text('session-found', state.jobId ? count(state.stats?.candidatesFound ?? state.scannedTotal ?? state.total) : '—');
    text('session-saved', result ? count(result.filesWritten) : '—');
    text('session-verified', result ? count(result.originalBytesVerified) : '—');
    const source = state.source?.label || '선택한 위치';
    const note = !state.jobId ? '아직 검색하지 않았습니다. 발견과 복구 성공은 따로 확인합니다.' : result ? `저장 ${result.filesWritten}개 · 손상 ${result.damagedFilesWritten}개 · 이름 복원 ${result.originalNamesRestored}개. 원본 일치는 삭제 전 비교 근거가 있을 때만 집계합니다.` : `${source} · ${state.scanIncomplete ? '확인하지 못한 범위가 남아 있습니다.' : state.working ? '실제 엔진 진행 상태를 표시합니다.' : '검사 종료가 파일의 원본 복구 성공을 뜻하지는 않습니다.'}`;
    text('session-context', note);
    if (view === 'recovery') text('workspace-breadcrumb', '파일 복구 / ' + (state.jobId ? '진행 중인 작업' : '새 작업'));
  }
  return {
    render, start(state) { model.start(state); render(state); },
    event(event, state) { model.event(event, state); render(state); },
    reset() { model.reset(); readiness = null; checkedContext = null; render(); },
    setReadiness(report, source) { readiness = report; checkedContext = readinessContext(getState(), document.getElementById('program-source')?.value, source); render(); },
    showView,
  };
}
