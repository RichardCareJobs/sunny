/**
 * health — the first Edge Function, and the one that proves the pattern.
 *
 * It exercises CORS preflight, the shared error shape, input validation and
 * the provider guard, so a broken deployment is caught here rather than in the
 * middle of the claim flow. It reveals nothing about the database and requires
 * no authentication.
 *
 *   curl -X POST "$SUPABASE_URL/functions/v1/health" \
 *        -H "Content-Type: application/json" \
 *        -d '{"echo":"hello"}'
 */
import { handler, json, optionalString } from "../_shared/http.ts";
import { stage, paymentsProvider, voiceProvider, assertProvidersSafe } from "../_shared/env.ts";

Deno.serve(handler(async (req, body) => {
  // Runs per-request rather than at module load so a misconfiguration reports
  // itself through the normal error path instead of a cold-start crash with no
  // useful message.
  assertProvidersSafe();

  const echo = optionalString(body, "echo", { max: 100 });

  return json(req, {
    ok: true,
    stage,
    providers: { payments: paymentsProvider, voice: voiceProvider },
    echo,
    time: new Date().toISOString(),
  });
}));
