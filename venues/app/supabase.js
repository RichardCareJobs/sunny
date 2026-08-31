/**
 * Supabase client and session handling.
 *
 * The client is created once. `supabase-js` is loaded as a pinned UMD build in
 * index.html rather than an ES module because the published ESM bundle is not
 * self-contained (it reaches for `ws`, `buffer` and `process`), and we would
 * rather vendor one file than a dependency tree.
 *
 * Session rules, from the brief:
 *   - persist across reloads and refresh in the background
 *   - an expired session surfaces, it never fails silently
 *   - sign-out clears all local state, not just the Supabase token
 */
import config, { assertConfig } from "./config.js";

let client = null;

export function getClient() {
  if (client) return client;
  assertConfig();
  if (!window.supabase?.createClient) {
    throw new Error("supabase-js did not load. Check vendor/supabase.umd.js is served.");
  }
  client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: "sunny-venues-auth",
      flowType: "pkce",
    },
    global: {
      headers: { "x-sunny-app": "venues" },
    },
  });
  return client;
}

/** Keys this app owns in localStorage. Sign-out clears every one of them. */
const LOCAL_KEYS = ["sunny-venues-auth", "sunny-venues-selected-venue"];

export async function signOut() {
  try {
    await getClient().auth.signOut();
  } finally {
    // Runs even if the network call fails — a user who taps "Sign out" must
    // end up signed out locally regardless of what the server said.
    LOCAL_KEYS.forEach((key) => {
      try { window.localStorage.removeItem(key); } catch { /* private mode */ }
    });
  }
}

export async function getSession() {
  const { data, error } = await getClient().auth.getSession();
  if (error) return null;
  return data.session ?? null;
}

/**
 * Subscribes to auth changes and returns an unsubscribe function.
 * `onChange(session, event)` fires immediately with the current session so
 * callers never have to handle "not asked yet" separately from "signed out".
 */
export function onAuthChange(onChange) {
  const sb = getClient();
  getSession().then((session) => onChange(session, "INITIAL"));
  const { data } = sb.auth.onAuthStateChange((event, session) => onChange(session ?? null, event));
  return () => data?.subscription?.unsubscribe();
}

/**
 * Wraps a Supabase call so an expired or missing session becomes an explicit,
 * catchable condition instead of a confusing 401 body. Every data call in the
 * app should go through this.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super("Your session has expired. Sign in again to pick up where you left off.");
    this.name = "SessionExpiredError";
  }
}

export async function withSession(fn) {
  const session = await getSession();
  if (!session) throw new SessionExpiredError();
  const result = await fn(getClient(), session);
  const { error } = result ?? {};
  if (error && (error.code === "PGRST301" || error.status === 401)) {
    throw new SessionExpiredError();
  }
  return result;
}

/**
 * Calls an Edge Function with the user's JWT attached. Never pass a place_id
 * as proof of authorisation — the function re-derives membership from the JWT.
 * This helper exists so no screen hand-rolls a fetch and forgets that.
 */
export async function callFunction(name, body) {
  return withSession(async (sb) => {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) throw error;
    return data;
  });
}
