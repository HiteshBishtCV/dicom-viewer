# DICOM Viewer

A web-based DICOM viewer with a Python/FastAPI backend and vanilla JS + Cornerstone.js frontend. Supports CT, MRI, RT structures, full MPR reconstruction, GPU-accelerated rendering, 3D volume ray casting, and DRR simulation — no build step required.

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.12, FastAPI, pydicom |
| Frontend | Vanilla JS, Cornerstone.js (CDN), WebGL2 |

## Setup

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install fastapi uvicorn pydicom python-multipart
uvicorn server:app --reload
```

Server runs at `http://127.0.0.1:8000`.

### Frontend

Open `frontend/index.html` directly in your browser — no build step:

```bash
firefox frontend/index.html
```

---

## Features

### Supported modalities

| Modality | Behaviour |
|----------|-----------|
| CT / MR / RTIMAGE | Image viewer with slice scrolling |
| RTPLAN | Beam table (name, type, energy) |
| RTSTRUCT | ROI list with numbers and names |
| RTDOSE | Multi-frame image viewer |
| REG | Registration entry count |

---

### ROI Save / Load (JSON)

Drawn ROIs can be persisted to the backend with one click.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/save-roi` | POST | Accept `{ rois: [{name, slice, points, ...}] }`, write `saved_rois/roi_<timestamp>.json` |
| `/load-roi/` | GET | List all saved ROI files (newest first) |
| `/load-roi/{filename}` | GET | Return the full saved record |

- **"↑ Save ROIs" button** in the Structures panel sends all entries from `roiStore` to the backend in one POST
- Each saved file is self-contained JSON — no DICOM dependency
- `roi-save.js` is fully decoupled: it reads from `roiStore` only, so ROIs from any drawing tool are included automatically
- DICOM RTSTRUCT export is a separate future step — not included here

---

### Polygon ROI Drawing

Available in both the 2D viewer and MPR view.

- **Draw mode** — toggle with the "Draw ROI" button; cursor changes to crosshair
- **Click** to add vertices; **double-click** or **click the first vertex** (highlighted yellow when closeable) to close the polygon
- **Name prompt** — after closing, a dialog prompts for a name; default is `ROI_1`, `ROI_2`, … (press Enter or cancel to accept the default)
- **Label on image** — the ROI name is rendered at the polygon centroid in the ROI's colour
- **Structures panel** — lists all ROIs with an inline rename input, slice/plane position, and a delete button
- Points stored in image-pixel coordinates and re-projected each frame so ROIs stay aligned through zoom and pan

#### Edit mode

- **"✎ Edit ROI" button** — activates edit mode (mutually exclusive with draw mode)
- **Click inside a polygon** — selects it; selected ROI shows a white dashed ring and larger vertex handles
- **Drag a vertex handle** — moves that vertex in real-time; committed to `roiStore` on mouse-up
- **Delete / Backspace** — removes the selected ROI
- **Click empty space** — deselects
- Changing slice clears selection; drag commit fires on mouse-leave too (no lost edits)

#### Load from backend

- **"↓ Load ROIs" button** — fetches saved file list from `GET /load-roi/`, shows an inline `<select>`
- Selecting a file calls `GET /load-roi/{filename}` and imports ROIs via `roiDraw.importRois()`
- Deduplicates by `id` so re-loading the same file is safe
- Loaded ROIs render on the correct slice immediately and persist through scroll/zoom

---

### 2D Viewer

- Upload an entire DICOM folder — files are grouped by `SeriesInstanceUID`
- Scouts / localizers filtered out automatically
- Files missing DICOM File Meta headers are rewritten with a proper header on upload
- **Mouse wheel** — scroll through slices (default mode)
- **Middle-mouse click** — toggle between Scroll mode and Zoom mode; wheel zooms viewport in Zoom mode
- **Left-click drag** — adjust Window/Level: left/right → Window Width (contrast), up/down → Window Center (brightness); sensitivity 2 HU/px, values clamped to safe ranges
- **Slider** — scrub through slices; shows current slice / total
- **Window presets** — Lung (WL −600 / WW 1600), Bone (WL 400 / WW 1800), Soft Tissue (WL 40 / WW 400), Brain (WL 600 / WW 2800)
- **Metadata panel** — modality, series description, slice count, image dimensions, pixel spacing, slice thickness, live WL / WW

---

### MPR View (Multi-Planar Reconstruction)

Available for CT and MR series with more than one slice. Opens in a new browser tab in either **CPU** or **GPU** mode.

#### CPU mode

All slices are assembled into a single `Float32Array` volume in memory. The three orthogonal planes are computed by reading different slices through that buffer:

- **Axial** — zero-copy `subarray` of the buffer
- **Coronal** — one row across all slices, columns reversed for radiological convention (L on left)
- **Sagittal** — one column across all slices, rows reversed (A on right)

HU scaling (`pixel × slope + intercept`) is applied once at build time.

#### GPU mode

The volume is uploaded to a WebGL2 `TEXTURE_3D` (R16F half-float format). A single parameterised GLSL shader handles all three planes via `u_origin`, `u_dx`, `u_dy` uniforms. W/L is applied entirely in the fragment shader. Output is rendered to a hidden GL canvas then copied via `drawImage` to the visible output canvas.

#### Navigation (both modes)

| Input | Action |
|-------|--------|
| Slider | Move plane independently per view |
| Mouse wheel | Scroll slices (Scroll mode) or zoom canvas (Zoom mode) |
| Middle-mouse click | Toggle Scroll / Zoom mode |
| Arrow Up / Down | Move axial plane (z) |
| Arrow Left / Right | Move sagittal plane (x) |
| W / S | Move coronal plane (y) |
| Click on any view | Jump crosshair to that point, syncing all three views |
| Reset Zoom button | Restore all canvas scales to 1× |

#### Crosshair overlay

Each view draws two dashed cyan lines showing the current intersection point. Clicking anywhere in a view moves the intersection and immediately updates the other two views.

#### Orientation & aspect ratio

Slices are sorted by `ImagePositionPatient` z descending (superior-first) before volume build. Canvas scaling uses physical millimetre dimensions rather than raw pixel counts, so thick-slice coronal and sagittal views are never squashed.

| View | Physical width | Physical height |
|------|----------------|----------------|
| Axial | `cols × colSpacing` mm | `rows × rowSpacing` mm |
| Coronal | `cols × colSpacing` mm | `slices × sliceThickness` mm |
| Sagittal | `rows × rowSpacing` mm | `slices × sliceThickness` mm |

---

### 3D Volume Rendering (GPU)

Opens in a new browser tab. Requires WebGL2.

- **MIP (Maximum Intensity Projection)** — shows the brightest windowed voxel along each ray, ideal for CT bone and vessel detail
- **Transfer functions** — map intensity to colour + opacity using front-to-back Porter-Duff alpha compositing with early-exit at 99% opacity

| Preset | Appearance |
|--------|-----------|
| Bone | Ivory cortical bone (opaque) + faint pink soft tissue |
| Soft Tissue | Yellow fat + pink muscle/organs + barely-visible bone |
| Lung | Cyan parenchyma + red vessels/bronchi + ivory ribs |
| MIP | Greyscale maximum intensity projection |

- **Mouse drag** — rotate camera (spherical theta/phi coordinates, gimbal-lock-free)
- **Reset Camera** button restores default viewing angle

#### Shader architecture

256-step ray march through the `TEXTURE_3D` volume. In MIP mode the shader keeps the maximum windowed value. In TF mode each step samples a 256×1 RGBA8 transfer function texture (x-coord = raw normalised voxel value) and composites front-to-back. A single `u_mip` float switches between modes; `setPreset()` uploads a new TF texture without recompiling the shader.

---

### DRR (Digitally Reconstructed Radiograph)

Opens in a new browser tab. Requires WebGL2.

A DRR simulates a plain X-ray image by integrating CT attenuation values along parallel rays through the volume, following the Beer-Lambert law.

#### Physics model

Real X-rays obey `I = I₀ · exp(−∫μ dx)` where `μ` (linear attenuation coefficient) is proportional to electron density and therefore to HU:

| Tissue | HU | μ proxy |
|--------|----|---------|
| Air | −1000 | 0 — fully transparent |
| Soft tissue | ~0–80 | ~1000–1080 — moderate attenuation |
| Bone | ~400–700 | ~1400–1700 — strong attenuation → dark on film |

The shader accumulates `max(0, HU + 1000) × stepSize` along each ray then applies `exp(−sum × scale)`, inverting so dense structures appear dark.

#### Controls

| Control | Action |
|---------|--------|
| AP / Lateral / Oblique / Superior buttons | Standard radiograph projections |
| Mouse drag | Freely rotate the projection direction |
| Contrast slider (1–20) | Adjusts attenuation scale (×0.001 – ×0.020) |

All rays are orthographic (parallel) — no focal-spot geometry, which is standard for DRR use in radiation therapy planning.

---

### HU Scaling

`RescaleSlope` and `RescaleIntercept` are read from DICOM metadata by the WADO loader and applied automatically. The default viewport is initialised once per series using `getDefaultViewportForImage`, then preserved while scrolling so W/L adjustments survive slice changes.

---

## Performance

### Image cache

A `Map` (`_imageCache`) keyed by imageId stores every decoded Cornerstone image object after first load. Subsequent MPR opens for the same series require zero network requests or decode work.

### Volume cache

The built `Float32Array` volume is stored in `_volumeCache` keyed by `firstImageId + sliceCount`. Re-entering MPR for the same series returns the cached volume instantly — the progress bar jumps to 100% in under 1 ms.

### requestAnimationFrame render gate

`updateAllViews()` schedules rendering via `requestAnimationFrame` behind a flag, collapsing any number of input events (key-repeat, wheel, slider drag) into exactly one render per display frame.

### Pre-allocated reslice buffers

`_coronalBuf` and `_sagittalBuf` are allocated once inside `buildVolume()` and reused every frame. No heap allocations occur during MPR navigation — JS heap stays flat with no GC pressure.

---

## Project Structure

```
dicom-viewer/
├── backend/
│   └── server.py              # FastAPI: upload, header-fix, series grouping, static files
├── frontend/
│   ├── index.html             # Layout, styles, CDN script tags
│   ├── app.js                 # 2D viewer logic + tab launchers
│   ├── mpr.js                 # CPU MPR: volume builder, reslicing, crosshair, caches
│   ├── gpu-volume.js          # WebGL2 volume upload (R16F TEXTURE_3D)
│   ├── gpu-slice.js           # GPU MPR slicer (parameterised shader, all 3 planes)
│   ├── mpr-tab.html           # Standalone MPR tab layout
│   ├── mpr-tab-init.js        # MPR tab bootstrap (CPU or GPU mode)
│   ├── volume-render.js       # GPU ray-cast renderer (MIP + TF compositing)
│   ├── vol-tab.html           # Standalone 3D volume tab layout
│   ├── vol-tab-init.js        # 3D volume tab bootstrap
│   ├── drr-render.js          # GPU DRR renderer (Beer-Lambert ray-sum)
│   ├── drr-tab.html           # Standalone DRR tab layout
│   ├── drr-tab-init.js        # DRR tab bootstrap
│   ├── roi-store.js           # Global ROI store (canonical [[x,y]] format)
│   ├── roi-draw.js            # 2D viewer polygon ROI drawing
│   ├── mpr-roi.js             # MPR polygon ROI drawing (all 3 planes)
│   ├── roi-save.js            # ROI → backend JSON persistence
│   └── rtstruct-overlay.js    # RTSTRUCT contour overlay
├── backend/
│   └── saved_rois/            # Saved ROI JSON files (auto-created)
└── Patient_data/              # Sample patient data (not committed)
```

---

## Changelog

### ROI load + edit
- `roi-draw.js`: `importRois(array)` — converts backend `[[x,y]]` → internal `{x,y}`, deduplicates by id, syncs to `roiStore`
- `roi-draw.js`: `toggleEditMode()` / `isEditing()` — click-to-select, vertex drag, Delete key, white dashed ring + large handles on selection
- `app.js`: `showRoiLoadPicker()` / `loadSelectedRoi()` — fetches file list, shows `<select>`, calls `roiDraw.importRois()`
- `app.js`: `toggleRoiEdit()` — wires Edit button with mutual exclusion against draw mode
- `index.html`: "✎ Edit ROI", "↓ Load ROIs" buttons + `<select id="roiFileSelect">` in Structures panel

### ROI save / load
- `backend/server.py`: `POST /save-roi`, `GET /load-roi/`, `GET /load-roi/{filename}` — JSON file storage in `saved_rois/`
- `frontend/roi-save.js`: `roiSave.save()` POSTs full `roiStore` payload; `loadList()` / `load(filename)` for retrieval
- "↑ Save ROIs" button added to Structures panel

### ROI naming
- `roi-draw.js`, `mpr-roi.js`: `window.prompt()` after polygon close; default `ROI_N` accepted on cancel or blank
- `roi-draw.js`, `mpr-roi.js`: name label rendered at polygon centroid with drop-shadow for legibility
- `roi-store.js`: fallback default name updated to `ROI_1`

### DRR renderer
- `drr-render.js`: WebGL2 orthographic parallel-ray Beer-Lambert integration
- Attenuation proxy `μ = max(0, HU+1000)`; Beer-Lambert inversion `exp(−sum·scale)`
- AP, Lateral, Oblique, Superior preset views; drag-to-rotate; contrast slider

### Transfer function volume rendering
- `volume-render.js`: MIP mode + front-to-back TF compositing in same shader (`u_mip` toggle)
- 1D TF texture (256×1 RGBA8) uploaded via `setPreset()` — no shader recompile on switch
- Presets: Bone (ivory), Soft Tissue (pink organs), Lung (cyan parenchyma + red vessels)

### GPU MPR + 3D tab system
- `gpu-volume.js`: R16F `TEXTURE_3D` upload; WebGL1 fallback (LUMINANCE atlas)
- `gpu-slice.js`: single parameterised shader for all three MPR planes; W/L in shader
- `volume-render.js`: perspective ray-cast MIP with spherical camera and rAF gate
- New tabs: MPR (CPU/GPU choice), 3D Volume, DRR — all using postMessage handshake

### Performance optimisations (MPR)
- Image cache: zero re-fetches on MPR reopen
- Volume cache: sub-millisecond volume rebuild on reopen
- rAF gate: one render per display frame regardless of input burst rate
- Pre-allocated reslice buffers: flat JS heap during navigation

### MPR view (CPU)
- Three-panel reconstruction: axial, coronal, sagittal
- Shared `xIndex / yIndex / zIndex` state with crosshair overlay and click navigation
- Physical mm scaling for correct aspect ratios on thick-slice volumes
- `ImagePositionPatient` z-sort for correct superior/inferior orientation

### 2D viewer
- W/L drag, scroll/zoom toggle, window presets, metadata panel
- Middle-mouse scroll/zoom toggle, per-slice label, DICOM header rewrite
