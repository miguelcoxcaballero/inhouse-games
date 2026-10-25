'use strict';

const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session, shell, Tray, Menu, nativeImage, powerSaveBlocker, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { validateInput } = require('./input-validation.cjs');
const { createDesktopGoogleAuth } = require('./google-auth.cjs');
const { createAccountHostingAuthority, createPeerRevocationHandler } = require('./account-hosting.cjs');
const { createCloudAccountAuthority } = require('./cloud-account.cjs');
const googleAuth = createDesktopGoogleAuth({ publicAppUrl: process.env.INHOUSE_PUBLIC_APP_URL || process.env.VITE_PUBLIC_APP_URL });

let window;
let localServer;
let appOrigin;
let captureBounds = null;
let captureDisplayId = null;
let controlEnabled = false;
let controlPrompt = false;
let controlEpoch = 0;
let nativeInput;
let nativeReady;
let inputCount = 0;
let inputBucket = Date.now();
let exiting = false;
let tray;
let wakeLock = null;
let accountHosting;
let googleOwnerVerifier;
let googleLoginEpoch = 0;
let controlFromAccount = false;
let cloudAccount;
let accountHostingMode = null;

function nativeAccountAuthority() { return accountHostingMode === 'cloud' ? cloudAccount : accountHosting; }

function nativeProtectedStorageAvailable() {
  try {
    return safeStorage.isEncryptionAvailable()
      && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text');
  } catch { return false; }
}

function notifyNative(name, reason) {
  if (window && !window.isDestroyed()) window.webContents.send(name, reason);
}

function stopAccountHosting(reason = '') {
  accountHosting?.disable(reason);
  cloudAccount?.disable(reason);
  accountHostingMode = null;
  setSharingAwake(false);
  disableControl();
  captureBounds = null;
  captureDisplayId = null;
}

async function nativeGoogleOwner(accessToken) {
  if (!googleOwnerVerifier) {
    const { createGoogleTokenVerifier, DEFAULT_GOOGLE_CLIENT_ID } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'google-auth.mjs')).href);
    googleOwnerVerifier = createGoogleTokenVerifier({ clientId: process.env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID });
  }
  return googleOwnerVerifier(accessToken);
}

function setSharingAwake(active) {
  if (active && wakeLock === null) wakeLock = powerSaveBlocker.start('prevent-display-sleep');
  if (!active && wakeLock !== null) {
    powerSaveBlocker.stop(wakeLock);
    wakeLock = null;
  }
}

function createTray() {
  if (process.platform !== 'win32') return;
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')));
  tray.setToolTip('inhouse link');
  const show = () => { if (window) { window.show(); window.restore(); window.focus(); } };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir inhouse link', click: show },
    { type: 'separator' },
    { label: 'Salir y detener la conexión', click: () => app.quit() },
  ]));
  tray.on('double-click', show);
}

function trustedSender(event) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents) return false;
  try {
    return event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === appOrigin;
  } catch { return false; }
}

function writeNative(event) {
  if (!nativeInput || nativeInput.killed || nativeInput.stdin.destroyed || !nativeInput.stdin.writable) return false;
  if (nativeInput.stdin.writableLength > 64 * 1024) {
    disableControl();
    return false;
  }
  try {
    nativeInput.stdin.write(`${JSON.stringify(event)}\n`);
    return true;
  } catch {
    disableControl();
    return false;
  }
}

function releaseInputs() {
  if (nativeInput && !nativeInput.killed && !nativeInput.stdin.destroyed && nativeInput.stdin.writable) {
    try { nativeInput.stdin.write('{"kind":"release"}\n'); } catch {}
  }
}

function disableControl() {
  controlEpoch += 1;
  controlEnabled = false;
  controlFromAccount = false;
  releaseInputs();
}

function stopNative() {
  disableControl();
  const child = nativeInput;
  nativeInput = null;
  nativeReady = null;
  if (child && !child.killed) {
    child.stdin.end('{"kind":"quit"}\n');
    const timeout = setTimeout(() => child.kill(), 1000);
    timeout.unref();
    child.once('exit', () => clearTimeout(timeout));
  }
}

function startNative() {
  if (nativeReady) return nativeReady;
  nativeReady = new Promise((resolve, reject) => {
    const helper = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'desktop', 'native', 'input.ps1')
      : path.join(__dirname, 'native', 'input.ps1');
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', helper], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    nativeInput = child;
    let output = '';
    let settled = false;
    const timer = setTimeout(() => fail(new Error('El componente de control de Windows no responde.')), 15000);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      nativeReady = null;
      disableControl();
      child.kill();
      reject(error);
    };
    child.on('error', () => fail(new Error('No se pudo iniciar el componente de control de Windows.')));
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 8192) output = output.slice(-8192);
      if (!settled && output.includes('INHOUSE_INPUT_READY')) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', () => {
      // Never echo helper input or potentially sensitive renderer messages to logs.
      if (!settled) fail(new Error('Windows bloqueó el componente de control. Revisa su política de PowerShell.'));
    });
    child.on('exit', () => {
      if (!settled) fail(new Error('El componente de control se cerró antes de iniciar.'));
      if (nativeInput === child) {
        nativeInput = null;
        nativeReady = null;
        controlEnabled = false;
      }
    });
    child.stdin.on('error', () => disableControl());
  });
  return nativeReady;
}

function selectedDisplayBounds(displayId) {
  const display = screen.getAllDisplays().find((candidate) => String(candidate.id) === String(displayId));
  if (!display) return null;
  try {
    const rect = process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : display.bounds;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  } catch { return null; }
}

function updateCaptureBounds() {
  if (!captureDisplayId) return;
  const nextBounds = selectedDisplayBounds(captureDisplayId);
  if (!nextBounds) {
    nativeAccountAuthority()?.disable('La pantalla compartida ya no está disponible.');
    setSharingAwake(false);
    disableControl();
    captureDisplayId = null;
    captureBounds = null;
    return;
  }
  captureBounds = nextBounds;
  if (controlEnabled && !writeNative({ kind: 'bounds', ...nextBounds })) disableControl();
}

async function accountCaptureSource() {
  const authority = nativeAccountAuthority();
  if (!authority?.canCapture()) return null;
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 160, height: 90 } });
  if (authority !== nativeAccountAuthority() || !authority.canCapture()) return null;
  const primary = screen.getPrimaryDisplay();
  const source = sources.find((candidate) => String(candidate.display_id) === String(primary.id));
  if (!source) return null;
  const bounds = selectedDisplayBounds(source.display_id);
  if (!bounds) return null;
  disableControl();
  captureDisplayId = String(source.display_id);
  captureBounds = bounds;
  setSharingAwake(true);
  return source;
}

async function enableOwnAccountControl() {
  const authority = nativeAccountAuthority();
  if (process.platform !== 'win32' || !captureBounds || !authority?.canControl()) return false;
  const epoch = controlEpoch;
  const bounds = captureBounds;
  await startNative();
  if (epoch !== controlEpoch || captureBounds !== bounds || authority !== nativeAccountAuthority() || !authority.canControl()) return false;
  if (!writeNative({ kind: 'bounds', ...bounds })) return false;
  controlEnabled = true;
  controlFromAccount = true;
  return true;
}

function registerCapture() {
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return requestingOrigin === appOrigin && ['media', 'display-capture', 'fullscreen', 'pointerLock'].includes(permission);
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    let trusted = false;
    try { trusted = contents === window.webContents && new URL(contents.getURL()).origin === appOrigin; } catch {}
    callback(trusted && ['media', 'display-capture', 'fullscreen', 'pointerLock'].includes(permission));
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    setSharingAwake(false);
    disableControl();
    captureBounds = null;
    captureDisplayId = null;
    try {
      if (!window || request.frame !== window.webContents.mainFrame || new URL(request.frame.url).origin !== appOrigin) {
        callback({});
        return;
      }
      if (nativeAccountAuthority()?.canCapture()) {
        const ownSource = await accountCaptureSource();
        if (!ownSource) { callback({}); return; }
        if (process.platform === 'win32' && request.audioRequested) callback({ video: ownSource, audio: 'loopback' });
        else callback({ video: ownSource });
        return;
      }
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 160, height: 90 } });
      if (!sources.length) { callback({}); return; }
      const result = await dialog.showMessageBox(window, {
        type: 'question',
        title: 'Compartir pantalla · Inhouse Link',
        message: 'Elige la pantalla que quieres compartir',
        detail: `La otra persona verá esta pantalla${request.audioRequested && process.platform === 'win32' ? ' y escuchará el audio del sistema' : ''} cuando aceptes su conexión. El PC se mantendrá activo mientras compartes. Puedes detener la sesión en cualquier momento.`,
        buttons: [...sources.map((source, index) => `${index + 1}. ${source.name}`), 'Cancelar'],
        defaultId: 0,
        cancelId: sources.length,
        noLink: true,
      });
      const source = sources[result.response];
      if (!source) { callback({}); return; }
      captureDisplayId = String(source.display_id);
      captureBounds = selectedDisplayBounds(captureDisplayId);
      setSharingAwake(true);
      if (process.platform === 'win32' && request.audioRequested) callback({ video: source, audio: 'loopback' });
      else callback({ video: source });
    } catch {
      setSharingAwake(false);
      captureBounds = null;
      captureDisplayId = null;
      callback({});
    }
  });
}

function registerIpc() {
  ipcMain.handle('inhouse:computer-name', (event) => {
    if (!trustedSender(event)) throw new Error('No se permite consultar este equipo desde esa página.');
    return os.hostname().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || 'PC Windows';
  });
  ipcMain.handle('inhouse:account-hosting', async (event, credential) => {
    if (!trustedSender(event) || process.platform !== 'win32') return false;
    stopAccountHosting();
    const allowed = await accountHosting.enable(credential);
    if (!trustedSender(event)) { stopAccountHosting(); return false; }
    if (allowed) accountHostingMode = 'backend';
    return allowed;
  });
  ipcMain.handle('inhouse:cloud-account-restore', async (event) => {
    if (!trustedSender(event)) return null;
    const restored = await cloudAccount.restore();
    return trustedSender(event) ? restored : null;
  });
  ipcMain.on('inhouse:cloud-account-forget', (event) => {
    if (!trustedSender(event)) return;
    stopAccountHosting();
    void cloudAccount.forget().catch(() => {});
  });
  ipcMain.handle('inhouse:cloud-account-hosting', async (event, identity) => {
    if (!trustedSender(event) || process.platform !== 'win32') return null;
    stopAccountHosting();
    const enabled = await cloudAccount.enable(identity);
    if (!trustedSender(event)) { stopAccountHosting(); return null; }
    if (enabled) accountHostingMode = 'cloud';
    return enabled;
  });
  ipcMain.handle('inhouse:account-capture-source', async (event) => {
    if (!trustedSender(event) || process.platform !== 'win32') return null;
    const source = await accountCaptureSource();
    if (!trustedSender(event)) { stopAccountHosting(); return null; }
    return source ? { sourceId: source.id } : null;
  });
  ipcMain.handle('inhouse:account-peer', async (event, connectionId) => {
    if (!trustedSender(event) || process.platform !== 'win32') return false;
    if (!await accountHosting.authorizePeer(connectionId) || !trustedSender(event)) return false;
    try { return await enableOwnAccountControl(); }
    catch { accountHosting.endPeer('No se ha podido iniciar el control de Windows.'); return false; }
  });
  ipcMain.handle('inhouse:cloud-account-peer', async (event, proof) => {
    if (!trustedSender(event) || process.platform !== 'win32' || accountHostingMode !== 'cloud') return false;
    if (!await cloudAccount.authorizePeer(proof) || !trustedSender(event)) return false;
    try { return await enableOwnAccountControl(); }
    catch { cloudAccount.endPeer('No se ha podido iniciar el control de Windows.'); return false; }
  });
  ipcMain.handle('inhouse:cloud-account-peer-renew', async (event, proof) => {
    if (!trustedSender(event) || process.platform !== 'win32' || accountHostingMode !== 'cloud') return false;
    return cloudAccount.renewPeer(proof);
  });
  ipcMain.on('inhouse:account-peer-ended', (event) => {
    if (!trustedSender(event)) return;
    accountHosting.endPeer();
    cloudAccount.endPeer();
    disableControl();
  });
  ipcMain.on('inhouse:account-hosting-disabled', (event) => { if (trustedSender(event)) stopAccountHosting(); });
  ipcMain.handle('inhouse:google-sign-in', async (event, options) => {
    if (!trustedSender(event)) throw new Error('No se permite iniciar el acceso desde esta página.');
    const loginEpoch = ++googleLoginEpoch;
    accountHosting.pauseForLogin();
    cloudAccount.beginLogin();
    stopAccountHosting();
    const attempt = googleAuth.begin();
    // A canceled request can settle while the OS is still opening the browser.
    // Keep that rejection handled without changing the promise delivered to IPC.
    void attempt.promise.catch(() => {});
    try {
      await shell.openExternal(attempt.url);
      const result = await attempt.promise;
      if (!trustedSender(event) || loginEpoch !== googleLoginEpoch) throw new Error('La ventana que inició el acceso ya no está disponible.');
      const owner = await nativeGoogleOwner(result.accessToken);
      if (!trustedSender(event) || loginEpoch !== googleLoginEpoch) throw new Error('La solicitud de acceso ya no está activa.');
      await accountHosting.recordGoogleOwner(owner);
      if (!trustedSender(event) || loginEpoch !== googleLoginEpoch) throw new Error('La solicitud de acceso ya no está activa.');
      let cloud = null;
      if (options?.cloudMode === true) {
        const { obtainDriveRealm } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'drive-realm.mjs')).href);
        const realm = await obtainDriveRealm(result.accessToken, owner);
        if (!trustedSender(event) || loginEpoch !== googleLoginEpoch) throw new Error('La solicitud de acceso ya no está activa.');
        cloud = await cloudAccount.recordSession(realm, owner);
        if (!cloud || !trustedSender(event) || loginEpoch !== googleLoginEpoch) throw new Error('La solicitud de acceso ya no está activa.');
      }
      if (window) { window.show(); if (window.isMinimized()) window.restore(); window.focus(); }
      return cloud ? { ...result, cloudRealm: cloud.realm, profile: cloud.profile, cloudSessionExpiresAt: cloud.expiresAt } : result;
    } catch (error) {
      attempt.cancel();
      throw new Error(error instanceof Error ? error.message : 'No se ha podido completar el acceso con Google.');
    }
  });
  ipcMain.on('inhouse:google-sign-out', (event) => {
    if (!trustedSender(event)) return;
    googleLoginEpoch++;
    googleAuth.cancel();
    stopAccountHosting();
    void accountHosting.signOut().catch(() => {});
    void cloudAccount.forget().catch(() => {});
  });
  ipcMain.on('inhouse:minimize-host', (event) => {
    if (trustedSender(event) && captureBounds && window) window.minimize();
  });
  ipcMain.handle('inhouse:control', async (event, enabled) => {
    if (!trustedSender(event)) return false;
    if (enabled !== true) { disableControl(); return false; }
    if (process.platform !== 'win32' || !captureBounds || controlPrompt) return false;
    if (controlEnabled) return true;
    if (nativeAccountAuthority()?.canControl()) {
      try { return await enableOwnAccountControl(); } catch { return false; }
    }
    controlPrompt = true;
    const requestedEpoch = controlEpoch;
    const requestedBounds = captureBounds;
    try {
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Permitir control remoto · Inhouse Link',
        message: '¿Permitir teclado y ratón en este PC?',
        detail: 'Las conexiones que aceptes o vincules podrán usar el teclado y el ratón mientras sigas compartiendo esta pantalla, también al reconectar. Desactiva el control o deja de compartir para revocar este permiso.',
        buttons: ['Cancelar', 'Permitir control'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response !== 1 || captureBounds !== requestedBounds || controlEpoch !== requestedEpoch || !window || window.isDestroyed()) return false;
      await startNative();
      if (captureBounds !== requestedBounds || controlEpoch !== requestedEpoch || !window || window.isDestroyed()) return false;
      if (!writeNative({ kind: 'bounds', ...captureBounds })) return false;
      controlEnabled = true;
      return true;
    } catch (error) {
      disableControl();
      if (window && !window.isDestroyed()) await dialog.showMessageBox(window, { type: 'error', title: 'Control no disponible', message: error.message });
      return false;
    } finally { controlPrompt = false; }
  });
  ipcMain.on('inhouse:input', (event, data) => {
    if (!trustedSender(event) || !controlEnabled || !captureBounds) return;
    if (controlFromAccount && !nativeAccountAuthority()?.canControl()) { disableControl(); return; }
    const validated = validateInput(data);
    if (!validated) return;
    if (validated.kind === 'release') { releaseInputs(); return; }
    if (Date.now() - inputBucket > 1000) { inputBucket = Date.now(); inputCount = 0; }
    if (++inputCount > 1500) { disableControl(); return; }
    writeNative(validated);
  });
  ipcMain.on('inhouse:release', (event) => { if (trustedSender(event)) releaseInputs(); });
  ipcMain.on('inhouse:capture-ended', (event) => {
    if (!trustedSender(event)) return;
    stopAccountHosting();
  });
}

function configureNavigation() {
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { if (new URL(url).protocol === 'https:') void shell.openExternal(url); } catch {}
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin === appOrigin) return; } catch {}
    event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', () => { googleLoginEpoch++; googleAuth.cancel(); stopAccountHosting(); stopNative(); });
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) { googleLoginEpoch++; googleAuth.cancel(); stopAccountHosting(); }
  });
  window.on('blur', releaseInputs);
  window.on('closed', () => { googleLoginEpoch++; googleAuth.cancel(); stopAccountHosting(); stopNative(); window = null; });
}

async function createWindow() {
  let appUrl = process.env.INHOUSE_DEV_URL;
  if (appUrl) {
    const parsed = new URL(appUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
      throw new Error('INHOUSE_DEV_URL debe apuntar a una dirección local.');
    }
  }
  // The fixed loopback callback exists in development too: Google opens in the
  // regular browser on the already-authorized public web origin.
  const { createSignalingServer } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.mjs')).href);
  localServer = createSignalingServer({
    port: 48715,
    host: '127.0.0.1',
    staticDir: path.join(__dirname, '..', 'dist'),
    sessionStorePath: path.join(app.getPath('userData'), 'account-sessions.json'),
    handleDesktopAuth: googleAuth.handleRequest,
  });
  let address;
  try { address = await localServer.listen(); }
  catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error('El puerto local 48715 está ocupado. Cierra la otra aplicación que lo utiliza y vuelve a abrir Inhouse Link. No se cambia de puerto para conservar la identidad de este equipo.');
    throw error;
  }
  appUrl ||= `http://127.0.0.1:${address.port}`;
  const route = new URL(appUrl);
  route.hash = '/client';
  appUrl = route.href;
  appOrigin = new URL(appUrl).origin;
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    title: 'Inhouse Link',
    backgroundColor: '#151515',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  configureNavigation();
  registerCapture();
  await window.loadURL(appUrl);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  });
  app.whenReady().then(async () => {
    accountHosting = createAccountHostingAuthority({
      file: path.join(app.getPath('userData'), 'native-account-hosting.json'),
      onPeerRevoked: createPeerRevocationHandler(disableControl, (reason) => notifyNative('inhouse:account-peer-revoked', reason)),
      onHostingRevoked: (reason) => {
        setSharingAwake(false);
        disableControl();
        captureBounds = null;
        captureDisplayId = null;
        notifyNative('inhouse:account-hosting-revoked', reason);
      },
    });
    cloudAccount = createCloudAccountAuthority({
      file: path.join(app.getPath('userData'), 'native-cloud-account.bin'),
      protect: (value) => safeStorage.encryptString(value),
      unprotect: (value) => safeStorage.decryptString(value),
      isProtectionAvailable: nativeProtectedStorageAvailable,
      onPeerRevoked: createPeerRevocationHandler(disableControl, (reason) => notifyNative('inhouse:account-peer-revoked', reason)),
      onHostingRevoked: (reason) => {
        setSharingAwake(false); disableControl(); captureBounds = null; captureDisplayId = null;
        notifyNative('inhouse:account-hosting-revoked', reason);
      },
    });
    registerIpc();
    screen.on('display-metrics-changed', updateCaptureBounds);
    screen.on('display-added', updateCaptureBounds);
    screen.on('display-removed', updateCaptureBounds);
    await createWindow();
    createTray();
  }).catch((error) => {
    dialog.showErrorBox('Inhouse Link no pudo iniciar', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    googleLoginEpoch++;
    googleAuth.cancel();
    stopAccountHosting();
    setSharingAwake(false);
    if (tray) { tray.destroy(); tray = null; }
    stopNative();
    if (localServer && !exiting) {
      event.preventDefault();
      exiting = true;
      Promise.allSettled([localServer.close(), accountHosting?.flush(), cloudAccount?.flush()]).finally(() => app.quit());
    }
  });
}
