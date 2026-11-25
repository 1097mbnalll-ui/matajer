// تيليقرام + تشغيل جلسات الموظفين (routines على اشتراك Max)
import { bump, log, setSetting, getSetting } from "./db.js";

const ICON = { urgent: "🔴 عاجل", important: "🟠 مهم", info: "🔵 للعلم" };

export async function tg(env, text, buttons) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { ok: false, skipped: true };
  const body = { chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: true };
  if (buttons && buttons.length) body.reply_markup = { inline_keyboard: buttons };
  try {
    const r = await (env.fetch || fetch)(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { ok: r.ok };
  } catch { return { ok: false }; }
}
export const levelIcon = (l) => ICON[l] || ICON.info;

// يصحّي موظف: ROUTINE_<KEY>_ID (متغير عادي) + ROUTINE_<KEY>_TOKEN (سر)
export async function wake(env, emp, text) {
  const K = emp.toUpperCase();
  const id = env[`ROUTINE_${K}_ID`], token = env[`ROUTINE_${K}_TOKEN`];
  if (!id || !token) { await log(env, emp, "wake_skipped", { why: "not_configured" }); return { ok: false, code: "not_configured" }; }
  const cap = Number(await getSetting(env, "fire_cap", 60));
  if (!(await bump(env, "fire", cap))) { await log(env, emp, "wake_skipped", { why: "daily_cap", cap }); return { ok: false, code: "daily_cap" }; }
  try {
    const r = await (env.fetch || fetch)(`https://api.anthropic.com/v1/claude_code/routines/${encodeURIComponent(id)}/fire`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "experimental-cc-routine-2026-04-01", "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ text: String(text).slice(0, 8000) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { await log(env, emp, "wake_failed", { status: r.status }); return { ok: false, code: "fire_failed", status: r.status }; }
    const url = j.claude_code_session_url || null;
    await env.DB.prepare("INSERT INTO emp_state (emp, status, session_url, at) VALUES (?, 'working', ?, ?) ON CONFLICT(emp) DO UPDATE SET status = 'working', session_url = excluded.session_url, at = excluded.at")
      .bind(emp, url, Date.now()).run();
    await log(env, emp, "woke", { url });
    return { ok: true, url };
  } catch { await log(env, emp, "wake_failed", { status: 0 }); return { ok: false, code: "fire_failed" }; }
}
export { setSetting };
