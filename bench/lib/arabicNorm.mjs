// Egyptian Arabic spelling has no standard (human transcribers disagree ~13% on MGB-3), so speech models are compared
// on normalised text: no diacritics or tatweel, one alef, ya for alef maqsura, ha for ta marbuta, plain digits,
// lowercase Latin, no punctuation, a standalone «و» joined to its word, and the user's equivalences (يوتيوب = youtube).

const TAGS = /\[[^\]]*\]/g;

/** "a = b" lines (one per line; # comments) → [[from, to]] applied as whole-word replacements after normalising. */
export function parseEquivalences(text = "") {
  return String(text).split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter((l) => l.includes("="))
    .map((l) => l.split("=").map((x) => baseNorm(x))).filter(([a, b]) => a && b);
}

function baseNorm(s) {
  return String(s || "")
    .replace(TAGS, " ")
    .replace(/[ً-ْٰـ]/g, "")                   // diacritics, dagger alef, tatweel
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")                             // punctuation of every script
    .replace(/(^|\s)و\s+(?=\S)/g, "$1و")                           // «و انا» = «وانا»
    .replace(/\s+/g, " ").trim();
}

export function normalize(s, equivalences = []) {
  let t = ` ${baseNorm(s)} `;
  for (const [a, b] of equivalences) t = t.split(` ${a} `).join(` ${b} `);
  return t.trim().replace(/\s+/g, " ");
}

/** Edit operations between two sequences (Levenshtein): substitutions, deletions, insertions. */
export function editOps(ref, hyp) {
  const n = ref.length, m = hyp.length;
  const d = Array.from({ length: n + 1 }, (_, i) => { const r = new Uint32Array(m + 1); r[0] = i; return r; });
  for (let j = 1; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  }
  // Walk back to split the distance into S/D/I.
  let i = n, j = m, S = 0, D = 0, I = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) { if (ref[i - 1] !== hyp[j - 1]) S++; i--; j--; }
    else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { D++; i--; }
    else { I++; j--; }
  }
  return { distance: d[n][m], S, D, I, n };
}
