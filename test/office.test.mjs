// اختبارات خادم المكتب: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./d1.mjs";
import worker from "../src/worker.js";
import { runMonitor } from "../src/monitor.js";
import { TEAM } from "../src/team.js";

const BASE = "https://office.test";
function makeEnv(store = {}) {
  const sent = [], fired = [], storeCalls = [];
  const env = {
    __fresh: true, DB: fakeD1(), OFFICE_PASSWORD: "كلمة-سر-تجريبية", SECRET: "s".repeat(32), AGENT_TOKEN: "agent-token-test",
    TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_CHAT_ID: "42", TG_WEBHOOK_SECRET: "hook",
    STORE_API: "https://store.test", STORE_ORIGIN: "https://shop.test", STORE_DATA_URL: "https://shop.test/data.json",
    STORE_READER_USER: "office-reader", STORE_READER_PASSWORD: "reader-password-123",
    ROUTINE_MONITOR_ID: "trig_mon", ROUTINE_MONITOR_TOKEN: "tok_mon", ROUTINE_MANAGER_ID: "trig_man", ROUTINE_MANAGER_TOKEN: "tok_man",
    ROUTINE_IDEAS_ID: "trig_ide", ROUTINE_IDEAS_TOKEN: "tok_ide",
    sent, fired, storeCalls, store,
  };
  env.fetch = async (u, init = {}) => {
    u = String(u);
    const body = init.body ? JSON.parse(init.body) : {};
    if (u.includes("api.telegram.org")) { if (u.endsWith("/sendMessage")) sent.push(body); return Response.json({ ok: true }); }
    if (u.startsWith("https://api.anthropic.com/")) {
      fired.push({ u, headers: init.headers, body });
      return Response.json({ type: "routine_fire", claude_code_session_id: "s1", claude_code_session_url: "https://claude.ai/code/session_x" });
    }
    if (u.startsWith("https://shop.test/data.json")) return Response.json(store.data || { products: [] });
    if (u.startsWith("https://store.test")) {
      const p = u.slice("https://store.test".length);
      storeCalls.push({ p, body, origin: init.headers?.Origin });
      if (p === "/ping") return store.down ? new Response("x", { status: 502 }) : Response.json({ ok: true });
      if (p === "/staff/login") return store.denied ? Response.json({ ok: false }, { status: 401 }) : Response.json({ ok: true, session: "a".repeat(64) });
      if (store.denied) return Response.json({ ok: false, code: "session_expired" }, { status: 401 });
      if (p === "/admin/alerts") return Response.json({ ok: true, orders: store.late || [] });
      if (p === "/admin/stock") return Response.json(body.summary ? { ok: true, low: store.low || {} } : { ok: true, costs: store.costs || {} });
      if (p === "/admin/cash") return Response.json({ ok: true, drivers: store.drivers || [] });
    }
    return new Response("?", { status: 404 });
  };
  return env;
}
const ctx = { waitUntil() {} };
async function call(env, path, { body, cookie, agent, method, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (cookie) h.Cookie = cookie;
  if (agent) h.Authorization = `Bearer ${agent}`;
  const res = await worker.fetch(new Request(BASE + path, { method: method || (body !== undefined ? "POST" : "GET"), headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }), env, ctx);
  return { status: res.status, body: await res.json().catch(() => null), setCookie: res.headers.get("Set-Cookie") };
}
async function login(env) {
  const r = await call(env, "/api/login", { body: { password: env.OFFICE_PASSWORD } });
  assert.equal(r.status, 200);
  return r.setCookie.split(";")[0];
}
const A = (env, path, body) => call(env, path, { body, agent: env.AGENT_TOKEN });

test("الدخول: كلمة سر غلط تنقفل بعد ٥ مرات، والصح يعطي كوكي آمن", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "/api/state")).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await call(env, "/api/login", { body: { password: "غلط" } })).status, 401);
  assert.equal((await call(env, "/api/login", { body: { password: env.OFFICE_PASSWORD } })).status, 429);
  assert.ok(env.sent.some((m) => m.text.includes("٥ مرات")));
  const env2 = makeEnv();
  const r = await call(env2, "/api/login", { body: { password: env2.OFFICE_PASSWORD } });
  assert.match(r.setCookie, /HttpOnly; Secure; SameSite=Strict/);
  const st = await call(env2, "/api/state", { cookie: r.setCookie.split(";")[0] });
  assert.equal(st.status, 200);
  assert.equal(st.body.team.length, TEAM.length);
  assert.equal(st.body.team.find((t) => t.key === "pricing").perms.prices, "propose");
  assert.equal(st.body.team.find((t) => t.key === "pricing").perms.text, "auto");
});

test("طلب من موقع ثاني (Origin غريب) ينرفض", async () => {
  const env = makeEnv();
  const r = await call(env, "/api/login", { body: { password: env.OFFICE_PASSWORD }, headers: { Origin: "https://evil.test" } });
  assert.equal(r.status, 403);
});

test("الموظفين بدون رمز صحيح ما يدخلون", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "/agent/brief", { body: { emp: "monitor" }, agent: "wrong" })).status, 401);
  assert.equal((await A(env, "/agent/brief", { emp: "nobody" })).status, 400);
  assert.equal((await A(env, "/agent/brief", { emp: "monitor" })).status, 200);
});

test("الكبير ينتظر موافقة المالك، والبسيط ينفّذ مع زر تراجع", async () => {
  const env = makeEnv();
  const big = await A(env, "/agent/request", { emp: "pricing", area: "prices", title: "خفض سعر الحليب", detail: "من ٧ إلى ٦٫٥" });
  assert.equal(big.body.status, "pending");
  const msg = env.sent.at(-1);
  assert.match(msg.text, /ينتظر موافقتك/);
  assert.equal(msg.reply_markup.inline_keyboard[0][0].callback_data, `a:${big.body.id}:y`);
  // حتى لو المالك عطاه «ينفّذ لحاله» في مجال كبير، يبقى ينتظر
  const c = await login(env);
  await call(env, "/api/perm", { cookie: c, body: { emp: "pricing", area: "prices", level: "auto" } });
  assert.equal((await A(env, "/agent/request", { emp: "pricing", area: "prices", title: "x" })).body.status, "pending");
  const small = await A(env, "/agent/request", { emp: "pricing", area: "text", title: "تصحيح كلمة" });
  assert.equal(small.body.status, "approved");
  assert.equal(env.sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data, `u:${small.body.id}`);
  // بسيط بس الاختبارات فشلت → يصير كبير
  assert.equal((await A(env, "/agent/request", { emp: "pricing", area: "text", title: "y", testsPassed: false })).body.status, "pending");
  // «يقرأ بس» ما يقدر يطلب أصلاً
  await call(env, "/api/perm", { cookie: c, body: { emp: "monitor", area: "text", level: "read" } });
  assert.equal((await A(env, "/agent/request", { emp: "monitor", area: "text", title: "z" })).status, 403);
});

test("أي نزول لازم اجتماع اتفق فيه كل الموظفين", async () => {
  const env = makeEnv();
  assert.equal((await A(env, "/agent/request", { emp: "manager", area: "text", title: "نزول", deploy: true })).body.code, "needs_full_meeting");
  const m = (await A(env, "/agent/meeting-open", { emp: "manager", topic: "تصحيح نص" })).body.id;
  for (const t of TEAM.slice(0, -1)) await A(env, "/agent/meeting-say", { emp: t.key, id: m, text: "موافق" });
  // ناقص واحد ما تكلم → ما فيه إجماع
  const notAll = await A(env, "/agent/meeting-close", { emp: "manager", id: m, decision: "ننزل", agreed: TEAM.map((t) => t.key) });
  assert.equal(notAll.body.status, "no_consensus");
  assert.equal((await A(env, "/agent/request", { emp: "manager", area: "text", title: "نزول", deploy: true, meeting: m })).body.code, "needs_full_meeting");
  const m2 = (await A(env, "/agent/meeting-open", { emp: "manager", topic: "مرة ثانية" })).body.id;
  for (const t of TEAM) await A(env, "/agent/meeting-say", { emp: t.key, id: m2, text: "موافق" });
  assert.equal((await A(env, "/agent/meeting-close", { emp: "monitor", id: m2, agreed: [] })).status, 403);
  assert.equal((await A(env, "/agent/meeting-close", { emp: "manager", id: m2, decision: "ننزل", agreed: TEAM.map((t) => t.key) })).body.status, "agreed");
  assert.equal((await A(env, "/agent/request", { emp: "manager", area: "text", title: "نزول", deploy: true, meeting: m2 })).body.status, "approved");
  // نزول كبير بعد الاجتماع: يبقى ينتظر المالك
  assert.equal((await A(env, "/agent/request", { emp: "manager", area: "prices", title: "نزول أسعار", deploy: true, meeting: m2 })).body.status, "pending");
});

test("سقف الاجتماعات اليومي", async () => {
  const env = makeEnv();
  const c = await login(env);
  await call(env, "/api/rules", { cookie: c, body: { meetingCap: 2 } });
  assert.equal((await A(env, "/agent/meeting-open", { emp: "manager", topic: "1" })).status, 200);
  assert.equal((await A(env, "/agent/meeting-open", { emp: "manager", topic: "2" })).status, 200);
  assert.equal((await A(env, "/agent/meeting-open", { emp: "manager", topic: "3" })).body.code, "meeting_cap");
});

test("المالك يوافق من تيليقرام، وغيره ما يقدر", async () => {
  const env = makeEnv();
  const id = (await A(env, "/agent/request", { emp: "pricing", area: "prices", title: "عرض" })).body.id;
  const hook = (body, secret = "hook") => call(env, "/tg", { body, headers: { "X-Telegram-Bot-Api-Secret-Token": secret } });
  assert.equal((await hook({}, "wrong")).status, 401);
  await hook({ callback_query: { id: "q", from: { id: 999 }, message: { chat: { id: 999 } }, data: `a:${id}:y` } });
  assert.equal((await A(env, "/agent/request-status", { emp: "pricing", id })).body.status, "pending");
  await hook({ callback_query: { id: "q", from: { id: 42 }, message: { chat: { id: 42 } }, data: `a:${id}:y` } });
  assert.equal((await A(env, "/agent/request-status", { emp: "pricing", id })).body.status, "approved");
  // رسالة من المالك → مطوّر الأفكار ويصحى
  await hook({ message: { chat: { id: 42 }, text: "/i فكرة: عرض نهاية الأسبوع" } });
  assert.ok(env.fired.some((f) => f.u.includes("trig_ide") && f.body.text.includes("عرض نهاية الأسبوع")));
});

test("بس المدير والقنوات الخاصة يكلمون المالك مباشرة", async () => {
  const env = makeEnv();
  assert.equal((await A(env, "/agent/tell", { emp: "monitor", text: "هلا" })).body.code, "via_manager");
  assert.equal((await A(env, "/agent/tell", { emp: "ideas", text: "طوّرت فكرتك" })).status, 200);
  assert.equal((await A(env, "/agent/assign", { emp: "monitor", to: "noon", text: "x" })).status, 403);
  assert.equal((await A(env, "/agent/assign", { emp: "manager", to: "noon", text: "راجع نون" })).status, 200);
});

test("تشغيل الجلسة يرسل الرؤوس الصحيحة، ويوقف عند السقف اليومي", async () => {
  const env = makeEnv();
  const c = await login(env);
  await call(env, "/api/rules", { cookie: c, body: { fireCap: 1 } });
  const r1 = await call(env, "/api/task", { cookie: c, body: { emp: "manager", text: "رتب لي يومي" } });
  assert.equal(r1.body.woke, true);
  const f = env.fired[0];
  assert.equal(f.u, "https://api.anthropic.com/v1/claude_code/routines/trig_man/fire");
  assert.equal(f.headers.Authorization, "Bearer tok_man");
  assert.equal(f.headers["anthropic-beta"], "experimental-cc-routine-2026-04-01");
  const r2 = await call(env, "/api/task", { cookie: c, body: { emp: "manager", text: "ثاني" } });
  assert.equal(r2.body.wakeCode, "daily_cap");
  // موظف ما انربط له تشغيل: المهمة تنحفظ وما يطيح شي
  assert.equal((await call(env, "/api/task", { cookie: c, body: { emp: "assistant", text: "x" } })).body.wakeCode, "not_configured");
});

test("المراقب: موقع واقف = عاجل ويصحّي المراقب، وما يكرر، ويبلغ لما ينحل", async () => {
  const env = makeEnv({ down: true });
  await runMonitor(env);
  assert.match(env.sent[0].text, /عاجل/);
  assert.equal(env.fired.length, 1);
  await runMonitor(env);
  assert.equal(env.sent.length, 1, "ما يكرر نفس التنبيه");
  env.store.down = false;
  await runMonitor(env);
  assert.ok(env.sent.some((m) => m.text.includes("انحلّت")));
});

test("المراقب: تأخير، خلص المخزون، كاش عالي، بيع بخسارة", async () => {
  const env = makeEnv({
    late: [{ no: "#1007", status: "accepted" }, { no: "#1008", status: "onway" }],
    low: { p1: 0, p2: 3 }, drivers: [{ id: "d1", name: "سالم", balance: 800 }, { id: "d2", name: "فهد", balance: 100 }],
    costs: { p1: 10, p2: 5 }, data: { products: [{ id: "p1", name: "حليب", price: 9 }, { id: "p2", name: "خبز", price: 6 }] },
  });
  await runMonitor(env, { hourly: true });
  const texts = env.sent.map((m) => m.text).join("\n");
  assert.match(texts, /طلب #1007 متأخر/);
  assert.match(texts, /طلب #1008 متأخر/);
  assert.match(texts, /1 منتج خلص/);
  assert.match(texts, /سالم/);
  assert.doesNotMatch(texts, /فهد/);
  assert.match(texts, /«حليب» يتباع بخسارة/);
  assert.doesNotMatch(texts, /خبز/);
  assert.equal(env.fired.length, 1, "العاجل بس يصحّي المراقب (الطلب اللي في الطريق)");
  assert.ok(env.storeCalls.every((c) => c.p === "/ping" || c.origin === "https://shop.test"));
  assert.ok(env.storeCalls.filter((c) => c.p.startsWith("/admin")).every((c) => c.body.session), "يقرأ بجلسة قارئ المكتب");
});

test("المراقب: حساب القارئ مرفوض = تنبيه مهم", async () => {
  const env = makeEnv({ denied: true });
  await runMonitor(env);
  assert.match(env.sent[0].text, /قارئ المكتب/);
});

test("المدير يدعو الكل للاجتماع، وكل واحد يقرأ المحضر ويشوف مين باقي", async () => {
  const env = makeEnv();
  const id = (await A(env, "/agent/meeting-open", { emp: "manager", topic: "خطة الويكند" })).body.id;
  assert.equal((await A(env, "/agent/meeting-invite", { emp: "noon", id })).status, 403);
  const inv = await A(env, "/agent/meeting-invite", { emp: "manager", id });
  assert.equal(Object.keys(inv.body.woke).length, TEAM.length - 1);
  assert.equal(inv.body.woke.monitor, true);
  assert.equal(inv.body.woke.noon, false, "اللي ما انربط له تشغيل تنحفظ له المهمة");
  await A(env, "/agent/meeting-say", { emp: "monitor", id, text: "رأيي كذا" });
  const r = await A(env, "/agent/meeting-read", { emp: "noon", id });
  assert.equal(r.body.lines.length, 1);
  assert.ok(!r.body.waitingFor.includes("monitor"));
  assert.ok(r.body.waitingFor.includes("noon"));
});
