require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
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

const app = express();
let serverInstance = null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const historial = {};
const mensajesProcesados = new Set();
const leadsEnviados = new Set();

const DEFAULT_VERIFY_TOKEN = "nexora_2026_secure";
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DEFAULT_LEAD_EMAIL = "contactonexora16@gmail.com";
const DIST_DIR = path.join(__dirname, "dist");
const DIST_INDEX = path.join(DIST_DIR, "index.html");
let sheets = null;
const openaiClients = new Map();

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
  if (!resend) {
    console.log("Resend no configurado, se omite envio de email");
    return;
  }

  const businessLabel = cliente?.businessName || cliente?.nombre || "NEXORA";

  try {
    await resend.emails.send({
      from: "NEXORA <onboarding@resend.dev>",
      to: [to],
      subject: `Nuevo lead - ${businessLabel}`,
      text: `
Cliente: ${businessLabel}
Nombre: ${nombre || "No informado"}
Telefono: ${telefono || "No informado"}
Interes: ${interes || "No especificado"}
Presupuesto: ${presupuesto || "No informado"}
`,
    });

    console.log("Lead enviado por email");
  } catch (error) {
    console.error("Error enviando email:", error.response?.data || error.message || error);
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

app.get("/api/health", (req, res) => {
  const config = getConfig();

  res.json({
    ok: true,
    message: "Servidor NEXORA funcionando",
    checks: getRuntimeStatus(config),
  });
});

app.get("/api/clientes", (req, res) => {
  res.json({
    clientes: listClientes(),
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    config: getConfig(),
  });
});

app.get("/api/clientes/:id", (req, res) => {
  const cliente = getCliente(req.params.id);

  if (!cliente) {
    return res.status(404).json({ error: "Cliente no encontrado" });
  }

  return res.json({ cliente });
});

app.post("/api/clientes", (req, res) => {
  try {
    const cliente = saveCliente(req.body);
    return res.status(201).json({ cliente });
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

    if (payload.id !== req.params.id) {
      removeCliente(req.params.id);
    }

    const cliente = saveCliente(payload, req.params.id);
    return res.json({ cliente });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete("/api/clientes/:id", (req, res) => {
  const deleted = removeCliente(req.params.id);

  if (!deleted) {
    return res.status(404).json({ error: "Cliente no encontrado" });
  }

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

app.post("/webhook", async (req, res) => {
  try {
    const config = getConfig();

    const body = req.body;

    if (!body.entry) {
      return res.sendStatus(200);
    }

    const value = body.entry[0]?.changes?.[0]?.value;

    if (!value?.messages?.[0]) {
      return res.sendStatus(200);
    }

    const messageData = value.messages[0];
    const messageId = messageData.id;

    if (mensajesProcesados.has(messageId)) {
      console.log("Mensaje duplicado ignorado:", messageId);
      return res.sendStatus(200);
    }

    mensajesProcesados.add(messageId);

    if (!messageData.text?.body) {
      return res.sendStatus(200);
    }

    const from = messageData.from;
    const mensaje = messageData.text.body;
    const phoneNumberId = value.metadata.phone_number_id;
    const cliente = getCliente(phoneNumberId);

    if (!cliente) {
      console.log("Cliente no configurado para phoneNumberId:", phoneNumberId);
      return res.sendStatus(200);
    }

    const openaiApiKey = resolveClientOpenAIApiKey(cliente, config);
    const whatsappToken = resolveClientWhatsappToken(cliente, config);
    const openai = getOpenAIClient(openaiApiKey);

    if (!openai) {
      console.error("OPENAI_API_KEY no configurada para cliente:", cliente.id);
      return res.status(503).json({ error: "OpenAI no configurado" });
    }

    if (!whatsappToken) {
      console.error("WHATSAPP_TOKEN no configurado para cliente:", cliente.id);
      return res.status(503).json({ error: "WhatsApp no configurado" });
    }

    if (!historial[from]) {
      historial[from] = [];
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(cliente, config),
        },
        ...historial[from],
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

    const mensajeFinal = data.mensaje || "Perfecto, contame un poco mas y te ayudo.";

    if (data.lead_calificado && !leadsEnviados.has(from)) {
      leadsEnviados.add(from);
      const leadEmail = cliente.leadEmail || DEFAULT_LEAD_EMAIL;

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

    historial[from].push({ role: "user", content: mensaje });
    historial[from].push({ role: "assistant", content: mensajeFinal });

    if (historial[from].length > 6) {
      historial[from] = historial[from].slice(-6);
    }

    await responderWhatsapp(phoneNumberId, from, mensajeFinal, whatsappToken);

    return res.sendStatus(200);
  } catch (error) {
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
