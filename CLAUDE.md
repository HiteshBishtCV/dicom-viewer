# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A DICOM medical image viewer with a Python backend and vanilla JS frontend. Users upload DICOM folders; the backend parses and groups files by series; the frontend renders slices using Cornerstone.js and supports GPU-accelerated MPR, 3D volume rendering, and DRR.

## Architecture

### Backend (`backend/server.py`)
FastAPI server using pydicom. Single `/upload/` endpoint accepts DICOM files, filters scouts/localizers, groups by `SeriesInstanceUID`, sorts by `InstanceNumber`, rewrites files missing DICOM meta headers, and returns series metadata. Uploaded files are saved to `backend/uploaded_dicoms/`. A `/files/` static mount serves files to the WADO loader.

### Frontend (`frontend/`)
Static HTML/JS app — no build step. All scripts loaded via `<script>` tags or dynamically.

| File | Role |
|------|------|
| `index.html` | Layout, styles, CDN script tags for Cornerstone |
| `app.js` | 2D viewer: upload, series list, W/L drag, scroll/zoom, preset buttons, tab launchers |
| `mpr.js` | CPU MPR: volume builder, reslice renderers, crosshair, performance layer |
| `gpu-volume.js` | WebGL2 volume upload: 3D texture (R16F half-float) or WebGL1 fallback |
| `gpu-slice.js` | GPU MPR slicer: single parameterised shader for axial/coronal/sagittal |
| `mpr-tab.html` + `mpr-tab-init.js` | Standalone MPR tab (CPU or GPU mode) |
| `volume-render.js` | GPU ray-cast renderer: MIP + transfer-function compositing |
| `vol-tab.html` + `vol-tab-init.js` | Standalone 3D volume tab |
| `drr-render.js` | GPU DRR renderer: orthographic Beer-Lambert ray-sum |
| `drr-tab.html` + `drr-tab-init.js` | Standalone DRR tab |
| `roi-store.js` | Global ROI store: single source of truth for all drawn ROIs (id, name, slice, points, color) |
| `roi-draw.js` | 2D viewer polygon ROI: click-to-add vertices, close on first-vertex click or dblclick, `window.prompt` for name, label at centroid |
| `mpr-roi.js` | MPR polygon ROI: same UX on all three canvases; plane-index-aware so ROIs only show on the correct slice |
| `roi-save.js` | ROI persistence: POSTs `roiStore` data to `/save-roi`; exposes `save()`, `loadList()`, `load(filename)` |
| `rtstruct-overlay.js` | RT structure set overlay renderer |

Frontend fetches from `http://127.0.0.1:8000` and loads images via the `wadouri:` scheme.

## Commands

### Run backend
```bash
cd backend
source venv/bin/activate
uvicorn server:app --reload
```

### Run frontend
Open `frontend/index.html` directly in a browser (no build/server needed).

### Install backend dependencies
```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install fastapi uvicorn pydicom python-multipart
```

## Key Details

- Python 3.12, no requirements.txt — dependencies: fastapi, uvicorn, pydicom, python-multipart
- No test framework configured
- No linter or formatter configured
- CORS wide open (`allow_origins=["*"]`) — development only
- GPU features require WebGL2 (Chrome/Firefox modern). Buttons are hidden when unavailable.
- Tabs communicate with the main window via `postMessage` (handshake: `*-ready` / `*-data`)
- All GPU renderers share one WebGL context from `gpu-volume.js` (`preserveDrawingBuffer: true`)
- Volume texture format: `R16F` + `FLOAT` (WebGL2) for ~1024 distinct HU levels; `LUMINANCE` + `UNSIGNED_BYTE` (WebGL1 fallback)
- Slices sorted descending by `ImagePositionPatient` z before volume build (superior-first)
- ROI naming: after polygon close, `window.prompt()` asks for a name; default `ROI_N`; name displayed as canvas text at centroid (coloured + dark shadow)
- ROI store (`roiStore`) uses canonical `[[x,y]]` point format; `roi-draw.js` uses `{x,y}` objects internally for Cornerstone's `pixelToCanvas`
- ROI save: `POST /save-roi` accepts `{ rois: [{name, slice, points, ...}] }`; files written to `backend/saved_rois/roi_<timestamp>.json`; `GET /load-roi/` lists files; `GET /load-roi/{filename}` returns one record
- `roi-save.js` is decoupled — reads only from `roiStore`, has no direct dependency on `roi-draw.js` or `mpr-roi.js`
- ROI edit mode (`roi-draw.js`): `toggleEditMode()` / `isEditing()`; click-to-select (point-in-polygon), vertex drag (mousedown→mousemove→mouseup), Delete key deletes selected; modes are mutually exclusive
- ROI load (`roi-draw.js`): `importRois(array)` converts `[[x,y]]` → `{x,y}`, deduplicates by id, syncs roiStore, redraws — aligned to CT because points are already in image-pixel coords
- Glue code for load UI lives in `app.js` (`showRoiLoadPicker`, `loadSelectedRoi`, `toggleRoiEdit`); `roi-save.js` stays pure I/O
- RTSTRUCT export: `POST /export-rtstruct`; uses `_roi_contour_data()` which is plane-aware (axial/coronal/sagittal); `_pixels_to_patient` handles axial, `_roi_contour_data` handles MPR flips
- MPR plane → CT voxel: axial `(ix,iy,z)`, coronal `(ncols-1-ix, planeIndex, iy)`, sagittal `(planeIndex, nrows-1-ix, iy)` — flips match renderCoronal/renderSagittal in `mpr.js`
- `_load_ct_for_export` now includes `rows` and `cols` per slice (needed for coronal/sagittal flip math)
- `mpr-roi.js`: full edit mode (select, vertex drag, Delete key), `importRois()`, `roiStore` sync on every close/delete/import; `_drawCrossViewIndicators()` draws a thin dashed guide line in each non-source canvas at the ROI's planeIndex; `_requestRedraw()` routes all interactive redraws through `updateAllViews()` to prevent rubber-band accumulation; interpolation engine: `interpolate(name)`, `clearInterpolated(name)`, `getInterpolatable()` — arc-length resample → start-point align (tests both windings B and B-reversed + all cyclic rotations, picks globally lowest SSD — fixes CW/CCW mismatch) → linear blend per z-slice; interpolated ROIs carry `isInterpolated:true` and render dashed; seg-box mode: `toggleBoxMode()`, `clearSegBoxes()`, `getSegBoxes()` — drag to draw dashed yellow bbox on any canvas, boxes persist across redraws and are forwarded to `/segment-heart` as `axial_ix1/iy1/ix2/iy2` etc. to constrain the search region
- `roi-save.js`: save payload now forwards `plane`, `planeIndex`, `canvasId`, `isInterpolated` for full round-trip fidelity
- `backend/server.py` `_build_rtstruct()`: groups ROIs by name — one `StructureSetROISequence`/`ROIContourSequence` per unique name, multiple `ContourSequence` items inside (one per slice); backwards-compatible with single-slice ROIs
- Auto-segmentation: `POST /segment-lungs` (seed_left/right [slice,col,row] → left/right lung contours), `POST /preview-lung` (one seed → single-lung contours for immediate preview), `POST /segment-heart` (one seed [slice,col,row] inside heart → heart contours); all endpoints wrapped in `asyncio.to_thread()`; `_load_ct_volume()` uses `ThreadPoolExecutor(max_workers=8)` for parallel DICOM reads; `_propagate_from_seed_2d(binary_mask, ...)`: shared 2D per-slice connected-component propagation — avoids 3D labeling, lungs/heart never merge via bridges, FOV-edge structures preserved via fallback; `_segment_one_lung_2d()`: thin wrapper calling propagate with `vol < -300`; `_do_segment_heart_seeded()`: propagate with soft-tissue mask (−30 to 200 HU) + 12 mm 2D closing; `_close_mask_2d()` per-slice 2D disk closing (10-100× faster than 3D); frontend: lung picker is 2-click (left→preview→right→final), heart picker is 1-click (both use same `_segPickState` machinery with 'left'/'right'/'heart' states)
- Frontend auto-seg: `mpr-tab.html` has Auto-Segment panel; `mpr-tab-init.js` has seed-picker state machine (`_segPickState`), `startLungSeedPicker()`, `_handleSeedClick()`, `runHeartSegmentation()`, `_importSegResults()` — imports via `mprRoi.importRois()` with source:'auto-segment'
- Required backend packages (one-time install): numpy, scipy, scikit-image
- `mpr-tab.html`: loads `roi-store.js` + `roi-save.js`; Draw/Edit/Save/Load/Export buttons + two file `<select>` pickers
- `mpr-tab-init.js`: `toggleMprEdit`, `showMprLoadPicker`, `loadSelectedMprRoi`, `showMprExportPicker`, `exportSelectedMprRoi`; stores `_mprSeriesUid` from postMessage payload
- ROI → 3D field mask: `POST /roi-field-mask` accepts `{ filename|rois, roi_name, series_uid }`; saves mask to `backend/saved_masks/mask_<name>_<timestamp>.npy` via `np.save()`; returns `{ shape, annotated_slices, interpolated_slices, voxel_count, central_slice_index, saved_file }`; `_field_central_slice(field_mask)` → z-index of middle active slice (`active = np.where(mask.any(axis=(1,2)))[0]; return active[len(active)//2]`); `GET /saved-masks/` lists files; `GET /saved-masks/{filename}` serves the file; `_polygon_to_mask()` + `_interpolate_masks_sdt()` do rasterisation + SDT interpolation; UI: shows "✓ Saved to backend: filename" + "⬇ Download .npy" link pointing to `/saved-masks/` — no browser-side inflate/npy needed
- Field–organ overlap: `POST /field-organ-stats` accepts pre-computed b64 masks; `POST /field-organ-overlap` accepts raw ROI list + structure names (`field_roi_name`, `lung_roi_names[]`, `heart_roi_name`) — rasterises + interpolates everything server-side in parallel asyncio tasks; helpers: `_rois_to_mask(rois, names, nz, nr, nc)`, `_decode_mask_b64`, `_read_voxel_spacing`, `_organ_field_stats`; returns `{ lung/heart: {organ_volume_cc, volume_in_field_cc, percent_in_field}, field_volume_cc, voxel_volume_cc, spacing_mm }`
- `field-stats-tab.html` + `field-stats-tab-init.js`: standalone "📊 Field Stats" tab; receives ROIs via postMessage handshake (`field-stats-ready` → `field-stats-data`); auto-selects structures by name convention; shows metric bars (blue=lung, red=heart) with colour coding (green/amber/red thresholds); `openFieldStatsTab()` in `mpr-tab-init.js` opens/focuses window and forwards `mprRoi.getRois()` + `_mprSeriesUid`; `📊 Field Stats` button added to `mpr-tab.html` toolbar

## GPU Rendering Notes

- `gpu-volume.js` must be loaded before `gpu-slice.js`, `volume-render.js`, or `drr-render.js`
- All three GPU renderers render to the hidden `glCanvas` inside `gpuHandle`, then `drawImage` copy to the visible output canvas
- W/L math in shaders: `val = clamp((hu - (wc - ww/2)) / ww, 0, 1)`
- DRR attenuation proxy: `μ = max(0, HU + 1000)` per voxel, summed along ray, then `exp(-sum * scale)` inverted
- Transfer function texture: 256×1 RGBA8, x-coord = normalised volume sample [0,1], authored against typical CT range [-1000, +3000] HU
