/**
 * Component inventory.
 *
 * The visible Phase 1 deliverable: every component in the library, in the
 * states screens will actually use, on one page. It is a working reference and
 * a regression check — if a token change breaks something, it breaks here
 * first, before it reaches a screen a publican is using.
 *
 * Content is real Dublin and London venues from the existing dataset, not
 * placeholder text, so spacing is exercised against the lengths we will see.
 */
import { html, useState } from "../html.js";
import {
  Button, Input, Textarea, Select, Checkbox, Card, Table, Badge, Banner,
  EmptyState, Spinner, Modal, VenueSwitcher,
} from "../ui/components.js";
import { toast } from "../store.js";

const DEMO_VENUES = [
  { place_id: "demo-1", venue_name: "The Long Hall", role: "owner",   address: "South Great George's St, Dublin 2" },
  { place_id: "demo-2", venue_name: "Toner's",       role: "manager", address: "Baggot St Lower, Dublin 2" },
  { place_id: "demo-3", venue_name: "The Bull & Last", role: "owner",  address: "Highgate Rd, London NW5" },
];

function Section({ id, title, note, children }) {
  return html`
    <section class="s-stack" aria-labelledby=${`h-${id}`} style="scroll-margin-top: 72px" id=${id}>
      <div class="s-stack s-stack--tight">
        <h2 id=${`h-${id}`}>${title}</h2>
        ${note && html`<p class="s-muted s-measure">${note}</p>`}
      </div>
      ${children}
    </section>`;
}

export function Gallery() {
  const [modalOpen, setModalOpen] = useState(false);
  const [selected, setSelected] = useState("demo-1");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

  const emailError = email && !email.includes("@")
    ? "That does not look like an email address. Check for a typo."
    : null;

  const fakeSave = () => {
    setLoading(true);
    window.setTimeout(() => { setLoading(false); toast("Offer saved", { tone: "ok" }); }, 900);
  };

  return html`
    <div class="s-container s-stack s-stack--loose">

      <header class="s-stack s-stack--tight">
        <h1>Component inventory</h1>
        <p class="s-muted s-measure">
          Every component the venue platform is built from, in the states the screens use.
          Colour, type, spacing and radius all come from <code>styles/tokens.css</code> —
          there is no hard-coded colour below this line.
        </p>
      </header>

      <${Banner} tone="info" title="Phase 1 — foundations">
        Auth, claiming, billing, offers and reporting are not built yet. This page exists so the
        components are settled and consistent before any screen is written.
      <//>

      <${Section} id="buttons" title="Buttons"
        note="Primary buttons use the accessible orange — 5.4:1 on white. The brand orange stays for
              identity surfaces like the header, which carries near-black text rather than white so
              it clears AA too.">
        <div class="s-row">
          <${Button} variant="primary">Claim this venue<//>
          <${Button} variant="secondary">Cancel<//>
          <${Button} variant="ghost">Skip for now<//>
          <${Button} variant="danger">Delete offer<//>
        </div>
        <div class="s-row">
          <${Button} variant="primary" size="sm">Small<//>
          <${Button} variant="primary">Default<//>
          <${Button} variant="primary" size="lg">Large<//>
          <${Button} variant="primary" loading=${loading} onClick=${fakeSave}>Save offer<//>
          <${Button} variant="primary" disabled>Unavailable on your plan<//>
        </div>
      <//>

      <${Section} id="forms" title="Inputs"
        note="Every control has a real label tied by id. Errors are announced and linked with
              aria-describedby by the Field component, so a screen cannot forget to do it.">
        <div class="s-stack" style="max-width: 30rem">
          <${Input} label="Venue name" required placeholder="The Long Hall"
                    hint="As it appears on your licence." />
          <${Input} label="Email" type="email" required value=${email}
                    error=${emailError}
                    onInput=${(e) => setEmail(e.target.value)}
                    hint="We send the verification link here." />
          <${Select} label="Offer type" hint="Categorisation only — it never limits what you can offer."
                     options=${[
                       { value: "food", label: "Food" },
                       { value: "drink", label: "Drink" },
                       { value: "entry", label: "Entry" },
                       { value: "other", label: "Other" },
                     ]} />
          <${Textarea} label="Terms and conditions"
                       placeholder="One per customer. Not valid with any other offer."
                       hint="Shown in full when someone taps the offer." />
          <${Checkbox} label="Email me when an offer is about to expire"
                       hint="About one email a month." />
        </div>
      <//>

      <${Section} id="cards" title="Cards">
        <${Card} title="The Long Hall"
                 actions=${html`<${Badge} tone="ok">Live<//>`}
                 footer=${html`
                   <${Button} variant="secondary" size="sm">Preview<//>
                   <${Button} variant="primary" size="sm">Edit offer<//>`}>
          <p>Two-for-one on Guinness, Monday to Thursday, 4pm–7pm.</p>
          <p class="s-muted s-small">Runs until 30 September · 41 claims so far</p>
        <//>
      <//>

      <${Section} id="badges" title="Badges and banners"
        note="Status is carried by shape and colour together, so it reads at a glance and still
              works for someone who cannot distinguish the hues.">
        <div class="s-row">
          <${Badge}>Draft<//>
          <${Badge} tone="info">Scheduled<//>
          <${Badge} tone="ok">Live<//>
          <${Badge} tone="warn">Paused<//>
          <${Badge} tone="danger">Expired<//>
          <${Badge} tone="brand">Pro<//>
        </div>
        <${Banner} tone="warn" title="Your card was declined">
          We could not take this month's payment for Toner's. Your listing and reporting are
          unaffected — only the live offer is paused.
        <//>
        <${Banner} tone="danger" title="Verification locked">
          Three codes have been requested for this venue today. Try again tomorrow, or ask us to
          check it by hand.
        <//>
        <${Banner} tone="ok" title="Venue claimed">
          You are the owner of The Long Hall. Next, add your first offer.
        <//>
      <//>

      <${Section} id="tables" title="Tables"
        note="Numbers are tabular and right-aligned so columns line up. The table scrolls inside its
              own container — the page never scrolls sideways on a phone.">
        <${Table}
          caption="Venue performance, last 30 days"
          columns=${[
            { key: "venue", header: "Venue" },
            { key: "plan", header: "Plan", render: (r) => html`<${Badge} tone=${r.tone}>${r.plan}<//>` },
            { key: "views", header: "Listing views", numeric: true },
            { key: "opens", header: "Detail opens", numeric: true },
          ]}
          rows=${[
            { venue: "The Long Hall", plan: "Standard", tone: "ok", views: "107", opens: "6" },
            { venue: "Toner's", plan: "Lite", tone: "info", views: "24", opens: "2" },
            { venue: "The Bull & Last", plan: "Free", tone: null, views: "4", opens: "0" },
          ]}
          rowKey=${(r) => r.venue} />
      <//>

      <${Section} id="empty" title="Empty states"
        note="The component requires a title, an explanation of what the number will show, and an
              action. 'No data' on its own cannot be shipped by accident.">
        <${EmptyState} mark="☀" title="No offers yet"
          action=${html`<${Button} variant="primary">Create your first offer<//>`}>
          An offer appears in the app to anyone browsing near you. Venues that run one see roughly
          three times the detail views of venues that do not.
        <//>
        <${EmptyState} mark="📈" title="Not enough data yet"
          action=${html`<${Button} variant="secondary">See how views are counted<//>`}>
          Redemption rate needs about twenty claims before the percentage means anything. You have
          four so far, so we are showing the count rather than a figure that would mislead you.
        <//>
      <//>

      <${Section} id="feedback" title="Toasts, modals and loading">
        <div class="s-row">
          <${Button} variant="secondary" onClick=${() => toast("Draft saved")}>Neutral toast<//>
          <${Button} variant="secondary" onClick=${() => toast("Offer published", { tone: "ok" })}>Success toast<//>
          <${Button} variant="secondary" onClick=${() => toast("Could not reach the server. Nothing was saved.", { tone: "danger" })}>Error toast<//>
          <${Button} variant="secondary" onClick=${() => setModalOpen(true)}>Open modal<//>
          <${Spinner} />
        </div>
        <${Modal} open=${modalOpen} title="Delete this offer?" onClose=${() => setModalOpen(false)}
          footer=${html`
            <${Button} variant="secondary" onClick=${() => setModalOpen(false)}>Keep it<//>
            <${Button} variant="danger" onClick=${() => { setModalOpen(false); toast("Offer deleted"); }}>Delete offer<//>`}>
          <p>Two-for-one on Guinness will stop showing in the app straight away.</p>
          <p class="s-muted s-small">
            The 41 people who already claimed it keep their claim, and the terms they agreed to are
            kept on record.
          </p>
        <//>
        <p class="s-muted s-small">
          On a phone the modal docks to the bottom as a sheet. It is one component either way, so
          focus trapping and Escape behave identically.
        </p>
      <//>

      <${Section} id="switcher" title="Venue switcher"
        note="Shown only to users with more than one venue. Below it renders with three; give it one
              and it renders nothing at all, which is the single-venue case the brief asks for.">
        <div class="s-row" style="background: var(--brand-500); padding: var(--space-2); border-radius: var(--radius-md)">
          <${VenueSwitcher} venues=${DEMO_VENUES} selectedPlaceId=${selected} onSelect=${setSelected} />
          <${VenueSwitcher} venues=${[DEMO_VENUES[0]]} selectedPlaceId="demo-1" onSelect=${() => {}} />
        </div>
        <p class="s-muted s-small">
          Selecting a venue here is a client-side convenience only. Every request still carries the
          venue identifier and every server-side check re-derives membership from the JWT.
        </p>
      <//>

    </div>`;
}
