// Classic worker: loads one Emscripten engine (gs or qpdf), runs it once, returns the output files.
self.onmessage = async ({ data }) => {
  const { engine, base, args, files, outputs } = data;
  const log = [];
  // some builds ignore print/printErr and write straight to the console: capture that too
  console.log = console.error = console.warn = (...a) => log.push(a.join(' '));
  try {
    importScripts(`${base}${engine}/${engine}.js`);
    const factory = self.Module || self.exports?.Module;
    const mod = await factory({
      noInitialRun: true, locateFile: (f) => `${base}${engine}/${f}`,
      print: (t) => log.push(t), printErr: (t) => log.push(t),
    });
    for (const [name, bytes] of Object.entries(files)) mod.FS.writeFile(name, bytes);
    let code;
    try { code = mod.callMain(args); } catch (e) { code = typeof e?.status === 'number' ? e.status : 1; if (typeof e?.status !== 'number') log.push(String(e?.message || e)); }
    const out = {};
    for (const n of outputs) { try { out[n] = mod.FS.readFile(n); } catch { /* not produced */ } }
    self.postMessage({ code, out, log: log.slice(-40) }, Object.values(out).map((b) => b.buffer));
  } catch (e) {
    self.postMessage({ error: String(e?.message || e), log });
  }
};
