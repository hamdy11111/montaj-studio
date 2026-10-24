# منصة المونتاج الوكيلية — Skills + MCP + Agentic Editing

**الحالة:** المرحلة 0 (الفحص) والمسار الأول المتكامل (المراحل 1–3 مصغّرة) — 2026-10-24.
كل بند في هذا المستند موسوم بحالته: ✅ منفّذ ومختبر، 🟡 منفّذ جزئيًا، ⏳ مخطط.

---

## 1. فحص الوضع الحالي (Phase 0 — Engineering Audit)

### 1.1 البنية الموجودة

| الطبقة | المكوّن | الحالة |
|---|---|---|
| اللغة والإطار | JavaScript ES2022، Electron 45، Node 24، دون أي إطار واجهات | موجودة وتعمل |
| التخزين | Realm 20 في العملية الرئيسية فقط (`src/db`)، مخطط مُرحَّل، نسخ احتياطي | موجودة وتعمل |
| نموذج المشروع | `core/model.js`: Project → Timeline → Tracks → Segments (فيديو، صورة، صوت، نص، ملصق، مؤثر، فلتر، تعديل، مركّب)، Keyframes، Transitions، Markers | موجودة وتعمل |
| محرك التحرير | `TimelineService.exec`: موجّه أوامر (≈45 أمرًا). كل أمر: لقطة → تعديل بدوال نقية (`core/timelineOps.js`) → تحقق → حفظ في معاملة واحدة → تاريخ تراجع | موجودة وتعمل |
| التراجع | `core/history.js`: لقطات في الذاكرة لكل خط زمني، مع دمج التعديلات المتتالية | موجودة وتعمل (في الذاكرة فقط، تُفقد عند الإغلاق) |
| المعاينة | `renderer/js/editor/player.js` على Canvas 2D، والتصحيح اللوني بكسلي على المعالج | موجودة وتحتاج تحسينًا (أبطأ من CapCut مع التصحيح الكثيف و8K) |
| التصدير | `core/exportGraph.js` + `exportService.js`: رسم FFmpeg، قص النطاق، تسلسل concat، أجزاء متوازية، مسار YUV، NVENC | موجودة وتعمل |
| الصوت | تلاشٍ، مستوى، loudnorm، إزالة ضوضاء، عزل الصوت، مغيّر صوت (مرشّحات FFmpeg) | موجودة وتعمل |
| الكابشن | استيراد SRT/VTT؛ كابشن تلقائي عبر whisper.cpp محلي يضبطه المستخدم | 🟡 يعمل فقط بعد ضبط whisper.cpp ونموذج |
| «الذكاء» الحالي | `analysisService`: كشف المشاهد والصمت والصوت واللون (FFmpeg)؛ `assistant.js` (EditPilot): محلّل أوامر بالقواعد | موجودة بشكل تجريبي (قواعد، لا نماذج) |
| الواجهة البرمجية | IPC واحد بقائمة سماح (`main/ipc.js`) للواجهة فقط | موجودة؛ **لا توجد واجهة لعملاء خارجيين** |
| Skills / Agents / MCP | — | **غير موجودة** |
| الأمان | `contextIsolation`، `sandbox`، `nodeIntegration=false`، بروتوكول `app://` | موجودة؛ **لا يوجد نموذج صلاحيات للوكلاء** |
| الاختبارات | 49 وحدة/تكامل (Realm وFFmpeg حقيقيان) + 20 من طرف إلى طرف (Playwright على Electron) | موجودة وتعمل |

### 1.2 ما يُحافَظ عليه وما يُطوَّر

- **يُحافَظ عليه كما هو:** نموذج المشروع، والأوامر النقية، والتصدير، وقاعدة البيانات، والخدمات. هي مستقرة ومختبرة، وإعادة بنائها بلا مبرر.
- **يُضاف فوقها:**
  - طبقة **Editing API** موحّدة (كتالوج عمليات مكتوبة بمخططات)؛
  - **محرك المهارات**؛
  - **خادم تحكم محلي** بصلاحيات؛
  - **خادم MCP**.
- **قيد معماري حاسم:** حالة الخط الزمني والتاريخ تعيش في ذاكرة العملية الرئيسية. لو فتح خادم MCP مستقل قاعدة البيانات نفسها لعمل على حالة قديمة، ولكتب فوق تعديلات المستخدم دون أن يعلم. **لذلك لا يملك خادم MCP محركًا ثانيًا؛ هو جسر رقيق إلى التطبيق الذي يعمل.**

### 1.3 المخاطر والتبعيات

| الخطر | المعالجة |
|---|---|
| وكيل يكتب فوق عمل المستخدم | محرك واحد، و`revision` لكل خط زمني، و`expectedRevision` اختياري، وكل تنفيذ مهارة خطوة تراجع واحدة |
| وكيل يقرأ أو يكتب ملفات خارج نطاقه | صندوق مسارات: الاستيراد من جذور مسموحة فقط، والتصدير إلى مجلد مسموح فقط |
| مهارة خارجية خبيثة | المهارة بيانات تعريفية فقط (JSON مُتحقَّق بمخطط). لا كود قابل للتنفيذ. الخطوات تستدعي عمليات من قائمة سماح. المهارات الخارجية معطّلة حتى يفعّلها المستخدم |
| حقن تعليمات من محتوى الوسائط | لا يُعامَل أي نص من الوسائط أو الكابشن أو البيانات الوصفية كتعليمات. النتائج تُعاد كبيانات منظّمة، ولا توجد أداة «نفّذ هذا النص» |
| عمليات مدمّرة | نطاق `delete` منفصل لا يُمنح افتراضيًا، وموافقة المستخدم داخل التطبيق لكل عملية |
| الاعتماد على الإنترنت | كل شيء محلي: المهارات، والتحليل، وMCP عبر stdio وأنبوب محلي |

---

## 2. البنية المستهدفة

```
External Agent (Claude Code / Codex / أي عميل MCP)
   │  MCP عبر stdio (JSON-RPC)
   ▼
montaj-mcp  (src/mcp/server.mjs — عملية Node مستقلة، بلا حالة)
   │  JSON-RPC عبر Named Pipe محلي  +  Bearer token
   ▼
Agent Control Server  (src/agent/controlServer.js — داخل عملية Electron الرئيسية)
   │  المصادقة ← الصلاحيات (scopes) ← نطاق المشاريع ← صندوق المسارات ← حدّ المعدّل ← الموافقات ← سجل التدقيق
   ▼
Editing API — كتالوج العمليات  (src/agent/operations.js)
   │                                   ▲
   ├── Skills Runtime (src/agent/skills/runtime.js) ── Skill Registry (registry.js) ── Skill Schema
   ├── Jobs (src/agent/jobs.js): مهام طويلة، تقدّم، إلغاء
   ▼
Services الحالية: TimelineService (أوامر + تاريخ) · MediaService · AnalysisService · ExportService · ProjectService
   ▼
Realm (مصدر الحقيقة)
```

**مبادئ التصميم:**
- **مسار واحد للتعديل:** الواجهة اليدوية، و«المونتير الذكي» داخل التطبيق، والوكلاء الخارجيون كلهم يستدعون الخدمات نفسها. التعديلات تظهر في الخط الزمني فورًا، وتُعدَّل يدويًا، ويُتراجَع عنها.
- **عمليات مكتوبة لا نصوص حرّة:** لكل عملية مخطط مدخلات (JSON Schema) ونطاق صلاحية ووصف.
- **غير إتلافي:** لا تُعدَّل ملفات المستخدم الأصلية أبدًا. التصدير يكتب ملفات جديدة فقط.

---

## 3. Editing API — كتالوج العمليات ✅

العملية الواحدة: `{ name, title, description, scope, input (JSON Schema), run(ctx, args) }`. الكتالوج نفسه يغذّي أدوات MCP ومحرك المهارات. الأسماء:

| النطاق (scope) | العمليات (45، مولَّدة من الكود) |
|---|---|
| `read` | `project_list`، `project_inspect`، `timeline_inspect`، `media_inspect`، `skills_list`، `skills_inspect`، `skills_validate`، `skills_build_from_text`، `job_status`، `timeline_frames`، `captions_templates`، `edit_plan_schema`، `edit_plan_validate` |
| `media` | `media_import`، `media_detect_silence`، `media_detect_scenes`، `media_loudness`، `media_frames`، `media_transcribe`، `media_analyze_speech` |
| `edit` | `project_create`، `timeline_add_clip`، `timeline_split`، `timeline_trim`، `timeline_move`، `timeline_remove_clips`، `timeline_update_clips`، `timeline_add_layer`، `timeline_set_transition`، `timeline_transition_all`، `timeline_remove_silences` (+media)، `audio_normalize`، `audio_enhance_voice`، `timeline_set_canvas`، `timeline_add_captions` (+media)، `timeline_undo`، `timeline_redo`، `timeline_add_captions_pro` (+media)، `timeline_captions_style`، `edit_plan_apply` |
| `skills.run` | `skills_execute` |
| `skills.write` | `skills_save` |
| `export` | `export_start`، `export_cancel` |
| `delete` | `project_trash` (موافقة) |
