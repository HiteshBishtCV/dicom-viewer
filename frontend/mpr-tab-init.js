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
