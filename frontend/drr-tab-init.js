// drr-tab-init.js — Bootstrap for drr-tab.html.
//
// 1. Initialises Cornerstone WADO loader (for DICOM decoding).
// 2. Dynamically loads gpu-volume.js and drr-render.js.
// 3. Signals opener that the tab is ready (type: 'drr-ready').
// 4. Receives {imageIds, series} via postMessage (type: 'drr-data').
// 5. Builds volume, uploads to GPU, inits DRR renderer, renders first frame.
// 6. Mouse drag updates theta/phi → re-renders via requestAnimationFrame.

(async function () {
  'use strict';

  // ── Cornerstone WADO init ─────────────────────────────────────────────────
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
  await loadScript('drr-render.js');

  // ── Signal readiness ──────────────────────────────────────────────────────
  if (!window.opener) {
    document.getElementById('loadMsg').textContent =
      'Open this page from the DICOM viewer.';
    return;
  }
  window.opener.postMessage({ type: 'drr-ready' }, '*');

  // ── Receive volume data ───────────────────────────────────────────────────
  window.addEventListener('message', async function handler(e) {
    if (!e.data || e.data.type !== 'drr-data') return;
    window.removeEventListener('message', handler);

    const { imageIds, series } = e.data;

    // ── Build volume ──────────────────────────────────────────────────────
    document.getElementById('loadMsg').textContent = 'Decoding slices…';
    const volume = await buildVolume(imageIds, series, pct => {
      document.getElementById('progBar').style.width = pct + '%';
    });

    // ── Upload to GPU ─────────────────────────────────────────────────────
    document.getElementById('loadMsg').textContent = 'Uploading to GPU…';
    const gpuHandle = gpuVolume.uploadVolumeToGPU(volume);
    if (!gpuHandle) {
      document.getElementById('loadMsg').textContent =
        'GPU not available — DRR requires WebGL2.';
      return;
    }

    // ── Init DRR renderer ─────────────────────────────────────────────────
    const renderer = drrRender.init(gpuHandle);
    if (!renderer) {
      document.getElementById('loadMsg').textContent =
        'Shader compilation failed — check browser console.';
      return;
    }

    // ── Show viewer ───────────────────────────────────────────────────────
    document.getElementById('loading').style.display = 'none';
    document.getElementById('viewer').style.display  = 'flex';

    const canvas = document.getElementById('drrCanvas');

    // Default: AP projection (beam travels anterior→posterior)
    let theta   = 0;
    let phi     = Math.PI / 2;   // horizontal beam
    let curScale = 0.003;        // attenuation scale (×10^-3 per step)

    // rAF gate
    let rafId = null;
    function requestRender() {
      if (!rafId) rafId = requestAnimationFrame(() => {
        rafId = null;
        renderer.render(canvas, theta, phi, curScale);
        document.getElementById('status').textContent =
          `θ ${(theta * 180 / Math.PI).toFixed(1)}°  φ ${(phi * 180 / Math.PI).toFixed(1)}°`;
      });
    }

    requestRender();

    // ── Mouse drag to rotate projection ──────────────────────────────────
    let dragging = false, lastX = 0, lastY = 0;

    canvas.addEventListener('mousedown', e => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      theta -= (e.clientX - lastX) * 0.01;
      phi   -= (e.clientY - lastY) * 0.01;
      phi    = Math.max(0.05, Math.min(Math.PI - 0.05, phi));
      lastX  = e.clientX;
      lastY  = e.clientY;
      requestRender();
    });
    window.addEventListener('mouseup',    () => { dragging = false; });
    window.addEventListener('mouseleave', () => { dragging = false; });

    // ── Globals for HTML callbacks ────────────────────────────────────────
    window.setView = (t, p) => { theta = t; phi = p; requestRender(); };
    window.resetView = ()   => { theta = 0; phi = Math.PI / 2; requestRender(); };
    window.onScaleChange = v => {
      curScale = parseFloat(v) * 0.001;   // slider 1-20 → 0.001 – 0.020
      document.getElementById('scaleVal').textContent = v;
      requestRender();
    };
  });

  // ── Volume builder (identical pattern to vol-tab-init.js) ──────────────────
  async function buildVolume(imageIds, series, onProgress) {
    const images = [];
    for (let i = 0; i < imageIds.length; i++) {
      images.push(await cornerstone.loadImage(imageIds[i]));
      onProgress(Math.round((i + 1) / imageIds.length * 100));
    }

    // Sort descending by z (superior slices first)
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
