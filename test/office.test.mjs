// اختبارات خادم المكتب: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./d1.mjs";
import worker from "../src/worker.js";
import { runMonitor } from "../src/monitor.js";
import { TEAM } from "../src/team.js";
import { tgHookSecret } from "../src/notify.js";

const BASE = "https://office.test";
function makeEnv(store = {}) {
  const sent = [], fired = [], storeCalls = [];
  const env = {
    __fresh: true, DB: fakeD1(), OFFICE_PASSWORD: "كلمة-سر-تجريبية", AGENT_TOKEN: "agent-token-test",
    TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_CHAT_ID: "42",
    STORE_API: "https://store.test", STORE_ORIGIN: "https://shop.test", STORE_DATA_URL: "https://shop.test/data.json",
    STORE_READER_PIN: "918273645501",
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
      if (p === "/enter") return store.denied ? Response.json({ ok: false }, { status: 401 }) : Response.json({ ok: true, go: "staff", token: "a".repeat(64), user: { role: store.role || "reader" } });
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
  const good = await tgHookSecret(env);
  const hook = (body, secret = good) => call(env, "/tg", { body, headers: { "X-Telegram-Bot-Api-Secret-Token": secret } });
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

test("المراقب يرفض يستخدم أي حساب غير «قارئ المكتب» حتى لو الرقم صحيح", async () => {
  const env = makeEnv({ role: "manager" });
  await runMonitor(env);
  assert.match(env.sent[0].text, /قارئ المكتب/);
  assert.ok(!env.storeCalls.some((c) => c.p.startsWith("/admin")), "ما قرأ شي بحساب المدير");
});

test("الموظفين يقرون المتجر عن طريق المكتب (قراءة بس)، والمحلل يرسل تقرير الصباح", async () => {
  const env = makeEnv({ drivers: [{ id: "d1", name: "سالم", balance: 20 }] });
  const r = await A(env, "/agent/store", { emp: "morning", path: "/admin/cash" });
  assert.equal(r.body.data.drivers[0].name, "سالم");
  assert.equal((await A(env, "/agent/store", { emp: "morning", path: "/save" })).body.code, "path_not_allowed");
  await A(env, "/agent/store", { emp: "morning", path: "/admin/cash", add: 50 });
  assert.ok(env.storeCalls.filter((c) => c.p === "/admin/cash").every((c) => c.body.add === undefined), "ما يمرر أي تعديل");
  assert.equal((await A(env, "/agent/report", { emp: "noon", text: "x" })).status, 403);
  await A(env, "/agent/report", { emp: "morning", text: "المبيعات أمس ١٬٢٠٠ ر.س" });
  assert.match(env.sent.at(-1).text, /تقرير الصباح/);
});

test("المؤقت: تقرير الصباح الساعة ٧ بتوقيت الرياض مرة وحدة باليوم", async () => {
  const env = makeEnv(); env.ROUTINE_MORNING_ID = "trig_mor"; env.ROUTINE_MORNING_TOKEN = "tok_mor";
  const run = async (iso) => { const p = []; await worker.scheduled({ scheduledTime: Date.parse(iso) }, env, { waitUntil: (x) => p.push(x) }); await Promise.all(p); };
  await run("2026-11-26T04:00:00Z"); // ٧:٠٠ الرياض
  await run("2026-11-26T04:05:00Z");
  await run("2026-11-26T05:00:00Z");
  assert.equal(env.fired.filter((f) => f.u.includes("trig_mor")).length, 1);
});

test("ربط الجلسة من الموقع: الرمز ينحفظ وما يرجع، وبعدها الموظف يصحى", async () => {
  const env = makeEnv();
  const c = await login(env);
  assert.equal((await call(env, "/api/task", { cookie: c, body: { emp: "assistant", text: "x" } })).body.wakeCode, "not_configured");
  assert.equal((await call(env, "/api/routine", { cookie: c, body: { emp: "assistant", id: "trig_assistant0001", token: "https://api.anthropic.com/x" } })).status, 400);
  assert.equal((await call(env, "/api/routine", { cookie: c, body: { emp: "assistant", id: "trig_assistant0001", token: "sk-ant-oat01-routine-long-token" } })).status, 200);
  const st = await call(env, "/api/state", { cookie: c });
  assert.equal(st.body.team.find((t) => t.key === "assistant").linked, true);
  assert.ok(!JSON.stringify(st.body).includes("sk-ant-oat01-routine-long-token"), "الرمز ما يرجع للمتصفح");
  assert.equal((await call(env, "/api/task", { cookie: c, body: { emp: "assistant", text: "رتب ملفاتي" } })).body.woke, true);
  assert.equal(env.fired.at(-1).headers.Authorization, "Bearer sk-ant-oat01-routine-long-token");
});

test("اربط تيليقرام: ياخذ محادثة المالك ويركّب الـ webhook بسر", async () => {
  const env = makeEnv(); delete env.TELEGRAM_CHAT_ID;
  const base = env.fetch, calls = [];
  env.fetch = async (u, init = {}) => {
    u = String(u); calls.push(u);
    if (u.includes("/getUpdates")) return Response.json({ ok: true, result: [{ message: { chat: { id: 777, type: "private", first_name: "المالك" }, text: "هلا" } }] });
    if (u.includes("/setWebhook")) { env.hookBody = JSON.parse(init.body); return Response.json({ ok: true }); }
    return base(u, init);
  };
  const c = await login(env);
  const r = await call(env, "/api/tg-setup", { cookie: c, body: {} });
  assert.equal(r.body.ok, true);
  assert.equal(env.hookBody.url, "https://office.test/tg");
  assert.equal(env.hookBody.secret_token, await tgHookSecret(env));
  assert.equal(env.sent.at(-1).chat_id, "777");
});

test("أول مرة: المالك يختار كلمة السر مرة وحدة، وبعدها ما أحد يقدر يغيّرها", async () => {
  const env = makeEnv(); delete env.OFFICE_PASSWORD;
  assert.equal((await call(env, "/api/setup-status")).body.needsSetup, true);
  assert.equal((await call(env, "/api/login", { body: { password: "x" } })).body.code, "needs_setup");
  assert.equal((await call(env, "/api/setup", { body: { password: "قصيرة" } })).status, 400);
  assert.equal((await call(env, "/api/setup", { body: { password: "كلمة-سر-طويلة-للمكتب" } })).status, 200);
  assert.equal((await call(env, "/api/setup", { body: { password: "واحد-ثاني-يحاول-يغيرها" } })).status, 409);
  assert.equal((await call(env, "/api/login", { body: { password: "واحد-ثاني-يحاول-يغيرها" } })).status, 401);
  assert.equal((await call(env, "/api/login", { body: { password: "كلمة-سر-طويلة-للمكتب" } })).status, 200);
});

test("المالك يحط رمز البوت ورقم القارئ من الموقع، وما يرجعون للمتصفح", async () => {
  const env = makeEnv({ drivers: [{ id: "d1", name: "سالم", balance: 900 }] }); delete env.TELEGRAM_BOT_TOKEN; delete env.STORE_READER_PIN;
  const c = await login(env);
  let st = await call(env, "/api/state", { cookie: c });
  assert.equal(st.body.telegram.bot, false); assert.equal(st.body.reader, false);
  await call(env, "/api/config", { cookie: c, body: { TELEGRAM_BOT_TOKEN: "123:bot-secret-xyz", STORE_READER_PIN: "918273645501" } });
  st = await call(env, "/api/state", { cookie: c });
  assert.equal(st.body.telegram.bot, true); assert.equal(st.body.reader, true);
  assert.ok(!JSON.stringify(st.body).includes("bot-secret-xyz") && !JSON.stringify(st.body).includes("918273645501"));
  // المؤقت يقرأ الإعدادات المحفوظة
  const p = []; await worker.scheduled({ scheduledTime: Date.parse("2026-11-26T10:00:00Z") }, env, { waitUntil: (x) => p.push(x) }); await Promise.all(p);
  assert.ok(env.storeCalls.some((x) => x.p === "/enter" && x.body.pin === "918273645501"));
});

test("رمز الجلسة المؤقت: يجي مع التشغيل، يشتغل لنفس الموظف بس", async () => {
  const env = makeEnv(); delete env.AGENT_TOKEN;
  const c = await login(env);
  await call(env, "/api/task", { cookie: c, body: { emp: "ideas", text: "فكرة" } });
  const text = env.fired.at(-1).body.text;
  assert.match(text, /رابط المكتب: https:\/\/office.test/);
  const tok = text.match(/[a-f0-9]{48}/)[0];
  const as = (emp, t = tok) => call(env, "/agent/brief", { body: { emp }, agent: t });
  assert.equal((await as("ideas")).status, 200);
  assert.equal((await as("manager")).body.code, "token_for_other_employee");
  assert.equal((await as("ideas", "f".repeat(48))).status, 401);
});

test("الواجهة مدموجة في الخادم وتنفتح بدون ملفات منفصلة", async () => {
  const env = makeEnv();
  const r = await worker.fetch(new Request(BASE + "/"), env, ctx);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /مكتب متاجر أحد/);
  assert.match((await worker.fetch(new Request(BASE + "/app.js"), env, ctx)).headers.get("Content-Type"), /javascript/);
  assert.equal((await worker.fetch(new Request(BASE + "/nothing"), env, ctx)).status, 404);
});

test("رد الموظف على مهمة المالك يظهر في المكتب ويوصل تيليقرام، حتى لو مو من القنوات المباشرة", async () => {
  const env = makeEnv(); env.ROUTINE_NOON_ID = "trig_n"; env.ROUTINE_NOON_TOKEN = "tok_n";
  const c = await login(env);
  const id = (await call(env, "/api/task", { cookie: c, body: { emp: "noon", text: "مبيعات اليوم" } })).body.id;
  await A(env, "/agent/task-done", { emp: "noon", id, result: "طلب واحد بـ ٤٥ ر.س" });
  assert.match(env.sent.at(-1).text, /مسؤول نون خلّص مهمتك/);
  let st = await call(env, "/api/state", { cookie: c });
  assert.equal(st.body.replies[0].result, "طلب واحد بـ ٤٥ ر.س");
  await call(env, "/api/replies-seen", { cookie: c, body: {} });
  st = await call(env, "/api/state", { cookie: c });
  assert.equal(st.body.replies.length, 0);
});

test("ملف مرفق بالمهمة: الموظف نفسه بس ينزّله", async () => {
  const env = makeEnv(); env.ROUTINE_PRICING_ID = "trig_p"; env.ROUTINE_PRICING_TOKEN = "tok_p";
  const c = await login(env);
  const b64 = Buffer.from("sku,price\nA,5").toString("base64");
  const id = (await call(env, "/api/task", { cookie: c, body: { emp: "pricing", text: "قارن الأسعار", file: { name: "prices.xlsx", type: "x", b64 } } })).body.id;
  assert.match(env.fired.at(-1).body.text, /مرفق: prices.xlsx/);
  const tok = env.fired.at(-1).body.text.match(/[a-f0-9]{48}/)[0];
  const r = await call(env, "/agent/file", { body: { emp: "pricing", task: id }, agent: tok });
  assert.equal(Buffer.from(r.body.files[0].b64, "base64").toString(), "sku,price\nA,5");
  assert.equal((await A(env, "/agent/file", { emp: "noon", task: id })).status, 404);
  assert.equal((await call(env, "/api/task", { cookie: c, body: { emp: "pricing", text: "x", file: { name: "a", b64: "!!" } } })).status, 400);
});

test("«حلّلها»: يوضح ليش ما صحى، وتنبيهات نون تروح لمسؤول نون", async () => {
  const env = makeEnv(); delete env.ROUTINE_MONITOR_ID; env.ROUTINE_NOON_ID = "trig_n"; env.ROUTINE_NOON_TOKEN = "tok_n";
  const c = await login(env);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO alerts (k, level, title, body, first, last) VALUES ('out:x','important','منتج خلص','',?,?)").bind(t, t).run().catch(async () => { await call(env, "/api/state", { cookie: c }); });
  await call(env, "/api/state", { cookie: c });
  await env.DB.prepare("INSERT INTO alerts (k, level, title, body, first, last) VALUES ('out:y','important','منتج خلص','',?,?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO alerts (k, level, title, body, first, last) VALUES ('noon_low:A','important','نون: حليب قرّب يخلص','',?,?)").bind(t, t).run();
  const ids = (await env.DB.prepare("SELECT id, k FROM alerts").all()).results;
  const mon = await call(env, "/api/analyze", { cookie: c, body: { id: ids.find((a) => a.k === "out:y").id } });
  assert.equal(mon.body.ok, false); assert.match(mon.body.why, /المراقب ما صحى: ما انربطت جلسته/);
  const nn = await call(env, "/api/analyze", { cookie: c, body: { id: ids.find((a) => a.k === "noon_low:A").id } });
  assert.equal(nn.body.ok, true); assert.equal(nn.body.who, "مسؤول نون");
});
