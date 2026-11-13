import { ERROR_STATUS, type ErrorBody, type ErrorCode } from "@plinth/shared";

/** Thrown by services; turned into a JSON error (REST) or an isError result (MCP). */
export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = ERROR_STATUS[code];
  }
  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const notFound = (what = "Artifact") => new ApiError("not_found", `${what} not found`);
export const forbidden = (message = "You do not have access to this") =>
  new ApiError("forbidden", message);
export const unauthorized = (message = "Sign in or send a valid bearer token") =>
  new ApiError("unauthorized", message);

/** True if a (possibly wrapped) database error is a UNIQUE constraint violation. */
export function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
    if (String((cur as { message?: unknown }).message ?? cur).includes("UNIQUE constraint failed"))
      return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
