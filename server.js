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
const SPANISH_MONTH_INDEX = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
};
const SCHEDULING_SIGNAL_PATTERNS = [
  /\breunion\b/,
  /\breunirme\b/,
  /\breunirnos\b/,
  /\bagend(ar|o|amos|emos)\b/,
  /\bagenda\b/,
  /\bcoordin(ar|amos|emos|o)\b/,
  /\bcoordinar\b/,
  /\bllamada\b/,
  /\bcall\b/,
  /\bcita\b/,
  /\bturno\b/,
  /\bdemo\b/,
  /\bvisita\b/,
];

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
    payload.contactName || "sin-contacto",
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

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatFullDate(date = new Date()) {
  return new Intl.DateTimeFormat("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function formatShortDate(date = new Date()) {
  return new Intl.DateTimeFormat("es-AR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function normalizeYear(value, fallbackYear) {
  const numericYear = Number(value);

  if (!Number.isFinite(numericYear)) {
    return fallbackYear;
  }

  return numericYear < 100 ? 2000 + numericYear : numericYear;
}

function buildValidDate(year, monthIndex, day) {
  const candidate = new Date(year, monthIndex, day);

  if (
    Number.isNaN(candidate.getTime()) ||
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== monthIndex ||
    candidate.getDate() !== day
  ) {
    return null;
  }

  return startOfLocalDay(candidate);
}

function detectPastDateReference(text, now = new Date()) {
  const normalizedText = normalizeLeadSignalText(text);

  if (!normalizedText) {
    return null;
  }

  const today = startOfLocalDay(now);
  const directPastReferences = [
    "ayer",
    "anteayer",
    "la semana pasada",
    "el mes pasado",
    "el ano pasado",
  ];

  for (const reference of directPastReferences) {
    if (normalizedText.includes(reference)) {
      return {
        kind: "relative",
        matchedText: reference,
        displayDate: null,
      };
    }
  }

  const weekdayPastMatch = normalizedText.match(
    /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+pasad[oa]\b/
  );

  if (weekdayPastMatch) {
    return {
      kind: "relative",
      matchedText: weekdayPastMatch[0],
      displayDate: null,
    };
  }

  const numericDateRegex = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/g;

  for (const match of normalizedText.matchAll(numericDateRegex)) {
    const day = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const year = normalizeYear(match[3], today.getFullYear());
    const candidate = buildValidDate(year, monthIndex, day);

    if (candidate && candidate < today) {
      return {
        kind: "absolute",
        matchedText: match[0],
        displayDate: formatShortDate(candidate),
      };
    }
  }

  const textualDateRegex =
    /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{2,4}))?\b/g;

  for (const match of normalizedText.matchAll(textualDateRegex)) {
    const day = Number(match[1]);
    const monthIndex = SPANISH_MONTH_INDEX[match[2]];
    const year = normalizeYear(match[3], today.getFullYear());
    const candidate = buildValidDate(year, monthIndex, day);

    if (candidate && candidate < today) {
      return {
        kind: "absolute",
        matchedText: match[0],
        displayDate: formatShortDate(candidate),
      };
    }
  }

  return null;
}

function buildSystemPrompt(cliente, config, options = {}) {
  const hasAssistantHistory = Boolean(options?.hasAssistantHistory);
  const currentDate = options?.currentDate instanceof Date ? options.currentDate : new Date();
  const pastDateReference = options?.pastDateReference || null;
  const knownLeadSnapshot = options?.knownLeadSnapshot || null;
  const promptNotes = Array.isArray(cliente.promptNotes) && cliente.promptNotes.length
    ? cliente.promptNotes.map((note) => `- ${note}`).join("\n")
    : "- Responde de forma clara, breve y natural.";

  const globalPrompt = String(config?.mainPrompt || "").trim();
  const effectiveMainPrompt = String(
    cliente?.mainPromptOverride || buildClientMainPrompt(globalPrompt, cliente)
  ).trim();
  const clientPrompt = String(cliente.clientPrompt || "").trim();
  const openingRules = hasAssistantHistory
    ? [
        "- Ya respondiste antes en esta conversacion: no reinicies, no repitas saludo, no repitas presentacion y no mandes otra bienvenida.",
        "- Si el cliente retoma despues de horas o dias, segui natural desde el ultimo punto util.",
      ].join("\n")
    : [
        "- Si es tu primera respuesta, presentate solo si el cliente saluda, pregunta quien sos o el contexto realmente lo necesita.",
        "- Si el cliente va directo a una consulta, responde directo sin mensaje de presentacion.",
      ].join("\n");

  return `
PROMPT PRINCIPAL NEXORA:
${effectiveMainPrompt || "Sos el operador principal de Nexora."}

CONTEXTO DEL CLIENTE:
Tu nombre es ${cliente.assistantName || "Fer"}.
Sos ${cliente.assistantName || "Fer"}, el asistente oficial de ${cliente.businessName || cliente.nombre}.
Te identificas como ${cliente.assistantName || "Fer"} solo cuando aporta valor a la conversacion.

Nunca digas que sos una IA.
Nunca digas que sos un asistente generico.

Tu funcion es ayudar a personas interesadas en ${cliente.businessDescription || "los servicios del negocio"}.

Objetivo principal:
${cliente.leadGoal || "Ayudar al usuario, responder dudas y detectar oportunidades comerciales."}

Mensaje base de presentacion si preguntan quien sos:
${cliente.greeting || `Soy ${cliente.assistantName || "Fer"}, asistente de ${cliente.businessName || cliente.nombre}.`}

Reglas de apertura y seguimiento:
- No envias mensajes proactivos, reactivaciones ni seguimientos si el cliente no respondio.
- Si el cliente queda en silencio, guardas silencio.
${openingRules}
- Hace seguimiento basico solo dentro de la conversacion activa y solo para destrabar un dato faltante; recordalo una sola vez y con naturalidad.
- Si la conversacion ya viene avanzada, retoma el contexto sin volver a empezar.

Reglas adicionales:
${promptNotes}

Tono:
${cliente.tono || "Claro y natural"}

Fecha actual de referencia:
- Hoy es ${formatFullDate(currentDate)}.
- Fecha ISO actual: ${formatIsoDate(currentDate)}.

Datos ya confirmados en esta conversacion:
${knownLeadSnapshot
    ? [
        `- Nombre ya confirmado: ${knownLeadSnapshot.confirmedName || "No informado"}`,
        `- Telefono ya confirmado: ${knownLeadSnapshot.confirmedPhone || "No informado"}`,
        knownLeadSnapshot.contactPreference
          ? `- Preferencia de contacto registrada: ${knownLeadSnapshot.contactPreference}`
          : null,
        knownLeadSnapshot.leadInterest
          ? `- Interes registrado: ${knownLeadSnapshot.leadInterest}`
          : null,
        knownLeadSnapshot.leadSentAt
          ? `- Este lead ya fue enviado al equipo el ${knownLeadSnapshot.leadSentAt}.`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "- Aun no hay datos de contacto confirmados para este chat."}

PROMPT ESPECIFICO DEL CLIENTE:
${clientPrompt || "Sin instrucciones extra para este cliente."}

Modo premium de atencion y ventas:
- Detecta la etapa del cliente: exploracion, comparacion, objecion o decision.
- Adapta el flujo segun la etapa y la intencion real de compra.
- Prioriza respuestas inteligentes, claras y accionables.
- Usa multiples flujos segun corresponda: consulta general, recomendacion, objecion, cierre, toma de datos y seguimiento basico.
- Cuando haya intencion real de compra o contratacion, intenta capturar nombre y telefono.
- Cuando pidas datos de contacto para que un asesor siga la conversacion, pedi tambien que dia y horario le quedan mejor para recibir ese contacto.
- Pide un solo dato por vez y solo el minimo necesario para avanzar.
- Si ya tienes suficiente contexto para recomendar, no hagas preguntas innecesarias.
- Si el cliente menciona una fecha u horario que ya paso respecto de hoy, no lo confirmes ni lo agendes.
- Si el cliente propone una fecha pasada, explicale claramente que esa fecha ya paso y pedi una nueva fecha futura.
- Si el cliente usa referencias relativas como "ayer", "la semana pasada", "el lunes pasado" o una fecha tipo "10/03", interpretalas usando la fecha actual indicada arriba.
- Si ya tienes nombre y telefono confirmados en esta conversacion, no vuelvas a pedirlos.
- Si el lead ya fue enviado al equipo, no digas que faltan datos de contacto ni afirmes que no los tienes.
- Solo vuelve a preguntar nombre o telefono si el cliente aclara que quiere corregirlos o cambiarlos.
- Si el cliente quiere coordinar una reunion, llamada o demo comercial, no respondas que no puedes agendar.
- En ese caso, captura nombre, telefono y la preferencia de fecha/horario de contacto si faltan, y deja la conversacion lista para que un asesor lo contacte a la brevedad y confirme esa reunion.
- Habla siempre en espanol rioplatense real: preferi "aca", "decime", "contame", "si queres", "dale", "buenisimo", "podes".
- Evita palabras o giros neutros o demasiado formales como "aqui", "puedes", "de acuerdo", "indiqueme", "podria", "si deseas", "comprendo".
- Nunca te describas como IA, inteligencia artificial, asistente virtual, bot o modelo.

IMPORTANTE:
Responde SOLO con JSON valido.
No agregues texto antes ni despues del JSON.
No escribas la palabra json ni explicaciones extra.
Nunca menciones cuentas bancarias, alias, CBU, CVU, links de pago, confirmacion de pedido,
entrega, retiro o stock confirmado si esa informacion no esta escrita en la configuracion del cliente.
Nunca prometas enviar despues demos, detalles, informacion adicional, catalogos, archivos, links, material,
presupuestos personalizados ni seguimiento humano si esa accion no existe de forma explicita en la configuracion.
Si el cliente pide mas informacion, respondela ahora mismo dentro del chat usando solo lo que esta cargado.
No digas "te mando", "te envio", "te paso", "te comparto" ni "te agendo una demo" para cosas no habilitadas.
Nunca pidas razon social, CIF, NIF, CUIT, CUIL, identificacion fiscal, direccion de facturacion,
domicilio fiscal, datos bancarios ni documentacion operativa si eso no esta explicitamente configurado.
Si el catalogo del cliente esta cargado en "Planes disponibles", tomalo como catalogo cerrado:
no inventes productos, marcas, variedades, presentaciones ni precios fuera de esa lista.

Formato obligatorio:
{
  "mensaje": "respuesta al usuario",
  "lead_calificado": false,
  "nombre": null,
  "telefono": null,
  "preferencia_contacto": null,
  "interes": null,
  "presupuesto": null
}

Reglas para completar el JSON:
- "lead_calificado" = true solo si ya tienes nombre y telefono confirmados, junto con una intencion comercial clara.
- "nombre" solo si el cliente lo dijo o lo confirmo.
- "telefono" solo si el cliente lo dijo o lo confirmo dentro de la charla.
- "preferencia_contacto" solo si el cliente indico un dia, fecha, franja horaria u horario preferido para que lo contacten.
- "interes" debe resumir con precision que quiere comprar o contratar el cliente; si es un producto o plan puntual, nombra ese producto o plan.
- "presupuesto" solo si el cliente lo menciono.
- Si falta nombre o telefono, no marques lead_calificado y usalos en "mensaje" para pedir el siguiente dato faltante con naturalidad.
${pastDateReference
    ? `- Atencion: en el ultimo mensaje el cliente menciono una fecha pasada (${pastDateReference.displayDate || pastDateReference.matchedText}). No la tomes como valida ni confirmes una reunion con esa fecha.`
    : ""}

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

function hasLeadContactData(parsedData) {
  return Boolean(String(parsedData?.nombre || "").trim() && String(parsedData?.telefono || "").trim());
}

function inferCatalogInterest(cliente, ...texts) {
  const catalog = Array.isArray(cliente?.planes) ? cliente.planes : [];
  const normalizedTexts = texts.map((value) => normalizeLeadSignalText(value)).join(" ");

  for (const plan of catalog) {
    const planName = String(plan?.nombre || "").trim();
    if (!planName) {
      continue;
    }

    const normalizedPlanName = normalizeLeadSignalText(planName);
    if (normalizedPlanName && normalizedTexts.includes(normalizedPlanName)) {
      return planName;
    }
  }

  return null;
}

function shouldReplaceLeadInterest(interes) {
  const normalized = normalizeLeadSignalText(interes);
  if (!normalized) {
    return true;
  }

  return [
    "interesado",
    "consulta",
    "compra",
    "pedido",
    "producto",
    "servicio",
    "plan",
    "vino",
    "automatizacion",
  ].includes(normalized);
}

function enrichLeadData(cliente, userMessage, parsedData, history = []) {
  const enrichedData = { ...parsedData };
  const historyTexts = history.map((item) => item?.content || "");
  const inferredInterest = inferCatalogInterest(
    cliente,
    enrichedData?.interes,
    userMessage,
    ...historyTexts
  );

  if (inferredInterest && shouldReplaceLeadInterest(enrichedData?.interes)) {
    enrichedData.interes = inferredInterest;
  }

  return enrichedData;
}

function mergeKnownLeadSnapshot(parsedData, knownLeadSnapshot) {
  if (!knownLeadSnapshot) {
    return { ...parsedData };
  }

  return {
    ...parsedData,
    nombre: parsedData?.nombre || knownLeadSnapshot.confirmedName || null,
    telefono: parsedData?.telefono || knownLeadSnapshot.confirmedPhone || null,
    interes: parsedData?.interes || knownLeadSnapshot.leadInterest || null,
  };
}

function buildLeadDispatchKey(clienteId, from, interes) {
  const normalizedInterest = normalizeLeadSignalText(interes || "general").replace(/\s+/g, "-") || "general";
  return `${clienteId}:${from}:${normalizedInterest}`;
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
  const hasQualifiedLeadData = hasLeadContactData(parsedData);

  return (
    hasQualifiedLeadData ||
    (purchaseSignals.some((signal) => userText.includes(signal)) &&
      closingSignals.some((signal) => combinedText.includes(signal)) &&
      hasLeadContactData(parsedData))
  );
}

function looksLikeFarewellMessage(userMessage) {
  const text = normalizeLeadSignalText(userMessage);

  if (!text) {
    return false;
  }

  const farewellSignals = [
    "gracias",
    "muchas gracias",
    "chau",
    "chauu",
    "adios",
    "hasta luego",
    "nos vemos",
    "saludos",
    "buenisimo gracias",
    "genial gracias",
    "perfecto gracias",
    "dale gracias",
    "listo gracias",
  ];
  const continuationSignals = [
    "?",
    "precio",
    "cuanto",
    "como",
    "donde",
    "cuando",
    "quiero",
    "me interesa",
    "mandame",
    "pasame",
    "necesito",
    "pero",
  ];

  return (
    farewellSignals.some((signal) => text.includes(signal)) &&
    !continuationSignals.some((signal) => text.includes(signal))
  );
}

function looksLikePostLeadAcknowledgement(userMessage, knownLeadSnapshot) {
  const text = normalizeLeadSignalText(userMessage).replace(/[!.,?]/g, " ").trim();

  if (!text || !knownLeadSnapshot?.leadSentAt) {
    return false;
  }

  return [
    "genial",
    "genial fer",
    "perfecto",
    "perfecto fer",
    "buenisimo",
    "buenisimo fer",
    "listo",
    "listo fer",
    "dale",
    "dale fer",
    "ok",
    "oka",
    "joya",
    "excelente",
    "gracias",
    "gracias fer",
  ].includes(text);
}

function buildFarewellReply(parsedData) {
  const customerName = String(parsedData?.nombre || "").trim();
  const greetingTarget = customerName ? ` ${customerName}` : "";

  return `Saludos${greetingTarget}, si necesitas algo mas estamos en contacto.`;
}

function buildQualifiedLeadReply(cliente, parsedData, options = {}) {
  const customerName = String(
    parsedData?.nombre || options?.knownLeadSnapshot?.confirmedName || ""
  ).trim();
  const greetingTarget = customerName ? ` ${customerName}` : "";
  const interes = String(parsedData?.interes || "").trim();
  const orderTail = interes ? ` y tu pedido de ${interes}` : " y tu pedido";
  const meetingRequested = Boolean(options?.meetingRequested);

  if (meetingRequested) {
    const meetingLabel = options?.meetingLabel || inferMeetingLabel(interes);
    return `Perfecto${greetingTarget}. Ya deje tus datos para coordinar ${meetingLabel}. Un asesor te va a contactar a la brevedad para confirmarla.`;
  }

  return `Perfecto${greetingTarget}. Ya guardamos tus datos de contacto${orderTail}. Un asesor te va a contactar a la brevedad para finalizar el proceso.`;
}

function inferUnsupportedMediaReplyType(messageType, messageText = "") {
  const normalizedType = String(messageType || "").trim().toLowerCase();
  const normalizedText = normalizeLeadSignalText(messageText);

  if (normalizedType === "sticker" || normalizedText.includes("envio un sticker")) {
    return "sticker";
  }

  return "image";
}

function hasUnsupportedPromise(message) {
  const normalizedMessage = normalizeLeadSignalText(message);

  if (!normalizedMessage) {
    return false;
  }

  const promisePatterns = [
    /\bdemo\b/,
    /\bdetalles?\b/,
    /\bmas info\b/,
    /\binformacion adicional\b/,
    /\bcatalogo\b/,
    /\bmaterial\b/,
    /\bbrochure\b/,
    /\bpdf\b/,
    /\blink\b/,
    /\blinks\b/,
  ];
  const futureSendPatterns = [
    /\bte (mando|envio|paso|comparto)\b/,
    /\bte voy a (mandar|enviar|pasar|compartir)\b/,
    /\bte podemos? (mandar|enviar|pasar|compartir)\b/,
    /\bagend(ar|amos|o|emos)\b/,
  ];

  return (
    promisePatterns.some((pattern) => pattern.test(normalizedMessage)) &&
    futureSendPatterns.some((pattern) => pattern.test(normalizedMessage))
  );
}

function sanitizeAssistantReply(message) {
  const trimmedMessage = String(message || "").trim();

  if (!trimmedMessage) {
    return "Contame un poco mas y te ayudo por aca con la informacion disponible.";
  }

  if (!hasUnsupportedPromise(trimmedMessage)) {
    return trimmedMessage;
  }

  return "Te cuento todo por aca con la informacion disponible. Decime que parte te interesa y te respondo sin prometer envios ni demos.";
}

function normalizeAssistantTone(message) {
  const trimmedMessage = String(message || "").trim();

  if (!trimmedMessage) {
    return trimmedMessage;
  }

  const aiDisclosurePatterns = [
    /\bcomo (ia|inteligencia artificial)\b/gi,
    /\bsoy (una )?(ia|inteligencia artificial|un bot|un chatbot|un asistente virtual|un modelo de lenguaje)\b/gi,
    /\bestoy programad[oa] para\b/gi,
    /\bno tengo la capacidad de\b/gi,
  ];
  const neutralReplacements = [
    [/\baqui\b/gi, "aca"],
    [/\baquí\b/gi, "aca"],
    [/\bpuedes\b/gi, "podes"],
    [/\bsi deseas\b/gi, "si queres"],
    [/\bsi desea\b/gi, "si queres"],
    [/\bdeseas\b/gi, "queres"],
    [/\bde acuerdo\b/gi, "dale"],
    [/\bindicame\b/gi, "decime"],
    [/\bindícame\b/gi, "decime"],
    [/\bindiqueme\b/gi, "decime"],
    [/\bindíqueme\b/gi, "decime"],
    [/\bcomprendo\b/gi, "entiendo"],
    [/\bpuedo ayudarte desde aqui\b/gi, "te ayudo por aca"],
    [/\bestoy aqui para ayudarte\b/gi, "estoy por aca para ayudarte"],
  ];

  let normalizedMessage = trimmedMessage;

  for (const pattern of aiDisclosurePatterns) {
    normalizedMessage = normalizedMessage.replace(pattern, "");
  }

  for (const [pattern, replacement] of neutralReplacements) {
    normalizedMessage = normalizedMessage.replace(pattern, replacement);
  }

  normalizedMessage = normalizedMessage
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/^[,.;:\s-]+/g, "")
    .trim();

  return normalizedMessage || "Estoy por aca para ayudarte en lo que necesites.";
}

function mentionsSchedulingIntent(...texts) {
  const normalizedText = texts.map((text) => normalizeLeadSignalText(text)).join(" ");

  if (!normalizedText.trim()) {
    return false;
  }

  return SCHEDULING_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalizedText));
}

function buildPastDateReply(pastDateReference) {
  const dateLabel = pastDateReference?.displayDate || pastDateReference?.matchedText || "la fecha que mencionaste";

  return `La fecha que mencionaste, ${dateLabel}, ya paso. Si queres coordinar una reunion o llamada, decime una fecha futura y lo seguimos por aca.`;
}

function mentionsMeetingIntent(...texts) {
  const normalizedText = texts.map((text) => normalizeLeadSignalText(text)).join(" ");

  if (!normalizedText.trim()) {
    return false;
  }

  return [/\breunion\b/, /\bllamada\b/, /\bdemo\b/, /\bcita\b/, /\bcall\b/].some((pattern) =>
    pattern.test(normalizedText)
  );
}

function inferMeetingLabel(...texts) {
  const normalizedText = texts.map((text) => normalizeLeadSignalText(text)).join(" ");

  if (/\bdemo\b/.test(normalizedText)) {
    return "la demo";
  }

  if (/\bllamada\b|\bcall\b/.test(normalizedText)) {
    return "la llamada";
  }

  if (/\bcita\b/.test(normalizedText)) {
    return "la cita";
  }

  return "la reunion";
}

function joinNaturalList(items) {
  const filteredItems = items.filter(Boolean);

  if (filteredItems.length <= 1) {
    return filteredItems[0] || "";
  }

  if (filteredItems.length === 2) {
    return `${filteredItems[0]} y ${filteredItems[1]}`;
  }

  return `${filteredItems.slice(0, -1).join(", ")} y ${filteredItems[filteredItems.length - 1]}`;
}

function buildMissingContactDetailsText({ needName = false, needPhone = false, needContactPreference = false } = {}) {
  return joinNaturalList([
    needName ? "tu nombre" : null,
    needPhone ? "tu telefono" : null,
    needContactPreference ? "que dia y horario te quedan mejor para que te contacten" : null,
  ]);
}

function isMeetingRefusal(message) {
  const normalizedMessage = normalizeLeadSignalText(message);

  if (!normalizedMessage) {
    return false;
  }

  return [
    /\bno puedo agendar\b/,
    /\bno puedo coordinar\b/,
    /\bno puedo programar\b/,
    /\bno puedo gestionar\b/,
    /\bno es posible agendar\b/,
    /\bno puedo confirmar reuniones?\b/,
  ].some((pattern) => pattern.test(normalizedMessage));
}

function buildMeetingLeadReply(parsedData, knownLeadSnapshot, ...texts) {
  const meetingLabel = inferMeetingLabel(...texts);
  const knownName = String(parsedData?.nombre || knownLeadSnapshot?.confirmedName || "").trim();
  const knownPhone = String(parsedData?.telefono || knownLeadSnapshot?.confirmedPhone || "").trim();
  const knownContactPreference = String(
    parsedData?.preferencia_contacto || knownLeadSnapshot?.contactPreference || ""
  ).trim();
  const missingMeetingDetails = buildMissingContactDetailsText({
    needName: !knownName,
    needPhone: !knownPhone,
    needContactPreference: !knownContactPreference,
  });

  if (knownName && knownPhone && knownContactPreference) {
    return `Perfecto${knownName ? ` ${knownName}` : ""}. Ya deje tus datos para coordinar ${meetingLabel} y la preferencia de contacto que me pasaste. Un asesor te va a contactar a la brevedad para confirmarla.`;
  }

  if (knownName && knownPhone) {
    return `Perfecto${knownName ? ` ${knownName}` : ""}. Ya deje tus datos para coordinar ${meetingLabel}. Si queres, decime que dia y horario te quedan mejor para que te contacten.`;
  }

  return `Si queres coordinar ${meetingLabel}, decime ${missingMeetingDetails}. Asi la dejo cargada para que un asesor la confirme.`;
}

function hasForbiddenSensitiveDataRequest(message) {
  const normalizedMessage = normalizeLeadSignalText(message);

  if (!normalizedMessage) {
    return false;
  }

  return [
    /\brazon social\b/,
    /\bcif\b/,
    /\bnif\b/,
    /\bcuit\b/,
    /\bcuil\b/,
    /\bidentificacion fiscal\b/,
    /\bnumero de identificacion fiscal\b/,
    /\bdireccion de facturacion\b/,
    /\bdomicilio fiscal\b/,
    /\bdatos fiscales\b/,
    /\bbilling\b/,
  ].some((pattern) => pattern.test(normalizedMessage));
}

function buildSafeLeadContinuationReply(parsedData, knownLeadSnapshot, meetingRequested = false, ...texts) {
  if (meetingRequested) {
    return buildMeetingLeadReply(parsedData, knownLeadSnapshot, ...texts);
  }

  const knownName = String(parsedData?.nombre || knownLeadSnapshot?.confirmedName || "").trim();
  const knownPhone = String(parsedData?.telefono || knownLeadSnapshot?.confirmedPhone || "").trim();
  const knownContactPreference = String(
    parsedData?.preferencia_contacto || knownLeadSnapshot?.contactPreference || ""
  ).trim();
  const missingContactDetails = buildMissingContactDetailsText({
    needName: !knownName,
    needPhone: !knownPhone,
    needContactPreference: !knownContactPreference,
  });

  if (knownName && knownPhone && knownContactPreference) {
    return "Con lo que ya me compartiste alcanza para dejarlo cargado. Un asesor te va a contactar a la brevedad para seguir y confirmar el proximo paso.";
  }

  if (knownName && knownPhone) {
    return "Ya tengo tu nombre y telefono. Si queres, decime tambien que dia y horario te quedan mejor para que te contacten.";
  }

  return `Por ahora necesito ${missingContactDetails} para dejar el contacto cargado. Si queres, pasamelos y seguimos por aca.`;
}

function hasUnsupportedOperationalClaim(message) {
  const normalizedMessage = normalizeLeadSignalText(message);

  if (!normalizedMessage) {
    return false;
  }

  return [
    /\bprocedere a registrar\b/,
    /\bvoy a gestionar\b/,
    /\bgestionare la informacion\b/,
    /\btu plan esta en marcha\b/,
    /\bya active\b/,
    /\bya quedo activado\b/,
    /\bregistro completado\b/,
    /\bactivacion en curso\b/,
    /\bpuesta en marcha\b/,
  ].some((pattern) => pattern.test(normalizedMessage));
}

function buildUnsupportedMediaReply(messageType) {
  if (messageType === "sticker") {
    return "Por aca no podemos recibir stickers. Si queres, contame por texto y te ayudo.";
  }

  return "Por aca no podemos recibir imagenes. Si queres, contame por texto y te ayudo.";
}

function isUnsupportedMediaMessage(messageType, messageText = "") {
  const normalizedType = String(messageType || "").trim().toLowerCase();

  if (normalizedType === "image" || normalizedType === "sticker") {
    return true;
  }

  const normalizedText = normalizeLeadSignalText(messageText);
  return normalizedText.includes("envio una foto por whatsapp") || normalizedText.includes("envio un sticker por whatsapp");
}

function looksLikeGreetingOnly(message) {
  const normalizedMessage = normalizeLeadSignalText(message).replace(/[!.,?]/g, " ").trim();

  if (!normalizedMessage) {
    return false;
  }

  return [
    "hola",
    "holaa",
    "holi",
    "buenas",
    "buen dia",
    "buen dia fer",
    "buenas tardes",
    "buenas noches",
    "que tal",
    "ey",
  ].includes(normalizedMessage);
}

function buildSimpleGreetingReply(cliente) {
  const normalizedBusinessName = normalizeLeadSignalText(
    cliente?.businessName || cliente?.nombre || ""
  );
  const configuredGreeting = String(cliente?.greeting || "").trim();

  if (normalizedBusinessName === "nexora" && configuredGreeting) {
    return configuredGreeting;
  }

  const assistantName = cliente?.assistantName || "Fer";
  const businessName = cliente?.businessName || cliente?.nombre || "el negocio";
  return `Hola, soy ${assistantName} de ${businessName}. Como te puedo ayudar?`;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatPlanReply(message, cliente) {
  const trimmedMessage = String(message || "").trim();

  if (!trimmedMessage || !Array.isArray(cliente?.planes) || cliente.planes.length < 2) {
    return trimmedMessage;
  }

  const normalizedMessage = normalizeLeadSignalText(trimmedMessage);
  const mentionedPlanNames = cliente.planes
    .map((plan) => String(plan?.nombre || "").trim())
    .filter((planName) => planName && normalizedMessage.includes(normalizeLeadSignalText(planName)));

  if (mentionedPlanNames.length < 2) {
    return trimmedMessage;
  }

  let formattedMessage = trimmedMessage;

  for (const planName of mentionedPlanNames) {
    const planPattern = new RegExp(`\\s*${escapeRegExp(planName)}\\s*:`, "gi");
    formattedMessage = formattedMessage.replace(planPattern, `\n\n${planName}:`);
  }

  formattedMessage = formattedMessage
    .replace(/\s+(Setup:|Mensual:|Precio setup:|Precio mensual:)/gi, "\n$1")
    .replace(/\s+-\s+/g, "\n- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return formattedMessage;
}

function isRequestingKnownContactData(message, knownLeadSnapshot) {
  const normalizedMessage = normalizeLeadSignalText(message);

  if (!normalizedMessage || !knownLeadSnapshot?.leadSentAt) {
    return false;
  }

  const hasKnownContactData =
    Boolean(String(knownLeadSnapshot?.confirmedName || "").trim()) &&
    Boolean(String(knownLeadSnapshot?.confirmedPhone || "").trim());

  if (!hasKnownContactData) {
    return false;
  }

  const repeatedContactRequestPatterns = [
    /\b(nombre y telefono|telefono y nombre)\b/,
    /\b(decime|pasame|compartime|dejame|indicame|necesito)\b[\s\S]{0,40}\b(nombre|telefono|numero|contacto)\b/,
    /\b(me falta|faltaria|necesito tener)\b[\s\S]{0,40}\b(nombre|telefono|numero|contacto)\b/,
    /\bno (tengo|tendria|me pasaste|recibi)\b[\s\S]{0,20}\b(nombre|telefono|numero|contacto|datos)\b/,
    /\bpara avanzar\b[\s\S]{0,40}\b(nombre|telefono|numero|contacto)\b/,
  ];

  return repeatedContactRequestPatterns.some((pattern) => pattern.test(normalizedMessage));
}

function sanitizeRepeatedLeadCapture(message, knownLeadSnapshot) {
  const trimmedMessage = String(message || "").trim();

  if (!trimmedMessage) {
    return trimmedMessage;
  }

  if (!isRequestingKnownContactData(trimmedMessage, knownLeadSnapshot)) {
    return trimmedMessage;
  }

  return "Ya tengo tus datos de contacto cargados. Si queres corregir alguno, decimelo; si no, contame que mas necesitas y sigo por aca.";
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
      contactosPorTelefono: new Map(),
    });
  }

  const runtimeState = clientRuntime.get(clienteId);

  if (!runtimeState.contactosPorTelefono) {
    runtimeState.contactosPorTelefono = new Map();
  }

  return runtimeState;
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

function extractInboundContactProfile(value, from) {
  const contactId = String(from || "").trim();
  const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
  const matchedContact =
    contacts.find((contact) => String(contact?.wa_id || "").trim() === contactId) || contacts[0] || null;

  if (!matchedContact) {
    return null;
  }

  const profileName = String(
    matchedContact?.profile?.name || matchedContact?.name || matchedContact?.display_name || ""
  ).trim();

  return {
    waId: String(matchedContact?.wa_id || contactId).trim(),
    profileName: profileName || null,
  };
}

function rememberContactProfile(runtimeState, contactProfile) {
  const waId = String(contactProfile?.waId || "").trim();

  if (!runtimeState || !waId) {
    return null;
  }

  const existingContact = runtimeState.contactosPorTelefono.get(waId) || {};
  const mergedContact = {
    waId,
    profileName: String(contactProfile?.profileName || existingContact.profileName || "").trim() || null,
    lastSeenAt: new Date().toISOString(),
  };

  runtimeState.contactosPorTelefono.set(waId, mergedContact);
  return mergedContact;
}

function getKnownContactProfile(runtimeState, contactId) {
  const waId = String(contactId || "").trim();

  if (!runtimeState || !waId || !runtimeState.contactosPorTelefono.has(waId)) {
    return null;
  }

  return runtimeState.contactosPorTelefono.get(waId);
}

function updateKnownContactState(runtimeState, contactId, updates = {}) {
  const waId = String(contactId || updates?.waId || "").trim();

  if (!runtimeState || !waId) {
    return null;
  }

  const existingContact = runtimeState.contactosPorTelefono.get(waId) || { waId };
  const mergedContact = {
    ...existingContact,
    ...updates,
    waId,
    profileName:
      String(updates?.profileName || existingContact.profileName || "").trim() || null,
    confirmedName:
      String(updates?.confirmedName || existingContact.confirmedName || "").trim() || null,
    confirmedPhone:
      String(updates?.confirmedPhone || existingContact.confirmedPhone || "").trim() || null,
    contactPreference:
      String(updates?.contactPreference || existingContact.contactPreference || "").trim() || null,
    leadInterest:
      String(updates?.leadInterest || existingContact.leadInterest || "").trim() || null,
    leadSentAt: updates?.leadSentAt || existingContact.leadSentAt || null,
    lastSeenAt: updates?.lastSeenAt || existingContact.lastSeenAt || new Date().toISOString(),
  };

  runtimeState.contactosPorTelefono.set(waId, mergedContact);
  return mergedContact;
}

function getKnownLeadSnapshot(runtimeState, contactId) {
  const knownContact = getKnownContactProfile(runtimeState, contactId);

  if (!knownContact) {
    return null;
  }

  const confirmedName = String(knownContact.confirmedName || "").trim();
  const confirmedPhone = String(knownContact.confirmedPhone || "").trim();
  const contactPreference = String(knownContact.contactPreference || "").trim();
  const leadSentAt = String(knownContact.leadSentAt || "").trim();

  if (!confirmedName && !confirmedPhone && !contactPreference && !leadSentAt) {
    return null;
  }

  return {
    confirmedName: confirmedName || null,
    confirmedPhone: confirmedPhone || null,
    contactPreference: contactPreference || null,
    leadInterest: String(knownContact.leadInterest || "").trim() || null,
    leadSentAt: leadSentAt || null,
  };
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

async function enviarEmailLead(
  cliente,
  to,
  nombre,
  telefono,
  interes,
  presupuesto,
  preferenciaContacto = null,
  whatsappOrigen = null,
  contactName = null
) {
  const businessLabel = cliente?.businessName || cliente?.nombre || "NEXORA";
  const resendFrom = String(process.env.EMAIL_FROM || "").trim();
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
    const phoneText = telefono || "No informado";
    const originText = whatsappOrigen || "No informado";
    const whatsappContactName = contactName || "No informado";
    const text = `
Cliente: ${businessLabel}
Nombre: ${nombre || "No informado"}
Nombre de perfil en WhatsApp: ${whatsappContactName}
Telefono brindado: ${phoneText}
WhatsApp de origen: ${originText}
Interes: ${interes || "No especificado"}
Presupuesto: ${presupuesto || "No informado"}
Preferencia de contacto: ${preferenciaContacto || "No informada"}
`;

    if (resend && resendFrom) {
      await resend.emails.send({
        from: resendFrom,
        to: [to],
        subject,
        text,
      });
    } else if (smtpTransport) {
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

function getIncomingMessageType(messageData) {
  const explicitType = String(messageData?.type || "").trim().toLowerCase();

  if (explicitType) {
    return explicitType;
  }

  if (messageData?.text?.body) {
    return "text";
  }

  if (messageData?.audio?.id) {
    return "audio";
  }

  if (messageData?.image?.id) {
    return "image";
  }

  if (messageData?.sticker?.id) {
    return "sticker";
  }

  return "unknown";
}

function buildIncomingMessagePreview(messageData, messageType = getIncomingMessageType(messageData)) {
  switch (messageType) {
    case "text":
      return String(messageData?.text?.body || "").trim();
    case "image": {
      const caption = String(messageData?.image?.caption || "").trim();
      return caption ? `[imagen] ${caption}` : "[imagen sin texto]";
    }
    case "audio":
      return "[audio]";
    case "sticker":
      return "[sticker]";
    default:
      return `[${messageType}]`;
  }
}

function guessFileExtensionFromMimeType(mimeType) {
  const normalizedMimeType = String(mimeType || "").trim().toLowerCase();

  switch (normalizedMimeType) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "audio/ogg":
      return ".ogg";
    case "audio/opus":
      return ".opus";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
    case "audio/aac":
      return ".m4a";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/amr":
      return ".amr";
    default:
      return ".bin";
  }
}

function buildDataUrl(buffer, mimeType) {
  const resolvedMimeType = String(mimeType || "").trim() || "application/octet-stream";
  return `data:${resolvedMimeType};base64,${buffer.toString("base64")}`;
}

async function fetchWhatsappMediaMetadata(mediaId, whatsappToken) {
  const response = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: {
      Authorization: `Bearer ${whatsappToken}`,
    },
  });

  return response.data || {};
}

async function downloadWhatsappMedia(mediaId, whatsappToken) {
  const metadata = await fetchWhatsappMediaMetadata(mediaId, whatsappToken);
  const mediaUrl = String(metadata?.url || "").trim();

  if (!mediaUrl) {
    throw new Error(`Meta no devolvio URL para el media ${mediaId}`);
  }

  const response = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    headers: {
      Authorization: `Bearer ${whatsappToken}`,
    },
  });

  return {
    buffer: Buffer.from(response.data),
    mimeType: String(metadata?.mime_type || response.headers?.["content-type"] || "").trim(),
  };
}

async function transcribeWhatsappAudioMessage(messageData, openai, whatsappToken) {
  const audioId = String(messageData?.audio?.id || "").trim();

  if (!audioId) {
    return null;
  }

  const { buffer, mimeType } = await downloadWhatsappMedia(audioId, whatsappToken);
  const extension = guessFileExtensionFromMimeType(mimeType);
  const transcription = await openai.audio.transcriptions.create({
    file: await OpenAI.toFile(buffer, `whatsapp-audio${extension}`, {
      type: mimeType || "application/octet-stream",
    }),
    model: "gpt-4o-mini-transcribe",
  });

  return String(transcription?.text || transcription || "").trim() || null;
}

async function buildIncomingMessageInput(messageData, openai, whatsappToken) {
  const messageType = getIncomingMessageType(messageData);

  switch (messageType) {
    case "text":
      return {
        messageType,
        userMessage: String(messageData?.text?.body || "").trim(),
      };
    case "image": {
      const caption = String(messageData?.image?.caption || "").trim();
      return {
        messageType,
        userMessage: caption
          ? `El cliente envio una foto por WhatsApp con este texto: "${caption}".`
          : "El cliente envio una foto por WhatsApp.",
      };
    }
    case "audio":
      try {
        const audioKind = messageData?.audio?.voice ? "audio de voz" : "audio";
        const transcription = await transcribeWhatsappAudioMessage(messageData, openai, whatsappToken);

        return {
          messageType,
          userMessage: transcription
            ? `El cliente envio un ${audioKind} por WhatsApp. Transcripcion aproximada: "${transcription}".`
            : `El cliente envio un ${audioKind} por WhatsApp, pero no se pudo transcribir con claridad. Responde de forma util y pedi que lo mande de nuevo o por escrito si hace falta.`,
        };
      } catch (error) {
        console.error("Error preparando audio entrante:", error.response?.data || error.message || error);
        return {
          messageType,
          userMessage:
            "El cliente envio un audio por WhatsApp, pero no se pudo procesar. Responde de forma util y pedi que lo mande de nuevo o por escrito si hace falta.",
        };
      }
    case "sticker":
      return {
        messageType,
        userMessage: "El cliente envio un sticker por WhatsApp.",
      };
    default:
      return {
        messageType,
        userMessage:
          "El cliente envio un mensaje de WhatsApp en un formato no textual. Responde de forma util y pedi que te lo mande por texto si necesitas mas detalle.",
      };
  }
}

async function processQualifiedLead(
  cliente,
  runtimeState,
  leadKey,
  from,
  data,
  contactProfile = null,
  knownLeadSnapshot = null
) {
  runtimeState.leadsEnviados.add(leadKey);
  const leadEmail = cliente.leadEmail || DEFAULT_LEAD_EMAIL;
  const resolvedName = String(data.nombre || knownLeadSnapshot?.confirmedName || "").trim() || "No informado";
  const resolvedPhone =
    String(data.telefono || knownLeadSnapshot?.confirmedPhone || from || "").trim() || "No informado";
  const resolvedContactPreference =
    String(data.preferencia_contacto || knownLeadSnapshot?.contactPreference || "").trim() || "No informada";
  const contactName = String(contactProfile?.profileName || "").trim() || null;
  updateKnownContactState(runtimeState, from, {
    profileName: contactName,
    confirmedName: resolvedName !== "No informado" ? resolvedName : null,
    confirmedPhone: resolvedPhone,
    contactPreference: resolvedContactPreference !== "No informada" ? resolvedContactPreference : null,
    leadInterest: data.interes || null,
    leadSentAt: new Date().toISOString(),
  });

  persistLeadEvent({
    clientId: cliente.id,
    businessName: cliente.businessName || cliente.nombre || "NEXORA",
    toEmail: leadEmail,
    from,
    contactName,
    nombre: resolvedName,
    telefono: resolvedPhone,
    whatsappOrigen: from || "No informado",
    interes: data.interes || "Interesado",
    presupuesto: data.presupuesto || "No informado",
    preferenciaContacto: resolvedContactPreference,
  });

  await guardarLead(
    resolvedName,
    resolvedPhone,
    cliente.nombre || "Pendiente",
    data.interes || "Interesado"
  );

  await enviarEmailLead(
    cliente,
    leadEmail,
    resolvedName,
    resolvedPhone,
    data.interes || "Interesado",
    data.presupuesto || "No informado",
    resolvedContactPreference,
    from,
    contactName
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
  const from = messageData.from;
  const messageType = getIncomingMessageType(messageData);
  const previewText = buildIncomingMessagePreview(messageData, messageType);
  const phoneNumberId = value?.metadata?.phone_number_id;
  const cliente = getCliente(phoneNumberId);

  if (!cliente) {
    logWebhookEvent({
      type: "incoming",
      phoneNumberId,
      clientId: null,
      from,
      messageId,
      text: previewText,
      messageType,
      contactName: extractInboundContactProfile(value, from)?.profileName || null,
    });
    console.log("Cliente no configurado para phoneNumberId:", phoneNumberId);
    return;
  }

  const runtimeState = getClientRuntimeState(cliente.id);
  const contactProfile =
    rememberContactProfile(runtimeState, extractInboundContactProfile(value, from)) ||
    getKnownContactProfile(runtimeState, from);
  const knownLeadSnapshot = getKnownLeadSnapshot(runtimeState, from);
  const processedMessageKey = `${cliente.id}:${messageId}`;

  logWebhookEvent({
    type: "incoming",
    phoneNumberId,
    clientId: cliente.id,
    from,
    messageId,
    text: previewText,
    messageType,
    contactName: contactProfile?.profileName || null,
  });

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

  const incomingMessage = await buildIncomingMessageInput(messageData, openai, whatsappToken);
  const mensaje = String(incomingMessage?.userMessage || "").trim();
  const currentDate = new Date();
  const pastDateReference = detectPastDateReference(mensaje, currentDate);

  if (!mensaje) {
    console.log("Mensaje entrante sin contenido procesable:", messageType);
    return;
  }

  const historial = getConversationHistory(runtimeState, from);
  const hasAssistantHistory = historial.some((item) => item.role === "assistant");

  if (isUnsupportedMediaMessage(messageType, mensaje)) {
    const mediaReply = buildUnsupportedMediaReply(inferUnsupportedMediaReplyType(messageType, mensaje));

    historial.push({ role: "user", content: mensaje });
    historial.push({ role: "assistant", content: mediaReply });

    if (historial.length > 6) {
      runtimeState.historialPorContacto.set(from, historial.slice(-6));
    }

    await responderWhatsapp(phoneNumberId, from, mediaReply, whatsappToken);

    logWebhookEvent({
      type: "outgoing",
      phoneNumberId,
      clientId: cliente.id,
      from,
      messageId,
      text: mediaReply,
      messageType,
      contactName: contactProfile?.profileName || null,
    });

    return;
  }

  if (!hasAssistantHistory && looksLikeGreetingOnly(mensaje)) {
    const greetingReply = buildSimpleGreetingReply(cliente);

    historial.push({ role: "user", content: mensaje });
    historial.push({ role: "assistant", content: greetingReply });

    if (historial.length > 6) {
      runtimeState.historialPorContacto.set(from, historial.slice(-6));
    }

    await responderWhatsapp(phoneNumberId, from, greetingReply, whatsappToken);

    logWebhookEvent({
      type: "outgoing",
      phoneNumberId,
      clientId: cliente.id,
      from,
      messageId,
      text: greetingReply,
      messageType,
      contactName: contactProfile?.profileName || null,
    });

    return;
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: buildSystemPrompt(cliente, config, {
          hasAssistantHistory,
          currentDate,
          pastDateReference,
          knownLeadSnapshot,
        }),
      },
      ...historial,
      { role: "user", content: mensaje },
    ],
  });

  const respuestaCruda = response.choices[0]?.message?.content || "";
  const emptyLeadData = {
    mensaje: respuestaCruda,
    lead_calificado: false,
    nombre: null,
    telefono: null,
    preferencia_contacto: null,
    interes: null,
    presupuesto: null,
  };
  let data = { ...emptyLeadData };

  try {
    const parsedData = JSON.parse(respuestaCruda);
    data = {
      ...emptyLeadData,
      ...parsedData,
      mensaje: parsedData?.mensaje || respuestaCruda || "Perfecto, contame un poco mas y te ayudo.",
      lead_calificado: Boolean(parsedData?.lead_calificado),
      nombre: parsedData?.nombre || null,
      telefono: parsedData?.telefono || null,
      preferencia_contacto: parsedData?.preferencia_contacto || null,
      interes: parsedData?.interes || null,
      presupuesto: parsedData?.presupuesto || null,
    };
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
          preferencia_contacto: jsonExtraido.preferencia_contacto || null,
          interes: jsonExtraido.interes || null,
          presupuesto: jsonExtraido.presupuesto || null,
        };
      } catch {
        data = {
          ...emptyLeadData,
          mensaje:
            respuestaCruda.replace(/\{[\s\S]*\}/, "").trim() ||
            "Perfecto, contame un poco mas y te ayudo.",
        };
      }
    }
  }

  data = enrichLeadData(cliente, mensaje, data, historial);
  const meetingRequested = mentionsMeetingIntent(mensaje, data?.mensaje, data?.interes);
  const meetingLabel = inferMeetingLabel(mensaje, data?.interes, data?.mensaje);
  const hasMeetingContactReady =
    meetingRequested &&
    (hasLeadContactData(data) ||
      (Boolean(String(knownLeadSnapshot?.confirmedName || "").trim()) &&
        Boolean(String(knownLeadSnapshot?.confirmedPhone || "").trim())));

  if (meetingRequested && shouldReplaceLeadInterest(data?.interes)) {
    data.interes = `Solicitud de ${meetingLabel}`;
  }

  const hasPastSchedulingConflict =
    Boolean(pastDateReference) &&
    mentionsSchedulingIntent(mensaje, data?.mensaje, data?.interes, data?.presupuesto);

  if (hasPastSchedulingConflict) {
    data.lead_calificado = false;
    data.mensaje = buildPastDateReply(pastDateReference);
  }

  if (meetingRequested && isMeetingRefusal(data?.mensaje || "")) {
    data.mensaje = buildMeetingLeadReply(data, knownLeadSnapshot, mensaje, data?.interes, data?.mensaje);
  }

  if (hasForbiddenSensitiveDataRequest(data?.mensaje || "")) {
    data.mensaje = buildSafeLeadContinuationReply(
      data,
      knownLeadSnapshot,
      meetingRequested,
      mensaje,
      data?.interes,
      data?.mensaje
    );
  }

  if (meetingRequested && !hasPastSchedulingConflict) {
    data.mensaje = buildMeetingLeadReply(data, knownLeadSnapshot, mensaje, data?.interes, data?.mensaje);
  }

  if (hasUnsupportedOperationalClaim(data?.mensaje || "")) {
    data.mensaje = buildSafeLeadContinuationReply(
      data,
      knownLeadSnapshot,
      meetingRequested,
      mensaje,
      data?.interes,
      data?.mensaje
    );
  }

  data.lead_calificado = hasPastSchedulingConflict
    ? false
    : (Boolean(data.lead_calificado) && hasLeadContactData(data)) ||
      looksLikeQualifiedLead(mensaje, data, data.mensaje || "Perfecto, contame un poco mas y te ayudo.");

  if (!hasPastSchedulingConflict && hasMeetingContactReady) {
    data.lead_calificado = true;
  }
  const isPostLeadAcknowledgement = looksLikePostLeadAcknowledgement(mensaje, knownLeadSnapshot);

  if (isPostLeadAcknowledgement) {
    data.lead_calificado = false;
    data.mensaje = "Perfecto, en breve te contactan para seguir.";
  }

  const isFarewell = looksLikeFarewellMessage(mensaje);
  const rawReply = isFarewell
    ? buildFarewellReply(data)
    : data.lead_calificado
      ? buildQualifiedLeadReply(cliente, data, { knownLeadSnapshot, meetingRequested, meetingLabel })
      : data.mensaje || "Perfecto, contame un poco mas y te ayudo.";
  const mensajeFinal = sanitizeRepeatedLeadCapture(
    formatPlanReply(normalizeAssistantTone(sanitizeAssistantReply(rawReply)), cliente),
    knownLeadSnapshot
  );
  const leadKey = buildLeadDispatchKey(cliente.id, from, data?.interes);

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
    messageType,
    contactName: contactProfile?.profileName || null,
  });

  if (data.lead_calificado && !runtimeState.leadsEnviados.has(leadKey)) {
    processQualifiedLead(cliente, runtimeState, leadKey, from, data, contactProfile, knownLeadSnapshot).catch(
      (error) => {
        console.error("Error procesando lead:", error.response?.data || error.message || error);
      }
    );
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
