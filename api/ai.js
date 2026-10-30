"use strict";
/**
 * RepoPilot AI proxy — Vercel serverless function (Node, CommonJS).
 *
 * Purpose: let the browser talk to AI providers that do not send CORS headers.
 * The browser sends {url, method, headers, body}; this function validates the
 * target and relays it. It only works where Vercel (or `vercel dev`) executes it:
 * plain static hosting (GitHub Pages, python -m http.server, file:// or content://
 * previews) cannot run this file.
 *
 * Security model
 *  - Only known provider hosts + exact API paths are reachable (see PROVIDERS).
 *  - Extra hosts can be allowed by the deployer with the RP_EXTRA_HOSTS env var
 *    (comma-separated hostnames). Private/loopback/link-local targets are always refused.
 *  - Same-origin only: the Origin header must match this deployment (or RP_ALLOWED_ORIGINS).
 *    This stops other websites from using a visitor's browser to reach the proxy. It is
 *    NOT authentication: a non-browser client can forge headers. Abuse is limited because
 *    the proxy never adds credentials, only relays the caller's own key, to a fixed host list.
 *  - Redirects are never followed. Requests have a timeout and size caps.
 *  - API keys are relayed in memory only: never logged, stored, or echoed back
 *    (any occurrence in an upstream response body is redacted).
 *  - Best-effort in-memory rate limit per client IP (per warm instance).
 */
const dns = require("node:dns").promises;
const net = require("node:net");

const OPENAI_STYLE = ["/models", "/chat/completions"];
const mk = (prefix, tail) => tail.map((t) => prefix + t);
const PROVIDERS = {
  "api.openai.com": mk("/v1", OPENAI_STYLE),
  "integrate.api.nvidia.com": mk("/v1", OPENAI_STYLE),
  "api.groq.com": mk("/openai/v1", OPENAI_STYLE),
  "api.featherless.ai": mk("/v1", OPENAI_STYLE),
  "openrouter.ai": mk("/api/v1", OPENAI_STYLE),
  "generativelanguage.googleapis.com": mk("/v1beta/openai", OPENAI_STYLE),
  "api.anthropic.com": ["/v1/models", "/v1/messages"],
};
// Paths accepted for hosts added through RP_EXTRA_HOSTS (OpenAI-compatible or Anthropic-style).
const EXTRA_PATH_RE = /^(\/[A-Za-z0-9._~-]+){0,4}\/(models|chat\/completions|messages)$/;

const ALLOWED_REQUEST_HEADERS = new Set([
  "authorization", "content-type", "x-api-key", "anthropic-version",
  "anthropic-beta", "x-goog-api-key", "http-referer", "x-title",
]);
const MODEL_QUERY_KEYS = new Set(["limit", "after_id", "before_id"]);

const LIMITS = {
  maxRequestBytes: 2 * 1024 * 1024,
  maxBodyChars: 1_500_000,
  maxResponseBytes: 4 * 1024 * 1024, // Vercel caps function responses at ~4.5 MB
  slimModelsAbove: 1_500_000,
  upstreamTimeoutMs: 55_000,
  rateWindowMs: 60_000,
  rateMax: 90,
};

const rate = new Map();
function rateLimited(ip, now = Date.now()) {
  const hits = (rate.get(ip) || []).filter((t) => now - t < LIMITS.rateWindowMs);
  hits.push(now);
  rate.set(ip, hits);
  if (rate.size > 5000) for (const [k, v] of rate) if (!v.length || now - v[v.length - 1] > LIMITS.rateWindowMs) rate.delete(k);
  return hits.length > LIMITS.rateMax;
}

function send(res, status, obj, source = "proxy") {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-RepoPilot-Source", source);
  res.end(JSON.stringify(obj));
}
const fail = (res, status, code, message) => send(res, status, { error: { code, message } });

function extraHosts() {
  return new Set(String(process.env.RP_EXTRA_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}
function allowedOrigins(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
  const set = new Set(String(process.env.RP_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().toLowerCase().replace(/\/$/, "")).filter(Boolean));
  if (host) { set.add("https://" + host); set.add("http://" + host); }
  return set;
}

function isPrivateAddress(addr) {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224;
  }
  if (net.isIPv6(addr)) {
    const v = addr.toLowerCase();
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff");
  }
  return true;
}

function validateTarget(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch { return { error: "Invalid provider URL." }; }
  if (u.protocol !== "https:") return { error: "Only https:// provider URLs are allowed." };
  if (u.username || u.password) return { error: "Credentials in URLs are not allowed." };
  if (u.port && u.port !== "443") return { error: "Custom ports are not allowed." };
  if (u.hash) return { error: "URL fragments are not allowed." };
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, "");
  let known = Object.prototype.hasOwnProperty.call(PROVIDERS, host);
  let extra = false;
  if (known) {
    if (!PROVIDERS[host].includes(path)) return { error: "Unsupported API path for this provider.", code: "path_not_allowed" };
  } else if (extraHosts().has(host)) {
    extra = true;
    if (net.isIP(host) || !host.includes(".") || /\.(local|internal|localhost|lan|home)$/.test(host)) return { error: "Host is not allowed.", code: "host_not_allowed" };
    if (!EXTRA_PATH_RE.test(path)) return { error: "Unsupported API path.", code: "path_not_allowed" };
  } else {
    return { error: "This provider host is not allowed by the proxy. Add it to RP_EXTRA_HOSTS on your deployment, or use a supported provider.", code: "host_not_allowed" };
  }
  // Query strings: only pagination on model listings.
  const isModels = path.endsWith("/models");
  for (const [k, v] of u.searchParams) {
    if (!isModels || !MODEL_QUERY_KEYS.has(k) || !/^[A-Za-z0-9_-]{1,200}$/.test(v)) return { error: "Query parameters are not allowed here.", code: "query_not_allowed" };
  }
  const url = "https://" + host + path + (u.search || "");
  return { url, host, path, isModels, extra };
}

function cleanHeaders(input) {
  const out = {};
  for (const [name, value] of Object.entries(input && typeof input === "object" ? input : {})) {
    const key = name.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(key)) continue;
    if (typeof value !== "string" || value.length > 4096 || /[\r\n\0]/.test(value)) continue;
    out[key] = value;
  }
  return out;
}

function redact(text, secrets) {
  let t = text;
  for (const s of secrets) if (s && s.length >= 8) t = t.split(s).join("[redacted]");
  return t;
}

async function handler(req, res) {
  res.setHeader("X-RepoPilot-Proxy", "1");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "GET") {
    return send(res, 200, { ok: true, service: "repopilot-proxy", version: 2, extraHosts: extraHosts().size });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return fail(res, 405, "method_not_allowed", "Method not allowed.");
  }

  const origin = String(req.headers.origin || "").toLowerCase().replace(/\/$/, "");
  if (!origin || !allowedOrigins(req).has(origin)) {
    return fail(res, 403, "origin_not_allowed", "Requests must come from this site's own pages.");
  }
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) {
    return fail(res, 415, "bad_content_type", "Content-Type must be application/json.");
  }
  if (Number(req.headers["content-length"] || 0) > LIMITS.maxRequestBytes) {
    return fail(res, 413, "too_large", "Request is too large.");
  }
  const ip = String(req.headers["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "?").split(",")[0].trim();
  if (rateLimited(ip)) {
    res.setHeader("Retry-After", "30");
    return fail(res, 429, "rate_limited", "Too many requests through the proxy. Wait a moment and retry.");
  }

  const payload = req.body && typeof req.body === "object" ? req.body : null;
  if (!payload) return fail(res, 400, "bad_request", "Expected a JSON object body.");

  const target = validateTarget(payload.url);
  if (target.error) return fail(res, 400, target.code || "bad_target", target.error);

  const method = payload.method === "GET" ? "GET" : "POST";
  if (target.isModels && method !== "GET") return fail(res, 400, "bad_method", "Model lists must be fetched with GET.");
  if (!target.isModels && method !== "POST") return fail(res, 400, "bad_method", "This endpoint requires POST.");
  if (method === "POST" && (typeof payload.body !== "string" || payload.body.length > LIMITS.maxBodyChars)) {
    return fail(res, 400, "bad_body", "Request body must be a JSON string within the size limit.");
  }

  const headers = cleanHeaders(payload.headers);
  headers.accept = "application/json";
  if (method === "POST") headers["content-type"] = "application/json";
  const secrets = [headers["x-api-key"], headers["x-goog-api-key"], String(headers.authorization || "").replace(/^Bearer\s+/i, "")];

  if (target.extra) {
    try {
      const addrs = await dns.lookup(target.host, { all: true });
      if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
        return fail(res, 400, "host_not_allowed", "Host resolves to a private address and is blocked.");
      }
    } catch {
      return fail(res, 502, "dns_failed", "Could not resolve the provider host.");
    }
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIMITS.upstreamTimeoutMs);
  try {
    const upstream = await fetch(target.url, {
      method, headers, redirect: "manual", signal: ctl.signal,
      ...(method === "POST" ? { body: payload.body } : {}),
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      return fail(res, 502, "redirect_blocked", "The provider tried to redirect the request, which the proxy does not follow.");
    }
    let text = redact(await upstream.text(), secrets);
    const type = String(upstream.headers.get("content-type") || "");
    if (target.isModels && upstream.ok && text.length > LIMITS.slimModelsAbove) {
      try {
        const j = JSON.parse(text);
        const rows = Array.isArray(j) ? j : Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
        const slim = { data: rows.map((m) => (typeof m === "string" ? { id: m } : { id: m.id || m.name || m.model })).filter((m) => m.id) };
        for (const k of ["has_more", "last_id", "first_id"]) if (j[k] !== undefined) slim[k] = j[k];
        text = JSON.stringify(slim);
      } catch { /* fall through to size check */ }
    }
    if (Buffer.byteLength(text) > LIMITS.maxResponseBytes) {
      return fail(res, 502, "response_too_large", "The provider response is too large to relay. Type the model ID manually instead.");
    }
    if (/json/i.test(type)) {
      res.statusCode = upstream.status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("X-RepoPilot-Source", "upstream");
      return res.end(text);
    }
    // Non-JSON upstream bodies (HTML error pages, plain text) are wrapped, never relayed raw.
    const status = upstream.ok ? 502 : upstream.status;
    return send(res, status, { error: { code: "upstream_non_json", message: "Provider returned a non-JSON response (HTTP " + upstream.status + ").", detail: text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) } }, "upstream");
  } catch (err) {
    if (err && err.name === "AbortError") return fail(res, 504, "upstream_timeout", "The provider did not answer in time.");
    return fail(res, 502, "upstream_unreachable", "Could not reach the provider from the proxy.");
  } finally {
    clearTimeout(timer);
  }
}

module.exports = handler;
module.exports._internals = { validateTarget, cleanHeaders, isPrivateAddress, redact, PROVIDERS, LIMITS, rate };
