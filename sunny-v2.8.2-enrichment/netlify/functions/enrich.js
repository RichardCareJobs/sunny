// netlify/functions/enrich.js
// Fetch venue enrichment from Foursquare + Wikidata.
// Env vars expected:
//   FOURSQUARE_API_KEY
// Notes: This code runs on Netlify Functions (Node 18+).

export default async (request, context) => {
  try {
    const url = new URL(request.url);
    const name = url.searchParams.get('name') || '';
    const lat = parseFloat(url.searchParams.get('lat'));
    const lon = parseFloat(url.searchParams.get('lon'));
    const wikidata = url.searchParams.get('wikidata') || '';
    const osm_id = url.searchParams.get('osm_id') || '';

    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    if (request.method === 'OPTIONS') {
      return new Response('', { status: 204, headers });
    }

    // If no coords, bail
    if (!isFinite(lat) || !isFinite(lon)) {
      return new Response(JSON.stringify({ ok: false, reason: 'missing_coords' }), { status: 400, headers });
    }

    let data = { ok: true, source: [], hours: null, phone: null, website: null, photos: [], rating: null, price: null };

    // 1) Foursquare
    const fsqKey = process.env.FOURSQUARE_API_KEY;
    if (fsqKey) {
      try {
        const searchParams = new URLSearchParams({
          query: name,
          ll: `${lat},${lon}`,
          radius: '200',
          categories: '13003,13032,13018', // pub, beer bar, bar
          limit: '5'
        });
        const search = await fetch(`https://api.foursquare.com/v3/places/search?${searchParams.toString()}`, {
          headers: { 'Authorization': fsqKey, 'accept': 'application/json' }
        });
        if (search.ok) {
          const sjson = await search.json();
          // choose best match by distance + name similarity
          let best = null;
          function norm(s){ return (s||'').toLowerCase().replace(/hotel|the|bar|pub|hotel|inn|tavern|brewery/g,'').replace(/[^a-z0-9]+/g,'').trim(); }
          const nName = norm(name);
          for (const p of (sjson.results || [])) {
            const dist = p.distance ?? 9999;
            const score = 1000 - Math.min(dist, 1000) + (norm(p.name) === nName ? 500 : 0);
            if (!best || score > best.score) best = { ...p, score };
          }
          if (best && best.fsq_id) {
            const detail = await fetch(`https://api.foursquare.com/v3/places/${best.fsq_id}?fields=fsq_id,name,location,geocodes,website,tel,hours,rating,price,photos`, {
              headers: { 'Authorization': fsqKey, 'accept': 'application/json' }
            });
            if (detail.ok) {
              const dj = await detail.json();
              data.source.push('foursquare');
              data.hours = dj.hours || null;
              data.phone = dj.tel || null;
              data.website = dj.website || null;
              data.rating = dj.rating || null;
              data.price = dj.price || null;
              if (Array.isArray(dj.photos)) {
                data.photos = dj.photos.slice(0, 4).map(p => `https://fastly.4sqi.net/img/general/540x360/${p.prefix.replace(/^https?:\/\//,'')}${p.suffix}`);
              }
              data.fsq_id = dj.fsq_id;
            }
          }
        }
      } catch (e) {
        // ignore
      }
    }

    // 2) Wikidata (if id provided)
    if (wikidata) {
      try {
        const wd = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${wikidata}.json`);
        if (wd.ok) {
          const wj = await wd.json();
          const ent = wj.entities?.[wikidata]?.claims || {};
          function getClaim(prop){
            const v = ent[prop]?.[0]?.mainsnak?.datavalue?.value;
            return (typeof v === 'string') ? v : (v?.text || null);
          }
          const site = getClaim('P856'); // official website
          const phone = getClaim('P1329'); // phone number
          if (site && !data.website) data.website = site;
          if (phone && !data.phone) data.phone = phone;
          data.source.push('wikidata');
        }
      } catch(e){}
    }

    // Minimal response
    return new Response(JSON.stringify(data), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ ok:false, error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin':'*' }
    });
  }
};
