import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// CORS for dev
app.use((_req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

const CLIENT_KEY = process.env.LM_CLIENT_KEY;
const CLIENT_SECRET = process.env.LM_CLIENT_SECRET;
const TOKEN_URL = 'https://apimanager.lantmateriet.se/oauth2/token';
const WMTS_BASE = 'https://maps.lantmateriet.se/open/topowebb-ccby/v1/wmts';

let cachedToken = null;
let tokenExpiry = 0;

// ── Sysselsättning caches ──────────────────────────────────────────────────
const scbCache = { data: null, ts: 0 };
const geoCache = { data: null, ts: 0 };
const SCB_TTL = 24 * 60 * 60 * 1000;        // 24h
const GEO_TTL = 7 * 24 * 60 * 60 * 1000;   // 7 days

const SCB_URL = 'https://api.scb.se/OV0104/v1/doris/sv/ssd/AM/AM0210/AM0210D/ArRegArbStatus';
const GADM_URL = 'https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_SWE_2.json';

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const creds = Buffer.from(`${CLIENT_KEY}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await res.json();
  cachedToken = data.access_token;
  // Refresh 5 min before expiry
  tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  return cachedToken;
}

// Proxy all WMTS requests (KVP and REST)
app.get('/api/wmts', async (req, res) => {
  try {
    const token = await getToken();
    const qs = new URLSearchParams(req.query).toString();
    const url = `${WMTS_BASE}?${qs}`;
    console.log('WMTS proxy:', url);

    const wmtsRes = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (wmtsRes.status === 401) {
      // Token expired, force refresh and retry once
      cachedToken = null;
      tokenExpiry = 0;
      const newToken = await getToken();
      const retryRes = await fetch(url, {
        headers: { 'Authorization': `Bearer ${newToken}` },
      });
      if (!retryRes.ok) {
        console.log('WMTS error after retry:', retryRes.status);
        return res.status(retryRes.status).send('WMTS request failed');
      }
      const ct = retryRes.headers.get('content-type') || 'application/octet-stream';
      res.set('Content-Type', ct);
      res.set('Cache-Control', 'public, max-age=86400');
      const buf = Buffer.from(await retryRes.arrayBuffer());
      return res.send(buf);
    }

    if (!wmtsRes.ok) {
      console.log('WMTS error:', wmtsRes.status);
      return res.status(wmtsRes.status).send('WMTS request failed');
    }

    const contentType = wmtsRes.headers.get('content-type') || 'application/octet-stream';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    const buffer = Buffer.from(await wmtsRes.arrayBuffer());
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POI categories → Overpass tags
const POI_CATEGORIES = {
  restauranger: { key: 'amenity', value: 'restaurant' },
  kafeer: { key: 'amenity', value: 'cafe' },
  parker: { key: 'leisure', value: 'park' },
  laddstationer: { key: 'amenity', value: 'charging_station' },
  busshallplatser: { key: 'highway', value: 'bus_stop' },
};

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const poiCache = new Map();
const POI_CACHE_TTL = 5 * 60 * 1000; // 5 min

app.get('/api/pois', async (req, res) => {
  try {
    const { category, bbox } = req.query;
    const cat = POI_CATEGORIES[category];
    if (!cat) {
      return res.status(400).json({ error: `Unknown category. Valid: ${Object.keys(POI_CATEGORIES).join(', ')}` });
    }
    if (!bbox) {
      return res.status(400).json({ error: 'bbox required (south,west,north,east)' });
    }

    const cacheKey = `${category}:${bbox}`;
    const cached = poiCache.get(cacheKey);
    if (cached && Date.now() - cached.time < POI_CACHE_TTL) {
      return res.json(cached.data);
    }

    const [south, west, north, east] = bbox.split(',');
    const query = `[out:json][timeout:10];node["${cat.key}"="${cat.value}"](${south},${west},${north},${east});out body;`;

    const overpassRes = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (!overpassRes.ok) {
      console.log('Overpass error:', overpassRes.status);
      return res.status(502).json({ error: 'Overpass API error' });
    }

    const data = await overpassRes.json();
    const pois = (data.elements || []).map(el => ({
      id: el.id,
      name: el.tags?.name || '',
      lat: el.lat,
      lon: el.lon,
      tags: el.tags || {},
    }));

    poiCache.set(cacheKey, { time: Date.now(), data: pois });

    // Evict old cache entries
    if (poiCache.size > 200) {
      const now = Date.now();
      for (const [k, v] of poiCache) {
        if (now - v.time > POI_CACHE_TTL) poiCache.delete(k);
      }
    }

    res.json(pois);
  } catch (e) {
    console.error('POI fetch error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// AI Chat endpoint
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CHAT_MODEL = 'google/gemini-2.5-flash';

const SYSTEM_PROMPT = `Du är en kunnig guide för Sverige och Norden. Användaren ställer frågor om platser, sevärdheter, historiska händelser och geografi.

VIKTIGT: Du ska ALLTID inkludera platser med koordinater i ditt svar. Formatera dem i ett JSON-block markerat med \`\`\`places och \`\`\`:

\`\`\`places
[{"name": "Platsnamn", "lat": 59.123, "lon": 18.456, "description": "Kort beskrivning"}]
\`\`\`

Regler:
- Svara alltid på svenska
- Inkludera alltid minst en plats med koordinater
- Koordinaterna ska vara korrekta WGS84 (lat/lon)
- Ge en informativ textbeskrivning utöver platserna
- Om frågan handlar om flera platser, inkludera alla relevanta platser i JSON-blocket`;

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message required' });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey || apiKey === 'your-openrouter-api-key-here') {
      return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured' });
    }

    console.log('Chat request:', message.substring(0, 80));

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenRouter error:', response.status, errText);
      return res.status(502).json({ error: 'AI API error' });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Parse out places JSON block
    let places = [];
    let text = content;
    const placesMatch = content.match(/```places\s*\n([\s\S]*?)\n```/);
    if (placesMatch) {
      try {
        places = JSON.parse(placesMatch[1]);
      } catch (e) {
        console.error('Failed to parse places JSON:', e.message);
      }
      // Remove the places block from displayed text
      text = content.replace(/```places\s*\n[\s\S]*?\n```/, '').trim();
    }

    // Verify/correct coordinates via Nominatim
    if (places.length > 0) {
      const corrected = await Promise.all(places.map(async (place) => {
        try {
          const q = encodeURIComponent(place.name);
          const nomRes = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&countrycodes=se&limit=1&q=${q}`,
            { headers: { 'User-Agent': 'SverigeKarta/1.0', 'Accept-Language': 'sv' } }
          );
          const nomData = await nomRes.json();
          if (nomData.length > 0) {
            const correctedLat = parseFloat(nomData[0].lat);
            const correctedLon = parseFloat(nomData[0].lon);
            console.log(`Corrected "${place.name}": ${place.lat},${place.lon} → ${correctedLat},${correctedLon}`);
            return { ...place, lat: correctedLat, lon: correctedLon };
          }
        } catch (e) {
          console.error(`Nominatim lookup failed for "${place.name}":`, e.message);
        }
        return place; // keep AI coordinates as fallback
      }));
      places = corrected;
    }

    res.json({ text, places });
  } catch (e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/kommuner-sysselsattning ─────────────────────────────────────
app.get('/api/kommuner-sysselsattning', async (_req, res) => {
  try {
    // 1. SCB metadata + data (cached 24h)
    let nameToKod, kodToValue;
    if (scbCache.data && Date.now() - scbCache.ts < SCB_TTL) {
      ({ nameToKod, kodToValue } = scbCache.data);
    } else {
      // GET metadata → build nameToKod (kommunnamn → 4-siffrig kod)
      const metaRes = await fetch(SCB_URL);
      if (!metaRes.ok) throw new Error(`SCB metadata HTTP ${metaRes.status}`);
      const meta = await metaRes.json();

      const regionVar = meta.variables.find(v => v.code === 'Region');
      if (!regionVar) throw new Error('SCB: Region variable not found in metadata');

      nameToKod = {};
      const municipalityCodes = [];
      regionVar.values.forEach((kod, i) => {
        if (/^\d{4}$/.test(kod)) {          // 4-digit codes = municipalities
          nameToKod[regionVar.valueTexts[i]] = kod;
          municipalityCodes.push(kod);
        }
      });
      console.log(`SCB metadata: ${municipalityCodes.length} municipalities found`);

      // POST data → sysselsättningsgrad per municipality
      const scbQuery = {
        query: [
          { code: 'Region',        selection: { filter: 'item', values: municipalityCodes } },
          { code: 'Kon',           selection: { filter: 'item', values: ['1+2'] } },
          { code: 'Alder',         selection: { filter: 'item', values: ['16-64'] } },
          { code: 'Fodelseregion', selection: { filter: 'item', values: ['tot'] } },
          { code: 'ContentsCode',  selection: { filter: 'item', values: ['000002NS'] } },
          { code: 'Tid',           selection: { filter: 'item', values: ['2024'] } },
        ],
        response: { format: 'json' },
      };

      const dataRes = await fetch(SCB_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scbQuery),
      });
      if (!dataRes.ok) {
        const errText = await dataRes.text();
        throw new Error(`SCB data HTTP ${dataRes.status}: ${errText.slice(0, 200)}`);
      }
      const scbData = await dataRes.json();

      kodToValue = {};
      for (const row of (scbData.data || [])) {
        const kod = row.key[0];
        const value = parseFloat(row.values[0]);
        if (!isNaN(value)) kodToValue[kod] = value;
      }
      console.log(`SCB data: ${Object.keys(kodToValue).length} values loaded`);

      scbCache.data = { nameToKod, kodToValue };
      scbCache.ts = Date.now();
    }

    // 2. GADM GeoJSON (cached 7 days)
    let gadmGeo;
    if (geoCache.data && Date.now() - geoCache.ts < GEO_TTL) {
      gadmGeo = geoCache.data;
    } else {
      console.log('Fetching GADM GeoJSON…');
      const geoRes = await fetch(GADM_URL);
      if (!geoRes.ok) throw new Error(`GADM HTTP ${geoRes.status}`);
      gadmGeo = await geoRes.json();
      geoCache.data = gadmGeo;
      geoCache.ts = Date.now();
      console.log(`GADM: ${gadmGeo.features.length} total features cached`);
    }

    // 3. Merge: add kod + sysselsattning to each municipality feature
    // Build case-insensitive fallback map
    const nameLower = {};
    for (const [name, kod] of Object.entries(nameToKod)) {
      nameLower[name.toLowerCase()] = kod;
    }

    const unmatched = [];
    const features = gadmGeo.features
      .filter(f => f.properties.ENGTYPE_2 === 'Municipality')
      .map(f => {
        const name2 = f.properties.NAME_2 || '';
        const kod = nameToKod[name2] || nameLower[name2.toLowerCase()] || null;
        const sysselsattning = kod ? (kodToValue[kod] ?? null) : null;
        if (!kod) unmatched.push(name2);
        return {
          ...f,
          properties: {
            ...f.properties,
            kod,
            sysselsattning,
          },
        };
      });

    if (unmatched.length > 0) {
      console.warn('Unmatched municipalities (no SCB data):', unmatched);
    }

    res.json({ type: 'FeatureCollection', features });
  } catch (e) {
    console.error('Sysselsättning endpoint error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Serve frontend
app.use(express.static(join(__dirname, '..', 'dist')));
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, '..', 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Map server running on http://localhost:${PORT}`);
});
