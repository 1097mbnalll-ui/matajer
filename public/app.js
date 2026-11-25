// واجهة «مكتب متاجر أحد»: مكتب أيزومتري + الموافقات + الصلاحيات + السجل
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
function toast(t) { const el = $("#toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 2600); }
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
  g.push(`<g class="emp" tabindex="0" role="button" data-meet="1" aria-label="طاولة الاجتماعات">`);
  g.push(`<ellipse cx="${tx}" cy="${ty + 10}" rx="34" ry="17" fill="rgba(0,0,0,.12)"/><rect x="${tx - 3}" y="${ty}" width="6" height="10" fill="${css("--desk")}"/><ellipse cx="${tx}" cy="${ty}" rx="32" ry="16" fill="${css("--desk-top")}" stroke="${css("--desk")}"/>`);
  meeting.forEach((t, i) => { const a = (i / Math.max(meeting.length, 1)) * Math.PI * 2; g.push(person(TABLE[0] + 0.6 + Math.cos(a) * 1.5, TABLE[1] + 0.6 + Math.sin(a) * 1.5, css("--info"), "pulse")); });
  g.push(`<text class="zone" x="${tx}" y="${ty - 20}" text-anchor="middle">طاولة الاجتماعات${meeting.length ? ` · ${meeting.length} مجتمعين` : ""}</text></g>`);
  // المكاتب مرتبة من الخلف للأمام
  const order = S.team.slice().sort((a, b) => (DESKS[a.key][0] + DESKS[a.key][1]) - (DESKS[b.key][0] + DESKS[b.key][1]));
  for (const t of order) {
    const [x, y] = DESKS[t.key];
    const color = t.status === "working" ? css("--ok") : t.status === "meeting" ? css("--info") : css("--idle");
    const [lx, ly] = iso(x + 0.7, y + 0.4, 40);
    const w = Math.max(44, t.short.length * 7 + 20);
    g.push(`<g class="emp" tabindex="0" role="button" data-emp="${t.key}" aria-label="${esc(t.name)}: ${STATUS_NAME[t.status]}">`);
    if (t.status !== "meeting") g.push(person(x + 0.7, y - 0.25, color, t.status === "working" ? "pulse" : ""));
    g.push(box(x, y, 1.4, 0.8, 12, css("--desk-top"), css("--desk"), css("--desk")));
    const [mx, my] = iso(x + 0.5, y + 0.2, 12); g.push(`<rect x="${mx - 6}" y="${my - 11}" width="12" height="9" rx="1.5" fill="#2b3a4a"/><rect x="${mx - 5}" y="${my - 10}" width="10" height="7" fill="${t.status === "working" ? "#7fe0b0" : "#5a6b7c"}"/>`);
    g.push(`<rect class="tag" x="${lx - w / 2}" y="${ly - 11}" width="${w}" height="15" rx="7.5"/><circle cx="${lx + w / 2 - 8}" cy="${ly - 3.5}" r="3" fill="${color}"/><text class="tagt" x="${lx - 3}" y="${ly}" text-anchor="middle">${esc(t.short)}</text>`);
    if (t.openTasks) g.push(`<circle cx="${lx - w / 2 + 2}" cy="${ly - 11}" r="6" fill="${css("--important")}"/><text x="${lx - w / 2 + 2}" y="${ly - 8}" font-size="8" fill="#fff" text-anchor="middle">${t.openTasks}</text>`);
    g.push(`</g>`);
  }
  $("#floor").innerHTML = g.join("");
}

// ---------- الصفحة ----------
async function load() {
  try { const r = await api("/api/state"); if (!r.ok) return; S = r; } catch { return; }
  $("#app").hidden = false;
  $("#nPending").textContent = S.pending.length;
  $("#btnPending").classList.toggle("has", S.pending.length > 0);
  $("#clock").textContent = new Date().toLocaleDateString("ar-SA-u-nu-arab", { weekday: "long", day: "numeric", month: "long" });
  const nm = (k) => S.team.find((t) => t.key === k)?.name || k;
  $("#alerts").innerHTML = (S.replies || []).map((q) => `<div class="alert reply"><div class="grow"><div class="t">💬 رد ${esc(nm(q.emp))} على: ${esc(q.text.slice(0, 60))}</div><div class="b" style="white-space:pre-wrap;color:var(--ink)">${esc(q.result || "")}</div></div></div>`).join("")
    + ((S.replies || []).length ? '<button class="btn small" id="repliesSeen">قريتها ✓</button>' : "")
    + S.alerts.slice(0, 6).map((a) => `<div class="alert ${a.level}"><div class="grow"><div class="t">${ALERT_NAME[a.level]} · ${esc(a.title)}</div><div class="b">${esc(a.body || "")} · ${when(a.first)}</div></div><button class="btn small" data-analyze="${a.id}">حلّلها</button></div>`).join("");
  $("#teamList").innerHTML = S.team.map((t) => `<button class="row" data-emp="${t.key}"><span class="dot ${t.status}"></span><span><div class="n">${esc(t.name)}</div><div class="j">${STATUS_NAME[t.status]} · ${esc(t.job)}</div></span></button>`).join("");
  drawOffice();
}
function openSheet(html) { $("#sheetContent").innerHTML = html; $("#sheet").hidden = false; }
function closeSheet() { $("#sheet").hidden = true; }

async function openEmp(key) {
  const t = S.team.find((x) => x.key === key);
  const r = await api(`/api/log?emp=${key}`);
  const perms = S.areas.map((a) => `<div class="perm"><div class="lbl"><span>${esc(a.name)}</span>${a.big ? '<span class="note">كبير: ينتظر موافقتك دايماً</span>' : ""}</div>
    <div class="seg">${S.levels.map((l) => `<button data-perm="${a.key}" data-level="${l}" class="${t.perms[a.key] === l ? "on" : ""}">${LEVEL_NAME[l]}</button>`).join("")}</div></div>`).join("");
  const tasks = (r.tasks || []).slice(0, 5).map((k) => `<div class="req"><div class="meta">${when(k.at)} · ${k.status === "open" ? "⏳ يشتغل عليها" : "✅ خلّصها"}</div><b>${esc(k.text.slice(0, 200))}</b>${k.result ? `<pre>${esc(k.result)}</pre>` : ""}</div>`).join("");
  const log = (r.log || []).map((l) => `<div class="logline"><time>${when(l.at)}</time><span>${esc(ACT_NAME[l.act] || l.act)}</span></div>`).join("") || '<div class="empty">ما سوّى شي للحين</div>';
  openSheet(`<h2>${esc(t.name)}</h2><div class="muted">${esc(t.job)} · ${STATUS_NAME[t.status]}${t.direct ? " · يكلمك مباشرة" : " · يرفع للمدير العام"}</div>
    ${t.sessionUrl ? `<p><a href="${esc(t.sessionUrl)}" target="_blank" rel="noopener">شوف شغله لايف ↗</a></p>` : ""}
    <h3>أعطه شغلة</h3><textarea id="taskText" placeholder="${key === "ideas" ? "اكتب فكرتك…" : "وش تبيه يسوي؟"}"></textarea>
    <label class="field" style="margin-top:8px"><span class="muted">إرفاق ملف (إكسل أو غيره، حد ١ ميقا)</span><input id="taskFile" type="file"></label>
    <div class="btns"><button class="btn primary" data-send="${key}">أرسل</button></div>
    ${tasks ? `<h3>آخر المهام وردوده</h3>${tasks}` : ""}
    <h3>ربط الجلسة ${t.linked ? "✅" : "⚪️"}</h3>
    <p class="muted" style="margin:0 0 8px;font-size:13px">${t.linked ? "مربوط: المكتب يقدر يصحّيه." : "من claude.ai/code/routines: افتح مهمته، أضف API trigger، وانسخ الرقم والرمز هنا."}</p>
    <details${t.linked ? "" : " open"}><summary class="muted">${t.linked ? "غيّر الربط" : "اربط الحين"}</summary>
      <label class="field"><span>رقم المهمة (trig_…)</span><input id="rtId" dir="ltr" autocomplete="off"></label>
      <label class="field"><span>الرمز (ينحفظ مخفي وما يظهر مرة ثانية)</span><input id="rtTok" type="password" dir="ltr" autocomplete="off"></label>
      <div class="btns"><button class="btn primary" data-link="${key}">احفظ الربط</button>${t.linked ? `<button class="btn danger" data-unlink="${key}">افصل</button>` : ""}</div></details>
    <h3>بطاقة الصلاحيات</h3>${perms}
    <h3>السجل</h3>${log}`);
}
function openPending() {
  openSheet(`<h2>ينتظر موافقتك</h2>${S.pending.map((q) => `<div class="req"><div class="meta">${esc(S.team.find((t) => t.key === q.emp)?.name)} · ${esc(S.areas.find((a) => a.key === q.area)?.name)} · ${when(q.at)}${q.meeting ? ` · بعد اجتماع رقم ${q.meeting}` : ""}</div>
    <b>${esc(q.title)}</b>${q.detail ? `<pre>${esc(q.detail)}</pre>` : ""}<div class="btns"><button class="btn primary" data-yes="${q.id}">موافق</button><button class="btn danger" data-no="${q.id}">رفض</button></div></div>`).join("") || '<div class="empty">ما فيه شي ينتظرك 👌</div>'}`);
}
function openMeetings() {
  const st = { open: "شغّال الحين", agreed: "اتفقوا كلهم", no_consensus: "ما اتفقوا" };
  openSheet(`<h2>الاجتماعات</h2>${S.meetings.map((m) => `<button class="row" data-meeting="${m.id}"><span class="dot ${m.status === "open" ? "meeting" : ""}"></span><span><div class="n">${esc(m.topic)}</div><div class="j">${st[m.status] || m.status} · ${when(m.at)}</div></span></button>`).join("<div style='height:8px'></div>") || '<div class="empty">ما صار اجتماع للحين</div>'}`);
}
async function openMeeting(id) {
  const r = await api(`/api/meeting?id=${id}`);
  const nm = (k) => S.team.find((t) => t.key === k)?.name || k;
  openSheet(`<h2>${esc(r.meeting.topic)}</h2><div class="muted">${when(r.meeting.at)}</div><h3>المحضر</h3>
    ${r.lines.map((l) => `<div class="line"><b>${esc(nm(l.emp))}:</b>${esc(l.text)}</div>`).join("") || '<div class="empty">ما تكلم أحد للحين</div>'}
    ${r.meeting.decision ? `<h3>القرار</h3><p>${esc(r.meeting.decision)}</p>` : ""}`);
}
function openSettings() {
  openSheet(`<h2>الإعدادات</h2>
    <label class="field"><span>حد كاش المندوب (ر.س)</span><input id="cashLimit" type="number" inputmode="numeric" value="${S.rules.cashLimit}"></label>
    <label class="field"><span>متى يصحى المراقب لحاله؟</span><select id="wakeOn">
      <option value="urgent" ${S.rules.wakeOn === "urgent" ? "selected" : ""}>العاجل بس</option><option value="important" ${S.rules.wakeOn === "important" ? "selected" : ""}>العاجل والمهم</option><option value="none" ${S.rules.wakeOn === "none" ? "selected" : ""}>ولا شي، بس لما أضغط «حلّلها»</option></select></label>
    <label class="field"><span>أقصى عدد جلسات باليوم (عشان حد اشتراك Max)</span><input id="fireCap" type="number" inputmode="numeric" value="${S.caps.fire}"></label>
    <label class="field"><span>أقصى عدد اجتماعات باليوم</span><input id="meetingCap" type="number" inputmode="numeric" value="${S.caps.meetings}"></label>
    <div class="btns"><button class="btn primary" id="saveRules">احفظ</button><button class="btn danger" id="logout">خروج</button></div>
    <h3>تيليقرام ${S.telegram.linked ? "✅ مربوط" : "⚪️ مو مربوط"}</h3>
    <label class="field"><span>رمز البوت من BotFather ${S.telegram.bot ? "(محفوظ ✅، اتركه فاضي إذا ما تبي تغيّره)" : ""}</span><input id="cfgBot" type="password" dir="ltr" autocomplete="off"></label>
    <p class="muted" style="font-size:13px;margin-top:0">بعد ما تحفظ الرمز: أرسل أي رسالة للبوت في تيليقرام، وبعدها اضغط «اربط تيليقرام».</p>
    <h3>حساب «قارئ المكتب» في المتجر ${S.reader ? "✅" : "⚪️"}</h3>
    <label class="field"><span>الرقم السري (١٢ رقم) ${S.reader ? "(محفوظ ✅)" : ""}</span><input id="cfgPin" type="password" inputmode="numeric" dir="ltr" autocomplete="off"></label>
    <h3>نون ${S.noon.key ? "✅ مربوط" : "⚪️ مو مربوط"}</h3>
    <label class="field"><span>ملف المفتاح من نون (.json) ${S.noon.key ? "(محفوظ ✅، ارفع ملف جديد بس إذا تبي تغيّره)" : ""}</span><input id="noonFile" type="file" accept=".json,application/json"></label>
    <label class="field"><span>المنتجات اللي يراقبها في نون (رموز SKU حقتك، كل واحد بسطر) · الحين ${S.noon.skus}</span><textarea id="noonSkus" dir="ltr" placeholder="SKU-001&#10;SKU-002"></textarea></label>
    <div class="btns"><button class="btn" id="saveNoon">احفظ نون</button>${S.noon.key ? '<button class="btn" id="testNoon">جرّب الاتصال</button>' : ""}</div>
    <div class="btns"><button class="btn primary" id="saveCfg">احفظ</button>${S.telegram.bot ? `<button class="btn" id="tgSetup">${S.telegram.linked ? "أعد ربط تيليقرام" : "اربط تيليقرام"}</button>` : ""}</div>`);
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-close],[data-emp],[data-meet],[data-perm],[data-send],[data-yes],[data-no],[data-meeting],[data-analyze],[data-link],[data-unlink],#tgSetup,#saveCfg,#saveNoon,#testNoon,#repliesSeen,#btnPending,#btnMeet,#btnSet,#saveRules,#logout");
  if (!el) return;
  const d = el.dataset;
  try {
    if (d.close !== undefined) closeSheet();
    else if (d.emp) openEmp(d.emp);
    else if (d.meet || el.id === "btnMeet") openMeetings();
    else if (d.meeting) openMeeting(d.meeting);
    else if (el.id === "btnPending") openPending();
    else if (el.id === "btnSet") openSettings();
    else if (d.perm) {
      const key = $("#sheetContent [data-send]").dataset.send;
      const r = await api("/api/perm", { emp: key, area: d.perm, level: d.level });
      if (r.ok) { S.team.find((t) => t.key === key).perms = r.perms; el.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === el)); toast("تغيّرت الصلاحية"); }
    } else if (d.send) {
      const text = $("#taskText").value.trim(); if (!text) return;
      const fl = $("#taskFile") && $("#taskFile").files[0];
      let file = null;
      if (fl) {
        if (fl.size > 1024 * 1024) { toast("الملف أكبر من ١ ميقا"); return; }
        const b = new Uint8Array(await fl.arrayBuffer()); let bin = ""; for (let i = 0; i < b.length; i += 8192) bin += String.fromCharCode(...b.subarray(i, i + 8192));
        file = { name: fl.name, type: fl.type, b64: btoa(bin) };
      }
      const r = await api("/api/task", { emp: d.send, text, file });
      toast(r.woke ? "وصلت وبدأ يشتغل" : r.wakeCode === "daily_cap" ? "انحفظت، بس وصلنا سقف اليوم" : "انحفظت عنده (ما انربطت جلسته للحين)");
      closeSheet(); load();
    } else if (d.yes || d.no) {
      const r = await api("/api/decide", { id: Number(d.yes || d.no), yes: !!d.yes });
      toast(r.ok ? (d.yes ? "تمت الموافقة" : "انرفض") : "انحسم من قبل"); await load(); openPending();
    } else if (d.analyze) {
      const r = await api("/api/analyze", { id: Number(d.analyze) }); toast(r.ok ? "المراقب يحللها الحين" : "ما قدرت أصحّي المراقب");
    } else if (el.id === "saveRules") {
      await api("/api/rules", { cashLimit: Number($("#cashLimit").value), wakeOn: $("#wakeOn").value, fireCap: Number($("#fireCap").value), meetingCap: Number($("#meetingCap").value) });
      toast("انحفظت"); closeSheet(); load();
    } else if (d.link) {
      const r = await api("/api/routine", { emp: d.link, id: $("#rtId").value.trim(), token: $("#rtTok").value.trim() });
      toast(r.ok ? "انربط ✅" : "تأكد من الرقم والرمز"); if (r.ok) { await load(); openEmp(d.link); }
    } else if (d.unlink) {
      await api("/api/routine", { emp: d.unlink, clear: true }); toast("انفصل"); await load(); openEmp(d.unlink);
    } else if (el.id === "saveCfg") {
      const r = await api("/api/config", { TELEGRAM_BOT_TOKEN: $("#cfgBot").value.trim() || null, STORE_READER_PIN: $("#cfgPin").value.trim() || null });
      toast(r.ok ? "انحفظ ✅" : "ما انحفظ"); await load(); openSettings();
    } else if (el.id === "saveNoon") {
      const f = $("#noonFile").files[0], skus = $("#noonSkus").value.trim();
      if (f) {
        const r = await api("/api/noon-key", { text: await f.text() });
        toast(!r.ok ? "الملف مو ملف مفتاح نون" : r.test.ok ? "انربط نون ✅ والاتصال شغّال" : "انحفظ المفتاح، بس نون رفض الدخول (" + (r.test.status || r.test.code) + ")");
      }
      if (skus) { const r = await api("/api/noon-skus", { skus }); toast(`انحفظت ${r.n} منتج للمراقبة`); }
      await load(); openSettings();
    } else if (el.id === "repliesSeen") {
      await api("/api/replies-seen", {}); load();
    } else if (el.id === "testNoon") {
      const r = await api("/api/noon-test", {}); toast(r.ok ? "الاتصال بنون شغّال ✅" : "نون ما رد صح (" + (r.status || r.code) + ")");
    } else if (el.id === "tgSetup") {
      const r = await api("/api/tg-setup", {});
      toast(r.ok ? "انربط تيليقرام ✅ شيك على البوت" : r.code === "send_message_first" ? "أرسل رسالة للبوت أول وبعدها اضغط" : "ما انربط، جرّب مرة ثانية"); if (r.ok) { await load(); openSettings(); }
    } else if (el.id === "logout") { await api("/api/logout", {}); closeSheet(); showLogin(); }
  } catch {}
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSheet();
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".emp")) { e.preventDefault(); e.target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => S && drawOffice());
setInterval(() => { if (!document.hidden && S) load(); }, 30000);
load();
