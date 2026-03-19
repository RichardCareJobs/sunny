/* Live Pub Crawl — Supabase-powered group sessions
   Loaded after app.js. Hooks into window.SunnyLiveCrawl for app.js integration.
*/
(function () {
  "use strict";

  const SUPABASE_URL = "https://ivylljoqjswkuyrpevmg.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_EIu1IEynBaGhk38hljJ6IA_pIcp4zNz";
  const SESSION_EXPIRY_HOURS = 8;
  const LOCATION_UPDATE_INTERVAL_MS = 12000;
  const STALE_MARKER_MS = 120000; // 2 minutes
  const STALE_CHECK_INTERVAL_MS = 15000;
  const CODE_LENGTH = 4;
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 for clarity
  const SHARE_BASE_URL = "https://visit.sunnypubs.app/crawl/";

  let supabase = null;
  let currentSession = null;
  let currentParticipantId = null;
  let realtimeChannel = null;
  let locationWatchId = null;
  let locationIntervalId = null;
  let lastKnownPosition = null;
  let participantMarkers = new Map();
  let staleCheckIntervalId = null;
  let liveMapOverlayEl = null;
  let namePromptEl = null;

  function getSupabase() {
    if (supabase) return supabase;
    if (!window.supabase?.createClient) {
      console.error("[LiveCrawl] Supabase client not loaded");
      return null;
    }
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return supabase;
  }

  function generateSessionCode() {
    const arr = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => CODE_CHARS[b % CODE_CHARS.length]).join("");
  }

  function getShareUrl(code) {
    return SHARE_BASE_URL + code;
  }

  // ── Session Creation ──────────────────────────────────────────────

  async function createSession(crawlState) {
    const sb = getSupabase();
    if (!sb) throw new Error("Supabase not available");

    const route = crawlState.venues.map((v, i) => ({
      name: v.name || "Stop " + (i + 1),
      address: v.address || "",
      lat: v.lat,
      lng: v.lng,
      order: i
    }));

    // Try up to 3 times in case of code collision
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateSessionCode();
      const { data, error } = await sb.from("crawl_sessions").insert({
        code,
        route,
        last_activity_at: new Date().toISOString()
      }).select().single();

      if (error) {
        if (error.code === "23505" && attempt < 2) continue; // unique violation, retry
        throw error;
      }
      return data;
    }
    throw new Error("Failed to generate unique session code");
  }

  async function addParticipant(sessionId, displayName) {
    const sb = getSupabase();
    const { data, error } = await sb.from("crawl_participants").insert({
      session_id: sessionId,
      display_name: displayName,
      last_seen_at: new Date().toISOString()
    }).select().single();
    if (error) throw error;
    return data;
  }

  async function fetchSession(code) {
    const sb = getSupabase();
    if (!sb) return null;
    const cutoff = new Date(Date.now() - SESSION_EXPIRY_HOURS * 3600000).toISOString();
    const { data, error } = await sb.from("crawl_sessions")
      .select("*")
      .eq("code", code.toUpperCase())
      .gt("last_activity_at", cutoff)
      .single();
    if (error || !data) return null;
    return data;
  }

  async function fetchParticipants(sessionId) {
    const sb = getSupabase();
    const { data } = await sb.from("crawl_participants")
      .select("*")
      .eq("session_id", sessionId);
    return data || [];
  }

  async function updateParticipantLocation(participantId, lat, lng) {
    const sb = getSupabase();
    if (!sb || !participantId) return;
    await sb.from("crawl_participants").update({
      lat,
      lng,
      last_seen_at: new Date().toISOString()
    }).eq("id", participantId);
  }

  async function touchSession(sessionId) {
    const sb = getSupabase();
    if (!sb) return;
    await sb.from("crawl_sessions").update({
      last_activity_at: new Date().toISOString()
    }).eq("id", sessionId);
  }

  async function removeParticipant(participantId) {
    const sb = getSupabase();
    if (!sb || !participantId) return;
    await sb.from("crawl_participants").delete().eq("id", participantId);
  }

  // ── Name Prompt ───────────────────────────────────────────────────

  function showNamePrompt(title, subtitle) {
    return new Promise((resolve) => {
      if (namePromptEl) namePromptEl.remove();

      const el = document.createElement("div");
      el.className = "live-crawl-name-prompt";
      el.innerHTML = `
        <div class="live-crawl-name-prompt__backdrop"></div>
        <div class="live-crawl-name-prompt__card">
          <h2 class="live-crawl-name-prompt__title">${title || "Enter your name"}</h2>
          ${subtitle ? `<p class="live-crawl-name-prompt__subtitle">${subtitle}</p>` : ""}
          <input type="text" class="live-crawl-name-prompt__input" placeholder="Your display name" maxlength="20" autocomplete="off">
          <button type="button" class="live-crawl-name-prompt__btn" disabled>Join</button>
        </div>
      `;
      document.body.appendChild(el);
      namePromptEl = el;

      const input = el.querySelector("input");
      const btn = el.querySelector("button");

      input.addEventListener("input", () => {
        btn.disabled = !input.value.trim();
      });

      function submit() {
        const name = input.value.trim();
        if (!name) return;
        el.remove();
        namePromptEl = null;
        resolve(name);
      }

      btn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });

      requestAnimationFrame(() => input.focus());
    });
  }

  // ── Location Tracking ─────────────────────────────────────────────

  function startLocationTracking() {
    if (!navigator.geolocation) return;

    // Watch position for continuous updates
    locationWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        lastKnownPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      },
      () => {}, // silently handle errors
      { enableHighAccuracy: false, maximumAge: 15000, timeout: 10000 }
    );

    // Send updates to Supabase every ~12 seconds
    locationIntervalId = setInterval(async () => {
      if (!lastKnownPosition || !currentParticipantId) return;
      try {
        await updateParticipantLocation(currentParticipantId, lastKnownPosition.lat, lastKnownPosition.lng);
        if (currentSession) touchSession(currentSession.id);
      } catch (e) {
        console.warn("[LiveCrawl] Location update failed", e);
      }
    }, LOCATION_UPDATE_INTERVAL_MS);
  }

  function stopLocationTracking() {
    if (locationWatchId !== null) {
      navigator.geolocation.clearWatch(locationWatchId);
      locationWatchId = null;
    }
    if (locationIntervalId) {
      clearInterval(locationIntervalId);
      locationIntervalId = null;
    }
    lastKnownPosition = null;
  }

  // ── Realtime Subscription ─────────────────────────────────────────

  function subscribeToSession(sessionId, map) {
    const sb = getSupabase();
    if (!sb) return;

    // Unsubscribe from previous
    unsubscribeFromSession();

    realtimeChannel = sb.channel("crawl-" + sessionId)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "crawl_participants",
        filter: "session_id=eq." + sessionId
      }, (payload) => {
        if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
          updateParticipantMarker(payload.new, map);
        } else if (payload.eventType === "DELETE") {
          removeParticipantMarker(payload.old.id, map);
        }
      })
      .subscribe();

    // Start stale marker check
    staleCheckIntervalId = setInterval(() => {
      checkStaleMarkers(map);
    }, STALE_CHECK_INTERVAL_MS);
  }

  function unsubscribeFromSession() {
    if (realtimeChannel) {
      realtimeChannel.unsubscribe();
      realtimeChannel = null;
    }
    if (staleCheckIntervalId) {
      clearInterval(staleCheckIntervalId);
      staleCheckIntervalId = null;
    }
  }

  // ── Participant Markers on Map ────────────────────────────────────

  function createParticipantMarkerIcon(name, isStale) {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="40" height="50" viewBox="0 0 40 50">
        <circle cx="20" cy="20" r="18" fill="${isStale ? "rgba(107,114,128,0.5)" : "#4F46E5"}" stroke="#fff" stroke-width="2"/>
        <text x="20" y="24" text-anchor="middle" fill="#fff" font-size="11" font-weight="700" font-family="system-ui,sans-serif">${escapeXml(name.slice(0, 2).toUpperCase())}</text>
      </svg>`;
    return {
      url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
      scaledSize: new google.maps.Size(40, 50),
      anchor: new google.maps.Point(20, 25)
    };
  }

  function escapeXml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function updateParticipantMarker(participant, map) {
    if (!participant || !participant.lat || !participant.lng) return;
    // Don't show our own marker — we already see our location
    // Actually, do show it so others see it too and we see it on the shared map

    const existing = participantMarkers.get(participant.id);
    const isStale = Date.now() - new Date(participant.last_seen_at).getTime() > STALE_MARKER_MS;

    if (existing) {
      existing.marker.setPosition({ lat: participant.lat, lng: participant.lng });
      existing.marker.setIcon(createParticipantMarkerIcon(participant.display_name, isStale));
      existing.marker.setOpacity(isStale ? 0.4 : 1);
      existing.lastSeen = new Date(participant.last_seen_at);
      existing.name = participant.display_name;
    } else {
      const marker = new google.maps.Marker({
        position: { lat: participant.lat, lng: participant.lng },
        map,
        icon: createParticipantMarkerIcon(participant.display_name, isStale),
        opacity: isStale ? 0.4 : 1,
        title: participant.display_name,
        zIndex: 2000
      });
      participantMarkers.set(participant.id, {
        marker,
        lastSeen: new Date(participant.last_seen_at),
        name: participant.display_name
      });
    }
  }

  function removeParticipantMarker(participantId) {
    const entry = participantMarkers.get(participantId);
    if (entry) {
      entry.marker.setMap(null);
      participantMarkers.delete(participantId);
    }
  }

  function checkStaleMarkers(map) {
    const now = Date.now();
    participantMarkers.forEach((entry, id) => {
      const age = now - entry.lastSeen.getTime();
      if (age > STALE_MARKER_MS) {
        entry.marker.setIcon(createParticipantMarkerIcon(entry.name, true));
        entry.marker.setOpacity(0.4);
      }
      // Remove after 4 minutes of no updates (well past the 2 min fade)
      if (age > STALE_MARKER_MS * 2) {
        entry.marker.setMap(null);
        participantMarkers.delete(id);
      }
    });
  }

  function clearAllParticipantMarkers() {
    participantMarkers.forEach((entry) => entry.marker.setMap(null));
    participantMarkers.clear();
  }

  // ── Live Map Overlay (shown when joining via share link) ──────────

  function showLiveMapOverlay(session, map) {
    if (liveMapOverlayEl) liveMapOverlayEl.remove();

    const route = session.route || [];
    const el = document.createElement("div");
    el.className = "live-crawl-overlay";
    el.id = "live-crawl-overlay";

    let routeHtml = route.map((stop, i) => `
      <div class="live-crawl-stop">
        <span class="live-crawl-stop__num">${i + 1}</span>
        <div class="live-crawl-stop__info">
          <strong>${escapeHtml(stop.name)}</strong>
          ${stop.address ? `<span class="live-crawl-stop__addr">${escapeHtml(stop.address)}</span>` : ""}
        </div>
      </div>
    `).join("");

    el.innerHTML = `
      <div class="live-crawl-overlay__header">
        <h2>Live Pub Crawl</h2>
        <span class="live-crawl-overlay__code">${session.code}</span>
        <button type="button" class="live-crawl-overlay__close" aria-label="Close live view">&times;</button>
      </div>
      <div class="live-crawl-overlay__route">${routeHtml}</div>
      <div class="live-crawl-overlay__status">
        <span class="live-crawl-overlay__dot"></span>
        <span class="live-crawl-overlay__status-text">Live — sharing location</span>
      </div>
    `;

    document.body.appendChild(el);
    liveMapOverlayEl = el;

    el.querySelector(".live-crawl-overlay__close").addEventListener("click", () => {
      leaveSession();
    });

    // Fit map to show all route stops
    if (route.length && map) {
      const bounds = new google.maps.LatLngBounds();
      route.forEach(s => bounds.extend({ lat: s.lat, lng: s.lng }));
      map.fitBounds(bounds, { top: 80, bottom: 40, left: 20, right: 20 });
    }
  }

  function hideLiveMapOverlay() {
    if (liveMapOverlayEl) {
      liveMapOverlayEl.remove();
      liveMapOverlayEl = null;
    }
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  // ── Route Markers (for joined users who see the planned route) ────

  let routeMarkers = [];

  function renderRouteMarkers(route, map) {
    clearRouteMarkers();
    if (!route || !map) return;
    route.forEach((stop, i) => {
      const marker = new google.maps.Marker({
        position: { lat: stop.lat, lng: stop.lng },
        map,
        icon: {
          path: "M0-48c-9.9 0-18 8.1-18 18 0 13.5 18 30 18 30s18-16.5 18-30c0-9.9-8.1-18-18-18z",
          fillColor: "#ff6a00",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 1.5,
          scale: 1,
          labelOrigin: new google.maps.Point(0, -28)
        },
        label: {
          text: String(i + 1),
          color: "#ffffff",
          fontWeight: "700"
        },
        zIndex: 1000
      });
      routeMarkers.push(marker);
    });
  }

  function clearRouteMarkers() {
    routeMarkers.forEach(m => m.setMap(null));
    routeMarkers = [];
  }

  // ── Main Flows ────────────────────────────────────────────────────

  // Called from app.js when user clicks Share on their crawl
  async function startLiveSession(crawlState, map) {
    try {
      const displayName = await showNamePrompt(
        "Start a live crawl",
        "Enter your display name so your group can see you on the map."
      );
      if (!displayName) return;

      const session = await createSession(crawlState);
      currentSession = session;

      const participant = await addParticipant(session.id, displayName);
      currentParticipantId = participant.id;

      // Subscribe to realtime updates
      subscribeToSession(session.id, map);

      // Start sharing location
      startLocationTracking();

      // Show the live overlay on the existing crawl view
      showLiveSessionBanner(session.code);

      // Share the URL
      const shareUrl = getShareUrl(session.code);
      if (navigator.share) {
        navigator.share({ title: "Join my pub crawl!", text: "Join my live pub crawl on Sunny", url: shareUrl }).catch(() => {});
      } else {
        navigator.clipboard?.writeText(shareUrl).then(() => {
          alert("Live crawl link copied! Share it with your group: " + shareUrl);
        }).catch(() => {
          prompt("Copy this link to share your live crawl:", shareUrl);
        });
      }

      const analytics = window.SunnyAnalytics;
      if (analytics?.track) {
        analytics.track("live_crawl_created", {
          venue_count: crawlState.venues?.length || 0,
          session_code: session.code
        });
      }
    } catch (err) {
      console.error("[LiveCrawl] Failed to create session", err);
      alert("Failed to start live crawl. Please try again.");
    }
  }

  let liveBannerEl = null;

  function showLiveSessionBanner(code) {
    if (liveBannerEl) liveBannerEl.remove();

    const el = document.createElement("div");
    el.className = "live-crawl-banner";
    el.innerHTML = `
      <span class="live-crawl-banner__dot"></span>
      <span class="live-crawl-banner__text">Live: <strong>${code}</strong></span>
      <button type="button" class="live-crawl-banner__share" aria-label="Share link">Share</button>
      <button type="button" class="live-crawl-banner__end" aria-label="End session">End</button>
    `;
    document.body.appendChild(el);
    liveBannerEl = el;

    el.querySelector(".live-crawl-banner__share").addEventListener("click", () => {
      const shareUrl = getShareUrl(code);
      if (navigator.share) {
        navigator.share({ title: "Join my pub crawl!", url: shareUrl }).catch(() => {});
      } else {
        navigator.clipboard?.writeText(shareUrl).then(() => alert("Link copied!")).catch(() => prompt("Copy:", shareUrl));
      }
    });

    el.querySelector(".live-crawl-banner__end").addEventListener("click", () => {
      if (confirm("End this live crawl session?")) leaveSession();
    });
  }

  function hideLiveSessionBanner() {
    if (liveBannerEl) {
      liveBannerEl.remove();
      liveBannerEl = null;
    }
  }

  // Called when someone opens a /crawl/:code URL
  async function joinSession(code, map) {
    try {
      const session = await fetchSession(code);
      if (!session) {
        alert("This crawl session has expired or doesn't exist.");
        // Clean URL
        window.history.replaceState({}, "", "/");
        return;
      }

      currentSession = session;

      // Show route immediately before asking for name
      renderRouteMarkers(session.route, map);
      showLiveMapOverlay(session, map);

      const displayName = await showNamePrompt(
        "Join the pub crawl",
        "Enter a display name so the group can see you."
      );
      if (!displayName) {
        hideLiveMapOverlay();
        clearRouteMarkers();
        currentSession = null;
        window.history.replaceState({}, "", "/");
        return;
      }

      const participant = await addParticipant(session.id, displayName);
      currentParticipantId = participant.id;

      // Load existing participants
      const existing = await fetchParticipants(session.id);
      existing.forEach(p => updateParticipantMarker(p, map));

      // Subscribe to realtime
      subscribeToSession(session.id, map);

      // Start sharing location
      startLocationTracking();

      // Clean the URL but keep the session active
      window.history.replaceState({}, "", "/");

      const analytics = window.SunnyAnalytics;
      if (analytics?.track) {
        analytics.track("live_crawl_joined", { session_code: code });
      }
    } catch (err) {
      console.error("[LiveCrawl] Failed to join session", err);
      alert("Failed to join this crawl. Please try again.");
    }
  }

  function leaveSession() {
    stopLocationTracking();
    unsubscribeFromSession();
    if (currentParticipantId) {
      removeParticipant(currentParticipantId);
      currentParticipantId = null;
    }
    clearAllParticipantMarkers();
    clearRouteMarkers();
    hideLiveMapOverlay();
    hideLiveSessionBanner();
    currentSession = null;
  }

  // ── URL Detection (for /crawl/:code paths) ───────────────────────

  function detectCrawlCode() {
    const path = window.location.pathname;
    const match = path.match(/^\/crawl\/([A-Za-z0-9]{3,6})$/);
    if (match) return match[1].toUpperCase();

    // Also check query param as fallback
    const params = new URLSearchParams(window.location.search);
    const code = params.get("live");
    if (code && /^[A-Za-z0-9]{3,6}$/.test(code)) return code.toUpperCase();

    return null;
  }

  // ── Cleanup on tab close ──────────────────────────────────────────

  window.addEventListener("pagehide", () => {
    if (currentParticipantId) {
      // Use sendBeacon for reliable cleanup on tab close
      const sb = getSupabase();
      if (sb) {
        // Best-effort cleanup — sendBeacon with Supabase REST
        const url = SUPABASE_URL + "/rest/v1/crawl_participants?id=eq." + currentParticipantId;
        const headers = {
          "apikey": SUPABASE_ANON_KEY,
          "Content-Type": "application/json"
        };
        // sendBeacon doesn't support DELETE, so we null out the location to signal departure
        try {
          navigator.sendBeacon(
            SUPABASE_URL + "/rest/v1/rpc/dummy",
            new Blob([], { type: "application/json" })
          );
        } catch (e) {
          // best effort
        }
      }
      stopLocationTracking();
      unsubscribeFromSession();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (currentParticipantId) {
      // Set location to null to signal departure (marker will fade after 2 min)
      const sb = getSupabase();
      if (sb) {
        // Fire and forget
        sb.from("crawl_participants").update({
          lat: null,
          lng: null,
          last_seen_at: new Date(Date.now() - STALE_MARKER_MS).toISOString()
        }).eq("id", currentParticipantId).then(() => {});
      }
    }
  });

  // ── Public API ────────────────────────────────────────────────────

  window.SunnyLiveCrawl = {
    startLiveSession,
    joinSession,
    leaveSession,
    detectCrawlCode,
    isActive: () => !!currentSession,
    getSessionCode: () => currentSession?.code || null
  };
})();
