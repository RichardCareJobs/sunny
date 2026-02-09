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

  function formatFieldLabel(field) {
    const map = {
      businessName: "Business name",
      contactName: "Contact name",
      email: "Email",
      phone: "Phone",
      abn: "ABN",
      suburb: "Suburb",
      state: "State",
    };
    return map[field] || field;
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
    const approvedVenues = state.venues.filter(
      (venue) => AdsState.isVenueApproved(state, venue.id) && venue.claimedBy === profile.id,
    );
    const activeCampaigns = state.campaigns.filter(
      (campaign) => campaign.status === "active",
    );
    const profileIncomplete = !AdsState.isProfileComplete(profile);
    const hasApprovedVenue = approvedVenues.length > 0;
    const checklistItems = [
      {
        label: "Complete profile",
        done: !profileIncomplete,
        href: "#/profile",
      },
      {
        label: "Submit venue claim",
        done: state.claims.some((claim) => claim.advertiserId === profile.id),
        href: "#/venues",
      },
      {
        label: "Get claim approved",
        done: hasApprovedVenue,
        href: "#/venues",
      },
      {
        label: "Create Boost campaign",
        done: state.campaigns.length > 0,
        href: "#/campaigns",
      },
    ];
    const primaryCta = profileIncomplete
      ? { label: "Complete profile", href: "#/profile" }
      : !hasApprovedVenue
        ? { label: "Claim a venue", href: "#/venues" }
        : { label: "Create campaign", href: "#/campaigns" };

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
        <div class="actions-row">
          <a class="button" href="${primaryCta.href}">${primaryCta.label}</a>
        </div>
      </section>
      <section class="card">
        <h2>Getting started</h2>
        <p class="muted">Work through these steps to launch your first Boost campaign.</p>
        <ul class="checklist">
          ${checklistItems
            .map(
              (item) => `
              <li class="checklist-item ${item.done ? "done" : ""}">
                <a href="${item.href}">${item.label}</a>
              </li>
            `,
            )
            .join("")}
        </ul>
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
    let activeFilter = "all";

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
        <div class="toggle-group" role="tablist" aria-label="Venue filters">
          <button class="toggle active" type="button" data-filter="all">All venues</button>
          <button class="toggle" type="button" data-filter="mine">My venues</button>
        </div>
        <div id="venue-list" class="cards-grid"></div>
      </section>
    `);

    const list = document.getElementById("venue-list");
    const searchInput = document.getElementById("venue-search");
    const toggles = document.querySelectorAll(".toggle-group .toggle");

    function renderList(filter = "") {
      if (!list) return;
      const normalized = filter.toLowerCase();
      const filtered = state.venues.filter((venue) => {
        const claim = AdsState.getClaimByVenueId(state, venue.id);
        const isMine =
          venue.claimedBy === advertiser.id || (claim && claim.advertiserId === advertiser.id);
        if (activeFilter === "mine" && !isMine) {
          return false;
        }
        return (
          venue.name.toLowerCase().includes(normalized) ||
          venue.suburb.toLowerCase().includes(normalized)
        );
      });

      list.innerHTML = filtered
        .map((venue) => {
          const claim = AdsState.getClaimByVenueId(state, venue.id);
          const claimStatus = AdsState.getClaimStatusForVenue(state, venue.id);
          const isMine =
            venue.claimedBy === advertiser.id || (claim && claim.advertiserId === advertiser.id);
          const isClaimedByOther = venue.claimed && venue.claimedBy !== advertiser.id;
          let statusLabel = "Unclaimed";
          let statusClass = "unclaimed";
          let action = `<a class="button" href="#/claim?venueId=${venue.id}">Request claim</a>`;

          if (claimStatus === "pending") {
            statusLabel = "Claim pending review";
            statusClass = "pending";
            action = `<span class="button disabled">Pending</span>`;
          }

          if (claimStatus === "rejected") {
            statusLabel = "Claim rejected";
            statusClass = "rejected";
            action = `<a class="button ghost" href="#/claim?venueId=${venue.id}">Resubmit claim</a>`;
          }

          if (claimStatus === "approved") {
            statusLabel = "Approved";
            statusClass = "approved";
            if (isClaimedByOther) {
              statusLabel = "Claimed by another account";
              statusClass = "rejected";
              action = `<span class="button disabled">Unavailable</span>`;
            } else if (isMine) {
              action = `
                <div class="actions-row">
                  <a class="button ghost" href="#/campaigns">Manage venue</a>
                  <a class="button" href="#/campaigns">Create campaign</a>
                </div>
              `;
            } else {
              action = `<span class="button disabled">Unavailable</span>`;
            }
          }
          return `
            <article class="venue-card">
              <h3>${venue.name}</h3>
              <p class="muted">${venue.address}</p>
              <div class="tags">${venue.tags.map((tag) => `<span>${tag}</span>`).join("")}</div>
              <div class="venue-footer">
                <span class="status-pill ${statusClass}">${statusLabel}</span>
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

    if (toggles.length) {
      toggles.forEach((toggle) => {
        toggle.addEventListener("click", () => {
          toggles.forEach((button) => button.classList.remove("active"));
          toggle.classList.add("active");
          activeFilter = toggle.dataset.filter || "all";
          renderList(searchInput ? searchInput.value : "");
        });
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

    const existingClaim = AdsState.getClaimByVenueId(state, venueId);

    if (existingClaim && existingClaim.status !== "rejected") {
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
          advertiserId: advertiser.id,
          status: "pending",
          submittedAt: new Date().toISOString(),
          proofType,
          notes,
        };
        const nextState = AdsState.loadState();
        nextState.claims.unshift(claim);
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
    const profileComplete = AdsState.isProfileComplete(advertiser);
    const missingFields = AdsState.getMissingProfileFields(advertiser);
    const approvedVenues = state.venues.filter(
      (venue) => AdsState.isVenueApproved(state, venue.id) && venue.claimedBy === advertiser.id,
    );
    const hasApprovedVenues = approvedVenues.length > 0;
    const isBlocked = !profileComplete || !hasApprovedVenues;
    const missingFieldsList = missingFields
      .map((field) => `<li>${formatFieldLabel(field)}</li>`)
      .join("");

    render(`
      ${renderToast()}
      ${
        !profileComplete
          ? `
        <section class="card">
          <h2>Complete your profile to launch campaigns</h2>
          <p class="muted">We need a few more details before you can create campaigns.</p>
          <ul class="list">${missingFieldsList}</ul>
          <a class="button" href="#/profile">Complete profile</a>
        </section>
      `
          : ""
      }
      ${
        profileComplete && !hasApprovedVenues
          ? `
        <section class="card">
          <h2>You need an approved venue before creating campaigns</h2>
          <p class="muted">Submit a claim and wait for approval to launch Boost.</p>
          <a class="button" href="#/venues">Claim a venue</a>
        </section>
      `
          : ""
      }
      <section class="card">
        <h2>Create campaign</h2>
        <div id="campaign-error" class="banner danger" style="display:none;"></div>
        <form id="campaign-form" class="form">
          <label>
            Venue
            <select class="input" name="venueId" ${isBlocked ? "disabled" : ""}>
              ${
                approvedVenues.length
                  ? approvedVenues
                      .map((venue) => `<option value="${venue.id}">${venue.name}</option>`)
                      .join("")
                  : `<option value="">No approved venues yet</option>`
              }
            </select>
          </label>
          <fieldset class="plan-fieldset">
            <legend>Plan</legend>
            <label class="radio">
              <input type="radio" name="plan" value="boost" checked ${
                isBlocked ? "disabled" : ""
              } />
              Boost — $19 / month
            </label>
            <label class="radio">
              <input type="radio" name="plan" value="boost_plus" ${
                isBlocked ? "disabled" : ""
              } />
              Boost+ — $39 / month
            </label>
          </fieldset>
          <label>
            Radius (km)
            <input
              class="input"
              name="radiusKm"
              type="number"
              min="1"
              value="5"
              ${isBlocked ? "disabled" : ""}
            />
          </label>
          <label>
            Status
            <select class="input" name="status" ${isBlocked ? "disabled" : ""}>
              <option value="active" selected>Active</option>
              <option value="paused">Paused</option>
            </select>
          </label>
          <button
            type="submit"
            class="button ${isBlocked ? "disabled" : ""}"
            ${isBlocked ? 'aria-disabled="true"' : ""}
          >
            Create campaign
          </button>
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
    const errorBanner = document.getElementById("campaign-error");
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const latestState = AdsState.loadState();
        const latestAdvertiser = latestState.advertiser;
        const latestProfileComplete = AdsState.isProfileComplete(latestAdvertiser);
        const formData = new FormData(form);
        const venueId = formData.get("venueId");
        const selectedVenue = latestState.venues.find((venue) => venue.id === venueId);
        const venueApproved =
          selectedVenue &&
          AdsState.isVenueApproved(latestState, venueId) &&
          selectedVenue.claimedBy === latestAdvertiser.id;

        if (!latestProfileComplete) {
          if (errorBanner) {
            errorBanner.style.display = "block";
            errorBanner.textContent = "Complete your profile before creating campaigns.";
          }
          AdsState.logEvent("campaign_create_blocked", {
            reason: "profile_incomplete",
          });
          return;
        }

        if (!venueApproved) {
          if (errorBanner) {
            errorBanner.style.display = "block";
            errorBanner.textContent = "Select a venue with an approved claim to continue.";
          }
          AdsState.logEvent("campaign_create_blocked", {
            reason: "venue_not_approved",
          });
          return;
        }

        if (errorBanner) {
          errorBanner.style.display = "none";
        }
        const plan = formData.get("plan");
        const monthlyPrice = plan === "boost" ? 19 : 39;
        const campaign = {
          id: AdsState.createId("cmp"),
          venueId,
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

  function renderAdmin() {
    const state = AdsState.loadState();
    const isAdmin = state.adminMode;

    if (!isAdmin) {
      render(`
        <section class="card">
          <h2>Admin access only</h2>
          <p class="muted">Enable admin mode with <code>?admin=1</code> to review claims.</p>
          <a class="button" href="#/dashboard">Back to dashboard</a>
        </section>
      `);
      return;
    }

    const rows = state.claims.map((claim) => {
      const venue = state.venues.find((item) => item.id === claim.venueId);
      const status = claim.status || "pending";
      const statusClass = status;
      const actions =
        status === "pending"
          ? `
            <button class="button ghost" data-action="approve" data-id="${claim.id}">Approve</button>
            <button class="button danger" data-action="reject" data-id="${claim.id}">Reject</button>
          `
          : `
            <button class="button ghost" data-action="reset" data-id="${claim.id}">Reset to pending</button>
          `;
      return `
        <tr>
          <td>${venue ? venue.name : "Venue"}</td>
          <td>${formatDate(claim.submittedAt)}</td>
          <td>${claim.proofType || "-"}</td>
          <td>${claim.notes || "-"}</td>
          <td><span class="status-pill ${statusClass}">${status}</span></td>
          <td>
            <div class="actions-row">
              ${actions}
            </div>
          </td>
        </tr>
      `;
    });

    render(`
      ${renderToast()}
      <section class="card">
        <h2>Claim admin</h2>
        <p class="muted">Review and approve venue claims. Latest submissions appear first.</p>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Venue</th>
                <th>Submitted</th>
                <th>Proof</th>
                <th>Notes</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${
                rows.length
                  ? rows.join("")
                  : `<tr><td colspan="6" class="muted">No claims submitted yet.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </section>
    `);

    const table = document.querySelector("table");
    if (!table) return;
    table.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const action = button.dataset.action;
      const claimId = button.dataset.id;
      if (!action || !claimId) return;
      const nextState = AdsState.loadState();
      const claimIndex = nextState.claims.findIndex((item) => item.id === claimId);
      if (claimIndex === -1) return;
      const claim = nextState.claims[claimIndex];
      const venue = nextState.venues.find((item) => item.id === claim.venueId);
      if (!venue) return;

      if (action === "approve") {
        claim.status = "approved";
        venue.claimed = true;
        venue.claimedBy = claim.advertiserId;
        AdsState.logEvent("claim_approved", { venueId: venue.id });
        AdsState.pushDataLayer("ads_claim_approved", {
          venueId: venue.id,
          venueName: venue.name,
        });
        AdsRouter.setToast("Claim approved.");
      }

      if (action === "reject") {
        claim.status = "rejected";
        venue.claimed = false;
        venue.claimedBy = null;
        AdsState.logEvent("claim_rejected", { venueId: venue.id });
        AdsState.pushDataLayer("ads_claim_rejected", {
          venueId: venue.id,
          venueName: venue.name,
        });
        AdsRouter.setToast("Claim rejected.");
      }

      if (action === "reset") {
        claim.status = "pending";
        venue.claimed = false;
        venue.claimedBy = null;
        AdsRouter.setToast("Claim reset to pending.");
      }

      AdsState.saveState(nextState);
      renderAdmin();
    });
  }

  function renderResults() {
    const state = AdsState.loadState();
    const activeCampaigns = state.campaigns.filter(
      (campaign) => campaign.status === "active",
    );
    const now = new Date();
    const appearanceEvents = state.events.filter((event) => event.type === "appearance");
    const totalDelivered = appearanceEvents.filter((event) => event.meta && event.meta.venueId)
      .length;
    const offerReveals = state.events.filter((event) => event.type === "offer_reveal").length;
    const campaignRows = activeCampaigns.map((campaign) => {
      const venue = state.venues.find((item) => item.id === campaign.venueId);
      const guarantee = campaign.plan === "boost" ? 100 : 250;
      const delivered = appearanceEvents.filter(
        (event) => event.meta && event.meta.venueId === campaign.venueId,
      ).length;
      const percent = Math.min(100, Math.round((delivered / guarantee) * 100));
      const startDate = new Date(campaign.startDate);
      const daysElapsed = Math.min(
        30,
        Math.max(1, Math.floor((now - startDate) / (1000 * 60 * 60 * 24)) + 1),
      );
      const expectedRatio = daysElapsed / 30;
      const deliveryStatus = delivered / guarantee >= expectedRatio ? "On track" : "Needs more delivery";
      return `
        <article class="campaign-card">
          <h3>${venue ? venue.name : "Venue"} — ${campaign.plan === "boost" ? "Boost" : "Boost+"}</h3>
          <p class="muted">Guarantee: ${guarantee} promoted appearances/month</p>
          <p class="muted">Delivered this month: ${delivered}</p>
          <div class="progress">
            <span style="width: ${percent}%"></span>
          </div>
          <div class="status-row">
            <span class="status">${percent}% delivered</span>
            <span class="muted">${deliveryStatus}</span>
          </div>
        </article>
      `;
    });

    render(`
      ${renderToast()}
      <section class="card">
        <h2>Results (v0)</h2>
        <div class="stats">
          <div>
            <span class="label">Promoted appearances delivered</span>
            <strong>${totalDelivered}</strong>
            <span class="muted">Tracked for approved venues.</span>
          </div>
          <div>
            <span class="label">Offer reveals</span>
            <strong>${offerReveals}</strong>
            <span class="muted">Based on simulated events.</span>
          </div>
          <div>
            <span class="label">Simulated appearances</span>
            <strong>${appearanceEvents.length}</strong>
            <span class="muted">Manual test events.</span>
          </div>
        </div>
        <div class="actions-row">
          <button class="button ghost" id="btn-appearance">Simulate promoted appearance</button>
          <button class="button" id="btn-reveal">Simulate offer reveal</button>
        </div>
      </section>
      <section class="card">
        <h2>Campaign delivery</h2>
        ${
          campaignRows.length
            ? `<div class="cards-grid">${campaignRows.join("")}</div>`
            : `<p class="muted">No active campaigns to report yet.</p>`
        }
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
        const latestState = AdsState.loadState();
        const activeCampaign = latestState.campaigns.find(
          (campaign) => campaign.status === "active",
        );
        AdsState.logEvent("appearance", {
          source: "simulator",
          venueId: activeCampaign ? activeCampaign.venueId : null,
        });
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
    admin: renderAdmin,
    results: renderResults,
  };
})();

window.AdsViews = AdsViews;
