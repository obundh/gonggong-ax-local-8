'use strict';
const { app, BrowserWindow, Menu, protocol, session, dialog, ipcMain, shell, Notification, powerMonitor, screen } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { readFile } = require('node:fs/promises');

protocol.registerSchemesAsPrivileged([
  { scheme: 'recovery', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

app.setName('공공 AX 로컬 시리즈 8 - 파일 복구');
const runtimeRoot = path.resolve(process.env.RECOVERY_WORKSPACE || path.join(app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(), 'recovery-workspace'));
try {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  app.setPath('userData', path.join(runtimeRoot, 'profile'));
  app.setPath('sessionData', path.join(runtimeRoot, 'session'));
  app.setPath('logs', path.join(runtimeRoot, 'logs'));
  app.setPath('crashDumps', path.join(runtimeRoot, 'crash-dumps'));
  app.commandLine.appendSwitch('disk-cache-dir', path.join(runtimeRoot, 'cache'));
  const temporaryRoot = path.join(runtimeRoot, 'temp');
  for (const directory of ['profile', 'session', 'logs', 'crash-dumps', 'cache', 'temp']) fs.mkdirSync(path.join(runtimeRoot, directory), { recursive: true });
  app.setPath('temp', temporaryRoot);
  process.env.TEMP = temporaryRoot;
  process.env.TMP = temporaryRoot;
} catch (error) { dialog.showErrorBox('작업 공간을 만들지 못했어요', '쓰기 권한이 있는 다른 장치의 폴더로 프로그램을 옮겨 실행해주세요.\n' + error.message); app.exit(1); }
const entryURL = 'recovery://app/';
let window;
let jobs;
let closing = false;
let quitPending = false;
let quitReady = false;
const validSender = event => window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === entryURL;
function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({
    title: '공공 AX 로컬 시리즈 8 - 파일 복구', width: Math.min(1180, workArea.width), height: Math.min(900, workArea.height), minWidth: 360, minHeight: 520,
    frame: false, thickFrame: false,
    backgroundColor: '#f7f8fa', show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, webviewTag: false, devTools: !app.isPackaged,
      spellcheck: false
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== entryURL) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const key = input.key;
    if (!['+', '=', '-', '0'].includes(key)) return;
    event.preventDefault();
    const current = window.webContents.getZoomFactor();
    window.webContents.setZoomFactor(key === '0' ? 1 : Math.min(2, Math.max(.75, Math.round((current + (key === '-' ? -.25 : .25)) * 100) / 100)));
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', event => {
    if (closing || !jobs?.busy()) return;
    event.preventDefault();
    void dialog.showMessageBox(window, { type: 'question', title: '작업을 종료할까요?', message: '진행 중인 검색·저장이 중단돼요. 완료된 복구본은 남겨둬요.', buttons: ['계속 진행', '작업 종료'], defaultId: 0, cancelId: 0 })
      .then(async answer => { if (answer.response === 1) { closing = true; await jobs.dispose(); window?.close(); } });
  });
  window.on('closed', () => { window = null; });
  window.loadURL(entryURL).catch(error => {
    dialog.showErrorBox('화면을 열지 못했어요', error.message);
    app.quit();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  });
  app.whenReady().then(async () => {
    app.setAppUserModelId('local.recoverychat.desktop');
    Menu.setApplicationMenu(null);
    const engineRoot = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'engine') : path.join(app.getAppPath(), 'engine');
    const optionalRoot = app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
    let semanticModelPath = path.join(optionalRoot, 'models', 'name-embedding', 'paraphrase-multilingual-MiniLM-L12-v2');
    const { RecoveryJobs } = await import(pathToFileURL(path.join(engineRoot, 'job-service.mjs')).href);
    const alertTimes = new Map();
    const runtimePaths = [
      { purpose: '프로그램', path: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(), access: 'read-only' },
      { purpose: '읽기 도우미', path: path.join(engineRoot, '..', 'native', 'bin', 'RecoveryChat.VolumeReader.exe'), access: 'read-only' },
      ...['profile', 'session', 'logs', 'crash-dumps', 'cache', 'temp'].map(name => ({ purpose: name, path: path.join(runtimeRoot, name), access: 'writable' }))
    ];
    jobs = new RecoveryJobs({ workspace: runtimeRoot, runtimePaths, onEvent(event) {
      if (window && !window.isDestroyed()) window.webContents.send('recovery-event', event);
      const job = jobs.jobs.get(event.jobId);
      const preference = job?.notifications ?? {};
      const hasClue = Boolean(job?.filters.name);
      const now = Date.now();
      const minutes = Math.min(60, Math.max(1, Number(preference.minutes) || 5));
      const final = ['complete', 'recover-complete', 'error', 'cancelled'].includes(event.type);
      const periodic = preference.mode === 'periodic' && event.type === 'progress' && now - (alertTimes.get(event.jobId) ?? now) >= minutes * 60000;
      const candidate = preference.mode === 'candidate' && hasClue && event.type === 'candidate' && Number(event.candidate.score) >= 80 && now - (alertTimes.get(event.jobId) ?? 0) > 60000;
      if (!alertTimes.has(event.jobId)) alertTimes.set(event.jobId, now);
      if ((final || periodic || candidate) && Notification.isSupported() && (!window || !window.isFocused())) {
        alertTimes.set(event.jobId, now);
        const notification = new Notification({ title: '파일 복구', body: event.type === 'error' ? '작업 중 확인이 필요한 상황이 생겼어요.' : final ? '진행한 작업의 결과를 확인해주세요.' : '새 진행 상황과 후보를 확인할 수 있어요.' });
        notification.on('click', () => { window?.show(); window?.focus(); }); notification.show();
      }
    } });
    await jobs.initialize();
    ipcMain.handle('recovery-command', async (event, message) => {
      if (!validSender(event)) return { ok: false, error: { code: 'FORBIDDEN', message: '허용되지 않은 요청이에요.' } };
      try {
        if (!message || typeof message.command !== 'string' || JSON.stringify(message).length > 1024 * 1024) throw new Error('요청 형식을 확인해주세요.');
        const { command, payload } = message;
        let value;
        if (command === 'devices') value = await jobs.devices();
        else if (command === 'sourceReadiness') value = await jobs.sourceReadiness(payload);
        else if (command === 'acquireImage') value = await jobs.acquisitions.start({ ...payload, elevate: true });
        else if (command === 'acquisitions') value = jobs.acquisitions.list();
        else if (command === 'cancelAcquisition') value = jobs.acquisitions.cancel(payload?.id);
        else if (command === 'useAcquiredImage') value = await jobs.acquisitions.useImage(payload?.id);
        else if (command === 'showAcquisition') {
          const record = jobs.acquisitions.records.get(payload?.id);
          if (!record) throw new Error('보관 기록을 찾을 수 없어요.');
          shell.showItemInFolder(path.join(record.outputDirectory, 'acquisition.json')); value = { opened: true };
        }
        else if (command === 'openRecycleBin') {
          if (jobs.busy()) throw new Error('진행 중인 작업을 마친 뒤 휴지통을 열어주세요.');
          await new Promise((resolve, reject) => {
            const child = childProcess.spawn(path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'explorer.exe'), ['shell:RecycleBinFolder'], { windowsHide: false, detached: true, stdio: 'ignore' });
            child.once('error', reject);
            child.once('spawn', () => { child.unref(); resolve(); });
          });
          value = { opened: true };
        }
        else if (command === 'chooseSource') {
          const kind = typeof payload === 'string' ? payload : payload?.kind;
          if (!['folder', 'image'].includes(kind)) throw new Error('원본 종류를 선택해주세요.');
          const selection = await dialog.showOpenDialog(window, { title: kind === 'image' ? '복구할 볼륨 이미지 선택' : '찾아볼 폴더 선택', properties: kind === 'folder' ? ['openDirectory'] : ['openFile'],
            ...(kind === 'image' ? { filters: [{ name: '디스크·볼륨 이미지', extensions: ['img', 'dd', 'raw', 'bin'] }, { name: '모든 파일', extensions: ['*'] }] } : {}) });
          value = selection.canceled ? null : await jobs.addSource(kind, selection.filePaths[0]);
        } else if (command === 'chooseDestination') {
          const selection = await dialog.showOpenDialog(window, { title: '파일을 저장할 폴더 선택', properties: ['openDirectory', 'createDirectory'] });
          value = selection.canceled ? null : await jobs.addDestination(selection.filePaths[0]);
        } else if (command === 'start') {
          if (!['deleted', 'deep', 'copies', 'autosave', 'traces'].includes(payload?.mode)) throw new Error('지원하는 검색을 선택해주세요. 휴지통은 Windows에서 확인할 수 있어요.');
          value = await jobs.start({ ...payload, elevate: true });
        }
        else if (command === 'candidates') value = await jobs.candidates(payload);
        else if (command === 'recover') value = await jobs.recover(payload);
        else if (command === 'preview') value = await jobs.preview(payload);
        else if (command === 'previewRecovered') value = await jobs.previewRecovered(payload);
        else if (command === 'showRecovered') { shell.showItemInFolder(await jobs.recoveredPath(payload)); value = { opened: true }; }
        else if (['cancel', 'pause', 'resume'].includes(command)) value = jobs[command](typeof payload === 'string' ? payload : payload?.jobId);
        else if (command === 'history') value = jobs.history();
        else if (command === 'clearHistory') value = await jobs.clearHistory();
        else if (command === 'state') value = jobs.state();
        else if (command === 'cleanup') value = await jobs.cleanup(payload);
        else if (command === 'exportResults') { value = await jobs.exportResults(payload); shell.showItemInFolder(value.path); }
        else if (command === 'openResult') { const target = jobs.resultPath(payload); const failure = await shell.openPath(target); if (failure) throw new Error(failure); value = { opened: true }; }
        else if (command === 'openCandidate') { const target = jobs.candidatePath(payload); if (!target) throw new Error('현재 남아 있는 파일만 위치를 열 수 있어요.'); shell.showItemInFolder(target); value = { opened: true }; }
        else if (command === 'backups') {
          value = await jobs.autosaveSource();
        }
        else if (command === 'recentTraces') value = await jobs.recentSource();
        else if (command === 'saveIndex') value = await jobs.requestWorker(jobs.getJob(payload.jobId), 'save-index');
        else if (command === 'loadIndex') {
          const selection = await dialog.showOpenDialog(window, { title: '기존 파일명 인덱스 재사용', properties: ['openFile'], filters: [{ name: '검색 인덱스 JSON', extensions: ['json'] }] });
          value = selection.canceled ? null : await jobs.requestWorker(jobs.getJob(payload.jobId), 'load-index', { path: selection.filePaths[0] });
        }
        else if (command === 'support') {
          value = { version: app.getVersion(), workspace: runtimeRoot, text: await readFile(path.join(optionalRoot, 'SUPPORT.md'), 'utf8'), notices: await readFile(path.join(optionalRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8') };
        }
        else if (command === 'salvage') {
          if (jobs.busy()) throw new Error('현재 작업을 마친 뒤 손상 파일을 선택해주세요.');
          const png = payload?.kind === 'png';
          const chosen = await dialog.showOpenDialog(window, { title: png ? 'PNG 조각이 남은 파일 선택' : '손상 문서의 부분 내용 추출', properties: ['openFile'], filters: [{ name: png ? 'PNG 조각 파일' : '문서 파일', extensions: png ? ['png','bin','partial'] : ['docx','xlsx','pptx','hwpx'] }] });
          if (chosen.canceled) value = null;
          else {
            const out = await dialog.showOpenDialog(window, { title: '추출 결과 저장 폴더', properties: ['openDirectory','createDirectory'] });
            if (out.canceled) value = null;
            else {
              const source = await jobs.addSource('document', chosen.filePaths[0]), destination = await jobs.addDestination(out.filePaths[0]);
              value = { ...await jobs.start({ sourceId: source.id, destinationId: destination.id, mode: 'salvage', salvageKind: png ? 'png' : 'document' }), source, destination };
            }
          }
        }
        else if (command === 'semanticStatus' || command === 'chooseModel') {
          if (command === 'chooseModel') {
            const choice = await dialog.showOpenDialog(window, { title: '파일명 의미 검색 모델 폴더', properties: ['openDirectory'] });
            if (!choice.canceled) semanticModelPath = choice.filePaths[0];
          }
          const { getSemanticStatus } = await import(pathToFileURL(path.join(engineRoot, 'semantic-search.mjs')).href);
          value = { ...getSemanticStatus({ modelPath: semanticModelPath, runtimeRoot: path.join(optionalRoot, 'optional-ai') }), modelPath: semanticModelPath };
        }
        else if (command === 'semantic') {
          const job = jobs.getJob(payload.jobId);
          if (typeof payload.query !== 'string' || !payload.query.trim() || payload.query.length > 256) throw new Error('기억나는 파일 제목을 256자 이내로 적어주세요.');
          if (job.source.kind === 'volume') await jobs.validateDestination(job.source, job.destinationId);
          value = await jobs.requestWorker(job, 'semantic', { query: payload.query, modelPath: semanticModelPath, runtimeRoot: path.join(optionalRoot, 'optional-ai') });
        }
        else if (command === 'duplicates') { const job = jobs.getJob(payload.jobId); value = await jobs.requestWorker(job, 'hash', { ids: payload.ids }); }
        else throw new Error('지원하지 않는 명령이에요.');
        return { ok: true, value };
      } catch (failure) { return { ok: false, error: { code: failure.code ?? 'OPERATION_FAILED', message: failure.message } }; }
    });
    ipcMain.on('window-control', (event, action) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== entryURL) return;
      if (action === 'minimize') window.minimize();
      else if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
      else if (action === 'close') window.close();
    });
    ipcMain.handle('view-mode', (event, mode) => {
      if (!validSender(event) || !['program', 'chat'].includes(mode)) throw new Error('올바르지 않은 화면 요청입니다.');
      if (jobs?.busy()) throw new Error('작업 중에는 화면을 전환할 수 없습니다.');
      const area = screen.getDisplayMatching(window.getBounds()).workArea;
      if (window.isMaximized()) window.unmaximize();
      const width = Math.min(mode === 'program' ? 1180 : 520, area.width);
      const height = Math.min(mode === 'program' ? 900 : 800, area.height);
      const old = window.getBounds();
      window.setBounds({ x: Math.max(area.x, Math.min(old.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(old.y, area.y + area.height - height)), width, height });
      return { mode };
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    const assets = new Map([
      ['/', ['index.html', 'text/html; charset=utf-8']],
      ['/index.html', ['index.html', 'text/html; charset=utf-8']],
      ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
      ['/workspace.css', ['workspace.css', 'text/css; charset=utf-8']],
      ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
      ['/ui/workspace.mjs', ['ui/workspace.mjs', 'text/javascript; charset=utf-8']],
      ['/ui/acquisition.mjs', ['ui/acquisition.mjs', 'text/javascript; charset=utf-8']],
      ['/ui/deep-coverage.mjs', ['ui/deep-coverage.mjs', 'text/javascript; charset=utf-8']],
      ['/ui/checklist-data.mjs', ['ui/checklist-data.mjs', 'text/javascript; charset=utf-8']],
      ['/engine/recovery-outcome.mjs', ['engine/recovery-outcome.mjs', 'text/javascript; charset=utf-8']],
      ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
    ]);
    protocol.handle('recovery', async request => {
      const url = new URL(request.url);
      const asset = url.hostname === 'app' && request.method === 'GET' ? assets.get(url.pathname) : null;
      if (!asset) return new Response('Not found', { status: 404 });
      try {
        const data = await readFile(path.join(app.getAppPath(), asset[0]));
        return new Response(data, { headers: { 'Content-Type': asset[1], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } });
      } catch {
        return new Response('App asset unavailable', { status: 500 });
      }
    });
    createWindow();
    powerMonitor.on('suspend', () => { for (const job of jobs.jobs.values()) if (['scanning', 'recovering'].includes(job.status)) jobs.cancel(job.id); });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(error => {
    dialog.showErrorBox('프로그램을 시작하지 못했어요', error.message);
    app.quit();
  });
  app.on('before-quit', event => {
    if (!jobs || quitReady) return;
    event.preventDefault();
    if (quitPending) return;
    quitPending = true; closing = true;
    void jobs.dispose().finally(() => { quitReady = true; app.quit(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}



