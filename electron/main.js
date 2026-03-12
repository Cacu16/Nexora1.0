const path = require("path");
const http = require("http");
const fs = require("fs");
const { app, BrowserWindow, dialog, shell } = require("electron");

const isDev = Boolean(process.env.ELECTRON_START_URL);
const serverPort = Number(process.env.PORT || (isDev ? 3000 : 3210));
const appUrl = isDev ? process.env.ELECTRON_START_URL : `http://localhost:${serverPort}`;

let mainWindow = null;
let startedServer = null;
let logFile = null;

function writeLog(message, error) {
  try {
    if (!logFile) {
      return;
    }

    const lines = [`[${new Date().toISOString()}] ${message}`];

    if (error) {
      lines.push(error.stack || String(error));
    }

    fs.appendFileSync(logFile, `${lines.join("\n")}\n`, "utf8");
  } catch {}
}

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

  const { startServer } = require("../server");
  startedServer = startServer(serverPort);
  writeLog(`Servidor desktop iniciado en ${serverPort}`);
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
  writeLog("No se pudo iniciar Nexora Desktop", error);
  dialog.showErrorBox(
    "Nexora",
    `No se pudo iniciar Nexora Desktop.\n\n${error?.message || error}\n\nLog: ${logFile || "no disponible"}`
  );
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
      writeLog("No se pudo reabrir Nexora Desktop", error);
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

process.on("uncaughtException", (error) => {
  writeLog("Excepcion no capturada en main process", error);
});

process.on("unhandledRejection", (error) => {
  writeLog("Promesa rechazada en main process", error);
});

app.on("ready", () => {
  logFile = path.join(app.getPath("userData"), "nexora-desktop.log");
  writeLog("App Electron ready");
});
