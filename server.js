require("dotenv").config();
const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const axios = require("axios");
const clientes = require("./clientes");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json());

const NUMERO_DUENO = "5491132465579";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});


// ===============================
// GOOGLE SHEETS
// ===============================

const auth = new google.auth.GoogleAuth({
  keyFile: "google-credentials.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;


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
  } else {
    return res.sendStatus(403);
  }
});


// ===============================
// GUARDAR LEAD
// ===============================

async function guardarLead(nombre, telefono, rubro, interes) {
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
    console.error("Error guardando lead:", error);
  }
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
      console.log("Cliente no configurado");
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
Siempre te presentás como Fer cuando hablas con un cliente.

Nunca digas que sos una IA.
Nunca digas que sos un asistente genérico.

Tu función es ayudar a personas interesadas en automatizar su WhatsApp con inteligencia artificial usando NEXORA.

Respondé de forma clara, breve y natural.

Si el cliente pregunta quién sos:
"Soy Fer, asistente de NEXORA. Estoy para ayudarte con información sobre nuestros planes y automatizaciones."

Reglas de comunicación:

- No inventes procesos internos.
- No menciones contratos, documentos o reuniones que no estén definidos.
- Si el usuario quiere contratar:
  - Pedí su correo electrónico.
  - Confirmá su número de contacto.

Tono:

- Si el usuario habla informal → respondé en tuteo argentino.
- Si habla formal → respondé formalmente.
- No uses lenguaje corporativo.
- Hablá como una persona real.

FORMATO OBLIGATORIO:

Debes responder SIEMPRE en JSON válido.

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

    let data;

    try {
      data = JSON.parse(response.choices[0].message.content);
    } catch {

      data = {
        mensaje: response.choices[0].message.content,
        lead_calificado: false
      };

    }

    const mensajeFinal = data.mensaje;


// ===============================
// ENVIAR LEAD AL DUEÑO
// ===============================

    if (data.lead_calificado && !leadsEnviados.has(from)) {

      leadsEnviados.add(from);

      try {

        await axios.post(
          `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
          {
            messaging_product: "whatsapp",
            to: NUMERO_DUENO,
            text: {
              body: `🔥 NUEVO LEAD NEXORA

Nombre: ${data.nombre || "No informado"}
Teléfono: ${from}
Interés: ${data.interes || "No especificado"}
Presupuesto: ${data.presupuesto || "No informado"}`
            }
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
              "Content-Type": "application/json"
            }
          }
        );

        console.log("Lead enviado al dueño:", from);

      } catch (error) {

        console.error("Error enviando lead:", error.response?.data || error);

      }

      await guardarLead(
        data.nombre || "No informado",
        from,
        "Pendiente",
        data.interes || "Interesado"
      );

    }


// ===============================
// RESPONDER AL CLIENTE
// ===============================

    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to: from,
        text: { body: mensajeFinal }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );


// ===============================
// GUARDAR HISTORIAL
// ===============================

    historial[from].push({ role: "user", content: mensaje });
    historial[from].push({ role: "assistant", content: mensajeFinal });

    if (historial[from].length > 6) {
      historial[from] = historial[from].slice(-6);
    }

    res.sendStatus(200);

  } catch (error) {

    console.error("Error webhook:", error.response?.data || error);

    res.sendStatus(500);

  }

});


// ===============================
// SERVER
// ===============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});