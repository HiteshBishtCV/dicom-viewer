from fastapi import FastAPI, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydicom.dataset import FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
import pydicom
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


@app.get("/")
def root():
    return {"message": "Server is running"}
