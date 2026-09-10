'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit bridge. Renderer gets no Node access - only these four
// calls. Request text is length-capped here at the trust boundary.
contextBridge.exposeInMainWorld('deskmate', {
  submit: (text) => ipcRenderer.send('panel:submit', String(text || '').slice(0, 1000)),
  confirm: () => ipcRenderer.send('panel:confirm'),
  cancel: () => ipcRenderer.send('panel:cancel'),
  openSettings: (pane) => ipcRenderer.send('open:settings', String(pane || '')),
  onState: (fn) => ipcRenderer.on('panel:state', (_e, s) => fn(s)),
});