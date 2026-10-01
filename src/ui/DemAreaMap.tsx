import { useEffect, useRef, useState } from 'preact/hooks';
import type * as Leaflet from 'leaflet';
import type { DemArea, GeographicPoint } from '../dem/mapSelection';
import 'leaflet/dist/leaflet.css';
import './demAreaMap.css';

type Mode = 'browse' | 'center' | 'area';
export function DemAreaMap({ area, disabled, onChange }: { area: DemArea; disabled: boolean; onChange: (area: DemArea) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const current = useRef({ area, disabled, onChange }); current.current = { area, disabled, onChange };
  const controller = useRef<{ draw: (fit: boolean) => void; clear: () => void }>();
  const mode = useRef<Mode>('browse'), corner = useRef<GeographicPoint>();
  const [activeMode, setActiveMode] = useState<Mode>('browse'), [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false), [error, setError] = useState(''), [tileError, setTileError] = useState(false);
  const selectMode = (next: Mode) => {
    mode.current = next; corner.current = undefined; setActiveMode(next); setPending(false); setError(''); controller.current?.clear();
  };
  useEffect(() => {
    let disposed = false, map: Leaflet.Map | undefined, observer: ResizeObserver | undefined;
    void Promise.all([import('leaflet'), import('../dem/mapSelection')]).then(([L, geometry]) => {
      if (disposed || !container.current) return;
      map = L.map(container.current, { worldCopyJump: false, maxBounds: [[-85, -180], [85, 180]], minZoom: 3, maxZoom: 19 });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
        maxZoom: 19, noWrap: true, updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 0,
      }).on('tileerror', () => { if (!disposed) setTileError(true); }).addTo(map);
      L.control.scale({ imperial: false }).addTo(map);
      const outline = L.polygon([], { color: '#143c32', weight: 3, fillColor: '#80d4ac', fillOpacity: .2, interactive: false }).addTo(map);
      const center = L.circleMarker([0, 0], { radius: 5, color: '#143c32', fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(map);
      const draft = L.rectangle([[0, 0], [0, 0]], { color: '#143c32', dashArray: '6 5', weight: 2, fillOpacity: .1, interactive: false });
      const clear = () => { if (map?.hasLayer(draft)) map.removeLayer(draft); };
      controller.current = { clear, draw: (fit) => {
        try {
          const { outline: points } = geometry.areaRegion(current.current.area);
          outline.setLatLngs(points); center.setLatLng([current.current.area.latitude, current.current.area.longitude]);
          if (!map?.hasLayer(outline)) { outline.addTo(map!); center.addTo(map!); }
          if (fit) map?.fitBounds(outline.getBounds(), { padding: [45, 45], maxZoom: 16, animate: false });
          setError('');
        } catch (cause) {
          map?.removeLayer(outline); map?.removeLayer(center);
          setError(cause instanceof Error ? cause.message : String(cause));
          // Still provide an initial view when numerical coordinates are invalid.
          if (!map?.getZoom()) map?.setView([34.69, 135.5], 13);
        }
      } };
      map.on('click', (event: Leaflet.LeafletMouseEvent) => {
        if (current.current.disabled || mode.current === 'browse') return;
        try {
          if (mode.current === 'center') {
            const next = { ...current.current.area, latitude: event.latlng.lat, longitude: event.latlng.lng };
            geometry.areaRegion(next); current.current.onChange(next); selectMode('browse');
          } else if (!corner.current) {
            corner.current = { lat: event.latlng.lat, lng: event.latlng.lng }; setPending(true);
            draft.setBounds(L.latLngBounds(event.latlng, event.latlng)).addTo(map!);
          } else {
            const next = geometry.areaFromCorners(corner.current, event.latlng, current.current.area.spacing);
            current.current.onChange(next); selectMode('browse');
          }
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      });
      map.on('mousemove', (event: Leaflet.LeafletMouseEvent) => {
        if (corner.current && !current.current.disabled) draft.setBounds(L.latLngBounds(corner.current, event.latlng));
      });
      observer = new ResizeObserver(() => map?.invalidateSize()); observer.observe(container.current);
      controller.current.draw(true); setReady(true);
    }).catch(cause => { if (!disposed) setError(`Map could not load: ${String(cause)}. You can still use the coordinate inputs.`); });
    return () => { disposed = true; observer?.disconnect(); controller.current = undefined; map?.remove(); };
  }, []);
  useEffect(() => { selectMode('browse'); controller.current?.draw(true); }, [area.latitude, area.longitude, area.width, area.depth, area.spacing]);
  useEffect(() => { if (disabled) selectMode('browse'); }, [disabled]);
  return <div class="dem-area-map">
    <div class="dem-map-toolbar">
      <button disabled={!ready || disabled} aria-pressed={activeMode === 'center'} onClick={() => selectMode(activeMode === 'center' ? 'browse' : 'center')}>SET CENTER</button>
      <button disabled={!ready || disabled} aria-pressed={activeMode === 'area'} onClick={() => selectMode(activeMode === 'area' ? 'browse' : 'area')}>SELECT AREA</button>
      <button disabled={!ready} onClick={() => { selectMode('browse'); controller.current?.draw(true); }}>FIT AREA</button>
    </div>
    <p role="status">{activeMode === 'center' ? 'Click the map to place the centre.' : activeMode === 'area'
      ? pending ? 'Click the opposite corner. Click SELECT AREA again to cancel.' : 'Click the first corner, then the opposite corner.'
      : 'Drag to explore · scroll or +/− to zoom · SELECT AREA to choose two corners.'}</p>
    <div ref={container} class="dem-map-canvas" role="region" aria-label="DEM area selection map" />
    <p class="dem-map-caption">Selected: {area.width.toLocaleString()} × {area.depth.toLocaleString()} m. Drawn sizes round to 64 m; maximum 32,768 m per side. The outlined metric footprint is imported.</p>
    {tileError && <p role="status">Some basemap tiles could not load. Coordinate selection and local DEM import remain available.</p>}
    {error && <p class="new-game-error" role="alert">{error}</p>}
  </div>;
}
