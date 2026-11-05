// The only bridge from the page to the machine: run gs/qpdf on given bytes, or convert an Office file.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdfheroNative', {
  has: ipcRenderer.sendSync('has'),
  run: (engine, args, files, outputs) => ipcRenderer.invoke('run', engine, args, files, outputs),
  office: (bytes, ext) => ipcRenderer.invoke('office', bytes, ext),
});
