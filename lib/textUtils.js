const MOJIBAKE_PATTERN = /(Ãƒ.|Ã‚.|Ã¢.|Ã°Å¸|ï¿½)/;

function stripBom(value) {
  return String(value || "").replace(/^\uFEFF/, "");
}

function countMojibake(value) {
  const matches = String(value || "").match(/(Ãƒ.|Ã‚.|Ã¢.|Ã°Å¸|ï¿½)/g);
  return matches ? matches.length : 0;
}

function repairMojibake(value) {
  let result = String(value || "");

  for (let index = 0; index < 3; index += 1) {
    if (!MOJIBAKE_PATTERN.test(result)) {
      break;
    }

    const candidate = Buffer.from(result, "latin1").toString("utf8");

    if (countMojibake(candidate) >= countMojibake(result)) {
      break;
    }

    result = candidate;
  }

  return result;
}

function normalizeText(value) {
  return repairMojibake(stripBom(String(value || "")));
}

function normalizeDeep(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeDeep);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, normalizeDeep(entryValue)])
    );
  }

  if (typeof value === "string") {
    return normalizeText(value);
  }

  return value;
}

module.exports = {
  normalizeDeep,
  normalizeText,
  stripBom,
};
