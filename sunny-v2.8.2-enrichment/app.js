// Sunny v2.7 — mobile map fix (inline Leaflet CSS), Uber action, broader outdoor heuristic, details parity
const AUSTRALIA_CENTER = { lat: -25.2744, lon: 133.7751 };
let preference = "full";
let outdoorOnly = true;
let distanceFilter = 'all';
let openNowOnly = false;
let venues = [];
let markers = [];
let userLoc = null;
let firstRun = localStorage.getItem('sunny-first-run-done') !== 'true' ? true : false;

// Map
const map = L.map('map', { zoomControl: true }).setView([AUSTRALIA_CENTER.lat, AUSTRALIA_CENTER.lon], 4);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap, &copy; CARTO' }).addTo(map);


// === Enrichment cache & fetch ===

const ENRICH_ENDPOINT = (window.SUNNY_ENRICH_ENDPOINT || '').trim();
const ENRICH_ENABLED = ENRICH_ENDPOINT.length > 0;
let loggedEnrichDisabled = false;

function labelFromEnrichedHours(hoursObj){
  if (!hoursObj) return null;
  if (typeof hoursObj.open_now === 'boolean') return hoursObj.open_now ? 'Open now' : 'Closed';
  if (typeof hoursObj.status === 'string' && hoursObj.status.trim()) return hoursObj.status;
  if (typeof hoursObj.display === 'string' && hoursObj.display.trim()) return hoursObj.display;
  if (typeof hoursObj.text === 'string' && hoursObj.text.trim()) return hoursObj.text;
  return null;
}

const ENRICH_CACHE_TTL = 7 * 24 * 3600 * 1000; // 7 days
function getEnrichCache(id){
  try {
    const raw = localStorage.getItem('sunny:enrich:' + id);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj.ts || (Date.now() - obj.ts) > ENRICH_CACHE_TTL) return null;
    return obj.data;
  } catch (e) { console.warn('Enrich error', e); return null; }
}
function setEnrichCache(id, data){
  try { localStorage.setItem('sunny:enrich:' + id, JSON.stringify({ ts: Date.now(), data })); } catch {}
}
function buildEnrichUrl(base, params){
  const hasQuery = base.includes('?');
  const needsSeparator = hasQuery ? !(base.endsWith('?') || base.endsWith('&')) : true;
  const sep = hasQuery ? (needsSeparator ? '&' : '') : '?';
  return base + sep + params.toString();
}

async function enrichVenue(v){
  if (!ENRICH_ENABLED) {
    if (!loggedEnrichDisabled) {
      console.info('Enrichment disabled: no SUNNY_ENRICH_ENDPOINT configured.');
      loggedEnrichDisabled = true;
    }
    return null;
  }
  if (!(location.protocol === 'http:' || location.protocol === 'https:')) { console.debug('Enrich skipped (not http/https)'); return null; }

  const cached = getEnrichCache(v.id);
  if (cached) return cached;
  const params = new URLSearchParams({ name: v.name, lat: v.lat, lon: v.lon });
  if (v.wikidata) params.set('wikidata', v.wikidata);
  if (v.id) params.set('osm_id', v.id);
  try {
    const url = buildEnrichUrl(ENRICH_ENDPOINT, params);
    console.debug('Enrich fetch →', url);
    const res = await fetch(url, { headers: { 'Accept':'application/json' } });
    if (!res.ok) throw new Error('enrich fail');
    const json = await res.json();
    setEnrichCache(v.id, json);
    return json;
  } catch (e) { console.warn('Enrich error', e); return null; }
}

// Marker
const markerIcon = L.icon({ iconUrl: '/icons/marker.png', iconSize: [32,32], iconAnchor: [16,16], popupAnchor: [0,-16] });

// Elements
const locCard = document.getElementById('locCard');
const allowLoc = document.getElementById('allowLoc');
const denyLoc = document.getElementById('denyLoc');
const cardsEl = document.getElementById('cards');
const listPanel = document.getElementById('listPanel');
const resultHint = document.getElementById('resultHint');
const viewMapBtn = document.getElementById('viewMap');
const viewListBtn = document.getElementById('viewList');

function kmBetween(a, b) {
  const R=6371, toRad=x=>x*Math.PI/180;
  const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
function formatDistanceKm(d){ if (d < 1) return Math.round(d*1000) + ' m'; return d.toFixed(1) + ' km'; }

// Overpass
const OVERPASS_CACHE_PREFIX = 'sunny-pubs-overpass-tiles-v2:';
const OVERPASS_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const OVERPASS_ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter'
];
let overpassIdx = 0;
function nextOverpassEndpoint(){ overpassIdx = (overpassIdx + 1) % OVERPASS_ENDPOINTS.length; return OVERPASS_ENDPOINTS[overpassIdx]; }
function bboxKey(b) { const f = x => x.toFixed(2); return `${f(b.getSouth())},${f(b.getWest())},${f(b.getNorth())},${f(b.getEast())}`; }
function getCachedTile(key){
  try { const raw = localStorage.getItem(OVERPASS_CACHE_PREFIX + key); if (!raw) return null;
        const obj = JSON.parse(raw); if (!obj.ts || (Date.now() - obj.ts) > OVERPASS_CACHE_TTL_MS) return null; return obj.data; } catch { return null; }
}
function setCachedTile(key,data){ try { localStorage.setItem(OVERPASS_CACHE_PREFIX + key, JSON.stringify({ts:Date.now(), data})); } catch {} }
let overpassDebounce = null;

async function fetchOverpassFor(b) {
  const key = bboxKey(b);
  const cached = getCachedTile(key);
  if (cached) return cached;

  const sw = b.getSouthWest(), ne = b.getNorthEast();
  const bbox = [sw.lat, sw.lng, ne.lat, ne.lng].join(',');
  const q = `[out:json][timeout:25];
    (
      node["amenity"~"pub|bar|biergarten"](${bbox});
      way["amenity"~"pub|bar|biergarten"](${bbox});
      relation["amenity"~"pub|bar|biergarten"](${bbox});
    );
    out center tags;`;

  for (let i=0;i<OVERPASS_ENDPOINTS.length;i++) {
    const endpoint = OVERPASS_ENDPOINTS[overpassIdx];
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8', 'Accept':'application/json' },
        body: new URLSearchParams({ data: q })
      });
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      setCachedTile(key, json);
      return json;
    } catch (e) { nextOverpassEndpoint(); }
  }
  throw new Error('Overpass failed');
}

// Outdoor heuristic (broader but respects explicit no)
function hasOutdoor(tags){
  const val = (x) => (typeof x === 'string') ? x.trim().toLowerCase() : x;
  const pos = new Set(['yes','designated','covered','pergola','roofed','terrace','garden','seating','tables','limited']);
  const v = {
    amenity: val(tags.amenity),
    beer_garden: val(tags.beer_garden),
    outdoor_seating: val(tags['outdoor_seating']),
    terrace: val(tags.terrace),
    garden: val(tags.garden),
    courtyard: val(tags.courtyard),
    seating_outside: val(tags['seating:outside']),
  };
  if (v.beer_garden === 'no' || v.outdoor_seating == 'no' || v.terrace == 'no' || v.garden == 'no') return false;
  if (v.amenity === 'biergarten') return true;
  if (v.beer_garden && v.beer_garden != 'no') return true;
  if (v.outdoor_seating && v.outdoor_seating != 'no') return true;
  if (v.terrace && v.terrace != 'no') return true;
  if (v.garden && v.garden != 'no') return true;
  if (v.courtyard && v.courtyard != 'no') return true;
  if (v.seating_outside && v.seating_outside != 'no') return true;
  return false;
}

function normalizeOverpass(json){
  const out = [];
  if (!json || !json.elements) return out;
  for (const el of json.elements) {
    const tags = el.tags || {};
    const lat = el.lat || (el.center && el.center.lat);
    const lon = el.lon || (el.center && el.center.lon);
    if (lat == null || lon == null) continue;
    const id = (tags.name || 'venue').toLowerCase().replace(/[^a-z0-9]+/g,'-') + '-' + el.id;
    out.push({
      id, name: tags.name || 'Unnamed',
      lat, lon,
      hasClearOutdoor: hasOutdoor(tags),
      opening_hours: tags.opening_hours || null,
      website: tags.website || null,
      phone: tags.phone || tags['contact:phone'] || null,
      addr: [tags['addr:housenumber'], tags['addr:street'], tags['addr:suburb'] || tags.suburb, tags['addr:city'] || tags.city].filter(Boolean).join(', '), wikidata: tags.wikidata || null
    });
  }
  return out;
}

// Opening-hours helpers
function isOpenNow(v, when=new Date()){
  if (!openNowOnly) return true;
  if (!v.opening_hours) return false;
  try { const oh = new opening_hours(v.opening_hours, null, { address: null }); return oh.getState(when); } catch { return false; }
}
function openStateLabel(v, when=new Date()){
  if (!v.opening_hours) return 'Hours unknown';
  try {
    const oh = new opening_hours(v.opening_hours, null, { address: null });
    const state = oh.getState(when);
    if (state) {
      const until = oh.getNextChange(when);
      const mins = Math.max(0, Math.round((until - when)/60000));
      if (mins <= 45) return 'Closing soon';
      return 'Open now';
    } else {
      const next = oh.getNextChange(when);
      if (next) { const h = String(next.getHours()).padStart(2,'0'), m = String(next.getMinutes()).padStart(2,'0'); return `Opens ${h}:${m}`; }
      return 'Closed';
    }
  } catch { return 'Hours unknown'; }
}

// UI: pre-permission
function showLocPrompt(){ locCard.classList.add('show'); }
function hideLocPrompt(){ locCard.classList.remove('show'); }
allowLoc?.addEventListener('click', () => { hideLocPrompt(); requestGeo(); });
denyLoc?.addEventListener('click', () => { hideLocPrompt(); localStorage.setItem('sunny-first-run-done','true'); map.fire('moveend'); });

function requestGeo(){
  if (!navigator.geolocation) { map.fire('moveend'); return; }
  navigator.geolocation.getCurrentPosition((pos) => {
    userLoc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    map.setView([userLoc.lat, userLoc.lon], 14);
    localStorage.setItem('sunny-first-run-done','true');
    map.fire('moveend');
  }, () => { map.fire('moveend'); }, { enableHighAccuracy: true, timeout: 8000 });
}

// Rendering helpers
function clearMarkers(){ for (const m of markers) m.remove(); markers = []; }
function addMarkers(list){
  for (const v of list) {
    const m = L.marker([v.lat, v.lon], { icon: markerIcon }).addTo(map);
    markers.push(m);
    m.on('click', () => openDetail(v));
  }
}
function inViewport(v){ return map.getBounds().contains([v.lat, v.lon]); }
function withinDistance(v){
  if (distanceFilter === 'all' || !userLoc) return true;
  const d = kmBetween({lat:userLoc.lat, lon:userLoc.lon}, {lat:v.lat, lon:v.lon});
  const lim = parseFloat(distanceFilter);
  return d <= lim;
}
function filterList(){
  return venues.filter(v => inViewport(v) && (!openNowOnly || isOpenNow(v)) && withinDistance(v) && (!outdoorOnly || v.hasClearOutdoor));
}

function uberLink(lat, lon){
  const d = encodeURIComponent(`${lat},${lon}`);
  return `https://m.uber.com/ul/?action=setPickup&dropoff[latitude]=${lat}&dropoff[longitude]=${lon}`;
}
function didiLink(lat, lon){
  return 'https://www.didiglobal.com/';
}


async function enhanceAndUpdateCard(v, el){
  const data = await enrichVenue(v);
  if (!data) return;
  let phone = v.phone || data.phone || '';
  let website = v.website || data.website || '';
  let attrib = '';
  if (data) console.debug('Enriched', v.name, data);
  if (data && data.source && data.source.length) {
    attrib = `<div class="tiny">ⓘ data via ${data.source.join(', ')}</div>`;
  }
  // Update actions
  const callLink = el.querySelector('a[data-call]');
  const webLink = el.querySelector('a[data-web]');
  if (phone && callLink){ callLink.href = `tel:${phone}`; callLink.style.display = 'inline-block'; }
  if (website && webLink){ webLink.href = website; webLink.style.display = 'inline-block'; }
  // Hours label update
  const hoursLabel = labelFromEnrichedHours(data && data.hours);
  if (hoursLabel) {
    const hs = el.querySelector('[data-hours]'); if (hs) hs.textContent = hoursLabel;
  }
  // Attribution
  const foot = el.querySelector('.card-foot');
  if (foot) foot.innerHTML = attrib;
}

function buildCard(v){
  let dist = userLoc ? formatDistanceKm(kmBetween(userLoc, {lat:v.lat, lon:v.lon})) : '';
  const state = openStateLabel(v);
  const stateSpan = `<span data-hours>${state}</span>`;
  const sunBadge = preference==='full' ? '<span class="badge b-sun-full">Full sun</span>' :
                  preference==='partial' ? '<span class="badge b-sun-some">Some sun</span>' :
                  '<span class="badge">Shade</span>';
  const outdoor = v.hasClearOutdoor ? '<span class="badge b-outdoor">Outdoor</span>' : '';
  const addr = v.addr ? `<div class="tiny">${v.addr}</div>` : '';
  const phone = v.phone ? `<a href="tel:${v.phone}" data-call>Call</a>` : `<a href="#" style="display:none" data-call>Call</a>`;
  const website = v.website ? `<a href="${v.website}" target="_blank" rel="noopener" data-web>Website</a>` : `<a href="#" style="display:none" target="_blank" rel="noopener" data-web>Website</a>`;
  const uber = `<a href="${uberLink(v.lat,v.lon)}" target="_blank" rel="noopener">Uber</a>`;
  const didi = `<a href="${didiLink(v.lat,v.lon)}" target="_blank" rel="noopener">DiDi</a>`;
  return `<article class="card" data-id="${v.id}">
    <h3>${v.name}</h3>
    <div class="meta">${dist ? dist + ' • ' : ''}${stateSpan}</div>
    ${addr}
    <div class="badges">${sunBadge} ${outdoor}</div>
    <div class="actions">
      <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(v.lat+','+v.lon)}" target="_blank" rel="noopener" class="primary">Directions</a>
      ${uber} ${didi} ${phone} ${website}
      <button data-add="${v.id}">+ Add to Crawl</button>
    </div>
    <div class="card-foot tiny"></div>
  </article>`;
}

function renderCards(list){
  if (!list.length) {
    resultHint.textContent = 'No venues match these filters in view. Pan/zoom || adjust filters.';
    cardsEl.innerHTML = '';
    listPanel.innerHTML = '';
    return;
  }
  resultHint.textContent = `${list.length} in view`;
  const subset = list.slice(0, 24);
  cardsEl.innerHTML = subset.map(v => buildCard(v)).join('');
  // Enrich top 8 cards lazily
  Array.from(cardsEl.querySelectorAll('.card')).slice(0,8).forEach((el, i) => {
    const id = el.getAttribute('data-id');
    const v = subset.find(x => x.id === id);
    if (v) enhanceAndUpdateCard(v, el);
  });
  listPanel.innerHTML = list.map(v => {
    const dist = userLoc ? formatDistanceKm(kmBetween(userLoc, {lat:v.lat, lon:v.lon})) : '';
    const state = openStateLabel(v);
  const stateSpan = `<span data-hours>${state}</span>`;
    return `<div class="list-item">
      <div>
        <h4>${v.name}</h4>
        <div class="tiny">${dist ? dist + ' • ' : ''}${state}${v.addr ? ' • ' + v.addr : ''}</div>
      </div>
      <div><button data-detail="${v.id}" class="icon-btn">View</button></div>
    </div>`;
  }).join('');
  cardsEl.querySelectorAll('button[data-add]').forEach(btn => btn.addEventListener('click', () => {
    btn.textContent = 'Added ✓'; btn.disabled = true;
  }));
  listPanel.querySelectorAll('button[data-detail]').forEach(btn => btn.addEventListener('click', () => {
    const v = venues.find(x => x.id === btn.getAttribute('data-detail')); if (v) openDetail(v);
  }));
}

function render(){
  const list = filterList();
  clearMarkers();
  addMarkers(list);
  renderCards(list);
}

// Fetch on move
map.on('moveend', () => {
  clearTimeout(overpassDebounce);
  overpassDebounce = setTimeout(async () => {
    try {
      resultHint.textContent = 'Loading venues…';
      const json = await fetchOverpassFor(map.getBounds());
      const fresh = normalizeOverpass(json);
      const ids = new Set(venues.map(v=>v.id));
      for (const f of fresh) if (!ids.has(f.id)) venues.push(f);
      render();
    } catch {
      resultHint.textContent = 'Could not load venues. Try again.';
    }
  }, 250);
});

// View toggle
function setViewMode(mode){
  if (mode === 'map') {
    viewMapBtn.classList.add('active'); viewMapBtn.setAttribute('aria-pressed','true');
    viewListBtn.classList.remove('active'); viewListBtn.setAttribute('aria-pressed','false');
    listPanel.classList.remove('show'); listPanel.setAttribute('aria-hidden','true');
  } else {
    viewListBtn.classList.add('active'); viewListBtn.setAttribute('aria-pressed','true');
    viewMapBtn.classList.remove('active'); viewMapBtn.setAttribute('aria-pressed','false');
    listPanel.classList.add('show'); listPanel.setAttribute('aria-hidden','false');
  }
}
viewMapBtn.addEventListener('click', () => setViewMode('map'));
viewListBtn.addEventListener('click', () => setViewMode('list'));

// Detail modal — parity with preview card
const detailBackdrop = document.getElementById('detailBackdrop');
const detailModal = document.getElementById('detailModal');
const closeDetailBtn = document.getElementById('closeDetail');
function openDetail(v){
  const dist = userLoc ? formatDistanceKm(kmBetween(userLoc, {lat:v.lat, lon:v.lon})) : '';
  const state = openStateLabel(v);
  const stateSpan = `<span data-hours>${state}</span>`;
  const sunBadge = preference==='full' ? '<span class="badge b-sun-full">Full sun</span>' :
                  preference==='partial' ? '<span class="badge b-sun-some">Some sun</span>' :
                  '<span class="badge">Shade</span>';
  const outdoor = v.hasClearOutdoor ? '<span class="badge b-outdoor">Outdoor</span>' : '';
  const addr = v.addr ? `<div class="tiny">${v.addr}</div>` : '';
  document.getElementById('detailTitle').textContent = v.name;
  document.getElementById('detailInfo').innerHTML = `
    <div class="meta">${dist ? dist + ' • ' : ''}${stateSpan}</div>
    ${addr}
    <div class="badges">${sunBadge} ${outdoor}</div>`;
  document.getElementById('detailDirections').href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(v.lat+','+v.lon)}`;
  document.getElementById('detailUber').href = uberLink(v.lat, v.lon);
  document.getElementById('detailDidi').href = didiLink(v.lat, v.lon);
  const web = document.getElementById('detailWebsite'); web.style.display = v.website ? 'inline-block' : 'none'; web.href = v.website || '#';
  const call = document.getElementById('detailCall'); call.style.display = v.phone ? 'inline-block' : 'none'; call.href = v.phone ? `tel:${v.phone}` : '#';
  if (window.detailMiniLeaflet) { window.detailMiniLeaflet.remove(); }
  window.detailMiniLeaflet = L.map('detailMiniMap', { attributionControl:false, zoomControl:false, dragging:false, scrollWheelZoom:false }).setView([v.lat, v.lon], 16);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(window.detailMiniLeaflet);
  L.marker([v.lat, v.lon], { icon: markerIcon }).addTo(window.detailMiniLeaflet);
  detailBackdrop.classList.add('show'); detailModal.classList.add('show');
  
  // Enrich detail with server data
  enrichVenue(v).then(data => {
    if (!data) return;
    const web = document.getElementById('detailWebsite'); 
    const call = document.getElementById('detailCall');
    const uber = document.getElementById('detailUber');
    if (data.website && (!web.href || web.href === '#')) { web.href = data.website; web.style.display = 'inline-block'; }
    if (data.phone && (!call.href || call.href === '#')) { call.href = `tel:${data.phone}`; call.style.display = 'inline-block'; }
    const info = document.getElementById('detailInfo');
    const attrib = data.source && data.source.length ? `<div class="tiny">ⓘ data via ${data.source.join(', ')}</div>` : '';
    if (info) info.insertAdjacentHTML('beforeend', attrib);
    const h2 = labelFromEnrichedHours(data && data.hours);
    if (h2){ const hs = document.querySelector('[data-hours-detail]'); if (hs) hs.textContent = h2; }
  });

}
function closeDetail(){ detailBackdrop.classList.remove('show'); detailModal.classList.remove('show'); }
detailBackdrop.addEventListener('click', closeDetail);
closeDetailBtn.addEventListener('click', closeDetail);


// Show local preview hint if not http(s)
if (!(location.protocol === 'http:' || location.protocol === 'https:')) {
  const b = document.getElementById('enrichHint'); if (b) b.style.display = 'block';
}

// First run
if (firstRun) { showLocPrompt(); } else { requestGeo(); }
setTimeout(()=>{ if (!userLoc) map.fire('moveend'); }, 400);
