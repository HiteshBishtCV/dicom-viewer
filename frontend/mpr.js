// ── MPR (Multi-Planar Reconstruction) ────────────────────────────────────────
// Builds a 3D Float32Array volume from loaded DICOM slices, then reslices
// on demand into axial, coronal and sagittal planes rendered on <canvas>.

let mprVolume   = null;   // volume object (see buildVolume)
let mprWC       = 40;     // window center for MPR rendering
let mprWW       = 400;    // window width  for MPR rendering
let mprSeries   = null;   // series object passed from app.js

// ── Public API ────────────────────────────────────────────────────────────────

async function showMPRView(series, imageIds) {
  mprSeries = series;

  // Sync W/L from the main viewer if available
  const vp = cornerstone.getViewport(document.getElementById('dicomImage'));
  if (vp) { mprWC = Math.round(vp.voi.windowCenter); mprWW = Math.round(vp.voi.windowWidth); }

  document.getElementById('viewerRow').style.display  = 'none';
  document.getElementById('mprSection').style.display = 'block';
  setMPRProgress(0);

  mprVolume = await buildVolume(imageIds, setMPRProgress);

  // Initialise sliders at midpoint
  const midZ = Math.floor(mprVolume.slices / 2);
  const midY = Math.floor(mprVolume.rows   / 2);
  const midX = Math.floor(mprVolume.cols   / 2);

  initSlider('axialSlider',    mprVolume.slices - 1, midZ, v => renderAxial(v));
  initSlider('coronalSlider',  mprVolume.rows   - 1, midY, v => renderCoronal(v));
  initSlider('sagittalSlider', mprVolume.cols   - 1, midX, v => renderSagittal(v));

  attachWheelScroll('axialCanvas',    'axialSlider',    mprVolume.slices - 1, v => renderAxial(v));
  attachWheelScroll('coronalCanvas',  'coronalSlider',  mprVolume.rows   - 1, v => renderCoronal(v));
  attachWheelScroll('sagittalCanvas', 'sagittalSlider', mprVolume.cols   - 1, v => renderSagittal(v));

  renderAxial(midZ);
  renderCoronal(midY);
  renderSagittal(midX);
}

function exitMPR() {
  document.getElementById('mprSection').style.display = 'none';
  document.getElementById('viewerRow').style.display  = 'flex';
}

function applyMPRPreset(wc, ww) {
  mprWC = wc; mprWW = ww;
  rerenderAll();
}

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
      buffer[offset + i] = pixels[i] * slope + intercept;  // → HU values
    }
  }

  const sm = (mprSeries && mprSeries.series_metadata) || {};
  const ps = sm.pixel_spacing || [1, 1];

  return {
    buffer,
    rows,
    cols,
    slices,
    rowSpacing:      parseFloat(ps[0])              || 1,
    colSpacing:      parseFloat(ps[1])              || 1,
    sliceThickness:  parseFloat(sm.slice_thickness) || 1,
  };
}

// ── Reslicing ─────────────────────────────────────────────────────────────────

function renderAxial(z) {
  if (!mprVolume) return;
  const v    = mprVolume;
  const size = v.rows * v.cols;
  const slice = v.buffer.subarray(z * size, (z + 1) * size);
  renderToCanvas(slice, v.cols, v.rows, 'axialCanvas');
  document.getElementById('axialLabel').textContent = `AXIAL  —  z ${z + 1} / ${v.slices}`;
}

function renderCoronal(y) {
  if (!mprVolume) return;
  const v    = mprVolume;
  const data = new Float32Array(v.slices * v.cols);
  for (let s = 0; s < v.slices; s++) {
    const srcRow = s * v.rows * v.cols + y * v.cols;
    const dstRow = (v.slices - 1 - s) * v.cols;   // flip z → superior up
    for (let c = 0; c < v.cols; c++) {
      data[dstRow + c] = v.buffer[srcRow + c];
    }
  }
  renderToCanvas(data, v.cols, v.slices, 'coronalCanvas');
  document.getElementById('coronalLabel').textContent = `CORONAL  —  y ${y + 1} / ${v.rows}`;
}

function renderSagittal(x) {
  if (!mprVolume) return;
  const v    = mprVolume;
  const data = new Float32Array(v.slices * v.rows);
  for (let s = 0; s < v.slices; s++) {
    const dstRow = (v.slices - 1 - s) * v.rows;   // flip z → superior up
    for (let r = 0; r < v.rows; r++) {
      data[dstRow + r] = v.buffer[s * v.rows * v.cols + r * v.cols + x];
    }
  }
  renderToCanvas(data, v.rows, v.slices, 'sagittalCanvas');
  document.getElementById('sagittalLabel').textContent = `SAGITTAL  —  x ${x + 1} / ${v.cols}`;
}

// ── Canvas renderer ───────────────────────────────────────────────────────────

function renderToCanvas(pixelData, srcW, srcH, canvasId) {
  const canvas = document.getElementById(canvasId);
  const low    = mprWC - mprWW / 2;
  const range  = mprWW;

  // Build ImageData at native resolution
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

  // Scale-to-fit into display canvas, preserving aspect ratio
  const ctx    = canvas.getContext('2d');
  const dw     = canvas.clientWidth  || canvas.width;
  const dh     = canvas.clientHeight || canvas.height;
  canvas.width  = dw;
  canvas.height = dh;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, dw, dh);

  const scale  = Math.min(dw / srcW, dh / srcH);
  const drawW  = srcW * scale;
  const drawH  = srcH * scale;
  const offX   = (dw - drawW) / 2;
  const offY   = (dh - drawH) / 2;

  ctx.imageSmoothingEnabled  = true;
  ctx.imageSmoothingQuality  = 'high';
  ctx.drawImage(offscreen, offX, offY, drawW, drawH);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function initSlider(sliderId, max, initial, onChange) {
  const s  = document.getElementById(sliderId);
  s.min    = 0;
  s.max    = max;
  s.value  = initial;
  s.oninput = () => onChange(parseInt(s.value));
}

function attachWheelScroll(canvasId, sliderId, max, onChange) {
  document.getElementById(canvasId).addEventListener('wheel', function(e) {
    e.preventDefault();
    const s   = document.getElementById(sliderId);
    const val = Math.max(0, Math.min(max, parseInt(s.value) + (e.deltaY > 0 ? 1 : -1)));
    s.value   = val;
    onChange(val);
  }, { passive: false });
}

function rerenderAll() {
  renderAxial(parseInt(document.getElementById('axialSlider').value));
  renderCoronal(parseInt(document.getElementById('coronalSlider').value));
  renderSagittal(parseInt(document.getElementById('sagittalSlider').value));
}

function setMPRProgress(pct) {
  const bar = document.getElementById('mprProgressBar');
  if (bar) bar.style.width = pct + '%';
}
