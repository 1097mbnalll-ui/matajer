// الاتصال بنون (noon Partner API) — حسب التوثيق الرسمي noon-docs.noonpartners.dev
// المفتاح: ملف .json من نون (key_id, private_key, project_code) يرفعه المالك من إعدادات المكتب.
// الدخول: JWT بتوقيع RS256 ← POST /identity/public/v1/api/login ← كوكي جلسة (تعيش ٣٠ يوم)
import { addMsg, getSetting, setSetting, log, now } from "./db.js";
import { tg, wake, levelIcon } from "./notify.js";

export const NOON_BASE = "https://noon-api-gateway.noon.partners";
const UA = "OhodOffice/1.0";
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (s) => b64url(new TextEncoder().encode(s));

// ---------- المفتاح ----------
export function parseNoonKey(text) {
  let k; try { k = JSON.parse(text); } catch { return { error: "not_json" }; }
  if (!k || typeof k.key_id !== "string" || typeof k.private_key !== "string" || !/PRIVATE KEY/.test(k.private_key)) return { error: "missing_fields" };
  return { key: { key_id: k.key_id, private_key: k.private_key, project_code: k.project_code || null } };
}
export async function noonKey(env) {
  if (env.NOON_KEY) { const p = parseNoonKey(env.NOON_KEY); if (p.key) return p.key; }
  return await getSetting(env, "cfg:NOON_KEY");
}

// PEM ← مفتاح WebCrypto (يدعم PKCS#8 و PKCS#1)
function derLen(n) { if (n < 128) return [n]; const b = []; while (n) { b.unshift(n & 255); n >>= 8; } return [0x80 | b.length, ...b]; }
function pkcs1to8(der) {
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const oct = [0x04, ...derLen(der.length), ...der];
  const body = [0x02, 0x01, 0x00, ...algo, ...oct];
  return new Uint8Array([0x30, ...derLen(body.length), ...body]);
}
async function importKey(pem) {
  const raw = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const der = /BEGIN RSA PRIVATE KEY/.test(pem) ? pkcs1to8([...raw]) : raw;
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
export async function makeJwt(key) {
  const head = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64urlText(JSON.stringify({ sub: key.key_id, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID() }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importKey(key.private_key), new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

// ---------- الجلسة ----------
function cookiesFrom(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("Set-Cookie")].filter(Boolean);
  return list.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}
async function noonLogin(env) {
  const key = await noonKey(env);
  if (!key) return { ok: false, code: "no_key" };
  const f = env.fetch || fetch;
  let res;
  try {
    res = await f(`${NOON_BASE}/identity/public/v1/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ token: await makeJwt(key), ...(key.project_code ? { default_project_code: key.project_code } : {}) }),
    });
  } catch { return { ok: false, code: "network" }; }
  if (!res.ok) return { ok: false, code: "login_failed", status: res.status, detail: (await res.text().catch(() => "")).slice(0, 300) };
  const cookie = cookiesFrom(res);
  if (!cookie) return { ok: false, code: "no_cookie" };
  await setSetting(env, "noon_session", { cookie, at: now() });
  return { ok: true, cookie };
}
export async function noonCall(env, method, path, body) {
  const f = env.fetch || fetch;
  let s = await getSetting(env, "noon_session");
  if (!s || now() - s.at > 25 * 864e5) { const l = await noonLogin(env); if (!l.ok) return { ok: false, status: 0, ...l }; s = { cookie: l.cookie }; }
  const go = (cookie) => f(NOON_BASE + path, { method, headers: { Accept: "application/json", "User-Agent": UA, Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let res;
  try {
    res = await go(s.cookie);
    if (res.status === 401 || res.status === 403) { const l = await noonLogin(env); if (!l.ok) return { ok: false, status: res.status, ...l }; res = await go(l.cookie); }
  } catch { return { ok: false, status: 0, code: "network" }; }
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

// مسارات القراءة المسموحة للموظفين (كتابة الأسعار والمخزون تمر بالموافقة، وما هي هنا)
export const NOON_READ = [
  { method: "GET", re: /^\/offer\/v1\/product\/[^/?#]{1,120}$/ },
  { method: "POST", re: /^\/pricing\/v1\/pricing\/get$/ },
  { method: "POST", re: /^\/stock\/v1\/stock-list$/ },
  { method: "GET", re: /^\/impex\/v1\/export\/category\/list$/ },
  { method: "POST", re: /^\/impex\/v1\/export\/status$/ },
  { method: "GET", re: /^\/warehouse-platform\/v1\/warehouses(\?.*)?$/ },
];
export const noonReadAllowed = (method, path) => NOON_READ.some((r) => r.method === method && r.re.test(path));

// ---------- المراقبة الدائمة (كل ١٥ دقيقة) ----------
export const NOON_DEFAULTS = { lowStock: 3, country: "sa" };
export async function runNoon(env) {
  if (!(await noonKey(env))) return { skipped: "no_key" };
  const skus = ((await getSetting(env, "noon_skus")) || []).slice(0, 150);
  const rules = { ...NOON_DEFAULTS, ...((await getSetting(env, "noon_rules")) || {}) };
  const found = [];
  let reached = false, authFail = null;
  const snap = [];
  for (const sku of skus) {
    const r = await noonCall(env, "GET", `/offer/v1/product/${encodeURIComponent(sku)}`);
    if (!r.ok) { if (r.code === "login_failed" || r.code === "no_cookie") { authFail = r; break; } continue; }
    reached = true;
    for (const o of (r.data?.offers || []).filter((x) => x.country_code === rules.country)) snap.push({ sku, title: r.data.title || sku, stock: Number(o.active_net_stock) || 0, live: !!o.live_status, active: !!o.is_active, price: o.price?.amount ?? null });
    for (const o of (r.data?.offers || []).filter((x) => x.country_code === rules.country)) {
      const name = r.data.title || sku;
      if (o.is_active && Number(o.active_net_stock) <= rules.lowStock)
        found.push({ k: `noon_low:${sku}`, level: Number(o.active_net_stock) <= 0 ? "urgent" : "important", title: `نون: «${name}» ${Number(o.active_net_stock) <= 0 ? "خلص" : "قرّب يخلص"} في مستودع نون`, body: `الباقي ${o.active_net_stock}. جهّز شحنة لمستودع نون.` });
      if (o.is_active && !o.live_status)
        found.push({ k: `noon_hidden:${sku}`, level: "important", title: `نون: «${name}» مخفي عن الزبائن`, body: (o.offer_issues || []).map((i) => i.description || i.reason).join(" · ").slice(0, 400) || "بدون سبب واضح من نون." });
    }
  }
  if (authFail) found.push({ k: "noon_auth", level: "important", title: "المكتب ما قدر يدخل نون", body: "يمكن المفتاح انتهى أو انحذف. ارفع ملف المفتاح من جديد في الإعدادات." });
  const checked = new Set(authFail ? ["noon_auth"] : reached ? ["noon_low", "noon_hidden", "noon_auth"] : ["noon_auth"]);
  // تسجيل بدون تكرار (نفس منطق المراقب)
  const t = now(), fresh = [];
  for (const a of found) {
    const ex = await env.DB.prepare("SELECT id, open FROM alerts WHERE k = ?").bind(a.k).first();
    if (ex && ex.open) { await env.DB.prepare("UPDATE alerts SET last = ? WHERE id = ?").bind(t, ex.id).run(); continue; }
    if (ex) await env.DB.prepare("UPDATE alerts SET open = 1, first = ?, last = ?, level = ?, title = ?, body = ? WHERE id = ?").bind(t, t, a.level, a.title, a.body, ex.id).run();
    else await env.DB.prepare("INSERT INTO alerts (k, level, title, body, first, last) VALUES (?, ?, ?, ?, ?, ?)").bind(a.k, a.level, a.title, a.body, t, t).run();
    fresh.push({ ...a, id: (await env.DB.prepare("SELECT id FROM alerts WHERE k = ?").bind(a.k).first()).id });
  }
  const seen = new Set(found.map((a) => a.k));
  for (const o of (await env.DB.prepare("SELECT id, k, title FROM alerts WHERE open = 1 AND k LIKE 'noon%'").all()).results || []) {
    if (!seen.has(o.k) && checked.has(o.k.split(":")[0])) { await env.DB.prepare("UPDATE alerts SET open = 0 WHERE id = ?").bind(o.id).run(); await tg(env, `✅ انحلّت: ${o.title}`); }
  }
  for (const a of fresh) {
    await tg(env, `${levelIcon(a.level)}\n${a.title}\n${a.body || ""}`, [[{ text: "🔎 حلّلها", callback_data: `n:${a.id}` }]]);
    await log(env, "noon", "alert", { level: a.level, title: a.title });
    await addMsg(env, "noon", "emp", `${a.title}\n${a.body || ""}`, "alert", a.id);
    if (a.level === "urgent") await wake(env, "noon", `تنبيه نون (${a.level}): ${a.title}\n${a.body}\nرقم التنبيه: ${a.id}`);
  }
  if (reached) await setSetting(env, "noon_snapshot", { at: now(), items: snap }); // للأرقام الحية في المكتب (بدون جلسة)
  return { checked: skus.length, fresh: fresh.length };
}
