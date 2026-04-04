// rtstruct-overlay.js — draw RTSTRUCT contours on the Cornerstone 2D viewer.
//
// Contours are drawn inside the 'cornerstoneimagerendered' event so they
// stay aligned after every W/L drag, zoom, or pan that triggers a Cornerstone
// redraw.  cornerstone.pixelToCanvas() does the image→canvas transform, which
// accounts for Cornerstone's scale, pan, and flip state automatically.
//
// Coordinate convention from the backend (/rtstruct/slices/):
//   points[i] = [row, col]   (CT pixel space, 0-indexed, origin = top-left)
//   cornerstone.pixelToCanvas() expects { x: col, y: row }

const RTSTRUCT_PALETTE = [
  '#ff4444', '#44ff88', '#4499ff', '#ffff44', '#ff88ff',
  '#44ffff', '#ff8844', '#aa44ff', '#88ff44', '#ff4488',
];

// Module state
let _rtData    = null;        // full /rtstruct/slices/ response
let _roiColor  = {};          // roi number → CSS color string
let _roiHidden = new Set();   // roi numbers that are toggled off

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch /rtstruct/slices/, store the result, and assign palette colors.
 * Returns a Promise resolving to the raw response data.
 */
function loadRtstruct(path) {
  return fetch(`http://127.0.0.1:8000/rtstruct/slices/?path=${encodeURIComponent(path)}`)
    .then(r => {
      if (!r.ok) throw new Error(`/rtstruct/slices/ HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      _rtData    = data;
      _roiColor  = {};
      _roiHidden = new Set();

      // Walk every entry once in encounter order to assign stable palette colors.
      const order = [];
      Object.values(data.slices).forEach(entries =>
        entries.forEach(e => {
          if (!(e.number in _roiColor)) {
            _roiColor[e.number] = RTSTRUCT_PALETTE[order.length % RTSTRUCT_PALETTE.length];
            order.push(e.number);
          }
        })
      );

      return data;
    });
}

/** Discard stored contour data (call when a new CT series is loaded). */
function clearRtstruct() {
  _rtData    = null;
  _roiColor  = {};
  _roiHidden = new Set();
}

/**
 * Draw all visible contours for `sliceIndex` onto the Cornerstone canvas.
 * Must be called from inside a 'cornerstoneimagerendered' handler.
 */
function drawRtstructOverlay(element, sliceIndex) {
  if (!_rtData) return;

  const canvas = element.querySelector('canvas');
  if (!canvas) return;

  const key     = `slice_${sliceIndex}`;
  const entries = _rtData.slices[key];
  if (!entries || entries.length === 0) return;

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.lineJoin  = 'round';

  entries.forEach(entry => {
    if (_roiHidden.has(entry.number)) return;          // skip hidden ROIs
    if (!entry.points || entry.points.length < 2) return;

    ctx.strokeStyle = _roiColor[entry.number] || '#ffffff';
    ctx.beginPath();

    entry.points.forEach((pt, i) => {
      // pt = [row, col]; pixelToCanvas wants { x: col, y: row }
      const cp = cornerstone.pixelToCanvas(element, { x: pt[1], y: pt[0] });
      if (i === 0) ctx.moveTo(cp.x, cp.y);
      else         ctx.lineTo(cp.x, cp.y);
    });

    ctx.closePath();
    ctx.stroke();
  });

  ctx.restore();
}

/**
 * Render a checkbox-per-ROI control list into #rtLegend.
 * Each row: [checkbox] [color picker] [name]
 * Changes trigger cornerstone.updateImage() immediately.
 *
 * Relies on the global `element` (the Cornerstone div) defined in app.js.
 * Both scripts share the same global scope, and this function is only ever
 * called after app.js has executed, so `element` is guaranteed to exist.
 */
function updateRtLegend() {
  const el = document.getElementById('rtLegend');
  if (!el) return;

  const rois = _roiList();
  if (!rois.length) { el.style.display = 'none'; return; }

  el.style.display = 'flex';

  el.innerHTML = rois.map(({ number, name }) => {
    const color   = _roiColor[number] || '#ffffff';
    const checked = _roiHidden.has(number) ? '' : 'checked';
    return `<label>
      <input type="checkbox" data-roi="${number}" ${checked}>
      <input type="color"    data-roi="${number}" value="${color}">
      <span>${name}</span>
    </label>`;
  }).join('');

  // Checkbox: toggle visibility, redraw.
  el.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      const num = parseInt(cb.dataset.roi, 10);
      if (cb.checked) _roiHidden.delete(num);
      else            _roiHidden.add(num);
      cornerstone.updateImage(element);   // element is global from app.js
    });
  });

  // Color picker: update palette entry, redraw.
  el.querySelectorAll('input[type=color]').forEach(picker => {
    picker.addEventListener('input', () => {
      _roiColor[parseInt(picker.dataset.roi, 10)] = picker.value;
      cornerstone.updateImage(element);
    });
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Return [{number, name}] for all ROIs in encounter order. */
function _roiList() {
  if (!_rtData) return [];
  const seen = new Map();
  Object.values(_rtData.slices).forEach(entries =>
    entries.forEach(e => { if (!seen.has(e.number)) seen.set(e.number, e.name); })
  );
  return Array.from(seen.entries()).map(([number, name]) => ({ number, name }));
}
