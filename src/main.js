'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, screen, shell, Notification } = require('electron');
const { TokenWatcher, PROJECTS_DIR } = require('./watcher');
const config = require('./config');
const { AlertTracker, status } = require('./alerts');

let win = null;
const watcher = new TokenWatcher();
const tracker = new AlertTracker();

// No Windows o .ico carrega todos os tamanhos de uma vez, então a barra de
// tarefas e o Alt+Tab pegam a versão certa sem reescalar.
const ICON = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 400,
    height: 640,
    x: width - 420,
    y: 40,
    icon: ICON,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.on('closed', () => {
    win = null;
  });
}

function fmtValue(v, unit) {
  if (unit === 'usd') return '$' + v.toFixed(2);
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v));
}

function notify(alert) {
  const cfg = config.get();
  if (!cfg.notify || !Notification.isSupported()) return;
  const over = alert.level === 'over';
  new Notification({
    icon: ICON,
    title: over ? '⚠️ Limite estourado' : '⏳ Perto do limite',
    body: `${alert.label}: ${fmtValue(alert.value, alert.unit)} de ${fmtValue(alert.limit, alert.unit)}`,
    urgency: over ? 'critical' : 'normal',
    silent: !cfg.sound,
  }).show();
}

function send(snapshot) {
  const cfg = config.get();
  const alerts = tracker.check(snapshot, cfg);
  for (const a of alerts) {
    if (a.level !== 'ok') notify(a);
  }
  const payload = { ...snapshot, config: cfg, alerts: status(snapshot, cfg), fired: alerts };
  if (win && !win.isDestroyed()) {
    win.webContents.send('tokens:update', payload);
    // Traz a janela pra frente quando um limite estoura de fato.
    if (alerts.some((a) => a.level === 'over')) {
      win.showInactive();
      win.flashFrame(true);
    }
  }
  return payload;
}

app.whenReady().then(async () => {
  config.init(app.getPath('userData'));
  app.setAppUserModelId('com.tokenmonitor.app');
  createWindow();

  watcher.on('update', send);
  watcher.on('error', (err) => console.error('[watcher]', err.message));

  ipcMain.handle('tokens:snapshot', () => {
    const s = watcher.snapshot();
    const cfg = config.get();
    return { ...s, config: cfg, alerts: status(s, cfg), fired: [] };
  });
  ipcMain.handle('config:get', () => config.get());
  ipcMain.handle('config:set', (_e, patch) => {
    const cfg = config.set(patch);
    // Rearma para os novos limites valerem imediatamente.
    tracker.reset();
    send(watcher.snapshot());
    return cfg;
  });
  ipcMain.on('window:close', () => win && win.close());
  ipcMain.on('window:minimize', () => win && win.minimize());
  ipcMain.on('window:pin', (_e, pinned) => {
    if (win) win.setAlwaysOnTop(!!pinned, 'floating');
  });
  ipcMain.on('window:flash-off', () => win && win.flashFrame(false));
  ipcMain.on('open:projects', () => shell.openPath(PROJECTS_DIR));

  await watcher.start();
  send(watcher.snapshot());
});

app.on('window-all-closed', () => {
  watcher.stop();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
