// mpr-tab-init.js — Bootstrap logic for mpr-tab.html.
//
// 1. Reads ?mode=cpu|gpu from the URL.
// 2. Initialises the Cornerstone WADO loader (needed by mpr.js/buildVolume).
// 3. For GPU mode, dynamically loads gpu-volume.js and gpu-slice.js.
// 4. Signals the opener tab that this page is ready.
// 5. Receives the volume payload ({imageIds, series, wc, ww}) via postMessage.
// 6. Calls showMPRView() — defined in mpr.js — to build and render the volume.

(async function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const mode   = params.get('mode') === 'gpu' ? 'gpu' : 'cpu';

  // Label the mode badge
  const badge = document.getElementById('mprModeBadge');
  if (badge) {
    badge.textContent = mode === 'gpu' ? 'GPU MPR' : 'CPU MPR';
    badge.className   = mode;
  }
  document.title = (mode === 'gpu' ? 'GPU' : 'CPU') + ' MPR — DICOM';

  // ── Cornerstone WADO initialisation ──────────────────────────────────────
  // mpr.js uses cornerstone.loadImage() inside buildVolume(). The WADO loader
  // must be wired up before any loadImage call is made.
  cornerstoneWADOImageLoader.external.cornerstone  = cornerstone;
  cornerstoneWADOImageLoader.external.dicomParser  = dicomParser;
  cornerstoneWADOImageLoader.webWorkerManager.initialize({
    webWorkerPath: 'https://unpkg.com/cornerstone-wado-image-loader/dist/cornerstoneWADOImageLoaderWebWorker.js',
    taskConfiguration: {
      decodeTask: {
        codecsPath: 'https://unpkg.com/cornerstone-wado-image-loader/dist/cornerstoneWADOImageLoaderCodecs.js',
      },
    },
  });

  // ── Dynamic GPU script loading ────────────────────────────────────────────
  // Load before showMPRView() so gpuVolume/gpuSlice globals are available.
  if (mode === 'gpu') {
    await loadScript('gpu-volume.js').catch(e => {
      console.warn('mpr-tab: failed to load gpu-volume.js —', e.message);
    });
    await loadScript('gpu-slice.js').catch(e => {
      console.warn('mpr-tab: failed to load gpu-slice.js —', e.message);
    });
  }

  // ── Signal readiness to opener ────────────────────────────────────────────
  if (!window.opener) {
    document.getElementById('mprTabWaitMsg').textContent =
      'Open this page from the DICOM viewer (do not navigate here directly).';
    return;
  }
  window.opener.postMessage({ type: 'mpr-ready' }, '*');

  // ── Receive volume payload ────────────────────────────────────────────────
  window.addEventListener('message', async function handler(e) {
    if (!e.data || e.data.type !== 'mpr-data') return;
    window.removeEventListener('message', handler);

    const { imageIds, series, wc, ww } = e.data;

    // Store the CT series UID for RTSTRUCT export.
    window._mprSeriesUid = series && series.uid ? series.uid : '';

    document.getElementById('mprTabWaiting').style.display = 'none';

    await showMPRView(series, imageIds, wc, ww);

    // Attach ROI drawing + editing listeners now that canvases exist.
    if (typeof mprRoi !== 'undefined') mprRoi.init();
  });

  // ── Helper ───────────────────────────────────────────────────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s   = document.createElement('script');
      s.src     = src;
      s.onload  = resolve;
      s.onerror = () => reject(new Error(src));
      document.head.appendChild(s);
    });
  }

})();

// ── MPR ROI glue functions ────────────────────────────────────────────────────
// These live outside the IIFE so they are accessible from inline onclick attrs.

function toggleMprEdit() {
  const active = mprRoi.toggleEditMode();
  const btn = document.getElementById('mprRoiEditBtn');
  if (btn) {
    btn.textContent       = active ? '◼ Stop Editing' : '✎ Edit ROI';
    btn.style.color       = active ? '#80cbc4' : '#ccc';
    btn.style.borderColor = active ? '#4db6ac' : '#444';
  }
  // Reset draw button label if edit mode forced draw off.
  if (active) {
    const drawBtn = document.getElementById('mprRoiDrawBtn');
    if (drawBtn) {
      drawBtn.textContent       = '✏ Draw ROI';
      drawBtn.style.color       = '#ccc';
      drawBtn.style.borderColor = '#444';
    }
  }
}

async function showMprLoadPicker() {
  const select = document.getElementById('mprRoiFileSelect');
  const files  = await roiSave.loadList();

  if (!files.length) {
    alert('No saved ROI files found.\nSave your ROIs first using "↑ Save ROIs".');
    return;
  }

  select.innerHTML =
    '<option value="">— select file to load —</option>' +
    files.map(f => `<option value="${f}">${f}</option>`).join('');

  // Toggle visibility.
  select.style.display = select.style.display === 'none' ? 'block' : 'none';
  // Hide export picker if open.
  const exp = document.getElementById('mprRoiExportSelect');
  if (exp) exp.style.display = 'none';
}

async function loadSelectedMprRoi() {
  const select   = document.getElementById('mprRoiFileSelect');
  const filename = select.value;
  if (!filename) return;

  const record = await roiSave.load(filename);
  if (!record || !Array.isArray(record.rois)) {
    alert('Failed to load ROI file.');
    return;
  }

  // importRois filters to MPR-sourced entries (those with canvasId set).
  mprRoi.importRois(record.rois);
  select.style.display = 'none';
  select.value         = '';
}

async function showMprExportPicker() {
  const select = document.getElementById('mprRoiExportSelect');
  const files  = await roiSave.loadList();

  if (!files.length) {
    alert('No saved ROI files found.\nSave your ROIs first using "↑ Save ROIs".');
    return;
  }

  select.innerHTML =
    '<option value="">— select file to export —</option>' +
    files.map(f => `<option value="${f}">${f}</option>`).join('');

  select.style.display = select.style.display === 'none' ? 'block' : 'none';
  // Hide load picker if open.
  const load = document.getElementById('mprRoiFileSelect');
  if (load) load.style.display = 'none';
}

async function exportSelectedMprRoi() {
  const select   = document.getElementById('mprRoiExportSelect');
  const filename = select.value;
  if (!filename) return;

  await roiSave.exportRtstruct(filename, window._mprSeriesUid ?? '');
  select.style.display = 'none';
  select.value         = '';
}

// ── Auto-segmentation glue ────────────────────────────────────────────────────
//
// Lung segmentation requires two user seed points (left then right lung).
// Heart segmentation is fully automatic — it runs its own internal lung
// detection to find the mediastinum.
//
// Seed-picker state machine:
//   _segPickState === null        — idle
//   _segPickState === 'left'      — waiting for left-lung click
//   _segPickState === 'right'     — waiting for right-lung click (left already saved)
//
// The click handler is attached once (on first startLungSeedPicker call)
// and delegates to _handleSeedClick() which checks _segPickState.

const SEG_API = 'http://127.0.0.1:8000';

// Auto-segmentation structure colours.
const SEG_COLORS = {
  'Left Lung':  '#4fc3f7',
  'Right Lung': '#81c784',
  'Heart':      '#ef5350',
};

let _segPickState = null;   // null | 'left' | 'right'
let _segSeedLeft  = null;   // {slice, col, row}
let _segListening = false;  // click handler attached to axialCanvas?

function _segStatus(msg, color = '#aaa') {
  const el = document.getElementById('mprSegStatus');
  if (!el) return;
  el.style.display     = msg ? 'block' : 'none';
  el.style.borderColor = color;
  el.textContent       = msg;
}

function _segBtnDisable(disabled) {
  const lb = document.getElementById('mprSegLungBtn');
  const hb = document.getElementById('mprSegHeartBtn');
  if (lb) lb.disabled = disabled;
  if (hb) hb.disabled = disabled;
}

/**
 * Called when the user clicks inside the axial canvas while the seed-picker
 * is active.  Reads the image-space coordinates from the click event.
 */
function _handleSeedClick(e) {
  if (!_segPickState) return;
  e.stopPropagation();

  // Convert click → image-space coords (same as mprRoi._fromEvent).
  const canvas = document.getElementById('axialCanvas');
  const state  = mprViewState && mprViewState['axialCanvas'];
  if (!canvas || !state) return;

  const rect = canvas.getBoundingClientRect();
  const cx   = (e.clientX - rect.left) * (canvas.width  / rect.width);
  const cy   = (e.clientY - rect.top)  * (canvas.height / rect.height);
  const col  = Math.round((cx - state.offX) * state.srcW / state.drawW);
  const row  = Math.round((cy - state.offY) * state.srcH / state.drawH);

  if (col < 0 || row < 0 || col >= state.srcW || row >= state.srcH) return;

  const seed = { slice: zIndex, col, row };

  if (_segPickState === 'left') {
    _segSeedLeft  = seed;
    _segPickState = 'right';
    _segStatus('Seed 1 recorded. Now click inside the RIGHT lung.', '#81c784');
  } else if (_segPickState === 'right') {
    _segPickState = null;
    _detachSeedListener();
    _runLungSegmentation(_segSeedLeft, seed);
  }
}

function _attachSeedListener() {
  if (_segListening) return;
  const canvas = document.getElementById('axialCanvas');
  if (canvas) canvas.addEventListener('click', _handleSeedClick, true);
  _segListening = true;
}

function _detachSeedListener() {
  const canvas = document.getElementById('axialCanvas');
  if (canvas) canvas.removeEventListener('click', _handleSeedClick, true);
  _segListening = false;
}

/** Start the two-click seed-picking flow for lung segmentation. */
function startLungSeedPicker() {
  if (typeof mprRoi === 'undefined') return;
  _segPickState = 'left';
  _segSeedLeft  = null;
  _segStatus('Click inside the LEFT lung on the axial view.', '#4fc3f7');
  _segBtnDisable(true);
  _attachSeedListener();
}

/** Cancel any in-progress seed-picking or segmentation. */
function cancelSegPicker() {
  _segPickState = null;
  _segSeedLeft  = null;
  _detachSeedListener();
  _segStatus('');
  _segBtnDisable(false);
}

/** POST /segment-lungs and import results. */
async function _runLungSegmentation(seedLeft, seedRight) {
  _segStatus('Segmenting lungs… (may take a few seconds)', '#4fc3f7');
  try {
    const res = await fetch(`${SEG_API}/segment-lungs`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        series_uid:  window._mprSeriesUid ?? '',
        seed_left:  [seedLeft.slice,  seedLeft.col,  seedLeft.row],
        seed_right: [seedRight.slice, seedRight.col, seedRight.row],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    const total = _importSegResults({
      'Left Lung':  data.left_lung,
      'Right Lung': data.right_lung,
    });
    _segStatus(`Lungs segmented — ${total} contours loaded.`, '#81c784');
  } catch (err) {
    _segStatus(`Lung segmentation failed: ${err.message}`, '#f44');
  } finally {
    _segBtnDisable(false);
  }
}

/** POST /segment-heart and import results. */
async function runHeartSegmentation() {
  if (typeof mprRoi === 'undefined') return;
  _segBtnDisable(true);
  _segStatus('Segmenting heart… (auto-detects lungs first, may take ~10 s)', '#ef5350');
  try {
    const res = await fetch(`${SEG_API}/segment-heart`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ series_uid: window._mprSeriesUid ?? '' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    const total = _importSegResults({ 'Heart': data.heart });
    _segStatus(`Heart segmented — ${total} contours loaded.`, '#ef5350');
  } catch (err) {
    _segStatus(`Heart segmentation failed: ${err.message}`, '#f44');
  } finally {
    _segBtnDisable(false);
  }
}

/**
 * Convert segmentation results to roiStore/mprRoi format and import.
 * structureMap: { 'Left Lung': [{slice, points}, ...], ... }
 * Returns total contour count.
 */
function _importSegResults(structureMap) {
  const rois = [];
  for (const [name, contours] of Object.entries(structureMap)) {
    const color = SEG_COLORS[name] ?? '#ffcc44';
    for (const c of (contours ?? [])) {
      rois.push({
        id:         Date.now() + Math.random(),
        name,
        slice:      c.slice,
        points:     c.points,            // already [[col, row], ...]
        color,
        source:     'auto-segment',
        plane:      'axial',
        canvasId:   'axialCanvas',
        planeIndex: c.slice,
      });
    }
  }
  if (rois.length) mprRoi.importRois(rois);
  return rois.length;
}

// ── Interpolation glue ────────────────────────────────────────────────────────

/**
 * Pick a structure name (auto-select if only one candidate), then call
 * mprRoi.interpolate() to fill all intermediate axial slices.
 */
async function runMprInterpolate() {
  const names = mprRoi.getInterpolatable();
  if (!names.length) {
    alert('No structures have 2 or more axial key frames.\nDraw ROIs with the same name on at least 2 different Z slices.');
    return;
  }

  const chosen = await _pickInterpStructure(names);
  if (!chosen) return;

  const count = mprRoi.interpolate(chosen);
  if (count === 0) {
    alert(`"${chosen}": key frames are on adjacent slices — nothing to fill.`);
  } else {
    alert(`Added ${count} interpolated contour(s) for "${chosen}".`);
  }
}

/**
 * Pick a structure name, then remove all its interpolated contours while
 * leaving the hand-drawn key frames intact.
 */
async function runMprClearInterpolated() {
  const names = mprRoi.getInterpolatable();
  if (!names.length) {
    alert('No interpolatable structures found.');
    return;
  }

  const chosen = await _pickInterpStructure(names);
  if (!chosen) return;

  mprRoi.clearInterpolated(chosen);
}

/**
 * Show the shared structure-picker <select> and resolve with the chosen name.
 * Auto-selects if only one candidate.  Resolves null if the user dismisses.
 */
async function _pickInterpStructure(names) {
  if (names.length === 1) return names[0];

  const select = document.getElementById('mprInterpStructSelect');
  // Hide the file pickers so they don't overlap.
  const loadSel   = document.getElementById('mprRoiFileSelect');
  const exportSel = document.getElementById('mprRoiExportSelect');
  if (loadSel)   loadSel.style.display   = 'none';
  if (exportSel) exportSel.style.display = 'none';

  select.innerHTML =
    '<option value="">— select structure —</option>' +
    names.map(n => `<option value="${n}">${n}</option>`).join('');
  select.style.display = 'block';

  return new Promise(resolve => {
    function onchange() {
      select.removeEventListener('change', onchange);
      select.style.display = 'none';
      resolve(select.value || null);
      select.value = '';
    }
    select.addEventListener('change', onchange);
  });
}
