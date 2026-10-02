'use strict';
const { ipcRenderer, contextBridge } = require('electron');
const commands = ['devices', 'sourceReadiness', 'openRecycleBin', 'chooseSource', 'chooseDestination', 'start', 'candidates', 'recover', 'preview', 'previewRecovered', 'showRecovered', 'openResult', 'openCandidate', 'exportResults', 'cleanup', 'cancel', 'pause', 'resume', 'history', 'clearHistory', 'state', 'backups', 'recentTraces', 'duplicates', 'saveIndex', 'loadIndex', 'support'];
const api = Object.fromEntries(commands.map(command => [command, async payload => {
  const result = await ipcRenderer.invoke('recovery-command', { command, payload });
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value;
}]));
for (const command of ['semanticStatus', 'chooseModel', 'semantic', 'salvage', 'acquireImage', 'acquisitions', 'cancelAcquisition', 'useAcquiredImage', 'showAcquisition']) api[command] = async payload => {
  const result = await ipcRenderer.invoke('recovery-command', { command, payload });
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value;
};
api.onEvent = callback => {
  if (typeof callback !== 'function') throw new TypeError('이벤트 함수를 지정해주세요.');
  const listener = (_event, message) => callback(message);
  ipcRenderer.on('recovery-event', listener);
  return () => ipcRenderer.removeListener('recovery-event', listener);
};
api.setViewMode = mode => ipcRenderer.invoke('view-mode', mode);
contextBridge.exposeInMainWorld('recoveryAPI', api);
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop');
  document.querySelectorAll('[data-window-action]').forEach(button => {
    button.addEventListener('click', () => ipcRenderer.send('window-control', button.dataset.windowAction));
  });
  document.querySelector('.app-header')?.addEventListener('dblclick', event => {
    if (!event.target.closest('button')) ipcRenderer.send('window-control', 'maximize');
  });
});
