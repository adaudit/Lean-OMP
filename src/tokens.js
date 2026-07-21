import crypto from "node:crypto";

export function estimateTokens(value) {
  if (value === undefined || value === null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

export function digest(value, length = 20) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, length);
}
