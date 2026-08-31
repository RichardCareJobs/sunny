/**
 * Runtime configuration.
 *
 * This is a static site, so there is no build step to inline environment
 * variables. Config is set on `window.SUNNY_VENUES_CONFIG` by `config.local.js`
 * (git-ignored, for local development) or by the deployed `config.prod.js`.
 * See `.env.example` for what belongs where.
 *
 * Only values that are safe in a browser live here. The Supabase anon key is
 * one of them — it is public by design and is the same key the consumer app
 * ships. The service role key is NOT here, is not in this repo, and belongs
 * only in Supabase Edge Function secrets.
 */

const defaults = {
  supabaseUrl: "https://ivylljoqjswkuyrpevmg.supabase.co",
  supabaseAnonKey: "",
  // Where Supabase sends users back to after a magic link, email confirmation
  // or password reset. Must also be on the Supabase Auth redirect allow-list.
  siteUrl: window.location.origin,
  // Set by config.prod.js. Guards anything that must not run in production.
  stage: "development",
};

const config = Object.freeze({
  ...defaults,
  ...(window.SUNNY_VENUES_CONFIG || {}),
});

export default config;

export const isProduction = () => config.stage === "production";

/**
 * Fails loudly at boot rather than at the first request. A missing anon key
 * produces an unauthorised error deep inside a screen otherwise, which is a
 * miserable thing to debug.
 */
export function assertConfig() {
  const missing = [];
  if (!config.supabaseUrl) missing.push("supabaseUrl");
  if (!config.supabaseAnonKey) missing.push("supabaseAnonKey");
  if (missing.length) {
    throw new Error(
      `Missing config: ${missing.join(", ")}. Copy venues/config.example.js to ` +
      `venues/config.local.js and fill it in — see venues/README.md.`
    );
  }
}
