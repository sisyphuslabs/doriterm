// A bare window for app-region.e2e.ts: no app, no preload, so the helper is read against a page the spec writes.
const { app, BrowserWindow } = require("electron");

void (async () => {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 800, height: 600 });
  await window.loadURL("about:blank");
})();
app.on("window-all-closed", () => app.quit());
