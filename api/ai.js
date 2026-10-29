// Vercel serverless proxy for RepoPilot provider requests.
// Does not persist API keys. Requests are forwarded only to supported AI provider hosts.
const ALLOWED_HOSTS = new Set([
  "integrate.api.nvidia.com", "api.openai.com", "api.groq.com",
  "api.featherless.ai", "openrouter.ai",
  "generativelanguage.googleapis.com", "api.anthropic.com"
]);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { message: "Method not allowed" } });
  }
  try {
    const payload = req.body || {};
    const target = new URL(String(payload.url || ""));
    if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname))
      return res.status(400).json({ error: { message: "Unsupported provider URL. Check provider settings." } });
    const allowedPaths = ["/v1/models", "/v1/chat/completions", "/v1/messages", "/v1beta/openai/models"];
    if (!allowedPaths.includes(target.pathname))
      return res.status(400).json({ error: { message: "Unsupported API path." } });

    const headers = { "Accept": "application/json" };
    for (const [key, value] of Object.entries(payload.headers || {})) {
      if (["authorization", "content-type", "x-api-key", "anthropic-version", "anthropic-dangerous-direct-browser-access"].includes(key.toLowerCase())
          && typeof value === "string" && value.length < 12000) headers[key] = value;
    }
    const method = payload.method === "GET" ? "GET" : "POST";
    const upstream = await fetch(target.toString(), {
      method, headers,
      ...(method === "POST" && typeof payload.body === "string" ? { body: payload.body } : {})
    });
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.send(body);
  } catch (_) {
    return res.status(400).json({ error: { message: "Proxy request failed. Check provider settings and connectivity." } });
  }
};
