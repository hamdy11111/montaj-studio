# قاعدة البيانات — Realm

## التحقق من Realm JavaScript SDK

| البند | النتيجة (موثّقة ومختبرة) |
|---|---|
| الحزمة | `realm@20.2.0` (آخر إصدار على npm، 2025-08-11)، الترخيص Apache-2.0 |
| حالة الصيانة | أعلنت MongoDB إيقاف Atlas Device Sync وSDKs (نهاية الدعم 30 سبتمبر 2025). **قاعدة البيانات المحلية مفتوحة المصدر وتعمل**، لكن لن تصلها تحديثات جديدة غالبًا. هذا خطر صيانة مستقبلي وليس عائقًا حاليًا |
| التوافق | Node 24.21 وElectron 45.0.0 (العملية الرئيسية)، عبر ملف Node-API v10 مسبق البناء، دون مُترجِم |
| المتصفح | **لا يعمل داخل صفحة sandbox**، لذلك يعمل حصريًا في العملية الرئيسية وتصل إليه الواجهة عبر IPC |
| إيقاف العملية | يجب استدعاء `Realm.shutdown()` عند الخروج وإلا تبقى العملية حيّة (`closeDatabase({shutdown:true})`) |
| القياس | يُعطَّل بـ `REALM_DISABLE_ANALYTICS=1` |

لم يُستبدل Realm بقاعدة أخرى. إن احتجت مستقبلًا للاستبدال، فطبقة `src/db/repositories.js` هي الحد الوحيد الذي يلزم تغييره، لأن بقية التطبيق لا ترى إلا كائنات JS عادية.

## المخطط (SCHEMA_VERSION = 2)

```
Project ──timelines[]──▶ Timeline ──tracks[]──▶ Track ──segments[]──▶ Segment ──media──▶ MediaAsset
   │  └─media[]─────────────────────────────────────────────────────────────────────────▲      │ derivedFrom
   │                                  Segment.compoundTimeline ──▶ Timeline (مقطع مركّب) │      ▼
   ◀──projects[] (backlink)── Workspace                                                 └─ MediaAsset
LibraryItem · ExportRecord(project) · ShareRecord(project) · Setting(key) · ShortcutPreset(id, bindings:string{})
```

| الكائن | المفتاح | الحقول الأساسية |
|---|---|---|
| Project | `_id` | name, status (active/trashed), isTemplate, createdAt, updatedAt, lastOpenedAt, trashedAt, durationUs, sizeBytes, realEditSeconds, coverPath, mainTimelineId, tags[], timelines[], media[], template (TemplateInfo) |
| Timeline | `_id` | name, order, fps, isCompound, canvas (CanvasSpec), markers (Marker[]), tracks[] |
| Track | `_id` | type, order, isMain, name, locked, hidden, muted, segments[] |
| Segment | `_id` | kind, name, start/duration/sourceStart/sourceDuration (µs), speed, speedMode, curvePreset, curvePoints[], volumeDb, fades, disabled, groupId, colorTag, audioDetached, transform, crop, adjust, videoFx, audioFx, animIn/Out/Combo, transitionOut, clipEffects[], keyframes[], text, effect/filter/sticker, media, compoundTimeline |
| MediaAsset | `_id` | name, path (مفهرس), type, durationUs, width, height, fps, hasAudio/hasVideo, codecs, sampleRate, channels, sizeBytes, status, thumbPath/Count, waveformPath, proxyPath, favorite, origin, importedAt, derivedFrom |
| Workspace | `_id` | name, color, quotaBytes, projects[] |
| LibraryItem | `_id` | kind (audio/sticker/lut/element), category, name, path, favorite, durationUs, sizeBytes, meta (JSON) |
| ExportRecord / ShareRecord | `_id` | project, path, kind/direction, status, progress, settings (JSON), sizeBytes, error |
| Setting | `key` | value (JSON لكل قسم: draft/edit/performance/general/providers/export/ui) |
| ShortcutPreset | `id` 1..5 | bindings: قاموس `commandId → chord` |

الكائنات المضمَّنة (embedded): Transform, Crop, Adjust (HslChannel×8, CurveChannel×4, WheelRange×4), VideoFx, AudioFx, AnimSpec, ClipEffect, Keyframe, Marker, TextStyle, CanvasSpec, TemplateInfo.

## القواعد

- **التحقق قبل الحفظ:**
  - الأسماء: لا تقبل `\/:*?"<>|`، ولا نقطة في البداية، وبحد أقصى 255 حرفًا.
  - الأرقام: ضمن نطاقاتها.
  - الألوان: بصيغة `#RRGGBB`.
  - الخط الزمني: `validateTimeline` يمنع التداخل على مسار واحد والمدد الصفرية ونوع مقطع غير مقبول في مساره.
- **المعاملات:** كل كتابة تمر عبر `write(realm, fn)`. `saveState` يحفظ الخط الزمني كاملًا في معاملة واحدة (upsert بـ `UpdateMode.Modified`)، ويحذف المسارات والمقاطع المزالة، ويمسح كائنات Segment اليتيمة (`track.@count == 0`).
- **الحذف:**
  - سلة المهملات تحتفظ بالمشروع 30 يومًا، ثم يُحذف عند بدء التشغيل (`purgeExpired`).
  - الحذف النهائي يحذف الخطوط الزمنية والمسارات والمقاطع، والوسائط التي لا يستخدمها مشروع آخر.
  - لا يُحذف من الملفات إلا ما أنشأه التطبيق (TTS، التسجيل، العكس، التجميد، الذاكرة المؤقتة)، أما الملفات المستوردة فتبقى في مكانها.
- **معالجة الأخطاء:** فشل فتح القاعدة يعرض `err.dbOpen`. قاعدة أنشأها إصدار أحدث تعرض `err.dbNewerVersion`، ولا تُفتح حتى لا تفسد.

## الترحيل (Migrations)

- `src/db/migrations.js` يحتوي خطوة لكل إصدار. v1→v2 تملأ `Project.lastOpenedAt` من `updatedAt`، وتضيف `Segment.colorTag` و`Segment.audioDetached`.
- قبل أي ترحيل يُنسخ الملف إلى `montaj.realm.pre-v2.bak`.
- لإضافة إصدار جديد:
  1. ارفع `SCHEMA_VERSION`.
  2. عدّل المخطط.
  3. أضف خطوة في `MIGRATIONS`.
  4. أضف اختبارًا كما في `tests/unit/db.test.js` («migration v1 → v2»).

## النسخ الاحتياطي والاستعادة

- **النسخ:** يُنشأ مجلد `MontajBackup-<stamp>` يحتوي:
  - `data.realm`، وهو لقطة متّسقة ومضغوطة عبر `writeCopyTo`.
  - `media/`، وفيه الوسائط التي أنشأها التطبيق.
  - `manifest.json`، وفيه إصدار التطبيق والمخطط والأعداد.
- **الاستعادة:**
  1. التحقق من manifest وإصدار المخطط.
  2. إغلاق القاعدة.
  3. حفظ نسخة أمان `data.before-restore-<stamp>.realm`.
  4. الاستبدال، ثم إعادة الفتح، مع ترحيل تلقائي للنسخ الأقدم.

  عند أي فشل تُعاد النسخة السابقة تلقائيًا.
- **النسخ التلقائي:** نسخة يومية تُبقي آخر 7 نسخ، من الإعدادات › المسودة. هذا بديل محلي لميزة «Auto sync».
- **حزم المشاركة:** ملف `.mstudio` بصيغة zip عبر bsdtar الخاص بـ Windows، يحتوي `project.json` والوسائط. عند الاستيراد تُعاد كتابة كل المعرّفات.
