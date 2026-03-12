const path = require("path");
const http = require("http");
const { app, BrowserWindow, shell } = require("electron");
const { startServer } = require("../server");

const isDev = Boolean(process.env.ELECTRON_START_URL);
const serverPort = Number(process.env.PORT || (isDev ? 3000 : 3210));
const appUrl = isDev ? process.env.ELECTRON_START_URL : `http://localhost:${serverPort}`;

let mainWindow = null;
let startedServer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    autoHideMenuBar: true,
    backgroundColor: "#07111f",
    title: "Nexora",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow.loadURL(appUrl);
}

function startServerIfNeeded() {
  if (isDev || startedServer) {
    return;
  }

  startedServer = startServer(serverPort);
}

async function boot() {
  startServerIfNeeded();

  await waitForApp(appUrl, 30000);

  await createWindow();
}

function waitForApp(url, timeoutMs) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    function tryConnect() {
      const request = http.get(url, (response) => {
        response.resume();

        if (response.statusCode && response.statusCode < 500) {
          resolve();
          return;
        }

        scheduleRetry();
      });

      request.on("error", scheduleRetry);
      request.setTimeout(2000, () => {
        request.destroy();
        scheduleRetry();
      });
    }

    function scheduleRetry() {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timeout esperando a ${url}`));
        return;
      }

      setTimeout(tryConnect, 400);
    }

    tryConnect();
  });
}

app.whenReady().then(boot).catch((error) => {
  console.error("No se pudo iniciar Nexora Desktop:", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    boot().catch((error) => {
      console.error("No se pudo reabrir Nexora Desktop:", error);
    });
  }
});

app.on("before-quit", () => {
  if (startedServer) {
    startedServer.close();
    startedServer = null;
  }
});
