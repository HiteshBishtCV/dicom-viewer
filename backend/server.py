from fastapi import FastAPI, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import pydicom
import os

app = FastAPI()

# Allow frontend to talk to backend
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

        # Save file
        with open(path, "wb") as f:
            f.write(await file.read())

        try:
            ds = pydicom.dcmread(path, stop_before_pixels=True)

            series_uid = getattr(ds, "SeriesInstanceUID", "unknown")
            modality = getattr(ds, "Modality", "unknown")
            description = getattr(ds, "SeriesDescription", "NA")
            instance = getattr(ds, "InstanceNumber", 0)

            # Filter scouts/localizers
            image_type = getattr(ds, "ImageType", [])
            if "LOCALIZER" in image_type or "SCOUT" in image_type:
                continue

            if series_uid not in series_dict:
                series_dict[series_uid] = {
                    "modality": modality,
                    "description": description,
                    "instances": []
                }

            series_dict[series_uid]["instances"].append({
                "path": path,
                "instance": instance
            })

        except Exception as e:
            print(f"Skipping file {file.filename}: {e}")

    # Sort slices in each series
    for uid in series_dict:
        series_dict[uid]["instances"].sort(key=lambda x: x["instance"])

    return series_dict

@app.get("/")
def root():
    return {"message": "Server is running"}