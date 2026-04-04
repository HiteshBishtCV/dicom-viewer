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
from collections import defaultdict

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


@app.get("/")
def root():
    return {"message": "Server is running"}
