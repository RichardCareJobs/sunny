/**
 * Hash router.
 *
 * Hash routing is deliberate: GitHub Pages has no server-side rewrite, so a
 * path-based route would 404 on refresh without a 404.html trick. The hash is
 * free for us to use because auth is configured with the PKCE flow, which
 * returns its code in the query string rather than the fragment.
 */

const listeners = new Set();
let routes = [];

/** "/venues/:placeId/offers" -> { pattern, keys } */
function compile(path) {
  const keys = [];
  const pattern = new RegExp(
    "^" +
      path
        .replace(/\/+$/, "")
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\:([A-Za-z0-9_]+)/g, (_, key) => {
          keys.push(key);
          return "([^/]+)";
        }) +
      "/?$"
  );
  return { pattern, keys };
}

export function defineRoutes(defs) {
  routes = defs.map((def) => ({ ...def, ...compile(def.path) }));
}

export function currentPath() {
  const raw = window.location.hash.replace(/^#/, "");
  return raw || "/";
}

export function match(path = currentPath()) {
  for (const route of routes) {
    const found = route.pattern.exec(path);
    if (!found) continue;
    const params = {};
    route.keys.forEach((key, i) => { params[key] = decodeURIComponent(found[i + 1]); });
    return { route, params, path };
  }
  return { route: null, params: {}, path };
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (window.location.hash === target) return;
  if (replace) window.history.replaceState(null, "", target);
  else window.location.hash = path;
  if (replace) notify();
}

export function onRouteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  const result = match();
  listeners.forEach((fn) => fn(result));
}

export function startRouter() {
  window.addEventListener("hashchange", notify);
  notify();
  return () => window.removeEventListener("hashchange", notify);
}
