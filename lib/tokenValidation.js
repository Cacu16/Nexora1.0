function isMetaAccessToken(value) {
  return /^EAA[A-Za-z0-9]/.test(String(value || "").trim());
}

function isVerifyToken(value) {
  return /^nexora_/i.test(String(value || "").trim());
}

function assertValidClientWhatsappToken(value) {
  const token = String(value || "").trim();

  if (!token) {
    return token;
  }

  if (isVerifyToken(token)) {
    throw new Error(
      "El WhatsApp Token del cliente no puede ser `nexora_...`. Ahi va el token `EAAG...` o `EAAX...` que entrega Meta."
    );
  }

  return token;
}

function assertValidWebhookVerifyToken(value) {
  const token = String(value || "").trim();

  if (!token) {
    return token;
  }

  if (isMetaAccessToken(token)) {
    throw new Error(
      "El Webhook Verify Token global no puede ser un token `EAAG...` o `EAAX...` de Meta."
    );
  }

  return token;
}

module.exports = {
  assertValidClientWhatsappToken,
  assertValidWebhookVerifyToken,
  isMetaAccessToken,
  isVerifyToken,
};
