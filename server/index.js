import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// CORS for dev
app.use((_req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  next();
});

const CLIENT_KEY = process.env.LM_CLIENT_KEY;
const CLIENT_SECRET = process.env.LM_CLIENT_SECRET;
const TOKEN_URL = 'https://apimanager.lantmateriet.se/oauth2/token';
const WMTS_BASE = 'https://maps.lantmateriet.se/open/topowebb-ccby/v1/wmts';

let cachedToken = null;
let tokenExpiry = 0;

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

// Serve frontend
app.use(express.static(join(__dirname, '..', 'dist')));
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, '..', 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Map server running on http://localhost:${PORT}`);
});
