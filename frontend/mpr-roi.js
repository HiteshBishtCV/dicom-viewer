// mpr-roi.js — polygon ROI drawing overlay for the MPR view (CPU + GPU).
//
// Each MPR canvas (axial / coronal / sagittal) renders its image by writing
// directly to canvas pixels every frame, which clears any previous drawing.
// mprRoi.redrawAll() is therefore called at the end of every _doRender() cycle
// in mpr.js so that polygons are repainted on top after each frame.
//
// ── Coordinate system ────────────────────────────────────────────────────────
// Points are stored in image-space (ix, iy) where:
//   ix ∈ [0, srcW)   — column index in the rendered source image
//   iy ∈ [0, srcH)   — row    index in the rendered source image
//
// mprViewState[canvasId] (populated by renderToCanvas in mpr.js) contains:
//   { offX, offY, drawW, drawH, srcW, srcH }
//
// Canvas ← image conversion:
//   canvas_x = offX + (ix / srcW) * drawW
//   canvas_y = offY + (iy / srcH) * drawH
//
// Image ← canvas conversion (used on click):
//   ix = (cx - offX) * srcW / drawW
//   iy = (cy - offY) * srcH / drawH
//
// Each ROI also records the planeIndex at which it was drawn (z for axial,
// y for coronal, x for sagittal). A ROI is only visible when the viewer is
// showing that exact plane position.
//
// ── Scrolling behaviour ───────────────────────────────────────────────────────
// If the user scrolls away while a polygon is in progress, _redrawCanvas()
// detects the stale planeIndex and silently discards the WIP so stale geometry
// is never committed to the wrong slice.

const mprRoi = (() => {

  const PALETTE = [
    '#ff4444', '#44ff88', '#4499ff', '#ffff44',
    '#ff88ff', '#44ffff', '#ff8844', '#aa44ff',
  ];

  const CANVAS_IDS = ['axialCanvas', 'coronalCanvas', 'sagittalCanvas'];
  const PLANE_LABEL = { axialCanvas: 'Axial', coronalCanvas: 'Coronal', sagittalCanvas: 'Sagittal' };

  let _drawing = false;
  let _rois    = [];    // { id, name, canvasId, planeIndex, points:[{ix,iy}], color }
  let _wip     = null;  // { canvasId, planeIndex, points, mousePos:{x,y}|null }

  // ── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    CANVAS_IDS.forEach(id => {
      const canvas = document.getElementById(id);
      if (!canvas) return;

      // Capture phase so we can stopPropagation before attachClickNav's handler.
      canvas.addEventListener('click',     e => _onClick(e, id),    true);
      canvas.addEventListener('dblclick',  e => _onDblClick(e, id), true);
      canvas.addEventListener('mousemove', e => _onMouseMove(e, id));
      canvas.addEventListener('mouseleave', () => {
        if (_wip && _wip.canvasId === id) { _wip.mousePos = null; _redrawCanvas(id); }
      });
    });
  }

  // ── Draw mode ─────────────────────────────────────────────────────────────────

  function toggleDrawMode() {
    _drawing = !_drawing;
    if (!_drawing && _wip) { _wip = null; redrawAll(); }

    CANVAS_IDS.forEach(id => {
      const c = document.getElementById(id);
      if (c) c.style.cursor = _drawing ? 'crosshair' : '';
    });

    _updateBtn();
    _renderPanel();
    return _drawing;
  }

  function isDrawing() { return _drawing; }

  function _updateBtn() {
    const btn = document.getElementById('mprRoiDrawBtn');
    if (!btn) return;
    btn.textContent       = _drawing ? '◼ Stop Drawing' : '✏ Draw ROI';
    btn.style.color       = _drawing ? '#ffb74d' : '#ccc';
    btn.style.borderColor = _drawing ? '#ffb74d' : '#444';
  }

  // ── Plane helpers ─────────────────────────────────────────────────────────────

  // Read the current plane index from mpr.js globals (zIndex / yIndex / xIndex).
  function _planeIndex(canvasId) {
    if (canvasId === 'axialCanvas')    return typeof zIndex !== 'undefined' ? zIndex : 0;
    if (canvasId === 'coronalCanvas')  return typeof yIndex !== 'undefined' ? yIndex : 0;
    if (canvasId === 'sagittalCanvas') return typeof xIndex !== 'undefined' ? xIndex : 0;
    return 0;
  }

  // ── Canvas ↔ image coordinate helpers ────────────────────────────────────────

  function _toCanvas(pt, state) {
    return {
      x: state.offX + (pt.ix / state.srcW) * state.drawW,
      y: state.offY + (pt.iy / state.srcH) * state.drawH,
    };
  }

  // Returns { ix, iy, cx, cy } in image + canvas pixels, or null if out-of-bounds.
  function _fromEvent(e, canvasId) {
    const canvas = document.getElementById(canvasId);
    const state  = mprViewState && mprViewState[canvasId];
    if (!canvas || !state) return null;

    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const cy = (e.clientY - rect.top)  * (canvas.height / rect.height);

    const ix = (cx - state.offX) * state.srcW / state.drawW;
    const iy = (cy - state.offY) * state.srcH / state.drawH;

    if (ix < 0 || iy < 0 || ix >= state.srcW || iy >= state.srcH) return null;
    return { ix, iy, cx, cy };
  }

  // ── Event handlers ────────────────────────────────────────────────────────────

  function _onClick(e, canvasId) {
    if (!_drawing) return;
    if (e.detail >= 2) { e.stopPropagation(); return; }  // part of a dblclick
    e.stopPropagation();  // block attachClickNav (crosshair navigation)

    const coords = _fromEvent(e, canvasId);
    if (!coords) return;

    const plane = _planeIndex(canvasId);

    // Start fresh WIP if switching canvas or plane.
    if (!_wip || _wip.canvasId !== canvasId || _wip.planeIndex !== plane) {
      _wip = { canvasId, planeIndex: plane, points: [], mousePos: null };
    }

    // Close polygon if clicking within 10 px of the first vertex (≥3 pts).
    if (_wip.points.length >= 3) {
      const state = mprViewState[canvasId];
      const fp    = _toCanvas(_wip.points[0], state);
      if (Math.hypot(coords.cx - fp.x, coords.cy - fp.y) < 10) {
        _close(canvasId); return;
      }
    }

    _wip.points.push({ ix: coords.ix, iy: coords.iy });
    _redrawCanvas(canvasId);
  }

  function _onDblClick(e, canvasId) {
    if (!_drawing) return;
    e.stopPropagation();
    if (_wip && _wip.canvasId === canvasId && _wip.points.length >= 3) _close(canvasId);
  }

  function _onMouseMove(e, canvasId) {
    if (!_drawing || !_wip || _wip.canvasId !== canvasId) return;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    _wip.mousePos = {
      x: (e.clientX - rect.left) * (canvas.width  / rect.width),
      y: (e.clientY - rect.top)  * (canvas.height / rect.height),
    };
    _redrawCanvas(canvasId);
  }

  // ── Polygon management ────────────────────────────────────────────────────────

  function _close(canvasId) {
    if (!_wip || _wip.points.length < 3) return;
    _rois.push({
      id:         Date.now(),
      name:       `ROI ${_rois.length + 1}`,
      canvasId,
      planeIndex: _wip.planeIndex,
      points:     [..._wip.points],
      color:      PALETTE[_rois.length % PALETTE.length],
    });
    _wip = null;
    _redrawCanvas(canvasId);
    _renderPanel();
  }

  function deleteRoi(id) {
    _rois = _rois.filter(r => r.id !== id);
    _renderPanel();
    redrawAll();
  }

  function renameRoi(id, name) {
    const roi = _rois.find(r => r.id === id);
    if (roi) roi.name = name.trim() || roi.name;
  }

  function getRois() { return _rois; }

  // ── Rendering ─────────────────────────────────────────────────────────────────

  // Called at the end of every _doRender() in mpr.js so ROIs are painted
  // on top of the freshly drawn image pixels on all three canvases.
  function redrawAll() {
    CANVAS_IDS.forEach(_redrawCanvas);
  }

  function _redrawCanvas(canvasId) {
    const canvas = document.getElementById(canvasId);
    const state  = mprViewState && mprViewState[canvasId];
    if (!canvas || !state) return;

    const ctx   = canvas.getContext('2d');
    const plane = _planeIndex(canvasId);

    // If WIP belongs to a stale plane (user scrolled away), silently discard it.
    if (_wip && _wip.canvasId === canvasId && _wip.planeIndex !== plane) {
      _wip = null;
    }

    // Closed ROIs for this canvas + current plane position.
    _rois.filter(r => r.canvasId === canvasId && r.planeIndex === plane)
         .forEach(r => _drawClosed(ctx, r, state));

    // In-progress polygon.
    if (_wip && _wip.canvasId === canvasId) _drawWip(ctx, _wip, state);
  }

  function _drawClosed(ctx, roi, state) {
    const pts = roi.points.map(p => _toCanvas(p, state));
    if (pts.length < 2) return;

    ctx.save();
    ctx.strokeStyle = roi.color;
    ctx.fillStyle   = roi.color + '22';
    ctx.lineWidth   = 1.5;
    ctx.lineJoin    = 'round';

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = roi.color;
    pts.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.restore();
  }

  function _drawWip(ctx, wip, state) {
    const pts = wip.points.map(p => _toCanvas(p, state));
    if (!pts.length) return;

    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 1.5;
    ctx.lineJoin    = 'round';
    ctx.setLineDash([5, 3]);

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (wip.mousePos) ctx.lineTo(wip.mousePos.x, wip.mousePos.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Vertex dots; first vertex turns yellow when polygon is closeable (≥3 pts).
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.fillStyle = (i === 0 && pts.length >= 3) ? '#ffff00' : '#ffffff';
      ctx.arc(p.x, p.y, i === 0 ? 5 : 3, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.restore();
  }

  // ── ROI list panel ────────────────────────────────────────────────────────────

  function _renderPanel() {
    const panel = document.getElementById('mprRoiList');
    if (!panel) return;

    if (!_rois.length) {
      panel.innerHTML = '<div style="color:#555;font-size:12px;">No ROIs drawn</div>';
      return;
    }

    panel.innerHTML = _rois.map(r => `
      <div style="display:flex;align-items:center;gap:6px;padding:2px 0;">
        <span style="width:10px;height:10px;background:${r.color};border-radius:2px;
                     flex-shrink:0;display:inline-block;"></span>
        <input class="mpr-roi-name" type="text" data-id="${r.id}" value="${r.name}"
               style="flex:1;background:#1a1a1a;border:1px solid #444;border-radius:3px;
                      color:#ccc;font-size:12px;padding:2px 5px;min-width:0;"
               title="Click to rename">
        <span style="color:#555;font-size:11px;white-space:nowrap;">
          ${PLANE_LABEL[r.canvasId]} ${r.planeIndex + 1}
        </span>
        <button data-id="${r.id}"
          style="background:none;border:none;color:#f66;cursor:pointer;
                 font-size:11px;padding:0 2px;flex-shrink:0;"
          title="Delete">✕</button>
      </div>`).join('');

    panel.querySelectorAll('.mpr-roi-name').forEach(input => {
      const commit = () => renameRoi(Number(input.dataset.id), input.value);
      input.addEventListener('blur',    commit);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    });

    panel.querySelectorAll('button[data-id]').forEach(btn => {
      btn.addEventListener('click', () => deleteRoi(Number(btn.dataset.id)));
    });
  }

  return { init, toggleDrawMode, isDrawing, redrawAll, getRois, deleteRoi, renameRoi };

})();
