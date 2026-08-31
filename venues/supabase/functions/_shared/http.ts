/**
 * Request parsing, validation and error shape for Edge Functions.
 *
 * The brief: every Edge Function validates its input and returns useful
 * errors; errors surfaced to users are in plain language, errors useful to us
 * are logged with context. That is two different audiences from one throw, so
 * `AppError` carries both.
 */
import { corsHeaders, handlePreflight } from "./cors.ts";

export class AppError extends Error {
  status: number;
  code: string;
  /** Plain language, shown to the venue operator. No jargon, no stack traces. */
  userMessage: string;
  /** Structured context for our logs. Never sent to the client. */
  context: Record<string, unknown>;

  constructor(
    code: string,
    userMessage: string,
    { status = 400, context = {}, cause = "" } = {},
  ) {
    super(cause || code);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.userMessage = userMessage;
    this.context = context;
  }
}

export const badRequest = (code: string, userMessage: string, context = {}) =>
  new AppError(code, userMessage, { status: 400, context });

export const unauthorised = () =>
  new AppError("not_signed_in", "Your session has expired. Sign in again to continue.", { status: 401 });

export const forbidden = () =>
  new AppError("not_a_member", "You do not have access to this venue.", { status: 403 });

export const rateLimited = (userMessage: string, context = {}) =>
  new AppError("rate_limited", userMessage, { status: 429, context });

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

/**
 * Wraps a handler with preflight, JSON parsing, error translation and logging.
 * An unexpected error never leaks its message to the browser — the operator
 * gets something they can act on, and we get the detail in the logs.
 */
export function handler(
  fn: (req: Request, body: Record<string, unknown>) => Promise<Response>,
) {
  return async (req: Request): Promise<Response> => {
    const preflight = handlePreflight(req);
    if (preflight) return preflight;

    if (req.method !== "POST") {
      return json(req, { error: { code: "method_not_allowed", message: "Use POST." } }, 405);
    }

    let body: Record<string, unknown> = {};
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return json(req, {
        error: { code: "bad_json", message: "We could not read that request. Please try again." },
      }, 400);
    }

    try {
      return await fn(req, body);
    } catch (err) {
      if (err instanceof AppError) {
        console.error(JSON.stringify({
          level: "warn", code: err.code, status: err.status,
          cause: err.message, context: err.context,
        }));
        return json(req, { error: { code: err.code, message: err.userMessage } }, err.status);
      }
      console.error(JSON.stringify({
        level: "error", code: "unhandled",
        cause: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }));
      return json(req, {
        error: {
          code: "unexpected",
          message: "Something went wrong at our end. Nothing was changed — please try again.",
        },
      }, 500);
    }
  };
}

/* ── Small validators. Deliberately not a schema library — the shapes are
      simple and a dependency in a Deno function is a supply-chain decision. ── */

export function requireString(
  body: Record<string, unknown>, key: string, { max = 500 } = {},
): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw badRequest("missing_field", `${key} is required.`, { key });
  }
  if (value.length > max) {
    throw badRequest("field_too_long", `${key} is too long.`, { key, length: value.length, max });
  }
  return value.trim();
}

export function optionalString(
  body: Record<string, unknown>, key: string, { max = 500 } = {},
): string | null {
  if (body[key] === undefined || body[key] === null || body[key] === "") return null;
  return requireString(body, key, { max });
}
