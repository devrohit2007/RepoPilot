"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/ai.js");
const { validateTarget, isPrivateAddress, LIMITS, rate } = handler._internals;

function mockRes() {
  const r = { statusCode: 200, headers: {}, body: "" };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { r.body = b || ""; r.done = true; };
  return r;
}
const req = (over = {}) => ({
  method: "POST",
  headers: { host: "app.example.com", origin: "https://app.example.com", "content-type": "application/json", "x-forwarded-for": "1.1.1.1" },
  body: {}, ...over,
});
async function call(body, over = {}) {
  const r = mockRes();
  const q = req({ ...over, body });
  if (over.headers) q.headers = { ...req().headers, ...over.headers };
  await handler(q, r);
  let json = null; try { json = JSON.parse(r.body); } catch {}
  return { r, json };
}
function stubFetch(fn) { const o = global.fetch; global.fetch = fn; return () => { global.fetch = o; }; }
const okJson = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
test.beforeEach(() => rate.clear());

test("GET is a health check with proxy header", async () => {
  const r = mockRes(); await handler({ method: "GET", headers: {} }, r);
  assert.equal(r.statusCode, 200); assert.equal(r.headers["x-repopilot-proxy"], "1");
});
test("other methods rejected", async () => {
  const r = mockRes(); await handler({ method: "PUT", headers: {} }, r);
  assert.equal(r.statusCode, 405);
});

test("every supported provider path validates", () => {
  const ok = [
    "https://api.openai.com/v1/models", "https://api.openai.com/v1/chat/completions",
    "https://integrate.api.nvidia.com/v1/models", "https://integrate.api.nvidia.com/v1/chat/completions",
    "https://api.groq.com/openai/v1/models", "https://api.groq.com/openai/v1/chat/completions",
    "https://api.featherless.ai/v1/models", "https://api.featherless.ai/v1/chat/completions",
    "https://openrouter.ai/api/v1/models", "https://openrouter.ai/api/v1/chat/completions",
    "https://generativelanguage.googleapis.com/v1beta/openai/models", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    "https://api.anthropic.com/v1/models?limit=1000", "https://api.anthropic.com/v1/messages",
    "https://API.OPENAI.COM/v1/models/",
  ];
  for (const u of ok) assert.ok(!validateTarget(u).error, u + " -> " + validateTarget(u).error);
});

test("SSRF / bypass attempts are rejected", () => {
  const bad = [
    "http://api.openai.com/v1/models", "https://api.openai.com:8443/v1/models",
    "https://api.openai.com@evil.com/v1/models", "https://evil.com#@api.openai.com/v1/models",
    "https://api.openai.com.evil.com/v1/models", "https://evil.com/api.openai.com/v1/models",
    "https://127.0.0.1/v1/models", "https://[::1]/v1/models", "https://169.254.169.254/latest/meta-data",
    "https://localhost/v1/models", "https://api.openai.com/v1/files", "https://api.openai.com/v1/../v1/files",
    "https://api.openai.com/v1/models?foo=1", "https://api.openai.com/v1/chat/completions?x=1",
    "https://api.anthropic.com/v1/chat/completions", "https://api.groq.com/v1/models",
    "https://user:pw@api.openai.com/v1/models", "https://api.openai.com/v1/models#x", "file:///etc/passwd", "", "not a url", null,
    "https://api.anthropic.com/v1/models?limit=1000&evil=1", "https://api.anthropic.com/v1/models?limit=../x",
  ];
  for (const u of bad) assert.ok(validateTarget(u).error, "should reject " + u);
});

test("private address detection", () => {
  for (const a of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.5.4", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) assert.ok(isPrivateAddress(a), a);
  for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.ok(!isPrivateAddress(a), a);
});

test("extra hosts only via env, never IPs or internal names", () => {
  assert.ok(validateTarget("https://api.together.xyz/v1/models").error);
  process.env.RP_EXTRA_HOSTS = "api.together.xyz, 127.0.0.1, foo.internal, intranet";
  try {
    assert.ok(!validateTarget("https://api.together.xyz/v1/chat/completions").error);
    assert.ok(validateTarget("https://api.together.xyz/v1/files").error);
    assert.ok(validateTarget("https://127.0.0.1/v1/models").error);
    assert.ok(validateTarget("https://foo.internal/v1/models").error);
    assert.ok(validateTarget("https://intranet/v1/models").error);
  } finally { delete process.env.RP_EXTRA_HOSTS; }
});

test("origin must match deployment", async () => {
  const body = { url: "https://api.openai.com/v1/models", method: "GET", headers: {} };
  assert.equal((await call(body, { headers: { origin: "https://evil.example" } })).r.statusCode, 403);
  const noOrigin = req({ body }); delete noOrigin.headers.origin;
  const r = mockRes(); await handler(noOrigin, r); assert.equal(r.statusCode, 403);
});
test("content-type and size enforced", async () => {
  assert.equal((await call({}, { headers: { "content-type": "text/plain" } })).r.statusCode, 415);
  assert.equal((await call({}, { headers: { "content-length": String(LIMITS.maxRequestBytes + 1) } })).r.statusCode, 413);
  assert.equal((await call(undefined)).r.statusCode, 400);
});

test("forwards allowed headers only, strips others and CRLF injection", async () => {
  let seen;
  const restore = stubFetch(async (url, opts) => { seen = { url, opts }; return okJson({ data: [{ id: "m1" }] }); });
  try {
    const { r } = await call({ url: "https://api.openai.com/v1/models", method: "GET", headers: {
      Authorization: "Bearer sk-test-12345678", Cookie: "a=b", "X-Forwarded-For": "6.6.6.6", Host: "evil", "x-api-key": "bad\r\nX-Evil: 1", "Content-Type": "application/json" } });
    assert.equal(r.statusCode, 200);
    assert.equal(seen.opts.headers.authorization, "Bearer sk-test-12345678");
    for (const k of ["cookie", "x-forwarded-for", "host", "x-api-key"]) assert.equal(seen.opts.headers[k], undefined, k);
    assert.equal(seen.opts.redirect, "manual");
    assert.equal(seen.opts.method, "GET");
    assert.equal(seen.opts.body, undefined);
  } finally { restore(); }
});

test("POST relays body, passes upstream status, marks source", async () => {
  let seen;
  const restore = stubFetch(async (url, opts) => { seen = { url, opts }; return okJson({ error: { message: "bad model" } }, 404); });
  try {
    const { r, json } = await call({ url: "https://api.groq.com/openai/v1/chat/completions", method: "POST", headers: { authorization: "Bearer gsk_abcdefgh1234" }, body: "{\"model\":\"x\"}" });
    assert.equal(r.statusCode, 404); assert.equal(r.headers["x-repopilot-source"], "upstream");
    assert.equal(json.error.message, "bad model");
    assert.equal(seen.opts.body, "{\"model\":\"x\"}"); assert.equal(seen.url, "https://api.groq.com/openai/v1/chat/completions");
  } finally { restore(); }
});

test("method/endpoint mismatch rejected", async () => {
  assert.equal((await call({ url: "https://api.openai.com/v1/models", method: "POST", body: "{}" })).r.statusCode, 400);
  assert.equal((await call({ url: "https://api.openai.com/v1/chat/completions", method: "GET" })).r.statusCode, 400);
  assert.equal((await call({ url: "https://api.openai.com/v1/chat/completions", method: "POST", body: { a: 1 } })).r.statusCode, 400);
});

test("API key echoed by upstream is redacted", async () => {
  const key = "sk-live-SECRETSECRET1234";
  const restore = stubFetch(async () => okJson({ error: { message: "Invalid key " + key + " for org" } }, 401));
  try {
    const { r } = await call({ url: "https://api.openai.com/v1/models", method: "GET", headers: { authorization: "Bearer " + key } });
    assert.equal(r.statusCode, 401); assert.ok(!r.body.includes(key)); assert.ok(r.body.includes("[redacted]"));
  } finally { restore(); }
});

test("keys are never written to console", async () => {
  const key = "sk-console-LEAKCHECK9999"; const logs = [];
  const orig = {}; for (const m of ["log", "info", "warn", "error", "debug"]) { orig[m] = console[m]; console[m] = (...a) => logs.push(a.join(" ")); }
  const restore = stubFetch(async () => { throw new Error("boom " + key); });
  try { await call({ url: "https://api.openai.com/v1/models", method: "GET", headers: { authorization: "Bearer " + key } }); }
  finally { restore(); for (const m in orig) console[m] = orig[m]; }
  assert.deepEqual(logs, []);
});

test("upstream network failure -> 502 without leaking error text", async () => {
  const key = "sk-net-ZZZZZZZZZZ12";
  const restore = stubFetch(async () => { throw new Error("connect ECONNREFUSED " + key); });
  try {
    const { r, json } = await call({ url: "https://api.openai.com/v1/models", method: "GET", headers: { authorization: "Bearer " + key } });
    assert.equal(r.statusCode, 502); assert.equal(json.error.code, "upstream_unreachable"); assert.ok(!r.body.includes(key));
  } finally { restore(); }
});

test("timeout -> 504", async () => {
  const saved = LIMITS.upstreamTimeoutMs; LIMITS.upstreamTimeoutMs = 30;
  const restore = stubFetch((url, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" })))));
  try { assert.equal((await call({ url: "https://api.openai.com/v1/models", method: "GET" })).r.statusCode, 504); }
  finally { restore(); LIMITS.upstreamTimeoutMs = saved; }
});

test("redirects are not followed", async () => {
  const restore = stubFetch(async () => new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } }));
  try { const { r, json } = await call({ url: "https://api.openai.com/v1/models", method: "GET" }); assert.equal(r.statusCode, 502); assert.equal(json.error.code, "redirect_blocked"); }
  finally { restore(); }
});

test("HTML upstream is wrapped as JSON, never relayed raw", async () => {
  const restore = stubFetch(async () => new Response("<html><script>alert(1)</script><body>Bad gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } }));
  try {
    const { r, json } = await call({ url: "https://api.openai.com/v1/models", method: "GET" });
    assert.match(r.headers["content-type"], /application\/json/); assert.equal(r.statusCode, 502);
    assert.equal(json.error.code, "upstream_non_json"); assert.ok(!json.error.detail.includes("<"));
  } finally { restore(); }
});

test("huge model lists are slimmed to ids", async () => {
  const rows = Array.from({ length: 6000 }, (_, i) => ({ id: "model-" + i, pad: "x".repeat(300) }));
  const restore = stubFetch(async () => okJson({ data: rows }));
  try {
    const { r, json } = await call({ url: "https://api.featherless.ai/v1/models", method: "GET" });
    assert.equal(r.statusCode, 200); assert.equal(json.data.length, 6000); assert.deepEqual(Object.keys(json.data[0]), ["id"]);
  } finally { restore(); }
});

test("rate limit kicks in", async () => {
  const restore = stubFetch(async () => okJson({ data: [] }));
  try {
    let last;
    for (let i = 0; i < LIMITS.rateMax + 2; i++) last = await call({ url: "https://api.openai.com/v1/models", method: "GET" });
    assert.equal(last.r.statusCode, 429);
  } finally { restore(); }
});
