// Error codes used by REST responses and MCP tool errors.
export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "quota_exceeded",
  "rate_limited",
  "payload_too_large",
  "invalid_input",
  "csrf",
  "feature_disabled",
  "internal",
  "unavailable",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  quota_exceeded: 403,
  rate_limited: 429,
  payload_too_large: 413,
  invalid_input: 400,
  csrf: 403,
  feature_disabled: 403,
  internal: 500,
  unavailable: 503,
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}
