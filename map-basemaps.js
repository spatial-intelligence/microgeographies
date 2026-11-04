/* Shared basemaps for every Leaflet viewer. Gray variants retain OSM labels. */
(() => {
  'use strict';
  const streets = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const osm = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const definitions = {
    streets: {name:'Streets', url:streets, attribution:osm},
    aerial: {name:'Esri aerial', url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution:'Tiles &copy; Esri — Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community'},
    light: {name:'Light gray', url:streets, attribution:osm, className:'basemap-light-gray'},
    dark: {name:'Dark gray', url:streets, attribution:osm, className:'basemap-dark-gray'},
  };
  window.MGMaps = {
    addBasemaps(map, id) {
      const L = window.L, key = `mg.basemap.${id}`;
      let selected = 'streets', active;
      try { const saved = localStorage.getItem(key); if (Object.hasOwn(definitions, saved)) selected = saved; } catch (_) {}
      const control = L.control({position:'topright'});
      control.onAdd = () => {
        const label = L.DomUtil.create('label', 'map-basemap-control');
        const caption = document.createElement('span'); caption.textContent = 'Basemap'; label.append(caption);
        const select = document.createElement('select'); select.setAttribute('aria-label', 'Basemap');
        for (const [value, definition] of Object.entries(definitions)) {
          const option = document.createElement('option'); option.value = value; option.textContent = definition.name; select.append(option);
        }
        const change = () => {
          const definition = definitions[select.value];
          if (active) map.removeLayer(active);
          active = L.tileLayer(definition.url, {maxZoom:22, maxNativeZoom:19, attribution:definition.attribution, className:definition.className || ''}).addTo(map);
          try { localStorage.setItem(key, select.value); } catch (_) {}
        };
        select.value = selected; select.addEventListener('change', change); label.append(select);
        L.DomEvent.disableClickPropagation(label); L.DomEvent.disableScrollPropagation(label);
        // Keyboard navigation of the menu must not pan the map or trigger survey shortcuts.
        L.DomEvent.on(label, 'keydown keyup', L.DomEvent.stopPropagation);
        change(); return label;
      };
      control.addTo(map);
    }
  };
})();
