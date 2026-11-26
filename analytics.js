(() => {
  const SESSION_KEY = "sunny_session_id";
  const SUPABASE_URL = "https://ivylljoqjswkuyrpevmg.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2eWxsam9xanN3a3V5cnBldm1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4OTk4NzksImV4cCI6MjA4OTQ3NTg3OX0.nyRzoYBdJeMg2CR45WRR7bDMkHSi524z_dLfASIBczs";

  let _supabase = null;
  let _sessionPromise = null;
  let _sessionReady = false;

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
    }, { onConflict: "id", ignoreDuplicates: true }).then(() => { _sessionReady = true; }).catch(err => { console.warn("[Sunny Analytics] session insert failed:", err?.message || err); });

    return _sessionPromise;
  }

  function buildEventRow(sessionId, eventName, params) {
    const { place_id, ...metadata } = params;
    return {
      session_id: sessionId,
      event_type: eventName,
      place_id: place_id || null,
      metadata: Object.keys(metadata).length ? metadata : null,
      created_at: new Date().toISOString(),
    };
  }

  function insertEventViaClient(sb, row) {
    sb.from("events").insert(row).then(() => {}).catch(err => { console.warn("[Sunny Analytics] event insert failed:", err?.message || err); });
  }

  // Same POST to the events table that supabase-js makes, but with keepalive so the
  // request survives the page being hidden or closed (e.g. a tap that opens Maps/Uber).
  // sendBeacon can't set the apikey header PostgREST needs, so fetch keepalive is used.
  function sendEventKeepalive(row) {
    if (typeof window.fetch !== "function") return false;
    try {
      window.fetch(`${SUPABASE_URL}/rest/v1/events`, {
        method: "POST",
        keepalive: true,
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(row),
      }).catch(err => { console.warn("[Sunny Analytics] keepalive event failed:", err?.message || err); });
      return true;
    } catch {
      return false;
    }
  }

  function trackSupabaseEvent(eventName, params, transport) {
    try {
      const sb = getSupabase();
      const sessionId = initSessionId();
      const row = buildEventRow(sessionId, eventName, params);
      if (transport === "beacon") {
        // events.session_id references sessions(id): send right now (still inside the
        // click handler) when the session row exists, otherwise as soon as it does.
        if (_sessionReady) {
          if (!sendEventKeepalive(row) && sb) insertEventViaClient(sb, row);
          return;
        }
        if (!sb) return;
        ensureSupabaseSession(sessionId).then(() => {
          if (!sendEventKeepalive(row)) insertEventViaClient(sb, row);
        });
        return;
      }
      if (!sb) return;
      ensureSupabaseSession(sessionId).then(() => insertEventViaClient(sb, row));
    } catch { /* no-op */ }
  }

  function hasAnalyticsConsent() {
    if (window.SunnyConsent?.hasAnalyticsConsent) {
      return window.SunnyConsent.hasAnalyticsConsent();
    }
    return false;
  }

  // options.transport: "beacon" sends the Supabase event with fetch keepalive so it
  // isn't lost when the tap opens another app.
  function track(eventName, params = {}, options = {}) {
    try {
      if (!eventName) return;

      // Server-side tracking — runs regardless of cookie consent
      trackSupabaseEvent(eventName, params, options && options.transport);

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
