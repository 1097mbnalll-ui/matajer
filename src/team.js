// الفريق ومجالات الصلاحيات. أي تعديل هنا وثّقه في AGENTS.md

export const LEVELS = ["read", "propose", "auto"]; // يقرأ بس / يقترح وينتظر / ينفّذ لحاله

// big = يمس الأسعار أو المنتجات أو الفلوس أو البيانات: افتراضياً «يقترح وينتظر موافقتك»
export const AREAS = [
  { key: "prices", name: "الأسعار والعروض", big: true },
  { key: "products", name: "المنتجات", big: true },
  { key: "stock", name: "المخزون", big: true },
  { key: "money", name: "الفلوس والكاش", big: true },
  { key: "orders", name: "الطلبات", big: true },
  { key: "customers", name: "بيانات الزبائن", big: true },
  { key: "store_code", name: "منطق خادم المتجر", big: true },
  { key: "text", name: "نصوص وشكل الموقع", big: false },
  { key: "office", name: "إعدادات المكتب والتنبيهات", big: false },
];

// direct = يكلم المالك مباشرة بدون المدير العام
export const TEAM = [
  { key: "manager", person: "سلطان", color: "#0f6b4f", icon: "tie", chips: ["وش صار اليوم؟", "سوّوا اجتماع عن", "وزّع الشغل"], routine: "trig_01UttuofJBHvgBAnNyHDmDsG", short: "المدير", name: "المدير العام", job: "يكلمك، يوزّع الشغل، ويدير الاجتماعات", direct: true },
  { key: "monitor", person: "فهد", color: "#b0412e", icon: "eye", chips: ["فيه مشاكل الحين؟", "حلّل آخر تنبيه", "الطلبات المتأخرة"], routine: "trig_016JZXTgpVNvT6orvmDoYDU3", short: "المراقب", name: "المراقب", job: "يراقب المتجر ٢٤ ساعة" },
  { key: "morning", person: "ناصر", color: "#2f6fb5", icon: "chart", chips: ["تقرير اليوم", "مبيعات الأسبوع", "أكثر المنتجات مبيعاً"], routine: "trig_014xmJdpw4yNRnuSRkGw6tGi", short: "المحلل", name: "محلل الصباح", job: "تقرير يومي بالمبيعات والربح والمخزون" },
  { key: "pricing", person: "خالد", color: "#4a7d2a", icon: "tag", chips: ["قارن ملف الأسعار", "منتجات تحت التكلفة", "اقترح عروض"], routine: "trig_01YP6S8Bk8814U1AeEBs2H2D", short: "الأسعار", name: "مسؤول الأسعار والعروض", job: "يقارن ملفات الإكسل ويجهز التعديلات" },
  { key: "noon", person: "راكان", color: "#c46a12", icon: "box", chips: ["مبيعات اليوم في نون", "المخزون في نون", "منتجات مخفية"], routine: "trig_01HJSLHHVSuzx8tsT5ab3cbV", short: "نون", name: "مسؤول نون", job: "يتابع متجرك على نون (FBN)" },
  { key: "ideas", person: "ماجد", color: "#7b4bb0", icon: "bulb", chips: ["عندي فكرة:", "طوّر الفكرة الأخيرة", "وش أفكارك للأسبوع؟"], routine: "trig_01GvcdssFvC9ac98oBRDMwGC", short: "الأفكار", name: "مطوّر الأفكار", job: "بينك وبينه: يطوّر أفكارك ويضبطها", direct: true },
  { key: "assistant", person: "بدر", color: "#2b7f8c", icon: "clip", chips: ["عندي شغلة:", "ذكّرني بـ", "رتّب لي"], routine: "trig_017UY3QS86MHf5un7s9C4ykv", short: "المساعد", name: "المساعد الشخصي", job: "أشغالك الجانبية، وإذا ما فيه شغل يرتاح", direct: true },
];

export const teamKeys = new Set(TEAM.map((t) => t.key));
export const areaOf = (k) => AREAS.find((a) => a.key === k);
export const defaultLevel = (areaKey) => (areaOf(areaKey)?.big ? "propose" : "auto");
