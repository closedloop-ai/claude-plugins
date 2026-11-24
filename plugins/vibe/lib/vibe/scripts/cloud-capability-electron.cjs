const { app, BrowserWindow } = require("electron");

// This fixed smoke opens only in the Xvfb display created by the probe.
const timer = setTimeout(() => app.exit(124), 15_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  await window.loadURL("about:blank");
  process.stdout.write("Electron loaded about:blank on its virtual display\n");
  clearTimeout(timer);
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  clearTimeout(timer);
  app.exit(1);
});
