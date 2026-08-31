/**
 * App shell.
 *
 * Header, venue switcher slot, and the outlet screens render into. The real
 * navigation arrives with the dashboard in Phase 4; what exists now is the
 * frame everything else hangs off, so screens can be written against a stable
 * container rather than being retrofitted into one.
 */
import { html } from "../html.js";
import { VenueSwitcher } from "../ui/components.js";
import { IconSun } from "../ui/icons.js";

export function Shell({ state, onSelectVenue, children }) {
  return html`
    <div class="s-shell">
      <a class="skip-link" href="#main">Skip to content</a>
      <header class="s-shell__header">
        <a class="s-shell__brand" href="#/">
          <${IconSun} size=${22} />
          <span>Sunny for Venues</span>
        </a>
        <span class="s-spacer"></span>
        <${VenueSwitcher}
          venues=${state.memberships}
          selectedPlaceId=${state.selectedPlaceId}
          onSelect=${onSelectVenue} />
      </header>
      <main class="s-shell__main" id="main" tabindex="-1">
        ${children}
      </main>
    </div>`;
}
