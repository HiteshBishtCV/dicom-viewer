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

    // Hide the waiting overlay; showMPRView will show #mprSection and the
    // progress bar as it builds the volume.
    document.getElementById('mprTabWaiting').style.display = 'none';

    // showMPRView is defined in mpr.js (loaded via <script> tag above).
    await showMPRView(series, imageIds, wc, ww);

    // Attach ROI drawing listeners now that canvases are sized and rendered.
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
