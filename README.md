# DICOM Viewer

A web-based DICOM viewer built with a Python/FastAPI backend and vanilla JS + Cornerstone.js frontend. Supports CT, MRI, RT structures, and full MPR reconstruction — no build step required.

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
| RTDOSE | Skipped (metadata only) |
| REG | Registration entry count |

---

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

---

### MPR View (Multi-Planar Reconstruction)

Available for CT and MR series with more than one slice. Click **⊞ MPR View** to enter.

#### How MPR works

All slices are loaded and assembled into a single `Float32Array` volume in memory. The three orthogonal planes are then computed by reading different slices through that buffer:

- **Axial** — reads a horizontal slab directly from the buffer (zero-copy `subarray`)
- **Coronal** — reads one row across all slices, writing columns in reverse to follow radiological convention (L on left)
- **Sagittal** — reads one column across all slices, writing rows in reverse (A on right)

HU scaling (`pixel × slope + intercept`) is applied once during volume build, so rendering is just a windowing lookup with no per-frame DICOM math.

#### Navigation

| Input | Action |
|-------|--------|
| Slider | Move plane independently per view |
| Mouse wheel | Scroll slices (Scroll mode) or zoom canvas (Zoom mode) |
| Middle-mouse click | Toggle Scroll / Zoom mode |
| Arrow Up / Down | Move axial plane (z) |
| Arrow Left / Right | Move sagittal plane (x) |
| W / S | Move coronal plane (y) |
| Click on any view | Jump crosshair to that point, syncing all three views |

#### Crosshair overlay

Each view draws two dashed cyan lines showing the current intersection point. The crosshair position is computed from the shared `xIndex / yIndex / zIndex` state and drawn after every render. Clicking anywhere inside a view moves the intersection to that point and immediately updates the other two views.

#### Orientation correction

When building the volume, each slice's `ImagePositionPatient` tag (DICOM `0020,0032`) is read and slices are sorted descending by z-coordinate. This places the most superior slice at index 0 regardless of whether the scanner acquired head-first or feet-first, making the S/I labels on coronal and sagittal views unconditionally correct.

#### Aspect ratio correction

Raw pixel counts are not used for scaling. Instead, each view is scaled using physical millimetre dimensions:

| View | Physical width | Physical height |
|------|---------------|----------------|
| Axial | `cols × colSpacing` mm | `rows × rowSpacing` mm |
| Coronal | `cols × colSpacing` mm | `slices × sliceThickness` mm |
| Sagittal | `rows × rowSpacing` mm | `slices × sliceThickness` mm |

This matters because slice thickness (e.g. 3 mm) is usually much larger than pixel spacing (e.g. 0.977 mm). Without this correction, coronal and sagittal views appear squashed vertically.

#### Window presets

All four presets (Lung, Bone, Soft Tissue, Brain) apply to all three MPR views simultaneously.

---

### HU Scaling

`RescaleSlope` and `RescaleIntercept` are read from DICOM metadata by the WADO loader and applied automatically. The default viewport is initialised once per series using `getDefaultViewportForImage`, then preserved while scrolling so W/L adjustments are not reset between slices.

---

## Performance

The MPR pipeline is optimised so that navigating through a loaded volume is as fast as possible and memory stays flat during use.

### Action 1 — Image cache

**Problem:** `cornerstone.loadImage()` fetches and decodes each DICOM file from the server. Re-entering MPR (or switching back and forth) would repeat that work.

**Solution:** A `Map` (`_imageCache`) keyed by imageId stores every decoded Cornerstone image object after its first load. On subsequent calls `_loadImage()` returns the cached object synchronously — no network request, no DICOM decode.

**Effect:** Second and subsequent MPR opens for the same series are limited only by the volume assembly loop, not by network latency or decode time. Verify in DevTools → Network: zero requests on re-entry.

### Action 2 — Volume cache

**Problem:** Assembling the `Float32Array` volume requires iterating over every pixel of every slice to apply HU scaling — for a 512×512×125 CT that is 32 million multiply-add operations. Re-entering MPR repeated this every time.

**Solution:** The built volume is stored in `_volumeCache` and keyed by `firstImageId + sliceCount`. `buildVolume()` checks the key first; if it matches, it returns the cached volume immediately (calling `onProgress(100)` so the progress bar completes instantly).

**Effect:** Re-entering MPR for the same series is instantaneous. The progress bar jumps to 100% without animating. Verify in DevTools → Console by timing `buildVolume` calls.

### Action 3 — requestAnimationFrame render gate

**Problem:** Input events (key-repeat, mouse wheel, slider drag) fire many times per frame. Each event was calling `updateAllViews()` directly, which ran three full canvas renders synchronously — often 5–10 renders per frame instead of one.

**Solution:** `updateAllViews()` sets a boolean flag `_rafPending` and schedules `_doRender()` via `requestAnimationFrame`. Any further calls while the flag is set are no-ops. The flag clears when the browser actually paints, then the cycle can repeat.

**Effect:** Exactly one render per display frame regardless of how many events fire. Frame time stays near 16 ms at 60 Hz even during rapid keyboard navigation. Verify in DevTools → Performance: record while holding an arrow key and look for consistent frame spacing with no "Long Task" bars.

### Action 4 — Pre-allocated reslice buffers

**Problem:** `renderCoronal()` and `renderSagittal()` called `new Float32Array(...)` on every frame. For a 512×125 volume each array is 256 KB. Allocating and immediately discarding two 256 KB arrays per navigation event creates constant GC pressure, causing periodic frame-time spikes.

**Solution:** Two fixed-size typed arrays (`_coronalBuf` and `_sagittalBuf`) are allocated once inside `buildVolume()` and stored on the volume object. The render functions write into these buffers in-place using indexed assignment — zero heap allocations during navigation.

**Effect:** JS heap size stays flat during MPR navigation (no sawtooth GC pattern). Verify in DevTools → Memory → Allocation instrumentation on timeline: no `Float32Array` allocation bars appear while navigating, only the initial volume allocation at load time.

### Verifying all four together

Open **Performance Monitor** (DevTools → three-dot menu → More tools → Performance monitor) while using MPR and watch:

| Metric | Before optimisation | After optimisation |
|--------|--------------------|--------------------|
| JS heap size during navigation | Sawtooth (GC every few frames) | Flat line |
| Network requests on MPR reopen | 100+ DICOM fetches | Zero |
| Volume build time on reopen | Several seconds | < 1 ms |
| Renders per keypress burst | 5–10 | 1 |

---

## Project Structure

```
dicom-viewer/
├── backend/
│   └── server.py          # FastAPI: upload, header-fix, series grouping
├── frontend/
│   ├── index.html         # Layout, styles, CDN script tags
│   ├── app.js             # 2D viewer logic (upload, series list, W/L, scroll/zoom)
│   └── mpr.js             # MPR volume builder, reslicing renderer, performance layer
└── Patient_data/          # Sample patient data (not committed)
```

---

## Changelog

### [c5141ac] Performance Action 4: pre-allocated reslice buffers
- `_coronalBuf` and `_sagittalBuf` allocated once in `buildVolume`, reused every frame
- Eliminates two 256 KB `Float32Array` allocations per navigation event
- JS heap stays flat; GC pauses eliminated during MPR use

### [6f61068] Performance Actions 1–3: image cache, volume cache, rAF gate
- `_imageCache` Map keeps decoded Cornerstone images alive across sessions
- `_volumeCache` returns the assembled volume instantly on re-entry
- `requestAnimationFrame` gate collapses burst events into one paint per frame

### [09ca1ce] MPR zoom toggle
- Middle-mouse click toggles Scroll / Zoom mode on MPR canvases (mirrors 2D viewer)
- Per-canvas zoom scale stored in `mprCanvasZoom`; zoom applied after aspect-ratio correction
- Mode indicator and Reset Zoom button added to MPR top bar

### [ca29b27] MPR features: crosshair, click navigation, orientation & aspect ratio
- Cyan dashed crosshair drawn on all three views after every render
- Click anywhere in a view to move the intersection point and sync all views
- `buildVolume` sorts slices by `ImagePositionPatient` z descending — S/I labels always correct
- Physical mm dimensions used for canvas scaling — thick-slice views no longer squashed

### [9ee7b30] Fix MPR wheel scroll — arrow functions have no arguments object
- `arguments[0]` in arrow function callbacks was always `undefined`, making index `NaN`
- Fixed by using an explicit parameter `(d)` in wheel callbacks

### [31b5701] MPR centralized rendering engine with shared indices
- `updateAllViews()` as single entry point: clamps indices, syncs sliders, renders all three planes
- Shared `xIndex / yIndex / zIndex` as the authoritative 3-D intersection point
- All inputs (slider, wheel, keyboard) write to indices and call `updateAllViews()`

### [d5098cd] MPR view — axial, coronal, sagittal reconstruction
- `mpr.js`: loads all slices into a `Float32Array` volume, reslices on demand
- Three-panel grid with independent sliders and mouse-wheel scroll per view
- Progress bar during volume loading; W/L presets apply to all three views
- Horizontal flip on coronal/sagittal for radiological orientation (L on left)
- Orientation labels: R/L on axial; L/R/S/I on coronal; P/A/S/I on sagittal

### [1c42108] Middle-mouse scroll/zoom toggle (2D viewer)
- Middle-mouse button toggles wheel between Scroll and Zoom modes
- Zoom mode: scroll up = ×1.1, scroll down = ×0.9, scale clamped to [0.1, 10]

### [e8ad972] W/L presets, live display, clamping, smoother drag
- Window presets: Lung, Bone, Soft Tissue, Brain
- Live WL / WW display updates on every drag move and preset click
- WW clamped to [1, 10000], WC clamped to [−2000, 5000]
- Drag sensitivity 2 HU/px

### [41bdbbd] Window/Level drag, proper viewport init, HU scaling
- Left-click drag: left/right → Window Width, up/down → Window Center
- `getDefaultViewportForImage` called once per series; viewport preserved across slices

### [dee05bc] Mouse wheel scroll fix
- Replaced unreliable `StackScrollMouseWheelTool` with a native `wheel` event listener

### [e195390] Metadata sidebar + slice counter
- Backend returns pixel spacing, slice thickness, window C/W, image dimensions per series
- Metadata panel displayed beside the viewer

### [cf52311] Fix CT/MR rendering — missing DICOM meta headers
- Files without DICOM preamble fail silently in `dicom-parser`
- Backend rewrites such files as Explicit VR Little Endian before serving

### [a6b32a1] RTSTRUCT and REG support
- RTSTRUCT: ROI list as a numbered table
- REG: registration entry count displayed

### [2d4c7e2] RTPLAN, RTDOSE, RTIMAGE modalities
- RTPLAN: beam table with name, type, energy
- RTDOSE: multi-frame DICOM via `wadouri:url?frame=N`
- RTIMAGE: treated as standard image series

### [ad0fa3b] Initial commit
- FastAPI backend: upload endpoint, series grouping by `SeriesInstanceUID`, scout filtering
- Static file serving via `StaticFiles` mount for WADO image loading
- Cornerstone.js frontend: file upload, series buttons, slice slider
