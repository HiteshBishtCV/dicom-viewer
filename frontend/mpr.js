// ── MPR (Multi-Planar Reconstruction) ────────────────────────────────────────

// ── Volume ───────────────────────────────────────────────────────────────────
let mprVolume = null;
let mprSeries = null;
let mprWC     = 40;
let mprWW     = 400;

// ── Shared indices ────────────────────────────────────────────────────────────
let xIndex = 0;   // sagittal plane position  (0 … cols-1)
let yIndex = 0;   // coronal  plane position  (0 … rows-1)
let zIndex = 0;   // axial    slice  position  (0 … slices-1)

// ── Per-canvas render geometry — populated each frame, used by click handler ─
const mprViewState = {};

// ── Zoom state ────────────────────────────────────────────────────────────────
// Each canvas keeps its own zoom level; mode is shared (one toggle affects all).
let mprWheelMode = 'scroll';   // 'scroll' | 'zoom'
const mprCanvasZoom = { axialCanvas: 1, coronalCanvas: 1, sagittalCanvas: 1 };

// ── Centralized rendering engine ──────────────────────────────────────────────
function updateAllViews() {
  if (!mprVolume) return;

  const v = mprVolume;

  xIndex = Math.max(0, Math.min(v.cols   - 1, xIndex));
  yIndex = Math.max(0, Math.min(v.rows   - 1, yIndex));
  zIndex = Math.max(0, Math.min(v.slices - 1, zIndex));

  document.getElementById('axialSlider').value    = zIndex;
  document.getElementById('coronalSlider').value  = yIndex;
  document.getElementById('sagittalSlider').value = xIndex;

  renderAxial(zIndex);
  renderCoronal(yIndex);
  renderSagittal(xIndex);
}

// ── Public API ────────────────────────────────────────────────────────────────

async function showMPRView(series, imageIds) {
  mprSeries = series;

  const vp = cornerstone.getViewport(document.getElementById('dicomImage'));
  if (vp) { mprWC = Math.round(vp.voi.windowCenter); mprWW = Math.round(vp.voi.windowWidth); }

  document.getElementById('viewerRow').style.display  = 'none';
  document.getElementById('mprSection').style.display = 'block';
  setMPRProgress(0);

  mprVolume = await buildVolume(imageIds, setMPRProgress);

  xIndex = Math.floor(mprVolume.cols   / 2);
  yIndex = Math.floor(mprVolume.rows   / 2);
  zIndex = Math.floor(mprVolume.slices / 2);

  // Reset zoom and mode on every entry
  mprCanvasZoom.axialCanvas = mprCanvasZoom.coronalCanvas = mprCanvasZoom.sagittalCanvas = 1;
  mprWheelMode = 'scroll';
  updateMPRModeIndicator();

  initSlider('axialSlider',    mprVolume.slices - 1, zIndex, v => { zIndex = v; updateAllViews(); });
  initSlider('coronalSlider',  mprVolume.rows   - 1, yIndex, v => { yIndex = v; updateAllViews(); });
  initSlider('sagittalSlider', mprVolume.cols   - 1, xIndex, v => { xIndex = v; updateAllViews(); });

  attachWheelScroll('axialCanvas',    (d) => { zIndex += d; updateAllViews(); });
  attachWheelScroll('coronalCanvas',  (d) => { yIndex += d; updateAllViews(); });
  attachWheelScroll('sagittalCanvas', (d) => { xIndex += d; updateAllViews(); });

  attachMiddleMouseToggle('axialCanvas');
  attachMiddleMouseToggle('coronalCanvas');
  attachMiddleMouseToggle('sagittalCanvas');

  attachClickNav('axialCanvas', (ix, iy) => {
    xIndex = Math.round(ix);
    yIndex = Math.round(iy);
    updateAllViews();
  });
  attachClickNav('coronalCanvas', (ix, iy) => {
    xIndex = mprVolume.cols - 1 - Math.round(ix);   // un-flip horizontal
    zIndex = Math.round(iy);
    updateAllViews();
  });
  attachClickNav('sagittalCanvas', (ix, iy) => {
    yIndex = mprVolume.rows - 1 - Math.round(ix);   // un-flip horizontal
    zIndex = Math.round(iy);
    updateAllViews();
  });

  updateAllViews();
}

function exitMPR() {
  document.getElementById('mprSection').style.display = 'none';
  document.getElementById('viewerRow').style.display  = 'flex';
}

function applyMPRPreset(wc, ww) {
  mprWC = wc; mprWW = ww;
  updateAllViews();
}

function resetMPRZoom() {
  mprCanvasZoom.axialCanvas = mprCanvasZoom.coronalCanvas = mprCanvasZoom.sagittalCanvas = 1;
  updateAllViews();
}

// ── Keyboard navigation ───────────────────────────────────────────────────────
document.addEventListener('keydown', function(e) {
  if (!mprVolume || document.getElementById('mprSection').style.display === 'none') return;
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;

  let changed = true;
  switch (e.key) {
    case 'ArrowUp':    zIndex--;  break;
    case 'ArrowDown':  zIndex++;  break;
    case 'ArrowLeft':  xIndex--;  break;
    case 'ArrowRight': xIndex++;  break;
    case 'w': case 'W': yIndex--; break;
    case 's': case 'S': yIndex++; break;
    default: changed = false;
  }

  if (changed) { e.preventDefault(); updateAllViews(); }
});

// ── Volume builder ────────────────────────────────────────────────────────────

async function buildVolume(imageIds, onProgress) {
  const images = [];
  for (let i = 0; i < imageIds.length; i++) {
    const image = await cornerstone.loadImage(imageIds[i]);
    images.push(image);
    onProgress(Math.round((i + 1) / imageIds.length * 100));
  }

  // ── Orientation correction: sort descending by z so slice 0 = superior ──
  const zOf = img => {
    const s = img.data && img.data.string('x00200032');
    return s ? (parseFloat(s.split('\\')[2]) || 0) : 0;
  };
  images.sort((a, b) => zOf(b) - zOf(a));

  const rows   = images[0].rows;
  const cols   = images[0].columns;
  const slices = images.length;
  const buffer = new Float32Array(slices * rows * cols);

  for (let s = 0; s < slices; s++) {
    const pixels    = images[s].getPixelData();
    const slope     = images[s].slope     ?? 1;
    const intercept = images[s].intercept ?? 0;
    const offset    = s * rows * cols;
    for (let i = 0; i < pixels.length; i++) {
      buffer[offset + i] = pixels[i] * slope + intercept;
    }
  }

  const sm = (mprSeries && mprSeries.series_metadata) || {};
  const ps = sm.pixel_spacing || [1, 1];

  return {
    buffer, rows, cols, slices,
    rowSpacing:     parseFloat(ps[0])              || 1,
    colSpacing:     parseFloat(ps[1])              || 1,
    sliceThickness: parseFloat(sm.slice_thickness) || 1,
  };
}

// ── Reslicing ─────────────────────────────────────────────────────────────────

function renderAxial(z) {
  const v     = mprVolume;
  const size  = v.rows * v.cols;
  const slice = v.buffer.subarray(z * size, (z + 1) * size);
  const crosshair = {
    x: xIndex / Math.max(1, v.cols - 1),
    y: yIndex / Math.max(1, v.rows - 1),
  };
  renderToCanvas(slice, v.cols, v.rows, 'axialCanvas',
    { left: 'R', right: 'L' },
    crosshair,
    v.cols * v.colSpacing, v.rows * v.rowSpacing);
  document.getElementById('axialLabel').textContent = `AXIAL  —  z ${z + 1} / ${v.slices}`;
}

function renderCoronal(y) {
  const v    = mprVolume;
  const data = new Float32Array(v.slices * v.cols);
  for (let s = 0; s < v.slices; s++) {
    const srcRow = s * v.rows * v.cols + y * v.cols;
    const dstRow = s * v.cols;
    for (let c = 0; c < v.cols; c++) {
      data[dstRow + (v.cols - 1 - c)] = v.buffer[srcRow + c];   // horizontal flip → L on left
    }
  }
  const crosshair = {
    x: (v.cols - 1 - xIndex) / Math.max(1, v.cols - 1),
    y: zIndex / Math.max(1, v.slices - 1),
  };
  renderToCanvas(data, v.cols, v.slices, 'coronalCanvas',
    { left: 'L', right: 'R', top: 'S', bottom: 'I' },
    crosshair,
    v.cols   * v.colSpacing,
    v.slices * v.sliceThickness);
  document.getElementById('coronalLabel').textContent = `CORONAL  —  y ${y + 1} / ${v.rows}`;
}

function renderSagittal(x) {
  const v    = mprVolume;
  const data = new Float32Array(v.slices * v.rows);
  for (let s = 0; s < v.slices; s++) {
    const dstRow = s * v.rows;
    for (let r = 0; r < v.rows; r++) {
      data[dstRow + (v.rows - 1 - r)] = v.buffer[s * v.rows * v.cols + r * v.cols + x];  // horizontal flip → A on right
    }
  }
  const crosshair = {
    x: (v.rows - 1 - yIndex) / Math.max(1, v.rows - 1),
    y: zIndex / Math.max(1, v.slices - 1),
  };
  renderToCanvas(data, v.rows, v.slices, 'sagittalCanvas',
    { left: 'P', right: 'A', top: 'S', bottom: 'I' },
    crosshair,
    v.rows   * v.rowSpacing,
    v.slices * v.sliceThickness);
  document.getElementById('sagittalLabel').textContent = `SAGITTAL  —  x ${x + 1} / ${v.cols}`;
}

// ── Canvas renderer ───────────────────────────────────────────────────────────

function renderToCanvas(pixelData, srcW, srcH, canvasId, labels, crosshair, physW, physH) {
  const canvas = document.getElementById(canvasId);
  const low    = mprWC - mprWW / 2;
  const range  = mprWW;

  const offscreen = new OffscreenCanvas(srcW, srcH);
  const octx      = offscreen.getContext('2d');
  const imgData   = octx.createImageData(srcW, srcH);
  const d         = imgData.data;

  for (let i = 0; i < pixelData.length; i++) {
    const val = Math.max(0, Math.min(255, Math.round(((pixelData[i] - low) / range) * 255)));
    const idx = i * 4;
    d[idx] = d[idx + 1] = d[idx + 2] = val;
    d[idx + 3] = 255;
  }
  octx.putImageData(imgData, 0, 0);

  const ctx = canvas.getContext('2d');
  const dw  = canvas.clientWidth  || canvas.width;
  const dh  = canvas.clientHeight || canvas.height;
  canvas.width  = dw;
  canvas.height = dh;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, dw, dh);

  // ── Aspect ratio correction ───────────────────────────────────────────────
  const physAspect = (physW && physH) ? physW / physH : srcW / srcH;
  let baseW, baseH;
  if (dw / dh > physAspect) { baseH = dh; baseW = dh * physAspect; }
  else                       { baseW = dw; baseH = dw / physAspect; }

  // ── Apply per-canvas zoom (scale from centre) ─────────────────────────────
  const zoom  = mprCanvasZoom[canvasId] || 1;
  const drawW = baseW * zoom;
  const drawH = baseH * zoom;
  const offX  = (dw - drawW) / 2;
  const offY  = (dh - drawH) / 2;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(offscreen, offX, offY, drawW, drawH);

  // Save render geometry for click-to-navigate
  mprViewState[canvasId] = { offX, offY, drawW, drawH, srcW, srcH };

  // ── Crosshair overlay ─────────────────────────────────────────────────────
  if (crosshair) {
    const cx = offX + crosshair.x * drawW;
    const cy = offY + crosshair.y * drawH;

    ctx.save();
    ctx.strokeStyle = 'rgba(0, 210, 255, 0.85)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(cx, offY);  ctx.lineTo(cx, offY + drawH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(offX, cy);  ctx.lineTo(offX + drawW, cy); ctx.stroke();
    ctx.restore();
  }

  // ── Orientation labels ────────────────────────────────────────────────────
  if (labels) {
    const fs = Math.max(13, Math.floor(dw / 22));
    ctx.font         = `bold ${fs}px sans-serif`;
    ctx.fillStyle    = '#ffff00';
    ctx.shadowColor  = '#000';
    ctx.shadowBlur   = 4;
    ctx.textBaseline = 'middle';
    if (labels.left)   { ctx.textAlign = 'left';   ctx.fillText(labels.left,   offX + 6,         offY + drawH / 2); }
    if (labels.right)  { ctx.textAlign = 'right';  ctx.fillText(labels.right,  offX + drawW - 6, offY + drawH / 2); }
    if (labels.top)    { ctx.textAlign = 'center'; ctx.fillText(labels.top,    offX + drawW / 2, offY + fs); }
    if (labels.bottom) { ctx.textAlign = 'center'; ctx.fillText(labels.bottom, offX + drawW / 2, offY + drawH - fs / 2); }
    ctx.shadowBlur = 0;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function initSlider(sliderId, max, initial, onChange) {
  const s   = document.getElementById(sliderId);
  s.min     = 0;
  s.max     = max;
  s.value   = initial;
  s.oninput = () => onChange(parseInt(s.value));
}

// Wheel handler: scroll slices OR zoom the canvas depending on mprWheelMode.
function attachWheelScroll(canvasId, onScrollDelta) {
  const canvas = document.getElementById(canvasId);
  if (canvas._mprWheelHandler) canvas.removeEventListener('wheel', canvas._mprWheelHandler);
  canvas._mprWheelHandler = function(e) {
    e.preventDefault();
    if (mprWheelMode === 'zoom') {
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      mprCanvasZoom[canvasId] = Math.max(0.5, Math.min(8, mprCanvasZoom[canvasId] * factor));
      updateAllViews();
    } else {
      onScrollDelta(e.deltaY > 0 ? 1 : -1);
    }
  };
  canvas.addEventListener('wheel', canvas._mprWheelHandler, { passive: false });
}

// Middle mouse click toggles scroll / zoom mode (mirrors 2D viewer behaviour).
function attachMiddleMouseToggle(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (canvas._mprMiddleHandler) canvas.removeEventListener('mousedown', canvas._mprMiddleHandler);
  canvas._mprMiddleHandler = function(e) {
    if (e.button !== 1) return;
    e.preventDefault();
    mprWheelMode = mprWheelMode === 'scroll' ? 'zoom' : 'scroll';
    updateMPRModeIndicator();
  };
  canvas.addEventListener('mousedown', canvas._mprMiddleHandler);
  // Suppress browser's default middle-click autoscroll on each canvas
  canvas.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
}

function updateMPRModeIndicator() {
  const el = document.getElementById('mprModeIndicator');
  if (!el) return;
  if (mprWheelMode === 'zoom') {
    el.textContent = '🔍 Zoom mode  (middle-click to switch)';
    el.style.color = '#ffd54f';
  } else {
    el.textContent = '↕ Scroll mode  (middle-click to switch)';
    el.style.color = '#aaa';
  }
}

function attachClickNav(canvasId, onImageCoords) {
  const canvas = document.getElementById(canvasId);
  if (canvas._mprClickHandler) canvas.removeEventListener('click', canvas._mprClickHandler);
  canvas._mprClickHandler = function(e) {
    const state = mprViewState[canvasId];
    if (!state) return;
    const rect = canvas.getBoundingClientRect();
    // Map CSS pixels → canvas pixels (handles HiDPI / CSS scaling)
    const cx = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const cy = (e.clientY - rect.top)  * (canvas.height / rect.height);
    // Map canvas pixels → image pixels (zoom already baked into offX/drawW)
    const ix = (cx - state.offX) * state.srcW / state.drawW;
    const iy = (cy - state.offY) * state.srcH / state.drawH;
    if (ix < 0 || iy < 0 || ix >= state.srcW || iy >= state.srcH) return;
    onImageCoords(ix, iy);
  };
  canvas.addEventListener('click', canvas._mprClickHandler);
}

function setMPRProgress(pct) {
  const bar = document.getElementById('mprProgressBar');
  if (bar) bar.style.width = pct + '%';
}
