/**
 * CORS for Supabase Edge Functions.
 *
 * Supabase adds CORS headers to its REST and Auth endpoints but NOT to Edge
 * Functions. Every function has to do this itself, which is the single most
 * common way this goes wrong. So it is one helper, applied everywhere, from
 * the first function.
 *
 * The allow-list is explicit and the origin is echoed rather than wildcarded.
 * These functions are credentialed — they read the caller's JWT — and
 * `Access-Control-Allow-Origin: *` cannot be combined with credentials anyway.
 */

const ALLOWED_ORIGINS = [
  "https://venues.sunnypubs.app",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allowed = ALLOWED_ORIGINS.includes(origin);
  return {
    // An origin we do not know gets the canonical production origin back,
    // which the browser will reject — a clear failure rather than a silent
    // wildcard that would let any site call these functions with a user's JWT.
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/**
 * Answers the preflight. Call this as the FIRST thing in every handler, before
 * any auth check — a preflight carries no Authorization header, so a function
 * that authenticates first will reject its own preflight and the browser will
 * report a CORS error that has nothing to do with CORS.
 */
export function handlePreflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}
