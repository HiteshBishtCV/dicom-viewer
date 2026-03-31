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

// ── State ────────────────────────────────────────────────────────────────────

let currentImageIds = [];
let currentIndex = 0;
let activeBtn = null;

// ── Mouse wheel scroll (direct, bypasses cornerstone-tools) ──────────────────

element.addEventListener('wheel', function(e) {
  e.preventDefault();
  if (!currentImageIds.length) return;

  const delta = e.deltaY > 0 ? 1 : -1;
  const next = Math.max(0, Math.min(currentImageIds.length - 1, currentIndex + delta));
  if (next === currentIndex) return;

  currentIndex = next;
  slider.value = next;
  updateSliceLabel(next, currentImageIds.length);
  displayImage(next);
}, { passive: false });

// ── Upload ───────────────────────────────────────────────────────────────────

document.getElementById('fileInput').addEventListener('change', async function(e) {
  const formData = new FormData();
  for (let file of e.target.files) formData.append("files", file);

  const response = await fetch("http://127.0.0.1:8000/upload/", {
    method: "POST",
    body: formData
  });

  const data = await response.json();
  console.log("Series received:", data);
  showSeries(data);
});

// ── Series list ──────────────────────────────────────────────────────────────

function showSeries(seriesData) {
  const container = document.getElementById("seriesList");
  container.innerHTML = "";

  const order = { image: 0, multiframe: 1, plan: 2, struct: 3, reg: 4 };
  const sorted = Object.values(seriesData).sort(
    (a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9)
  );

  sorted.forEach(series => {
    const btn = document.createElement("button");
    let label;
    switch (series.type) {
      case "image":
      case "multiframe": label = `${series.instances.length} slices`; break;
      case "plan":       label = `${series.metadata.beam_count} beams`; break;
      case "struct":     label = `${series.metadata.roi_count} ROIs`; break;
      default:           label = series.type;
    }
    btn.innerText = `[${series.modality}] ${series.description} (${label})`;

    if (series.type === "image" || series.type === "multiframe") {
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

// ── Metadata-only display (RTPLAN, RTSTRUCT, REG) ────────────────────────────

function showMetadata(series) {
  element.style.display = "none";
  slider.style.display = "none";
  sliceLabel.style.display = "none";
  metaPanel.style.display = "none";
  infoPanel.style.display = "block";

  let html = `<h3 style="margin-bottom:10px">[${series.modality}] ${series.description}</h3>`;

  if (series.type === "plan") {
    const m = series.metadata;
    const rows = m.beams.map(b =>
      `<tr><td>${b.name}</td><td>${b.type}</td><td>${b.energy} MV</td></tr>`
    ).join("");
    html += `<p style="margin-bottom:8px">Beams: <b>${m.beam_count}</b></p>
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Energy</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  } else if (series.type === "struct") {
    const m = series.metadata;
    const rows = m.rois.map(r =>
      `<tr><td>${r.number}</td><td>${r.name}</td></tr>`
    ).join("");
    html += `<p style="margin-bottom:8px">ROIs: <b>${m.roi_count}</b></p>
      <table>
        <thead><tr><th>#</th><th>Name</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  } else if (series.type === "reg") {
    html += `<p>${series.metadata.description}</p>
             <p>Entries: <b>${series.metadata.entry_count}</b></p>`;
  }

  infoPanel.innerHTML = html;
}

// ── Image series viewer ──────────────────────────────────────────────────────

function loadSeries(series) {
  element.style.display = "block";
  slider.style.display = "block";
  sliceLabel.style.display = "block";
  metaPanel.style.display = "block";
  infoPanel.style.display = "none";

  currentImageIds = series.instances.map(item => {
    const base = `wadouri:http://127.0.0.1:8000/files/${item.path}`;
    return series.type === "multiframe" ? `${base}?frame=${item.frame}` : base;
  });
  currentIndex = 0;

  const total = currentImageIds.length;
  slider.max = total - 1;
  slider.value = 0;

  renderMetaPanel(series, total);
  displayImage(0);

  slider.oninput = function() {
    currentIndex = parseInt(this.value);
    updateSliceLabel(currentIndex, total);
    displayImage(currentIndex);
  };
}

function displayImage(index) {
  cornerstone.loadImage(currentImageIds[index]).then(function(image) {
    const viewport = cornerstone.getDefaultViewportForImage(element, image);
    cornerstone.displayImage(element, image, viewport);
    updateSliceLabel(index, currentImageIds.length);
  }).catch(function(err) {
    console.error("Failed to load image:", err);
  });
}

function updateSliceLabel(index, total) {
  sliceLabel.textContent = `Slice ${index + 1} / ${total}`;
}

function renderMetaPanel(series, total) {
  const m = series.series_metadata || {};

  const ps = m.pixel_spacing
    ? `${m.pixel_spacing[0]} × ${m.pixel_spacing[1]} mm`
    : '—';
  const st = m.slice_thickness ? `${m.slice_thickness} mm` : '—';
  const dims = (m.rows && m.cols) ? `${m.rows} × ${m.cols} px` : '—';
  const wc = m.window_center ? m.window_center : '—';
  const ww = m.window_width ? m.window_width : '—';

  const rows = [
    ['Modality',        series.modality],
    ['Series',          series.description],
    ['Slices',          total],
    ['Dimensions',      dims],
    ['Pixel Spacing',   ps],
    ['Slice Thickness', st],
    ['Window Center',   wc],
    ['Window Width',    ww],
  ];

  metaContent.innerHTML = rows.map(([label, value]) => `
    <div class="row">
      <span class="label">${label}</span>
      <span class="value">${value}</span>
    </div>
  `).join('');
}
