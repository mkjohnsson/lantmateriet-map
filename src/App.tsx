import { useEffect, useRef, useState, useCallback } from 'react';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import WMTS from 'ol/source/WMTS';
import WMTSTileGrid from 'ol/tilegrid/WMTS';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import { Icon, Style } from 'ol/style';
import { register } from 'ol/proj/proj4';
import { get as getProjection, transform } from 'ol/proj';
import proj4 from 'proj4';
import ScaleLine from 'ol/control/ScaleLine';
import Zoom from 'ol/control/Zoom';
import 'ol/ol.css';
import './App.css';

// Register SWEREF99 TM (EPSG:3006)
proj4.defs('EPSG:3006', '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
register(proj4);

const extent3006: [number, number, number, number] = [-1200000, 4305696, 2994304, 8500000];
const origin3006: [number, number] = [-1200000, 8500000];
const resolutions3006 = [4096, 2048, 1024, 512, 256, 128, 64, 32, 16, 8];
const matrixIds = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

const apiBase = import.meta.env.DEV ? 'http://localhost:3000' : '';

interface SearchResult {
  display_name: string;
  lat: string;
  lon: string;
}

function App() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<Map | null>(null);
  const markerSource = useRef<VectorSource>(new VectorSource());
  const [coordinates, setCoordinates] = useState<{ x: number; y: number } | null>(null);
  const [zoomLevel, setZoomLevel] = useState(2);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    const projection = getProjection('EPSG:3006')!;
    projection.setExtent(extent3006);

    const tileGrid = new WMTSTileGrid({
      tileSize: 256,
      extent: extent3006,
      resolutions: resolutions3006,
      matrixIds,
      origin: origin3006,
    });

    const wmtsSource = new WMTS({
      url: `${apiBase}/api/wmts`,
      layer: 'topowebb',
      format: 'image/png',
      matrixSet: '3006',
      tileGrid,
      version: '1.0.0',
      style: 'default',
      requestEncoding: 'KVP',
    });

    // Marker layer for search results
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

    const map = new Map({
      target: mapRef.current,
      layers: [
        new TileLayer({ source: wmtsSource }),
        markerLayer,
      ],
      view: new View({
        projection: 'EPSG:3006',
        extent: extent3006,
        center: [616542, 6727536],
        zoom: 2,
        resolutions: resolutions3006,
      }),
      controls: [new Zoom(), new ScaleLine()],
    });

    map.on('pointermove', (e) => {
      const [x, y] = e.coordinate;
      setCoordinates({ x: Math.round(x), y: Math.round(y) });
    });

    map.on('moveend', () => {
      setZoomLevel(map.getView().getZoom() ?? 0);
    });

    mapInstance.current = map;

    return () => {
      map.setTarget(undefined);
      mapInstance.current = null;
    };
  }, []);

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

    const lon = parseFloat(result.lon);
    const lat = parseFloat(result.lat);
    const coord = transform([lon, lat], 'EPSG:4326', 'EPSG:3006');

    // Add marker
    markerSource.current.clear();
    markerSource.current.addFeature(new Feature(new Point(coord)));

    // Fly to location
    map.getView().animate({
      center: coord,
      zoom: 7,
      duration: 800,
    });

    setResults([]);
    setQuery(result.display_name.split(',')[0]);
  };

  return (
    <div className="app">
      <div className="toolbar">
        <h1>Lantmäteriet Karta</h1>
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
        <div className="info">
          <span>Zoom: {zoomLevel.toFixed(0)}</span>
          {coordinates && (
            <span>
              SWEREF99: {coordinates.x}, {coordinates.y}
            </span>
          )}
        </div>
      </div>
      <div ref={mapRef} className="map" />
    </div>
  );
}

export default App;
