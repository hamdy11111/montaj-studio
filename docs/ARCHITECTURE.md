# البنية المعمارية — Architecture

## الطبقات

```
┌──────────────────────── Renderer (Chromium, sandbox, contextIsolation, بلا Node) ────────────────────────┐
│ Presentation   src/renderer/js/pages, editor, dialogs, ui   +  css/   (DOM مباشر، بلا إطار)             │
│                player.js (Canvas + <video>/<audio> + Web Audio) · timeline.js · inspector.js · materials.js │
│ Shared Models  /core/*  (نفس ملفات src/core تُخدَم عبر app://bundle/core/)                              │
└───────────────▲──────────────────────────────────────────────────────────────────────────────────────────┘
                │ window.api.call(method, ...args)  ←  preload.cjs (contextBridge)  →  قناة IPC واحدة "api:call"
┌───────────────┴──────────────────────── Main process (Node.js) ──────────────────────────────────────────┐
│ Electron Integration  src/main: main.js (نافذة، أمان، أذونات) · ipc.js (قائمة سماح + تحقق) · protocols.js │
│ Business Logic        src/services: project, timeline (الأوامر + التراجع), media, export, analysis,        │
│                       captions, tts, backup, package, settings                                           │
│ Models (pure)         src/core: model, timelineOps, layerMath, speed, color, exportGraph, shortcuts…      │
│ Data Access (DAL)     src/db: schemas, migrations, realmClient, mappers, repositories                    │
│ Storage / Engines     Realm (data/montaj.realm) · FFmpeg/ffprobe (ffmpeg-static) · PowerShell WinRT TTS  │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Realm يعمل في العملية الرئيسية فقط.** Realm JS هو addon أصلي لـ Node، فلا يمكن تشغيله داخل صفحة sandbox. الواجهة لا ترى كائنات Realm أبدًا: `mappers.js` يحوّلها إلى كائنات JS عادية قبل عبورها IPC.
- **مصدر الحقيقة للخط الزمني هو العملية الرئيسية.** كل تعديل يمر بـ `timeline.exec(cmd, args)` في `timelineService.js`، وكل أمر ينفّذ الخطوات نفسها:
  1. أخذ لقطة من الحالة.
  2. تنفيذ العملية الصِّرفة من `core/timelineOps.js`.
  3. `validateTimeline`.
  4. حفظها في معاملة Realm واحدة.
  5. إضافتها إلى سجل التراجع.
  6. إعادة الحالة الجديدة إلى الواجهة.

  تحريك المنزلقات يُعاين محليًا (`patchLive`)، ثم يُرسَل عند الإفلات كأمر واحد بمفتاح دمج `coalesceKey` حتى يُسجَّل خطوة تراجع واحدة.
- **صيغة واحدة للمعاينة والتصدير.** `core/layerMath.js` يكتب صيغ الحركة والانتقالات والإطارات المفتاحية والصوت مرة واحدة على «جبر» مجرّد: `NUM` للأرقام في المعاينة، و`EXPR` لتعابير FFmpeg في التصدير. لذلك لا تختلف المعاينة عن الناتج. الموضع يُخزَّن كنسبة من أبعاد الإطار، فيبقى ثابتًا في أي دقة.
- **التصدير:** `core/exportGraph.js` يحوّل الخط الزمني إلى مدخلات FFmpeg ورسم مرشحات واحد (`-filter_complex_script`). النصوص والملصقات تُرسَم في الواجهة بالدالة نفسها المستخدمة في المعاينة (`editor/raster.js`) وتُرسَل كصور PNG بدقة التصدير.

## المجلدات

```
montaj-studio/
├─ package.json            سكربتات التشغيل والاختبار والبناء + إعداد electron-builder
├─ build/icon.png          أيقونة أصلية (scripts/make-icon.mjs)
├─ src/
│  ├─ main/                main.js · ipc.js · protocols.js
│  ├─ preload/preload.cjs  الجسر الوحيد إلى الواجهة
│  ├─ services/            منطق الأعمال (index.js = جذر التركيب)
│  ├─ db/                  طبقة الوصول إلى البيانات (Realm)
│  ├─ core/                نماذج ومنطق صِرف مشترك بين العمليتين
│  └─ renderer/            index.html · css/ · js/(app, state, api, i18n, ui/, pages/, dialogs/, editor/) · assets/stickers
├─ tests/unit/             db · core · services · export      (node:test)
├─ tests/e2e/              app · panels                       (Playwright + Electron)
├─ scripts/                traceability.js · traceability-map.mjs · make-icon.mjs
└─ docs/                   هذه المستندات + report/*.csv (جداول التقرير)
```

## الأمان

- `contextIsolation: true`، `sandbox: true`، `nodeIntegration: false`، `webSecurity: true`، وقائمة التطبيق معطّلة.
- **قناة واحدة `api:call`** بقائمة سماح صريحة للطرق. كل وسيط يُتحقق منه: نوعه، وصيغة المعرّف `^[A-Za-z0-9-]{8,64}$`، والقيم المسموحة، والنطاقات. يُرفض أي استدعاء لا يأتي من `app://`.
- **الأخطاء** تعود دائمًا بغلاف موحّد `{code, messageKey, details}`. الواجهة تترجم `messageKey` ولا ترى استثناءات خام.
- **CSP صارمة** للصفحة: `script-src 'self'`، ولا مصادر بعيدة. `media://` يخدم ملفات المشروع المسجّلة فقط، بمعرّفاتها لا بمساراتها، ويدعم Range، ويرسل CORS لـ `app://bundle` حتى يمكن قراءة البكسلات وتوجيه الصوت عبر Web Audio.
- **التنقل** محصور في `app://`. `window.open` مرفوض والروابط الخارجية تُفتح في المتصفح. الأذونات (الميكروفون/الشاشة/الإشعارات) لا تُمنح إلا لصفحات `app://`.
- لا توجد أي طلبات شبكة وقت التشغيل، ويتحقق اختبار e2e «offline» من ذلك.

## تدفقات رئيسية

| التدفق | المسار |
|---|---|
| استيراد | `media.import` ← ffprobe ← `MediaAsset` ← توليد المصغّرات وشكل الموجة (وproxy اختياريًا) ← حدث `media:updated` |
| تعديل | زر/اختصار/قائمة ← `ed.run(cmd)` ← `timeline.exec` ← Realm ← إعادة رسم الخط الزمني والمعاينة والخصائص |
| معاينة | `Player.render()` كل إطار: الطبقات بترتيب المسارات ← `layerState(NUM)` ← تصحيح الألوان بكسليًا ← المؤثرات ← المزج |
| تصدير | `openExport` ← رسم النصوص/الملصقات ← `export.start` ← `buildExport` ← FFmpeg مع `-progress` ← أحداث التقدم |
| نسخ احتياطي | `realm.writeCopyTo` + مجلد الوسائط + manifest ← الاستعادة تحفظ نسخة أمان وتتراجع تلقائيًا عند الفشل |
