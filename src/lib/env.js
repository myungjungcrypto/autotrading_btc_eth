import { existsSync, readFileSync } from "node:fs";

export function loadEnvFile(path = ".env") {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function envString(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

export function envNumber(name, fallback, opts = {}) {
  const raw = envString(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number for ${name}: ${raw}`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new Error(`${name} must be >= ${opts.min}`);
  }
  return value;
}

export function envBool(name, fallback = false) {
  const raw = envString(name, String(fallback)).toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

export function envList(name, fallback = []) {
  const raw = envString(name, fallback.join(","));
  return raw
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}
