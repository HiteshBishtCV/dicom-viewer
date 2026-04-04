from fastapi import FastAPI, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydicom.dataset import FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
import pydicom
import math
import os

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = "uploaded_dicoms"
os.makedirs(UPLOAD_DIR, exist_ok=True)

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
    coordinate transform, sorted by ascending slice position along the
    image normal (so index 0 = most inferior/posterior depending on patient
    orientation).
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

    if not slices:
        return slices

    # Sort by position along the slice-normal direction so index matches
    # the clinical stack order used by the MPR volume builder (z descending).
    # We derive the normal from the first slice's ImageOrientationPatient.
    iop0   = slices[0]["iop"]
    F_row  = iop0[:3]          # direction cosines of the row  axis
    F_col  = iop0[3:]          # direction cosines of the col  axis
    normal = _norm(_cross(F_row, F_col))   # normal = F_row × F_col

    slices.sort(key=lambda s: _dot(s["ipp"], normal))
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
    # Use the first (most inferior) slice as the reference for F_row, F_col, N.
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
        slice_index is the index into ct_slices (0 = most inferior).
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


@app.get("/")
def root():
    return {"message": "Server is running"}
