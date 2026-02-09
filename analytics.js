(() => {
  const SESSION_KEY = "sunny_session_id";

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
    const rand = () => Math.random().toString(36).slice(2, 10);
    return `${Date.now().toString(36)}-${rand()}-${rand()}`;
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

  function hasAnalyticsConsent() {
    if (window.SunnyConsent?.hasAnalyticsConsent) {
      return window.SunnyConsent.hasAnalyticsConsent();
    }
    return false;
  }

  function track(eventName, params = {}) {
    try {
      if (!eventName) return;
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
    } catch {
      // no-op
    }
  }

  window.SunnyAnalytics = { initSessionId, track };
  window.__sunnyTrackTest = () => track("sunny_track_test", { test: true });
})();
