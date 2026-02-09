const ADS_STORAGE_KEY = "sunny_ads_state_v0";

const DEFAULT_VENUES = [
  {
    id: "v_001",
    name: "The Sunny Hotel",
    address: "123 Example St, Pyrmont NSW",
    suburb: "Pyrmont",
    tags: ["pub"],
    claimed: false,
    claimedBy: null,
  },
  {
    id: "v_002",
    name: "Harbour Taproom",
    address: "5 Wharf Rd, Barangaroo NSW",
    suburb: "Barangaroo",
    tags: ["bar"],
    claimed: false,
    claimedBy: null,
  },
  {
    id: "v_003",
    name: "Golden Hour Arms",
    address: "88 King St, Newtown NSW",
    suburb: "Newtown",
    tags: ["pub"],
    claimed: false,
    claimedBy: null,
  },
  {
    id: "v_004",
    name: "The Courtyard",
    address: "12 Queen St, Surry Hills NSW",
    suburb: "Surry Hills",
    tags: ["pub"],
    claimed: false,
    claimedBy: null,
  },
  {
    id: "v_005",
    name: "Rooftop Social",
    address: "9 High Ln, Darlinghurst NSW",
    suburb: "Darlinghurst",
    tags: ["bar"],
    claimed: false,
    claimedBy: null,
  },
];

function createId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36)}`;
}

function ensureAdvertiser(advertiser) {
  if (advertiser && advertiser.id) {
    return advertiser;
  }
  return {
    id: createId("adv"),
    businessName: "",
    contactName: "",
    email: "",
    phone: "",
    abn: "",
    suburb: "",
    state: "NSW",
    createdAt: new Date().toISOString(),
  };
}

function loadState() {
  const raw = window.localStorage.getItem(ADS_STORAGE_KEY);
  if (!raw) {
    const seeded = {
      advertiser: ensureAdvertiser(null),
      venues: DEFAULT_VENUES,
      claims: [],
      campaigns: [],
      events: [],
    };
    saveState(seeded);
    return seeded;
  }

  try {
    const parsed = JSON.parse(raw);
    const nextState = {
      advertiser: ensureAdvertiser(parsed.advertiser),
      venues: parsed.venues && parsed.venues.length ? parsed.venues : DEFAULT_VENUES,
      claims: parsed.claims || [],
      campaigns: parsed.campaigns || [],
      events: parsed.events || [],
    };
    saveState(nextState);
    return nextState;
  } catch (error) {
    const fallback = {
      advertiser: ensureAdvertiser(null),
      venues: DEFAULT_VENUES,
      claims: [],
      campaigns: [],
      events: [],
    };
    saveState(fallback);
    return fallback;
  }
}

function saveState(state) {
  window.localStorage.setItem(ADS_STORAGE_KEY, JSON.stringify(state));
}

function pushDataLayer(event, meta = {}) {
  if (window.dataLayer) {
    window.dataLayer.push({ event, ...meta });
  }
}

function logEvent(type, meta = {}) {
  const state = loadState();
  const entry = { ts: new Date().toISOString(), type, meta };
  state.events.unshift(entry);
  saveState(state);
  pushDataLayer(type, meta);
  return entry;
}

function getClaimForVenue(venueId) {
  const state = loadState();
  return state.claims.find((claim) => claim.venueId === venueId) || null;
}

function getCampaignsForVenue(venueId) {
  const state = loadState();
  return state.campaigns.filter((campaign) => campaign.venueId === venueId);
}

window.AdsState = {
  ADS_STORAGE_KEY,
  DEFAULT_VENUES,
  loadState,
  saveState,
  logEvent,
  pushDataLayer,
  getClaimForVenue,
  getCampaignsForVenue,
  createId,
};
