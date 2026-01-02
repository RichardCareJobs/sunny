
/* Sunny app.js — Bottom Card, No Filters (build: 2025-10-10-f)
   - Map-only UI with a bottom detail card (replaces popups)
   - Filters UI removed
   - Custom pins from icons/marker.png (or window.SUNNY_ICON_URL)
*/
console.log("Sunny app.js loaded: Bottom Card (No Filters) 2025-10-10-f");

(function () {
  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter"
  ];

  const DEFAULT_VIEW = { lat: -32.9267, lng: 151.7789, zoom: 12 };

  const TILE_URL = window.SUNNY_TILE_URL ||
    "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  const TILE_ATTR =
    window.SUNNY_TILE_ATTR ||
    '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

  const VENUE_CACHE_KEY = "sunny-pubs-venues";
  const TILE_CACHE_PREFIX = "sunny-pubs-overpass-tiles-v1:";
  const TILE_CACHE_TTL_MS = 1000 * 60 * 30;

  let map, markersLayer;
  let locateButton = null;
  let allVenues = {};
  let userLocation = null;
  let locationWatchId = null;
  let locationWatchTimer = null;
  let hasCenteredOnUser = false;

  const MAX_LOCATION_WAIT_MS = 15000;
  const DESIRED_LOCATION_ACCURACY_METERS = 250;

  const MOVE_DEBOUNCE_MS = 500;
  let moveTimer = null;

  let openVenueId = null;
  let isRenderingMarkers = false;
  let detailCard = null;

  let venueCountToast = null;
  let venueCountTimer = null;

  const MARKER_ICON_URL = window.SUNNY_ICON_URL || "icons/marker.png";
  const markerIcon = L.icon({
    iconUrl: MARKER_ICON_URL,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -28]
  });

  // Helpers
  function saveLocal(k,v){ try{localStorage.setItem(k,JSON.stringify({v,t:Date.now()}));}catch{} }
  function loadLocal(k,maxAge=null){
    try{const raw=localStorage.getItem(k); if(!raw) return null; const {v,t}=JSON.parse(raw); if(maxAge!=null&&Date.now()-t>maxAge) return null; return v;}catch{return null;}
  }
  function toTitle(s=""){ return s ? s.replace(/\b\w/g,c=>c.toUpperCase()) : ""; }

  // Distance
  function haversine(a,b,c,d){ const R=6371,toRad=x=>x*Math.PI/180; const dLat=toRad(c-a), dLon=toRad(d-b);
    const A=Math.sin(dLat/2)**2+Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLon/2)**2;
    const C=2*Math.atan2(Math.sqrt(A),Math.sqrt(1-A)); return R*C; }
  function formatDistanceKm(km){ return km<1 ? `${Math.round(km*1000)} m` : `${km.toFixed(1)} km`; }
  function formatAddress(tags={}){
    if(tags["addr:full"]) return tags["addr:full"];
    const hn=tags["addr:housenumber"]||"";
    const street=tags["addr:street"]||tags["addr:place"]||"";
    const city=tags["addr:city"]||tags["addr:suburb"]||tags["addr:municipality"]||"";
    const streetLine=[hn,street].filter(Boolean).join(" ").trim();
    return [streetLine,city].filter(Boolean).join(", ");
  }
  function clearLocationWatch(){
    if(locationWatchId!==null){ navigator.geolocation.clearWatch(locationWatchId); locationWatchId=null; }
    if(locationWatchTimer){ clearTimeout(locationWatchTimer); locationWatchTimer=null; }
  }
  function centerOnUserIfAvailable(targetZoom=15,{force=false}={}){
    if(!map||!userLocation) return;
    if(hasCenteredOnUser&&!force) return;
    const zoom=Math.max(map.getZoom(),targetZoom);
    map.flyTo([userLocation.lat,userLocation.lng],zoom,{animate:true});
    hasCenteredOnUser=true;
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
  async function populateWeatherBadge(id,lat,lng){
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = "Loading weather…";
    const data = await fetchWeather(lat,lng);
    const target = document.getElementById(id);
    if (!target) return;
    if (data && data.tempC !== null) {
      target.innerHTML = `<span>${data.icon}</span><span>${data.tempC}&nbsp;°C</span>`;
    } else {
      target.innerHTML = `<span>${data.icon}</span><span>${data.label}</span>`;
    }
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
    if(open){ if(closeIn<=60) return {status:"Closing soon",tone:"warn"}; return {status:"Open now",tone:"good"}; }
    if(isFinite(openIn)){ if(openIn<=60) return {status:"Opening soon",tone:"info"}; return {status:"Closed",tone:"muted"}; }
    return {status:"Closed",tone:"muted"};
  }

  // Overpass
  function buildOverpassQuery(bbox){
    return `[out:json][timeout:25];
      (
        node["amenity"~"^(pub|bar|biergarten)$"](${bbox});
        way["amenity"~"^(pub|bar|biergarten)$"](${bbox});
        relation["amenity"~"^(pub|bar|biergarten)$"](${bbox});
        node["amenity"="restaurant"]["outdoor_seating"="yes"](${bbox});
        way["amenity"="restaurant"]["outdoor_seating"="yes"](${bbox});
        relation["amenity"="restaurant"]["outdoor_seating"="yes"](${bbox});
        node["amenity"="restaurant"]["garden"="yes"](${bbox});
        way["amenity"="restaurant"]["garden"="yes"](${bbox});
        relation["amenity"="restaurant"]["garden"="yes"](${bbox});
        node["amenity"="restaurant"]["terrace"="yes"](${bbox});
        way["amenity"="restaurant"]["terrace"="yes"](${bbox});
        relation["amenity"="restaurant"]["terrace"="yes"](${bbox});
        node["tourism"="hotel"]["terrace"="yes"](${bbox});
        way["tourism"="hotel"]["terrace"="yes"](${bbox});
        relation["tourism"="hotel"]["terrace"="yes"](${bbox});
      );
      out center tags;`;
  }
  async function fetchOverpass(q){
    const body=new URLSearchParams({data:q});
    for(const url of OVERPASS_ENDPOINTS){
      try{ const res=await fetch(url,{method:"POST",body}); if(!res.ok) continue; const json=await res.json(); if(json&&json.elements) return json.elements; }
      catch{}
    }
    throw new Error("All Overpass endpoints failed");
  }
  function normalizeElement(el){
    const tags=el.tags||{}; let lat=el.lat,lng=el.lon; if((!lat||!lng)&&el.center){ lat=el.center.lat; lng=el.center.lon; }
    if(!lat||!lng) return null; const id=`${el.type}/${el.id}`; const name=tags.name||tags.brand||toTitle(tags.operator)||(tags.amenity?toTitle(tags.amenity):"Unnamed");
    if(isClosed(tags)) return null;
    if(lacksOutdoor(tags)) return null;
    if(isDryVenue(tags)) return null;
    return { id,name,lat,lng,tags,hasOutdoor:hasOutdoorHints(tags),source:"osm" };
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
  function mergeVenues(list){ let added=0; for(const v of list){ if(!v) continue; if(!allVenues[v.id]){ allVenues[v.id]=v; added++; } else { allVenues[v.id]={...allVenues[v.id],...v}; } } if(added) saveLocal(VENUE_CACHE_KEY,allVenues); }

  // Map
  function setupMap(){
    if(!document.getElementById("map")){ const m=document.createElement("div"); m.id="map"; m.style.position="absolute"; m.style.left="0"; m.style.right="0"; m.style.top="0"; m.style.bottom="0"; document.body.appendChild(m); }
    map=L.map("map").setView([DEFAULT_VIEW.lat,DEFAULT_VIEW.lng],DEFAULT_VIEW.zoom);
    L.tileLayer(TILE_URL,{maxZoom:19,attribution:TILE_ATTR}).addTo(map);
    markersLayer=L.layerGroup().addTo(map);
    map.on("moveend",debouncedLoadVisible);
    map.on("zoomend",debouncedLoadVisible);
    map.on("click",()=>hideVenueCard());
    addLocateControl();
    centerOnUserIfAvailable();
  }
  function debouncedLoadVisible(){ if(moveTimer) clearTimeout(moveTimer); moveTimer=setTimeout(loadVisibleTiles,MOVE_DEBOUNCE_MS); }

  async function loadVisibleTiles(){
    const b=map.getBounds(); const sw=b.getSouthWest(), ne=b.getNorthEast();
    const bbox=[sw.lat,sw.lng,ne.lat,ne.lng].map(n=>+n.toFixed(5)).join(","), cacheKey=`${TILE_CACHE_PREFIX}${bbox}`;
    const cached=loadLocal(cacheKey,TILE_CACHE_TTL_MS);
    if(cached&&Array.isArray(cached)){ mergeVenues(cached.map(normalizeElement).filter(Boolean)); renderMarkers(); return; }
    try{ const els=await fetchOverpass(buildOverpassQuery(bbox)); saveLocal(cacheKey,els); mergeVenues(els.map(normalizeElement).filter(Boolean)); renderMarkers(); }
    catch(e){ console.error("Overpass error:",e); }
  }

  function ensureDetailCard(){
    if(detailCard) return detailCard;
    const container=document.createElement("div");
    container.id="venue-card";
    container.className="venue-card hidden";
    container.innerHTML=`
      <div class="venue-card__inner">
        <div class="venue-card__handle"></div>
        <div class="venue-card__header">
          <div class="venue-card__title">
            <div class="venue-card__name"></div>
            <div class="venue-card__meta"></div>
            <div class="venue-card__address"></div>
          </div>
          <button class="venue-card__close" type="button" aria-label="Close details">×</button>
        </div>
        <div class="venue-card__section-title">Current weather</div>
        <div class="venue-card__badges">
          <span class="chip chip-sun"><span class="chip-emoji">☀️</span><span class="chip-label">Full sun</span></span>
          <span class="chip chip-weather" id="venue-card-weather">Loading weather…</span>
          <span class="chip chip-open"></span>
        </div>
        <div class="venue-card__note"></div>
        <div class="venue-card__actions">
          <a class="action primary" target="_blank" rel="noopener" data-action="directions">Directions</a>
          <a class="action" target="_blank" rel="noopener" data-action="uber">Ride</a>
          <a class="action muted" target="_blank" rel="noopener" data-action="website">Website</a>
        </div>
      </div>`;
    document.body.appendChild(container);
    const closeBtn=container.querySelector(".venue-card__close");
    closeBtn.addEventListener("click",()=>hideVenueCard());
    detailCard={
      container,
      nameEl:container.querySelector(".venue-card__name"),
      metaEl:container.querySelector(".venue-card__meta"),
      addressEl:container.querySelector(".venue-card__address"),
      openChip:container.querySelector(".chip-open"),
      sunChip:container.querySelector(".chip-sun"),
      weatherChip:container.querySelector("#venue-card-weather"),
      weatherLabel:container.querySelector(".venue-card__section-title"),
      noteEl:container.querySelector(".venue-card__note"),
      actions:{
        directions:container.querySelector('[data-action="directions"]'),
        uber:container.querySelector('[data-action="uber"]'),
        website:container.querySelector('[data-action="website"]')
      }
    };
    return detailCard;
  }
  function hideVenueCard(){
    if(!detailCard) return;
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
    const card=ensureDetailCard();
    const tags=v.tags||{};
    const kind=toTitle(tags.amenity||tags.tourism||"");
    const distance=userLocation?formatDistanceKm(haversine(userLocation.lat,userLocation.lng,v.lat,v.lng)):null;
    const address=formatAddress(tags);
    const sun=sunBadge(v.lat,v.lng);
    const open=parseOpenStatus(tags.opening_hours);
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

    card.sunChip.querySelector(".chip-emoji").textContent=sun.icon;
    card.sunChip.querySelector(".chip-label").textContent=sun.label;

    card.weatherChip.textContent="Loading weather…";
    populateWeatherBadge("venue-card-weather",v.lat,v.lng);

    if(!open.status||open.status==="Unknown"){
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

    const outdoorHint=hasOutdoorHints(tags);
    if(outdoorHint){
      card.noteEl.textContent="Marked with outdoor seating hints on the map.";
      card.noteEl.classList.remove("hidden");
    } else {
      card.noteEl.textContent="";
      card.noteEl.classList.add("hidden");
    }

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
      map.getContainer().appendChild(venueCountToast);
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

  function renderMarkers(){
    if(!markersLayer||!map) return;
    const reopenVenueId=openVenueId;
    let reopenVenue=null;
    isRenderingMarkers=true;
    markersLayer.clearLayers();
    const b=map.getBounds();
    let visibleCount=0;
    Object.values(allVenues).forEach(v=>{
      if(!b.contains([v.lat,v.lng])) return;
      visibleCount++;
      const marker=L.marker([v.lat,v.lng],{icon:markerIcon}).addTo(markersLayer);
      marker.on("click",()=>{
        openVenueId=v.id;
        showVenueCard(v);
      });
      if(reopenVenueId&&reopenVenueId===v.id) reopenVenue=v;
    });
    isRenderingMarkers=false;
    showVenueCount(visibleCount);
    if(reopenVenue){
      showVenueCard(reopenVenue);
    } else if(reopenVenueId){
      hideVenueCard();
    }
  }

  function addLocateControl(){
    if(!map) return;
    const LocateControl=L.Control.extend({
      options:{position:"bottomleft"},
      onAdd(){
        const container=L.DomUtil.create("div","locate-control");
        const button=L.DomUtil.create("button","locate-button",container);
        button.type="button";
        button.setAttribute("aria-label","Locate me");
        button.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M11 3.06V1h2v2.06A8.01 8.01 0 0 1 20.94 11H23v2h-2.06A8.01 8.01 0 0 1 13 20.94V23h-2v-2.06A8.01 8.01 0 0 1 3.06 13H1v-2h2.06A8.01 8.01 0 0 1 11 3.06ZM12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm0 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/></svg>`;
        locateButton=button;
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.on(button,"click",(event)=>{
          L.DomEvent.stop(event);
          locateUser();
        });
        return container;
      }
    });
    map.addControl(new LocateControl());
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
    if(cached&&typeof cached==="object") allVenues=cached;
    setupMap();
    renderMarkers();
    debouncedLoadVisible();
  }

  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
