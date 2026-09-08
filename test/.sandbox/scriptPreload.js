"use strict";

// electron/scriptPreload.ts
var import_electron = require("electron");
var CHANNEL = "script-sandbox";
import_electron.contextBridge.exposeInMainWorld("__krypt_sandbox", {
  send: (msg) => {
    import_electron.ipcRenderer.send(CHANNEL, msg);
  },
  on: (cb) => {
    import_electron.ipcRenderer.on(CHANNEL, (_e, msg) => cb(msg));
  }
});
