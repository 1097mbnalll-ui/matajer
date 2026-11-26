// خادم «مكتب متاجر أحد» على Cloudflare Workers
// - /api/*   للمالك (كوكي بعد الدخول بكلمة السر)
// - /agent/* لجلسات الموظفين (Authorization: Bearer AGENT_TOKEN)
// - /tg      تيليقرام (أزرار موافق/رفض ورسايل المالك)
// - scheduled: المراقب كل ٥ دقايق
import { TEAM, AREAS, LEVELS, teamKeys, areaOf } from "./team.js";
import { ensureSchema, now, log, getSetting, setSetting, permsOf, bump, teamState, hydrate, CFG_KEYS, addMsg } from "./db.js";
import { tg, wake, ownerChat, tgHookSecret, routineOf } from "./notify.js";
import ASSETS from "./assets.js";
import AGENT_TEXT from "./agents-text.js";
import { runNoon, noonCall, noonReadAllowed, parseNoonKey, noonKey } from "./noon.js";
import { runMonitor, analysisPrompt, DEFAULT_RULES, storeCall } from "./monitor.js";

const SESSION_DAYS = 30, MAX_FAILS = 5, LOCK_MIN = 15;
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key, s) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(s)));
}
function toB64(buf) { let s = ""; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192)); return btoa(s); }
async function pbkdf2(pw, salt) {
  const k = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" }, k, 256));
}
async function hasPassword(env) { return !!(env.OFFICE_PASSWORD || (await getSetting(env, "pw"))); }
async function checkPassword(env, pw) {
  if (env.OFFICE_PASSWORD) return sameText(await hmac("ohod-office-login", pw), await hmac("ohod-office-login", env.OFFICE_PASSWORD));
  const s = await getSetting(env, "pw");
  return !!s && sameText(await pbkdf2(pw, s.salt), s.hash);
}
function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
const clip = (s, n) => String(s ?? "").slice(0, n);
const riyadhDayStr = (back = 0) => new Date(Date.now() + 3 * 3600e3 - back * 864e5).toISOString().slice(0, 10);
const nameOf = (k) => TEAM.find((t) => t.key === k)?.name || k;
// ليش ما صحى الموظف: بكلام واضح للمالك
const WHY = { not_configured: "ما انربطت جلسته للحين (اضغط عليه في المكتب ← ربط الجلسة)", daily_cap: "وصلنا الحد اليومي للجلسات (تقدر ترفعه من الإعدادات)", fire_failed: "Claude رفض التشغيل (يمكن رمز التشغيل انحذف أو انتهى، اربطه من جديد)" };
const whyNot = (emp, code) => `${TEAM.find((t) => t.key === emp)?.person || nameOf(emp)} (${nameOf(emp)}) ما صحى: ${WHY[code] || code || "سبب غير معروف"}`;
// التنبيه يروح للمختص: تنبيهات نون لمسؤول نون، والباقي للمراقب
const alertOwner = (a) => (String(a.k || "").startsWith("noon") ? "noon" : "monitor");
const alertPrompt = (a) => alertOwner(a) === "noon" ? `تنبيه نون: ${a.title}\n${a.body || ""}\nرقم التنبيه: ${a.id}` : analysisPrompt(a);

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      env = await hydrate(env);
      const m = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
      await runMonitor(env, { hourly: m < 5 });
      if (m % 15 < 5) await runNoon(env); // نون كل ١٥ دقيقة
      // تقرير الصباح: الساعة ٧ بتوقيت الرياض، مرة وحدة باليوم
      const riyadh = new Date((event.scheduledTime || Date.now()) + 3 * 3600e3);
      // توفير: آخر اليوم نصوّر أرقام اليوم، والصبح الخادم نفسه يكتب التقرير (بدون جلسة ذكاء اصطناعي)
      if (riyadh.getUTCHours() === 23 && riyadh.getUTCMinutes() >= 50) await snapshotDay(env, riyadh.toISOString().slice(0, 10));
      if (riyadh.getUTCHours() === 7 && (await bump(env, "morning_report", 1))) await morningReport(env, new Date(riyadh - 864e5).toISOString().slice(0, 10));
    })().catch(() => {}));
  },
  async fetch(request, env, ctx) {
    try { return await route(request, env, ctx); }
    catch (e) { return json(500, { ok: false, code: "server" }); }
  },
};

let CTX = null; // ctx.waitUntil: نكمّل شغل بعد ما نرد (مثل تصحية الموظف) عشان الموقع ما ينتظر
async function route(request, env, ctx) {
  CTX = ctx;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path.startsWith("/api/") || path.startsWith("/agent/") || path === "/tg") {
    if (!env.DB) return json(500, { ok: false, code: "config", missing: "DB" });
    await ensureSchema(env);
    env = await hydrate(env);
    if (!env.OFFICE_URL) env.OFFICE_URL = url.origin;
  }
  if (path === "/tg") return telegram(request, env);
  if (path.startsWith("/agent/")) return agentApi(request, env, path, url);
  if (path.startsWith("/api/")) return ownerApi(request, env, path, url);
  // الواجهة (مدموجة في الخادم)
  if (env.ASSETS) return env.ASSETS.fetch(request);
  const a = ASSETS[path] || ASSETS[path + ".html"];
  if (!a || request.method !== "GET") return new Response("not found", { status: 404 });
  return new Response(a.body, { headers: { "Content-Type": a.type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" } });
}

// ================= المالك =================
async function readBody(request) {
  if (request.method !== "POST") return {};
  if (!(request.headers.get("Content-Type") || "").includes("application/json")) return null;
  const t = await request.text();
  if (t.length > 200000) return null;
  try { return JSON.parse(t || "{}"); } catch { return null; }
}
function cookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|; )${name}=([a-f0-9]{64})`));
  return m ? m[1] : null;
}
async function isOwner(request, env) {
  const c = cookie(request, "office");
  if (!c) return false;
  const r = await env.DB.prepare("SELECT expires FROM sessions WHERE hash = ?").bind(await sha(c)).first();
  return !!(r && r.expires > now());
}
function sameOrigin(request, url) {
  const o = request.headers.get("Origin");
  return !o || o === url.origin;
}

async function ownerApi(request, env, path, url) {
  if (request.method === "POST" && !sameOrigin(request, url)) return json(403, { ok: false, code: "origin" });
  const body = await readBody(request);
  if (body === null) return json(400, { ok: false, code: "bad_body" });
  const ip = request.headers.get("CF-Connecting-IP") || "local";

  if (path === "/api/setup-status") return json(200, { ok: true, needsSetup: !(await hasPassword(env)) });
  if (path === "/api/setup") { // أول مرة بس: المالك يختار كلمة سر المكتب
    if (await hasPassword(env)) return json(409, { ok: false, code: "already_set" });
    const pw = clip(body.password, 200);
    if (pw.length < 10) return json(400, { ok: false, code: "too_short" });
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    await setSetting(env, "pw", { salt, hash: await pbkdf2(pw, salt) });
    await log(env, "manager", "password_set", { by: "المالك" });
    return json(200, { ok: true });
  }
  if (path === "/api/login") {
    if (!(await hasPassword(env))) return json(409, { ok: false, code: "needs_setup" });
    const f = await env.DB.prepare("SELECT n, until FROM fails WHERE ip = ?").bind(ip).first();
    if (f && f.until > now()) return json(429, { ok: false, code: "locked", minutes: Math.ceil((f.until - now()) / 60000) });
    const ok = await checkPassword(env, clip(body.password, 200));
    if (!ok) {
      const n = (f && f.until <= now() && f.n >= MAX_FAILS ? 0 : f?.n || 0) + 1;
      const until = n >= MAX_FAILS ? now() + LOCK_MIN * 60000 : 0;
      await env.DB.prepare("INSERT INTO fails (ip, n, until) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET n = excluded.n, until = excluded.until").bind(ip, n, until).run();
      if (until) await tg(env, "⚠️ أحد حاول يدخل المكتب بكلمة سر غلط ٥ مرات. انقفل الدخول ١٥ دقيقة.");
      return json(401, { ok: false, code: "bad_password", left: Math.max(0, MAX_FAILS - n) });
    }
    await env.DB.prepare("DELETE FROM fails WHERE ip = ?").bind(ip).run();
    const tok = hex(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("INSERT INTO sessions (hash, expires) VALUES (?, ?)").bind(await sha(tok), now() + SESSION_DAYS * 864e5).run();
    await env.DB.prepare("DELETE FROM sessions WHERE expires < ?").bind(now()).run();
    return json(200, { ok: true }, { "Set-Cookie": `office=${tok}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}` });
  }
  if (!(await isOwner(request, env))) return json(401, { ok: false, code: "login" });

  if (path === "/api/logout") {
    const c = cookie(request, "office");
    if (c) await env.DB.prepare("DELETE FROM sessions WHERE hash = ?").bind(await sha(c)).run();
    return json(200, { ok: true }, { "Set-Cookie": "office=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" });
  }
  if (path === "/api/state") {
    const pending = (await env.DB.prepare("SELECT * FROM requests WHERE status = 'pending' ORDER BY id DESC").all()).results || [];
    const alerts = (await env.DB.prepare("SELECT * FROM alerts WHERE open = 1 ORDER BY CASE level WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, id DESC LIMIT 50").all()).results || [];
    const meetings = (await env.DB.prepare("SELECT * FROM meetings ORDER BY id DESC LIMIT 10").all()).results || [];
    // ردود الموظفين على مهام المالك اللي ما شافها للحين
    const seenAt = (await env.DB.prepare("SELECT v FROM seen WHERE k = 'replies'").first())?.v || 0;
    const replies = (await env.DB.prepare("SELECT id, emp, text, result, done FROM tasks WHERE status = 'done' AND src != 'المدير العام' AND done > ? ORDER BY done DESC LIMIT 10").bind(seenAt).all()).results || [];
    const team = await teamState(env);
    for (const t of team) { const r = await routineOf(env, t.key); t.linked = !!(r.id && r.token); }
    return json(200, { ok: true, team, replies, telegram: { bot: !!env.TELEGRAM_BOT_TOKEN, linked: !!(await ownerChat(env)) }, reader: !!env.STORE_READER_PIN, noon: { key: !!(await noonKey(env)), skus: ((await getSetting(env, "noon_skus")) || []).length }, areas: AREAS, levels: LEVELS, pending, alerts, meetings,
      rules: { ...DEFAULT_RULES, ...(await getSetting(env, "rules", {})) }, caps: { fire: await getSetting(env, "fire_cap", 60), meetings: await getSetting(env, "meeting_cap", 5) } });
  }
  // ---------- المحادثات ----------
  if (path === "/api/chats") {
    if (!(await env.DB.prepare("SELECT id FROM messages LIMIT 1").first())) { // أول مرة: نسحب المهام القديمة للمحادثات
      for (const t of (await env.DB.prepare("SELECT * FROM tasks ORDER BY id").all()).results || []) {
        await env.DB.prepare("INSERT INTO messages (at, emp, frm, kind, text, ref) VALUES (?, ?, ?, 'text', ?, ?)").bind(t.at, t.emp, t.src === "المدير العام" ? "sys" : "owner", t.text.replace(/\n\[مرفق:[^\]]*\]/, ""), t.id).run();
        if (t.result) await env.DB.prepare("INSERT INTO messages (at, emp, frm, kind, text, ref) VALUES (?, ?, 'emp', 'text', ?, ?)").bind(t.done || t.at, t.emp, t.result, t.id).run();
      }
    }
    // استعلامات مجمّعة: كل المحادثات بخطوة وحدة
    const [stR, lastR, unreadR, routR, meetR, mlR, pendR] = await Promise.all([
      env.DB.prepare("SELECT emp, status, session_url FROM emp_state").all(),
      env.DB.prepare("SELECT m.emp, m.at, m.frm, m.kind, m.text FROM messages m JOIN (SELECT emp, MAX(id) mid FROM messages GROUP BY emp) x ON m.id = x.mid").all(),
      env.DB.prepare("SELECT m.emp, COUNT(*) n FROM messages m LEFT JOIN seen s ON s.k = 'chat:' || m.emp WHERE m.frm != 'owner' AND m.id > COALESCE(s.v, 0) GROUP BY m.emp").all(),
      env.DB.prepare("SELECT k FROM settings WHERE k LIKE 'routine:%'").all(),
      env.DB.prepare("SELECT id, topic, status, at FROM meetings ORDER BY id DESC LIMIT 15").all(),
      env.DB.prepare("SELECT l.meeting, l.emp, l.text, l.at FROM meeting_lines l JOIN (SELECT meeting, MAX(id) mid FROM meeting_lines GROUP BY meeting) x ON l.id = x.mid").all(),
      env.DB.prepare("SELECT COUNT(*) n FROM requests WHERE status = 'pending'").first(),
    ]);
    const by = (rs) => Object.fromEntries((rs.results || []).map((r) => [r.emp, r]));
    const st = by(stR), lastM = by(lastR), unread = by(unreadR), linked = new Set((routR.results || []).map((r) => r.k.slice(8)));
    const chats = TEAM.map((t) => { const L = lastM[t.key];
      return { key: t.key, person: t.person, name: t.name, color: t.color, icon: t.icon, status: st[t.key]?.status || "idle", sessionUrl: st[t.key]?.session_url || null,
        linked: linked.has(t.key) || !!(env[`ROUTINE_${t.key.toUpperCase()}_TOKEN`]), last: L ? { at: L.at, frm: L.frm, kind: L.kind, text: L.text } : null, unread: unread[t.key]?.n || 0 }; });
    const ml = Object.fromEntries((mlR.results || []).map((r) => [r.meeting, r]));
    const meetings = (meetR.results || []).map((m) => ({ id: m.id, topic: m.topic, status: m.status, at: ml[m.id]?.at || m.at, last: ml[m.id] ? { emp: ml[m.id].emp, text: ml[m.id].text, at: ml[m.id].at } : null }));
    const pending = pendR.n;
    return json(200, { ok: true, chats, meetings, pending });
  }
  if (path === "/api/chat") {
    const emp = url.searchParams.get("emp");
    if (!teamKeys.has(emp)) return json(400, { ok: false, code: "bad_emp" });
    const msgs = ((await env.DB.prepare("SELECT * FROM messages WHERE emp = ? ORDER BY id DESC LIMIT 150").bind(emp).all()).results || []).reverse();
    const cardIds = msgs.filter((m) => m.kind === "card").map((m) => m.ref);
    const cards = {};
    if (cardIds.length) for (const q of (await env.DB.prepare("SELECT id, area, title, detail, status, big FROM requests WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(cardIds)).all()).results || []) cards[q.id] = q;
    if (msgs.length) await env.DB.prepare("INSERT INTO seen (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind("chat:" + emp, msgs.at(-1).id).run();
    const st = await env.DB.prepare("SELECT status, session_url FROM emp_state WHERE emp = ?").bind(emp).first();
    return json(200, { ok: true, messages: msgs, cards, status: st?.status || "idle", sessionUrl: st?.session_url || null });
  }
  // الأرقام الحية: من الخادم مباشرة، بدون أي موظف (فوري ومجاني)
  if (path === "/api/live") {
    const [t, a] = await Promise.all([storeCall(env, "/admin/today"), storeCall(env, "/admin/alerts")]);
    const store = t.ok ? { ok: true, orders: t.body.today?.orders ?? 0, revenue: t.body.today?.revenue ?? 0, cost: t.body.today?.cost ?? 0, canceled: t.body.today?.canceled ?? 0,
      lastWeek: t.body.lastWeek?.revenue ?? null, open: Object.fromEntries((t.body.open || []).map((o) => [o.status, o.n])), cash: t.body.cashBalance ?? null, late: a.ok ? (a.body.orders || []).length : null } : { ok: false };
    const ns = await getSetting(env, "noon_snapshot");
    const noon = ns ? { ok: true, at: ns.at, total: ns.items.reduce((n, i) => n + i.stock, 0), products: ns.items.length, out: ns.items.filter((i) => i.active && i.stock <= 0).length, hidden: ns.items.filter((i) => i.active && !i.live).length,
      items: ns.items.slice().sort((x, y) => y.stock - x.stock).slice(0, 12) } : { ok: false, why: (await noonKey(env)) ? "no_skus" : "no_key" };
    return json(200, { ok: true, at: now(), store, noon });
  }
  if (path === "/api/usage") { // الاستهلاك: عدد الجلسات الفعلي من سجل المكتب + تقدير التوكنز والدولار
    const per = Number(await getSetting(env, "cost_per_session", 0.35)), tokPer = Number(await getSetting(env, "tokens_per_session", 600000));
    const dayStart = (d) => Date.parse(riyadhDayStr(d) + "T00:00:00+03:00");
    const rows = (await env.DB.prepare("SELECT at, emp FROM logs WHERE act = 'woke' AND at >= ?").bind(now() - 31 * 864e5).all()).results || [];
    const today = dayStart(0), week = now() - 7 * 864e5, month = now() - 30 * 864e5;
    const sum = (from) => { const by = {}; let n = 0; for (const r of rows) if (r.at >= from) { n++; by[r.emp] = (by[r.emp] || 0) + 1; } return { sessions: n, usd: +(n * per).toFixed(2), tokens: n * tokPer, by }; };
    return json(200, { ok: true, perSession: per, tokensPerSession: tokPer, today: sum(today), week: sum(week), month: sum(month), fireCap: Number(await getSetting(env, "fire_cap", 60)) });
  }
  if (path === "/api/meeting-new") { // المالك يسوي اجتماع: يختار الموظفين والموضوع، وسلطان يدير النقاش
    const topic = clip(body.topic, 500).trim();
    const who = [...new Set((Array.isArray(body.who) ? body.who : []).filter((k) => teamKeys.has(k)))];
    if (!topic) return json(400, { ok: false, code: "no_topic" });
    if (who.length < 2) return json(400, { ok: false, code: "need_two" });
    const cap = Number(await getSetting(env, "meeting_cap", 5));
    if (!(await bump(env, "meeting", cap))) return json(429, { ok: false, code: "meeting_cap", cap });
    const m = await env.DB.prepare("INSERT INTO meetings (at, by, topic, who) VALUES (?, 'owner', ?, ?) RETURNING id").bind(now(), topic, JSON.stringify(who)).first();
    if (body.note) await env.DB.prepare("INSERT INTO meeting_lines (meeting, at, emp, text) VALUES (?, ?, 'owner', ?)").bind(m.id, now(), clip(body.note, 2000)).run();
    const names = who.map((k) => TEAM.find((t) => t.key === k).person).join("، ");
    const woke = {};
    for (const k of who) {
      if (k === "manager") continue;
      woke[k] = (await giveTask(env, k, `اجتماع رقم ${m.id} طلبه المالك: ${topic}\nالمشاركين: ${names}\nاقرأ المحضر (meeting-read)، وقل رأيك بصراحة (meeting-say). إذا فيه خلاف رد على زملائك بالاسم. ممنوع أي تنفيذ من هالاجتماع بدون موافقة المالك.`, "المدير العام", null, `اجتماع: ${topic}`)).woke;
    }
    // سلطان يدير الاجتماع دايماً (حتى لو ما اختاره المالك كمشارك)
    woke.manager = (await giveTask(env, "manager", `أدر الاجتماع رقم ${m.id} اللي طلبه المالك: ${topic}\nالمشاركين: ${names}\nانتظر آراءهم (meeting-read لين waitingFor تفضى، حد ٢٠ دقيقة)، سوّ جولة ثانية للخلاف بس، وبعدها meeting-close بالقرار وagreed. ${who.includes("manager") ? "وأنت مشارك بعد، قل رأيك." : "أنت تدير بس."} بعدها أرسل للمالك خلاصة قصيرة (/agent/tell). أي تنفيذ يحتاج موافقة المالك.`, "الموقع", null, `أدر اجتماع: ${topic}`)).woke;
    await log(env, "manager", "meeting_opened", { id: m.id, topic: topic.slice(0, 200), by: "المالك" });
    return json(200, { ok: true, id: m.id, woke });
  }
  if (path === "/api/meeting-say") { // المالك يعلّق في قروب الاجتماع
    const m = await env.DB.prepare("SELECT * FROM meetings WHERE id = ?").bind(Number(body.id)).first();
    if (!m) return json(404, { ok: false });
    const text = clip(body.text, 2000).trim();
    if (!text) return json(400, { ok: false, code: "empty" });
    await env.DB.prepare("INSERT INTO meeting_lines (meeting, at, emp, text) VALUES (?, ?, 'owner', ?)").bind(m.id, now(), text).run();
    const lastWake = await env.DB.prepare("SELECT at FROM logs WHERE emp = 'manager' AND act = 'woke' ORDER BY id DESC LIMIT 1").first();
    if (m.status === "open" && !(lastWake && now() - lastWake.at < 10 * 60e3)) await wake(env, "manager", `المالك علّق في الاجتماع رقم ${m.id} (${m.topic}):\n${text}\nخذ تعليقه بالاعتبار وكمّل الاجتماع.`);
    return json(200, { ok: true });
  }
  if (path === "/api/replies-seen") {
    await env.DB.prepare("INSERT INTO seen (k, v) VALUES ('replies', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(now()).run();
    return json(200, { ok: true });
  }
  if (path === "/api/log") {
    const emp = url.searchParams.get("emp");
    if (!teamKeys.has(emp)) return json(400, { ok: false, code: "bad_emp" });
    const rs = (await env.DB.prepare("SELECT at, act, info FROM logs WHERE emp = ? ORDER BY id DESC LIMIT 100").bind(emp).all()).results || [];
    const tasks = (await env.DB.prepare("SELECT * FROM tasks WHERE emp = ? ORDER BY id DESC LIMIT 20").bind(emp).all()).results || [];
    return json(200, { ok: true, log: rs, tasks });
  }
  if (path === "/api/meeting") {
    const id = Number(url.searchParams.get("id"));
    const m = await env.DB.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first();
    if (!m) return json(404, { ok: false });
    const lines = (await env.DB.prepare("SELECT * FROM meeting_lines WHERE meeting = ? ORDER BY id").bind(id).all()).results || [];
    return json(200, { ok: true, meeting: m, lines });
  }
  if (path === "/api/decide") return json(...(await decide(env, Number(body.id), body.yes === true, "الموقع")));
  if (path === "/api/perm") {
    if (!teamKeys.has(body.emp) || !areaOf(body.area) || !LEVELS.includes(body.level)) return json(400, { ok: false, code: "bad" });
    if (body.emp === "noon" && body.level === "auto") return json(400, { ok: false, code: "noon_red_line" }); // 🔴 مسؤول نون ما ينفّذ لحاله أبداً
    await env.DB.prepare("INSERT INTO perms (emp, area, level) VALUES (?, ?, ?) ON CONFLICT(emp, area) DO UPDATE SET level = excluded.level").bind(body.emp, body.area, body.level).run();
    await log(env, body.emp, "perm_changed", { area: areaOf(body.area).name, level: body.level, by: "المالك" });
    return json(200, { ok: true, perms: await permsOf(env, body.emp) });
  }
  if (path === "/api/task") {
    if (!teamKeys.has(body.emp)) return json(400, { ok: false, code: "bad_emp" });
    const text = clip(body.text, 4000).trim();
    if (!text) return json(400, { ok: false, code: "empty" });
    // ملف مرفق (مثل إكسل الأسعار): يتخزن في قاعدة المكتب الخاصة، والموظف ينزّله برمز جلسته
    const f = body.file;
    if (f && (typeof f.b64 !== "string" || f.b64.length > 1400000 || !/^[A-Za-z0-9+/=]+$/.test(f.b64))) return json(400, { ok: false, code: "file_too_big_or_bad" });
    const note = f ? `\n[مرفق: ${clip(f.name, 120)} — نزّله بـ POST /agent/file {"emp","task":<رقم المهمة>}]` : "";
    const r = await giveTaskFast(env, body.emp, text + note, "الموقع", f ? async (id) => {
      await env.DB.prepare("INSERT INTO files (task, name, type, size, b64, at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, clip(f.name, 120), clip(f.type, 100), Math.floor(f.b64.length * 3 / 4), f.b64, now()).run();
    } : null, f ? `${text}\n📎 ${clip(f.name, 120)}` : text);
    return json(200, r);
  }
  if (path === "/api/rules") {
    const r = { ...DEFAULT_RULES, ...(await getSetting(env, "rules", {})) };
    if (body.cashLimit != null) r.cashLimit = Math.max(0, Math.min(100000, Number(body.cashLimit) || 0));
    if (["urgent", "important", "none"].includes(body.wakeOn)) r.wakeOn = body.wakeOn;
    await setSetting(env, "rules", r);
    if (body.fireCap != null) await setSetting(env, "fire_cap", Math.max(0, Math.min(200, Number(body.fireCap) || 0)));
    if (body.meetingCap != null) await setSetting(env, "meeting_cap", Math.max(0, Math.min(50, Number(body.meetingCap) || 0)));
    await log(env, "manager", "rules_changed", { by: "المالك" });
    return json(200, { ok: true, rules: r });
  }
  if (path === "/api/config") { // أسرار يحطها المالك من الموقع: تنحفظ وما ترجع للمتصفح
    for (const k of CFG_KEYS) {
      const v = body[k] == null ? null : clip(body[k], 300).trim();
      if (v) await setSetting(env, "cfg:" + k, v);
    }
    if (body.TELEGRAM_BOT_TOKEN) await env.DB.prepare("DELETE FROM settings WHERE k = 'tg_chat'").run();
    await env.DB.prepare("DELETE FROM settings WHERE k = 'store_session'").run();
    await log(env, "manager", "config_changed", { keys: CFG_KEYS.filter((k) => body[k]), by: "المالك" });
    return json(200, { ok: true });
  }
  if (path === "/api/noon-key") { // ملف مفتاح نون (.json): ينحفظ مخفي ويتجرب فوراً
    const p = parseNoonKey(clip(body.text, 20000));
    if (p.error) return json(400, { ok: false, code: p.error });
    await setSetting(env, "cfg:NOON_KEY", p.key);
    await env.DB.prepare("DELETE FROM settings WHERE k = 'noon_session'").run();
    await log(env, "noon", "key_saved", { by: "المالك" });
    const t = await noonCall(env, "GET", "/impex/v1/export/category/list");
    return json(200, { ok: true, test: { ok: t.ok, status: t.status, code: t.code || null, exports: (t.data?.export_categories || []).map((c) => c.export_category_code) } });
  }
  if (path === "/api/noon-test") {
    const t = await noonCall(env, "GET", "/impex/v1/export/category/list");
    return json(200, { ok: t.ok, status: t.status, code: t.code || null, exports: (t.data?.export_categories || []).map((c) => c.export_category_code) });
  }
  if (path === "/api/noon-skus") {
    const skus = [...new Set(String(body.skus || "").split(/[\s,،]+/).map((x) => x.trim()).filter((x) => /^[\w.\-/]{1,120}$/.test(x)))].slice(0, 150);
    await setSetting(env, "noon_skus", skus);
    await log(env, "noon", "skus_set", { n: skus.length, by: "المالك" });
    return json(200, { ok: true, n: skus.length });
  }
  if (path === "/api/routine") { // ربط جلسة موظف: الرمز ينحفظ وما يرجع للمتصفح أبداً
    if (!teamKeys.has(body.emp)) return json(400, { ok: false, code: "bad_emp" });
    // تنظيف: مسافات، أسطر، حروف مخفية، علامات تنصيص (تنلصق من الجوال)
    const clean = (v) => String(v ?? "").replace(/[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff"'`«»]/g, "");
    const id = clean(clip(body.id, 200)) || TEAM.find((t) => t.key === body.emp).routine, token = clean(clip(body.token, 1000));
    if (body.clear) { await env.DB.prepare("DELETE FROM settings WHERE k = ?").bind("routine:" + body.emp).run(); await log(env, body.emp, "routine_unlinked", { by: "المالك" }); return json(200, { ok: true }); }
    if (!/^trig_[A-Za-z0-9]{10,60}$/.test(id)) return json(400, { ok: false, code: "bad_routine_id" });
    if (/^https?:/i.test(token)) return json(400, { ok: false, code: "token_is_url" });
    if (!token) return json(400, { ok: false, code: "token_empty" });
    if (/\.\.\.|…/.test(token)) return json(400, { ok: false, code: "token_masked" }); // المعاينة المختصرة من صفحة Claude
    if (!token.startsWith("sk-ant-")) return json(400, { ok: false, code: "token_prefix", start: token.slice(0, 3) });
    if (token.length < 40) return json(400, { ok: false, code: "token_short", len: token.length });
    await setSetting(env, "routine:" + body.emp, { id, token });
    await log(env, body.emp, "routine_linked", { by: "المالك" });
    return json(200, { ok: true });
  }
  if (path === "/api/tg-setup") { // المالك يرسل أي رسالة للبوت، وبعدها يضغط «اربط تيليقرام»
    if (!env.TELEGRAM_BOT_TOKEN) return json(400, { ok: false, code: "no_bot" });
    const f = env.fetch || fetch, base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
    await f(`${base}/deleteWebhook`, { method: "POST" }).catch(() => {});
    const up = await (await f(`${base}/getUpdates?limit=50`)).json().catch(() => ({}));
    const priv = (up.result || []).map((u) => u.message).filter((m) => m && m.chat && m.chat.type === "private").pop();
    if (!priv) return json(400, { ok: false, code: "send_message_first" });
    await setSetting(env, "tg_chat", String(priv.chat.id));
    const hook = await (await f(`${base}/setWebhook`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `${url.origin}/tg`, secret_token: await tgHookSecret(env), allowed_updates: ["message", "callback_query"] }) })).json().catch(() => ({}));
    await tg(env, "✅ انربط تيليقرام بمكتب متاجر أحد. من هنا بتوصلك التنبيهات والموافقات.");
    return json(200, { ok: !!hook.ok, name: priv.chat.first_name || "" });
  }
  if (path === "/api/analyze") {
    const a = await env.DB.prepare("SELECT * FROM alerts WHERE id = ?").bind(Number(body.id)).first();
    if (!a) return json(404, { ok: false });
    const who = alertOwner(a), w = await wake(env, who, alertPrompt(a));
    return json(200, { ...w, who: nameOf(who), why: w.ok ? null : whyNot(who, w.code) });
  }
  return json(404, { ok: false, code: "not_found" });
}

// ---------- تقرير الصباح بدون ذكاء اصطناعي ----------
async function snapshotDay(env, day) {
  if (await getSetting(env, "snap:" + day)) return;
  const r = await storeCall(env, "/admin/today");
  if (r.ok) await setSetting(env, "snap:" + day, { today: r.body.today, lastWeek: r.body.lastWeek, at: now() });
}
const sar = (n) => `${Number(n || 0).toLocaleString("ar-SA", { maximumFractionDigits: 2 })} ر.س`;
export async function morningReport(env, yday) {
  const snap = await getSetting(env, "snap:" + yday);
  const cash = await storeCall(env, "/admin/cash");
  const late = await storeCall(env, "/admin/alerts");
  const open = (await env.DB.prepare("SELECT level, title FROM alerts WHERE open = 1 ORDER BY CASE level WHEN 'urgent' THEN 0 ELSE 1 END LIMIT 5").all()).results || [];
  const L = [];
  if (snap) {
    const d = snap.today, w = snap.lastWeek || {};
    const chg = w.revenue ? Math.round((d.revenue - w.revenue) / w.revenue * 100) : null;
    L.push(`أمس: ${d.orders} طلب · ${sar(d.revenue)}${chg != null ? ` (${chg >= 0 ? "+" : ""}${chg}٪ عن نفس اليوم الأسبوع اللي طاف)` : ""}`);
    if (d.cost > 0) L.push(`الربح التقريبي: ${sar(d.revenue - d.cost)}`);
    if (d.canceled) L.push(`ملغي: ${d.canceled}`);
  } else L.push("أرقام أمس ما انحفظت (المكتب ما قدر يقرأ المتجر آخر الليل).");
  if (cash.ok && cash.body.balance > 0) L.push(`كاش عند المناديب: ${sar(cash.body.balance)}`);
  if (late.ok && (late.body.orders || []).length) L.push(`طلبات متأخرة الحين: ${late.body.orders.length}`);
  if (open.length) L.push("تنبيهات مفتوحة: " + open.map((a) => a.title).join(" · "));
  const text = L.join("\n");
  await tg(env, `📊 تقرير الصباح (ناصر)\n${text}`);
  await addMsg(env, "morning", "emp", text, "report");
  await log(env, "morning", "morning_report", { auto: true });
  return text;
}

async function giveTask(env, emp, text, src, before, shown) {
  // نفس الرسالة لنفس الموظف خلال دقيقتين (ضغطة مكررة) = مهمة وحدة، عشان ما يجي جوابين مختلفين لنفس السؤال
  const dup = await env.DB.prepare("SELECT id FROM tasks WHERE emp = ? AND text = ? AND at > ?").bind(emp, text, now() - 120e3).first();
  if (dup) return { ok: true, id: dup.id, woke: true, duplicate: true };
  const r = await env.DB.prepare("INSERT INTO tasks (at, emp, text, src) VALUES (?, ?, ?, ?) RETURNING id").bind(now(), emp, text, src).first();
  if (before) await before(r.id);
  // في المحادثة: رسالة المالك، أو «طلب من سلطان» لو من المدير
  if (src === "المدير العام") await addMsg(env, emp, "sys", `سلطان طلب: ${String(shown ?? text).slice(0, 1500)}`, "text", r.id);
  else await addMsg(env, emp, "owner", shown ?? text, "text", r.id);
  await log(env, emp, "task_received", { id: r.id, src });
  const w = await wake(env, emp, `مهمة جديدة من المالك (رقم ${r.id}):\n${text}`);
  if (!w.ok) await addMsg(env, emp, "sys", whyNot(emp, w.code));
  return { ok: true, id: r.id, woke: w.ok, wakeCode: w.code || null, why: w.ok ? null : whyNot(emp, w.code), url: w.url || null };
}
// للموقع: نحفظ الرسالة ونرد فوراً، والتصحية تكمل بالخلفية
async function giveTaskFast(env, emp, text, src, before, shown) {
  if (!CTX || !CTX.waitUntil || env.SYNC_WAKE) return giveTask(env, emp, text, src, before, shown); // SYNC_WAKE للاختبارات
  let resolveId; const idP = new Promise((r) => (resolveId = r));
  const job = giveTask(env, emp, text, src, async (id) => { if (before) await before(id); resolveId(id); }, shown).catch(() => resolveId(null));
  CTX.waitUntil(job);
  const id = await Promise.race([idP, job.then((x) => x?.id)]);
  return { ok: true, id, queued: true };
}

// موافقة أو رفض (من الموقع أو تيليقرام)
async function decide(env, id, yes, how) {
  const r = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first();
  if (!r) return [404, { ok: false, code: "not_found" }];
  if (r.status !== "pending") return [409, { ok: false, code: "already", status: r.status }];
  const st = yes ? "approved" : "rejected";
  await env.DB.prepare("UPDATE requests SET status = ?, decided = ?, how = ? WHERE id = ? AND status = 'pending'").bind(st, now(), how, id).run();
  await log(env, r.emp, yes ? "approved_by_owner" : "rejected_by_owner", { id, title: r.title, how });
  await addMsg(env, r.emp, "sys", `${yes ? "✓ وافقت على" : "✕ رفضت"}: ${r.title}`, "text", id);
  // توفير: ما نصحّي الموظف عشان يعرف القرار؛ يشوفه في brief أول ما يشتغل
  return [200, { ok: true, status: st }];
}

// ================= جلسات الموظفين =================
async function agentApi(request, env, path, url) {
  const auth = request.headers.get("Authorization") || "";
  const body = await readBody(request);
  if (body === null) return json(400, { ok: false, code: "bad_body" });
  const emp = body.emp || url.searchParams.get("emp");
  // رمز ثابت (اختياري) أو رمز الجلسة المؤقت اللي يجي مع كل تشغيل (مربوط بموظف واحد)
  let allowed = !!env.AGENT_TOKEN && sameText(auth, `Bearer ${env.AGENT_TOKEN}`);
  if (!allowed && /^Bearer [a-f0-9]{48}$/.test(auth)) {
    const t = await env.DB.prepare("SELECT emp, expires FROM agent_tokens WHERE hash = ?").bind(await sha(auth.slice(7))).first();
    if (t && t.expires > now()) { if (t.emp !== emp) return json(403, { ok: false, code: "token_for_other_employee", you: t.emp }); allowed = true; }
  }
  if (!allowed) return json(401, { ok: false, code: "agent_auth" });
  if (!teamKeys.has(emp)) return json(400, { ok: false, code: "bad_emp", team: [...teamKeys] });

  if (path === "/agent/brief") { // أول شي يسويه الموظف: وش عندي؟
    const tasks = (await env.DB.prepare("SELECT id, at, text, src FROM tasks WHERE emp = ? AND status = 'open' ORDER BY id").bind(emp).all()).results || [];
    const mine = (await env.DB.prepare("SELECT id, title, status, decided FROM requests WHERE emp = ? ORDER BY id DESC LIMIT 20").bind(emp).all()).results || [];
    // كل موظف يشوف تنبيهات مجاله: راكان تنبيهات نون بس، والباقين تنبيهات البقالة (عشان ما تختلط)
    const alerts = (await env.DB.prepare(`SELECT id, level, title, body, first FROM alerts WHERE open = 1 AND k ${emp === "noon" ? "LIKE" : "NOT LIKE"} 'noon%' ORDER BY id DESC LIMIT 30`).all()).results || [];
    const meetings = (await env.DB.prepare("SELECT id, topic, by, status FROM meetings WHERE status = 'open' ORDER BY id").all()).results || [];
    const recent = (await env.DB.prepare("SELECT at, act FROM logs WHERE emp = ? AND act NOT IN ('woke','task_received','wake_queued','read_store','read_noon') ORDER BY id DESC LIMIT 8").bind(emp).all()).results || [];
    const instructions = `${AGENT_TEXT.common || ""}\n\n${AGENT_TEXT[emp] || ""}`;
    const me = TEAM.find((t) => t.key === emp);
    // سلطان يشوف آخر شغل الفريق كله عشان ينسّق ويما يكرر
    const team = emp === "manager" ? ((await env.DB.prepare("SELECT datetime(at/1000,'unixepoch','+3 hours') t, emp, frm, kind, substr(text,1,200) text FROM messages ORDER BY id DESC LIMIT 15").all()).results || []) : undefined;
    return json(200, { ok: true, instructions, me: { key: me.key, person: me.person, name: me.name }, perms: await permsOf(env, emp), tasks, requests: mine.slice(0, 8), alerts: alerts.slice(0, 10), meetings, recent, ...(team ? { team } : {}) });
  }
  if (path === "/agent/status") {
    const st = ["idle", "working", "meeting"].includes(body.status) ? body.status : "idle";
    await env.DB.prepare("INSERT INTO emp_state (emp, status, session_url, note, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(emp) DO UPDATE SET status = excluded.status, session_url = COALESCE(excluded.session_url, emp_state.session_url), note = excluded.note, at = excluded.at")
      .bind(emp, st, body.sessionUrl ? clip(body.sessionUrl, 300) : null, body.note ? clip(body.note, 200) : null, now()).run();
    return json(200, { ok: true });
  }
  if (path === "/agent/log") { await log(env, emp, clip(body.act || "note", 200), body.info ?? null); return json(200, { ok: true }); }

  // يكلم المالك: المدير ومطوّر الأفكار والمساعد بس، والباقي عن طريق المدير
  if (path === "/agent/tell") {
    const text = clip(body.text, 3500).trim();
    if (!text) return json(400, { ok: false, code: "empty" });
    await tg(env, `💬 ${nameOf(emp)}:\n${text}`);
    await log(env, emp, "told_owner", { text: text.slice(0, 300) });
    await addMsg(env, emp, "emp", text);
    return json(200, { ok: true });
  }
  if (path === "/agent/file") { // ملف مرفق بمهمة الموظف نفسه
    const t = await env.DB.prepare("SELECT id FROM tasks WHERE id = ? AND emp = ?").bind(Number(body.task), emp).first();
    if (!t) return json(404, { ok: false, code: "not_your_task" });
    const fl = (await env.DB.prepare("SELECT name, type, size, b64 FROM files WHERE task = ?").bind(t.id).all()).results || [];
    await log(env, emp, "file_read", { task: t.id, n: fl.length });
    return json(200, { ok: true, files: fl });
  }
  if (path === "/agent/task-done") {
    const t = await env.DB.prepare("SELECT * FROM tasks WHERE id = ? AND emp = ?").bind(Number(body.id), emp).first();
    if (!t) return json(404, { ok: false });
    await env.DB.prepare("UPDATE tasks SET status = 'done', result = ?, done = ? WHERE id = ?").bind(clip(body.result, 4000), now(), t.id).run();
    await log(env, emp, "task_done", { id: t.id });
    await addMsg(env, emp, "emp", clip(body.result, 4000), "text", t.id);
    // المهمة من المالك نفسه: الرد يوصله مباشرة، أياً كان الموظف
    if (t.src !== "المدير العام" || TEAM.find((x) => x.key === emp)?.direct) await tg(env, `✅ ${nameOf(emp)} خلّص مهمتك رقم ${t.id}:\n${clip(body.result, 3000)}`);
    return json(200, { ok: true });
  }
  if (path === "/agent/assign") { // المدير يوزّع شغل على موظف
    if (emp !== "manager" || !teamKeys.has(body.to)) return json(403, { ok: false, code: "manager_only" });
    const text = clip(body.text, 4000).trim();
    if (!text) return json(400, { ok: false, code: "empty" });
    return json(200, await giveTask(env, body.to, text, "المدير العام"));
  }

  // ----- الاجتماعات -----
  if (path === "/agent/meeting-open") {
    const cap = Number(await getSetting(env, "meeting_cap", 5));
    if (!(await bump(env, "meeting", cap))) return json(429, { ok: false, code: "meeting_cap", cap });
    const r = await env.DB.prepare("INSERT INTO meetings (at, by, topic) VALUES (?, ?, ?) RETURNING id").bind(now(), emp, clip(body.topic, 500)).first();
    await log(env, emp, "meeting_opened", { id: r.id, topic: clip(body.topic, 200) });
    return json(200, { ok: true, id: r.id });
  }
  if (path === "/agent/meeting-say") {
    const m = await env.DB.prepare("SELECT * FROM meetings WHERE id = ?").bind(Number(body.id)).first();
    if (!m || m.status !== "open") return json(409, { ok: false, code: "meeting_closed" });
    await env.DB.prepare("INSERT INTO meeting_lines (meeting, at, emp, text) VALUES (?, ?, ?, ?)").bind(m.id, now(), emp, clip(body.text, 4000)).run();
    return json(200, { ok: true });
  }
  if (path === "/agent/meeting-read") {
    const m = await env.DB.prepare("SELECT * FROM meetings WHERE id = ?").bind(Number(body.id ?? url.searchParams.get("id"))).first();
    if (!m) return json(404, { ok: false });
    const lines = (await env.DB.prepare("SELECT at, emp, text FROM meeting_lines WHERE meeting = ? ORDER BY id").bind(m.id).all()).results || [];
    const spoke = new Set(lines.map((l) => l.emp));
    const members = m.who ? JSON.parse(m.who) : TEAM.map((t) => t.key);
    return json(200, { ok: true, meeting: m, members, lines, waitingFor: members.filter((k) => !spoke.has(k)) });
  }
  if (path === "/agent/meeting-invite") { // المدير يصحّي الموظفين للاجتماع (كل واحد جلسة مستقلة)
    if (emp !== "manager") return json(403, { ok: false, code: "manager_only" });
    const m = await env.DB.prepare("SELECT * FROM meetings WHERE id = ?").bind(Number(body.id)).first();
    if (!m || m.status !== "open") return json(409, { ok: false, code: "meeting_closed" });
    // اجتماع المالك: بس المشاركين اللي اختارهم (كان سلطان يدعو الكل ويصرف جلسات زيادة)
    const members = m.who ? JSON.parse(m.who) : TEAM.map((t) => t.key);
    const who = (Array.isArray(body.who) && body.who.length ? body.who : members).filter((k) => teamKeys.has(k) && k !== "manager" && members.includes(k));
    const out = {};
    for (const k of who) out[k] = (await giveTask(env, k, `اجتماع رقم ${m.id}: ${m.topic}\n${clip(body.note, 1500)}\nاقرأ المحضر وقل رأيك بصراحة (موافق / معترض ولماذا / اقتراح أفضل).`, "المدير العام")).woke;
    return json(200, { ok: true, woke: out });
  }
  if (path === "/agent/meeting-close") { // المدير بس يقفل الاجتماع ويكتب القرار
    if (emp !== "manager") return json(403, { ok: false, code: "manager_only" });
    const m = await env.DB.prepare("SELECT * FROM meetings WHERE id = ?").bind(Number(body.id)).first();
    if (!m || m.status !== "open") return json(409, { ok: false, code: "meeting_closed" });
    const spoke = new Set(((await env.DB.prepare("SELECT DISTINCT emp FROM meeting_lines WHERE meeting = ?").bind(m.id).all()).results || []).map((r) => r.emp));
    const agreed = Array.isArray(body.agreed) ? body.agreed.filter((k) => teamKeys.has(k) && spoke.has(k)) : [];
    const members = m.who ? JSON.parse(m.who) : TEAM.map((t) => t.key);
    const all = members.every((k) => agreed.includes(k));
    await env.DB.prepare("UPDATE meetings SET status = ?, decision = ?, agreed = ?, closed = ? WHERE id = ?")
      .bind(all ? "agreed" : "no_consensus", clip(body.decision, 4000), JSON.stringify(agreed), now(), m.id).run();
    await log(env, emp, "meeting_closed", { id: m.id, all });
    if (m.by === "owner") await tg(env, `👥 خلص اجتماع «${m.topic}»\nالقرار: ${clip(body.decision, 1500)}`);
    return json(200, { ok: true, status: all ? "agreed" : "no_consensus", missing: members.filter((k) => !agreed.includes(k)) });
  }

  // ----- طلب تنفيذ (قاعدة المالك: الكبير ينتظر، البسيط ينفذ، وأي نزول بعد اجتماع الكل) -----
  if (path === "/agent/request") {
    const area = areaOf(body.area);
    if (!area) return json(400, { ok: false, code: "bad_area" });
    const level = (await permsOf(env, emp))[area.key];
    if (level === "read") return json(403, { ok: false, code: "read_only", area: area.key });
    const deploy = body.deploy === true;
    let meeting = null;
    if (deploy) {
      meeting = await env.DB.prepare("SELECT * FROM meetings WHERE id = ?").bind(Number(body.meeting)).first();
      if (!meeting || meeting.status !== "agreed" || meeting.who) return json(409, { ok: false, code: "needs_full_meeting" }); // اجتماع الفريق كامل، مو اجتماع مخصص
    }
    const testsFailed = body.testsPassed === false;
    // 🔴 خط أحمر (قرار المالك ٢٥ نوفمبر ٢٠٢٦): أي تعديل يخص نون، ولو مثقال ذرة، ينتظر إذن المالك دايماً.
    // أي طلب من مسؤول نون، أو يذكر نون، يصير «كبير» مهما كانت الصلاحية أو المجال أو الاجتماع.
    const noonRed = emp === "noon" || body.noon === true || /نون|noon/i.test(`${body.title || ""} ${body.detail || ""}`);
    const big = area.big || testsFailed || level === "propose" || noonRed;
    const status = big ? "pending" : "approved";
    const r = await env.DB.prepare("INSERT INTO requests (at, emp, area, big, deploy, meeting, title, detail, status, decided, how) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(now(), emp, area.key, big ? 1 : 0, deploy ? 1 : 0, meeting ? meeting.id : null, clip(body.title, 300), clip(body.detail, 4000), status, big ? null : now(), big ? null : "تلقائي (بسيط)").first();
    await log(env, emp, big ? "asked_approval" : "auto_approved", { id: r.id, title: clip(body.title, 200), area: area.name });
    await addMsg(env, emp, "emp", clip(body.title, 300), "card", r.id);
    if (big) {
      await tg(env, `${noonRed ? "🔴 خط أحمر · تعديل على نون\n" : ""}🟡 ينتظر موافقتك (${nameOf(emp)})\n${clip(body.title, 300)}\nالمجال: ${area.name}${testsFailed ? "\n⚠️ فيه اختبار فشل" : ""}${meeting ? `\nاجتماع رقم ${meeting.id}: اتفقوا كلهم` : ""}\n\n${clip(body.detail, 1500)}`,
        [[{ text: "✅ موافق", callback_data: `a:${r.id}:y` }, { text: "❌ رفض", callback_data: `a:${r.id}:n` }]]);
    } else {
      await tg(env, `🟢 ${nameOf(emp)} نفّذ تعديل بسيط بعد اتفاق الفريق:\n${clip(body.title, 300)}`, [[{ text: "↩️ تراجع", callback_data: `u:${r.id}` }]]);
    }
    return json(200, { ok: true, id: r.id, status });
  }
  if (path === "/agent/request-status") {
    const r = await env.DB.prepare("SELECT id, status, decided, how FROM requests WHERE id = ? AND emp = ?").bind(Number(body.id ?? url.searchParams.get("id")), emp).first();
    return r ? json(200, { ok: true, ...r }) : json(404, { ok: false });
  }
  // قراءة بيانات المتجر عن طريق المكتب (حساب «قارئ المكتب»، قراءة بس)
  if (path === "/agent/store") {
    // راكان (نون) ما يقرأ بيانات البقالة أبداً: عشان ما يخلط أرقام متاجر أحد بأرقام نون (قرار المالك ٢٥ نوفمبر ٢٠٢٦)
    if (emp === "noon") return json(403, { ok: false, code: "noon_reads_noon_only", message: "أنت مسؤول نون: بيانات البقالة (متاجر أحد) مو لك. استخدم /agent/noon و /agent/noon-export بس. لو بيانات نون ما ظهرت، قل للمالك كذا بوضوح، ولا تعوّضها بأرقام البقالة." });
    const allowed = ["/admin/alerts", "/admin/stock", "/admin/today", "/admin/cash"];
    if (!allowed.includes(body.path)) return json(400, { ok: false, code: "path_not_allowed", allowed });
    const q = body.path === "/admin/stock" ? (body.summary ? { summary: true } : Array.isArray(body.ids) ? { ids: body.ids.slice(0, 500).map(String) } : {}) : {};
    const r = await storeCall(env, body.path, q);
    await log(env, emp, "read_store", { path: body.path, ok: r.ok });
    return json(r.ok ? 200 : 502, { ok: r.ok, status: r.status, data: r.body });
  }
  // قراءة نون عن طريق المكتب (قراءة بس؛ أي تعديل سعر أو مخزون = طلب موافقة)
  if (path === "/agent/noon") {
    if (!["noon", "manager", "morning", "pricing"].includes(emp)) return json(403, { ok: false, code: "not_allowed" });
    const method = body.method === "POST" ? "POST" : "GET", p = String(body.path || "");
    if (!noonReadAllowed(method, p)) return json(400, { ok: false, code: "read_only_paths" });
    const r = await noonCall(env, method, p, method === "POST" ? body.body || {} : undefined);
    await log(env, emp, "read_noon", { path: p.slice(0, 80), ok: r.ok });
    return json(r.ok ? 200 : 502, { ok: r.ok, status: r.status, code: r.code || null, data: r.data });
  }
  // تقارير نون (مثل المبيعات): المكتب يطلب التقرير وينزّله بنفسه ويرجّع محتواه
  if (path === "/agent/noon-export") {
    if (!["noon", "manager", "morning"].includes(emp)) return json(403, { ok: false, code: "not_allowed" });
    if (body.export_code) {
      const st = await noonCall(env, "POST", "/impex/v1/export/status", { export_code: clip(body.export_code, 200) });
      if (!st.ok) return json(502, { ok: false, status: st.status, code: st.code || null, data: st.data });
      const url2 = st.data?.download_url;
      if (!url2 || !/^https:\/\//.test(url2)) return json(200, { ok: true, ready: false, status: st.data?.export_status });
      const dl = await (env.fetch || fetch)(url2).catch(() => null);
      if (!dl || !dl.ok) return json(502, { ok: false, code: "download_failed" });
      const buf = new Uint8Array(await dl.arrayBuffer());
      const head = String.fromCharCode(...buf.slice(0, 4));
      if (head.startsWith("PK")) return json(200, { ok: true, ready: true, format: "xlsx_or_zip", bytes: buf.length, base64: buf.length <= 3e6 ? toB64(buf) : null });
      const text = new TextDecoder().decode(buf);
      await log(env, emp, "noon_export", { bytes: buf.length });
      return json(200, { ok: true, ready: true, format: "text", bytes: buf.length, text: text.slice(0, 400000), truncated: text.length > 400000 });
    }
    if (!body.export_category_code) return json(400, { ok: false, code: "need_export_category_code_or_export_code" });
    const cr = await noonCall(env, "POST", "/impex/v1/export/create", { export_category_code: clip(body.export_category_code, 100), params: body.params && typeof body.params === "object" ? body.params : {} });
    await log(env, emp, "noon_export_requested", { cat: clip(body.export_category_code, 100), ok: cr.ok });
    return json(cr.ok ? 200 : 502, { ok: cr.ok, status: cr.status, data: cr.data });
  }
  if (path === "/agent/noon-skus") { // مسؤول نون يحدد المنتجات اللي تنراقب (إعداد مكتب = بسيط)
    if (emp !== "noon") return json(403, { ok: false, code: "noon_only" });
    const skus = [...new Set((Array.isArray(body.skus) ? body.skus : []).map(String).filter((x) => /^[\w.\-/]{1,120}$/.test(x)))].slice(0, 150);
    await setSetting(env, "noon_skus", skus);
    await log(env, emp, "skus_set", { n: skus.length });
    return json(200, { ok: true, n: skus.length });
  }
  if (path === "/agent/report") { // تقرير الصباح يوصل للمالك مباشرة
    if (emp !== "morning") return json(403, { ok: false, code: "morning_only" });
    const text = clip(body.text, 3800).trim();
    if (!text) return json(400, { ok: false, code: "empty" });
    await tg(env, `📊 تقرير الصباح\n${text}`);
    await log(env, emp, "morning_report", { len: text.length });
    await addMsg(env, emp, "emp", text, "report");
    return json(200, { ok: true });
  }
  if (path === "/agent/alert-done") {
    await env.DB.prepare("UPDATE alerts SET open = 0 WHERE id = ?").bind(Number(body.id)).run();
    await log(env, emp, "alert_closed", { id: Number(body.id), note: clip(body.note, 300) });
    return json(200, { ok: true });
  }
  return json(404, { ok: false, code: "not_found" });
}

// ================= تيليقرام =================
async function telegram(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !sameText(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", await tgHookSecret(env))) return json(401, { ok: false });
  const u = await request.json().catch(() => ({}));
  const owner = (await ownerChat(env)) || "__none__";
  const answer = async (id, text) => { if (env.TELEGRAM_BOT_TOKEN) await (env.fetch || fetch)(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: id, text }) }).catch(() => {}); };

  if (u.callback_query) {
    const q = u.callback_query;
    if (String(q.from?.id) !== owner && String(q.message?.chat?.id) !== owner) return json(200, { ok: true });
    const d = String(q.data || "");
    let m;
    if ((m = d.match(/^a:(\d+):([yn])$/))) { const [, res] = await decide(env, Number(m[1]), m[2] === "y", "تيليقرام"); await answer(q.id, res.ok ? (m[2] === "y" ? "تمت الموافقة" : "انرفض") : "انحسم من قبل"); }
    else if ((m = d.match(/^[zn]:(\d+)$/))) {
      const a = await env.DB.prepare("SELECT * FROM alerts WHERE id = ?").bind(Number(m[1])).first();
      if (!a) await answer(q.id, "التنبيه ما عاد موجود");
      else { const who = alertOwner(a), w = await wake(env, who, alertPrompt(a)); await answer(q.id, w.ok ? `${nameOf(who)} يحللها الحين` : "ما صحى"); if (!w.ok) await tg(env, `⚠️ ${whyNot(who, w.code)}`); }
    }
    else if ((m = d.match(/^u:(\d+)$/))) { const r = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(Number(m[1])).first(); if (r) await giveTask(env, "manager", `المالك طلب التراجع عن التعديل رقم ${r.id}: ${r.title}`, "تيليقرام"); await answer(q.id, "وصل طلب التراجع للمدير"); }
    return json(200, { ok: true });
  }
  const msg = u.message;
  if (!msg || String(msg.chat?.id) !== owner || typeof msg.text !== "string") return json(200, { ok: true });
  // /i فكرة → مطوّر الأفكار، /s مهمة → المساعد، غير كذا → المدير العام
  const t = msg.text.trim();
  const route = t.startsWith("/i ") ? ["ideas", t.slice(3)] : t.startsWith("/s ") ? ["assistant", t.slice(3)] : t.startsWith("/m ") ? ["manager", t.slice(3)] : t.startsWith("/") ? null : ["manager", t];
  if (!route) { await tg(env, "اكتب رسالتك للمدير مباشرة، أو:\n/i فكرة لمطوّر الأفكار\n/s مهمة للمساعد الشخصي"); return json(200, { ok: true }); }
  const r = await giveTask(env, route[0], clip(route[1], 4000), "تيليقرام");
  await tg(env, r.woke ? `👍 وصلت لـ${nameOf(route[0])} وبدأ يشتغل.` : `📥 انحفظت المهمة. ${whyNot(route[0], r.wakeCode)}`);
  return json(200, { ok: true });
}
