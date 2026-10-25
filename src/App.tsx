import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, Check, ChevronDown, Copy,
  Gauge, Globe2, Headphones, Keyboard, Laptop, Link2, LoaderCircle,
  LockKeyhole, Maximize2, Monitor, MousePointer2, Power,
  Radio, Settings2, ShieldCheck, Signal, Trash2, Volume2, VolumeX, Wifi, X,
} from 'lucide-react';
import { DEFAULT_SETTINGS, forgetTrustedHost, getTrustedDevices, getTrustedHosts, LinkSession, type LinkSettings, type LinkState, type SessionStats } from './lib/session';
import { attachRemoteInput } from './lib/input';
import AccountMenu, { type AccountProfile } from './components/AccountMenu';
import './styles.css';

type Tab = 'connect' | 'settings';
type Modal = 'download' | 'how' | null;
type DesktopBridge = {
  platform: string;
  version: string;
  setControlEnabled(enabled: boolean): Promise<boolean>;
  releaseInputs(): void;
  minimizeHost?(): void;
};
const desktop = (window as unknown as { inhouseDesktop?: DesktopBridge }).inhouseDesktop;
const WINDOWS_DOWNLOAD = `${import.meta.env.BASE_URL}downloads/Inhouse-Link-Windows.exe`;
const SETTINGS_KEY = 'inhouse.link.settings';
const POSITION_KEY = 'inhouse.link.menu-position';
type ShortcutAction = 'menu' | 'fullscreen' | 'stats' | 'immersive' | 'disconnect';
const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = { menu: 'Ctrl+Shift+KeyM', fullscreen: 'Ctrl+Shift+KeyF', stats: 'Ctrl+Shift+KeyS', immersive: 'Ctrl+Shift+KeyI', disconnect: 'Ctrl+Alt+Shift+KeyQ' };
const SHORTCUT_LABELS: Record<ShortcutAction, string> = { menu: 'Menú de sesión', fullscreen: 'Pantalla completa', stats: 'Estadísticas', immersive: 'Ratón para juegos', disconnect: 'Desconectar' };
function shortcutText(value: string) { return value.replace(/Key/g, '').replace(/Digit/g, '').replace(/\+/g, ' + '); }
function keyCombination(event: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'code'>) {
  return [event.ctrlKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', event.metaKey ? 'Meta' : '', event.code].filter(Boolean).join('+');
}
function readShortcuts(): Record<ShortcutAction, string> {
  try { const value = JSON.parse(localStorage.getItem('inhouse.link.shortcuts') || '{}'); return Object.fromEntries(Object.entries(DEFAULT_SHORTCUTS).map(([key, fallback]) => [key, typeof value[key] === 'string' && /^(Ctrl|Alt|Shift|Meta)\+/.test(value[key]) ? value[key] : fallback])) as Record<ShortcutAction, string>; }
  catch { return { ...DEFAULT_SHORTCUTS }; }
}
function storedServer() { try { const value = localStorage.getItem('inhouse.signalingUrl'); if (!value) return ''; const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.origin : ''; } catch { return ''; } }
function storedServiceToken() { try { return localStorage.getItem('inhouse.serviceToken') || ''; } catch { return ''; } }
const EMPTY_STATE: LinkState = {
  status: 'idle', role: null, code: '', deviceId: '', error: null, peerName: '', requests: [],
  stats: { rttMs: null, decodeMs: null, bitrateMbps: null, fps: null, packetLoss: null, resolution: '', transport: '', codec: '' },
  remoteStream: null, localStream: null, controlEnabled: false,
};

function readSettings(): LinkSettings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      resolution: ['native', '1080p', '1440p', '4k'].includes(value.resolution) ? value.resolution : DEFAULT_SETTINGS.resolution,
      fps: [30, 60, 120].includes(value.fps) ? value.fps : DEFAULT_SETTINGS.fps,
      bitrate: typeof value.bitrate === 'number' && value.bitrate >= 5 && value.bitrate <= 100 ? value.bitrate : DEFAULT_SETTINGS.bitrate,
      codec: ['auto', 'h264', 'vp9', 'av1'].includes(value.codec) ? value.codec : DEFAULT_SETTINGS.codec,
      audio: typeof value.audio === 'boolean' ? value.audio : DEFAULT_SETTINGS.audio,
      adaptive: typeof value.adaptive === 'boolean' ? value.adaptive : DEFAULT_SETTINGS.adaptive,
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

function Brand({ small = false }: { small?: boolean }) {
  return <span className={`brand ${small ? 'brand-small' : ''}`}>
    <span className="brand-symbol" aria-hidden="true"><svg viewBox="0 0 34 28" fill="none"><path d="M3 15 17 4 31 15M7 13v11h20V13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
    <span className="brand-wordmark">inhouse <span className="brand-product">link</span></span>
  </span>;
}

function Toggle({ checked, onChange, label, hint, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return <label className={`toggle-row ${disabled ? 'is-disabled' : ''}`}>
    <span><span className="toggle-label">{label}</span>{hint && <span className="toggle-hint">{hint}</span>}</span>
    <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    <span className="toggle-track" aria-hidden="true"><span /></span>
  </label>;
}

function QualitySettings({ settings, setSettings, compact = false }: { settings: LinkSettings; setSettings: (settings: LinkSettings) => void; compact?: boolean }) {
  const change = <K extends keyof LinkSettings>(key: K, value: LinkSettings[K]) => setSettings({ ...settings, [key]: value });
  return <div className={`quality-settings ${compact ? 'quality-compact' : ''}`}>
    <div className="settings-grid">
      <label className="field-label">Resolución<span className="select-wrap"><select aria-label="Resolución" value={settings.resolution} onChange={event => change('resolution', event.target.value as LinkSettings['resolution'])}>
        <option value="native">Nativa</option><option value="1080p">1080p · Full HD</option><option value="1440p">1440p · QHD</option><option value="4k">2160p · 4K</option>
      </select><ChevronDown size={14} /></span></label>
      <label className="field-label">Fotogramas<span className="select-wrap"><select aria-label="Fotogramas por segundo" value={settings.fps} onChange={event => change('fps', Number(event.target.value) as LinkSettings['fps'])}>
        <option value={30}>30 FPS</option><option value={60}>60 FPS</option><option value={120}>120 FPS</option>
      </select><ChevronDown size={14} /></span></label>
    </div>
    <label className="field-label bitrate-label"><span>Límite de bitrate <strong>{settings.bitrate} <small>Mb/s</small></strong></span>
      <input aria-label="Límite de bitrate" type="range" min="5" max="100" step="1" value={settings.bitrate} onChange={event => change('bitrate', Number(event.target.value))} style={{ '--range-progress': `${(settings.bitrate - 5) / 95 * 100}%` } as React.CSSProperties} />
      <span className="range-labels"><span>5 Mb/s</span><span>100 Mb/s</span></span>
    </label>
    <label className="field-label">Códec de vídeo<span className="select-wrap"><select aria-label="Códec de vídeo" value={settings.codec} onChange={event => change('codec', event.target.value as LinkSettings['codec'])}>
      <option value="auto">Automático · recomendado</option><option value="h264">H.264 · compatibilidad</option><option value="vp9">VP9 · eficiencia</option><option value="av1">AV1 · si está disponible</option>
    </select><ChevronDown size={14} /></span></label>
    <div className="settings-toggles">
      <Toggle label="Calidad adaptativa" hint={compact ? undefined : 'Ajusta el envío a la capacidad de tu conexión.'} checked={settings.adaptive} onChange={value => change('adaptive', value)} />
      <Toggle label="Audio del equipo" hint={compact ? undefined : 'Requiere que el anfitrión comparta el audio.'} checked={settings.audio} onChange={value => change('audio', value)} />
    </div>
    {!compact && <p className="field-note">La resolución y los FPS son límites solicitados. La captura, el equipo y el navegador determinan lo que se negocia realmente.</p>}
  </div>;
}

function Metric({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  return <div className="metric"><span>{label}</span><strong>{value === null || !Number.isFinite(value) ? '—' : value.toFixed(value < 10 && unit !== 'FPS' ? 1 : 0)}<small>{unit}</small></strong></div>;
}

const statusLabels: Record<LinkState['status'], string> = {
  idle: 'Listo para conectar', connecting: 'Conectando con el servicio…', hosting: 'Esperando conexión',
  pending: 'Esperando autorización', negotiating: 'Preparando vídeo…', connected: 'Conectado',
  disconnected: 'Sesión finalizada', error: 'No se ha podido conectar',
};

export type AppProps = {
  profile?: AccountProfile;
  onSignOut?: () => void;
  onSwitchAccount?: () => void;
  onHome?: () => void;
  windowsDownload?: { url: string } | null;
};

export default function App({ profile, onSignOut, onSwitchAccount, onHome, windowsDownload }: AppProps = {}) {
  const [state, setState] = useState<LinkState>(EMPTY_STATE);
  const [settings, setSettings] = useState<LinkSettings>(readSettings);
  const [tab, setTab] = useState<Tab>('connect');
  const [code, setCode] = useState('');
  const [name, setName] = useState(() => { try { return localStorage.getItem('inhouse.link.name') || profile?.name || ''; } catch { return profile?.name || ''; } });
  const [modal, setModal] = useState<Modal>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [inputEnabled, setInputEnabled] = useState(true);
  const [toast, setToast] = useState('');
  const [downloadAvailable, setDownloadAvailable] = useState(false);
  const [serverReady, setServerReady] = useState<boolean | null>(null);
  const [serverUrl, setServerUrl] = useState(storedServer);
  const [activeServer, setActiveServer] = useState(storedServer);
  const [serviceToken, setServiceToken] = useState(storedServiceToken);
  const [shortcuts, setShortcuts] = useState(readShortcuts);
  const [trustedHosts, setTrustedHosts] = useState(getTrustedHosts);
  const [trustedCount, setTrustedCount] = useState(() => getTrustedDevices().length);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [configRevision, setConfigRevision] = useState(0);
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState(() => {
    try { const p = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null'); return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: Math.max(12, Math.min(p.x, window.innerWidth - 72)), y: Math.max(12, Math.min(p.y, window.innerHeight - 72)) } : { x: 24, y: 24 }; } catch { return { x: 24, y: 24 }; }
  });
  const sessionRef = useRef<LinkSession | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef<{ startX: number; startY: number; x: number; y: number; moved: boolean } | null>(null);
  const diagnosticSamples = useRef<(SessionStats & { at: string })[]>([]);
  const inSession = state.status === 'connected' && !!(state.remoteStream || state.localStream);
  const busy = ['connecting', 'pending', 'negotiating'].includes(state.status);
  const resolvedWindowsDownload = windowsDownload === undefined ? (downloadAvailable ? WINDOWS_DOWNLOAD : null) : windowsDownload?.url || null;

  useEffect(() => { if (inSession) diagnosticSamples.current = []; }, [inSession]);
  useEffect(() => {
    if (inSession) diagnosticSamples.current = [...diagnosticSamples.current.slice(-299), { at: new Date().toISOString(), ...state.stats }];
  }, [inSession, state.stats]);

  useEffect(() => {
    const session = new LinkSession(setState);
    sessionRef.current = session;
    setState(session.state);
    return () => { session.destroy(); sessionRef.current = null; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const serviceBase = activeServer || import.meta.env.VITE_SIGNALING_URL || location.origin;
    const checkHealth = async () => {
      const healthUrl = new URL('/health', serviceBase).toString();
      const response = await fetch(healthUrl);
      const healthy = response.ok && response.headers.get('content-type')?.includes('application/json') && (await response.json()).ok === true;
      if (!cancelled) setServerReady(!!healthy);
    };
    void checkHealth().catch(() => { if (!cancelled) setServerReady(false); });
    if (windowsDownload === undefined) fetch(WINDOWS_DOWNLOAD, { method: 'HEAD' }).then(response => { if (!cancelled) setDownloadAvailable(response.ok && !response.headers.get('content-type')?.includes('text/html')); }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeServer, configRevision, windowsDownload]);

  useEffect(() => {
    setTrustedHosts(getTrustedHosts()); setTrustedCount(getTrustedDevices().length);
  }, [state]);

  useEffect(() => { try { localStorage.setItem('inhouse.link.shortcuts', JSON.stringify(shortcuts)); } catch { /* Optional persistence. */ } }, [shortcuts]);

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Settings remain usable without storage. */ }
    const timer = setTimeout(() => { if (['hosting', 'connected', 'negotiating'].includes(state.status)) void sessionRef.current?.updateSettings(settings).catch(error => notify(error instanceof Error ? error.message : 'No se han podido aplicar los ajustes.')); }, 180);
    return () => clearTimeout(timer);
  }, [settings, state.status]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = state.role === 'host' ? state.localStream : state.remoteStream;
    video.muted = state.role === 'host' || !settings.audio;
    void video.play().catch(() => {});
  }, [state.remoteStream, state.localStream, state.role, settings.audio, inSession]);

  useEffect(() => {
    if (state.role === 'host' && state.status === 'connected') desktop?.minimizeHost?.();
  }, [state.role, state.status]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !sessionRef.current || state.role !== 'viewer' || !inSession || !inputEnabled || !state.controlEnabled) return;
    return attachRemoteInput(video, sessionRef.current);
  }, [state.role, state.controlEnabled, inSession, inputEnabled]);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4400);
  }, []);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  useEffect(() => {
    if (!modal && state.requests.length === 0) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('.dialog button, .dialog a[href], .dialog input')?.focus());
    const trap = (event: KeyboardEvent) => {
      const dialog = document.querySelector<HTMLElement>('.dialog');
      if (!dialog) return;
      if (event.key === 'Escape' && modal) { event.preventDefault(); setModal(null); return; }
      if (event.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(element => element.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', trap, true);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', trap, true); if (previous?.isConnected) previous.focus(); };
  }, [modal, state.requests.length]);

  const disconnect = useCallback(() => {
    sessionRef.current?.disconnect(); setMenuOpen(false); setStatsOpen(false); setInputEnabled(true);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, []);

  const fullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => notify('No se ha podido salir de pantalla completa.'));
    else if (stageRef.current?.requestFullscreen) void stageRef.current.requestFullscreen().catch(() => notify('El navegador no ha permitido activar la pantalla completa.'));
    else notify('La pantalla completa no está disponible en este navegador.');
  }, [notify]);

  const immersive = useCallback(() => {
    if (state.role !== 'viewer' || !state.controlEnabled || !inputEnabled) { notify('El anfitrión debe permitir el control para capturar el ratón.'); return; }
    if (document.pointerLockElement) document.exitPointerLock();
    else if (videoRef.current?.requestPointerLock) {
      setMenuOpen(false); videoRef.current.focus();
      void Promise.resolve(videoRef.current.requestPointerLock()).catch(() => notify('No se ha podido capturar el ratón. Prueba con doble clic en el vídeo.'));
      const keyboardAPI = (navigator as Navigator & { keyboard?: { lock(keys?: string[]): Promise<void> } }).keyboard;
      void keyboardAPI?.lock(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']).catch(() => {});
    }
    else notify('Este navegador no permite capturar el ratón.');
  }, [state.role, state.controlEnabled, inputEnabled, notify]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!inSession) return;
      if (event.code === 'Escape' && menuOpen) { event.preventDefault(); event.stopImmediatePropagation(); setMenuOpen(false); videoRef.current?.focus(); return; }
      const action = (Object.entries(shortcuts) as [ShortcutAction, string][]).find(([, combination]) => combination === keyCombination(event))?.[0];
      if (!action) return;
      event.preventDefault(); event.stopImmediatePropagation(); sessionRef.current?.sendInput({ kind: 'release' });
      if (action === 'menu') { if (document.pointerLockElement) document.exitPointerLock(); setMenuOpen(value => !value); }
      else if (action === 'fullscreen') fullscreen();
      else if (action === 'stats') setStatsOpen(value => !value);
      else if (action === 'immersive') immersive();
      else if (action === 'disconnect') disconnect();
    };
    window.addEventListener('keydown', shortcut, true);
    return () => window.removeEventListener('keydown', shortcut, true);
  }, [inSession, fullscreen, disconnect, immersive, shortcuts, menuOpen]);

  const saveServer = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const value = serverUrl.trim();
      if (value) {
        const url = new URL(value);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Usa una dirección HTTPS sin rutas ni credenciales. HTTP solo se permite en localhost.');
        localStorage.setItem('inhouse.signalingUrl', url.origin); setServerUrl(url.origin); setActiveServer(url.origin);
      } else { localStorage.removeItem('inhouse.signalingUrl'); setServerUrl(''); setActiveServer(''); }
      if (serviceToken.trim()) localStorage.setItem('inhouse.serviceToken', serviceToken.trim()); else localStorage.removeItem('inhouse.serviceToken');
      sessionRef.current?.disconnect(); setServerReady(null); setConfigRevision(value => value + 1);
      window.dispatchEvent(new Event('inhouse-service-changed'));
      notify('Servicio guardado. Si cambias de servidor, vuelve a iniciar sesión.');
    } catch (error) { notify(error instanceof Error ? error.message : 'No se ha podido guardar el servicio.'); }
  };

  const rememberShortcut = (action: ShortcutAction, event: React.KeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    if (['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'].includes(event.code)) return;
    if (!event.ctrlKey && !event.altKey && !event.metaKey) { notify('Incluye Ctrl, Alt o la tecla Windows en el atajo.'); return; }
    const combination = keyCombination(event.nativeEvent);
    if (Object.entries(shortcuts).some(([key, value]) => key !== action && value === combination)) { notify('Ese atajo ya se utiliza para otra acción.'); return; }
    setShortcuts(value => ({ ...value, [action]: combination })); event.currentTarget.blur();
  };

  useEffect(() => {
    const onResize = () => setPosition(value => ({ x: Math.max(12, Math.min(value.x, window.innerWidth - 72)), y: Math.max(12, Math.min(value.y, window.innerHeight - 72)) }));
    window.addEventListener('resize', onResize); return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const keyboardAPI = (navigator as Navigator & { keyboard?: { lock(keys?: string[]): Promise<void>; unlock(): void } }).keyboard;
    const changed = () => { setPointerLocked(!!document.pointerLockElement); if (!document.pointerLockElement) keyboardAPI?.unlock(); };
    document.addEventListener('pointerlockchange', changed);
    return () => { document.removeEventListener('pointerlockchange', changed); keyboardAPI?.unlock(); };
  }, []);

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!code.replace(/[^A-Z0-9]/gi, '').length) { codeRef.current?.focus(); return; }
    try { localStorage.setItem('inhouse.link.name', name); } catch { /* Optional persistence. */ }
    await sessionRef.current?.join(code, settings, name.trim() || 'Portátil Windows').catch(error => notify(error instanceof Error ? error.message : 'No se ha podido conectar.'));
  };

  const host = async () => {
    if (!desktop) { setModal('download'); return; }
    await sessionRef.current?.host(settings).catch(error => notify(error instanceof Error ? error.message : 'No se ha podido compartir la pantalla.'));
  };

  const copyCode = async () => {
    try { await navigator.clipboard.writeText(state.code); setCopied(true); setTimeout(() => setCopied(false), 2200); }
    catch { notify('No se ha podido copiar. Selecciona el código y cópialo manualmente.'); }
  };

  const exportDiagnostic = () => {
    if (!diagnosticSamples.current.length) { notify('Espera a recibir las primeras estadísticas de la sesión.'); return; }
    const contents = { version: desktop?.version || '0.1.0', createdAt: new Date().toISOString(), samples: diagnosticSamples.current };
    const url = URL.createObjectURL(new Blob([JSON.stringify(contents, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `inhouse-link-diagnostico-${Date.now()}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('Diagnóstico exportado sin códigos, claves ni nombres de equipos.');
  };

  const toggleControl = async (enabled: boolean) => {
    if (state.role === 'host') {
      const allowed = await sessionRef.current?.setControlEnabled(enabled);
      if (enabled && !allowed) notify('El control remoto requiere la aplicación Windows y una captura activa.');
    } else {
      setInputEnabled(enabled); sessionRef.current?.setViewerInputEnabled(enabled);
    }
  };

  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startY: event.clientY, x: position.x, y: position.y, moved: false };
  };

  const moveDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = drag.current; if (!current) return;
    const dx = event.clientX - current.startX, dy = event.clientY - current.startY;
    if (Math.abs(dx) + Math.abs(dy) > 5) current.moved = true;
    if (current.moved) setPosition({ x: Math.max(12, Math.min(current.x + dx, window.innerWidth - 72)), y: Math.max(12, Math.min(current.y + dy, window.innerHeight - 72)) });
  };

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = drag.current; drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (current && !current.moved) setMenuOpen(value => !value);
    try { localStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch { /* Optional persistence. */ }
  };

  const menuAboveButton = position.y > window.innerHeight / 2;
  const panelStyle = {
    left: Math.min(position.x, Math.max(12, window.innerWidth - 352)),
    top: menuAboveButton ? undefined : position.y + 66,
    bottom: menuAboveButton ? window.innerHeight - position.y + 10 : undefined,
    maxHeight: Math.max(80, menuAboveButton ? position.y - 22 : window.innerHeight - position.y - 78),
  };

  return <div className={`app ${inSession ? 'app-in-session' : ''}`}>
    {!inSession && <>
      <header className="app-header">
        <a className="brand-link" href="#/" aria-label="inhouse link, inicio" onClick={event => { event.preventDefault(); if (onHome) onHome(); else setTab('connect'); }}><Brand /></a>
        <nav className="main-nav" aria-label="Navegación principal">
          <button className={tab === 'connect' ? 'active' : ''} onClick={() => setTab('connect')}>Conexión</button>
          <button data-testid="settings-open" className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Ajustes</button>
        </nav>
        <div className="header-end"><span className="platform-chip"><span className="tiny-dot" />{desktop ? 'Aplicación de escritorio' : 'Cliente web'}</span><button className="icon-button help-button" aria-label="Cómo funciona" onClick={() => setModal('how')}>?</button>{profile && onSignOut && <AccountMenu profile={profile} onSignOut={onSignOut} onSwitchAccount={onSwitchAccount} onHome={onHome} />}</div>
      </header>

      <main className="main-content">
        {tab === 'connect' ? <>
          <section className="hero-section">
            <div className="hero-copy"><div className="eyebrow"><span className="eyebrow-line" />TU ESPACIO, SIN DISTANCIAS</div><h1>Tu PC.<br />Donde estés<span className="accent-text">.</span></h1><p>El juego se queda en casa.<br className="desktop-break" /> Tú decides desde dónde jugar.</p><div className="hero-badges"><span><ShieldCheck size={14} />Conexión cifrada</span><span><MousePointer2 size={14} />Control en tiempo real</span></div></div>
            <div className="connection-visual" aria-label="Conecta tu PC Windows con tu portátil a través de una sesión cifrada">
              <div className="visual-grid" /><span className="visual-caption top-caption">UN ENLACE. TU EQUIPO.</span>
              <div className="computer-node host-node"><div className="node-icon"><Monitor size={33} strokeWidth={1.3} /><span className="node-indicator" /></div><span>Tu PC Windows</span><small>ANFITRIÓN</small></div>
              <div className="visual-route"><span /><span className="route-lock"><LockKeyhole size={17} /></span><span /></div>
              <div className="computer-node client-node"><div className="node-icon"><Laptop size={33} strokeWidth={1.3} /><span className="node-indicator" /></div><span>Tu portátil</span><small>CLIENTE</small></div>
              <div className="visual-bottom"><span className="live-line" />Vídeo, audio y controles. En una sola sesión.</div>
            </div>
          </section>

          <section className="connection-cards" aria-label="Conectar y compartir">
            <article className="connect-card primary-card">
              <div className="card-heading"><span className="card-icon"><Link2 size={21} /></span><span className="step-number">01 / CONECTAR</span><span className="card-corner-icon"><ArrowUpRight size={20} /></span></div>
              <h2>Entra en tu equipo.</h2><p>Introduce el código que aparece en el PC que quieres utilizar.</p>
              <form onSubmit={connect}>
                <label className="sr-only" htmlFor="connection-code">Código de conexión</label>
                <div className={`code-input-wrap ${busy ? 'is-busy' : ''}`}><Keyboard size={19} /><input ref={codeRef} id="connection-code" data-testid="join-code" aria-label="Código de conexión" type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="XXXX · XXXX" maxLength={20} value={code} disabled={busy || state.status === 'hosting'} onChange={event => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9 -]/g, ''))} /><span className="input-key">CÓDIGO</span></div>
                <div className="name-input-row"><label htmlFor="viewer-name">Tu nombre</label><input id="viewer-name" data-testid="join-name" placeholder="Mi portátil" value={name} maxLength={40} onChange={event => setName(event.target.value)} disabled={busy} /></div>
                <button className="button button-primary connect-button" data-testid="connect-button" type="submit" disabled={busy || state.status === 'hosting' || !code.replace(/[^A-Z0-9]/g, '')}>{busy ? <><LoaderCircle size={18} className="spin" />{statusLabels[state.status]}</> : <>Conectar al equipo<ArrowRight size={18} /></>}</button>
              </form>
              <div className="card-footnote"><LockKeyhole size={13} />Tú decides qué dispositivos pueden entrar.</div>
            </article>

            <article className="connect-card host-card">
              <div className="card-heading"><span className="card-icon subdued"><Monitor size={21} /></span><span className="step-number">02 / COMPARTIR</span><span className="card-corner-icon"><Radio size={19} /></span></div>
              <h2>Deja tu PC a mano.</h2><p>Abre Inhouse Link en tu PC Windows y comparte tu pantalla de forma segura.</p>
              {state.status === 'hosting' || (state.role === 'host' && busy) ? <div className="hosting-code"><span className="status-label"><span className="status-dot pulse" />{statusLabels[state.status]}</span><div><strong data-testid="host-code">{state.code || '···· ····'}</strong><button className="icon-button" onClick={copyCode} aria-label="Copiar código">{copied ? <Check size={18} /> : <Copy size={18} />}</button></div><span>Compártelo solo con la persona que quieres conectar.</span><button className="text-button" onClick={disconnect}>Dejar de compartir</button></div> : <>
                <div className="host-feature-list"><span><Check size={15} />Tú apruebas quién entra</span><span><Check size={15} />Vídeo y audio del equipo</span><span><Check size={15} />Revoca el control cuando quieras</span></div>
                <button className="button button-secondary" data-testid="host-button" onClick={host} disabled={busy}>{desktop ? <><Radio size={17} />Compartir este PC</> : <><ArrowDownToLine size={17} />Obtener la app de Windows</>}<ArrowUpRight size={17} /></button>
              </>}
              <div className="card-footnote"><Monitor size={13} />{desktop ? 'La captura requiere tu permiso.' : 'El navegador funciona como cliente. La app comparte el PC.'}</div>
            </article>
          </section>

          {state.status !== 'idle' && state.status !== 'hosting' && !inSession && <div className={`connection-feedback ${state.status === 'error' ? 'feedback-error' : ''}`} role="status"><span>{busy ? <LoaderCircle size={18} className="spin" /> : state.status === 'error' ? <X size={18} /> : <Signal size={18} />}</span><div><strong>{statusLabels[state.status]}</strong><p>{state.error || (state.status === 'pending' ? 'El PC remoto debe aceptar tu solicitud antes de compartir vídeo y controles.' : state.status === 'disconnected' ? 'Puedes iniciar otra conexión cuando quieras.' : 'Estableciendo una conexión entre los dos equipos.')}</p></div>{busy && <button className="text-button" onClick={disconnect}>Cancelar</button>}</div>}

          {trustedHosts.length > 0 && <section className="trusted-hosts" aria-label="Equipos vinculados"><div className="trusted-section-heading"><div><span className="eyebrow">SIEMPRE A MANO</span><h2>Tus equipos vinculados.</h2></div><span>{trustedHosts.length} {trustedHosts.length === 1 ? 'equipo' : 'equipos'}</span></div><div className="trusted-list">{trustedHosts.map(device => <article className="trusted-device" key={device.deviceId}><span className="trusted-device-icon"><Monitor size={22} /></span><div><strong>{device.name || 'PC vinculado'}</strong><span>El PC debe estar encendido y compartiendo.</span></div><button className="button button-secondary" disabled={busy || state.status === 'hosting'} onClick={() => { void sessionRef.current?.join(device.deviceId, settings, name.trim() || 'Mi portátil').catch(error => notify(error instanceof Error ? error.message : 'No se ha podido reconectar.')); }}>Conectar<ArrowRight size={15} /></button><button className="icon-button" aria-label={`Quitar ${device.name || 'PC vinculado'}`} onClick={() => { forgetTrustedHost(device.deviceId); setTrustedHosts(getTrustedHosts()); notify('Equipo eliminado de este dispositivo.'); }}><Trash2 size={16} /></button></article>)}</div></section>}
          <section className="bottom-note"><div><span className="note-icon"><Globe2 size={20} /></span><p><strong>Tu conexión importa.</strong><span>Conecta ambos equipos al mismo servicio. Usar cable en el PC y una Wi-Fi estable en el portátil mejora la experiencia.</span></p></div><button onClick={() => setModal('how')} className="text-button">Cómo funciona<ArrowUpRight size={15} /></button></section>
        </> : <section className="settings-page">
          <div className="page-heading"><div className="eyebrow"><span className="eyebrow-line" />A TU MEDIDA</div><h1>La conexión,<br />a tu manera<span className="accent-text">.</span></h1><p>Un punto de partida para tu próxima sesión.<br />También puedes ajustar la calidad mientras juegas.</p></div>
          <div className="settings-card"><div className="settings-card-header"><span className="card-icon"><Settings2 size={22} /></span><div><h2>Vídeo y sonido</h2><p>Los ajustes se guardan en este dispositivo.</p></div></div><QualitySettings settings={settings} setSettings={setSettings} /><button className="text-button reset-button" onClick={() => { setSettings({ ...DEFAULT_SETTINGS }); notify('Ajustes restaurados.'); }}>Restaurar valores recomendados</button></div>
          <section className="server-settings"><div className="settings-section-title"><Globe2 size={19} /><h3>Tu servicio de conexión.</h3></div><p>Ambos equipos deben utilizar el mismo servicio. En la app de Windows, configura su dirección pública HTTPS para conectar desde otra red.</p><form onSubmit={saveServer}><label className="field-label" htmlFor="signaling-url">Dirección del servicio<input data-testid="signaling-url" id="signaling-url" type="url" placeholder="https://link.tudominio.com" value={serverUrl} onChange={event => setServerUrl(event.target.value)} /></label><label className="field-label" htmlFor="service-token">Clave del servicio (si la requiere)<input data-testid="service-token" id="service-token" type="password" autoComplete="current-password" placeholder="Opcional" value={serviceToken} onChange={event => setServiceToken(event.target.value)} /></label><button className="button button-secondary" data-testid="save-settings" type="submit">Guardar servicio<Check size={15} /></button></form><span className="field-note">Vacío utiliza el servicio de esta página. HTTP solo se admite en localhost para desarrollo.</span></section>
          <div className="keyboard-guide"><Keyboard size={20} /><div><h3>Atajos de inhouse link.</h3><p>Pulsa un campo y escribe la combinación que prefieras.</p>{(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map(action => <div className="shortcut-setting" key={action}><label htmlFor={`shortcut-${action}`}>{SHORTCUT_LABELS[action]}</label><input id={`shortcut-${action}`} aria-label={`Atajo ${SHORTCUT_LABELS[action]}`} readOnly value={shortcutText(shortcuts[action])} onKeyDown={event => rememberShortcut(action, event)} onFocus={event => event.currentTarget.select()} /></div>)}<button className="text-button" onClick={() => setShortcuts({ ...DEFAULT_SHORTCUTS })}>Restaurar atajos</button><small>Ctrl + Shift + I activa la captura del ratón, como el modo inmersivo de Parsec. La captura de teclado está limitada por el navegador y Windows; no todos sus atajos se pueden reenviar.</small></div></div>
          {desktop && <section className="trusted-settings"><div className="settings-section-title"><ShieldCheck size={19} /><h3>Dispositivos autorizados.</h3></div><p>{trustedCount === 0 ? 'Ningún dispositivo tiene permiso para reconectar sin autorización.' : `${trustedCount} ${trustedCount === 1 ? 'dispositivo puede' : 'dispositivos pueden'} reconectar a este PC cuando esté compartiendo.`}</p><button className="text-button revoke-button" disabled={trustedCount === 0} onClick={() => { sessionRef.current?.clearTrustedDevices(); setTrustedCount(0); notify('Permisos revocados. La próxima conexión necesitará autorización.'); }}><Trash2 size={14} />Revocar todos los dispositivos</button></section>}
        </section>}
      </main>

      <footer className="app-footer"><span>Hecho para estar cerca.</span><div><span className={`tiny-dot ${serverReady === true ? 'is-live' : serverReady === false ? 'is-offline' : ''}`} />{serverReady === null ? 'Comprobando servicio…' : serverReady ? 'Servicio de conexión disponible' : 'Servicio de conexión no disponible'}</div><span className="footer-version">inhouse link <span>·</span> {desktop?.version || 'WEB'}</span></footer>
    </>}

    {inSession && <div ref={stageRef} className="session-stage" data-testid="session-stage">
      <video ref={videoRef} data-testid="remote-video" className="remote-video" autoPlay playsInline tabIndex={0} aria-label={state.role === 'host' ? 'Vista previa de tu pantalla compartida' : 'Pantalla del equipo remoto'} onClick={() => { if (state.role === 'viewer' && state.controlEnabled && inputEnabled) videoRef.current?.focus(); }} />
      {state.role === 'host' && <div className="host-session-banner"><Radio size={15} /><span>Compartiendo con <strong>{state.peerName || 'un dispositivo autorizado'}</strong></span><button onClick={disconnect}>Dejar de compartir</button></div>}
      <button className={`floating-menu-button ${menuOpen ? 'is-open' : ''}`} data-testid="session-menu-toggle" aria-label={menuOpen ? 'Cerrar menú de sesión' : 'Abrir menú de sesión'} aria-expanded={menuOpen} title="Menú de sesión · arrastra para mover" style={{ left: position.x, top: position.y }} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => { drag.current = null; }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setMenuOpen(value => !value); } }}><span className="brand-symbol" aria-hidden="true"><svg viewBox="0 0 34 28" fill="none"><path d="M3 15 17 4 31 15M7 13v11h20V13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span></button>
      {menuOpen && <aside className="session-menu" data-testid="session-menu" style={panelStyle} aria-label="Menú de sesión"><div className="session-menu-header"><Brand small /><button className="icon-button" aria-label="Cerrar menú" onClick={() => setMenuOpen(false)}><X size={16} /></button></div><div className="session-peer"><span className="status-dot pulse" /><div><strong>{state.role === 'host' ? state.peerName || 'Cliente conectado' : 'Equipo remoto'}</strong><span>{state.role === 'host' ? 'Estás compartiendo tu pantalla' : 'Sesión cifrada · WebRTC'}</span></div><Signal size={17} /></div><div className="session-actions">{state.role === 'viewer' && <button onClick={immersive} disabled={!state.controlEnabled || !inputEnabled}><MousePointer2 size={16} /><span>{pointerLocked ? 'Liberar ratón' : 'Ratón para juegos'}</span><kbd>{shortcutText(shortcuts.immersive)}</kbd></button>}<button onClick={fullscreen}><Maximize2 size={16} /><span>Pantalla completa</span><kbd>{shortcutText(shortcuts.fullscreen)}</kbd></button><button onClick={() => setStatsOpen(value => !value)} aria-pressed={statsOpen}><Gauge size={16} /><span>Estadísticas</span><span className={`action-dot ${statsOpen ? 'active' : ''}`} /></button><button onClick={() => setSettings(value => ({ ...value, audio: !value.audio }))}>{settings.audio ? <Volume2 size={16} /> : <VolumeX size={16} />}<span>{settings.audio ? 'Silenciar audio' : 'Activar audio'}</span></button><button onClick={exportDiagnostic}><ArrowDownToLine size={16} /><span>Exportar diagnóstico</span></button></div><div className="session-quality"><span className="section-label">CALIDAD DE LA SESIÓN</span><QualitySettings settings={settings} setSettings={setSettings} compact /></div><div className="session-control"><Toggle label={state.role === 'host' ? 'Permitir teclado y ratón' : 'Capturar teclado y ratón'} hint={state.role === 'host' ? 'Puedes retirar el permiso en cualquier momento.' : state.controlEnabled ? 'Haz clic en el vídeo para enviar los controles.' : 'El anfitrión aún no ha habilitado el control.'} checked={state.role === 'host' ? state.controlEnabled : inputEnabled} disabled={state.role === 'viewer' && !state.controlEnabled} onChange={value => void toggleControl(value)} /></div><button className="disconnect-button" onClick={disconnect}><Power size={16} /><span>Desconectar</span><span>{shortcutText(shortcuts.disconnect)}</span></button>{onSignOut && <button className="session-signout" onClick={() => { disconnect(); onSignOut(); }}>Cerrar sesión de Google</button>}</aside>}
      {statsOpen && <aside className="stats-overlay" data-testid="session-stats" aria-label="Estadísticas reales de la conexión"><div className="stats-heading"><span><Gauge size={14} />ESTADÍSTICAS EN DIRECTO</span><button className="icon-button" aria-label="Cerrar estadísticas" onClick={() => setStatsOpen(false)}><X size={14} /></button></div><div className="stats-metrics"><Metric label="Red · RTT" value={state.stats.rttMs} unit="ms" /><Metric label="Decodificación" value={state.stats.decodeMs} unit="ms" /><Metric label="Fotogramas" value={state.stats.fps} unit="FPS" /><Metric label={state.role === 'host' ? 'Vídeo enviado' : 'Vídeo recibido'} value={state.stats.bitrateMbps} unit="Mb/s" /><Metric label="Pérdida de paquetes" value={state.stats.packetLoss} unit="%" /></div><div className="stats-detail"><span>{state.stats.resolution || 'Resolución pendiente'}</span><span>{state.stats.codec || 'Códec pendiente'}</span><span>{state.stats.transport || 'Ruta pendiente'}</span></div><p>Medidas de WebRTC. RTT es ida y vuelta de red, no latencia total de extremo a extremo.</p></aside>}
      {state.role === 'viewer' && !state.controlEnabled && <div className="session-view-only"><MousePointer2 size={13} />Solo visualización · el anfitrión controla los permisos</div>}
    </div>}

    {state.requests.length > 0 && <div className="modal-backdrop"><section className="dialog approval-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-title"><span className="dialog-hero-icon"><ShieldCheck size={30} /></span><span className="eyebrow">TÚ TIENES EL CONTROL</span><h2 id="approval-title">Una nueva conexión.</h2><p><strong>{state.requests[0].name || 'Un dispositivo'}</strong> quiere ver tu pantalla y controlar este PC. Acepta solo si reconoces esta solicitud.</p><div className="approval-detail"><Monitor size={18} /><span>Compartirás vídeo, audio si está disponible y, en Windows, teclado y ratón.</span></div><button className="button button-primary" onClick={() => sessionRef.current?.approve(state.requests[0].id, true, false)} data-testid="approve-once"><Check size={18} />Permitir esta vez</button><button className="button button-secondary approve-trust-button" onClick={() => sessionRef.current?.approve(state.requests[0].id, true, true)} data-testid="approve-trust"><ShieldCheck size={18} />Permitir y vincular</button><p className="approval-remember-note">Al vincular, este portátil podrá reconectar sin otra aprobación mientras el PC siga compartiendo. Puedes revocar el permiso en Ajustes.</p><button className="button button-ghost" data-testid="reject-request" onClick={() => sessionRef.current?.approve(state.requests[0].id, false)}>Rechazar conexión</button></section></div>}

    {modal && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setModal(null); }}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><button className="icon-button dialog-close" aria-label="Cerrar ventana" onClick={() => setModal(null)}><X size={20} /></button>{modal === 'download' ? <><span className="dialog-hero-icon"><Monitor size={30} /></span><span className="eyebrow">EL PC SE QUEDA. TÚ TE MUEVES.</span><h2 id="dialog-title">Todo empieza<br />en tu PC Windows.</h2><p>La aplicación de Inhouse Link comparte tu pantalla y permite el control remoto. Después podrás entrar desde este navegador o desde otro Windows.</p><ol className="setup-steps"><li><span>1</span>Abre la app en el PC que tiene tus juegos.</li><li><span>2</span>Pulsa «Compartir este PC» y copia el código.</li><li><span>3</span>Conecta desde tu portátil y autoriza la solicitud.</li></ol>{resolvedWindowsDownload ? <a className="button button-primary" href={resolvedWindowsDownload} download><ArrowDownToLine size={18} />Descargar para Windows<ArrowUpRight size={17} /></a> : <div className="download-notice"><ArrowDownToLine size={18} /><span>El ejecutable Windows todavía no está disponible en este servidor. Necesitas la compilación de la app para compartir el PC.</span></div>}<p className="dialog-fineprint">Compartir pantalla desde el navegador no permite controlar Windows. Por eso el anfitrión utiliza la aplicación.</p></> : <><span className="dialog-hero-icon"><Link2 size={30} /></span><span className="eyebrow">MENOS DISTANCIA. MÁS CONEXIÓN.</span><h2 id="dialog-title">Tu equipo.<br />Al otro lado.</h2><p>Inhouse Link transmite el vídeo y el audio del PC y devuelve tus acciones de teclado y ratón mediante WebRTC.</p><div className="explanation-list"><div><ShieldCheck size={20} /><span><strong>Cada conexión necesita permiso</strong>El código inicia una solicitud. El anfitrión decide si acepta y puede retirar el acceso.</span></div><div><Wifi size={20} /><span><strong>La red marca la diferencia</strong>Una conexión directa suele dar mejor respuesta. Un servidor intermedio ayuda cuando la red no permite conectarlos directamente, aunque puede añadir demora.</span></div><div><Gauge size={20} /><span><strong>Datos medidos, no promesas</strong>Las estadísticas muestran medidas reales del navegador. No representan una comparación medida con otros programas.</span></div><div><Headphones size={20} /><span><strong>Primera versión</strong>Teclado, ratón, pantalla y audio según el sistema. Los mandos y HDR requieren desarrollo adicional.</span></div></div><button className="button button-primary" onClick={() => setModal(null)}>Entendido<ArrowRight size={18} /></button></>}</section></div>}

    {toast && <div className="toast" role="status"><span>{toast}</span><button className="icon-button" aria-label="Cerrar notificación" onClick={() => setToast('')}><X size={16} /></button></div>}
  </div>;
}
