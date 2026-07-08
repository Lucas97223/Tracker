// Electron main process. Spawns the desktop window that hosts the React app.
//
// Run modes (driven by the ELECTRON_DEV env var):
//   ELECTRON_DEV=1  → load from Vite dev server at http://localhost:5174
//   (unset)         → load from ../dist/index.html (production build / packaged)

const { app, BrowserWindow, dialog, ipcMain, Menu, shell, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const db = require('./db.cjs');

const useDevServer = process.env.ELECTRON_DEV === '1';

// When packaged, our files live inside the asar archive. Resolve via __dirname
// so both unpacked and packaged builds work.
const distIndex = path.join(__dirname, '..', 'dist', 'index.html');

function createWindow() {
  if (!useDevServer && !fs.existsSync(distIndex)) {
    dialog.showErrorBox(
      'Build required',
      'The app has not been built yet. Open PowerShell in the project folder and run:\n\n    npm run build\n\nThen launch the app again.',
    );
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Expense Tracker',
    autoHideMenuBar: true,
    backgroundColor: '#f1f5f9',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // Hide the visible menu bar but keep accelerators (F12, Ctrl+R, Ctrl+Shift+I)
  // registered. Removing the menu entirely would lose those built-ins.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'View',
        visible: false,
        submenu: [
          { role: 'reload', accelerator: 'CommandOrControl+R' },
          { role: 'forceReload', accelerator: 'CommandOrControl+Shift+R' },
          { role: 'toggleDevTools', accelerator: 'F12' },
          {
            label: 'DevTools (alt)',
            accelerator: 'CommandOrControl+Shift+I',
            click: (_item, focusedWin) => focusedWin?.webContents?.toggleDevTools(),
          },
        ],
      },
      {
        label: 'App',
        visible: false,
        submenu: [
          {
            label: 'Reset local session',
            accelerator: 'CommandOrControl+Shift+L',
            click: (_item, focusedWin) => {
              focusedWin?.webContents.executeJavaScript(
                'try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}',
              );
              focusedWin?.webContents.reload();
            },
          },
          { role: 'quit', accelerator: 'CommandOrControl+Q' },
        ],
      },
    ]),
  );

  // Belt-and-braces: also intercept the key events at the webContents level so
  // shortcuts work even if the menu accelerator binding ever changes.
  win.webContents.on('before-input-event', (event, input) => {
    const key = input.key?.toLowerCase();
    if (input.type !== 'keyDown') return;
    if (key === 'f12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if (input.control && input.shift && key === 'i') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if (input.control && key === 'r' && !input.shift) {
      win.webContents.reload();
      event.preventDefault();
    } else if (input.control && input.shift && key === 'l') {
      win.webContents.executeJavaScript(
        'try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}',
      );
      win.webContents.reload();
      event.preventDefault();
    }
  });

  // External links → OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const allowed = useDevServer
      ? url.startsWith('http://localhost:5174')
      : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Surface renderer errors to the OS so the user sees something other than a
  // blank window when bundle loading fails.
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return; // ABORTED — normal during navigation
    dialog.showErrorBox(
      'Failed to load app',
      `Code ${errorCode}: ${errorDescription}\nURL: ${validatedURL}\n\nTry pressing Ctrl+Shift+L to reset the session, or reinstall the app.`,
    );
  });

  if (useDevServer) {
    win.loadURL('http://localhost:5174');
  } else {
    win.loadFile(distIndex);
  }
}

// ── IPC handlers: SQLite local DB ────────────────────────────────────────────

ipcMain.handle('db:query',            (_e, table, filters)                      => db.query(table, filters));
ipcMain.handle('db:get',              (_e, table, id)                           => db.get(table, id));
ipcMain.handle('db:upsert',           (_e, table, row)                          => db.upsert(table, row));
ipcMain.handle('db:upsert-many',      (_e, table, rows)                         => db.upsertMany(table, rows));
ipcMain.handle('db:delete',           (_e, table, id)                           => db.remove(table, id));
ipcMain.handle('db:enqueue',          (_e, table, recordId, operation, payload) => db.enqueue(table, recordId, operation, payload));
ipcMain.handle('db:get-queue',        ()                                         => db.getQueue());
ipcMain.handle('db:remove-from-queue',(_e, id)                                  => db.removeFromQueue(id));
ipcMain.handle('db:mark-queue-error', (_e, id, err)                             => db.markQueueError(id, err));
ipcMain.handle('db:get-conflicts',    ()                                         => db.getConflicts());
ipcMain.handle('db:resolve-conflict', (_e, id, resolution)                      => db.resolveConflict(id, resolution));
ipcMain.handle('db:add-conflict',     (_e, table, recordId, local, remote)      => db.addConflict(table, recordId, local, remote));
ipcMain.handle('db:get-cache',        (_e, key)                                 => db.getCache(key));
ipcMain.handle('db:set-cache',        (_e, key, data)                           => db.setCache(key, data));
ipcMain.handle('db:get-meta',         (_e, key)                                 => db.getMeta(key));
ipcMain.handle('db:set-meta',         (_e, key, value)                          => db.setMeta(key, value));

// ─────────────────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // macOS "App Nap" throttles timers in idle-but-visible windows within about
  // a minute, which stalls the Supabase JWT auto-refresh (and our own
  // AuthProvider refresh interval) long enough for the access token to
  // expire mid-session. 'prevent-app-suspension' also opts the app out of
  // App Nap for as long as the blocker is active, so we start it once at
  // launch and never stop it.
  powerSaveBlocker.start('prevent-app-suspension');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
