/**
 * Entry point.
 *
 * Phase 1 wires the shell, the router and the toast layer, and mounts the
 * component inventory. Auth screens land in Phase 2; the session plumbing they
 * will use is already here, so signing in becomes a screen rather than a
 * rewrite.
 */
import { html, render, useEffect, useState } from "./html.js";
import { defineRoutes, startRouter, onRouteChange, match, navigate } from "./router.js";
import { getState, setState, subscribe, dismissToast, persistSelectedPlaceId } from "./store.js";
import { onAuthChange } from "./supabase.js";
import { Toasts, Banner, Button } from "./ui/components.js";
import { Shell } from "./screens/shell.js";
import { Gallery } from "./screens/gallery.js";

defineRoutes([
  { path: "/", screen: Gallery },
  { path: "/components", screen: Gallery },
]);

function NotFound() {
  return html`
    <div class="s-container s-stack">
      <${Banner} tone="warn" title="That page does not exist yet"
        actions=${html`<${Button} variant="primary" size="sm" href="#/">Back to the start<//>`}>
        Most of the venue platform arrives in later phases. What is built so far is the component
        inventory.
      <//>
    </div>`;
}

function App() {
  const [state, setLocal] = useState(getState());
  const [route, setRoute] = useState(match());

  useEffect(() => subscribe(setLocal), []);
  useEffect(() => onRouteChange(setRoute), []);
  useEffect(() => startRouter(), []);

  useEffect(() => {
    // Session plumbing runs from boot even though there are no auth screens
    // yet, so an expired session is already a first-class state rather than
    // something bolted on in Phase 2.
    let stop = () => {};
    try {
      stop = onAuthChange((session) => {
        setState({
          session,
          user: session?.user ?? null,
          status: session ? "ready" : "signed-out",
        });
      });
    } catch (err) {
      // No anon key configured yet. The inventory still renders — you do not
      // need Supabase credentials to look at the components.
      setState({ status: "signed-out" });
      console.warn("[sunny-venues]", err.message);
    }
    return () => stop();
  }, []);

  const onSelectVenue = (placeId) => {
    persistSelectedPlaceId(state.user?.id, placeId);
    setState({ selectedPlaceId: placeId });
  };

  const Screen = route.route?.screen ?? NotFound;

  return html`
    <${Shell} state=${state} onSelectVenue=${onSelectVenue}>
      <${Screen} ...${route.params} />
    <//>
    <${Toasts} toasts=${state.toasts} onDismiss=${dismissToast} />`;
}

render(html`<${App} />`, document.getElementById("root"));

// Exposed for console poking during development. Not used by the app.
if (window.location.hostname === "localhost") {
  window.__sunny = { getState, setState, navigate };
}
