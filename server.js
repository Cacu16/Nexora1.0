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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===============================
// 🔐 GOOGLE SHEETS CONFIG
// ===============================

const auth = new google.auth.GoogleAuth({
  keyFile: "google-credentials.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// ===============================
// 🔐 VERIFY TOKEN
// ===============================

const VERIFY_TOKEN = "nexora_2026_secure";

// ===============================
// 📌 RUTA BASE
// ===============================

app.get("/", (req, res) => {
  res.send("Servidor NEXORA funcionando 🚀");
});

// ===============================
// 🔐 WEBHOOK VERIFICACIÓN
// ===============================

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
// 📊 GUARDAR LEAD EN SHEETS
// ===============================

async function guardarLead(nombre, telefono, rubro, interes) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "A:E",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            new Date().toLocaleString(),
            nombre,
            telefono,
            rubro,
            interes
          ]
        ]
      }
    });

    console.log("Lead guardado en Sheets");
  } catch (error) {
    console.error("Error guardando en Sheets:", error);
  }
}

// ===============================
// 📩 WEBHOOK MENSAJES
// ===============================

const historial = {};

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (
      body.object &&
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0].value.messages
    ) {
      const value = body.entry[0].changes[0].value;
      const messageData = value.messages[0];

      if (!messageData.text) {
        return res.sendStatus(200);
      }

      const from = messageData.from;
      const mensaje = messageData.text.body;
      const phoneNumberId = value.metadata.phone_number_id;

      console.log("phoneNumberId:", phoneNumberId);

      const cliente = clientes[phoneNumberId];

      if (!cliente) {
        console.log("Cliente no configurado");
        return res.sendStatus(200);
      }

      if (!historial[from]) historial[from] = [];

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `
Sos Fernando asistente oficial de ${cliente.nombre}.

Reglas de comunicación:
- No inventes procesos internos.
- No menciones contratos, documentos, reuniones, llamados o pasos que no estén explícitamente definidos en los planes.
- Si el usuario confirma que quiere contratar o avanzar:
   - SIEMPRE pedí explícitamente su correo electrónico.
   - SIEMPRE confirmá su número de contacto.
   - No asumas que ya tenemos sus datos.
   - No digas que un asesor lo contactará hasta que el usuario haya enviado sus datos.
   - Primero pedí los datos. Después confirmá que serán contactados.
- Nunca prometas envío de contrato si no está definido.
- Detectá automáticamente el estilo del usuario.
- Si el usuario habla informal (me pasás, cuánto sale, che, hola genio, etc), respondé usando tuteo argentino natural.
- Está prohibido usar lenguaje corporativo o neutro si el usuario habla informal.
- No uses frases como: "Con gusto", "Estimado", "Aquí tienes", "No dudes en".
- Hablá como una persona real, cercana y segura.
- Si el usuario usa trato formal (usted, podría indicarme), respondé formalmente.
- No seas rígido ni estructurado como folleto.
- No uses formato excesivamente corporativo.
- Sé directo, claro y humano.
REGLA DEL SISTEMA:

Debes responder SIEMPRE en formato JSON válido.
No puedes responder texto fuera del JSON.

El formato obligatorio es:

{
  "mensaje": "respuesta natural para el usuario",
  "lead_calificado": boolean,
  "nombre": string o null,
  "telefono": string o null,
  "interes": string o null,
  "presupuesto": string o null
}

- Si el usuario muestra intención clara de contratar o avanzar,
  lead_calificado debe ser true.
- Si no, debe ser false.
- El campo "mensaje" debe contener la respuesta normal conversacional.
- No agregues texto fuera del JSON.

- Sé ${cliente.tono}.

Planes disponibles:
${cliente.planes}
`
          },
          ...historial[from],
          { role: "user", content: mensaje }
        ],
      });

      const data = JSON.parse(response.choices[0].message.content);

const mensajeFinal = data.mensaje;
let datosLead = null;

const match = respuestaIA.match(/\{[\s\S]*"lead_calificado":[\s\S]*?\}/);

if (match) {
  try {
    datosLead = JSON.parse(match[0]);
    mensajeFinal = respuestaIA.replace(match[0], "").trim();
  } catch (e) {
    console.log("Error parseando JSON de lead");
  }
}

if (data.lead_calificado) {
  await guardarLead(
    data.nombre || "Pendiente",
    from,
    data.presupuesto || "Pendiente",
    data.interes || "Interesado"
  );
}

      // Guardar historial
      historial[from].push({ role: "user", content: mensaje });
      historial[from].push({ role: "assistant", content: respuestaIA });

      if (historial[from].length > 6) {
        historial[from] = historial[from].slice(-6);
      }

      // 🔥 Detectar interés simple
      const mensajeLower = mensaje.toLowerCase();

      if (
        mensajeLower.includes("me interesa") ||
        mensajeLower.includes("quiero contratar")
      ) {
        await guardarLead("Pendiente", from, "Pendiente", "Interesado");
      }

      // 📤 Enviar respuesta por WhatsApp
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
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Error webhook:", error.response?.data || error);
    res.sendStatus(500);
  }
});

// ===============================
// 🚀 SERVER
// ===============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});