'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inhouseDesktop', Object.freeze({
  platform: process.platform,
  version: '0.2.0',
  setControlEnabled: (enabled) => ipcRenderer.invoke('inhouse:control', enabled === true),
  injectInput: (event) => ipcRenderer.send('inhouse:input', event),
  releaseInputs: () => ipcRenderer.send('inhouse:release'),
  captureEnded: () => ipcRenderer.send('inhouse:capture-ended'),
  minimizeHost: () => ipcRenderer.send('inhouse:minimize-host'),
  googleSignIn: () => ipcRenderer.invoke('inhouse:google-sign-in'),
  googleSignOut: () => ipcRenderer.send('inhouse:google-sign-out'),
}));
