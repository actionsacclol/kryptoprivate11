// `electron` stand-in for booting the whole SniperEngine in node.
//
// Extends the wallet stub with the three surfaces the script sandbox pulls
// in (BrowserWindow / ipcMain / session). They are inert: this harness never
// runs a user script, it drives the engine's feed and order paths.
export { app, safeStorage } from './electronstub.mjs';
import { app, safeStorage } from './electronstub.mjs';

export class BrowserWindow {
  constructor() {
    this.webContents = { id: 0, send: () => {}, on: () => {}, setWindowOpenHandler: () => {} };
  }
  loadURL() { return Promise.resolve(); }
  destroy() {}
  isDestroyed() { return false; }
  on() {}
}

export const ipcMain = { handle: () => {}, on: () => {}, removeHandler: () => {} };
const fakeSession = {
  setPermissionRequestHandler: () => {},
  setPermissionCheckHandler: () => {},
  webRequest: { onBeforeRequest: () => {}, onBeforeSendHeaders: () => {} },
  setWebRTCIPHandlingPolicy: () => {},
  setProxy: () => Promise.resolve(),
  setCertificateVerifyProc: () => {},
  resolveProxy: () => Promise.resolve('DIRECT'),
};
export const session = { fromPartition: () => fakeSession, defaultSession: fakeSession };

export default { app, safeStorage, BrowserWindow, ipcMain, session };
