/**
 * Sunny for Venues — component library.
 *
 * The inventory the brief asks for, built before any screen. Styles live in
 * styles/components.css; this file owns behaviour and accessible structure.
 *
 * Rules these components enforce so screens cannot get them wrong:
 *   - every input has a real <label>, tied by id, never a placeholder-as-label
 *   - errors are announced, tied to the input by aria-describedby
 *   - an empty state cannot be rendered without saying what the number means
 *   - a modal traps focus, closes on Escape, and restores focus on close
 */
import { html, useEffect, useRef, useState, useMemo } from "../html.js";
import { IconChevronDown, IconClose, IconCheck, IconAlert } from "./icons.js";

let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;

const cx = (...parts) => parts.filter(Boolean).join(" ");

/* ── Button ───────────────────────────────────────────────────────────────
   `loading` disables and shows a spinner while keeping the button's width, so
   a form does not jump when you submit it. `href` renders an anchor that looks
   identical — a link that navigates should be a link. */
export function Button({
  variant = "secondary", size, block, loading, disabled, href, type = "button",
  children, class: className, ...rest
}) {
  const cls = cx(
    "s-btn", `s-btn--${variant}`,
    size && `s-btn--${size}`,
    block && "s-btn--block",
    className
  );
  const inner = html`
    ${loading && html`<span class=${cx("s-spinner", variant === "primary" && "s-spinner--on-brand")}></span>`}
    <span>${children}</span>`;

  if (href) {
    return html`<a class=${cls} href=${href} aria-disabled=${disabled ? "true" : null} ...${rest}>${inner}</a>`;
  }
  return html`
    <button class=${cls} type=${type} disabled=${disabled || loading || null}
            aria-busy=${loading ? "true" : null} ...${rest}>${inner}</button>`;
}

/* ── Field ────────────────────────────────────────────────────────────────
   The unit every form is built from. Owns the label/hint/error wiring so no
   screen has to remember aria-describedby. */
export function Field({ label, hint, error, required, id, children }) {
  const fieldId = useMemo(() => id || nextId("field"), [id]);
  const hintId = hint ? `${fieldId}-hint` : null;
  const errorId = error ? `${fieldId}-error` : null;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || null;

  return html`
    <div class="s-field">
      <label class="s-field__label" for=${fieldId}>
        ${label}${required && html`<span class="s-field__required" aria-hidden="true">*</span>`}
      </label>
      ${children({ id: fieldId, describedBy, invalid: Boolean(error), required })}
      ${hint && html`<span class="s-field__hint" id=${hintId}>${hint}</span>`}
      ${error && html`<span class="s-field__error" id=${errorId} role="alert">${error}</span>`}
    </div>`;
}

export function Input({ label, hint, error, required, id, ...rest }) {
  return html`
    <${Field} label=${label} hint=${hint} error=${error} required=${required} id=${id}>
      ${(a) => html`
        <input class="s-input" id=${a.id} required=${a.required || null}
               aria-invalid=${a.invalid ? "true" : null}
               aria-describedby=${a.describedBy} ...${rest} />`}
    <//>`;
}

export function Textarea({ label, hint, error, required, id, ...rest }) {
  return html`
    <${Field} label=${label} hint=${hint} error=${error} required=${required} id=${id}>
      ${(a) => html`
        <textarea class="s-textarea" id=${a.id} required=${a.required || null}
                  aria-invalid=${a.invalid ? "true" : null}
                  aria-describedby=${a.describedBy} ...${rest}></textarea>`}
    <//>`;
}

export function Select({ label, hint, error, required, id, options = [], ...rest }) {
  return html`
    <${Field} label=${label} hint=${hint} error=${error} required=${required} id=${id}>
      ${(a) => html`
        <select class="s-select" id=${a.id} required=${a.required || null}
                aria-invalid=${a.invalid ? "true" : null}
                aria-describedby=${a.describedBy} ...${rest}>
          ${options.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
        </select>`}
    <//>`;
}

export function Checkbox({ label, hint, ...rest }) {
  const id = useMemo(() => nextId("check"), []);
  return html`
    <label class="s-check" for=${id}>
      <input type="checkbox" id=${id} ...${rest} />
      <span class="s-check__text">
        ${label}
        ${hint && html`<br /><span class="s-muted">${hint}</span>`}
      </span>
    </label>`;
}

/* ── Card ─────────────────────────────────────────────────────────────────── */
export function Card({ title, actions, footer, children, class: className }) {
  return html`
    <section class=${cx("s-card", className)}>
      ${(title || actions) && html`
        <header class="s-card__head">
          ${title && html`<h3 class="s-card__title">${title}</h3>`}
          <span class="s-spacer"></span>
          ${actions}
        </header>`}
      <div class="s-card__body">${children}</div>
      ${footer && html`<footer class="s-card__foot">${footer}</footer>`}
    </section>`;
}

/* ── Table ────────────────────────────────────────────────────────────────
   `columns: [{ key, header, numeric, render }]`. Always wrapped in its own
   horizontal scroller so the page body never scrolls sideways on a phone. */
export function Table({ columns, rows, caption, rowKey = (r, i) => i, empty }) {
  if (!rows.length && empty) return empty;
  return html`
    <div class="s-table-scroll">
      <table class="s-table">
        ${caption && html`<caption class="visually-hidden">${caption}</caption>`}
        <thead>
          <tr>${columns.map((c) => html`
            <th scope="col" class=${c.numeric ? "s-num" : null}>${c.header}</th>`)}</tr>
        </thead>
        <tbody>
          ${rows.map((row, i) => html`
            <tr key=${rowKey(row, i)}>
              ${columns.map((c) => html`
                <td class=${c.numeric ? "s-num" : null}>
                  ${c.render ? c.render(row) : row[c.key]}
                </td>`)}
            </tr>`)}
        </tbody>
      </table>
    </div>`;
}

/* ── Badge, Banner ────────────────────────────────────────────────────────── */
export function Badge({ tone, children }) {
  return html`<span class=${cx("s-badge", tone && `s-badge--${tone}`)}>${children}</span>`;
}

export function Banner({ tone = "info", title, children, actions }) {
  return html`
    <div class=${cx("s-banner", `s-banner--${tone}`)} role=${tone === "danger" ? "alert" : "status"}>
      <div class="s-banner__body">
        ${title && html`<span class="s-banner__title">${title}</span>`}
        <div>${children}</div>
        ${actions && html`<div class="s-row">${actions}</div>`}
      </div>
    </div>`;
}

/* ── Empty state ──────────────────────────────────────────────────────────
   `title`, `children` (what this will show once there is data) and `action`
   (what the venue can do to move it) are all part of the signature. The brief
   is explicit that "No data" on its own is not acceptable, so the component
   makes the fuller version the path of least resistance. */
export function EmptyState({ mark = "☀", title, children, action }) {
  return html`
    <div class="s-empty">
      <span class="s-empty__mark" aria-hidden="true">${mark}</span>
      <span class="s-empty__title">${title}</span>
      <p class="s-empty__body">${children}</p>
      ${action}
    </div>`;
}

export function Spinner({ label = "Loading" }) {
  return html`<span class="s-row"><span class="s-spinner"></span><span class="visually-hidden">${label}</span></span>`;
}

/* ── Toasts ───────────────────────────────────────────────────────────────── */
export function Toasts({ toasts, onDismiss }) {
  return html`
    <div class="s-toasts" role="region" aria-label="Notifications">
      ${toasts.map((t) => html`
        <div key=${t.id} class=${cx("s-toast", t.tone !== "neutral" && `s-toast--${t.tone}`)}
             role=${t.tone === "danger" ? "alert" : "status"}>
          ${t.tone === "ok" && html`<${IconCheck} size=${18} />`}
          ${t.tone === "danger" && html`<${IconAlert} size=${18} />`}
          <span class="s-spacer">${t.message}</span>
          <button class="s-toast__close" type="button" onClick=${() => onDismiss(t.id)}
                  aria-label="Dismiss notification">✕</button>
        </div>`)}
    </div>`;
}

/* ── Modal ────────────────────────────────────────────────────────────────
   One component for both the desktop dialog and the phone bottom sheet — the
   difference is a media query, so focus handling cannot drift between them. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, title, onClose, children, footer, labelledBy }) {
  const panelRef = useRef(null);
  const restoreRef = useRef(null);
  const titleId = useMemo(() => labelledBy || nextId("modal-title"), [labelledBy]);

  useEffect(() => {
    if (!open) return undefined;
    restoreRef.current = document.activeElement;

    const panel = panelRef.current;
    const first = panel?.querySelector(FOCUSABLE);
    (first || panel)?.focus();

    const onKeyDown = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose?.(); return; }
      if (e.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return html`
    <div class="s-scrim" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div class="s-modal" role="dialog" aria-modal="true" aria-labelledby=${titleId}
           tabindex="-1" ref=${panelRef}>
        <header class="s-modal__head">
          <h2 class="s-modal__title" id=${titleId}>${title}</h2>
          <button class="s-iconbtn" type="button" onClick=${onClose} aria-label="Close">
            <${IconClose} size=${18} />
          </button>
        </header>
        <div class="s-modal__body">${children}</div>
        ${footer && html`<footer class="s-modal__foot">${footer}</footer>`}
      </div>
    </div>`;
}

/* ── Venue switcher ───────────────────────────────────────────────────────
   Renders nothing at all for a user with one venue. The brief is specific that
   a single-venue operator should never see switcher chrome, so the guard lives
   in the component rather than in every screen that mounts it. */
export function VenueSwitcher({ venues = [], selectedPlaceId, onSelect }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (venues.length <= 1) return null;

  const selected = venues.find((v) => v.place_id === selectedPlaceId) ?? venues[0];

  return html`
    <div class="s-switcher" ref=${rootRef}>
      <button class="s-switcher__trigger" type="button" onClick=${() => setOpen((v) => !v)}
              aria-expanded=${open ? "true" : "false"} aria-haspopup="listbox">
        <span class="s-switcher__name">${selected?.venue_name ?? "Choose a venue"}</span>
        <${IconChevronDown} size=${16} />
      </button>
      ${open && html`
        <div class="s-switcher__menu" role="listbox" aria-label="Switch venue">
          ${venues.map((v) => html`
            <button key=${v.place_id} class="s-switcher__item" type="button" role="option"
                    aria-current=${v.place_id === selected?.place_id ? "true" : "false"}
                    aria-selected=${v.place_id === selected?.place_id ? "true" : "false"}
                    onClick=${() => { onSelect?.(v.place_id); setOpen(false); }}>
              <span>${v.venue_name}</span>
              <span class="s-switcher__item-sub">${v.role}${v.address ? ` · ${v.address}` : ""}</span>
            </button>`)}
        </div>`}
    </div>`;
}
