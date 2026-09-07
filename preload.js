'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Explicit, fixed surface. The renderer cannot reach ipcRenderer directly and
// cannot name a channel that is not listed here.
contextBridge.exposeInMainWorld('clamav', {
  getStatus: () => ipcRenderer.invoke('status:get'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  readLog: (name) => ipcRenderer.invoke('logs:read', name),
  readLogElevated: (name) => ipcRenderer.invoke('logs:readElevated', name),
  runAction: (id) => ipcRenderer.invoke('action:run', id),
  controlService: (unit, verb) => ipcRenderer.invoke('service:control', { unit, verb }),
  setPrevention: (value) => ipcRenderer.invoke('config:setPrevention', value),
  addPath: (p) => ipcRenderer.invoke('config:addPath', p),
  removePath: (p) => ipcRenderer.invoke('config:removePath', p),
  setSchedule: (which, calendar) => ipcRenderer.invoke('config:setSchedule', { which, calendar }),
  helperPresent: () => ipcRenderer.invoke('helper:present'),
  revealLog: (file) => ipcRenderer.invoke('open:external', file),
});
