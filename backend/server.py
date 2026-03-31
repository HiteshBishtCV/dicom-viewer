from fastapi import FastAPI, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
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


@app.post("/upload/")
async def upload(files: list[UploadFile]):
    series_dict = {}

    for file in files:
        filename = os.path.basename(file.filename)
        path = os.path.join(UPLOAD_DIR, filename)

        with open(path, "wb") as f:
            f.write(await file.read())

        try:
            # force=True handles files missing the DICOM preamble/meta header
            ds = pydicom.dcmread(path, stop_before_pixels=True, force=True)
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
                    },
                    "instances": [],
                }

            elif modality == "RTDOSE":
                n_frames = int(getattr(ds, "NumberOfFrames", 1))
                dose_type = getattr(ds, "DoseType", "PHYSICAL")
                dose_units = getattr(ds, "DoseUnits", "GY")
                series_dict[series_uid] = {
                    "modality": "RTDOSE",
                    "description": f"Dose — {dose_type} ({dose_units})",
                    "type": "multiframe",
                    "instances": [
                        {"path": path, "instance": i, "frame": i}
                        for i in range(n_frames)
                    ],
                }

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
                    series_dict[series_uid] = {
                        "modality": modality,
                        "description": description,
                        "type": "image",
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


@app.get("/")
def root():
    return {"message": "Server is running"}
