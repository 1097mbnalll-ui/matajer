// واجهة «مكتب متاجر أحد»: محادثات مع الموظفين (مثل الواتساب) + المكتب الأيزومتري + الموافقات + الإعدادات
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LEVEL_NAME = { read: "يقرأ بس", propose: "يقترح وينتظر", auto: "ينفّذ لحاله" };
const STATUS_NAME = { idle: "فاضي", working: "يشتغل الحين", meeting: "في اجتماع" };
const ALERT_NAME = { urgent: "عاجل", important: "مهم", info: "للعلم" };
const ACT_NAME = {
  woke: "بدأ جلسة شغل", wake_skipped: "ما اشتغل (ما انربط أو وصل السقف)", wake_failed: "فشل تشغيل الجلسة", alert: "طلّع تنبيه", solved: "انحلّت مشكلة",
  task_received: "استلم مهمة", task_done: "خلّص مهمة", asked_approval: "طلب موافقتك", auto_approved: "نفّذ تعديل بسيط", approved_by_owner: "وافقت على طلبه",
  rejected_by_owner: "رفضت طلبه", meeting_opened: "فتح اجتماع", meeting_closed: "قفل اجتماع", told_owner: "كلّمك", perm_changed: "تغيّرت صلاحياته",
  rules_changed: "تغيّرت الإعدادات", alert_closed: "قفل تنبيه", routine_linked: "انربطت جلسته", routine_unlinked: "انفصلت جلسته",
  read_store: "قرأ بيانات المتجر", read_noon: "قرأ من نون", key_saved: "انحفظ مفتاح نون", skus_set: "تحدّثت قائمة منتجات نون", morning_report: "أرسل تقرير الصباح",
};
let S = null;

async function api(path, body) {
  const r = await fetch(path, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.code === "login") { showLogin(); throw new Error("login"); }
  return { status: r.status, ...j };
}
function toast(t) { const el = $("#toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), Math.max(2600, t.length * 70)); }
const when = (t) => new Date(t).toLocaleString("ar-SA-u-nu-arab", { weekday: "short", hour: "numeric", minute: "2-digit" });

// ---------- الدخول ----------
let SETUP = false;
async function showLogin() {
  $("#app").hidden = true; $("#login").hidden = false;
  const st = await fetch("/api/setup-status").then((r) => r.json()).catch(() => ({}));
  SETUP = !!st.needsSetup;
  $("#loginForm h1 + p").textContent = SETUP ? "أول مرة: اختر كلمة سر للمكتب (١٠ أحرف أو أكثر) واحفظها عندك" : "خاص بالمالك";
  $("#loginForm button").textContent = SETUP ? "احفظ كلمة السر وادخل" : "دخول";
  $("#pw").autocomplete = SETUP ? "new-password" : "current-password";
  $("#pw").focus();
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (SETUP) {
    const s = await fetch("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("#pw").value }) });
    const sj = await s.json().catch(() => ({}));
    if (!s.ok) { $("#loginMsg").textContent = sj.code === "too_short" ? "كلمة السر لازم ١٠ أحرف أو أكثر." : "انحفظت كلمة سر من قبل. سجّل دخول."; if (sj.code === "already_set") showLogin(); return; }
    SETUP = false;
  }
  const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("#pw").value }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { $("#pw").value = ""; $("#login").hidden = true; load(); return; }
  $("#loginMsg").textContent = j.code === "locked" ? `انقفل الدخول ${j.minutes} دقيقة بسبب محاولات غلط.` : `كلمة السر غلط${j.left != null ? ` (باقي ${j.left} محاولات)` : ""}.`;
});

// ---------- رسم المكتب ----------
const U = 17;
const iso = (x, y, z = 0) => [200 + (x - y) * U, 40 + (x + y) * U / 2 - z];
const pts = (...p) => p.map((q) => q.join(",")).join(" ");
const DESKS = { manager: [1.6, 1.6], monitor: [5, 1.4], morning: [8.2, 1.4], pricing: [1.4, 5.2], noon: [1.4, 8.2], ideas: [8.4, 5.4], assistant: [8.4, 8.4] };
const TABLE = [5.2, 5.6];
function box(x, y, w, d, h, top, side, front) {
  const a = iso(x, y, h), b = iso(x + w, y, h), c = iso(x + w, y + d, h), e = iso(x, y + d, h);
  const b0 = iso(x + w, y), c0 = iso(x + w, y + d), e0 = iso(x, y + d);
  return `<polygon points="${pts(e, c, c0, e0)}" fill="${front}"/><polygon points="${pts(b, c, c0, b0)}" fill="${side}"/><polygon points="${pts(a, b, c, e)}" fill="${top}"/>`;
}
function person(x, y, color, cls = "") {
  const [px, py] = iso(x, y);
  return `<g class="${cls}"><ellipse cx="${px}" cy="${py}" rx="6" ry="3" fill="rgba(0,0,0,.15)"/><rect x="${px - 5}" y="${py - 20}" width="10" height="16" rx="5" fill="${color}"/><circle cx="${px}" cy="${py - 24}" r="5" fill="#e8c39e" stroke="rgba(0,0,0,.15)"/></g>`;
}
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function drawOffice() {
  const g = [];
  // الأرضية بلاطات
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) g.push(`<polygon points="${pts(iso(i, j), iso(i + 1, j), iso(i + 1, j + 1), iso(i, j + 1))}" fill="${(i + j) % 2 ? css("--floor-a") : css("--floor-b")}"/>`);
  // الجدران الخلفية + نوافذ
  g.push(`<polygon points="${pts(iso(0, 0), iso(10, 0), iso(10, 0, 34), iso(0, 0, 34))}" fill="${css("--wall")}"/>`);
  g.push(`<polygon points="${pts(iso(0, 0), iso(0, 10), iso(0, 10, 34), iso(0, 0, 34))}" fill="${css("--wall-side")}"/>`);
  for (const k of [2.5, 6.5]) g.push(`<polygon points="${pts(iso(k, 0, 12), iso(k + 2, 0, 12), iso(k + 2, 0, 28), iso(k, 0, 28))}" fill="#a9cfe6" opacity=".75"/>`);
  // نبتة
  const [nx, ny] = iso(9.5, 9.5); g.push(`<circle cx="${nx}" cy="${ny - 14}" r="9" fill="#3f8f4f"/><rect x="${nx - 4}" y="${ny - 6}" width="8" height="8" fill="#9a6a3c"/>`);
  // طاولة الاجتماعات
  const meeting = S.team.filter((t) => t.status === "meeting");
  const [tx, ty] = iso(TABLE[0] + 0.6, TABLE[1] + 0.6, 10);
  g.push(`<g class="emp" tabindex="0" role="button" data-table aria-label="طاولة الاجتماعات">`);
  g.push(`<ellipse cx="${tx}" cy="${ty + 10}" rx="34" ry="17" fill="rgba(0,0,0,.12)"/><rect x="${tx - 3}" y="${ty}" width="6" height="10" fill="${css("--desk")}"/><ellipse cx="${tx}" cy="${ty}" rx="32" ry="16" fill="${css("--desk-top")}" stroke="${css("--desk")}"/>`);
  meeting.forEach((t, i) => { const a = (i / Math.max(meeting.length, 1)) * Math.PI * 2; g.push(person(TABLE[0] + 0.6 + Math.cos(a) * 1.5, TABLE[1] + 0.6 + Math.sin(a) * 1.5, css("--info"), "pulse")); });
  g.push(`<text class="zone" x="${tx}" y="${ty - 20}" text-anchor="middle">طاولة الاجتماعات${meeting.length ? ` · ${meeting.length} مجتمعين` : ""}</text></g>`);
  // المكاتب مرتبة من الخلف للأمام
  const order = S.team.slice().sort((a, b) => (DESKS[a.key][0] + DESKS[a.key][1]) - (DESKS[b.key][0] + DESKS[b.key][1]));
  for (const t of order) {
    const [x, y] = DESKS[t.key];
    const color = t.status === "working" ? css("--ok") : t.status === "meeting" ? css("--info") : css("--idle");
    const [lx, ly] = iso(x + 0.7, y + 0.4, 40);
    const w = Math.max(44, t.person.length * 7 + 20);
    g.push(`<g class="emp" tabindex="0" role="button" data-emp="${t.key}" aria-label="${esc(t.person)} · ${esc(t.name)}: ${STATUS_NAME[t.status]}">`);
    if (t.status !== "meeting") g.push(person(x + 0.7, y - 0.25, color, t.status === "working" ? "pulse" : ""));
    g.push(box(x, y, 1.4, 0.8, 12, css("--desk-top"), css("--desk"), css("--desk")));
    const [mx, my] = iso(x + 0.5, y + 0.2, 12); g.push(`<rect x="${mx - 6}" y="${my - 11}" width="12" height="9" rx="1.5" fill="#2b3a4a"/><rect x="${mx - 5}" y="${my - 10}" width="10" height="7" fill="${t.status === "working" ? "#7fe0b0" : "#5a6b7c"}"/>`);
    g.push(`<rect class="tag" x="${lx - w / 2}" y="${ly - 11}" width="${w}" height="15" rx="7.5"/><circle cx="${lx + w / 2 - 8}" cy="${ly - 3.5}" r="3" fill="${color}"/><text class="tagt" x="${lx - 3}" y="${ly}" text-anchor="middle">${esc(t.person)}</text>`);
    if (t.openTasks) g.push(`<circle cx="${lx - w / 2 + 2}" cy="${ly - 11}" r="6" fill="${css("--important")}"/><text x="${lx - w / 2 + 2}" y="${ly - 8}" font-size="8" fill="#fff" text-anchor="middle">${t.openTasks}</text>`);
    g.push(`</g>`);
  }
  $("#floor").innerHTML = g.join("");
}

// ---------- أيقونات وصور الموظفين ----------
const SV = (d, w = 24, c = "currentColor", sw = 1.9) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const IC = {
  tie: '<path d="M12 3l2 3-2 3-2-3 2-3zm0 6l3 9-3 3-3-3 3-9z"/>', eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', tag: '<path d="M3 12V3h9l9 9-9 9-9-9z"/><circle cx="8" cy="8" r="1.5"/>',
  box: '<path d="M3 7l9-4 9 4-9 4-9-4zm0 0v10l9 4 9-4V7M12 11v10"/>', bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 00-4 10c1 1 1 2 1 3h6c0-1 0-2 1-3a6 6 0 00-4-10z"/>',
  clip: '<path d="M9 4h6v3H9zM6 6h12v15H6z"/><path d="M9 12h6M9 16h4"/>', group: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5M14 20c0-2 2-4 4-4s3 1 3 3"/>',
  office: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M10 21v-4h4v4"/>', chats: '<path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>', set: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  attach: '<path d="M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 7"/>', send: '<path d="M4 12l16-8-6 16-2-6-8-2z"/>',
  back: '<path d="M9 6l6 6-6 6"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>', live: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
};
function avatar(t, size = 50) {
  const dot = t.status ? `<i class="st ${t.status}"></i>` : "";
  if (!t.person) return `<div class="av" style="--c:#2f6fb5;--s:${size}px">${SV(IC.group, Math.round(size * 0.48), "#fff", 2)}${dot}</div>`;
  return `<div class="av" style="--c:${t.color};--s:${size}px"><span>${esc(t.person[0])}</span><em>${SV(IC[t.icon], 13, t.color, 2.2)}</em>${dot}</div>`;
}
const num = (n) => Number(n).toLocaleString("ar-SA");
const timeShort = (t) => { const d = new Date(t), n = new Date(); const same = d.toDateString() === n.toDateString(); const y = new Date(n - 864e5).toDateString() === d.toDateString();
  return same ? d.toLocaleTimeString("ar-SA-u-nu-arab", { hour: "numeric", minute: "2-digit" }) : y ? "أمس" : d.toLocaleDateString("ar-SA-u-nu-arab", { weekday: "long" }); };
const KIND_PREFIX = { card: "ينتظر موافقتك: ", alert: "تنبيه: ", report: "تقرير: " };
const LINK_ERR = { token_is_url: "هذا رابط، مو الرمز. الرمز يبدأ بـ sk-ant-", token_empty: "خانة الرمز فاضية", token_masked: "هذا رمز مختصر فيه (...). سوّ رمز جديد (Regenerate) وانسخه كامل على طول", token_short: "الرمز ناقص. انسخه كامل", bad_routine_id: "رقم المهمة غلط" };

// ---------- الحالة والتبويبات ----------
let LIVE = null, C = null, USG = null, TAB = "chats", OPEN = null; // OPEN = {type:"emp",key} | {type:"meet",id}
async function load() {
  try {
    const [s, c, u] = await Promise.all([api("/api/state"), api("/api/chats"), api("/api/usage")]);
    if (!s.ok || !c.ok) return; S = s; C = c; USG = u.ok ? u : null;
    if (!LIVE || Date.now() - (LIVE._t || 0) > 60000) loadLive(); // الأرقام الحية (أبطأ) بالخلفية، كل دقيقة بالكثير
  } catch { return; }
  for (const t of S.team) { const x = C.chats.find((y) => y.key === t.key); if (x) Object.assign(t, { linked: x.linked }); }
  $("#app").hidden = false;
  render();
}
async function loadLive() { try { const l = await api("/api/live"); if (l.ok) { LIVE = { ...l, _t: Date.now() }; if (!OPEN && TAB === "chats") { const box = document.querySelector(".live2"); if (box) box.outerHTML = liveHTML(); else render(); } } } catch {} }
function render() {
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === TAB));
  const unread = C.chats.reduce((n, x) => n + x.unread, 0);
  $("#badgeChats").textContent = unread ? num(unread) : ""; $("#badgeChats").hidden = !unread;
  $("#badgeOk").textContent = C.pending ? num(C.pending) : ""; $("#badgeOk").hidden = !C.pending;
  const v = $("#view");
  if (TAB === "chats") v.innerHTML = chatsHTML();
  else if (TAB === "office") { v.innerHTML = officeHTML(); drawOffice(); }
  else if (TAB === "ok") v.innerHTML = approvalsHTML();
  else v.innerHTML = `<header class="tophead"><h1 class="title">الإعدادات</h1></header><div class="pad">${settingsHTML()}</div>`;
}
function chatsHTML() {
  const q = (window.__q || "").trim();
  const rows = [];
  const items = [...C.chats.map((x) => ({ t: "emp", at: x.last?.at || 0, x })), ...C.meetings.map((m) => ({ t: "meet", at: m.at, m }))].sort((a, b) => b.at - a.at);
  for (const it of items) {
    if (it.t === "emp") {
      const x = it.x; if (q && !(x.person + x.name).includes(q)) continue;
      const last = x.status === "working" ? '<span class="typing">يكتب…</span>' : x.last ? esc((x.last.frm === "owner" ? "أنت: " : "") + (KIND_PREFIX[x.last.kind] || "") + (x.last.text || "").replace(/\s+/g, " ").slice(0, 80)) : `<span class="muted">${x.linked ? "ينتظر شغلة منك" : "ما انربطت جلسته"}</span>`;
      rows.push(`<button class="crow" data-chat="${x.key}">${avatar(x)}<span class="mid"><span class="nm"><b>${esc(x.person)}</b> <small>· ${esc(x.name)}</small></span><span class="last">${last}</span></span><span class="side"><small>${x.last ? timeShort(x.last.at) : ""}</small>${x.unread ? `<i class="badge">${num(x.unread)}</i>` : ""}</span></button>`);
    } else {
      const m = it.m; if (q && !m.topic.includes(q)) continue;
      const nm = m.last ? (m.last.emp === "owner" ? "أنت" : S.team.find((t) => t.key === m.last.emp)?.person || "") : "";
      rows.push(`<button class="crow" data-meet="${m.id}">${avatar({ status: m.status === "open" ? "meeting" : null })}<span class="mid"><span class="nm"><b>اجتماع: ${esc(m.topic)}</b></span><span class="last">${m.last ? esc(nm + ": " + m.last.text.replace(/\s+/g, " ").slice(0, 80)) : '<span class="muted">بدأ الحين</span>'}</span></span><span class="side"><small>${timeShort(m.at)}</small></span></button>`);
    }
  }
  const usage = USG ? `<button class="usage" data-tab="set"><span>استهلاك اليوم: <b>${num(USG.today.sessions)}</b> جلسة · تقريباً <b>${USG.today.usd.toLocaleString("ar-SA")}$</b></span><small>الحد ${num(USG.fireCap)} جلسة</small></button>` : "";
  return `<header class="tophead"><h1 class="title">المحادثات</h1><span class="hbtns">${C.pending ? `<button class="pill" data-tab="ok">${num(C.pending)} ينتظر موافقتك</button>` : ""}<button class="pill ghost" data-newmeet>+ اجتماع</button></span></header>
    ${liveHTML()}
    <div class="searchbox"><input id="q" placeholder="ابحث في المحادثات" value="${esc(q)}">${usage}</div><div class="clist">${rows.join("") || '<div class="empty">ما فيه نتائج</div>'}</div>`;
}
function officeHTML() {
  const alerts = S.alerts.slice(0, 6).map((a) => `<div class="alert ${a.level}"><div class="grow"><div class="t">${ALERT_NAME[a.level]} · ${esc(a.title)}</div><div class="b">${esc(a.body || "")} · ${when(a.first)}</div></div><button class="btn small" data-analyze="${a.id}">حلّلها</button></div>`).join("");
  return `<header class="tophead"><h1 class="title">المكتب</h1><span class="muted">${new Date().toLocaleDateString("ar-SA-u-nu-arab", { weekday: "long", day: "numeric", month: "long" })}</span></header>
    <section class="alerts">${alerts}</section><main class="office"><svg id="floor" viewBox="22 6 356 214" role="img" aria-label="مخطط المكتب"></svg><p class="hint muted">اضغط على أي موظف تفتح محادثته</p></main>`;
}
function approvalsHTML() {
  const nm = (k) => { const t = S.team.find((x) => x.key === k); return t ? `${t.person} · ${t.name}` : k; };
  return `<header class="tophead"><h1 class="title">الموافقات</h1></header><div class="pad">${S.pending.map((q) => `<div class="req"><div class="meta">${esc(nm(q.emp))} · ${esc(S.areas.find((a) => a.key === q.area)?.name)} · ${when(q.at)}${q.meeting ? ` · بعد اجتماع رقم ${q.meeting}` : ""}</div>
    <b>${esc(q.title)}</b>${q.detail ? `<pre>${esc(q.detail)}</pre>` : ""}<div class="btns"><button class="btn primary" data-yes="${q.id}">موافق</button><button class="btn danger" data-no="${q.id}">رفض</button></div></div>`).join("") || '<div class="empty">ما فيه شي ينتظرك</div>'}</div>`;
}
function liveHTML() {
  if (!LIVE) return "";
  const sar = (n) => Number(n || 0).toLocaleString("ar-SA", { maximumFractionDigits: 0 }) + " ر.س";
  const st = LIVE.store, nn = LIVE.noon;
  const openN = st.ok ? Object.values(st.open || {}).reduce((a, b) => a + b, 0) : 0;
  const chg = st.ok && st.lastWeek ? Math.round((st.revenue - st.lastWeek) / st.lastWeek * 100) : null;
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "الحين" : `قبل ${num(m)} دقيقة`; };
  const storeBox = st.ok ? `<div class="lv"><div class="lvh">البقالة اليوم <small>لحظي</small></div><div class="lvn">${sar(st.revenue)}</div><div class="lvs">${num(st.orders)} طلب${chg != null ? ` · ${chg >= 0 ? "+" : ""}${num(chg)}٪ عن الأسبوع الماضي` : ""}${st.cost > 0 ? ` · ربح تقريبي ${sar(st.revenue - st.cost)}` : ""}</div>
    <div class="lvs">${openN ? `مفتوحة: ${num(openN)}` : "ما فيه طلبات مفتوحة"}${st.late ? ` · <b class="warn">متأخرة: ${num(st.late)}</b>` : ""}${st.cash != null ? ` · عهدة المندوب: ${sar(st.cash)}` : ""}</div></div>` : `<div class="lv"><div class="lvh">البقالة</div><div class="lvs">ما قدرت أقرأ المتجر الحين</div></div>`;
  const noonBox = nn.ok ? `<div class="lv"><div class="lvh">نون الحين <small>${ago(nn.at)}</small></div><div class="lvn">${num(nn.total)} قطعة</div><div class="lvs">${num(nn.products)} منتج${nn.out ? ` · <b class="warn">خلص: ${num(nn.out)}</b>` : ""}${nn.hidden ? ` · <b class="warn">مخفي: ${num(nn.hidden)}</b>` : ""}</div>
    <details class="lvd"><summary>التفاصيل</summary>${nn.items.map((i) => `<div class="lvi"><span>${esc(i.title.slice(0, 40))}</span><b>${num(i.stock)}</b></div>`).join("")}</details></div>`
    : `<div class="lv"><div class="lvh">نون</div><div class="lvs">${nn.why === "no_key" ? "ما انربط مفتاح نون" : "راكان بيعبّي قائمة المنتجات أول مهمة، أو أضفها من الإعدادات"}</div></div>`;
  return `<div class="live2">${storeBox}${noonBox}</div>`;
}
function usageHTML() {
  if (!USG) return "";
  const row = (lbl, x) => `<tr><td>${lbl}</td><td><b>${num(x.sessions)}</b> جلسة</td><td>≈ ${num(Math.round(x.tokens / 1000))} ألف توكن</td><td>≈ <b>${x.usd.toLocaleString("ar-SA")}$</b></td></tr>`;
  const by = Object.entries(USG.today.by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(S.team.find((t) => t.key === k)?.person || k)}: ${num(n)}`).join(" · ");
  return `<div class="usagecard"><h3 style="margin-top:0">الاستهلاك</h3><table>${row("اليوم", USG.today)}${row("آخر ٧ أيام", USG.week)}${row("آخر ٣٠ يوم", USG.month)}</table>
    ${by ? `<p class="muted" style="font-size:13px;margin:8px 0 0">اليوم لكل موظف: ${by}</p>` : ""}
    <p class="muted" style="font-size:12.5px;margin:8px 0 0">عدد الجلسات حقيقي من سجل المكتب. التوكنز والدولار <b>تقدير</b> (حوالي ${USG.perSession.toLocaleString("ar-SA")}$ للجلسة بسعر API). أنت على اشتراك Max، يعني ما تندفع فلوس زيادة على كل جلسة؛ الجلسات تنخصم من حد الاشتراك. الحد الحقيقي تشوفه في claude.ai ← Settings ← Usage.</p></div>`;
}
function settingsHTML() {
  return usageHTML() + `<label class="field"><span>حد كاش المندوب (ر.س)</span><input id="cashLimit" type="number" inputmode="numeric" value="${S.rules.cashLimit}"></label>
    <label class="field"><span>متى يصحى فهد (المراقب) لحاله؟</span><select id="wakeOn">
      <option value="urgent" ${S.rules.wakeOn === "urgent" ? "selected" : ""}>العاجل بس</option><option value="important" ${S.rules.wakeOn === "important" ? "selected" : ""}>العاجل والمهم</option><option value="none" ${S.rules.wakeOn === "none" ? "selected" : ""}>ولا شي، بس لما أضغط «حلّلها»</option></select></label>
    <label class="field"><span>أقصى عدد جلسات باليوم (عشان حد اشتراك Max)</span><input id="fireCap" type="number" inputmode="numeric" value="${S.caps.fire}"></label>
    <label class="field"><span>أقصى عدد اجتماعات باليوم</span><input id="meetingCap" type="number" inputmode="numeric" value="${S.caps.meetings}"></label>
    <div class="btns"><button class="btn primary" id="saveRules">احفظ</button></div>
    <h3>تيليقرام ${S.telegram.linked ? "✅ مربوط" : "⚪️ مو مربوط"}</h3>
    <label class="field"><span>رمز البوت من BotFather ${S.telegram.bot ? "(محفوظ ✅، اتركه فاضي إذا ما تبي تغيّره)" : ""}</span><input id="cfgBot" type="password" dir="ltr" autocomplete="off"></label>
    <p class="muted" style="font-size:13px;margin-top:0">بعد ما تحفظ الرمز: أرسل أي رسالة للبوت، وبعدها اضغط «اربط تيليقرام».</p>
    <h3>حساب «قارئ المكتب» في المتجر ${S.reader ? "✅" : "⚪️"}</h3>
    <label class="field"><span>الرقم السري (١٢ رقم) ${S.reader ? "(محفوظ ✅)" : ""}</span><input id="cfgPin" type="password" inputmode="numeric" dir="ltr" autocomplete="off"></label>
    <div class="btns"><button class="btn primary" id="saveCfg">احفظ</button>${S.telegram.bot ? `<button class="btn" id="tgSetup">${S.telegram.linked ? "أعد ربط تيليقرام" : "اربط تيليقرام"}</button>` : ""}</div>
    <h3>نون ${S.noon.key ? "✅ مربوط" : "⚪️ مو مربوط"}</h3>
    <label class="field"><span>ملف المفتاح من نون (.json) ${S.noon.key ? "(محفوظ ✅، ارفع ملف جديد بس إذا تبي تغيّره)" : ""}</span><input id="noonFile" type="file" accept=".json,application/json"></label>
    <label class="field"><span>المنتجات اللي يراقبها راكان في نون (رموز SKU، كل واحد بسطر) · الحين ${S.noon.skus}</span><textarea id="noonSkus" dir="ltr" placeholder="SKU-001&#10;SKU-002"></textarea></label>
    <div class="btns"><button class="btn" id="saveNoon">احفظ نون</button>${S.noon.key ? '<button class="btn" id="testNoon">جرّب الاتصال</button>' : ""}</div>
    <h3>الموظفين</h3><div class="clist flat">${S.team.map((t) => `<button class="crow" data-info="${t.key}">${avatar({ ...t, status: null }, 40)}<span class="mid"><span class="nm"><b>${esc(t.person)}</b> <small>· ${esc(t.name)}</small></span><span class="last">${t.linked ? "مربوط ✅ · الصلاحيات والسجل" : "ما انربطت جلسته ⚪️"}</span></span></button>`).join("")}</div>
    <div class="btns" style="margin-top:18px"><button class="btn danger" id="logout">خروج</button></div>`;
}

// ---------- المحادثة ----------
// كاش المحادثات: تنفتح فوراً من آخر نسخة، وبعدها تتحدث بهدوء
const CH = {}, SIG = {};
function openChat(key) { OPEN = { type: "emp", key }; history.pushState({ chat: key }, ""); $("#chat").hidden = false; paintChat(true); refreshOpen(true); }
function openMeet(id) { OPEN = { type: "meet", id: Number(id) }; history.pushState({ meet: id }, ""); $("#chat").hidden = false; $("#chat").innerHTML = CH["m" + id] || '<div class="empty">…</div>'; refreshOpen(true); }
function closeChat(fromPop) {
  if (!OPEN) return;
  if (OPEN.type === "emp") { const x = C.chats.find((y) => y.key === OPEN.key); if (x) x.unread = 0; }
  OPEN = null; $("#chat").hidden = true; render(); // القائمة تطلع فوراً من الكاش
  if (!fromPop && history.state && (history.state.chat || history.state.meet)) history.back();
  setTimeout(load, 50);
}
addEventListener("popstate", () => { if (OPEN) closeChat(true); else if (!$("#sheet").hidden) closeSheet(); });
function paintChat(first) { const key = OPEN?.key; if (key && CH[key]) { $("#chat").innerHTML = CH[key]; const b = $("#msgs"); if (b && first) b.scrollTop = b.scrollHeight; } else $("#chat").innerHTML = '<div class="empty">…</div>'; }
const tmOf = (at) => new Date(at).toLocaleTimeString("ar-SA-u-nu-arab", { hour: "numeric", minute: "2-digit" });
async function refreshOpen(first) {
  if (!OPEN) return;
  const keep = !first && $("#msgIn") ? { v: $("#msgIn").value, f: document.activeElement === $("#msgIn"), file: $("#msgFile")?.files[0] ? $("#fileName").textContent : "" } : null;
  if (keep && keep.file) return; // لا نمسح ملف مختار قبل الإرسال
  const box0 = $("#msgs"); const atBottom = !box0 || box0.scrollHeight - box0.scrollTop - box0.clientHeight < 80;
  if (OPEN.type === "emp") {
    const key = OPEN.key, t = S.team.find((x) => x.key === key), ch = C.chats.find((x) => x.key === key);
    const r = await api(`/api/chat?emp=${key}`); if (!r.ok || OPEN?.key !== key) return;
    const sig = JSON.stringify([r.messages.at(-1)?.id, r.messages.length, r.status, Object.values(r.cards).map((q) => q.status)]);
    if (!first && SIG[key] === sig && !$("#chat .pending-b")) return; // ما فيه جديد: لا نعيد الرسم
    SIG[key] = sig;
    const live = r.sessionUrl ? `<a class="live" href="${esc(r.sessionUrl)}" target="_blank" rel="noopener">${SV(IC.live, 14)} لايف</a>` : "";
    let day = "";
    const msgs = r.messages.map((m) => {
      const d = new Date(m.at).toLocaleDateString("ar-SA-u-nu-arab", { weekday: "long", day: "numeric", month: "long" });
      const sep = d !== day ? `<div class="day">${(day = d)}</div>` : "";
      if (m.frm === "sys") return sep + `<div class="sys">${esc(m.text)}</div>`;
      if (m.kind === "card") {
        const q = r.cards[m.ref] || {}; const area = S.areas.find((a) => a.key === q.area)?.name || "";
        const stt = q.status === "pending" ? `<div class="cbtns"><button data-yes="${q.id}" class="ok">موافق</button><button data-no="${q.id}" class="no">رفض</button></div>` : `<div class="cdone ${q.status}">${q.status === "approved" ? "✓ تمت الموافقة" : "✕ انرفض"}</div>`;
        return sep + `<div class="apv"><div class="chd">${q.big ? "ينتظر موافقتك" : "تعديل بسيط انفّذ"} · ${esc(area)}</div><div class="cb"><b>${esc(q.title || m.text)}</b>${q.detail ? `<pre>${esc(q.detail)}</pre>` : ""}</div>${q.big ? stt : ""}<small class="ct">${tmOf(m.at)}</small></div>`;
      }
      const cls = m.frm === "owner" ? "me" : "th" + (m.kind === "alert" ? " alert-b" : m.kind === "report" ? " report-b" : "");
      const tag = m.kind === "alert" ? '<div class="who warn">تنبيه</div>' : m.kind === "report" ? '<div class="who">تقرير</div>' : "";
      return sep + `<div class="b ${cls}">${tag}${esc(m.text)}<small>${tmOf(m.at)}</small></div>`;
    }).join("") || `<div class="empty">ابدأ المحادثة مع ${esc(t.person)}</div>`;
    const typing = r.status === "working" ? '<div class="dots" aria-label="يكتب"><i></i><i></i><i></i></div>' : "";
    const chips = (t.chips || []).map((c) => `<button class="chip" data-chip="${esc(c)}">${esc(c)}</button>`).join("");
    const sub = r.status === "working" ? "يشتغل الحين…" : !ch?.linked ? "ما انربطت جلسته" : r.status === "meeting" ? "في اجتماع" : "متاح";
    $("#chat").innerHTML = `<header class="chathead"><button class="icon" data-close-chat aria-label="رجوع">${SV(IC.back, 26)}</button>${avatar({ ...t, status: null }, 42)}<div class="who2"><b>${esc(t.person)}</b><small class="${r.status === "working" ? "on" : ""}">${esc(t.name)} · ${sub}</small></div>${live}<button class="icon" data-info="${key}" aria-label="معلومات ${esc(t.person)}">${SV(IC.info, 22)}</button></header>
      ${key === "noon" ? '<div class="redline">🔴 خط أحمر: راكان ما يعدّل أي شي على نون، ولو مثقال ذرة، إلا بإذنك</div>' : ""}
      <div class="msgs" id="msgs">${msgs}${typing}</div>
      <div class="chips">${chips}</div>
      <form class="compose" id="compose"><label class="icon attach" aria-label="إرفاق ملف">${SV(IC.attach, 20)}<input type="file" id="msgFile" hidden></label><div class="inwrap"><span id="fileName" class="fname"></span><textarea id="msgIn" rows="1" placeholder="اكتب رسالة لـ ${esc(t.person)}…"></textarea></div><button class="icon send" type="submit" aria-label="أرسل">${SV(IC.send, 20, "#fff")}</button></form>`;
    CH[key] = $("#chat").innerHTML;
  } else {
    const id = OPEN.id;
    const r = await api(`/api/meeting?id=${id}`); if (!r.ok || OPEN?.id !== id) return;
    const sig = JSON.stringify([r.lines.length, r.meeting.status]);
    if (!first && SIG["m" + id] === sig) return;
    SIG["m" + id] = sig;
    const who = (k) => k === "owner" ? { person: "أنت", color: "#0f6b4f", name: "" } : S.team.find((x) => x.key === k) || { person: k, color: "#666", name: "" };
    const names = [...new Set(r.lines.map((l) => l.emp).filter((k) => k !== "owner"))].map((k) => who(k).person).join(" · ");
    const lines = r.lines.map((l) => { const w = who(l.emp);
      return l.emp === "owner" ? `<div class="b me">${esc(l.text)}<small>${tmOf(l.at)}</small></div>` : `<div class="b th"><div class="who" style="color:${w.color}">${esc(w.person)} · ${esc(w.name)}</div>${esc(l.text)}<small>${tmOf(l.at)}</small></div>`; }).join("");
    const m = r.meeting;
    let agreed = []; try { agreed = JSON.parse(m.agreed || "[]"); } catch {}
    const decision = m.decision ? `<div class="sys big">القرار: ${esc(m.decision)}<div class="votes">${agreed.map((k) => `<span>${esc(who(k).person)} ✓</span>`).join("")}</div>${m.status === "no_consensus" ? "<div>ما اتفقوا كلهم، فما يتنفذ شي</div>" : ""}</div>` : "";
    const open = m.status === "open";
    $("#chat").innerHTML = `<header class="chathead"><button class="icon" data-close-chat aria-label="رجوع">${SV(IC.back, 26)}</button>${avatar({ status: null }, 42)}<div class="who2"><b>اجتماع: ${esc(m.topic)}</b><small>${esc(names || "ينتظر الموظفين")}</small></div></header>
      <div class="msgs" id="msgs"><div class="sys">سلطان (المدير) فتح الاجتماع</div>${lines}${decision}${open ? '<div class="dots"><i></i><i></i><i></i></div>' : ""}</div>
      <form class="compose" id="compose"><div class="inwrap"><textarea id="msgIn" rows="1" placeholder="${open ? "علّق على الاجتماع…" : "الاجتماع انتهى"}" ${open ? "" : "disabled"}></textarea></div><button class="icon send" type="submit" aria-label="أرسل" ${open ? "" : "disabled"}>${SV(IC.send, 20, "#fff")}</button></form>`;
  }
  if (OPEN?.type === "meet") CH["m" + OPEN.id] = $("#chat").innerHTML;
  if (keep) { $("#msgIn").value = keep.v; if (keep.f) $("#msgIn").focus(); }
  const box = $("#msgs"); if (first || atBottom) box.scrollTop = box.scrollHeight;
}
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "compose") return;
  e.preventDefault();
  const text = $("#msgIn").value.trim();
  if (OPEN?.type === "meet") { if (!text) return; $("#msgIn").value = ""; const box = $("#msgs"); const pend = document.createElement("div"); pend.className = "b me"; pend.textContent = text; box.appendChild(pend); box.scrollTop = box.scrollHeight; await api("/api/meeting-say", { id: OPEN.id, text }); SIG["m" + OPEN.id] = null; return refreshOpen(); }
  const fl = $("#msgFile")?.files[0];
  if (!text && !fl) return;
  let file = null;
  if (fl) {
    if (fl.size > 1024 * 1024) { toast("الملف أكبر من ١ ميقا"); return; }
    const b = new Uint8Array(await fl.arrayBuffer()); let bin = ""; for (let i = 0; i < b.length; i += 8192) bin += String.fromCharCode(...b.subarray(i, i + 8192));
    file = { name: fl.name, type: fl.type, b64: btoa(bin) };
  }
  $("#msgIn").value = ""; $("#msgIn").style.height = "auto"; if ($("#msgFile")) $("#msgFile").value = ""; if ($("#fileName")) $("#fileName").textContent = "";
  // تطلع رسالتك فوراً (مثل الواتساب) وبعدها تتأكد من الخادم
  const box = $("#msgs"); const pend = document.createElement("div");
  pend.className = "b me pending-b"; pend.textContent = (text || "شوف الملف المرفق") + (fl ? "\n📎 " + fl.name : "");
  const sm = document.createElement("small"); sm.textContent = "🕓"; pend.appendChild(sm); box.querySelector(".empty")?.remove(); box.appendChild(pend); box.scrollTop = box.scrollHeight;
  const key = OPEN.key;
  const r = await api("/api/task", { emp: key, text: text || "شوف الملف المرفق", file }).catch(() => ({ ok: false }));
  if (!r.ok) { sm.textContent = "⚠️ ما انرسلت"; return; }
  sm.textContent = "✓"; SIG[key] = null; if (OPEN?.key === key) setTimeout(() => refreshOpen(), 400);
});
document.addEventListener("change", (e) => { if (e.target.id === "msgFile") $("#fileName").textContent = e.target.files[0] ? "📎 " + e.target.files[0].name : ""; });
document.addEventListener("input", (e) => {
  if (e.target.id === "q") { window.__q = e.target.value; const pos = e.target.selectionStart; render(); const q = $("#q"); q.focus(); q.setSelectionRange(pos, pos); }
  if (e.target.id === "msgIn") { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; }
});

// ---------- معلومات الموظف: الربط، الصلاحيات، السجل ----------
function openSheet(html) { $("#sheetContent").innerHTML = html; $("#sheet").hidden = false; }
function closeSheet() { $("#sheet").hidden = true; }
async function openInfo(key) {
  const t = S.team.find((x) => x.key === key);
  const r = await api(`/api/log?emp=${key}`);
  const perms = S.areas.map((a) => `<div class="perm"><div class="lbl"><span>${esc(a.name)}</span>${a.big ? '<span class="note">كبير: ينتظر موافقتك دايماً</span>' : ""}</div>
    <div class="seg">${S.levels.map((l) => `<button data-perm="${a.key}" data-level="${l}" data-pemp="${key}" class="${t.perms[a.key] === l ? "on" : ""}">${LEVEL_NAME[l]}</button>`).join("")}</div></div>`).join("");
  const log = (r.log || []).slice(0, 40).map((l) => `<div class="logline"><time>${when(l.at)}</time><span>${esc(ACT_NAME[l.act] || l.act)}</span></div>`).join("") || '<div class="empty">ما سوّى شي للحين</div>';
  openSheet(`<div class="infohead">${avatar({ ...t, status: null }, 64)}<div><h2>${esc(t.person)}</h2><div class="muted">${esc(t.name)} · ${esc(t.job)}</div><div class="muted">${t.direct ? "يكلمك مباشرة" : "يرفع للمدير العام (سلطان)"}</div></div></div>
    <h3>ربط الجلسة ${t.linked ? "✅" : "⚪️"}</h3>
    <details${t.linked ? "" : " open"}><summary class="muted">${t.linked ? "غيّر الربط" : "اربط الحين"}</summary>
      <label class="field"><span>رقم المهمة</span><input id="rtId" dir="ltr" autocomplete="off" value="${esc(t.routine || "")}"></label>
      <label class="field"><span>الرمز: يبدأ بـ <b dir="ltr">sk-ant-</b> وطويل (انسخه كامل أول ما يطلع)</span><input id="rtTok" type="password" dir="ltr" autocomplete="off"></label>
      <div class="btns"><button class="btn primary" data-link="${key}">احفظ الربط</button>${t.linked ? `<button class="btn danger" data-unlink="${key}">افصل</button>` : ""}</div></details>
    <h3>بطاقة الصلاحيات</h3>${perms}<h3>السجل</h3>${log}`);
}

// ---------- اجتماع جديد ----------
function openNewMeeting() {
  openSheet(`<h2>اجتماع جديد</h2><p class="muted" style="margin-top:0">اختر الموظفين والموضوع، وسلطان (المدير العام) يدير النقاش ويرسل لك القرار.</p>
    <label class="field"><span>الموضوع</span><input id="mTopic" placeholder="مثلاً: عروض الويكند"></label>
    <label class="field"><span>ملاحظة منك للمجتمعين (اختياري)</span><textarea id="mNote" placeholder="مثلاً: ركزوا على المنتجات اللي خلصت"></textarea></label>
    <div class="field"><span>المشاركين (اثنين أو أكثر)</span><div class="picks">${S.team.map((t) => `<label class="pick"><input type="checkbox" value="${t.key}">${avatar({ ...t, status: null }, 36)}<span><b>${esc(t.person)}</b><small>${esc(t.name)}</small></span></label>`).join("")}</div></div>
    <p class="muted" id="mCost" style="font-size:13px"></p>
    <div class="btns"><button class="btn primary" id="mStart">ابدأ الاجتماع</button></div>`);
  const upd = () => { const n = document.querySelectorAll(".picks input:checked").length; $("#mCost").textContent = n ? `بياخذ تقريباً ${num(n + (document.querySelector('.picks input[value="manager"]:checked') ? 0 : 1))} جلسات أو أكثر من اشتراكك.` : ""; };
  document.querySelectorAll(".picks input").forEach((i) => i.addEventListener("change", upd));
}

// ---------- الضغطات ----------
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-newmeet],#mStart,[data-close],[data-table],[data-tab],[data-chat],[data-meet],[data-emp],[data-chip],[data-close-chat],[data-info],[data-perm],[data-yes],[data-no],[data-analyze],[data-link],[data-unlink],#tgSetup,#saveCfg,#saveNoon,#testNoon,#saveRules,#logout");
  if (!el) return;
  const d = el.dataset;
  try {
    if (d.newmeet !== undefined) openNewMeeting();
    else if (el.id === "mStart") {
      const who = [...document.querySelectorAll(".picks input:checked")].map((i) => i.value);
      const r = await api("/api/meeting-new", { topic: $("#mTopic").value.trim(), note: $("#mNote").value.trim(), who });
      if (!r.ok) { toast({ no_topic: "اكتب الموضوع", need_two: "اختر موظفين اثنين أو أكثر", meeting_cap: "وصلت حد الاجتماعات اليوم" }[r.code] || "ما بدأ الاجتماع"); return; }
      closeSheet(); toast("بدأ الاجتماع"); await load(); openMeet(r.id);
    }
    else if (d.close !== undefined) closeSheet();
    else if (d.tab) { TAB = d.tab; render(); window.scrollTo(0, 0); }
    else if (d.chat) openChat(d.chat);
    else if (d.table !== undefined) { TAB = "chats"; render(); }
    else if (d.meet) openMeet(d.meet);
    else if (d.closeChat !== undefined) closeChat(false);
    else if (d.info) openInfo(d.info);
    else if (d.chip) { const i = $("#msgIn"); i.value = d.chip + (/[:]$|عن$|بـ$/.test(d.chip) ? " " : ""); i.focus(); }
    else if (d.emp) openChat(d.emp);
    else if (d.perm) {
      const r = await api("/api/perm", { emp: d.pemp, area: d.perm, level: d.level });
      if (r.ok) { S.team.find((t) => t.key === d.pemp).perms = r.perms; el.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === el)); toast("تغيّرت الصلاحية"); }
    } else if (d.yes || d.no) {
      const r = await api("/api/decide", { id: Number(d.yes || d.no), yes: !!d.yes });
      toast(r.ok ? (d.yes ? "تمت الموافقة" : "انرفض") : "انحسم من قبل"); await load(); if (OPEN) refreshOpen();
    } else if (d.analyze) {
      const r = await api("/api/analyze", { id: Number(d.analyze) }); toast(r.ok ? `${r.who} يحللها الحين` : r.why || "ما صحى");
    } else if (el.id === "saveRules") {
      await api("/api/rules", { cashLimit: Number($("#cashLimit").value), wakeOn: $("#wakeOn").value, fireCap: Number($("#fireCap").value), meetingCap: Number($("#meetingCap").value) });
      toast("انحفظت"); load();
    } else if (d.link) {
      const r = await api("/api/routine", { emp: d.link, id: $("#rtId").value.trim(), token: $("#rtTok").value.trim() });
      toast(r.ok ? "انربط ✅" : r.code === "token_prefix" ? `الرمز لازم يبدأ بـ sk-ant- (اللي لصقته يبدأ بـ «${r.start}»)` : LINK_ERR[r.code] || "ما انحفظ، جرّب مرة ثانية");
      if (r.ok) { await load(); openInfo(d.link); }
    } else if (d.unlink) {
      await api("/api/routine", { emp: d.unlink, clear: true }); toast("انفصل"); await load(); openInfo(d.unlink);
    } else if (el.id === "saveCfg") {
      const r = await api("/api/config", { TELEGRAM_BOT_TOKEN: $("#cfgBot").value.trim() || null, STORE_READER_PIN: $("#cfgPin").value.trim() || null });
      toast(r.ok ? "انحفظ ✅" : "ما انحفظ"); load();
    } else if (el.id === "saveNoon") {
      const f = $("#noonFile").files[0], skus = $("#noonSkus").value.trim();
      if (f) {
        const r = await api("/api/noon-key", { text: await f.text() });
        toast(!r.ok ? "الملف مو ملف مفتاح نون" : r.test.ok ? "انربط نون ✅ والاتصال شغّال" : "انحفظ المفتاح، بس نون رفض الدخول (" + (r.test.status || r.test.code) + ")");
      }
      if (skus) { const r = await api("/api/noon-skus", { skus }); toast(`انحفظت ${r.n} منتج للمراقبة`); }
      load();
    } else if (el.id === "testNoon") {
      const r = await api("/api/noon-test", {}); toast(r.ok ? "الاتصال بنون شغّال ✅" : "نون ما رد صح (" + (r.status || r.code) + ")");
    } else if (el.id === "tgSetup") {
      const r = await api("/api/tg-setup", {});
      toast(r.ok ? "انربط تيليقرام ✅ شيك على البوت" : r.code === "send_message_first" ? "أرسل رسالة للبوت أول وبعدها اضغط" : "ما انربط، جرّب مرة ثانية"); if (r.ok) load();
    } else if (el.id === "logout") { await api("/api/logout", {}); showLogin(); }
  } catch {}
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (!$("#sheet").hidden) closeSheet(); else if (OPEN) closeChat(false); }
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".emp")) { e.preventDefault(); e.target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => S && TAB === "office" && drawOffice());
// تحديث ذكي: المحادثة المفتوحة كل ٤ ثواني، القائمة كل ١٢ ثانية، والأرقام الحية كل دقيقة
setInterval(() => { if (!document.hidden && S && OPEN) refreshOpen(); }, 4000);
setInterval(() => { if (!document.hidden && S && !OPEN) load(); }, 12000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && S) { if (OPEN) refreshOpen(); else load(); } });
load();
