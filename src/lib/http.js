export class HttpError extends Error {
  constructor(message, { status, body, url }) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export function withQuery(url, params = {}) {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) next.searchParams.append(key, String(item));
    } else {
      next.searchParams.set(key, String(value));
    }
  }
  return next.toString();
}

export async function requestJson(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 8000,
    retries = 2,
    retryDelayMs = 250,
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let payload = text;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }
      if (!res.ok) {
        throw new HttpError(`HTTP ${res.status} for ${url}`, {
          status: res.status,
          body: payload,
          url,
        });
      }
      return payload || {};
    } catch (err) {
      lastError = err;
      const retryable =
        err.name === "AbortError" ||
        err.status === 429 ||
        (typeof err.status === "number" && err.status >= 500);
      if (!retryable || attempt === retries) break;
      await sleep(retryDelayMs * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
