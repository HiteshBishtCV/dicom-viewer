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

## GPU Rendering Notes

- `gpu-volume.js` must be loaded before `gpu-slice.js`, `volume-render.js`, or `drr-render.js`
- All three GPU renderers render to the hidden `glCanvas` inside `gpuHandle`, then `drawImage` copy to the visible output canvas
- W/L math in shaders: `val = clamp((hu - (wc - ww/2)) / ww, 0, 1)`
- DRR attenuation proxy: `μ = max(0, HU + 1000)` per voxel, summed along ray, then `exp(-sum * scale)` inverted
- Transfer function texture: 256×1 RGBA8, x-coord = normalised volume sample [0,1], authored against typical CT range [-1000, +3000] HU
