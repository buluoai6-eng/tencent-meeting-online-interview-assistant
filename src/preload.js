const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coach', {
  start: (options) => ipcRenderer.invoke('coach:start', options),
  stop: () => ipcRenderer.invoke('coach:stop'),
  sendAudio: (base64Audio) => ipcRenderer.send('coach:audio', base64Audio),
  commitAudio: () => ipcRenderer.send('coach:commit'),
  openPrepNotes: () => ipcRenderer.invoke('coach:open-prep'),
  getAnswerSettings: () => ipcRenderer.invoke('coach:get-answer-settings'),
  saveAnswerSettings: (settings) => ipcRenderer.invoke('coach:save-answer-settings', settings),
  setCompact: (compact) => ipcRenderer.invoke('coach:set-compact', compact),
  close: () => ipcRenderer.send('coach:close'),
  onStatus: (callback) => ipcRenderer.on('coach:status', (_event, value) => callback(value)),
  onDelta: (callback) => ipcRenderer.on('coach:transcript-delta', (_event, value) => callback(value)),
  onTranscript: (callback) => ipcRenderer.on('coach:transcript', (_event, value) => callback(value)),
  onHintStart: (callback) => ipcRenderer.on('coach:hint-start', (_event, value) => callback(value)),
  onHint: (callback) => ipcRenderer.on('coach:hint', (_event, value) => callback(value)),
  onIdle: (callback) => ipcRenderer.on('coach:idle', (_event, value) => callback(value)),
  onError: (callback) => ipcRenderer.on('coach:error', (_event, value) => callback(value))
});
