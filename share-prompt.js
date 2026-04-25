(() => {
  const FIRST_VISIT_KEY = 'sunny_first_visited';
  const PROMPT_SHOWN_KEY = 'sunny_share_prompt_shown';
  const DELAY_MS = 30000;
  const SHARE_URL = 'https://visit.sunnypubs.app/';
  const SHARE_TITLE = 'Sunny — Find great outdoor pubs';
  const SHARE_TEXT = 'I use Sunny to find great outdoor pubs nearby. Check it out!';

  function isReturningUser() {
    try {
      const seen = localStorage.getItem(FIRST_VISIT_KEY);
      if (!seen) {
        localStorage.setItem(FIRST_VISIT_KEY, String(Date.now()));
        return false;
      }
      return true;
    } catch { return false; }
  }

  function hasShownThisSession() {
    try { return sessionStorage.getItem(PROMPT_SHOWN_KEY) === '1'; } catch { return false; }
  }

  function markShown() {
    try { sessionStorage.setItem(PROMPT_SHOWN_KEY, '1'); } catch {}
  }

  function track(event) {
    try { window.SunnyAnalytics?.track(event); } catch {}
  }

  function doShare(shareBtn) {
    if (navigator.share) {
      navigator.share({ title: SHARE_TITLE, text: SHARE_TEXT, url: SHARE_URL }).catch(() => {});
    } else if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(SHARE_URL).then(() => {
        const original = shareBtn.textContent;
        shareBtn.textContent = 'Link copied!';
        setTimeout(() => { shareBtn.textContent = original; }, 2000);
      }).catch(() => {});
    }
  }

  function showSharePrompt() {
    if (hasShownThisSession()) return;
    markShown();
    track('share_prompt_shown');

    const wrapper = document.createElement('div');
    wrapper.className = 'share-prompt';
    wrapper.setAttribute('role', 'dialog');
    wrapper.setAttribute('aria-modal', 'true');
    wrapper.setAttribute('aria-labelledby', 'share-prompt-title');
    wrapper.innerHTML = `
      <div class="share-prompt__backdrop" data-action="close"></div>
      <div class="share-prompt__card">
        <p class="share-prompt__eyebrow">Enjoying Sunny?</p>
        <h2 class="share-prompt__title" id="share-prompt-title">Share it with a mate</h2>
        <p class="share-prompt__body">Help your friends find great outdoor pubs near them.</p>
        <div class="share-prompt__actions">
          <button type="button" class="share-prompt__btn share-prompt__btn--primary" data-action="share">Share Sunny</button>
          <button type="button" class="share-prompt__btn share-prompt__btn--secondary" data-action="close">Maybe later</button>
        </div>
      </div>
    `;

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
      }
    });

    wrapper.addEventListener('keydown', e => {
      if (e.key === 'Escape') { track('share_prompt_dismissed'); close(); }
    });

    document.body.appendChild(wrapper);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => wrapper.classList.add('share-prompt--visible'));
    });
    wrapper.querySelector('.share-prompt__card')?.focus?.();
  }

  function init() {
    if (!isReturningUser()) return;
    if (hasShownThisSession()) return;
    setTimeout(showSharePrompt, DELAY_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
