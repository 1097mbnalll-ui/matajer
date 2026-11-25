// خادم «مكتب متاجر أحد» على Cloudflare Workers
// - /api/*   للمالك (كوكي بعد الدخول بكلمة السر)
// - /agent/* لجلسات الموظفين (Authorization: Bearer AGENT_TOKEN)
// - /tg      تيليقرام (أزرار موافق/رفض ورسايل المالك)
// - scheduled: المراقب كل ٥ دقايق
import { TEAM, AREAS, LEVELS, teamKeys, areaOf } from "./team.js";
import { ensureSchema, now, log, getSetting, setSetting, permsOf, bump, teamState } from "./db.js";
import { tg, wake } from "./notify.js";
import { runMonitor, analysisPrompt, DEFAULT_RULES } from "./monitor.js";

const SESSION_DAYS = 30, MAX_FAILS = 5, LOCK_MIN = 15;
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key, s) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(s)));
}
function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
const clip = (s, n) => String(s ?? "").slice(0, n);
const nameOf = (k) => TEAM.find((t) => t.key === k)?.name || k;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      const m = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
      await runMonitor(env, { hourly: m < 5 });
    })().catch(() => {}));
  },
  async fetch(request, env, ctx) {
    try { return await route(request, env, ctx); }
    catch (e) { return json(500, { ok: false, code: "server" }); }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path.startsWith("/api/") || path.startsWith("/agent/") || path === "/tg") {
    if (!env.DB) return json(500, { ok: false, code: "config", missing: "DB" });
    await ensureSchema(env);
  }
  if (path === "/tg") return telegram(request, env);
  if (path.startsWith("/agent/")) return agentApi(request, env, path, url);
  if (path.startsWith("/api/")) return ownerApi(request, env, path, url);
  // الملفات الثابتة (الواجهة)
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response("not found", { status: 404 });
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

  if (path === "/api/login") {
    if (!env.OFFICE_PASSWORD || !env.SECRET) return json(500, { ok: false, code: "config" });
    const f = await env.DB.prepare("SELECT n, until FROM fails WHERE ip = ?").bind(ip).first();
    if (f && f.until > now()) return json(429, { ok: false, code: "locked", minutes: Math.ceil((f.until - now()) / 60000) });
    const ok = sameText(await hmac(env.SECRET, clip(body.password, 200)), await hmac(env.SECRET, env.OFFICE_PASSWORD));
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
    return json(200, { ok: true, team: await teamState(env), areas: AREAS, levels: LEVELS, pending, alerts, meetings,
      rules: { ...DEFAULT_RULES, ...(await getSetting(env, "rules", {})) }, caps: { fire: await getSetting(env, "fire_cap", 60), meetings: await getSetting(env, "meeting_cap", 5) } });
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
    await env.DB.prepare("INSERT INTO perms (emp, area, level) VALUES (?, ?, ?) ON CONFLICT(emp, area) DO UPDATE SET level = excluded.level").bind(body.emp, body.area, body.level).run();
    await log(env, body.emp, "perm_changed", { area: areaOf(body.area).name, level: body.level, by: "المالك" });
    return json(200, { ok: true, perms: await permsOf(env, body.emp) });
  }
  if (path === "/api/task") {
    if (!teamKeys.has(body.emp)) return json(400, { ok: false, code: "bad_emp" });
    const text = clip(body.text, 4000).trim();
    if (!text) return json(400, { ok: false, code: "empty" });
    return json(200, await giveTask(env, body.emp, text, "الموقع"));
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
  if (path === "/api/analyze") {
    const a = await env.DB.prepare("SELECT * FROM alerts WHERE id = ?").bind(Number(body.id)).first();
    if (!a) return json(404, { ok: false });
    return json(200, await wake(env, "monitor", analysisPrompt(a)));
  }
  return json(404, { ok: false, code: "not_found" });
}

async function giveTask(env, emp, text, src) {
  const r = await env.DB.prepare("INSERT INTO tasks (at, emp, text, src) VALUES (?, ?, ?, ?) RETURNING id").bind(now(), emp, text, src).first();
  await log(env, emp, "task_received", { id: r.id, src });
  const w = await wake(env, emp, `مهمة جديدة من المالك (رقم ${r.id}):\n${text}`);
  return { ok: true, id: r.id, woke: w.ok, wakeCode: w.code || null, url: w.url || null };
}

// موافقة أو رفض (من الموقع أو تيليقرام)
async function decide(env, id, yes, how) {
  const r = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first();
  if (!r) return [404, { ok: false, code: "not_found" }];
  if (r.status !== "pending") return [409, { ok: false, code: "already", status: r.status }];
  const st = yes ? "approved" : "rejected";
  await env.DB.prepare("UPDATE requests SET status = ?, decided = ?, how = ? WHERE id = ? AND status = 'pending'").bind(st, now(), how, id).run();
  await log(env, r.emp, yes ? "approved_by_owner" : "rejected_by_owner", { id, title: r.title, how });
  await wake(env, r.emp, `المالك ${yes ? "وافق على" : "رفض"} طلبك رقم ${id}: ${r.title}`);
  return [200, { ok: true, status: st }];
}

// ================= جلسات الموظفين =================
async function agentApi(request, env, path, url) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.AGENT_TOKEN || !sameText(auth, `Bearer ${env.AGENT_TOKEN}`)) return json(401, { ok: false, code: "agent_auth" });
  const body = await readBody(request);
  if (body === null) return json(400, { ok: false, code: "bad_body" });
  const emp = body.emp || url.searchParams.get("emp");
  if (!teamKeys.has(emp)) return json(400, { ok: false, code: "bad_emp", team: [...teamKeys] });

  if (path === "/agent/brief") { // أول شي يسويه الموظف: وش عندي؟
    const tasks = (await env.DB.prepare("SELECT id, at, text, src FROM tasks WHERE emp = ? AND status = 'open' ORDER BY id").bind(emp).all()).results || [];
    const mine = (await env.DB.prepare("SELECT id, title, status, decided FROM requests WHERE emp = ? ORDER BY id DESC LIMIT 20").bind(emp).all()).results || [];
    const alerts = (await env.DB.prepare("SELECT id, level, title, body, first FROM alerts WHERE open = 1 ORDER BY id DESC LIMIT 30").all()).results || [];
    const meetings = (await env.DB.prepare("SELECT id, topic, by, status FROM meetings WHERE status = 'open' ORDER BY id").all()).results || [];
    const recent = (await env.DB.prepare("SELECT at, act, info FROM logs WHERE emp = ? ORDER BY id DESC LIMIT 30").bind(emp).all()).results || [];
    return json(200, { ok: true, me: TEAM.find((t) => t.key === emp), perms: await permsOf(env, emp), areas: AREAS, tasks, requests: mine, alerts, meetings, recent, team: TEAM.map((t) => t.key) });
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
    if (!TEAM.find((t) => t.key === emp)?.direct) return json(403, { ok: false, code: "via_manager" });
    const text = clip(body.text, 3500).trim();
    if (!text) return json(400, { ok: false, code: "empty" });
    await tg(env, `💬 ${nameOf(emp)}:\n${text}`);
    await log(env, emp, "told_owner", { text: text.slice(0, 300) });
    return json(200, { ok: true });
  }
  if (path === "/agent/task-done") {
    const t = await env.DB.prepare("SELECT * FROM tasks WHERE id = ? AND emp = ?").bind(Number(body.id), emp).first();
    if (!t) return json(404, { ok: false });
    await env.DB.prepare("UPDATE tasks SET status = 'done', result = ?, done = ? WHERE id = ?").bind(clip(body.result, 4000), now(), t.id).run();
    await log(env, emp, "task_done", { id: t.id });
    if (TEAM.find((x) => x.key === emp)?.direct) await tg(env, `✅ ${nameOf(emp)} خلّص مهمتك رقم ${t.id}:\n${clip(body.result, 3000)}`);
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
    return json(200, { ok: true, meeting: m, lines, waitingFor: TEAM.map((t) => t.key).filter((k) => !spoke.has(k)) });
  }
  if (path === "/agent/meeting-invite") { // المدير يصحّي الموظفين للاجتماع (كل واحد جلسة مستقلة)
    if (emp !== "manager") return json(403, { ok: false, code: "manager_only" });
    const m = await env.DB.prepare("SELECT * FROM meetings WHERE id = ?").bind(Number(body.id)).first();
    if (!m || m.status !== "open") return json(409, { ok: false, code: "meeting_closed" });
    const who = (Array.isArray(body.who) && body.who.length ? body.who : TEAM.map((t) => t.key)).filter((k) => teamKeys.has(k) && k !== "manager");
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
    const all = agreed.length === TEAM.length;
    await env.DB.prepare("UPDATE meetings SET status = ?, decision = ?, agreed = ?, closed = ? WHERE id = ?")
      .bind(all ? "agreed" : "no_consensus", clip(body.decision, 4000), JSON.stringify(agreed), now(), m.id).run();
    await log(env, emp, "meeting_closed", { id: m.id, all });
    return json(200, { ok: true, status: all ? "agreed" : "no_consensus", missing: TEAM.map((t) => t.key).filter((k) => !agreed.includes(k)) });
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
      if (!meeting || meeting.status !== "agreed") return json(409, { ok: false, code: "needs_full_meeting" });
    }
    const testsFailed = body.testsPassed === false;
    const big = area.big || testsFailed || level === "propose";
    const status = big ? "pending" : "approved";
    const r = await env.DB.prepare("INSERT INTO requests (at, emp, area, big, deploy, meeting, title, detail, status, decided, how) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(now(), emp, area.key, big ? 1 : 0, deploy ? 1 : 0, meeting ? meeting.id : null, clip(body.title, 300), clip(body.detail, 4000), status, big ? null : now(), big ? null : "تلقائي (بسيط)").first();
    await log(env, emp, big ? "asked_approval" : "auto_approved", { id: r.id, title: clip(body.title, 200), area: area.name });
    if (big) {
      await tg(env, `🟡 ينتظر موافقتك (${nameOf(emp)})\n${clip(body.title, 300)}\nالمجال: ${area.name}${testsFailed ? "\n⚠️ فيه اختبار فشل" : ""}${meeting ? `\nاجتماع رقم ${meeting.id}: اتفقوا كلهم` : ""}\n\n${clip(body.detail, 1500)}`,
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
  if (path === "/agent/alert-done") {
    await env.DB.prepare("UPDATE alerts SET open = 0 WHERE id = ?").bind(Number(body.id)).run();
    await log(env, emp, "alert_closed", { id: Number(body.id), note: clip(body.note, 300) });
    return json(200, { ok: true });
  }
  return json(404, { ok: false, code: "not_found" });
}

// ================= تيليقرام =================
async function telegram(request, env) {
  if (!env.TG_WEBHOOK_SECRET || !sameText(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", env.TG_WEBHOOK_SECRET)) return json(401, { ok: false });
  const u = await request.json().catch(() => ({}));
  const owner = String(env.TELEGRAM_CHAT_ID || "");
  const answer = async (id, text) => { if (env.TELEGRAM_BOT_TOKEN) await (env.fetch || fetch)(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: id, text }) }).catch(() => {}); };

  if (u.callback_query) {
    const q = u.callback_query;
    if (String(q.from?.id) !== owner && String(q.message?.chat?.id) !== owner) return json(200, { ok: true });
    const d = String(q.data || "");
    let m;
    if ((m = d.match(/^a:(\d+):([yn])$/))) { const [, res] = await decide(env, Number(m[1]), m[2] === "y", "تيليقرام"); await answer(q.id, res.ok ? (m[2] === "y" ? "تمت الموافقة" : "انرفض") : "انحسم من قبل"); }
    else if ((m = d.match(/^z:(\d+)$/))) { const a = await env.DB.prepare("SELECT * FROM alerts WHERE id = ?").bind(Number(m[1])).first(); const w = a ? await wake(env, "monitor", analysisPrompt(a)) : { ok: false }; await answer(q.id, w.ok ? "المراقب يحللها الحين" : "ما قدرت أصحّي المراقب"); }
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
  await tg(env, r.woke ? `👍 وصلت لـ${nameOf(route[0])} وبدأ يشتغل.` : `📥 انحفظت عند ${nameOf(route[0])} (ما قدرت أصحّيه الحين: ${r.wakeCode}).`);
  return json(200, { ok: true });
}
