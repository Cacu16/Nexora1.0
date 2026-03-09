require("dotenv").config();
const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const axios = require("axios");
const clientes = require("./clientes");
const { google } = require("googleapis");
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
app.use(cors());
app.use(express.json());

const DEST_EMAIL = "contactonexora16@gmail.com";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===============================
// GOOGLE SHEETS (opcional)
// ===============================

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
let sheets = null;

if (SPREADSHEET_ID) {
  const auth = new google.auth.GoogleAuth({
    keyFile: "google-credentials.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheets = google.sheets({ version: "v4", auth });
}

// ===============================
// EMAIL
// ===============================

// ===============================
// VARIABLES
// ===============================

const historial = {};
const mensajesProcesados = new Set();
const leadsEnviados = new Set();

// ===============================
// RUTA BASE
// ===============================

app.get("/", (req, res) => {
  res.send("Servidor NEXORA funcionando 🚀");
});

// ===============================
// VERIFY TOKEN
// ===============================

const VERIFY_TOKEN = "nexora_2026_secure";

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// ===============================
// GUARDAR LEAD EN SHEETS (opcional)
// ===============================

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
        values: [[
          new Date().toLocaleString(),
          nombre,
          telefono,
          rubro,
          interes
        ]]
      }
    });

    console.log("Lead guardado en Sheets");
  } catch (error) {
    console.error("Error guardando lead en Sheets:", error.response?.data || error.message || error);
  }
}

// ===============================
// ENVIAR LEAD POR EMAIL
// ===============================

async function enviarEmailLead(nombre, telefono, interes, presupuesto) {
  try {

    await resend.emails.send({
      from: "NEXORA <onboarding@resend.dev>",
      to: ["contactonexora16@gmail.com"],
      subject: "🔥 NUEVO LEAD NEXORA",
      text: `
Nombre: ${nombre || "No informado"}
Teléfono: ${telefono}
Interés: ${interes || "No especificado"}
Presupuesto: ${presupuesto || "No informado"}
`
    });

    console.log("Lead enviado por email");

  } catch (error) {

    console.error("Error enviando email:", error);

  }
}

// ===============================
// RESPONDER AL CLIENTE POR WHATSAPP
// ===============================

async function responderWhatsapp(phoneNumberId, to, body) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ===============================
// WEBHOOK MENSAJES
// ===============================

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (!body.entry) return res.sendStatus(200);

    const value = body.entry[0].changes[0].value;

    if (!value.messages) return res.sendStatus(200);

    const messageData = value.messages[0];
    const messageId = messageData.id;

    if (mensajesProcesados.has(messageId)) {
      console.log("Mensaje duplicado ignorado:", messageId);
      return res.sendStatus(200);
    }

    mensajesProcesados.add(messageId);

    if (!messageData.text) return res.sendStatus(200);

    const from = messageData.from;
    const mensaje = messageData.text.body;
    const phoneNumberId = value.metadata.phone_number_id;

    const cliente = clientes[phoneNumberId];

    if (!cliente) {
      console.log("Cliente no configurado para phoneNumberId:", phoneNumberId);
      return res.sendStatus(200);
    }

    if (!historial[from]) historial[from] = [];

    // ===============================
    // CONSULTA A OPENAI
    // ===============================

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
Tu nombre es Fer.
Sos Fer, el asistente oficial de NEXORA.
Siempre te presentás como Fer cuando hablás con un cliente.

Nunca digas que sos una IA.
Nunca digas que sos un asistente genérico.

Tu función es ayudar a personas interesadas en automatizar su WhatsApp con inteligencia artificial usando NEXORA.

Respondé de forma clara, breve y natural.

Si el cliente pregunta quién sos:
"Soy Fer, asistente de NEXORA. Estoy para ayudarte con información sobre nuestros planes y automatizaciones."

Reglas:
- No inventes procesos internos.
- No menciones contratos o reuniones inexistentes.
- Si el usuario quiere contratar:
  - pedí su correo
  - confirmá su número

Tono:
- Si habla informal, respondé en tuteo argentino.
- Si habla formal, respondé formalmente.
- Hablá natural.
- No uses lenguaje corporativo innecesario.

IMPORTANTE:
Respondé SOLO con JSON válido.
No agregues texto antes ni después del JSON.
No escribas palabras como "json" ni explicaciones extra.

Formato obligatorio:

{
  "mensaje": "respuesta al usuario",
  "lead_calificado": false,
  "nombre": null,
  "telefono": null,
  "interes": null,
  "presupuesto": null
}

Si el usuario muestra intención clara de contratar:
lead_calificado = true

Planes disponibles:
${cliente.planes}
`
        },
        ...historial[from],
        { role: "user", content: mensaje }
      ],
    });

    // ===============================
    // PARSEAR RESPUESTA
    // ===============================

   const respuestaCruda = response.choices[0].message.content;

let data = {
  mensaje: respuestaCruda,
  lead_calificado: false,
  nombre: null,
  telefono: null,
  interes: null,
  presupuesto: null,
};

try {
  // Caso ideal: OpenAI devuelve JSON puro
  data = JSON.parse(respuestaCruda);
} catch {
  // Caso mixto: texto + json
  const match = respuestaCruda.match(/\{[\s\S]*\}/);

  if (match) {
    try {
      const jsonExtraido = JSON.parse(match[0]);

      data = {
        mensaje:
          jsonExtraido.mensaje ||
          respuestaCruda.replace(match[0], "").trim() ||
          "Perfecto 👍 ¿En qué puedo ayudarte?",
        lead_calificado: jsonExtraido.lead_calificado || false,
        nombre: jsonExtraido.nombre || null,
        telefono: jsonExtraido.telefono || null,
        interes: jsonExtraido.interes || null,
        presupuesto: jsonExtraido.presupuesto || null,
      };
    } catch {
      // si ni el JSON extraído sirve, dejamos solo texto limpio
      data = {
        mensaje: respuestaCruda.replace(/\{[\s\S]*\}/, "").trim() || "Perfecto 👍 ¿En qué puedo ayudarte?",
        lead_calificado: false,
        nombre: null,
        telefono: null,
        interes: null,
        presupuesto: null,
      };
    }
  }
}

const mensajeFinal = data.mensaje || "Perfecto 👍 ¿En qué puedo ayudarte?";

    // ===============================
    // ENVIAR LEAD POR EMAIL Y GUARDAR
    // ===============================

    if (data.lead_calificado && !leadsEnviados.has(from)) {
      leadsEnviados.add(from);

      await guardarLead(
        data.nombre || "No informado",
        from,
        "Pendiente",
        data.interes || "Interesado"
      );

      await enviarEmailLead(
        data.nombre || "No informado",
        from,
        data.interes || "Interesado",
        data.presupuesto || "No informado"
      );
    }

    // ===============================
    // HISTORIAL
    // ===============================

    historial[from].push({ role: "user", content: mensaje });
    historial[from].push({ role: "assistant", content: mensajeFinal });

    if (historial[from].length > 6) {
      historial[from] = historial[from].slice(-6);
    }

    // ===============================
    // RESPUESTA AL CLIENTE
    // ===============================

    await responderWhatsapp(phoneNumberId, from, mensajeFinal);

    return res.sendStatus(200);

  } catch (error) {
    console.error("Error webhook:", error.response?.data || error.message || error);
    return res.sendStatus(500);
  }
});

// ===============================
// SERVER
// ===============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});