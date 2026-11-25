// قاعدة بيانات المكتب (D1). الجداول تنعمل تلقائياً أول مرة، فما يحتاج المالك يشغّل شي
import { TEAM, AREAS, defaultLevel } from "./team.js";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS fails (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS perms (emp TEXT NOT NULL, area TEXT NOT NULL, level TEXT NOT NULL, PRIMARY KEY (emp, area))",
  "CREATE TABLE IF NOT EXISTS emp_state (emp TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'idle', session_url TEXT, note TEXT, at INTEGER)",
  "CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, emp TEXT NOT NULL, act TEXT NOT NULL, info TEXT)",
  "CREATE INDEX IF NOT EXISTS logs_emp ON logs (emp, id)",
  "CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL UNIQUE, level TEXT NOT NULL, title TEXT NOT NULL, body TEXT, first INTEGER NOT NULL, last INTEGER NOT NULL, open INTEGER NOT NULL DEFAULT 1)",
  "CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, emp TEXT NOT NULL, area TEXT NOT NULL, big INTEGER NOT NULL, deploy INTEGER NOT NULL DEFAULT 0, meeting INTEGER, title TEXT NOT NULL, detail TEXT, status TEXT NOT NULL, decided INTEGER, how TEXT)",
  "CREATE TABLE IF NOT EXISTS meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, by TEXT NOT NULL, topic TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', decision TEXT, agreed TEXT, closed INTEGER)",
  "CREATE TABLE IF NOT EXISTS meeting_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting INTEGER NOT NULL, at INTEGER NOT NULL, emp TEXT NOT NULL, text TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, emp TEXT NOT NULL, text TEXT NOT NULL, src TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', result TEXT, done INTEGER)",
  "CREATE TABLE IF NOT EXISTS agent_tokens (hash TEXT PRIMARY KEY, emp TEXT NOT NULL, expires INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS seen (k TEXT PRIMARY KEY, v INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS counters (day TEXT NOT NULL, k TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, k))",
];

let ready = false;
export async function ensureSchema(env) {
  if (ready && !env.__fresh) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  ready = true;
}

export const now = () => Date.now();
export const riyadhDay = (t = Date.now()) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);

export async function getSetting(env, k, dflt = null) {
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k = ?").bind(k).first();
  if (!r) return dflt;
  try { return JSON.parse(r.v); } catch { return dflt; }
}
export async function setSetting(env, k, v) {
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, JSON.stringify(v)).run();
}

export async function log(env, emp, act, info) {
  await env.DB.prepare("INSERT INTO logs (at, emp, act, info) VALUES (?, ?, ?, ?)")
    .bind(now(), emp, String(act).slice(0, 200), info == null ? null : JSON.stringify(info).slice(0, 4000)).run();
}

export async function permsOf(env, emp) {
  const rs = (await env.DB.prepare("SELECT area, level FROM perms WHERE emp = ?").bind(emp).all()).results || [];
  const set = Object.fromEntries(rs.map((r) => [r.area, r.level]));
  return Object.fromEntries(AREAS.map((a) => [a.key, set[a.key] || defaultLevel(a.key)]));
}

// عدّاد يومي (تشغيل الجلسات، الاجتماعات) عشان ما يخلص حد اشتراك Max
export async function bump(env, k, cap) {
  const day = riyadhDay();
  const r = await env.DB.prepare("SELECT n FROM counters WHERE day = ? AND k = ?").bind(day, k).first();
  const n = r ? r.n : 0;
  if (cap != null && n >= cap) return false;
  await env.DB.prepare("INSERT INTO counters (day, k, n) VALUES (?, ?, 1) ON CONFLICT(day, k) DO UPDATE SET n = n + 1").bind(day, k).run();
  return true;
}

export async function teamState(env) {
  const st = Object.fromEntries(((await env.DB.prepare("SELECT * FROM emp_state").all()).results || []).map((r) => [r.emp, r]));
  const out = [];
  for (const t of TEAM) {
    const last = await env.DB.prepare("SELECT at, act FROM logs WHERE emp = ? ORDER BY id DESC LIMIT 1").bind(t.key).first();
    const open = await env.DB.prepare("SELECT COUNT(*) n FROM tasks WHERE emp = ? AND status = 'open'").bind(t.key).first();
    out.push({ ...t, status: st[t.key]?.status || "idle", sessionUrl: st[t.key]?.session_url || null, note: st[t.key]?.note || null,
      last: last || null, openTasks: open ? open.n : 0, perms: await permsOf(env, t.key) });
  }
  return out;
}

// إعدادات سرية يحطها المالك من داخل الموقع (بدل إعدادات Cloudflare). المتغيرات في Cloudflare لها الأولوية
export const CFG_KEYS = ["TELEGRAM_BOT_TOKEN", "STORE_READER_PIN"];
export async function hydrate(env) {
  const out = { ...env };
  for (const k of CFG_KEYS) if (!out[k]) { const v = await getSetting(env, "cfg:" + k); if (v) out[k] = v; }
  return out;
}
