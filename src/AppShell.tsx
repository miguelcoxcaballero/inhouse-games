import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, Check, ChevronRight, CircleAlert,
  Code2, Copy, FileArchive, Gauge, Globe2, Keyboard, Laptop, LoaderCircle,
  LockKeyhole, Monitor, MousePointer2, Radio, ShieldCheck, SlidersHorizontal,
} from 'lucide-react';
import App from './App';
import DesktopAuth from './DesktopAuth';
import AccountMenu from './components/AccountMenu';
import { GoogleAccount, type AccountState } from './lib/google-account';
import './website.css';

type Route = 'home' | 'downloads' | 'client' | 'desktop-auth';
type DownloadKind = 'windows' | 'web' | 'source';
type DownloadAsset = { url: string; sha256: string; size: number };
type ReleaseManifest = { version: string; tag: string; publishedAt: string | null; downloads: Partial<Record<DownloadKind, DownloadAsset>> };
type LocalDownload = { url: string; size: number | null; sha256: string | null };
type ReleaseState = { status: 'loading' | 'ready' | 'unavailable' | 'error'; manifest: ReleaseManifest | null; localWindows: LocalDownload | null; error: string | null };
const BASE = import.meta.env.BASE_URL;
const LOCAL_WINDOWS = `${BASE}downloads/Inhouse-Link-Windows.exe`;
const INITIAL_ACCOUNT: AccountState = { status: 'loading', profile: null, error: null };

function routeFromHash(): Route {
  const path = location.hash.split('?')[0].replace(/^#/, '').replace(/\/$/, '');
  if (path === '/desktop-auth') return 'desktop-auth';
  if (path === '/client') return 'client';
  if (path === '/downloads') return 'downloads';
  return 'home';
}

function assetUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return null;
  try {
    const base = new URL(BASE, document.baseURI);
    const url = new URL(value, base);
    const sameOrigin = url.origin === location.origin;
    if (url.username || url.password || (url.protocol !== 'https:' && !(sameOrigin && url.protocol === 'http:'))) return null;
    return url.toString();
  } catch { return null; }
}

function parseManifest(value: unknown): ReleaseManifest | null {
  if (!value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  if (typeof object.version !== 'string' || !object.version.trim() || object.version.length > 80
    || typeof object.tag !== 'string' || !object.tag.trim() || object.tag.length > 160
    || !object.downloads || typeof object.downloads !== 'object') return null;
  const downloads: ReleaseManifest['downloads'] = {};
  for (const kind of ['windows', 'web', 'source'] as DownloadKind[]) {
    const asset = (object.downloads as Record<string, unknown>)[kind] as Partial<DownloadAsset> | undefined;
    if (!asset || typeof asset !== 'object') continue;
    const url = assetUrl(asset.url);
    if (url && typeof asset.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(asset.sha256)
      && typeof asset.size === 'number' && Number.isSafeInteger(asset.size) && asset.size > 0) {
      downloads[kind] = { url, sha256: asset.sha256.toLowerCase(), size: asset.size };
    }
  }
  const publishedAt = typeof object.publishedAt === 'string' && Number.isFinite(Date.parse(object.publishedAt)) ? object.publishedAt : null;
  return { version: object.version, tag: object.tag, publishedAt, downloads };
}

function useRelease(): ReleaseState {
  const [release, setRelease] = useState<ReleaseState>({ status: 'loading', manifest: null, localWindows: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`${BASE}release.json`, { signal: controller.signal, headers: { Accept: 'application/json' }, cache: 'no-cache' });
        if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
          const manifest = parseManifest(await response.json());
          if (!manifest) { setRelease({ status: 'error', manifest: null, localWindows: null, error: 'La información de esta publicación no es válida. Las descargas no están disponibles.' }); return; }
          setRelease({ status: 'ready', manifest, localWindows: null, error: null }); return;
        }
        const missing = response.status === 404 || (response.ok && response.headers.get('content-type')?.includes('text/html'));
        if (!missing) throw new Error('No se ha podido consultar la publicación. Reintenta más tarde.');
        const local = await fetch(LOCAL_WINDOWS, { method: 'HEAD', signal: controller.signal });
        if (!local.ok || local.headers.get('content-type')?.includes('text/html')) {
          setRelease({ status: 'unavailable', manifest: null, localWindows: null, error: null }); return;
        }
        const length = Number(local.headers.get('content-length'));
        const size = Number.isSafeInteger(length) && length > 0 ? length : null;
        let sha256: string | null = null;
        try {
          const checksum = await fetch(`${LOCAL_WINDOWS}.sha256`, { signal: controller.signal });
          if (checksum.ok && !checksum.headers.get('content-type')?.includes('text/html')) {
            const match = (await checksum.text()).match(/^([a-f0-9]{64})(?:\s|$)/i); sha256 = match?.[1].toLowerCase() ?? null;
          }
        } catch (error) { if (controller.signal.aborted) throw error; }
        setRelease({ status: 'ready', manifest: null, localWindows: { url: LOCAL_WINDOWS, size, sha256 }, error: null });
      } catch (error) {
        if (!controller.signal.aborted) setRelease({ status: 'error', manifest: null, localWindows: null, error: error instanceof Error ? error.message : 'No se han podido cargar las descargas.' });
      }
    };
    void load();
    return () => controller.abort();
  }, []);
  return release;
}

function formatSize(bytes: number | null) {
  if (bytes === null) return null;
  return `${(bytes / 1024 / 1024).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MiB`;
}

function Roof({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 34 28" fill="none" aria-hidden="true"><path d="M3 15 17 4 31 15M7 13v11h20V13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function SiteBrand() {
  return <a className="site-brand" href="#/" aria-label="inhouse link, inicio"><Roof /><span>inhouse <strong>link</strong></span></a>;
}

const FEATURE_CARDS = [
  { icon: Monitor, title: 'Tu PC hace el trabajo.', description: 'Los juegos se ejecutan en tu equipo Windows. La app comparte la pantalla y el sonido; tú te conectas desde otro lugar.' },
  { icon: Globe2, title: 'Un navegador basta.', description: 'Entra en el cliente web desde tu portátil. También puedes conectarte desde la aplicación de Windows.' },
  { icon: ShieldCheck, title: 'Tú decides quién entra.', description: 'Autoriza una sesión o vincula un dispositivo de confianza. Puedes retirar el permiso cuando quieras.' },
  { icon: SlidersHorizontal, title: 'Calidad a tu medida.', description: 'Ajusta resolución, fotogramas, bitrate y audio desde el menú de la sesión, sin salir del vídeo.' },
  { icon: MousePointer2, title: 'El control, a mano.', description: 'Teclado, ratón y captura del puntero para juegos. Un botón flotante mantiene los ajustes al alcance.' },
  { icon: Gauge, title: 'Mide tu conexión.', description: 'Consulta las estadísticas reales y exporta un diagnóstico. La red y ambos equipos determinan la experiencia.' },
];

function Homepage({ release }: { release: ReleaseState }) {
  const windows = release.manifest?.downloads.windows || release.localWindows;
  return <>
    <section className="site-hero site-wrap">
      <div className="site-hero-copy"><span className="site-eyebrow"><span />TU EQUIPO. OTRO LUGAR.</span><h1>Los juegos,<br />en casa.<br /><span>Tú, donde quieras.</span></h1><p>Conecta con tu PC Windows desde el navegador o desde otro Windows. Tu escritorio, tus controles y tu espacio, al otro lado del enlace.</p><div className="site-hero-actions"><a className="site-button site-button-primary" data-testid="home-windows-download" href={windows?.url || '#/downloads'}>{windows ? <ArrowDownToLine size={18} /> : <FileArchive size={18} />}{windows ? 'Descargar para Windows' : 'Ver descargas'}<ArrowUpRight size={17} /></a><a className="site-button site-button-outline" href="#/client">Abrir cliente web<ArrowRight size={17} /></a></div><div className="site-hero-meta"><span><LockKeyhole size={13} />Sesión cifrada</span><span><Monitor size={13} />Anfitrión Windows</span><span><Globe2 size={13} />Cliente web</span></div></div>
      <div className="site-hero-art" aria-label="Tu PC Windows se conecta con tu portátil a través de inhouse link"><div className="site-art-grid" /><div className="site-art-title"><Roof /><span>un enlace. tu espacio.</span><span className="site-art-corner">inhouse link</span></div><div className="site-host-tile"><span className="site-device-icon"><Monitor size={40} strokeWidth={1.2} /></span><span className="site-device-label">Tu equipo Windows</span><small>LOS JUEGOS SE EJECUTAN AQUÍ</small><div className="site-device-details"><span><Keyboard size={12} />Teclado y ratón</span><span><Radio size={12} />Pantalla y audio</span></div></div><div className="site-art-link"><span /><span className="site-art-roof"><Roof /></span><span /></div><div className="site-client-tile"><div className="site-browser-chrome"><i /><i /><i /><span>cliente web</span></div><div className="site-browser-content"><Laptop size={39} strokeWidth={1.2} /><strong>Tu portátil.</strong><span>El siguiente lugar lo eliges tú.</span><span className="site-browser-pill"><ShieldCheck size={12} />Acceso autorizado por ti</span></div><div className="site-art-floating"><Roof /></div></div><div className="site-art-caption"><span />Comparte en un equipo. Conecta desde el otro.</div></div>
    </section>

    <section className="site-features site-wrap" aria-labelledby="features-title"><div className="site-section-heading"><div><span className="site-eyebrow">DENTRO DEL ENLACE</span><h2 id="features-title">Tu espacio.<br />Sin cambiar de equipo.</h2></div><p>Una aplicación para compartir.<br />Una web para conectar.</p></div><div className="site-feature-grid">{FEATURE_CARDS.map(({ icon: Icon, title, description }) => <article className="site-feature-card" key={title}><span><Icon size={22} strokeWidth={1.5} /></span><h3>{title}</h3><p>{description}</p></article>)}</div></section>

    <section className="site-steps site-wrap" aria-labelledby="steps-title"><div className="site-section-heading"><div><span className="site-eyebrow">DE AQUÍ A ALLÍ</span><h2 id="steps-title">Tres pasos.<br />Un mismo espacio.</h2></div><a href="#/client" className="site-inline-link">Abrir el cliente<ArrowUpRight size={17} /></a></div><ol className="site-step-grid"><li><span>01</span><h3>Prepara el PC.</h3><p>Abre la aplicación Windows en el equipo que tiene los juegos. Inicia sesión con Google y pulsa «Compartir este PC».</p></li><li><span>02</span><h3>Entra desde el portátil.</h3><p>Abre el cliente web o la app de Windows, inicia sesión y utiliza el código del anfitrión para solicitar acceso.</p></li><li><span>03</span><h3>Autoriza y conecta.</h3><p>Acepta la solicitud en el PC. Si vinculas el portátil, podrá reconectar mientras el equipo siga encendido y compartiendo.</p></li></ol><div className="site-network-note"><Globe2 size={19} /><p>Para conectar dos redes distintas, ambos equipos deben usar un servicio de conexión publicado y configurado para acceso por Internet. La aplicación incluye las instrucciones para prepararlo.</p></div></section>

    <section className="site-bottom-cta site-wrap"><Roof /><span className="site-eyebrow">DEJA EL PC. LLÉVATE TU ESPACIO.</span><h2>Nos vemos<br />al otro lado<span>.</span></h2><a className="site-button site-button-primary" href="#/client">Entrar con Google<ArrowRight size={18} /></a><span className="site-bottom-caption">La misma cuenta que puedes usar en inhouse notes y read.</span></section>
  </>;
}

function DownloadPage({ release }: { release: ReleaseState }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async (key: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(key); setCopyError(false); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(null), 2200); }
    catch { setCopyError(true); }
  };
  const manifest = release.manifest;
  const downloads = manifest?.downloads || {};
  const windows = downloads.windows || release.localWindows;
  const cards: { key: DownloadKind; icon: typeof Monitor; label: string; tag: string; description: string; action: string; asset: DownloadAsset | LocalDownload | null | undefined }[] = [
    { key: 'windows', icon: Monitor, label: 'Windows', tag: 'APLICACIÓN · 64 BITS', description: 'Comparte tu PC o conecta con otro equipo desde la aplicación de escritorio.', action: 'Descargar .exe', asset: windows },
    { key: 'web', icon: Globe2, label: 'Cliente web y servidor', tag: 'WEB + SERVICIO', description: 'Cliente web compilado y servidor de conexión Node.js para alojarlos en tu propia infraestructura.', action: 'Descargar web .zip', asset: downloads.web },
    { key: 'source', icon: Code2, label: 'Código fuente', tag: 'PROYECTO COMPLETO', description: 'El proyecto de inhouse link, con el cliente, el servicio de conexión y las instrucciones de desarrollo.', action: 'Descargar código .zip', asset: downloads.source },
  ];
  return <main className="site-download-page site-wrap" data-testid="downloads-page"><div className="site-download-heading"><span className="site-eyebrow">TODO EN SU SITIO</span><h1>Elige tu<br />punto de partida<span>.</span></h1><p>Descarga la aplicación, publica el cliente web<br />o explora el proyecto por dentro.</p></div>
    {manifest && <div className="site-release-bar"><span className="site-release-dot" /><strong>Versión {manifest.version}</strong><span>{manifest.tag}</span>{manifest.publishedAt && <time dateTime={manifest.publishedAt}>{new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' }).format(new Date(manifest.publishedAt))}</time>}</div>}
    {release.status === 'loading' && <div className="site-release-notice" role="status"><LoaderCircle size={18} className="spin" /><span>Consultando las descargas disponibles…</span></div>}
    {release.error && <div className="site-release-notice is-error" role="alert"><CircleAlert size={18} /><span>{release.error}</span></div>}
    {release.status === 'unavailable' && <div className="site-release-notice"><FileArchive size={18} /><span>Aún no hay una publicación disponible para descargar desde este sitio.</span></div>}
    {!manifest && release.localWindows && <div className="site-release-notice"><Monitor size={18} /><span>Compilación local de Windows. Este servidor todavía no incluye información de una publicación.</span></div>}
    <section className="site-download-grid" aria-label="Archivos para descargar">{cards.map(({ key, icon: Icon, label, tag, description, action, asset }) => <article className={`site-download-card ${key === 'windows' ? 'is-primary' : ''}`} key={key}><div className="site-download-icon"><Icon size={29} strokeWidth={1.4} /></div><span className="site-eyebrow">{tag}</span><h2>{label}</h2><p>{description}</p><div className="site-download-filemeta">{asset ? <><span>{formatSize(asset.size) || 'Tamaño no publicado'}</span>{manifest && <span>v{manifest.version}</span>}</> : <span>{release.status === 'loading' ? 'Consultando…' : 'No publicado en este sitio'}</span>}</div>{asset ? <a className={`site-button ${key === 'windows' ? 'site-button-primary' : 'site-button-outline'}`} href={asset.url} data-testid={`download-${key}`}><ArrowDownToLine size={17} />{action}<ArrowUpRight size={15} /></a> : <button className="site-button site-button-outline" disabled><ArrowDownToLine size={17} />No disponible</button>}{asset?.sha256 && <div className="site-checksum"><span>SHA-256<button aria-label={`Copiar SHA-256 de ${label}`} onClick={() => void copy(key, asset.sha256!)}>{copied === key ? <Check size={13} /> : <Copy size={13} />}</button></span><code>{asset.sha256}</code></div>}</article>)}</section>
    {copyError && <p className="site-copy-error" role="alert">No se ha podido copiar. Puedes seleccionar el SHA-256 y copiarlo manualmente.</p>}
    <section className="site-web-alternative"><span className="site-device-icon"><Globe2 size={26} /></span><div><h2>También puedes entrar desde aquí.</h2><p>El cliente web se abre en el navegador. Inicia sesión con Google y conecta con tu PC.</p></div><a className="site-button site-button-outline" href="#/client">Abrir cliente web<ArrowRight size={17} /></a></section>
    <p className="site-download-footnote">El SHA-256 permite comparar el archivo descargado con el valor publicado. La firma y la ejecución en Windows se indican en las notas de cada versión.</p>
  </main>;
}

function LoginPage({ account, onSignIn, serviceChanged }: { account: AccountState; onSignIn: () => void; serviceChanged: boolean }) {
  return <main className="site-login-page site-wrap"><div className="site-login-art" aria-hidden="true"><div className="site-login-orbit orbit-one" /><div className="site-login-orbit orbit-two" /><span className="site-login-roof"><Roof /></span><span className="site-login-satellite satellite-pc"><Monitor size={27} strokeWidth={1.4} /></span><span className="site-login-satellite satellite-laptop"><Laptop size={27} strokeWidth={1.4} /></span></div><section className="site-login-card" aria-labelledby="login-heading"><span className="site-eyebrow">BIENVENIDO A TU ESPACIO</span><h1 id="login-heading">Un enlace.<br />Tu cuenta<span>.</span></h1><p>Entra con Google para conectar con tus equipos.<br />Puedes usar la misma cuenta de inhouse notes y read.</p>{serviceChanged && <div className="site-login-notice" role="status">Has cambiado el servicio de conexión. Vuelve a iniciar sesión para autorizar el acceso a ese servicio.</div>}<button className="site-google-button" data-testid="login-google" disabled={account.status === 'loading'} onClick={onSignIn}>{account.status === 'loading' ? <LoaderCircle size={20} className="spin" /> : <span className="google-g" aria-hidden="true">G</span>}<span>{account.status === 'loading' ? 'Preparando acceso…' : 'Continuar con Google'}</span><ChevronRight size={17} /></button>{account.error && <div className="site-login-error" data-testid="login-error" role="alert"><CircleAlert size={17} /><span>{account.error}</span></div>}<div className="site-login-note"><ShieldCheck size={16} /><p>Tu cuenta permite acceder a inhouse link. El PC anfitrión sigue decidiendo qué dispositivos pueden ver su pantalla y controlarlo.</p></div><a className="site-inline-link" href="#/downloads">Solo quiero descargar la app<ArrowUpRight size={14} /></a></section></main>;
}

function Website({ route }: { route: Exclude<Route, 'desktop-auth'> }) {
  const [account, setAccount] = useState<AccountState>(INITIAL_ACCOUNT);
  const google = useRef<GoogleAccount | null>(null);
  const [serviceChanged, setServiceChanged] = useState(false);
  const release = useRelease();
  useEffect(() => {
    const provider = new GoogleAccount(setAccount); google.current = provider;
    setAccount(provider.state); void provider.initialize();
    return () => { provider.destroy(); google.current = null; };
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [route]);
  useEffect(() => {
    const changed = () => setServiceChanged(true);
    window.addEventListener('inhouse-service-changed', changed);
    return () => window.removeEventListener('inhouse-service-changed', changed);
  }, []);
  useEffect(() => { if (account.status === 'signed-in') setServiceChanged(false); }, [account.status]);
  const signIn = () => { void google.current?.signIn().catch(() => { /* The provider reports the actual failure in account state. */ }); };
  const signOut = () => google.current?.signOut();
  const switchAccount = () => { google.current?.signOut(); signIn(); };
  const goHome = () => { location.hash = '#/'; };
  const windows = release.manifest?.downloads.windows || release.localWindows;

  if (route === 'client' && account.status === 'signed-in' && account.profile) {
    return <App profile={account.profile} onSignOut={signOut} onSwitchAccount={switchAccount} onHome={goHome} windowsDownload={windows ? { url: windows.url } : null} />;
  }
  return <div className="site-shell"><header className="site-header site-wrap"><SiteBrand /><nav aria-label="Web de inhouse link"><a className={route === 'home' ? 'active' : ''} href="#/">Producto</a><a className={route === 'downloads' ? 'active' : ''} href="#/downloads">Descargas</a></nav><div className="site-header-actions">{account.status === 'signed-in' && account.profile ? <AccountMenu profile={account.profile} onSignOut={signOut} onSwitchAccount={switchAccount} /> : null}<a className="site-header-client" href="#/client">Abrir cliente<ArrowUpRight size={15} /></a></div></header>{route === 'home' ? <main><Homepage release={release} /></main> : route === 'downloads' ? <DownloadPage release={release} /> : <LoginPage account={account} onSignIn={signIn} serviceChanged={serviceChanged} />}<footer className="site-footer site-wrap"><SiteBrand /><span>Hecho para estar cerca.</span><div><a href="https://github.com/miguelcoxcaballero/inhouse-games" target="_blank" rel="noopener noreferrer">El proyecto<ArrowUpRight size={12} /></a><a href="#/downloads">Descargas</a><a href="#/client">Cliente web</a></div></footer></div>;
}

export default function AppShell() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  useEffect(() => {
    const changed = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  // The external desktop login broker owns its own account provider.
  return route === 'desktop-auth' ? <DesktopAuth /> : <Website route={route} />;
}
