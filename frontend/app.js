const element = document.getElementById('dicomImage');
const slider = document.getElementById('sliceSlider');
const infoPanel = document.getElementById('infoPanel');

// Setup loader
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

cornerstoneTools.addTool(cornerstoneTools.StackScrollMouseWheelTool);
cornerstoneTools.setToolActive('StackScrollMouseWheel', {});

let currentStack = null;
let newImageListener = null;

document.getElementById('fileInput').addEventListener('change', async function(e) {
  const formData = new FormData();
  for (let file of e.target.files) {
    formData.append("files", file);
  }

  const response = await fetch("http://127.0.0.1:8000/upload/", {
    method: "POST",
    body: formData
  });

  const data = await response.json();
  console.log("Series received:", data);
  showSeries(data);
});

function showSeries(seriesData) {
  const container = document.getElementById("seriesList");
  container.innerHTML = "";

  // Sort: image/multiframe first, then metadata-only
  const order = { image: 0, multiframe: 1, plan: 2, struct: 3, reg: 4 };
  const sorted = Object.values(seriesData).sort(
    (a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9)
  );

  sorted.forEach(series => {
    const btn = document.createElement("button");
    let label;
    switch (series.type) {
      case "image":
      case "multiframe":
        label = `${series.instances.length} slices`;
        break;
      case "plan":    label = `${series.metadata.beam_count} beams`; break;
      case "struct":  label = `${series.metadata.roi_count} ROIs`;   break;
      default:        label = series.type;
    }
    btn.innerText = `[${series.modality}] ${series.description} (${label})`;
    btn.style.display = "block";
    btn.style.margin = "3px 0";

    if (series.type === "image" || series.type === "multiframe") {
      btn.onclick = () => loadSeries(series);
    } else {
      btn.onclick = () => showMetadata(series);
    }

    container.appendChild(btn);
  });
}

function showMetadata(series) {
  element.style.display = "none";
  slider.style.display = "none";
  infoPanel.style.display = "block";

  let html = `<h3>[${series.modality}] ${series.description}</h3>`;

  if (series.type === "plan") {
    const m = series.metadata;
    const rows = m.beams.map(b =>
      `<tr><td>${b.name}</td><td>${b.type}</td><td>${b.energy} MV</td></tr>`
    ).join("");
    html += `
      <p>Beams: <b>${m.beam_count}</b></p>
      <table border="1" cellpadding="4" cellspacing="0">
        <thead><tr><th>Name</th><th>Type</th><th>Energy</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  else if (series.type === "struct") {
    const m = series.metadata;
    const rows = m.rois.map(r =>
      `<tr><td>${r.number}</td><td>${r.name}</td></tr>`
    ).join("");
    html += `
      <p>ROIs: <b>${m.roi_count}</b></p>
      <table border="1" cellpadding="4" cellspacing="0">
        <thead><tr><th>#</th><th>Name</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  else if (series.type === "reg") {
    html += `<p>${series.metadata.description}</p>
             <p>Registration entries: <b>${series.metadata.entry_count}</b></p>`;
  }

  infoPanel.innerHTML = html;
}

function loadSeries(series) {
  element.style.display = "block";
  slider.style.display = "block";
  infoPanel.style.display = "none";

  const imageIds = series.instances.map(item => {
    const base = `wadouri:http://127.0.0.1:8000/files/${item.path}`;
    return series.type === "multiframe" ? `${base}?frame=${item.frame}` : base;
  });

  slider.max = imageIds.length - 1;
  slider.value = 0;

  const stack = { currentImageIdIndex: 0, imageIds };
  cornerstoneTools.addStackStateManager(element, ['stack']);
  cornerstoneTools.addToolState(element, 'stack', stack);
  currentStack = stack;

  loadImage(0);

  slider.oninput = function() {
    const index = parseInt(this.value);
    currentStack.currentImageIdIndex = index;
    loadImage(index);
  };

  if (newImageListener) {
    element.removeEventListener('cornerstonenewimage', newImageListener);
  }
  newImageListener = function(e) {
    const index = imageIds.indexOf(e.detail.image.imageId);
    if (index !== -1) {
      slider.value = index;
      currentStack.currentImageIdIndex = index;
    }
  };
  element.addEventListener('cornerstonenewimage', newImageListener);

  function loadImage(index) {
    cornerstone.loadImage(imageIds[index]).then(function(image) {
      cornerstone.displayImage(element, image);
    }).catch(function(err) {
      console.error("Failed to load image:", err);
    });
  }
}
