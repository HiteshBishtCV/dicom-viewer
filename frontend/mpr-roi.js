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

  const PALETTE = [
    '#ff4444', '#44ff88', '#4499ff', '#ffff44',
    '#ff88ff', '#44ffff', '#ff8844', '#aa44ff',
  ];

  const CANVAS_IDS  = ['axialCanvas', 'coronalCanvas', 'sagittalCanvas'];
  const PLANE_LABEL = { axialCanvas: 'Axial', coronalCanvas: 'Coronal', sagittalCanvas: 'Sagittal' };
  const PLANE_NAME  = { axialCanvas: 'axial', coronalCanvas: 'coronal', sagittalCanvas: 'sagittal' };

  let _drawing    = false;
  let _editing    = false;
  let _rois       = [];     // { id, name, canvasId, planeIndex, points:[{ix,iy}], color }
  let _wip        = null;   // { canvasId, planeIndex, points, mousePos }
  let _selectedId = null;   // id of currently selected ROI (edit mode)
  let _dragState  = null;   // { canvasId, roiId, vertexIdx }

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
    if (_editing) _exitEdit();          // mutually exclusive
    _drawing = !_drawing;
    if (!_drawing && _wip) { _wip = null; redrawAll(); }
    _syncCursors();
    _updateDrawBtn();
    _renderPanel();
    return _drawing;
  }

  function toggleEditMode() {
    if (_drawing) {                     // mutually exclusive
      _drawing = false;
      if (_wip) { _wip = null; redrawAll(); }
      _updateDrawBtn();
    }
    _editing = !_editing;
    if (!_editing) _exitEdit();
    _syncCursors();
    _updateEditBtn();
    redrawAll();
    return _editing;
  }

  function _exitEdit() {
    _selectedId = null;
    _dragState  = null;
    _editing    = false;
  }

  function _syncCursors() {
    CANVAS_IDS.forEach(id => {
      const c = document.getElementById(id);
      if (!c) return;
      c.style.cursor = _drawing ? 'crosshair' : _editing ? 'default' : '';
    });
  }

  function isDrawing() { return _drawing; }
  function isEditing() { return _editing; }

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
    if (!_editing || !_dragState || _dragState.canvasId !== canvasId) return;
    const roi = _rois.find(r => r.id === _dragState.roiId);
    if (roi) _syncToStore(roi);
    _dragState = null;
    const canvas = document.getElementById(canvasId);
    if (canvas) canvas.style.cursor = 'default';
  }

  function _onMouseLeave(canvasId) {
    if (_drawing && _wip && _wip.canvasId === canvasId) {
      _wip.mousePos = null;
      _requestRedraw();
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
        name:       r.name      ?? 'Imported',
        canvasId:   r.canvasId,
        planeIndex: r.planeIndex ?? 0,
        // Convert [[ix,iy]] → [{ix,iy}] for internal use.
        points:     (r.points ?? []).map(p => ({ ix: p[0], iy: p[1] })),
        color:      r.color ?? PALETTE[_rois.length % PALETTE.length],
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

    // Closed ROIs for this canvas at the current plane position.
    _rois.filter(r => r.canvasId === canvasId && r.planeIndex === plane)
         .forEach(r => _drawClosed(ctx, r, state, r.id === _selectedId));

    // In-progress polygon (draw mode only).
    if (_wip && _wip.canvasId === canvasId) _drawWip(ctx, _wip, state);
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
    const others = _rois.filter(r => r.canvasId !== canvasId);
    if (!others.length) return;

    const { offX, offY, drawW, drawH, srcW, srcH } = state;

    for (const roi of others) {
      let isHoriz, lineCoord;   // isHoriz true → horizontal; lineCoord in image space

      if (canvasId === 'axialCanvas') {
        if      (roi.canvasId === 'coronalCanvas')  { isHoriz = true;  lineCoord = roi.planeIndex; }
        else if (roi.canvasId === 'sagittalCanvas') { isHoriz = false; lineCoord = roi.planeIndex; }
        else continue;

      } else if (canvasId === 'coronalCanvas') {
        if      (roi.canvasId === 'axialCanvas')    { isHoriz = true;  lineCoord = roi.planeIndex; }
        else if (roi.canvasId === 'sagittalCanvas') { isHoriz = false; lineCoord = srcW - 1 - roi.planeIndex; }
        else continue;

      } else if (canvasId === 'sagittalCanvas') {
        if      (roi.canvasId === 'axialCanvas')    { isHoriz = true;  lineCoord = roi.planeIndex; }
        else if (roi.canvasId === 'coronalCanvas')  { isHoriz = false; lineCoord = srcW - 1 - roi.planeIndex; }
        else continue;
      } else { continue; }

      // Skip if the indicator falls outside the rendered image area.
      const max = isHoriz ? srcH : srcW;
      if (lineCoord < 0 || lineCoord >= max) continue;

      // Convert image-space coordinate to canvas pixels.
      let x1, y1, x2, y2, labelX, labelY;
      if (isHoriz) {
        const cy = offY + (lineCoord / srcH) * drawH;
        x1 = offX;  y1 = cy;
        x2 = offX + drawW; y2 = cy;
        labelX = offX + 4;
        labelY = cy - 13;
      } else {
        const cx = offX + (lineCoord / srcW) * drawW;
        x1 = cx; y1 = offY;
        x2 = cx; y2 = offY + drawH;
        labelX = cx + 4;
        labelY = offY + 4;
      }

      ctx.save();
      ctx.strokeStyle = roi.color + 'b3';   // ~70% opacity
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Name tag beside the line.
      ctx.font         = 'bold 10px sans-serif';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle    = 'rgba(0,0,0,0.55)';
      ctx.fillText(roi.name, labelX + 1, labelY + 1);
      ctx.fillStyle    = roi.color + 'cc';
      ctx.fillText(roi.name, labelX, labelY);

      ctx.restore();
    }
  }

  function _drawClosed(ctx, roi, state, selected) {
    const pts = roi.points.map(p => _toCanvas(p, state));
    if (pts.length < 2) return;

    ctx.save();
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

  // ── ROI list panel ─────────────────────────────────────────────────────────

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

  // ── Public API ─────────────────────────────────────────────────────────────

  return {
    init,
    toggleDrawMode, isDrawing,
    toggleEditMode, isEditing,
    redrawAll, getRois,
    deleteRoi, renameRoi,
    importRois,
  };

})();
