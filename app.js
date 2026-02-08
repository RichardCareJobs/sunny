
/* Sunny app.js — Bottom Card, No Filters (build: 2025-10-10-f)
   - Map-only UI with a bottom detail card (replaces popups)
   - Filters UI removed
   - Custom pins from icons/marker.png (or window.SUNNY_ICON_URL)
*/
console.log("Sunny app.js loaded: Bottom Card (No Filters) 2025-10-10-f");

(function () {
  const DEFAULT_VIEW = { lat: -32.9267, lng: 151.7789, zoom: 12 };

  const VENUE_CACHE_KEY = "sunny-pubs-venues";
  const VENUE_PHOTO_CACHE_KEY = "sunny-pubs-venue-photos-v2";
  const VIEWPORT_CACHE_TTL_MS = 1000 * 60 * 3;
  const VIEWPORT_CACHE_STALE_MS = 1000 * 60 * 5;
  const VIEWPORT_CACHE_GRID_DEG = 0.002;

  const PRIMARY_PUB_TYPES = ["bar", "pub"];
  const SECONDARY_PUB_TYPES = ["night_club"];
  const SECONDARY_FOOD_TYPES = ["restaurant"];
  const DEFAULT_CITY_RADIUS_M = 2500;
  const PLACES_QUERY_RADIUS_MIN_M = 2000;
  const PLACES_QUERY_RADIUS_MAX_M = 12000;
  const RADIUS_EXPANSION_STEP_M = 2000;
  const MIN_PRIMARY_RESULTS = 18;
  const MIN_TOTAL_RESULTS = 24;
  const PUB_BAR_MIN_SHARE = 0.7;
  const INCLUDE_CAFES_DEFAULT = false;
  const DEBUG_PLACES = false;
  const DEBUG_FILTERS = false;
  const DEBUG_PERF = false;
  const OUTDOOR_ONLY = true;
  const preferPubsAndBarsForCrawls = true;
  const DEV_PLACES_LOGGING = DEBUG_PLACES || ["localhost","127.0.0.1",""].includes(window.location.hostname);
  const DEV_CRAWL_LOGGING = DEV_PLACES_LOGGING;
  const MAP_PROVIDER = window.SUNNY_PROVIDER || "google";
  window.SUNNY_PROVIDER = MAP_PROVIDER;

  const analytics = window.SunnyAnalytics || null;
  function trackEvent(eventName, params = {}){
    if(!analytics || typeof analytics.track!=="function") return;
    analytics.track(eventName, params);
  }

  let map;
  let markersLayer = [];
  const markersById = new Map();
  let markerClusterer = null;
  const CLUSTER_THRESHOLD = 60;
  let locateButton = null;
  let allVenues = {};
  let venuePhotoCache = loadLocal(VENUE_PHOTO_CACHE_KEY) || {};
  if(!venuePhotoCache || typeof venuePhotoCache!=="object") venuePhotoCache={};
  let userLocation = null;
  let locationWatchId = null;
  let locationWatchTimer = null;
  let hasCenteredOnUser = false;

  const MAX_LOCATION_WAIT_MS = 15000;
  const DESIRED_LOCATION_ACCURACY_METERS = 250;

  const MOVE_DEBOUNCE_MS = 300;
  let moveTimer = null;
  let hasInitialMapLoad = false;

  let openVenueId = null;
  let isRenderingMarkers = false;
  let detailCard = null;
  let imageViewerModal = null;
  let ratingCard = null;
  let venueStatusEl = null;

  let venueCountToast = null;
  let venueCountTimer = null;

  const CRAWL_DEFAULT_HANG_MINUTES = 45;
  const CRAWL_TIME_STEP_MINUTES = 15;
  const MAX_CRAWL_VENUES = 12;
  const CRAWL_MAX_STEP_METERS = 200;

  let crawlLayer = [];
  let crawlState = null;
  let isCrawlMode = false;
  let hasAutoFitCrawlOnLoad = false;
  let pendingCrawlFitReason = null;
  let crawlBuildStartTime = null;
  let crawlBuilder = null;
  let crawlControls = null;
  let crawlCard = null;
  let crawlListPanel = null;
  let crawlAddPanel = null;
  let crawlNotifications = new Map();
  let crawlBuildRequestId = 0;
  let isCrawlBuildInProgress = false;
  let placesService = null;
  let autocompleteService = null;
  let activeSearchId = 0;
  let activeRequestId = 0;
  let activeRequestController = null;
  const MAX_PAGES_PER_PASS = 1;

  const MARKER_ICON_URL = window.SUNNY_ICON_URL || "/icons/marker.png";
  let markerIcon = null;
  const viewportCache = new Map();
  const crawlVenueCache = new Map();

  // Helpers
  function setupHeaderMenu(){
    const button = document.getElementById("menuBtn");
    const menu = document.getElementById("headerMenu");
    if (!button || !menu) return;
    const closeMenu = () => {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
    };
    const openMenu = () => {
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
    };
    const toggleMenu = () => {
      if (menu.hidden) openMenu();
      else closeMenu();
    };
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMenu();
    });
    menu.addEventListener("click", (event) => {
      if (event.target.closest("a")) closeMenu();
    });
    document.addEventListener("click", (event) => {
      if (menu.hidden) return;
      if (menu.contains(event.target) || button.contains(event.target)) return;
      closeMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !menu.hidden) closeMenu();
    });
  }
  function saveLocal(k,v){ try{localStorage.setItem(k,JSON.stringify({v,t:Date.now()}));}catch{} }
  function loadLocal(k,maxAge=null){
    try{const raw=localStorage.getItem(k); if(!raw) return null; const {v,t}=JSON.parse(raw); if(maxAge!=null&&Date.now()-t>maxAge) return null; return v;}catch{return null;}
  }
  function perfLog(message,data={}){
    if(!(DEBUG_PERF || ["localhost","127.0.0.1",""].includes(window.location.hostname))) return;
    const payload=Object.keys(data).length ? ` ${JSON.stringify(data)}` : "";
    console.log(`[Perf] ${message}${payload}`);
  }
  function getFilterHash(){
    const includeCafes=getIncludeCafes();
    return `outdoor:${OUTDOOR_ONLY?1:0}|cafes:${includeCafes?1:0}`;
  }
  function roundToGrid(value,grid){
    return Math.round(value/grid)*grid;
  }
  function getViewportCacheKey(){
    if(!map) return "";
    const center=map.getCenter();
    const zoom=map.getZoom();
    const lat=roundToGrid(center.lat(),VIEWPORT_CACHE_GRID_DEG);
    const lng=roundToGrid(center.lng(),VIEWPORT_CACHE_GRID_DEG);
    return `${lat.toFixed(3)}:${lng.toFixed(3)}:z${zoom}:${getFilterHash()}`;
  }
  function getCrawlVenueCacheKey(center,radiusMeters){
    if(!center||typeof center.lat!=="number"||typeof center.lng!=="number") return "";
    const radius=Math.round(radiusMeters || 0);
    const lat=roundToGrid(center.lat,VIEWPORT_CACHE_GRID_DEG);
    const lng=roundToGrid(center.lng,VIEWPORT_CACHE_GRID_DEG);
    return `crawl:${lat.toFixed(3)}:${lng.toFixed(3)}:r${radius}:${getFilterHash()}`;
  }
  function getViewportCacheEntry(key){
    return viewportCache.get(key) || null;
  }
  function setViewportCacheEntry(key,data){
    viewportCache.set(key,{ data, ts: Date.now() });
  }
  function getCrawlVenueCacheEntry(key){
    return crawlVenueCache.get(key) || null;
  }
  function setCrawlVenueCacheEntry(key,data){
    crawlVenueCache.set(key,{ data, ts: Date.now() });
  }
  function throwIfAborted(signal){
    if(signal?.aborted){
      throw new DOMException("Aborted","AbortError");
    }
  }
  function getMarkerClustererClass(){
    return window.markerClusterer?.MarkerClusterer || window.MarkerClusterer || null;
  }
  function ensureMarkerClusterer(){
    if(markerClusterer) return markerClusterer;
    const MarkerClustererClass=getMarkerClustererClass();
    if(!MarkerClustererClass) return null;
    markerClusterer=new MarkerClustererClass({ map, markers: [] });
    return markerClusterer;
  }
  function clearMarkerClusterer(){
    if(markerClusterer){
      markerClusterer.clearMarkers();
      markerClusterer.setMap(null);
      markerClusterer=null;
    }
  }
  function toTitle(s=""){ return s ? s.replace(/\b\w/g,c=>c.toUpperCase()) : ""; }
  function ensureVenueStatus(){
    if(venueStatusEl) return venueStatusEl;
    const el=document.createElement("div");
    el.id="venueStatus";
    el.className="venue-status";
    el.hidden=true;
    el.setAttribute("aria-live","polite");
    document.body.appendChild(el);
    venueStatusEl=el;
    return el;
  }
  function showVenueStatus(state,message){
    const el=ensureVenueStatus();
    el.dataset.state=state;
    el.textContent=message;
    el.hidden=false;
    if(state==="error"){
      trackEvent("error_shown",{
        error_type:"api",
        component:"venues"
      });
    }
  }
  function hideVenueStatus(){
    if(!venueStatusEl) return;
    venueStatusEl.hidden=true;
  }
  // Distance
  function haversine(a,b,c,d){ const R=6371,toRad=x=>x*Math.PI/180; const dLat=toRad(c-a), dLon=toRad(d-b);
    const A=Math.sin(dLat/2)**2+Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLon/2)**2;
    const C=2*Math.atan2(Math.sqrt(A),Math.sqrt(1-A)); return R*C; }
  function haversineMeters(a,b,c,d){
    const km=haversine(a,b,c,d);
    return Number.isFinite(km) ? km*1000 : NaN;
  }
  function isValidCoord(lat,lng){
    return Number.isFinite(lat)&&Number.isFinite(lng);
  }
  function formatDistanceKm(km){ return km<1 ? `${Math.round(km*1000)} m` : `${km.toFixed(1)} km`; }
  function formatAddress(tags={}){
    if(tags["addr:full"]) return tags["addr:full"];
    const hn=tags["addr:housenumber"]||"";
    const street=tags["addr:street"]||tags["addr:place"]||"";
    const city=tags["addr:city"]||tags["addr:suburb"]||tags["addr:municipality"]||"";
    const streetLine=[hn,street].filter(Boolean).join(" ").trim();
    return [streetLine,city].filter(Boolean).join(", ");
  }
  function getVenueDistanceMeters(venue){
    if(!venue||!userLocation) return null;
    if(!Number.isFinite(venue.lat)||!Number.isFinite(venue.lng)) return null;
    if(!Number.isFinite(userLocation.lat)||!Number.isFinite(userLocation.lng)) return null;
    const distance=haversineMeters(userLocation.lat,userLocation.lng,venue.lat,venue.lng);
    return Number.isFinite(distance) ? Math.round(distance) : null;
  }
  function trackVenueCardOpened(card,venue){
    if(!card||!venue) return;
    const isAlreadyOpen=!card.container.classList.contains("hidden") && card.container.dataset.venueId===venue.id;
    if(isAlreadyOpen) return;
    const payload={
      venue_id: String(venue.id || ""),
      provider: MAP_PROVIDER
    };
    const distanceMeters=getVenueDistanceMeters(venue);
    if(Number.isFinite(distanceMeters)) payload.distance_m=distanceMeters;
    if(typeof venue.openNow==="boolean") payload.is_open=venue.openNow;
    trackEvent("venue_card_opened",payload);
  }
  function trackVenueAction(action,venue){
    if(!venue||!action) return;
    const payload={
      venue_id: String(venue.id || ""),
      action,
      provider: MAP_PROVIDER
    };
    const distanceMeters=getVenueDistanceMeters(venue);
    if(Number.isFinite(distanceMeters)) payload.distance_m=distanceMeters;
    trackEvent("venue_action_clicked",payload);
  }
  function clearLocationWatch(){
    if(locationWatchId!==null){ navigator.geolocation.clearWatch(locationWatchId); locationWatchId=null; }
    if(locationWatchTimer){ clearTimeout(locationWatchTimer); locationWatchTimer=null; }
  }
  function formatTime(date){
    if(!(date instanceof Date)) return "";
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function formatTimeRange(start,end){
    if(!(start instanceof Date) || !(end instanceof Date)) return "";
    return `${formatTime(start)} - ${formatTime(end)}`;
  }
  function estimateUberFare(distanceKm){
    const base=8;
    const perKm=2.2;
    const estimate=base + perKm * Math.max(distanceKm,0.2);
    return Math.round(estimate);
  }
  function buildStartDateFromInput(timeValue){
    if(!timeValue) return new Date();
    const [hour,minute]=timeValue.split(":").map(Number);
    const now=new Date();
    if(Number.isNaN(hour)||Number.isNaN(minute)) return now;
    const next=new Date(now.getFullYear(),now.getMonth(),now.getDate(),hour,minute,0,0);
    if(next.getTime()<now.getTime()) next.setDate(next.getDate()+1);
    return next;
  }
 
  // Ratings
  const RATING_STORAGE_KEY = "sunny-outdoor-ratings";
  let ratingStore = loadLocal(RATING_STORAGE_KEY) || {};
  if (!ratingStore || typeof ratingStore !== "object") ratingStore = {};

  function getRatingEntry(venueId){
    const entry = ratingStore && typeof ratingStore === "object" ? ratingStore[venueId] : null;
    if(!entry || typeof entry !== "object") return { total:0, count:0, rated:false };
    const { total=0, count=0, rated=false } = entry;
    return { total, count, rated:!!rated };
  }
  function persistRatings(){
    saveLocal(RATING_STORAGE_KEY, ratingStore);
  }
  function recordRating(venueId,value){
    if(!venueId||!value) return;
    const current=getRatingEntry(venueId);
    if(current.rated) return;
    const next={ total: current.total + value, count: current.count + 1, rated:true };
    ratingStore={ ...ratingStore, [venueId]: next };
    persistRatings();
    if(openVenueId===venueId) renderVenueRatingSummary(venueId);
  }
  function renderVenueRatingSummary(venueId){
    if(!detailCard||!detailCard.ratingDisplay) return;
    const { total, count, rated } = getRatingEntry(venueId);
    const average = count ? total / count : null;
    const stars=detailCard.ratingDisplay.querySelectorAll(".rating-star--display");
    const label=detailCard.ratingDisplay.querySelector(".rating-display__label");
    const rateBtns=(detailCard.rateButtons&&detailCard.rateButtons.length)?detailCard.rateButtons:(detailCard.rateButton?[detailCard.rateButton]:[]);
    if(rateBtns.length){
      rateBtns.forEach(btn=>{
        btn.disabled=!!rated;
        btn.textContent=rated?"Rated":"Rate";
      });
    }
    if(count>=10 && average!==null){
      const filled=Math.round(average);
      detailCard.ratingDisplay.classList.remove("hidden");
      stars.forEach(star=>{
        const value=Number(star.dataset.value);
        star.classList.toggle("is-active",value<=filled);
      });
      if(label) label.textContent=`${average.toFixed(1)} (${count})`;
      detailCard.ratingDisplay.setAttribute("aria-label",`Outdoor area rating ${average.toFixed(1)} out of 5 from ${count} ratings`);
    } else {
      detailCard.ratingDisplay.classList.add("hidden");
      stars.forEach(star=>star.classList.remove("is-active"));
      if(label) label.textContent="";
      detailCard.ratingDisplay.removeAttribute("aria-label");
    }
  }
  function stripLegacyRating(root){
    if(!root) return;
    const legacyTitles=Array.from(root.querySelectorAll(".venue-card__section-title")).filter(el=>/rating/i.test(el.textContent||""));
    legacyTitles.forEach(el=>el.remove());
    const legacyRows=root.querySelectorAll(".venue-card__rating-row");
    legacyRows.forEach(el=>el.remove());
    Array.from(root.querySelectorAll("button")).forEach(btn=>{
      if(/rate outdoor area/i.test(btn.textContent||"")) btn.remove();
    });
    Array.from(root.querySelectorAll("*")).forEach(el=>{
      if(/rating coming soon/i.test(el.textContent||"")) el.remove();
    });
  }
  function centerOnUserIfAvailable(targetZoom=15,{force=false}={}){
    if(!map||!userLocation) return;
    if(hasCenteredOnUser&&!force) return;
    const zoom=Math.max(map.getZoom(),targetZoom);
    panToLocation(userLocation.lat,userLocation.lng,zoom);
    hasCenteredOnUser=true;
  }
  function panToLocation(lat,lng,zoom=null){
    if(!map) return;
    map.panTo({lat,lng});
    if(typeof zoom==="number") map.setZoom(zoom);
  }
  function acceptAccurateLocation(p,{shouldCenter=false,forceCenter=false,onComplete=null}={}){
    if(!p||!p.coords){ if(onComplete) onComplete(); return false; }
    const {latitude,longitude,accuracy}=p.coords;
    if(typeof accuracy==="number"&&accuracy>DESIRED_LOCATION_ACCURACY_METERS){
      if(locationWatchId===null&&navigator.geolocation.watchPosition){
        locationWatchId=navigator.geolocation.watchPosition(
          (next)=>acceptAccurateLocation(next,{shouldCenter,onComplete}),
          ()=>{ clearLocationWatch(); if(onComplete) onComplete(); },
          {enableHighAccuracy:true,timeout:20000,maximumAge:0}
        );
        locationWatchTimer=setTimeout(()=>{
          clearLocationWatch();
          if(onComplete) onComplete();
        },MAX_LOCATION_WAIT_MS);
      } else {
        if(onComplete) onComplete();
        if(!navigator.geolocation.watchPosition&&userLocation===null) userLocation=false;
      }
      return false;
    }
    clearLocationWatch();
    userLocation={lat:latitude,lng:longitude};
    if(shouldCenter) centerOnUserIfAvailable(15,{force:forceCenter});
    if(onComplete) onComplete();
    return true;
  }
  function requestUserLocationOnce(){
    if(userLocation!==null) return;
    if(!navigator.geolocation){ userLocation=false; return; }
    const opts={enableHighAccuracy:true,timeout:8000,maximumAge:0};
    const handleFailure=()=>{ clearLocationWatch(); if(userLocation===null) userLocation=false; };
    const handleSuccess=(p)=>{
      if(!acceptAccurateLocation(p,{shouldCenter:true})) return;
    };
    navigator.geolocation.getCurrentPosition(handleSuccess,handleFailure,opts);
  }

  // Sun
  function sunPosition(lat,lng,date=new Date()){
    const rad=Math.PI/180,deg=180/Math.PI,J1970=2440588,J2000=2451545,dayMs=86400000;
    const toJulian=d=>d/dayMs-0.5+J1970, d=toJulian(date.getTime())-J2000;
    const M=rad*(357.5291+0.98560028*d), C=rad*(1.9148*Math.sin(M)+0.02*Math.sin(2*M)+0.0003*Math.sin(3*M));
    const P=rad*102.9372, L=M+C+P+Math.PI, e=rad*23.4397;
    const sinDec=Math.sin(e)*Math.sin(L), dec=Math.asin(sinDec), lw=rad*-lng, phi=rad*lat;
    const theta=rad*(280.16+360.9856235*d)-lw, H=theta-L;
    const altitude=Math.asin(Math.sin(phi)*Math.sin(dec)+Math.cos(phi)*Math.cos(dec)*Math.cos(H));
    const azimuth=Math.atan2(Math.sin(H),Math.cos(H)*Math.sin(phi)-Math.tan(dec)*Math.cos(phi));
    return { azimuthDeg:(azimuth*deg+180)%360, altitudeDeg:altitude*deg };
  }
  function sunBadge(lat,lng){ const alt=sunPosition(lat,lng).altitudeDeg; if(alt>=45) return{icon:"☀️",label:"Full sun"}; if(alt>=15) return{icon:"🌤️",label:"Partial sun"}; return{icon:"⛅",label:"Low sun"}; }

  const WEATHER_CACHE_TTL_MS = 1000 * 60 * 10;
  const weatherCache = new Map();
  async function fetchWeather(lat,lng){
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    const cached = weatherCache.get(key);
    if (cached && Date.now() - cached.t < WEATHER_CACHE_TTL_MS) return cached.v;
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lng,
      current: "temperature_2m,weather_code"
    });
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
      if (!res.ok) throw new Error("Weather request failed");
      const json = await res.json();
      const current = json && json.current;
      if (!current) throw new Error("Weather payload missing current data");
      const temp = typeof current.temperature_2m === "number" ? Math.round(current.temperature_2m) : null;
      const code = typeof current.weather_code === "number" ? current.weather_code : null;
      const icon = weatherIconForCode(code);
      const value = { tempC: temp, icon: icon.icon, label: icon.label };
      weatherCache.set(key, { v: value, t: Date.now() });
      return value;
    } catch (err) {
      console.warn("Weather fetch failed", err);
      const fallback = { tempC: null, icon: "☁️", label: "Weather unavailable" };
      weatherCache.set(key, { v: fallback, t: Date.now() });
      return fallback;
    }
  }
  function weatherIconForCode(code){
    if (code === 0 || code === 1) return { icon: "☀️", label: "Sunny" };
    if (code === 2 || code === 3) return { icon: "🌤️", label: "Partly cloudy" };
    return { icon: "☁️", label: "Cloudy" };
  }
  function formatCurrentWeatherChipLabel(sunLabel,tempC){
    const cleanSunLabel=typeof sunLabel==="string"?sunLabel.trim():"";
    const hasSunLabel=!!cleanSunLabel;
    const hasTemp=typeof tempC==="number"&&Number.isFinite(tempC);
    if(!hasSunLabel&&!hasTemp) return "";
    if(hasSunLabel&&hasTemp) return `${cleanSunLabel} · ${tempC}°C`;
    if(hasSunLabel) return cleanSunLabel;
    return `Weather · ${tempC}°C`;
  }
  async function populateCombinedWeatherChip(chip,lat,lng,sun){
    if(!chip) return;
    const currentIcon=chip.querySelector(".chip-emoji");
    const currentLabel=chip.querySelector(".chip-label");
    if(!currentIcon||!currentLabel) return;
    currentIcon.textContent=(sun&&sun.icon)||"☀️";
    currentLabel.textContent=formatCurrentWeatherChipLabel(sun?.label,null);
    const requestToken=String(Date.now()+Math.random());
    chip.dataset.weatherRequestToken=requestToken;
    const data=await fetchWeather(lat,lng);
    if(chip.dataset.weatherRequestToken!==requestToken) return;
    const formattedLabel=formatCurrentWeatherChipLabel(sun?.label,data?.tempC);
    if(!formattedLabel){
      chip.classList.add("hidden");
      chip.style.display="none";
      return;
    }
    currentLabel.textContent=formattedLabel;
    chip.classList.remove("hidden");
    chip.style.display="inline-flex";
  }

  // Hours
  const DAY_MAP=["Su","Mo","Tu","We","Th","Fr","Sa"];
  function parseOpenStatus(openingHours){
    if(!openingHours) return {status:"Unknown",tone:"muted"};
    const s=String(openingHours).trim();
    if(/24.?7/i.test(s)) return {status:"Open now",tone:"good"};
    const now=new Date(), day=DAY_MAP[now.getDay()], rules=s.split(/\s*;\s*/);
    const dayMatches=(rule,d)=>{
      rule=rule.replace(/Mon/gi,"Mo").replace(/Tue/gi,"Tu").replace(/Wed/gi,"We").replace(/Thu/gi,"Th").replace(/Fri/gi,"Fr").replace(/Sat/gi,"Sa").replace(/Sun/gi,"Su");
      if(/daily|every ?day|mo-su/i.test(rule)) return true;
      const m=rule.match(/\b(Mo|Tu|We|Th|Fr|Sa|Su)\s*-\s*(Mo|Tu|We|Th|Fr|Sa|Su)\b/i);
      if(m){ const s=DAY_MAP.indexOf(m[1]), e=DAY_MAP.indexOf(m[2]), i=DAY_MAP.indexOf(d); return s<=e ? i>=s&&i<=e : (i>=s||i<=e); }
      return new RegExp(`\\b${d}\\b`,"i").test(rule);
    };
    let todays=null; for(const r of rules){ if(dayMatches(r,day)){ todays=r; break; } } if(!todays) todays=s;
    const ranges=[]; todays.replace(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g,(_,a,b)=>{ranges.push([a,b]); return _;});
    if(!ranges.length) return {status:"Unknown",tone:"muted"};
    const nowMin=now.getHours()*60+now.getMinutes(); let open=false, openIn=Infinity, closeIn=Infinity;
    for(const [a,b] of ranges){ const [ah,am]=a.split(':').map(Number), [bh,bm]=b.split(':').map(Number);
      let start=ah*60+am, end=bh*60+bm; if(end<start) end+=1440; let current=nowMin; if(nowMin<start&&end>=1440) current+=1440;
      if(current>=start&&current<=end){ open=true; closeIn=Math.min(closeIn,end-current); }
      else if(current<start){ openIn=Math.min(openIn,start-current); }
    }
    if(open){ if(closeIn<=30) return {status:"Closing soon",tone:"warn"}; return {status:"Open now",tone:"good"}; }
    if(isFinite(openIn)){ if(openIn<=30) return {status:"Opening soon",tone:"info"}; return {status:"Closed",tone:"muted"}; }
    return {status:"Closed",tone:"muted"};
  }
  function toneForHoursStatus(status=""){
    if(status==="Open now") return "good";
    if(status==="Closing soon") return "warn";
    if(status==="Opening soon") return "info";
    return "muted";
  }
  function resolveOpenStatus(venue){
    if(venue && venue.hoursStatus){
      return {status:venue.hoursStatus,tone:toneForHoursStatus(venue.hoursStatus)};
    }
    if(venue && typeof venue.openNow==="boolean"){
      return venue.openNow ? {status:"Open now",tone:"good"} : {status:"Closed",tone:"muted"};
    }
    const tags=venue?.tags||{};
    return parseOpenStatus(tags.opening_hours);
  }
  function getLocalTimeForOffset(utcOffsetMinutes){
    const now=new Date();
    if(typeof utcOffsetMinutes!=="number") return now;
    const utcMs=now.getTime()+now.getTimezoneOffset()*60000;
    return new Date(utcMs+utcOffsetMinutes*60000);
  }
  function timeStringToMinutes(value){
    if(!value||typeof value!=="string") return null;
    const hour=parseInt(value.slice(0,2),10);
    const minute=parseInt(value.slice(2),10);
    if(Number.isNaN(hour)||Number.isNaN(minute)) return null;
    return hour*60+minute;
  }
  function getTodayHoursText(weekdayText=[],utcOffsetMinutes){
    if(!Array.isArray(weekdayText)||weekdayText.length!==7) return "";
    const localTime=getLocalTimeForOffset(utcOffsetMinutes);
    const dayIndex=localTime.getDay();
    const weekdayIndex=(dayIndex+6)%7;
    return weekdayText[weekdayIndex]||"";
  }
  function computeHoursStatus({ openingHours, utcOffsetMinutes }){
    if(!openingHours) return { status:"Hours unavailable", nextChangeText:"" };
    let isOpen;
    if(typeof openingHours.isOpen==="function"){
      try{ isOpen=openingHours.isOpen(); } catch{}
    }
    if(typeof isOpen!=="boolean" && typeof openingHours.open_now==="boolean") isOpen=openingHours.open_now;
    const periods=Array.isArray(openingHours.periods)?openingHours.periods:[];
    if(periods.length===0){
      if(typeof isOpen==="boolean") return { status:isOpen?"Open now":"Closed", nextChangeText:"" };
      return { status:"Hours unavailable", nextChangeText:"" };
    }
    const WEEK_MINUTES=10080;
    const localTime=getLocalTimeForOffset(utcOffsetMinutes);
    const nowMinutes=localTime.getDay()*1440+localTime.getHours()*60+localTime.getMinutes();
    const intervals=[];
    let hasOpenEnded=false;
    periods.forEach(period=>{
      const open=period.open;
      if(!open||open.day==null||!open.time) return;
      const openTime=timeStringToMinutes(open.time);
      if(openTime==null) return;
      let start=open.day*1440+openTime;
      let end=start+1440;
      if(period.close&&period.close.day!=null&&period.close.time){
        const closeTime=timeStringToMinutes(period.close.time);
        if(closeTime!=null){
          end=period.close.day*1440+closeTime;
          if(end<=start) end+=WEEK_MINUTES;
        }
      } else {
        hasOpenEnded=true;
      }
      intervals.push([start,end]);
    });
    if(intervals.length===0){
      if(typeof isOpen==="boolean") return { status:isOpen?"Open now":"Closed", nextChangeText:"" };
      return { status:"Hours unavailable", nextChangeText:"" };
    }
    let openIn=Infinity;
    let closeIn=Infinity;
    let isCurrentlyOpen=false;
    intervals.forEach(([start,end])=>{
      [-WEEK_MINUTES,0,WEEK_MINUTES].forEach(shift=>{
        const s=start+shift;
        const e=end+shift;
        if(nowMinutes>=s && nowMinutes<=e){
          isCurrentlyOpen=true;
          closeIn=Math.min(closeIn,e-nowMinutes);
        } else if(nowMinutes<s){
          openIn=Math.min(openIn,s-nowMinutes);
        }
      });
    });
    const statusIsOpen=typeof isOpen==="boolean" ? isOpen : isCurrentlyOpen;
    let status="Closed";
    if(statusIsOpen){
      status=closeIn<=30 ? "Closing soon" : "Open now";
    } else if(isFinite(openIn)){
      status=openIn<=30 ? "Opening soon" : "Closed";
    } else if(typeof isOpen==="boolean"){
      status=isOpen ? "Open now" : "Closed";
    } else {
      status="Hours unavailable";
    }
    let nextChangeText="";
    if(statusIsOpen && hasOpenEnded){
      nextChangeText="Open 24 hours";
    } else if(statusIsOpen && isFinite(closeIn)){
      const closeAt=new Date(localTime.getTime()+closeIn*60000);
      nextChangeText=`Closes ${formatTime(closeAt)}`;
    } else if(!statusIsOpen && isFinite(openIn)){
      const openAt=new Date(localTime.getTime()+openIn*60000);
      nextChangeText=`Opens ${formatTime(openAt)}`;
    }
    return { status, nextChangeText };
  }

  // Google Places
  function getPrimaryCategory(types=[]){
    if(types.includes("bar")||types.includes("pub")||types.includes("night_club")) return "Pub/Bar";
    if(types.includes("cafe")) return "Cafe";
    if(types.includes("restaurant")) return "Restaurant";
    return "Other";
  }
  function getOutdoorLikely(place){
    if(!place) return false;
    const haystack=`${place.name||""} ${place.vicinity||""}`.toLowerCase();
    const keywords=[
      "beer garden","beer-garden","courtyard","rooftop","terrace","alfresco","outdoor seating","outdoor",
      "garden bar","beer garden pub","patio"
    ];
    return keywords.some(keyword=>haystack.includes(keyword));
  }
  function getAmenityFromTypes(types=[]){
    if(types.includes("pub")) return "pub";
    if(types.includes("bar")) return "bar";
    if(types.includes("night_club")) return "nightclub";
    if(types.includes("cafe")) return "cafe";
    if(types.includes("restaurant")) return "restaurant";
    return "";
  }
  function normalizePlace(place){
    if(!place||!place.geometry||!place.geometry.location) return null;
    if(place.business_status==="CLOSED_PERMANENTLY") return null;
    if(place.permanently_closed) return null;
    const location=place.geometry.location;
    const lat=typeof location.lat==="function" ? location.lat() : location.lat;
    const lng=typeof location.lng==="function" ? location.lng() : location.lng;
    if(typeof lat!=="number"||typeof lng!=="number") return null;
    const id=place.place_id;
    const name=place.name||"Unnamed";
    const types=place.types||[];
    const amenity=getAmenityFromTypes(types);
    const primaryCategory=place.primaryCategoryOverride||getPrimaryCategory(types);
    const photoData=resolvePlacePhotoData(place,{ width: 480, mode: "thumbnail" });
    const tags={
      name,
      amenity,
      types: types.join(","),
      vicinity: place.vicinity || "",
      formatted_address: place.formatted_address || "",
      outdoor_seating: place.outdoor_seating || ""
    };
    if(isClosed(tags)) return null;
    if(lacksOutdoor(tags)) return null;
    if(isDryVenue(tags)) return null;
    return {
      id,
      name,
      lat,
      lng,
      address: place.vicinity || place.formatted_address || "",
      tags,
      primaryCategory,
      outdoorLikely: !!place.outdoorLikely,
      openNow: place.opening_hours?.open_now,
      hoursText: "",
      hasOutdoor: hasOutdoorHints(tags),
      photo: photoData,
      photos: photoData?.photos||[],
      source: "google"
    };
  }
  // Rule: VIP Lounge sub-venues are globally excluded from Sunny.
  function isGloballyExcludedVenue(venue){
    const name=String(venue?.name||"").trim().toLowerCase();
    return name.includes("vip lounge");
  }
  function normalizeAddressKey(venue){
    const address=String(
      venue?.address ||
      venue?.formatted_address ||
      venue?.vicinity ||
      venue?.tags?.formatted_address ||
      venue?.tags?.vicinity ||
      ""
    ).trim();
    if(address){
      return address.toLowerCase().replace(/\s+/g," ");
    }
    const lat=venue?.lat;
    const lng=venue?.lng;
    if(Number.isFinite(lat)&&Number.isFinite(lng)){
      return `${lat.toFixed(5)},${lng.toFixed(5)}`;
    }
    return String(venue?.id||"").trim();
  }
  function filterGloballyExcludedVenues(list,label="venues"){
    const venues=Array.isArray(list)?list:[];
    const filtered=venues.filter(v=>!isGloballyExcludedVenue(v));
    if((DEBUG_FILTERS||DEV_PLACES_LOGGING)&&filtered.length!==venues.length){
      console.log(`[Venues] excluded ${venues.length-filtered.length} VIP Lounge entries from ${label}.`);
    }
    return filtered;
  }
  function selectUniqueAddressVenues(list,count){
    const selected=[];
    const used=new Set();
    list.forEach((venue)=>{
      if(selected.length>=count) return;
      const key=normalizeAddressKey(venue);
      if(!key||used.has(key)) return;
      used.add(key);
      selected.push(venue);
    });
    if((DEBUG_FILTERS||DEV_PLACES_LOGGING)&&selected.length<Math.min(count,list.length)){
      console.log(`[Crawl] skipped ${Math.min(count,list.length)-selected.length} venues with duplicate addresses.`);
    }
    return selected;
  }
  function getGoogleMapsApiKey(){
    const script=[...document.querySelectorAll('script[src*="maps.googleapis.com/maps/api/js"]')].find(Boolean);
    if(!script?.src) return "";
    try{
      const url=new URL(script.src,window.location.origin);
      return url.searchParams.get("key")||"";
    } catch {
      return "";
    }
  }
  function buildLegacyPhotoEndpoint(photoReference,width=480){
    const apiKey=getGoogleMapsApiKey();
    if(!photoReference||!apiKey) return "";
    const params=new URLSearchParams({
      maxwidth: String(width),
      photo_reference: photoReference,
      key: apiKey
    });
    return `https://maps.googleapis.com/maps/api/place/photo?${params.toString()}`;
  }
  function derivePhotoUrl(photo,width=480){
    if(!photo) return "";
    if(typeof photo.getUrl==="function"){
      try{ return photo.getUrl({ maxWidth: width }); }catch{}
    }
    if(photo.photo_reference) return buildLegacyPhotoEndpoint(photo.photo_reference,width);
    if(photo.name){
      const apiKey=getGoogleMapsApiKey();
      if(apiKey){
        const encodedName=encodeURIComponent(photo.name);
        return `https://places.googleapis.com/v1/${encodedName}/media?maxWidthPx=${width}&key=${encodeURIComponent(apiKey)}`;
      }
    }
    return "";
  }
  function normalizePlacePhotos(place,photos=[]){
    const list=Array.isArray(photos)?photos:[];
    return list.slice(0,10).map((photo,index)=>({
      id: photo?.name || photo?.photo_reference || `${place?.place_id||"place"}-${index}`,
      attribution: Array.isArray(photo?.html_attributions) ? photo.html_attributions : [],
      caption: photo?.caption || "",
      source: photo
    }));
  }
  function getThumbnailUrl(photo,maxWidth=400){
    return derivePhotoUrl(photo?.source||photo,maxWidth);
  }
  function getLargeUrl(photo,maxWidth=1200){
    return derivePhotoUrl(photo?.source||photo,maxWidth);
  }
  function hasOutdoorFeature(place){
    if(!place) return false;
    return ["TRUE","true",true,"yes","YES"].includes(place.outdoor_seating) ||
      ["TRUE","true",true,"yes","YES"].includes(place.rooftop_seating) ||
      ["TRUE","true",true,"yes","YES"].includes(place.courtyard);
  }
  function selectPlacePhoto(place,photos=[]){
    if(!photos.length) return { selectedIndex: -1, selectedPhoto: null, photosCount: 0, strategy: "none" };
    const outdoorFeature=hasOutdoorFeature(place);
    if(!outdoorFeature){
      return { selectedIndex: 0, selectedPhoto: photos[0], photosCount: photos.length, strategy: "primary" };
    }
    // Best-effort outdoor hint support. Metadata varies by API response; currently we default
    // to first photo when no reliable outdoor metadata is present.
    const firstOutdoorIndex=photos.findIndex(photo=>{
      const text=`${photo?.caption||""} ${(photo?.html_attributions||[]).join(" ")}`.toLowerCase();
      return /outdoor|terrace|rooftop|courtyard|beer ?garden|patio|alfresco/.test(text);
    });
    const selectedIndex=firstOutdoorIndex>=0 ? firstOutdoorIndex : 0;
    return { selectedIndex, selectedPhoto: photos[selectedIndex], photosCount: photos.length, strategy: firstOutdoorIndex>=0?"outdoor-hint":"outdoor-fallback-primary" };
  }
  function resolvePlacePhotoData(place,{ width=480, mode="thumbnail" }={}){
    const placeId=place?.place_id;
    if(!placeId) return null;
    const cached=venuePhotoCache[placeId];
    if(cached&&Array.isArray(cached.photos)&&cached.photos.length){
      const selectedIndex=Number.isInteger(cached.selectedIndex)?cached.selectedIndex:0;
      const selectedPhoto=cached.photos[selectedIndex]||cached.photos[0];
      const url=mode==="detail"?getLargeUrl(selectedPhoto,width):getThumbnailUrl(selectedPhoto,width);
      if(url){
        return {
          url,
          selectedIndex,
          photosCount: cached.photos.length,
          photos: cached.photos,
          mode,
          strategy: cached.strategy||"cache"
        };
      }
    }
    const photos=normalizePlacePhotos(place,place?.photos);
    const pick=selectPlacePhoto(place,photos.map(photo=>photo.source));
    if(!photos.length||!pick.selectedPhoto) return null;
    const selectedPhoto=photos[pick.selectedIndex]||photos[0];
    const url=mode==="detail"?getLargeUrl(selectedPhoto,width):getThumbnailUrl(selectedPhoto,width);
    if(!url) return null;
    const next={
      photos,
      selectedIndex: pick.selectedIndex,
      strategy: pick.strategy,
      photosCount: photos.length
    };
    venuePhotoCache[placeId]=next;
    saveLocal(VENUE_PHOTO_CACHE_KEY,venuePhotoCache);
    if(DEV_PLACES_LOGGING){
      console.log(`[PlacesPhoto] place_id=${placeId} photos=${pick.photosCount} selectedIndex=${pick.selectedIndex} strategy=${pick.strategy}`);
    }
    return { url, selectedIndex: pick.selectedIndex, photosCount: photos.length, photos, mode, strategy: pick.strategy };
  }
  function getRankByLabel(rankBy){
    if(!google?.maps?.places?.RankBy) return rankBy;
    const entries=Object.entries(google.maps.places.RankBy);
    const match=entries.find(([,value])=>value===rankBy);
    return match ? match[0] : rankBy;
  }
  function summarizePlaceTypes(results=[]){
    const typeCounts={};
    const top=results.slice(0,20).map(place=>({
      name: place?.name||"Unknown",
      primaryType: place?.types?.[0]||"unknown"
    }));
    results.forEach(place=>{
      const primary=place?.types?.[0]||"unknown";
      typeCounts[primary]=(typeCounts[primary]||0)+1;
    });
    return { typeCounts, top };
  }
  function logPlacesRequest(endpoint,params,results){
    if(!DEV_PLACES_LOGGING) return;
    const normalizedParams={ ...params };
    if("rankBy" in normalizedParams) normalizedParams.rankBy=getRankByLabel(normalizedParams.rankBy);
    const summary=summarizePlaceTypes(results);
    console.log(`[Places][${endpoint}] request`,normalizedParams);
    console.log(`[Places][${endpoint}] type counts`,summary.typeCounts);
    console.log(`[Places][${endpoint}] top 20`,summary.top);
  }
  const GENERIC_PLACE_TYPES=new Set([
    "point_of_interest",
    "establishment",
    "food",
    "store",
    "premise"
  ]);
  const PUB_BAR_NAME_HINTS=[
    "hotel",
    "arms",
    "tavern",
    "inn",
    "public house",
    "pub",
    "bar",
    "brewpub",
    "taproom"
  ];
  function getPlaceTypes(place){
    const types=Array.isArray(place?.types) ? place.types : [];
    const normalized=types.map(type=>String(type).toLowerCase());
    const primaryType=place?.primaryType ? String(place.primaryType).toLowerCase() : "";
    if(primaryType && !normalized.includes(primaryType)) normalized.push(primaryType);
    return normalized;
  }
  function classifyPlace(place){
    const types=getPlaceTypes(place);
    if(types.includes("bar")) return { isPubBar:true, reason:"type:bar" };
    if(types.includes("pub")) return { isPubBar:true, reason:"type:pub" };
    const name=(place?.name||"").toLowerCase();
    const hasGenericTypes=types.length===0 || types.every(type=>GENERIC_PLACE_TYPES.has(type));
    if(name && hasGenericTypes){
      const hit=PUB_BAR_NAME_HINTS.find(hint=>name.includes(hint));
      if(hit) return { isPubBar:true, reason:`name:${hit}` };
    }
    return { isPubBar:false, reason: types.length ? `types:${types.join(",")}` : "no-types" };
  }
  function isPubBarPlace(place){
    if(place?.clubLane) return true;
    return classifyPlace(place).isPubBar;
  }
  function isCafePlace(place){
    return (place?.types||[]).includes("cafe");
  }
  function enforcePubFirstComposition(places,{ includeCafes=false }={}){
    if(!Array.isArray(places)||places.length===0||includeCafes) return places;
    const pubs=places.filter(isPubBarPlace);
    const others=places.filter(place=>!isPubBarPlace(place));
    if(!others.length||!pubs.length) return places;
    const maxOthers=Math.floor((pubs.length/PUB_BAR_MIN_SHARE)-pubs.length);
    if(others.length<=maxOthers) return places;
    return [...pubs,...others.slice(0,Math.max(0,maxOthers))];
  }
  async function fetchPlacesByType({ request, type, keyword, searchId, signal }){
    if(!placesService) return [];
    if(signal?.aborted) return [];
    const collected=[];
    const scopedRequest={ ...request, type, ...(keyword ? { keyword } : {}) };
    return new Promise((resolve)=>{
      let pagesFetched=0;
      let resolved=false;
      const handlePage=(results,status,pagination)=>{
        if(signal?.aborted){
          if(!resolved){ resolved=true; resolve([]); }
          return;
        }
        if(searchId!==activeSearchId){
          if(DEBUG_PERF) console.log(`[Perf] stale search ignored (${searchId})`);
          if(!resolved){ resolved=true; resolve([]); }
          return;
        }
        if(status===google.maps.places.PlacesServiceStatus.OK&&Array.isArray(results)){
          collected.push(...results);
        }
        pagesFetched+=1;
        if(DEBUG_PERF) console.log(`[Perf] ${type}${keyword?`+${keyword}`:""} pages fetched: ${pagesFetched}`);
        if(pagination&&pagination.hasNextPage&&pagesFetched<MAX_PAGES_PER_PASS){
          setTimeout(()=>pagination.nextPage(),200);
        } else {
          if(!resolved){ resolved=true; resolve(collected); }
        }
      };
      placesService.nearbySearch(scopedRequest,(results,status,pagination)=>{
        handlePage(results,status,pagination);
        if(!pagination||!pagination.hasNextPage||pagesFetched>=MAX_PAGES_PER_PASS){
          logPlacesRequest("nearbySearch",scopedRequest,collected);
        }
      });
    });
  }
  async function fetchPlacesByText({ request, query, searchId, signal }){
    if(!placesService) return [];
    if(signal?.aborted) return [];
    const collected=[];
    const scopedRequest={ ...request, query };
    return new Promise((resolve)=>{
      let pagesFetched=0;
      let resolved=false;
      const handlePage=(results,status,pagination)=>{
        if(signal?.aborted){
          if(!resolved){ resolved=true; resolve([]); }
          return;
        }
        if(searchId!==activeSearchId){
          if(DEBUG_PERF) console.log(`[Perf] stale search ignored (${searchId})`);
          if(!resolved){ resolved=true; resolve([]); }
          return;
        }
        if(status===google.maps.places.PlacesServiceStatus.OK&&Array.isArray(results)){
          collected.push(...results);
        }
        pagesFetched+=1;
        if(DEBUG_PERF) console.log(`[Perf] text+${query} pages fetched: ${pagesFetched}`);
        if(pagination&&pagination.hasNextPage&&pagesFetched<MAX_PAGES_PER_PASS){
          setTimeout(()=>pagination.nextPage(),200);
        } else {
          if(!resolved){ resolved=true; resolve(collected); }
        }
      };
      placesService.textSearch(scopedRequest,(results,status,pagination)=>{
        handlePage(results,status,pagination);
        if(!pagination||!pagination.hasNextPage||pagesFetched>=MAX_PAGES_PER_PASS){
          logPlacesRequest("textSearch",scopedRequest,collected);
        }
      });
    });
  }
  function calculateRadiusFromBounds(bounds){
    const center=bounds.getCenter();
    const ne=bounds.getNorthEast();
    const radiusKm=haversine(center.lat(),center.lng(),ne.lat(),ne.lng());
    const viewRadius=Math.round(radiusKm*1000);
    const radiusMeters=Math.min(PLACES_QUERY_RADIUS_MAX_M,Math.max(Math.max(PLACES_QUERY_RADIUS_MIN_M,DEFAULT_CITY_RADIUS_M),viewRadius));
    return radiusMeters;
  }
  function getIncludeCafes(){
    const flag=window.SUNNY_INCLUDE_CAFES;
    if(typeof flag==="boolean") return flag;
    try{
      const raw=localStorage.getItem("sunny_include_cafes");
      if(raw===null) return INCLUDE_CAFES_DEFAULT;
      return raw==="1"||raw==="true";
    } catch {
      return INCLUDE_CAFES_DEFAULT;
    }
  }
  async function fetchPlacesForBounds(bounds,searchId,signal){
    const center=bounds.getCenter();
    let radius=calculateRadiusFromBounds(bounds);
    const centerLocation={lat:center.lat(),lng:center.lng()};
    const distanceRequest={ location: centerLocation, rankBy: google.maps.places.RankBy.DISTANCE };
    const textBaseRequest={ location: centerLocation, radius };
    const includeCafes=getIncludeCafes();
    const responses=[];
    for(const type of PRIMARY_PUB_TYPES){
      throwIfAborted(signal);
      const results=await fetchPlacesByType({ request: distanceRequest, type, searchId, signal });
      if(DEBUG_PLACES) console.log(`[Places] ${type} results: ${results.length}`);
      responses.push({ results, outdoor: false, label: type, pass: "primary" });
    }
    for(const type of SECONDARY_PUB_TYPES){
      throwIfAborted(signal);
      const results=await fetchPlacesByType({ request: distanceRequest, type, searchId, signal });
      if(DEBUG_PLACES) console.log(`[Places] secondary ${type} results: ${results.length}`);
      responses.push({ results, outdoor: false, label: type, pass: "secondary-pub" });
    }
    const outdoorPasses=[
      { type: "bar", keyword: "beer garden", label: "bar+beer garden" },
      { type: "restaurant", keyword: "outdoor seating", label: "restaurant+outdoor seating" }
    ];
    if(includeCafes){
      outdoorPasses.push({ type: "cafe", keyword: "alfresco", label: "cafe+alfresco" });
    }
    for(const pass of outdoorPasses){
      throwIfAborted(signal);
      const results=await fetchPlacesByType({ request: distanceRequest, type: pass.type, keyword: pass.keyword, searchId, signal });
      if(DEBUG_PLACES) console.log(`[Places] ${pass.label} results: ${results.length}`);
      responses.push({ results, outdoor: true, label: pass.label });
    }
    const clubQueries=["bowling club","bowls club","bowlo","sports club"];
    const clubNameHints=["bowling club","bowls club","bowlo","sports club","workers club","rsl","leagues"];
    const clubSanityCheck=(place)=>{
      const name=(place?.name||"").toLowerCase();
      return clubNameHints.some(hint=>name.includes(hint));
    };
    const clubExclusions=[];
    const logClubExclusion=(place,reason)=>{
      if(!DEBUG_PLACES) return;
      clubExclusions.push({ name: place?.name||"Unknown", reason });
    };
    const clubLaneCounts=[];
    for(const query of clubQueries){
      throwIfAborted(signal);
      const results=await fetchPlacesByText({ request: textBaseRequest, query, searchId, signal });
      const saneResults=results.filter(place=>{
        const keep=clubSanityCheck(place);
        if(!keep) logClubExclusion(place,"excluded: club sanity");
        return keep;
      });
      if(DEBUG_PLACES){
        clubLaneCounts.push({ query, total: results.length, sane: saneResults.length });
      }
      responses.push({ results: saneResults, outdoor: true, label: `club+${query}`, clubLane: true });
    }

    const primaryCount=responses
      .filter(entry=>entry.pass==="primary")
      .reduce((sum,entry)=>sum+entry.results.length,0);
    if(primaryCount<MIN_PRIMARY_RESULTS){
      radius=Math.min(PLACES_QUERY_RADIUS_MAX_M,radius+RADIUS_EXPANSION_STEP_M);
      const expansionRequest={ ...textBaseRequest, radius };
      for(const type of SECONDARY_FOOD_TYPES){
        throwIfAborted(signal);
        const results=await fetchPlacesByType({ request: distanceRequest, type, searchId, signal });
        if(DEBUG_PLACES) console.log(`[Places] fallback ${type} results: ${results.length}`);
        responses.push({ results, outdoor: false, label: `fallback-${type}` });
      }
      if(includeCafes){
        throwIfAborted(signal);
        const cafeResults=await fetchPlacesByType({ request: distanceRequest, type: "cafe", searchId, signal });
        responses.push({ results: cafeResults, outdoor: false, label: "fallback-cafe" });
      }
      const fallbackQueries=["pub", "bar"];
      for(const query of fallbackQueries){
        throwIfAborted(signal);
        const results=await fetchPlacesByText({ request: expansionRequest, query, searchId, signal });
        responses.push({ results, outdoor: false, label: `fallback-text-${query}` });
      }
    }
    if(DEBUG_PLACES){
      clubLaneCounts.forEach(entry=>{
        console.log(`[Clubs] ${entry.query} results: ${entry.total} (after sanity ${entry.sane})`);
      });
    }
    const merged=[];
    const seen=new Set();
    const mergedById=new Map();
    const totalCount=responses.reduce((sum,entry)=>sum+entry.results.length,0);
    responses.forEach(entry=>{
      entry.results.forEach(place=>{
        if(place&&place.place_id&&!seen.has(place.place_id)){
          seen.add(place.place_id);
          if(entry.outdoor) place.outdoorLikely=true;
          if(entry.clubLane){
            place.clubLane=true;
            place.primaryCategoryOverride="Club";
          }
          merged.push(place);
          mergedById.set(place.place_id,place);
        } else if(place&&place.place_id&&entry.outdoor){
          const existing=mergedById.get(place.place_id);
          if(existing) existing.outdoorLikely=true;
          if(existing&&entry.clubLane){
            existing.clubLane=true;
            existing.primaryCategoryOverride="Club";
          }
        }
      });
    });
    if(DEBUG_PLACES) console.log(`[Places] merged ${totalCount} results, deduped ${merged.length}`);
    const allowTypes=["bar","pub","restaurant","night_club",...(includeCafes?["cafe"]:[])];
    const excludeTypes=[
      "fast_food_restaurant",
      "convenience_store","gas_station","supermarket","grocery_or_supermarket",
      "pharmacy","drugstore","department_store","shopping_mall",
      "meal_delivery","meal_takeaway"
    ];
    const nameExclusions=[
      "zambrero","mcdonald","kfc","subway","domino","pizza hut","hungry jack","guzman","gyg","taco bell",
      "7-eleven","7 eleven","bp","shell","ampol","caltex","mobil","service station","petrol","servo"
    ];
    const excludedSamples=[];
    const logExclusion=(place,reason)=>{
      if(!DEBUG_FILTERS||excludedSamples.length>=5) return;
      excludedSamples.push({ name: place?.name||"Unknown", reason });
    };
    const beforeCount=merged.length;
    const allowFiltered=merged.filter(place=>{
      const types=place?.types||[];
      const keep=place?.clubLane ? true : types.some(type=>allowTypes.includes(type));
      if(!keep) logExclusion(place,"excluded: not hospitality");
      return keep;
    });
    const excludeFiltered=allowFiltered.filter(place=>{
      const types=place?.types||[];
      const keep=!types.some(type=>excludeTypes.includes(type));
      if(!keep){
        const hit=types.find(type=>excludeTypes.includes(type));
        logExclusion(place,`excluded: ${hit}`);
        if(place?.clubLane) logClubExclusion(place,`excluded: ${hit}`);
      }
      return keep;
    });
    const nameFiltered=excludeFiltered.filter(place=>{
      const name=(place?.name||"").toLowerCase();
      const hit=nameExclusions.find(term=>name.includes(term));
      if(hit){
        logExclusion(place,`excluded: name ${hit}`);
        if(place?.clubLane) logClubExclusion(place,`excluded: name ${hit}`);
        return false;
      }
      return true;
    });
    const cafeFiltered=nameFiltered.filter(place=>includeCafes || !isCafePlace(place));
    const outdoorFiltered=cafeFiltered.filter(place=>{
      const outdoorLikely=!!place.outdoorLikely||getOutdoorLikely(place);
      place.outdoorLikely=outdoorLikely;
      if(OUTDOOR_ONLY && !outdoorLikely){
        logExclusion(place,"excluded: no outdoor signal");
        if(place?.clubLane) logClubExclusion(place,"excluded: no outdoor signal");
      }
      return OUTDOOR_ONLY ? outdoorLikely : true;
    });
    if(DEBUG_PLACES){
      const clubDisplayedCount=outdoorFiltered.filter(place=>place?.clubLane).length;
      console.log(`[Clubs] final displayed: ${clubDisplayedCount}`);
      if(clubExclusions.length){
        console.log("[Clubs] excluded items:",clubExclusions);
      }
    }
    if(DEBUG_FILTERS){
      console.log(`[Filters] before ${beforeCount}`);
      console.log(`[Filters] after allowlist ${allowFiltered.length}`);
      console.log(`[Filters] after exclude types ${excludeFiltered.length}`);
      console.log(`[Filters] after name excludes ${nameFiltered.length}`);
      console.log(`[Filters] after cafe filter ${cafeFiltered.length}`);
      console.log(`[Filters] after outdoor required ${outdoorFiltered.length}`);
      if(excludedSamples.length){
        console.log("[Filters] sample exclusions:",excludedSamples);
      }
    }
    const compositionAdjusted=enforcePubFirstComposition(outdoorFiltered,{ includeCafes });
    const finalPlaces=compositionAdjusted.slice(0,Math.max(MIN_TOTAL_RESULTS,compositionAdjusted.length));
    if(DEBUG_FILTERS||DEV_PLACES_LOGGING){
      const pubCount=finalPlaces.filter(isPubBarPlace).length;
      console.log(`[Places] final composition pubs/bars ${pubCount}/${finalPlaces.length}`);
    }
    return finalPlaces;
  }

  async function fetchPlacesByTypeForCrawl({ request, type, keyword, requestId }){
    if(!placesService) return [];
    if(requestId!==crawlBuildRequestId) return [];
    const collected=[];
    const scopedRequest={ ...request, type, ...(keyword ? { keyword } : {}) };
    return new Promise((resolve)=>{
      let pagesFetched=0;
      let resolved=false;
      const handlePage=(results,status,pagination)=>{
        if(requestId!==crawlBuildRequestId){
          if(!resolved){ resolved=true; resolve([]); }
          return;
        }
        if(status===google.maps.places.PlacesServiceStatus.OK&&Array.isArray(results)){
          collected.push(...results);
        }
        pagesFetched+=1;
        if(pagination&&pagination.hasNextPage&&pagesFetched<MAX_PAGES_PER_PASS){
          setTimeout(()=>pagination.nextPage(),200);
        } else if(!resolved){
          resolved=true;
          resolve(collected);
        }
      };
      placesService.nearbySearch(scopedRequest,(results,status,pagination)=>{
        handlePage(results,status,pagination);
      });
    });
  }

  async function fetchPlacesByTextForCrawl({ request, query, requestId }){
    if(!placesService) return [];
    if(requestId!==crawlBuildRequestId) return [];
    const collected=[];
    const scopedRequest={ ...request, query };
    return new Promise((resolve)=>{
      let pagesFetched=0;
      let resolved=false;
      const handlePage=(results,status,pagination)=>{
        if(requestId!==crawlBuildRequestId){
          if(!resolved){ resolved=true; resolve([]); }
          return;
        }
        if(status===google.maps.places.PlacesServiceStatus.OK&&Array.isArray(results)){
          collected.push(...results);
        }
        pagesFetched+=1;
        if(pagination&&pagination.hasNextPage&&pagesFetched<MAX_PAGES_PER_PASS){
          setTimeout(()=>pagination.nextPage(),200);
        } else if(!resolved){
          resolved=true;
          resolve(collected);
        }
      };
      placesService.textSearch(scopedRequest,(results,status,pagination)=>{
        handlePage(results,status,pagination);
      });
    });
  }

  async function fetchPlacesForCrawlCenter(center,requestId,radiusMeters){
    const radius=Math.min(
      PLACES_QUERY_RADIUS_MAX_M,
      Math.max(PLACES_QUERY_RADIUS_MIN_M,DEFAULT_CITY_RADIUS_M,Number(radiusMeters)||0)
    );
    const centerLocation={ lat: center.lat, lng: center.lng };
    const distanceRequest={ location: centerLocation, rankBy: google.maps.places.RankBy.DISTANCE };
    const textBaseRequest={ location: centerLocation, radius };
    const includeCafes=getIncludeCafes();
    const responses=[];
    for(const type of PRIMARY_PUB_TYPES){
      if(requestId!==crawlBuildRequestId) return [];
      const results=await fetchPlacesByTypeForCrawl({ request: distanceRequest, type, requestId });
      responses.push({ results, outdoor: false, label: type, pass: "primary" });
    }
    for(const type of SECONDARY_PUB_TYPES){
      if(requestId!==crawlBuildRequestId) return [];
      const results=await fetchPlacesByTypeForCrawl({ request: distanceRequest, type, requestId });
      responses.push({ results, outdoor: false, label: type, pass: "secondary-pub" });
    }
    const outdoorPasses=[
      { type: "bar", keyword: "beer garden", label: "bar+beer garden" },
      { type: "restaurant", keyword: "outdoor seating", label: "restaurant+outdoor seating" }
    ];
    if(includeCafes){
      outdoorPasses.push({ type: "cafe", keyword: "alfresco", label: "cafe+alfresco" });
    }
    for(const pass of outdoorPasses){
      if(requestId!==crawlBuildRequestId) return [];
      const results=await fetchPlacesByTypeForCrawl({ request: distanceRequest, type: pass.type, keyword: pass.keyword, requestId });
      responses.push({ results, outdoor: true, label: pass.label });
    }
    const clubQueries=["bowling club","bowls club","bowlo","sports club"];
    const clubNameHints=["bowling club","bowls club","bowlo","sports club","workers club","rsl","leagues"];
    const clubSanityCheck=(place)=>{
      const name=(place?.name||"").toLowerCase();
      return clubNameHints.some(hint=>name.includes(hint));
    };
    for(const query of clubQueries){
      if(requestId!==crawlBuildRequestId) return [];
      const results=await fetchPlacesByTextForCrawl({ request: textBaseRequest, query, requestId });
      const saneResults=results.filter(place=>clubSanityCheck(place));
      responses.push({ results: saneResults, outdoor: true, label: `club+${query}`, clubLane: true });
    }
    const primaryCount=responses
      .filter(entry=>entry.pass==="primary")
      .reduce((sum,entry)=>sum+entry.results.length,0);
    if(primaryCount<MIN_PRIMARY_RESULTS){
      const expansionRequest={ ...textBaseRequest, radius: Math.min(PLACES_QUERY_RADIUS_MAX_M, radius+RADIUS_EXPANSION_STEP_M) };
      for(const type of SECONDARY_FOOD_TYPES){
        if(requestId!==crawlBuildRequestId) return [];
        const results=await fetchPlacesByTypeForCrawl({ request: distanceRequest, type, requestId });
        responses.push({ results, outdoor: false, label: `fallback-${type}` });
      }
      if(includeCafes){
        if(requestId!==crawlBuildRequestId) return [];
        const cafeResults=await fetchPlacesByTypeForCrawl({ request: distanceRequest, type: "cafe", requestId });
        responses.push({ results: cafeResults, outdoor: false, label: "fallback-cafe" });
      }
      const fallbackQueries=["pub", "bar"];
      for(const query of fallbackQueries){
        if(requestId!==crawlBuildRequestId) return [];
        const results=await fetchPlacesByTextForCrawl({ request: expansionRequest, query, requestId });
        responses.push({ results, outdoor: false, label: `fallback-text-${query}` });
      }
    }
    const merged=[];
    const seen=new Set();
    const mergedById=new Map();
    responses.forEach(entry=>{
      entry.results.forEach(place=>{
        if(place&&place.place_id&&!seen.has(place.place_id)){
          seen.add(place.place_id);
          if(entry.outdoor) place.outdoorLikely=true;
          if(entry.clubLane){
            place.clubLane=true;
            place.primaryCategoryOverride="Club";
          }
          merged.push(place);
          mergedById.set(place.place_id,place);
        } else if(place&&place.place_id&&entry.outdoor){
          const existing=mergedById.get(place.place_id);
          if(existing) existing.outdoorLikely=true;
          if(existing&&entry.clubLane){
            existing.clubLane=true;
            existing.primaryCategoryOverride="Club";
          }
        }
      });
    });
    const allowTypes=["bar","pub","restaurant","night_club",...(includeCafes?["cafe"]:[])];
    const excludeTypes=[
      "fast_food_restaurant",
      "convenience_store","gas_station","supermarket","grocery_or_supermarket",
      "pharmacy","drugstore","department_store","shopping_mall",
      "meal_delivery","meal_takeaway"
    ];
    const nameExclusions=[
      "zambrero","mcdonald","kfc","subway","domino","pizza hut","hungry jack","guzman","gyg","taco bell",
      "7-eleven","7 eleven","bp","shell","ampol","caltex","mobil","service station","petrol","servo"
    ];
    const allowFiltered=merged.filter(place=>{
      const types=place?.types||[];
      return place?.clubLane ? true : types.some(type=>allowTypes.includes(type));
    });
    const excludeFiltered=allowFiltered.filter(place=>{
      const types=place?.types||[];
      return !types.some(type=>excludeTypes.includes(type));
    });
    const nameFiltered=excludeFiltered.filter(place=>{
      const name=(place?.name||"").toLowerCase();
      const hit=nameExclusions.find(term=>name.includes(term));
      return !hit;
    });
    const cafeFiltered=nameFiltered.filter(place=>includeCafes || !isCafePlace(place));
    const outdoorFiltered=cafeFiltered.filter(place=>{
      const outdoorLikely=!!place.outdoorLikely||getOutdoorLikely(place);
      place.outdoorLikely=outdoorLikely;
      return OUTDOOR_ONLY ? outdoorLikely : true;
    });
    const compositionAdjusted=enforcePubFirstComposition(outdoorFiltered,{ includeCafes });
    const finalPlaces=compositionAdjusted.slice(0,Math.max(MIN_TOTAL_RESULTS,compositionAdjusted.length));
    if(DEBUG_FILTERS||DEV_PLACES_LOGGING){
      const pubCount=finalPlaces.filter(isPubBarPlace).length;
      console.log(`[Places] final crawl composition pubs/bars ${pubCount}/${finalPlaces.length}`);
    }
    return finalPlaces;
  }

  async function fetchCrawlVenuesForCenter(center,requestId,radiusMeters){
    if(requestId!==crawlBuildRequestId) return [];
    const cacheKey=getCrawlVenueCacheKey(center,radiusMeters);
    const cachedEntry=cacheKey ? getCrawlVenueCacheEntry(cacheKey) : null;
    if(cachedEntry && Date.now()-cachedEntry.ts<=VIEWPORT_CACHE_TTL_MS){
      return filterGloballyExcludedVenues(cachedEntry.data,"crawl-cache");
    }
    const places=await fetchPlacesForCrawlCenter(center,requestId,radiusMeters);
    if(requestId!==crawlBuildRequestId) return [];
    const normalized=places.map(normalizePlace).filter(Boolean);
    const filtered=filterGloballyExcludedVenues(normalized,"crawl-fetch");
    if(cacheKey) setCrawlVenueCacheEntry(cacheKey,filtered);
    if(filtered.length){
      mergeVenues(filtered);
    }
    return filtered;
  }
  function fetchVenueDetails(venue){
    if(!placesService||!venue||!venue.id) return;
    const existing=allVenues[venue.id];
    if(existing?.detailsFetched||existing?.detailsFetching||venue.detailsFetched||venue.detailsFetching) return;
    if(existing) existing.detailsFetching=true;
    venue.detailsFetching=true;
    placesService.getDetails({
      placeId: venue.id,
      fields: ["place_id","name","opening_hours","utc_offset_minutes","outdoor_seating","photos"]
    },(place,status)=>{
      if(existing) existing.detailsFetching=false;
      venue.detailsFetching=false;
      if(status===google.maps.places.PlacesServiceStatus.OK&&place){
        const openingHours=place.opening_hours||null;
        const utcOffsetMinutes=typeof place.utc_offset_minutes==="number" ? place.utc_offset_minutes : null;
        const { status:hoursStatus, nextChangeText }=computeHoursStatus({ openingHours, utcOffsetMinutes });
        const hoursText=getTodayHoursText(openingHours?.weekday_text,utcOffsetMinutes)||"";
        const detailPhoto=resolvePlacePhotoData(place,{ width: 1200, mode: "detail" });
        const updated={
          ...venue,
          openNow: typeof openingHours?.open_now==="boolean" ? openingHours.open_now : venue.openNow,
          hoursStatus,
          nextChangeText,
          hoursText,
          photo: detailPhoto || venue.photo,
          photos: detailPhoto?.photos || venue.photos || []
        };
        if(allVenues[venue.id]) allVenues[venue.id]={...allVenues[venue.id],...updated, detailsFetched:true };
        venue.detailsFetched=true;
        if(openVenueId===venue.id&&allVenues[venue.id]) showVenueCard(allVenues[venue.id]);
      }
    });
  }
  function hasOutdoorHints(tags={}){
    const t=x=>(x||"").toLowerCase();
    const name=t(tags.name);
    const desc=t(tags.description||tags.note||"");
    const outdoorExplicit=["yes","limited","seasonal"].includes(t(tags.outdoor_seating))||
      t(tags.terrace)==="yes"||t(tags.roof_terrace)==="yes"||t(tags.garden)==="yes"||
      t(tags.patio)==="yes"||t(tags.deck)==="yes"||t(tags.outdoor)==="yes";
    const nameHints=/beer ?garden|courtyard|terrace|rooftop|roof ?top|outdoor|al ?fresco|alfresco/.test(name);
    const textHints=/courtyard|terrace|rooftop|beer ?garden|patio|alfresco|sun deck/.test(desc);
    const seatHints=t(tags["seating:outdoor"])==="yes"||t(tags["seating:covered"])==="yes"||t(tags["seating:terrace"])==="yes";
    return !!(outdoorExplicit||nameHints||textHints||seatHints);
  }
  function lacksOutdoor(tags={}){
    const amenity=(tags.amenity||"").toLowerCase();
    if(!shouldRequireOutdoor(amenity)) return false;
    const t=x=>(x||"").toLowerCase();
    const flag=t(tags.outdoor_seating);
    if(flag==="no"||flag==="none") return true;
    if(t(tags["seating:outdoor"])==="no") return true;
    if(/indoor only|inside only|no outdoor/i.test(tags.description||"")) return true;
    return false;
  }
  function isDryVenue(tags={}){
    const amenity=(tags.amenity||"").toLowerCase();
    if(!shouldRequireAlcohol(amenity,tags)) return false;
    const t=x=>(x||"").toLowerCase();
    const alcoholFields=[tags.alcohol,tags["serves:alcohol"],tags["alcohol:beer"],tags["drink:beer"],tags["drink:wine"],tags["drink:cocktail"],tags["drink:spirits"],tags["drink:liquor"],tags["drink:alcohol"],tags["alcohol:spirits"]];
    if(alcoholFields.some(v=>["no","none","0"].includes(t(v)))) return true;
    if(t(tags.diet)==="no_alcohol"||t(tags["diet:alcohol_free"])==="yes") return true;
    if(["restaurant","cafe","fast_food","food_court"].includes(amenity)&&t(tags.licensed)==="no") return true;
    if(t(tags.alcohol)==="permissive"||t(tags.alcohol)==="customers") return false;
    return false;
  }
  function shouldRequireOutdoor(amenity){
    return ["biergarten","bar","pub","restaurant","cafe","fast_food","food_court","nightclub","ice_cream","brewery"].includes(amenity);
  }
  function shouldRequireAlcohol(amenity,tags={}){
    if(["biergarten","bar","pub","nightclub","brewery","microbrewery"].includes(amenity)) return true;
    if(amenity==="restaurant"||amenity==="cafe") return hasOutdoorHints(tags);
    return false;
  }
  function isClosed(tags={}){
    const t=x=>(x||"").toLowerCase();
    if(t(tags.disused)==="yes"||t(tags.abandoned)==="yes"||t(tags.closed)==="yes") return true;
    if(tags["disused:amenity"]||tags["abandoned:amenity"]||tags["was:amenity"]) return true;
    const op=t(tags.operational_status);
    if(op&&/closed|temporarily closed|permanently closed/.test(op)) return true;
    const oh=t(tags.opening_hours||"").trim();
    if(/^\s*closed\s*$/i.test(oh)) return true;
    if(t(tags["contact:status"])==="closed") return true;
    return false;
  }
  function mergeVenues(list){
    let added=0;
    for(const v of list){
      if(!v||isGloballyExcludedVenue(v)) continue;
      if(!allVenues[v.id]){
        allVenues[v.id]=v;
        added++;
      } else {
        allVenues[v.id]={...allVenues[v.id],...v};
      }
    }
    if(added) saveLocal(VENUE_CACHE_KEY,allVenues);
  }

  function clearMarkersLayer(){
    clearMarkerClusterer();
    markersById.forEach(marker=>marker.setMap(null));
    markersById.clear();
    markersLayer=[];
  }

  function clearCrawlLayer(){
    crawlLayer.forEach(marker=>marker.setMap(null));
    crawlLayer=[];
  }

  function ensureCrawlLayer(){
    if(!map) return [];
    return crawlLayer;
  }

  function fitMapToCrawlVenues(venues,{ enforceMaxZoom=true }={}){
    if(!map||!Array.isArray(venues)||venues.length===0) return;
    const bounds=new google.maps.LatLngBounds();
    let points=0;
    venues.forEach((venue)=>{
      if(typeof venue?.lat!=="number"||typeof venue?.lng!=="number") return;
      bounds.extend({ lat: venue.lat, lng: venue.lng });
      points++;
    });
    if(points===0) return;
    map.fitBounds(bounds,{ top:72,right:72,bottom:180,left:72 });
    if(enforceMaxZoom){
      google.maps.event.addListenerOnce(map,"idle",()=>{
        const maxZoom=16;
        if(map.getZoom()>maxZoom) map.setZoom(maxZoom);
      });
    }
  }

  function scheduleCrawlFit(reason="load"){
    if(!isCrawlMode||!crawlState?.venues?.length) return;
    if(reason==="load"&&hasAutoFitCrawlOnLoad) return;
    pendingCrawlFitReason=reason;
    requestAnimationFrame(()=>{
      if(pendingCrawlFitReason!==reason) return;
      pendingCrawlFitReason=null;
      if(reason==="load") hasAutoFitCrawlOnLoad=true;
      fitMapToCrawlVenues(crawlState.venues,{ enforceMaxZoom: reason!=="refresh" });
    });
  }

  function enterCrawlMode({ autoFit=false }={}){
    if(!crawlState?.venues?.length) return;
    isCrawlMode=true;
    hideVenueCard();
    clearMarkersLayer();
    renderCrawlMarkers();
    showCrawlControls();
    if(autoFit) scheduleCrawlFit("load");
  }

  function exitCrawlMode(){
    isCrawlMode=false;
    clearCrawlLayer();
    hideCrawlCard();
    if(crawlListPanel) crawlListPanel.classList.add("hidden");
    renderMarkers();
    showCrawlControls();
  }

  function clearCrawlAndReturnToMap(){
    if(!crawlState) return;
    const confirmed=window.confirm("Clear this pub crawl?");
    if(!confirmed) return;
    clearCrawlNotifications();
    crawlState=null;
    crawlBuildStartTime=null;
    hasAutoFitCrawlOnLoad=false;
    pendingCrawlFitReason=null;
    if(crawlAddPanel) crawlAddPanel.classList.add("hidden");
    exitCrawlMode();
    const url=new URL(window.location.href);
    if(url.searchParams.has("crawl")){
      url.searchParams.delete("crawl");
      window.history.replaceState({}, "", url.toString());
    }
    resetCrawlBuilderState();
  }

  function getMapCenter(){
    if(!map) return { lat: DEFAULT_VIEW.lat, lng: DEFAULT_VIEW.lng };
    const center=map.getCenter();
    return { lat: center.lat(), lng: center.lng() };
  }

  function getCrawlOrigin(){
    if(userLocation&&typeof userLocation.lat==="number") return userLocation;
    return getMapCenter();
  }

  function chooseCrawlVenuesFromList(list,origin,count=4){
    const venues=(Array.isArray(list)?list:[]).filter(v=>v&&isValidCoord(v.lat,v.lng)&&!isGloballyExcludedVenue(v));
    if(venues.length===0) return [];
    return venues
      .map(v=>({ venue:v, distance:haversine(origin.lat,origin.lng,v.lat,v.lng) }))
      .sort((a,b)=>a.distance-b.distance)
      .map(item=>item.venue)
      .slice(0,count);
  }

  function chooseCrawlVenues(origin,count=4){
    return chooseCrawlVenuesFromList(Object.values(allVenues),origin,count);
  }

  function annotateCrawlVenue(venue){
    const classification=classifyPlace(venue);
    const crawlFallback=preferPubsAndBarsForCrawls ? !classification.isPubBar : false;
    return {
      ...venue,
      crawlFallback,
      crawlPubBarReason: classification.reason
    };
  }

  function selectCrawlVenuesWithPubPreference(venues,count){
    const pubBars=[];
    const fallbacks=[];
    venues.forEach((venue)=>{
      const classification=classifyPlace(venue);
      if(classification.isPubBar){
        pubBars.push({ venue, classification });
      } else {
        fallbacks.push({ venue, classification });
      }
    });
    const selectedPubBars=pubBars.slice(0,count);
    const remaining=count-selectedPubBars.length;
    const selectedFallbacks=remaining>0 ? fallbacks.slice(0,remaining) : [];
    const selected=[
      ...selectedPubBars.map(({ venue, classification })=>({
        ...venue,
        crawlFallback:false,
        crawlPubBarReason: classification.reason
      })),
      ...selectedFallbacks.map(({ venue, classification })=>({
        ...venue,
        crawlFallback:true,
        crawlPubBarReason: classification.reason
      }))
    ];
    return {
      selected,
      pubBarCount:selectedPubBars.length,
      fallbackCount:selectedFallbacks.length,
      totalPubBars:pubBars.length
    };
  }

  function orderCrawlVenuesWithPubPreference(venues,origin,mode,startAt,maxStepMeters){
    const pubBars=venues.filter(venue=>!venue.crawlFallback);
    const fallbacks=venues.filter(venue=>venue.crawlFallback);
    if(!pubBars.length){
      return orderVenues(fallbacks,origin,mode,startAt,maxStepMeters);
    }
    const orderedPubs=orderVenues(pubBars,origin,mode,startAt,maxStepMeters);
    if(!orderedPubs.ok) return orderedPubs;
    if(!fallbacks.length) return orderedPubs;
    const fallbackOrigin=orderedPubs.venues[orderedPubs.venues.length-1];
    const orderedFallbacks=orderVenues(fallbacks,fallbackOrigin,mode,startAt,maxStepMeters);
    if(!orderedFallbacks.ok) return orderedFallbacks;
    return {
      ok:true,
      venues:[...orderedPubs.venues,...orderedFallbacks.venues],
      maxStepDistanceMeters: Math.max(
        orderedPubs.maxStepDistanceMeters || 0,
        orderedFallbacks.maxStepDistanceMeters || 0
      )
    };
  }

  function runCrawlSelectionAssertions(){
    const warn=(message)=>console.warn(`[CrawlTest] ${message}`);
    const assert=(condition,message)=>{ if(!condition) warn(message); };
    const typedPub={ name:"The Local Bar", types:["bar"] };
    const namedPub={ name:"Sunset Tavern", types:["establishment"] };
    const restaurant={ name:"Arms Cafe", types:["restaurant"] };
    assert(classifyPlace(typedPub).isPubBar,"Expected bar type to classify as pub/bar.");
    assert(classifyPlace(namedPub).isPubBar,"Expected name hint to classify as pub/bar when types are generic.");
    assert(!classifyPlace(restaurant).isPubBar,"Expected restaurant type to stay non pub/bar.");
    const sampleVenues=[
      { id:"1", name:"Pub A", types:["bar"] },
      { id:"2", name:"Cafe", types:["cafe"] },
      { id:"3", name:"Pub B", types:["pub"] }
    ];
    const fullPubs=selectCrawlVenuesWithPubPreference(sampleVenues,2);
    assert(fullPubs.selected.length===2 && fullPubs.selected.every(v=>!v.crawlFallback),"Expected pub-only crawl when enough pubs.");
    const mixed=selectCrawlVenuesWithPubPreference(sampleVenues,3);
    assert(mixed.selected[0] && !mixed.selected[0].crawlFallback && mixed.selected[2]?.crawlFallback,"Expected pubs first then fallback venues.");
    const noPubs=selectCrawlVenuesWithPubPreference([{ id:"1", name:"Cafe", types:["cafe"] }],1);
    assert(noPubs.selected[0]?.crawlFallback,"Expected fallback when no pubs.");
  }
  if(DEV_CRAWL_LOGGING) runCrawlSelectionAssertions();

  function getCrawlCandidatesFromStore(center,radiusMeters){
    const totalVenuesInStore=Object.values(allVenues).length;
    const withValidCoords=Object.values(allVenues).filter(v=>v&&isValidCoord(v.lat,v.lng));
    const candidatesAfterTypeFilter=withValidCoords.filter(v=>!isGloballyExcludedVenue(v));
    const withinRadius=candidatesAfterTypeFilter.filter(v=>{
      const distance=haversineMeters(center.lat,center.lng,v.lat,v.lng);
      return Number.isFinite(distance) && distance<=radiusMeters;
    });
    const candidatesAfterAnyOtherFilter=withinRadius;
    const candidatesAfterDedup=selectUniqueAddressVenues(candidatesAfterAnyOtherFilter,candidatesAfterAnyOtherFilter.length);
    return {
      candidates: candidatesAfterDedup,
      stats: {
        totalVenuesInStore,
        candidatesWithValidCoords: withValidCoords.length,
        candidatesAfterTypeFilter: candidatesAfterTypeFilter.length,
        candidatesAfterAnyOtherFilter: candidatesAfterAnyOtherFilter.length,
        candidatesAfterDedup: candidatesAfterDedup.length
      }
    };
  }

  function generateCrawlVenuesFromList(list,origin,count,startAt,orderMode,{ refresh=false, currentVenueIds=[], maxStepMeters=CRAWL_MAX_STEP_METERS }={}){
    const candidates=chooseCrawlVenuesFromList(list,origin,Math.max(count,Math.min(MAX_CRAWL_VENUES,refresh ? count*3 : count)));
    if(!candidates.length) return { ok:false, reason:"NOT_ENOUGH_CANDIDATES", venues: [] };
    let selectionPool=candidates;
    let selectionMeta=null;
    if(refresh&&candidates.length>count){
      const currentSet=new Set(currentVenueIds||[]);
      const alternates=candidates.filter(v=>!currentSet.has(v.id));
      const pool=alternates.length>=count ? alternates : candidates;
      const maxStart=Math.max(0,pool.length-count);
      const startIndex=maxStart>0 ? Math.floor(Math.random()*(maxStart+1)) : 0;
      const orderedPool=pool.slice(startIndex).concat(pool.slice(0,startIndex));
      selectionPool=orderedPool;
    }
    if(preferPubsAndBarsForCrawls){
      selectionMeta=selectCrawlVenuesWithPubPreference(selectionPool,count);
      selectionPool=selectionMeta.selected;
    }
    // Enforce unique addresses so a crawl never repeats a location.
    const uniqueSelected=selectUniqueAddressVenues(selectionPool,count);
    if(uniqueSelected.length<count){
      return { ok:false, reason:"NOT_ENOUGH_CANDIDATES", venues: uniqueSelected };
    }
    if(preferPubsAndBarsForCrawls && selectionMeta){
      return orderCrawlVenuesWithPubPreference(uniqueSelected,origin,orderMode,startAt,maxStepMeters);
    }
    return orderVenues(uniqueSelected,origin,orderMode,startAt,maxStepMeters);
  }

  function generateCrawlVenues(origin,count,startAt,orderMode,options){
    return generateCrawlVenuesFromList(Object.values(allVenues),origin,count,startAt,orderMode,{ maxStepMeters: CRAWL_MAX_STEP_METERS, ...options });
  }

  function buildCrawlState(venues,startAt,originInfo=null,orderMode="location",maxStepDistanceMeters=CRAWL_MAX_STEP_METERS){
    const filtered=Array.isArray(venues) ? venues.filter(v=>v&&!isGloballyExcludedVenue(v)) : [];
    const uniqueVenues=[];
    const usedAddresses=new Set();
    filtered.forEach((venue)=>{
      const key=normalizeAddressKey(venue);
      if(!key||usedAddresses.has(key)) return;
      usedAddresses.add(key);
      uniqueVenues.push(annotateCrawlVenue(venue));
    });
    if((DEBUG_FILTERS||DEV_PLACES_LOGGING)&&uniqueVenues.length!==filtered.length){
      console.log(`[Crawl] removed ${filtered.length-uniqueVenues.length} duplicate-address venues from crawl.`);
    }
    const normalized=uniqueVenues.map((venue,index)=>({
      ...venue,
      crawlIndex:index,
      address: venue.address || formatAddress(venue.tags||{}),
      hangMinutes:CRAWL_DEFAULT_HANG_MINUTES,
      remind:false
    }));
    const pubBarCount=normalized.filter(venue=>!venue.crawlFallback).length;
    const fallbackCount=normalized.length-pubBarCount;
    crawlState={
      venues: normalized,
      startAt,
      origin: originInfo,
      orderMode,
      maxStepDistanceMeters,
      pubBarCount,
      fallbackCount
    };
    updateCrawlSchedule();
  }

  function updateCrawlSchedule(){
    if(!crawlState||!crawlState.venues) return;
    let cursor=crawlState.startAt instanceof Date ? new Date(crawlState.startAt) : new Date();
    crawlState.venues.forEach((venue)=>{
      const start=new Date(cursor);
      const end=new Date(cursor.getTime()+venue.hangMinutes*60000);
      venue.slot={ start, end };
      cursor=end;
    });
  }

  function getSunScore(venue,time){
    if(!venue||!time) return -Infinity;
    const { altitudeDeg }=sunPosition(venue.lat,venue.lng,time);
    return altitudeDeg;
  }

  function pickNextCrawlVenue(remaining,current,mode,startAt,maxStepMeters){
    const candidates=[];
    remaining.forEach((venue,index)=>{
      const distance=haversineMeters(current.lat,current.lng,venue.lat,venue.lng);
      if(Number.isFinite(distance) && distance<=maxStepMeters){
        candidates.push({ venue, index, distance });
      }
    });
    if(!candidates.length) return null;
    const pool=candidates;
    let bestIndex=pool[0]?.index ?? 0;
    let bestDistance=Infinity;
    let bestScore=-Infinity;
    pool.forEach((item)=>{
      if(mode==="sun"){
        const score=getSunScore(item.venue,startAt);
        if(score>bestScore || (score===bestScore && item.distance<bestDistance)){
          bestScore=score;
          bestDistance=item.distance;
          bestIndex=item.index;
        }
      }else{
        if(item.distance<bestDistance){
          bestDistance=item.distance;
          bestIndex=item.index;
        }
      }
    });
    const [next]=remaining.splice(bestIndex,1);
    return { venue: next, distance: bestDistance };
  }

  function orderVenues(venues,origin,mode,startAt,maxStepMeters){
    if(!Array.isArray(venues)) return { ok:false, reason:"OTHER", venues: [] };
    if(!isValidCoord(origin?.lat,origin?.lng)) return { ok:false, reason:"INVALID_COORDS", venues: [] };
    const candidates=venues.filter(v=>v&&isValidCoord(v.lat,v.lng));
    if(candidates.length===0) return { ok:false, reason:"INVALID_COORDS", venues: [] };
    const seedRanked=[...candidates]
      .map((venue,index)=>({
        index,
        distance:haversineMeters(origin.lat,origin.lng,venue.lat,venue.lng)
      }))
      .filter(item=>Number.isFinite(item.distance))
      .sort((a,b)=>a.distance-b.distance);
    const seedIndices=new Set(seedRanked.slice(0,Math.min(10,seedRanked.length)).map(item=>item.index));
    if(mode==="sun"){
      const sunRanked=[...candidates]
        .map((venue,index)=>({ index, score:getSunScore(venue,startAt) }))
        .sort((a,b)=>b.score-a.score);
      sunRanked.slice(0,Math.min(5,sunRanked.length)).forEach(item=>seedIndices.add(item.index));
    }
    const maxSeeds=Math.min(20,candidates.length);
    while(seedIndices.size<maxSeeds){
      seedIndices.add(Math.floor(Math.random()*candidates.length));
    }
    let bestResult=null;
    for(const seedIndex of seedIndices){
      const seedVenue=candidates[seedIndex];
      if(!seedVenue) continue;
      const remaining=candidates.filter((_,idx)=>idx!==seedIndex);
      const firstDistance=haversineMeters(origin.lat,origin.lng,seedVenue.lat,seedVenue.lng);
      if(!Number.isFinite(firstDistance) || firstDistance>maxStepMeters) continue;
      const ordered=[seedVenue];
      let current=seedVenue;
      let maxDistance=firstDistance;
      let failed=false;
      while(remaining.length){
        const next=pickNextCrawlVenue(remaining,current,mode,startAt,maxStepMeters);
        if(!next){
          failed=true;
          break;
        }
        ordered.push(next.venue);
        if(next.distance>maxDistance) maxDistance=next.distance;
        current=next.venue;
      }
      if(!failed){
        const result={ ok:true, venues: ordered, maxStepDistanceMeters: Math.round(maxDistance) };
        if(!bestResult || result.maxStepDistanceMeters<bestResult.maxStepDistanceMeters){
          bestResult=result;
        }
      }
    }
    if(bestResult) return bestResult;
    return { ok:false, reason:"NO_VALID_PATH_WITHIN_CONSTRAINTS", venues: [] };
  }

  function clearCrawlNotifications(){
    crawlNotifications.forEach((timeoutId)=>clearTimeout(timeoutId));
    crawlNotifications.clear();
  }

  function scheduleCrawlReminder(venue){
    if(!venue||!venue.slot||!venue.slot.end) return;
    if(!("Notification" in window)) return;
    if(Notification.permission!=="granted") return;
    const delay=venue.slot.end.getTime()-Date.now();
    if(delay<=0) return;
    const timeoutId=setTimeout(()=>{
      new Notification("Time to move on",{
        body:`Head to the next venue after ${venue.name||"this stop"}.`,
        icon:"icons/apple-touch-icon.png"
      });
      crawlNotifications.delete(venue.id);
    },delay);
    crawlNotifications.set(venue.id,timeoutId);
  }

  function refreshCrawlReminders(){
    clearCrawlNotifications();
    if(!crawlState) return;
    crawlState.venues.forEach((venue,index)=>{
      if(index===crawlState.venues.length-1) return;
      if(venue.remind) scheduleCrawlReminder(venue);
    });
  }

  function serializeCrawl(){
    if(!crawlState||!crawlState.venues) return null;
      const data={
      startAt: crawlState.startAt instanceof Date ? crawlState.startAt.toISOString() : null,
      origin: crawlState.origin || null,
      orderMode: crawlState.orderMode || "location",
      venues: crawlState.venues.map(v=>({
        id:v.id,
        name:v.name,
        lat:v.lat,
        lng:v.lng,
        address: v.address || formatAddress(v.tags || {}),
        hangMinutes:v.hangMinutes
      }))
    };
    const json=JSON.stringify(data);
    return btoa(unescape(encodeURIComponent(json)));
  }

  function hydrateCrawlFromLink(encoded){
    if(!encoded) return false;
    try{
      const json=decodeURIComponent(escape(atob(encoded)));
      const data=JSON.parse(json);
      if(!data||!Array.isArray(data.venues)) return false;
      const startAt=data.startAt ? new Date(data.startAt) : new Date();
      const origin=data.origin || null;
      const orderMode=data.orderMode || "location";
      const venues=data.venues.map((v,index)=>({
        ...v,
        crawlIndex:index,
        hangMinutes:Number(v.hangMinutes)||CRAWL_DEFAULT_HANG_MINUTES,
        remind:false
      }));
      const filtered=venues.filter(v=>v&&!isGloballyExcludedVenue(v));
      const uniqueVenues=selectUniqueAddressVenues(filtered,filtered.length).map(annotateCrawlVenue);
      const pubBarCount=uniqueVenues.filter(venue=>!venue.crawlFallback).length;
      const fallbackCount=uniqueVenues.length-pubBarCount;
      crawlState={ venues: uniqueVenues, startAt, origin, orderMode, pubBarCount, fallbackCount };
      updateCrawlSchedule();
      hasAutoFitCrawlOnLoad=false;
      enterCrawlMode({ autoFit:true });
      updateCrawlList();
      return true;
    } catch(err){
      console.warn("Unable to hydrate crawl link",err);
      return false;
    }
  }

  // Map
  function setupMap(){
    if(!document.getElementById("map")){ const m=document.createElement("div"); m.id="map"; m.style.position="absolute"; m.style.left="0"; m.style.right="0"; m.style.top="0"; m.style.bottom="0"; document.body.appendChild(m); }
    map=new google.maps.Map(document.getElementById("map"),{
      center:{ lat: DEFAULT_VIEW.lat, lng: DEFAULT_VIEW.lng },
      zoom: DEFAULT_VIEW.zoom
    });
    markerIcon={
      url: MARKER_ICON_URL,
      scaledSize: new google.maps.Size(32, 32),
      anchor: new google.maps.Point(16, 16)
    };
    placesService=new google.maps.places.PlacesService(map);
    autocompleteService=new google.maps.places.AutocompleteService();
    map.addListener("idle",()=>{
      if(!hasInitialMapLoad){
        hasInitialMapLoad=true;
        loadVisibleTiles({ immediate: true });
        return;
      }
      debouncedLoadVisible();
    });
    map.addListener("click",()=>{
      hideVenueCard();
      hideCrawlCard();
    });
    addLocateControl();
    centerOnUserIfAvailable();
  }
  function debouncedLoadVisible(){
    if(moveTimer) clearTimeout(moveTimer);
    moveTimer=setTimeout(()=>loadVisibleTiles({ immediate: false }),MOVE_DEBOUNCE_MS);
  }

  async function loadVisibleTiles({ immediate=false }={}){
    if(!map||!placesService) return;
    const requestId=++activeRequestId;
    activeSearchId=requestId;
    if(activeRequestController) activeRequestController.abort();
    const requestController=new AbortController();
    activeRequestController=requestController;
    const { signal }=requestController;
    const perfStart=performance.now();
    const fetchReason=immediate ? "initial" : "map_move";
    perfLog("load start",{ requestId, immediate });
    const b=map.getBounds();
    if(!b){
      hideVenueStatus();
      return;
    }
    const cacheKey=getViewportCacheKey();
    const cachedEntry=cacheKey ? getViewportCacheEntry(cacheKey) : null;
    const cacheAge=cachedEntry ? Date.now()-cachedEntry.ts : null;
    const cacheFresh=cachedEntry && cacheAge<=VIEWPORT_CACHE_TTL_MS;
    const cacheStale=cachedEntry && cacheAge>VIEWPORT_CACHE_TTL_MS && cacheAge<=VIEWPORT_CACHE_STALE_MS;
    if(cacheFresh && Array.isArray(cachedEntry.data)){
      if(requestId!==activeRequestId) return;
      const cachedFiltered=filterGloballyExcludedVenues(cachedEntry.data,"cache");
      if(cachedFiltered.length){
        mergeVenues(cachedFiltered);
        renderMarkers({ perfStart, cacheStatus: "hit" });
        hideVenueStatus();
      } else {
        showVenueStatus("empty","No sunny venues found here — try zooming out or moving the map.");
      }
      trackEvent("venues_fetch_completed",{
        fetch_time_ms: Math.round(performance.now()-perfStart),
        results_count: cachedFiltered.length,
        cache_hit: true,
        reason: fetchReason
      });
      perfLog("cache hit",{ requestId, ageMs: cacheAge });
      return;
    }
    if(cacheStale && Array.isArray(cachedEntry.data)){
      const cachedFiltered=filterGloballyExcludedVenues(cachedEntry.data,"cache");
      if(cachedFiltered.length){
        mergeVenues(cachedFiltered);
        renderMarkers({ cacheStatus: "stale" });
        hideVenueStatus();
      } else {
        showVenueStatus("loading","Loading venues…");
      }
      perfLog("cache stale",{ requestId, ageMs: cacheAge });
    } else if(!cacheStale) {
      showVenueStatus("loading","Loading venues…");
    }
    try{
      const places=await fetchPlacesForBounds(b,requestId,signal);
      if(requestId!==activeRequestId){
        perfLog("stale load ignored",{ requestId });
        return;
      }
      const normalized=places.map(normalizePlace).filter(Boolean);
      const filtered=filterGloballyExcludedVenues(normalized,"fetch");
      if(cacheKey) setViewportCacheEntry(cacheKey,filtered);
      if(filtered.length){
        mergeVenues(filtered);
        renderMarkers({ perfStart, cacheStatus: cacheStale ? "stale-refresh" : "miss" });
        hideVenueStatus();
      } else {
        showVenueStatus("empty","No sunny venues found here — try zooming out or moving the map.");
      }
      trackEvent("venues_fetch_completed",{
        fetch_time_ms: Math.round(performance.now()-perfStart),
        results_count: filtered.length,
        reason: fetchReason
      });
    } catch(e){
      if(signal.aborted){
        perfLog("load aborted",{ requestId });
        return;
      }
      if(requestId!==activeRequestId) return;
      showVenueStatus("error","Couldn’t load venues. Please try again.");
      trackEvent("venues_fetch_completed",{
        fetch_time_ms: Math.round(performance.now()-perfStart),
        results_count: 0,
        reason: fetchReason
      });
      console.error("Places error:",e);
    }
  }

  function ensureDetailCard(){
    if(detailCard){
      stripLegacyRating(detailCard.container);
      return detailCard;
    }
    const existing=document.getElementById("venue-card");
    if(existing) existing.remove();
    const container=document.createElement("div");
    container.id="venue-card";
    container.className="venue-card hidden";
    container.innerHTML=`
      <div class="venue-card__inner">
        <div class="venue-card__handle"></div>
        <div class="venue-card__header">
          <div class="venue-card__title">
            <div class="venue-card__name-row">
              <div class="venue-card__name"></div>
              <div class="venue-card__rating-inline">
                <div class="rating-display hidden" aria-label="Outdoor area rating">
                  <div class="rating-display__stars">
                    <span class="rating-star rating-star--display" data-value="1">★</span>
                    <span class="rating-star rating-star--display" data-value="2">★</span>
                    <span class="rating-star rating-star--display" data-value="3">★</span>
                    <span class="rating-star rating-star--display" data-value="4">★</span>
                    <span class="rating-star rating-star--display" data-value="5">★</span>
                  </div>
                  <span class="rating-display__label"></span>
                </div>
              </div>
            </div>
            <div class="venue-card__meta"></div>
            <div class="venue-card__address"></div>
          </div>
          <button class="venue-card__close" type="button" aria-label="Close details">×</button>
        </div>
        <div class="venue-card__photo-strip hidden" aria-label="Venue photos"></div>
        <div class="venue-card__section-title">Current weather</div>
        <div class="venue-card__badges">
          <span class="chip chip-sun"><span class="chip-emoji">☀️</span><span class="chip-label">Full sun</span></span>
          <span class="chip chip-open"></span>
        </div>
        <div class="venue-card__hours hidden"></div>
        <div class="venue-card__hours-next hidden"></div>
        <div class="venue-card__note"></div>
        <div class="venue-card__section-title">Outdoor area rating</div>
        <div class="venue-card__rating-row">
          <div class="venue-card__rating-summary venue-card__rating-placeholder">Rating coming soon</div>
          <button class="venue-card__fab-item venue-card__rate-btn" type="button" data-action="rate">Rate outdoor area</button>
        </div>
        <div class="venue-card__actions">
          <a class="action primary" target="_blank" rel="noopener" data-action="directions">Directions</a>
          <a class="action" target="_blank" rel="noopener" data-action="uber">Ride</a>
          <a class="action muted" target="_blank" rel="noopener" data-action="website">Website</a>
        </div>
        <div class="venue-card__fab" aria-haspopup="true">
          <button class="venue-card__fab-toggle" type="button" aria-label="More actions" aria-expanded="false">+</button>
          <div class="venue-card__fab-menu" role="menu">
            <button class="venue-card__fab-item venue-card__rate-btn" type="button" data-action="rate">Rate</button>
            <button class="venue-card__fab-item" type="button" data-action="add-images">Add images</button>
          </div>
        </div>
        <input class="venue-card__file-input" type="file" accept="image/*" capture="environment" multiple hidden>
        <div class="venue-card__upload-hint hidden" role="status">
          <span class="venue-card__upload-text"></span>
          <button class="venue-card__upload-dismiss" type="button" aria-label="Dismiss photo tip">×</button>
        </div>
      </div>`;
    stripLegacyRating(container);
    document.body.appendChild(container);
    const closeBtn=container.querySelector(".venue-card__close");
    closeBtn.addEventListener("click",()=>hideVenueCard());
    const fabToggle=container.querySelector(".venue-card__fab-toggle");
    const fabMenu=container.querySelector(".venue-card__fab-menu");
    const addImagesButton=container.querySelector('[data-action="add-images"]');
    const fileInput=container.querySelector(".venue-card__file-input");
    const uploadHint=container.querySelector(".venue-card__upload-hint");
    const uploadHintText=container.querySelector(".venue-card__upload-text");
    const uploadDismiss=container.querySelector(".venue-card__upload-dismiss");
    const rateButtons=Array.from(container.querySelectorAll(".venue-card__rate-btn"));
    const setFabOpen=(isOpen)=>{
      container.classList.toggle("fab-open",!!isOpen);
      if(fabMenu) fabMenu.classList.toggle("show",!!isOpen);
      if(fabToggle){
        fabToggle.setAttribute("aria-expanded",isOpen?"true":"false");
        fabToggle.textContent=isOpen?"×":"+";
        fabToggle.setAttribute("aria-label",isOpen?"Close actions":"More actions");
      }
    };
    if(fabToggle){
      fabToggle.addEventListener("click",(event)=>{
        event.stopPropagation();
        setFabOpen(!container.classList.contains("fab-open"));
      });
    }
    document.addEventListener("click",(event)=>{
      if(!container.contains(event.target)) setFabOpen(false);
    });
    if(fabMenu){
      fabMenu.addEventListener("click",(event)=>event.stopPropagation());
    }
    setFabOpen(false);
    if(addImagesButton&&fileInput){
      addImagesButton.addEventListener("click",(event)=>{
        event.stopPropagation();
        if(uploadHint&&uploadHintText){
          uploadHintText.textContent="Choose or take photos of this venue. Your device may ask for camera or photo permissions.";
          uploadHint.classList.remove("hidden");
        }
        fileInput.value="";
        fileInput.click();
        setFabOpen(false);
      });
      fileInput.addEventListener("change",()=>{
        const count=fileInput.files?fileInput.files.length:0;
        if(!uploadHint||!uploadHintText) return;
        if(count>0){
          uploadHintText.textContent=count===1?"1 photo selected. Thanks for sharing!":`${count} photos selected. Thanks for sharing!`;
          uploadHint.classList.remove("hidden");
        } else {
          uploadHintText.textContent="";
          uploadHint.classList.add("hidden");
        }
      });
    }
    const hideUploadHint=()=>{
      if(!uploadHint||!uploadHintText) return;
      uploadHintText.textContent="";
      uploadHint.classList.add("hidden");
    };
    if(uploadDismiss){
      uploadDismiss.addEventListener("click",(event)=>{
        event.stopPropagation();
        hideUploadHint();
      });
    }
    hideUploadHint();
    detailCard={
      container,
      nameEl:container.querySelector(".venue-card__name"),
      metaEl:container.querySelector(".venue-card__meta"),
      addressEl:container.querySelector(".venue-card__address"),
      openChip:container.querySelector(".chip-open"),
      hoursEl:container.querySelector(".venue-card__hours"),
      hoursNextEl:container.querySelector(".venue-card__hours-next"),
      sunChip:container.querySelector(".chip-sun"),
      weatherLabel:container.querySelector(".venue-card__section-title"),
      noteEl:container.querySelector(".venue-card__note"),
      photoStripEl:container.querySelector(".venue-card__photo-strip"),
      ratingDisplay:container.querySelector(".rating-display"),
      rateButton:rateButtons[0]||null,
      rateButtons,
      fabToggle,
      fabMenu,
      addImagesButton,
      fileInput,
      uploadHint,
      uploadHintText,
      uploadDismiss,
      hideUploadHint,
      setFabOpen,
      currentVenue:null,
      actions:{
        directions:container.querySelector('[data-action="directions"]'),
        uber:container.querySelector('[data-action="uber"]'),
        website:container.querySelector('[data-action="website"]')
      }
    };
    if(detailCard.actions.directions){
      detailCard.actions.directions.addEventListener("click",()=>{
        if(detailCard.currentVenue) trackVenueAction("directions",detailCard.currentVenue);
      });
    }
    if(detailCard.actions.website){
      detailCard.actions.website.addEventListener("click",()=>{
        if(detailCard.currentVenue) trackVenueAction("website",detailCard.currentVenue);
      });
    }
    assert(!container.querySelector(".chip-fallback"),"Venue card should not render a fallback label.");
    return detailCard;
  }
  function ensureImageViewerModal(){
    if(imageViewerModal) return imageViewerModal;
    const container=document.createElement("div");
    container.className="image-viewer hidden";
    container.innerHTML=`
      <div class="image-viewer__backdrop" data-close="true"></div>
      <div class="image-viewer__card" role="dialog" aria-modal="true" aria-label="Venue photos viewer">
        <button class="image-viewer__close" type="button" aria-label="Close image viewer">×</button>
        <button class="image-viewer__arrow image-viewer__arrow--prev" type="button" aria-label="Previous photo">‹</button>
        <img class="image-viewer__image" alt="Venue photo" loading="lazy" decoding="async">
        <div class="image-viewer__placeholder hidden">Image unavailable</div>
        <button class="image-viewer__arrow image-viewer__arrow--next" type="button" aria-label="Next photo">›</button>
      </div>`;
    document.body.appendChild(container);
    const imageEl=container.querySelector(".image-viewer__image");
    const placeholderEl=container.querySelector(".image-viewer__placeholder");
    const prevBtn=container.querySelector(".image-viewer__arrow--prev");
    const nextBtn=container.querySelector(".image-viewer__arrow--next");
    let photos=[];
    let index=0;
    let touchStartX=0;
    const render=()=>{
      const total=photos.length;
      if(!total) return;
      const current=photos[index]||photos[0];
      const url=getLargeUrl(current,1200)||getThumbnailUrl(current,400);
      if(url){
        imageEl.src=url;
        imageEl.classList.remove("hidden");
        placeholderEl.classList.add("hidden");
      } else {
        imageEl.removeAttribute("src");
        imageEl.classList.add("hidden");
        placeholderEl.classList.remove("hidden");
      }
      prevBtn.disabled=total<2;
      nextBtn.disabled=total<2;
    };
    const close=()=>{
      container.classList.add("hidden");
      container.classList.remove("show");
      imageEl.removeAttribute("src");
    };
    const move=(delta)=>{
      if(photos.length<2) return;
      index=(index+delta+photos.length)%photos.length;
      render();
    };
    container.addEventListener("click",(event)=>{
      if(event.target.dataset.close==="true") close();
    });
    container.querySelector(".image-viewer__close").addEventListener("click",close);
    prevBtn.addEventListener("click",()=>move(-1));
    nextBtn.addEventListener("click",()=>move(1));
    imageEl.onerror=()=>{
      imageEl.classList.add("hidden");
      placeholderEl.classList.remove("hidden");
    };
    container.addEventListener("touchstart",(event)=>{ touchStartX=event.changedTouches?.[0]?.clientX||0; },{ passive:true });
    container.addEventListener("touchend",(event)=>{
      const endX=event.changedTouches?.[0]?.clientX||0;
      const diff=endX-touchStartX;
      if(Math.abs(diff)<35) return;
      move(diff>0?-1:1);
    },{ passive:true });
    const onKeyDown=(event)=>{
      if(container.classList.contains("hidden")) return;
      if(event.key==="Escape") close();
      if(event.key==="ArrowLeft") move(-1);
      if(event.key==="ArrowRight") move(1);
    };
    document.addEventListener("keydown",onKeyDown);
    imageViewerModal={ open(nextPhotos=[],initialIndex=0){ photos=Array.isArray(nextPhotos)?nextPhotos:[]; index=Math.max(0,Math.min(initialIndex,photos.length-1)); if(!photos.length) return; render(); container.classList.remove("hidden"); container.classList.add("show"); }, close };
    return imageViewerModal;
  }
  function renderVenueThumbnails(card,venue){
    const strip=card?.photoStripEl;
    if(!strip) return;
    const cachedPhotos=venue?.id&&Array.isArray(venuePhotoCache?.[venue.id]?.photos)?venuePhotoCache[venue.id].photos:[];
    const photos=Array.isArray(venue?.photos)&&venue.photos.length?venue.photos:cachedPhotos;
    strip.innerHTML="";
    if(!photos.length){
      strip.classList.add("hidden");
      return;
    }
    const maxVisible=3;
    const visible=photos.slice(0,maxVisible);
    const hiddenCount=Math.max(0,photos.length-maxVisible);
    visible.forEach((photo,index)=>{
      const button=document.createElement("button");
      button.type="button";
      button.className="venue-thumb";
      button.setAttribute("aria-label",`Open photo ${index+1} of ${photos.length}`);
      const img=document.createElement("img");
      img.className="venue-thumb__img";
      img.loading="lazy";
      img.decoding="async";
      img.alt=`${venue?.name||"Venue"} photo ${index+1}`;
      const url=getThumbnailUrl(photo,400);
      if(url) img.src=url;
      else button.classList.add("is-fallback");
      img.onerror=()=>button.classList.add("is-fallback");
      button.appendChild(img);
      if(hiddenCount>0&&index===visible.length-1){
        const overlay=document.createElement("span");
        overlay.className="venue-thumb__more";
        overlay.textContent=`+${hiddenCount}`;
        button.appendChild(overlay);
      }
      button.addEventListener("click",()=>ensureImageViewerModal().open(photos,index));
      strip.appendChild(button);
    });
    strip.classList.remove("hidden");
  }

  function hideVenueCard(){
    if(!detailCard) return;
    if(detailCard.setFabOpen) detailCard.setFabOpen(false);
    if(detailCard.hideUploadHint) detailCard.hideUploadHint();
    detailCard.container.classList.add("hidden");
    detailCard.container.classList.remove("show");
    detailCard.container.removeAttribute("data-venue-id");
    openVenueId=null;
  }
  function applyToneClass(el,tone){
    if(!el) return;
    el.classList.remove("chip-good","chip-warn","chip-info","chip-muted");
    if(tone==="good") el.classList.add("chip-good");
    else if(tone==="warn") el.classList.add("chip-warn");
    else if(tone==="info") el.classList.add("chip-info");
    else el.classList.add("chip-muted");
  }
  function showVenueCard(v){
    if(isGloballyExcludedVenue(v)){
      hideVenueCard();
      return;
    }
    const card=ensureDetailCard();
    trackVenueCardOpened(card,v);
    openVenueId=v.id;
    card.currentVenue=v;
    fetchVenueDetails(v);
    if(card.setFabOpen) card.setFabOpen(false);
    const tags=v.tags||{};
    const kind=v.primaryCategory||toTitle(tags.amenity||tags.tourism||"");
    const distance=userLocation?formatDistanceKm(haversine(userLocation.lat,userLocation.lng,v.lat,v.lng)):null;
    const address=v.address||formatAddress(tags);
    const hasValidCoords=Number.isFinite(v.lat)&&Number.isFinite(v.lng);
    const sun=hasValidCoords?sunBadge(v.lat,v.lng):null;
    const open=resolveOpenStatus(v);
    const website=(tags.website||tags.contact_website||tags.url)?String(tags.website||tags.contact_website||tags.url).replace(/^http:\/\//,'https://'):null;

    card.container.dataset.venueId=v.id;
    card.nameEl.textContent=v.name||"Outdoor venue";
    card.metaEl.textContent=[kind,distance].filter(Boolean).join(" · ")||"";
    if(address){
      card.addressEl.textContent=address;
      card.addressEl.classList.remove("hidden");
    } else {
      card.addressEl.textContent="";
      card.addressEl.classList.add("hidden");
    }

    const initialWeatherLabel=formatCurrentWeatherChipLabel(sun?.label,null);
    if(initialWeatherLabel){
      card.sunChip.querySelector(".chip-emoji").textContent=(sun&&sun.icon)||"☀️";
      card.sunChip.querySelector(".chip-label").textContent=initialWeatherLabel;
      card.sunChip.classList.remove("hidden");
      card.sunChip.style.display="inline-flex";
    } else {
      card.sunChip.classList.add("hidden");
      card.sunChip.style.display="none";
    }
    if(hasValidCoords) populateCombinedWeatherChip(card.sunChip,v.lat,v.lng,sun);

    if(!open.status){
      card.openChip.textContent="";
      card.openChip.classList.add("hidden");
      card.openChip.style.display="none";
      applyToneClass(card.openChip,"muted");
    } else {
      card.openChip.textContent=open.status;
      card.openChip.classList.remove("hidden");
      card.openChip.style.display="inline-flex";
      applyToneClass(card.openChip,open.tone);
    }

    if(card.hoursEl){
      const hoursText=v.hoursText||"";
      if(hoursText){
        card.hoursEl.textContent=hoursText;
        card.hoursEl.classList.remove("hidden");
      } else {
        card.hoursEl.textContent="";
        card.hoursEl.classList.add("hidden");
      }
    }
    if(card.hoursNextEl){
      const nextChangeText=v.nextChangeText||"";
      if(nextChangeText){
        card.hoursNextEl.textContent=nextChangeText;
        card.hoursNextEl.classList.remove("hidden");
      } else {
        card.hoursNextEl.textContent="";
        card.hoursNextEl.classList.add("hidden");
      }
    }

    const outdoorHint=hasOutdoorHints(tags);
    if(outdoorHint){
      card.noteEl.textContent="Marked with outdoor seating hints on the map.";
      card.noteEl.classList.remove("hidden");
    } else {
      card.noteEl.textContent="";
      card.noteEl.classList.add("hidden");
    }

    renderVenueThumbnails(card,v);

    card.actions.directions.textContent="Google Maps";
    card.actions.directions.href=`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${v.lat},${v.lng}`)}`;
    card.actions.uber.textContent="Uber";
    card.actions.uber.href=`https://m.uber.com/ul/?action=setPickup&dropoff[latitude]=${v.lat}&dropoff[longitude]=${v.lng}&dropoff[nickname]=${encodeURIComponent(v.name)}`;
    if(website){
      card.actions.website.classList.remove("hidden");
      card.actions.website.href=website;
    } else {
      card.actions.website.classList.add("hidden");
    }

    if(card.rateButtons&&card.rateButtons.length){
      card.rateButtons.forEach(btn=>{
        btn.onclick=(event)=>{
          event.stopPropagation();
          if(card.currentVenue) openRatingCard(card.currentVenue);
          if(card.setFabOpen) card.setFabOpen(false);
        };
      });
    }
    if(card.uploadHint){
      if(card.hideUploadHint) card.hideUploadHint();
      else card.uploadHint.classList.add("hidden");
    }
    renderVenueRatingSummary(v.id);

    card.container.classList.remove("hidden");
    card.container.classList.add("show");
  }

  function showVenueCount(count){
    if(!map) return;
    if(!venueCountToast){
      venueCountToast=document.createElement("div");
      venueCountToast.id="venue-count-toast";
      Object.assign(venueCountToast.style,{
        position:"absolute",
        top:"16px",
        left:"50%",
        transform:"translateX(-50%)",
        zIndex:"1000",
        background:"#111",
        color:"#fff",
        padding:"8px 14px",
        borderRadius:"999px",
        fontWeight:"700",
        fontSize:"14px",
        boxShadow:"0 10px 25px rgba(15,23,42,0.25)",
        opacity:"0",
        transition:"opacity 150ms ease",
        pointerEvents:"none"
      });
      map.getDiv().appendChild(venueCountToast);
    }
    venueCountToast.textContent=count===0?"No venues in view":count===1?"1 venue in view":`${count} venues in view`;
    venueCountToast.style.opacity="1";
    if(venueCountTimer) clearTimeout(venueCountTimer);
    venueCountTimer=setTimeout(()=>{
      if(venueCountToast){
        venueCountToast.style.opacity="0";
      }
    },3000);
  }

  function renderMarkers({ perfStart=null, cacheStatus=null }={}){
    if(!map) return;
    if(isCrawlMode&&crawlState&&crawlState.venues&&crawlState.venues.length){
      clearMarkersLayer();
      return;
    }
    const reopenVenueId=openVenueId;
    let reopenVenue=null;
    isRenderingMarkers=true;
    const b=map.getBounds();
    if(!b){ isRenderingMarkers=false; return; }
    const visibleVenues=[];
    Object.values(allVenues).forEach(v=>{
      if(!v||typeof v.lat!=="number"||typeof v.lng!=="number") return;
      if(isGloballyExcludedVenue(v)) return;
      if(!b.contains(new google.maps.LatLng(v.lat,v.lng))) return;
      visibleVenues.push(v);
      if(reopenVenueId&&reopenVenueId===v.id) reopenVenue=v;
    });
    const visibleIds=new Set(visibleVenues.map(v=>v.id));
    markersById.forEach((marker,id)=>{
      if(!visibleIds.has(id)){
        marker.setMap(null);
        markersById.delete(id);
      }
    });
    visibleVenues.forEach(v=>{
      let marker=markersById.get(v.id);
      if(!marker){
        marker=new google.maps.Marker({
          position:{ lat: v.lat, lng: v.lng },
          icon: markerIcon
        });
        marker.addListener("click",()=>{
          openVenueId=v.id;
          showVenueCard(v);
        });
        markersById.set(v.id,marker);
      } else {
        const pos=marker.getPosition();
        if(!pos||pos.lat()!==v.lat||pos.lng()!==v.lng){
          marker.setPosition({ lat: v.lat, lng: v.lng });
        }
        if(markerIcon&&marker.getIcon()!==markerIcon){
          marker.setIcon(markerIcon);
        }
      }
    });
    const visibleMarkers=visibleVenues.map(v=>markersById.get(v.id)).filter(Boolean);
    const shouldCluster=visibleMarkers.length>CLUSTER_THRESHOLD && !!getMarkerClustererClass();
    if(shouldCluster){
      const clusterer=ensureMarkerClusterer();
      if(clusterer){
        visibleMarkers.forEach(marker=>marker.setMap(null));
        clusterer.clearMarkers();
        clusterer.addMarkers(visibleMarkers);
      }
    } else {
      if(markerClusterer) clearMarkerClusterer();
      visibleMarkers.forEach(marker=>marker.setMap(map));
    }
    markersLayer=visibleMarkers;
    isRenderingMarkers=false;
    showVenueCount(visibleMarkers.length);
    if(perfStart){
      perfLog("markers rendered",{ ms: Math.round(performance.now()-perfStart), count: visibleMarkers.length, cache: cacheStatus || "none" });
    } else if(cacheStatus){
      perfLog("markers rendered",{ count: visibleMarkers.length, cache: cacheStatus });
    }
    if(reopenVenue){
      showVenueCard(reopenVenue);
    } else if(reopenVenueId){
      hideVenueCard();
    }
  }

  function createCrawlMarkerIcon(number){
    return {
      path: "M0-48c-9.9 0-18 8.1-18 18 0 13.5 18 30 18 30s18-16.5 18-30c0-9.9-8.1-18-18-18z",
      fillColor: "#ff6a00",
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 1.5,
      scale: 1,
      labelOrigin: new google.maps.Point(0,-28)
    };
  }

  function renderCrawlMarkers(){
    if(!map) return;
    ensureCrawlLayer();
    clearCrawlLayer();
    if(!isCrawlMode||!crawlState||!crawlState.venues||crawlState.venues.length===0) return;
    crawlState.venues.forEach((venue,index)=>{
      const marker=new google.maps.Marker({
        position:{ lat: venue.lat, lng: venue.lng },
        map,
        icon: createCrawlMarkerIcon(index+1),
        label: {
          text: String(index+1),
          color: "#ffffff",
          fontWeight: "700"
        }
      });
      marker.addListener("click",()=>{
        openCrawlCard(venue.id);
      });
      crawlLayer.push(marker);
    });
  }

  function ensureCrawlCard(){
    if(crawlCard) return crawlCard;
    const container=document.createElement("div");
    container.id="crawl-card";
    container.className="crawl-card hidden";
    container.innerHTML=`
      <div class="crawl-card__inner">
        <div class="crawl-card__handle"></div>
        <div class="crawl-card__header">
          <div>
            <div class="crawl-card__title"></div>
            <div class="crawl-card__subtitle"></div>
            <div class="crawl-card__address"></div>
          </div>
          <button class="crawl-card__close" type="button" aria-label="Close crawl venue">×</button>
        </div>
        <div class="crawl-card__section">
          <div class="crawl-card__section-title">Time slot</div>
          <div class="crawl-card__time-row">
            <span class="crawl-card__time-range"></span>
            <div class="crawl-card__time-controls">
              <button type="button" class="crawl-card__time-btn" data-action="decrease">−</button>
              <span class="crawl-card__time-length"></span>
              <button type="button" class="crawl-card__time-btn" data-action="increase">+</button>
            </div>
          </div>
        </div>
        <div class="crawl-card__section crawl-card__controls">
          <button type="button" class="crawl-card__remove-btn">− Remove venue</button>
          <label class="crawl-card__toggle">
            <input type="checkbox" class="crawl-card__toggle-input">
            <span class="crawl-card__toggle-track"></span>
            <span class="crawl-card__toggle-label">Remind me when it is time to move on</span>
          </label>
          <button type="button" class="crawl-card__continue hidden">
            <span>Keen to keep going? Add more places</span>
            <span class="crawl-card__continue-icon">+</span>
          </button>
          <div class="crawl-card__uber">
            <div class="crawl-card__uber-text"></div>
            <div class="crawl-card__uber-actions">
              <a class="crawl-card__uber-btn" target="_blank" rel="noopener">Book an Uber now</a>
              <a class="crawl-card__didi-btn" target="_blank" rel="noopener">Book a Didi now</a>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(container);
    const closeBtn=container.querySelector(".crawl-card__close");
    closeBtn.addEventListener("click",hideCrawlCard);
    const removeBtn=container.querySelector(".crawl-card__remove-btn");
    const toggleInput=container.querySelector(".crawl-card__toggle-input");
    const continueBtn=container.querySelector(".crawl-card__continue");
    const timeButtons=Array.from(container.querySelectorAll(".crawl-card__time-btn"));
    removeBtn.addEventListener("click",()=>{
      if(!crawlState||!crawlCard.currentVenueId) return;
      const nextVenues=crawlState.venues.filter(v=>v.id!==crawlCard.currentVenueId);
      if(nextVenues.length===0){
        crawlState=null;
        isCrawlMode=false;
        renderCrawlMarkers();
        hideCrawlCard();
        updateCrawlList();
        hideCrawlControls();
        showCrawlFab();
        renderMarkers();
        return;
      }
      crawlState.venues=nextVenues.map((venue,index)=>({ ...venue, crawlIndex:index }));
      const pubBarCount=crawlState.venues.filter(v=>!v.crawlFallback).length;
      crawlState.pubBarCount=pubBarCount;
      crawlState.fallbackCount=crawlState.venues.length-pubBarCount;
      updateCrawlSchedule();
      renderCrawlMarkers();
      updateCrawlCard(crawlCard.currentVenueId);
      updateCrawlList();
    });
    toggleInput.addEventListener("change",async()=>{
      if(!crawlState||!crawlCard.currentVenueId) return;
      const venue=crawlState.venues.find(v=>v.id===crawlCard.currentVenueId);
      if(!venue) return;
      if(toggleInput.checked&&("Notification" in window)&&Notification.permission==="default"){
        try{
          await Notification.requestPermission();
        } catch (err){
          console.warn("Notification permission failed",err);
        }
      }
      venue.remind=toggleInput.checked;
      refreshCrawlReminders();
    });
    if(continueBtn){
      continueBtn.addEventListener("click",()=>{
        openCrawlAddPanel();
      });
    }
    timeButtons.forEach(btn=>{
      btn.addEventListener("click",()=>{
        if(!crawlState||!crawlCard.currentVenueId) return;
        const venue=crawlState.venues.find(v=>v.id===crawlCard.currentVenueId);
        if(!venue) return;
        const delta=btn.dataset.action==="increase" ? CRAWL_TIME_STEP_MINUTES : -CRAWL_TIME_STEP_MINUTES;
        const next=Math.max(15,venue.hangMinutes+delta);
        venue.hangMinutes=next;
        updateCrawlSchedule();
        updateCrawlCard(crawlCard.currentVenueId);
        updateCrawlList();
        refreshCrawlReminders();
      });
    });
    crawlCard={
      container,
      titleEl:container.querySelector(".crawl-card__title"),
      subtitleEl:container.querySelector(".crawl-card__subtitle"),
      addressEl:container.querySelector(".crawl-card__address"),
      timeRangeEl:container.querySelector(".crawl-card__time-range"),
      timeLengthEl:container.querySelector(".crawl-card__time-length"),
      removeBtn,
      toggleInput,
      continueBtn,
      uberWrap:container.querySelector(".crawl-card__uber"),
      uberBtn:container.querySelector(".crawl-card__uber-btn"),
      didiBtn:container.querySelector(".crawl-card__didi-btn"),
      uberText:container.querySelector(".crawl-card__uber-text")
    };
    return crawlCard;
  }

  function updateCrawlCard(venueId){
    const card=ensureCrawlCard();
    if(!crawlState||!crawlState.venues) return;
    const venue=crawlState.venues.find(v=>v.id===venueId);
    if(!venue) return;
    card.currentVenueId=venueId;
    const position=venue.crawlIndex+1;
    card.titleEl.textContent=venue.name || `Crawl stop ${position}`;
    card.subtitleEl.textContent=`Stop ${position} of ${crawlState.venues.length}`;
    card.addressEl.textContent=venue.address || formatAddress(venue.tags||{});
    card.timeRangeEl.textContent=formatTimeRange(venue.slot?.start,venue.slot?.end);
    card.timeLengthEl.textContent=`${venue.hangMinutes} min`;
    const isLast=venue.crawlIndex===crawlState.venues.length-1;
    if(isLast){
      venue.remind=false;
      card.toggleInput.checked=false;
    } else {
      card.toggleInput.checked=!!venue.remind;
    }
    card.toggleInput.closest(".crawl-card__toggle").classList.toggle("hidden",isLast);
    if(card.continueBtn){
      card.continueBtn.classList.toggle("hidden",!isLast);
    }
    const nextVenue=!isLast ? crawlState.venues[venue.crawlIndex+1] : null;
    if(nextVenue){
      card.uberWrap.classList.remove("hidden");
      const hasCoords=typeof venue.lat==="number"&&typeof venue.lng==="number"
        &&typeof nextVenue.lat==="number"&&typeof nextVenue.lng==="number";
      const distanceMeters=hasCoords ? haversine(venue.lat,venue.lng,nextVenue.lat,nextVenue.lng)*1000 : 0;
      const walkMins=Math.max(1,Math.round(distanceMeters/80));
      card.uberText.textContent=`Up next: ${nextVenue.name || "the next venue"}, ${walkMins} min walk or book a ride.`;
      const uberUrl=`https://m.uber.com/ul/?action=setPickup&dropoff[latitude]=${nextVenue.lat}&dropoff[longitude]=${nextVenue.lng}&dropoff[nickname]=${encodeURIComponent(nextVenue.name || "Next venue")}`;
      const didiUrl="https://www.didiglobal.com/";
      card.uberBtn.href=uberUrl;
      if(card.didiBtn){
        card.didiBtn.href=didiUrl;
      }
    } else {
      card.uberWrap.classList.add("hidden");
      card.uberText.textContent="";
      card.uberBtn.removeAttribute("href");
      if(card.didiBtn){
        card.didiBtn.removeAttribute("href");
      }
    }
    card.container.classList.remove("hidden");
    requestAnimationFrame(()=>card.container.classList.add("show"));
  }

  function openCrawlCard(venueId){
    hideVenueCard();
    updateCrawlCard(venueId);
  }

  function hideCrawlCard(){
    if(!crawlCard) return;
    crawlCard.container.classList.remove("show");
    crawlCard.container.classList.add("hidden");
    crawlCard.currentVenueId=null;
  }

  function ensureCrawlControls(){
    if(crawlControls) return crawlControls;
    const container=document.createElement("div");
    container.className="crawl-controls hidden";
    container.innerHTML=`
      <button class="crawl-control hidden" type="button" data-action="mode-toggle">Hide crawl</button>
      <button class="crawl-control crawl-control--icon hidden" type="button" data-action="refresh" aria-label="Refresh crawl venues">
        <span aria-hidden="true">↻</span>
      </button>
      <button class="crawl-control crawl-control--icon" type="button" data-action="list" aria-label="View crawl list">
        <span aria-hidden="true">☰</span>
      </button>
      <button class="crawl-control crawl-control--icon" type="button" data-action="clear" aria-label="Clear crawl">
        <span aria-hidden="true">×</span>
      </button>
      <button class="crawl-control crawl-control--icon" type="button" data-action="add" aria-label="Add venue">
        <span aria-hidden="true">+</span>
      </button>
      <button class="crawl-control crawl-control--icon" type="button" data-action="share" aria-label="Share crawl">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M18 8a3 3 0 1 0-2.83-4H15a3 3 0 0 0 .17 1L8.91 8.3a3 3 0 0 0-1.82-.61 3 3 0 1 0 2.65 4.41l5.36 3.09A3 3 0 0 0 15 16a3 3 0 1 0 .17-1l-5.36-3.09a3 3 0 0 0 0-1.82l5.36-3.09A3 3 0 0 0 18 8Z"/>
        </svg>
      </button>
    `;
    document.body.appendChild(container);
    container.addEventListener("click",(event)=>{
      const btn=event.target.closest(".crawl-control");
      if(!btn) return;
      const action=btn.dataset.action;
      if(action==="mode-toggle"){
        if(isCrawlMode) exitCrawlMode();
        else enterCrawlMode();
      }
      if(action==="refresh") refreshCrawlVenues();
      if(action==="list") toggleCrawlList();
      if(action==="clear") clearCrawlAndReturnToMap();
      if(action==="add") openCrawlAddPanel();
      if(action==="share") shareCrawl();
    });
    crawlControls=container;
    return crawlControls;
  }

  function showCrawlControls(){
    const controls=ensureCrawlControls();
    const hasActiveCrawl=!!crawlState?.venues?.length;
    controls.classList.toggle("hidden",!hasActiveCrawl);
    const modeBtn=controls.querySelector('[data-action="mode-toggle"]');
    const showModeToggle=hasActiveCrawl;
    modeBtn?.classList.toggle("hidden",!showModeToggle);
    if(modeBtn){
      modeBtn.textContent=isCrawlMode ? "Hide crawl" : "View crawl";
      modeBtn.setAttribute("aria-label",isCrawlMode ? "Hide crawl" : "View crawl");
    }
    controls.querySelector('[data-action="refresh"]')?.classList.toggle("hidden",!hasActiveCrawl||!isCrawlMode);
    controls.querySelector('[data-action="list"]')?.classList.toggle("hidden",!hasActiveCrawl||!isCrawlMode);
    controls.querySelector('[data-action="clear"]')?.classList.toggle("hidden",!hasActiveCrawl);
    controls.querySelector('[data-action="add"]')?.classList.toggle("hidden",!hasActiveCrawl||!isCrawlMode);
    controls.querySelector('[data-action="share"]')?.classList.toggle("hidden",!hasActiveCrawl||!isCrawlMode);
    if(hasActiveCrawl) hideCrawlFab();
    else showCrawlFab();
  }

  function hideCrawlControls(){
    if(!crawlControls) return;
    crawlControls.classList.add("hidden");
  }

  function refreshCrawlVenues(){
    if(!crawlState?.venues?.length) return;
    const origin=crawlState.origin || getCrawlOrigin();
    const venueCount=Math.max(1,crawlState.venues.length);
    const orderMode=crawlState.orderMode || "location";
    const startAt=crawlState.startAt instanceof Date ? crawlState.startAt : new Date();
    const currentVenueIds=crawlState.venues.map(v=>v.id);
    const maxStepDistanceMeters=crawlState.maxStepDistanceMeters || CRAWL_MAX_STEP_METERS;
    const refreshResult=generateCrawlVenues(origin,venueCount,startAt,orderMode,{ refresh:true, currentVenueIds, maxStepMeters: maxStepDistanceMeters });
    if(!refreshResult.ok){
      alert(`Couldn’t build a crawl within ${formatDistanceKm(maxStepDistanceMeters/1000)} between stops. Try increasing the distance limit or reducing number of stops.`);
      return;
    }
    buildCrawlState(refreshResult.venues,startAt,origin,orderMode,maxStepDistanceMeters);
    if(isCrawlMode){
      renderCrawlMarkers();
      scheduleCrawlFit("refresh");
    }
    updateCrawlList();
    refreshCrawlReminders();
    showCrawlControls();
  }

  function ensureCrawlListPanel(){
    if(crawlListPanel) return crawlListPanel;
    const panel=document.createElement("div");
    panel.className="crawl-list hidden";
    panel.innerHTML=`
      <div class="crawl-list__header">
        <div>
          <h3>Pub crawl stops</h3>
          <p class="crawl-list__subtitle"></p>
          <p class="crawl-list__notice hidden"></p>
        </div>
        <button type="button" class="crawl-list__close" aria-label="Close list">×</button>
      </div>
      <div class="crawl-list__items"></div>
    `;
    document.body.appendChild(panel);
    panel.querySelector(".crawl-list__close").addEventListener("click",()=>panel.classList.add("hidden"));
    crawlListPanel=panel;
    return panel;
  }

  function updateCrawlList(){
    if(!crawlState||!crawlState.venues) return;
    const panel=ensureCrawlListPanel();
    const items=panel.querySelector(".crawl-list__items");
    const subtitle=panel.querySelector(".crawl-list__subtitle");
    const notice=panel.querySelector(".crawl-list__notice");
    subtitle.textContent=`${crawlState.venues.length} venues · Start ${formatTime(crawlState.startAt)}`;
    if(notice){
      if(preferPubsAndBarsForCrawls && crawlState.pubBarCount===0 && crawlState.fallbackCount>0){
        notice.textContent="No pubs/bars found nearby — showing other venues instead.";
        notice.classList.remove("hidden");
      } else {
        notice.textContent="";
        notice.classList.add("hidden");
      }
    }
    items.innerHTML="";
    const firstVenueName=(crawlState.venues[0]?.name||"").trim();
    const hasFirstVenueName=!!firstVenueName;
    const hasCurrentLocation=!!(userLocation&&typeof userLocation.lat==="number"&&typeof userLocation.lng==="number");
    crawlState.venues.forEach((venue,index)=>{
      const previous=index>0 ? crawlState.venues[index-1] : null;
      const origin=crawlState.origin && typeof crawlState.origin.lat==="number" ? crawlState.origin : null;
      const originLabel=origin?.label || "start point";
      const fromPoint=previous || origin;
      const fromLabel=previous ? (previous.name || "previous venue") : originLabel;
      const distanceKm=fromPoint ? haversine(fromPoint.lat,fromPoint.lng,venue.lat,venue.lng) : 0;
      const distanceLabel=fromPoint ? `${formatDistanceKm(distanceKm)} from ${fromLabel}` : "Start of the crawl";
      const fare=estimateUberFare(distanceKm);
      let uberText=`$${fare} Uber fare`;
      if(hasFirstVenueName){
        uberText+=` to ${firstVenueName}`;
      }
      if(hasFirstVenueName&&hasCurrentLocation){
        uberText+=" from your current location.";
      } else {
        uberText+=".";
      }
      const uberLink=fromPoint
        ? `https://m.uber.com/ul/?action=setPickup&pickup[latitude]=${fromPoint.lat}&pickup[longitude]=${fromPoint.lng}&pickup[nickname]=${encodeURIComponent(fromLabel)}&dropoff[latitude]=${venue.lat}&dropoff[longitude]=${venue.lng}&dropoff[nickname]=${encodeURIComponent(venue.name || "Next venue")}`
        : "";
      const item=document.createElement("div");
      item.className="crawl-list__item";
      item.innerHTML=`
        <div>
          <div class="crawl-list__title">${venue.crawlIndex+1}. ${venue.name||"Venue"}</div>
          <div class="crawl-list__meta">${distanceLabel}</div>
          <div class="crawl-list__uber">
            <span>${uberText}</span>
            <a class="crawl-list__uber-btn" target="_blank" rel="noopener" ${fromPoint ? `href="${uberLink}"` : "aria-disabled=\"true\""}>Book Uber now</a>
          </div>
        </div>
        <div class="crawl-list__time">${formatTimeRange(venue.slot?.start,venue.slot?.end)}</div>
      `;
      item.addEventListener("click",()=>{
        if(map) panToLocation(venue.lat,venue.lng,Math.max(map.getZoom(),15));
        openCrawlCard(venue.id);
      });
      items.appendChild(item);
    });
  }

  function toggleCrawlList(){
    if(!crawlState) return;
    const panel=ensureCrawlListPanel();
    updateCrawlList();
    panel.classList.toggle("hidden");
  }

  function ensureCrawlAddPanel(){
    if(crawlAddPanel) return crawlAddPanel;
    const panel=document.createElement("div");
    panel.className="crawl-add hidden";
    panel.innerHTML=`
      <div class="crawl-add__panel">
        <div class="crawl-add__header">
          <h3>Add venues</h3>
          <button type="button" class="crawl-add__close" aria-label="Close add venues">×</button>
        </div>
        <input class="crawl-add__input" type="search" placeholder="Search by venue name">
        <div class="crawl-add__results"></div>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector(".crawl-add__close").addEventListener("click",()=>panel.classList.add("hidden"));
    panel.addEventListener("click",(event)=>{
      if(event.target===panel) panel.classList.add("hidden");
    });
    const input=panel.querySelector(".crawl-add__input");
    input.addEventListener("input",()=>renderCrawlAddResults(input.value));
    crawlAddPanel=panel;
    return panel;
  }

  function openCrawlAddPanel(){
    if(!crawlState) return;
    const panel=ensureCrawlAddPanel();
    panel.classList.remove("hidden");
    const input=panel.querySelector(".crawl-add__input");
    input.value="";
    input.focus();
    renderCrawlAddResults("");
  }

  function renderCrawlAddResults(query=""){
    if(!crawlState||!crawlAddPanel) return;
    const resultsEl=crawlAddPanel.querySelector(".crawl-add__results");
    resultsEl.innerHTML="";
    const term=query.trim().toLowerCase();
    if(term.length<2){
      resultsEl.innerHTML=`<div class="crawl-add__empty">Type at least 2 letters to search.</div>`;
      return;
    }
    const existingIds=new Set(crawlState.venues.map(v=>v.id));
    const existingAddressKeys=new Set(crawlState.venues.map(v=>normalizeAddressKey(v)).filter(Boolean));
    const matches=Object.values(allVenues)
      .filter(v=>v&&v.name&&v.name.toLowerCase().includes(term))
      .filter(v=>!isGloballyExcludedVenue(v))
      .filter(v=>!existingIds.has(v.id))
      .filter(v=>!existingAddressKeys.has(normalizeAddressKey(v)))
      .slice(0,10);
    if(matches.length===0){
      resultsEl.innerHTML=`<div class="crawl-add__empty">No matches found.</div>`;
      return;
    }
    matches.forEach((venue)=>{
      const row=document.createElement("button");
      row.type="button";
      row.className="crawl-add__row";
      row.innerHTML=`
        <span>
          <strong>${venue.name}</strong>
          <span class="crawl-add__meta">${formatAddress(venue.tags||{})}</span>
        </span>
        <span class="crawl-add__action">Add</span>
      `;
      row.addEventListener("click",()=>{
        if(crawlState.venues.length>=MAX_CRAWL_VENUES) return;
        if(existingAddressKeys.has(normalizeAddressKey(venue))) return;
        const nextVenue=annotateCrawlVenue({
          ...venue,
          crawlIndex:crawlState.venues.length,
          address: venue.address || formatAddress(venue.tags||{}),
          hangMinutes:CRAWL_DEFAULT_HANG_MINUTES,
          remind:false
        });
        crawlState.venues.push(nextVenue);
        const pubBarCount=crawlState.venues.filter(v=>!v.crawlFallback).length;
        crawlState.pubBarCount=pubBarCount;
        crawlState.fallbackCount=crawlState.venues.length-pubBarCount;
        updateCrawlSchedule();
        renderCrawlMarkers();
        updateCrawlList();
        crawlAddPanel.classList.add("hidden");
      });
      resultsEl.appendChild(row);
    });
  }

  function shareCrawl(){
    if(!crawlState) return;
    const encoded=serializeCrawl();
    if(!encoded) return;
    const url=new URL(window.location.href);
    url.searchParams.set("crawl",encoded);
    if(navigator.share){
      navigator.share({ title:"Sunny pub crawl", text:"Join my pub crawl", url:url.toString() })
        .then(()=>{
          trackEvent("crawl_shared",{
            venue_count: crawlState.venues?.length || 0,
            share_method: "native_share"
          });
        })
        .catch(()=>{});
      return;
    }
    navigator.clipboard?.writeText(url.toString()).then(()=>{
      alert("Crawl link copied to clipboard!");
      trackEvent("crawl_shared",{
        venue_count: crawlState.venues?.length || 0,
        share_method: "copy_link"
      });
    }).catch(()=>{
      prompt("Copy this crawl link:",url.toString());
      trackEvent("crawl_shared",{
        venue_count: crawlState.venues?.length || 0,
        share_method: "share_button"
      });
    });
  }

  function ensureCrawlBuilder(){
    if(crawlBuilder) return crawlBuilder;
    const container=document.createElement("div");
    container.id="crawl-builder";
    container.className="crawl-builder hidden";
    container.innerHTML=`
      <div class="crawl-builder__backdrop"></div>
      <div class="crawl-builder__panel">
        <div class="crawl-builder__header">
          <h2>Plan a pub crawl</h2>
          <button type="button" class="crawl-builder__close" aria-label="Close pub crawl builder">×</button>
        </div>
        <div class="crawl-builder__loading hidden" aria-live="polite">
          <img class="crawl-builder__loading-logo" src="icons/apple-touch-icon.png" alt="Sunny logo">
          <div class="crawl-builder__loading-text">Building your pub crawl</div>
        </div>
        <div class="crawl-builder__body">
          <div class="crawl-builder__section">
            <button type="button" class="crawl-option" data-option="nearby">Plan a pub crawl nearby</button>
            <button type="button" class="crawl-option" data-option="around">Plan a pub crawl around</button>
            <label class="crawl-builder__label" for="crawl-location-input">Enter an Australian postcode or suburb</label>
            <input id="crawl-location-input" class="crawl-builder__input" type="text" placeholder="e.g. 2000 or Fitzroy" autocomplete="off">
            <div class="crawl-builder__suggestions"></div>
            <div class="crawl-builder__status" role="status"></div>
          </div>
          <div class="crawl-builder__section crawl-order">
            <h3>Order places based on sun or location?</h3>
            <div class="crawl-builder__order-options">
              <button type="button" class="crawl-order-option" data-order="sun">Sun</button>
              <button type="button" class="crawl-order-option" data-order="location">Location</button>
            </div>
          </div>
          <div class="crawl-builder__section crawl-start hidden">
            <h3>When do you want to start?</h3>
            <div class="crawl-builder__start-options">
              <button type="button" class="crawl-start-option" data-start="now">Now</button>
              <button type="button" class="crawl-start-option" data-start="time">Select a time</button>
            </div>
            <input class="crawl-builder__time-input hidden" type="time">
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(container);
    const closeBtn=container.querySelector(".crawl-builder__close");
    const backdrop=container.querySelector(".crawl-builder__backdrop");
    const optionButtons=Array.from(container.querySelectorAll(".crawl-option"));
    const startSection=container.querySelector(".crawl-start");
    const startButtons=Array.from(container.querySelectorAll(".crawl-start-option"));
    const orderButtons=Array.from(container.querySelectorAll(".crawl-order-option"));
    const timeInput=container.querySelector(".crawl-builder__time-input");
    const statusEl=container.querySelector(".crawl-builder__status");
    const input=container.querySelector(".crawl-builder__input");
    const suggestionsEl=container.querySelector(".crawl-builder__suggestions");
    const bodyEl=container.querySelector(".crawl-builder__body");
    const loadingEl=container.querySelector(".crawl-builder__loading");
    const loadingTextEl=container.querySelector(".crawl-builder__loading-text");
    let suggestionTimer=null;
    let selectedOption=null;
    let orderMode="location";
    let isBusy=false;
    let isBuildingCrawl=false;
    const STREET_TOKEN_REGEX=/\b(st|street|rd|road|ave|avenue|ln|lane|dr|drive|ct|court|cct|circuit|pde|parade|cres|crescent|pl|place|blvd|boulevard|hwy|highway|tce|terrace)\b/i;
    const UNIT_TOKEN_REGEX=/\b(unit|apt|apartment|suite|level|lvl)\b/i;
    const LEADING_STREET_NUMBER_REGEX=/^\s*\d{1,6}\s+\S+/;
    const POSTCODE_PREFIX_REGEX=/^\s*\d{4}(?:\b|\s)/;
    const REGION_RESULT_TYPES=new Set(["postal_code","locality","sublocality","administrative_area_level_1","administrative_area_level_2","postal_town"]);
    const ADDRESS_ONLY_TYPES=new Set(["street_address","premise","subpremise","route"]);

    function setStatus(message,type=""){
      statusEl.textContent=message||"";
      statusEl.className=`crawl-builder__status ${type}`.trim();
    }
    function updateInputDisabled(){
      input.disabled=isBusy || selectedOption!=="around";
    }
    function setBuilderLoading(loading,text){
      isBuildingCrawl=loading;
      if(loadingEl) loadingEl.classList.toggle("hidden",!loading);
      if(bodyEl) bodyEl.classList.toggle("hidden",loading);
      if(loadingTextEl && text) loadingTextEl.textContent=text;
    }
    function setBuilderBusy(busy,requestId=null){
      if(requestId!=null && requestId!==crawlBuildRequestId) return;
      isBusy=busy;
      optionButtons.forEach(btn=>btn.disabled=busy);
      startButtons.forEach(btn=>{
        btn.disabled=busy;
        btn.classList.toggle("is-loading",busy);
      });
      timeInput.disabled=busy;
      updateInputDisabled();
    }
    function cancelCrawlBuild(){
      if(!isBuildingCrawl && !isCrawlBuildInProgress) return;
      crawlBuildRequestId+=1;
      isCrawlBuildInProgress=false;
      crawlBuildStartTime=null;
      setBuilderBusy(false);
      setBuilderLoading(false);
      setStatus("");
    }
    function renderSuggestions(list){
      if(!suggestionsEl) return;
      suggestionsEl.innerHTML="";
      if(!Array.isArray(list)||list.length===0) return;
      list.forEach((item)=>{
        const btn=document.createElement("button");
        btn.type="button";
        btn.className="crawl-builder__suggestion";
        btn.textContent=item.label;
        btn.addEventListener("click",()=>{
          input.value=item.label;
          crawlBuilder.locationOverride={ lat:item.lat, lng:item.lng, label:item.label, bounds:item.bounds || null, placeId:item.placeId || null };
          suggestionsEl.innerHTML="";
          setStatus("Location confirmed.","success");
          if(map&&item.bounds){
            map.fitBounds(item.bounds);
          } else if(map){
            panToLocation(item.lat,item.lng,13);
          }
        });
        suggestionsEl.appendChild(btn);
      });
    }
    function isLikelyAddressQuery(query){
      if(!query) return false;
      return LEADING_STREET_NUMBER_REGEX.test(query)||STREET_TOKEN_REGEX.test(query)||UNIT_TOKEN_REGEX.test(query);
    }
    function isLikelyPostcodeQuery(query){
      if(!query) return false;
      return POSTCODE_PREFIX_REGEX.test(query);
    }
    function shouldIncludePrediction(prediction,allowAddressResults){
      if(!prediction||!Array.isArray(prediction.types)||prediction.types.length===0) return false;
      if(allowAddressResults) return true;
      const types=prediction.types;
      if(types.some(type=>ADDRESS_ONLY_TYPES.has(type))) return false;
      if(types.some(type=>REGION_RESULT_TYPES.has(type))) return true;
      return !types.includes("geocode");
    }
    async function fetchSuggestions(query){
      if(!query||!autocompleteService||!placesService) return [];
      const postcodeQuery=isLikelyPostcodeQuery(query);
      const addressQuery=!postcodeQuery&&isLikelyAddressQuery(query);
      const predictionTypes=addressQuery ? ["address"] : ["(regions)"];
      const predictions=await new Promise(resolve=>{
        autocompleteService.getPlacePredictions({
          input: query,
          types: predictionTypes,
          componentRestrictions: { country: "au" }
        },(results,status)=>{
          if(status!==google.maps.places.PlacesServiceStatus.OK||!Array.isArray(results)) return resolve([]);
          const filtered=results.filter(prediction=>shouldIncludePrediction(prediction,addressQuery));
          resolve(filtered.slice(0,5));
        });
      });
      if(predictions.length===0) return [];
      const detailPromises=predictions.map(prediction=>new Promise(resolve=>{
        placesService.getDetails({
          placeId: prediction.place_id,
          fields: ["geometry","formatted_address","name","address_components"]
        },(place,status)=>{
          if(status!==google.maps.places.PlacesServiceStatus.OK||!place||!place.geometry){
            return resolve(null);
          }
          const location=place.geometry.location;
          const lat=location.lat();
          const lng=location.lng();
          const label=place.formatted_address||place.name||prediction.description;
          resolve({
            label,
            lat,
            lng,
            bounds: place.geometry.viewport || null,
            placeId: prediction.place_id,
            addressComponents: place.address_components || []
          });
        });
      }));
      const results=await Promise.all(detailPromises);
      return results.filter(Boolean);
    }

    function setSelectedOption(option){
      selectedOption=option;
      optionButtons.forEach(btn=>btn.classList.toggle("is-selected",btn.dataset.option===option));
      updateInputDisabled();
      if(option==="around") input.focus();
      startSection.classList.remove("hidden");
    }
    function setOrderMode(mode){
      orderMode=mode;
      orderButtons.forEach(btn=>btn.classList.toggle("is-selected",btn.dataset.order===mode));
    }

    optionButtons.forEach(btn=>{
      btn.addEventListener("click",async()=>{
        if(btn.disabled) return;
        setStatus("");
        const option=btn.dataset.option;
        setSelectedOption(option);
        if(option==="around"){
          crawlBuilder.locationOverride=null;
          if(!input.value.trim()){
            setStatus("Enter a suburb or postcode, then pick a location.","error");
          }
        } else {
          crawlBuilder.locationOverride=null;
          if(suggestionsEl) suggestionsEl.innerHTML="";
        }
      });
    });

    orderButtons.forEach(btn=>{
      btn.addEventListener("click",()=>{
        setOrderMode(btn.dataset.order);
      });
    });

    startButtons.forEach(btn=>{
      btn.addEventListener("click",async()=>{
        if(!selectedOption){
          setStatus("Choose where you'd like to crawl first.","error");
          return;
        }
        startButtons.forEach(b=>b.classList.toggle("is-selected",b===btn));
        const startType=btn.dataset.start;
        if(startType==="time"){
          timeInput.classList.remove("hidden");
          timeInput.focus();
          return;
        }
        timeInput.classList.add("hidden");
        const startAt=new Date();
        await buildCrawlFromBuilder(selectedOption,startAt);
      });
    });

    timeInput.addEventListener("change",async()=>{
      if(!selectedOption) return;
      const startAt=buildStartDateFromInput(timeInput.value);
      await buildCrawlFromBuilder(selectedOption,startAt);
    });

    input.addEventListener("input",()=>{
      if(input.disabled){
        setStatus("");
        if(suggestionsEl) suggestionsEl.innerHTML="";
        return;
      }
      const query=input.value.trim();
      crawlBuilder.locationOverride=null;
      if(suggestionTimer) clearTimeout(suggestionTimer);
      if(query.length<2){
        if(suggestionsEl) suggestionsEl.innerHTML="";
        setStatus("");
        return;
      }
      suggestionTimer=setTimeout(async()=>{
        const list=await fetchSuggestions(query);
        renderSuggestions(list);
        if(list.length===0) setStatus("No matches yet. Try another suburb or postcode.","error");
        else setStatus("");
      },300);
    });

    closeBtn.addEventListener("click",()=>{
      cancelCrawlBuild();
      container.classList.add("hidden");
    });
    backdrop.addEventListener("click",()=>{
      cancelCrawlBuild();
      container.classList.add("hidden");
    });

    crawlBuilder={
      container,
      startSection,
      timeInput,
      statusEl,
      input,
      setBusy: setBuilderBusy,
      setLoading: setBuilderLoading,
      locationOverride:null,
      get orderMode(){ return orderMode; },
      reset(){
        selectedOption="nearby";
        optionButtons.forEach(btn=>btn.classList.remove("is-selected","is-loading"));
        const nearbyButton=container.querySelector('.crawl-option[data-option="nearby"]');
        nearbyButton?.classList.add("is-selected");
        setBuilderBusy(false);
        setBuilderLoading(false);
        crawlBuilder.locationOverride=null;
        if(suggestionsEl) suggestionsEl.innerHTML="";
        setOrderMode("location");
        startButtons.forEach(btn=>btn.classList.remove("is-selected"));
        startSection.classList.remove("hidden");
        timeInput.classList.add("hidden");
        setStatus("");
      }
    };
    return crawlBuilder;
  }

  function openCrawlBuilder(){
    const builder=ensureCrawlBuilder();
    builder.container.classList.remove("hidden");
    builder.reset();
  }

  function resetCrawlBuilderState(){
    if(!crawlBuilder) return;
    crawlBuilder.reset?.();
    if(crawlBuilder.input) crawlBuilder.input.value="";
    crawlBuilder.locationOverride=null;
    const suggestions=crawlBuilder.container?.querySelector(".crawl-builder__suggestions");
    if(suggestions) suggestions.innerHTML="";
  }

  async function buildCrawlFromBuilder(option,startAt){
    if(!option||isCrawlBuildInProgress) return;
    crawlBuildStartTime=performance.now();
    const requestId=++crawlBuildRequestId;
    isCrawlBuildInProgress=true;
    crawlBuilder?.setBusy(true,requestId);
    if(crawlBuilder?.setLoading){
      crawlBuilder.setLoading(true,"Building your pub crawl");
    }
    const deviceLocation=userLocation ? { ...userLocation } : null;
    const selectedAreaCenter=option==="around" ? crawlBuilder?.locationOverride : null;
    const distanceSteps=[200,350,500,750,1000,1500,2000];
    const radiusSteps=Array.from(new Set([
      Math.max(1200,distanceSteps[0]*6),
      1500,
      2000,
      3000,
      4000
    ])).sort((a,b)=>a-b);
    const targetCount=4;
    const logBuild=(payload)=>{
      if(!DEV_CRAWL_LOGGING) return;
      console.log("[Crawl] build",payload);
    };
    const resolveCenter=async()=>{
      if(option==="around"){
        if(!crawlBuilder?.locationOverride) return null;
        const override=crawlBuilder.locationOverride;
        if(typeof override.lat==="number"&&typeof override.lng==="number") return override;
        if(override.placeId&&placesService){
          const details=await new Promise(resolve=>{
            placesService.getDetails({
              placeId: override.placeId,
              fields: ["geometry","formatted_address","name"]
            },(place,status)=>{
              if(status!==google.maps.places.PlacesServiceStatus.OK||!place?.geometry?.location){
                return resolve(null);
              }
              const location=place.geometry.location;
              resolve({
                lat: location.lat(),
                lng: location.lng(),
                label: place.formatted_address||place.name||override.label||"",
                bounds: place.geometry.viewport || null,
                placeId: override.placeId
              });
            });
          });
          if(requestId!==crawlBuildRequestId) return null;
          if(details){
            crawlBuilder.locationOverride={ ...override, ...details };
          }
          return details;
        }
        return null;
      }
      return getCrawlOrigin();
    };
    try{
      const center=await resolveCenter();
      if(requestId!==crawlBuildRequestId) return;
      if(!center){
        if(crawlBuilder?.statusEl){
          if(crawlBuilder?.setLoading) crawlBuilder.setLoading(false);
          crawlBuilder.statusEl.textContent="Choose a location from the list first.";
          crawlBuilder.statusEl.className="crawl-builder__status error";
        }
        return;
      }
      const orderMode=crawlBuilder?.orderMode || "location";
      let buildResult={ ok:false, reason:"NOT_ENOUGH_CANDIDATES" };
      let usedDistance=null;
      let usedRadius=null;
      let lastStats=null;
      for(const radius of radiusSteps){
        if(requestId!==crawlBuildRequestId) return;
        if(crawlBuilder?.setLoading){
          crawlBuilder.setLoading(true,"Finding venues…");
        }
        await fetchCrawlVenuesForCenter(center,requestId,radius);
        if(requestId!==crawlBuildRequestId) return;
        const { candidates, stats }=getCrawlCandidatesFromStore(center,radius);
        lastStats=stats;
        logBuild({
          requestId,
          centerUsedForCrawl:center,
          venueSearchRadiusMeters: radius,
          requiredStops: targetCount,
          actualCandidates: candidates.length,
          ...stats
        });
        if(candidates.length<targetCount){
          buildResult={ ok:false, reason:"NOT_ENOUGH_CANDIDATES" };
          continue;
        }
        if(crawlBuilder?.setLoading){
          crawlBuilder.setLoading(true,"Building your pub crawl");
        }
        for(const step of distanceSteps){
          const attempt=generateCrawlVenuesFromList(candidates,center,targetCount,startAt,orderMode,{ maxStepMeters: step });
          if(attempt.ok){
            buildResult=attempt;
            usedDistance=step;
            usedRadius=radius;
            break;
          }
          if(attempt.reason==="NOT_ENOUGH_CANDIDATES"||attempt.reason==="INVALID_COORDS"){
            buildResult=attempt;
            break;
          }
          buildResult=attempt;
        }
        if(buildResult.ok) break;
      }
      if(requestId!==crawlBuildRequestId) return;
      if(buildResult.ok && !usedDistance){
        usedDistance=distanceSteps[0];
      }
      if(!buildResult.ok){
        if(crawlBuilder?.statusEl){
          if(crawlBuilder?.setLoading) crawlBuilder.setLoading(false);
          const maxDistance=distanceSteps[distanceSteps.length-1];
          const maxRadius=radiusSteps[radiusSteps.length-1];
          const distanceLimitKm=formatDistanceKm(maxDistance/1000);
          const detail=DEV_CRAWL_LOGGING && lastStats
            ? ` Tried radius=${maxRadius}m, candidates=${lastStats.candidatesAfterDedup}, requiredStops=${targetCount}, maxStep=${maxDistance}m.`
            : "";
          if(buildResult.reason==="NOT_ENOUGH_CANDIDATES"){
            crawlBuilder.statusEl.textContent=`Not enough venues in this area to build a crawl. Try another suburb or reduce the number of stops.${detail}`;
          } else if(buildResult.reason==="INVALID_COORDS"){
            crawlBuilder.statusEl.textContent=`Some venues are missing location data for this area. Try another suburb or reduce the number of stops.${detail}`;
          } else {
            crawlBuilder.statusEl.textContent=`Couldn’t build a crawl within ${distanceLimitKm} between stops for this area. Try increasing the distance limit or reducing number of stops.${detail}`;
          }
          crawlBuilder.statusEl.className="crawl-builder__status error";
        }
        if(buildResult.reason==="NOT_ENOUGH_CANDIDATES"){
          trackEvent("not_enough_venues_shown",{
            radius_m: radiusSteps[radiusSteps.length-1],
            results_count: lastStats?.candidatesAfterDedup ?? 0,
            reason: "too_few_results"
          });
        } else {
          trackEvent("error_shown",{
            error_type: "unknown",
            component: "crawl"
          });
        }
        crawlBuildStartTime=null;
        logBuild({
          requestId,
          deviceLocation,
          selectedAreaCenter,
          centerUsedForCrawl:center,
          venueSearchRadiusMeters: radiusSteps[radiusSteps.length-1],
          maxStepDistanceMeters: distanceSteps[distanceSteps.length-1],
          failureReason: buildResult.reason || "NO_VALID_PATH_WITHIN_CONSTRAINTS",
          ...(lastStats || {})
        });
        return;
      }
      logBuild({
        requestId,
        deviceLocation,
        selectedAreaCenter,
        centerUsedForCrawl:center,
        venueCountUsed: lastStats?.candidatesAfterDedup ?? 0,
        maxStepDistanceMeters: usedDistance,
        venueSearchRadiusMeters: usedRadius,
        maxStepDistanceUsedMeters: buildResult.maxStepDistanceMeters
      });
      buildCrawlState(buildResult.venues,startAt,center,orderMode,usedDistance);
      const maxLegDistance=buildResult.maxStepDistanceMeters || usedDistance;
      const buildTimeSeconds=crawlBuildStartTime ? (performance.now()-crawlBuildStartTime)/1000 : null;
      const crawlPayload={
        venue_count: buildResult.venues.length
      };
      if(buildTimeSeconds!=null) crawlPayload.build_time_s=Number(buildTimeSeconds.toFixed(2));
      if(Number.isFinite(maxLegDistance)){
        crawlPayload.max_leg_distance_m=maxLegDistance;
        crawlPayload.contains_over_200m_leg=maxLegDistance>200;
      }
      trackEvent("crawl_created",crawlPayload);
      crawlBuildStartTime=null;
      hasAutoFitCrawlOnLoad=false;
      enterCrawlMode({ autoFit:true });
      updateCrawlList();
      refreshCrawlReminders();
      if(crawlBuilder?.container) crawlBuilder.container.classList.add("hidden");
    } finally {
      if(requestId===crawlBuildRequestId){
        isCrawlBuildInProgress=false;
        crawlBuilder?.setBusy(false,requestId);
        if(crawlBuilder?.setLoading) crawlBuilder.setLoading(false);
      }
    }
  }

  function ensureCrawlFab(){
    if(document.getElementById("crawl-fab")) return;
    const button=document.createElement("button");
    button.id="crawl-fab";
    button.className="crawl-fab";
    button.type="button";
    button.textContent="Plan a pub crawl";
    button.addEventListener("click",openCrawlBuilder);
    document.body.appendChild(button);
  }

  function showCrawlFab(){
    const button=document.getElementById("crawl-fab");
    if(button) button.classList.remove("hidden");
  }

  function hideCrawlFab(){
    const button=document.getElementById("crawl-fab");
    if(button) button.classList.add("hidden");
  }

  function addLocateControl(){
    if(!map) return;
    const container=document.createElement("div");
    container.className="locate-control";
    const button=document.createElement("button");
    button.type="button";
    button.className="locate-button";
    button.setAttribute("aria-label","Locate me");
    button.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M11 3.06V1h2v2.06A8.01 8.01 0 0 1 20.94 11H23v2h-2.06A8.01 8.01 0 0 1 13 20.94V23h-2v-2.06A8.01 8.01 0 0 1 3.06 13H1v-2h2.06A8.01 8.01 0 0 1 11 3.06ZM12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm0 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/></svg>`;
    locateButton=button;
    container.appendChild(button);
    button.addEventListener("click",(event)=>{
      event.stopPropagation();
      locateUser();
    });
    map.controls[google.maps.ControlPosition.LEFT_BOTTOM].push(container);
  }

  function ensureRatingCard(){
    if(ratingCard) return ratingCard;
    const container=document.createElement("div");
    container.id="rating-card";
    container.className="rating-card hidden";
    container.innerHTML=`
      <div class="rating-card__backdrop"></div>
      <div class="rating-card__panel">
        <div class="rating-card__header">
          <div>
            <div class="rating-card__title">Rate the outdoor area</div>
            <div class="rating-card__subtitle">Tap the stars to rate this outdoor space</div>
          </div>
          <button class="rating-card__close" type="button" aria-label="Close rating">×</button>
        </div>
        <div class="rating-card__stars" role="radiogroup" aria-label="Outdoor area rating">
          <button class="rating-star" type="button" data-value="1" aria-label="1 star">★</button>
          <button class="rating-star" type="button" data-value="2" aria-label="2 stars">★</button>
          <button class="rating-star" type="button" data-value="3" aria-label="3 stars">★</button>
          <button class="rating-star" type="button" data-value="4" aria-label="4 stars">★</button>
          <button class="rating-star" type="button" data-value="5" aria-label="5 stars">★</button>
        </div>
        <button class="rating-card__submit" type="button" disabled>Submit rating</button>
      </div>`;
    document.body.appendChild(container);
    const stars=Array.from(container.querySelectorAll(".rating-star"));
    const submitBtn=container.querySelector(".rating-card__submit");
    const closeBtn=container.querySelector(".rating-card__close");
    const backdrop=container.querySelector(".rating-card__backdrop");
    const titleEl=container.querySelector(".rating-card__title");
    let selected=0;
    function setSelected(val){
      selected=val;
      stars.forEach(star=>{
        const value=Number(star.dataset.value);
        star.classList.toggle("is-active",value<=val);
      });
      submitBtn.disabled=val<=0;
    }
    stars.forEach(star=>{
      star.addEventListener("click",()=>setSelected(Number(star.dataset.value)));
    });
    const close=()=>{
      container.classList.add("hidden");
      container.classList.remove("show");
      container.removeAttribute("data-venue-id");
      setSelected(0);
    };
    submitBtn.addEventListener("click",()=>{
      const venueId=container.dataset.venueId;
      if(!venueId||selected<=0) return;
      recordRating(venueId,selected);
      close();
    });
    backdrop.addEventListener("click",close);
    closeBtn.addEventListener("click",close);
    ratingCard={container,setSelected,titleEl};
    return ratingCard;
  }

  function openRatingCard(v){
    const { rated } = getRatingEntry(v.id);
    if(rated) return;
    const card=ensureRatingCard();
    card.container.dataset.venueId=v.id;
    card.titleEl.textContent=v.name?`Rate the outdoor area at ${v.name}`:"Rate the outdoor area";
    card.setSelected(0);
    card.container.classList.remove("hidden");
    requestAnimationFrame(()=>card.container.classList.add("show"));
  }

  function setLocateLoading(isLoading){
    if(!locateButton) return;
    locateButton.disabled=isLoading;
    locateButton.classList.toggle("is-loading",isLoading);
  }

  function locateUser(){
    if(!navigator.geolocation||!map){ console.warn("Geolocation not available"); return; }
    setLocateLoading(true);
    const opts={enableHighAccuracy:true,timeout:10000,maximumAge:0};
    const onComplete=()=>setLocateLoading(false);
    navigator.geolocation.getCurrentPosition((p)=>{
      if(acceptAccurateLocation(p,{shouldCenter:true,forceCenter:true,onComplete})) return;
    },(err)=>{
      console.warn("Locate failed",err);
      onComplete();
    },opts);
  }

  function boot(){
    requestUserLocationOnce();
    const cached=loadLocal(VENUE_CACHE_KEY);
    if(cached&&typeof cached==="object"){
      const filtered=filterGloballyExcludedVenues(Object.values(cached),"local cache");
      allVenues=filtered.reduce((acc,venue)=>{
        if(venue?.id) acc[venue.id]=venue;
        return acc;
      },{});
    }
    setupMap();
    renderMarkers();
    debouncedLoadVisible();
    ensureCrawlFab();
    const params=new URLSearchParams(window.location.search);
    const crawlParam=params.get("crawl");
    if(crawlParam) hydrateCrawlFromLink(crawlParam);
  }

  let domReady=false;
  let mapsReady=false;
  let hasBooted=false;
  function tryBoot(){
    if(hasBooted||!domReady||!mapsReady) return;
    hasBooted=true;
    boot();
  }
  window.__sunnyBoot=()=>{
    mapsReady=true;
    tryBoot();
  };
  if(window.__sunnyMapsReady){
    mapsReady=true;
  }
  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",()=>{
      setupHeaderMenu();
      domReady=true;
      tryBoot();
    });
  } else {
    setupHeaderMenu();
    domReady=true;
    tryBoot();
  }
})();
