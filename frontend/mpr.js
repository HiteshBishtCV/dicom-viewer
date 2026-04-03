// ── MPR (Multi-Planar Reconstruction) ────────────────────────────────────────

// ── Volume ───────────────────────────────────────────────────────────────────
let mprVolume = null;
let mprSeries = null;
let mprWC     = 40;
let mprWW     = 400;

// ── GPU slice renderer ────────────────────────────────────────────────────────
let _gpuHandle   = null;   // GpuVolumeHandle from gpu-volume.js
let _gpuRenderer = null;   // SliceRenderer   from gpu-slice.js

function _setCPUCanvasVisibility(visible) {
  ['axialCanvas', 'coronalCanvas', 'sagittalCanvas'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? '' : 'none';
  });
}

// ── Shared indices ────────────────────────────────────────────────────────────
let xIndex = 0;   // sagittal plane position  (0 … cols-1)
let yIndex = 0;   // coronal  plane position  (0 … rows-1)
let zIndex = 0;   // axial    slice  position  (0 … slices-1)

// ── Per-canvas render geometry — populated each frame, used by click handler ─
const mprViewState = {};

// ── Zoom state ────────────────────────────────────────────────────────────────
let mprWheelMode = 'scroll';   // 'scroll' | 'zoom'
const mprCanvasZoom = { axialCanvas: 1, coronalCanvas: 1, sagittalCanvas: 1 };

// ── Performance: image cache ─────────────────────────────────────────────────
// Keeps decoded Cornerstone image objects alive between MPR sessions so
// re-entering MPR never re-fetches or re-decodes slices.
const _imageCache = new Map();   // imageId → cornerstone image

async function _loadImage(imageId) {
  if (_imageCache.has(imageId)) return _imageCache.get(imageId);
  const img = await cornerstone.loadImage(imageId);
  _imageCache.set(imageId, img);
  return img;
}

// ── Performance: volume cache ─────────────────────────────────────────────────
// Keyed by first imageId + slice count. Same series → instant return.
// Invalidated automatically when a different series is opened.
let _volumeCache    = null;
let _volumeCacheKey = '';

function _volumeKey(imageIds) {
  return imageIds[0] + ':' + imageIds.length;
}

// ── Performance: rAF gate ─────────────────────────────────────────────────────
// Multiple synchronous calls to updateAllViews() within one event-loop tick
// (e.g. rapid key-repeat, wheel bursts) collapse into a single paint call.
let _rafPending = false;

// ── Centralized rendering engine ──────────────────────────────────────────────
function updateAllViews() {
  if (!mprVolume || _rafPending) return;
  _rafPending = true;
  requestAnimationFrame(_doRender);
}

function _doRender() {
  _rafPending = false;
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

async function showMPRView(series, imageIds, wc, ww) {
  mprSeries = series;

  // Read W/L from Cornerstone viewport when available (main viewer tab).
  const dicomEl = document.getElementById('dicomImage');
  if (dicomEl) {
    const vp = cornerstone.getViewport(dicomEl);
    if (vp) { mprWC = Math.round(vp.voi.windowCenter); mprWW = Math.round(vp.voi.windowWidth); }
  }
  // Caller-supplied values override (used by mpr-tab to pass the current W/L).
  if (wc !== undefined) mprWC = wc;
  if (ww !== undefined) mprWW = ww;

  const viewerRow = document.getElementById('viewerRow');
  if (viewerRow) viewerRow.style.display = 'none';   // absent in the MPR tab
  document.getElementById('mprSection').style.display = 'block';
  setMPRProgress(0);

  // Ensure CPU canvases are visible at the start of every session.
  // They will be hidden below if the GPU renderer initialises successfully.
  _setCPUCanvasVisibility(true);

  mprVolume = await buildVolume(imageIds, setMPRProgress);

  // ── GPU texture upload ────────────────────────────────────────────────────
  // Tear down any previous renderer (different series / re-entry).
  if (_gpuRenderer) { _gpuRenderer.destroy(); _gpuRenderer = null; }
  if (_gpuHandle)   { _gpuHandle = null; }

  if (typeof gpuVolume !== 'undefined') {
    _gpuHandle   = gpuVolume.uploadVolumeToGPU(mprVolume);   // null on no-GPU machines
    _gpuRenderer = gpuSlice.init(_gpuHandle);                // null if upload failed
  }

  // When GPU is active it owns all W/L computation; hide the CPU canvases so
  // the panes show only the GPU output (no stale/duplicate views).
  if (_gpuRenderer) _setCPUCanvasVisibility(false);

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
  const viewerRow = document.getElementById('viewerRow');
  if (viewerRow) viewerRow.style.display = 'flex';
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
  // Return cached volume if it's the same series
  const key = _volumeKey(imageIds);
  if (_volumeCache && _volumeCacheKey === key) {
    onProgress(100);
    return _volumeCache;
  }

  const images = [];
  for (let i = 0; i < imageIds.length; i++) {
    images.push(await _loadImage(imageIds[i]));   // served from _imageCache after first load
    onProgress(Math.round((i + 1) / imageIds.length * 100));
  }

  // Orientation correction: sort descending by z so slice 0 = most superior
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

  const volume = {
    buffer, rows, cols, slices,
    rowSpacing:     parseFloat(ps[0])              || 1,
    colSpacing:     parseFloat(ps[1])              || 1,
    sliceThickness: parseFloat(sm.slice_thickness) || 1,
    // Action 4 — pre-allocated reslice buffers; reused every render frame
    // instead of allocating new Float32Arrays that trigger GC.
    _coronalBuf:  new Float32Array(slices * cols),
    _sagittalBuf: new Float32Array(slices * rows),
  };

  _volumeCache    = volume;
  _volumeCacheKey = key;
  return volume;
}

// ── Reslicing ─────────────────────────────────────────────────────────────────

function renderAxial(z) {
  const v = mprVolume;
  document.getElementById('axialLabel').textContent = `AXIAL  —  z ${z + 1} / ${v.slices}`;

  // GPU path: W/L is applied entirely in the fragment shader via uniforms.
  // Early-return skips the CPU pixel loop below — no JS W/L computation.
  if (_gpuRenderer) { _gpuRenderer.renderAxial(z, mprWC, mprWW); return; }

  // CPU fallback (only reached when GPU is unavailable).
  const size  = v.rows * v.cols;
  const slice = v.buffer.subarray(z * size, (z + 1) * size);
  renderToCanvas(slice, v.cols, v.rows, 'axialCanvas',
    { left: 'R', right: 'L' },
    { x: xIndex / Math.max(1, v.cols - 1), y: yIndex / Math.max(1, v.rows - 1) },
    v.cols * v.colSpacing, v.rows * v.rowSpacing);
}

function renderCoronal(y) {
  const v = mprVolume;
  document.getElementById('coronalLabel').textContent = `CORONAL  —  y ${y + 1} / ${v.rows}`;

  if (_gpuRenderer) { _gpuRenderer.renderCoronal(y, mprWC, mprWW); return; }

  // CPU fallback.
  const data = v._coronalBuf;
  for (let s = 0; s < v.slices; s++) {
    const srcRow = s * v.rows * v.cols + y * v.cols;
    const dstRow = s * v.cols;
    for (let c = 0; c < v.cols; c++) {
      data[dstRow + (v.cols - 1 - c)] = v.buffer[srcRow + c];   // horizontal flip → L on left
    }
  }
  renderToCanvas(data, v.cols, v.slices, 'coronalCanvas',
    { left: 'L', right: 'R', top: 'S', bottom: 'I' },
    { x: (v.cols - 1 - xIndex) / Math.max(1, v.cols - 1), y: zIndex / Math.max(1, v.slices - 1) },
    v.cols   * v.colSpacing,
    v.slices * v.sliceThickness);
}

function renderSagittal(x) {
  const v = mprVolume;
  document.getElementById('sagittalLabel').textContent = `SAGITTAL  —  x ${x + 1} / ${v.cols}`;

  if (_gpuRenderer) { _gpuRenderer.renderSagittal(x, mprWC, mprWW); return; }

  // CPU fallback.
  const data = v._sagittalBuf;
  for (let s = 0; s < v.slices; s++) {
    const dstRow = s * v.rows;
    for (let r = 0; r < v.rows; r++) {
      data[dstRow + (v.rows - 1 - r)] = v.buffer[s * v.rows * v.cols + r * v.cols + x];  // horizontal flip → A on right
    }
  }
  renderToCanvas(data, v.rows, v.slices, 'sagittalCanvas',
    { left: 'P', right: 'A', top: 'S', bottom: 'I' },
    { x: (v.rows - 1 - yIndex) / Math.max(1, v.rows - 1), y: zIndex / Math.max(1, v.slices - 1) },
    v.rows   * v.rowSpacing,
    v.slices * v.sliceThickness);
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

  // Aspect ratio correction
  const physAspect = (physW && physH) ? physW / physH : srcW / srcH;
  let baseW, baseH;
  if (dw / dh > physAspect) { baseH = dh; baseW = dh * physAspect; }
  else                       { baseW = dw; baseH = dw / physAspect; }

  // Per-canvas zoom (scale from centre)
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

  // Crosshair overlay
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

  // Orientation labels
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
    const cx = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const cy = (e.clientY - rect.top)  * (canvas.height / rect.height);
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
