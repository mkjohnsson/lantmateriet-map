# lantmateriet-map (Weraryu?)

Interaktiv karta över Sverige med Lantmäteriets topografiska kartor, OSM, POI-sökning och AI-chatt.

## Stack

- **Frontend:** React 19 + TypeScript + OpenLayers 10 + Vite
- **Backend:** Express (Node.js) — OAuth2-proxy för Lantmäteriet + POI-API + AI-chatt
- **AI:** Google Gemini 2.5 Flash via OpenRouter
- **Hosting:** Raspberry Pi 5 → publikt på https://weraryu.com (Cloudflare Tunnel + Access)
- **CI/CD:** GitHub Actions med self-hosted runner på Pi (auto-deploy vid push till master)

## Nyckelkomponenter

| Fil | Vad den gör |
|---|---|
| `src/App.tsx` | Hela frontend-appen — karta, sökning, POI, AI-chatt |
| `server/index.js` | Express-backend — WMTS-proxy, POI-API, AI-chatt-endpoint |
| `.env` | Hemliga nycklar (ingår ej i git) |
| `.github/workflows/deploy.yml` | GitHub Actions CI/CD |

## Köra lokalt

```bash
# Terminal 1 — backend
npm run dev:server

# Terminal 2 — frontend
npm run dev
```

Frontend: http://localhost:5173
Backend: http://localhost:3000

## Bygga och deploya

Deploy sker automatiskt via GitHub Actions vid push till `master`.

```bash
git add . && git commit -m "beskrivning" && git push
```

Manuell build (om det behövs):
```bash
npm run build
```

## Miljövariabler (.env)

```
LM_CLIENT_KEY=        # Lantmäteriet OAuth2 client key
LM_CLIENT_SECRET=     # Lantmäteriet OAuth2 client secret
OPENROUTER_API_KEY=   # OpenRouter API-nyckel (Gemini via OpenRouter)
```

## Funktioner

- **Kartlager:** Lantmäteriets topowebb (WMTS via OAuth2-proxy) + OpenStreetMap
- **Platssökning:** Nominatim (Sverige-filtrerat) med fly-to och markör
- **POI-kategorier:** Restauranger, Kaféer, Parker, Laddstationer, Busshållplatser (OpenStreetMap Overpass API)
- **AI-chatt:** Fråga om platser i Sverige → svar med koordinater plottade på kartan
- **Koordinatkorrigering:** AI-svar verifieras mot Nominatim för korrekta koordinater
- **Mobilvänlig:** Swipe-to-close för chatpanelen

## Hosting på Pi

- **URL:** https://weraryu.com (skyddad med Cloudflare Access — e-post-engångskod)
- **Intern port:** 5003
- **pm2-processnamn:** `weraryu`
- **Appkatalog på Pi:** `~/apps/lantmateriet-map/`

```bash
# Kolla status
ssh pi@raspberrypi.local "pm2 show weraryu"

# Kolla loggar
ssh pi@raspberrypi.local "pm2 logs weraryu --lines 30"

# Starta om manuellt
ssh pi@raspberrypi.local "pm2 restart weraryu"
```

## GitHub

- **Repo:** https://github.com/mkjohnsson/lantmateriet-map
- **Runner:** `pi-lantmateriet-map` (self-hosted på Pi)
- **Actions:** https://github.com/mkjohnsson/lantmateriet-map/actions
