# RT Metrics Workflow — Step-by-Step Guide

End-to-end instructions for loading a CT, drawing a tangential field ROI,
auto-segmenting organs, and computing CLD / lung–heart overlap metrics.

---

## Prerequisites

### One-time setup

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn pydicom python-multipart \
            numpy scipy scikit-image
```

---

## Step 1 — Start the backend

```bash
cd backend
source venv/bin/activate
uvicorn server:app --reload
```

Server runs at `http://127.0.0.1:8000`.
Keep this terminal open for the whole session.

---

## Step 2 — Open the viewer

Open `frontend/index.html` directly in Chrome or Firefox.

```bash
# Linux / macOS
xdg-open frontend/index.html          # Linux
open frontend/index.html              # macOS
```

Or drag the file into a browser tab.

---

## Step 3 — Upload a DICOM CT series

1. Click **"Choose Files"** (top of the page).
2. Select **all files** inside your CT folder
   (Ctrl+A to select all, then Open).
3. Wait for the series list to populate on the left.
4. Click the CT series entry — slices appear in the 2D viewer.

> The backend rewrites any files missing a DICOM meta header automatically.
> Scouts / localisers are filtered out; only the main CT series appears.

---

## Step 4 — Open the MPR view

Click **"Open MPR"** in the top toolbar.

A new tab opens showing three panels:
- **Axial** (top-left)
- **Coronal** (top-right)
- **Sagittal** (bottom-left)

Use the sliders under each panel to scroll through planes.

---

## Step 5 — Run AI organ segmentation

1. Click **"🤖 AI Segment"** in the MPR toolbar.
   The AI Segmentation window opens.

2. Select a method:
   - **TotalSegmentator** (recommended — heart + both lungs in ~30 s on GPU)
   - Platipy / MONAI / MedSAM are heart-only alternatives

3. Leave default organs checked: **Heart + vessels**, **Left Lung**, **Right Lung**.

4. Select quality: **Fast** (~30 s) is sufficient for planning.

5. Click **"▶ Run Segmentation"** and wait for the progress bar to finish.

6. When complete, click **"↩ Load in MPR View"**.
   - Three coloured contours appear on the axial canvas:
     **Left Lung** (cyan), **Right Lung** (green), **Heart** (red).

> If TotalSegmentator is not installed:
> ```bash
> pip install TotalSegmentator
> ```
> Model weights (~300 MB) download automatically on the first run.

---

## Step 6 — Draw the tangential field ROI

The field ROI defines the treatment volume boundary.

### 6a. Enable draw mode

Click **"✏ Draw ROI"** in the MPR toolbar.
The cursor changes to a crosshair on the axial canvas.

### 6b. Draw the polygon

- **Click** to place each vertex of the field boundary.
- **Double-click** or **click the first vertex** (turns yellow when closeable)
  to close the polygon.
- A name prompt appears — type a name such as **`Field`** or **`ROI_1`**,
  then press Enter.

Draw the field on at least **2–3 representative axial slices**
(e.g. superior, central, and inferior extent of the tangential field).
Use the axial slider to navigate between slices.

> Each slice is independent. You are creating key-frame contours;
> interpolation will fill the gaps in the next step.

### 6c. Repeat on multiple slices

Scroll to another slice with the axial slider, draw again with
the same name. Repeat for the full extent of the field.

---

## Step 7 — Interpolate the field ROI across all slices

1. Click **"⟷ Interpolate"** in the MPR toolbar.
2. If multiple structures exist, a picker appears — choose **`Field`** (or `ROI_1`).
3. Interpolated contours (dashed) fill every integer slice between your key frames.

> If contours look twisted / crossed, redraw the key-frame polygons
> consistently (always start at the same anatomical landmark, e.g.
> top-left corner). The interpolator now handles CW/CCW winding mismatches
> automatically, but very irregular shapes may still benefit from
> consistent start-point placement.

---

## Step 8 — Save all ROIs

Click **"↑ Save ROIs"** in the MPR toolbar.

This POSTs all contours (organ + field) to the backend and writes a file:
```
backend/saved_rois/roi_<timestamp>.json
```

Note the filename — you will need it for the field mask step.

---

## Step 9 — Compute RT metrics (Field Stats tab)

1. Click **"📊 Field Stats"** in the MPR toolbar.
   A new tab opens; all current ROIs are forwarded automatically.

2. **Structure Assignment** — the dropdowns are auto-populated:

   | Dropdown | Select |
   |----------|--------|
   | Treatment Field ROI | `Field` / `ROI_1` |
   | Lung(s) | `Left Lung` + `Right Lung` (hold Ctrl for multi) |
   | Heart | `Heart` |

3. **Beam Direction** (for CLD):
   Enter the 2D beam direction vector in physical mm space.

   | Beam orientation | bx | by |
   |------------------|----|----|
   | Left → Right     | 1  | 0  |
   | Right → Left     | -1 | 0  |
   | Anterior → Post  | 0  | 1  |
   | Oblique (typical tangential) | e.g. 0.7 | 0.7 |

   > Leave bx=1, by=0 if unsure — you can recompute with a different direction
   > instantly without re-running segmentation.

4. Click **"▶ Compute Overlap"**.

### Results

| Metric | Description |
|--------|-------------|
| **Lung %** | Fraction of total lung volume inside the field |
| **Lung in field (cc)** | Absolute lung volume irradiated |
| **Heart %** | Fraction of heart inside the field |
| **Heart in field (cc)** | Absolute heart volume irradiated |
| **CLD (mm)** | Central Lung Distance — max depth of lung along beam at central slice |
| **Field volume (cc)** | Total treatment field volume |
| **Central slice** | Z-index of the mid-field axial slice |

**Colour coding:**

| Colour | Lung threshold | Heart threshold |
|--------|---------------|-----------------|
| Blue / Green | < 20 % / < 5 % | Normal |
| Amber | 20–35 % / 5–10 % | Elevated |
| Red | > 35 % / > 10 % | High |

---

## Step 10 — Generate a 3D binary field mask (optional)

Needed if you want to use the mask in external scripts or pipelines.

1. Open the **AI Segmentation** tab (`🤖 AI Segment` button).
2. Scroll to the **"ROI → 3D Binary Field Mask"** card at the bottom.
3. Click **"↻ Refresh"** to load the saved ROI file list.
4. Select the file saved in Step 8.
5. Enter the ROI name (`Field` or `ROI_1`) in the name box.
6. Click **"▶ Generate"**.

The mask is saved automatically to:
```
backend/saved_masks/mask_<name>_<timestamp>.npy
```

The result card shows:
- Shape (z × row × col)
- Annotated slices (your key frames)
- Interpolated slices (auto-filled)
- Central slice index
- A **"⬇ Download .npy"** link

### Load the mask in Python

```python
import numpy as np

mask = np.load("backend/saved_masks/mask_Field_20260405_143200_000001.npy").astype(bool)
print(mask.shape)   # (nz, nrows, ncols)
print(mask.sum())   # voxel count
```

---

## Step 11 — Compute all features programmatically (optional)

Call `POST /rt-features` directly for batch use or scripting:

```python
import requests, json

rois = json.load(open("backend/saved_rois/roi_20260405_143000_000001.json"))["rois"]

resp = requests.post("http://127.0.0.1:8000/rt-features", json={
    "series_uid":     "",          # leave blank to use all uploaded files
    "rois":           rois,
    "field_roi_name": "Field",
    "lung_roi_names": ["Left Lung", "Right Lung"],
    "heart_roi_name": "Heart",
    "beam_direction": [1, 0],      # left→right beam
})

features = resp.json()
print(features)
```

**Response:**
```json
{
  "lung_volume_cc":           2400.5,
  "heart_volume_cc":           620.1,
  "field_volume_cc":          1850.4,
  "lung_volume_in_field_cc":   310.2,
  "heart_volume_in_field_cc":   48.7,
  "lung_percent_in_field":      12.92,
  "heart_percent_in_field":      7.85,
  "central_slice_index":          65,
  "cld_mm":                      18.3,
  "lung_in_field_pixels":        412,
  "spacing_mm":          [2.5, 0.977, 0.977]
}
```

---

## Quick-reference checklist

```
[ ] 1. Start backend:  uvicorn server:app --reload
[ ] 2. Open frontend/index.html in browser
[ ] 3. Upload DICOM CT folder
[ ] 4. Open MPR view
[ ] 5. AI Segment → Run → Load in MPR View
[ ] 6. Draw field ROI on 2-3 axial slices (same name)
[ ] 7. Interpolate → fill all slices
[ ] 8. Save ROIs  →  note the filename
[ ] 9. Field Stats → assign structures → enter beam direction → Compute
[ ]10. (optional) Generate 3D field mask
[ ]11. (optional) POST /rt-features for programmatic access
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Backend not reachable | Make sure `uvicorn` is running and check `http://127.0.0.1:8000/` returns `{"message":"Server is running"}` |
| No series appear after upload | Check browser console — files may not be CT modality or may have corrupt headers |
| AI segmentation disabled / grey | TotalSegmentator not installed — run `pip install TotalSegmentator` in the venv |
| Twisted interpolated contours | Redraw key frames starting from the same anatomical point; or simply regenerate — the CW/CCW winding fix handles most cases automatically |
| CLD = 0.0 | Lung and field do not overlap at the central slice — check that the field ROI spans the correct z-range and that lung segmentation completed |
| Field mask shape mismatch | Always generate the mask after uploading the same CT series; different uploads → different shapes |
