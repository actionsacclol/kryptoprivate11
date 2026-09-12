import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ToastProvider } from './state/ToastProvider';
import { ModalProvider } from './state/ModalProvider';
import { AppStateProvider } from './state/AppStateProvider';
import { TerminalProvider } from './state/TerminalProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LiteMotion } from './components/LiteModeHost';
import { initLite } from './state/liteMode';

// Self-hosted fonts (2026-08-16). These were loaded from fonts.googleapis.com,
// which made "No telemetry" false on every launch — Google saw the IP and
// timestamp of each app start. Bundled locally, the renderer makes no
// outbound font request at all. Latin subsets only; weights are the ones the
// UI actually sets (Tailwind font-normal/medium/semibold/bold = 400–700 —
// nothing uses 300, so Spline Sans Light is not shipped).
import '@fontsource/spline-sans/latin-400.css';
import '@fontsource/spline-sans/latin-500.css';
import '@fontsource/spline-sans/latin-600.css';
import '@fontsource/spline-sans/latin-700.css';
import '@fontsource/cinzel/latin-400.css';
import '@fontsource/cinzel/latin-500.css';
import '@fontsource/cinzel/latin-600.css';
import '@fontsource/cinzel/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';

import './index.css';

// Errors that escape React entirely (event handlers, timers, un-awaited
// promises) do not reach the boundary. Log them so they show up in the
// console page rather than vanishing; never throw from here.
window.addEventListener('error', (e) => {
  // eslint-disable-next-line no-console
  console.error('[ui] uncaught', e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  // eslint-disable-next-line no-console
  console.error('[ui] unhandled rejection', e.reason);
});

// The preload exposes window.krypt before any page script runs. When it is
// missing, this window loaded while the bridge file was not readable —
// which is what a rebuild under a running unpackaged app does: the window
// reloads, the preload is mid-write, and the first `window.krypt.engine`
// read throws "Cannot read properties of undefined". The file is normally
// back within a second, so retry once quietly before saying anything, and
// never mount React without a bridge.
if (!window.krypt) {
  const root = document.getElementById('root')!;
  const KEY = 'krypt.bridgeRetryAt';
  const last = Number(sessionStorage.getItem(KEY) ?? 0);
  const retriedJustNow = Date.now() - last < 10_000;
  if (!retriedJustNow) {
    sessionStorage.setItem(KEY, String(Date.now()));
    setTimeout(() => window.location.reload(), 1_200);
  } else {
    root.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07060d;color:#e8e6f0;font-family:system-ui,sans-serif">
        <div style="max-width:34rem;padding:2rem;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(255,255,255,.03)">
          <div style="font-size:11px;letter-spacing:.36em;color:#c4b5fd">BRIDGE NOT LOADED</div>
          <h2 style="margin:.4rem 0 .6rem;font-size:18px;font-weight:600">The interface cannot reach the app</h2>
          <p style="font-size:13px;line-height:1.6;color:#b8b4c8">The preload script that connects this window to the engine did not load, so nothing on screen could talk to it. The engine itself is unaffected and still running.</p>
          <p style="font-size:13px;line-height:1.6;color:#b8b4c8">This happens when the app's files are rebuilt while it is running. Reloading usually fixes it; if it does not, restart the app.</p>
          <button id="krypt-reload" style="margin-top:1rem;padding:.55rem 1.1rem;border-radius:8px;border:0;background:#7c5cf6;color:#fff;font-size:13px;font-weight:600;cursor:pointer">Reload interface</button>
        </div>
      </div>`;
    document.getElementById('krypt-reload')?.addEventListener('click', () => {
      sessionStorage.removeItem(KEY);
      window.location.reload();
    });
  }
  throw new Error('window.krypt is missing — the preload did not load');
}
// A clean boot clears the retry mark so a later failure gets its own quiet retry.
sessionStorage.removeItem('krypt.bridgeRetryAt');

// Lite mode's class goes on <html> BEFORE React mounts, from this machine's
// mirror of the setting — a lite user should not see one animated boot per
// launch while settings are still on their way over IPC.
initLite();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <ModalProvider>
          <AppStateProvider>
            <TerminalProvider>
              <LiteMotion>
                <App />
              </LiteMotion>
            </TerminalProvider>
          </AppStateProvider>
        </ModalProvider>
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
