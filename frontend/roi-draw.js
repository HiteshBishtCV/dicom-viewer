// roi-draw.js — interactive polygon ROI drawing on the Cornerstone 2D viewer.
//
// Points are stored in Cornerstone image pixel coordinates {x, y} using
// cornerstone.canvasToPixel().  On every redraw they are re-projected to
// canvas coordinates via cornerstone.pixelToCanvas(), so polygons stay
// aligned through zoom, pan, and W/L changes without any extra bookkeeping.
//
// Public API (call from app.js after cornerstone.enable()):
//   roiDraw.init(element)      — inject overlay canvas, wire events
//   roiDraw.setSlice(index)    — update current slice; discards in-progress polygon
//   roiDraw.toggleDrawMode()   — toggle draw mode; returns new boolean state
//   roiDraw.isDrawing()        — true while draw mode is active
//   roiDraw.redraw()           — re-project and repaint (call from cornerstoneimagerendered)
//   roiDraw.getRois()          — return all completed ROI objects
//   roiDraw.deleteRoi(id)      — remove one ROI by id

const roiDraw = (() => {

  const PALETTE = [
    '#ff4444', '#44ff88', '#4499ff', '#ffff44',
    '#ff88ff', '#44ffff', '#ff8844', '#aa44ff',
  ];

  let _el      = null;   // Cornerstone element (#dicomImage)
  let _canvas  = null;   // overlay <canvas>
  let _ctx     = null;
  let _drawing = false;  // draw mode on/off
  let _slice   = 0;      // current slice index
  let _rois    = [];     // { id, name, sliceIndex, points:[{x,y}], color }
  let _wip     = [];     // in-progress polygon — image pixel coords
  let _mouse   = null;   // last canvas mouse pos for rubber-band line

  // ── Initialisation ────────────────────────────────────────────────────────

  function init(el) {
    _el = el;

    // Inject overlay canvas as last child so it sits above Cornerstone's canvas.
    _canvas = document.createElement('canvas');
    _canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
    el.style.position = 'relative';
    el.appendChild(_canvas);
    _ctx = _canvas.getContext('2d');

    _syncSize();
    window.addEventListener('resize', _syncSize);

    _canvas.addEventListener('click',      _onClick);
    _canvas.addEventListener('dblclick',   _onDblClick);
    _canvas.addEventListener('mousemove',  _onMouseMove);
    _canvas.addEventListener('mouseleave', () => { _mouse = null; redraw(); });
  }

  function _syncSize() {
    if (!_el || !_canvas) return;
    _canvas.width  = _el.clientWidth;
    _canvas.height = _el.clientHeight;
    redraw();
  }

  // ── Draw mode toggle ──────────────────────────────────────────────────────

  function toggleDrawMode() {
    _drawing = !_drawing;
    if (!_drawing) _discardWip();
    // Only capture pointer events while actively drawing.
    _canvas.style.pointerEvents = _drawing ? 'auto' : 'none';
    _canvas.style.cursor        = _drawing ? 'crosshair' : '';
    _renderPanel();
    redraw();
    return _drawing;
  }

  function isDrawing() { return _drawing; }

  // ── Slice change ──────────────────────────────────────────────────────────

  function setSlice(index) {
    if (index !== _slice) _discardWip();
    _slice = index;
    redraw();
  }

  // ── Mouse handlers ────────────────────────────────────────────────────────

  function _onClick(e) {
    if (!_drawing) return;
    // dblclick fires two click events; the second arrives with detail=2 — skip it.
    if (e.detail >= 2) return;

    const pt = _toPx(e);
    if (!pt) return;

    // Close polygon when clicking within 10 px of the first vertex (≥3 pts).
    if (_wip.length >= 3) {
      const first = cornerstone.pixelToCanvas(_el, _wip[0]);
      const dx = e.offsetX - first.x, dy = e.offsetY - first.y;
      if (Math.sqrt(dx * dx + dy * dy) < 10) { _close(); return; }
    }

    _wip.push(pt);
    redraw();
  }

  function _onDblClick(e) {
    if (!_drawing || _wip.length < 3) return;
    _close();
  }

  function _onMouseMove(e) {
    if (!_drawing) return;
    _mouse = { x: e.offsetX, y: e.offsetY };
    redraw();
  }

  // Convert a mouse event's offset position to Cornerstone image pixel coords.
  function _toPx(e) {
    try { return cornerstone.canvasToPixel(_el, { x: e.offsetX, y: e.offsetY }); }
    catch (_) { return null; }
  }

  // ── Polygon management ────────────────────────────────────────────────────

  function _close() {
    const color = PALETTE[_rois.length % PALETTE.length];
    _rois.push({
      id:         Date.now(),
      name:       `ROI ${_rois.length + 1}`,
      sliceIndex: _slice,
      points:     [..._wip],
      color,
    });
    _wip   = [];
    _mouse = null;
    _renderPanel();
    redraw();
  }

  function _discardWip() { _wip = []; _mouse = null; redraw(); }

  function deleteRoi(id) {
    _rois = _rois.filter(r => r.id !== id);
    _renderPanel();
    redraw();
  }

  function getRois() { return _rois; }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function redraw() {
    if (!_ctx) return;
    _ctx.clearRect(0, 0, _canvas.width, _canvas.height);

    // Completed ROIs on this slice
    _rois.filter(r => r.sliceIndex === _slice).forEach(_drawClosed);

    // In-progress polygon
    if (_wip.length > 0) _drawWip();
  }

  function _drawClosed(roi) {
    const pts = roi.points.map(p => cornerstone.pixelToCanvas(_el, p));
    if (pts.length < 2) return;

    _ctx.save();
    _ctx.strokeStyle = roi.color;
    _ctx.fillStyle   = roi.color + '22';   // ~13 % opacity fill
    _ctx.lineWidth   = 1.5;
    _ctx.lineJoin    = 'round';

    _ctx.beginPath();
    _ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) _ctx.lineTo(pts[i].x, pts[i].y);
    _ctx.closePath();
    _ctx.fill();
    _ctx.stroke();

    // Vertex dots
    _ctx.fillStyle = roi.color;
    pts.forEach(p => {
      _ctx.beginPath();
      _ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      _ctx.fill();
    });

    _ctx.restore();
  }

  function _drawWip() {
    const pts = _wip.map(p => cornerstone.pixelToCanvas(_el, p));

    _ctx.save();
    _ctx.strokeStyle = '#ffffff';
    _ctx.lineWidth   = 1.5;
    _ctx.lineJoin    = 'round';
    _ctx.setLineDash([5, 3]);

    _ctx.beginPath();
    _ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) _ctx.lineTo(pts[i].x, pts[i].y);
    // Rubber-band line to current mouse position
    if (_mouse) _ctx.lineTo(_mouse.x, _mouse.y);
    _ctx.stroke();

    _ctx.setLineDash([]);

    // Vertex dots; first vertex turns yellow when polygon is closeable (≥3 pts).
    pts.forEach((p, i) => {
      _ctx.beginPath();
      _ctx.fillStyle = (i === 0 && pts.length >= 3) ? '#ffff00' : '#ffffff';
      _ctx.arc(p.x, p.y, i === 0 ? 5 : 3, 0, Math.PI * 2);
      _ctx.fill();
    });

    _ctx.restore();
  }

  // ── ROI list panel ────────────────────────────────────────────────────────

  function _renderPanel() {
    const panel = document.getElementById('roiList');
    if (!panel) return;

    if (!_rois.length) {
      panel.innerHTML = '<div style="color:#555;font-size:12px;padding:2px 0">No ROIs drawn</div>';
      return;
    }

    panel.innerHTML = _rois.map(r => `
      <div style="display:flex;align-items:center;gap:6px;padding:2px 0;">
        <span style="width:10px;height:10px;background:${r.color};border-radius:2px;
                     flex-shrink:0;display:inline-block;"></span>
        <span style="flex:1;font-size:12px;color:#ccc;">
          ${r.name}
          <span style="color:#555;font-size:11px;">(sl.${r.sliceIndex + 1})</span>
        </span>
        <button data-id="${r.id}"
          style="background:none;border:none;color:#f66;cursor:pointer;font-size:11px;padding:0 2px;"
          title="Delete">✕</button>
      </div>`).join('');

    // Wire delete buttons via delegation (avoids inline roiDraw.deleteRoi calls
    // being blocked by some CSP policies).
    panel.querySelectorAll('button[data-id]').forEach(btn => {
      btn.addEventListener('click', () => deleteRoi(Number(btn.dataset.id)));
    });
  }

  return { init, toggleDrawMode, isDrawing, setSlice, redraw, getRois, deleteRoi };

})();
