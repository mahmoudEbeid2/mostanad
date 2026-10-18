import AppError from "../../utils/appError.js";

/**
 * An AppError that carries a machine-readable `code` (CERTIFICATES_V2_PLAN.md
 * §12: NO_PDF_CONTENT, NO_LIVE_TEXT, VERSION_CONFLICT, CERTIFICATE_FINAL, …)
 * plus optional extra response fields. The certificates router's error
 * handler serialises it as { status, code, message, ...extra }.
 */
export class CertError extends AppError {
  constructor(code, message, statusCode = 400, extra = {}) {
    super(message, statusCode);
    this.code = code;
    this.extra = extra;
  }
}

export const notFound = (what = "Resource") => new AppError(`${what} not found`, 404);
