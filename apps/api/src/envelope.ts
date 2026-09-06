import { z } from "zod";

/**
 * The response envelope and error taxonomy — docs/10 § 2 and § 3.
 *
 * Every response goes through here, including failures, because the alternative
 * is a client that has to handle two shapes and gets the rare one wrong.
 *
 * `message` is ALWAYS user-safe: it is rendered directly in the UI. Internal
 * detail goes in `detail`, which is stripped from 5xx in production. That split
 * is the whole point — a stack trace or a SQL error in `message` is a security
 * finding, not a debugging convenience.
 */

export const ERROR_CODES = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONVERSATION_BUSY: 409,
  STATE_CONFLICT: 409,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  ENTITLEMENT_REQUIRED: 402,
  CONTENT_BLOCKED: 422,
  AI_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  detail?: string;
  retry_after?: number;
  fields?: Record<string, string>;
}

/**
 * A typed error carrying its own HTTP status. CLAUDE.md § 6: errors are typed
 * and use the envelope; never throw a bare string.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    /** Shown to the user verbatim. Write it as if it will be, because it will. */
    readonly userMessage: string,
    readonly options: { detail?: string; retryAfter?: number; fields?: Record<string, string> } = {},
  ) {
    super(`${code}: ${userMessage}`);
    this.name = "ApiError";
  }

  get status(): number {
    return ERROR_CODES[this.code];
  }
}

export function ok<T>(data: T, requestId: string): { data: T; meta: { request_id: string; version: string } } {
  return { data, meta: { request_id: requestId, version: "1" } };
}

export function fail(
  e: ApiError,
  requestId: string,
  isProduction: boolean,
): { error: ErrorBody; meta: { request_id: string } } {
  const body: ErrorBody = { code: e.code, message: e.userMessage };
  // Detail is stripped from 5xx in production. A 4xx detail describes what the
  // CALLER did wrong and is safe; a 5xx detail describes what WE did wrong.
  if (e.options.detail !== undefined && !(isProduction && e.status >= 500)) {
    body.detail = e.options.detail;
  }
  if (e.options.retryAfter !== undefined) body.retry_after = e.options.retryAfter;
  if (e.options.fields !== undefined) body.fields = e.options.fields;
  return { error: body, meta: { request_id: requestId } };
}

/**
 * Turns a Zod failure into a `fields` map.
 *
 * The messages come from the schemas, which were written to be read by a person
 * — "A memory shorter than 8 characters is not a fact." That is already a
 * user-safe sentence, which is why contracts-first pays here.
 */
export function validationError(err: z.ZodError): ApiError {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const path = issue.path.join(".") || "_";
    fields[path] ??= issue.message;
  }
  return new ApiError("VALIDATION_FAILED", "Some of that could not be accepted.", { fields });
}

/**
 * Anything thrown, as an ApiError.
 *
 * An unrecognised throw becomes INTERNAL with a GENERIC message, and the real
 * one goes to `detail` where production strips it. This function is the only
 * place an unexpected error can reach a user, so it is the only place that has
 * to be careful.
 */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof z.ZodError) return validationError(e);
  return new ApiError("INTERNAL", "Something went wrong on our side.", {
    detail: e instanceof Error ? e.message : String(e),
  });
}
