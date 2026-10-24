// Default project naming (FEAT-001): "MMDD" from today's date, with " (n)" when the name is taken.
// Observed in CapCut 9.6: «1023», «1023 (1)», «1023 (2)».

export function dateStem(date = new Date()) {
  return `${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

/** Unique name among `existing` (case-insensitive): stem, stem (1), stem (2)... */
export function uniqueName(stem, existing) {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(stem.toLowerCase())) return stem;
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} (${Date.now()})`;
}

export const defaultProjectName = (existing, date = new Date()) => uniqueName(dateStem(date), existing);

/** "Copy" naming used by Duplicate. */
export const duplicateName = (name, existing) => uniqueName(name.replace(/ \(\d+\)$/, ""), existing);
