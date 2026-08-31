/**
 * Preact + htm, wired once.
 *
 * Everything in the app imports `html`, `render` and the hooks from here so
 * there is exactly one place that knows which view layer we use. Swapping it
 * out later means rewriting this file, not the app.
 *
 * `html` is a tagged template — JSX-like structure with no build step:
 *   html`<button class="s-btn" onClick=${fn}>${label}</button>`
 */
import { h, render as preactRender, Fragment } from "preact";
import htm from "htm";

export const html = htm.bind(h);
export { h, Fragment, preactRender as render };
export {
  useState, useEffect, useRef, useMemo, useCallback, useContext, useReducer,
} from "preact/hooks";
export { createContext } from "preact";
