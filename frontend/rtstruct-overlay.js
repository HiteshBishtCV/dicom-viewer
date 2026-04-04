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

// Module state — intentionally module-level so app.js can call helpers freely.
let _rtData   = null;   // full /rtstruct/slices/ response
let _roiColor = {};     // roi number (int) → CSS color string

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch /rtstruct/slices/ for the given server-side file path, store the
 * result, and assign one palette color per ROI number.
 * Returns a Promise that resolves to the raw response data.
 */
function loadRtstruct(path) {
  return fetch(`http://127.0.0.1:8000/rtstruct/slices/?path=${encodeURIComponent(path)}`)
    .then(r => {
      if (!r.ok) throw new Error(`/rtstruct/slices/ HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      _rtData   = data;
      _roiColor = {};

      // Walk every entry once to discover all ROI numbers in encounter order,
      // then assign palette colors.  Using encounter order rather than sorting
      // keeps the assignment stable across slices.
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
  _rtData   = null;
  _roiColor = {};
}

/**
 * Draw all contours for `sliceIndex` onto the Cornerstone canvas inside
 * `element`.  Must be called from inside a 'cornerstoneimagerendered'
 * handler so the canvas has already been painted by Cornerstone.
 *
 * sliceIndex must use the same ordering as the backend's _load_ct_slices():
 * ascending by position along the image normal (matches InstanceNumber-
 * ascending order for standard axial CT acquisitions).
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
    if (!entry.points || entry.points.length < 2) return;

    ctx.strokeStyle = _roiColor[entry.number] || '#ffffff';
    ctx.beginPath();

    entry.points.forEach((pt, i) => {
      // pt = [row, col]; pixelToCanvas wants { x: col, y: row }
      const cp = cornerstone.pixelToCanvas(element, { x: pt[1], y: pt[0] });
      if (i === 0) ctx.moveTo(cp.x, cp.y);
      else         ctx.lineTo(cp.x, cp.y);
    });

    ctx.closePath();   // close polygon back to the first point
    ctx.stroke();
  });

  ctx.restore();
}

/**
 * Return an array of { name, color } objects for all ROIs in the loaded data.
 * Used to render the legend below the viewer.
 */
function getRoiLegend() {
  if (!_rtData) return [];

  // Collect unique ROI numbers in encounter order, pick their name from any
  // contour entry (name is the same for all entries sharing a number).
  const seen = new Map();
  Object.values(_rtData.slices).forEach(entries =>
    entries.forEach(e => { if (!seen.has(e.number)) seen.set(e.number, e.name); })
  );

  return Array.from(seen.entries()).map(([num, name]) => ({
    name,
    color: _roiColor[num] || '#ffffff',
  }));
}
