const fs = require("fs");
const path = require("path");

const CLIENTS_FILE = path.join(__dirname, "..", "data", "clientes.json");

function readClientes() {
  try {
    const file = fs.readFileSync(CLIENTS_FILE, "utf8");
    return JSON.parse(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function writeClientes(clientes) {
  fs.writeFileSync(CLIENTS_FILE, `${JSON.stringify(clientes, null, 2)}\n`, "utf8");
}

function normalizeCliente(payload, fallbackId) {
  const id = String(payload.id || fallbackId || "").trim();

  if (!id) {
    throw new Error("El identificador del cliente es obligatorio.");
  }

  const promptNotes = Array.isArray(payload.promptNotes)
    ? payload.promptNotes.map((note) => String(note || "").trim()).filter(Boolean)
    : [];

  const planes = Array.isArray(payload.planes)
    ? payload.planes.map((plan, index) => ({
        nombre: String(plan.nombre || `Plan ${index + 1}`).trim(),
        setup: String(plan.setup || "").trim(),
        mensual: String(plan.mensual || "").trim(),
        beneficios: Array.isArray(plan.beneficios)
          ? plan.beneficios.map((item) => String(item || "").trim()).filter(Boolean)
          : [],
      }))
    : [];

  return {
    id,
    nombre: String(payload.nombre || "Nuevo cliente").trim(),
    estado: String(payload.estado || "Activo").trim(),
    tono: String(payload.tono || "Profesional y cercano").trim(),
    assistantName: String(payload.assistantName || "Fer").trim(),
    businessName: String(payload.businessName || payload.nombre || "NEXORA").trim(),
    businessDescription: String(payload.businessDescription || "").trim(),
    leadGoal: String(payload.leadGoal || "").trim(),
    greeting: String(payload.greeting || "").trim(),
    leadEmail: String(payload.leadEmail || "").trim().toLowerCase(),
    clientPrompt: String(payload.clientPrompt || "").trim(),
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
