const fs = require("fs");
const path = require("path");

async function ensureElectronExe(context) {
  if (process.platform !== "win32") {
    return;
  }

  const appOutDir = context?.appOutDir;

  if (!appOutDir) {
    return;
  }

  const targetExe = path.join(appOutDir, "electron.exe");

  if (fs.existsSync(targetExe)) {
    return;
  }

  const sourceExe = path.join(context.packager.projectDir, "node_modules", "electron", "dist", "electron.exe");

  if (!fs.existsSync(sourceExe)) {
    throw new Error(`No se encontro electron.exe en ${sourceExe}`);
  }

  fs.copyFileSync(sourceExe, targetExe);
}

exports.default = ensureElectronExe;
