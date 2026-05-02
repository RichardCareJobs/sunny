(() => {
  const SESSION_KEY = "sunny_session_id";
  const SUPABASE_URL = "https://ivylljoqjswkuyrpevmg.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_EIu1IEynBaGhk38hljJ6IA_pIcp4zNz";

  let _supabase = null;
  let _sessionPromise = null;

  function getSupabase() {
    if (_supabase) return _supabase;
    if (!window.supabase?.createClient) return null;
    try { _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); } catch(e) { console.warn("[Sunny Analytics] Supabase init failed:", e?.message || e); return null; }
    return _supabase;
  }

  function getEnv() {
    if (typeof window.SUNNY_ENV === "string" && window.SUNNY_ENV) {
      return window.SUNNY_ENV;
    }
    const host = window.location.hostname || "";
    if (host.includes("localhost") || host.includes("127.0.0.1") || host.includes("staging")) {
      return "staging";
    }
    return host ? "prod" : undefined;
  }

  function generateSessionId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    // Fallback: RFC 4122 v4 UUID
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function initSessionId() {
    try {
      const existing = window.sessionStorage?.getItem(SESSION_KEY);
      if (existing) return existing;
      const next = generateSessionId();
      window.sessionStorage?.setItem(SESSION_KEY, next);
      return next;
    } catch {
      return generateSessionId();
    }
  }

  function getUtmParams() {
    try {
      const p = new URLSearchParams(window.location.search);
      return {
        utm_source: p.get("utm_source") || null,
        utm_medium: p.get("utm_medium") || null,
        utm_campaign: p.get("utm_campaign") || null,
      };
    } catch { return {}; }
  }

  function ensureSupabaseSession(sessionId) {
    try {
      // Return cached promise if session creation is in-flight or complete
      if (_sessionPromise) return _sessionPromise;

      const sb = getSupabase();
      // Supabase not loaded yet — return uncached so next call retries
      if (!sb) return Promise.resolve();

      const utm = getUtmParams();
      const consent = window.SunnyConsent?.hasAnalyticsConsent?.();

      _sessionPromise = sb.from("sessions").upsert({
        id: sessionId,
        created_at: new Date().toISOString(),
        user_agent: navigator.userAgent || null,
        referrer: document.referrer || null,
        utm_source: utm.utm_source,
        utm_medium: utm.utm_medium,
        utm_campaign: utm.utm_campaign,
        cookie_consent: typeof consent === "boolean" ? consent : null,
      }, { onConflict: "id", ignoreDuplicates: true }).then(() => {}).catch(err => { console.warn("[Sunny Analytics] session insert failed:", err?.message || err); });

      return _sessionPromise;
    } catch { return Promise.resolve(); }
  }

  function trackSupabaseEvent(eventName, params) {
    try {
      const sb = getSupabase();
      if (!sb) return;
      const sessionId = initSessionId();
      const { place_id, ...metadata } = params;
      ensureSupabaseSession(sessionId).then(() => {
        sb.from("events").insert({
          session_id: sessionId,
          event_type: eventName,
          place_id: place_id || null,
          metadata: Object.keys(metadata).length ? metadata : null,
          created_at: new Date().toISOString(),
        }).then(() => {}).catch(err => { console.warn("[Sunny Analytics] event insert failed:", err?.message || err); });
      });
    } catch { /* no-op */ }
  }

  function hasAnalyticsConsent() {
    if (window.SunnyConsent?.hasAnalyticsConsent) {
      return window.SunnyConsent.hasAnalyticsConsent();
    }
    return false;
  }

  function track(eventName, params = {}) {
    try {
      if (!eventName) return;

      // Server-side tracking — runs regardless of cookie consent
      trackSupabaseEvent(eventName, params);

      // GTM tracking — only with consent
      if (!hasAnalyticsConsent()) return;
      window.dataLayer = window.dataLayer || [];
      const payload = {
        event: eventName,
        session_id: initSessionId()
      };
      if (window.SUNNY_APP_VERSION) payload.app_version = window.SUNNY_APP_VERSION;
      const env = getEnv();
      if (env) payload.env = env;
      if (window.SUNNY_PROVIDER) payload.provider = window.SUNNY_PROVIDER;
      window.dataLayer.push({ ...payload, ...params });
    } catch { /* no-op */ }
  }

  window.SunnyAnalytics = { initSessionId, track };
  window.__sunnyTrackTest = () => track("sunny_track_test", { test: true });
})();
