const element = document.getElementById('dicomImage');
const slider = document.getElementById('sliceSlider');

// Setup loader
cornerstoneWADOImageLoader.external.cornerstone = cornerstone;
cornerstoneWADOImageLoader.external.dicomParser = dicomParser;

// Web worker
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

// Add and activate mouse wheel scroll tool
cornerstoneTools.addTool(cornerstoneTools.StackScrollMouseWheelTool);
cornerstoneTools.setToolActive('StackScrollMouseWheel', {});

// Track current image stack for wheel scrolling
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
    btn.innerText = `${series.modality} - ${series.description} (${series.instances.length})`;

    btn.onclick = () => loadSeries(series.instances);

    container.appendChild(btn);
    container.appendChild(document.createElement("br"));
  });
}

function loadSeries(instances) {

  const imageIds = instances.map(item =>
    "wadouri:http://127.0.0.1:8000/files/" + item.path
  );

  slider.max = imageIds.length - 1;
  slider.value = 0;

  // Tell the stack scroll tool about this image stack
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

  // Keep slider in sync when wheel scroll changes slice
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
    }).catch(function(err){
      console.error(err);
    });
  }
}