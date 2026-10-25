'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inhouseDesktop', Object.freeze({
  platform: process.platform,
  version: '0.3.0',
  setControlEnabled: (enabled) => ipcRenderer.invoke('inhouse:control', enabled === true),
  injectInput: (event) => ipcRenderer.send('inhouse:input', event),
  releaseInputs: () => ipcRenderer.send('inhouse:release'),
  captureEnded: () => ipcRenderer.send('inhouse:capture-ended'),
  minimizeHost: () => ipcRenderer.send('inhouse:minimize-host'),
  googleSignIn: (options) => ipcRenderer.invoke('inhouse:google-sign-in', { cloudMode: options?.cloudMode === true }),
  googleSignOut: () => ipcRenderer.send('inhouse:google-sign-out'),
  getComputerName: () => ipcRenderer.invoke('inhouse:computer-name'),
  cloudAccountRestore: () => ipcRenderer.invoke('inhouse:cloud-account-restore'),
  cloudAccountForget: () => ipcRenderer.send('inhouse:cloud-account-forget'),
  enableCloudAccountHosting: (identity) => ipcRenderer.invoke('inhouse:cloud-account-hosting', identity),
  authorizeCloudPeer: (proof) => ipcRenderer.invoke('inhouse:cloud-account-peer', proof),
  renewCloudPeer: (proof) => ipcRenderer.invoke('inhouse:cloud-account-peer-renew', proof),
  enableAccountHosting: (credential) => ipcRenderer.invoke('inhouse:account-hosting', credential),
  getAccountCaptureSource: () => ipcRenderer.invoke('inhouse:account-capture-source'),
  authorizeAccountPeer: (connectionId) => ipcRenderer.invoke('inhouse:account-peer', connectionId),
  endAccountPeer: () => ipcRenderer.send('inhouse:account-peer-ended'),
  disableAccountHosting: () => ipcRenderer.send('inhouse:account-hosting-disabled'),
  onAccountHostingRevoked: (callback) => {
    const listener = (_event, reason) => callback(typeof reason === 'string' ? reason : 'La autorización de la cuenta ha terminado.');
    ipcRenderer.on('inhouse:account-hosting-revoked', listener);
    return () => ipcRenderer.removeListener('inhouse:account-hosting-revoked', listener);
  },
  onAccountPeerRevoked: (callback) => {
    const listener = (_event, reason) => callback(typeof reason === 'string' ? reason : 'La autorización de esta conexión ha terminado.');
    ipcRenderer.on('inhouse:account-peer-revoked', listener);
    return () => ipcRenderer.removeListener('inhouse:account-peer-revoked', listener);
  },
}));
