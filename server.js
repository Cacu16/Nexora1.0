require("dotenv").config();
const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 🔐 VERIFY TOKEN (Debe coincidir con Meta)
const VERIFY_TOKEN = "nexora_2026_secure";

// ===============================
// 📌 RUTA BASE
// ===============================
app.get("/", (req, res) => {
  res.send("Servidor NEXORA funcionando 🚀");
});

// ===============================
// 🔐 WEBHOOK VERIFICACIÓN META
// ===============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente");
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

// ===============================
// 📩 RECEPCIÓN DE MENSAJES WHATSAPP
// ===============================
app.post("/webhook", async (req, res) => {
  console.log("Mensaje recibido:");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const body = req.body;

    if (
      body.object &&
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0].value.messages
    ) {
      const mensaje =
        body.entry[0].changes[0].value.messages[0].text.body;

      console.log("Mensaje del usuario:", mensaje);

      // 🔥 Llamada a OpenAI
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Sos NEXORA, un asistente profesional de atención al cliente para empresas."
          },
          {
            role: "user",
            content: mensaje
          }
        ],
      });

      console.log("Respuesta IA:", response.choices[0].message.content);
    }

    res.sendStatus(200);

  } catch (error) {
    console.error("Error procesando mensaje:", error);
    res.sendStatus(500);
  }
});

// ===============================
// 💬 RUTA DE CHAT INTERNO (pruebas)
// ===============================
app.post("/chat", async (req, res) => {
  try {
    const { mensaje } = req.body;

    if (!mensaje) {
      return res.status(400).json({
        error: "Falta el mensaje en el body"
      });
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Sos NEXORA, una IA estratégica especializada en negocios, startups y crecimiento."
        },
        {
          role: "user",
          content: mensaje
        }
      ],
    });

    res.json({
      respuesta: response.choices[0].message.content
    });

  } catch (error) {
    console.error("Error OpenAI:", error);
    res.status(500).json({
      error: "Error conectando con OpenAI"
    });
  }
});

// ===============================
// 🚀 SERVIDOR
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});