// تيليقرام + تشغيل جلسات الموظفين (routines على اشتراك Max)
import { bump, log, setSetting, getSetting } from "./db.js";

const ICON = { urgent: "🔴 عاجل", important: "🟠 مهم", info: "🔵 للعلم" };

// رقم محادثة المالك: من الإعداد أو من «اربط تيليقرام» في الموقع
export async function ownerChat(env) {
  if (env.TELEGRAM_CHAT_ID) return String(env.TELEGRAM_CHAT_ID);
  if (!env.DB) return null;
  const v = await getSetting(env, "tg_chat");
  return v ? String(v) : null;
}
export async function tgHookSecret(env) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ohod-office-tg:" + env.TELEGRAM_BOT_TOKEN));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
export async function tg(env, text, buttons) {
  const chat = env.TELEGRAM_BOT_TOKEN ? await ownerChat(env) : null;
  if (!chat) return { ok: false, skipped: true };
  const body = { chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true };
  if (buttons && buttons.length) body.reply_markup = { inline_keyboard: buttons };
  try {
    const r = await (env.fetch || fetch)(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { ok: r.ok };
  } catch { return { ok: false }; }
}
export const levelIcon = (l) => ICON[l] || ICON.info;

// ربط جلسة الموظف: من «ربط الجلسة» في الموقع (يتخزن في قاعدة المكتب الخاصة)، أو ROUTINE_<KEY>_ID/_TOKEN في Cloudflare
export async function routineOf(env, emp) {
  const K = emp.toUpperCase();
  const saved = (await getSetting(env, "routine:" + emp)) || {};
  return { id: env[`ROUTINE_${K}_ID`] || saved.id || null, token: env[`ROUTINE_${K}_TOKEN`] || saved.token || null };
}
export async function wake(env, emp, text) {
  const { id, token } = await routineOf(env, emp);
  if (!id || !token) { await log(env, emp, "wake_skipped", { why: "not_configured" }); return { ok: false, code: "not_configured" }; }
  const cap = Number(await getSetting(env, "fire_cap", 60));
  // رمز مؤقت للجلسة (٣ ساعات، لهالموظف بس): الموظف ما يحتاج سر ثابت في بيئته
  const tok = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!(await bump(env, "fire", cap))) { await log(env, emp, "wake_skipped", { why: "daily_cap", cap }); return { ok: false, code: "daily_cap" }; }
  try {
    const r = await (env.fetch || fetch)(`https://api.anthropic.com/v1/claude_code/routines/${encodeURIComponent(id)}/fire`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "experimental-cc-routine-2026-04-01", "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ text: `${String(text).slice(0, 7000)}\n\n---\nرابط المكتب: ${env.OFFICE_URL || ""}\nرمز جلستك (مؤقت ٣ ساعات، لا تطبعه في أي مكان): ${tok}\nأرسله في كل طلب للمكتب: Authorization: Bearer <الرمز>` }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { await log(env, emp, "wake_failed", { status: r.status }); return { ok: false, code: "fire_failed", status: r.status }; }
    const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tok)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare("INSERT INTO agent_tokens (hash, emp, expires) VALUES (?, ?, ?)").bind(h, emp, Date.now() + 3 * 3600e3).run();
    await env.DB.prepare("DELETE FROM agent_tokens WHERE expires < ?").bind(Date.now()).run();
    const url = j.claude_code_session_url || null;
    await env.DB.prepare("INSERT INTO emp_state (emp, status, session_url, at) VALUES (?, 'working', ?, ?) ON CONFLICT(emp) DO UPDATE SET status = 'working', session_url = excluded.session_url, at = excluded.at")
      .bind(emp, url, Date.now()).run();
    await log(env, emp, "woke", { url });
    return { ok: true, url };
  } catch { await log(env, emp, "wake_failed", { status: 0 }); return { ok: false, code: "fire_failed" }; }
}
export { setSetting };
