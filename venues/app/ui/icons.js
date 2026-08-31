/**
 * Inline SVG icons. Kept as a small set on purpose — an icon that only appears
 * once is usually a word that would read better.
 *
 * All icons inherit `currentColor` and are marked aria-hidden; the accessible
 * name comes from the control that contains them.
 */
import { html } from "../html.js";

const svg = (paths, { size = 20, fill = false } = {}) => html`
  <svg width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
       fill=${fill ? "currentColor" : "none"} stroke=${fill ? "none" : "currentColor"}
       stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    ${paths}
  </svg>`;

export const IconSun = (p = {}) => svg(html`
  <circle cx="12" cy="12" r="4" />
  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />`, p);

export const IconChevronDown = (p = {}) => svg(html`<path d="m6 9 6 6 6-6" />`, p);
export const IconCheck  = (p = {}) => svg(html`<path d="m20 6-11 11-5-5" />`, p);
export const IconClose  = (p = {}) => svg(html`<path d="M18 6 6 18M6 6l12 12" />`, p);
export const IconSearch = (p = {}) => svg(html`<circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />`, p);
export const IconAlert  = (p = {}) => svg(html`<path d="M12 9v4M12 17h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />`, p);
export const IconChart  = (p = {}) => svg(html`<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />`, p);
