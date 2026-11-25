// المراقب: فحص المتجر كل ٥ دقايق على Cloudflare (بدون ذكاء اصطناعي)
// يقرأ بس من خادم المتجر بحساب «قارئ المكتب» (دور reader في المتجر، يدخل برقمه من /enter)، وما يعدّل أي شي
import { getSetting, setSetting, log, now, ensureSchema } from "./db.js";
import { tg, wake, levelIcon } from "./notify.js";

export const DEFAULT_RULES = { cashLimit: 500, lowStockMin: 1, wakeOn: "urgent" };

// ---------- الاتصال بخادم المتجر ----------
async function storeLogin(env) {
  const r = await storePost(env, "/enter", { pin: env.STORE_READER_PIN });
  if (!r.ok || !r.body.token || r.body.user?.role !== "reader") return null; // لازم يكون حساب «قارئ المكتب» بالذات
  await setSetting(env, "store_session", { s: r.body.token, at: now() });
  return r.body.token;
}
async function storePost(env, path, body) {
  const f = env.fetch || fetch;
  try {
    const res = await f(env.STORE_API.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: env.STORE_ORIGIN || "" },
      body: JSON.stringify(body || {}),
    });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok && j.ok !== false, status: res.status, body: j };
  } catch { return { ok: false, status: 0, body: {} }; }
}
export async function storeCall(env, path, body = {}) {
  let sess = (await getSetting(env, "store_session"))?.s;
  if (!sess) sess = await storeLogin(env);
  if (!sess) return { ok: false, status: 401, body: { code: "reader_login_failed" } };
  let r = await storePost(env, path, { ...body, session: sess });
  if (r.status === 401) { sess = await storeLogin(env); if (sess) r = await storePost(env, path, { ...body, session: sess }); }
  return r;
}

// ---------- الفحوصات: كل فحص يرجع قائمة تنبيهات {k, level, title, body} ----------
export async function collect(env, opts = {}) {
  const rules = { ...DEFAULT_RULES, ...(await getSetting(env, "rules", {})) };
  const found = [], checked = new Set();
  const f = env.fetch || fetch;

  // ١) الخادم شغّال؟
  checked.add("down");
  let up = false;
  try { const r = await f(env.STORE_API.replace(/\/+$/, "") + "/ping"); up = r.ok; } catch { up = false; }
  if (!up) { found.push({ k: "down", level: "urgent", title: "خادم المتجر ما يرد", body: "الزبائن ممكن ما يقدرون يطلبون الحين." }); return { found, checked }; }

  if (!env.STORE_READER_PIN) return { found, checked, note: "reader_not_configured" };

  // ٢) طلبات متأخرة (حدود المتجر نفسه)
  const al = await storeCall(env, "/admin/alerts");
  if (al.ok) {
    checked.add("late");
    for (const o of al.body.orders || []) {
      const st = { new: "ما انقبل", accepted: "ما طلع مع المندوب", onway: "ما وصل للزبون" }[o.status] || o.status;
      found.push({ k: `late:${o.no}:${o.status}`, level: o.status === "onway" || o.status === "new" ? "urgent" : "important", title: `طلب ${o.no} متأخر`, body: `${st} من وقت طويل.` });
    }
  } else if (al.status === 401 || al.status === 403) {
    found.push({ k: "reader_denied", level: "important", title: "المراقب ما يقدر يقرأ المتجر", body: "حساب «قارئ المكتب» مرفوض. يمكن انتهى أو تغيّرت كلمة سره." });
    return { found, checked: new Set(["reader_denied", "down"]) };
  }
  checked.add("reader_denied");

  // ٣) منتجات خلصت
  const st = await storeCall(env, "/admin/stock", { summary: true });
  if (st.ok) {
    checked.add("out");
    const low = st.body.low || {};
    const out = Object.entries(low).filter(([, q]) => Number(q) < rules.lowStockMin).map(([id]) => id);
    if (out.length) found.push({ k: `out:${out.slice().sort().join(",").slice(0, 300)}`, level: "important", title: `${out.length} منتج خلص من المخزون`, body: `أمثلة: ${out.slice(0, 5).join("، ")}` });
  }

  // ٤) كاش مندوب عالي
  const cash = await storeCall(env, "/admin/cash");
  if (cash.ok) {
    checked.add("cash");
    for (const d of cash.body.drivers || []) {
      if (Number(d.balance) > rules.cashLimit) found.push({ k: `cash:${d.id}`, level: "important", title: `كاش عند ${d.name || "مندوب"} عالي`, body: `معه ${d.balance} ر.س، والحد ${rules.cashLimit}.` });
    }
  }

  // ٥) سعر أقل من التكلفة (ثقيل: مرة بالساعة)
  if (opts.hourly && env.STORE_DATA_URL) {
    const full = await storeCall(env, "/admin/stock");
    let data = null;
    try { const r = await f(env.STORE_DATA_URL, { cf: { cacheTtl: 300 } }); if (r.ok) data = await r.json(); } catch {}
    if (full.ok && data) {
      checked.add("loss");
      const costs = full.body.costs || {};
      for (const p of data.products || []) {
        const c = Number(costs[p.id]), pr = Number(p.price);
        if (c > 0 && pr > 0 && pr < c) found.push({ k: `loss:${p.id}`, level: "important", title: `«${p.name}» يتباع بخسارة`, body: `السعر ${pr} والتكلفة ${c} ر.س.` });
      }
    }
  }
  return { found, checked };
}

// ---------- تسجيل التنبيهات بدون تكرار ----------
const familyOf = (k) => k.split(":")[0];
export async function runMonitor(env, opts = {}) {
  await ensureSchema(env);
  const { found, checked } = await collect(env, opts);
  const rules = { ...DEFAULT_RULES, ...(await getSetting(env, "rules", {})) };
  const t = now(), fresh = [];
  for (const a of found) {
    const ex = await env.DB.prepare("SELECT id, open FROM alerts WHERE k = ?").bind(a.k).first();
    if (ex && ex.open) { await env.DB.prepare("UPDATE alerts SET last = ? WHERE id = ?").bind(t, ex.id).run(); continue; }
    if (ex) await env.DB.prepare("UPDATE alerts SET open = 1, first = ?, last = ?, level = ?, title = ?, body = ? WHERE id = ?").bind(t, t, a.level, a.title, a.body, ex.id).run();
    else await env.DB.prepare("INSERT INTO alerts (k, level, title, body, first, last) VALUES (?, ?, ?, ?, ?, ?)").bind(a.k, a.level, a.title, a.body, t, t).run();
    const row = await env.DB.prepare("SELECT id FROM alerts WHERE k = ?").bind(a.k).first();
    fresh.push({ ...a, id: row.id });
  }
  // اللي انحلّ: فحصناه وما ظهر هالمرة
  const seen = new Set(found.map((a) => a.k));
  const open = (await env.DB.prepare("SELECT id, k, title FROM alerts WHERE open = 1").all()).results || [];
  const solved = [];
  for (const o of open) {
    if (!seen.has(o.k) && checked.has(familyOf(o.k))) { await env.DB.prepare("UPDATE alerts SET open = 0 WHERE id = ?").bind(o.id).run(); solved.push(o); }
  }
  for (const a of fresh) {
    await tg(env, `${levelIcon(a.level)}\n${a.title}\n${a.body || ""}`, [[{ text: "🔎 حلّلها", callback_data: `z:${a.id}` }]]);
    await log(env, "monitor", "alert", { level: a.level, title: a.title });
    const auto = a.level === "urgent" || (rules.wakeOn === "important" && a.level === "important");
    if (auto) await wake(env, "monitor", analysisPrompt(a));
  }
  for (const s of solved) { await tg(env, `✅ انحلّت: ${s.title}`); await log(env, "monitor", "solved", { title: s.title }); }
  return { fresh: fresh.length, solved: solved.length, open: open.length - solved.length + fresh.length };
}

export function analysisPrompt(a) {
  return `تنبيه من خادم المكتب (${a.level}): ${a.title}\n${a.body || ""}\nرقم التنبيه في المكتب: ${a.id}`;
}
