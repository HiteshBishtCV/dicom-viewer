// ── MPR (Multi-Planar Reconstruction) ────────────────────────────────────────

// ── Volume ───────────────────────────────────────────────────────────────────
let mprVolume = null;
let mprSeries = null;
let mprWC     = 40;
let mprWW     = 400;

// ── Shared indices (core of MPR) ─────────────────────────────────────────────
// These represent the current intersection point in 3D space.
// Every input source (slider, wheel, keyboard) writes to these
// and calls updateAllViews() — nothing renders directly.
let xIndex = 0;   // sagittal plane position  (0 … cols-1)
let yIndex = 0;   // coronal  plane position  (0 … rows-1)
let zIndex = 0;   // axial    slice  position  (0 … slices-1)

// ── Centralized rendering engine ─────────────────────────────────────────────
function updateAllViews() {
  if (!mprVolume) return;

  const v = mprVolume;

  // Clamp to valid range
  xIndex = Math.max(0, Math.min(v.cols   - 1, xIndex));
  yIndex = Math.max(0, Math.min(v.rows   - 1, yIndex));
  zIndex = Math.max(0, Math.min(v.slices - 1, zIndex));

  // Sync all sliders
  document.getElementById('axialSlider').value    = zIndex;
  document.getElementById('coronalSlider').value  = yIndex;
  document.getElementById('sagittalSlider').value = xIndex;

  // Re-render all three planes
  renderAxial(zIndex);
  renderCoronal(yIndex);
  renderSagittal(xIndex);
}

// ── Public API ────────────────────────────────────────────────────────────────

async function showMPRView(series, imageIds) {
  mprSeries = series;

  // Sync W/L from the 2D viewer
  const vp = cornerstone.getViewport(document.getElementById('dicomImage'));
  if (vp) { mprWC = Math.round(vp.voi.windowCenter); mprWW = Math.round(vp.voi.windowWidth); }

  document.getElementById('viewerRow').style.display  = 'none';
  document.getElementById('mprSection').style.display = 'block';
  setMPRProgress(0);

  mprVolume = await buildVolume(imageIds, setMPRProgress);

  // Start at midpoint
  xIndex = Math.floor(mprVolume.cols   / 2);
  yIndex = Math.floor(mprVolume.rows   / 2);
  zIndex = Math.floor(mprVolume.slices / 2);

  // Wire up sliders — each writes its index and calls updateAllViews()
  initSlider('axialSlider',    mprVolume.slices - 1, zIndex, v => { zIndex = v; updateAllViews(); });
  initSlider('coronalSlider',  mprVolume.rows   - 1, yIndex, v => { yIndex = v; updateAllViews(); });
  initSlider('sagittalSlider', mprVolume.cols   - 1, xIndex, v => { xIndex = v; updateAllViews(); });

  // Wire up mouse-wheel on each canvas
  attachWheelScroll('axialCanvas',    () => { zIndex += arguments[0]; updateAllViews(); });
  attachWheelScroll('coronalCanvas',  () => { yIndex += arguments[0]; updateAllViews(); });
  attachWheelScroll('sagittalCanvas', () => { xIndex += arguments[0]; updateAllViews(); });

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

// ── Keyboard navigation ───────────────────────────────────────────────────────
// Arrow Up/Down  → axial (z)        move through slices
// Arrow Left/Right → sagittal (x)   move left/right
// W / S          → coronal (y)      move anterior/posterior
document.addEventListener('keydown', function(e) {
  if (!mprVolume || document.getElementById('mprSection').style.display === 'none') return;

  // Don't hijack input fields
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

  if (changed) {
    e.preventDefault();
    updateAllViews();
  }
});

// ── Volume builder ────────────────────────────────────────────────────────────

async function buildVolume(imageIds, onProgress) {
  const images = [];
  for (let i = 0; i < imageIds.length; i++) {
    const image = await cornerstone.loadImage(imageIds[i]);
    images.push(image);
    onProgress(Math.round((i + 1) / imageIds.length * 100));
  }

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
  const v    = mprVolume;
  const size = v.rows * v.cols;
  const slice = v.buffer.subarray(z * size, (z + 1) * size);
  renderToCanvas(slice, v.cols, v.rows, 'axialCanvas', { left: 'R', right: 'L' });
  document.getElementById('axialLabel').textContent = `AXIAL  —  z ${z + 1} / ${v.slices}`;
}

function renderCoronal(y) {
  const v    = mprVolume;
  const data = new Float32Array(v.slices * v.cols);
  for (let s = 0; s < v.slices; s++) {
    const srcRow = s * v.rows * v.cols + y * v.cols;
    const dstRow = s * v.cols;
    for (let c = 0; c < v.cols; c++) {
      data[dstRow + (v.cols - 1 - c)] = v.buffer[srcRow + c];  // horizontal flip
    }
  }
  renderToCanvas(data, v.cols, v.slices, 'coronalCanvas',
    { left: 'L', right: 'R', top: 'S', bottom: 'I' });
  document.getElementById('coronalLabel').textContent = `CORONAL  —  y ${y + 1} / ${v.rows}`;
}

function renderSagittal(x) {
  const v    = mprVolume;
  const data = new Float32Array(v.slices * v.rows);
  for (let s = 0; s < v.slices; s++) {
    const dstRow = s * v.rows;
    for (let r = 0; r < v.rows; r++) {
      data[dstRow + (v.rows - 1 - r)] = v.buffer[s * v.rows * v.cols + r * v.cols + x]; // horizontal flip
    }
  }
  renderToCanvas(data, v.rows, v.slices, 'sagittalCanvas',
    { left: 'P', right: 'A', top: 'S', bottom: 'I' });
  document.getElementById('sagittalLabel').textContent = `SAGITTAL  —  x ${x + 1} / ${v.cols}`;
}

// ── Canvas renderer ───────────────────────────────────────────────────────────

function renderToCanvas(pixelData, srcW, srcH, canvasId, labels) {
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

  const scale = Math.min(dw / srcW, dh / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const offX  = (dw - drawW) / 2;
  const offY  = (dh - drawH) / 2;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(offscreen, offX, offY, drawW, drawH);

  if (labels) {
    const fs = Math.max(13, Math.floor(dw / 22));
    ctx.font         = `bold ${fs}px sans-serif`;
    ctx.fillStyle    = '#ffff00';
    ctx.shadowColor  = '#000';
    ctx.shadowBlur   = 4;
    ctx.textBaseline = 'middle';
    if (labels.left)   { ctx.textAlign = 'left';   ctx.fillText(labels.left,   offX + 6,          offY + drawH / 2); }
    if (labels.right)  { ctx.textAlign = 'right';  ctx.fillText(labels.right,  offX + drawW - 6,  offY + drawH / 2); }
    if (labels.top)    { ctx.textAlign = 'center'; ctx.fillText(labels.top,    offX + drawW / 2,  offY + fs); }
    if (labels.bottom) { ctx.textAlign = 'center'; ctx.fillText(labels.bottom, offX + drawW / 2,  offY + drawH - fs / 2); }
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

function attachWheelScroll(canvasId, onDelta) {
  document.getElementById(canvasId).addEventListener('wheel', function(e) {
    e.preventDefault();
    onDelta(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
}

function setMPRProgress(pct) {
  const bar = document.getElementById('mprProgressBar');
  if (bar) bar.style.width = pct + '%';
}
