/**
 * A very small observable store.
 *
 * Deliberately not a state library. The app has one piece of genuinely global
 * state — who is signed in and which venue they are looking at — and everything
 * else is local to a screen.
 *
 * The selected venue is a CLIENT-SIDE CONVENIENCE ONLY. Every request still
 * carries the venue identifier and every server-side check re-derives
 * membership from the JWT. Switching venues here grants nothing.
 */

const SELECTED_VENUE_KEY = "sunny-venues-selected-venue";

const initial = {
  status: "loading",   // loading | signed-out | ready
  session: null,
  user: null,
  memberships: [],     // [{ place_id, role, venue_name, ... }]
  selectedPlaceId: null,
  toasts: [],
};

let state = { ...initial };
const listeners = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  listeners.forEach((fn) => fn(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function resetState() {
  state = { ...initial, status: "signed-out" };
  listeners.forEach((fn) => fn(state));
}

/* ── Selected venue, persisted per user ──────────────────────────────────── */

function readSelectionMap() {
  try {
    return JSON.parse(window.localStorage.getItem(SELECTED_VENUE_KEY) || "{}");
  } catch {
    return {};
  }
}

export function readSelectedPlaceId(userId) {
  if (!userId) return null;
  return readSelectionMap()[userId] ?? null;
}

export function persistSelectedPlaceId(userId, placeId) {
  if (!userId) return;
  try {
    const map = readSelectionMap();
    map[userId] = placeId;
    window.localStorage.setItem(SELECTED_VENUE_KEY, JSON.stringify(map));
  } catch { /* private mode — selection just will not persist */ }
}

/**
 * Resolves the venue to show. Falls back to the first membership when the
 * remembered venue is gone — a user removed from a venue must not land on a
 * dead screen.
 */
export function resolveSelectedVenue(memberships, userId) {
  if (!memberships.length) return null;
  const remembered = readSelectedPlaceId(userId);
  const match = memberships.find((m) => m.place_id === remembered);
  return (match ?? memberships[0]).place_id;
}

/* ── Toasts ──────────────────────────────────────────────────────────────── */

let toastSeq = 0;

export function toast(message, { tone = "neutral", timeout = 5000 } = {}) {
  const id = ++toastSeq;
  setState((s) => ({ toasts: [...s.toasts, { id, message, tone }] }));
  if (timeout) window.setTimeout(() => dismissToast(id), timeout);
  return id;
}

export function dismissToast(id) {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
