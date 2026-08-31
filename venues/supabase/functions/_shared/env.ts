/**
 * Environment and provider selection.
 *
 * Every external service sits behind an internal interface with two
 * implementations chosen by environment variable. Both default to `stub`, so
 * the whole app runs end to end on a clean checkout with no third-party keys.
 *
 * The guard below is the important part: a stub reaching production is a full
 * authentication bypass, because the voice stub returns the verification code
 * in its response. So the function refuses to start rather than degrading
 * quietly. Failing to boot is a much better outcome than handing every venue
 * to whoever asks for it.
 */

export type Stage = "development" | "staging" | "production";
export type PaymentsProvider = "stub" | "stripe";
export type VoiceProvider = "stub" | "twilio";

function read(name: string, fallback = ""): string {
  return Deno.env.get(name)?.trim() || fallback;
}

export const stage = read("DEPLOY_STAGE", "development") as Stage;
export const isProduction = stage === "production";

export const paymentsProvider = read("PAYMENTS_PROVIDER", "stub") as PaymentsProvider;
export const voiceProvider = read("VOICE_PROVIDER", "stub") as VoiceProvider;

export function assertProvidersSafe(): void {
  if (!isProduction) return;
  const stubbed = [
    paymentsProvider === "stub" ? "PAYMENTS_PROVIDER" : null,
    voiceProvider === "stub" ? "VOICE_PROVIDER" : null,
  ].filter(Boolean);

  if (stubbed.length) {
    throw new Error(
      `Refusing to start: ${stubbed.join(" and ")} set to "stub" with DEPLOY_STAGE=production. ` +
      `The voice stub returns the verification code to the caller, so this would be an ` +
      `authentication bypass. Set the real provider or change the stage.`,
    );
  }
}

/**
 * The service role key. Read only inside Edge Functions, never sent to a
 * browser, never committed. Throwing here rather than returning an empty
 * string means a misconfigured deployment fails at boot instead of silently
 * making unauthenticated queries.
 */
export function serviceRoleKey(): string {
  const key = read("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set.");
  return key;
}

export const supabaseUrl = () => read("SUPABASE_URL");
