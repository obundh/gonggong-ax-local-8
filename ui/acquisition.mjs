const el = (tag, text, className) => { const element = document.createElement(tag); if (text != null) element.textContent = text; if (className) element.className = className; return element; };
const bytes = value => Number.isFinite(value) ? new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(value / 1024 ** 2) + ' MB' : '확인 중';
const names = { preparing: '보관 준비', acquiring: '원본 보관 중', verifying: '보관본 검사 중', complete: '원본 보관 완료', partial: '일부 구간을 읽지 못했어요', cancelled: '중단한 자료를 보관했어요', interrupted: '중단된 보관 자료', error: '보관 중 확인이 필요해요', 'verification-failed': '보관본 검증 실패', cancelling: '중단 기록을 저장하고 있어요' };
const phases = { acquiring: '원본 읽기', 'readback-verification': '저장한 내용 확인', verification: '이미지 해시 확인', 'resume-verification': '이어서 작업할 위치 확인' };

export function createAcquisitionUI({ invoke, getSource, loadSources, isBusy, openDialog, closeDialog, onBusy, useSource, notice }) {
  let record = null, progress = null;
  const panel = document.getElementById('acquisition-status');
  const button = (label, action, primary = false) => { const item = el('button', label, primary ? 'primary' : 'secondary-button'); item.type = 'button'; item.addEventListener('click', action); return item; };
  function render() {
    panel.hidden = !record;
    if (!record) return;
    panel.replaceChildren();
    const active = ['preparing', 'acquiring', 'verifying', 'cancelling'].includes(record.status);
    const heading = el('div', null, 'acquisition-heading');
    heading.append(el('strong', names[record.status] || '원본 보관'), el('span', record.sourceLabel, 'acquisition-source'));
    panel.append(heading);
    if (active && Number.isFinite(progress?.bytesProcessed) && Number.isFinite(progress?.totalBytes) && progress.totalBytes > 0) {
      const meter = el('progress'); meter.max = progress.totalBytes; meter.value = progress.bytesProcessed; meter.setAttribute('aria-label', '원본 보관 진행률');
      panel.append(meter, el('p', `${phases[progress.phase] || '처리 중'} · ${bytes(progress.bytesProcessed)} / ${bytes(progress.totalBytes)}`));
    } else if (active) { const loader = el('span', '작업을 준비하고 있어요', 'acquisition-loading'); panel.append(loader); }
    else if (record.summary) panel.append(el('p', `${bytes(record.summary.bytesWritten)} 보관 · 읽기 실패 구간 ${record.summary.readErrorCount ?? 0}개`));
    if (record.error) panel.append(el('p', record.error.message, 'readiness-warning'));
    const actions = el('div', null, 'acquisition-actions');
    if (active) actions.append(button('중단하고 기록 남기기', async () => { const result = await invoke('cancelAcquisition', { id: record.id }); if (result) { record.status = 'cancelling'; render(); } }));
    else {
      if (record.canUse) actions.append(button('보관 이미지에서 파일 찾기', () => use(record), true));
      if (record.canResume) actions.append(button('같은 원본에서 이어서 보관', () => resume(record)));
      actions.append(button('보관 폴더 열기', () => invoke('showAcquisition', { id: record.id })), button('닫기', () => { record = null; render(); }));
    }
    panel.append(actions);
    if (record.status === 'partial') panel.append(el('p', '읽지 못한 구간은 따로 기록했어요. 이 자료를 완성된 이미지로 열지는 않습니다.'));
  }
  function adopt(value) { record = value; progress = null; onBusy(['preparing', 'acquiring', 'verifying', 'cancelling'].includes(value.status)); render(); panel.scrollIntoView({ block: 'nearest' }); }
  async function use(item) {
    if (isBusy()) return;
    closeDialog(); adopt({ ...item, status: 'verifying' });
    const source = await invoke('useAcquiredImage', { id: item.id });
    onBusy(false);
    if (source) { record = null; render(); await useSource(source); notice('보관 이미지 검증을 마쳤어요. 이 이미지에서 파일을 찾을 수 있어요.'); }
    else { const current = await invoke('acquisitions'); const updated = current?.items.find(value => value.id === item.id); adopt(updated || { ...item, status: 'verification-failed', canUse: false }); }
  }
  async function resume(item) {
    if (isBusy()) return;
    await loadSources(); const source = getSource();
    if (!source) { notice('이전에 사용한 원본 이미지 파일을 먼저 선택해주세요.'); return; }
    closeDialog(); const result = await invoke('acquireImage', { sourceId: source.id, resumeId: item.id }); if (result) adopt(result);
  }
  async function prepare() {
    if (isBusy()) return;
    await loadSources(); const source = getSource();
    if (!source || !['image', 'volume'].includes(source.kind)) { notice('보관할 드라이브 또는 이미지 파일을 먼저 선택해주세요.'); return; }
    closeDialog();
    const destination = await invoke('chooseDestination'); if (!destination) return;
    const report = await invoke('sourceReadiness', { sourceId: source.id, destinationId: destination.id }); if (!report) return;
    const allowed = source.kind === 'volume' ? report.acquisition?.canAcquire === true : report.source.identityStatus === 'current' && report.destination?.identityStatus === 'current';
    openDialog('원본을 이미지로 보관하기', body => {
      body.append(el('p', source.label), el('p', '선택한 위치의 전체 범위를 별도 파일로 보관합니다. 삭제 파일이 아닌 사용 중인 영역도 포함하므로 전체 용량만큼 저장 공간이 필요해요.'));
      if (Number.isFinite(report.source.size)) body.append(el('p', '원본 크기: ' + bytes(report.source.size)));
      body.append(el('p', '저장 위치: ' + destination.label));
      if (source.kind === 'volume') body.append(el('p', '실행 중인 드라이브는 보관하는 동안에도 바뀔 수 있어요. 보관본이 한 시점의 고정 상태임을 보장하지 않습니다.'));
      if (!allowed) {
        const reasons = report.acquisition?.reasons || report.checks.filter(check => check.status === 'blocked');
        body.append(el('strong', '보관을 시작할 수 없는 조건이 있어요.'));
        for (const reason of reasons) body.append(el('p', reason.detail));
      } else body.append(button('전체 이미지 만들기', async () => { closeDialog(); const result = await invoke('acquireImage', { sourceId: source.id, destinationId: destination.id }); if (result) adopt(result); }, true));
    });
  }
  async function show() {
    const data = await invoke('acquisitions'); if (!data) return;
    openDialog('원본 보관 · 이미지', body => {
      body.append(el('p', '원본을 별도 이미지로 보관한 뒤 같은 자료를 다시 검사할 수 있어요. 일반 파일 찾기에는 필수 과정이 아닙니다.'));
      const start = button('현재 선택한 위치 보관하기', prepare, true); start.disabled = isBusy(); body.append(start);
      for (const item of data.items) {
        const row = el('div', null, 'acquisition-record');
        row.append(el('strong', names[item.status] || item.status), el('p', item.sourceLabel), el('p', new Date(item.createdAt).toLocaleString('ko-KR')));
        if (item.canUse) row.append(button('이 이미지에서 찾기', () => use(item)));
        if (item.canResume) row.append(button('같은 원본으로 이어서 보관', () => resume(item)));
        row.append(button('진행·결과 보기', () => { closeDialog(); adopt(item); })); body.append(row);
      }
      const details = el('details'); details.append(el('summary', '지원 형식과 한계'), el('p', 'raw · img · dd · bin 입력을 사용합니다. E01·VHDX 같은 컨테이너의 직접 수집·변환은 지원하지 않습니다. 이미지 크기·SHA-256·읽기 실패 구간·중단 이력은 보관 폴더에 함께 남습니다.'));
      body.append(details);
    });
  }
  return { show, event(event) {
    if (!event?.type?.startsWith('acquisition-')) return false;
    if (event.type === 'acquisition-permission') { notice(event.message); return true; }
    if (event.acquisition) { record = event.acquisition; progress = event.progress || progress; if (event.verifying) record = { ...record, status: 'verifying' }; onBusy(event.type !== 'acquisition-complete'); render(); }
    return true;
  } };
}
