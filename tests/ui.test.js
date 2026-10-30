"use strict";
// End-to-end UI test: real index.html + real api/ai.js, mocked GitHub / providers / CDN.
const { chromium } = require("playwright");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { start } = require("./dev-server.js");
const MERMAID = process.env.MERMAID_JS || "/opt/npm-tools/node_modules/mermaid/dist/mermaid.min.js";
const SHOTS = process.env.SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "rp-shots-"));

const FILES = {
  "README.md": "# Buggy App\nA demo shop.\n\n```bash\nnpm start\n```\n",
  "package.json": '{"name":"buggy-app","version":"1.0.0","scripts":{"start":"node src/app.js"}}\n',
  "src/cart.js": "function total(items) {\n  let sum = 0;\n  for (let i = 0; i <= items.length; i++) {\n    sum += items[i].price;\n  }\n  return sum;\n}\nmodule.exports = { total };\n",
  "src/legacy.py": "def average(values):\n    # compute average\n    total = 0\n    return sum(values) / len(values)",
  "src/server.py": 'import os\npassword = "hunter2hunter2xyz"\nresult = eval(user_input)\n',
  "src/app.js": "const el = document.getElementById('x');\nel.innerHTML = location.hash;\n",
  "config.json": '{"a": 1,}\n',
};
const results = []; let failed = 0;
const ok = (name, cond, extra = "") => { results.push((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  -> " + extra)); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mockWeb(page) {
  await page.route("https://api.github.com/**", (route) => {
    const u = new URL(route.request().url());
    if (/\/git\/trees\//.test(u.pathname)) return route.fulfill({ json: { truncated: false, tree: Object.entries(FILES).map(([p, c]) => ({ path: p, type: "blob", size: Buffer.byteLength(c), sha: "x" })).concat([{ path: "node_modules/x/index.js", type: "blob", size: 5 }, { path: "src", type: "tree" }]) } });
    if (/\/repos\/demo\/buggy-app$/.test(u.pathname)) return route.fulfill({ json: { full_name: "demo/buggy-app", html_url: "https://github.com/demo/buggy-app", description: "A deliberately buggy demo", default_branch: "main", stargazers_count: 1234, forks_count: 5, license: { spdx_id: "MIT" }, updated_at: "2026-10-01T00:00:00Z", private: false } });
    return route.fulfill({ status: 404, json: { message: "Not Found" } });
  });
  await page.route("https://raw.githubusercontent.com/**", (route) => {
    const p = decodeURIComponent(new URL(route.request().url()).pathname.split("/").slice(4).join("/"));
    return FILES[p] != null ? route.fulfill({ body: FILES[p], contentType: "text/plain" }) : route.fulfill({ status: 404, body: "no" });
  });
  await page.route("https://cdn.jsdelivr.net/npm/mermaid@*/dist/mermaid.min.js", (route) => route.fulfill({ body: fs.readFileSync(MERMAID), contentType: "application/javascript" }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ body: "", contentType: "text/css" }));
}
async function setKey(page, key, model) {
  await page.click('.nav-item[data-view="settings"]');
  await page.fill("#apiKey", key); if (model != null) await page.fill("#apiModel", model);
}
async function lastBotText(page) { return page.evaluate(() => { const b = [...document.querySelectorAll("#chatHistory .msg.bot .msg-body")].pop(); return b ? b.innerText : ""; }); }
async function ask(page, q) {
  await page.click('.tab[data-view="chat"]'); await page.fill("#chatInput", q); await page.click("#sendChat");
  await page.waitForFunction(() => { const b = [...document.querySelectorAll("#chatHistory .msg.bot .msg-body")].pop(); return b && !/^Thinking/.test(b.innerText); }, null, { timeout: 15000 });
  return lastBotText(page);
}

(async () => {
  const { server, port } = await start(0); const base = "http://127.0.0.1:" + port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); await mockWeb(page);
  const errors = []; page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  const api = (p) => fetch(base + p).then((r) => r.text());
  const logs = async () => JSON.parse(await new Promise((res) => require("http").get(base + "/__log", (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => res(d)); })));
  const reset = (q = "") => new Promise((res) => require("http").get(base + "/__reset" + q, (r) => { r.resume(); r.on("end", res); }));

  await page.goto(base + "/");
  await page.waitForFunction(() => /Secure proxy active/.test(document.getElementById("routeText").textContent), null, { timeout: 8000 }).catch(() => {});
  ok("route detection -> proxy active", /Secure proxy active/.test(await page.textContent("#routeText")), await page.textContent("#routeText"));
  const iconsOk = await page.evaluate(() => [...document.querySelectorAll("use")].every((u) => document.querySelector(u.getAttribute("href"))));
  ok("every <use> icon resolves to a sprite symbol", iconsOk);

  // navigation before analysis
  await page.click('.nav-item[data-view="files"]');
  ok("nav before analysis explains what to do", /Analyze a repository first/.test(await page.textContent("#globalStatus")));

  // analyze
  await page.fill("#repoUrl", "demo/buggy-app"); await page.click("#analyzeBtn");
  await page.waitForSelector("#repoOverview.visible", { timeout: 8000 });
  ok("analyze: file count excludes node_modules and dirs", (await page.textContent("#fileCount")) === String(Object.keys(FILES).length), await page.textContent("#fileCount"));
  ok("analyze: languages detected from extensions", +(await page.textContent("#languageCount")) >= 2, await page.textContent("#languageCount"));
  ok("analyze: stars shown", (await page.textContent("#starCount")).includes("1,234"));

  // navigation + scrolling to every section
  await page.setViewportSize({ width: 1280, height: 500 }); // short viewport so scrolling is necessary
  for (const v of ["files", "mindmap", "bugs", "prompt", "chat", "overview"]) {
    await page.click('.tab[data-view="' + v + '"]'); await sleep(900);
    const r = await page.evaluate((v) => { const p = document.getElementById("view-" + v), b = p.getBoundingClientRect(); return { active: p.classList.contains("active"), top: Math.round(b.top), tabsBottom: Math.round(document.querySelector(".tabs").getBoundingClientRect().bottom) }; }, v);
    ok("scroll: " + v + " panel active and below sticky bar", r.active && r.top >= r.tabsBottom - 2 && r.top < 300, JSON.stringify(r));
  }
  await page.click('.nav-item[data-view="settings"]'); await sleep(800);
  ok("scroll: settings in view", (await page.evaluate(() => document.getElementById("settingsSection").getBoundingClientRect().top)) < 200);
  await page.setViewportSize({ width: 1280, height: 900 });

  // code explorer
  await page.click('.tab[data-view="files"]'); await page.fill("#fileSearch", "cart"); await page.click("#fileTree .tree-item");
  await page.waitForFunction(() => /function total/.test(document.getElementById("filePreview").textContent));
  ok("explorer: filter + preview", true);
  ok("explorer: scan-this-file enabled for source", !(await page.$eval("#scanThisFile", (b) => b.disabled)));
  await page.fill("#fileSearch", "");

  // mind map (lazy mermaid, SRI-checked)
  await page.click('.tab[data-view="mindmap"]'); await page.waitForSelector("#mindmapShell svg", { timeout: 20000 }).catch(() => {});
  const mm = await page.evaluate(() => { const s = document.querySelector("#mindmapShell svg"); if (!s) return null; const b = s.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), text: s.textContent.length }; });
  ok("mind map renders a real, sized SVG with labels", !!mm && mm.w > 150 && mm.h > 100 && mm.text > 20, JSON.stringify(mm));
  const dl = page.waitForEvent("download"); await page.click("#downloadSvg"); const svgPath = await (await dl).path();
  ok("mind map SVG export has xmlns", /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(fs.readFileSync(svgPath, "utf8").slice(0, 400)));
  await page.screenshot({ path: path.join(SHOTS, "desktop-mindmap.png") });

  // reverse prompt: manual only + local draft without key
  ok("prompt: nothing auto-generated", (await page.inputValue("#promptOutput")) === "");
  await page.click('.tab[data-view="prompt"]'); await page.click("#makePrompt");
  ok("prompt: local draft without key", /# Build Prompt: demo\/buggy-app/.test(await page.inputValue("#promptOutput")));

  // chat without key -> settings; five chips
  ok("chat: five pre-built questions", (await page.$$(".question-chip")).length === 5);
  await page.click('.tab[data-view="chat"]'); await page.click('.question-chip >> nth=1'); await sleep(400);
  ok("chat chip without key opens settings", await page.evaluate(() => !document.getElementById("settingsSection").classList.contains("hidden")));

  // bug scan with NO key: local rules only
  await page.click('.nav-item[data-view="files"]'); await page.click('.tab[data-view="bugs"]'); await page.click("#scanBtn");
  await page.waitForSelector("#scanResults .finding", { timeout: 15000 });
  let titles = await page.$$eval("#scanResults .f-title", (n) => n.map((x) => x.textContent));
  ok("scan (no key): rule hits found incl. eval + hard-coded credential", titles.some((t) => /eval/i.test(t)) && titles.some((t) => /Credential-like/.test(t)), titles.join(" | "));
  const jsonCard = await page.$$eval("#scanResults .finding", (n) => n.filter((x) => /Invalid JSON/.test(x.textContent)).map((x) => x.querySelector(".pill.st-confirmed") ? "confirmed" : "other"));
  ok("scan (no key): invalid JSON is the only locally 'confirmed' kind", jsonCard[0] === "confirmed", JSON.stringify(jsonCard));
  const ruleStatuses = await page.$$eval("#scanResults .finding", (n) => n.filter((x) => /local rule/.test(x.textContent) && !/Invalid JSON/.test(x.textContent)).map((x) => !!x.querySelector(".pill.st-suspected")));
  ok("scan (no key): pattern matches are 'suspected'", ruleStatuses.length > 0 && ruleStatuses.every(Boolean));

  // ---- settings: providers & models
  await setKey(page, "sk-test-12345678", "");
  await page.selectOption("#providerPreset", "openai");
  await page.fill("#apiKey", "sk-test-12345678"); await page.click("#loadModels");
  await page.waitForFunction(() => /Loaded \d+ models/.test(document.getElementById("settingsStatus").textContent), null, { timeout: 8000 });
  let opts = await page.$$eval("#modelPicker option", (o) => o.map((x) => x.value));
  ok("models: loaded dynamically; embeddings/speech filtered out", opts.includes("gpt-4o-mini") && !opts.includes("text-embedding-3-small") && !opts.includes("whisper-1"), opts.join(","));
  ok("models: suggestion auto-filled from returned list", (await page.inputValue("#apiModel")) === "gpt-4o-mini", await page.inputValue("#apiModel"));
  await page.check("#showAllModels"); opts = await page.$$eval("#modelPicker option", (o) => o.map((x) => x.value));
  ok("models: show-all reveals filtered ones", opts.includes("text-embedding-3-small"));
  await page.uncheck("#showAllModels");
  // per-provider keys
  await page.selectOption("#providerPreset", "groq");
  ok("provider switch does not carry the previous key", (await page.inputValue("#apiKey")) === "" && (await page.inputValue("#apiBase")).includes("api.groq.com/openai/v1"));
  await page.fill("#apiKey", "gsk_groqkey12345678"); await page.click("#loadModels");
  await page.waitForFunction(() => /Loaded \d+ models from Groq/.test(document.getElementById("settingsStatus").textContent), null, { timeout: 8000 });
  ok("groq model list goes through the proxy (path /openai/v1/models)", (await logs()).some((l) => l.host === "api.groq.com" && l.path === "/openai/v1/models"));
  await page.selectOption("#providerPreset", "openai");
  ok("switching back restores that provider's key", (await page.inputValue("#apiKey")) === "sk-test-12345678");
  // all other providers list models
  for (const [prov, key, host] of [["nvidia", "nvapi-abcdefgh1234", "integrate.api.nvidia.com"], ["featherless", "fl-abcdefgh1234", "api.featherless.ai"], ["openrouter", "or-abcdefgh1234", "openrouter.ai"], ["gemini", "gm-abcdefgh1234", "generativelanguage.googleapis.com"], ["anthropic", "an-abcdefgh1234", "api.anthropic.com"]]) {
    await page.selectOption("#providerPreset", prov); await page.fill("#apiKey", key); await page.click("#loadModels");
    await page.waitForFunction(() => /Loaded \d+ models|failed|not|Not|Could/.test(document.getElementById("settingsStatus").textContent), null, { timeout: 8000 });
    const st = await page.textContent("#settingsStatus");
    ok("models: " + prov + " lists via proxy", /Loaded \d+ models/.test(st), st);
  }
  const anth = await page.$$eval("#modelPicker option", (o) => o.length - 1);
  ok("models: Claude pagination collects all pages (26)", anth === 26, String(anth));
  ok("models: Gemini 'models/' prefix stripped", await (async () => { await page.selectOption("#providerPreset", "gemini"); await page.click("#loadModels"); await page.waitForFunction(() => /Loaded/.test(document.getElementById("settingsStatus").textContent)); return (await page.$$eval("#modelPicker option", (o) => o.map((x) => x.value))).includes("gemini-2.5-flash"); })());
  // custom host: not on allowlist -> proxy declines -> falls to direct -> network error w/ guidance
  await page.selectOption("#providerPreset", "custom"); await page.fill("#apiBase", "https://llm.example.invalid/v1"); await page.fill("#apiKey", "custom-key-12345678"); await page.click("#loadModels");
  await page.waitForFunction(() => /could not reach|proxy declined|CORS/i.test(document.getElementById("settingsStatus").textContent), null, { timeout: 15000 });
  ok("custom host: clear guidance (RP_EXTRA_HOSTS)", /RP_EXTRA_HOSTS/.test(await page.textContent("#settingsStatus")), await page.textContent("#settingsStatus"));

  // ---- chat via OpenAI-style
  await page.selectOption("#providerPreset", "openai"); await page.fill("#apiModel", "gpt-4o-mini");
  await page.click("#saveSettings");
  await reset();
  let ans = await ask(page, "Where is the cart logic?");
  ok("chat: answer rendered as markdown (code + pre)", /Mock answer/.test(ans) && (await page.$$("#chatHistory .msg.bot code")).length >= 1 && (await page.$$("#chatHistory .msg.bot pre")).length >= 1);
  let lg = (await logs()).filter((l) => l.path.endsWith("/chat/completions"));
  ok("chat: OpenAI request uses max_completion_tokens", lg.length && lg[lg.length - 1].body.keys.includes("max_completion_tokens") && !lg[lg.length - 1].body.keys.includes("max_tokens"), JSON.stringify(lg.slice(-1)));
  ok("chat: question picks relevant file (no crash on source fetch)", true);
  await ask(page, "And the second question?");
  ok("chat: keeps conversation history (no error)", !/Could not get/.test(await lastBotText(page)));

  // reasoning-model quirks
  await setKey(page, "sk-test-12345678", "o-reasoner"); await page.click("#testApi");
  await page.waitForFunction(() => /answered|failed/.test(document.getElementById("settingsStatus").textContent), null, { timeout: 10000 });
  ok("reasoning model: param quirks auto-handled", /answered: “ready”/.test(await page.textContent("#settingsStatus")), await page.textContent("#settingsStatus"));

  // retired model -> clear message, NOT "proxy missing"
  await page.fill("#apiModel", "retired-model"); await page.click('.tab[data-view="chat"]').catch(() => {});
  ans = await ask(page, "hello?");
  ok("retired model: clear 404 guidance, no 'proxy missing'", /Load the model list/.test(ans) && !/proxy is missing/i.test(ans), ans);

  // bad key
  await setKey(page, "bad-key-12345678", "gpt-4o-mini"); ans = await ask(page, "hi again");
  ok("bad key: 401 explained and key redacted", /Authentication failed \(401\)/.test(ans) && !ans.includes("bad-key-12345678") && /redacted/.test(ans), ans);

  // HTML upstream
  await setKey(page, "html-fail", "gpt-4o-mini"); ans = await ask(page, "hi html");
  ok("non-JSON upstream error handled", /non-JSON|server error|failed/i.test(ans) && !/<html/i.test(ans), ans);

  // fallback
  await setKey(page, "primary-fail", "gpt-4o-mini");
  await page.check("#enableFallback"); await page.selectOption("#fbProvider", "groq"); await page.fill("#fbKey", "gsk_fallbackkey1234"); await page.fill("#fbModel", "llama-3.3-70b-versatile");
  ans = await ask(page, "fallback please");
  ok("fallback: answers via fallback model after primary 503", /Mock answer/.test(ans) && /fallback model/.test(await page.evaluate(() => [...document.querySelectorAll("#chatHistory .msg.bot")].pop().innerText)), ans);
  ok("fallback: goes to the fallback provider host", (await logs()).some((l) => l.host === "api.groq.com" && l.path.endsWith("/chat/completions")));
  await page.click('.nav-item[data-view="settings"]'); await page.fill("#fbKey", "primary-fail"); await page.fill("#apiKey", "primary-fail");
  ans = await ask(page, "both fail");
  ok("fallback: both failing reports both errors", /Primary model failed/.test(ans) && /Fallback model also failed/.test(ans), ans);
  await setKey(page, "sk-test-12345678", "gpt-4o-mini"); await page.uncheck("#enableFallback"); await page.click("#saveSettings");

  // ---- AI bug scan
  await reset();
  await page.click('.tab[data-view="bugs"]'); await page.click("#scanBtn");
  await page.waitForFunction(() => document.querySelector("#scanResults .stat") && /AI/.test(document.querySelector("#scanResults .section-title p").textContent), null, { timeout: 30000 });
  const cards = await page.$$eval("#scanResults .finding", (n) => n.map((x) => ({ t: x.querySelector(".f-title").textContent, st: x.querySelector(".pill.st-confirmed") ? "confirmed" : "suspected", loc: x.querySelector(".f-loc").textContent, evFound: !!x.querySelector(".chk.ok") && /Quoted evidence found/.test(x.textContent), hasPatch: /Patch \(unified diff\)/.test(x.textContent) })));
  const cart = cards.find((c) => /Off-by-one/.test(c.t)), hall = cards.find((c) => /Hallucinated/.test(c.t)), vague = cards.find((c) => /Missing validation/.test(c.t)), div0 = cards.find((c) => /Division by zero/.test(c.t));
  ok("AI scan: real bug is confirmed with verified evidence + patch", cart && cart.st === "confirmed" && cart.evFound && cart.hasPatch && /src\/cart\.js:3/.test(cart.loc), JSON.stringify(cart));
  ok("AI scan: hallucinated 'confirmed' finding is downgraded to suspected", hall && hall.st === "suspected" && !hall.evFound, JSON.stringify(hall));
  ok("AI scan: unanchorable fix gets no patch and says so", vague && !vague.hasPatch, JSON.stringify(vague));
  ok("AI scan: python (no trailing newline) finding has patch", div0 && div0.hasPatch && div0.st === "confirmed", JSON.stringify(div0));
  ok("AI scan: verified findings rank above evidence-less ones", cards.length > 2 && /Off-by-one/.test(cards[0].t) && /Hallucinated/.test(cards[cards.length - 1].t) || cards.findIndex((c) => /Hallucinated/.test(c.t)) > cards.findIndex((c) => /Off-by-one/.test(c.t)), cards.map((c) => c.t).join(" | "));
  const pageText = await page.textContent("#scanResults");
  ok("UI states nothing was executed", /Executed\/tested: no/.test(pageText) && /not run|did not compile, run or test/.test(pageText) && /Static review only/.test(pageText));
  ok("no claim of tested/verified fixes", !/(fix(es)? (was|were|has been) (tested|verified))|tests? passed/i.test(pageText));
  await page.screenshot({ path: path.join(SHOTS, "desktop-scan.png"), fullPage: false });
  // patches really apply
  const dl2 = page.waitForEvent("download"); await page.click('#scanResults button:has-text("All patches")'); const patchPath = await (await dl2).path();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "rp-apply-")); fs.mkdirSync(path.join(work, "src"));
  fs.writeFileSync(path.join(work, "src/cart.js"), FILES["src/cart.js"]); fs.writeFileSync(path.join(work, "src/legacy.py"), FILES["src/legacy.py"]);
  const patchText = fs.readFileSync(patchPath, "utf8").split(/^# F\d+: .*\n/m).filter(Boolean);
  let applied = 0, applyErr = "";
  for (const p of patchText) { fs.writeFileSync(path.join(work, "p.patch"), p); try { execSync("git apply --check p.patch", { cwd: work, stdio: "pipe" }); execSync("git apply p.patch", { cwd: work, stdio: "pipe" }); applied++; } catch (e) { applyErr += String(e.stderr || e.message); } }
  ok("patches pass `git apply --check` and apply (" + applied + "/" + patchText.length + ")", applied === patchText.length && applied >= 2, applyErr);
  ok("patched cart.js has the corrected loop", /i < items\.length/.test(fs.readFileSync(path.join(work, "src/cart.js"), "utf8")));
  ok("patched legacy.py keeps no-trailing-newline and fixes bug", fs.readFileSync(path.join(work, "src/legacy.py"), "utf8") === FILES["src/legacy.py"].replace("len(values)", "len(values) if values else 0"));
  // markdown report
  const dl3 = page.waitForEvent("download"); await page.click('#scanResults button:has-text("Report")'); const rep = fs.readFileSync(await (await dl3).path(), "utf8");
  ok("markdown report has disclaimer and statuses", /Nothing was executed/.test(rep) && /Confirmed/.test(rep) && /Suspected/.test(rep));
  // persistence of scan after reload
  await page.reload(); await page.waitForSelector("#scanResults .finding", { timeout: 8000 }).catch(() => {});
  ok("workspace + scan restored after reload", (await page.$$("#scanResults .finding")).length === cards.length && /demo\/buggy-app/.test(await page.textContent("#repoName")));
  ok("keys persisted per provider after reload", await (async () => { await page.click('.nav-item[data-view="settings"]'); return (await page.inputValue("#apiKey")) === "sk-test-12345678"; })());

  // garbage model output and stop button
  await reset("?scan=garbage"); await page.click('.tab[data-view="bugs"]').catch(async () => { await page.click('.nav-item[data-view="bugs"]'); });
  await page.click("#scanBtn"); await page.waitForFunction(() => /not in the expected format/.test(document.getElementById("scanResults").textContent), null, { timeout: 30000 });
  ok("scan: malformed model output is reported, not crashed", true);
  await reset("?scan=none"); await page.click("#scanBtn"); await page.waitForFunction(() => document.querySelector("#scanResults .stat"), null, { timeout: 30000 }); await sleep(300);
  ok("scan: [[NO_FINDINGS]] handled", true);

  // scan this file shortcut
  await page.click('.tab[data-view="files"]'); await page.fill("#fileSearch", "legacy"); await page.click("#fileTree .tree-item"); await reset();
  await page.waitForFunction(() => !document.getElementById("scanThisFile").disabled); await page.click("#scanThisFile");
  await page.waitForFunction(() => /legacy\.py/.test(document.getElementById("scanResults").textContent) && document.querySelectorAll("#scanResults .finding").length >= 1, null, { timeout: 20000 });
  ok("'Scan this file' scans only that file", (await page.$$eval("#scanResults .f-loc", (n) => n.every((x) => /legacy\.py/.test(x.textContent)))));

  // AI map + audit + AI prompt
  await page.click('.tab[data-view="mindmap"]'); await page.click("#aiMap"); await page.waitForFunction(() => /AI architecture map generated|could not/i.test(document.getElementById("toast").textContent + document.getElementById("mindmapStatus").textContent), null, { timeout: 15000 }).catch(() => {});
  ok("AI architecture map renders", (await page.$$("#mindmapShell svg")).length === 1 && (await page.$eval("#mindmapShell", (s) => s.textContent)).includes("Client"));
  await page.click('.tab[data-view="overview"]'); await page.click("#runAudit"); await page.waitForFunction(() => /Mock answer/.test(document.getElementById("auditOutput").textContent), null, { timeout: 15000 }).catch(() => {});
  ok("AI review renders", /Mock answer/.test(await page.textContent("#auditOutput")));
  await page.click('.tab[data-view="prompt"]'); await page.click("#makePrompt"); await page.waitForFunction(() => /AI build prompt/.test(document.getElementById("promptOutput").value), null, { timeout: 15000 }).catch(() => {});
  ok("AI reverse prompt generated on demand", /AI build prompt/.test(await page.inputValue("#promptOutput")));

  // security of what hit the upstream: key never in URL; only whitelisted headers
  const all = await logs();
  ok("upstream: redirect:manual and no query leakage", all.every((l) => l.redirect === "manual") && all.every((l) => !/key=|token=/i.test(l.path)));
  ok("upstream: only whitelisted headers forwarded", all.every((l) => l.headers.every((h) => ["accept", "authorization", "content-type", "x-api-key", "anthropic-version", "http-referer", "x-title"].includes(h))), JSON.stringify([...new Set(all.flatMap((l) => l.headers))]));
  ok("no uncaught page errors / CSP violations", errors.length === 0, errors.join(" || "));

  // ---- mobile
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); const mp = await m.newPage(); await mockWeb(mp);
  await mp.goto(base + "/"); await mp.fill("#repoUrl", "demo/buggy-app"); await mp.click("#analyzeBtn"); await mp.waitForSelector("#repoOverview.visible");
  for (const v of ["overview", "files", "mindmap", "bugs", "prompt", "chat"]) {
    await mp.click('.tab[data-view="' + v + '"]'); await sleep(700);
    const ov = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    ok("mobile: no horizontal overflow on " + v, ov.sw <= ov.iw + 1, JSON.stringify(ov));
    await mp.screenshot({ path: path.join(SHOTS, "mobile-" + v + ".png") });
  }
  await mp.click("#settingsTop"); await sleep(600); await mp.screenshot({ path: path.join(SHOTS, "mobile-settings.png") });
  const ov = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  ok("mobile: no horizontal overflow on settings", ov.sw <= ov.iw + 1, JSON.stringify(ov));

  // ---- static hosting (no /api/ai): direct mode
  const sctx = await browser.newContext(); const sp = await sctx.newPage(); await mockWeb(sp);
  await sp.route("**/api/ai", (r) => r.fulfill({ status: 404, body: "Not found" }));
  await sp.route("https://api.openai.com/**", (r) => r.fulfill({ json: r.request().url().endsWith("/models") ? { data: [{ id: "gpt-4o-mini" }] } : { choices: [{ message: { content: "direct ok" }, finish_reason: "stop" }] }, headers: { "access-control-allow-origin": "*" } }));
  await sp.goto(base + "/"); await sp.waitForFunction(() => /Direct browser mode/.test(document.getElementById("routeText").textContent));
  ok("static host: detects missing proxy -> direct mode + explanation", /static hosting/i.test(await sp.textContent("#routeBoxText")) || (await sp.click("#settingsTop"), /Plain static hosting/.test(await sp.textContent("#routeBoxText"))));
  await sp.click("#settingsTop"); await sp.fill("#apiKey", "sk-direct-12345678"); await sp.click("#loadModels");
  await sp.waitForFunction(() => /Loaded 1 models/.test(document.getElementById("settingsStatus").textContent), null, { timeout: 8000 }).catch(() => {});
  ok("static host: direct model loading works", /Loaded 1 models/.test(await sp.textContent("#settingsStatus")), await sp.textContent("#settingsStatus"));
  await sp.selectOption("#providerPreset", "nvidia"); await sp.fill("#apiKey", "nvapi-direct-1234"); await sp.click("#loadModels");
  await sp.waitForFunction(() => /could not reach|Loaded/i.test(document.getElementById("settingsStatus").textContent), null, { timeout: 15000 });
  ok("static host: blocked provider gives actionable CORS/Vercel message", /Vercel|CORS/.test(await sp.textContent("#settingsStatus")), await sp.textContent("#settingsStatus"));

  await browser.close(); server.close();
  console.log(results.join("\n")); console.log("\nscreenshots:", SHOTS); console.log(failed ? "\n" + failed + " FAILED" : "\nALL PASSED (" + results.length + " checks)");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); console.log(results.join("\n")); process.exit(2); });
