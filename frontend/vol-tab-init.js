// vol-tab-init.js — Bootstrap for vol-tab.html.
//
// 1. Initialises the Cornerstone WADO loader (for image decoding).
// 2. Dynamically loads gpu-volume.js and volume-render.js.
// 3. Signals the opener that the page is ready.
// 4. Receives {imageIds, series, wc, ww} via postMessage.
// 5. Builds the volume, uploads to GPU, inits the ray caster, renders first frame.
// 6. Mouse drag updates theta/phi → re-renders via requestAnimationFrame.

(async function () {
  'use strict';

  // ── Cornerstone WADO init (needed for cornerstone.loadImage in buildVolume) ──
  cornerstoneWADOImageLoader.external.cornerstone = cornerstone;
  cornerstoneWADOImageLoader.external.dicomParser = dicomParser;
  cornerstoneWADOImageLoader.webWorkerManager.initialize({
    webWorkerPath: 'https://unpkg.com/cornerstone-wado-image-loader/dist/cornerstoneWADOImageLoaderWebWorker.js',
    taskConfiguration: {
      decodeTask: {
        codecsPath: 'https://unpkg.com/cornerstone-wado-image-loader/dist/cornerstoneWADOImageLoaderCodecs.js',
      },
    },
  });

  // ── Load GPU scripts ──────────────────────────────────────────────────────
  await loadScript('gpu-volume.js');
  await loadScript('volume-render.js');

  // ── Signal readiness ──────────────────────────────────────────────────────
  if (!window.opener) {
    document.getElementById('loadMsg').textContent =
      'Open this page from the DICOM viewer.';
    return;
  }
  window.opener.postMessage({ type: 'vol-ready' }, '*');

  // ── Wait for volume data ──────────────────────────────────────────────────
  window.addEventListener('message', async function handler(e) {
    if (!e.data || e.data.type !== 'vol-data') return;
    window.removeEventListener('message', handler);

    const { imageIds, series, wc, ww } = e.data;

    // ── Build volume (decode DICOM slices) ──────────────────────────────────
    document.getElementById('loadMsg').textContent = 'Decoding slices…';
    const volume = await buildVolume(imageIds, series, pct => {
      document.getElementById('progBar').style.width = pct + '%';
    });

    // ── Upload to GPU ───────────────────────────────────────────────────────
    document.getElementById('loadMsg').textContent = 'Uploading to GPU…';
    const gpuHandle = gpuVolume.uploadVolumeToGPU(volume);
    if (!gpuHandle) {
      document.getElementById('loadMsg').textContent =
        'GPU not available — volume rendering requires WebGL2.';
      return;
    }

    // ── Init ray caster ─────────────────────────────────────────────────────
    const renderer = volumeRender.init(gpuHandle);
    if (!renderer) {
      document.getElementById('loadMsg').textContent =
        'Shader compilation failed — check browser console.';
      return;
    }

    // ── Show viewer ─────────────────────────────────────────────────────────
    document.getElementById('loading').style.display  = 'none';
    document.getElementById('viewer').style.display   = 'flex';

    const canvas = document.getElementById('volCanvas');

    // Initial camera angles and W/L
    let theta = Math.PI / 4;   // 45° azimuth
    let phi   = Math.PI / 3;   // 60° from top (slight elevation)
    let curWC = wc;
    let curWW = ww;

    // rAF gate — prevents queuing multiple renders per frame
    let rafId = null;
    function requestRender() {
      if (!rafId) rafId = requestAnimationFrame(() => {
        rafId = null;
        renderer.render(canvas, curWC, curWW, theta, phi);
        document.getElementById('status').textContent =
          `θ ${(theta * 180 / Math.PI).toFixed(1)}°  φ ${(phi * 180 / Math.PI).toFixed(1)}°`
          + `  |  WC ${Math.round(curWC)}  WW ${Math.round(curWW)}`;
      });
    }

    // First frame
    requestRender();

    // ── Mouse drag to rotate ────────────────────────────────────────────────
    let dragging = false, lastX = 0, lastY = 0;

    canvas.addEventListener('mousedown', e => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      // Horizontal drag → azimuth; vertical drag → elevation
      theta -= (e.clientX - lastX) * 0.01;
      phi   -= (e.clientY - lastY) * 0.01;
      phi    = Math.max(0.05, Math.min(Math.PI - 0.05, phi));
      lastX  = e.clientX;
      lastY  = e.clientY;
      requestRender();
    });
    window.addEventListener('mouseup',    () => { dragging = false; });
    window.addEventListener('mouseleave', () => { dragging = false; });

    // ── Globals used by HTML button callbacks ───────────────────────────────
    window.setPreset   = name => { renderer.setPreset(name); requestRender(); };
    window.resetCamera = ()   => { theta = Math.PI/4; phi = Math.PI/3; requestRender(); };
  });

  // ── Volume builder (self-contained, no dependency on mpr.js) ───────────────
  async function buildVolume(imageIds, series, onProgress) {
    const images = [];
    for (let i = 0; i < imageIds.length; i++) {
      images.push(await cornerstone.loadImage(imageIds[i]));
      onProgress(Math.round((i + 1) / imageIds.length * 100));
    }

    // Sort descending by z (superior slices first, matching mpr.js)
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

    return { buffer, rows, cols, slices };
  }

  // ── Script loader ─────────────────────────────────────────────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s   = document.createElement('script');
      s.src     = src;
      s.onload  = resolve;
      s.onerror = () => reject(new Error('Failed to load: ' + src));
      document.head.appendChild(s);
    });
  }

})();
