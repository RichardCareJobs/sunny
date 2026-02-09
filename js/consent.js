(() => {
  const STORAGE_KEY = "sunny_cookie_consent";
  const STORAGE_VERSION = "1.0";
  const BANNER_ID = "sunny-consent-banner";
  const ACCEPTED = "accepted";
  const DECLINED = "declined";
  const consentState = { choice: null };
  let initDone = false;

  function ensureGtagStub() {
    window.dataLayer = window.dataLayer || [];
    if (typeof window.gtag !== "function") {
      window.gtag = function gtag() {
        window.dataLayer.push(arguments);
      };
    }
  }

  function setDefaultDenied() {
    ensureGtagStub();
    window.gtag("consent", "default", {
      ad_storage: "denied",
      analytics_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied"
    });
  }

  function readStoredConsent() {
    try {
      const raw = window.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || (parsed.choice !== ACCEPTED && parsed.choice !== DECLINED)) return null;
      if (parsed.version !== STORAGE_VERSION) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function persistChoice(choice) {
    try {
      const payload = {
        choice,
        timestamp: new Date().toISOString(),
        version: STORAGE_VERSION
      };
      window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(payload));
      return payload;
    } catch {
      return null;
    }
  }

  function updateConsent(choice) {
    ensureGtagStub();
    if (choice === ACCEPTED) {
      window.gtag("consent", "update", {
        analytics_storage: "granted",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied"
      });
      return;
    }
    window.gtag("consent", "update", {
      ad_storage: "denied",
      analytics_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied"
    });
  }

  function closeBanner() {
    const banner = document.getElementById(BANNER_ID);
    if (banner) banner.remove();
  }

  function buildBanner() {
    if (document.getElementById(BANNER_ID)) return;

    const banner = document.createElement("section");
    banner.id = BANNER_ID;
    banner.className = "consent-banner";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", "Cookie preferences");
    banner.setAttribute("aria-live", "polite");
    banner.tabIndex = -1;

    const content = document.createElement("div");
    content.className = "consent-banner__content";

    const title = document.createElement("h2");
    title.className = "consent-banner__title";
    title.textContent = "Your privacy";

    const body = document.createElement("p");
    body.className = "consent-banner__body";
    body.textContent =
      "We use cookies and similar technologies to improve the app and measure usage. You can accept or decline non-essential cookies.";

    const links = document.createElement("div");
    links.className = "consent-banner__links";

    const privacyLink = document.createElement("a");
    privacyLink.href = "https://sunnypubs.app/privacy-policy/";
    privacyLink.target = "_blank";
    privacyLink.rel = "noopener noreferrer";
    privacyLink.textContent = "Privacy policy";

    links.append(privacyLink);

    const actions = document.createElement("div");
    actions.className = "consent-banner__actions";

    const declineButton = document.createElement("button");
    declineButton.type = "button";
    declineButton.className = "consent-btn consent-btn--secondary";
    declineButton.textContent = "Decline";
    declineButton.addEventListener("click", () => applyConsent(DECLINED));

    const acceptButton = document.createElement("button");
    acceptButton.type = "button";
    acceptButton.className = "consent-btn consent-btn--primary";
    acceptButton.textContent = "Accept";
    acceptButton.addEventListener("click", () => applyConsent(ACCEPTED));

    actions.append(declineButton, acceptButton);

    content.append(title, body, links, actions);
    banner.append(content);
    document.body.append(banner);
    banner.focus();
  }

  function showConsentBanner() {
    const show = () => {
      buildBanner();
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", show, { once: true });
      return;
    }
    show();
  }

  function applyConsent(choice) {
    if (choice !== ACCEPTED && choice !== DECLINED) return;
    consentState.choice = choice;
    persistChoice(choice);
    updateConsent(choice);
    closeBanner();
  }

  function openCookieSettings() {
    showConsentBanner();
  }

  function hasAnalyticsConsent() {
    const stored = readStoredConsent();
    if (stored) consentState.choice = stored.choice;
    return consentState.choice === ACCEPTED;
  }

  function initConsent() {
    if (initDone) return;
    initDone = true;
    setDefaultDenied();
    const stored = readStoredConsent();
    if (stored) {
      consentState.choice = stored.choice;
      updateConsent(stored.choice);
    } else {
      showConsentBanner();
    }
  }

  setDefaultDenied();

  window.SunnyConsent = {
    initConsent,
    showConsentBanner,
    applyConsent,
    openCookieSettings,
    closeBanner,
    hasAnalyticsConsent
  };
})();
