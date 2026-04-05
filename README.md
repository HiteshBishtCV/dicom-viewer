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
- DICOM RTSTRUCT export is handled by the `POST /export-rtstruct` endpoint (see below)

---

### Polygon ROI Drawing

Available in both the 2D viewer and MPR view.

- **Draw mode** — toggle with the "Draw ROI" button; cursor changes to crosshair
- **Click** to add vertices; **double-click** or **click the first vertex** (highlighted yellow when closeable) to close the polygon
- **Name prompt** — after closing, a dialog prompts for a name; default is `ROI_1`, `ROI_2`, … (press Enter or cancel to accept the default)
- **Label on image** — the ROI name is rendered at the polygon centroid in the ROI's colour
- **Structures panel** — lists all ROIs with an inline rename input, slice/plane position, and a delete button
- Points stored in image-pixel coordinates and re-projected each frame so ROIs stay aligned through zoom and pan

#### Edit mode (2D viewer and MPR)

- **"✎ Edit ROI" button** — activates edit mode (mutually exclusive with draw mode)
- **Click inside a polygon** — selects it; selected ROI shows a white dashed ring and larger vertex handles
- **Drag a vertex handle** — moves that vertex in real-time; committed to `roiStore` on mouse-up
- **Delete / Backspace** — removes the selected ROI
- **Click empty space** — deselects
- Changing slice clears selection; drag commit fires on mouse-leave too (no lost edits)

#### Load from backend (2D viewer and MPR)

- **"↓ Load ROIs" button** — fetches saved file list from `GET /load-roi/`, shows an inline `<select>`
- Selecting a file calls `GET /load-roi/{filename}` and imports ROIs; entries with `canvasId` go to MPR, others to the 2D viewer
- Deduplicates by `id` so re-loading the same file is safe
- Loaded ROIs render on the correct slice immediately and persist through scroll/zoom

#### MPR-specific coordinate mapping for RTSTRUCT export

| Plane | ix → CT col | iy → CT row | planeIndex → |
|---|---|---|---|
| Axial | `ix` | `iy` | CT slice `z` |
| Coronal | `ncols-1-ix` (flip) | `planeIndex` (fixed row) | — |
| Sagittal | `planeIndex` (fixed col) | `nrows-1-ix` (flip) | — |

For coronal/sagittal ROIs, `iy` encodes the CT slice index — each polygon vertex may lie on a different slice, which is valid for a `CLOSED_PLANAR` DICOM contour in a non-axial plane.

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

### RTSTRUCT export

Converts saved ROI polygons to a valid DICOM RT Structure Set file.

#### Coordinate transform (pixel → patient mm)

DICOM PS 3.3 C.7.6.2 defines the forward mapping per slice:

```
P = IPP  +  col × F_row × ΔC  +  row × F_col × ΔR
```

| Symbol | Tag | Meaning |
|--------|-----|---------|
| IPP | `ImagePositionPatient` | Patient-space position of pixel (0, 0) |
| F_row | `ImageOrientationPatient[:3]` | Unit vector along increasing column index |
| F_col | `ImageOrientationPatient[3:]` | Unit vector along increasing row index |
| ΔC | `PixelSpacing[1]` | mm between adjacent column centres |
| ΔR | `PixelSpacing[0]` | mm between adjacent row centres |

The frontend stores points as `[[col, row], ...]`. The backend applies the formula above using the IPP of the ROI's slice (matched by InstanceNumber order, same as the frontend).

#### RTSTRUCT DICOM structure

```
RTSTRUCT dataset
├── ReferencedFrameOfReferenceSequence  — ties to CT frame + series
├── StructureSetROISequence             — ROI number + name (no geometry)
├── ROIContourSequence                  — flat [x,y,z,...] contour data per ROI
└── RTROIObservationsSequence           — clinical type label per ROI
```

#### Workflow

1. Draw ROIs on the CT
2. "↑ Save ROIs" → JSON saved on backend
3. "⬇ Export RTSTRUCT" → select the saved file → `.dcm` downloads to your machine
4. Open the RTSTRUCT in any DICOM-compatible TPS or viewer that supports RT Structure Sets

---

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

### ROI → 3D Binary Field Mask

Converts polygon ROIs (same name across multiple slices) into a full 3-D binary volume aligned to the CT.

#### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/roi-field-mask` | POST | Compute 3-D binary mask from ROI polygons |

**Body** (choose one):
```json
{ "filename": "roi_20260404_123456.json", "roi_name": "Heart", "series_uid": "..." }
{ "rois": [...],                           "roi_name": "Heart", "series_uid": "..." }
```

**Response:**
```json
{ "shape": [nz, nrows, ncols],
  "annotated_slices":    N,
  "interpolated_slices": M,
  "voxel_count":         V,
  "field_mask_b64":      "<base64 zlib-compressed uint8 C-order bytes>" }
```

Deserialise in Python:
```python
import base64, zlib, numpy as np
raw  = zlib.decompress(base64.b64decode(resp["field_mask_b64"]))
mask = np.frombuffer(raw, dtype=np.uint8).reshape(resp["shape"]).astype(bool)
```

#### Algorithm

1. **Polygon rasterisation** — `skimage.draw.polygon` rasterises each `[[col, row]]` polygon into a per-slice binary mask; holes filled with `scipy.ndimage.binary_fill_holes`
2. **Signed-distance-transform (SDT) interpolation** — for each annotated slice a SDT is computed (positive inside, negative outside); between any two annotated slice positions the SDTs are linearly blended; threshold at 0 gives a smooth interpolated binary mask
3. **Boundary replication** — slices before/after the first/last annotated position copy that slice's mask (no extrapolation)
4. **Hole fill** — `binary_fill_holes` applied per slice on the final volume

#### UI (AI Segmentation tab)

- **↻ Refresh** — loads saved ROI file list from `/load-roi/`
- Select file → enter optional ROI name filter → **▶ Generate** — calls `/roi-field-mask` and displays shape, annotated/interpolated slice counts, and total voxel count
- **⬇ Download .npy** — packages the mask directly in the browser as a valid NumPy 1.0 `.npy` file (no round-trip); uses `DecompressionStream` (Chrome ≥ 80 / Firefox ≥ 113) to inflate zlib in-browser

---

### Field–Organ Overlap — Live Stats Tab

A dedicated **📊 Field Stats** tab shows how much lung and heart volume falls inside the drawn treatment field.

#### Workflow

1. In the MPR view, draw the treatment field ROI (e.g. `ROI_1`) and run organ segmentation (lung + heart)
2. Click **📊 Field Stats** in the MPR toolbar
3. The tab opens and receives all current ROIs automatically
4. Assign structures: pick the field ROI, select lung(s), select heart
5. Click **▶ Compute Overlap**
6. Results appear with metric bars and volume numbers

#### Display

| Element | Meaning |
|---------|---------|
| Bar + % | Fraction of the organ that lies inside the field |
| "In field" | Volume (cc) of organ ∩ field |
| "Total" | Total organ volume (cc) |
| Bar colour | Blue → normal · Amber → elevated · Red → high (lung >35 %, heart >10 %) |

#### API

`POST /field-organ-overlap` — single round-trip, no pre-computed masks needed:

```json
{
  "series_uid":     "...",
  "rois":           [ {name, slice, points, ...} ],
  "field_roi_name": "ROI_1",
  "lung_roi_names": ["Left Lung", "Right Lung"],
  "heart_roi_name": "Heart"
}
```

The backend rasterises and SDT-interpolates each structure mask in parallel threads, then calls `_organ_field_stats` for each organ. Voxel spacing is read automatically from the uploaded DICOM headers.

---

### Field–Organ Overlap Statistics (low-level, pre-computed masks)

Computes what fraction of each organ (lung, heart) falls inside the 3-D treatment field.

#### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/field-organ-stats` | POST | Compute lung/heart overlap with field mask |

**Body:**
```json
{
  "field_mask_b64":  "<base64 zlib uint8>",
  "lung_mask_b64":   "<base64 zlib uint8>",
  "heart_mask_b64":  "<base64 zlib uint8>",
  "shape":           [nz, nr, nc],
  "spacing":         [dz_mm, dy_mm, dx_mm],
  "series_uid":      "..."
}
```
`spacing` is optional — omit it and the endpoint reads voxel spacing directly from the uploaded DICOM files. `lung_mask_b64` should be the combined left ∪ right lung mask if both lobes were segmented separately.

**Response:**
```json
{
  "lung":  { "organ_volume_cc": 2400.5, "volume_in_field_cc": 310.2, "percent_in_field": 12.92 },
  "heart": { "organ_volume_cc":  620.1, "volume_in_field_cc":  48.7, "percent_in_field":  7.85 },
  "field_volume_cc": 1850.4,
  "voxel_volume_cc": 0.262144,
  "spacing_mm": [2.5, 0.977, 0.977]
}
```

#### How volumes are computed

`voxel_volume_cc = dz × dy × dx / 1000`  (mm³ → cc)

| Quantity | Formula |
|----------|---------|
| `organ_volume_cc` | `count(organ_mask) × voxel_volume_cc` |
| `volume_in_field_cc` | `count(organ_mask ∩ field_mask) × voxel_volume_cc` |
| `percent_in_field` | `count(overlap) / count(organ) × 100` |

#### Voxel spacing source

- **Explicit** — pass `"spacing": [dz, dy, dx]`
- **Auto** — `_read_voxel_spacing()` scans uploaded DICOM headers: `dy`/`dx` from `PixelSpacing`, `dz` from the median gap between consecutive `ImagePositionPatient` z-values (more reliable than `SliceThickness` tag)

### Auto-Segmentation (Lung + Heart)

CPU-only automatic contouring from CT in the MPR view. No GPU, no model downloads.

**Install once:**
```bash
cd backend && source venv/bin/activate
pip install numpy scipy scikit-image
```

#### Lung segmentation (seed-point)

1. Click **🫁 Segment Lungs** — a status bar prompts "Click inside the LEFT lung"
2. Click inside the left lung on the axial canvas (any slice)
3. Status updates to "Click inside the RIGHT lung" → click inside it
4. Backend segments both lungs separately and returns one contour per slice

Algorithm:
- Threshold CT at −300 HU (air-filled voxels)
- Remove external air by zeroing components that touch the volume boundary
- **Neighbourhood seed lookup** — searches a 20 mm radius around the clicked point so clicks on nodules, vessels, or bronchial walls still resolve to the correct lung region (fixes "point not in air" error)
- Seed-based region growing selects the component under each seed point (naturally excludes trachea/bronchi)
- **Per-slice 2D disk closing** with **15 mm physical radius** fills lung nodules (bright ~−100 to +100 HU spots) — 10-100× faster than 3D closing, sub-second on typical CT
- `scipy.ndimage.binary_fill_holes` removes any remaining interior holes

#### Heart segmentation (seed + optional bounding boxes)

1. Optionally draw bounding boxes to constrain the search region:
   - Click **🔲 Seg Box** to enter box mode, then **click and drag** on any canvas to draw a dashed yellow rectangle
   - Draw on axial canvas to constrain row/col range; draw on coronal or sagittal to constrain the Z (slice) range
   - Click **✕ Clear Box** to remove all boxes and start over
2. Click **❤ Segment Heart** → click inside the heart on the axial canvas

Algorithm:
- Applies bounding box constraints from any drawn boxes to exclude anatomy outside the region of interest
- Auto-locates lungs using **2D connected-component analysis** with border removal and a multi-threshold fallback (−300/−200/−100 HU) for robust detection across different CT protocols
- Builds a per-slice **mediastinum mask** (column band between the two lung boundaries)
- Thresholds −30 to 150 HU inside the mediastinum ∩ bbox, excluding lung voxels
- Propagates from the user seed using 2D per-slice connected-component selection (same engine as lung segmentation)
- Subtracts auto-detected lung volumes to remove overlap
- 12 mm per-slice 2D closing + per-slice hole fill (fills cardiac chambers on non-contrast CT)
- Note: may include aortic root / pulmonary vessels — edit contours manually if needed

Both endpoints run in a background thread (`asyncio.to_thread`) so the UI and WADO image loader remain fully responsive during segmentation.

#### Output

- Contours appear immediately on the axial MPR canvas across all slices
- Left Lung (cyan), Right Lung (green), Heart (red)
- Results are standard ROIs: editable, saveable, exportable as RTSTRUCT
- RTSTRUCT export groups all same-named contours into one RT structure

### Contour interpolation for 3D structures

Draw axial ROIs at 2 or more Z slices with the same name (key frames), then click **⟷ Interpolate** to fill every intermediate slice automatically.

- **Arc-length resampling** — each key-frame polygon is resampled to 64 uniformly-spaced points regardless of original vertex count
- **Start-point alignment** — both winding directions of B are tested (B as-is and B reversed), and for each direction all cyclic rotations are evaluated; the globally best (direction, offset) combination is chosen; this prevents twisted-ribbon interpolation caused by CW/CCW mismatch between polygons drawn in different order
- **Linear blending** — each intermediate slice at z is: `t = (z - z_A) / (z_B - z_A)`, then `pt[i] = (1-t)·A[i] + t·B[i]`
- Works between each consecutive pair of key frames (3 key frames = 2 interpolated segments)
- Interpolated contours rendered dashed + semi-transparent to distinguish from hand-drawn key frames
- **✕ Clear Interp** removes generated contours while keeping key frames
- Interpolation is idempotent — clicking ⟷ Interpolate again re-runs cleanly
- Save → Load round-trips correctly (`isInterpolated` field preserved in JSON)
- RTSTRUCT export: all contours sharing the same name are grouped into **one RT structure** with one `ContourSequence` item per slice (correct DICOM representation for a 3D structure suitable for boolean operations in a TPS)

### MPR cross-view ROI indicators + rubber-band fix
- `mpr-roi.js`: `_drawCrossViewIndicators()` paints a thin dashed coloured guide line in each non-source canvas at the plane position of every ROI drawn in the other two planes (e.g., an axial ROI at z=N appears as a horizontal line at iy=N in both coronal and sagittal)
- The indicator line carries the ROI name tag so multiple overlapping ROIs are distinguishable
- `_requestRedraw()` routes all interactive redraws through `updateAllViews()` so mpr.js clears the canvas before repainting — eliminates the dashed-stroke accumulation artefact during polygon drawing

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
