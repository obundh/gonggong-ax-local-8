import { recoveryOutcome, recoverySummary } from './engine/recovery-outcome.mjs';
import { createWorkspace } from './ui/workspace.mjs';
import { createAcquisitionUI } from './ui/acquisition.mjs';
import { deepCoverageView, deepSearchLimits } from './ui/deep-coverage.mjs';

(() => {
  'use strict';
  const api = window.recoveryAPI;
  const demo = new URLSearchParams(location.search).get('demo') === '1';
  const $ = (s) => document.querySelector(s);
  const ui = { transcript: $('#transcript'), question: $('#question'), notice: $('#notice'), status: $('#scan-status'), results: $('#results'), list: $('#candidate-list'), count: $('#results-count'), actions: $('#results-actions'), path: $('#path-filter'), sort: $('#sort'), dialog: $('#app-dialog'), dialogContent: $('#dialog-content'), dialogTitle: $('#dialog-title'), announce: $('#announcer'), connection: $('#connection-state'), progress: $('#progress-label') };
  const state = { step: 'lost', answers: {}, devices: [], source: null, destination: null, mode: null, jobId: null, recoveryJobId: null, working: false, paused: false, total: 0, items: [], selected: new Set(), kind: 'all', pendingCandidates: false, stats: {}, results: null, unsub: null };
  let workspaceShell = null;
  let acquisitionUI = null;
  const e = (tag, attrs = {}, text) => { const n = document.createElement(tag); Object.entries(attrs).forEach(([k,v]) => { if (k === 'class') n.className = v; else if (k === 'dataset') Object.assign(n.dataset,v); else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(),v); else if (k === 'style') n.setAttribute('style', String(v)); else if (k === 'disabled') n.disabled = Boolean(v); else if (k === 'checked') n.checked = Boolean(v); else n.setAttribute(k,String(v)); }); if (text !== undefined) n.textContent = text; return n; };
  const say = (text, who = 'assistant') => { const li = e('li',{class:`turn ${who}`}); li.append(e('div',{class:'bubble'},text)); ui.transcript.append(li); ui.announce.textContent = text; requestAnimationFrame(() => li.scrollIntoView({block:'nearest'})); };
  const clear = (n) => n.replaceChildren();
  const answer = (text) => { if(state.viewMode==='chat')state.chatActive=true;say(text,'user');syncModeControls(); };
  const errText = (x) => x && typeof x.message === 'string' ? x.message : '데스크톱 서비스가 요청을 처리하지 못했습니다.';
  const showNotice = (text, tone='warning') => { ui.notice.hidden = !text; ui.notice.dataset.tone = tone; ui.notice.textContent = text || ''; };
  function journalValidationFailed(){
    if(state.mode!=='deleted'||!['journal-first','native-journal'].includes(state.coverage?.strategy))return false;
    if(state.coverage.strategy==='native-journal'&&state.scanIncomplete===true)return true;
    const partitions=state.coverage.partitions||[state.coverage];
    return partitions.some(partition=>partition.journalAvailable===false)||(state.scanWarnings||[]).some(warning=>['USN_CHANGED','USN_CANDIDATE_CHANGED','USN_VALIDATION_LIMIT'].includes(warning.code));
  }
  function renderScanWarnings(){
    const panel=$('#scan-warning-panel'),warnings=state.scanWarningsJobId===state.jobId?state.scanWarnings||[]:[];
    const wasOpen=panel.querySelector('details')?.open;
    clear(panel);panel.hidden=!warnings.length;if(!warnings.length)return;
    panel.append(e('strong',{},`검색 경고 ${warnings.length}건 · 파일 개수가 아니에요`));
    const changed=warnings.some(warning=>['USN_CHANGED','USN_CANDIDATE_CHANGED'].includes(warning.code));
    panel.append(e('p',{},changed?'검색 중 삭제 이력이 바뀌어 일부 기록의 검증을 마치지 못했어요. 검증되지 않은 기록은 파일 후보로 표시하지 않아요.':'검색 범위 제한이나 읽지 못한 기록이 있어요. 아래 내용을 확인해주세요.'));
    const details=e('details'),list=e('ul');details.open=Boolean(wasOpen);
    details.append(e('summary',{},'경고 전체 보기'));
    for(const warning of warnings){const item=e('li');item.append(e('span',{},warning.message||'자세한 설명이 없는 검색 경고입니다.'));if(warning.code)item.append(e('small',{},'진단 코드: '+warning.code));list.append(item);}
    details.append(list);panel.append(details);
  }
  const pendingOperations=new Map();
  const operationLabels={devices:'연결된 장치를 확인하고 있어요',openRecycleBin:'Windows 휴지통을 열고 있어요',chooseSource:'검색 위치 선택을 기다리고 있어요',chooseDestination:'저장 폴더 선택을 기다리고 있어요',start:'검색을 준비하고 있어요',candidates:'찾은 파일 목록을 불러오고 있어요',recover:'선택한 파일의 복구를 준비하고 있어요',preview:'파일 미리보기를 준비하고 있어요',previewRecovered:'저장한 복구본을 다시 읽고 있어요',showRecovered:'복구본의 파일 위치를 열고 있어요',history:'이전 작업 기록을 불러오고 있어요',backups:'자동 저장 폴더를 확인하고 있어요',recentTraces:'최근 문서 단서 위치를 확인하고 있어요',semantic:'파일 이름의 의미를 비교하고 있어요',duplicates:'파일 내용을 비교하고 있어요',saveIndex:'파일명 인덱스를 저장하고 있어요',loadIndex:'인덱스의 파일을 다시 확인하고 있어요',support:'지원 안내를 불러오고 있어요',salvage:'손상 파일의 내용을 추출하고 있어요',cleanup:'정리 대상을 처리하고 있어요',pause:'일시 정지를 요청하고 있어요',resume:'작업을 이어가고 있어요',cancel:'작업 중단을 요청하고 있어요'};
  function renderActivity(){
    const indicator=$('#activity-indicator');const label=$('#activity-label');
    const pending=[...pendingOperations.values()].at(-1);
    const text=pending||(state.working?(state.paused?'일시 정지했어요 · 이어하기로 계속할 수 있어요':state.stats.stage||'검색을 진행하고 있어요'):'');
    indicator.hidden=!text;indicator.dataset.paused=String(state.paused&&!pending);
    if(label.textContent!==text)label.textContent=text;
    syncModeControls();
  }
  async function invoke(name, ...args) {
    const epoch=state.epoch||0;const token=Symbol(name);pendingOperations.set(token,operationLabels[name]||'요청을 처리하고 있어요');renderActivity();
    try { const value = await api[name](...args); if (value && value.error) throw new Error(String(value.error)); return value; }
    catch (error) { if(epoch===(state.epoch||0)){showNotice(errText(error),'error'); ui.announce.textContent = errText(error);}return null; }
    finally {pendingOperations.delete(token);renderActivity();}
  }
  function choices(title, help, options) { if(state.viewMode==='chat'&&state.jobId){state.chatActive=true;syncModeControls();}clear(ui.question); ui.question.append(e('h1',{id:'question-title'},title)); if (help) ui.question.append(e('p',{},help)); const list = e('div',{class:'choice-list'}); options.forEach(opt => { const b = e('button',{type:'button',class:'choice',onClick:opt.click}); b.append(e('strong',{},opt.label)); if (opt.hint) b.append(e('small',{},opt.hint)); list.append(b); }); ui.question.append(list); ui.progress.textContent = state.step; }
  function actionRow(buttons) { const row=e('div',{class:'button-row'}); buttons.forEach(({label,primary,click,disabled})=>row.append(e('button',{type:'button',class:primary?'primary':'',onClick:click,disabled:!!disabled},label))); ui.question.append(row); }
  function resetResultFilters(clues={}) {
    const dateValue=value=>{if(value===null||value===undefined||value==='')return '';if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value))return value;const d=new Date(value);return Number.isNaN(d.getTime())?'':`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
    ui.path.value=clues.name||'';state.kind=['document','photo','other'].includes(clues.kind)?clues.kind:'all';
    $('#original-path').value=clues.pathContains||'';$('#modified-after').value=dateValue(clues.modifiedAfter);$('#modified-before').value=dateValue(clues.modifiedBefore);$('#max-size').value=clues.maxSize==null?'':String(clues.maxSize/1048576);ui.sort.value=state.mode==='traces'?'name':state.mode==='autosave'?'modified-desc':state.recent?'deleted-desc':'score-desc';
    document.querySelectorAll('[data-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.kind===state.kind)));
  }
  function reset() { if([...pendingOperations.keys()].some(token=>token.description!=='candidates')&&!state.working&&!state.starting){showNotice('요청을 처리하고 있어요. 잠시 후 다시 눌러주세요.');return;}if(state.working||state.starting){showNotice('진행 중인 작업을 먼저 취소해주세요.');return;}state.epoch=(state.epoch||0)+1;pendingOperations.clear();Object.assign(state,{step:'lost',answers:{},devices:[],source:null,resumeId:null,semantic:false,deepScope:'unallocated',recent:false,destination:null,notifications:null,mode:null,jobId:null,recoveryJobId:null,working:false,paused:false,saving:false,total:0,items:[],selected:new Set(),kind:'all',pendingCandidates:false,stats:{},results:null}); resetResultFilters();clear(ui.transcript); clear(ui.question); ui.status.hidden=true; ui.results.hidden=true; showNotice(''); renderActivity();showLost(); }
  function showLost() { state.step='1 / 상황'; choices('파일이 어떻게 없어졌나요?','기억나는 범위에서만 골라주세요.',[
    {label:'최근 삭제 기록 보기',hint:'휴지통 비움·완전 삭제 기록을 최신순으로',click:beginDeletedRecent},
    {label:'직접 지웠어요',hint:'삭제 또는 Shift+Delete를 했어요',click:()=>{answer('직접 지웠어요');state.answers.disappearance='deleted';showRecycle();}},
    {label:'찾아보니 없어요',hint:'이동, 이름 변경, 복사본도 함께 찾아봐요',click:()=>{answer('찾아보니 없어요');state.answers.disappearance='missing';showOrigin();}},
    {label:'잘 모르겠어요',hint:'확실하지 않아도 시작할 수 있어요',click:()=>{answer('잘 모르겠어요');state.answers.disappearance='unknown';showOrigin();}}
  ]); actionRow([{label:'휴지통 비운 뒤 파일 찾기',click:beginDeletedRecent}]); }
  async function openRecycleBin(){
    if(operationBusy())return;
    if(!api){showNotice('데스크톱 앱에서 Windows 휴지통을 열 수 있어요.');return;}
    const result=await invoke('openRecycleBin');
    if(result?.opened)showNotice('Windows 휴지통에서 확인한 뒤, 파일이 없으면 삭제 기록 찾기를 진행해주세요.','info');
  }
  async function beginDeletedRecent(){
    if(state.working||state.starting)return;
    state.recent=true;state.answers={disappearance:'deleted',filters:{}};state.resumeId=null;
    state.destination=null;state.jobId=null;state.recoveryJobId=null;state.items=[];state.selected.clear();state.results=null;ui.results.hidden=true;ui.status.hidden=true;
    answer('휴지통을 비웠거나 완전 삭제한 파일의 기록을 찾아볼게요.');
    clear(ui.question);ui.question.append(e('h1',{id:'question-title'},'최근 삭제 기록을 준비할게요'));
    const response=await invoke('devices');
    if(!response){actionRow([{label:'다시 확인',click:beginDeletedRecent},{label:'처음으로',click:reset}]);return;}
    state.devices=Array.isArray(response.devices)?response.devices:[];
    await showUnknownDevices();
  }
  function afterSourceChosen(){if(state.recent)showRecentSummary();else showClues();}
  function showRecentSummary(){
    state.step='최근 삭제 / 확인';
    choices('최근 삭제된 파일부터 살펴볼까요?','삭제 시각이 남아 있는 파일은 최신순으로, 시각을 알 수 없는 파일은 아래에 모아 보여드려요.',[
      {label:'최근 삭제 목록 검색',hint:sourceLabel(),click:()=>chooseMode('deleted')},
      {label:'검색 위치 바꾸기',hint:'다른 드라이브나 디스크 이미지 선택',click:showOrigin},
      {label:'이름·종류로 좁히기',hint:'기억나는 단서가 있을 때만',click:showClues},
      {label:'다른 방식으로 찾기',click:()=>{state.recent=false;showSummary();}}
    ]);
    ui.question.append(e('p',{class:'deletion-time-note'},'남아 있는 삭제 기록을 찾습니다. 휴지통의 현재 목록과는 다르며, 삭제 기록이 지워졌다면 시각을 확인할 수 없어요.'));
    ui.question.append(e('button',{type:'button',class:'secondary-button',onClick:showPeriodDialog},'기간을 정해서 빠르게 찾기'));
  }
  function showRecycle() { state.step='1 / 휴지통 확인'; choices('휴지통을 확인해 보셨나요?','휴지통에 남아 있으면 Windows에서 바로 복원할 수 있어요.',[
    {label:'휴지통 열기',hint:'Windows 휴지통에서 직접 확인',click:()=>{answer('휴지통을 먼저 확인할게요.');void openRecycleBin();}},
    {label:'휴지통을 비웠어요',hint:'삭제 기록 찾기로 계속',click:()=>{answer('휴지통을 비웠어요');state.answers.recycle='emptied';showOrigin();}},
    {label:'완전 삭제했어요',hint:'Shift+Delete 등으로 지웠어요',click:()=>{answer('완전 삭제했어요');state.answers.recycle='permanent';showOrigin();}},
    {label:'휴지통에도 없어요',hint:'원래 있던 곳부터 찾기',click:()=>{answer('휴지통에도 없어요');state.answers.recycle='missing';showOrigin();}}
  ]); }
  function recycleGuide(){if(!api)return demoEnd();showRecycle();}
  async function showOrigin() { state.step='2 / 원래 위치'; if (!api) return showDesktopRequired(); if (!state.devices.length) { clear(ui.question); ui.question.append(e('h1',{id:'question-title'},'연결된 위치를 확인하고 있어요')); ui.question.append(e('p',{},'사용 가능한 장치만 표시합니다.')); const response=await invoke('devices'); if (!response) return; state.devices=Array.isArray(response.devices)?response.devices:[]; }
    const opts=[]; state.devices.forEach(d=>opts.push({label:d.label||'이름 없는 장치',hint:d.ready===false?(d.reason||'지금 사용할 수 없어요'):`${d.kind||'장치'} · ${d.fileSystem||'파일 시스템 정보 없음'}${d.system?' · 시스템 장치':''}`,click:()=>{if(d.ready===false){showNotice(d.reason||'이 장치는 현재 준비되지 않았습니다.','warning');return;}state.source={id:d.id,label:d.label,kind:d.kind||'volume'};if(d.system)showNotice('시스템 장치는 Windows 자체의 쓰기가 계속될 수 있어요. 앱과 작업 공간을 다른 물리 디스크에서 실행해주세요.');answer(d.label||'장치를 골랐어요');afterSourceChosen();}}));
    opts.push({label:'공유 폴더 · 클라우드에 있었어요',hint:'서비스 휴지통과 버전 기록 안내',click:showRemoteGuide},{label:'폴더를 직접 고를게요',hint:'데스크톱에서 폴더 선택 창을 엽니다',click:()=>chooseSource('folder')},{label:'디스크 이미지에서 찾을게요',hint:'읽기 전용 이미지 파일을 선택합니다',click:()=>chooseSource('image')},{label:'어디인지 모르겠어요',hint:'기본 드라이브부터 자동으로 위치를 정해요',click:()=>{answer('어디인지 모르겠어요');showUnknownDevices();}}); choices('파일이 원래 있던 곳을 골라주세요','원본 장치에는 검색 중 쓰지 않습니다.',opts); }
  function showRemoteGuide(){choices('서비스의 복구 기록부터 확인해주세요','공유 폴더는 서버 관리자에게, OneDrive 등은 웹 휴지통과 버전 기록을 확인하세요. 온라인 전용 파일은 로컬 디스크에 내용이 없을 수 있어요.',[{label:'PC에 남은 복사본 찾기',click:()=>chooseSource('folder')},{label:'다른 위치 선택',click:showOrigin}]);}
  async function showUnknownDevices(refresh=false){
    state.step='2 / 자동 위치';
    if(refresh){const response=await invoke('devices');if(!response)return;state.devices=Array.isArray(response.devices)?response.devices:[];}
    const devices=state.devices.filter(d=>d.ready!==false).sort((a,b)=>Number(!!b.system)-Number(!!a.system));
    if(!devices.length){choices('지금 읽을 수 있는 장치가 없어요','장치를 연결한 뒤 다시 확인해주세요. 원래 위치를 몰라도 계속할 수 있어요.',[{label:'장치 다시 확인',click:()=>showUnknownDevices(true)},{label:'처음으로',click:reset}]);return;}
    selectUnknownLocation(devices,0);
    say(`${state.recent?'기본 드라이브부터 살펴볼게요.':'위치를 몰라도 괜찮아요.'} ${devices[0].label||'첫 번째 장치'}부터 확인할게요.${devices.length>1?' 원하는 파일이 없으면 “다음 위치 찾기”로 이어갈 수 있어요.':''}`);
    afterSourceChosen();
  }
  function selectUnknownLocation(devices,index){
    const device=devices[index];
    state.source={id:device.id,label:device.label||'이름 없는 장치',kind:device.kind||'volume',autoScope:{devices,index}};
    state.resumeId=null;
  }
  function sourceLabel(){const source=state.source;const scope=source?.autoScope;return (source?.label||'미선택')+(scope?` · ${scope.index+1} / ${scope.devices.length}번째 위치`:'');}
  function hasNextLocation(){const scope=state.source?.autoScope;return scope&&scope.index+1<scope.devices.length;}
  function appendNextLocation(container){
    if(hasNextLocation()&&!container.querySelector('[data-next-location]'))container.append(e('button',{type:'button','data-next-location':'',onClick:nextUnknownLocation},'다음 위치 찾기'));
  }
  async function nextUnknownLocation(){
    if(state.working||state.starting||!hasNextLocation())return;
    const {devices,index}=state.source.autoScope;
    selectUnknownLocation(devices,index+1);
    state.jobId=null;state.recoveryJobId=null;state.items=[];state.total=0;state.selected.clear();state.results=null;state.stats={};state.deepScope='unallocated';
    ui.results.hidden=true;ui.status.hidden=true;showNotice('');
    say(`${state.source.label}에서 같은 단서로 찾아볼게요. (${index+2}/${devices.length}번째 위치)`);
    showNotifications();
    await startSearch();
  }
  async function chooseSource(kind){ const result=await invoke('chooseSource',kind); if(!result)return; state.source={id:result.id,label:result.label||'선택한 위치',kind:result.kind||kind};answer(result.label||'선택한 위치');afterSourceChosen(); }
  function showClues(){ state.step='3 / 단서'; clear(ui.question); ui.question.append(e('h1',{id:'question-title'},'기억나는 단서가 있나요?')); ui.question.append(e('p',{},'모르면 비워도 됩니다. 입력한 조건으로만 후보를 좁힙니다.')); if(state.source?.autoScope)ui.question.append(e('p',{class:'candidate-meta'},`이번 검색 위치: ${sourceLabel()}`)); const grid=e('div',{class:'clue-grid'}); const fields=[['name','파일 이름 또는 일부','예: 회의록'],['extension','확장자','예: pdf'],['kind','파일 종류','']]; fields.forEach(([key,label,ph])=>{const l=e('label',{},label); const input=key==='kind'?e('select',{id:`clue-${key}`}):e('input',{id:`clue-${key}`,placeholder:ph,autocomplete:'off'}); if(key==='kind'){[['','모름'],['document','문서'],['image','사진'],['other','기타']].forEach(([v,t])=>input.append(e('option',{value:v},t)));}if(key==='name')input.value=state.answers.filters?.name||'';if(key==='extension')input.value=[state.answers.filters?.extensions||''].flat().join(',');if(key==='kind')input.value=state.answers.filters?.kind==='photo'?'image':state.answers.filters?.kind||'';input.setAttribute('maxlength','256');l.append(input);grid.append(l);}); const time=e('label',{class:'wide'},'마지막으로 본 시점 (선택)');time.append(e('input',{id:'clue-time',value:state.answers.lastSeen||'',placeholder:'예: 지난주, 9월 초',autocomplete:'off'}));grid.append(time);ui.question.append(grid); const compose=e('div',{class:'composer-row'});const text=e('textarea',{id:'clue-note',placeholder:'추가로 기억나는 파일 이름 일부를 적을 수 있어요.'});const send=e('button',{type:'button',class:'primary',onClick:()=>submitClues()},'계속'); text.addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();submitClues();}});compose.append(text,send);ui.question.append(compose); actionRow([{label:'단서 없이 계속',click:submitClues}]); }
  function submitClues(){ const get=(id)=>$(id)?.value.trim()||''; state.answers.lastSeen=get('#clue-time'); state.answers.filters={name:(get('#clue-name')||get('#clue-note')).slice(0,256),extensions:get('#clue-extension').replace(/^\./,''),kind:get('#clue-kind')==='image'?'photo':get('#clue-kind')||'all'}; const count=Object.values(state.answers.filters).filter(v=>v&&v!=='all').length;answer(count?'단서를 입력했어요.':'단서 없이 찾을게요.');showSummary(); }
  function showSummary(){ if(state.recent)return showRecentSummary();state.step='4 / 확인'; choices('검색할 내용을 확인해 주세요','검색은 원본에 쓰지 않습니다. 정밀 검색과 실제 복구 전에는 별도 저장 위치를 고릅니다.',[
    {label:'기간을 정해서 빠르게 찾기',hint:'오늘·7일·직접 지정 → 삭제 이벤트부터 확인',click:showPeriodDialog},
    {label:'삭제 파일 찾기',hint:'남아 있는 삭제 기록부터 확인',click:()=>chooseMode('deleted')},
    {label:'복사본·비슷한 파일 찾기',hint:'현재 남아 있는 이름과 복사본 확인',click:()=>chooseMode('copies')},
    {label:'깊게 찾아보기',hint:'기록 없는 영역도 확인 · 별도 작업 위치 필요',click:()=>chooseMode('deep')}
  ].filter(option=>state.jobId||option.label!=='깊게 찾아보기')); const summary=e('div',{class:'summary'}); [[state.source?.autoScope?'이번 검색 위치':'원래 위치',sourceLabel()],['단서',Object.entries(state.answers.filters||{}).filter(([k,v])=>v&&v!=='all').map(([k,v])=>Array.isArray(v)?v.join(','):v).join(' · ')||'없음']].forEach(([k,v])=>{const row=e('div');row.append(e('span',{},k),e('strong',{},v));summary.append(row);}); ui.question.append(summary); actionRow([{label:'단서 수정',click:showClues},{label:'원래 위치 수정',click:showOrigin}]); }
  async function chooseMode(mode){ if(state.source.kind==='folder'&&mode!=='copies'){showNotice('폴더 선택은 복사본 검색에 사용해요. 삭제·정밀 검색은 드라이브나 이미지 파일을 선택해주세요.');return;} if(state.source.kind==='image'&&mode==='copies'){showNotice('복사본 검색은 실제 폴더나 드라이브를 선택해주세요.');return;} state.mode=mode;if(!['deleted','recycle'].includes(mode))state.recent=false;state.semantic=false; answer(mode==='deleted'?(state.recent?'최근 삭제 목록 검색':'삭제 파일 찾기'):'copies'===mode?'복사본·비슷한 파일 찾기':'깊게 찾아보기'); if(mode==='deep'&&!state.destination){await chooseDestination(()=>showNotifications());return;} showNotifications(); }
  async function chooseDestination(next){ state.step='5 / 안전한 저장'; clear(ui.question);ui.question.append(e('h1',{id:'question-title'},'별도 작업 저장 위치를 고르세요'));ui.question.append(e('p',{},'정밀 검색과 복구 파일은 원본과 다른 장치에 저장해야 합니다.'));const b=e('button',{type:'button',class:'choice',onClick:async()=>{const result=await invoke('chooseDestination');if(!result)return;state.destination={id:result.id,label:result.label||'선택한 저장 위치'};answer(state.destination.label);next();}});b.append(e('strong',{},'저장 위치 선택'),e('small',{},'데스크톱 폴더 선택 창을 엽니다'));ui.question.append(b);actionRow([{label:'이전',click:showSummary}]); }
  function showNotifications(){ state.step='5 / 알림'; clear(ui.question);ui.question.append(e('h1',{id:'question-title'},'알림 방식을 고르세요'));ui.question.append(e('p',{},'검색은 계속 진행되고, 알림을 위해 답할 필요는 없습니다.'));const sel=e('select',{id:'notification-mode'});[['candidate','유력 후보를 찾았을 때'],['periodic','진행 상황을 주기적으로'],['complete','검색이 끝났을 때만']].forEach(([v,t])=>sel.append(e('option',{value:v},t)));const minutes=e('input',{id:'notification-minutes',type:'number',min:'1',max:'120',value:'10'});const l=e('label',{class:'clue-grid wide'},'알림 방식');l.append(sel);ui.question.append(l);const m=e('label',{class:'clue-grid wide'},'주기 알림 간격(분)');m.append(minutes);ui.question.append(m);if(state.notifications){sel.value=state.notifications.mode;minutes.value=state.notifications.minutes;}actionRow([{label:'검색 시작',primary:true,click:startSearch},{label:'이전',click:showSummary}]); }
  async function startSearch(configuration=null){
    if(state.working||state.starting)return false;
    const config=configuration?.source?configuration:null,search=config||state;
    const clues=config?.filters||{...state.answers.filters,...(search.mode==='deleted'?periodFilters():{})};
    const notificationMode=config?.notifications?.mode||$('#notification-mode')?.value||state.notifications?.mode||'complete';
    const notifications=config?.notifications||{mode:notificationMode==='candidate'&&!clues.name?'complete':notificationMode,minutes:Number($('#notification-minutes')?.value)||state.notifications?.minutes||10};
    state.startEvents=new Map();state.starting=true;syncModeControls();
    const controls=[...ui.question.querySelectorAll('button')];controls.forEach(b=>b.disabled=true);
    const result=await invoke('start',{sourceId:search.source.id,resumeId:search.resumeId,mode:search.mode,deletedStrategy:search.deletedStrategy||'auto',recent:search.recent===true,deepScope:search.deepScope,...(search.mode==='deep'?{deepLimits:search.deepLimits}:{}),destinationId:['deleted','recycle'].includes(search.mode)?undefined:search.destination?.id,filters:clues,notifications});
    const earlyEvents=[...state.startEvents.values()];state.startEvents=null;
    state.starting=false;controls.forEach(b=>b.disabled=false);syncModeControls();
    if(!result?.jobId){
      if(!config&&state.source?.autoScope){appendNextLocation(ui.question);if(state.mode==='deep'&&!ui.question.querySelector('[data-change-destination]'))ui.question.append(e('button',{type:'button','data-change-destination':'',onClick:()=>chooseDestination(showNotifications)},'작업 저장 위치 바꾸기'));}
      return false;
    }
    if(config){const {filters,notifications:unused,...settings}=config;Object.assign(state,settings);state.answers={...state.answers,filters};}
    else state.answers={...state.answers,filters:clues};
    if(['full','vacancy'].includes(config?.deletedStrategy))$('#include-unknown-date').checked=clues.includeUnknownDeletedAt!==false;
    state.coverage=result.coverage||null;
    state.scanWarnings=[];state.scanIncomplete=false;
    state.notifications=notifications;state.jobId=result.jobId;state.recoveryJobId=null;state.finishedJobId=null;
    if(['deleted','recycle'].includes(state.mode))state.destination=null;
    clearInlinePreview();state.matchCounts=null;state.nameFallback=null;state.programResumeId=null;
    state.semantic=false;resetResultFilters(state.answers.filters);state.selected.clear();state.items=[];state.total=0;state.scannedTotal=0;state.stats={};state.pendingCandidates=false;state.results=null;state.working=true;state.paused=false;
    workspaceShell?.start(state);
    if(state.viewMode==='chat')state.chatActive=true;
    clear(ui.question);if(state.source?.autoScope)say('이번 검색은 '+sourceLabel()+'만 확인해요.');
    say(state.mode==='deep'?'정밀 검색에서는 원래 이름을 모르는 후보도 함께 보여드려요. 이름과 기본 정보를 확인해주세요.':'검색을 시작했어요. 후보는 찾는 중에도 확인할 수 있습니다.');
    ui.results.hidden=false;ui.status.hidden=false;renderStatus();renderResults();
    for(const event of earlyEvents)if(event.jobId===state.jobId)onEvent(event);
    await loadCandidates(0,true);return true;
  }
  function filters(){return {...state.answers.filters,...(['autosave','traces'].includes(state.mode)?{}:periodFilters()),name:state.semantic?'':ui.path.value.trim(),pathContains:$('#original-path').value.trim(),modifiedAfter:$('#modified-after').value?$('#modified-after').value+'T00:00:00':null,modifiedBefore:$('#modified-before').value?$('#modified-before').value+'T23:59:59.999':null,maxSize:$('#max-size').value?Number($('#max-size').value)*1048576:null,kind:state.kind==='all'?'':state.kind};}
  async function loadCandidates(offset=0,replace=false){
    if(!state.jobId||!api||(!['autosave','traces'].includes(state.mode)&&!validPeriod()))return;
    const jobId=state.jobId,request=state.candidateRequest=(state.candidateRequest||0)+1;
    const res=await invoke('candidates',{jobId,offset,limit:state.viewMode==='program'?25:5,filters:filters(),sort:ui.sort.value});
    if(!res||state.jobId!==jobId||state.candidateRequest!==request)return;
    state.total=Number(res.total)||0;state.matchCounts=res.matchCounts||null;state.nameFallback=res.fallback;state.scannedTotal=res.scannedTotal||0;
    if(res.coverage)state.coverage=res.coverage;
    state.unknownDeletedTimeTotal=res.unknownDeletedTimeTotal||0;
    if(res.status&&state.finishedJobId!==jobId)state.working=['scanning','recovering','paused','cancelling'].includes(res.status);
    const items=Array.isArray(res.items)?res.items:[];
    state.freshIds=new Set(items.filter(item=>!state.items.some(old=>old.id===item.id)).map(item=>item.id));
    state.items=items;state.pageOffset=offset;
    if(state.previewId&&!state.items.some(item=>item.id===state.previewId))clearInlinePreview();
    state.pendingCandidates=false;renderResults();renderStatus();
    if(!state.working&&state.previewDeferred&&state.previewId){state.previewDeferred=false;void showInlinePreview(state.previewId,state.previewEarlierJobId||null);}
  }
  function deletionMillis(value){if(value===null||value===undefined||value===''||typeof value==='string'&&!value.trim())return null;if(typeof value!=='number'&&typeof value!=='string')return null;const ms=typeof value==='number'?value:Date.parse(value);return Number.isFinite(ms)&&Math.abs(ms)<=8640000000000000?ms:null;}
  function canSelectForRecovery(item){if(['deletion-trace','recycle-metadata','directory-slack','recent-link'].includes(item.source))return false;return ['readable','existing'].includes(item.status)||(item.status==='unverified'&&item.requiresPreparation===true);}
  function earlierCaptureOffer(item){
    const offer=item?.earlierCapture,at=Date.parse(offer?.capturedAt||'');
    return offer&&typeof offer.jobId==='string'&&offer.jobId&&Number.isFinite(at)&&typeof offer.sha256==='string'&&/^[a-f0-9]{64}$/i.test(offer.sha256)
      &&Number.isSafeInteger(offer.size)&&offer.size>=0&&offer.documentStatus==='preview-available'&&offer.originalIdentityVerified===false?offer:null;
  }
  function candidateStatusText(item){return item.source==='recent-link'?'경로 단서 · 본문 없음':item.source==='directory-slack'?'폴더 기록 흔적':item.source==='recycle-metadata'?'휴지통 정보 단서':item.source==='deletion-trace'?'삭제 이력만 확인':item.preservation?.status==='captured'?(['damaged','format-mismatch'].includes(item.preservation.documentStatus)?'본문 확보 · 손상 확인':'본문 확보 · 내용 확인 필요'):statusText(item.status);}
  function formatBytes(v){if(!Number.isFinite(v))return '크기 모름';return v<1024?v+' B':v<1048576?(v/1024).toFixed(1)+' KB':v<1073741824?(v/1048576).toFixed(1)+' MB':(v/1073741824).toFixed(2)+' GB';} function reasonText(v){return ({'filenameSimilarity:exact':'파일명 일치','filenameSimilarity:variant':'복사본·수정본 이름','filenameSimilarity:contains':'이름 일부 일치','filenameSimilarity:tokens':'이름 단어 일치','filenameSimilarity:fuzzy':'이름이 비슷함','noAI':'일반 이름 비교','name:generated':'원본 이름을 몰라 만든 이름','validation:truncated':'전체가 아닌 부분 추출','signature:hwp':'HWP 형식 확인','structure:hwp5-cfb-allocation-chains':'저장 구간 연결 확인'})[v]||v;} function sourceText(v){return ({'recycle-bin':'휴지통','recycle-metadata':'휴지통 정보 단서','directory-slack':'폴더 기록 흔적','deleted-record':'삭제 기록','carved':'정밀 추출','existing-file':'현재 남은 파일','recent-link':'최근 문서 바로가기'})[v]||'출처 미확인';} function statusText(v){return ({readable:'읽을 수 있음',unverified:'선택 시 확인',unsupported:'미지원',conflict:'기록·할당 충돌',existing:'현재 존재',saved:'저장됨',partial:'부분 저장',failed:'실패',skipped:'건너뜀',reconstructed:'구조 재구성 · 원본 동일 미확인'})[v]||'상태 미확인';} function fmt(v){if(v===undefined||v===null||v==='')return '모름';if(typeof v==='object')return Array.isArray(v)?v.length.toString():v.message||v.format||'';return String(v);}
  function currentDeepCoverage(){return state.mode==='deep'&&!state.results&&!state.saving?deepCoverageView(state.coverage):null;}
  function deepCoverageText(value){return `검사한 범위 ${formatBytes(value.examinedBytes)} / ${formatBytes(value.selectedBytes)} · 미검사 ${formatBytes(value.unexaminedBytes)}`+(value.readErrorBytes?` · 읽기 오류 ${formatBytes(value.readErrorBytes)}`:'')+(value.incomplete&&!state.working?' · 미검사 영역에 파일이 없는 것은 아닙니다.':'');}
  function renderStatus(){
    renderActivity();clear(ui.status);const coverage=currentDeepCoverage();
    if(!state.working&&!state.results&&!coverage){ui.status.hidden=true;return;}ui.status.hidden=false;
    const stage=coverage&&!state.working?coverage.label:state.stats.stage||(state.paused?'일시 정지':'검색 중');
    const head=e('div',{class:'scan-head'});head.append(e('strong',{},stage),e('span',{},state.paused?'일시 정지':state.working?'진행 중':coverage?.incomplete?'일부 범위 확인 필요':'완료'));ui.status.append(head);
    ui.status.append(e('p',{},scanDetail()));
    const completed=state.stats.bytesChecked??state.stats.bytesWritten??state.stats.bytesRead??state.stats.recordsRead;
    const full=state.stats.bytesTotal??state.stats.recordsTotal;
    const percent=coverage?coverage.percent:state.stats.percent??state.stats.progress??(full>0&&completed!==undefined?completed/full*100:NaN);
    if(Number.isFinite(percent))ui.status.append(e('progress',{max:'100',value:String(Math.max(0,Math.min(100,percent))),'aria-label':'진행률'}));
    const controls=e('div',{class:'scan-actions'});if(state.working)controls.append(e('button',{type:'button',onClick:togglePause},state.paused?'이어하기':'일시 정지'),e('button',{type:'button',onClick:cancelJob},'검색 취소'));ui.status.append(controls);
  }
  function scanDetail(){
    const s=state.stats||{},parts=[],count=value=>Number.isFinite(value)?value.toLocaleString('ko-KR'):'확인 중';
    const coverage=currentDeepCoverage();if(coverage)return deepCoverageText(coverage);
    if(state.source?.autoScope)parts.push(sourceLabel());
    if(s.bytesChecked!==undefined)parts.push('저장본 확인 '+formatBytes(s.bytesChecked)+' / '+formatBytes(s.bytesTotal));
    if(s.bytesWritten!==undefined)parts.push(`저장 ${formatBytes(s.bytesWritten)} / ${formatBytes(s.bytesTotal)}`);
    if(s.filesProcessed!==undefined)parts.push(`처리 ${count(s.filesProcessed)}/${count(s.filesTotal)}개 · 파일 저장 ${count(s.filesWritten)}개`);
    if(s.filesVisited!==undefined)parts.push(`파일 ${count(s.filesVisited)}개 확인`);
    if(s.journalBytesRead!==undefined)parts.push(`삭제 이벤트 ${formatBytes(s.journalBytesRead)} 확인`);
    if(s.journalRecordsRead!==undefined)parts.push(`이벤트 ${count(s.journalRecordsRead)}건`);
    if(s.eventsRead!==undefined)parts.push(`삭제·이름 변경 이력 ${count(s.eventsRead)}건`);
    if(s.deletionTraces!==undefined)parts.push(`본문 위치 미확인 이력 ${count(s.deletionTraces)}개 · 복구 건수 아님`);
    const captured=s.capture||(state.progressStage==='capture'?s:null);if(captured)parts.push(`본문 ${count(captured.captured)}개 확보 · 정상 복구 여부 미확인${captured.limited?' · 확보 한도 도달':''}`);
    if(s.slotsVisited!==undefined)parts.push(`빈 기록 ${count(s.slotsVisited)}개 확인`);
    if(s.bytesRead!==undefined&&s.journalBytesRead===undefined)parts.push(`읽음 ${formatBytes(s.bytesRead)}`);
    if(s.recordsRead!==undefined){const kind=state.progressStage==='journal'&&s.journalRecordsRead===undefined?'삭제 이벤트':['period-records','combined-records','recent-priority'].includes(state.progressStage)||['journal-first','native-journal'].includes(state.coverage?.strategy)?'연결된 파일 기록':'파일 관리 기록';parts.push(`${kind} ${count(s.recordsRead)}${s.recordsTotal!==undefined?'/'+count(s.recordsTotal):''}개 확인`);}
    const provisional=state.working&&state.progressStage==='period-records';
    const found=(provisional?s.provisionalCandidates:undefined)??s.candidatesFound??s.count??s.found;if(found!==undefined)parts.push(provisional?`검증 전 기록 ${count(found)}개 · 파일 후보 확정 전`:`${state.mode==='deleted'?'삭제 후보':'후보'} ${count(found)}개 발견`);
    if(s.eta?.minSeconds!==undefined)parts.push(`약 ${Math.ceil(s.eta.minSeconds/60)}~${Math.ceil(s.eta.maxSeconds/60)}분 남음`);
    return parts.length?parts.join(' · '):state.working?'검색 범위와 시간을 계산하고 있어요.':'작업 상태를 확인하세요.';
  }
  function renderResults(){
    if(!state.jobId){if(state.viewMode==='program')renderProgramEmpty();syncModeControls();return;}
    ui.results.hidden=false;ui.count.textContent=String(state.total);
    $('#results-title').textContent=state.mode==='deep'?'정밀 검색 후보':state.mode==='deleted'?'삭제 기록 후보':state.mode==='traces'?'최근 문서 이름·경로 단서':state.mode==='autosave'?'자동 저장 위치의 사본':'찾은 파일';
    $('.list-columns span:last-child').textContent=state.mode==='traces'?'단서의 종류 · 상태':state.mode==='autosave'?'사본 수정 · 크기 · 상태':'삭제 시각 · 크기 · 상태';
    $('#period-label').textContent='삭제 기록 기간';
    const note=$('#deletion-time-note');note.hidden=!['recycle','deleted','deep','autosave','traces'].includes(state.mode);
    note.textContent=state.mode==='traces'?'최근 문서 바로가기에 남은 이름·경로입니다. 파일 본문이나 삭제 여부는 확인하지 않았고 대상 경로에는 접근하지 않아요.':state.mode==='autosave'?'현재 남은 사본입니다. 원본과의 관계·최신 버전 여부는 미확인입니다. 임시 파일은 문서 조각일 수 있고, 미리보기가 지원되지 않을 수 있어요.':state.mode==='recycle'?'휴지통에 들어간 시각 기준입니다. 휴지통을 비운 시각과는 다릅니다.':state.mode==='deep'?'본문 흔적에서 찾은 후보입니다. 원래 이름과 삭제 시각이 남아 있지 않을 수 있어요.':'삭제 기록 후보를 표시해요. 내용 복구는 미리보기와 저장으로 확인해주세요. 삭제 시각 미확인 후보는 별도로 모았습니다.';
    renderMatchNotice();renderScanWarnings();
    const scrollTop=ui.list.scrollTop;clear(ui.list);
    if(!state.items.length){
      const verificationFailed=!state.working&&!state.scannedTotal&&journalValidationFailed();
      const empty=e('div',{class:'empty-state'});empty.append(e('strong',{},state.working?(state.mode==='traces'?'최근 문서 이름·경로를 확인하고 있어요':state.mode==='autosave'?'자동 복구 위치를 확인하고 있어요':'삭제 흔적을 확인하고 있어요'):verificationFailed?'검증을 마친 파일 후보가 없어요':'현재 조건에 맞는 후보가 없어요'),e('p',{},state.working?'찾은 후보는 준비되는 대로 목록에 추가됩니다.':verificationFailed?'이번 검색에서 삭제 이력을 읽거나 검증하지 못했어요. 삭제 파일이 없다는 뜻은 아니에요. 선택 기간으로 다시 검색하거나 전체 기록 검색으로 이어갈 수 있어요.':state.mode==='deep'?(deepCoverageView(state.coverage)?.incomplete?'미검사 영역이 남아 있어요. 이미지 검색 체크포인트가 있으면 이전 작업 기록에서 검증 후 이어서 검사할 수 있어요.':'선택한 범위에서 지원하는 파일 흔적을 찾지 못했어요. 원래 파일이 없었다는 뜻은 아닙니다.'):state.mode==='traces'?'지원하는 바로가기에서 조건에 맞는 경로 단서를 찾지 못했어요. 문서가 없거나 삭제됐다는 뜻은 아닙니다.':state.mode==='autosave'?'기본 자동 복구 위치에서 조건에 맞는 사본을 찾지 못했어요. 앱에서 직접 지정한 폴더는 다른 백업 폴더 선택으로 확인해주세요.':'기간을 넓히거나 시각 미확인 후보를 포함해보세요. 아래에서 정밀 검색으로 이어갈 수도 있어요.'));ui.list.append(empty);
    } else state.items.forEach((item,index)=>{
      if(!['autosave','traces'].includes(state.mode)&&ui.sort.value.startsWith('deleted')&&(index===0||deletionMillis(state.items[index-1].deletedAt)!==null&&deletionMillis(item.deletedAt)===null))ui.list.append(e('h3',{class:'deletion-time-heading'},deletionMillis(item.deletedAt)===null?'삭제 시각 미확인':state.mode==='recycle'?'휴지통 이동 시각 확인됨':'삭제 기록 시각 확인됨'));
      const card=e('article',{class:'candidate'+(state.freshIds?.has(item.id)?' fresh-candidate':''),role:'listitem',tabindex:'0','aria-label':fmt(item.name)+' · 정보와 미리보기',dataset:{candidateId:item.id,selected:String(state.selected.has(item.id)),preview:String(state.previewId===item.id)}});
      const top=e('div',{class:'candidate-top'}),check=e('input',{type:'checkbox','aria-label':fmt(item.name)+' 선택'});
      const saveable=canSelectForRecovery(item);
      if(!saveable)state.selected.delete(item.id);
      check.checked=state.selected.has(item.id);check.disabled=!saveable;
      check.addEventListener('change',()=>{check.checked?state.selected.add(item.id):state.selected.delete(item.id);card.dataset.selected=String(check.checked);renderResultActions();});
      const main=e('div',{class:'candidate-main'});
      main.append(e('div',{class:'candidate-name'},fmt(item.name)),e('div',{class:'candidate-meta'},(item.autosave?item.autosave.app+' · '+item.autosave.name:item.source==='deletion-trace'?'Windows 삭제 이력':sourceText(item.source))+' · '+formatBytes(item.size)+' · '+fileType(item.name)));
      if(item.restorationName?.name)main.append(e('div',{class:'candidate-meta name-hint'},(item.source==='deletion-trace'?'삭제 이전 이름: ':'복원할 이름: ')+item.restorationName.name));
      else if(item.previousNameHints?.length)main.append(e('div',{class:'candidate-meta name-hint'},'이전 이름 이력: '+item.previousNameHints.join(' · ')));
      const date=deletionMillis(item.deletedAt);
      main.append(e('div',{class:'candidate-meta deletion-time'},item.source==='recent-link'?'바로가기 수정 '+dateText(item.clue?.shortcutModifiedAt)+' · 삭제·열람 시각 아님':item.autosave?'사본 수정 '+dateText(item.modifiedAt):date===null?'삭제 시각 미확인':(item.source==='recycle-bin'?'휴지통 이동 ':'삭제 기록 ')+dateText(date)));
      if(item.originalPath||item.path)main.append(e('div',{class:'candidate-meta',title:fmt(item.originalPath||item.path)},fmt(item.originalPath||item.path)));
      const match=item.nameMatch;if(match&&ui.path.value.trim())main.append(e('span',{class:'name-match',dataset:{match:match.kind},title:match.reason||''},matchLabel(match.kind)));
      if(item.semanticScore!==null&&item.semanticScore!==undefined)main.append(e('div',{class:'candidate-reason'},'파일명 의미 유사도 '+item.semanticScore+'점 · 복구 확률과 다름'));
      if(Array.isArray(item.reasons)&&item.reasons.length)main.append(e('div',{class:'candidate-reason details-reason'},item.reasons.map(reasonText).join(' · ')));
      top.append(check,main,e('span',{class:'tag '+fmt(item.status)},candidateStatusText(item)));card.append(top);
      const open=()=>showInlinePreview(item.id);
      card.addEventListener('click',event=>{if(!event.target.closest('button,input,a'))void open();});
      card.addEventListener('keydown',event=>{if(event.target!==card)return;if(event.key==='Enter'||event.key===' '){event.preventDefault();void open();}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const cards=[...ui.list.querySelectorAll('article.candidate')],at=cards.indexOf(card),next=event.key==='Home'?0:event.key==='End'?cards.length-1:Math.max(0,Math.min(cards.length-1,at+(event.key==='ArrowDown'?1:-1)));cards[next]?.focus();}});
      card.addEventListener('dblclick',event=>{if(saveable&&!event.target.closest('button,input,a'))void saveFiles([item.id]);});
      const actions=e('div',{class:'candidate-actions'});actions.append(e('button',{type:'button',onClick:open},'정보 · 미리보기'));
      if(saveable)actions.append(e('button',{type:'button',disabled:state.working||state.saving,onClick:()=>saveFiles([item.id])},item.autosave?'사본 저장':'복구해서 저장'));
      const earlier=earlierCaptureOffer(item);
      if(earlier)actions.append(e('button',{type:'button',onClick:()=>showInlinePreview(item.id,earlier.jobId)},'이전 확보본 보기'),e('button',{type:'button',disabled:state.working||state.saving,onClick:()=>saveFiles([item.id],earlier.jobId)},'이전 확보본 저장'));
      if(['deletion-trace','recycle-metadata','directory-slack'].includes(item.source))actions.append(e('button',{type:'button',disabled:state.working||state.saving,onClick:goDeeper},'같은 드라이브 정밀 검색'));
      if(item.source==='existing-file')actions.append(e('button',{type:'button',onClick:()=>openCandidate(item.id)},'위치 열기'));
      card.append(actions);ui.list.append(card);
    });
    ui.list.scrollTop=scrollTop;state.freshIds=new Set();renderResultActions();syncModeControls();
  }
  function renderResultActions(){
    clear(ui.actions);ui.actions.append(e('p',{},state.selected.size+'개 선택됨 · '+state.items.length+' / '+state.total+'개 표시'+(state.pendingCandidates?' · 새 후보가 있어요.':'')));
    if(state.pendingCandidates)ui.actions.append(e('button',{type:'button',onClick:()=>loadCandidates(0,true)},'새 후보 반영'));
    const pageSize=state.viewMode==='program'?25:5,offset=state.pageOffset||0;
    if(offset>0)ui.actions.append(e('button',{id:'candidates-previous',type:'button',onClick:()=>loadCandidates(Math.max(0,offset-pageSize),true)},'이전 목록'));
    if(offset+state.items.length<state.total)ui.actions.append(e('button',{id:'candidates-next',type:'button',onClick:()=>loadCandidates(offset+pageSize,true)},'다음 목록'));
    if(state.total>pageSize){
      const pages=Math.ceil(state.total/pageSize),current=Math.floor(offset/pageSize)+1;
      const label=e('label',{},`페이지 (전체 ${pages}) `),input=e('input',{id:'candidate-page',type:'number',min:1,max:pages,value:current,'aria-label':'후보 목록 페이지'});
      label.append(input);ui.actions.append(label,e('button',{id:'candidates-go',type:'button',onClick:()=>{const n=Number(input.value);if(Number.isInteger(n)&&n>=1&&n<=pages)void loadCandidates((n-1)*pageSize,true);}},'이동'));
    }
    if(state.selected.size)ui.actions.append(e('button',{type:'button',class:'primary',disabled:state.working||state.saving,onClick:beginRecover},'선택 파일 저장'));
    if(!state.working&&state.mode!=='salvage'&&state.viewMode==='chat')ui.actions.append(e('button',{type:'button',onClick:state.mode==='traces'?showRecentTraces:state.mode==='autosave'?showBackups:showSummary},'원하는 파일 없음 · 다른 검색'));
    if(!state.working)appendNextLocation(ui.actions);
    if(state.results)renderCompletionActions();
  }
  function renderMatchNotice(){
    const node=$('#match-notice'),query=ui.path.value.trim(),counts=state.matchCounts;
    node.hidden=!query||!state.jobId;
    if(node.hidden)return;
    const exact=counts?.exact||0,partial=counts?.partial||0,similar=counts?.similar||0;
    const scope=state.working?'현재까지 확인한 후보에서':'현재 검색 범위와 기간에서';
    if(exact){node.dataset.tone='info';node.textContent='이름이 문자 기준으로 일치하는 후보 '+exact+'개를 찾았어요. 이름 일치는 원본 내용이 같다는 뜻은 아니에요.';}
    else if(partial||similar){node.dataset.tone='info';node.textContent=scope+' 이름이 완전히 일치하는 파일은 없어요. 일부 일치 '+partial+'개 · 유사한 이름 '+similar+'개가 있으니 기본 정보와 미리보기를 확인해보세요.';}
    else{node.dataset.tone='warning';node.textContent=scope+' 입력한 이름과 일치하는 파일을 찾지 못했어요. 휴지통 이동이나 삭제 과정에서 이름이 바뀌었거나 원래 이름 정보가 사라졌을 수 있어요. 아래 후보의 종류·크기·날짜와 미리보기를 확인해보세요.';}
  }
  function activeJobId(){return state.recoveryJobId||state.jobId;}
  async function togglePause(){ const jobId=activeJobId();if(state.paused){const r=await invoke('resume',jobId);if(r!==null){state.paused=false;state.working=true;}}else{const r=await invoke('pause',jobId);if(r!==null)state.paused=true;}renderStatus(); }
  async function cancelJob(){ const r=await invoke('cancel',activeJobId());if(r!==null){state.stats.stage='중단 처리 중';state.paused=false;say('중단을 요청했어요. 읽기와 쓰기가 멈출 때까지 잠시 기다려주세요.');renderStatus();} }
  async function beginRecover(){await saveFiles([...state.selected]);}
  async function saveFiles(ids,earlierJobId=null){
    if(state.saving||state.starting)return;
    if(state.working){showNotice('검색이 끝나거나 취소 처리가 끝난 뒤 저장할 수 있어요.');return;}
    if(!ids.length)return;
    state.saving=true;const jobId=state.jobId;renderResults();
    try{
      if(state.previewPromise)await state.previewPromise.catch(()=>{});
      if(state.jobId!==jobId)return;
      const destination=await invoke('chooseDestination');
      if(!destination||state.jobId!==jobId)return;
      const previous={destination:state.destination,selected:state.selected,results:state.results,stats:state.stats,recoveryJobId:state.recoveryJobId};
      state.destination=destination;state.selected=new Set(ids);state.recoveryJobId=earlierJobId||jobId;state.working=true;state.results=null;state.stats={stage:earlierJobId?'이전 확보본 저장 중':'본문 복구 중'};
      showNotice('');
      const result=await invoke('recover',{jobId,ids,destinationId:destination.id,...(earlierJobId?{earlierJobId}:{})});
      if(!result?.jobId){Object.assign(state,previous,{working:false});return;}
      state.recoveryJobId=result.jobId;
      if(state.working)say(earlierJobId?`${ids.length}개 이전 확보본을 ${destination.label||'선택한 폴더'}에 저장하고, 저장한 본문을 다시 확인할게요.`:`${ids.length}개 파일을 ${destination.label||'선택한 폴더'}에 복구하고, 저장한 본문을 다시 확인할게요.`);
    }finally{state.saving=false;renderStatus();renderResults();}
  }
  async function preview(id){return showInlinePreview(id);}
  async function showInlinePreview(id,earlierJobId=null){
    const item=state.items.find(x=>x.id===id);if(!item)return;
    const offer=earlierJobId?earlierCaptureOffer(item):null;if(earlierJobId&&(!offer||offer.jobId!==earlierJobId))return;
    state.previewId=id;state.previewEarlierJobId=earlierJobId;const jobId=state.jobId,token=state.previewToken=(state.previewToken||0)+1;
    const panel=$('#preview-panel'),content=$('#preview-content');panel.dataset.selected='true';panel.dataset.state='loading';$('#preview-title').textContent=fmt(item.name);
    clear(content);content.classList.remove('preview-enter');requestAnimationFrame(()=>content.classList.add('preview-enter'));
    const details=e('dl',{class:'preview-details'});
    const field=(title,value)=>details.append(e('dt',{},title),e('dd',{},value));
    field('파일 종류',fileType(item.name));field('크기',formatBytes(item.size));
    if(!item.autosave&&item.source!=='recent-link')field(item.source==='recycle-bin'?'휴지통 이동':'삭제 기록',dateText(item.deletedAt));field('수정 시각',dateText(item.modifiedAt));
    field(item.source==='recent-link'?'바로가기에 남은 경로':item.source==='recycle-metadata'?'정보에 적힌 원래 위치':'발견 위치',fmt(item.originalPath||item.path||state.source?.label||'위치 미확인'));field('현재 상태',candidateStatusText(item));if(item.autosave){field('사본 출처',item.autosave.app+' · '+item.autosave.name);field('원본과의 관계','같은 문서·최신 버전 여부 미확인');}
    if(item.source==='recent-link'){const evidence=item.clue?.targetEvidence;const derived=evidence?.source?.includes('relative')||evidence?.confidence==='relative-derived';field('단서 파일',item.shortcutPath||'미확인');field('대상 존재 여부','확인하지 않음');field('삭제 여부','확인하지 않음');field('경로 근거',derived?'상대 경로에서 계산 · 실제 위치 미확인':item.originalPath?'바로가기에 기록된 경로 · 실제 위치 미확인':'지원되는 경로 정보 없음');}
    if(item.source==='deleted-record')field('발견 근거','남아 있는 삭제 기록 · 내용 보존 여부는 별도 확인');
    if(item.source==='deletion-trace'){
      field('발견 근거','Windows 변경 기록에 남은 삭제 사건 · 파일 본문은 아직 찾지 못함');
      field('삭제 당시 이름',fmt(item.discoveredName));
      field('복구 가능 여부','아직 판단할 수 없어요. 이 항목은 저장하거나 미리 볼 본문이 없습니다.');
    }
    if(item.source==='recycle-metadata'){
      field('기록된 원본 크기',formatBytes(item.recordedSize));
      field('휴지통 이동 시각',dateText(item.recycledAt)+' · 영구 삭제 시각은 아님');
      field('발견 근거','삭제된 휴지통 정보 파일 · '+fmt(item.discoveredName));
      field('복구 가능 여부','이름·경로가 남은 단서예요. 저장하거나 미리 볼 본문이 없습니다.');
    }
    if(item.source==='directory-slack'){
      field('발견 근거',item.provenance==='ntfs-index-freed-buffer'?'사용 해제된 폴더 기록 블록':'폴더 기록의 남는 영역');
      field('발견 폴더',fmt(item.directoryName)+' · 기록 '+fmt(item.directoryReference?.recordNumber));
      field('기록된 크기',formatBytes(item.recordedSize));
      field('기록된 수정 시각',dateText(item.recordedModifiedAt)+' · 삭제 시각은 아님');
      field('복구 가능 여부','이름 흔적은 남아 있지만 삭제 여부와 본문 위치는 아직 확인하지 못했어요.');
    }
    if(item.previousNameHints?.length)field('이전 이름 이력',item.previousNameHints.join(' · '));
    if(item.restorationName?.name)field(item.source==='deletion-trace'?'삭제 이전 이름':'복원할 이름',item.restorationName.name+' · 이름 변경 기록 연결');
    if(item.status==='readable'&&item.namedStreamPolicy?.streams?.some(stream=>stream.name==='Zone.Identifier'))field('다운로드 출처 정보','본문과 함께 보존해 저장해요. 보존할 수 없는 저장 위치에서는 저장을 완료하지 않아요.');
    if(item.nameMatch&&ui.path.value.trim())field('이름 비교',matchLabel(item.nameMatch.kind)+' · '+(item.nameMatch.reason||''));
    content.append(details);
    if(item.reasons?.length)content.append(e('p',{class:'preview-note'},item.reasons.map(reasonText).join(' · ')));
    const body=e('div',{class:'preview-document','aria-live':'polite'});content.append(body);
    document.querySelectorAll('.candidate').forEach(card=>card.dataset.preview=String(card.dataset.candidateId===id));
    if(item.source==='recent-link'){panel.dataset.state='metadata-only';body.append(e('p',{class:'preview-note'},'이 항목에는 문서 본문이 없습니다. 표시한 이름·경로를 삭제 기록 검색이나 다른 사본 찾기의 단서로 사용해주세요. 바로가기와 대상 파일은 실행하지 않습니다.'));return;}
    if(['deletion-trace','recycle-metadata','directory-slack'].includes(item.source)){
      panel.dataset.state='metadata-only';
      body.append(e('p',{class:'preview-note'},item.source==='directory-slack'?'저장하거나 미리 볼 본문이 없습니다. 정밀 검색에서 찾은 자료와의 연결은 별도 확인이 필요해요.':item.source==='recycle-metadata'?'원래 이름이 남아 있어도 파일 본문과 연결된 것은 아니에요. 정밀 검색에서 찾은 자료가 이 파일인지는 별도 확인해야 합니다.':'파일 관리 기록이 재사용되거나 달라져도 삭제 이력은 남을 수 있어요. 정밀 검색은 이 드라이브의 본문 흔적을 찾으며, 발견한 자료가 이 파일인지는 별도 확인해야 합니다.'),e('button',{type:'button',disabled:state.working||state.starting||state.saving,onClick:goDeeper},'같은 드라이브 정밀 검색'));
      return;
    }
    if(state.working||state.starting||state.saving||state.previewLoading){
      state.previewDeferred=true;panel.dataset.state='waiting';body.append(e('p',{class:'preview-note'},'기본 정보를 먼저 보여드려요. 현재 작업이 끝나면 선택한 파일의 미리보기를 불러옵니다.'));return;
    }
    const canPreview=Boolean(offer)||canSelectForRecovery(item)||item.status==='reconstructed';
    if(!canPreview){panel.dataset.state='unsupported';body.append(e('p',{class:'preview-note'},'이 후보의 내용을 현재 읽을 수 없어 미리보기를 제공하지 못해요. 위의 기록과 상태를 확인해주세요.'));return;}
    const loading=e('div',{class:'preview-loading',role:'status','aria-label':'미리보기를 불러오는 중'});loading.append(e('i'),e('i'),e('i'));body.append(loading);
    state.previewLoading=true;syncModeControls();
    try{
      const previewRequest=invoke('preview',{jobId,id,...(earlierJobId?{earlierJobId}:{})});state.previewPromise=previewRequest;
      const value=await previewRequest;
      if(token!==state.previewToken||jobId!==state.jobId)return;
      if(item.requiresPreparation){await loadCandidates(state.pageOffset||0,true);if(token!==state.previewToken||jobId!==state.jobId)return;}
      clear(body);
      if(!value){panel.dataset.state='error';body.append(e('p',{class:'preview-note'},'미리보기를 불러오지 못했어요. 파일 상태를 확인한 뒤 다시 시도해주세요.'));return;}
      panel.dataset.state=value.type==='unsupported'?'unsupported':'ready';
      const preserved=earlierJobId?earlierCaptureOffer(value):null;
      if(earlierJobId&&(!preserved||preserved.jobId!==earlierJobId||preserved.sha256!==offer.sha256||preserved.size!==offer.size||preserved.capturedAt!==offer.capturedAt)){panel.dataset.state='error';body.append(e('p',{class:'preview-note'},'이전 확보본의 확인 정보를 받지 못했어요. 현재 원본 미리보기로 자동 전환하지 않았습니다.'));return;}
      if(value.type==='text'){
        body.append(e('p',{class:'preview-note'},/\.pdf$/i.test(item.name)?'PDF 텍스트 미리보기 · 원래 서식과 모든 페이지를 재현하지 않습니다.':'문서 텍스트 미리보기 · 원래 배치와 서식은 다를 수 있습니다.'),e('pre',{class:'preview-text'},value.text||'표시할 수 있는 텍스트가 없습니다.'));
      }else if(value.type==='image'&&/^data:image\/(png|jpeg|gif|webp);base64,/.test(value.dataUrl||''))body.append(e('img',{class:'preview-image',alt:fmt(item.name)+' 미리보기',src:value.dataUrl}));
      else body.append(e('p',{class:'preview-note'},previewReason(value.reason)));
      if(value.truncated)body.append(e('p',{class:'preview-note'},'크기 또는 지원 범위 때문에 일부 내용만 표시합니다.'));
      if(preserved)body.append(e('p',{class:'preview-note'},'보관 시각: '+dateText(preserved.capturedAt)),e('p',{class:'preview-note'},'이전 검색에서 보관한 본문이에요. 현재 원본을 다시 읽은 결과가 아니며 삭제 전 원본과의 동일성은 미확인이에요.'));
      body.append(e('p',{class:'preview-note'},'미리보기는 저장이나 원본 동일성 확인을 뜻하지 않습니다.'));
      const currentItem=state.items.find(candidate=>candidate.id===id)||item;
      const currentStatus=[...details.querySelectorAll('dt')].find(node=>node.textContent==='현재 상태')?.nextElementSibling;
      if(currentStatus)currentStatus.textContent=candidateStatusText(currentItem);
      if(canSelectForRecovery(currentItem))body.append(e('button',{type:'button',class:'primary-button preview-save',onClick:()=>saveFiles([id],earlierJobId)},earlierJobId?'이전 확보본 저장':item.autosave?'이 사본 저장':'이 파일 복구해서 저장'));
    }finally{
      state.previewLoading=false;state.previewPromise=null;syncModeControls();
      if(state.previewDeferred&&state.previewId&&!state.working&&!state.saving){state.previewDeferred=false;void showInlinePreview(state.previewId,state.previewEarlierJobId||null);}
    }
  }
  function previewReason(reason){const text=String(reason||'');if(/ENCRYPT|PROTECT/.test(text))return '암호나 보호 설정이 있어 내용을 표시할 수 없어요.';if(/LIMIT|TOO_LARGE/.test(text))return '안전한 미리보기의 크기 한도를 넘었어요. 별도 저장 후 해당 프로그램에서 확인해주세요.';if(/CHANGED/.test(text))return '검색 뒤 파일이 바뀌었어요. 다시 검색해주세요.';if(/CLOUD|OFFLINE/.test(text))return '온라인에만 있는 파일일 수 있어요. 서비스에서 내려받은 복사본을 선택해주세요.';if(/DAMAGED|INVALID|TRUNCATED|CRC/.test(text))return '지원 구조가 손상됐거나 불완전해서 내용을 표시할 수 없어요.';if(/^[A-Z_]+$/.test(text))return '이 파일 구조는 안전한 미리보기를 지원하지 않아요. 지원 범위를 확인해주세요.';return text||'이 파일은 안전한 미리보기를 지원하지 않아요.';}
  async function openCandidate(id){await invoke('openCandidate',{jobId:state.jobId,id});}
  function documentStatus(result){
    const doc=result.document;
    if(!doc)return '문서 상태 미확인';
    const labels={'preview-available':'내용 미리보기 확인',protected:'암호·보호 설정 확인 필요',damaged:'손상 가능성 · 문서 확인 필요','format-mismatch':'확장자와 내용 불일치','needs-check':'문서 확인 필요'};
    const limited=doc.assessmentLimited===true||doc.truncated===true||doc.reason==='FILE_TOO_LARGE';
    return (labels[doc.status]||'문서 상태 미확인')+(limited?(doc.status==='preview-available'?' · 미리보기 범위 제한':' · 문서 검사 범위 제한'):'')+(doc.format&&doc.format!=='unknown'?' · '+doc.format:'');
  }
  async function showRecoveredPreview(item){
    if(operationBusy())return;
    const jobId=state.recoveryJobId||state.jobId;
    const value=await invoke('previewRecovered',{jobId,id:item.id});
    if(!value||jobId!==(state.recoveryJobId||state.jobId))return;
    openDialog(item.name+' · 복구본 확인',body=>{
      body.append(e('p',{class:'preview-note'},'저장한 복구본을 다시 읽은 내용이에요. 문서 프로그램의 전체 서식·페이지와 삭제 전 원본의 동일성은 별도 확인이 필요해요.'));
      if(value.type==='text')body.append(e('pre',{class:'preview-text'},value.text||'표시할 수 있는 텍스트가 없습니다.'));
      else if(value.type==='image'&&/^data:image\/(png|jpeg|gif|webp);base64,/.test(value.dataUrl||''))body.append(e('img',{class:'preview-image',alt:item.name+' 복구본',src:value.dataUrl}));
      else body.append(e('p',{},previewReason(value.reason)));
      if(value.truncated)body.append(e('p',{class:'preview-note'},'지원 범위와 크기 한도 때문에 일부 내용만 보여드려요.'));
      const actions=e('div',{class:'dialog-actions'});
      actions.append(e('button',{type:'button',onClick:()=>invoke('showRecovered',{jobId,id:item.id})},'복구한 파일 위치 열기'),e('button',{type:'button',onClick:()=>ui.dialog.close()},'닫기'));
      body.append(actions);
    });
  }
  function renderCompletionActions(){
    const data=Array.isArray(state.results)?state.results:[];
    const resultJobId=state.recoveryJobId||state.jobId;
    const retryEarlierJobId=resultJobId!==state.jobId?resultJobId:null;
    const success=data.filter(item=>item.status==='saved'||state.mode==='salvage'&&item.path);
    const failed=data.filter(item=>!success.includes(item));
    const summary=recoverySummary(data);
    ui.actions.append(e('p',{class:'recovery-summary'},state.mode==='salvage'?`부분 자료 저장 ${success.length}개 · 미완료 ${failed.length}개`:`파일 저장 ${summary.filesWritten}개 · 문서 열림 확인 ${summary.documentOpenVerified}개 · 손상 자료 ${summary.damagedFilesWritten}개 · 미저장 ${summary.filesNotSaved}개`));
    if(summary.filesWrittenUnverified)ui.actions.append(e('p',{class:'recovery-check'},`저장 파일 중 확인 실패 ${summary.filesWrittenUnverified}개 · 파일은 기록됐지만 현재 내용과 상태를 확인하지 못했어요.`));
    if(summary.documentAssessmentsLimited)ui.actions.append(e('p',{class:'preview-note'},`문서 검사 범위 제한 ${summary.documentAssessmentsLimited}개 · 저장한 파일은 해당 문서 프로그램에서도 확인해주세요.`));
    if(!['salvage','autosave'].includes(state.mode))ui.actions.append(e('p',{class:'preview-note'},`삭제 전 원본 바이트 일치 확인 ${summary.originalBytesVerified}개 · 원래 이름 복원 ${summary.originalNamesRestored}개 · 미리보기 가능 ${summary.previewsAvailable}개. 미리보기만으로 전체 문서가 정상이라고 확정하지 않아요.`));
    if(state.mode!=='autosave'&&success.some(item=>item.originalIdentityVerified===false))ui.actions.append(e('p',{class:'preview-note'},'저장한 본문의 확인 결과와 원래 이름 복원 여부를 아래에서 볼 수 있어요. 삭제 전 원본과 같은지, 문서 프로그램에서 전체가 열리는지는 별도 확인이 필요해요.'));
    for(const item of data){
      const card=e('section',{class:'recovery-result',dataset:{resultId:item.id||'',documentStatus:item.document?.status||'unknown'}});
      const outcome=recoveryOutcome(item);
      if(item.autosave)card.append(e('p',{class:'preview-note'},'자동 저장 위치의 사본 저장 · '+item.autosave.app+' · 원본과의 관계·최신 버전 여부 미확인'));
      const resultLabels={'written-unverified':'파일 기록됨 · 저장 확인 실패','damaged-data-saved':'문서 손상 확인 · 손상 자료 저장','original-verified':'삭제 전 원본 바이트 일치 확인','document-open-verified':'문서 열림 확인','partial-content-saved':'일부 본문 저장 · 전체 복구 미완료','preview-checked':'미리보기 가능 · 전체 문서 미확인','saved-unchecked':'파일 저장 · 문서 상태 미확인','not-saved':statusText(item.status)};
      card.append(e('strong',{},item.name),e('p',{class:'candidate-meta'},`${resultLabels[outcome.kind]}${item.error?' — '+item.error:''}`));
      if(item.integrity?.status==='verified')card.append(e('p',{class:'recovery-check'},'읽어온 바이트와 저장본의 크기·SHA-256 일치 · 삭제 전 원본과의 비교는 별도예요.'));
      if(item.preservation?.source==='earlier-discovery-capture')card.append(e('p',{class:'recovery-check'},'이전 검색에서 확보한 본문을 저장했어요 · 보관 시각 '+dateText(item.preservation.capturedAt)+' · 삭제 전 원본과의 동일성은 미확인이에요.'));
      if(item.diagnostic?.readFailure)card.append(e('p',{class:'recovery-check'},`원본에서 요청한 ${formatBytes(item.diagnostic.readFailure.requestedBytes)} 구간을 읽지 못했어요. 정확한 손상 바이트 수는 미확정이에요.`));
      if(item.coverage?.mode==='sequential-local-zip'){
        const c=item.coverage;
        card.append(e('p',{class:'recovery-check'},`텍스트 ${c.extractedParts}개 부분 저장 · 미추출 ${c.skippedParts.length}개 · 전체 문서 복구는 아니에요.`));
        if(c.unexaminedBytes)card.append(e('p',{class:'preview-note'},`손상 지점 뒤 ${formatBytes(c.unexaminedBytes)}는 구조를 확인하지 못했어요.`));
        const details=e('details');details.append(e('summary',{},'추출한 부분과 빠진 부분'),e('pre',{class:'preview-text'},JSON.stringify({extractedParts:item.extractedParts,coverage:c},null,2)));card.append(details);
      }
      if(item.diagnostic){
        const labels={'record-reuse-confirmed':'파일 기록 자리 재사용 확인','source-change-observed':'검색 후 기록 변경 확인 · 재사용 여부는 상세 근거 참고','document-damage-observed':'본문 형식 불일치 또는 손상 확인','read-or-access-failed':'읽기 또는 접근 실패','record-interpretation-failed':'기록 해석 실패 또는 미지원','candidate-refused':'기록 상태 충돌로 복구 보류','output-verification-failed':'파일 기록 후 저장본 확인 실패','cause-unconfirmed':'실패 원인 미확정',cancelled:'처리 취소'};
        if(labels[item.diagnostic.category])card.append(e('p',{class:'recovery-check'},labels[item.diagnostic.category]));
        const details=e('details'),info=e('pre',{class:'preview-text'},JSON.stringify(item.diagnostic,null,2));
        details.append(e('summary',{},'확인 근거와 검사 범위'),info);card.append(details);
      }
      if(item.document){
        card.append(e('p',{class:'recovery-check'},documentStatus(item)));
        if(item.document.reason)card.append(e('p',{class:'preview-note'},previewReason(item.document.reason)));
      }
      if(item.nameRecovery){
        const names={'restored-from-history':'원래 이름 복원 · 이름 변경 기록 연결','record-name':'기록에 남은 파일명 사용',ambiguous:'이름 후보가 여러 개 · 임시 이름으로 저장',unknown:'원래 이름 미확인 · 발견한 이름으로 저장'};
        const nameLabel=item.nameRecovery.originalNameStatus==='restored-from-history'&&item.nameRecovery.adjustedForFilesystem?'원래 이름 일부 복원 · 저장 이름 조정':names[item.nameRecovery.originalNameStatus]||'원래 이름 미확인';
        card.append(e('p',{class:'recovery-check'},nameLabel));
        if(item.nameRecovery.alternatives?.length)card.append(e('p',{class:'preview-note'},'기록에 남은 이름 후보: '+item.nameRecovery.alternatives.map(value=>value.name).join(', ')));
        if(item.nameRecovery.adjustedForFilesystem)card.append(e('p',{class:'preview-note'},'파일명 길이나 사용할 수 없는 문자를 조정했어요. 확인한 이름: '+fmt(item.nameRecovery.name)));
      }
      if(item.path)card.append(e('p',{class:'candidate-meta recovery-path'},item.path));
      else if(item.details?.savedPath)card.append(e('p',{class:'preview-note'},'저장 확인을 마치지 못한 파일 위치: '+item.details.savedPath));
      if(item.status==='saved'&&item.supplementalStreams?.some(stream=>stream.name==='Zone.Identifier'&&stream.preservation==='preserved'))card.append(e('p',{class:'candidate-meta'},'다운로드 출처 정보(Zone.Identifier)도 함께 보존했어요.'));
      if(item.status==='saved'&&item.integrity?.status==='verified'){
       const actions=e('div',{class:'candidate-actions'}),jobId=state.recoveryJobId||state.jobId;
        actions.append(e('button',{type:'button',onClick:()=>showRecoveredPreview(item)},'복구본 미리보기'),e('button',{type:'button',onClick:()=>invoke('showRecovered',{jobId,id:item.id})},'파일 위치 열기'));
        card.append(actions);
      }
      ui.actions.append(card);
    }
    ui.actions.append(e('button',{type:'button',onClick:()=>invoke('openResult',{jobId:resultJobId})},'결과 폴더 열기'),e('button',{type:'button',onClick:()=>invoke('exportResults',{jobId:resultJobId})},'결과 목록 저장'),e('button',{type:'button',onClick:cleanupReview},'정리 대상 확인'));
    ui.actions.append(e('button',{type:'button',onClick:state.viewMode==='program'||state.mode==='salvage'?reset:showSummary},state.mode==='salvage'?'새 검색':'다른 후보 찾기'));if(failed.length)ui.actions.append(e('button',{type:'button',onClick:()=>{state.selected=new Set(failed.map(item=>item.id));void saveFiles([...state.selected],retryEarlierJobId);}},'미완료 항목 다시 시도'),e('button',{type:'button',onClick:()=>{state.selected=new Set(failed.map(item=>item.id));void saveFiles([...state.selected],retryEarlierJobId);}},'저장 위치 바꾸기'));
  }
  async function cleanupReview(){const result=await invoke('cleanup',{jobId:state.recoveryJobId||state.jobId,confirmed:false});if(!result)return;openDialog('정리 전 확인',body=>{body.append(e('p',{},`정리 대상: ${fmt(result.files.length)}개 · ${fmt(result.bytes)} 바이트. 복구 완료 파일은 정리하지 않습니다.`));for(const file of result.files||[])body.append(e('p',{class:'candidate-meta'},file.path));const row=e('div',{class:'dialog-actions'});row.append(e('button',{type:'button',class:'primary',onClick:async()=>{const ok=await invoke('cleanup',{jobId:state.recoveryJobId||state.jobId,confirmed:true,reviewId:result.reviewId});if(ok){ui.dialog.close();showNotice('정리 요청을 완료했습니다.','warning');}}},'이 항목 정리'),e('button',{type:'button',onClick:()=>ui.dialog.close()},'취소'));body.append(row);});}
  function openDialog(title,build){ui.dialogTitle.textContent=title;clear(ui.dialogContent);const body=e('div',{class:'dialog-body'});build(body);ui.dialogContent.append(body);ui.dialog.showModal();ui.dialog.querySelector('button')?.focus();}
  function showDesktopRequired(){state.step='데스크톱 연결 필요';clear(ui.question);ui.question.append(e('h1',{id:'question-title'},'데스크톱 앱에서 열어주세요'));ui.question.append(e('p',{},'이 브라우저에는 실제 장치와 복구 작업을 연결하는 데스크톱 브리지가 없습니다. 이 화면에서는 검색, 후보, 복구 완료 결과를 만들지 않습니다.'));if(demo){ui.question.append(e('p',{},'안내 미리보기 모드입니다. 선택 흐름만 볼 수 있으며 실제 검색은 시작하지 않습니다.'));actionRow([{label:'안내 흐름 보기',primary:true,click:showDemoFlow}]);}else{ui.question.append(e('p',{},'안내 흐름만 보려면 주소 끝에 ?demo=1 을 붙여 여세요.'));}ui.connection.textContent='데스크톱 브리지 없음';}
  function showDemoFlow(){state.step='미리보기';choices('안내 미리보기','실제 장치, 파일 후보, 검색 시간, 복구 결과는 표시하지 않습니다.',[{label:'직접 지웠어요',click:()=>{answer('직접 지웠어요');recycleGuide();}},{label:'찾아보니 없어요',click:()=>{answer('찾아보니 없어요');demoEnd();}},{label:'잘 모르겠어요',click:()=>{answer('잘 모르겠어요');demoEnd();}}]);}
  function demoEnd(){choices('데스크톱 앱에서 이어서 진행하세요','실제 장치 확인, 후보 검색, 미리보기, 저장 위치 선택은 데스크톱 브리지가 연결된 앱에서만 가능합니다.',[{label:'처음으로',click:showDesktopRequired}]);}
  function onEvent(event){
    if(!event||!event.jobId||event.jobId!==state.jobId&&event.jobId!==state.recoveryJobId)return;
    if(event.coverage)state.coverage=event.coverage;
    if(['cancelled','error'].includes(event.type)&&event.coverage?.strategy==='carving'){state.scanIncomplete=true;state.stats={...state.stats,...(event.stats||{})};}
    if(event.type==='progress'||event.type==='recover-progress'){
      const labels={traces:'최근 문서 경로 단서 확인 중',autosave:'자동 복구 위치의 사본 검색 중',scan:'삭제 기록 확인 중',search:'남아 있는 파일 검색 중',carve:'파일 흔적 검색 중',recover:'본문 복구 중','verify-recovery':'저장한 본문을 다시 확인하는 중',permission:'Windows 권한 확인 중','allocation-map':'빈 영역 확인 중',journal:'삭제 시각 기록 확인 중','semantic-rank':'파일명 의미 비교 중',recycle:'휴지통 파일 확인 중',copy:'파일 복사 중',hash:'선택 파일 내용 비교 중',read:'손상 파일 읽는 중',extract:'검증된 내용 추출 중',complete:'처리 결과 확인 중'};
      const stageLabels={'directory-freed-index':'사용 해제된 폴더 기록 확인 중','directory-slack':'폴더의 옛 이름 흔적 확인 중','recycle-metadata':'휴지통 정보 단서 확인 중',...labels,capture:'발견한 본문을 별도 디스크에 확보 중',journal:'삭제 이벤트 확인 중','native-journal':'Windows 삭제 이력 읽는 중','deletion-traces':'본문 위치가 없는 삭제 이력 정리 중','recent-priority':'최근 삭제된 파일 본문 먼저 확보 중','combined-records':'이력에 연결된 파일 기록 확인 중',bitmap:'빈 기록 자리 확인 중','vacancy-scan':'빈 기록에서 추가 후보 찾는 중','prepare-candidate':'선택한 파일 내용 확인 중','journal-discovery':'삭제 이벤트 위치 확인 중','period-records':'해당 기간의 파일 기록 확인 중',scan:state.coverage?.strategy==='mft-vacancy'?'빈 기록에서 추가 후보 찾는 중':'전체 파일 관리 기록 확인 중'};
      state.stats={...(state.progressStage!==event.stage?{}:state.stats),...(event.stats||{}),stage:event.stage==='scan'&&state.mode==='deep'?'파일 흔적 검색 중':stageLabels[event.stage]||event.stage||state.stats.stage,eta:event.eta};state.progressStage=event.stage;renderStatus();
      if(event.stage==='permission')showNotice(event.message||'Windows에서 한 번 허용하면 앱을 닫을 때까지 장치 읽기 권한을 재사용해요.');
    }else if(['candidate','candidate-batch'].includes(event.type)){state.pendingCandidates=true;let b=$('#refresh-candidates');if(!b){b=e('button',{id:'refresh-candidates',type:'button',onClick:()=>loadCandidates(0,true)},'새 후보 반영');ui.actions.prepend(b);}
    }else if(event.type==='candidates-removed'){const removed=new Set(event.ids||[]);for(const id of removed)state.selected.delete(id);state.items=state.items.filter(item=>!removed.has(item.id));loadCandidates(0,true);
    }else if(event.type==='candidate-limit'){showNotice(event.message);
    }else if(event.type==='paused'){state.paused=true;renderStatus();
    }else if(event.type==='resumed'){state.paused=false;state.working=true;renderStatus();
    }else if(event.type==='cancelled'){state.working=false;state.paused=false;if(event.results)state.results=event.results;say('작업을 중단했어요. 완료된 파일과 후보는 남아 있어요.');loadCandidates(0,true);
    }else if(event.type==='complete'){
      state.working=false;state.paused=false;state.scanIncomplete=event.complete===false;if(event.coverage)state.coverage=event.coverage;
      state.scanWarnings=Array.isArray(event.warnings)?event.warnings:[];state.scanWarningsJobId=state.jobId;
      state.stats={...state.stats,...(event.stats||{}),stage:'검색 결과'};
      say(currentDeepCoverage()?deepCoverageText(currentDeepCoverage()):journalValidationFailed()?'삭제 이력을 읽거나 검증하지 못한 범위가 있어요. 파일이 없다고 확정할 수 없으니 검색 경고를 확인해주세요.':state.coverage?.strategy==='native-journal'?'삭제 이력 검색을 마쳤어요. 본문 후보는 선택해 내용을 확인할 수 있어요. 삭제 이력만 확인된 항목은 본문 위치를 찾지 못했으니 정밀 검색으로 이어가세요.':state.coverage?.strategy==='journal-first'?'남아 있는 삭제 이벤트에서 해당 기간을 확인했어요. 기록이 없거나 시각을 모르는 파일은 전체 기록 검색으로 더 찾아볼 수 있어요.':event.complete===false?'확인한 범위의 검색을 마쳤어요. 일부 기록이나 범위는 확인하지 못했어요.':'검색을 마쳤어요. 후보를 확인해주세요.');
      showNotice(state.scanWarnings.length?`검색 경고 ${state.scanWarnings.length}건이 있어요. 파일 개수가 아니며, 결과 목록의 경고 전체 보기에서 내용을 확인할 수 있어요.`:'');
      loadCandidates(0,true);
    }else if(event.type==='recover-complete'){state.results=event.results||[];state.working=false;state.stats.stage='파일별 복구 결과';say('복구 처리가 끝났어요. 본문 확인 결과와 이름 복원 여부를 확인해주세요.');showNotice('');renderStatus();renderResults();
    }else if(event.type==='error'){state.working=false;state.paused=false;showNotice(event.error?.message||event.message||'작업 중 오류가 발생했어요.','error');if(event.error?.code==='WHOLE_SOURCE_REQUIRED'){if(state.viewMode==='program')showNotice((event.error?.message||'선택 범위의 검색을 진행할 수 없어요.')+' 아래 정밀 검색 버튼으로 전체 범위를 선택할 수 있어요.');else actionRow([{label:'전체 범위로 검색',primary:true,click:()=>{state.deepScope='whole';showNotifications();}}]);}renderStatus();renderResults();}
  }
  async function showTools(){openDialog('작업 도구',body=>{
    const add=(label,action)=>body.append(e('button',{type:'button',class:'choice',onClick:()=>{ui.dialog.close();action();}},label));
    add('원본 보관 · 이미지',()=>acquisitionUI.show());add('개발·검증 체크리스트',()=>workspaceShell.showView('roadmap'));add('이전 작업 기록',showHistory);add('저장하지 못한 문서 · 자동 저장본',showBackups);add('최근 문서 이름·경로 단서',showRecentTraces);add('지원 범위 · 버전 · 오픈소스',showSupport);add('손상 문서의 부분 내용 추출',()=>repairFile('document'));add('PNG 조각 재구성',()=>repairFile('png'));
    if(state.jobId){if(!['autosave','traces'].includes(state.mode))add('파일명 의미로 다시 정렬',showSemantic);if(state.mode==='copies'){add('선택한 파일끼리 내용 비교',compareSelected);add('파일명 인덱스 저장',async()=>{const r=await invoke('saveIndex',{jobId:state.jobId});if(r)showNotice('파일명 인덱스를 저장했어요: '+r.path);});add('기존 인덱스 불러오기',async()=>{const r=await invoke('loadIndex',{jobId:state.jobId});if(r){showNotice(`인덱스 재확인: 반영 ${r.stats.imported}개 · 변경 ${r.stats.changed}개 · 삭제·확인 불가 ${r.stats.deleted}개.${r.stats.skippedByLimit?' 후보 한도로 '+r.stats.skippedByLimit+'개를 가져오지 못했어요.':''} 현재 검색에 없는 새 파일은 별도 검색해야 해요.`);await loadCandidates(0,true);}});}add('현재 결과 목록 저장',()=>invoke('exportResults',{jobId:state.recoveryJobId||state.jobId}));add('임시 파일 정리 대상 보기',cleanupReview);}
  });}
  async function repairFile(kind){if(state.working){showNotice('현재 작업을 먼저 마쳐주세요.');return;}openDialog(kind==='png'?'제한적 PNG 재구성':'손상 문서 부분 추출',body=>{body.append(e('p',{},kind==='png'?'CRC가 맞는 IHDR·IEND와 최대 6개 IDAT 조각의 순서를 확인해요. 유효한 순서가 하나일 때만 재구성하며, 시간·처리량 한도를 넘으면 중단합니다.':'중앙 목록을 잃은 DOCX/XLSX/PPTX/HWPX에서 검증된 텍스트 부분을 새 파일로 저장해요. 일부 항목이 손상돼도 검증된 부분은 남기며, 추출하지 못한 부분을 함께 표시해요. 서식과 전체 문서를 되살리는 기능은 아닙니다.'),e('button',{type:'button',onClick:async()=>{ui.dialog.close();const r=await invoke('salvage',{kind});if(!r)return;state.jobId=r.jobId;state.recoveryJobId=null;state.source=r.source;state.destination=r.destination;state.mode='salvage';state.recent=false;state.working=true;state.items=[];state.total=0;state.results=null;state.selected.clear();clear(ui.question);state.stats={stage:'손상 파일의 검증된 부분 처리 중'};renderStatus();renderResults();}},'파일과 저장 위치 선택'));});}
  async function showSupport(){const r=await invoke('support');if(!r)return;openDialog('지원 범위 · '+r.version,body=>{body.append(e('p',{},'작업 기록 위치: '+r.workspace),e('pre',{class:'preview-text'},r.text));const details=e('details');details.append(e('summary',{},'오픈소스 고지'),e('pre',{class:'preview-text'},r.notices));body.append(details);});}
  async function showRecentTraces(){
    if(operationBusy()){showNotice('현재 작업을 먼저 마치거나 취소해주세요.');return;}
    const r=await invoke('recentTraces');if(!r)return;
    const run=async()=>{ui.dialog.close();await startSearch({source:r.source,mode:'traces',destination:null,resumeId:null,recent:false,filters:{},notifications:{mode:'complete',minutes:10}});};
    const text='Windows 최근 문서 바로가기에 남아 있는 이름·경로만 확인해요. 원래 문서가 존재하는지, 삭제됐는지는 판단하지 않아요. 대상 파일이나 네트워크 경로를 열지 않습니다.';
    if(state.viewMode==='program'){openDialog('최근 문서 이름·경로 단서',body=>{body.append(e('p',{},text),e('button',{type:'button',class:'primary',onClick:run},'이름·경로 단서 찾기'));});return;}
    state.step='최근 문서 단서';state.chatActive=true;choices('파일 이름이 기억나지 않나요?',text,[{label:'이름·경로 단서 찾기',primary:true,click:run}]);actionRow([{label:'처음으로',click:reset}]);syncModeControls();
  }
  async function showBackups(){
    if(operationBusy()){showNotice('현재 작업을 먼저 마치거나 취소해주세요.');return;}
    const r=await invoke('backups');if(!r)return;
    const locations=r.locations.filter(x=>x.exists);
    const scan=async()=>{ui.dialog.close();await startSearch({source:r.source,mode:'autosave',destination:null,resumeId:null,recent:false,filters:{},notifications:{mode:'complete',minutes:10}});};
    const description='Office 기본 자동 복구 위치 4곳에 남은 문서·임시 사본을 함께 찾아요. 원본과 같은 문서인지, 최신 버전인지는 내용을 확인해주세요.';
    if(state.viewMode==='program'){
      openDialog('자동 저장본 찾기',body=>{
        body.append(e('p',{},description),e('button',{type:'button',class:'primary',onClick:scan},'자동 저장 위치 한 번에 찾기'));
        if(!locations.length)body.append(e('p',{},'기본 위치에 읽을 수 있는 폴더가 없어요. 직접 지정한 저장 위치는 아래에서 선택해주세요.'));
        body.append(e('button',{type:'button',onClick:async()=>{ui.dialog.close();const source=await invoke('chooseSource','folder');if(source)configureProgramSearch('copies',source);}},'다른 백업 폴더 선택'));
      });return;
    }
    state.step='자동 저장본';state.chatActive=true;
    choices('저장하지 못한 문서도 확인해 볼게요',description,[{label:'자동 저장 위치 한 번에 찾기',primary:true,click:scan}]);
    if(!locations.length)ui.question.append(e('p',{},'현재 읽을 수 있는 자동 저장 폴더가 없어요. 앱의 파일 → 정보 → 문서 관리와 Windows 파일 기록도 확인해주세요.'));
    actionRow([{label:'다른 백업 폴더 선택',click:()=>chooseSource('folder')},{label:'처음으로',click:reset}]);syncModeControls();
  }
  function configureProgramSearch(mode,source,filters={},resumeId=null,deletedStrategy='auto'){
    state.programRoute=mode;state.programResumeId=resumeId;state.programFilters=filters;state.programDeletedStrategy=deletedStrategy;
    if(source)populateProgramDevices(source);
    $('#program-name').value=filters.name||'';
    const dateValue=value=>{if(!value)return '';const date=new Date(value);return Number.isNaN(date.getTime())?'':date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');};
    $('#deleted-after').value=dateValue(filters.deletedAfter);$('#deleted-before').value=dateValue(filters.deletedBefore);$('#include-unknown-date').checked=filters.includeUnknownDeletedAt!==false;
    updateProgramRoute();$('#program-controls').scrollIntoView({block:'start'});$('#program-name').focus();
  }
  function restoreDeepOptions(limits,scope='unallocated'){
    const select=$('#program-deep-limit');select.querySelector('[value="custom"]')?.remove();
    state.restoredDeepLimits=limits;state.programDeepScope=scope==='whole'?'whole':'unallocated';
    const match=['full','small','medium'].find(profile=>{
      const value=deepSearchLimits(profile)||{};return value.maxScanBytes===limits?.maxScanBytes&&value.maxOutputBytes===limits?.maxOutputBytes;
    });
    if(!match)select.append(e('option',{value:'custom'},'이전 설정 · 검색 '+(limits?.maxScanBytes?formatBytes(limits.maxScanBytes):'제한 없음')+' / 추출 '+(limits?.maxOutputBytes?formatBytes(limits.maxOutputBytes):'제한 없음')));
    select.value=match||'custom';
  }
  async function showHistory(){
    const r=await invoke('history');if(!r)return;
    openDialog('이전 작업 기록',body=>{
      body.append(e('p',{},r.restartPolicy),e('p',{class:'candidate-meta'},r.workspace));
      for(const j of r.jobs){
        const b=e('button',{type:'button',class:'choice',disabled:operationBusy()||j.sourceKind==='document'||['recycle','autosave','recent-traces'].includes(j.sourceKind)||['recycle','autosave','traces'].includes(j.mode),onClick:async()=>{
          if(operationBusy()||['recycle','autosave','recent-traces'].includes(j.sourceKind)||['recycle','autosave','traces'].includes(j.mode))return;ui.dialog.close();
          if(state.viewMode==='program'){
            let source=null;
            if(j.sourceKind==='volume'){
              if(!await loadProgramDevices())return;
              const select=$('#program-source');select.prepend(e('option',{value:''},'이전 작업의 드라이브를 선택해주세요'));select.value='';
            }else{
              source=await invoke('chooseSource',{kind:j.sourceKind});if(!source)return;
            }
            restoreDeepOptions(j.deepLimits,j.deepScope);
            configureProgramSearch(j.mode,source,j.filters||{},j.canContinue?j.id:null,j.deletedStrategy||'auto');
            showNotice(j.mode==='deep'&&j.canContinue?'이전 검색량 설정을 불러왔어요. 같은 이미지와 이전 복구 파일 위치를 검증한 뒤 이어서 검사합니다.':j.sourceKind==='volume'?'이전 작업과 같은 드라이브를 선택한 뒤 처음부터 다시 검사합니다.':j.mode==='deep'?(j.resumeUnavailableReason?.message?j.resumeUnavailableReason.message+' ':'이전 검색량 설정을 불러왔어요. ')+(j.deepScope==='whole'?'전체 범위':'미할당 범위')+'를 처음부터 다시 검사합니다.':'조건을 확인한 뒤 검색 시작을 눌러주세요.');return;
          }
          state.deepLimits=j.deepLimits;state.deepScope=j.deepScope||'unallocated';state.chatActive=true;state.resumeId=j.canContinue?j.id:null;state.answers.filters=j.filters||{};state.mode=j.mode;state.deletedStrategy=j.deletedStrategy||'auto';state.recent=j.recent===true;state.destination=null;resetResultFilters(state.answers.filters);
          if(j.sourceKind==='volume'){showNotice('이전 작업과 같은 드라이브를 다시 선택하면 처음부터 검사합니다.');await showOrigin();}else{const source=await invoke('chooseSource',{kind:j.sourceKind});if(!source)return;state.source=source;showSummary();if(j.mode==='deep')showNotice(j.canContinue?'같은 이미지와 이전 복구 파일 위치를 검증한 뒤 이어서 검사합니다.':(j.resumeUnavailableReason?.message||'체크포인트가 없어요.')+' 처음부터 다시 검사합니다.');}
          syncModeControls();
        }});
        b.append(e('strong',{},j.label),e('small',{},(['recycle','autosave','recent-traces'].includes(j.sourceKind)||['recycle','autosave','traces'].includes(j.mode)?(j.mode==='traces'?'이전 최근 문서 단서 검색 · 도구에서 새로 검색 · ':j.mode==='autosave'?'이전 자동 저장본 검색 · 도구에서 새로 검색 · ':'이전 휴지통 검색 · 다시 검색 미지원 · '):'')+j.status+' · 후보 '+j.candidateCount+'개 · '+j.createdAt));body.append(b);
      }
      if(!r.jobs.length)body.append(e('p',{},'저장된 작업 기록이 없어요.'));
      body.append(e('button',{type:'button',onClick:()=>{ui.dialog.close();openDialog('작업 목록 기록 지우기',box=>{box.append(e('p',{},'앱의 이전 작업 목록만 지웁니다. 복구본과 각 작업 폴더는 유지돼요.'),e('button',{type:'button',onClick:async()=>{const v=await invoke('clearHistory');if(v){ui.dialog.close();showNotice(v.message);}}},'목록 기록 지우기'));});}},'기록 지우기 전 확인'));
    });
  }
  async function compareSelected(){if(state.selected.size<2){showNotice('현재 남아 있는 파일을 두 개 이상 선택해주세요.');return;}showNotice('선택 파일의 내용을 읽어 비교하고 있어요.');state.working=true;state.stats.stage='선택 파일 내용 비교 중';renderStatus();const r=await invoke('duplicates',{jobId:state.jobId,ids:[...state.selected]});state.working=false;renderStatus();if(!r)return;openDialog('선택 파일 내용 비교',body=>{body.append(e('p',{},`서로 동일한 내용의 묶음 ${r.groups.length}개 · 확인 실패 ${r.warnings.length}개. 사라진 원본과의 동일 여부는 알 수 없어요.`));for(const group of r.groups)body.append(e('p',{},group.candidates.map(c=>c.name).join(' = ')));});showNotice('');}
  async function showSemantic(){if(state.working){showNotice('검색을 마친 뒤 파일명을 비교할 수 있어요.');return;}const status=await invoke('semanticStatus');if(!status)return;openDialog('파일명 의미 검색',body=>{body.append(e('p',{},'남아 있는 파일 제목만 로컬에서 비교합니다. 대화 AI나 문서 내용 검색이 아니에요. 이 기능을 누를 때만 모델을 실행하고 비교가 끝나면 해제합니다.'));if(!status.available){body.append(e('p',{},'선택형 AI 팩과 모델이 필요해요. 모델은 약 150MB이며 별도 런타임 공간이 필요합니다. 기본 이름 검색은 계속 사용할 수 있어요.'),e('button',{type:'button',onClick:async()=>{await invoke('chooseModel');ui.dialog.close();showSemantic();}},'로컬 모델 폴더 선택'));return;}const input=e('input',{placeholder:'예: 연간 예산 보고서',maxlength:'256',value:state.answers.filters?.name||''});body.append(input,e('button',{type:'button',class:'primary',onClick:async()=>{const query=input.value.trim();if(!query)return;ui.dialog.close();showNotice('파일명의 의미를 로컬 CPU로 비교하고 있어요.');state.working=true;state.stats.stage='파일명 의미 비교 중';renderStatus();const r=await invoke('semantic',{jobId:state.jobId,query});state.working=false;renderStatus();if(r){state.semantic=true;ui.path.value='';if(!ui.sort.querySelector('[value="semantic-desc"]'))ui.sort.append(e('option',{value:'semantic-desc'},'파일명 의미순'));ui.sort.value='semantic-desc';await loadCandidates(0,true);showNotice('의미 순위는 찾는 파일인지 판단하는 참고입니다. 원본 이름이 없는 정밀 추출 파일은 비교에서 제외했어요.');}}},'의미 검색 실행'));});}

  function dateText(value){const ms=deletionMillis(value);return ms===null?'시각 미확인':new Date(ms).toLocaleString('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}
  function fileType(name){const extension=String(name||'').split('.').pop();return extension&&extension!==name?extension.toUpperCase()+' 파일':'형식 미확인';}
  function matchLabel(kind){return {exact:'이름 문자 일치',partial:'이름 일부 일치',similar:'이름 유사',unknown:'원래 이름 미확인',none:'이름 불일치'}[kind]||'이름 비교 전';}
  function operationBusy(){return !!(state.working||state.starting||state.saving||state.preparing||state.previewLoading||state.acquisitionActive||pendingOperations.size);}
  function syncModeControls(){
    document.body.dataset.hasJob=String(Boolean(state.jobId));
    const busy=operationBusy(),chatBusy=state.viewMode==='chat'&&state.chatActive;
    const locked=busy||chatBusy;document.querySelectorAll('button[data-view-mode]').forEach(button=>{button.disabled=locked;button.setAttribute('aria-pressed',String(button.dataset.viewMode===state.viewMode));});
    const bar=$('.mode-bar');if(bar)bar.dataset.locked=String(locked);
    const note=$('#mode-lock-note');if(note)note.textContent=busy?'작업 중에는 모드를 전환할 수 없어요':chatBusy?'대화를 마치면 모드를 전환할 수 있어요':state.viewMode==='chat'?'필요한 순간에만 질문으로 안내해요':'목록과 미리보기로 빠르게 확인하세요';
    const end=$('#end-chat');if(end){end.hidden=!chatBusy;end.disabled=busy;}
    document.querySelectorAll('#program-controls button:not(#roadmap-nav):not(#workspace-nav),#program-controls select').forEach(button=>button.disabled=busy||!api);
    const name=$('#program-name');if(name)name.disabled=state.preparing||!api;
    document.querySelectorAll('[data-open-recycle]').forEach(button=>button.disabled=busy||!api);
    $('#deep-limit-control').hidden=(state.programRoute||'deleted')!=='deep';$('#program-deep-limit').disabled=busy;
    const deeper=$('#go-deeper');if(deeper){deeper.disabled=busy||!api||!state.jobId;deeper.textContent=state.mode==='deep'&&state.deepScope!=='whole'?'전체 범위로 넓혀 찾기 →':'정밀 검색으로 이어가기 →';}
    document.querySelectorAll('[data-action=restart]').forEach(button=>button.disabled=busy);
    const save=$('.preview-save');if(save)save.disabled=busy;
    renderPeriodSearch();
    workspaceShell?.render(state);
  }
  async function changeView(mode){
    if(mode===state.viewMode)return;if(operationBusy()||state.viewMode==='chat'&&state.chatActive)return;
    const old=state.viewMode;state.viewMode=mode;document.body.dataset.viewMode=mode;
    if(mode==='program'){
      $('#program-name').value=ui.path.value||state.answers.filters?.name||'';
      if(['deleted','deep','copies'].includes(state.mode))state.programRoute=state.mode;
      if(state.source&&!['recycle','autosave','recent-traces'].includes(state.source.kind))populateProgramDevices(state.source);
      updateProgramRoute();if(state.jobId)renderResults();else renderProgramEmpty();
    }else{if(state.jobId)renderResults();else{ui.results.hidden=true;clearInlinePreview();if(api)showLost();else showDesktopRequired();}}
    $('.workspace').classList.remove('mode-enter');requestAnimationFrame(()=>$('.workspace').classList.add('mode-enter'));syncModeControls();
    if(typeof api?.setViewMode==='function'){try{await api.setViewMode(mode);}catch{state.viewMode=old;document.body.dataset.viewMode=old;syncModeControls();}}
  }
  function periodFilters(){return {deletedAfter:$('#deleted-after').value?$('#deleted-after').value+'T00:00:00':null,deletedBefore:$('#deleted-before').value?$('#deleted-before').value+'T23:59:59.999':null,includeUnknownDeletedAt:$('#include-unknown-date').checked};}
  function renderPeriodSearch(){
    const note=$('#period-search-note'),again=$('#search-period-again'),full=$('#search-all-records'),vacant=$('#search-vacant-records');if(!note)return;
    const selected=periodFilters(),bounded=Boolean(selected.deletedAfter||selected.deletedBefore);
    const active=Boolean(state.jobId&&state.mode==='deleted'),native=active&&state.coverage?.strategy==='native-journal',vacancy=active&&state.coverage?.strategy==='mft-vacancy',fast=active&&['journal-first','native-journal'].includes(state.coverage?.strategy);
    const time=value=>value==null?null:typeof value==='number'?value:Date.parse(value);
    const changed=fast&&(time(selected.deletedAfter)!==time(state.coverage.deletedAfter)||time(selected.deletedBefore)!==time(state.coverage.deletedBefore));
    const busy=operationBusy();
    if(fast){
      note.textContent=changed?'기간이 바뀌었어요. 현재 목록은 이전 검색 결과 안에서만 걸러집니다. 선택 기간으로 다시 검색하면 새 범위를 확인해요.':'해당 기간의 삭제 이벤트에 연결된 파일만 확인합니다. 남아 있는 기록 범위의 결과이며, 시각 미확인 파일은 전체 기록 검색에서 찾을 수 있어요.';
      if(state.working)note.textContent+=' 진행 중인 검색 범위는 바뀌지 않아요.';
    }else if(active&&bounded)note.textContent='현재 목록은 전체 기록 검색 결과를 날짜로 걸러 보여줘요. 선택 기간으로 다시 검색하면 삭제 이벤트부터 확인해요.';
    else note.textContent=bounded?'검색 시작을 누르면 해당 기간의 삭제 이벤트부터 찾아요. 시각 미확인 파일은 추가 탐색에서 확인할 수 있어요.':'Windows NTFS 장치는 전체 기간도 삭제 이력부터 빠르게 찾아요. 이미지 파일과 다른 파일시스템은 지원하는 기록 검색을 사용해요.';
    if(native&&!changed)note.textContent='Windows 삭제 이력에 연결된 기록을 먼저 확인해요. 후보를 선택하면 내용을 확인해요. 빈 기록 추가 탐색은 필요할 때 시작하세요.';
    if(vacancy)note.textContent='빈 기록 자리에서 후보를 추가로 찾아요. 삭제 시각이 남아 있지 않은 후보도 표시할 수 있어요. 선택한 파일은 저장 전에 다시 확인해요.';
    if(busy&&active)note.textContent+=' 다시 검색하려면 현재 작업을 마치거나 취소해주세요.';
    again.hidden=!active||(!bounded&&!changed&&!native&&!vacancy);again.disabled=busy||!api;
    again.textContent=bounded?'선택 기간으로 다시 검색':'전체 기간으로 다시 검색';
    full.hidden=!fast||native;full.disabled=busy||!api;
    vacant.hidden=!native;vacant.disabled=busy||!api;
    let journalAll=$('#search-retained-journal');
    if(!journalAll){journalAll=e('button',{id:'search-retained-journal',type:'button',onClick:()=>repeatDeletedSearch('journal-full')},'보존된 삭제 이력 전체 확인');vacant.after(journalAll);}
    journalAll.hidden=!native;journalAll.disabled=busy||!api;
    const coverageParts=state.coverage?.partitions||[state.coverage||{}];
    if(native&&coverageParts.some(part=>part.periodPhysicallyReduced===true))note.textContent='최근 삭제 이력 구간부터 확인한 결과예요. 읽지 않은 이전 구간이 남아 있어요. 더 확인하려면 보존된 삭제 이력 전체 확인 또는 빈 기록 추가 탐색을 선택하세요.';
  }
  async function repeatDeletedSearch(strategy){
    if(operationBusy()||!state.jobId||state.mode!=='deleted'||!validPeriod())return;
    const selectedFilters=filters();if(['full','vacancy'].includes(strategy))selectedFilters.includeUnknownDeletedAt=true;
    const accepted=await startSearch({source:state.source,mode:'deleted',deletedStrategy:strategy,recent:true,resumeId:null,destination:null,
      filters:selectedFilters,notifications:state.notifications||{mode:'complete',minutes:10}});
    if(accepted){state.programRoute='deleted';state.programResumeId=null;state.programDeletedStrategy='auto';updateProgramRoute();}
  }
  function showPeriodDialog(){
    openDialog('삭제 기간을 정해서 찾기',body=>{
      body.append(e('p',{},'Windows NTFS 장치는 전체 기간도 삭제 이력부터 확인해요. 기간을 좁히면 연결된 파일 기록의 확인 범위를 줄일 수 있어요.'));
      const presets=e('div',{class:'dialog-actions'});
      for(const [days,label] of [['1','오늘'],['7','7일'],['30','30일'],['all','전체']])presets.append(e('button',{type:'button',onClick:()=>{setPeriod(days);state.answers.filters={...state.answers.filters,...periodFilters()};ui.dialog.close();say('삭제 기간을 '+label+'로 정했어요. 검색 시작을 누르면 적용해요.');}},label));
      body.append(presets);const dates=e('div',{class:'period-dialog-dates'});
      for(const [id,label,target] of [['chat-period-after','시작일','deleted-after'],['chat-period-before','종료일','deleted-before']]){const l=e('label',{},label);l.append(e('input',{type:'date',id,value:$('#'+target).value}));dates.append(l);}body.append(dates);
      body.append(e('button',{type:'button',class:'primary',onClick:()=>{const after=$('#chat-period-after').value,before=$('#chat-period-before').value;if(after&&before&&after>before){$('#chat-period-after').setCustomValidity('시작일이 종료일보다 늦어요.');$('#chat-period-after').reportValidity();return;}$('#deleted-after').value=after;$('#deleted-before').value=before;state.programDeletedStrategy='auto';state.deletedStrategy='auto';state.answers.filters={...state.answers.filters,...periodFilters()};ui.dialog.close();renderPeriodSearch();say('선택한 삭제 기간으로 검색할 준비가 됐어요.');}},'이 기간 적용'));
    });
  }
  function validPeriod(){const a=$('#deleted-after').value,b=$('#deleted-before').value;if(a&&b&&a>b){showNotice('시작일이 종료일보다 늦어요. 기간을 다시 선택해주세요.');return false;}return true;}
  function setPeriod(days){
    state.programDeletedStrategy='auto';state.deletedStrategy='auto';
    const localDate=date=>date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
    if(days==='all'){$('#deleted-after').value='';$('#deleted-before').value='';}
    else{const today=new Date(),start=new Date(today.getFullYear(),today.getMonth(),today.getDate());start.setDate(start.getDate()-Number(days)+1);$('#deleted-after').value=localDate(start);$('#deleted-before').value=localDate(today);}
    document.querySelectorAll('[data-period]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.period===days)));
    renderPeriodSearch();if(state.jobId)void loadCandidates(0,true);
  }
  function clearInlinePreview(){
    state.previewId=null;state.previewEarlierJobId=null;state.previewDeferred=false;state.previewToken=(state.previewToken||0)+1;
    const panel=$('#preview-panel');panel.dataset.selected='false';panel.dataset.state='empty';$('#preview-title').textContent='미리보기';
    const box=e('div',{class:'preview-empty'});box.append(e('strong',{},'파일을 선택해보세요'),e('p',{},'목록을 한 번 누르면 기본 정보와 지원되는 문서의 내용을 보여드려요.'),e('span',{},'두 번 누르면 저장 위치 선택'));clear($('#preview-content'));$('#preview-content').append(box);
  }
  function renderProgramEmpty(){
    renderScanWarnings();
    ui.results.hidden=false;$('#results-title').textContent='찾은 파일';ui.count.textContent='0';$('#match-notice').hidden=true;$('#deletion-time-note').hidden=true;
    clear(ui.list);const empty=e('div',{class:'empty-state'});empty.append(e('strong',{},api?'삭제 기록부터 찾아보세요':'데스크톱 앱에서 검색할 수 있어요'),e('p',{},api?'삭제 기간은 선택 사항이에요. 이름을 몰라도 파일 목록을 확인할 수 있어요.':'이 브라우저 화면에는 실제 파일 접근 기능이 연결되어 있지 않습니다.'));ui.list.append(empty);
    clear(ui.actions);ui.actions.append(e('p',{},'파일 선택 → 오른쪽 미리보기 · 더블클릭 → 저장'));
  }
  function updateProgramRoute(){
    const route=state.programRoute||'deleted';
    document.querySelectorAll('[data-program-route]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.programRoute===route)));
    $('#program-start').textContent=route==='deleted'?'삭제 기록 찾기 ↗':route==='copies'?'복사본 검색 시작 ↗':'정밀 검색 시작 ↗';
    $('#program-image').textContent=route==='copies'?'폴더 선택':'이미지 파일 선택';
    $('#program-source-note').textContent=route==='deleted'?'휴지통을 비웠거나 완전 삭제한 파일의 기록을 찾습니다. 위치를 모르면 기본 드라이브부터 시작합니다.':route==='copies'?'선택한 폴더에 남아 있는 복사본과 자동 저장 문서를 찾습니다.':'파일 내용의 흔적을 찾습니다. 검색 전 별도 작업 저장 위치가 필요하며 시간이 더 걸릴 수 있어요.';
    if(!state.jobId)$('#period-label').textContent='삭제 기록 기간';
    syncModeControls();
  }
  function populateProgramDevices(source=null){
    const select=$('#program-source'),selected=source?(source.kind==='image'?'image:':'')+source.id:select.value;
    if(source?.kind==='image')state.programImage=source;
    if(source?.kind==='folder')state.programFolder=source;
    clear(select);select.append(e('option',{value:'auto'},'위치 모름 · 기본 드라이브부터'));
    for(const device of state.devices)select.append(e('option',{value:device.id,disabled:device.ready===false},(device.label||'이름 없는 장치')+' · '+(device.fileSystem||device.kind||'정보 없음')+(device.ready===false?' · 사용 불가':'')));
    if(state.programImage)select.append(e('option',{value:'image:'+state.programImage.id},state.programImage.label));
    if(state.programFolder)select.append(e('option',{value:state.programFolder.id},state.programFolder.label));
    if(source?.kind==='volume'&&!state.devices.some(device=>device.id===source.id)){
      state.devices.push(source);select.append(e('option',{value:source.id},source.label||'선택한 장치'));
    }
    if([...select.options].some(option=>option.value===selected))select.value=selected;
  }
  async function loadProgramDevices(){
    if(!api)return false;const response=await invoke('devices');if(!response)return false;state.devices=Array.isArray(response.devices)?response.devices:[];
    populateProgramDevices();
    return true;
  }
  async function runProgram(route=state.programRoute||'deleted',sourceOverride=null,options={}){
    if(!['deleted','deep','copies'].includes(route))return;
    if(operationBusy()||!validPeriod())return;if(!api){showNotice('실제 검색은 데스크톱 앱에서 사용할 수 있어요.');return;}
    state.preparing=true;state.programRoute=route;updateProgramRoute();showNotice('');
    try{
      let selectedSource=sourceOverride;
      if(selectedSource){populateProgramDevices(selectedSource);}
      else{
        if(!state.devices.length&&!state.programImage&&!state.programFolder){if(!await loadProgramDevices())return;}
        const choice=$('#program-source').value;
        if(route==='copies'&&state.programFolder?.id===choice)selectedSource=state.programFolder;
        else if(choice.startsWith('image:')&&state.programImage)selectedSource=state.programImage;
        else{
          const devices=state.devices.filter(device=>device.ready!==false).sort((a,b)=>Number(!!b.system)-Number(!!a.system));
          const device=choice==='auto'?devices[0]:devices.find(value=>value.id===choice);
          if(!device){showNotice('검색 가능한 위치가 없어요. 연결된 장치를 확인하거나 이미지 파일을 선택해주세요.');return;}
          selectedSource={id:device.id,label:device.label,kind:device.kind||'volume',...(choice==='auto'?{autoScope:{devices,index:0}}:{})};
        }
      }
      let destination=null;
      if(route==='deep'){
        destination=await invoke('chooseDestination');if(!destination)return;
      }
      const previousJob=state.jobId;
      await startSearch({source:selectedSource,destination,mode:route,deletedStrategy:options.deletedStrategy||state.programDeletedStrategy||'auto',recent:route==='deleted',resumeId:options.fresh?null:state.programResumeId||null,deepScope:options.deepScope||state.programDeepScope||'unallocated',deepLimits:route==='deep'?($('#program-deep-limit').value==='custom'?state.restoredDeepLimits:deepSearchLimits($('#program-deep-limit').value)):undefined,filters:{...state.programFilters,...periodFilters(),name:$('#program-name').value.trim(),kind:state.kind||'all'},notifications:{mode:'complete',minutes:10}});
      if(state.jobId&&state.jobId!==previousJob)requestAnimationFrame(()=>ui.status.scrollIntoView({block:'start',behavior:'auto'}));
    }finally{state.preparing=false;syncModeControls();}
  }
  async function goDeeper(){
    if(operationBusy()||!state.jobId)return;
    if(state.viewMode==='program'){
      const source=['image','volume'].includes(state.source?.kind)?state.source:null;
      await runProgram('deep',source,{deepScope:state.mode==='deep'?'whole':'unallocated'});
    }else if(state.source?.kind==='image'||state.source?.kind==='volume'){
      if(state.mode==='deep')state.deepScope='whole';await chooseMode('deep');
    }else{
      answer('정밀 검색으로 이어갈게요');state.recent=false;state.requestedDeep=true;showOrigin();
    }
  }
  const originalReset=reset;
  reset=function(){
    if(operationBusy()){showNotice('진행 중인 작업이 끝나거나 중단 처리가 끝나면 처음으로 돌아갈 수 있어요.');return;}
    state.chatActive=false;state.previewId=null;state.previewDeferred=false;state.matchCounts=null;state.requestedDeep=false;state.programRoute='deleted';state.programResumeId=null;state.programFilters=null;state.programImage=null;state.programFolder=null;state.deletedStrategy='auto';state.programDeletedStrategy='auto';state.coverage=null;state.progressStage=null;
    restoreDeepOptions(undefined);state.deepLimits=undefined;
    originalReset();$('#program-name').value='';$('#deleted-after').value='';$('#deleted-before').value='';$('#include-unknown-date').checked=true;
    populateProgramDevices();$('#program-source').value='auto';
    document.querySelectorAll('[data-period]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.period==='all')));
    clearInlinePreview();updateProgramRoute();if(state.viewMode==='program')renderProgramEmpty();workspaceShell?.reset();syncModeControls();
  };
  const sourceChosen=afterSourceChosen;
  afterSourceChosen=function(){if(state.requestedDeep){state.requestedDeep=false;void chooseMode('deep');return;}sourceChosen();};
  const baseEvent=onEvent;
  onEvent=function(event){
    if(acquisitionUI?.event(event)){syncModeControls();return;}
    const terminal=event&&['complete','recover-complete','cancelled','error'].includes(event.type);
    if(state.starting&&state.startEvents&&terminal&&event.jobId!==state.jobId&&event.jobId!==state.recoveryJobId){
      if(state.startEvents.size<8)state.startEvents.set(event.jobId,event);
      return;
    }
    const ours=event&&(event.jobId===state.jobId||event.jobId===state.recoveryJobId);
    if(ours&&terminal)state.finishedJobId=event.jobId;
    baseEvent(event);
    if(ours)workspaceShell?.event(event,state);
    if(ours&&['candidate','candidate-batch'].includes(event.type)&&!state.autoRefresh){state.autoRefresh=setTimeout(()=>{state.autoRefresh=null;if(state.jobId===event.jobId)void loadCandidates(0,true);},450);}
    syncModeControls();
  };
  state.viewMode='program';state.programRoute='deleted';state.chatActive=false;
  document.querySelectorAll('button[data-view-mode]').forEach(button=>button.addEventListener('click',()=>changeView(button.dataset.viewMode)));
  $('#end-chat').addEventListener('click',()=>{if(operationBusy())return;if(!state.jobId){reset();return;}state.chatActive=false;clear(ui.question);say('대화를 마쳤어요. 찾은 목록은 유지되며 위에서 모드를 바꿀 수 있어요.');syncModeControls();});
  document.querySelectorAll('[data-program-route]').forEach(button=>button.addEventListener('click',async()=>{if(operationBusy())return;state.programRoute=button.dataset.programRoute;state.programDeepScope='unallocated';state.programResumeId=null;state.programFilters=null;updateProgramRoute();if(!state.devices.length)await loadProgramDevices();syncModeControls();}));
  document.querySelectorAll('[data-open-recycle]').forEach(button=>button.addEventListener('click',openRecycleBin));
  $('#program-start').addEventListener('click',()=>runProgram());
  $('#program-name').addEventListener('input',()=>{ui.path.value=$('#program-name').value;});
  $('#program-name').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();void runProgram();}});
  $('#program-name').addEventListener('change',()=>{if(state.jobId)void loadCandidates(0,true);});
  ui.path.addEventListener('input',()=>{$('#program-name').value=ui.path.value;});
  $('#program-image').addEventListener('click',async()=>{if(operationBusy())return;const chosen=await invoke('chooseSource',state.programRoute==='copies'?'folder':'image');if(chosen)populateProgramDevices(chosen);});
  document.querySelectorAll('[data-period]').forEach(button=>button.addEventListener('click',()=>setPeriod(button.dataset.period)));
  for(const id of ['deleted-after','deleted-before','include-unknown-date'])$('#'+id).addEventListener('change',()=>{document.querySelectorAll('[data-period]').forEach(button=>button.setAttribute('aria-pressed','false'));state.programDeletedStrategy='auto';state.deletedStrategy='auto';renderPeriodSearch();if(state.jobId)void loadCandidates(0,true);else validPeriod();});
  $('#search-period-again').addEventListener('click',()=>repeatDeletedSearch('auto'));
  $('#search-all-records').addEventListener('click',()=>repeatDeletedSearch('full'));
  $('#search-vacant-records').addEventListener('click',()=>repeatDeletedSearch('vacancy'));
  $('#go-deeper').addEventListener('click',goDeeper);

  function readinessSource(){
    const selection=$('#program-source').value;
    let source=state.viewMode==='chat'||selection==='auto'&&state.source?.autoScope?state.source:null;
    if(!source){
      if(selection.startsWith('image:'))source=state.programImage;
      else if(state.programFolder?.id===selection)source=state.programFolder;
      else source=selection==='auto'?[...state.devices].filter(item=>item.ready!==false).sort((a,b)=>Number(!!b.system)-Number(!!a.system))[0]:state.devices.find(item=>item.id===selection);
    }
    return source;
  }
  async function showSourceReadiness(){
    if(operationBusy())return;
    if(!api?.sourceReadiness){showNotice('원본 보호 점검은 새 데스크톱 앱에서 사용할 수 있어요.');return;}
    if(!state.devices.length&&!state.programImage&&!state.programFolder)await loadProgramDevices();
    const source=readinessSource();
    if(!source){showNotice('점검할 위치를 먼저 선택해주세요.');return;}
    const report=await invoke('sourceReadiness',{sourceId:source.id,destinationId:state.destination?.id});
    if(!report)return;workspaceShell.setReadiness(report,source);
    openDialog('원본 보호 · 작업 위치 점검',body=>{
      body.append(e('p',{},report.overall==='blocked'?'진행을 막는 조건이 있어요. 아래 장치와 위치를 확인해주세요.':report.overall==='ready'?'현재 확인한 조건을 충족합니다. 작업 시작과 저장 시 다시 확인합니다.':'점검을 마쳤어요. 미확인 정보와 추가로 확인할 조건을 구분해 표시합니다.'));
      const list=e('ul',{class:'readiness-checks'}),labels={pass:'확인',warning:'주의',blocked:'변경 필요',unknown:'미확인'};
      for(const check of report.checks){const li=e('li'),heading=e('strong');heading.append(e('span',{class:'readiness-state','data-state':check.status},labels[check.status]||'미확인'),document.createTextNode(check.title));li.append(heading,e('p',{},check.detail));list.append(li);}
      body.append(list);
      const details=e('details');details.append(e('summary',{},'점검 위치와 한계 보기'),e('p',{class:'readiness-path'},'원본: '+(report.source.label||source.label)),e('p',{class:'readiness-path'},'작업 공간: '+report.workspace.path));
      if(report.destination)details.append(e('p',{class:'readiness-path'},'복구 저장 위치: '+(report.destination.path||report.destination.label||'선택한 위치')));
      for(const limit of report.limits)details.append(e('p',{},limit));body.append(details);
      body.append(e('button',{type:'button',class:'secondary-button',onClick:async()=>{ui.dialog.close();const destination=await invoke('chooseDestination');if(destination){state.destination=destination;syncModeControls();await showSourceReadiness();}}},'저장 위치를 골라 함께 점검'));
    });
  }
  workspaceShell=createWorkspace({getState:()=>state,getReadinessSource:readinessSource,isBusy:operationBusy,onReadiness:showSourceReadiness,onStage:async step=>{
    if(operationBusy()||state.viewMode==='chat'&&state.chatActive)return;
    if(step==='protect'){await showSourceReadiness();return;}
    if(step==='content'){$('#results').scrollIntoView({block:'start',behavior:'auto'});showNotice(state.jobId?'후보를 선택하면 내용을 확인하고 별도 위치에 저장할 수 있어요.':'삭제 기록이나 정밀 검색에서 후보를 먼저 찾아주세요.','warning');return;}
    if(state.viewMode!=='program')await changeView('program');
    state.programRoute=step==='records'?'deleted':step;state.programResumeId=null;state.programFilters=null;updateProgramRoute();syncModeControls();
    $('#program-controls').scrollIntoView({block:'start',behavior:'auto'});
  }});
  operationLabels.sourceReadiness='원본 장치와 작업 위치를 점검하고 있어요';
  Object.assign(operationLabels,{acquireImage:'원본 보관을 준비하고 있어요',acquisitions:'보관 기록을 불러오고 있어요',cancelAcquisition:'중단 기록을 남기고 있어요',useAcquiredImage:'보관 이미지의 해시를 확인하고 있어요'});
  acquisitionUI=createAcquisitionUI({invoke,getSource:readinessSource,
    loadSources:async()=>{if(!state.devices.length&&!state.programImage&&!state.programFolder)await loadProgramDevices();},
    isBusy:()=>operationBusy()||state.viewMode==='chat'&&state.chatActive,openDialog,closeDialog:()=>ui.dialog.close(),
    onBusy:active=>{state.acquisitionActive=active;syncModeControls();},
    useSource:async source=>{await changeView('program');configureProgramSearch('deleted',source);},notice:message=>showNotice(message)});
  $('#program-source').addEventListener('change',()=>syncModeControls());

  const toolsButton=document.querySelector('[data-action=help]');toolsButton.textContent='도구 · 안내';toolsButton.removeAttribute('data-action');toolsButton.addEventListener('click',showTools);
  for(const id of ['modified-after','modified-before','max-size','original-path'])$('#'+id).addEventListener('change',()=>loadCandidates(0,true));
  $('#path-filter').addEventListener('change',()=>loadCandidates(0,true));$('#sort').addEventListener('change',()=>loadCandidates(0,true));document.querySelectorAll('[data-kind]').forEach(b=>b.addEventListener('click',()=>{state.kind=b.dataset.kind;document.querySelectorAll('[data-kind]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));loadCandidates(0,true);}));document.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.action==='restart')reset();else if(b.dataset.action==='help')openDialog('사용 안내',body=>body.append(e('p',{},'삭제 기록 확인과 실제 저장은 다릅니다. 후보를 확인한 뒤 원본과 다른 장치에 저장하세요. 지원하지 않는 파일이나 손상된 파일은 별도로 표시됩니다.')));else if(b.dataset.action==='close-dialog')ui.dialog.close();}));
  if(api){ui.connection.textContent='데스크톱 연결됨'; if(typeof api.onEvent==='function')state.unsub=api.onEvent(onEvent); reset();}else {showDesktopRequired();renderProgramEmpty();syncModeControls();}
})();
