const element = document.getElementById('dicomImage');
const slider = document.getElementById('sliceSlider');
const planInfo = document.getElementById('planInfo');

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

// Enable cornerstone on the element
cornerstone.enable(element);

// Init cornerstone tools
cornerstoneTools.external.cornerstone = cornerstone;
cornerstoneTools.external.cornerstoneMath = cornerstoneMath;
cornerstoneTools.external.Hammer = Hammer;
cornerstoneTools.init();

cornerstoneTools.addTool(cornerstoneTools.StackScrollMouseWheelTool);
cornerstoneTools.setToolActive('StackScrollMouseWheel', {});

let currentStack = null;
let newImageListener = null;

document.getElementById('fileInput').addEventListener('change', async function(e) {
  const files = e.target.files;
  const formData = new FormData();

  for (let file of files) {
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

  Object.keys(seriesData).forEach(uid => {
    const series = seriesData[uid];

    const btn = document.createElement("button");
    const count = series.type === "plan"
      ? "metadata"
      : `${series.instances.length} slices`;
    btn.innerText = `${series.modality} — ${series.description} (${count})`;

    if (series.type === "plan") {
      btn.onclick = () => showPlanMetadata(series);
    } else {
      btn.onclick = () => loadSeries(series);
    }

    container.appendChild(btn);
    container.appendChild(document.createElement("br"));
  });
}

function showPlanMetadata(series) {
  // Hide viewer, show plan info
  element.style.display = "none";
  slider.style.display = "none";
  planInfo.style.display = "block";

  const m = series.metadata;
  const beamRows = m.beams
    .map(b => `<tr><td>${b.name}</td><td>${b.type}</td><td>${b.energy} MV</td></tr>`)
    .join("");

  planInfo.innerHTML = `
    <h3>RT Plan: ${m.label}</h3>
    <p>Total beams: <b>${m.beam_count}</b></p>
    <table border="1" cellpadding="4" cellspacing="0">
      <thead><tr><th>Beam Name</th><th>Type</th><th>Energy</th></tr></thead>
      <tbody>${beamRows}</tbody>
    </table>
  `;
}

function loadSeries(series) {
  // Show viewer, hide plan info
  element.style.display = "block";
  slider.style.display = "block";
  planInfo.style.display = "none";

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
