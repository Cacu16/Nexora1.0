const fs = require("fs");
const path = require("path");

const DEFAULT_DATA_DIR = path.join(__dirname, "..", "data");

function getDataDir() {
  const customDir = String(process.env.NEXORA_DATA_DIR || "").trim();
  return customDir ? path.resolve(customDir) : DEFAULT_DATA_DIR;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureSeedFile(fileName, fallbackContents) {
  const dataDir = getDataDir();
  const targetFile = path.join(dataDir, fileName);

  ensureDir(dataDir);

  if (!fs.existsSync(targetFile)) {
    fs.writeFileSync(targetFile, fallbackContents, "utf8");
  }

  return targetFile;
}

module.exports = {
  DEFAULT_DATA_DIR,
  ensureSeedFile,
  getDataDir,
};
