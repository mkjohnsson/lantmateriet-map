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
import { Icon, Style } from 'ol/style';
import { fromLonLat } from 'ol/proj';
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

function App() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<Map | null>(null);
  const lmLayerRef = useRef<TileLayer | null>(null);
  const osmLayerRef = useRef<TileLayer | null>(null);
  const markerSource = useRef<VectorSource>(new VectorSource());
  const coordRef = useRef<HTMLSpanElement>(null);
  const zoomRef = useRef<HTMLSpanElement>(null);
  const [zoomLevel, setZoomLevel] = useState(5);
  const [baseLayer, setBaseLayer] = useState<BaseLayer>('lantmateriet');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      visible: true,
    });

    const osmLayer = new TileLayer({
      source: new OSM(),
      visible: false,
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

    lmLayerRef.current = lmLayer;
    osmLayerRef.current = osmLayer;

    const map = new Map({
      target: mapRef.current,
      layers: [lmLayer, osmLayer, markerLayer],
      view: new View({
        center: fromLonLat([18.07, 59.33]), // Stockholm
        zoom: 5,
        minZoom: 0,
        maxZoom: 18,
      }),
      controls: [new Zoom(), new ScaleLine()],
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
    });

    mapInstance.current = map;

    return () => {
      map.setTarget(undefined);
      mapInstance.current = null;
    };
  }, []);

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

  return (
    <div className="app">
      <div className="toolbar">
        <h1>Sverige Karta</h1>
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
        <div className="layer-switcher">
          <button
            className={`layer-btn ${baseLayer === 'lantmateriet' ? 'active' : ''}`}
            onClick={() => switchLayer('lantmateriet')}
          >
            Lantmäteriet
          </button>
          <button
            className={`layer-btn ${baseLayer === 'osm' ? 'active' : ''}`}
            onClick={() => switchLayer('osm')}
          >
            OpenStreetMap
          </button>
        </div>
        <div className="info">
          <span ref={zoomRef}>Zoom: {zoomLevel}</span>
          <span ref={coordRef}></span>
        </div>
      </div>
      <div ref={mapRef} className="map" />
    </div>
  );
}

export default App;
