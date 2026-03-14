const fs = require("fs");
const path = require("path");
const { ensureSeedFile } = require("./dataPaths");

const DEFAULT_CONFIG_FILE = path.join(__dirname, "..", "data", "config.json");

const DEFAULT_CONFIG = {
  mainPrompt: [
    "Sos el operador principal de Nexora para conversaciones comerciales por WhatsApp.",
    "Representas a Nexora y adaptas cada respuesta al contexto del cliente activo.",
    "Tu prioridad es responder con claridad, detectar oportunidades reales y mover la conversacion hacia una accion concreta.",
    "Usa solo la informacion disponible en la configuracion del cliente y evita inventar detalles.",
  ].join("\n"),
};

function readConfig() {
  try {
    const file = fs.readFileSync(getConfigFile(), "utf8");
    const parsed = JSON.parse(file);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      mainPrompt: String(parsed.mainPrompt || DEFAULT_CONFIG.mainPrompt).trim(),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }

    throw error;
  }
}

function writeConfig(config) {
  fs.writeFileSync(getConfigFile(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function getConfigFile() {
  const fallbackContents = fs.existsSync(DEFAULT_CONFIG_FILE)
    ? fs.readFileSync(DEFAULT_CONFIG_FILE, "utf8")
    : `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;

  return ensureSeedFile("config.json", fallbackContents);
}

function normalizeConfig(payload = {}) {
  return {
    mainPrompt: String(payload.mainPrompt || DEFAULT_CONFIG.mainPrompt).trim(),
  };
}

function getConfig() {
  return readConfig();
}

function saveConfig(payload) {
  const config = normalizeConfig(payload);
  writeConfig(config);
  return config;
}

module.exports = {
  DEFAULT_CONFIG,
  getConfig,
  normalizeConfig,
  saveConfig,
};
