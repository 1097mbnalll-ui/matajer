// يدمج ملفات public/ داخل الخادم (src/assets.js) عشان النشر ما يحتاج رفع ملفات منفصل
// شغّله بعد أي تعديل على الواجهة: node scripts/build-assets.mjs
import { readFile, writeFile, readdir } from "node:fs/promises";
const dir = new URL("../public/", import.meta.url);
const types = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8" };
const out = {};
for (const f of (await readdir(dir)).sort()) {
  const ext = f.split(".").pop();
  if (!types[ext]) continue;
  out["/" + f] = { type: types[ext], body: await readFile(new URL(f, dir), "utf8") };
}
out["/"] = out["/index.html"];
await writeFile(new URL("../src/assets.js", import.meta.url), "// ملف مولّد من public/ بـ scripts/build-assets.mjs — لا تعدّله يدوياً\nexport default " + JSON.stringify(out) + ";\n");
console.log("assets:", Object.keys(out).join(" "));
