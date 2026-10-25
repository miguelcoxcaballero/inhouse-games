'use strict';

const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session, shell, Tray, Menu, nativeImage, powerSaveBlocker } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { validateInput } = require('./input-validation.cjs');
const { createDesktopGoogleAuth } = require('./google-auth.cjs');
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
    setSharingAwake(false);
    disableControl();
    captureDisplayId = null;
    captureBounds = null;
    return;
  }
  captureBounds = nextBounds;
  if (controlEnabled && !writeNative({ kind: 'bounds', ...nextBounds })) disableControl();
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
  ipcMain.handle('inhouse:google-sign-in', async (event) => {
    if (!trustedSender(event)) throw new Error('No se permite iniciar el acceso desde esta página.');
    const attempt = googleAuth.begin();
    // A canceled request can settle while the OS is still opening the browser.
    // Keep that rejection handled without changing the promise delivered to IPC.
    void attempt.promise.catch(() => {});
    try {
      await shell.openExternal(attempt.url);
      const result = await attempt.promise;
      if (!trustedSender(event)) throw new Error('La ventana que inició el acceso ya no está disponible.');
      if (window) { window.show(); if (window.isMinimized()) window.restore(); window.focus(); }
      return result;
    } catch (error) {
      attempt.cancel();
      throw new Error(error instanceof Error ? error.message : 'No se ha podido completar el acceso con Google.');
    }
  });
  ipcMain.on('inhouse:google-sign-out', (event) => {
    if (trustedSender(event)) googleAuth.cancel();
  });
  ipcMain.on('inhouse:minimize-host', (event) => {
    if (trustedSender(event) && captureBounds && window) window.minimize();
  });
  ipcMain.handle('inhouse:control', async (event, enabled) => {
    if (!trustedSender(event)) return false;
    if (enabled !== true) { disableControl(); return false; }
    if (process.platform !== 'win32' || !captureBounds || controlPrompt) return false;
    if (controlEnabled) return true;
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
    setSharingAwake(false);
    disableControl();
    captureBounds = null;
    captureDisplayId = null;
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
  window.webContents.on('render-process-gone', () => { googleAuth.cancel(); setSharingAwake(false); captureBounds = null; captureDisplayId = null; stopNative(); });
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) { googleAuth.cancel(); setSharingAwake(false); captureBounds = null; captureDisplayId = null; disableControl(); }
  });
  window.on('blur', releaseInputs);
  window.on('closed', () => { googleAuth.cancel(); setSharingAwake(false); captureBounds = null; captureDisplayId = null; stopNative(); window = null; });
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
    googleAuth.cancel();
    setSharingAwake(false);
    if (tray) { tray.destroy(); tray = null; }
    stopNative();
    if (localServer && !exiting) {
      event.preventDefault();
      exiting = true;
      Promise.resolve(localServer.close()).finally(() => app.quit());
    }
  });
}
