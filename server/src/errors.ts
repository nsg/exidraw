import type { ApiErrorCode } from "@exidraw/shared";
const statuses: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  csrf: 403,
  not_found: 404,
  conflict: 409,
  invalid: 400,
  too_large: 413,
  rate_limited: 429,
  renderer_unavailable: 503,
  internal: 500,
};
export class HttpError extends Error {
  readonly status: number;
  constructor(
    readonly code: ApiErrorCode,
    message: string = code,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = statuses[code];
  }
}
