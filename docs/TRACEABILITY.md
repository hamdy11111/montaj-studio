# مصفوفة تتبّع المتطلبات — Requirements Traceability Matrix

مولَّدة آليًا بالأمر `npm run traceability` من جداول التقرير (`docs/report/features.csv`) وخريطة التنفيذ (`scripts/traceability-map.mjs`). يتحقق السكربت من وجود كل ملف واختبار مذكور.

## الملخص

| الحالة | العدد |
|---|---|
| منفّذ محليًا (done) | 85 |
| بديل محلي (alt) | 20 |
| جزئي (partial) | 7 |
| يتطلب مزوّدًا خارجيًا (provider) | 22 |
| غير منطبق (na) | 9 |
| غير منفّذ (no) | 5 |
| **المجموع** | **148** |

التصنيف: **منفّذ محليًا** = يعمل دون اتصال كما في التقرير؛ **بديل محلي** = الوظيفة الأصلية سحابية/توليدية وقُدّم بديل محلي حقيقي يؤدي الغرض؛ **جزئي** = جزء من الوظيفة؛ **يتطلب مزوّدًا خارجيًا** = يظهر في الواجهة كغير متاح دون اتصال ولا يُحاكى؛ **غير منطبق** = حسابات/اشتراكات/مزامنة سحابية للمنتج الأصلي.

## المتطلبات الأصلية (من التقرير)

| المعرّف | الميزة | الشاشات | الحالة | ملفات التنفيذ | الاختبارات | ملاحظات |
|---|---|---|---|---|---|---|
| FEAT-001 | إنشاء مشروع جديد / Create project | SCREEN-001, SCREEN-021 | منفّذ محليًا | `renderer/js/pages/home.js`<br>`services/projectService.js`<br>`core/naming.js`<br>`db/repositories.js` | `db.test.js`<br>`core.test.js`<br>`app.e2e.test.mjs` |  |
| FEAT-002 | فتح مشروع موجود / Open project | SCREEN-001 | منفّذ محليًا | `renderer/js/pages/home.js`<br>`renderer/js/editor/editor.js`<br>`services/projectService.js` | `app.e2e.test.mjs` |  |
| FEAT-003 | عرض المشاريع شبكة/قائمة / Grid / List view | SCREEN-001 | منفّذ محليًا | `renderer/js/pages/home.js`<br>`renderer/js/ui/table.js` | `panels.e2e.test.mjs` |  |
| FEAT-004 | البحث في المشاريع / Project search | SCREEN-001 | منفّذ محليًا | `renderer/js/pages/home.js`<br>`db/repositories.js` | `panels.e2e.test.mjs` |  |
| FEAT-005 | قائمة سياق المشروع / Project context menu | SCREEN-001 | منفّذ محليًا | `renderer/js/pages/home.js`<br>`renderer/js/ui/menu.js` | `app.e2e.test.mjs` | Open, rename, duplicate, save as template, export package, add to space, delete. |
| FEAT-006 | سلة المهملات / Trash | SCREEN-012 | منفّذ محليًا | `renderer/js/dialogs/trash.js`<br>`db/repositories.js` | `db.test.js`<br>`app.e2e.test.mjs` | 30-day retention with days-left badge; restore; permanent delete; empty trash; purge on start-up. |
| FEAT-007 | مزامنة المشاريع / Project sync | SCREEN-001 | بديل محلي | `services/backupService.js`<br>`renderer/js/dialogs/settings.js` | `services.test.js` | Cloud project sync → local backup/restore and .mstudio packages. |
| FEAT-008 | الحفظ التلقائي / Auto save | SCREEN-021, SCREEN-047 | منفّذ محليًا | `services/timelineService.js`<br>`db/repositories.js`<br>`renderer/js/editor/editor.js` | `db.test.js`<br>`app.e2e.test.mjs` | Every command is persisted in one Realm transaction; the top bar shows the last auto-save time. |
| FEAT-009 | مكان حفظ المسودات والذاكرة المؤقتة / Draft storage & cache | SCREEN-004 | منفّذ محليًا | `services/paths.js`<br>`renderer/js/dialogs/settings.js`<br>`main/ipc.js` | `panels.e2e.test.mjs` | Draft/media/record/export folders, cache size and clearing, auto-delete policy. |
| FEAT-010 | استرداد مشروع غير محفوظ / Recover unsaved project | — | منفّذ محليًا | `services/timelineService.js` | `app.e2e.test.mjs` | By design there is no unsaved state to recover: each edit is committed immediately (verified by restart test). |
| FEAT-011 | استيراد من الجهاز / Import › From device | SCREEN-024 | منفّذ محليًا | `renderer/js/editor/materials.js`<br>`renderer/js/editor/editor.js`<br>`services/mediaService.js`<br>`main/ipc.js` | `export.test.js`<br>`app.e2e.test.mjs` | Import files and folders; 4 GB per-file limit; per-file errors. |
| FEAT-012 | استيراد من المكتبة / Import › From library | SCREEN-024 | منفّذ محليًا | `renderer/js/editor/materials.js`<br>`main/ipc.js` | `db.test.js` | Library audio/stickers/LUTs imported once and reused in any project. |
| FEAT-013 | السحب والإفلات / Drag & drop | SCREEN-021, SCREEN-024 | منفّذ محليًا | `renderer/js/editor/materials.js`<br>`renderer/js/editor/timeline.js`<br>`renderer/js/editor/editor.js`<br>`preload/preload.cjs` | يدوي | Drop files on the Media panel, the timeline or the editor (manual test: OS drag & drop cannot be scripted). |
| FEAT-014 | تسجيل الشاشة/الصوت / Record | SCREEN-024 | منفّذ محليًا | `renderer/js/editor/recorder.js`<br>`main/ipc.js`<br>`main/main.js` | يدوي | Screen (primary display + system audio) and voiceover recording. Manual test (needs real devices). |
| FEAT-015 | تنظيم لوحة الوسائط / Media bin view / sort / filter / search | SCREEN-024 | منفّذ محليًا | `renderer/js/editor/materials.js` | `panels.e2e.test.mjs` | Search, type filter, favourites, Added badge, missing-media badge. |
| FEAT-016 | المشاريع الفرعية / Subprojects | SCREEN-024 | منفّذ محليًا | `core/timelineOps.js`<br>`services/timelineService.js`<br>`services/exportService.js` | `core.test.js`<br>`export.test.js` | Subprojects = compound clips (child timelines) with pre-processing. |
| FEAT-017 | مصادر الوسائط الإضافية / Yours / Generate / Spaces / Library / Dreamina | SCREEN-024 | بديل محلي | `renderer/js/editor/materials.js`<br>`renderer/js/pages/home.js` | `panels.e2e.test.mjs` | Yours / Library are local; Generate / Spaces / Dreamina sources are cloud features (unavailable). |
| FEAT-018 | مقص الذكاء الاصطناعي / AI clipper | SCREEN-024 | بديل محلي | `renderer/js/dialogs/tools.js`<br>`services/analysisService.js` | `services.test.js` | AI clipper → local highlight finder (scene cuts + speech density). |
| FEAT-019 | إضافة إلى الخط الزمني / Add to timeline | SCREEN-024, SCREEN-043 | منفّذ محليًا | `renderer/js/editor/materials.js`<br>`renderer/js/editor/timeline.js`<br>`core/timelineOps.js` | `core.test.js`<br>`app.e2e.test.mjs` |  |
| FEAT-020 | التقسيم / Split / Split all / Split mode | SCREEN-023, SCREEN-043 | منفّذ محليًا | `core/timelineOps.js`<br>`renderer/js/editor/editor.js`<br>`renderer/js/editor/timeline.js` | `core.test.js`<br>`app.e2e.test.mjs` | Split (E), Split all (Ctrl+Shift+B), Split mode (B). |
| FEAT-021 | حذف يسار/يمين/المقطع / Delete left / right / Delete | SCREEN-023, SCREEN-043 | منفّذ محليًا | `core/timelineOps.js`<br>`renderer/js/editor/editor.js` | `core.test.js` |  |
| FEAT-022 | التراجع والإعادة / Undo / Redo / Reset | SCREEN-022, SCREEN-023 | منفّذ محليًا | `core/history.js`<br>`services/timelineService.js`<br>`renderer/js/editor/editor.js` | `core.test.js`<br>`services.test.js`<br>`app.e2e.test.mjs` | 200 steps per timeline, slider drags coalesce into one step. |
| FEAT-023 | تحديد النطاق / Range › Select by clip / Deselect | SCREEN-043, SCREEN-023 | منفّذ محليًا | `renderer/js/editor/editor.js` | يدوي | In/Out points, Select by clip (Shift+X), Deselect (Alt+X), range menu. |
| FEAT-024 | مساعدات الخط الزمني / Main track magnet / Auto snapping / Linkage / Preview axis | SCREEN-043, SCREEN-006 | منفّذ محليًا | `core/timelineOps.js`<br>`renderer/js/editor/editor.js`<br>`renderer/js/editor/timeline.js`<br>`services/settingsService.js` | `core.test.js` |  |
| FEAT-025 | العلامات / Markers | SCREEN-023, SCREEN-043 | منفّذ محليًا | `core/timelineOps.js`<br>`renderer/js/editor/timeline.js`<br>`renderer/js/editor/editor.js` | `core.test.js` | Add (M), colours (Alt+M), notes, next/previous marker. |
| FEAT-026 | تكبير الخط الزمني والتنقل / Timeline zoom & navigation | SCREEN-023, SCREEN-043 | منفّذ محليًا | `renderer/js/editor/timeline.js`<br>`renderer/js/editor/editor.js` | `app.e2e.test.mjs` | Zoom slider, Ctrl+wheel, zoom to fit (Shift+Z), frame / cut-point navigation. |
| FEAT-027 | تحرير المقطع السريع / Edit › Freeze / Reverse / Mirror / Rotate / Crop | SCREEN-043 | منفّذ محليًا | `services/timelineService.js`<br>`services/mediaService.js`<br>`renderer/js/editor/editor.js`<br>`renderer/js/editor/inspector.js` | `services.test.js` | Freeze, Reverse (≤120 s), Mirror, Rotate, Crop. |
| FEAT-028 | التجميع والمقاطع المركبة / Group / Compound clip / Multi-camera | SCREEN-043 | جزئي | `core/timelineOps.js`<br>`services/timelineService.js` | `core.test.js`<br>`export.test.js` | Group and compound clips are implemented; multi-camera editing is not. |
| FEAT-029 | نسخ/لصق السمات / Copy / Paste attributes | SCREEN-043 | منفّذ محليًا | `core/timelineOps.js`<br>`renderer/js/editor/editor.js` | `core.test.js` |  |
| FEAT-030 | أوامر المقطع الإضافية / Deactivate / Replace / Link to media / Open file location / Export selected clips / Save preset | SCREEN-043 | منفّذ محليًا | `renderer/js/editor/editor.js`<br>`renderer/js/editor/materials.js`<br>`services/mediaService.js`<br>`services/exportService.js` | `export.test.js` | Deactivate, replace, link to media (relink), open file location, export selected clips. |
| FEAT-031 | التصيير المسبق / Render › Whole timeline / In / Out / Delete rendering cache | SCREEN-043, SCREEN-007 | منفّذ محليًا | `renderer/js/editor/editor.js`<br>`renderer/js/editor/exportDialog.js`<br>`services/exportService.js`<br>`main/ipc.js` | `export.test.js` |  |
| FEAT-032 | عناصر تحكم المسار / Track header controls | SCREEN-043 | منفّذ محليًا | `renderer/js/editor/timeline.js`<br>`core/timelineOps.js` | `core.test.js` | Lock / hide / mute per track. |
| FEAT-033 | غلاف الفيديو / Cover / Edit cover | SCREEN-043, SCREEN-045 | منفّذ محليًا | `services/projectService.js`<br>`renderer/js/editor/timeline.js`<br>`renderer/js/editor/editor.js` | يدوي | Automatic cover from the first clip; Cover button sets the cover from the playhead or resets it. |
| FEAT-034 | خطوط زمنية متعددة / Multiple timelines | SCREEN-022, SCREEN-021 | منفّذ محليًا | `renderer/js/editor/editor.js`<br>`services/projectService.js` | يدوي | Create, switch, rename and delete timelines in a project. |
| FEAT-035 | قائمة السياق الكاملة للمقطع / Clip context menu | SCREEN-043 | منفّذ محليًا | `renderer/js/editor/editor.js`<br>`renderer/js/ui/menu.js` | `panels.e2e.test.mjs` |  |
| FEAT-036 | التحويل الهندسي / Transform | SCREEN-035 | منفّذ محليًا | `renderer/js/editor/inspector.js`<br>`core/layerMath.js`<br>`renderer/js/editor/player.js`<br>`core/exportGraph.js` | `core.test.js`<br>`export.test.js`<br>`app.e2e.test.mjs` | Scale (uniform / X-Y), position, rotation, flip; direct manipulation in the player. |
| FEAT-037 | الإطارات المفتاحية / Keyframes | SCREEN-035, SCREEN-023 | منفّذ محليًا | `core/layerMath.js`<br>`renderer/js/editor/inspector.js`<br>`services/timelineService.js`<br>`renderer/js/editor/timeline.js` | `core.test.js`<br>`export.test.js`<br>`panels.e2e.test.mjs` | Keyframes for x, y, scale, rotation, opacity, volume with easing. |
| FEAT-038 | المزج والشفافية / Blend | SCREEN-035 | منفّذ محليًا | `renderer/js/editor/inspector.js`<br>`renderer/js/editor/player.js`<br>`core/exportGraph.js` | `export.test.js` | Normal, screen, add, multiply, darken, lighten + opacity. |
| FEAT-039 | التثبيت / Stabilize | SCREEN-035 | منفّذ محليًا | `renderer/js/editor/inspector.js`<br>`core/exportGraph.js` | `export.test.js` | FFmpeg deshake on export (preview shows the original). |
| FEAT-040 | تحسين الجودة / Enhance quality | SCREEN-035 | بديل محلي | `services/analysisService.js`<br>`renderer/js/editor/inspector.js` | `services.test.js` | Enhance quality → local sharpen + denoise (Global edit «Make video clearer»). |
| FEAT-041 | تقليل التشويش / Reduce image noise | SCREEN-035 | منفّذ محليًا | `renderer/js/editor/inspector.js`<br>`core/exportGraph.js` | `export.test.js` |  |
| FEAT-042 | التدفق البصري / Optical flow | SCREEN-035 | غير منفّذ | — | — | Optical-flow slow motion is not implemented (possible later with FFmpeg minterpolate). |
| FEAT-043 | إزالة العناصر بالذكاء / AI remove | SCREEN-035 | يتطلب مزوّدًا خارجيًا | — | — | AI remove needs a generative model. |
| FEAT-044 | توسيع الإطار / AI expand | SCREEN-035 | يتطلب مزوّدًا خارجيًا | — | — | AI expand needs a generative model. |
| FEAT-045 | إعادة المزج بالذكاء / AI remix | SCREEN-035 | يتطلب مزوّدًا خارجيًا | — | — | AI remix needs a generative model. |
| FEAT-046 | تصحيح اتجاه النظر / Eye contact | SCREEN-035 | يتطلب مزوّدًا خارجيًا | — | — | Eye contact needs a generative model. |
| FEAT-047 | مزامنة الشفاه / Lip sync | SCREEN-035 | يتطلب مزوّدًا خارجيًا | — | — | Lip sync needs a generative model. |
| FEAT-048 | إعادة الإضاءة / Relight | SCREEN-035 | يتطلب مزوّدًا خارجيًا | — | — | Relight needs a generative model. |
| FEAT-049 | إعادة التأطير التلقائي / Auto reframe | SCREEN-035 | بديل محلي | `services/projectService.js`<br>`renderer/js/editor/inspector.js` | `services.test.js` | Auto reframe → centre crop/fill for 9:16 shorts and crop presets (no subject tracking). |
| FEAT-050 | إزالة الوميض / Remove flickers | SCREEN-035 | منفّذ محليًا | `core/presets.js`<br>`core/exportGraph.js` | `export.test.js` | Remove flickers = FFmpeg deflicker effect (export only). |
| FEAT-051 | حركة بالذكاء / AI movement | SCREEN-035 | يتطلب مزوّدًا خارجيًا | — | — | AI movement needs a generative model. |
| FEAT-052 | تتبع الكاميرا / Camera tracking | SCREEN-035 | غير منفّذ | — | — | Camera tracking is not implemented. |
| FEAT-053 | ضبابية الحركة / Motion blur | SCREEN-035 | منفّذ محليًا | `renderer/js/editor/inspector.js`<br>`core/exportGraph.js` | `export.test.js` | FFmpeg tmix on export. |
| FEAT-054 | الخلفية (Canvas) / Canvas | SCREEN-035 | منفّذ محليًا | `renderer/js/editor/inspector.js`<br>`renderer/js/editor/player.js`<br>`core/exportGraph.js`<br>`services/timelineService.js` | `export.test.js` | Canvas colour or blurred background; apply to all. |
| FEAT-055 | إزالة الخلفية / Remove BG (Auto / Custom / Chroma key) | SCREEN-035 | جزئي | `renderer/js/editor/inspector.js`<br>`renderer/js/editor/player.js`<br>`core/exportGraph.js` | `export.test.js` | Chroma key (with colour picker) implemented; automatic AI background removal is not available. |
| FEAT-056 | الأقنعة / Mask | SCREEN-035, SCREEN-039 | منفّذ محليًا | `renderer/js/editor/inspector.js`<br>`renderer/js/editor/player.js`<br>`core/exportGraph.js` | `export.test.js` | Rectangle, circle, linear masks with feather and invert. |
| FEAT-057 | التجميل / Retouch | SCREEN-035 | يتطلب مزوّدًا خارجيًا | — | — | Face retouch needs an AI model. |
| FEAT-058 | مستوى الصوت والتلاشي / Volume / Fade in / Fade out | SCREEN-036, SCREEN-023 | منفّذ محليًا | `renderer/js/editor/inspector.js`<br>`core/layerMath.js`<br>`renderer/js/editor/player.js`<br>`core/exportGraph.js` | `core.test.js`<br>`export.test.js` |  |
| FEAT-059 | توحيد الجهارة / Normalize loudness | SCREEN-036, SCREEN-005 | منفّذ محليًا | `renderer/js/editor/inspector.js`<br>`core/exportGraph.js`<br>`services/settingsService.js` | `export.test.js` | FFmpeg loudnorm to the target from Settings › Edit (export). |
| FEAT-060 | تحسين الصوت / Enhance voice | SCREEN-036 | بديل محلي | `core/presets.js`<br>`core/exportGraph.js` | `services.test.js` | Enhance voice → local EQ/compressor chain (not AI). |
| FEAT-061 | مترجم الفيديو / Video translator | SCREEN-036, SCREEN-034 | يتطلب مزوّدًا خارجيًا | — | — | Video translator needs cloud speech/translation/voice models. |
| FEAT-062 | تقليل الضوضاء / Reduce noise | SCREEN-036 | منفّذ محليًا | `core/presets.js`<br>`core/exportGraph.js` | `export.test.js` | FFmpeg afftdn. |
| FEAT-063 | عزل الصوت / Isolate voice | SCREEN-036, SCREEN-043 | بديل محلي | `core/presets.js`<br>`renderer/js/editor/inspector.js`<br>`renderer/js/editor/editor.js` | `export.test.js` | Remove/keep vocal via stereo phase/band filters (approximation, not source separation). |
| FEAT-064 | ملء القناة / Fill channel | SCREEN-036 | غير منفّذ | — | — | Fill channel is not implemented. |
| FEAT-065 | تغيير الصوت / Voice changer | SCREEN-036, SCREEN-020 | منفّذ محليًا | `core/presets.js`<br>`renderer/js/editor/inspector.js`<br>`core/exportGraph.js` | `export.test.js` | 8 voice changer presets (export). |
| FEAT-066 | استخراج الصوت / Extract audio | SCREEN-043 | منفّذ محليًا | `services/timelineService.js`<br>`renderer/js/editor/editor.js` | `services.test.js` |  |
| FEAT-067 | السرعة القياسية / Speed › Standard | SCREEN-037 | منفّذ محليًا | `core/speed.js`<br>`core/timelineOps.js`<br>`renderer/js/editor/inspector.js`<br>`core/exportGraph.js` | `core.test.js`<br>`export.test.js` | 0.1×–100×, change pitch option. |
| FEAT-068 | منحنى السرعة / Speed › Curve | SCREEN-037 | منفّذ محليًا | `core/speed.js`<br>`renderer/js/editor/inspector.js`<br>`core/exportGraph.js` | `core.test.js`<br>`export.test.js`<br>`panels.e2e.test.mjs` | Presets + draggable curve editor. |
| FEAT-069 | مؤثرات السرعة / Velocity effects | SCREEN-037 | منفّذ محليًا | `core/speed.js`<br>`services/timelineService.js`<br>`renderer/js/editor/inspector.js` | يدوي |  |
| FEAT-070 | حركات الدخول/الخروج/المركّبة / Animation In / Out / Combo | SCREEN-038 | منفّذ محليًا | `core/layerMath.js`<br>`renderer/js/editor/inspector.js`<br>`renderer/js/editor/player.js`<br>`core/exportGraph.js` | `core.test.js`<br>`export.test.js` |  |
| FEAT-071 | الضبط الأساسي للألوان / Adjust › Basic | SCREEN-039 | منفّذ محليًا | `core/color.js`<br>`renderer/js/editor/inspector.js`<br>`renderer/js/editor/player.js`<br>`core/exportGraph.js` | `core.test.js`<br>`export.test.js` |  |
| FEAT-072 | HSL / Adjust › HSL | SCREEN-039 | منفّذ محليًا | `core/color.js`<br>`renderer/js/editor/inspector.js` | `panels.e2e.test.mjs` |  |
| FEAT-073 | المنحنيات / Adjust › Curves | SCREEN-039 | منفّذ محليًا | `core/color.js`<br>`renderer/js/editor/inspector.js` | `core.test.js` |  |
| FEAT-074 | عجلات الألوان / Adjust › Color wheel | SCREEN-039 | منفّذ محليًا | `core/color.js`<br>`renderer/js/editor/inspector.js` | `panels.e2e.test.mjs` |  |
| FEAT-075 | قناع الضبط / Adjust › Mask | SCREEN-039 | منفّذ محليًا | `renderer/js/editor/inspector.js`<br>`renderer/js/editor/player.js`<br>`core/exportGraph.js` | `export.test.js` | Adjust mask = clip mask (shared with FEAT-056). |
| FEAT-076 | إضافة نص / Add text | SCREEN-026, SCREEN-041 | منفّذ محليًا | `renderer/js/editor/materials.js`<br>`renderer/js/editor/editor.js`<br>`renderer/js/editor/raster.js` | `app.e2e.test.mjs` |  |
| FEAT-077 | تنسيق النص / Text › Basic | SCREEN-041 | منفّذ محليًا | `renderer/js/editor/inspector.js`<br>`renderer/js/editor/raster.js` | `panels.e2e.test.mjs` | Font, size, style, case, colour, spacing, alignment, RTL/LTR, stroke, background, shadow, presets. |
| FEAT-078 | تأثيرات وقوالب النص / Text effects / Text template | SCREEN-026 | منفّذ محليًا | `core/presets.js`<br>`renderer/js/editor/materials.js` | يدوي | Original text style presets (no CapCut assets). |
| FEAT-079 | حركة النص / Text › Animation | SCREEN-041 | منفّذ محليًا | `core/layerMath.js`<br>`renderer/js/editor/inspector.js` | `core.test.js`<br>`export.test.js` |  |
| FEAT-080 | تتبع النص / Text › Tracking | SCREEN-041 | غير منفّذ | — | — | Text tracking (attaching text to a moving object) is not implemented. |
| FEAT-081 | تحويل النص إلى كلام / Text to speech | SCREEN-041 | بديل محلي | `services/ttsService.js`<br>`renderer/js/editor/inspector.js` | `services.test.js` | Offline Windows voices (e.g. Microsoft Hoda for Arabic) instead of cloud voices. |
| FEAT-082 | شخصيات AI للنص / Text › AI avatars | SCREEN-041 | يتطلب مزوّدًا خارجيًا | `renderer/js/editor/materials.js` | — | AI avatars need a generative service. |
| FEAT-083 | الترجمة التلقائية / Auto captions | SCREEN-030 | بديل محلي | `services/captionService.js`<br>`renderer/js/editor/editor.js` | `services.test.js` | Local whisper.cpp configured by the user; clearly reported when not configured. |
| FEAT-084 | قوالب الترجمات / Captions › Templates | SCREEN-030 | جزئي | `core/presets.js` | يدوي | Caption style presets only. |
| FEAT-085 | كلمات الأغاني التلقائية / Auto lyrics | SCREEN-030 | بديل محلي | `services/captionService.js` | يدوي | Lyrics via the same local whisper.cpp transcription. |
| FEAT-086 | إضافة ترجمات يدويًا / Add captions | SCREEN-030 | منفّذ محليًا | `renderer/js/editor/editor.js`<br>`renderer/js/editor/materials.js` | يدوي | Caption text clips (flagged as captions) on the timeline. |
| FEAT-087 | ترجمات محلية / Local captions | SCREEN-026 | منفّذ محليًا | `core/srt.js`<br>`services/captionService.js`<br>`renderer/js/editor/editor.js` | `core.test.js`<br>`services.test.js` | SRT / WebVTT import up to 3 MB. |
| FEAT-088 | تقسيم الترجمات / Split captions | — | جزئي | `core/timelineOps.js` | `core.test.js` | Caption clips split in time with Split; splitting the words of one caption is not automatic. |
| FEAT-089 | النص المكتوب للمقطع / Transcript | SCREEN-043 | غير منفّذ | — | — | Transcript-based editing is not implemented. |
| FEAT-090 | مكتبة الموسيقى والمؤثرات الصوتية / Audio library | SCREEN-025 | بديل محلي | `renderer/js/editor/materials.js`<br>`main/ipc.js` | يدوي | User-imported audio library; no licensed music is bundled. |
| FEAT-091 | الملصقات / Stickers | SCREEN-027 | منفّذ محليًا | `renderer/js/editor/materials.js`<br>`core/presets.js`<br>`renderer/js/editor/raster.js`<br>`renderer/assets/stickers/` | `panels.e2e.test.mjs` | 12 original SVG stickers + imported images. |
| FEAT-092 | المؤثرات / Effects | SCREEN-028 | منفّذ محليًا | `core/presets.js`<br>`renderer/js/editor/player.js`<br>`core/exportGraph.js` | `export.test.js`<br>`panels.e2e.test.mjs` | 17 effects as effect tracks or clip effects. |
| FEAT-093 | الانتقالات / Transitions | SCREEN-029 | منفّذ محليًا | `core/layerMath.js`<br>`renderer/js/editor/materials.js`<br>`services/timelineService.js`<br>`core/exportGraph.js` | `export.test.js`<br>`panels.e2e.test.mjs` | 11 transitions, apply to all. |
| FEAT-094 | الفلاتر / Filters | SCREEN-031 | منفّذ محليًا | `core/presets.js`<br>`core/color.js`<br>`renderer/js/editor/materials.js`<br>`renderer/js/editor/player.js`<br>`core/exportGraph.js` | `core.test.js`<br>`export.test.js`<br>`panels.e2e.test.mjs` | 15 filter looks as filter tracks or clip grade. |
| FEAT-095 | طبقات الضبط و LUT / Adjustment library & LUT | SCREEN-032 | منفّذ محليًا | `core/lut.js`<br>`renderer/js/editor/materials.js`<br>`renderer/js/editor/inspector.js`<br>`renderer/js/editor/player.js`<br>`core/exportGraph.js` | `core.test.js`<br>`export.test.js` | Adjustment layers + .cube LUTs with intensity. |
| FEAT-096 | قوالب داخل المحرر / Templates (editor) | SCREEN-033 | منفّذ محليًا | `renderer/js/editor/materials.js`<br>`services/projectService.js` | `services.test.js` |  |
| FEAT-097 | الشخصيات الرقمية / AI avatar | SCREEN-034 | يتطلب مزوّدًا خارجيًا | `renderer/js/editor/materials.js` | — | AI avatar needs a generative service. |
| FEAT-098 | EditPilot (مساعد التحرير المحادثي) / EditPilot | SCREEN-001, SCREEN-044 | بديل محلي | `core/assistant.js`<br>`renderer/js/editor/pilot.js`<br>`renderer/js/pages/home.js` | `core.test.js`<br>`panels.e2e.test.mjs` | Local rule-based planner (Arabic + English) executing undoable commands; not an LLM. |
| FEAT-099 | اقتراحات ذكية وتعديلات شاملة / Smart suggestions / Global edits | SCREEN-042 | بديل محلي | `services/analysisService.js`<br>`renderer/js/editor/inspector.js`<br>`renderer/js/editor/editor.js` | `services.test.js` | Signal analysis (loudness, luma, saturation) → suggestions and global edits. |
| FEAT-100 | فيديو بالذكاء الاصطناعي / AI video | SCREEN-001 | يتطلب مزوّدًا خارجيًا | `renderer/js/pages/home.js`<br>`renderer/js/dialogs/tools.js` | `panels.e2e.test.mjs` |  |
| FEAT-101 | صورة بالذكاء الاصطناعي / AI image | SCREEN-001 | يتطلب مزوّدًا خارجيًا | `renderer/js/pages/home.js`<br>`renderer/js/dialogs/tools.js` | `panels.e2e.test.mjs` |  |
| FEAT-102 | تمديد الفيديو / Extend video | SCREEN-001 | يتطلب مزوّدًا خارجيًا | `renderer/js/pages/home.js`<br>`renderer/js/dialogs/tools.js` | `panels.e2e.test.mjs` |  |
| FEAT-103 | Video Studio / Video Studio | SCREEN-017 | يتطلب مزوّدًا خارجيًا | `renderer/js/pages/home.js` | `panels.e2e.test.mjs` |  |
| FEAT-104 | Design Studio / Design Studio | SCREEN-017 | يتطلب مزوّدًا خارجيًا | `renderer/js/pages/home.js` | `panels.e2e.test.mjs` |  |
| FEAT-105 | صانع الإعلانات / AI ad maker | SCREEN-018 | يتطلب مزوّدًا خارجيًا | `renderer/js/pages/home.js` | `panels.e2e.test.mjs` |  |
| FEAT-106 | تحويل فيديو طويل لمقاطع قصيرة / Long video to shorts | SCREEN-019 | بديل محلي | `renderer/js/dialogs/tools.js`<br>`services/analysisService.js`<br>`services/projectService.js` | `services.test.js` |  |
| FEAT-107 | أداة تحويل النص إلى كلام / Text to speech (tool) | SCREEN-020 | بديل محلي | `renderer/js/dialogs/tools.js`<br>`services/ttsService.js` | `services.test.js` |  |
| FEAT-108 | Create with AI (Dreamina) / Create with AI | SCREEN-017 | يتطلب مزوّدًا خارجيًا | `renderer/js/pages/home.js` | — |  |
| FEAT-109 | أدوات التسويق (Pippit) / Marketing tools | SCREEN-017 | يتطلب مزوّدًا خارجيًا | `renderer/js/pages/home.js` | — |  |
| FEAT-110 | تقسيم المشاهد / Split scenes | SCREEN-043 | منفّذ محليًا | `services/analysisService.js`<br>`renderer/js/editor/pilot.js`<br>`renderer/js/editor/editor.js` | `services.test.js` |  |
| FEAT-111 | صورة إلى فيديو / Image to video | SCREEN-023 | يتطلب مزوّدًا خارجيًا | — | — | Image to video needs a generative model. |
| FEAT-112 | التنسيق بالذكاء (AI stylize) / AI stylize | SCREEN-040 | يتطلب مزوّدًا خارجيًا | — | — | AI stylize needs a generative model. |
| FEAT-113 | تصدير الفيديو / Export video | SCREEN-045 | منفّذ محليًا | `renderer/js/editor/exportDialog.js`<br>`services/exportService.js`<br>`core/exportGraph.js` | `export.test.js`<br>`app.e2e.test.mjs` | 480p–8K, bit rate presets/custom, H.264/HEVC/AV1/ProRes, MP4/MOV, 24–60 fps, hardware encoders. |
| FEAT-114 | إزالة العلامة المائية / Remove watermark | SCREEN-045 | غير منطبق | — | — | Exports carry no watermark. |
| FEAT-115 | تصدير الصوت / Export audio | SCREEN-045 | منفّذ محليًا | `renderer/js/editor/exportDialog.js`<br>`core/exportGraph.js` | `export.test.js` | FLAC / MP3 / WAV / AAC. |
| FEAT-116 | تصدير GIF / Export GIF | SCREEN-045 | منفّذ محليًا | `renderer/js/editor/exportDialog.js`<br>`core/exportGraph.js` | `export.test.js` |  |
| FEAT-117 | تصدير الترجمات / Export captions | SCREEN-045 | منفّذ محليًا | `renderer/js/editor/exportDialog.js`<br>`core/srt.js`<br>`services/exportService.js` | `export.test.js` | SRT / TXT, UTF-8. |
| FEAT-118 | فحص حقوق النشر / Check copyright | SCREEN-045 | يتطلب مزوّدًا خارجيًا | — | — | Copyright check is a cloud service. |
| FEAT-119 | تصدير إطارات ثابتة / Export still frames | SCREEN-023 | منفّذ محليًا | `renderer/js/editor/exportDialog.js`<br>`core/exportGraph.js` | `export.test.js` |  |
| FEAT-120 | مشاركة المشروع / Share project | SCREEN-046 | بديل محلي | `services/packageService.js`<br>`renderer/js/pages/home.js`<br>`renderer/js/editor/editor.js` | `services.test.js` | Share → .mstudio package (project + media) exported/imported offline. |
| FEAT-121 | سجل المشاركة / Share history / Share files | SCREEN-011 | بديل محلي | `services/packageService.js`<br>`renderer/js/pages/home.js` | `services.test.js`<br>`panels.e2e.test.mjs` | Share history: packages shared by you / with you. |
| FEAT-122 | بطاقة الحساب / Account card | SCREEN-001 | غير منطبق | — | — | No accounts in an offline app. |
| FEAT-123 | إدارة الاشتراك / Subscription management | SCREEN-002 | غير منطبق | — | — |  |
| FEAT-124 | الفوترة والأكواد والأرصدة / Billing / Redeem code / Credits | SCREEN-003 | غير منطبق | — | — |  |
| FEAT-125 | خطط الاشتراك / Plans (Free / Standard / Pro / Ultra / Teams) | SCREEN-002 | غير منطبق | — | — |  |
| FEAT-126 | إدارة المساحات / Manage spaces | SCREEN-003 | بديل محلي | `renderer/js/pages/home.js`<br>`db/repositories.js` | `db.test.js`<br>`panels.e2e.test.mjs` | Local spaces (workspaces) group projects; no shared cloud spaces. |
| FEAT-127 | حذف الحساب / Delete account | SCREEN-022 | غير منطبق | — | — |  |
| FEAT-128 | دعوة الأصدقاء / Invite friends | SCREEN-001 | غير منطبق | — | — |  |
| FEAT-129 | قائمة الإعدادات / Settings menu | SCREEN-003 | منفّذ محليًا | `renderer/js/dialogs/settings.js`<br>`services/settingsService.js` | `services.test.js`<br>`panels.e2e.test.mjs` |  |
| FEAT-130 | إعدادات التحرير / Settings › Edit | SCREEN-005 | منفّذ محليًا | `renderer/js/dialogs/settings.js`<br>`services/settingsService.js` | `app.e2e.test.mjs` |  |
| FEAT-131 | المزامنة التلقائية / Auto sync | SCREEN-004 | بديل محلي | `services/backupService.js` | `services.test.js` | Auto sync → daily automatic local backup (keeps 7). |
| FEAT-132 | إعدادات الربط / Linkage settings | SCREEN-006 | منفّذ محليًا | `renderer/js/dialogs/settings.js`<br>`core/timelineOps.js` | `core.test.js` |  |
| FEAT-133 | إعدادات الأداء / Settings › Performance | SCREEN-007 | منفّذ محليًا | `renderer/js/dialogs/settings.js`<br>`main/main.js`<br>`services/ffmpeg.js` | `panels.e2e.test.mjs` | Hardware encode/decode, GPU UI (after restart), proxies, render cache, custom FFmpeg. |
| FEAT-134 | اللغة / Language | SCREEN-008 | منفّذ محليًا | `renderer/js/i18n.js`<br>`renderer/js/dialogs/settings.js` | `core.test.js`<br>`panels.e2e.test.mjs` | Arabic (RTL, default) and English (LTR). |
| FEAT-135 | الإشعارات والتحديثات والقائمة السياقية / Notifications / Software update / Right-click menu | SCREEN-008 | منفّذ محليًا | `renderer/js/dialogs/settings.js`<br>`main/ipc.js` | يدوي | Notifications and the per-user Windows right-click menu (manual test: writes HKCU). |
| FEAT-136 | نافذة تحديث الإصدار / Version update | SCREEN-009 | غير منطبق | `renderer/js/dialogs/settings.js` | — | Offline app: updates are new installers (stated in Settings). |
| FEAT-137 | تكامل نظام التشغيل / OS integration (service, shell extension, protocol) | — | جزئي | `main/ipc.js`<br>`package.json` | يدوي | Shell menu and .mstudio file association; no background service or URL protocol. |
| FEAT-138 | تخصيص الاختصارات / Shortcuts | SCREEN-023 | منفّذ محليًا | `core/shortcuts.js`<br>`renderer/js/dialogs/shortcuts.js`<br>`renderer/js/editor/editor.js` | `core.test.js`<br>`panels.e2e.test.mjs` | 100 commands, 5 presets, recording, conflicts, reset. |
| FEAT-139 | تخطيطات الواجهة / Layouts | SCREEN-022 | منفّذ محليًا | `renderer/js/editor/editor.js` | يدوي | Default / media / attributes / vertical layouts + resizable panels. |
| FEAT-140 | المساعدة والملاحظات والإشعارات / Help / Feedback / Notifications | SCREEN-010, SCREEN-022 | جزئي | `renderer/js/editor/editor.js`<br>`renderer/js/pages/home.js`<br>`renderer/js/dialogs/about.js` | `panels.e2e.test.mjs` | Walkthrough, About and notifications; online feedback is not applicable offline. |
| FEAT-141 | السياسات والمعلومات القانونية / Trust Center / Terms / Privacy / Third-party copyright / Environment Testing | SCREEN-003, SCREEN-022 | جزئي | `renderer/js/dialogs/about.js` | يدوي | Open-source licence list in About; no online trust center. |
| FEAT-142 | تحذيرات الموارد / Low memory / disk warnings | SCREEN-047 | منفّذ محليًا | `renderer/js/editor/editor.js`<br>`services/exportService.js`<br>`main/ipc.js` | يدوي | Low memory and low disk warnings; export refuses when the disk cannot hold the estimate. |
| FEAT-143 | إشعار تعارض الاختصارات / Shortcut conflict notification | SCREEN-047 | منفّذ محليًا | `renderer/js/dialogs/shortcuts.js`<br>`core/shortcuts.js` | `core.test.js` |  |
| FEAT-144 | المكتبة الشخصية / Library | SCREEN-015 | منفّذ محليًا | `renderer/js/pages/home.js`<br>`main/ipc.js` | `panels.e2e.test.mjs` | Generated assets (export history) and reusable elements. |
| FEAT-145 | المساحات السحابية / Spaces | SCREEN-016 | بديل محلي | `renderer/js/pages/home.js` | `panels.e2e.test.mjs` | Local spaces. |
| FEAT-146 | متصفح القوالب / Templates browser | SCREEN-013, SCREEN-014 | منفّذ محليًا | `renderer/js/pages/home.js`<br>`services/projectService.js` | `services.test.js`<br>`panels.e2e.test.mjs` | Templates from your own projects with orientation / clips / duration filters and favourites. |
| FEAT-147 | مزامنة Dreamina / Dreamina sync | SCREEN-005 | غير منطبق | — | — | Dreamina sync is a cloud service. |
| FEAT-148 | العودة للرئيسية والخروج / Back to home page / Quit | SCREEN-022, SCREEN-047 | منفّذ محليًا | `renderer/js/editor/editor.js`<br>`renderer/js/app.js` | `app.e2e.test.mjs` |  |

## تحسينات مقترحة ومنفّذة (ليست من التقرير)

| التحسين | الملف | الاختبار |
|---|---|---|
| Backup & restore with safety copy and rollback | `src/services/backupService.js` | `services.test.js` |
| Offline project packages (.mstudio) as the share mechanism | `src/services/packageService.js` | `services.test.js` |
| Schema versioning and migrations with a pre-migration backup | `src/db/migrations.js` | `db.test.js` |
| Single IPC channel with an allow-list and validation of every argument | `src/main/ipc.js` | `app.e2e.test.mjs` |
| Preview and export share one formula set (no drift) | `src/core/layerMath.js` | `core.test.js` |
| Text secondary colour raised for 4.5:1 contrast | `src/renderer/css/tokens.css` | — |

## افتراضات

- Product name «Montaj Studio» and all icons/stickers/presets are original; no CapCut assets, names or binaries are reused.
- Offline-first: features that need generative AI or CapCut cloud services are shown as unavailable instead of being simulated.
- Windows 10/11 x64 is the target (Windows TTS voices, bsdtar, HKCU shell menu).
- Shortcut «Step forward/back many» uses Shift+Right / Shift+Left (the report's screenshot shows the arrows swapped).
