# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A DICOM medical image viewer with a Python backend and vanilla JS frontend. Users upload DICOM folders, the backend parses and groups files by series, and the frontend renders slices using Cornerstone.js.

## Architecture

- **Backend** (`backend/server.py`): FastAPI server using pydicom. Single `/upload/` endpoint accepts DICOM files, filters out scouts/localizers, groups by SeriesInstanceUID, sorts by InstanceNumber, and returns series metadata. Uploaded files are saved to `backend/uploaded_dicoms/`.
- **Frontend** (`frontend/`): Static HTML/JS app (no build step). Uses Cornerstone.js (via CDN) for DICOM rendering with WADO image loader and dicom-parser. `app.js` handles file upload, series selection buttons, and slice navigation via a range slider.
- Frontend fetches from `http://127.0.0.1:8000` and loads images via `wadouri:` scheme pointing at the backend.

## Commands

### Run backend
```bash
cd backend
source venv/bin/activate
uvicorn server:app --reload
```

### Run frontend
Open `frontend/index.html` directly in a browser (no build/server needed), or use any static file server.

### Install backend dependencies
```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install fastapi uvicorn pydicom python-multipart
```

## Key Details

- Python 3.12, no requirements.txt yet — dependencies are fastapi, uvicorn, pydicom, python-multipart
- No test framework is set up
- No linter or formatter configured
- CORS is wide open (`allow_origins=["*"]`) — development only
- The frontend references a `/files/` endpoint for serving DICOM images that is not yet implemented in the backend
