(() => {
  const FIRST_VISIT_KEY    = 'sunny_first_visited';
  const VISIT_COUNT_KEY    = 'sunny_visit_count';
  const LAST_SHOWN_KEY     = 'sunny_share_prompt_last_visit';
  const NEVER_SHOW_KEY     = 'sunny_share_prompt_never';
  const SESSION_INIT_KEY   = 'sunny_share_session'; // sessionStorage — prevents double-counting on refresh
  const VISITS_BETWEEN     = 3;
  const DELAY_MS           = 20000;
  const SHARE_URL          = 'https://visit.sunnypubs.app/';
  const SHARE_TITLE        = 'Sunny — Find great outdoor pubs';
  const SHARE_TEXT         = 'Find the best outdoor pubs near you with Sunny — free, fast, and built for pub lovers. 🌞';

  // ── Visit tracking ──────────────────────────────────────────────────────────

  function recordVisit() {
    try {
      if (sessionStorage.getItem(SESSION_INIT_KEY)) return; // already counted this tab/session
      sessionStorage.setItem(SESSION_INIT_KEY, '1');
      const first = localStorage.getItem(FIRST_VISIT_KEY);
      if (!first) {
        localStorage.setItem(FIRST_VISIT_KEY, String(Date.now()));
        localStorage.setItem(VISIT_COUNT_KEY, '1');
      } else {
        const n = parseInt(localStorage.getItem(VISIT_COUNT_KEY) || '1', 10);
        localStorage.setItem(VISIT_COUNT_KEY, String(n + 1));
      }
    } catch {}
  }

  function getVisitCount() {
    try { return Math.max(1, parseInt(localStorage.getItem(VISIT_COUNT_KEY) || '1', 10)); }
    catch { return 1; }
  }

  // ── Display eligibility ──────────────────────────────────────────────────────

  function shouldShowPrompt() {
    try {
      if (!localStorage.getItem(FIRST_VISIT_KEY)) return false; // no record yet
      if (getVisitCount() < 2) return false;                    // first-timer
      if (localStorage.getItem(NEVER_SHOW_KEY)) return false;   // opted out
      const last = parseInt(localStorage.getItem(LAST_SHOWN_KEY) || '0', 10);
      return (getVisitCount() - last) >= VISITS_BETWEEN;
    } catch { return false; }
  }

  function markShown() {
    try { localStorage.setItem(LAST_SHOWN_KEY, String(getVisitCount())); } catch {}
  }

  function markNeverShow() {
    try { localStorage.setItem(NEVER_SHOW_KEY, '1'); } catch {}
  }

  // ── Analytics ────────────────────────────────────────────────────────────────

  function track(event) {
    try { window.SunnyAnalytics?.track(event); } catch {}
  }

  // ── Share action ─────────────────────────────────────────────────────────────

  function doShare(shareBtn) {
    if (navigator.share) {
      navigator.share({ title: SHARE_TITLE, text: SHARE_TEXT, url: SHARE_URL }).catch(() => {});
      return;
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(SHARE_URL).then(() => {
        const orig = shareBtn.textContent;
        shareBtn.textContent = 'Link copied!';
        setTimeout(() => { shareBtn.textContent = orig; }, 2000);
      }).catch(() => {});
    }
  }

  // ── Prompt UI ────────────────────────────────────────────────────────────────

  function showSharePrompt() {
    markShown();
    track('share_prompt_shown');

    const wrapper = document.createElement('div');
    wrapper.className = 'share-prompt';
    wrapper.setAttribute('role', 'dialog');
    wrapper.setAttribute('aria-modal', 'true');
    wrapper.setAttribute('aria-labelledby', 'share-prompt-title');
    wrapper.innerHTML = `
      <div class="share-prompt__backdrop" data-action="close"></div>
      <div class="share-prompt__card" tabindex="-1">
        <p class="share-prompt__eyebrow">Enjoying Sunny?</p>
        <h2 class="share-prompt__title" id="share-prompt-title">Share it with a mate</h2>
        <div class="share-prompt__preview">
          <img class="share-prompt__preview-img" src="/og-image-1200x630.png" alt="" role="presentation">
          <div class="share-prompt__preview-fallback">
            <span class="share-prompt__preview-sun">☀️</span>
            <span class="share-prompt__preview-fallback-label">Sunny</span>
          </div>
          <div class="share-prompt__preview-meta">
            <span class="share-prompt__preview-domain">visit.sunnypubs.app</span>
            <span class="share-prompt__preview-name">Sunny — Find great outdoor pubs</span>
            <span class="share-prompt__preview-desc">Find pubs nearby, spot the best outdoor vibes, and build a pub crawl in a couple of taps.</span>
          </div>
        </div>
        <div class="share-prompt__actions">
          <button type="button" class="share-prompt__btn share-prompt__btn--primary" data-action="share">Share Sunny</button>
          <button type="button" class="share-prompt__btn share-prompt__btn--secondary" data-action="close">Maybe later</button>
        </div>
        <button type="button" class="share-prompt__never" data-action="never">Don't show again</button>
      </div>
    `;

    // Fallback if OG image fails to load
    const img = wrapper.querySelector('.share-prompt__preview-img');
    const fallback = wrapper.querySelector('.share-prompt__preview-fallback');
    img.addEventListener('error', () => {
      img.style.display = 'none';
      fallback.style.display = 'flex';
    });

    function close() {
      wrapper.classList.remove('share-prompt--visible');
      setTimeout(() => wrapper.remove(), 250);
    }

    wrapper.addEventListener('click', e => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'share') {
        track('share_prompt_shared');
        doShare(wrapper.querySelector('[data-action="share"]'));
        close();
      } else if (action === 'close') {
        track('share_prompt_dismissed');
        close();
      } else if (action === 'never') {
        track('share_prompt_never');
        markNeverShow();
        close();
      }
    });

    wrapper.addEventListener('keydown', e => {
      if (e.key === 'Escape') { track('share_prompt_dismissed'); close(); }
    });

    document.body.appendChild(wrapper);
    requestAnimationFrame(() => requestAnimationFrame(() => wrapper.classList.add('share-prompt--visible')));
    wrapper.querySelector('.share-prompt__card')?.focus();
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────

  function init() {
    recordVisit();
    if (!shouldShowPrompt()) return;
    setTimeout(showSharePrompt, DELAY_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
