# Montaj Studio — مونتاج ستوديو

محرر فيديو مكتبي يعمل **دون اتصال بالكامل** على Windows، مبني على تحليل وظيفي لـ CapCut Desktop 9.6.0
بتقنيات **HTML5 / CSS3 / JavaScript (ES2022) / Node.js / Electron / Realm**،
بدون أي إطار واجهات (لا React ولا Vue ولا Angular).

> الاسم والأيقونات والملصقات والقوالب والإعدادات المسبقة كلها أصلية. لا يُعاد استخدام أي أصل أو اسم تجاري أو ملف تنفيذي من CapCut.

## التنزيل

المثبّت الجاهز لـ Windows 10/11 (x64) في صفحة [الإصدارات](https://github.com/hamdy11111/montaj-studio/releases). المثبّت غير موقَّع رقميًا، لذا قد يعرض Windows SmartScreen تحذيرًا عند أول تشغيل («More info» ← «Run anyway»).

**التحكم بالوكلاء (MCP) والمهارات:** يمكن لوكلاء مثل Claude Code وCodex فحص المشاريع وتحريرها وتشغيل «مهارات» مونتاج عبر بروتوكول MCP، من قناة محلية على الجهاز فقط، بصلاحيات يحددها المستخدم، مع سجل لكل عملية وتراجع كامل. الميزة معطّلة افتراضيًا، وتُفعَّل من الإعدادات › الوكلاء وMCP. التفاصيل ونتائج الاختبار الفعلية في [docs/AGENT_PLATFORM.md](docs/AGENT_PLATFORM.md).

مقارنة التطبيق بـ CapCut بالقياس الفعلي (الأداء والجودة والوظائف) في [docs/CAPCUT_COMPARISON.md](docs/CAPCUT_COMPARISON.md).

## المتطلبات

| العنصر | الإصدار المُختبَر |
|---|---|
| Windows | 10 / 11 x64 (اختُبر على Windows 11 Pro 26300) |
| Node.js | 24.21 (يكفي 20 LTS أو أحدث) |
| npm | 11.19 |
| الاتصال بالإنترنت | مطلوب **فقط** لتنزيل الحزم أثناء التثبيت وأثناء بناء المثبّت |

## التثبيت والتشغيل خطوة بخطوة

1. انسخ المستودع وادخل مجلده:
   ```bash
   git clone https://github.com/hamdy11111/montaj-studio.git
   ```
   ```bash
   cd montaj-studio
   ```
2. ثبّت الحزم:
   ```bash
   npm install
   ```
3. يحظر npm 11 سكربتات التثبيت افتراضيًا. اسمح بها لهذه الحزم فقط (Realm يجلب ملفه الأصلي، Electron يجلب ملفه التنفيذي، ffmpeg-static يجلب FFmpeg). موافقتك محفوظة في حقل `allowScripts` داخل `package.json`:
   ```bash
   npm install-scripts approve realm electron ffmpeg-static electron-builder
   ```
   ```bash
   npm rebuild
   ```
4. إن لم يُنزَّل ملف Electron التنفيذي (يظهر الخطأ «Electron failed to install correctly») شغّل:
   ```bash
   node node_modules/electron/install.js
   ```
5. عطّل قياس الاستخدام في Realm (اختياري، لكنه موصى به لتطبيق يعمل دون اتصال):
   ```bash
   export REALM_DISABLE_ANALYTICS=1
   ```
6. شغّل التطبيق:
   ```bash
   npm start
   ```
   - وضع التطوير مع أدوات المطوّر: `npm run dev`
   - فحص تشغيل سريع (يطبع `SMOKE_OK` ثم يخرج): `npx electron . --smoke-test`
   - بيانات معزولة للتجربة: اضبط المتغير `MONTAJ_USER_DATA` على مجلد فارغ قبل التشغيل.

تُحفظ البيانات في `%APPDATA%\montaj-studio\`: قاعدة Realm في `data\montaj.realm`، والذاكرة المؤقتة في `cache\`، والوسائط المولّدة في `media\`، والنسخ الاحتياطية في `backups\`، والسجلات في `logs\main.log`.

## الاختبارات

```bash
npm test
```
اختبارات الوحدات والخدمات (Realm وFFmpeg حقيقيان على وسائط مولّدة، دون شبكة): 49 اختبارًا في 4 ملفات.

```bash
npm run test:e2e
```
اختبارات الواجهة من طرف إلى طرف: Playwright يشغّل تطبيق Electron الحقيقي ويقوده كمستخدم، 20 اختبارًا في 3 ملفات، وتُحفظ لقطات الشاشة في `tests/e2e/artifacts/`.

```bash
npm run traceability
```
يولّد `docs/TRACEABILITY.md` ويفشل إن بقيت ميزة غير مصنّفة أو أشار إلى ملف غير موجود.

النتائج الفعلية لآخر تشغيل وما يحتاج اختبارًا يدويًا موثّقان في [docs/VERIFICATION.md](docs/VERIFICATION.md).

## بناء المثبّت

```bash
npm run pack
```
ينتج نسخة غير مضغوطة في `dist/win-unpacked/` (للتجربة).

```bash
npm run dist
```
ينتج مثبّت NSIS في `dist/` بالاسم «Montaj Studio Setup 1.2.1.exe»: تثبيت لكل مستخدم، مع إمكانية اختيار المجلد، واختصار على سطح المكتب، وربط ملفات `.mstudio`.

- `npmRebuild: false` مقصود: Realm 20 يأتي بملف Node-API مسبق البناء متوافق مع Electron 45، فلا حاجة إلى مُترجِم C++.
- `asarUnpack` يُخرج `realm.node` وFFmpeg وffprobe من أرشيف asar لأنها ملفات أصلية لا تُحمَّل من داخله.
- **الترخيص:** ملف FFmpeg المرفق (ffmpeg-static) مرخّص بـ GPL-3.0. عند التوزيع أرفق نص الرخصة (`node_modules/ffmpeg-static/ffmpeg.exe.LICENSE`، وهو داخل المثبّت) وعرضًا بالمصدر، أو استبدله بنسخة LGPL من الإعدادات › الأداء › برنامج FFmpeg.
- التوقيع الرقمي غير مُعدّ (لا توجد شهادة)، لذا سيعرض Windows SmartScreen تحذيرًا عند أول تشغيل.

## ميزات تعمل بمكوّنات محلية اختيارية

| الميزة | ما المطلوب |
|---|---|
| التفريغ والكابشن بتوقيت كل كلمة | النموذج المصري المدمج (`src/services/asr/models/asr-egyptian-nemo-v2.0.nemo`) ببيئة تشغيل البرنامج: `npm run setup:asr` مرة واحدة. يعمل محليًا بالكامل. اختياريًا للغات الأخرى: faster-whisper أو [whisper.cpp](https://github.com/ggerganov/whisper.cpp) من الإعدادات › المزوّدات |
| تحويل النص إلى كلام | أصوات Windows المثبّتة. صوت «Microsoft Hoda» العربي يأتي مع حزمة اللغة العربية |

الميزات التي تعتمد في المنتج الأصلي على نماذج توليدية سحابية (AI video، AI image، Extend، Lip sync، Avatars، Video translator…) **تظهر في الواجهة كغير متاحة دون اتصال ولا تُحاكى**. التفاصيل في [docs/TRACEABILITY.md](docs/TRACEABILITY.md).

## المستندات

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): الطبقات والمجلدات وتدفق البيانات والأمان.
- [docs/DATABASE.md](docs/DATABASE.md): مخطط Realm والعلاقات والترحيل والنسخ الاحتياطي.
- [docs/TRACEABILITY.md](docs/TRACEABILITY.md): مصفوفة تتبّع المتطلبات الـ148.
- [docs/VERIFICATION.md](docs/VERIFICATION.md): تقرير التحقق النهائي.
- [docs/CAPCUT_COMPARISON.md](docs/CAPCUT_COMPARISON.md): المقارنة بـ CapCut والمراحل المنفّذة بعدها.
- [docs/AGENT_PLATFORM.md](docs/AGENT_PLATFORM.md): منصة الوكلاء: المهارات، وخادم MCP، والأمان، وربط Claude Code وCodex، ونتائج الاختبار.
- [docs/AUTOMATION.md](docs/AUTOMATION.md): أتمتة المونتاج: التفريغ بتوقيت الكلمات، و«عين» الوكيل، وخطة المونتاج، والكابشن المتحرك، ونتائجها المقاسة.

## الترخيص

كود Montaj Studio مرخّص بـ [MIT](LICENSE). المثبّت يضم مكوّنات بتراخيص أخرى، أهمها FFmpeg وFFprobe بترخيص GPL v3. التفاصيل في [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Montaj Studio مشروع مستقل، غير تابع لـ CapCut أو ByteDance ولا معتمد منهما. اسم CapCut يُذكر في المستندات للمقارنة فقط.
