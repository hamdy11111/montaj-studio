// Hand labels for cause ↔ reaction links and their measurement (plan item 9, step 2: «50 رابط متعلّمين بالإيد من
// مقالبك وتحدياتك، ونقيس الصح والغلط في الربط»): the label file's shape, a labelling page (one self-contained HTML per
// media: the raw video read in place, every reaction found with its candidate causes, buttons to confirm / correct /
// add), and precision / recall of a links document against the labels. Pure (the CLI writes the files).
//
// Label file, schema "montaj.links-labels/1":
//   { schema, media: {name, hash, path}, labeller: "user" | "claude" | …, method, note,
//     reactions: [{ id, t0, t1, kind, real: true | false, unsure: bool, noCause: bool,
//                   causes: [{t0, t1, kind, text}], note }] }
// `real: false` = the system heard a reaction that is not one; `noCause` = a real reaction whose cause is not in the
// footage (or not knowable); `unsure` rows are left out of the scores.
export const LABELS_SCHEMA = "montaj.links-labels/1";

const r3 = (x) => Math.round(x * 1000) / 1000;
const near = (a0, a1, b0, b1, tol) => Math.min(a1, b1) - Math.max(a0, b0) > -tol;
const ratio = (a, b) => (b ? r3(a / b) : null);

/** An empty label file for a links document, pre-filled with the reactions found (each still to be judged). */
export function labelTemplate(doc, { labeller = "user" } = {}) {
  return {
    schema: LABELS_SCHEMA, media: { name: doc.media?.name ?? null, hash: doc.media?.hash ?? null, path: doc.media?.path ?? null }, labeller, method: "", note: "",
    reactions: doc.reactions.map((r) => ({ id: r.id, t0: r.t0, t1: r.t1, kind: r.kind, real: null, unsure: false, noCause: false, causes: [], note: "" })),
  };
}

/** Problems with a label file (empty = valid). */
export function validateLabels(L) {
  const bad = [];
  if (!L || L.schema !== LABELS_SCHEMA) bad.push("schema");
  for (const [i, r] of (L?.reactions || []).entries()) {
    if (!(Number.isFinite(r.t0) && Number.isFinite(r.t1) && r.t1 >= r.t0)) bad.push(`reactions[${i}] times`);
    if (r.real !== null && typeof r.real !== "boolean") bad.push(`reactions[${i}].real`);
    for (const c of r.causes || []) if (!(Number.isFinite(c.t0) && Number.isFinite(c.t1) && c.t1 >= c.t0)) bad.push(`reactions[${i}] cause times`);
  }
  return bad;
}

/**
 * Precision / recall of a links document against the labels (tolS: how far apart two spans may be and still match).
 *   reactions        found vs labelled real reactions (all found / those the vision check kept)
 *   links            the best link of each found reaction: right when its cause touches a labelled cause;
 *                    precision over all best links and over the «متأكد» ones; recall over the labelled links, at rank 1
 *                    and anywhere in the candidates (top-k)
 * Returns {counts, reactions: {…}, links: {…}, rows: [per labelled reaction]}.
 */
export function evaluate(doc, labels, { tolS = 0.75, causeTolS = 1.5 } = {}) {
  const L = (labels.reactions || []).filter((r) => !r.unsure && r.real !== null);
  const real = L.filter((r) => r.real);
  const C = new Map(doc.causes.map((c) => [c.id, c]));
  const matchL = (p) => L.find((l) => near(p.t0, p.t1, l.t0, l.t1, tolS)) || null;
  // A found reaction that only touches rows the labeller could not judge is left out of every score.
  const unjudged = (p) => !matchL(p) && (labels.reactions || []).some((l) => (l.unsure || l.real === null) && near(p.t0, p.t1, l.t0, l.t1, tolS));
  const pred = doc.reactions.filter((p) => !unjudged(p)).map((p) => ({ p, l: matchL(p) }));
  const tpR = (list) => list.filter((x) => x.l?.real).length;
  const kept = pred.filter((x) => x.p.verified?.real !== false);
  const foundReal = (list) => real.filter((l) => list.some((x) => x.l === l)).length;
  const best = (p) => doc.links.find((k) => k.reaction === p.id && k.best) || null;
  const right = (link, l) => !!link && !!l?.real && !l.noCause && (l.causes || []).some((c) => { const k = C.get(link.cause); return k && near(k.t0, k.t1, c.t0, c.t1, causeTolS); });
  const bl = pred.map((x) => ({ ...x, link: best(x.p) })).filter((x) => x.link);
  const sure = bl.filter((x) => x.link.status === "sure");
  const withCause = real.filter((l) => !l.noCause && (l.causes || []).length);
  const rows = real.map((l) => {
    const ps = pred.filter((x) => x.l === l).map((x) => x.p);
    const links = doc.links.filter((k) => ps.some((p) => p.id === k.reaction));
    const b = links.filter((k) => k.best).sort((a, z) => z.confidence - a.confidence)[0] || null;
    return { label: l.id, t0: l.t0, t1: l.t1, kind: l.kind, found: ps.map((p) => p.id), noCause: !!l.noCause, best: b ? { link: b.id, cause: b.cause, status: b.status, confidence: b.confidence, right: right(b, l) } : null, inCandidates: links.some((k) => right(k, l)) };
  });
  return {
    counts: { labelled: L.length, real: real.length, notReal: L.length - real.length, withCause: withCause.length, found: doc.reactions.length, judged: pred.length, kept: kept.length },
    reactions: {
      precision: ratio(tpR(pred), pred.length), recall: ratio(foundReal(pred), real.length),
      precisionAfterCheck: ratio(tpR(kept), kept.length), recallAfterCheck: ratio(foundReal(kept), real.length),
    },
    links: {
      precision: ratio(bl.filter((x) => right(x.link, x.l)).length, bl.length), n: bl.length, nRight: bl.filter((x) => right(x.link, x.l)).length,
      precisionSure: ratio(sure.filter((x) => right(x.link, x.l)).length, sure.length), nSure: sure.length, nSureRight: sure.filter((x) => right(x.link, x.l)).length,
      recall: ratio(rows.filter((r) => !r.noCause && r.best?.right).length, withCause.length),
      recallTopK: ratio(rows.filter((r) => !r.noCause && r.inCandidates).length, withCause.length),
      recallSure: ratio(rows.filter((r) => !r.noCause && r.best?.right && r.best.status === "sure").length, withCause.length),
    },
    rows,
  };
}

/** Sum of several evaluate() results' counts → pooled scores (micro average over the files). */
export function pooled(results) {
  const n = (f) => results.reduce((s, r) => s + f(r), 0);
  return {
    files: results.length, real: n((r) => r.counts.real), withCause: n((r) => r.counts.withCause), found: n((r) => r.counts.found),
    linkPrecision: ratio(n((r) => r.links.nRight), n((r) => r.links.n)), linkPrecisionSure: ratio(n((r) => r.links.nSureRight), n((r) => r.links.nSure)), nSure: n((r) => r.links.nSure),
    linkRecall: ratio(n((r) => r.rows.filter((x) => !x.noCause && x.best?.right).length), n((r) => r.counts.withCause)),
    linkRecallTopK: ratio(n((r) => r.rows.filter((x) => !x.noCause && x.inCandidates).length), n((r) => r.counts.withCause)),
    reactionRecall: ratio(n((r) => r.rows.filter((x) => x.found.length).length), n((r) => r.counts.real)),
  };
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const KIND_AR = { laughter: "ضحك", applause: "تصفيق", cheer: "هتاف", scream: "صريخ", gasp: "شهقة", verbal: "كلمة رد فعل", sudden_silence: "سكوت مفاجئ", face_change: "تغيير في الوش", loud_spike: "علو مفاجئ", pitch_spike: "نبرة عالية", speech: "كلام", promise: "وعد/رهان", action: "حدث في الصورة", sound: "صوت مفاجئ" };

/**
 * The labelling page: the raw video (read in place through file://), every reaction with its candidate causes and
 * the system's guess, and per reaction: real or not, which cause (or mark a new one from the video's current time),
 * no clear cause, unsure. Saved in the browser as you go; "حفظ الملف" downloads the label JSON. `labels`: an existing
 * label file to continue (else a template); `fileName`: the name the saved file gets (the CLI's <name>.labels.json).
 */
export function labelPageHtml(doc, { labels = null, videoUrl = null, fileName = null } = {}) {
  const data = { fileName: fileName || `${doc.media?.name || "media"}.labels.json`, doc: { media: doc.media, profile: doc.profile, reactions: doc.reactions, causes: doc.causes, links: doc.links, moments: doc.moments || [] }, labels: labels || labelTemplate(doc), kindAr: KIND_AR };
  const src = videoUrl || (doc.media?.path ? `file:///${String(doc.media.path).replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:")}` : "");
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>تعليم الروابط — ${esc(doc.media?.name)}</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1f;--mute:#6b6b70;--line:#e3e1dc;--acc:#0b6bcb;--ok:#1a7f37;--bad:#b42318;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--card:#202023;--ink:#ececee;--mute:#a0a0a8;--line:#34343a;--acc:#5aa7ff;--ok:#5cc878;--bad:#ff7a6e;--warn:#e6b450}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,"Segoe UI",Tahoma,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
video{width:min(360px,100%);max-height:52vh;background:#000;border-radius:8px}
.tools{flex:1;min-width:240px}.tools h1{font-size:17px;margin:0 0 4px}.mute{color:var(--mute);font-size:13px}
button{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:6px;padding:3px 9px;cursor:pointer}
button.on{background:var(--acc);color:#fff;border-color:var(--acc)} button.main{background:var(--acc);color:#fff;border-color:var(--acc)}
main{padding:12px 16px;max-width:1100px;margin:0 auto}
.r{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0 0 10px}
.r h3{margin:0 0 6px;font-size:15px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.t{font-variant-numeric:tabular-nums;direction:ltr;unicode-bidi:isolate}
.c{display:flex;gap:8px;align-items:baseline;padding:3px 0;border-top:1px dashed var(--line)}
.c .txt{flex:1;min-width:0;overflow-wrap:anywhere}.sure{color:var(--ok)}.unsure{color:var(--warn)}
.row{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;align-items:center}
textarea{width:100%;box-sizing:border-box;font:inherit;font-size:13px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:6px}
.done{border-inline-start:4px solid var(--ok)}
</style></head><body>
<header><video id="v" controls preload="metadata" src="${esc(src)}"></video>
<div class="tools"><h1>تعليم روابط «السبب ↔ رد الفعل» — ${esc(doc.media?.name)}</h1>
<div class="mute">نوع المحتوى: ${esc(doc.profile?.kind === "event" ? "حدث/تحدي/مقلب (السبب ممكن يكون بعيد)" : "كلام/كوميديا")} · لكل رد فعل: هل هو حقيقي؟ وإيه سببه؟ اضغط ▶ عشان تشوف المقطع. اللي مش متأكد منه علّمه «مش متأكد».</div>
<div class="row"><span>الوقت الحالي: <b class="t" id="now">0.0</b> ث</span>
<button id="add">➕ رد فعل جديد عند الوقت ده</button><button class="main" id="save">💾 حفظ الملف</button><span class="mute" id="count"></span></div>
<div class="row mute">المعلّم: <input id="who" style="width:110px"> · ملاحظة عامة: <input id="gnote" style="flex:1;min-width:160px"></div></div></header>
<main id="list"></main>
<script>
const D=${JSON.stringify(data).replace(/</g, "\\u003c")};
const KEY="links-labels:"+(D.doc.media&&D.doc.media.hash||"x");
let L; try{L=JSON.parse(localStorage.getItem(KEY))}catch(e){} if(!L||!L.reactions)L=D.labels;
const v=document.getElementById("v"),C=new Map(D.doc.causes.map(c=>[c.id,c]));
const f=x=>(+x).toFixed(1),ar=k=>D.kindAr[k]||k;
let stopAt=null;v.addEventListener("timeupdate",()=>{document.getElementById("now").textContent=f(v.currentTime);if(stopAt!==null&&v.currentTime>=stopAt){v.pause();stopAt=null}});
function play(a,b){v.currentTime=Math.max(0,a);stopAt=b;v.play()}
function store(){try{localStorage.setItem(KEY,JSON.stringify(L))}catch(e){}const n=L.reactions.filter(r=>r.real!==null||r.unsure).length;document.getElementById("count").textContent=n+" / "+L.reactions.length+" اتعلّموا"}
document.getElementById("who").value=L.labeller||"";document.getElementById("who").oninput=e=>{L.labeller=e.target.value;store()};
document.getElementById("gnote").value=L.note||"";document.getElementById("gnote").oninput=e=>{L.note=e.target.value;store()};
document.getElementById("add").onclick=()=>{const t=v.currentTime;L.reactions.push({id:"H"+(L.reactions.length+1),t0:+(t-0.5).toFixed(2),t1:+(t+0.5).toFixed(2),kind:"laughter",real:true,unsure:false,noCause:false,causes:[],note:"added by hand"});render();store()};
document.getElementById("save").onclick=()=>{const b=new Blob([JSON.stringify(L,null,1)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=D.fileName;a.click()};
function render(){const box=document.getElementById("list");box.innerHTML="";
for(const lr of L.reactions){const pr=D.doc.reactions.find(r=>r.id===lr.id);const links=D.doc.links.filter(k=>k.reaction===lr.id).sort((a,b)=>a.rank-b.rank);
const d=document.createElement("div");d.className="r"+(lr.real!==null||lr.unsure?" done":"");
const lo=Math.min(lr.t0,...links.map(k=>C.get(k.cause).t0));
d.innerHTML='<h3><span>'+lr.id+'</span><span class="t">'+f(lr.t0)+'–'+f(lr.t1)+' ث</span><span>'+(pr?pr.kinds.map(ar).join(" + "):ar(lr.kind))+'</span>'+(pr&&pr.verified?'<span class="mute">(الفحص: '+(pr.verified.real?"رد فعل":"مش رد فعل")+' '+pr.verified.confidence+')</span>':'')+'<button data-p>▶ رد الفعل</button><button data-pa>▶ من أول المرشحين</button></h3>';
d.querySelector("[data-p]").onclick=()=>play(lr.t0-2,lr.t1+1.5);d.querySelector("[data-pa]").onclick=()=>play(Math.max(lo-1,lr.t0-30),lr.t1+1.5);
const real=document.createElement("div");real.className="row";real.innerHTML='رد فعل حقيقي؟ ';
for(const [val,txt] of [[true,"آه"],[false,"لأ"]]){const b=document.createElement("button");b.textContent=txt;if(lr.real===val)b.className="on";b.onclick=()=>{lr.real=lr.real===val?null:val;render();store()};real.appendChild(b)}
const un=document.createElement("button");un.textContent="مش متأكد";if(lr.unsure)un.className="on";un.onclick=()=>{lr.unsure=!lr.unsure;render();store()};real.appendChild(un);
const nc=document.createElement("button");nc.textContent="مفيش سبب واضح";if(lr.noCause)nc.className="on";nc.onclick=()=>{lr.noCause=!lr.noCause;render();store()};real.appendChild(nc);d.appendChild(real);
for(const k of links){const c=C.get(k.cause);const picked=lr.causes.some(x=>Math.abs(x.t0-c.t0)<0.05&&Math.abs(x.t1-c.t1)<0.05);
const row=document.createElement("div");row.className="c";row.innerHTML='<button>'+(picked?"✔ السبب":"ده السبب")+'</button><span class="t">'+f(c.t0)+'–'+f(c.t1)+'</span><span>'+ar(c.kind)+'</span><span class="txt">'+(c.text||"").replace(/</g,"&lt;")+'</span><span class="'+k.status+'">'+(k.best?"★ ":"")+k.label_ar+' '+k.confidence+'</span><button>▶</button>';
const [pick,pl]=row.querySelectorAll("button");if(picked)pick.className="on";
pick.onclick=()=>{if(picked)lr.causes=lr.causes.filter(x=>!(Math.abs(x.t0-c.t0)<0.05&&Math.abs(x.t1-c.t1)<0.05));else lr.causes.push({t0:c.t0,t1:c.t1,kind:c.kind,text:c.text||""});render();store()};
pl.onclick=()=>play(Math.min(c.t0,lr.t0)-1,Math.max(c.t1,lr.t1)+1);d.appendChild(row)}
for(const x of lr.causes.filter(x=>!links.some(k=>{const c=C.get(k.cause);return Math.abs(x.t0-c.t0)<0.05&&Math.abs(x.t1-c.t1)<0.05}))){const row=document.createElement("div");row.className="c";row.innerHTML='<button class="on">✔ السبب</button><span class="t">'+f(x.t0)+'–'+f(x.t1)+'</span><span class="txt">'+(x.text||"سبب اتعلّم بالإيد").replace(/</g,"&lt;")+'</span>';row.querySelector("button").onclick=()=>{lr.causes=lr.causes.filter(y=>y!==x);render();store()};d.appendChild(row)}
const mk=document.createElement("div");mk.className="row";mk.innerHTML='<button>بداية سبب تاني = الوقت الحالي</button><button>نهايته = الوقت الحالي</button><span class="mute">(لو السبب مش في القايمة)</span>';
const [s0,s1]=mk.querySelectorAll("button");s0.onclick=()=>{lr._c0=+v.currentTime.toFixed(2);s0.textContent="البداية: "+f(lr._c0)};s1.onclick=()=>{if(lr._c0===undefined)return;const t=+v.currentTime.toFixed(2);lr.causes.push({t0:Math.min(lr._c0,t),t1:Math.max(lr._c0,t),kind:"hand",text:""});delete lr._c0;render();store()};d.appendChild(mk);
const nt=document.createElement("textarea");nt.rows=1;nt.placeholder="ملاحظة";nt.value=lr.note||"";nt.oninput=()=>{lr.note=nt.value;store()};d.appendChild(nt);box.appendChild(d)}}
render();store();
</script></body></html>`;
}

/**
 * The results folder's front page (Arabic): per media the content profile, reactions / links / «متأكد», the check's
 * engine and calibration, the scores when labelled, and a link to its labelling page; then how to label.
 * rows: [{name, doc, eval?}], pooledScores: pooled(…) or null.
 */
export function indexHtml(rows, pooledScores = null) {
  const pc = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)} %`);
  const tr = rows.map(({ name, doc, eval: e }) => {
    const v = doc.report.verify || {};
    const cal = v.calibration ? `${pc(v.calibration.realRate)} (${v.calibration.n})` : "—";
    return `<tr><td><a href="${esc(encodeURIComponent(name))}.labels.html">${esc(name)}</a></td><td>${doc.profile.kind === "event" ? "حدث/تحدي" : "كلام"}</td><td>${doc.reactions.length}</td><td>${doc.links.filter((l) => l.best).length}</td><td>${doc.report.counts.sure}</td><td>${esc(v.engine || "—")}</td><td>${cal}</td><td>${e ? `${e.counts.real} / ${e.counts.withCause}` : "—"}</td><td>${e ? pc(e.links.precision) : "—"}</td><td>${e ? pc(e.links.precisionSure) : "—"}</td><td>${e ? pc(e.links.recall) : "—"}</td></tr>`;
  }).join("");
  const P = pooledScores;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>روابط السبب ورد الفعل</title>
<style>:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1f;--mute:#6b6b70;--line:#e3e1dc}@media (prefers-color-scheme:dark){:root{--bg:#161618;--card:#202023;--ink:#ececee;--mute:#a0a0a8;--line:#34343a}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 system-ui,"Segoe UI",Tahoma,sans-serif}main{max-width:1000px;margin:0 auto;padding:16px}
table{width:100%;border-collapse:collapse;background:var(--card);font-size:14px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:start}th{color:var(--mute);font-weight:600}
.box{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:14px 0}.mute{color:var(--mute)}a{color:inherit}</style></head><body><main>
<h1>روابط «السبب ↔ رد الفعل» وأدوار اللحظات</h1>
<p class="mute">لكل فيديو: ردود الفعل اللي اتسمعت أو اتشافت، وسبب كل واحدة، ودرجة الثقة. «متأكد» = نموذج الصورة شاف السبب ورد الفعل وأكّدهم. «مش متأكد» = الرابط موجود بس محتاج عينك.</p>
<div style="overflow-x:auto"><table><tr><th>الفيديو (صفحة التعليم)</th><th>النوع</th><th>ردود فعل</th><th>روابط</th><th>متأكد</th><th>الفحص</th><th>«آه» على الطُعم</th><th>متعلّم: حقيقي / بسبب</th><th>دقة الروابط</th><th>دقة «متأكد»</th><th>السبب الصح اتلقى</th></tr>${tr}</table></div>
${P ? `<p>المجموع على الملفات المتعلّمة: دقة الروابط ${pc(P.linkPrecision)} · دقة «متأكد» ${pc(P.linkPrecisionSure)} (من ${P.nSure}) · السبب الصح اتلقى ${pc(P.linkRecall)} (من ${P.withCause}) · السبب الصح جوه المرشحين ${pc(P.linkRecallTopK)}.</p>` : ""}
<div class="box"><b>تنبيه مهم:</b> الأرقام دي من تعليم Claude بالصورة بس (من غير صوت)، على عدد صغير جدًا من الروابط، ومش من تعليمك انت. هي بتقول الطريقة شغالة ولا لأ، مش النسبة الحقيقية. «الطُعم» = لحظات هادية مفيهاش حاجة، بنسأل عنها النموذج عشان نعرف بيقول «آه» غلط قد إيه.</div>
<div class="box"><b>إزاي تعلّم (المطلوب 50 رابط من مقالبك وتحدياتك):</b><ol>
<li>افتح صفحة التعليم بتاعة الفيديو (في Chrome أو Edge). الفيديو الخام بيتقري من مكانه، مفيش نسخ.</li>
<li>لكل رد فعل: اضغط ▶ وشوف. «رد فعل حقيقي؟» آه أو لأ. لو مش متأكد اضغط «مش متأكد».</li>
<li>اختار السبب الصح من القايمة («ده السبب»)، أو علّمه بنفسك: «بداية سبب تاني» و«نهايته» من الفيديو. لو مفيش سبب ظاهر: «مفيش سبب واضح».</li>
<li>لو فيه رد فعل النظام ماشافهوش: وقّف الفيديو عنده واضغط «➕ رد فعل جديد».</li>
<li>في الآخر «💾 حفظ الملف»، وحط الملف في فولدر <code>labels</code> جنب الصفحة. الشغل بيتحفظ في المتصفح أول بأول.</li></ol></div>
</main></body></html>`;
}
