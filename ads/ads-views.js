const AdsViews = (() => {
  const view = document.getElementById("view");

  function render(html) {
    if (!view) return;
    view.innerHTML = html;
  }

  function formatDate(isoString) {
    if (!isoString) return "";
    const date = new Date(isoString);
    return date.toLocaleString();
  }

  function getProfileCompletion(advertiser) {
    const fields = [
      "businessName",
      "contactName",
      "email",
      "phone",
      "abn",
      "suburb",
      "state",
    ];
    const completed = fields.filter((field) => Boolean(advertiser[field])).length;
    return {
      completed,
      total: fields.length,
      percent: Math.round((completed / fields.length) * 100),
    };
  }

  function renderToast() {
    const toast = AdsRouter.consumeToast();
    if (!toast) return "";
    return `<div class="toast" role="status">${toast}</div>`;
  }

  function renderDashboard() {
    const state = AdsState.loadState();
    const profile = state.advertiser;
    const profileStatus = getProfileCompletion(profile);
    const claimedVenues = state.venues.filter(
      (venue) => venue.claimed && venue.claimedBy === profile.id,
    );
    const activeCampaigns = state.campaigns.filter(
      (campaign) => campaign.status === "active",
    );
    const profileIncomplete = profileStatus.percent < 100;

    render(`
      ${renderToast()}
      <section class="card">
        <h2>Welcome back</h2>
        <p>Track your venue claims, campaign spend, and early results.</p>
        <div class="stats">
          <div>
            <span class="label">Profile completion</span>
            <strong>${profileStatus.percent}%</strong>
            <span class="muted">${profileStatus.completed}/${profileStatus.total} fields complete</span>
          </div>
          <div>
            <span class="label">Claimed venues</span>
            <strong>${claimedVenues.length}</strong>
            <span class="muted">In your portfolio</span>
          </div>
          <div>
            <span class="label">Active campaigns</span>
            <strong>${activeCampaigns.length}</strong>
            <span class="muted">Currently running</span>
          </div>
        </div>
        ${
          profileIncomplete
            ? `<div class="banner">Finish your advertiser profile to launch campaigns. <a href="#/profile">Complete profile</a></div>`
            : ""
        }
      </section>
      <section class="card">
        <h2>Quick actions</h2>
        <div class="actions-grid">
          <a class="action" href="#/venues">Claim or manage a venue</a>
          <a class="action" href="#/campaigns">Create a Boost campaign</a>
          <a class="action" href="#/results">View results and events</a>
          <a class="action" href="/">Open Sunny consumer app</a>
        </div>
      </section>
    `);
  }

  function renderVenues() {
    const state = AdsState.loadState();
    const advertiser = state.advertiser;

    render(`
      ${renderToast()}
      <section class="card">
        <div class="card-header">
          <div>
            <h2>Venues</h2>
            <p class="muted">Search for a venue to claim or manage.</p>
          </div>
          <input id="venue-search" class="input" type="search" placeholder="Search by name or suburb" />
        </div>
        <div id="venue-list" class="cards-grid"></div>
      </section>
    `);

    const list = document.getElementById("venue-list");
    const searchInput = document.getElementById("venue-search");

    function renderList(filter = "") {
      if (!list) return;
      const normalized = filter.toLowerCase();
      const filtered = state.venues.filter((venue) => {
        return (
          venue.name.toLowerCase().includes(normalized) ||
          venue.suburb.toLowerCase().includes(normalized)
        );
      });

      list.innerHTML = filtered
        .map((venue) => {
          const claim = AdsState.getClaimForVenue(venue.id);
          const isMine = venue.claimed && venue.claimedBy === advertiser.id;
          const isClaimed = venue.claimed && !isMine;
          const statusLabel = isMine
            ? `Claimed (${claim ? claim.status : "approved"})`
            : isClaimed
              ? "Claimed by another advertiser"
              : "Unclaimed";
          const action = !venue.claimed
            ? `<a class="button" href="#/claim?venueId=${venue.id}">Claim</a>`
            : isMine
              ? `<a class="button ghost" href="#/campaigns">Manage</a>`
              : `<span class="button disabled">Unavailable</span>`;
          return `
            <article class="venue-card">
              <h3>${venue.name}</h3>
              <p class="muted">${venue.address}</p>
              <div class="tags">${venue.tags.map((tag) => `<span>${tag}</span>`).join("")}</div>
              <div class="venue-footer">
                <span class="status">${statusLabel}</span>
                ${action}
              </div>
            </article>
          `;
        })
        .join("");
    }

    renderList();

    if (searchInput) {
      searchInput.addEventListener("input", (event) => {
        renderList(event.target.value);
      });
    }
  }

  function renderClaim({ query }) {
    const state = AdsState.loadState();
    const venueId = query.venueId;
    const venue = state.venues.find((item) => item.id === venueId);
    const advertiser = state.advertiser;

    if (!venue) {
      render(`
        <section class="card">
          <h2>Venue not found</h2>
          <p>We couldn't find that venue. Head back to the venue list to try again.</p>
          <a class="button" href="#/venues">Back to venues</a>
        </section>
      `);
      return;
    }

    if (venue.claimed && venue.claimedBy !== advertiser.id) {
      render(`
        <section class="card">
          <h2>${venue.name}</h2>
          <p class="muted">${venue.address}</p>
          <div class="banner">This venue is already claimed by another advertiser.</div>
          <a class="button" href="#/venues">Back to venues</a>
        </section>
      `);
      return;
    }

    const existingClaim = state.claims.find(
      (claim) => claim.venueId === venueId && venue.claimedBy === advertiser.id,
    );

    if (existingClaim) {
      render(`
        <section class="card">
          <h2>${venue.name}</h2>
          <p class="muted">${venue.address}</p>
          <div class="banner">Claim already submitted. Status: ${existingClaim.status}.</div>
          <a class="button" href="#/venues">Back to venues</a>
        </section>
      `);
      return;
    }

    render(`
      ${renderToast()}
      <section class="card">
        <h2>Claim ${venue.name}</h2>
        <p class="muted">${venue.address}</p>
        <form id="claim-form" class="form">
          <label>
            Proof type
            <select name="proofType" class="input" required>
              <option value="email">Business email</option>
              <option value="abn">ABN</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label>
            Notes
            <textarea name="notes" class="input" rows="4" placeholder="Tell us how you manage this venue."></textarea>
          </label>
          <button type="submit" class="button">Submit claim</button>
        </form>
      </section>
    `);

    const form = document.getElementById("claim-form");
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        const proofType = formData.get("proofType");
        const notes = formData.get("notes");
        const claim = {
          id: AdsState.createId("c"),
          venueId,
          status: "pending",
          submittedAt: new Date().toISOString(),
          proofType,
          notes,
        };
        const nextState = AdsState.loadState();
        nextState.claims.unshift(claim);
        nextState.venues = nextState.venues.map((item) => {
          if (item.id !== venueId) return item;
          return { ...item, claimed: true, claimedBy: advertiser.id };
        });
        AdsState.saveState(nextState);
        AdsState.logEvent("claim_submitted", { venueId, proofType });
        AdsRouter.setToast("Claim submitted for review.");
        AdsRouter.navigate("/venues");
      });
    }
  }

  function renderProfile() {
    const state = AdsState.loadState();
    const profile = state.advertiser;

    render(`
      ${renderToast()}
      <section class="card">
        <h2>Advertiser profile</h2>
        <p class="muted">Keep your contact information up to date.</p>
        <form id="profile-form" class="form">
          <div class="form-grid">
            <label>
              Business name
              <input class="input" name="businessName" type="text" value="${profile.businessName}" required />
            </label>
            <label>
              Contact name
              <input class="input" name="contactName" type="text" value="${profile.contactName}" required />
            </label>
            <label>
              Email
              <input class="input" name="email" type="email" value="${profile.email}" required />
            </label>
            <label>
              Phone
              <input class="input" name="phone" type="tel" value="${profile.phone}" required />
            </label>
            <label>
              ABN
              <input class="input" name="abn" type="text" value="${profile.abn}" required />
            </label>
            <label>
              Suburb
              <input class="input" name="suburb" type="text" value="${profile.suburb}" required />
            </label>
            <label>
              State
              <select class="input" name="state">
                ${["NSW", "VIC", "QLD", "SA", "WA", "TAS", "ACT", "NT"]
                  .map(
                    (stateOption) =>
                      `<option value="${stateOption}" ${
                        stateOption === profile.state ? "selected" : ""
                      }>${stateOption}</option>`,
                  )
                  .join("")}
              </select>
            </label>
          </div>
          <button type="submit" class="button">Save profile</button>
        </form>
      </section>
    `);

    const form = document.getElementById("profile-form");
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        const nextState = AdsState.loadState();
        nextState.advertiser = {
          ...nextState.advertiser,
          businessName: formData.get("businessName").trim(),
          contactName: formData.get("contactName").trim(),
          email: formData.get("email").trim(),
          phone: formData.get("phone").trim(),
          abn: formData.get("abn").trim(),
          suburb: formData.get("suburb").trim(),
          state: formData.get("state"),
        };
        AdsState.saveState(nextState);
        AdsState.logEvent("profile_saved", { advertiserId: nextState.advertiser.id });
        AdsRouter.setToast("Profile saved.");
        renderProfile();
      });
    }
  }

  function renderCampaigns() {
    const state = AdsState.loadState();
    const advertiser = state.advertiser;
    const claimedVenues = state.venues.filter(
      (venue) => venue.claimed && venue.claimedBy === advertiser.id,
    );

    if (!claimedVenues.length) {
      render(`
        <section class="card">
          <h2>Campaigns</h2>
          <p>You need a claimed venue before launching a campaign.</p>
          <a class="button" href="#/venues">Claim a venue</a>
        </section>
      `);
      return;
    }

    render(`
      ${renderToast()}
      <section class="card">
        <h2>Create campaign</h2>
        <form id="campaign-form" class="form">
          <label>
            Venue
            <select class="input" name="venueId">
              ${claimedVenues
                .map((venue) => `<option value="${venue.id}">${venue.name}</option>`)
                .join("")}
            </select>
          </label>
          <fieldset class="plan-fieldset">
            <legend>Plan</legend>
            <label class="radio">
              <input type="radio" name="plan" value="boost" checked />
              Boost — $19 / month
            </label>
            <label class="radio">
              <input type="radio" name="plan" value="boost_plus" />
              Boost+ — $39 / month
            </label>
          </fieldset>
          <label>
            Radius (km)
            <input class="input" name="radiusKm" type="number" min="1" value="5" />
          </label>
          <label>
            Status
            <select class="input" name="status">
              <option value="active" selected>Active</option>
              <option value="paused">Paused</option>
            </select>
          </label>
          <button type="submit" class="button">Create campaign</button>
        </form>
      </section>
      <section class="card">
        <h2>Existing campaigns</h2>
        <div class="cards-grid" id="campaign-list"></div>
      </section>
    `);

    const list = document.getElementById("campaign-list");

    function renderList() {
      const nextState = AdsState.loadState();
      if (!list) return;
      if (!nextState.campaigns.length) {
        list.innerHTML = `<p class="muted">No campaigns yet.</p>`;
        return;
      }
      list.innerHTML = nextState.campaigns
        .map((campaign) => {
          const venue = nextState.venues.find((item) => item.id === campaign.venueId);
          const planLabel = campaign.plan === "boost" ? "Boost" : "Boost+";
          const isEnded = campaign.status === "ended";
          const toggleLabel = campaign.status === "paused" ? "Resume" : "Pause";
          return `
            <article class="campaign-card">
              <h3>${venue ? venue.name : "Venue"} — ${planLabel}</h3>
              <p class="muted">${campaign.radiusKm} km radius · $${campaign.monthlyPrice}/month</p>
              <div class="status-row">
                <span class="status">Status: ${campaign.status}</span>
                <span class="muted">Started ${formatDate(campaign.startDate)}</span>
              </div>
              <div class="actions-row">
                <button class="button ghost" data-action="toggle" data-id="${campaign.id}" ${
                  isEnded ? "disabled" : ""
                }>${toggleLabel}</button>
                <button class="button danger" data-action="end" data-id="${campaign.id}" ${
                  isEnded ? "disabled" : ""
                }>End</button>
              </div>
            </article>
          `;
        })
        .join("");
    }

    renderList();

    const form = document.getElementById("campaign-form");
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        const plan = formData.get("plan");
        const monthlyPrice = plan === "boost" ? 19 : 39;
        const campaign = {
          id: AdsState.createId("cmp"),
          venueId: formData.get("venueId"),
          plan,
          monthlyPrice,
          radiusKm: Number(formData.get("radiusKm")) || 5,
          status: formData.get("status"),
          startDate: new Date().toISOString(),
          endDate: null,
          createdAt: new Date().toISOString(),
        };
        const nextState = AdsState.loadState();
        nextState.campaigns.unshift(campaign);
        AdsState.saveState(nextState);
        AdsState.logEvent("campaign_created", {
          campaignId: campaign.id,
          venueId: campaign.venueId,
          plan: campaign.plan,
        });
        AdsRouter.setToast("Campaign created.");
        renderCampaigns();
      });
    }

    if (list) {
      list.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        const id = button.dataset.id;
        const action = button.dataset.action;
        if (!id || !action) return;
        const nextState = AdsState.loadState();
        let eventType = "";
        let eventMeta = {};
        nextState.campaigns = nextState.campaigns.map((campaign) => {
          if (campaign.id !== id) return campaign;
          if (action === "toggle") {
            const nextStatus = campaign.status === "paused" ? "active" : "paused";
            eventType = "campaign_status_changed";
            eventMeta = { campaignId: id, status: nextStatus };
            return { ...campaign, status: nextStatus };
          }
          if (action === "end") {
            eventType = "campaign_ended";
            eventMeta = { campaignId: id };
            return { ...campaign, status: "ended", endDate: new Date().toISOString() };
          }
          return campaign;
        });
        AdsState.saveState(nextState);
        if (eventType) {
          AdsState.logEvent(eventType, eventMeta);
        }
        renderCampaigns();
      });
    }
  }

  function renderResults() {
    const state = AdsState.loadState();
    const activeCampaigns = state.campaigns.filter(
      (campaign) => campaign.status === "active",
    );
    const estimatedAppearances = activeCampaigns.reduce((sum, campaign) => {
      return sum + (campaign.plan === "boost" ? 100 : 250);
    }, 0);
    const offerReveals = state.events.filter((event) => event.type === "offer_reveal").length;
    const appearanceEvents = state.events.filter((event) => event.type === "appearance").length;

    render(`
      ${renderToast()}
      <section class="card">
        <h2>Results (v0)</h2>
        <div class="stats">
          <div>
            <span class="label">Promoted appearances delivered</span>
            <strong>${estimatedAppearances}</strong>
            <span class="muted">This is estimated in v0.</span>
          </div>
          <div>
            <span class="label">Offer reveals</span>
            <strong>${offerReveals}</strong>
            <span class="muted">Based on simulated events.</span>
          </div>
          <div>
            <span class="label">Simulated appearances</span>
            <strong>${appearanceEvents}</strong>
            <span class="muted">Manual test events.</span>
          </div>
        </div>
        <div class="actions-row">
          <button class="button ghost" id="btn-appearance">Simulate promoted appearance</button>
          <button class="button" id="btn-reveal">Simulate offer reveal</button>
        </div>
      </section>
      <section class="card">
        <h2>Event log</h2>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Event</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              ${state.events
                .slice(0, 20)
                .map((event) => {
                  const meta = Object.keys(event.meta || {}).length
                    ? JSON.stringify(event.meta)
                    : "-";
                  return `
                    <tr>
                      <td>${formatDate(event.ts)}</td>
                      <td>${event.type}</td>
                      <td>${meta}</td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </section>
    `);

    const appearanceButton = document.getElementById("btn-appearance");
    const revealButton = document.getElementById("btn-reveal");

    if (appearanceButton) {
      appearanceButton.addEventListener("click", () => {
        AdsState.logEvent("appearance", { source: "simulator" });
        AdsRouter.setToast("Appearance event logged.");
        renderResults();
      });
    }

    if (revealButton) {
      revealButton.addEventListener("click", () => {
        AdsState.logEvent("offer_reveal", { source: "simulator" });
        AdsRouter.setToast("Offer reveal logged.");
        renderResults();
      });
    }
  }

  return {
    dashboard: renderDashboard,
    venues: renderVenues,
    claim: renderClaim,
    profile: renderProfile,
    campaigns: renderCampaigns,
    results: renderResults,
  };
})();

window.AdsViews = AdsViews;
