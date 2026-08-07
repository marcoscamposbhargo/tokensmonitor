'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tokens', {
  onUpdate: (cb) => ipcRenderer.on('tokens:update', (_e, data) => cb(data)),
  snapshot: () => ipcRenderer.invoke('tokens:snapshot'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  close: () => ipcRenderer.send('window:close'),
  minimize: () => ipcRenderer.send('window:minimize'),
  pin: (pinned) => ipcRenderer.send('window:pin', pinned),
  stopFlash: () => ipcRenderer.send('window:flash-off'),
  openProjects: () => ipcRenderer.send('open:projects'),
});
