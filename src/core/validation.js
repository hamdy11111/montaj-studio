// Input validation and the unified error envelope ({code, messageKey, retryable}) from the report (chapter 8-C).

export class AppError extends Error {
  /**
   * @param {"VALIDATION"|"NOT_FOUND"|"IO"|"MEDIA"|"NETWORK"|"ENTITLEMENT"|"CONFLICT"|"INTERNAL"|"PROVIDER"} code
   * @param {string} messageKey i18n key shown to the user
   * @param {object} [details]
   */
  constructor(code, messageKey, details = {}) {
    super(details.message || messageKey);
    this.name = "AppError";
    this.code = code;
    this.messageKey = messageKey;
    this.details = details;
    this.retryable = code === "IO" || code === "NETWORK";
  }
  toJSON() {
    return { code: this.code, messageKey: this.messageKey, details: this.details, retryable: this.retryable };
  }
}

const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|]/; // report: «Characters such as \:/*?<>| are not supported»

export function validateName(name, { field = "name", max = 255 } = {}) {
  if (typeof name !== "string") throw new AppError("VALIDATION", "err.nameRequired", { field });
  const v = name.trim();
  if (!v) throw new AppError("VALIDATION", "err.nameRequired", { field });
  if (v.length > max) throw new AppError("VALIDATION", "err.nameTooLong", { field, max });
  if (FORBIDDEN_NAME_CHARS.test(v)) throw new AppError("VALIDATION", "err.nameChars", { field });
  if (v.startsWith(".")) throw new AppError("VALIDATION", "err.nameDot", { field });
  return v;
}

export function validateNumber(v, { field, min = -Infinity, max = Infinity, integer = false } = {}) {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new AppError("VALIDATION", "err.number", { field });
  if (integer && !Number.isInteger(n)) throw new AppError("VALIDATION", "err.integer", { field });
  if (n < min || n > max) throw new AppError("VALIDATION", "err.range", { field, min, max });
  return n;
}

export function validateEnum(v, allowed, field) {
  if (!allowed.includes(v)) throw new AppError("VALIDATION", "err.enum", { field, allowed });
  return v;
}

export function validateColor(v, field = "color") {
  if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) throw new AppError("VALIDATION", "err.color", { field });
  return v.toUpperCase();
}

export function validateId(v, field = "id") {
  if (typeof v !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(v)) throw new AppError("VALIDATION", "err.id", { field });
  return v;
}

export function toErrorEnvelope(err) {
  if (err instanceof AppError) return err.toJSON();
  // Unexpected errors keep only their message — and whether a transaction was rolled back (skills, edit plans).
  const rb = err?.details?.rolledBack ? { rolledBack: true, failedStep: err.details.failedStep } : {};
  return { code: "INTERNAL", messageKey: "err.internal", details: { message: String(err?.message || err), ...rb }, retryable: false };
}
