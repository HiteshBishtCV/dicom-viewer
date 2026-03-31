# DICOM Viewer

A lightweight web-based DICOM viewer. Upload a folder of DICOM files, browse series, and scroll through slices.

## Stack

- **Backend**: Python, FastAPI, pydicom
- **Frontend**: Vanilla JS, [Cornerstone.js](https://cornerstonejs.org/) (via CDN)

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

Open `frontend/index.html` directly in your browser:

```bash
firefox frontend/index.html
```

## Usage

1. Click **Choose Files** and select a DICOM folder
2. The backend parses and groups files by series (scouts/localizers are filtered out)
3. Click a series button to load it
4. Scroll through slices using the **mouse wheel** or the **slider**
