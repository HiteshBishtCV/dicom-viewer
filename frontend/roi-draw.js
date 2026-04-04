// roi-draw.js — interactive polygon ROI drawing + editing on the Cornerstone 2D viewer.
//
// Points are stored in Cornerstone image pixel coordinates {x, y} using
// cornerstone.canvasToPixel().  On every redraw they are re-projected to
// canvas coordinates via cornerstone.pixelToCanvas(), so polygons stay
// aligned through zoom, pan, and W/L changes without any extra bookkeeping.
//
// ── Modes ─────────────────────────────────────────────────────────────────────
//   Draw mode  — click to add vertices; close polygon → name prompt → commit
//   Edit mode  — click body to select; drag vertex handle to move; Delete to remove
//   (The two modes are mutually exclusive.)
//
// ── Public API ────────────────────────────────────────────────────────────────
//   roiDraw.init(element)         — inject overlay canvas, wire events
//   roiDraw.setSlice(index)       — update current slice
//   roiDraw.toggleDrawMode()      — toggle draw mode; returns new bool
//   roiDraw.isDrawing()           — true while draw mode is active
//   roiDraw.toggleEditMode()      — toggle edit mode; returns new bool
//   roiDraw.isEditing()           — true while edit mode is active
//   roiDraw.redraw()              — re-project and repaint
//   roiDraw.getRois()             — return internal ROI array
//   roiDraw.deleteRoi(id)         — remove one ROI by id
//   roiDraw.renameRoi(id, name)   — rename an ROI
//   roiDraw.importRois(array)     — bulk-import from backend JSON format

const roiDraw = (() => {

  const PALETTE = [
    '#ff4444', '#44ff88', '#4499ff', '#ffff44',
    '#ff88ff', '#44ffff', '#ff8844', '#aa44ff',
  ];

  let _el         = null;   // Cornerstone element (#dicomImage)
  let _canvas     = null;   // overlay <canvas>
  let _ctx        = null;
  let _drawing    = false;  // draw mode on/off
  let _editing    = false;  // edit mode on/off
  let _slice      = 0;      // current slice index
  let _rois       = [];     // { id, name, sliceIndex, points:[{x,y}], color }
  let _wip        = [];     // in-progress polygon — image pixel coords {x,y}
  let _mouse      = null;   // last canvas mouse pos for rubber-band line
  let _selectedId = null;   // id of the currently selected ROI (edit mode)
  let _dragState  = null;   // { roiId, vertexIdx } — active vertex drag

  // ── Initialisation ─────────────────────────────────────────────────────────

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
    _canvas.addEventListener('mousedown',  _onMouseDown);
    _canvas.addEventListener('mouseup',    _onMouseUp);
    _canvas.addEventListener('mouseleave', _onMouseLeave);

    // Delete / Backspace removes the selected ROI while in edit mode.
    document.addEventListener('keydown', e => {
      if (!_editing || !_selectedId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteRoi(_selectedId);
        _selectedId = null;
      }
    });
  }

  function _syncSize() {
    if (!_el || !_canvas) return;
    _canvas.width  = _el.clientWidth;
    _canvas.height = _el.clientHeight;
    redraw();
  }

  // ── Mode toggles ───────────────────────────────────────────────────────────

  function toggleDrawMode() {
    if (_editing) _exitEdit();          // mutually exclusive
    _drawing = !_drawing;
    if (!_drawing) _discardWip();
    _syncPointerEvents();
    _renderPanel();
    redraw();
    return _drawing;
  }

  function toggleEditMode() {
    if (_drawing) {                     // mutually exclusive
      _drawing = false;
      _discardWip();
    }
    _editing = !_editing;
    if (!_editing) _exitEdit();
    _syncPointerEvents();
    redraw();
    return _editing;
  }

  function _exitEdit() {
    _selectedId = null;
    _dragState  = null;
    _editing    = false;
  }

  // Enable pointer events on the overlay canvas whenever either mode is active.
  function _syncPointerEvents() {
    const active = _drawing || _editing;
    _canvas.style.pointerEvents = active ? 'auto' : 'none';
    _canvas.style.cursor = _drawing ? 'crosshair'
                         : _editing ? 'default'
                         : '';
  }

  function isDrawing() { return _drawing; }
  function isEditing() { return _editing; }

  // ── Slice change ───────────────────────────────────────────────────────────

  function setSlice(index) {
    if (index !== _slice) {
      _discardWip();
      _selectedId = null;   // clear selection when changing slice
      _dragState  = null;
    }
    _slice = index;
    redraw();
  }

  // ── Mouse handlers — draw mode ─────────────────────────────────────────────

  function _onClick(e) {
    if (!_drawing) return;
    if (e.detail >= 2) return;   // second click of a dblclick — skip

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

  // ── Mouse handlers — shared / edit mode ───────────────────────────────────

  function _onMouseMove(e) {
    if (_drawing) {
      _mouse = { x: e.offsetX, y: e.offsetY };
      redraw();
      return;
    }
    if (_editing && _dragState) {
      const roi = _rois.find(r => r.id === _dragState.roiId);
      if (!roi) return;
      const pt = _toPx(e);
      if (pt) {
        roi.points[_dragState.vertexIdx] = pt;
        redraw();
      }
    }
  }

  function _onMouseDown(e) {
    if (!_editing) return;
    const cx = e.offsetX, cy = e.offsetY;

    // Vertex drag takes priority over body selection.
    const vhit = _findVertex(cx, cy);
    if (vhit) {
      _selectedId            = vhit.roiId;
      _dragState             = vhit;
      _canvas.style.cursor   = 'grabbing';
      redraw();
      return;
    }

    // Body click — select ROI, or deselect if clicking empty space.
    _selectedId = _findRoi(cx, cy);
    _dragState  = null;
    redraw();
  }

  function _onMouseUp() {
    if (!_editing || !_dragState) return;
    // Persist the moved vertex back to roiStore.
    const roi = _rois.find(r => r.id === _dragState.roiId);
    if (roi) {
      roiStore.update(roi.id, {
        points: roi.points.map(p => [Math.round(p.x), Math.round(p.y)]),
      });
    }
    _dragState           = null;
    _canvas.style.cursor = 'default';
  }

  function _onMouseLeave() {
    if (_drawing) { _mouse = null; redraw(); }
    // Commit any in-flight drag when the cursor leaves the canvas.
    if (_editing && _dragState) _onMouseUp();
  }

  // Convert mouse-event offset position to Cornerstone image pixel coords.
  function _toPx(e) {
    try { return cornerstone.canvasToPixel(_el, { x: e.offsetX, y: e.offsetY }); }
    catch (_) { return null; }
  }

  // ── Edit-mode hit testing ──────────────────────────────────────────────────

  // Returns { roiId, vertexIdx } if a vertex on the current slice is within
  // 8 canvas pixels of (cx, cy). Checks in reverse draw order (topmost first).
  function _findVertex(cx, cy) {
    const onSlice = _rois.filter(r => r.sliceIndex === _slice);
    for (let ri = onSlice.length - 1; ri >= 0; ri--) {
      const roi = onSlice[ri];
      const pts = roi.points.map(p => cornerstone.pixelToCanvas(_el, p));
      for (let i = 0; i < pts.length; i++) {
        const dx = cx - pts[i].x, dy = cy - pts[i].y;
        if (Math.sqrt(dx * dx + dy * dy) < 8) return { roiId: roi.id, vertexIdx: i };
      }
    }
    return null;
  }

  // Returns the id of the topmost ROI containing (cx, cy), or null.
  function _findRoi(cx, cy) {
    const onSlice = _rois.filter(r => r.sliceIndex === _slice).slice().reverse();
    for (const roi of onSlice) {
      const pts = roi.points.map(p => cornerstone.pixelToCanvas(_el, p));
      if (_pointInPolygon(cx, cy, pts)) return roi.id;
    }
    return null;
  }

  // Ray-casting algorithm — O(n) point-in-polygon test.
  function _pointInPolygon(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  // ── Polygon management ─────────────────────────────────────────────────────

  function _close() {
    const id      = Date.now();
    const defName = `ROI_${_rois.length + 1}`;
    const color   = PALETTE[_rois.length % PALETTE.length];
    const input   = window.prompt('Name this ROI:', defName);
    const name    = (input !== null && input.trim()) ? input.trim() : defName;

    // Internal entry: points stay as {x,y} objects for pixelToCanvas().
    _rois.push({ id, name, sliceIndex: _slice, points: [..._wip], color });

    // Mirror to the global store in canonical [[x,y]] format.
    roiStore.add({
      id,
      name,
      slice:  _slice,
      points: _wip.map(p => [Math.round(p.x), Math.round(p.y)]),
      color,
      source: 'draw2d',
    });

    _wip   = [];
    _mouse = null;
    _renderPanel();
    redraw();
  }

  function _discardWip() { _wip = []; _mouse = null; }

  function deleteRoi(id) {
    _rois = _rois.filter(r => r.id !== id);
    if (_selectedId === id) _selectedId = null;
    roiStore.remove(id);
    _renderPanel();
    redraw();
  }

  function getRois() { return _rois; }

  // ── Import from backend ────────────────────────────────────────────────────

  /**
   * Bulk-import ROIs from the backend JSON format into the 2D viewer.
   *
   * Expected shape per entry: { id, name, slice, points:[[x,y]], color, source? }
   * Entries whose id already exists in _rois are skipped (safe to call repeatedly).
   * Points must be in image-pixel coordinates — the same coordinate space the
   * draw tool uses — so they align correctly without any extra transform.
   */
  function importRois(roisArray) {
    if (!Array.isArray(roisArray) || !roisArray.length) return;

    const existingIds = new Set(_rois.map(r => r.id));

    for (const r of roisArray) {
      const id = r.id ?? (Date.now() + Math.random());
      if (existingIds.has(id)) continue;

      const roi = {
        id,
        name:       r.name  ?? 'Imported ROI',
        sliceIndex: r.slice ?? 0,
        // Convert [[x,y]] → [{x,y}] for Cornerstone's pixelToCanvas().
        points:     (r.points ?? []).map(p => ({ x: p[0], y: p[1] })),
        color:      r.color ?? PALETTE[_rois.length % PALETTE.length],
      };
      _rois.push(roi);
      existingIds.add(id);

      // Sync to global store (canonical [[x,y]] format, already in r.points).
      roiStore.add({
        id:     roi.id,
        name:   roi.name,
        slice:  roi.sliceIndex,
        points: r.points ?? [],
        color:  roi.color,
        source: r.source ?? 'loaded',
      });
    }

    _renderPanel();
    redraw();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function redraw() {
    if (!_ctx) return;
    _ctx.clearRect(0, 0, _canvas.width, _canvas.height);

    // Completed ROIs on this slice — pass selection state for visual feedback.
    _rois.filter(r => r.sliceIndex === _slice)
         .forEach(r => _drawClosed(r, r.id === _selectedId));

    // In-progress polygon (draw mode only).
    if (_wip.length > 0) _drawWip();
  }

  function _drawClosed(roi, selected) {
    const pts = roi.points.map(p => cornerstone.pixelToCanvas(_el, p));
    if (pts.length < 2) return;

    _ctx.save();
    _ctx.strokeStyle = roi.color;
    _ctx.fillStyle   = roi.color + '22';   // ~13 % opacity fill
    _ctx.lineWidth   = selected ? 2.5 : 1.5;
    _ctx.lineJoin    = 'round';

    _ctx.beginPath();
    _ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) _ctx.lineTo(pts[i].x, pts[i].y);
    _ctx.closePath();
    _ctx.fill();
    _ctx.stroke();

    // White dashed ring on the selected ROI.
    if (selected) {
      _ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      _ctx.lineWidth   = 1;
      _ctx.setLineDash([4, 3]);
      _ctx.beginPath();
      _ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) _ctx.lineTo(pts[i].x, pts[i].y);
      _ctx.closePath();
      _ctx.stroke();
      _ctx.setLineDash([]);
    }

    // Vertex handles — larger + outlined when selected to show they are draggable.
    pts.forEach(p => {
      _ctx.beginPath();
      if (selected) {
        _ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        _ctx.fillStyle   = '#ffffff';
        _ctx.fill();
        _ctx.strokeStyle = roi.color;
        _ctx.lineWidth   = 2;
        _ctx.stroke();
      } else {
        _ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        _ctx.fillStyle = roi.color;
        _ctx.fill();
      }
    });

    // Name label at centroid.
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    _ctx.font         = 'bold 12px sans-serif';
    _ctx.textAlign    = 'center';
    _ctx.textBaseline = 'middle';
    _ctx.fillStyle    = 'rgba(0,0,0,0.6)';
    _ctx.fillText(roi.name, cx + 1, cy + 1);
    _ctx.fillStyle    = selected ? '#ffffff' : roi.color;
    _ctx.fillText(roi.name, cx, cy);

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
    if (_mouse) _ctx.lineTo(_mouse.x, _mouse.y);
    _ctx.stroke();

    _ctx.setLineDash([]);

    // First vertex turns yellow when polygon is closeable (≥3 pts).
    pts.forEach((p, i) => {
      _ctx.beginPath();
      _ctx.fillStyle = (i === 0 && pts.length >= 3) ? '#ffff00' : '#ffffff';
      _ctx.arc(p.x, p.y, i === 0 ? 5 : 3, 0, Math.PI * 2);
      _ctx.fill();
    });

    _ctx.restore();
  }

  // ── ROI list panel ─────────────────────────────────────────────────────────

  function _renderPanel() {
    const panel = document.getElementById('drawnRoiList');
    if (!panel) return;

    if (!_rois.length) {
      panel.innerHTML = '<div class="sp-empty">No ROIs drawn</div>';
      return;
    }

    panel.innerHTML = _rois.map(r => `
      <div class="sp-row" style="align-items:center;">
        <span style="width:10px;height:10px;background:${r.color};border-radius:2px;
                     flex-shrink:0;display:inline-block;"></span>
        <input class="sp-name-input" type="text" data-id="${r.id}" value="${r.name}"
               title="Click to rename">
        <span class="sp-empty" style="font-size:11px;white-space:nowrap;">sl.${r.sliceIndex + 1}</span>
        <button data-id="${r.id}"
          style="background:none;border:none;color:#f66;cursor:pointer;font-size:11px;padding:0 2px;flex-shrink:0;"
          title="Delete">✕</button>
      </div>`).join('');

    panel.querySelectorAll('.sp-name-input').forEach(input => {
      const commit = () => renameRoi(Number(input.dataset.id), input.value);
      input.addEventListener('blur',  commit);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    });

    panel.querySelectorAll('button[data-id]').forEach(btn => {
      btn.addEventListener('click', () => deleteRoi(Number(btn.dataset.id)));
    });
  }

  function renameRoi(id, name) {
    const trimmed = name.trim();
    const roi     = _rois.find(r => r.id === id);
    if (roi && trimmed) roi.name = trimmed;
    roiStore.update(id, { name: trimmed || (roi && roi.name) });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  return {
    init,
    toggleDrawMode, isDrawing,
    toggleEditMode, isEditing,
    setSlice, redraw,
    getRois, deleteRoi, renameRoi,
    importRois,
  };

})();
