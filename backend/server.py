from fastapi import FastAPI, UploadFile, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.sequence import Sequence as DicomSequence
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
import pydicom
import datetime
import json
import math
import os
import asyncio
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import numpy as np
import scipy.ndimage as ndi
from skimage.measure import find_contours

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR   = "uploaded_dicoms"
ROI_SAVE_DIR = "saved_rois"
os.makedirs(UPLOAD_DIR,   exist_ok=True)
os.makedirs(ROI_SAVE_DIR, exist_ok=True)

app.mount("/files", StaticFiles(directory="."), name="files")


def fix_dicom_header(path):
    """
    If a DICOM file is missing the File Meta Information header (preamble + DICM prefix),
    rewrite it with a proper header so browser-side dicom-parser can read it.
    """
    try:
        pydicom.dcmread(path, stop_before_pixels=True)
        return  # already valid
    except Exception:
        pass

    ds = pydicom.dcmread(path, force=True)

    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = getattr(ds, "SOPClassUID", "1.2.840.10008.5.1.4.1.1.2")
    meta.MediaStorageSOPInstanceUID = getattr(ds, "SOPInstanceUID", generate_uid())
    meta.TransferSyntaxUID = ExplicitVRLittleEndian

    ds.file_meta = meta
    ds.is_implicit_VR = False
    ds.is_little_endian = True

    ds.save_as(path, write_like_original=False)


@app.post("/upload/")
async def upload(files: list[UploadFile]):
    series_dict = {}

    for file in files:
        filename = os.path.basename(file.filename)
        path = os.path.join(UPLOAD_DIR, filename)

        with open(path, "wb") as f:
            f.write(await file.read())

        try:
            # Ensure file has a valid DICOM meta header for browser parsing
            fix_dicom_header(path)

            ds = pydicom.dcmread(path, stop_before_pixels=True)
            modality = getattr(ds, "Modality", "unknown")
            series_uid = str(getattr(ds, "SeriesInstanceUID", filename))

            if modality == "RTPLAN":
                beams = getattr(ds, "BeamSequence", [])
                series_dict[series_uid] = {
                    "modality": "RTPLAN",
                    "description": getattr(ds, "RTPlanLabel", "RT Plan"),
                    "type": "plan",
                    "metadata": {
                        "label": getattr(ds, "RTPlanLabel", ""),
                        "beam_count": len(beams),
                        "beams": [
                            {
                                "name": getattr(b, "BeamName", "?"),
                                "type": getattr(b, "BeamType", "?"),
                                "energy": str(getattr(b, "NominalBeamEnergy", "?")),
                            }
                            for b in beams
                        ],
                    },
                    "instances": [],
                }

            elif modality == "RTSTRUCT":
                rois = getattr(ds, "StructureSetROISequence", [])
                series_dict[series_uid] = {
                    "modality": "RTSTRUCT",
                    "description": getattr(ds, "StructureSetLabel", "Structure Set"),
                    "type": "struct",
                    "metadata": {
                        "label": getattr(ds, "StructureSetLabel", ""),
                        "roi_count": len(rois),
                        "rois": [
                            {
                                "name": getattr(r, "ROIName", "?"),
                                "number": int(getattr(r, "ROINumber", 0)),
                            }
                            for r in rois
                        ],
                        # Path used by GET /rtstruct/?path=... to load full contour data
                        "path": path,
                    },
                    "instances": [],
                }

            elif modality == "RTDOSE":
                # Skip RT Dose visualization for now
                continue

            elif modality == "REG":
                regs = getattr(ds, "RegistrationSequence", [])
                series_dict[series_uid] = {
                    "modality": "REG",
                    "description": getattr(ds, "SeriesDescription", "Image Registration"),
                    "type": "reg",
                    "metadata": {
                        "description": getattr(ds, "SeriesDescription", "Image Registration"),
                        "entry_count": len(regs),
                    },
                    "instances": [],
                }

            else:
                # CT, MR, RTIMAGE and other image modalities
                image_type = getattr(ds, "ImageType", [])
                if "LOCALIZER" in image_type or "SCOUT" in image_type:
                    continue

                description = getattr(
                    ds,
                    "SeriesDescription",
                    getattr(ds, "RTImageLabel", "NA"),
                )
                instance = int(
                    getattr(ds, "InstanceNumber", getattr(ds, "AcquisitionNumber", 0))
                )

                if series_uid not in series_dict:
                    # Capture key metadata from the first slice of the series
                    ps = getattr(ds, "PixelSpacing", None)
                    series_dict[series_uid] = {
                        "modality": modality,
                        "description": description,
                        "type": "image",
                        "series_metadata": {
                            "rows": int(getattr(ds, "Rows", 0)),
                            "cols": int(getattr(ds, "Columns", 0)),
                            "slice_thickness": float(getattr(ds, "SliceThickness", 0) or 0),
                            "pixel_spacing": [round(float(ps[0]), 3), round(float(ps[1]), 3)] if ps else None,
                            "window_center": float(getattr(ds, "WindowCenter", 0) or 0),
                            "window_width": float(getattr(ds, "WindowWidth", 0) or 0),
                        },
                        "instances": [],
                    }

                series_dict[series_uid]["instances"].append(
                    {"path": path, "instance": instance, "frame": 0}
                )

        except Exception as e:
            print(f"Skipping {filename}: {e}")

    for uid in series_dict:
        series_dict[uid]["instances"].sort(key=lambda x: x["instance"])

    return series_dict


def parse_rtstruct(path: str) -> dict:
    """
    Extract ROI names, numbers, and full contour geometry from an RTSTRUCT file.

    RTSTRUCT stores contours in two parallel sequences:
      StructureSetROISequence  — ROI name + number (no geometry)
      ROIContourSequence       — geometry, linked by ReferencedROINumber

    ContourData is a flat list of floats [x0,y0,z0, x1,y1,z1, ...] in mm,
    in the same patient coordinate system as the CT ImagePositionPatient tag.
    We reshape it into [[x,y,z], ...] triplets.
    """
    ds = pydicom.dcmread(path)

    # Build lookup: ROI number → name
    roi_info: dict[int, str] = {}
    for roi in getattr(ds, "StructureSetROISequence", []):
        num  = int(getattr(roi, "ROINumber", 0))
        name = str(getattr(roi, "ROIName", "?"))
        roi_info[num] = name

    rois = []
    for roi_contour in getattr(ds, "ROIContourSequence", []):
        num  = int(getattr(roi_contour, "ReferencedROINumber", 0))
        name = roi_info.get(num, "?")

        contours = []
        for contour in getattr(roi_contour, "ContourSequence", []):
            data   = [float(v) for v in contour.ContourData]
            # Reshape flat list into [[x,y,z], ...] and round to 3 dp (μm precision)
            points = [
                [round(data[i], 3), round(data[i + 1], 3), round(data[i + 2], 3)]
                for i in range(0, len(data), 3)
            ]
            contours.append(points)

        rois.append({"name": name, "number": num, "contours": contours})

    return {"rois": rois}


@app.get("/rtstruct/")
def get_rtstruct(path: str):
    """
    Return full contour geometry for an RTSTRUCT file.

    The path is the server-side file path returned by /upload/ in the
    'instances' list (same path used for the /files/ static mount).
    Contour data is fetched on demand rather than included in the upload
    response because it can be several MB for a large structure set.

    Query param:
      path — server-side path to the RTSTRUCT .dcm file

    Response: { "rois": [ { "name", "number", "contours": [[[x,y,z],...]] } ] }
    """
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    try:
        return parse_rtstruct(path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Vector helpers (avoid numpy dependency) ───────────────────────────────────

def _dot(a, b):
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]

def _cross(a, b):
    return [a[1]*b[2] - a[2]*b[1],
            a[2]*b[0] - a[0]*b[2],
            a[0]*b[1] - a[1]*b[0]]

def _norm(v):
    l = math.sqrt(_dot(v, v))
    return [v[0]/l, v[1]/l, v[2]/l]


def _load_ct_slices(frame_ref_uid: str) -> list[dict]:
    """
    Scan UPLOAD_DIR for CT/MR slices whose FrameOfReferenceUID matches the
    RTSTRUCT.  Returns one dict per slice with the tags needed for the
    coordinate transform.

    Sorted by InstanceNumber ascending — the same order used by the frontend
    loadSeries() function.  This ensures that slice_index N in the backend
    corresponds to currentIndex N in the frontend regardless of whether the
    scanner acquired superior→inferior or inferior→superior.

    (A geometry-based sort on dot(IPP, normal) was used previously but caused
    a complete reversal on scanners where InstanceNumber increases
    superior→inferior, because that order is opposite to ascending z-position.)
    """
    slices = []
    for fname in os.listdir(UPLOAD_DIR):
        fpath = os.path.join(UPLOAD_DIR, fname)
        try:
            ds = pydicom.dcmread(fpath, stop_before_pixels=True)
            if getattr(ds, "Modality", "") not in ("CT", "MR"):
                continue
            if str(getattr(ds, "FrameOfReferenceUID", "")) != frame_ref_uid:
                continue

            ipp = [float(v) for v in ds.ImagePositionPatient]     # [x,y,z] mm
            iop = [float(v) for v in ds.ImageOrientationPatient]  # 6 cosines
            ps  = [float(v) for v in ds.PixelSpacing]             # [row_sp, col_sp]

            slices.append({
                "ipp": ipp,
                "iop": iop,
                "ps":  ps,
                "rows": int(getattr(ds, "Rows", 0)),
                "cols": int(getattr(ds, "Columns", 0)),
                "instance": int(getattr(ds, "InstanceNumber", 0)),
            })
        except Exception:
            continue

    # Match frontend sort: InstanceNumber ascending.
    slices.sort(key=lambda s: s["instance"])
    return slices


def parse_rtstruct_pixels(struct_path: str) -> dict:
    """
    Parse an RTSTRUCT file and convert all contour world coordinates (mm)
    to image pixel coordinates (row, col, slice_index).

    ── DICOM coordinate system ──────────────────────────────────────────────
    Each CT slice defines an affine mapping from pixel (row, col) to patient
    mm via three DICOM tags:

      ImagePositionPatient   (IPP)  [x,y,z] of the top-left pixel (col=0,row=0)
      ImageOrientationPatient (IOP) [F_row_x..z, F_col_x..z]
                                    F_row: unit vector along a row (col axis)
                                    F_col: unit vector along a column (row axis)
      PixelSpacing           [row_spacing, col_spacing]  (mm per pixel)

    Forward transform (pixel → patient mm):
      P = IPP  +  col × F_row × col_spacing
                +  row × F_col × row_spacing

    ── Inverse transform (patient mm → pixel) ───────────────────────────────
    Given a contour point P = (Px, Py, Pz) in patient mm:

      col = dot(P - IPP, F_row) / col_spacing
      row = dot(P - IPP, F_col) / row_spacing

    These are exact because F_row and F_col are orthonormal — projecting
    onto them decomposes the offset vector into its column and row components.

    ── Slice matching ────────────────────────────────────────────────────────
    The slice-normal N = F_row × F_col is perpendicular to the image plane.
    Every CT slice has a unique signed position along N:

      pos_i = dot(IPP_i, N)

    A contour point's normal position is:
      pos_P = dot(P, N)

    We find the slice whose pos_i is closest to pos_P.  Using the closest
    slice rather than the reference-frame first slice is important for tilted
    gantry acquisitions where IPP shifts between slices.
    """
    struct_ds = pydicom.dcmread(struct_path)

    # ── Resolve FrameOfReferenceUID ──────────────────────────────────────────
    # It may sit directly on the dataset or inside ReferencedFrameOfReferenceSequence.
    frame_ref_uid = str(getattr(struct_ds, "FrameOfReferenceUID", ""))
    if not frame_ref_uid:
        for ref in getattr(struct_ds, "ReferencedFrameOfReferenceSequence", []):
            frame_ref_uid = str(getattr(ref, "FrameOfReferenceUID", ""))
            if frame_ref_uid:
                break
    if not frame_ref_uid:
        raise ValueError("RTSTRUCT has no FrameOfReferenceUID — cannot match CT slices")

    # ── Load matching CT slices ───────────────────────────────────────────────
    ct_slices = _load_ct_slices(frame_ref_uid)
    if not ct_slices:
        raise ValueError(f"No CT/MR slices found for FrameOfReferenceUID: {frame_ref_uid}")

    # ── Build coordinate transform from first slice ───────────────────────────
    # All slices share the same IOP and PixelSpacing for a standard acquisition.
    # Use the first slice (lowest InstanceNumber) as the reference for IOP/spacing.
    iop0       = ct_slices[0]["iop"]
    F_row      = iop0[:3]                       # unit vec along columns
    F_col      = iop0[3:]                       # unit vec along rows
    normal     = _norm(_cross(F_row, F_col))    # unit vec perpendicular to image
    row_sp     = ct_slices[0]["ps"][0]          # mm between row centres
    col_sp     = ct_slices[0]["ps"][1]          # mm between col centres

    # Pre-compute each slice's signed position along the normal for fast lookup
    slice_positions = [_dot(s["ipp"], normal) for s in ct_slices]

    def world_to_pixel(x: float, y: float, z: float) -> tuple[float, float, int]:
        """
        Convert patient-space point (mm) → (row, col, slice_index).
        row and col are floating-point sub-pixel positions; round for display.
        slice_index is the index into ct_slices (sorted by InstanceNumber ascending).
        """
        p    = [x, y, z]

        # Reference IPP of the closest slice — more accurate for tilted gantry
        pt_pos = _dot(p, normal)
        slice_idx = min(range(len(slice_positions)),
                        key=lambda i: abs(slice_positions[i] - pt_pos))
        ipp = ct_slices[slice_idx]["ipp"]

        delta = [p[0] - ipp[0], p[1] - ipp[1], p[2] - ipp[2]]

        col = _dot(delta, F_row) / col_sp   # along F_row = column direction
        row = _dot(delta, F_col) / row_sp   # along F_col = row    direction

        return row, col, slice_idx

    # ── Build ROI name lookup ─────────────────────────────────────────────────
    roi_info: dict[int, str] = {}
    for roi in getattr(struct_ds, "StructureSetROISequence", []):
        num  = int(getattr(roi, "ROINumber", 0))
        roi_info[num] = str(getattr(roi, "ROIName", "?"))

    # ── Convert contours ──────────────────────────────────────────────────────
    rois = []
    for roi_contour in getattr(struct_ds, "ROIContourSequence", []):
        num  = int(getattr(roi_contour, "ReferencedROINumber", 0))
        name = roi_info.get(num, "?")

        contours = []
        for contour in getattr(roi_contour, "ContourSequence", []):
            data      = [float(v) for v in contour.ContourData]
            slice_idx = None
            points    = []

            for i in range(0, len(data), 3):
                row, col, sidx = world_to_pixel(data[i], data[i+1], data[i+2])
                # All points in one ContourSequence item lie on the same slice.
                # Record the slice index from the first point only.
                if slice_idx is None:
                    slice_idx = sidx
                points.append([round(row, 2), round(col, 2)])

            contours.append({"slice_index": slice_idx, "points": points})

        rois.append({"name": name, "number": num, "contours": contours})

    # ── Compute slice spacing for the caller ──────────────────────────────────
    if len(slice_positions) > 1:
        slice_spacing = abs(slice_positions[1] - slice_positions[0])
    else:
        slice_spacing = float(getattr(struct_ds, "SliceThickness", 1) or 1)

    return {
        "rois": rois,
        "ct": {
            "slice_count":  len(ct_slices),
            "rows":         ct_slices[0]["rows"],
            "cols":         ct_slices[0]["cols"],
            "pixel_spacing": [row_sp, col_sp],
            "slice_spacing": round(slice_spacing, 4),
        },
    }


@app.get("/rtstruct/pixels/")
def get_rtstruct_pixels(path: str):
    """
    Return contour geometry mapped to CT pixel coordinates.

    Scans the upload directory for CT slices that share the RTSTRUCT's
    FrameOfReferenceUID, then converts every contour point from patient-
    space mm to (row, col, slice_index) using the DICOM affine inverse.

    Query param:
      path — server-side path to the RTSTRUCT .dcm file
             (returned by /upload/ as series.metadata.path)

    Response:
      {
        "rois": [
          {
            "name": "GTV",
            "number": 1,
            "contours": [
              { "slice_index": 45, "points": [[row, col], ...] }
            ]
          }
        ],
        "ct": {
          "slice_count": 125,
          "rows": 512, "cols": 512,
          "pixel_spacing": [0.977, 0.977],
          "slice_spacing": 3.0
        }
      }
    """
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    try:
        return parse_rtstruct_pixels(path)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/rtstruct/slices/")
def get_rtstruct_slices(path: str):
    """
    Return RTSTRUCT contours grouped by slice, then by ROI — ready for the
    frontend to iterate without any client-side reshaping.

    Internally calls parse_rtstruct_pixels(), then pivots the per-ROI list
    into a slice-keyed dict so the renderer can look up all ROIs on a given
    slice in O(1).

    Query param:
      path — server-side path to the RTSTRUCT .dcm file
             (returned by /upload/ as series.metadata.path)

    Response:
      {
        "slices": {
          "slice_45": [
            { "name": "GTV", "number": 1, "points": [[row, col], ...] },
            { "name": "PTV", "number": 2, "points": [[row, col], ...] }
          ],
          "slice_46": [ ... ]
        },
        "ct": {
          "slice_count": 125,
          "rows": 512, "cols": 512,
          "pixel_spacing": [0.977, 0.977],
          "slice_spacing": 3.0
        }
      }
    """
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    try:
        data = parse_rtstruct_pixels(path)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Pivot: per-ROI contour list → slice-keyed dict of ROI entries.
    # A single ROI may have multiple contours on the same slice (e.g. islands);
    # they are kept as separate entries so the frontend can draw each polygon.
    slices: dict[str, list] = {}
    for roi in data["rois"]:
        for contour in roi["contours"]:
            key = f"slice_{contour['slice_index']}"
            slices.setdefault(key, []).append({
                "name":   roi["name"],
                "number": roi["number"],
                "points": contour["points"],
            })

    return {"slices": slices, "ct": data["ct"]}


# ── ROI persistence ───────────────────────────────────────────────────────────

@app.post("/save-roi")
async def save_roi(payload: dict = Body(...)):
    """
    Persist a list of drawn ROIs to disk as JSON.

    Expected body:
      { "rois": [ { "id", "name", "slice", "points", "color", "source" }, ... ] }

    Each ROI must include at minimum: name (str), slice (int), points ([[x,y],...]).
    Extra fields are accepted and stored unchanged.

    Returns: { "status": "ok", "filename": "roi_<timestamp>.json", "count": N }
    """
    rois = payload.get("rois")
    if not isinstance(rois, list):
        raise HTTPException(status_code=422, detail="Body must contain a 'rois' list")

    for i, r in enumerate(rois):
        if "name"   not in r: raise HTTPException(422, f"ROI[{i}] missing 'name'")
        if "slice"  not in r: raise HTTPException(422, f"ROI[{i}] missing 'slice'")
        if "points" not in r: raise HTTPException(422, f"ROI[{i}] missing 'points'")

    timestamp = datetime.datetime.utcnow().strftime("%Y%m%d_%H%M%S_%f")
    filename  = f"roi_{timestamp}.json"
    filepath  = os.path.join(ROI_SAVE_DIR, filename)

    record = {
        "saved_at": timestamp,
        "roi_count": len(rois),
        "rois": rois,
    }

    with open(filepath, "w") as f:
        json.dump(record, f, indent=2)

    return {"status": "ok", "filename": filename, "count": len(rois)}


@app.get("/load-roi/")
def list_roi_files():
    """
    Return a list of all saved ROI filenames, newest first.

    Response: { "files": ["roi_20260404_123456_000001.json", ...] }
    """
    files = sorted(
        (f for f in os.listdir(ROI_SAVE_DIR) if f.endswith(".json")),
        reverse=True,
    )
    return {"files": files}


@app.get("/load-roi/{filename}")
def load_roi(filename: str):
    """
    Load a previously saved ROI JSON file by name.

    Path param:
      filename — exact filename returned by POST /save-roi or GET /load-roi/

    Response: the full saved record including 'saved_at', 'roi_count', 'rois'.
    """
    safe_name = os.path.basename(filename)          # prevent path traversal
    filepath  = os.path.join(ROI_SAVE_DIR, safe_name)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail=f"Not found: {safe_name}")
    with open(filepath) as f:
        return json.load(f)


# ── RTSTRUCT export ───────────────────────────────────────────────────────────

def _load_ct_for_export(series_uid: str = "") -> list[dict]:
    """
    Load CT/MR slices from UPLOAD_DIR for RTSTRUCT coordinate transform.

    Optionally filter by SeriesInstanceUID (pass "" to accept any CT/MR).
    Returns slices sorted by InstanceNumber ascending — the same ordering
    used by the frontend loadSeries(), so slice index N in the ROI JSON
    corresponds to ct_slices[N] here without any extra mapping.

    Each dict contains:
      ipp, iop, ps            — affine transform parameters (see _pixels_to_patient)
      instance                — InstanceNumber for sorting
      frame_ref_uid           — FrameOfReferenceUID written into the RTSTRUCT
      study_uid               — CT StudyInstanceUID (RTSTRUCT inherits this)
      series_uid              — CT SeriesInstanceUID (referenced in RTSTRUCT)
      sop_class_uid           — CT SOPClassUID (per-slice reference)
      sop_instance_uid        — CT SOPInstanceUID (per-slice reference)
    """
    slices = []
    for fname in os.listdir(UPLOAD_DIR):
        fpath = os.path.join(UPLOAD_DIR, fname)
        try:
            ds = pydicom.dcmread(fpath, stop_before_pixels=True)
            if getattr(ds, "Modality", "") not in ("CT", "MR"):
                continue
            if series_uid and str(getattr(ds, "SeriesInstanceUID", "")) != series_uid:
                continue

            ipp = [float(v) for v in ds.ImagePositionPatient]
            iop = [float(v) for v in ds.ImageOrientationPatient]
            ps  = [float(v) for v in ds.PixelSpacing]

            slices.append({
                "ipp":              ipp,
                "iop":              iop,
                "ps":               ps,
                "rows":             int(getattr(ds, "Rows",              0)),
                "cols":             int(getattr(ds, "Columns",           0)),
                "instance":         int(getattr(ds, "InstanceNumber",    0)),
                "frame_ref_uid":    str(getattr(ds, "FrameOfReferenceUID", generate_uid())),
                "study_uid":        str(getattr(ds, "StudyInstanceUID",    generate_uid())),
                "series_uid":       str(getattr(ds, "SeriesInstanceUID",   "")),
                "sop_class_uid":    str(getattr(ds, "SOPClassUID",         "")),
                "sop_instance_uid": str(getattr(ds, "SOPInstanceUID",      generate_uid())),
            })
        except Exception:
            continue

    # Must match the frontend sort (InstanceNumber ascending = same as loadSeries).
    slices.sort(key=lambda s: s["instance"])
    return slices


def _pixels_to_patient(points: list, ct: dict) -> list[float]:
    """
    Convert a polygon's pixel coordinates to patient-space mm (ContourData format).

    ── DICOM affine forward transform ────────────────────────────────────────
    DICOM PS 3.3 C.7.6.2 defines the pixel → patient mapping for each slice:

        P = IPP  +  col × F_row × ΔC  +  row × F_col × ΔR

    where:
      IPP   = ImagePositionPatient   — patient-space position of pixel (0, 0)
      F_row = IOP[:3]                — unit vector along increasing column index
      F_col = IOP[3:]                — unit vector along increasing row index
      ΔC    = PixelSpacing[1]        — mm between adjacent column centres
      ΔR    = PixelSpacing[0]        — mm between adjacent row centres

    The frontend stores points as [[col, row], ...] in 0-based pixel indices.

    Returns a flat [x,y,z, x,y,z, ...] list as required by ContourData.
    """
    ipp    = ct["ipp"]
    iop    = ct["iop"]
    ps     = ct["ps"]
    F_row  = iop[:3]    # direction cosines along a row  (increasing column)
    F_col  = iop[3:]    # direction cosines along a col  (increasing row)
    col_sp = ps[1]      # ΔC — mm between adjacent column centres
    row_sp = ps[0]      # ΔR — mm between adjacent row centres

    flat = []
    for (col, row) in points:
        Px = ipp[0] + col * F_row[0] * col_sp + row * F_col[0] * row_sp
        Py = ipp[1] + col * F_row[1] * col_sp + row * F_col[1] * row_sp
        # Pz: IPP_z plus any out-of-plane component from F_row/F_col
        # (zero for standard axial scans, non-zero for oblique acquisitions)
        Pz = ipp[2] + col * F_row[2] * col_sp + row * F_col[2] * row_sp
        flat.extend([round(Px, 3), round(Py, 3), round(Pz, 3)])
    return flat


def _hex_to_rgb(color: str) -> list[int]:
    """Convert a '#rrggbb' CSS hex color string to [R, G, B] for ROIDisplayColor."""
    h = color.lstrip("#")
    if len(h) == 6:
        try:
            return [int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)]
        except ValueError:
            pass
    return [255, 68, 68]   # fallback red


def _ref_image_item(sop_class_uid: str, sop_instance_uid: str) -> pydicom.Dataset:
    """One ContourImageSequence item — references a single CT slice SOP instance."""
    item = pydicom.Dataset()
    item.ReferencedSOPClassUID    = sop_class_uid
    item.ReferencedSOPInstanceUID = sop_instance_uid
    return item


def _roi_contour_data(roi: dict, ct_slices: list[dict]) -> list[float]:
    """
    Convert one ROI's polygon to a flat [x,y,z,...] patient-mm ContourData list.

    Handles both coordinate origins:

    ── 2D viewer  (source = 'draw2d') or axial MPR ──────────────────────────
      points = [[col, row], ...]  at  slice_idx = roi["slice"]
      All points share the same CT slice → single _pixels_to_patient call.

    ── MPR coronal  (plane = 'coronal') ─────────────────────────────────────
      The coronal canvas is rendered with a horizontal flip:
        data[dstRow + (ncols-1-c)] = buf[srcRow + c]
      So canvas ix = ncols-1-col  ↔  col = ncols-1-ix

      Mapping from canvas (ix, iy) at planeIndex = CT row y:
        col = ncols - 1 - ix
        row = planeIndex
        z   = iy               (iy is the CT slice index in the coronal view)

    ── MPR sagittal  (plane = 'sagittal') ───────────────────────────────────
      The sagittal canvas is rendered with a horizontal flip:
        data[dstRow + (nrows-1-r)] = buf[... + r*cols + x]
      So canvas ix = nrows-1-row  ↔  row = nrows-1-ix

      Mapping from canvas (ix, iy) at planeIndex = CT col x:
        col = planeIndex
        row = nrows - 1 - ix
        z   = iy               (iy is the CT slice index in the sagittal view)

    Each coronal/sagittal point may reference a different CT slice (different z),
    so each point gets its own _pixels_to_patient call with the appropriate slice.
    """
    plane      = roi.get("plane",       "axial")
    source     = roi.get("source",      "draw2d")
    points     = roi.get("points",      [])
    plane_idx  = int(roi.get("planeIndex", roi.get("slice", 0)))

    if not ct_slices or not points:
        return []

    ncols = ct_slices[0].get("cols", 512)
    nrows = ct_slices[0].get("rows", 512)

    # ── Axial (2D viewer or MPR axial) ────────────────────────────────────────
    if source != "mpr" or plane == "axial":
        slice_idx = int(roi.get("slice", plane_idx))
        if slice_idx >= len(ct_slices):
            return []
        return _pixels_to_patient(points, ct_slices[slice_idx])

    # ── MPR coronal / sagittal — one patient point per polygon vertex ─────────
    flat = []
    for (ix, iy) in points:
        if plane == "coronal":
            col = ncols - 1 - int(ix)   # un-flip horizontal
            row = plane_idx              # fixed CT row = planeIndex
            z   = int(iy)               # iy = CT slice index in the coronal view
        else:  # sagittal
            col = plane_idx             # fixed CT col = planeIndex
            row = nrows - 1 - int(ix)  # un-flip horizontal
            z   = int(iy)              # iy = CT slice index in the sagittal view

        if z >= len(ct_slices):
            continue
        pt_mm = _pixels_to_patient([[col, row]], ct_slices[z])
        flat.extend(pt_mm)

    return flat


def _build_rtstruct(rois: list[dict], ct_slices: list[dict]) -> FileDataset:
    """
    Build a DICOM RT Structure Set (RTSTRUCT) dataset from drawn ROI polygons.

    ── RTSTRUCT internal structure ───────────────────────────────────────────
    Three parallel sequences hold different aspects of each ROI:

      StructureSetROISequence      — ROI number and name (no geometry)
      ROIContourSequence           — 3-D contour geometry per ROI
        └─ ContourSequence         — one item per planar polygon
             ContourData           — flat [x,y,z, x,y,z,...] in patient mm
      RTROIObservationsSequence    — clinical type / label per ROI

    Plus:
      ReferencedFrameOfReferenceSequence
        — ties this RTSTRUCT to the CT's coordinate frame and series, so
          treatment-planning systems can auto-register it against the CT.

    ── Coordinate transform ──────────────────────────────────────────────────
    See _pixels_to_patient() for the full pixel → patient mm formula.
    """
    now = datetime.datetime.now()
    RT_STRUCT_CLASS = "1.2.840.10008.5.1.4.1.1.481.3"

    # ── File meta ──────────────────────────────────────────────────────────────
    sop_instance_uid = generate_uid()
    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID    = RT_STRUCT_CLASS
    file_meta.MediaStorageSOPInstanceUID = sop_instance_uid
    file_meta.TransferSyntaxUID          = ExplicitVRLittleEndian

    ds = FileDataset(None, {}, file_meta=file_meta, preamble=b"\0" * 128)
    ds.is_implicit_VR   = False
    ds.is_little_endian = True

    # ── Shared CT metadata — RTSTRUCT lives in the same study as the CT ────────
    ref = ct_slices[0]
    frame_ref_uid = ref["frame_ref_uid"]
    study_uid     = ref["study_uid"]
    ct_series_uid = ref["series_uid"]

    # ── Patient / study tags ───────────────────────────────────────────────────
    ds.SpecificCharacterSet       = "ISO_IR 6"
    ds.InstanceCreationDate       = now.strftime("%Y%m%d")
    ds.InstanceCreationTime       = now.strftime("%H%M%S")
    ds.SOPClassUID                = RT_STRUCT_CLASS
    ds.SOPInstanceUID             = sop_instance_uid
    ds.Modality                   = "RTSTRUCT"
    ds.Manufacturer               = ""
    ds.StudyDate                  = now.strftime("%Y%m%d")
    ds.StudyTime                  = ""
    ds.AccessionNumber            = ""
    ds.StudyDescription           = ""
    ds.SeriesDescription          = "Drawn ROIs export"
    ds.PatientName                = "Anonymous"
    ds.PatientID                  = ""
    ds.PatientBirthDate           = ""
    ds.PatientSex                 = ""
    ds.StudyInstanceUID           = study_uid      # same study as the CT
    ds.SeriesInstanceUID          = generate_uid() # new series for the RTSTRUCT
    ds.FrameOfReferenceUID        = frame_ref_uid
    ds.PositionReferenceIndicator = ""
    ds.SeriesNumber               = "1"
    ds.InstanceNumber             = "1"
    ds.StructureSetLabel          = "Drawn ROIs"
    ds.StructureSetDate           = now.strftime("%Y%m%d")
    ds.StructureSetTime           = now.strftime("%H%M%S")

    # ── ReferencedFrameOfReferenceSequence ─────────────────────────────────────
    # Links the RTSTRUCT to the CT geometry so TPS software can auto-register.
    # Includes RTReferencedStudySequence → RTReferencedSeriesSequence →
    # ContourImageSequence (one item per CT slice).
    contour_images = DicomSequence([
        _ref_image_item(s["sop_class_uid"], s["sop_instance_uid"])
        for s in ct_slices
    ])

    ref_series = pydicom.Dataset()
    ref_series.SeriesInstanceUID      = ct_series_uid
    ref_series.ContourImageSequence   = contour_images

    ref_study = pydicom.Dataset()
    ref_study.ReferencedSOPClassUID    = "1.2.840.10008.3.1.2.3.1"  # Detached Study Mgmt
    ref_study.ReferencedSOPInstanceUID = study_uid
    ref_study.RTReferencedSeriesSequence = DicomSequence([ref_series])

    ref_frame = pydicom.Dataset()
    ref_frame.FrameOfReferenceUID        = frame_ref_uid
    ref_frame.PositionReferenceIndicator = ""
    ref_frame.RTReferencedStudySequence  = DicomSequence([ref_study])

    ds.ReferencedFrameOfReferenceSequence = DicomSequence([ref_frame])

    # ── Group ROIs by name ────────────────────────────────────────────────────
    # ROIs sharing the same name form one RT structure.  This allows a
    # hand-drawn + interpolated set to export as a single DICOM structure with
    # one ContourSequence item per slice — the correct DICOM representation.
    groups: dict = defaultdict(list)
    for roi in rois:
        groups[roi.get("name", "ROI")].append(roi)
    unique_names = list(groups.keys())   # insertion-order stable (Python 3.7+)

    # ── StructureSetROISequence — one item per unique structure name ───────────
    ss_rois = []
    for i, name in enumerate(unique_names):
        item = pydicom.Dataset()
        item.ROINumber                     = i + 1
        item.ReferencedFrameOfReferenceUID = frame_ref_uid
        item.ROIName                       = name
        item.ROIGenerationAlgorithm        = "MANUAL"
        ss_rois.append(item)
    ds.StructureSetROISequence = DicomSequence(ss_rois)

    # ── ROIContourSequence — one entry per unique name, N contour items ────────
    # Each member ROI of the group becomes one ContourSequence item (one slice).
    roi_contours = []
    for i, name in enumerate(unique_names):
        members = groups[name]
        color   = members[0].get("color", "#ff4444")

        contour_items = []
        for roi in members:
            contour_data = _roi_contour_data(roi, ct_slices)
            if len(contour_data) < 9:   # skip degenerate polygons (< 3 points)
                continue
            contour = pydicom.Dataset()
            contour.ContourGeometricType  = "CLOSED_PLANAR"
            contour.NumberOfContourPoints = len(contour_data) // 3
            contour.ContourData           = contour_data
            contour_items.append(contour)

        if not contour_items:
            continue    # skip structures with no valid geometry

        roi_contour = pydicom.Dataset()
        roi_contour.ReferencedROINumber = i + 1
        roi_contour.ROIDisplayColor     = _hex_to_rgb(color)
        roi_contour.ContourSequence     = DicomSequence(contour_items)
        roi_contours.append(roi_contour)

    ds.ROIContourSequence = DicomSequence(roi_contours)

    # ── RTROIObservationsSequence — one entry per unique structure name ────────
    observations = []
    for i, name in enumerate(unique_names):
        obs = pydicom.Dataset()
        obs.ObservationNumber    = i + 1
        obs.ReferencedROINumber  = i + 1
        obs.ROIObservationLabel  = name
        obs.RTROIInterpretedType = "ORGAN"   # relabel in TPS as needed
        obs.ROIInterpreter       = ""
        observations.append(obs)
    ds.RTROIObservationsSequence = DicomSequence(observations)

    return ds


@app.post("/export-rtstruct")
async def export_rtstruct(payload: dict = Body(...)):
    """
    Convert a saved ROI JSON file into an RT Structure Set DICOM file and
    return it as a downloadable attachment.

    Body:
      {
        "filename":   "roi_<timestamp>.json",  — file in saved_rois/
        "series_uid": ""                        — optional CT SeriesInstanceUID
                                                  filter; "" = use any CT/MR
      }

    Processing steps:
      1. Load ROI JSON from saved_rois/{filename}
      2. Load CT slices from uploaded_dicoms/ (sorted by InstanceNumber,
         matching the frontend's loadSeries() order so slice indices align)
      3. Convert each ROI polygon from pixel coords → patient mm via the
         DICOM affine transform (see _pixels_to_patient)
      4. Build a valid RTSTRUCT dataset with pydicom
      5. Write to saved_rois/ and return as application/octet-stream

    Response: .dcm file download
    """
    filename   = payload.get("filename",   "")
    series_uid = payload.get("series_uid", "")

    # ── Load ROI record ────────────────────────────────────────────────────────
    safe_name = os.path.basename(filename)
    filepath  = os.path.join(ROI_SAVE_DIR, safe_name)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail=f"ROI file not found: {safe_name}")

    with open(filepath) as f:
        record = json.load(f)

    rois = record.get("rois", [])
    if not rois:
        raise HTTPException(status_code=422, detail="No ROIs found in file")

    # ── Load CT slices ─────────────────────────────────────────────────────────
    ct_slices = _load_ct_for_export(series_uid)
    if not ct_slices:
        raise HTTPException(
            status_code=422,
            detail="No CT/MR slices found in uploaded_dicoms/ — upload a CT series first",
        )

    # ── Build RTSTRUCT ─────────────────────────────────────────────────────────
    try:
        ds = _build_rtstruct(rois, ct_slices)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"RTSTRUCT build error: {e}")

    # ── Write and return ───────────────────────────────────────────────────────
    out_name = safe_name.replace(".json", "_rtstruct.dcm")
    out_path = os.path.join(ROI_SAVE_DIR, out_name)
    ds.save_as(out_path, write_like_original=False)

    return FileResponse(
        out_path,
        media_type="application/octet-stream",
        filename=out_name,
    )


# ══════════════════════════════════════════════════════════════════════════════
# Auto-segmentation: Lung (seed-based) + Heart (automatic)
# ══════════════════════════════════════════════════════════════════════════════
#
# All heavy numpy/scipy operations run inside asyncio.to_thread() so they
# execute in a background thread and never block FastAPI's event loop.
# Without this, WADO image requests time out during processing, causing
# blank views and the impression that the server has hung.
#
# Performance notes:
#  - Volume loading: parallelised with ThreadPoolExecutor (8 workers)
#  - Morphological closing: 2D per-slice disk closing (10-100× faster than
#    3D closing on a 512×512×N volume)
#  - Typical wall time: 5-15 s for a 150-slice CT on a modern CPU

# ── Volume loading (parallel) ──────────────────────────────────────────────────

def _read_one_dicom(fpath: str, series_uid: str):
    """Load one DICOM file's pixel array + metadata. Returns dict or None."""
    try:
        ds = pydicom.dcmread(fpath)
        if getattr(ds, "Modality", "") not in ("CT", "MR"):
            return None
        if series_uid and str(getattr(ds, "SeriesInstanceUID", "")) != series_uid:
            return None
        arr   = ds.pixel_array.astype(np.float32)
        slope = float(getattr(ds, "RescaleSlope",     1.0))
        inter = float(getattr(ds, "RescaleIntercept", 0.0))
        ps    = [float(v) for v in ds.PixelSpacing]
        return {
            "hu":               arr * slope + inter,
            "ipp":              [float(v) for v in ds.ImagePositionPatient],
            "iop":              [float(v) for v in ds.ImageOrientationPatient],
            "ps":               ps,
            "rows":             int(ds.Rows),
            "cols":             int(ds.Columns),
            "instance":         int(getattr(ds, "InstanceNumber",      0)),
            "slice_thickness":  float(getattr(ds, "SliceThickness",    ps[0])),
            "frame_ref_uid":    str(getattr(ds, "FrameOfReferenceUID", generate_uid())),
            "study_uid":        str(getattr(ds, "StudyInstanceUID",    generate_uid())),
            "series_uid":       str(getattr(ds, "SeriesInstanceUID",   "")),
            "sop_class_uid":    str(getattr(ds, "SOPClassUID",         "")),
            "sop_instance_uid": str(getattr(ds, "SOPInstanceUID",      generate_uid())),
        }
    except Exception:
        return None


def _load_ct_volume(series_uid: str = "") -> tuple:
    """
    Load all CT slices as a 3D HU numpy array.

    Uses a thread pool so multiple DICOM files are decoded in parallel,
    cutting typical I/O time from ~15 s to ~3-5 s for a 150-slice CT.

    Returns:
      vol       — np.ndarray  shape (nz, nrows, ncols), float32, HU
      ct_slices — list[dict]  sorted by InstanceNumber; each dict has the
                              same fields as _load_ct_for_export() plus
                              'slice_thickness'
    """
    fpaths = [os.path.join(UPLOAD_DIR, f) for f in os.listdir(UPLOAD_DIR)]
    loader = partial(_read_one_dicom, series_uid=series_uid)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(loader, fpaths))

    slices = [r for r in results if r is not None]
    if not slices:
        return None, []

    slices.sort(key=lambda s: s["instance"])
    vol = np.stack([s.pop("hu") for s in slices], axis=0)   # (nz, nr, nc)
    return vol.astype(np.float32), slices


# ── Morphological helpers ──────────────────────────────────────────────────────

def _remove_external_air(mask: np.ndarray) -> np.ndarray:
    """
    Zero out any connected component that touches the volume boundary
    (= external / outside-body air).  Works slice-by-slice in the
    superior/inferior direction for speed, then does one 3-D label pass
    to catch anything that slipped through.
    """
    labeled, _ = ndi.label(mask)
    edge_labels = set()
    for face in (labeled[0], labeled[-1],
                 labeled[:, 0], labeled[:, -1],
                 labeled[:, :, 0], labeled[:, :, -1]):
        edge_labels.update(np.unique(face).tolist())
    edge_labels.discard(0)

    if not edge_labels:
        return mask

    ext = np.zeros_like(labeled, dtype=bool)
    for lbl in edge_labels:
        ext |= (labeled == lbl)
    return mask & ~ext


def _make_disk_2d(radius: int) -> np.ndarray:
    """Return a 2-D boolean disk structuring element of the given pixel radius."""
    y, x = np.ogrid[-radius:radius + 1, -radius:radius + 1]
    return (y ** 2 + x ** 2) <= radius ** 2


def _close_mask_2d(mask: np.ndarray, r_xy: int) -> np.ndarray:
    """
    Apply 2-D disk morphological closing + hole fill to every axial slice.

    This is 10-100× faster than the equivalent 3-D closing on a
    512×512×N volume and is sufficient because we extract per-slice
    contours anyway.  Nodules (bright spots inside dark lung) appear as
    holes in the threshold mask; closing fills them up to the disk radius.
    """
    disk   = _make_disk_2d(r_xy)
    result = np.zeros_like(mask)
    for z in range(mask.shape[0]):
        if not mask[z].any():
            continue
        closed      = ndi.binary_closing(mask[z], structure=disk)
        result[z]   = ndi.binary_fill_holes(closed)
    return result


# ── Seed / label helpers ───────────────────────────────────────────────────────

def _nearest_label(labeled: np.ndarray, z: int, row: int, col: int,
                   radius_px: int = 25) -> int:
    """
    Return the most common non-zero label within `radius_px` pixels of
    (z, row, col) in a 3-D label array.

    Searching a neighbourhood rather than the exact voxel makes the seed
    robust to clicks on nodules, vessels, or bronchial walls — all of which
    have higher HU than the −300 threshold and would be 0 in the air mask.
    """
    nz, nr, nc = labeled.shape
    z0, z1 = max(0, z   - radius_px), min(nz, z   + radius_px + 1)
    r0, r1 = max(0, row - radius_px), min(nr, row + radius_px + 1)
    c0, c1 = max(0, col - radius_px), min(nc, col + radius_px + 1)

    region  = labeled[z0:z1, r0:r1, c0:c1]
    nonzero = region[region > 0]
    if nonzero.size == 0:
        return 0
    vals, counts = np.unique(nonzero, return_counts=True)
    return int(vals[np.argmax(counts)])


def _find_auto_lung_seeds(vol: np.ndarray) -> tuple:
    """
    Automatically locate seed points for the left and right lungs.

    Scans axial slices in the middle third of the volume.  For each slice
    it removes border-touching air (external air) via 2-D connected
    components, then looks for two large internal air regions (= the two
    lung fields).  Returns on the first slice that yields two candidates.

    Returns (seed_left, seed_right) as (z, row, col) tuples.
    Raises ValueError if two distinct regions cannot be found.
    """
    nz, nr, nc = vol.shape

    for threshold in (-300, -200, -100):
        for z in range(nz // 4, 3 * nz // 4):
            air_2d = vol[z] < threshold
            if air_2d.sum() < 500:
                continue

            # 2-D connected components on this slice.
            labeled_2d, n = ndi.label(air_2d)
            if n < 2:
                continue

            # Identify border-touching (external) labels.
            border = set()
            for edge in (labeled_2d[0], labeled_2d[-1],
                         labeled_2d[:, 0], labeled_2d[:, -1]):
                border.update(np.unique(edge).tolist())
            border.discard(0)

            # Collect internal components with size ≥ 200 px.
            internal = {
                lbl: int((labeled_2d == lbl).sum())
                for lbl in range(1, n + 1)
                if lbl not in border and (labeled_2d == lbl).sum() >= 200
            }
            if len(internal) < 2:
                continue

            # Two largest internal components → left/right lung.
            top2  = sorted(internal, key=lambda l: -internal[l])[:2]
            cA    = ndi.center_of_mass(labeled_2d == top2[0])
            cB    = ndi.center_of_mass(labeled_2d == top2[1])

            # Sort by column index: smaller col = patient's anatomical right
            # (standard DICOM LPS orientation: col increases to patient's left).
            if cA[1] <= cB[1]:
                seed_right = (z, int(cA[0]), int(cA[1]))
                seed_left  = (z, int(cB[0]), int(cB[1]))
            else:
                seed_right = (z, int(cB[0]), int(cB[1]))
                seed_left  = (z, int(cA[0]), int(cA[1]))

            return seed_left, seed_right

    raise ValueError(
        "Could not find two distinct lung regions automatically. "
        "Make sure a thoracic CT series is loaded."
    )


# ── Contour extraction ─────────────────────────────────────────────────────────

def _resample_contour(pts: np.ndarray, n: int) -> list:
    """
    Arc-length resample a contour array (shape N×2, rows then cols) to
    exactly n uniformly-spaced points.
    Returns [[col, row], ...] (frontend pixel format).
    """
    if len(pts) < 3:
        return [[float(p[1]), float(p[0])] for p in pts]

    diffs = np.diff(pts, axis=0, append=pts[:1])        # close the polygon
    lens  = np.sqrt((diffs ** 2).sum(axis=1))
    arc   = np.concatenate([[0.0], np.cumsum(lens)])
    total = arc[-1]
    if total == 0:
        return [[float(pts[0, 1]), float(pts[0, 0])]] * n

    targets = np.linspace(0, total, n, endpoint=False)
    idx     = np.searchsorted(arc[1:], targets)
    t_local = np.where(lens[idx] > 0,
                       (targets - arc[idx]) / lens[idx], 0.0)
    rows = pts[idx, 0] + t_local * diffs[idx, 0]
    cols = pts[idx, 1] + t_local * diffs[idx, 1]
    return [[round(float(c), 1), round(float(r), 1)] for r, c in zip(rows, cols)]


def _mask_to_contours(mask: np.ndarray, n_points: int = 96) -> list:
    """
    Extract one polygon contour per axial slice from a 3-D binary mask.
    Returns [ {"slice": z, "points": [[col, row], ...]}, ... ].
    """
    out = []
    for z in range(mask.shape[0]):
        slc = mask[z].astype(np.uint8)
        if not slc.any():
            continue
        raw = find_contours(slc, level=0.5)
        if not raw:
            continue
        longest = max(raw, key=len)
        out.append({"slice": z, "points": _resample_contour(longest, n_points)})
    return out


# ── Shared 2-D propagation helper ─────────────────────────────────────────────

def _propagate_from_seed_2d(
    binary_mask: np.ndarray,
    seed_z: int, seed_row: int, seed_col: int,
    pixel_spacing: float,
) -> "np.ndarray | None":
    """
    General 2-D per-slice connected-component propagation from a seed point.

    Works on any pre-computed binary mask (e.g. air mask for lungs, soft-tissue
    mask for heart).  Avoids 3-D labeling so structures connected only through
    narrow 3-D bridges (trachea, great vessels) remain separated.

    Algorithm
    ---------
    1. On the seed slice, run 2-D connected components on binary_mask[seed_z].
       Prefer non-border-touching labels; fall back to border-touching if none
       found internally (handles structures that clip the FOV edge).
    2. Search a 20 mm neighbourhood around (seed_row, seed_col) to tolerate
       off-centre clicks.
    3. Propagate up and down: each new slice finds the 2-D component that
       overlaps the previous slice's mask (largest wins); stops when no overlap.

    Returns bool array (nz, nr, nc), or None if nothing found near the seed.
    """
    nz, nr, nc = binary_mask.shape
    r_px       = max(10, round(20.0 / float(pixel_spacing)))

    # 8-connectivity so diagonal touches don't split blobs (important for
    # cardiac tissue where chambers meet at corners).
    _conn8 = np.ones((3, 3), dtype=bool)

    def _label_slice(z):
        labeled_2d, _ = ndi.label(binary_mask[z], structure=_conn8)
        border = set()
        for edge in (labeled_2d[0], labeled_2d[-1],
                     labeled_2d[:, 0], labeled_2d[:, -1]):
            border.update(map(int, np.unique(edge)))
        border.discard(0)
        return labeled_2d, border

    def _pick_label(labeled_2d, border, row, col):
        r0 = max(0, row - r_px);  r1 = min(nr, row + r_px + 1)
        c0 = max(0, col - r_px);  c1 = min(nc, col + r_px + 1)
        sub = labeled_2d[r0:r1, c0:c1].ravel()
        internal = sub[(sub > 0) & ~np.isin(sub, list(border))]
        if internal.size:
            vals, counts = np.unique(internal, return_counts=True)
            return int(vals[np.argmax(counts)])
        any_label = sub[sub > 0]
        if any_label.size:
            vals, counts = np.unique(any_label, return_counts=True)
            return int(vals[np.argmax(counts)])
        return 0

    labeled_seed, border_seed = _label_slice(seed_z)
    lbl = _pick_label(labeled_seed, border_seed, seed_row, seed_col)
    if lbl == 0:
        return None

    mask_3d = np.zeros((nz, nr, nc), dtype=bool)
    mask_3d[seed_z] = (labeled_seed == lbl)

    for direction in (1, -1):
        prev = mask_3d[seed_z]
        z    = seed_z + direction
        gap  = 0          # consecutive slices with no overlap (gap bridging)
        while 0 <= z < nz:
            labeled_2d, border = _label_slice(z)
            overlap = labeled_2d[prev & binary_mask[z]]
            valid   = set(map(int, overlap)) - {0}
            if not valid:
                gap += 1
                if gap > 2:   # tolerate up to 2 consecutive empty slices
                    break
                z += direction
                continue
            gap = 0
            # Accept ALL components that touch the previous slice — not just the
            # largest.  This keeps cardiac chambers together (left + right
            # ventricle, aortic root) which are separate connected blobs on many
            # CT slices but anatomically part of the same structure.
            mask_3d[z] = np.isin(labeled_2d, list(valid))
            prev = mask_3d[z]
            z   += direction

    return mask_3d if mask_3d.any() else None


# ── Lung segmentation ──────────────────────────────────────────────────────────

def _segment_one_lung_2d(
    vol: np.ndarray,
    seed_z: int, seed_row: int, seed_col: int,
    pixel_spacing: float,
) -> "np.ndarray | None":
    """Thin wrapper: propagate from seed using air mask (HU < −300)."""
    return _propagate_from_seed_2d(vol < -300, seed_z, seed_row, seed_col, pixel_spacing)


def _do_segment_lungs(
    vol:            np.ndarray,
    seed_left:      tuple,          # (z, row, col)
    seed_right:     tuple,          # (z, row, col)
    pixel_spacing:  float,
    slice_thickness: float,
) -> tuple:
    """
    Full lung segmentation pipeline (synchronous; call via asyncio.to_thread).

    Uses 2-D per-slice propagation so the two lungs never merge via the
    trachea, and lungs touching the FOV edge are not deleted.

    Returns (left_mask, right_mask), each bool array shape (nz, nr, nc).
    """
    sz_l, sr_l, sc_l = seed_left
    sz_r, sr_r, sc_r = seed_right

    left_raw = _segment_one_lung_2d(vol, sz_l, sr_l, sc_l, pixel_spacing)
    if left_raw is None:
        raise ValueError(
            "No lung air found near the LEFT seed point. "
            "Try clicking closer to the centre of the lung field on an axial slice."
        )

    right_raw = _segment_one_lung_2d(vol, sz_r, sr_r, sc_r, pixel_spacing)
    if right_raw is None:
        raise ValueError(
            "No lung air found near the RIGHT seed point. "
            "Try clicking closer to the centre of the lung field."
        )

    # Warn if both seeds ended up in overlapping regions (user clicked same lung)
    overlap_vox = int((left_raw & right_raw).sum())
    max_vox     = int(max(left_raw.sum(), right_raw.sum()))
    if max_vox > 0 and overlap_vox / max_vox > 0.5:
        raise ValueError(
            "Both seeds appear to be inside the same lung. "
            "Click inside the LEFT lung first, then inside the RIGHT lung."
        )

    # Per-slice 2-D closing (fills nodules; much faster than 3-D closing)
    r_xy = max(3, round(15.0 / float(pixel_spacing)))
    left_filled  = _close_mask_2d(left_raw,  r_xy)
    right_filled = _close_mask_2d(right_raw, r_xy)

    return left_filled, right_filled


# ── Heart segmentation ─────────────────────────────────────────────────────────

def _do_segment_heart(
    vol:            np.ndarray,
    left_mask:      np.ndarray,
    right_mask:     np.ndarray,
    pixel_spacing:  float,
) -> np.ndarray:
    """
    Automatic heart segmentation using the lung masks to locate the
    mediastinum (synchronous; call via asyncio.to_thread).

    1. Thoracic z-range from lung masks.
    2. Per-slice mediastinum = column band between the two lung fields.
    3. Threshold −50 to 150 HU inside mediastinum, excluding lung voxels.
    4. Largest 3-D connected component.
    5. Per-slice 2-D closing (12 mm) + hole fill.

    Returns heart_mask bool array shape (nz, nr, nc).
    """
    nz, nr, nc = vol.shape
    combined   = left_mask | right_mask

    # 1 — z-range
    z_any = np.where(combined.any(axis=(1, 2)))[0]
    if len(z_any) == 0:
        return np.zeros((nz, nr, nc), dtype=bool)
    z_lo, z_hi = int(z_any[0]), int(z_any[-1])

    # 2 — per-slice mediastinum mask
    med_mask = np.zeros((nz, nr, nc), dtype=bool)
    for z in range(z_lo, z_hi + 1):
        l_any = left_mask[z].any(axis=0)
        r_any = right_mask[z].any(axis=0)
        l_cols = np.where(l_any)[0]
        r_cols = np.where(r_any)[0]
        if len(l_cols) == 0 or len(r_cols) == 0:
            # Only one lung visible on this slice → use centre quarter
            med_mask[z, :, nc // 4: 3 * nc // 4] = True
            continue
        # right lung = smaller cols, left lung = larger cols (standard DICOM LPS)
        col_med_start = int(r_cols.max())
        col_med_end   = int(l_cols.min())
        if col_med_start >= col_med_end:
            col_med_start = max(0, col_med_end - 20)
        med_mask[z, :, col_med_start:col_med_end] = True

    # 3 — soft-tissue threshold
    candidate = (vol > -50) & (vol < 150) & med_mask & ~combined

    # 4 — largest connected component
    labeled, n_comp = ndi.label(candidate)
    if n_comp == 0:
        return np.zeros((nz, nr, nc), dtype=bool)
    sizes   = ndi.sum(candidate, labeled, range(1, n_comp + 1))
    best    = int(np.argmax(sizes)) + 1
    heart_raw = (labeled == best)

    # 5 — per-slice closing + hole fill
    r_xy = max(2, round(12.0 / float(pixel_spacing)))
    return _close_mask_2d(heart_raw, r_xy)


def _do_segment_heart_seeded(
    vol:            np.ndarray,
    seed_z:         int,
    seed_row:       int,
    seed_col:       int,
    pixel_spacing:  float,
    slice_thickness: float,
    bbox:           "dict | None" = None,
) -> np.ndarray:
    """
    Seed-based heart segmentation.

    Pipeline
    --------
    1.  Build a 3-D bounding-box mask from optional user-drawn boxes in axial
        and/or coronal/sagittal views.  When provided this tightly constrains
        the search region so the propagation cannot leak into adjacent structures.
    2.  Per-slice mediastinum detection: find the two largest lung-air regions
        per axial slice and keep only the column band between them.
    3.  AND the two masks with a soft-tissue threshold (−30 to 150 HU) to form
        the candidate volume.
    4.  Propagate from seed using 2-D slice-by-slice connected components.
    5.  Subtract automatically-segmented lung masks (prevents the heart contour
        from blending into abutting lung tissue on border slices).
    6.  12 mm per-slice 2-D disk closing + hole fill to smooth the boundary and
        fill cardiac chambers.

    bbox dict keys (all optional, in frontend image coords):
      axial_ix1/ix2/iy1/iy2      : col/row range in the axial canvas
      coronal_ix1/ix2/iy1/iy2    : image-x/y range in the coronal canvas
      sagittal_ix1/ix2/iy1/iy2   : image-x/y range in the sagittal canvas

    Coordinate transforms (matching mpr.js conventions):
      Axial:    ix = col,          iy = row,         planeIndex = z
      Coronal:  ix = ncols-1-col,  iy = z (slice),   planeIndex = y
      Sagittal: ix = nrows-1-row,  iy = z (slice),   planeIndex = x
    """
    nz, nr, nc = vol.shape

    # ── 1. Bounding-box mask ──────────────────────────────────────────────────
    bbox_mask = np.ones((nz, nr, nc), dtype=bool)
    if bbox:
        def _apply_ax(k):
            if all(k + s in bbox for s in ('_ix1', '_ix2', '_iy1', '_iy2')):
                c0 = int(min(bbox[k + '_ix1'], bbox[k + '_ix2']))
                c1 = int(max(bbox[k + '_ix1'], bbox[k + '_ix2']))
                r0 = int(min(bbox[k + '_iy1'], bbox[k + '_iy2']))
                r1 = int(max(bbox[k + '_iy1'], bbox[k + '_iy2']))
                m  = np.zeros((nz, nr, nc), dtype=bool)
                m[:, r0:r1 + 1, c0:c1 + 1] = True
                return m
            return None

        def _apply_cor(k):
            if all(k + s in bbox for s in ('_ix1', '_ix2', '_iy1', '_iy2')):
                # coronal: ix = ncols-1-col, iy = z
                ix1 = int(min(bbox[k + '_ix1'], bbox[k + '_ix2']))
                ix2 = int(max(bbox[k + '_ix1'], bbox[k + '_ix2']))
                iy1 = int(min(bbox[k + '_iy1'], bbox[k + '_iy2']))
                iy2 = int(max(bbox[k + '_iy1'], bbox[k + '_iy2']))
                c0  = max(0, nc - 1 - ix2);  c1 = min(nc, nc - 1 - ix1 + 1)
                z0  = max(0, iy1);            z1 = min(nz, iy2 + 1)
                m   = np.zeros((nz, nr, nc), dtype=bool)
                m[z0:z1, :, c0:c1] = True
                return m
            return None

        def _apply_sag(k):
            if all(k + s in bbox for s in ('_ix1', '_ix2', '_iy1', '_iy2')):
                # sagittal: ix = nrows-1-row, iy = z
                ix1 = int(min(bbox[k + '_ix1'], bbox[k + '_ix2']))
                ix2 = int(max(bbox[k + '_ix1'], bbox[k + '_ix2']))
                iy1 = int(min(bbox[k + '_iy1'], bbox[k + '_iy2']))
                iy2 = int(max(bbox[k + '_iy1'], bbox[k + '_iy2']))
                r0  = max(0, nr - 1 - ix2);  r1 = min(nr, nr - 1 - ix1 + 1)
                z0  = max(0, iy1);            z1 = min(nz, iy2 + 1)
                m   = np.zeros((nz, nr, nc), dtype=bool)
                m[z0:z1, r0:r1, :] = True
                return m
            return None

        for fn, key in [(_apply_ax, 'axial'), (_apply_cor, 'coronal'), (_apply_sag, 'sagittal')]:
            m = fn(key)
            if m is not None:
                bbox_mask &= m

    # ── 2. Adaptive HU threshold from seed neighbourhood ─────────────────────
    # Sample a ~15 mm patch around the seed and use its median HU ± 100 as
    # the tissue window.  This adapts automatically to non-contrast, thick-
    # slice, or unusual-protocol CTs instead of relying on a fixed range.
    r_sample = max(3, round(15.0 / float(pixel_spacing)))
    r0s = max(0, seed_row - r_sample);  r1s = min(nr, seed_row + r_sample + 1)
    c0s = max(0, seed_col - r_sample);  c1s = min(nc, seed_col + r_sample + 1)
    seed_patch = vol[seed_z, r0s:r1s, c0s:c1s]
    hu_center  = float(np.median(seed_patch))
    hu_lo      = hu_center - 100.0
    hu_hi      = hu_center + 100.0

    # ── 3. Per-slice mediastinum detection ────────────────────────────────────
    def _mediastinum_slice(z):
        air = vol[z] < -300
        labeled_2d, n = ndi.label(air)
        if n == 0:
            return np.zeros((nr, nc), dtype=bool)

        sizes = {lbl: int((labeled_2d == lbl).sum()) for lbl in range(1, n + 1)}
        border = set()
        for edge in (labeled_2d[0], labeled_2d[-1],
                     labeled_2d[:, 0], labeled_2d[:, -1]):
            border.update(map(int, np.unique(edge)))
        border.discard(0)
        if border:
            ext_lbl = max(border, key=lambda l: sizes.get(l, 0))
            sizes.pop(ext_lbl, None)

        min_lung_px = max(100, nr * nc // 2000)
        candidates  = {l: s for l, s in sizes.items() if s >= min_lung_px}
        if len(candidates) < 2:
            return np.zeros((nr, nc), dtype=bool)

        top2   = sorted(candidates, key=lambda l: -candidates[l])[:2]
        cols_A = np.where((labeled_2d == top2[0]).any(axis=0))[0]
        cols_B = np.where((labeled_2d == top2[1]).any(axis=0))[0]
        if cols_A.size == 0 or cols_B.size == 0:
            return np.zeros((nr, nc), dtype=bool)

        mean_A, mean_B = float(cols_A.mean()), float(cols_B.mean())
        if mean_A < mean_B:
            c_start, c_end = int(cols_A.max()), int(cols_B.min())
        else:
            c_start, c_end = int(cols_B.max()), int(cols_A.min())
        if c_start >= c_end:
            mid = (c_start + c_end) // 2
            c_start, c_end = max(0, mid - 30), min(nc, mid + 30)

        med = np.zeros((nr, nc), dtype=bool)
        med[:, c_start:c_end] = True
        return med

    # ── 4. Candidate mask ────────────────────────────────────────────────────
    # Rule: when the user drew a bbox, trust it completely — skip mediastinum.
    # The mediastinum column band can exclude the heart at apex/base slices
    # and is unnecessary when the user has already constrained the region.
    # Without bbox, add mediastinum to prevent chest-wall leakage.
    tissue    = (vol >= hu_lo) & (vol <= hu_hi)
    has_bbox  = bool(bbox)
    candidate = np.zeros((nz, nr, nc), dtype=bool)
    for z in range(nz):
        if not bbox_mask[z].any():
            continue
        if has_bbox:
            candidate[z] = tissue[z] & bbox_mask[z]
        else:
            med = _mediastinum_slice(z)
            if med.any():
                candidate[z] = tissue[z] & med

    # ── 5. Propagate from seed ────────────────────────────────────────────────
    raw = _propagate_from_seed_2d(candidate, seed_z, seed_row, seed_col, pixel_spacing)
    if raw is None:
        msg = (
            f"No tissue found near the seed point (sampled HU ≈ {hu_center:.0f}, "
            f"window {hu_lo:.0f}–{hu_hi:.0f} HU). "
        )
        if bbox:
            msg += "Check that the seed click and the drawn box both cover the heart."
        else:
            msg += "Click in the centre of the heart on the axial view."
        raise ValueError(msg)

    # ── 6. Subtract lung volumes ──────────────────────────────────────────────
    # Auto-detect lungs and remove them from the heart mask.  This prevents
    # the contour from bleeding into abutting lung parenchyma on boundary slices.
    try:
        seed_l, seed_r = _find_auto_lung_seeds(vol)
        lm, rm = _do_segment_lungs(vol, seed_l, seed_r,
                                   pixel_spacing, slice_thickness)
        raw = raw & ~(lm | rm)
        # If subtraction emptied the mask (shouldn't happen, but be safe), restore
        if not raw.any():
            raw = _propagate_from_seed_2d(candidate, seed_z, seed_row, seed_col,
                                          pixel_spacing)
    except Exception:
        pass   # lung auto-detection failed → skip subtraction, keep raw mask

    if raw is None or not raw.any():
        raise ValueError("Heart mask became empty after lung subtraction. "
                         "Try placing the seed more centrally inside the heart.")

    # ── 7. 12 mm per-slice closing + hole fill ────────────────────────────────
    r_xy = max(2, round(12.0 / float(pixel_spacing)))
    return _close_mask_2d(raw, r_xy)


# ── Segmentation endpoints ─────────────────────────────────────────────────────
#
# Heavy CPU work runs inside asyncio.to_thread() so it executes in a
# background thread.  This keeps FastAPI's event loop responsive: the
# browser can still fetch WADO slice images while segmentation is running,
# so MPR/volume views continue to work during processing.

@app.post("/preview-lung")
async def preview_lung(payload: dict = Body(...)):
    """
    Segment ONE lung from a single seed point and return its contours.
    Called immediately after the user places the first seed so they can verify
    the left-lung boundary before placing the second seed.

    Body: { "series_uid": "", "seed": [slice_idx, col, row] }
    Response: { "contours": [{slice, points},...], "voxel_count": N }
    """
    series_uid = payload.get("series_uid", "")
    s = payload.get("seed", [])
    if len(s) != 3:
        raise HTTPException(status_code=422, detail="seed must be [slice_idx, col, row]")

    seed = (int(s[0]), int(s[2]), int(s[1]))   # → (z, row, col)

    def _run():
        vol, meta = _load_ct_volume(series_uid)
        if vol is None:
            return None
        psp = float(meta[0]["ps"][0])
        mask = _segment_one_lung_2d(vol, seed[0], seed[1], seed[2], psp)
        if mask is None:
            raise ValueError(
                "No lung air found near the seed point. "
                "Try clicking closer to the centre of the lung on an axial slice."
            )
        r_xy = max(3, round(15.0 / psp))
        filled = _close_mask_2d(mask, r_xy)
        return {
            "contours":    _mask_to_contours(filled),
            "voxel_count": int(filled.sum()),
        }

    try:
        result = await asyncio.to_thread(_run)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Preview error: {e}")

    if result is None:
        raise HTTPException(status_code=422, detail="No CT slices found in uploaded_dicoms/")
    return result


@app.post("/segment-lungs")
async def segment_lungs(payload: dict = Body(...)):
    """
    Segment left and right lungs using two user-provided seed points.

    Body:
      {
        "series_uid":  "",
        "seed_left":   [slice_idx, col, row],
        "seed_right":  [slice_idx, col, row]
      }

    Seed coordinates are image-pixel space (axial MPR canvas):
      col = ix (horizontal), row = iy (vertical)

    Seeds are looked up with a 20 mm neighbourhood tolerance, so clicking
    on a nodule or vessel near the lung centre still works.

    Response:
      {
        "left_lung":  [{"slice": z, "points": [[col,row],...]},...],
        "right_lung": [...],
        "slice_count": N
      }
    """
    series_uid = payload.get("series_uid", "")
    sl = payload.get("seed_left",  [])
    sr = payload.get("seed_right", [])
    if len(sl) != 3 or len(sr) != 3:
        raise HTTPException(
            status_code=422,
            detail="seed_left and seed_right must each be [slice_idx, col, row]",
        )

    # Frontend: [slice, col, row] → numpy: (z, row, col)
    seed_left  = (int(sl[0]), int(sl[2]), int(sl[1]))
    seed_right = (int(sr[0]), int(sr[2]), int(sr[1]))

    def _run():
        vol, meta = _load_ct_volume(series_uid)
        if vol is None:
            return None
        ps  = meta[0]["ps"]
        st  = meta[0]["slice_thickness"]
        psp = float(ps[0])
        lm, rm = _do_segment_lungs(vol, seed_left, seed_right, psp, st)
        return {
            "left_lung":   _mask_to_contours(lm),
            "right_lung":  _mask_to_contours(rm),
            "slice_count": int(vol.shape[0]),
        }

    try:
        result = await asyncio.to_thread(_run)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Segmentation error: {e}")

    if result is None:
        raise HTTPException(status_code=422, detail="No CT slices found in uploaded_dicoms/")
    return result


@app.post("/segment-heart")
async def segment_heart(payload: dict = Body(...)):
    """
    Segment the heart using a single user-provided seed point.

    The user clicks anywhere inside the heart (myocardium, blood pool, or
    pericardium) on the axial MPR canvas.  A soft-tissue mask (−30 to 200 HU)
    is propagated from that seed slice-by-slice; the result is closed with a
    12 mm disk to smooth boundaries and fill cardiac chambers.

    Body:
      {
        "series_uid": "",
        "seed": [slice_idx, col, row],   ← image-pixel space (axial MPR)
        "bbox": {                         ← optional bounding boxes (image coords)
          "axial_ix1": N, "axial_ix2": N, "axial_iy1": N, "axial_iy2": N,
          "coronal_ix1": N, ..., "sagittal_ix1": N, ...
        }
      }
    Response: { "heart": [{"slice": z, "points": [[col,row],...]},...] }
    """
    series_uid = payload.get("series_uid", "")
    s    = payload.get("seed", [])
    bbox = payload.get("bbox") or {}
    if len(s) != 3:
        raise HTTPException(
            status_code=422,
            detail="seed must be [slice_idx, col, row] — click inside the heart on the axial view",
        )

    # Frontend: [slice, col, row] → numpy: (z, row, col)
    seed_z, seed_row, seed_col = int(s[0]), int(s[2]), int(s[1])

    def _run():
        vol, meta = _load_ct_volume(series_uid)
        if vol is None:
            return None
        psp = float(meta[0]["ps"][0])
        st  = float(meta[0]["slice_thickness"])
        hm  = _do_segment_heart_seeded(
            vol, seed_z, seed_row, seed_col, psp, st,
            bbox=bbox if bbox else None,
        )
        return {"heart": _mask_to_contours(hm)}

    try:
        result = await asyncio.to_thread(_run)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Segmentation error: {e}")

    if result is None:
        raise HTTPException(status_code=422, detail="No CT slices found in uploaded_dicoms/")
    return result


@app.get("/check-totalseg")
def check_totalseg():
    """Return whether TotalSegmentator is installed, its version, and GPU info."""
    info = {"installed": False, "version": None, "gpu": None}
    try:
        import totalsegmentator
        info["installed"] = True
        info["version"]   = getattr(totalsegmentator, "__version__", "unknown")
    except ImportError:
        pass
    try:
        import torch
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            info["gpu"] = {
                "name":      torch.cuda.get_device_name(0),
                "memory_mb": props.total_memory // (1024 * 1024),
            }
    except Exception:
        pass
    return info


# ── ML segmentation job store ─────────────────────────────────────────────────
# Jobs are keyed by UUID; each entry: {status, pct, stage, result, error}
_ml_jobs: dict = {}

def _ml_set(job_id: str, **kw):
    if job_id in _ml_jobs:
        _ml_jobs[job_id].update(kw)


def _ml_run_sync(job_id: str, series_uid: str, fast: bool):
    """Heavy work executed in a background thread. Updates _ml_jobs[job_id]."""
    import time as _time

    def _upd(pct, stage):
        _ml_set(job_id, pct=pct, stage=stage)

    try:
        # ── 1. Import dependencies ────────────────────────────────────────────
        _upd(2, "Checking dependencies…")
        try:
            import SimpleITK as sitk
        except ImportError:
            raise RuntimeError(
                "SimpleITK not found — install with:  pip install TotalSegmentator"
            )
        try:
            from totalsegmentator.python_api import totalsegmentator as ts_run
        except ImportError:
            raise RuntimeError(
                "TotalSegmentator not installed — run:  pip install TotalSegmentator"
            )

        # ── 2. Detect GPU ─────────────────────────────────────────────────────
        device = "cpu"
        try:
            import torch
            if torch.cuda.is_available():
                device = "gpu"
        except Exception:
            pass
        gpu_label = "GPU" if device == "gpu" else "CPU"

        # ── 3. Collect DICOM files ────────────────────────────────────────────
        _upd(5, f"Scanning DICOM files [{gpu_label}]…")
        entries = []
        for fname in os.listdir(UPLOAD_DIR):
            fpath = os.path.join(UPLOAD_DIR, fname)
            try:
                ds = pydicom.dcmread(fpath, stop_before_pixels=True)
                if getattr(ds, "Modality", "") not in ("CT", "MR"):
                    continue
                if series_uid and str(getattr(ds, "SeriesInstanceUID", "")) != series_uid:
                    continue
                entries.append((int(getattr(ds, "InstanceNumber", 0)), fpath))
            except Exception:
                pass
        if not entries:
            raise RuntimeError("No CT slices found for this series.")
        entries.sort(key=lambda x: x[0])
        fpaths = [p for _, p in entries]

        # ── 4. Build SimpleITK image ──────────────────────────────────────────
        _upd(12, f"Loading {len(fpaths)} slices…")
        reader = sitk.ImageSeriesReader()
        reader.SetFileNames(fpaths)
        ct_img = reader.Execute()

        # ── 5. Run TotalSegmentator via subprocess ────────────────────────────
        # Using a subprocess lets us capture stdout line-by-line so we can
        # show the real download/inference progress in the UI instead of a
        # fake ticker.  TotalSegmentator prints tqdm lines like:
        #   "Downloading: 45%|████ | 60.0M/135M …"
        #   "Predicting…"  /  "Resampling…"
        import tempfile, pathlib, subprocess, sys, re

        mode_str = "fast" if fast else "full quality"
        _upd(18, f"Preparing CT volume for TotalSegmentator [{gpu_label}]…")

        with tempfile.TemporaryDirectory() as tmpdir:
            in_path = os.path.join(tmpdir, "ct.nii.gz")
            out_dir = pathlib.Path(tmpdir) / "seg_out"
            out_dir.mkdir()

            _upd(20, "Writing NIfTI file…")
            sitk.WriteImage(ct_img, in_path)

            cmd = [
                sys.executable, "-m", "totalsegmentator",
                "-i", in_path,
                "-o", str(out_dir),
                "--task", "total",
                "--device", device,
            ]
            if fast:
                cmd.append("--fast")

            def _run_proc(try_device):
                """Run TotalSegmentator subprocess, return (seg_arr, captured_lines)."""
                # Find the CLI binary next to the current Python interpreter.
                # TotalSegmentator installs as "TotalSegmentator" (capital T);
                # it has no __main__.py so `python -m totalsegmentator` fails.
                bin_dir = os.path.dirname(sys.executable)
                ts_bin  = None
                for name in ("TotalSegmentator", "totalsegmentator"):
                    candidate = os.path.join(bin_dir, name)
                    if os.path.isfile(candidate):
                        ts_bin = candidate
                        break
                if ts_bin is None:
                    import shutil
                    ts_bin = (shutil.which("TotalSegmentator") or
                              shutil.which("totalsegmentator") or
                              "TotalSegmentator")

                run_cmd = [
                    ts_bin,
                    "-i", in_path,
                    "-o", str(out_dir),
                    "--task", "total",
                    "--device", try_device,
                ]
                if fast:
                    run_cmd.append("--fast")

                print(f"[ML-Seg] CMD: {' '.join(run_cmd)}", flush=True)
                _upd(22, f"Launching TotalSegmentator ({mode_str}, {try_device.upper()})…")

                p = subprocess.Popen(
                    run_cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                )
                tail = []   # last 30 lines for error reporting

                for raw in p.stdout:
                    line = raw.strip()
                    if not line:
                        continue
                    print(f"[TS] {line}", flush=True)   # always visible in server terminal
                    tail.append(line)
                    if len(tail) > 30:
                        tail.pop(0)

                    # Download progress: "Downloading: 45%|... 60M/135M ..."
                    m = re.search(r'Downloading[^:]*:\s*(\d+)%', line)
                    if m:
                        dl = int(m.group(1))
                        pct = 22 + int(dl * 0.50)   # map 0-100 → 22-72%
                        sm  = re.search(r'([\d.]+[MG])\s*/\s*([\d.]+[MG])', line)
                        ss  = f" ({sm.group(1)}/{sm.group(2)})" if sm else ""
                        _upd(pct, f"Downloading weights: {dl}%{ss} (cached after this)…")
                        continue

                    low = line.lower()
                    if "resamp" in low:
                        _upd(73, f"Resampling CT [{try_device.upper()}]…")
                    elif "predict" in low or "infer" in low:
                        _upd(76, f"Neural network inference [{try_device.upper()}]…")
                    elif "saving" in low or "writing" in low:
                        _upd(80, "Saving segmentation…")

                rc = p.wait()
                return rc, tail

            # Try GPU first; fall back to CPU if it fails.
            rc, tail = _run_proc(device)
            if rc != 0 and device == "gpu":
                print("[ML-Seg] GPU run failed — retrying on CPU…", flush=True)
                _upd(22, "GPU failed — retrying on CPU…")
                # Clear output dir before retry
                import shutil
                shutil.rmtree(str(out_dir), ignore_errors=True)
                out_dir.mkdir()
                rc, tail = _run_proc("cpu")

            if rc != 0:
                snippet = '\n'.join(tail[-15:]) if tail else '(no output captured)'
                raise RuntimeError(
                    f"TotalSegmentator failed (exit {rc}).\n\nLast output:\n{snippet}"
                )

            _upd(82, "Reading segmentation output…")
            seg_path = str(out_dir / "segmentation.nii.gz")
            if not os.path.exists(seg_path):
                nii_files = [f for f in os.listdir(out_dir) if f.endswith(".nii.gz")]
                if not nii_files:
                    raise RuntimeError("TotalSegmentator produced no output file.")
                seg_path = str(out_dir / nii_files[0])
            seg_img = sitk.ReadImage(seg_path)
            seg_arr = sitk.GetArrayFromImage(seg_img)   # (nz, nr, nc)

        # ── 6. Look up label IDs ──────────────────────────────────────────────
        _upd(82, "Extracting organ masks…")
        try:
            from totalsegmentator.map_to_binary import class_map
            cmap = class_map.get("total", {})
            if not cmap:
                for v in class_map.values():
                    if v:
                        cmap = v; break
        except Exception:
            cmap = {}

        inv = {name: lid for lid, name in cmap.items()}
        WANT = {
            "Heart":      [v for k, v in inv.items() if k == "heart"],
            "Left Lung":  [v for k, v in inv.items() if "lung" in k and "left"  in k],
            "Right Lung": [v for k, v in inv.items() if "lung" in k and "right" in k],
        }
        FALLBACK = {"Heart": [52], "Left Lung": [13, 14], "Right Lung": [15, 16, 17]}
        for name in WANT:
            if not WANT[name]:
                WANT[name] = FALLBACK[name]

        # ── 7. Build contours ─────────────────────────────────────────────────
        _upd(88, "Building contours…")
        COLORS   = {"Heart": "#ef5350", "Left Lung": "#4fc3f7", "Right Lung": "#81c784"}
        results  = {}
        roi_list = []
        ts_now   = int(_time.time() * 1000)

        for name, label_ids in WANT.items():
            mask = np.zeros(seg_arr.shape, dtype=bool)
            for lid in label_ids:
                mask |= (seg_arr == lid)
            contours = _mask_to_contours(mask)
            results[name] = contours
            color = COLORS.get(name, "#ffcc44")
            for c in contours:
                roi_list.append({
                    "id":         ts_now + len(roi_list),
                    "name":       name,
                    "slice":      c["slice"],
                    "points":     c["points"],
                    "color":      color,
                    "source":     "ml-segment",
                    "plane":      "axial",
                    "canvasId":   "axialCanvas",
                    "planeIndex": c["slice"],
                })

        # ── 8. Save to disk ───────────────────────────────────────────────────
        _upd(96, "Saving ROI file…")
        ts_str = _time.strftime("%Y%m%d_%H%M%S")
        save_fname = f"ml_seg_{ts_str}.json"
        with open(os.path.join(ROI_SAVE_DIR, save_fname), "w") as fh:
            json.dump({"rois": roi_list, "source": "ml-segment"}, fh)

        results["saved_file"] = save_fname
        results["roi_list"]   = roi_list

        _ml_set(job_id, pct=100, stage="Done!", status="done", result=results)

    except Exception as exc:
        _ml_set(job_id, status="error", stage="Failed", error=str(exc))


@app.post("/ml-segment-start")
async def ml_segment_start(payload: dict = Body(...)):
    """
    Start a TotalSegmentator job in the background.
    Returns immediately with a job_id; poll /ml-segment-status/{job_id}.

    Body: { "series_uid": "...", "fast": true }
    """
    import uuid
    # Evict old jobs (keep 20 most recent).
    if len(_ml_jobs) >= 20:
        for old in list(_ml_jobs)[:len(_ml_jobs) - 19]:
            _ml_jobs.pop(old, None)

    job_id = str(uuid.uuid4())
    _ml_jobs[job_id] = {"status": "running", "pct": 0, "stage": "Starting…",
                        "result": None, "error": None}

    series_uid = payload.get("series_uid", "")
    fast       = bool(payload.get("fast", True))
    asyncio.create_task(asyncio.to_thread(_ml_run_sync, job_id, series_uid, fast))
    return {"job_id": job_id}


@app.get("/ml-segment-status/{job_id}")
async def ml_segment_status(job_id: str):
    """Poll the status of a running ML segmentation job."""
    job = _ml_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/")
def root():
    return {"message": "Server is running"}
