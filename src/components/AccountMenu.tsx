import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, LogOut, RefreshCw } from 'lucide-react';

export type AccountProfile = { id: string; name: string; email: string; photo: string };

export default function AccountMenu({ profile, onSignOut, onSwitchAccount, onHome }: {
  profile: AccountProfile;
  onSignOut: () => void;
  onSwitchAccount?: () => void;
  onHome?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  let photo = '';
  try { const url = new URL(profile.photo); if (url.protocol === 'https:' && !url.username && !url.password) photo = url.toString(); } catch { /* Initials remain available without a photograph. */ }
  const initials = (profile.name || profile.email).split(/[\s@]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();

  useEffect(() => { setPhotoFailed(false); }, [profile.photo]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keyboard); };
  }, [open]);

  const action = (callback: () => void) => { setOpen(false); callback(); };
  return <div className="account-menu" ref={container}>
    <button ref={trigger} className="account-trigger" data-testid="account-menu" aria-label={`Cuenta de ${profile.name || profile.email}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="account-avatar">{photo && !photoFailed ? <img src={photo} alt="" referrerPolicy="no-referrer" onError={() => setPhotoFailed(true)} /> : initials || 'G'}</span>
      <span className="account-trigger-name">{profile.name?.split(' ')[0] || 'Mi cuenta'}</span><ChevronDown size={13} />
    </button>
    {open && <div className="account-popover" role="menu" aria-label="Tu cuenta de Google">
      <div className="account-info"><span>CUENTA DE GOOGLE</span><strong>{profile.name || 'Mi cuenta'}</strong><p>{profile.email}</p></div>
      {onHome && <button role="menuitem" onClick={() => action(onHome)}><ArrowLeft size={15} />Ir a la web de inhouse link</button>}
      {onSwitchAccount && <button role="menuitem" data-testid="switch-google-account" onClick={() => action(onSwitchAccount)}><RefreshCw size={15} />Cambiar de cuenta</button>}
      <button role="menuitem" data-testid="account-signout" onClick={() => action(onSignOut)}><LogOut size={15} />Cerrar sesión</button>
    </div>}
  </div>;
}
