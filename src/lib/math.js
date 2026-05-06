export function decimalToNumber(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value).trim();
  if (raw === "") return 0;
  if (raw.includes(".")) return Number(raw);
  if (!/^-?\d+$/.test(raw)) return Number(raw);
  const sign = raw.startsWith("-") ? -1 : 1;
  const digits = raw.replace("-", "");
  if (digits.length > 12) {
    const padded = digits.padStart(19, "0");
    const whole = padded.slice(0, -18) || "0";
    const frac = padded.slice(-18).replace(/0+$/, "");
    return sign * Number(`${whole}.${frac || "0"}`);
  }
  return Number(raw);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function bps(edge, referencePrice) {
  if (!referencePrice) return 0;
  return (edge / referencePrice) * 10000;
}

export function nowIso() {
  return new Date().toISOString();
}

export function startOfLocalDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
