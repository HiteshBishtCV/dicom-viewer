# DICOM Viewer

A web-based DICOM viewer built with a Python/FastAPI backend and vanilla JS + Cornerstone.js frontend. Supports CT, MRI, RT structures, and MPR reconstruction — no build step required.

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.12, FastAPI, pydicom |
| Frontend | Vanilla JS, Cornerstone.js v2 (CDN), cornerstone-tools, cornerstone-wado-image-loader |

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
| RTDOSE | Skipped from viewer (metadata only) |
| REG | Registration entry count |

### 2D Viewer
- Upload an entire DICOM folder — files are grouped by `SeriesInstanceUID`
- Scouts / localizers filtered out automatically
- Files missing DICOM File Meta headers are rewritten with a proper header on upload so the browser can parse them
- **Mouse wheel** — scroll through slices (default mode)
- **Middle-mouse click** — toggle between Scroll mode and Zoom mode; wheel zooms viewport in Zoom mode
- **Left-click drag** — adjust Window/Level: left/right changes Window Width (contrast), up/down changes Window Center (brightness); sensitivity 2 HU/px, values clamped to safe ranges
- **Slider** — scrub through slices; shows current slice / total
- **Window presets** — Lung (WL −600 / WW 1600), Bone (WL 400 / WW 1800), Soft Tissue (WL 40 / WW 400), Brain (WL 600 / WW 2800)
- **Metadata panel** — shows modality, series description, slice count, image dimensions, pixel spacing, slice thickness, live WL / WW

### MPR View (Multi-Planar Reconstruction)
Available for CT and MR series with more than one slice.

- Click **⊞ MPR View** button to enter
- All slices are loaded and assembled into a `Float32Array` volume with HU scaling applied (`HU = pixel × slope + intercept`)
- Three orthogonal planes rendered simultaneously:
  - **Axial** — original acquisition plane
  - **Coronal** — resliced at fixed row (y), z-axis flipped so superior is up
  - **Sagittal** — resliced at fixed column (x), z-axis flipped so superior is up
- Each view has an independent slider and mouse-wheel scroll
- Window presets apply to all three views simultaneously
- Click **← Back to 2D** to return to the single-slice viewer

### HU Scaling
`RescaleSlope` and `RescaleIntercept` are read from DICOM metadata by the WADO loader and applied automatically. The default viewport is initialised once per series using `getDefaultViewportForImage`, then preserved while scrolling so W/L adjustments are not reset between slices.

---

## Project Structure

```
dicom-viewer/
├── backend/
│   └── server.py          # FastAPI: upload, header-fix, series grouping
├── frontend/
│   ├── index.html         # Layout, styles, CDN script tags
│   ├── app.js             # 2D viewer logic (upload, series list, W/L, scroll/zoom)
│   └── mpr.js             # MPR volume builder and reslicing renderer
└── Patient_data/          # Sample patient data (not committed)
```

---

## Changelog

### [d5098cd] MPR view — axial, coronal, sagittal reconstruction
- New `mpr.js`: loads all slices into a `Float32Array` volume, reslices on demand
- Three-panel grid with independent sliders and mouse-wheel scroll per view
- Progress bar during volume loading; W/L presets apply to all three views
- "Back to 2D" returns to single-slice viewer without data loss

### [1c42108] Middle-mouse scroll/zoom toggle
- Middle-mouse button (wheel click) toggles wheel between Scroll and Zoom modes
- Zoom mode: scroll up = ×1.1, scroll down = ×0.9, scale clamped to [0.1, 10]
- Mode indicator shown below the viewer

### [e8ad972] W/L presets, live display, clamping, smoother drag
- Window presets: Lung, Bone, Soft Tissue, Brain
- Live WL / WW display updates on every drag move and preset click
- WW clamped to [1, 10000], WC clamped to [−2000, 5000]
- Drag sensitivity reduced to 2 HU/px for finer control

### [41bdbbd] Window/Level drag, proper viewport init, HU scaling
- Left-click drag: left/right → Window Width, up/down → Window Center
- `getDefaultViewportForImage` called once per series; viewport preserved across slices
- HU scaling (`pixel × slope + intercept`) applied automatically via WADO loader

### [dee05bc] Mouse wheel scroll fix
- Replaced unreliable `StackScrollMouseWheelTool` with a native `wheel` event listener
- `currentImageIds` and `currentIndex` promoted to module scope so slider and wheel share state

### [e195390] Metadata sidebar + slice counter
- Backend returns pixel spacing, slice thickness, window C/W, and image dimensions per series
- Metadata panel displayed beside the viewer; slice label shows "Slice N / Total"

### [cf52311] Fix CT/MR rendering — missing DICOM meta headers
- Files without DICOM preamble/File Meta Information header fail silently in `dicom-parser`
- Backend now detects and rewrites such files as Explicit VR Little Endian before serving

### [a6b32a1] RTSTRUCT and REG support; force=True reads
- RTSTRUCT: ROI list displayed as a numbered table
- REG: registration entry count displayed
- All `dcmread` calls use `force=True` to handle non-standard files

### [2d4c7e2] RTPLAN, RTDOSE, RTIMAGE modalities
- RTPLAN: beam table with name, type, energy
- RTDOSE: multi-frame DICOM handled via `wadouri:url?frame=N`
- RTIMAGE: DRR portal images treated as standard image series

### [ad0fa3b] Initial commit
- FastAPI backend: upload endpoint, series grouping by `SeriesInstanceUID`, scout filtering, slice sorting by `InstanceNumber`
- Static file serving via `StaticFiles` mount for WADO image loading
- Cornerstone.js frontend: file upload, series buttons, slice slider
