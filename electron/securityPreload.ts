// The security window's preload: three calls, nothing else. Built as its own
// entry so that window never loads the main preload and its whole app API.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kryptSecurity', {
  view: () => ipcRenderer.invoke('securityPrompt:view'),
  act: (action: string, values: Record<string, string>) => ipcRenderer.invoke('securityPrompt:act', action, values),
  resize: (height: number) => ipcRenderer.invoke('securityPrompt:resize', height),
});
