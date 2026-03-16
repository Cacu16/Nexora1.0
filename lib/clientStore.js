const fs = require("fs");
const path = require("path");
const { ensureSeedFile } = require("./dataPaths");
const { normalizeDeep, normalizeText, stripBom } = require("./textUtils");
const { assertValidClientWhatsappToken } = require("./tokenValidation");

const DEFAULT_CLIENTS_FILE = path.join(__dirname, "..", "data", "clientes.json");

function getClientsFile() {
  const fallbackContents = fs.existsSync(DEFAULT_CLIENTS_FILE)
    ? fs.readFileSync(DEFAULT_CLIENTS_FILE, "utf8")
    : "{}\n";

  return ensureSeedFile("clientes.json", fallbackContents);
}

function readClientes() {
  try {
    const file = stripBom(fs.readFileSync(getClientsFile(), "utf8"));
    const parsed = JSON.parse(file);
    const normalized = normalizeDeep(parsed);

    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      writeClientes(normalized);
    }

    return normalized;
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function writeClientes(clientes) {
  fs.writeFileSync(getClientsFile(), `${JSON.stringify(clientes, null, 2)}\n`, "utf8");
}

function normalizeCliente(payload, fallbackId) {
  const normalizedPayload = normalizeDeep(payload);
  const id = String(normalizedPayload.id || fallbackId || "").trim();
  const whatsappToken = assertValidClientWhatsappToken(normalizedPayload.whatsappToken);

  if (!id) {
    throw new Error("El identificador del cliente es obligatorio.");
  }

  const promptNotes = Array.isArray(normalizedPayload.promptNotes)
    ? normalizedPayload.promptNotes.map((note) => normalizeText(note).trim()).filter(Boolean)
    : [];

  const planes = Array.isArray(normalizedPayload.planes)
    ? normalizedPayload.planes.map((plan, index) => ({
        nombre: normalizeText(plan.nombre || `Plan ${index + 1}`).trim(),
        setup: normalizeText(plan.setup || "").trim(),
        mensual: normalizeText(plan.mensual || "").trim(),
        beneficios: Array.isArray(plan.beneficios)
          ? plan.beneficios.map((item) => normalizeText(item).trim()).filter(Boolean)
          : [],
      }))
    : [];

  return {
    id,
    nombre: normalizeText(normalizedPayload.nombre || "Nuevo cliente").trim(),
    estado: normalizeText(normalizedPayload.estado || "Activo").trim(),
    tono: normalizeText(normalizedPayload.tono || "Profesional y cercano").trim(),
    assistantName: normalizeText(normalizedPayload.assistantName || "Fer").trim(),
    businessName: normalizeText(
      normalizedPayload.businessName || normalizedPayload.nombre || "NEXORA"
    ).trim(),
    businessDescription: normalizeText(normalizedPayload.businessDescription || "").trim(),
    leadGoal: normalizeText(normalizedPayload.leadGoal || "").trim(),
    greeting: normalizeText(normalizedPayload.greeting || "").trim(),
    leadEmail: String(normalizedPayload.leadEmail || "").trim().toLowerCase(),
    openaiApiKey: String(normalizedPayload.openaiApiKey || "").trim(),
    whatsappToken,
    mainPromptOverride: normalizeText(normalizedPayload.mainPromptOverride || "").trim(),
    clientPrompt: normalizeText(normalizedPayload.clientPrompt || "").trim(),
    promptNotes,
    planes,
  };
}

function listClientes() {
  return Object.values(readClientes());
}

function getCliente(id) {
  const clientes = readClientes();
  return clientes[id] || null;
}

function saveCliente(payload, fallbackId) {
  const clientes = readClientes();
  const cliente = normalizeCliente(payload, fallbackId);
  const previousId = String(fallbackId || "").trim();
  const currentOwnerId = clientes[cliente.id]?.id || null;

  if (currentOwnerId && currentOwnerId !== previousId) {
    throw new Error(
      "Ya existe un cliente con ese Phone Number ID. Cada cliente debe tener uno distinto."
    );
  }

  if (previousId && previousId !== cliente.id && clientes[previousId]) {
    delete clientes[previousId];
  }

  clientes[cliente.id] = cliente;
  writeClientes(clientes);

  return cliente;
}

function removeCliente(id) {
  const clientes = readClientes();

  if (!clientes[id]) {
    return false;
  }

  delete clientes[id];
  writeClientes(clientes);
  return true;
}

module.exports = {
  listClientes,
  getCliente,
  saveCliente,
  removeCliente,
  normalizeCliente,
};
