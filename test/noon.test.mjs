// اختبارات ربط نون: توقيع حقيقي RS256 يتحقق منه خادم نون وهمي
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { fakeD1 } from "./d1.mjs";
import worker from "../src/worker.js";
import { runNoon, makeJwt, parseNoonKey } from "../src/noon.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" });
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" });
const keyFile = (pem = pkcs8) => JSON.stringify({ key_id: "kid-1", private_key: pem, project_code: "PRJ1", channel_identifier: "x" });
function verifyJwt(tok) {
  const [h, b, sig] = tok.split(".");
  const v = createVerify("RSA-SHA256"); v.update(`${h}.${b}`);
  return v.verify(publicKey, Buffer.from(sig, "base64url")) ? JSON.parse(Buffer.from(b, "base64url")) : null;
}
function makeEnv(offers = {}) {
  const sent = [], fired = [], noon = { logins: 0, calls: [] };
  const env = { __fresh: true, SYNC_WAKE: true, DB: fakeD1(), OFFICE_PASSWORD: "office-password-1", TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_CHAT_ID: "42",
    ROUTINE_NOON_ID: "trig_noon", ROUTINE_NOON_TOKEN: "tok_noon", STORE_API: "https://store.test", sent, fired, noon };
  env.fetch = async (u, init = {}) => {
    u = String(u);
    const body = init.body ? JSON.parse(init.body) : {};
    if (u.includes("api.telegram.org")) { if (u.endsWith("/sendMessage")) sent.push(body); return Response.json({ ok: true }); }
    if (u.startsWith("https://api.anthropic.com/")) { fired.push({ u, body }); return Response.json({ claude_code_session_url: "https://claude.ai/code/s" }); }
    if (u.startsWith("https://noon-api-gateway.noon.partners")) {
      const p = u.slice("https://noon-api-gateway.noon.partners".length);
      if (p === "/identity/public/v1/api/login") {
        const claims = verifyJwt(body.token);
        if (!claims || claims.sub !== "kid-1" || Math.abs(claims.iat - Date.now() / 1000) > 300 || init.headers["User-Agent"] == null) return new Response("bad", { status: 401 });
        noon.logins++; noon.project = body.default_project_code;
        return new Response("{}", { headers: [["Set-Cookie", "session=abc; Path=/; HttpOnly"], ["Set-Cookie", "csrf=z; Path=/"]] });
      }
      noon.calls.push({ p, cookie: init.headers.Cookie, method: init.method });
      if (init.headers.Cookie !== "session=abc; csrf=z") return new Response("no", { status: 401 });
      if (p === "/impex/v1/export/category/list") return Response.json({ export_categories: [{ export_category_code: "offers", params: {} }] });
      const m = p.match(/^\/offer\/v1\/product\/(.+)$/);
      if (m) return offers[decodeURIComponent(m[1])] ? Response.json(offers[decodeURIComponent(m[1])]) : new Response("nf", { status: 404 });
    }
    return new Response("?", { status: 404 });
  };
  return env;
}
const ctx = { waitUntil() {} };
async function call(env, path, { body, cookie, agent } = {}) {
  const h = {}; if (body !== undefined) h["Content-Type"] = "application/json"; if (cookie) h.Cookie = cookie; if (agent) h.Authorization = `Bearer ${agent}`;
  const r = await worker.fetch(new Request("https://office.test" + path, { method: body !== undefined ? "POST" : "GET", headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }), env, ctx);
  return { status: r.status, body: await r.json().catch(() => null), setCookie: r.headers.get("Set-Cookie") };
}
const login = async (env) => (await call(env, "/api/login", { body: { password: env.OFFICE_PASSWORD } })).setCookie.split(";")[0];
const offer = (title, stock, live = true, issues = []) => ({ partner_sku: "x", sku: "N1", title, brand: "b", offers: [{ offer_code: "o", country_code: "sa", business_model: "noon", price: { amount: 10, currency: "SAR" }, is_active: true, active_net_stock: stock, live_status: live, offer_issues: issues }] });

test("ملف المفتاح: يتقبل PKCS#8 و PKCS#1، ويرفض الغلط", async () => {
  assert.equal(parseNoonKey("hello").error, "not_json");
  assert.equal(parseNoonKey('{"key_id":"a"}').error, "missing_fields");
  for (const pem of [pkcs8, pkcs1]) {
    const { key } = parseNoonKey(keyFile(pem));
    const claims = verifyJwt(await makeJwt(key));
    assert.equal(claims.sub, "kid-1"); assert.ok(claims.jti);
    assert.ok(Number.isInteger(claims.iat) && Math.abs(claims.iat - Date.now() / 1000) < 5, "iat بالثواني");
  }
});

test("المالك يرفع الملف: ينحفظ مخفي، ويتجرب الاتصال فوراً، والجلسة تنعاد استخدامها", async () => {
  const env = makeEnv();
  const c = await login(env);
  assert.equal((await call(env, "/api/noon-key", { cookie: c, body: { text: "غلط" } })).status, 400);
  const r = await call(env, "/api/noon-key", { cookie: c, body: { text: keyFile() } });
  assert.equal(r.body.test.ok, true);
  assert.deepEqual(r.body.test.exports, ["offers"]);
  assert.equal(env.noon.project, "PRJ1");
  const st = await call(env, "/api/state", { cookie: c });
  assert.equal(st.body.noon.key, true);
  assert.ok(!JSON.stringify(st.body).includes("PRIVATE KEY"), "المفتاح ما يرجع للمتصفح");
  await call(env, "/api/noon-test", { cookie: c, body: {} });
  assert.equal(env.noon.logins, 1, "ما يسوي دخول جديد كل مرة");
});

test("المراقبة الدائمة: قرّب يخلص، خلص، مخفي — بدون تكرار، ويبلغ لما ينحل", async () => {
  const offers = { A1: offer("حليب", 2), B2: offer("رز", 0), C3: offer("زيت", 50, false, [{ reason: "x", subreason: "y", description: "السعر أعلى من المسموح" }]), D4: offer("سكر", 40) };
  const env = makeEnv(offers);
  const c = await login(env);
  await call(env, "/api/noon-key", { cookie: c, body: { text: keyFile() } });
  await call(env, "/api/noon-skus", { cookie: c, body: { skus: "A1, B2\nC3 D4 bad sku!" } });
  await runNoon(env);
  const t = env.sent.map((m) => m.text).join("\n");
  assert.match(t, /«حليب» قرّب يخلص/); assert.match(t, /«رز» خلص/); assert.match(t, /«زيت» مخفي/); assert.match(t, /السعر أعلى من المسموح/);
  assert.doesNotMatch(t, /سكر/);
  assert.equal(env.fired.length, 1, "اللي خلص (عاجل) بس يصحّي مسؤول نون");
  const n = env.sent.length;
  await runNoon(env);
  assert.equal(env.sent.length, n, "ما يكرر");
  offers.A1 = offer("حليب", 30);
  await runNoon(env);
  assert.match(env.sent.at(-1).text, /انحلّت: نون: «حليب»/);
});

test("الموظفين يقرون نون بس (ما يقدرون يعدلون)، والمفتاح الغلط يطلّع تنبيه", async () => {
  const env = makeEnv({ A1: offer("حليب", 9) });
  const c = await login(env);
  await call(env, "/api/noon-key", { cookie: c, body: { text: keyFile() } });
  await call(env, "/api/task", { cookie: c, body: { emp: "noon", text: "راجع المخزون" } });
  const tok = env.fired.at(-1).body.text.match(/[a-f0-9]{48}/)[0];
  const A = (b) => call(env, "/agent/noon", { body: { emp: "noon", ...b }, agent: tok });
  const r = await A({ method: "GET", path: "/offer/v1/product/A1" });
  assert.equal(r.body.data.title, "حليب");
  assert.equal((await A({ method: "POST", path: "/pricing/v1/pricing/update" })).body.code, "read_only_paths");
  assert.equal((await A({ method: "POST", path: "/stock/v1/stock-update" })).body.code, "read_only_paths");
  assert.equal((await call(env, "/agent/noon-skus", { body: { emp: "noon", skus: ["A1"] }, agent: tok })).body.n, 1);
  // مفتاح انحذف من نون
  const { privateKey: other } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await call(env, "/api/noon-key", { cookie: c, body: { text: keyFile(other.export({ type: "pkcs8", format: "pem" })) } });
  await runNoon(env);
  assert.match(env.sent.at(-1).text, /ما قدر يدخل نون/);
});

test("التعليمات تجي من المكتب، ومسؤول نون يطلب تقرير وينزّله عن طريق المكتب", async () => {
  const env = makeEnv();
  const base = env.fetch;
  env.fetch = async (u, init = {}) => {
    u = String(u);
    if (u.endsWith("/impex/v1/export/create")) return Response.json({ export_code: "EX1" });
    if (u.endsWith("/impex/v1/export/status")) return Response.json({ export_code: "EX1", export_status: "done", download_url: "https://files.noon.test/ex1.csv" });
    if (u === "https://files.noon.test/ex1.csv") return new Response("sku,qty,total\nA1,3,30\n");
    return base(u, init);
  };
  const c = await login(env);
  await call(env, "/api/noon-key", { cookie: c, body: { text: keyFile() } });
  await call(env, "/api/task", { cookie: c, body: { emp: "noon", text: "مبيعات اليوم" } });
  const tok = env.fired.at(-1).body.text.match(/[a-f0-9]{48}/)[0];
  const b = await call(env, "/agent/brief", { body: { emp: "noon" }, agent: tok });
  assert.match(b.body.instructions, /مسؤول نون/); assert.match(b.body.instructions, /الكبير/);
  assert.equal(b.body.tasks[0].text, "مبيعات اليوم");
  const cr = await call(env, "/agent/noon-export", { body: { emp: "noon", export_category_code: "sales", params: {} }, agent: tok });
  assert.equal(cr.body.data.export_code, "EX1");
  const dl = await call(env, "/agent/noon-export", { body: { emp: "noon", export_code: "EX1" }, agent: tok });
  assert.equal(dl.body.ready, true); assert.match(dl.body.text, /A1,3,30/);
});

test("الأرقام الحية: نون من آخر فحص (بدون جلسة)", async () => {
  const env = makeEnv({ A1: offer("حليب", 2), D4: offer("سكر", 40) });
  const c = await login(env);
  await call(env, "/api/noon-key", { cookie: c, body: { text: keyFile() } });
  await call(env, "/api/noon-skus", { cookie: c, body: { skus: "A1 D4" } });
  await runNoon(env);
  const l = await call(env, "/api/live", { cookie: c });
  assert.equal(l.body.noon.total, 42); assert.equal(l.body.noon.products, 2); assert.equal(l.body.noon.items[0].title, "سكر");
  assert.equal(env.fired.length, 0);
});
