"use strict";
// Local stand-in for Vercel: serves index.html and runs the REAL api/ai.js.
// Upstream AI providers are mocked by replacing global fetch inside this process.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const handler = require("../api/ai.js");
handler._internals.LIMITS.rateMax = 1e9; // UI tests make many calls; rate limiting is covered by proxy.test.js

const log = []; // sanitized record of upstream calls (keys are never stored)
const MODELS = {
  "api.openai.com": ["gpt-4o-mini", "gpt-5-mini", "text-embedding-3-small", "whisper-1", "o-reasoner"],
  "api.groq.com": ["llama-3.3-70b-versatile", "whisper-large-v3"],
  "integrate.api.nvidia.com": ["meta/llama-3.3-70b-instruct", "nvidia/nv-embed-v1"],
  "api.featherless.ai": ["Qwen/Qwen2.5-7B-Instruct"],
  "openrouter.ai": ["anthropic/claude-sonnet-x", "openai/gpt-4o-mini"],
  "generativelanguage.googleapis.com": ["models/gemini-2.5-flash", "models/text-embedding-004"],
};
const ANTH = Array.from({ length: 25 }, (_, i) => "claude-model-" + String(i).padStart(2, "0")).concat(["claude-sonnet-test"]);
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

let scanMode = "normal";
function scanAnswer(userText) {
  if (scanMode === "garbage") return "I think the code is fine, nothing to see here, good job team!! ".repeat(3);
  if (scanMode === "none") return "[[NO_FINDINGS]]";
  const m = userText.match(/^File: (\S+)/);
  const file = m ? m[1] : "";
  if (file === "src/cart.js") return `Here are my findings:
[[FINDING]]
title: Off-by-one in loop reads past the end of the array
status: confirmed
severity: high
category: logic
confidence: high
lines: 3-3
explanation: The loop condition uses <= so the last iteration indexes items[items.length], which is undefined, and items[i].price throws a TypeError.
impact: total() crashes for every non-empty cart.
fix_summary: Use < instead of <=.
[[EVIDENCE]]
3| for (let i = 0; i <= items.length; i++) {
[[/EVIDENCE]]
[[ORIGINAL]]
for (let i = 0; i <= items.length; i++) {
[[/ORIGINAL]]
[[FIXED]]
for (let i = 0; i < items.length; i++) {
[[/FIXED]]
[[TEST]]
// jest
const { total } = require("./cart");
test("sums prices", () => expect(total([{price:1},{price:2}])).toBe(3));
[[/TEST]]
[[/FINDING]]
[[FINDING]]
title: Hallucinated confirmed bug
status: confirmed
severity: critical
category: security
confidence: high
lines: 40-41
explanation: This quote does not exist in the file.
impact: none
fix_summary: none
[[EVIDENCE]]
db.query("DROP TABLE users" + input)
[[/EVIDENCE]]
[[ORIGINAL]]
db.query("DROP TABLE users" + input)
[[/ORIGINAL]]
[[FIXED]]
db.query("DROP TABLE users")
[[/FIXED]]
[[/FINDING]]
[[FINDING]]
title: Missing validation of price type
status: suspected
severity: low
category: other
confidence: low
lines: 4-4
explanation: price may be a string at runtime.
impact: string concatenation instead of addition.
fix_summary: coerce with Number().
[[EVIDENCE]]
sum += items[i].price;
[[/EVIDENCE]]
[[ORIGINAL]]
this line is not in the file
[[/ORIGINAL]]
[[FIXED]]
sum += Number(items[i].price);
[[/FIXED]]
[[/FINDING]]`;
  if (file === "src/legacy.py") return `[[FINDING]]
title: Division by zero when count is 0
status: confirmed
severity: medium
category: logic
confidence: high
lines: 4-4
explanation: average divides by len(values) without checking for an empty list.
impact: ZeroDivisionError.
fix_summary: Return 0 for empty input.
[[EVIDENCE]]
    return sum(values) / len(values)
[[/EVIDENCE]]
[[ORIGINAL]]
    return sum(values) / len(values)
[[/ORIGINAL]]
[[FIXED]]
    return sum(values) / len(values) if values else 0
[[/FIXED]]
[[/FINDING]]`;
  return "[[NO_FINDINGS]]";
}

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const auth = String((opts.headers || {}).authorization || (opts.headers || {})["x-api-key"] || "").replace(/^Bearer\s+/i, "");
  const entry = { host: u.host, path: u.pathname + u.search, method: opts.method, redirect: opts.redirect, keyPrefix: auth.slice(0, 6), hadAuth: !!auth, headers: Object.keys(opts.headers || {}) };
  let body = null; try { body = opts.body ? JSON.parse(opts.body) : null; } catch {}
  if (body) entry.body = { model: body.model, keys: Object.keys(body) };
  log.push(entry);
  if (auth.startsWith("bad-key")) return json({ error: { message: "Incorrect API key provided: " + auth } }, 401);
  if (auth === "html-fail") return new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
  if (u.pathname.endsWith("/models")) {
    if (u.host === "api.anthropic.com") {
      const after = u.searchParams.get("after_id");
      const lim = Math.min(+u.searchParams.get("limit") || 20, 1000);
      // Simulate real behaviour: tiny default page; honour limit up to 20 per page to exercise pagination
      const page = 20; const startIdx = after ? ANTH.indexOf(after) + 1 : 0;
      const slice = ANTH.slice(startIdx, startIdx + Math.min(page, lim));
      return json({ data: slice.map((id) => ({ id })), has_more: startIdx + slice.length < ANTH.length, last_id: slice[slice.length - 1] });
    }
    return json({ data: (MODELS[u.host] || ["mock-model"]).map((id) => ({ id })) });
  }
  // chat
  const model = body && body.model;
  if (auth === "primary-fail") return json({ error: { message: "Service unavailable" } }, 503);
  if (model === "retired-model") return json({ error: { message: "The model `retired-model` does not exist" } }, 404);
  if (model === "o-reasoner" && body.max_tokens !== undefined) return json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }, 400);
  if (model === "o-reasoner" && body.temperature !== undefined) return json({ error: { message: "Unsupported value: 'temperature' does not support 0.25 with this model." } }, 400);
  const msgs = body.messages || [];
  const system = msgs.filter((m) => m.role === "system").map((m) => m.content).join("\n") + (body.system || "");
  const userText = String((msgs.filter((m) => m.role === "user").pop() || {}).content || "");
  let text;
  if (/meticulous senior code reviewer/.test(system)) text = scanAnswer(userText);
  else if (/Mermaid flowchart/.test(system)) text = "flowchart LR\n  A[\"Client\"] --> B[\"API\"]";
  else if (/reverse-prompt engineer/.test(system)) text = "# AI build prompt\nBuild it.";
  else if (/Reply with the single word/.test(userText)) text = "ready";
  else text = "**Mock answer** to: " + userText.slice(0, 80) + "\n\n- uses `src/cart.js`\n\n```js\nconsole.log(1)\n```";
  if (u.host === "api.anthropic.com") return json({ content: [{ type: "text", text }] });
  return json({ choices: [{ message: { content: text }, finish_reason: "stop" }] });
};

function start(port = 0) {
  const indexPath = path.join(__dirname, "..", "index.html");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/__log") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(log)); }
    if (url.pathname === "/__reset") { log.length = 0; scanMode = url.searchParams.get("scan") || "normal"; return res.end("ok"); }
    if (url.pathname === "/api/ai") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        if (/application\/json/.test(req.headers["content-type"] || "")) { try { req.body = JSON.parse(raw); } catch { req.body = raw; } } else req.body = raw;
        Promise.resolve(handler(req, res)).catch((e) => { res.statusCode = 500; res.end("crash " + e.message); });
      });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      // apply the same headers vercel.json would set
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
      for (const h of cfg.headers[0].headers) res.setHeader(h.key, h.value);
      return res.end(fs.readFileSync(indexPath));
    }
    res.statusCode = 404; res.end("not found");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}
module.exports = { start, log };
if (require.main === module) start(+process.env.PORT || 3000).then(({ port }) => console.log("http://127.0.0.1:" + port));
