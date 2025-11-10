
/* Sunny app.js — Popups Only, No Filters (build: 2025-10-10-e)
   - Map-only UI with enhanced popups (single card type)
   - Filters UI removed
   - Custom pins from icons/marker.png (or window.SUNNY_ICON_URL)
*/
console.log("Sunny app.js loaded: Popups Only (No Filters) 2025-10-10-e");

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
  let allVenues = {};
  let userLocation = null;

  const MOVE_DEBOUNCE_MS = 500;
  let moveTimer = null;

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
  function requestUserLocationOnce(){
    if(userLocation!==null) return;
    if(!navigator.geolocation){ userLocation=false; return; }
    navigator.geolocation.getCurrentPosition(
      p=>{ userLocation={lat:p.coords.latitude,lng:p.coords.longitude}; },
      ()=>{ userLocation=false; },
      {enableHighAccuracy:true,timeout:8000,maximumAge:600000}
    );
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

  function popupHTML(v,weatherId){
    const tags=v.tags||{}; const kind=toTitle(tags.amenity||tags.tourism||"");
    const sun=sunBadge(v.lat,v.lng);
    const open=parseOpenStatus(tags.opening_hours); const showOpen=open.status!=="Unknown";
    const website=(tags.website||tags.contact_website||tags.url)?String(tags.website||tags.contact_website||tags.url).replace(/^http:\/\//,'https://'):null;
    const distance=userLocation?formatDistanceKm(haversine(userLocation.lat,userLocation.lng,v.lat,v.lng)):null;

    return `<div style="min-width:220px;max-width:260px">
      <div style="font-weight:800;font-size:16px;line-height:1.1">${v.name}</div>
      ${kind||distance?`<div style="color:#6b7280;margin:.2rem 0 .4rem 0">${[kind,distance].filter(Boolean).join(' · ')}</div>`:''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
        <span style="display:inline-flex;align-items:center;gap:6px;background:#fff7e6;border:1px solid #fde68a;color:#b45309;border-radius:999px;padding:4px 8px;font-size:12px;">
          <span>${sun.icon}</span><span>${sun.label}</span>
        </span>
        <span id="${weatherId}" style="display:inline-flex;align-items:center;gap:6px;background:#eef2ff;border:1px solid #c7d2fe;color:#312e81;border-radius:999px;padding:4px 8px;font-size:12px;">Loading weather…</span>
        ${showOpen ? `<span style="display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 8px;font-size:12px;${open.tone==='good'?'background:#e8f7ef;border:1px solid #bbf7d0;color:#166534':open.tone==='warn'?'background:#fff1f2;border:1px solid #fecdd3;color:#9f1239':open.tone==='info'?'background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8':'background:#f3f4f6;border:1px solid #e5e7eb;color:#4b5563'}">${open.status}</span>` : ''}
      </div>
      <div style="color:#6b7280;font-size:12px;margin-bottom:8px">Current sun: ${sun.label}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.name)}&query_place_id=" style="background:#111;color:#fff;text-decoration:none;border-radius:10px;padding:8px 10px;font-weight:700">Directions</a>
        <a target="_blank" rel="noopener" href="https://m.uber.com/ul/?action=setPickup&dropoff[latitude]=${v.lat}&dropoff[longitude]=${v.lng}&dropoff[nickname]=${encodeURIComponent(v.name)}" style="background:#f1f5f9;color:#111;text-decoration:none;border-radius:10px;padding:8px 10px;font-weight:700">Uber</a>
        ${website?`<a target="_blank" rel="noopener" href="${website}" style="background:#fff;border:1px solid #e5e7eb;color:#0a66c2;text-decoration:none;border-radius:10px;padding:8px 10px;font-weight:700">Website</a>`:''}
      </div>
    </div>`;
  }

  function renderMarkers(){
    if(!markersLayer) return;
    markersLayer.clearLayers();
    const b=map.getBounds();
    Object.values(allVenues).forEach(v=>{
      if(!b.contains([v.lat,v.lng])) return;
      const weatherId=`weather-${v.id.replace(/[^a-z0-9]+/gi,'-')}`;
      const marker=L.marker([v.lat,v.lng],{icon:markerIcon}).addTo(markersLayer);
      marker.bindPopup(popupHTML(v,weatherId));
      marker.on("popupopen",()=>populateWeatherBadge(weatherId,v.lat,v.lng));
    });
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
