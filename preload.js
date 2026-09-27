const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  copyRichText: (html, text) => ipcRenderer.invoke('copy-rich', { html, text }),
  saveDoc: (filename, html) => ipcRenderer.invoke('save-doc', { filename, html }),
  saveDocx: (filename, base64) => ipcRenderer.invoke('save-docx', { filename, base64 })
});