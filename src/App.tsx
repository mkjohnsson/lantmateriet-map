import { useEffect, useRef, useState, useCallback } from 'react';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import WMTS from 'ol/source/WMTS';
import WMTSTileGrid from 'ol/tilegrid/WMTS';
import OSM from 'ol/source/OSM';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import { Icon, Style, Circle as CircleStyle, Fill, Stroke } from 'ol/style';
import Overlay from 'ol/Overlay';
import { fromLonLat } from 'ol/proj';
import { transformExtent } from 'ol/proj';
import ScaleLine from 'ol/control/ScaleLine';
import Zoom from 'ol/control/Zoom';
import 'ol/ol.css';
import './App.css';

// Lantmäteriet 3857 tile grid (from GetCapabilities)
// 16 zoom levels (0-15), standard Web Mercator
const lmResolutions = [
  559082264.028717875 * 0.00028,  // 0
  279541132.014358878 * 0.00028,  // 1
  139770566.007179409 * 0.00028,  // 2
  69885283.003589719 * 0.00028,   // 3
  34942641.501794859 * 0.00028,   // 4
  17471320.750897429 * 0.00028,   // 5
  8735660.375448714 * 0.00028,    // 6
  4367830.187724357 * 0.00028,    // 7
  2183915.093862178 * 0.00028,    // 8
  1091957.546931088 * 0.00028,    // 9
  545978.773465544 * 0.00028,     // 10
  272989.386732772 * 0.00028,     // 11
  136494.693366386 * 0.00028,     // 12
  68247.346683193 * 0.00028,      // 13
  34123.673341596 * 0.00028,      // 14
  17061.836670798 * 0.00028,      // 15
];
const lmMatrixIds = Array.from({ length: 16 }, (_, i) => String(i));

const apiBase = import.meta.env.DEV ? 'http://localhost:3000' : '';

type BaseLayer = 'lantmateriet' | 'osm';

interface SearchResult {
  display_name: string;
  lat: string;
  lon: string;
}

interface POI {
  id: number;
  name: string;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

interface AIPlace {
  name: string;
  lat: number;
  lon: number;
  description: string;
}

interface ChatMessage {
  role: 'user' | 'ai';
  text: string;
  places?: AIPlace[];
}

const POI_CATEGORIES = [
  { id: 'restauranger', label: 'Restauranger', emoji: '\u{1F37D}', color: '#f97316' },
  { id: 'kafeer', label: 'Kaféer', emoji: '\u2615', color: '#92400e' },
  { id: 'parker', label: 'Parker', emoji: '\u{1F333}', color: '#22c55e' },
  { id: 'laddstationer', label: 'Laddstationer', emoji: '\u26A1', color: '#eab308' },
  { id: 'busshallplatser', label: 'Busshållplatser', emoji: '\u{1F68C}', color: '#3b82f6' },
] as const;

type PoiCategory = typeof POI_CATEGORIES[number]['id'];

function App() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<Map | null>(null);
  const lmLayerRef = useRef<TileLayer | null>(null);
  const osmLayerRef = useRef<TileLayer | null>(null);
  const markerSource = useRef<VectorSource>(new VectorSource());
  const poiSource = useRef<VectorSource>(new VectorSource());
  const aiSource = useRef<VectorSource>(new VectorSource());
  const poiLayerRef = useRef<VectorLayer | null>(null);
  const aiLayerRef = useRef<VectorLayer | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const popupOverlay = useRef<Overlay | null>(null);
  const coordRef = useRef<HTMLSpanElement>(null);
  const zoomRef = useRef<HTMLSpanElement>(null);
  const [zoomLevel, setZoomLevel] = useState(5);
  const [baseLayer, setBaseLayer] = useState<BaseLayer>('osm');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [activePoiCategory, setActivePoiCategory] = useState<PoiCategory | null>(null);
  const [loadingPois, setLoadingPois] = useState(false);
  const activeCategoryRef = useRef<PoiCategory | null>(null);
  const poiDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Chat state
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const fetchPois = useCallback(async (category: PoiCategory) => {
    const map = mapInstance.current;
    if (!map) return;

    const extent = map.getView().calculateExtent(map.getSize());
    const [west, south, east, north] = transformExtent(extent, 'EPSG:3857', 'EPSG:4326');
    const bbox = `${south},${west},${north},${east}`;

    setLoadingPois(true);
    try {
      const res = await fetch(`${apiBase}/api/pois?category=${category}&bbox=${bbox}`);
      if (!res.ok) throw new Error('POI fetch failed');
      const pois: POI[] = await res.json();

      // Only update if this category is still active
      if (activeCategoryRef.current !== category) return;

      const catDef = POI_CATEGORIES.find(c => c.id === category)!;
      poiSource.current.clear();

      const features = pois.map(poi => {
        const f = new Feature({
          geometry: new Point(fromLonLat([poi.lon, poi.lat])),
          poiName: poi.name || 'Okänd',
          poiCategory: catDef.label,
          poiTags: poi.tags,
        });
        f.setStyle(new Style({
          image: new CircleStyle({
            radius: 7,
            fill: new Fill({ color: catDef.color }),
            stroke: new Stroke({ color: '#fff', width: 2 }),
          }),
        }));
        return f;
      });

      poiSource.current.addFeatures(features);
    } catch (e) {
      console.error('POI error:', e);
    }
    setLoadingPois(false);
  }, []);

  const togglePoiCategory = useCallback((categoryId: PoiCategory) => {
    if (activeCategoryRef.current === categoryId) {
      // Deactivate
      activeCategoryRef.current = null;
      setActivePoiCategory(null);
      poiSource.current.clear();
      if (popupOverlay.current) popupOverlay.current.setPosition(undefined);
    } else {
      // Activate
      activeCategoryRef.current = categoryId;
      setActivePoiCategory(categoryId);
      if (popupOverlay.current) popupOverlay.current.setPosition(undefined);
      fetchPois(categoryId);
    }
  }, [fetchPois]);

  // Plot AI places on map
  const plotAIPlaces = useCallback((places: AIPlace[]) => {
    aiSource.current.clear();
    if (places.length === 0) return;

    const features = places.map(place => {
      const f = new Feature({
        geometry: new Point(fromLonLat([place.lon, place.lat])),
        poiName: place.name,
        poiCategory: 'AI-svar',
        poiTags: { description: place.description },
      });
      f.setStyle(new Style({
        image: new Icon({
          anchor: [0.5, 1],
          scale: 1.5,
          src: 'data:image/svg+xml,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="32" viewBox="0 0 24 32">' +
            '<path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0z" fill="%239333ea"/>' +
            '<circle cx="12" cy="11" r="4" fill="white"/>' +
            '</svg>'
          ),
        }),
      }));
      return f;
    });

    aiSource.current.addFeatures(features);

    // Fit view to show all AI places
    const map = mapInstance.current;
    if (map && features.length > 0) {
      const extent = aiSource.current.getExtent();
      if (!extent) return;
      map.getView().fit(extent, {
        padding: [80, 80, 80, chatOpen ? 430 : 80],
        maxZoom: 14,
        duration: 800,
      });
    }
  }, [chatOpen]);

  // Send chat message
  const sendChatMessage = useCallback(async () => {
    const msg = chatInput.trim();
    if (!msg || chatLoading) return;

    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', text: msg }]);
    setChatLoading(true);

    try {
      const res = await fetch(`${apiBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Nätverksfel' }));
        setChatMessages(prev => [...prev, { role: 'ai', text: `Fel: ${err.error}` }]);
        return;
      }

      const data: { text: string; places: AIPlace[] } = await res.json();
      setChatMessages(prev => [...prev, { role: 'ai', text: data.text, places: data.places }]);

      if (data.places && data.places.length > 0) {
        plotAIPlaces(data.places);
      }
    } catch {
      setChatMessages(prev => [...prev, { role: 'ai', text: 'Kunde inte nå servern.' }]);
    } finally {
      setChatLoading(false);
    }
  }, [chatInput, chatLoading, plotAIPlaces]);

  // Swipe-to-close state
  const touchStartY = useRef<number | null>(null);
  const chatPanelRef = useRef<HTMLDivElement>(null);
  const chatHeaderRef = useRef<HTMLDivElement>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartY.current === null) return;
    const diff = e.changedTouches[0].clientY - touchStartY.current;
    if (diff > 50) setChatOpen(false);
    else if (diff < -50) setChatOpen(true);
    touchStartY.current = null;
  };

  // Non-passive touchmove to allow preventDefault (stops page scroll during swipe)
  useEffect(() => {
    const el = chatHeaderRef.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (touchStartY.current !== null) {
        const diff = e.touches[0].clientY - touchStartY.current;
        if (diff > 10) e.preventDefault();
      }
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, []);

  const handleSearchSubmit = () => {
    if (!chatInput.trim()) return;
    setChatOpen(true);
    sendChatMessage();
  };

  const handleSearchFocus = () => {
    if (chatMessages.length > 0) setChatOpen(true);
  };

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, chatLoading]);

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    const wmtsExtent: [number, number, number, number] = [-20037508.342789, -20037508.342789, 20037508.342789, 20037508.342789];

    const tileGrid = new WMTSTileGrid({
      tileSize: 256,
      extent: wmtsExtent,
      resolutions: lmResolutions,
      matrixIds: lmMatrixIds,
      origin: [-20037508.342789, 20037508.342789],
    });

    const lmLayer = new TileLayer({
      source: new WMTS({
        url: `${apiBase}/api/wmts`,
        layer: 'topowebb',
        format: 'image/png',
        matrixSet: '3857',
        tileGrid,
        version: '1.0.0',
        style: 'default',
        requestEncoding: 'KVP',
      }),
      visible: false,
    });

    const osmLayer = new TileLayer({
      source: new OSM(),
      visible: true,
    });

    const markerLayer = new VectorLayer({
      source: markerSource.current,
      style: new Style({
        image: new Icon({
          anchor: [0.5, 1],
          scale: 1.5,
          src: 'data:image/svg+xml,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="32" viewBox="0 0 24 32">' +
            '<path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0z" fill="%23e74c3c"/>' +
            '<circle cx="12" cy="11" r="4" fill="white"/>' +
            '</svg>'
          ),
        }),
      }),
    });

    const poiLayer = new VectorLayer({
      source: poiSource.current,
    });
    poiLayerRef.current = poiLayer;

    const aiLayer = new VectorLayer({
      source: aiSource.current,
    });
    aiLayerRef.current = aiLayer;

    lmLayerRef.current = lmLayer;
    osmLayerRef.current = osmLayer;

    const overlay = new Overlay({
      element: popupRef.current!,
      autoPan: { animation: { duration: 250 } },
    });
    popupOverlay.current = overlay;

    const map = new Map({
      target: mapRef.current,
      layers: [lmLayer, osmLayer, markerLayer, poiLayer, aiLayer],
      view: new View({
        center: fromLonLat([18.07, 59.33]), // Stockholm
        zoom: 5,
        minZoom: 0,
        maxZoom: 18,
      }),
      controls: [new Zoom(), new ScaleLine()],
      overlays: [overlay],
    });

    map.on('pointermove', (e) => {
      if (!coordRef.current) return;
      const [x, y] = e.coordinate;
      const lon = (x / 20037508.342789) * 180;
      const lat = (Math.atan(Math.exp((y / 20037508.342789) * Math.PI)) * 360 / Math.PI) - 90;
      coordRef.current.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    });

    map.on('moveend', () => {
      const z = Math.round(map.getView().getZoom() ?? 0);
      setZoomLevel(z);
      if (zoomRef.current) zoomRef.current.textContent = `Zoom: ${z}`;

      // Re-fetch POIs on pan/zoom
      if (activeCategoryRef.current) {
        if (poiDebounceRef.current) clearTimeout(poiDebounceRef.current);
        poiDebounceRef.current = setTimeout(() => {
          if (activeCategoryRef.current) fetchPois(activeCategoryRef.current);
        }, 500);
      }
    });

    // Click on POI or AI marker → show popup
    map.on('singleclick', (e) => {
      const feature = map.forEachFeatureAtPixel(e.pixel, f => f, {
        layerFilter: l => l === poiLayer || l === aiLayer,
      });
      if (feature) {
        const name = feature.get('poiName');
        const category = feature.get('poiCategory');
        const tags = feature.get('poiTags') || {};
        const geom = feature.getGeometry() as Point;

        const popupEl = popupRef.current;
        if (popupEl) {
          let html = `<strong>${name}</strong><br/><span class="poi-popup-type">${category}</span>`;
          if (tags.description) html += `<br/>${tags.description}`;
          if (tags.cuisine) html += `<br/>${tags.cuisine}`;
          if (tags.opening_hours) html += `<br/>${tags.opening_hours}`;
          if (tags.operator) html += `<br/>${tags.operator}`;
          popupEl.querySelector('.poi-popup-content')!.innerHTML = html;
        }
        overlay.setPosition(geom.getCoordinates());
      } else {
        overlay.setPosition(undefined);
      }
    });

    // Change cursor on hover over POI or AI marker
    map.on('pointermove', (e) => {
      const hit = map.hasFeatureAtPixel(e.pixel, {
        layerFilter: l => l === poiLayer || l === aiLayer,
      });
      map.getTargetElement().style.cursor = hit ? 'pointer' : '';
    });

    mapInstance.current = map;

    return () => {
      map.setTarget(undefined);
      mapInstance.current = null;
    };
  }, [fetchPois]);

  const switchLayer = (layer: BaseLayer) => {
    setBaseLayer(layer);
    if (lmLayerRef.current && osmLayerRef.current) {
      lmLayerRef.current.setVisible(layer === 'lantmateriet');
      osmLayerRef.current.setVisible(layer === 'osm');
    }
  };

  const search = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&countrycodes=se&limit=5&q=${encodeURIComponent(q)}`,
        { headers: { 'Accept-Language': 'sv' } }
      );
      const data: SearchResult[] = await res.json();
      setResults(data);
    } catch {
      setResults([]);
    }
    setSearching(false);
  }, []);

  const onSearchInput = (value: string) => {
    setQuery(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => search(value), 400);
  };

  const goToResult = (result: SearchResult) => {
    const map = mapInstance.current;
    if (!map) return;

    const coord = fromLonLat([parseFloat(result.lon), parseFloat(result.lat)]);

    markerSource.current.clear();
    markerSource.current.addFeature(new Feature(new Point(coord)));

    map.getView().animate({
      center: coord,
      zoom: 14,
      duration: 800,
    });

    setResults([]);
    setQuery(result.display_name.split(',')[0]);
  };

  const closePopup = () => {
    if (popupOverlay.current) popupOverlay.current.setPosition(undefined);
  };

  return (
    <div className="app">
      <div className="toolbar">
        <img src="/logo.png" alt="Weraryu?" className="toolbar-logo" />
        <div className="search-box">
          <input
            type="text"
            placeholder="Sök plats..."
            value={query}
            onChange={(e) => onSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results.length > 0) goToResult(results[0]);
            }}
          />
          {(results.length > 0 || searching) && (
            <div className="search-results">
              {searching && <div className="search-item">Söker...</div>}
              {results.map((r, i) => (
                <div key={i} className="search-item" onClick={() => goToResult(r)}>
                  {r.display_name}
                </div>
              ))}
            </div>
          )}
        </div>
        <button
          className="layer-toggle"
          onClick={() => switchLayer(baseLayer === 'lantmateriet' ? 'osm' : 'lantmateriet')}
        >
          {baseLayer === 'lantmateriet' ? 'Kartvy: LM' : 'Kartvy: OSM'}
        </button>
        <div className="info">
          <span ref={zoomRef}>Zoom: {zoomLevel}</span>
          <span ref={coordRef}></span>
        </div>
      </div>
      <div className="map-container">
        <div ref={mapRef} className="map" />
        <div className="poi-bar">
          {POI_CATEGORIES.map(cat => (
            <button
              key={cat.id}
              className={`poi-btn ${activePoiCategory === cat.id ? 'active' : ''}`}
              style={{ '--poi-color': cat.color } as React.CSSProperties}
              onClick={() => togglePoiCategory(cat.id)}
            >
              {cat.label}
            </button>
          ))}
          {loadingPois && <span className="poi-loading">Laddar...</span>}
        </div>
        {/* Chat panel — always visible on mobile, sidebar on desktop */}
        <div
          ref={chatPanelRef}
          className={`chat-panel ${chatOpen ? 'chat-panel-open' : ''}`}
        >
          <div
            ref={chatHeaderRef}
            className="chat-panel-header"
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            <div className="chat-drag-handle" />
            <div className="chat-search-bar">
              <input
                type="text"
                placeholder="Fråga om en plats..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSearchSubmit();
                }}
                onFocus={handleSearchFocus}
                disabled={chatLoading}
              />
              <button onClick={handleSearchSubmit} disabled={chatLoading || !chatInput.trim()}>
                Skicka
              </button>
            </div>
          </div>
          <div className="chat-messages">
            {chatMessages.length === 0 && (
              <div className="chat-hint">
                Ställ en fråga om platser i Sverige, t.ex. &quot;Var ligger Vasamuseet?&quot; eller &quot;Vilka slott finns runt Stockholm?&quot;
              </div>
            )}
            {chatMessages.map((msg, i) => (
              <div key={i} className={`chat-msg chat-msg-${msg.role}`}>
                <div className="chat-msg-text">{msg.text}</div>
                {msg.places && msg.places.length > 0 && (
                  <div className="chat-places">
                    {msg.places.map((p, j) => (
                      <button
                        key={j}
                        className="chat-place-btn"
                        onClick={() => {
                          const map = mapInstance.current;
                          if (!map) return;
                          const coord = fromLonLat([p.lon, p.lat]);
                          map.getView().animate({ center: coord, zoom: 14, duration: 800 });
                        }}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {chatLoading && (
              <div className="chat-msg chat-msg-ai">
                <div className="chat-msg-text chat-loading">Tänker...</div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
        </div>
      </div>
      <div ref={popupRef} className="poi-popup">
        <button className="poi-popup-close" onClick={closePopup}>&times;</button>
        <div className="poi-popup-content"></div>
      </div>
    </div>
  );
}

export default App;
