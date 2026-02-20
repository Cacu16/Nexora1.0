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

// Ruta base
app.get("/", (req, res) => {
  res.send("Servidor NEXORA funcionando 🚀");
});

// 🔥 RUTA REAL DE CHAT (dinámica)
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
          content: "Sos NEXORA, una IA estratégica especializada en negocios, startups y crecimiento."
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

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});