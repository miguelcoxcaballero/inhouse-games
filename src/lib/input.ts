import type { LinkSession } from './session';

/** Maps pointer coordinates onto the video content, excluding letterboxing. */
export function videoCoordinates(video: HTMLVideoElement, clientX: number, clientY: number) {
  const rect = video.getBoundingClientRect();
  if (!video.videoWidth || !video.videoHeight || !rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  const x = (clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (clientY - rect.top - (rect.height - height) / 2) / height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

/** Only the focused video captures input; the surrounding app stays usable. */
export function attachRemoteInput(video: HTMLVideoElement, session: LinkSession): () => void {
  const down = new Set<string>();
  const buttons = new Set<number>();
  const previousTabIndex = video.tabIndex;
  video.tabIndex = 0;
  const active = () => session.state.controlEnabled && session.state.role === 'viewer'
    && (document.activeElement === video || document.pointerLockElement === video);
  const release = () => {
    session.sendInput({ kind: 'release' });
    down.clear(); buttons.clear();
  };
  const move = (event: MouseEvent) => {
    if (!active()) return;
    if (document.pointerLockElement === video) {
      session.sendInput({ kind: 'relative', dx: Math.max(-2048, Math.min(2048, event.movementX)), dy: Math.max(-2048, Math.min(2048, event.movementY)) });
    } else {
      const point = videoCoordinates(video, event.clientX, event.clientY);
      if (point) session.sendInput({ kind: 'pointer', ...point });
    }
  };
  const mouseDown = (event: MouseEvent) => {
    if (event.button > 2 || !session.state.controlEnabled) return;
    if (document.pointerLockElement !== video && !videoCoordinates(video, event.clientX, event.clientY)) return;
    video.focus({ preventScroll: true });
    event.preventDefault();
    move(event);
    buttons.add(event.button);
    session.sendInput({ kind: 'button', button: event.button, down: true });
  };
  const mouseUp = (event: MouseEvent) => {
    if (!buttons.has(event.button)) return;
    buttons.delete(event.button);
    session.sendInput({ kind: 'button', button: event.button, down: false });
  };
  const keyDown = (event: KeyboardEvent) => {
    if (!active()) return;
    // UI handles the user's configurable local shortcuts in the capture phase.
    if (event.defaultPrevented || (event.code === 'Escape' && document.pointerLockElement === video)) { release(); return; }
    event.preventDefault();
    down.add(event.code);
    session.sendInput({ kind: 'key', code: event.code, down: true });
  };
  const keyUp = (event: KeyboardEvent) => {
    if (!down.has(event.code)) return;
    event.preventDefault();
    down.delete(event.code);
    session.sendInput({ kind: 'key', code: event.code, down: false });
  };
  const wheel = (event: WheelEvent) => {
    if (!active()) return;
    event.preventDefault();
    const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? video.clientHeight : 1;
    session.sendInput({ kind: 'wheel', dx: Math.max(-1200, Math.min(1200, event.deltaX * factor)), dy: Math.max(-1200, Math.min(1200, event.deltaY * factor)) });
  };
  const contextMenu = (event: MouseEvent) => { if (active()) event.preventDefault(); };
  const pointerLock = () => {
    if (session.state.controlEnabled && video.requestPointerLock) {
      video.focus({ preventScroll: true });
      void Promise.resolve(video.requestPointerLock()).catch(() => { /* Browser may require another user gesture. */ });
    }
  };
  const lockChanged = () => { if (document.pointerLockElement !== video) release(); };
  const visibility = () => { if (document.hidden) release(); };
  video.addEventListener('mousemove', move);
  video.addEventListener('mousedown', mouseDown);
  video.addEventListener('dblclick', pointerLock);
  video.addEventListener('wheel', wheel, { passive: false });
  video.addEventListener('contextmenu', contextMenu);
  video.addEventListener('blur', release);
  window.addEventListener('mouseup', mouseUp);
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('pointerlockchange', lockChanged);
  return () => {
    release();
    if (document.pointerLockElement === video) document.exitPointerLock();
    video.tabIndex = previousTabIndex;
    video.removeEventListener('mousemove', move);
    video.removeEventListener('mousedown', mouseDown);
    video.removeEventListener('dblclick', pointerLock);
    video.removeEventListener('wheel', wheel);
    video.removeEventListener('contextmenu', contextMenu);
    video.removeEventListener('blur', release);
    window.removeEventListener('mouseup', mouseUp);
    window.removeEventListener('keydown', keyDown);
    window.removeEventListener('keyup', keyUp);
    window.removeEventListener('blur', release);
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('pointerlockchange', lockChanged);
  };
}
