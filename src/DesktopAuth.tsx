import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, LockKeyhole, LoaderCircle, ShieldCheck } from 'lucide-react';
import { GoogleAccount, type AccountState } from './lib/google-account';
import { createDesktopCallbackUrl, readDesktopAuthRequest, type DesktopAuthRequest } from './lib/desktop-auth';

/** This route runs in the user's regular browser, never an embedded OAuth view. */
export default function DesktopAuth() {
  const [request] = useState<DesktopAuthRequest | null>(() => {
    if (window.inhouseDesktop) return null;
    try { return readDesktopAuthRequest(); } catch { return null; }
  });
  const [account, setAccount] = useState<AccountState>({ status: 'loading', profile: null, error: null });
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState(false);
  const manager = useRef<GoogleAccount | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!request) return;
    const google = new GoogleAccount(setAccount, { googleOnly: true });
    manager.current = google;
    void google.initialize().catch(() => {
      if (mounted.current) setError('No se ha podido preparar Google. Recarga esta página para intentarlo de nuevo.');
    });
    return () => { mounted.current = false; google.destroy(); manager.current = null; };
  }, [request]);

  const continueToDesktop = async () => {
    if (!request || !manager.current) { setError('Vuelve a iniciar el acceso desde la aplicación de Windows.'); return; }
    setSending(true); setError(null);
    try {
      let session = manager.current.getOAuthSession();
      // An Inhouse service session may outlive the Google access token. Start a
      // fresh Google popup directly in this click before awaiting anything else.
      if (!session) { await manager.current.signIn(); session = manager.current.getOAuthSession(); }
      if (!session) throw new Error('No current Google access token.');
      const callback = await createDesktopCallbackUrl(request, session);
      if (!mounted.current) return;
      setReady(true);
      // Only encrypted data and the single-use state travel in this fragment.
      location.replace(callback);
    } catch {
      if (mounted.current) { setSending(false); setError('No se ha podido devolver el acceso a Windows. Vuelve a iniciarlo desde la aplicación.'); }
    }
  };

  const signIn = () => {
    setError(null);
    void manager.current?.signIn().catch(() => {
      if (mounted.current) setError('No se ha completado el acceso con Google. Puedes volver a intentarlo.');
    });
  };

  return <main className="desktop-auth-page" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
    <section className="dialog" style={{ position: 'relative', width: 'min(100%, 500px)', margin: 'auto' }} aria-labelledby="desktop-auth-title">
      <span className="brand" style={{ marginBottom: 28 }}><span className="brand-wordmark">inhouse <span className="brand-product">link</span></span></span>
      <span className="dialog-hero-icon"><ShieldCheck size={30} /></span>
      <span className="eyebrow">TU CUENTA, TAMBIÉN EN WINDOWS</span>
      <h1 id="desktop-auth-title" style={{ fontSize: 34, lineHeight: 1.15 }}>Conecta tu cuenta<br />con Inhouse Link.</h1>
      {!request ? <p role="alert">Esta solicitud no es válida. Abre Inhouse Link para Windows y pulsa «Entrar con Google» para iniciar el acceso.</p> : <>
        <p>Utiliza la misma cuenta de Google que en tus aplicaciones de Inhouse. Después devolveremos el acceso a la aplicación de Windows.</p>
        <div className="approval-detail"><LockKeyhole size={18} /><span>Continúa solo si acabas de iniciar este acceso desde Inhouse Link en este ordenador.</span></div>
        {account.status === 'signed-in' && account.profile ? <>
          <p><strong>{account.profile.name || account.profile.email}</strong><br />{account.profile.email}</p>
          <button className="button button-primary" onClick={() => void continueToDesktop()} disabled={sending}>
            {sending ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />}{ready ? 'Volviendo a Windows…' : 'Continuar en Windows'}<ArrowRight size={17} />
          </button>
          <button className="button button-ghost" disabled={sending} onClick={() => manager.current?.signOut()}>Usar otra cuenta</button>
        </> : <button className="button button-primary" onClick={signIn} disabled={account.status === 'loading' || sending}>
          {account.status === 'loading' ? <LoaderCircle size={18} className="spin" /> : <span aria-hidden="true">G</span>}Entrar con Google<ArrowRight size={17} />
        </button>}
        {(error || account.error) && <p role="alert">{error || account.error}</p>}
        <p className="dialog-fineprint">La solicitud caduca en cinco minutos. La transferencia se cifra para esta aplicación; la credencial de Google no se incluye en la dirección de la página.</p>
      </>}
    </section>
  </main>;
}
