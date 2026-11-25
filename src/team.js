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
  { key: "manager", name: "المدير العام", job: "يكلمك، يوزّع الشغل، ويدير الاجتماعات", direct: true },
  { key: "monitor", name: "المراقب", job: "يراقب المتجر ٢٤ ساعة" },
  { key: "morning", name: "محلل الصباح", job: "تقرير يومي بالمبيعات والربح والمخزون" },
  { key: "pricing", name: "مسؤول الأسعار والعروض", job: "يقارن ملفات الإكسل ويجهز التعديلات" },
  { key: "noon", name: "مسؤول نون", job: "يتابع متجرك على نون (FBN)" },
  { key: "ideas", name: "مطوّر الأفكار", job: "بينك وبينه: يطوّر أفكارك ويضبطها", direct: true },
  { key: "assistant", name: "المساعد الشخصي", job: "أشغالك الجانبية، وإذا ما فيه شغل يرتاح", direct: true },
];

export const teamKeys = new Set(TEAM.map((t) => t.key));
export const areaOf = (k) => AREAS.find((a) => a.key === k);
export const defaultLevel = (areaKey) => (areaOf(areaKey)?.big ? "propose" : "auto");
