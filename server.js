require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const nodemailer = require("nodemailer");
const OpenAI = require("openai");
const { google } = require("googleapis");
const { Resend } = require("resend");
const {
  getCliente,
  listClientes,
  normalizeCliente,
  removeCliente,
  saveCliente,
} = require("./lib/clientStore");
const { getConfig, saveConfig } = require("./lib/configStore");
const { getDataDir } = require("./lib/dataPaths");

const app = express();
let serverInstance = null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const smtpTransport = createEmailTransport();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const clientRuntime = new Map();

const DEFAULT_VERIFY_TOKEN = "nexora_2026_secure";
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DEFAULT_LEAD_EMAIL = "contactonexora16@gmail.com";
const DIST_DIR = path.join(__dirname, "dist");
const DIST_INDEX = path.join(DIST_DIR, "index.html");
let sheets = null;
const openaiClients = new Map();

function createEmailTransport() {
  const smtpHost = String(process.env.SMTP_HOST || "").trim();
  const smtpUser = String(process.env.SMTP_USER || "").trim();
  const smtpPass = String(process.env.SMTP_PASS || "").trim();
  const gmailUser = String(process.env.GMAIL_USER || "").trim();
  const gmailAppPassword = String(process.env.GMAIL_APP_PASSWORD || "").trim();

  if (smtpHost && smtpUser && smtpPass) {
    return nodemailer.createTransport({
      host: smtpHost,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || "").trim().toLowerCase() === "true",
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });
  }

  if (gmailUser && gmailAppPassword) {
    return nodemailer.createTransport({
      service: "gmail",
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      auth: {
        user: gmailUser,
        pass: gmailAppPassword,
      },
    });
  }

  return null;
}

function appendJsonl(fileName, payload) {
  const targetFile = path.join(getDataDir(), fileName);
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.appendFileSync(targetFile, `${JSON.stringify(payload)}\n`, "utf8");
}

function logWebhookEvent(payload) {
  const summary = [
    payload.type || "event",
    payload.clientId || "sin-cliente",
    payload.phoneNumberId || "sin-phone-id",
    payload.from || "sin-from",
  ].join(" | ");

  console.log(`[webhook] ${summary}`);

  if (payload.message) {
    console.log(`[webhook-detail] ${payload.message}`);
  }

  appendJsonl("webhook-events.jsonl", {
    timestamp: new Date().toISOString(),
    ...payload,
  });
}

function persistLeadEvent(payload) {
  appendJsonl("lead-events.jsonl", {
    timestamp: new Date().toISOString(),
    ...payload,
  });
}

if (SPREADSHEET_ID) {
  const auth = new google.auth.GoogleAuth({
    keyFile: "google-credentials.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheets = google.sheets({ version: "v4", auth });
}

function buildPlanesText(cliente) {
  if (!Array.isArray(cliente.planes) || !cliente.planes.length) {
    return "Sin planes cargados";
  }

  return cliente.planes
    .map((plan) => {
      const beneficios = Array.isArray(plan.beneficios) && plan.beneficios.length
        ? plan.beneficios.map((beneficio) => `- ${beneficio}`).join("\n")
        : "- Sin beneficios definidos";

      return [
        `${String(plan.nombre || "Plan").toUpperCase()}:`,
        beneficios,
        `Precio setup: ${plan.setup || "Sin definir"}`,
        `Precio mensual: ${plan.mensual || "Sin definir"}`,
      ].join("\n");
    })
    .join("\n\n");
}

function buildClientMainPrompt(basePrompt, cliente) {
  const businessName = String(cliente?.businessName || cliente?.nombre || "Cliente").trim();
  return String(basePrompt || "").replace(/\bNexora\b/gi, businessName).trim();
}

function buildSystemPrompt(cliente, config) {
  const promptNotes = Array.isArray(cliente.promptNotes) && cliente.promptNotes.length
    ? cliente.promptNotes.map((note) => `- ${note}`).join("\n")
    : "- Responde de forma clara, breve y natural.";

  const globalPrompt = String(config?.mainPrompt || "").trim();
  const effectiveMainPrompt = String(
    cliente?.mainPromptOverride || buildClientMainPrompt(globalPrompt, cliente)
  ).trim();
  const clientPrompt = String(cliente.clientPrompt || "").trim();

  return `
PROMPT PRINCIPAL NEXORA:
${effectiveMainPrompt || "Sos el operador principal de Nexora."}

CONTEXTO DEL CLIENTE:
Tu nombre es ${cliente.assistantName || "Fer"}.
Sos ${cliente.assistantName || "Fer"}, el asistente oficial de ${cliente.businessName || cliente.nombre}.
Siempre te presentas como ${cliente.assistantName || "Fer"} cuando hablas con un cliente.

Nunca digas que sos una IA.
Nunca digas que sos un asistente generico.

Tu funcion es ayudar a personas interesadas en ${cliente.businessDescription || "los servicios del negocio"}.

Objetivo principal:
${cliente.leadGoal || "Ayudar al usuario, responder dudas y detectar oportunidades comerciales."}

Mensaje base de presentacion si preguntan quien sos:
${cliente.greeting || `Soy ${cliente.assistantName || "Fer"}, asistente de ${cliente.businessName || cliente.nombre}.`}

Reglas adicionales:
${promptNotes}

Tono:
${cliente.tono || "Claro y natural"}

PROMPT ESPECIFICO DEL CLIENTE:
${clientPrompt || "Sin instrucciones extra para este cliente."}

IMPORTANTE:
Responde SOLO con JSON valido.
No agregues texto antes ni despues del JSON.
No escribas la palabra json ni explicaciones extra.
Nunca menciones cuentas bancarias, alias, CBU, CVU, links de pago, confirmacion de pedido,
entrega, retiro o stock confirmado si esa informacion no esta escrita en la configuracion del cliente.
Si el catalogo del cliente esta cargado en "Planes disponibles", tomalo como catalogo cerrado:
no inventes productos, marcas, variedades, presentaciones ni precios fuera de esa lista.

Formato obligatorio:
{
  "mensaje": "respuesta al usuario",
  "lead_calificado": false,
  "nombre": null,
  "telefono": null,
  "interes": null,
  "presupuesto": null
}

Si el usuario muestra intencion clara de contratar:
lead_calificado = true

Planes disponibles:
${buildPlanesText(cliente)}
`.trim();
}

function normalizeLeadSignalText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function looksLikeQualifiedLead(userMessage, parsedData, assistantMessage) {
  const userText = normalizeLeadSignalText(userMessage);
  const assistantText = normalizeLeadSignalText(assistantMessage);
  const combinedText = `${userText} ${assistantText}`;
  const purchaseSignals = [
    "quiero comprar",
    "quiero pedir",
    "quiero una",
    "quiero dos",
    "me interesa",
    "cuanto sale",
    "como pago",
    "quiero pagar",
    "quiero reservar",
    "quiero encargar",
    "quiero llevar",
    "te compro",
    "quiero el",
    "quiero la",
  ];
  const closingSignals = [
    "nombre",
    "telefono",
    "contacto",
    "pago",
    "transferencia",
    "pedido",
    "reserva",
    "entrega",
    "retiro",
    "direccion",
  ];
  const hasStructuredLeadData = Boolean(
    parsedData?.nombre || parsedData?.telefono || parsedData?.interes || parsedData?.presupuesto
  );

  return (
    hasStructuredLeadData ||
    (purchaseSignals.some((signal) => userText.includes(signal)) &&
      closingSignals.some((signal) => combinedText.includes(signal)))
  );
}

function buildQualifiedLeadReply(cliente, parsedData) {
  const assistantName = String(cliente?.assistantName || "Fer").trim();
  const customerName = String(parsedData?.nombre || "").trim();
  const greetingTarget = customerName ? ` ${customerName}` : "";

  return `${assistantName}: perfecto${greetingTarget}. Ya agende tus datos y en breve te contactamos para seguir.`;
}

function resolveVerifyToken(config = getConfig()) {
  return String(
    process.env.WEBHOOK_VERIFY_TOKEN || config?.webhookVerifyToken || DEFAULT_VERIFY_TOKEN
  ).trim();
}

function resolveOpenAIApiKey(config = getConfig()) {
  return String(process.env.OPENAI_API_KEY || config?.openaiApiKey || "").trim();
}

function resolveWhatsappToken(config = getConfig()) {
  return String(process.env.WHATSAPP_TOKEN || config?.whatsappToken || "").trim();
}

function resolveClientOpenAIApiKey(cliente, config = getConfig()) {
  return String(cliente?.openaiApiKey || resolveOpenAIApiKey(config) || "").trim();
}

function resolveClientWhatsappToken(cliente, config = getConfig()) {
  return String(cliente?.whatsappToken || resolveWhatsappToken(config) || "").trim();
}

function isValidPhoneNumberId(value) {
  return /^\d+$/.test(String(value || "").trim());
}

function getClientRuntimeState(clienteId) {
  if (!clientRuntime.has(clienteId)) {
    clientRuntime.set(clienteId, {
      historialPorContacto: new Map(),
      mensajesProcesados: new Set(),
      leadsEnviados: new Set(),
    });
  }

  return clientRuntime.get(clienteId);
}

function moveClientRuntimeState(previousId, nextId) {
  if (!previousId || !nextId || previousId === nextId || !clientRuntime.has(previousId)) {
    return;
  }

  const previousState = clientRuntime.get(previousId);

  if (!clientRuntime.has(nextId)) {
    clientRuntime.set(nextId, previousState);
  }

  clientRuntime.delete(previousId);
}

function clearClientRuntimeState(clienteId) {
  if (!clienteId) {
    return;
  }

  clientRuntime.delete(clienteId);
}

function getConversationHistory(runtimeState, contactId) {
  if (!runtimeState.historialPorContacto.has(contactId)) {
    runtimeState.historialPorContacto.set(contactId, []);
  }

  return runtimeState.historialPorContacto.get(contactId);
}

function buildClientStatus(cliente, config = getConfig()) {
  const phoneNumberId = String(cliente?.id || "").trim();
  const phoneNumberIdConfigured = isValidPhoneNumberId(phoneNumberId);
  const openaiConfigured = Boolean(resolveClientOpenAIApiKey(cliente, config));
  const whatsappConfigured = Boolean(resolveClientWhatsappToken(cliente, config));
  const leadEmailConfigured = Boolean(String(cliente?.leadEmail || DEFAULT_LEAD_EMAIL).trim());

  return {
    phoneNumberId,
    phoneNumberIdConfigured,
    openaiConfigured,
    whatsappConfigured,
    leadEmailConfigured,
    ready: phoneNumberIdConfigured && openaiConfigured && whatsappConfigured,
  };
}

function serializeCliente(cliente, config = getConfig()) {
  return {
    ...cliente,
    runtime: buildClientStatus(cliente, config),
  };
}

function getOpenAIClient(apiKey) {
  if (!apiKey) {
    return null;
  }

  if (!openaiClients.has(apiKey)) {
    openaiClients.set(
      apiKey,
      new OpenAI({
        apiKey,
      })
    );
  }

  return openaiClients.get(apiKey);
}

function getRuntimeStatus(config = getConfig()) {
  const anyClientOpenAIConfigured = listClientes().some((cliente) =>
    Boolean(String(cliente?.openaiApiKey || "").trim())
  );
  const anyClientWhatsappConfigured = listClientes().some((cliente) =>
    Boolean(String(cliente?.whatsappToken || "").trim())
  );

  return {
    openaiConfigured: Boolean(resolveOpenAIApiKey(config)) || anyClientOpenAIConfigured,
    whatsappConfigured: Boolean(resolveWhatsappToken(config)) || anyClientWhatsappConfigured,
    spreadsheetConfigured: Boolean(SPREADSHEET_ID),
    resendConfigured: Boolean(resend),
    smtpConfigured: Boolean(smtpTransport),
    emailProviderConfigured: Boolean(resend || smtpTransport),
    webhookVerifyTokenConfigured: Boolean(resolveVerifyToken(config)),
  };
}

async function guardarLead(nombre, telefono, rubro, interes) {
  if (!sheets || !SPREADSHEET_ID) {
    console.log("Sheets no configurado, se omite guardado");
    return;
  }

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "A:E",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[new Date().toLocaleString(), nombre, telefono, rubro, interes]],
      },
    });

    console.log("Lead guardado en Sheets");
  } catch (error) {
    console.error("Error guardando lead en Sheets:", error.response?.data || error.message || error);
  }
}

async function enviarEmailLead(cliente, to, nombre, telefono, interes, presupuesto) {
  const businessLabel = cliente?.businessName || cliente?.nombre || "NEXORA";
  const smtpFrom =
    String(process.env.SMTP_FROM || "").trim() ||
    String(process.env.GMAIL_USER || "").trim() ||
    "contactonexora16@gmail.com";

  if (!resend && !smtpTransport) {
    console.log("No hay proveedor de email configurado, se omite envio de email");
    return false;
  }

  try {
    const subject = `Nuevo lead - ${businessLabel}`;
    const text = `
Cliente: ${businessLabel}
Nombre: ${nombre || "No informado"}
Telefono: ${telefono || "No informado"}
Interes: ${interes || "No especificado"}
Presupuesto: ${presupuesto || "No informado"}
`;

    if (smtpTransport) {
      await smtpTransport.sendMail({
        from: `NEXORA <${smtpFrom}>`,
        to,
        subject,
        text,
      });
    } else {
      await resend.emails.send({
        from: "NEXORA <onboarding@resend.dev>",
        to: [to],
        subject,
        text,
      });
    }

    console.log("Lead enviado por email");
    return true;
  } catch (error) {
    console.error("Error enviando email:", error.response?.data || error.message || error);
    return false;
  }
}

async function responderWhatsapp(phoneNumberId, to, body, whatsappToken) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${whatsappToken}`,
        "Content-Type": "application/json",
      },
    }
  );
}

async function processQualifiedLead(cliente, runtimeState, leadKey, from, data) {
  runtimeState.leadsEnviados.add(leadKey);
  const leadEmail = cliente.leadEmail || DEFAULT_LEAD_EMAIL;

  persistLeadEvent({
    clientId: cliente.id,
    businessName: cliente.businessName || cliente.nombre || "NEXORA",
    toEmail: leadEmail,
    from,
    nombre: data.nombre || "No informado",
    interes: data.interes || "Interesado",
    presupuesto: data.presupuesto || "No informado",
  });

  await guardarLead(
    data.nombre || "No informado",
    from,
    cliente.nombre || "Pendiente",
    data.interes || "Interesado"
  );

  await enviarEmailLead(
    cliente,
    leadEmail,
    data.nombre || "No informado",
    from,
    data.interes || "Interesado",
    data.presupuesto || "No informado"
  );
}

app.get("/api/health", (req, res) => {
  const config = getConfig();
  const clientes = listClientes();

  res.json({
    ok: true,
    message: "Servidor NEXORA funcionando",
    checks: getRuntimeStatus(config),
    clients: clientes.map((cliente) => ({
      id: cliente.id,
      nombre: cliente.nombre,
      runtime: buildClientStatus(cliente, config),
    })),
  });
});

app.get("/api/clientes", (req, res) => {
  const config = getConfig();

  res.json({
    clientes: listClientes().map((cliente) => serializeCliente(cliente, config)),
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    config: getConfig(),
  });
});

app.get("/api/clientes/:id", (req, res) => {
  const cliente = getCliente(req.params.id);
  const config = getConfig();

  if (!cliente) {
    return res.status(404).json({ error: "Cliente no encontrado" });
  }

  return res.json({ cliente: serializeCliente(cliente, config) });
});

app.post("/api/clientes", (req, res) => {
  try {
    const cliente = saveCliente(req.body);
    return res.status(201).json({ cliente: serializeCliente(cliente) });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put("/api/config", (req, res) => {
  try {
    const config = saveConfig(req.body);
    return res.json({ config });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put("/api/clientes/:id", (req, res) => {
  try {
    const existing = getCliente(req.params.id);

    if (!existing) {
      return res.status(404).json({ error: "Cliente no encontrado" });
    }

    const payload = normalizeCliente(req.body, req.params.id);
    const previousId = existing.id;
    const cliente = saveCliente(payload, req.params.id);

    moveClientRuntimeState(previousId, cliente.id);

    return res.json({ cliente: serializeCliente(cliente) });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete("/api/clientes/:id", (req, res) => {
  const deleted = removeCliente(req.params.id);

  if (!deleted) {
    return res.status(404).json({ error: "Cliente no encontrado" });
  }

  clearClientRuntimeState(req.params.id);

  return res.status(204).send();
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const verifyToken = resolveVerifyToken();

  if (mode === "subscribe" && token === verifyToken) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

async function processWebhookMessage(config, value, messageData) {
  const messageId = messageData.id;

  if (!messageData?.text?.body) {
    return;
  }

  const from = messageData.from;
  const mensaje = messageData.text.body;
  const phoneNumberId = value?.metadata?.phone_number_id;
  const cliente = getCliente(phoneNumberId);

  logWebhookEvent({
    type: "incoming",
    phoneNumberId,
    clientId: cliente?.id || null,
    from,
    messageId,
    text: mensaje,
  });

  if (!cliente) {
    console.log("Cliente no configurado para phoneNumberId:", phoneNumberId);
    return;
  }

  const runtimeState = getClientRuntimeState(cliente.id);
  const processedMessageKey = `${cliente.id}:${messageId}`;

  if (runtimeState.mensajesProcesados.has(processedMessageKey)) {
    console.log("Mensaje duplicado ignorado:", messageId);
    return;
  }

  runtimeState.mensajesProcesados.add(processedMessageKey);

  const openaiApiKey = resolveClientOpenAIApiKey(cliente, config);
  const whatsappToken = resolveClientWhatsappToken(cliente, config);
  const openai = getOpenAIClient(openaiApiKey);

  if (!openai) {
    throw new Error(`OpenAI no configurado para cliente ${cliente.id}`);
  }

  if (!whatsappToken) {
    throw new Error(`WhatsApp no configurado para cliente ${cliente.id}`);
  }

  const historial = getConversationHistory(runtimeState, from);
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: buildSystemPrompt(cliente, config),
      },
      ...historial,
      { role: "user", content: mensaje },
    ],
  });

  const respuestaCruda = response.choices[0]?.message?.content || "";
  let data = {
    mensaje: respuestaCruda,
    lead_calificado: false,
    nombre: null,
    telefono: null,
    interes: null,
    presupuesto: null,
  };

  try {
    data = JSON.parse(respuestaCruda);
  } catch {
    const match = respuestaCruda.match(/\{[\s\S]*\}/);

    if (match) {
      try {
        const jsonExtraido = JSON.parse(match[0]);

        data = {
          mensaje:
            jsonExtraido.mensaje ||
            respuestaCruda.replace(match[0], "").trim() ||
            "Perfecto, contame un poco mas y te ayudo.",
          lead_calificado: Boolean(jsonExtraido.lead_calificado),
          nombre: jsonExtraido.nombre || null,
          telefono: jsonExtraido.telefono || null,
          interes: jsonExtraido.interes || null,
          presupuesto: jsonExtraido.presupuesto || null,
        };
      } catch {
        data = {
          mensaje:
            respuestaCruda.replace(/\{[\s\S]*\}/, "").trim() ||
            "Perfecto, contame un poco mas y te ayudo.",
          lead_calificado: false,
          nombre: null,
          telefono: null,
          interes: null,
          presupuesto: null,
        };
      }
    }
  }

  data.lead_calificado =
    Boolean(data.lead_calificado) ||
    looksLikeQualifiedLead(mensaje, data, data.mensaje || "Perfecto, contame un poco mas y te ayudo.");
  const mensajeFinal = data.lead_calificado
    ? buildQualifiedLeadReply(cliente, data)
    : data.mensaje || "Perfecto, contame un poco mas y te ayudo.";
  const leadKey = `${cliente.id}:${from}`;

  historial.push({ role: "user", content: mensaje });
  historial.push({ role: "assistant", content: mensajeFinal });

  if (historial.length > 6) {
    runtimeState.historialPorContacto.set(from, historial.slice(-6));
  }

  await responderWhatsapp(phoneNumberId, from, mensajeFinal, whatsappToken);

  logWebhookEvent({
    type: "outgoing",
    phoneNumberId,
    clientId: cliente.id,
    from,
    messageId,
    text: mensajeFinal,
  });

  if (data.lead_calificado && !runtimeState.leadsEnviados.has(leadKey)) {
    processQualifiedLead(cliente, runtimeState, leadKey, from, data).catch((error) => {
      console.error("Error procesando lead:", error.response?.data || error.message || error);
    });
  }
}

app.post("/webhook", async (req, res) => {
  try {
    const config = getConfig();
    const body = req.body;

    if (!Array.isArray(body?.entry) || !body.entry.length) {
      return res.sendStatus(200);
    }

    for (const entry of body.entry) {
      for (const change of entry?.changes || []) {
        const value = change?.value;

        for (const messageData of value?.messages || []) {
          await processWebhookMessage(config, value, messageData);
        }
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    logWebhookEvent({
      type: "error",
      message: error.response?.data || error.message || String(error),
    });
    console.error("Error webhook:", error.response?.data || error.message || error);
    return res.sendStatus(500);
  }
});

if (fs.existsSync(DIST_INDEX)) {
  app.use(express.static(DIST_DIR));

  app.use((req, res, next) => {
    if (
      req.method !== "GET" ||
      req.path.startsWith("/api") ||
      req.path.startsWith("/webhook")
    ) {
      return next();
    }

    return res.sendFile(DIST_INDEX);
  });
}

function startServer(port = process.env.PORT || 3000) {
  if (serverInstance) {
    return serverInstance;
  }

  serverInstance = app.listen(port, () => {
    console.log(`Servidor corriendo en puerto ${port}`);
  });

  return serverInstance;
}

module.exports = {
  app,
  startServer,
};

if (require.main === module) {
  startServer();
}
