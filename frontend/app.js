const element = document.getElementById('dicomImage');
const slider = document.getElementById('sliceSlider');
const sliceLabel = document.getElementById('sliceLabel');
const metaPanel = document.getElementById('metaPanel');
const metaContent = document.getElementById('metaContent');
const infoPanel = document.getElementById('infoPanel');

// ── Cornerstone setup ────────────────────────────────────────────────────────

cornerstoneWADOImageLoader.external.cornerstone = cornerstone;
cornerstoneWADOImageLoader.external.dicomParser = dicomParser;
cornerstoneWADOImageLoader.webWorkerManager.initialize({
  webWorkerPath: 'https://unpkg.com/cornerstone-wado-image-loader/dist/cornerstoneWADOImageLoaderWebWorker.js',
  taskConfiguration: {
    decodeTask: {
      codecsPath: 'https://unpkg.com/cornerstone-wado-image-loader/dist/cornerstoneWADOImageLoaderCodecs.js'
    }
  }
});

cornerstone.enable(element);

cornerstoneTools.external.cornerstone = cornerstone;
cornerstoneTools.external.cornerstoneMath = cornerstoneMath;
cornerstoneTools.external.Hammer = Hammer;
cornerstoneTools.init();

// Draw R / L labels after every Cornerstone render (survives W/L drag redraws)
element.addEventListener('cornerstoneimagerendered', function() {
  const canvas = element.querySelector('canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.font         = 'bold 18px sans-serif';
  ctx.fillStyle    = '#ffff00';
  ctx.shadowColor  = '#000';
  ctx.shadowBlur   = 4;
  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'left';
  ctx.fillText('R', 8, h / 2);
  ctx.textAlign    = 'right';
  ctx.fillText('L', w - 8, h / 2);
  ctx.shadowBlur   = 0;
});

// ── State ────────────────────────────────────────────────────────────────────

let currentImageIds  = [];
let currentIndex     = 0;
let currentViewport  = null;   // preserved across slices, reset on series change
let activeBtn        = null;
let wheelMode        = 'scroll'; // 'scroll' | 'zoom' — toggled by middle mouse press

// ── TASK 2: Viewport init ─────────────────────────────────────────────────────
// displayImage() uses getDefaultViewportForImage only on the FIRST slice of a
// series (currentViewport === null). Subsequent slices reuse the same viewport
// so W/L adjustments are preserved when scrolling.

function displayImage(index) {
  cornerstone.loadImage(currentImageIds[index]).then(function(image) {

    if (currentViewport === null) {
      // TASK 3: getDefaultViewportForImage reads RescaleSlope/Intercept
      // from the image (set by WADO loader from DICOM tags) and applies
      // HU = pixel * slope + intercept inside the VOI LUT automatically.
      currentViewport = cornerstone.getDefaultViewportForImage(element, image);
    }

    cornerstone.displayImage(element, image, currentViewport);
    updateSliceLabel(index, currentImageIds.length);
    updateWLDisplay(
      Math.round(currentViewport.voi.windowCenter),
      Math.round(currentViewport.voi.windowWidth)
    );

  }).catch(function(err) {
    console.error('Failed to load image:', err);
  });
}

// ── TASK 1: Window / Level mouse drag ────────────────────────────────────────
// Left / Right drag → Window Width  (contrast)
// Up   / Down  drag → Window Center (brightness)

element.style.cursor = 'crosshair';

let isDragging   = false;
let dragStartX   = 0;
let dragStartY   = 0;
let dragStartWW  = 0;
let dragStartWC  = 0;

element.addEventListener('mousedown', function(e) {
  if (!currentImageIds.length) return;
  isDragging  = true;
  dragStartX  = e.clientX;
  dragStartY  = e.clientY;
  const vp = cornerstone.getViewport(element);
  if (vp) {
    dragStartWW = vp.voi.windowWidth;
    dragStartWC = vp.voi.windowCenter;
  }
  e.preventDefault();
});

// Listen on window so drag continues even if mouse leaves the element
window.addEventListener('mousemove', function(e) {
  if (!isDragging || !currentImageIds.length) return;

  const dx =  (e.clientX - dragStartX);   // right = wider  = more contrast
  const dy = -(e.clientY - dragStartY);   // up    = higher = brighter

  // Task 7: sensitivity=2 for smooth interaction
  const newWW = dragStartWW + dx * 2;
  const newWC = dragStartWC + dy * 2;

  const vp = cornerstone.getViewport(element);
  if (!vp) return;

  // Task 6: clamp to prevent instability
  vp.voi.windowWidth  = Math.max(1, Math.min(10000, newWW));
  vp.voi.windowCenter = Math.max(-2000, Math.min(5000, newWC));
  cornerstone.setViewport(element, vp);
  currentViewport = vp;

  updateWLDisplay(Math.round(vp.voi.windowCenter), Math.round(vp.voi.windowWidth));
});

window.addEventListener('mouseup',    () => { isDragging = false; });
window.addEventListener('mouseleave', () => { isDragging = false; });

// ── Middle mouse button: toggle scroll / zoom mode ───────────────────────────

element.addEventListener('mousedown', function(e) {
  if (e.button === 1) {           // wheel press
    e.preventDefault();
    wheelMode = wheelMode === 'scroll' ? 'zoom' : 'scroll';
    updateModeIndicator();
  }
});

// Prevent default middle-click auto-scroll behaviour in browsers
element.addEventListener('auxclick', function(e) {
  if (e.button === 1) e.preventDefault();
});

function updateModeIndicator() {
  const el = document.getElementById('modeIndicator');
  if (!el) return;
  if (wheelMode === 'zoom') {
    el.textContent = '🔍 Zoom mode  (middle-click to switch)';
    el.style.color = '#ffd54f';
  } else {
    el.textContent = '↕ Scroll mode  (middle-click to switch)';
    el.style.color = '#aaa';
  }
}

// ── Mouse wheel: scroll slices or zoom ───────────────────────────────────────

element.addEventListener('wheel', function(e) {
  e.preventDefault();
  if (!currentImageIds.length) return;

  if (wheelMode === 'zoom') {
    const vp = cornerstone.getViewport(element);
    if (!vp) return;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;          // down = zoom out, up = zoom in
    vp.scale = Math.max(0.1, Math.min(10, vp.scale * factor));
    cornerstone.setViewport(element, vp);
    currentViewport = vp;
  } else {
    const delta = e.deltaY > 0 ? 1 : -1;
    const next  = Math.max(0, Math.min(currentImageIds.length - 1, currentIndex + delta));
    if (next === currentIndex) return;
    currentIndex  = next;
    slider.value  = next;
    displayImage(next);
  }
}, { passive: false });

// ── Upload ───────────────────────────────────────────────────────────────────

document.getElementById('fileInput').addEventListener('change', async function(e) {
  const formData = new FormData();
  for (let file of e.target.files) formData.append('files', file);

  const response = await fetch('http://127.0.0.1:8000/upload/', {
    method: 'POST',
    body: formData
  });

  const data = await response.json();
  console.log('Series received:', data);
  showSeries(data);
});

// ── Series list ──────────────────────────────────────────────────────────────

function showSeries(seriesData) {
  const container = document.getElementById('seriesList');
  container.innerHTML = '';

  const order  = { image: 0, multiframe: 1, plan: 2, struct: 3, reg: 4 };
  const sorted = Object.values(seriesData).sort(
    (a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9)
  );

  sorted.forEach(series => {
    const btn = document.createElement('button');
    let label;
    switch (series.type) {
      case 'image':
      case 'multiframe': label = `${series.instances.length} slices`; break;
      case 'plan':       label = `${series.metadata.beam_count} beams`; break;
      case 'struct':     label = `${series.metadata.roi_count} ROIs`; break;
      default:           label = series.type;
    }
    btn.innerText = `[${series.modality}] ${series.description} (${label})`;

    if (series.type === 'image' || series.type === 'multiframe') {
      btn.onclick = () => { setActiveBtn(btn); loadSeries(series); };
    } else {
      btn.onclick = () => { setActiveBtn(btn); showMetadata(series); };
    }
    container.appendChild(btn);
  });
}

function setActiveBtn(btn) {
  if (activeBtn) activeBtn.classList.remove('active');
  activeBtn = btn;
  btn.classList.add('active');
}

// ── Image series loader ───────────────────────────────────────────────────────

function loadSeries(series) {
  element.style.display   = 'block';
  slider.style.display    = 'block';
  sliceLabel.style.display = 'block';
  metaPanel.style.display  = 'block';
  infoPanel.style.display  = 'none';
  document.getElementById('presets').style.display = 'flex';

  currentImageIds = series.instances.map(item => {
    const base = `wadouri:http://127.0.0.1:8000/files/${item.path}`;
    return series.type === 'multiframe' ? `${base}?frame=${item.frame}` : base;
  });
  currentIndex    = 0;
  currentViewport = null;   // reset so first slice gets a fresh default viewport

  const total     = currentImageIds.length;
  slider.max      = total - 1;
  slider.value    = 0;

  // Expose for MPR button (defined in HTML onclick)
  window._activeSeries   = series;
  window._activeImageIds = currentImageIds;

  // Show MPR button only for volumetric image series (CT/MR with multiple slices)
  const mprBtn = document.getElementById('mprBtn');
  if ((series.modality === 'CT' || series.modality === 'MR') && total > 1) {
    mprBtn.style.display = 'block';
  } else {
    mprBtn.style.display = 'none';
  }

  renderMetaPanel(series, total);
  displayImage(0);

  slider.oninput = function() {
    currentIndex = parseInt(this.value);
    displayImage(currentIndex);
  };
}

// ── Metadata-only display (RTPLAN, RTSTRUCT, REG) ────────────────────────────

function showMetadata(series) {
  element.style.display    = 'none';
  slider.style.display     = 'none';
  sliceLabel.style.display = 'none';
  metaPanel.style.display  = 'none';
  infoPanel.style.display  = 'block';

  let html = `<h3 style="margin-bottom:10px">[${series.modality}] ${series.description}</h3>`;

  if (series.type === 'plan') {
    const m    = series.metadata;
    const rows = m.beams.map(b =>
      `<tr><td>${b.name}</td><td>${b.type}</td><td>${b.energy} MV</td></tr>`
    ).join('');
    html += `<p style="margin-bottom:8px">Beams: <b>${m.beam_count}</b></p>
      <table><thead><tr><th>Name</th><th>Type</th><th>Energy</th></tr></thead>
      <tbody>${rows}</tbody></table>`;

  } else if (series.type === 'struct') {
    const m    = series.metadata;
    const rows = m.rois.map(r =>
      `<tr><td>${r.number}</td><td>${r.name}</td></tr>`
    ).join('');
    html += `<p style="margin-bottom:8px">ROIs: <b>${m.roi_count}</b></p>
      <table><thead><tr><th>#</th><th>Name</th></tr></thead>
      <tbody>${rows}</tbody></table>`;

  } else if (series.type === 'reg') {
    html += `<p>${series.metadata.description}</p>
             <p>Entries: <b>${series.metadata.entry_count}</b></p>`;
  }

  infoPanel.innerHTML = html;
}

// ── Metadata sidebar ─────────────────────────────────────────────────────────

function renderMetaPanel(series, total) {
  const m  = series.series_metadata || {};
  const ps = m.pixel_spacing
    ? `${m.pixel_spacing[0]} × ${m.pixel_spacing[1]} mm` : '—';
  const st   = m.slice_thickness ? `${m.slice_thickness} mm` : '—';
  const dims = (m.rows && m.cols) ? `${m.rows} × ${m.cols} px` : '—';

  const rows = [
    ['Modality',        series.modality],
    ['Series',          series.description],
    ['Slices',          total],
    ['Dimensions',      dims],
    ['Pixel Spacing',   ps],
    ['Slice Thickness', st],
  ];

  metaContent.innerHTML = rows.map(([label, value]) => `
    <div class="row">
      <span class="label">${label}</span>
      <span class="value">${value}</span>
    </div>
  `).join('');
}

function updateWLDisplay(wc, ww) {
  const wcEl = document.getElementById('meta-wc');
  const wwEl = document.getElementById('meta-ww');
  if (wcEl) wcEl.textContent = wc;
  if (wwEl) wwEl.textContent = ww;
}

// Task 4: window/level presets
function applyPreset(wc, ww) {
  if (!currentImageIds.length) return;
  const vp = cornerstone.getViewport(element);
  if (!vp) return;
  vp.voi.windowCenter = wc;
  vp.voi.windowWidth  = ww;
  cornerstone.setViewport(element, vp);
  currentViewport = vp;
  updateWLDisplay(wc, ww);
}

function updateSliceLabel(index, total) {
  sliceLabel.textContent = `Slice ${index + 1} / ${total}`;
}
