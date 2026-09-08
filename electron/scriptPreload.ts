// Preload for a script sandbox window: the one door between a user's code
// and the app. It forwards messages both ways on one channel and exposes
// nothing else. Runs sandboxed (no Node), so `require` here reaches only
// Electron's contextBridge and ipcRenderer. Standalone on purpose — a
// sandboxed preload cannot import the shared code.

import { contextBridge, ipcRenderer } from 'electron';

const CHANNEL = 'script-sandbox';

contextBridge.exposeInMainWorld('__krypt_sandbox', {
  send: (msg: unknown): void => {
    ipcRenderer.send(CHANNEL, msg);
  },
  on: (cb: (msg: unknown) => void): void => {
    ipcRenderer.on(CHANNEL, (_e, msg: unknown) => cb(msg));
  },
});
