// mpr-roi.js — polygon ROI drawing + editing overlay for the MPR view.
//
// Each MPR canvas renders its image by writing directly to canvas pixels every
// frame, which clears any previous drawing.  mprRoi.redrawAll() is therefore
// called at the end of every _doRender() cycle in mpr.js so polygons are
// repainted on top of the freshly drawn image.
//
// ── Modes ─────────────────────────────────────────────────────────────────────
//   Draw mode  — click to add vertices; close polygon → name prompt
//   Edit mode  — click body to select; drag vertex; Delete to remove
//   (Mutually exclusive)
//
// ── Coordinate system ─────────────────────────────────────────────────────────
// Points are stored in image-space {ix, iy} where:
//   ix ∈ [0, srcW)   column in the rendered source image
//   iy ∈ [0, srcH)   row    in the rendered source image
//
// mprViewState[canvasId] = { offX, offY, drawW, drawH, srcW, srcH }
//
//   canvas → image:  ix = (cx - offX) * srcW / drawW
//                    iy = (cy - offY) * srcH / drawH
//   image → canvas:  cx = offX + (ix / srcW) * drawW
//                    cy = offY + (iy / srcH) * drawH
//
// Each ROI also records the planeIndex at which it was drawn (zIndex for axial,
// yIndex for coronal, xIndex for sagittal). A ROI is only visible when the
// viewer is showing that exact plane position.
//
// ── Save / export coordinate mapping ─────────────────────────────────────────
// For roiStore and backend export each plane maps differently to CT voxels:
//   Axial:    col = ix,           row = iy,             z = planeIndex
//   Coronal:  col = (ncols-1-ix), row = planeIndex,     z = iy   (horizontal flip)
//   Sagittal: col = planeIndex,   row = (nrows-1-ix),   z = iy   (horizontal flip)
// The backend _roi_contour_data() performs these transforms on export.
//
// ── Public API ────────────────────────────────────────────────────────────────
//   mprRoi.init()              — wire canvas events (call after canvases exist)
//   mprRoi.toggleDrawMode()    — toggle draw mode; returns new bool
//   mprRoi.isDrawing()         — bool
//   mprRoi.toggleEditMode()    — toggle edit mode; returns new bool
//   mprRoi.isEditing()         — bool
//   mprRoi.redrawAll()         — repaint all canvases (called by mpr.js)
//   mprRoi.getRois()           — internal ROI array
//   mprRoi.deleteRoi(id)       — remove ROI by id
//   mprRoi.renameRoi(id, name) — rename ROI
//   mprRoi.importRois(array)   — bulk-import from backend JSON format

const mprRoi = (() => {

  const INTERP_N = 64;    // arc-length resampling resolution for interpolation

  const PALETTE = [
    '#ff4444', '#44ff88', '#4499ff', '#ffff44',
    '#ff88ff', '#44ffff', '#ff8844', '#aa44ff',
  ];

  const CANVAS_IDS  = ['axialCanvas', 'coronalCanvas', 'sagittalCanvas'];
  const PLANE_LABEL = { axialCanvas: 'Axial', coronalCanvas: 'Coronal', sagittalCanvas: 'Sagittal' };
  const PLANE_NAME  = { axialCanvas: 'axial', coronalCanvas: 'coronal', sagittalCanvas: 'sagittal' };

  let _drawing    = false;
  let _editing    = false;
  let _freehand   = false;
  let _boxMode    = false;
  let _rois       = [];     // { id, name, canvasId, planeIndex, points:[{ix,iy}], color }
  let _wip        = null;   // { canvasId, planeIndex, points, mousePos }
  let _fhWip      = null;   // freehand stroke: { canvasId, planeIndex, points, lastCx, lastCy }
  let _fhDist     = 6;      // minimum canvas-pixel gap between freehand vertices (scroll adjusts)
  let _selectedId = null;   // id of currently selected ROI (edit mode)
  let _dragState  = null;   // { canvasId, roiId, vertexIdx }
  let _segBoxes   = {};     // { canvasId: {ix1, iy1, ix2, iy2} } — committed seg boxes
  let _boxWip     = null;   // { canvasId, ix1, iy1, ix2, iy2 } — in-progress box
  let _mouseIm    = {};     // { canvasId: {ix, iy} } — last image-space mouse position

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    CANVAS_IDS.forEach(id => {
      const canvas = document.getElementById(id);
      if (!canvas) return;

      // Capture phase so stopPropagation blocks attachClickNav's handler.
      canvas.addEventListener('click',     e => _onClick(e, id),         true);
      canvas.addEventListener('dblclick',  e => _onDblClick(e, id),      true);
      canvas.addEventListener('mousemove', e => _onMouseMove(e, id));
      canvas.addEventListener('mousedown', e => _onMouseDown(e, id),     true);
      canvas.addEventListener('mouseup',   e => _onMouseUp(e, id),       true);
      canvas.addEventListener('mouseleave', () => _onMouseLeave(id));
      // Scroll wheel in freehand mode changes brush spacing (vertex density).
      // passive:false lets us call preventDefault() to block MPR scrolling.
      canvas.addEventListener('wheel', e => {
        if (!_freehand) return;
        e.preventDefault();
        e.stopPropagation();
        _fhDist = Math.max(2, Math.min(40, _fhDist + (e.deltaY > 0 ? 2 : -2)));
        _requestRedraw();
      }, { passive: false });
    });

    // Delete / Backspace removes the selected ROI in edit mode.
    document.addEventListener('keydown', e => {
      if (!_editing || !_selectedId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Don't intercept if a text input has focus (e.g. rename field).
        if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
        e.preventDefault();
        deleteRoi(_selectedId);
        _selectedId = null;
      }
    });
  }

  // ── Mode toggles ───────────────────────────────────────────────────────────

  function toggleDrawMode() {
    if (_editing)  _exitEdit();
    if (_freehand) _exitFreehand();
    if (_boxMode)  _exitBoxMode();
    _drawing = !_drawing;
    if (!_drawing && _wip) { _wip = null; redrawAll(); }
    _syncCursors();
    _updateDrawBtn();
    _updateFreehandBtn();
    _renderPanel();
    return _drawing;
  }

  function toggleEditMode() {
    if (_drawing)  { _drawing = false; _wip = null; _updateDrawBtn(); }
    if (_freehand) _exitFreehand();
    if (_boxMode)  _exitBoxMode();
    _editing = !_editing;
    if (!_editing) _exitEdit();
    _syncCursors();
    _updateEditBtn();
    _updateFreehandBtn();
    redrawAll();
    return _editing;
  }

  function toggleFreehandMode() {
    if (_drawing)  { _drawing = false; _wip = null; _updateDrawBtn(); }
    if (_editing)  _exitEdit();
    if (_boxMode)  _exitBoxMode();
    _freehand = !_freehand;
    if (!_freehand) _exitFreehand();
    _syncCursors();
    _updateEditBtn();
    _updateFreehandBtn();
    redrawAll();
    return _freehand;
  }

  function _exitEdit() {
    _selectedId = null;
    _dragState  = null;
    _editing    = false;
  }

  function _exitFreehand() {
    _fhWip    = null;
    _freehand = false;
  }

  function _exitBoxMode() {
    _boxWip  = null;
    _boxMode = false;
    _updateBoxBtn();
  }

  function toggleBoxMode() {
    if (_drawing)  { _drawing = false; _wip = null; _updateDrawBtn(); }
    if (_editing)  _exitEdit();
    if (_freehand) _exitFreehand();
    _boxMode = !_boxMode;
    if (!_boxMode) _boxWip = null;
    _syncCursors();
    _updateBoxBtn();
    redrawAll();
    return _boxMode;
  }

  function clearSegBoxes() {
    _segBoxes = {};
    _boxWip   = null;
    redrawAll();
  }

  /**
   * Return a flat bbox dict for the backend.
   * E.g. { axial_ix1:10, axial_iy1:20, axial_ix2:200, axial_iy2:300, ... }
   */
  function getSegBoxes() {
    const result = {};
    for (const [cid, box] of Object.entries(_segBoxes)) {
      // 'axialCanvas' → 'axial', 'coronalCanvas' → 'coronal', etc.
      const prefix = cid.replace('Canvas', '').toLowerCase();
      result[`${prefix}_ix1`] = Math.round(Math.min(box.ix1, box.ix2));
      result[`${prefix}_iy1`] = Math.round(Math.min(box.iy1, box.iy2));
      result[`${prefix}_ix2`] = Math.round(Math.max(box.ix1, box.ix2));
      result[`${prefix}_iy2`] = Math.round(Math.max(box.iy1, box.iy2));
    }
    return result;
  }

  function _syncCursors() {
    CANVAS_IDS.forEach(id => {
      const c = document.getElementById(id);
      if (!c) return;
      c.style.cursor = _drawing ? 'crosshair'
                     : _editing  ? 'default'
                     : _freehand ? 'crosshair'
                     : _boxMode  ? 'crosshair'
                     : '';
    });
  }

  function isDrawing()   { return _drawing; }
  function isEditing()   { return _editing; }
  function isFreehand()  { return _freehand; }
  function isBoxMode()   { return _boxMode; }

  // ── Button label helpers ───────────────────────────────────────────────────

  function _updateDrawBtn() {
    const btn = document.getElementById('mprRoiDrawBtn');
    if (!btn) return;
    btn.textContent       = _drawing ? '◼ Stop Drawing' : '✏ Draw ROI';
    btn.style.color       = _drawing ? '#ffb74d' : '#ccc';
    btn.style.borderColor = _drawing ? '#ffb74d' : '#444';
  }

  function _updateEditBtn() {
    const btn = document.getElementById('mprRoiEditBtn');
    if (!btn) return;
    btn.textContent       = _editing ? '◼ Stop Editing' : '✎ Edit ROI';
    btn.style.color       = _editing ? '#80cbc4' : '#ccc';
    btn.style.borderColor = _editing ? '#4db6ac' : '#444';
  }

  function _updateFreehandBtn() {
    const btn = document.getElementById('mprRoiFreehandBtn');
    if (!btn) return;
    btn.textContent       = _freehand ? '◼ Stop Brush' : '✏ Brush';
    btn.style.color       = _freehand ? '#ffaa00' : '#ccc';
    btn.style.borderColor = _freehand ? '#ff9900' : '#444';
  }

  function _updateBoxBtn() {
    const btn = document.getElementById('mprSegBoxBtn');
    if (!btn) return;
    btn.textContent       = _boxMode ? '◼ Stop Box' : '🔲 Seg Box';
    btn.style.color       = _boxMode ? '#ffcc44' : '#ccc';
    btn.style.borderColor = _boxMode ? '#ffcc44' : '#444';
  }

  // ── Plane helpers ──────────────────────────────────────────────────────────

  function _planeIndex(canvasId) {
    if (canvasId === 'axialCanvas')    return typeof zIndex !== 'undefined' ? zIndex : 0;
    if (canvasId === 'coronalCanvas')  return typeof yIndex !== 'undefined' ? yIndex : 0;
    if (canvasId === 'sagittalCanvas') return typeof xIndex !== 'undefined' ? xIndex : 0;
    return 0;
  }

  // ── Canvas ↔ image coord helpers ───────────────────────────────────────────

  function _toCanvas(pt, state) {
    return {
      x: state.offX + (pt.ix / state.srcW) * state.drawW,
      y: state.offY + (pt.iy / state.srcH) * state.drawH,
    };
  }

  // Returns { ix, iy, cx, cy } or null if out-of-bounds.
  function _fromEvent(e, canvasId) {
    const canvas = document.getElementById(canvasId);
    const state  = mprViewState && mprViewState[canvasId];
    if (!canvas || !state) return null;

    const rect = canvas.getBoundingClientRect();
    const cx   = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const cy   = (e.clientY - rect.top)  * (canvas.height / rect.height);
    const ix   = (cx - state.offX) * state.srcW / state.drawW;
    const iy   = (cy - state.offY) * state.srcH / state.drawH;

    if (ix < 0 || iy < 0 || ix >= state.srcW || iy >= state.srcH) return null;
    return { ix, iy, cx, cy };
  }

  // ── Draw mode event handlers ───────────────────────────────────────────────

  function _onClick(e, canvasId) {
    if (_freehand) { e.stopPropagation(); return; }  // freehand uses mousedown/up
    if (!_drawing) return;
    if (e.detail >= 2) { e.stopPropagation(); return; }
    e.stopPropagation();

    const coords = _fromEvent(e, canvasId);
    if (!coords) return;

    const plane = _planeIndex(canvasId);

    if (!_wip || _wip.canvasId !== canvasId || _wip.planeIndex !== plane) {
      _wip = { canvasId, planeIndex: plane, points: [], mousePos: null };
    }

    if (_wip.points.length >= 3) {
      const state = mprViewState[canvasId];
      const fp    = _toCanvas(_wip.points[0], state);
      if (Math.hypot(coords.cx - fp.x, coords.cy - fp.y) < 10) {
        _close(canvasId);
        return;
      }
    }

    _wip.points.push({ ix: coords.ix, iy: coords.iy });
    // Full re-render so vertex addition is drawn on a clean frame.
    _requestRedraw();
  }

  function _onDblClick(e, canvasId) {
    if (!_drawing) return;
    e.stopPropagation();
    if (_wip && _wip.canvasId === canvasId && _wip.points.length >= 3) _close(canvasId);
  }

  // ── Shared mouse handlers (draw rubber-band + edit drag) ───────────────────

  function _onMouseMove(e, canvasId) {
    // Always track image-space cursor position for the HU overlay.
    const _coords = _fromEvent(e, canvasId);
    if (_coords) {
      _mouseIm[canvasId] = { ix: _coords.ix, iy: _coords.iy };
      _requestRedraw();
    } else {
      delete _mouseIm[canvasId];
    }

    // Box mode: update in-progress box endpoint.
    if (_boxMode && _boxWip && _boxWip.canvasId === canvasId) {
      const coords = _fromEvent(e, canvasId);
      if (coords) {
        _boxWip.ix2 = coords.ix;
        _boxWip.iy2 = coords.iy;
        _requestRedraw();
      }
      return;
    }

    // Draw mode: update rubber-band endpoint then trigger a clean full re-render.
    // Calling _redrawCanvas() directly would accumulate strokes without clearing;
    // _requestRedraw() → updateAllViews() → _doRender() clears the canvas first.
    if (_drawing && _wip && _wip.canvasId === canvasId) {
      const canvas = document.getElementById(canvasId);
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      _wip.mousePos = {
        x: (e.clientX - rect.left) * (canvas.width  / rect.width),
        y: (e.clientY - rect.top)  * (canvas.height / rect.height),
      };
      _requestRedraw();
      return;
    }

    // Freehand mode: accumulate vertices while button is held.
    if (_freehand && _fhWip && _fhWip.canvasId === canvasId) {
      const canvas = document.getElementById(canvasId);
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cx   = (e.clientX - rect.left) * (canvas.width  / rect.width);
      const cy   = (e.clientY - rect.top)  * (canvas.height / rect.height);
      const dx   = cx - _fhWip.lastCx;
      const dy   = cy - _fhWip.lastCy;
      if (dx * dx + dy * dy >= _fhDist * _fhDist) {
        const coords = _fromEvent(e, canvasId);
        if (coords) _fhWip.points.push({ ix: coords.ix, iy: coords.iy });
        _fhWip.lastCx = cx;
        _fhWip.lastCy = cy;
        _requestRedraw();
      }
      return;
    }

    // Edit mode: live vertex drag.
    if (_editing && _dragState && _dragState.canvasId === canvasId) {
      const coords = _fromEvent(e, canvasId);
      if (!coords) return;
      const roi = _rois.find(r => r.id === _dragState.roiId);
      if (roi) {
        roi.points[_dragState.vertexIdx] = { ix: coords.ix, iy: coords.iy };
        _requestRedraw();
      }
    }
  }

  function _onMouseDown(e, canvasId) {
    // Box mode: start a new seg box.
    if (_boxMode) {
      e.stopPropagation();
      const coords = _fromEvent(e, canvasId);
      if (!coords) return;
      _boxWip = { canvasId, ix1: coords.ix, iy1: coords.iy, ix2: coords.ix, iy2: coords.iy };
      _requestRedraw();
      return;
    }

    // Freehand mode: start a new stroke.
    if (_freehand) {
      e.stopPropagation();
      const coords = _fromEvent(e, canvasId);
      if (!coords) return;
      const plane = _planeIndex(canvasId);
      _fhWip = {
        canvasId,
        planeIndex: plane,
        points:     [{ ix: coords.ix, iy: coords.iy }],
        lastCx:     coords.cx,
        lastCy:     coords.cy,
      };
      _requestRedraw();
      return;
    }

    if (!_editing) return;
    e.stopPropagation();

    const coords = _fromEvent(e, canvasId);
    if (!coords) {
      _selectedId = null;
      _requestRedraw();
      return;
    }

    const vhit = _findVertex(coords.cx, coords.cy, canvasId);
    if (vhit) {
      _selectedId = vhit.roiId;
      _dragState  = { canvasId, roiId: vhit.roiId, vertexIdx: vhit.vertexIdx };
      const canvas = document.getElementById(canvasId);
      if (canvas) canvas.style.cursor = 'grabbing';
      _requestRedraw();
      return;
    }

    _selectedId = _findRoi(coords.cx, coords.cy, canvasId);
    _dragState  = null;
    _requestRedraw();
  }

  function _onMouseUp(e, canvasId) {
    // Box mode: commit the in-progress box.
    if (_boxMode && _boxWip && _boxWip.canvasId === canvasId) {
      const w = Math.abs(_boxWip.ix2 - _boxWip.ix1);
      const h = Math.abs(_boxWip.iy2 - _boxWip.iy1);
      if (w > 2 && h > 2) _segBoxes[canvasId] = { ..._boxWip };
      _boxWip = null;
      _requestRedraw();
      return;
    }

    // Freehand: close stroke into an ROI.
    if (_freehand && _fhWip && _fhWip.canvasId === canvasId) {
      if (_fhWip.points.length >= 3) _closeFreehand();
      _fhWip = null;
      _requestRedraw();
      return;
    }

    if (!_editing || !_dragState || _dragState.canvasId !== canvasId) return;
    const roi = _rois.find(r => r.id === _dragState.roiId);
    if (roi) _syncToStore(roi);
    _dragState = null;
    const canvas = document.getElementById(canvasId);
    if (canvas) canvas.style.cursor = 'default';
  }

  function _onMouseLeave(canvasId) {
    delete _mouseIm[canvasId];
    _requestRedraw();
    if (_drawing && _wip && _wip.canvasId === canvasId) {
      _wip.mousePos = null;
    }
    if (_editing && _dragState && _dragState.canvasId === canvasId) {
      const roi = _rois.find(r => r.id === _dragState.roiId);
      if (roi) _syncToStore(roi);
      _dragState = null;
    }
  }

  // Route all interactive redraws through the full render pipeline so the
  // canvas is always cleared by mpr.js before ROI overlays are repainted.
  function _requestRedraw() {
    if (typeof updateAllViews === 'function') updateAllViews();
    else redrawAll();   // fallback (e.g. unit tests)
  }

  // ── Edit mode hit testing ──────────────────────────────────────────────────

  // Returns { roiId, vertexIdx } if a vertex on the current plane is within
  // 8 canvas-px of (cx, cy). Checks in reverse draw order (topmost first).
  function _findVertex(cx, cy, canvasId) {
    const state   = mprViewState && mprViewState[canvasId];
    if (!state) return null;
    const plane   = _planeIndex(canvasId);
    const onPlane = _rois.filter(r => r.canvasId === canvasId && r.planeIndex === plane);
    for (let ri = onPlane.length - 1; ri >= 0; ri--) {
      const roi = onPlane[ri];
      const pts = roi.points.map(p => _toCanvas(p, state));
      for (let i = 0; i < pts.length; i++) {
        const dx = cx - pts[i].x, dy = cy - pts[i].y;
        if (Math.sqrt(dx * dx + dy * dy) < 8) return { roiId: roi.id, vertexIdx: i };
      }
    }
    return null;
  }

  // Returns the id of the topmost ROI under (cx, cy) via point-in-polygon, or null.
  function _findRoi(cx, cy, canvasId) {
    const state   = mprViewState && mprViewState[canvasId];
    if (!state) return null;
    const plane   = _planeIndex(canvasId);
    const onPlane = _rois.filter(r => r.canvasId === canvasId && r.planeIndex === plane).slice().reverse();
    for (const roi of onPlane) {
      const pts = roi.points.map(p => _toCanvas(p, state));
      if (_pointInPolygon(cx, cy, pts)) return roi.id;
    }
    return null;
  }

  // Ray-casting point-in-polygon test.
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

  function _close(canvasId) {
    if (!_wip || _wip.points.length < 3) return;

    const defName = `ROI_${_rois.length + 1}`;
    const input   = window.prompt('Name this ROI:', defName);
    const name    = (input !== null && input.trim()) ? input.trim() : defName;
    const id      = Date.now();
    const color   = PALETTE[_rois.length % PALETTE.length];

    const roi = {
      id,
      name,
      canvasId,
      planeIndex: _wip.planeIndex,
      points:     [..._wip.points],
      color,
    };
    _rois.push(roi);

    // Sync to global roiStore so roiSave.save() captures it.
    if (typeof roiStore !== 'undefined') {
      roiStore.add({
        id,
        name,
        slice:      _wip.planeIndex,
        points:     _wip.points.map(p => [Math.round(p.ix), Math.round(p.iy)]),
        color,
        source:     'mpr',
        plane:      PLANE_NAME[canvasId] ?? 'axial',
        planeIndex: _wip.planeIndex,
        canvasId,
      });
    }

    _wip = null;
    _redrawCanvas(canvasId);
    _renderPanel();
  }

  // Close a freehand stroke into a named ROI.
  function _closeFreehand() {
    if (!_fhWip || _fhWip.points.length < 3) return;
    const canvasId = _fhWip.canvasId;
    const defName  = `ROI_${_rois.length + 1}`;
    const input    = window.prompt('Name this ROI:', defName);
    const name     = (input !== null && input.trim()) ? input.trim() : defName;
    const id       = Date.now();
    const color    = PALETTE[_rois.length % PALETTE.length];

    const roi = {
      id, name, canvasId,
      planeIndex: _fhWip.planeIndex,
      points:     [..._fhWip.points],
      color,
    };
    _rois.push(roi);

    if (typeof roiStore !== 'undefined') {
      roiStore.add({
        id, name,
        slice:      _fhWip.planeIndex,
        points:     _fhWip.points.map(p => [Math.round(p.ix), Math.round(p.iy)]),
        color,
        source:     'freehand',
        plane:      PLANE_NAME[canvasId] ?? 'axial',
        planeIndex: _fhWip.planeIndex,
        canvasId,
      });
    }

    _renderPanel();
  }

  // Sync a single ROI's updated points back to roiStore (after vertex drag).
  function _syncToStore(roi) {
    if (typeof roiStore === 'undefined') return;
    roiStore.update(roi.id, {
      points:     roi.points.map(p => [Math.round(p.ix), Math.round(p.iy)]),
      planeIndex: roi.planeIndex,
    });
  }

  function deleteRoi(id) {
    _rois = _rois.filter(r => r.id !== id);
    if (_selectedId === id) _selectedId = null;
    if (typeof roiStore !== 'undefined') roiStore.remove(id);
    _renderPanel();
    redrawAll();
  }

  function toggleRoiVisibility(id) {
    const roi = _rois.find(r => r.id === id);
    if (!roi) return;
    roi.visible = roi.visible === false ? true : false;
    _renderPanel();
    redrawAll();
  }

  function renameRoi(id, name) {
    const roi = _rois.find(r => r.id === id);
    if (!roi) return;
    const trimmed = name.trim() || roi.name;
    roi.name = trimmed;
    if (typeof roiStore !== 'undefined') roiStore.update(id, { name: trimmed });
  }

  function getRois() { return _rois; }

  // ── Import from backend ────────────────────────────────────────────────────

  /**
   * Bulk-import MPR ROIs from the backend JSON format.
   *
   * Expected shape per entry (as saved by the MPR roiStore sync):
   *   { id, name, plane, planeIndex, canvasId, points:[[ix,iy]], color, source:'mpr' }
   *
   * Entries missing 'plane' or 'canvasId' are skipped.
   * Entries whose id already exists are skipped (safe to call repeatedly).
   */
  function importRois(roisArray) {
    if (!Array.isArray(roisArray) || !roisArray.length) return;
    const existingIds = new Set(_rois.map(r => r.id));

    for (const r of roisArray) {
      // Only import entries that originated from the MPR tool.
      if (!r.canvasId || !CANVAS_IDS.includes(r.canvasId)) continue;

      const id = r.id ?? (Date.now() + Math.random());
      if (existingIds.has(id)) continue;

      const roi = {
        id,
        name:           r.name      ?? 'Imported',
        canvasId:       r.canvasId,
        planeIndex:     r.planeIndex ?? 0,
        // Convert [[ix,iy]] → [{ix,iy}] for internal use.
        points:         (r.points ?? []).map(p => ({ ix: p[0], iy: p[1] })),
        color:          r.color ?? PALETTE[_rois.length % PALETTE.length],
        isInterpolated: r.isInterpolated ?? false,
      };
      _rois.push(roi);
      existingIds.add(id);

      if (typeof roiStore !== 'undefined') {
        roiStore.add({
          id:         roi.id,
          name:       roi.name,
          slice:      roi.planeIndex,
          points:     r.points ?? [],
          color:      roi.color,
          source:     'mpr',
          plane:      r.plane ?? PLANE_NAME[roi.canvasId] ?? 'axial',
          planeIndex: roi.planeIndex,
          canvasId:   roi.canvasId,
        });
      }
    }

    _renderPanel();
    redrawAll();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  // Called at the end of every _doRender() in mpr.js.
  function redrawAll() {
    CANVAS_IDS.forEach(_redrawCanvas);
  }

  function _redrawCanvas(canvasId) {
    const canvas = document.getElementById(canvasId);
    const state  = mprViewState && mprViewState[canvasId];
    if (!canvas || !state) return;

    const ctx   = canvas.getContext('2d');
    const plane = _planeIndex(canvasId);

    // Discard WIP if the user scrolled to a different plane while drawing.
    if (_wip && _wip.canvasId === canvasId && _wip.planeIndex !== plane) {
      _wip = null;
    }

    // Cross-view position lines: show where ROIs from other planes intersect.
    _drawCrossViewIndicators(ctx, canvasId, state);

    // HU value overlay at cursor position (top-left corner).
    _drawHUOverlay(ctx, canvasId, state);

    // Segmentation bounding boxes (committed + in-progress).
    if (_segBoxes[canvasId]) _drawSegBox(ctx, _segBoxes[canvasId], state, false);
    if (_boxWip && _boxWip.canvasId === canvasId) _drawSegBox(ctx, _boxWip, state, true);

    // Closed ROIs for this canvas at the current plane position.
    _rois.filter(r => r.canvasId === canvasId && r.planeIndex === plane && r.visible !== false)
         .forEach(r => _drawClosed(ctx, r, state, r.id === _selectedId));

    // In-progress polygon (draw mode only).
    if (_wip  && _wip.canvasId  === canvasId) _drawWip(ctx, _wip, state);
    if (_fhWip && _fhWip.canvasId === canvasId) _drawFreehandWip(ctx, _fhWip, state);
  }

  // Look up the HU value for image coords (ix, iy) on the given canvas.
  // Returns null if mprVolume is unavailable or coords are out of bounds.
  function _huAt(canvasId, ix, iy) {
    if (typeof mprVolume === 'undefined' || !mprVolume) return null;
    const { buffer, rows, cols, slices } = mprVolume;
    let z, row, col;
    if (canvasId === 'axialCanvas') {
      col = Math.round(ix);  row = Math.round(iy);  z = (typeof zIndex !== 'undefined') ? zIndex : 0;
    } else if (canvasId === 'coronalCanvas') {
      col = Math.round(cols - 1 - ix);  row = (typeof yIndex !== 'undefined') ? yIndex : 0;  z = Math.round(iy);
    } else if (canvasId === 'sagittalCanvas') {
      row = Math.round(rows - 1 - ix);  col = (typeof xIndex !== 'undefined') ? xIndex : 0;  z = Math.round(iy);
    } else {
      return null;
    }
    if (z < 0 || z >= slices || row < 0 || row >= rows || col < 0 || col >= cols) return null;
    return buffer[z * rows * cols + row * cols + col];
  }

  // Draw the HU value and cursor image coords in the top-left corner of the canvas.
  function _drawHUOverlay(ctx, canvasId, state) {
    const pos = _mouseIm[canvasId];
    if (!pos) return;
    const hu = _huAt(canvasId, pos.ix, pos.iy);
    if (hu === null) return;

    const text = `HU: ${Math.round(hu)}`;
    const x = state.offX + 6;
    const y = state.offY + 6;

    ctx.save();
    ctx.font         = 'bold 12px monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    // Dark shadow for legibility on any background.
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillText(text, x + 1, y + 1);
    ctx.fillStyle = '#ffff66';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // Draw a segmentation bounding box rectangle on the canvas.
  function _drawSegBox(ctx, box, state, isWip) {
    const x1 = state.offX + (Math.min(box.ix1, box.ix2) / state.srcW) * state.drawW;
    const y1 = state.offY + (Math.min(box.iy1, box.iy2) / state.srcH) * state.drawH;
    const x2 = state.offX + (Math.max(box.ix1, box.ix2) / state.srcW) * state.drawW;
    const y2 = state.offY + (Math.max(box.iy1, box.iy2) / state.srcH) * state.drawH;
    const w  = x2 - x1;
    const h  = y2 - y1;
    if (w < 1 || h < 1) return;
    ctx.save();
    ctx.strokeStyle = isWip ? 'rgba(255,204,68,0.6)' : '#ffcc44';
    ctx.fillStyle   = 'rgba(255,204,68,0.07)';
    ctx.lineWidth   = isWip ? 1 : 1.5;
    ctx.setLineDash([6, 3]);
    ctx.fillRect(x1, y1, w, h);
    ctx.strokeRect(x1, y1, w, h);
    ctx.setLineDash([]);
    if (!isWip) {
      ctx.font         = 'bold 10px sans-serif';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle    = 'rgba(0,0,0,0.6)';  ctx.fillText('Seg Box', x1 + 5, y1 + 5);
      ctx.fillStyle    = '#ffcc44cc';          ctx.fillText('Seg Box', x1 + 4, y1 + 4);
    }
    ctx.restore();
  }

  // Draw thin dashed lines in `canvasId` showing the plane position of every
  // ROI drawn in the *other* two canvases.
  //
  // Coordinate algebra (srcW/srcH = image dimensions for the target canvas):
  //
  //   Axial   (ix=col, iy=row, planeIndex=z):
  //     ← Coronal  ROI at y=planeIndex → horizontal line  at iy = planeIndex
  //     ← Sagittal ROI at x=planeIndex → vertical   line  at ix = planeIndex
  //
  //   Coronal (ix=ncols-1-col, iy=z,   planeIndex=y):
  //     ← Axial    ROI at z=planeIndex → horizontal line  at iy = planeIndex
  //     ← Sagittal ROI at x=planeIndex → vertical   line  at ix = srcW-1-planeIndex
  //
  //   Sagittal (ix=nrows-1-row, iy=z,  planeIndex=x):
  //     ← Axial    ROI at z=planeIndex → horizontal line  at iy = planeIndex
  //     ← Coronal  ROI at y=planeIndex → vertical   line  at ix = srcW-1-planeIndex
  //
  function _drawCrossViewIndicators(ctx, canvasId, state) {
    const others = _rois.filter(r => r.canvasId !== canvasId && r.visible !== false);
    if (!others.length) return;

    const { offX, offY, drawW, drawH, srcW, srcH } = state;

    // Group by (name, source-canvas) so multi-slice structures (e.g. 100 axial
    // lung contours) appear as one shaded band rather than hundreds of lines.
    const groups = new Map();
    for (const roi of others) {
      const key = roi.name + '\0' + roi.canvasId;
      if (!groups.has(key)) {
        groups.set(key, { name: roi.name, srcCanvas: roi.canvasId,
                          color: roi.color, indices: [] });
      }
      groups.get(key).indices.push(roi.planeIndex);
    }

    for (const { name, srcCanvas, color, indices } of groups.values()) {
      const minIdx = Math.min(...indices);
      const maxIdx = Math.max(...indices);

      // Determine orientation + image-space coordinate range in the TARGET canvas.
      let isHoriz, coordMin, coordMax, srcDim;

      if (canvasId === 'axialCanvas') {
        if      (srcCanvas === 'coronalCanvas')  { isHoriz = true;  srcDim = srcH; coordMin = minIdx; coordMax = maxIdx; }
        else if (srcCanvas === 'sagittalCanvas') { isHoriz = false; srcDim = srcW; coordMin = minIdx; coordMax = maxIdx; }
        else continue;
      } else if (canvasId === 'coronalCanvas') {
        if      (srcCanvas === 'axialCanvas')    { isHoriz = true;  srcDim = srcH; coordMin = minIdx; coordMax = maxIdx; }
        else if (srcCanvas === 'sagittalCanvas') { isHoriz = false; srcDim = srcW; coordMin = srcW - 1 - maxIdx; coordMax = srcW - 1 - minIdx; }
        else continue;
      } else if (canvasId === 'sagittalCanvas') {
        if      (srcCanvas === 'axialCanvas')    { isHoriz = true;  srcDim = srcH; coordMin = minIdx; coordMax = maxIdx; }
        else if (srcCanvas === 'coronalCanvas')  { isHoriz = false; srcDim = srcW; coordMin = srcW - 1 - maxIdx; coordMax = srcW - 1 - minIdx; }
        else continue;
      } else continue;

      coordMin = Math.max(0, Math.min(coordMin, srcDim - 1));
      coordMax = Math.max(0, Math.min(coordMax, srcDim - 1));
      if (coordMin > coordMax) continue;

      // Canvas-pixel positions for the start/end of the band.
      const px1 = isHoriz
        ? offY + (coordMin / srcH) * drawH
        : offX + (coordMin / srcW) * drawW;
      const px2 = isHoriz
        ? offY + (coordMax / srcH) * drawH
        : offX + (coordMax / srcW) * drawW;

      ctx.save();

      if (minIdx === maxIdx) {
        // ── Single slice → thin dashed line (original style) ─────────────
        ctx.strokeStyle = color + 'b3';
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        if (isHoriz) {
          ctx.moveTo(offX, px1); ctx.lineTo(offX + drawW, px1);
        } else {
          ctx.moveTo(px1, offY); ctx.lineTo(px1, offY + drawH);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        const lx = isHoriz ? offX + 4 : px1 + 4;
        const ly = isHoriz ? px1 - 13  : offY + 4;
        ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(name, lx + 1, ly + 1);
        ctx.fillStyle = color + 'cc';        ctx.fillText(name, lx,     ly);

      } else {
        // ── Multiple slices → semi-transparent band ───────────────────────
        let bx, by, bw, bh;
        if (isHoriz) { bx = offX;  by = px1;  bw = drawW;      bh = px2 - px1; }
        else         { bx = px1;   by = offY;  bw = px2 - px1;  bh = drawH;     }

        ctx.fillStyle   = color + '1a';   // ~10% opacity fill
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = color + '66';
        ctx.lineWidth   = 1;
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(bx, by, bw, bh);
        ctx.setLineDash([]);

        // Name label centred in the band.
        ctx.font         = 'bold 10px sans-serif';
        const lx = isHoriz ? bx + 4       : bx + bw / 2;
        const ly = isHoriz ? by + bh / 2   : by + 4;
        ctx.textAlign    = isHoriz ? 'left'   : 'center';
        ctx.textBaseline = isHoriz ? 'middle' : 'top';
        ctx.fillStyle    = 'rgba(0,0,0,0.6)'; ctx.fillText(name, lx + 1, ly + 1);
        ctx.fillStyle    = color + 'cc';       ctx.fillText(name, lx,     ly);
      }

      ctx.restore();
    }
  }

  function _drawClosed(ctx, roi, state, selected) {
    const pts = roi.points.map(p => _toCanvas(p, state));
    if (pts.length < 2) return;

    ctx.save();

    // Interpolated contours: dashed + slightly transparent to distinguish from
    // hand-drawn key frames.
    if (roi.isInterpolated) {
      ctx.globalAlpha = 0.65;
      ctx.setLineDash([5, 3]);
    }

    ctx.strokeStyle = roi.color;
    ctx.fillStyle   = roi.color + '22';
    ctx.lineWidth   = selected ? 2.5 : 1.5;
    ctx.lineJoin    = 'round';

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // White dashed selection ring.
    if (selected) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Vertex handles — larger + outlined when selected (draggable).
    pts.forEach(p => {
      ctx.beginPath();
      if (selected) {
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fillStyle   = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = roi.color;
        ctx.lineWidth   = 2;
        ctx.stroke();
      } else {
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = roi.color;
        ctx.fill();
      }
    });

    // Name label at centroid.
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    ctx.font         = 'bold 12px sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = 'rgba(0,0,0,0.6)';
    ctx.fillText(roi.name, cx + 1, cy + 1);
    ctx.fillStyle    = selected ? '#ffffff' : roi.color;
    ctx.fillText(roi.name, cx, cy);

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

    // First vertex turns yellow when polygon is closeable (≥3 pts).
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.fillStyle = (i === 0 && pts.length >= 3) ? '#ffff00' : '#ffffff';
      ctx.arc(p.x, p.y, i === 0 ? 5 : 3, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.restore();
  }

  function _drawFreehandWip(ctx, wip, state) {
    const pts = wip.points.map(p => _toCanvas(p, state));
    if (!pts.length) return;

    ctx.save();
    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();

    // Closing line preview (dashed)
    if (pts.length >= 3) {
      const last = pts[pts.length - 1];
      ctx.strokeStyle = '#ffaa0066';
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(pts[0].x, pts[0].y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Brush-size indicator circle at last vertex + spacing label
    const last = pts[pts.length - 1];
    ctx.strokeStyle = 'rgba(255,170,0,0.5)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.arc(last.x, last.y, _fhDist, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font         = '10px sans-serif';
    ctx.fillStyle    = '#ffaa00cc';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`spacing ${_fhDist}px  (scroll ↕)`, last.x + _fhDist + 4, last.y - 6);

    ctx.restore();
  }

  // ── ROI list panel ─────────────────────────────────────────────────────────

  function _renderPanel() {
    const panel = document.getElementById('mprRoiList');
    if (!panel) return;

    if (!_rois.length) {
      panel.innerHTML = '<div style="color:#555;font-size:12px;">No ROIs drawn</div>';
      return;
    }

    panel.innerHTML = _rois.map(r => {
      const visible = r.visible !== false;
      return `
      <div style="display:flex;align-items:center;gap:6px;padding:2px 0;">
        <button data-vis-id="${r.id}"
          style="background:none;border:none;cursor:pointer;padding:0;flex-shrink:0;
                 font-size:14px;line-height:1;color:${visible ? r.color : '#444'};"
          title="${visible ? 'Hide' : 'Show'}">${visible ? '●' : '○'}</button>
        <span style="width:10px;height:10px;background:${visible ? r.color : '#333'};
                     border-radius:2px;flex-shrink:0;display:inline-block;
                     opacity:${visible ? 1 : 0.4};"></span>
        <input class="mpr-roi-name" type="text" data-id="${r.id}" value="${r.name}"
               style="flex:1;background:#1a1a1a;border:1px solid #444;border-radius:3px;
                      color:${visible ? '#ccc' : '#555'};font-size:12px;
                      padding:2px 5px;min-width:0;"
               title="Click to rename">
        <span style="color:#555;font-size:11px;white-space:nowrap;">
          ${PLANE_LABEL[r.canvasId]} ${r.planeIndex + 1}
        </span>
        <button data-del-id="${r.id}"
          style="background:none;border:none;color:#f66;cursor:pointer;
                 font-size:11px;padding:0 2px;flex-shrink:0;"
          title="Delete">✕</button>
      </div>`;
    }).join('');

    panel.querySelectorAll('.mpr-roi-name').forEach(input => {
      const commit = () => renameRoi(Number(input.dataset.id), input.value);
      input.addEventListener('blur',    commit);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    });

    panel.querySelectorAll('button[data-vis-id]').forEach(btn => {
      btn.addEventListener('click', () => toggleRoiVisibility(Number(btn.dataset.visId)));
    });

    panel.querySelectorAll('button[data-del-id]').forEach(btn => {
      btn.addEventListener('click', () => deleteRoi(Number(btn.dataset.delId)));
    });
  }

  // ── Interpolation engine ──────────────────────────────────────────────────
  //
  // Workflow:
  //   1. User draws several axial ROIs with the same name (key frames).
  //   2. interpolate(name) fills every integer z-slice between consecutive
  //      key frames with linearly-interpolated contours.
  //   3. All generated ROIs carry isInterpolated:true so clearInterpolated()
  //      can remove them without touching the hand-drawn key frames.
  //
  // Algorithm:
  //   Both key-frame polygons are resampled to INTERP_N arc-length-uniform
  //   points.  B's starting index is rotated to minimise distance to A
  //   (avoids twisted interpolation paths).  Each intermediate contour is
  //   a per-point linear blend weighted by position in the z interval.

  /**
   * Resample a closed polygon to exactly N uniformly-spaced points by
   * cumulative arc-length parameterisation.
   * @param {Array<{ix,iy}>} points
   * @param {number} N
   * @returns {Array<{ix,iy}>}
   */
  function _arcLengthResample(points, N) {
    const n = points.length;
    // Build cumulative arc-length array (closed: last edge → points[0]).
    const arc = [0];
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      const dx = b.ix - a.ix, dy = b.iy - a.iy;
      arc.push(arc[i] + Math.sqrt(dx * dx + dy * dy));
    }
    const total = arc[n];
    if (total === 0) {
      // Degenerate polygon — return N copies of the first point.
      return Array.from({ length: N }, () => ({ ix: points[0].ix, iy: points[0].iy }));
    }

    const out = [];
    for (let j = 0; j < N; j++) {
      const target = (j / N) * total;
      // Binary search for the segment that contains target.
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arc[mid + 1] < target) lo = mid + 1; else hi = mid;
      }
      const seg = lo;
      const segLen = arc[seg + 1] - arc[seg];
      const t = segLen > 0 ? (target - arc[seg]) / segLen : 0;
      const a = points[seg], b = points[(seg + 1) % n];
      out.push({ ix: a.ix + t * (b.ix - a.ix), iy: a.iy + t * (b.iy - a.iy) });
    }
    return out;
  }

  /**
   * Align B to A by finding the rotation + winding direction that minimises
   * the sum of squared point-to-point distances.
   *
   * Two passes are run:
   *   1. B as-is       (same winding as drawn)
   *   2. B reversed    (opposite winding — handles CW vs CCW mismatch)
   *
   * For each pass every cyclic rotation is tested.  The globally best
   * (direction, offset) combination is returned.  Without the reversal pass,
   * polygons drawn in opposite winding orders produce self-intersecting
   * (twisted-ribbon) interpolated contours.
   *
   * @param {Array<{ix,iy}>} A  — reference (not mutated)
   * @param {Array<{ix,iy}>} B  — candidate (returned aligned, not mutated)
   * @returns {Array<{ix,iy}>}
   */
  function _alignStartPoint(A, B) {
    const N    = A.length;
    const Brev = B.slice().reverse();   // opposite winding

    let bestCost = Infinity, bestK = 0, bestArr = B;

    for (const cand of [B, Brev]) {
      for (let k = 0; k < N; k++) {
        let cost = 0;
        for (let i = 0; i < N; i++) {
          const dx = A[i].ix - cand[(i + k) % N].ix;
          const dy = A[i].iy - cand[(i + k) % N].iy;
          cost += dx * dx + dy * dy;
          if (cost >= bestCost) break;   // early exit
        }
        if (cost < bestCost) { bestCost = cost; bestK = k; bestArr = cand; }
      }
    }

    return bestK === 0 ? bestArr : bestArr.slice(bestK).concat(bestArr.slice(0, bestK));
  }

  /**
   * Generate interpolated ROI objects for all integer z-slices strictly
   * between roiA.planeIndex and roiB.planeIndex.
   * @returns {Array} internal ROI objects (not yet added to _rois / roiStore)
   */
  function _interpolateContourPair(roiA, roiB) {
    const [lo, hi] = roiA.planeIndex <= roiB.planeIndex
      ? [roiA, roiB] : [roiB, roiA];
    if (hi.planeIndex - lo.planeIndex <= 1) return [];  // adjacent — nothing to fill

    const A  = _arcLengthResample(lo.points, INTERP_N);
    const B  = _alignStartPoint(A, _arcLengthResample(hi.points, INTERP_N));
    const ts = Date.now();
    const result = [];

    for (let z = lo.planeIndex + 1; z < hi.planeIndex; z++) {
      const t   = (z - lo.planeIndex) / (hi.planeIndex - lo.planeIndex);
      const pts = A.map((a, i) => ({
        ix: a.ix + t * (B[i].ix - a.ix),
        iy: a.iy + t * (B[i].iy - a.iy),
      }));
      result.push({
        id:             ts + z,     // unique: base timestamp + z offset
        name:           lo.name,
        canvasId:       'axialCanvas',
        planeIndex:     z,
        points:         pts,
        color:          lo.color,
        isInterpolated: true,
      });
    }
    return result;
  }

  /**
   * Return the names of all structures that have ≥2 axial key-frame ROIs
   * (i.e., non-interpolated, axialCanvas ROIs at ≥2 distinct planeIndex values).
   * @returns {string[]}
   */
  function getInterpolatable() {
    const counts = {};
    _rois
      .filter(r => r.canvasId === 'axialCanvas' && !r.isInterpolated)
      .forEach(r => {
        if (!counts[r.name]) counts[r.name] = new Set();
        counts[r.name].add(r.planeIndex);
      });
    return Object.entries(counts)
      .filter(([, s]) => s.size >= 2)
      .map(([name]) => name);
  }

  /**
   * Remove all interpolated ROIs for the given structure name.
   * Leaves hand-drawn key frames untouched.
   */
  function clearInterpolated(name) {
    const toRemove = _rois.filter(r => r.name === name && r.isInterpolated);
    toRemove.forEach(r => {
      _rois = _rois.filter(x => x.id !== r.id);
      if (typeof roiStore !== 'undefined') roiStore.remove(r.id);
    });
    _renderPanel();
    redrawAll();
  }

  /**
   * Interpolate all intermediate slices for the named structure.
   * Key frames are the non-interpolated axial ROIs sharing that name,
   * sorted by planeIndex.  Generates one contour per integer z-slice
   * between each consecutive pair.
   *
   * Calls clearInterpolated(name) first so re-running is idempotent.
   *
   * @param {string} name  — structure name (must match ROI names exactly)
   * @returns {number}     — count of new interpolated contours added
   */
  function interpolate(name) {
    const keyFrames = _rois
      .filter(r => r.canvasId === 'axialCanvas' && r.name === name && !r.isInterpolated)
      .sort((a, b) => a.planeIndex - b.planeIndex);

    if (keyFrames.length < 2) return 0;

    clearInterpolated(name);    // remove any previous pass first

    let total = 0;
    for (let k = 0; k < keyFrames.length - 1; k++) {
      const newRois = _interpolateContourPair(keyFrames[k], keyFrames[k + 1]);
      for (const roi of newRois) {
        _rois.push(roi);
        if (typeof roiStore !== 'undefined') {
          roiStore.add({
            id:             roi.id,
            name:           roi.name,
            slice:          roi.planeIndex,
            points:         roi.points.map(p => [Math.round(p.ix), Math.round(p.iy)]),
            color:          roi.color,
            source:         'mpr',
            plane:          'axial',
            planeIndex:     roi.planeIndex,
            canvasId:       'axialCanvas',
            isInterpolated: true,
          });
        }
      }
      total += newRois.length;
    }

    _renderPanel();
    redrawAll();
    return total;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  return {
    init,
    toggleDrawMode, isDrawing,
    toggleEditMode, isEditing,
    redrawAll, getRois,
    deleteRoi, renameRoi, toggleRoiVisibility,
    toggleFreehandMode, isFreehand,
    toggleBoxMode, isBoxMode, clearSegBoxes, getSegBoxes,
    importRois,
    interpolate, clearInterpolated, getInterpolatable,
  };

})();
