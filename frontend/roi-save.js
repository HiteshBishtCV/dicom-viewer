// roi-save.js — sends drawn ROI data to the FastAPI backend for JSON storage.
//
// Reads exclusively from roiStore (the global canonical store).  Has no
// knowledge of roi-draw.js or mpr-roi.js internals — any tool that writes
// to roiStore is automatically included in the save payload.
//
// ── Saved JSON schema (one file per save) ────────────────────────────────────
//
//   {
//     "saved_at":  "20260404_153012_000123",
//     "roi_count": 3,
//     "rois": [
//       {
//         "id":     1712245812345,    — Date.now() at creation
//         "name":   "ROI_1",
//         "slice":  4,               — 0-based slice index
//         "points": [[x,y], ...],    — image pixel coordinates
//         "color":  "#ff4444",
//         "source": "draw2d"         — which tool drew it
//       },
//       ...
//     ]
//   }
//
// ── Public API ────────────────────────────────────────────────────────────────
//
//   roiSave.save()               — POST current roiStore to backend
//                                  Returns Promise<{filename, count}|null>
//   roiSave.loadList()           — GET list of saved files from backend
//                                  Returns Promise<string[]>
//   roiSave.load(filename)       — GET one saved file; returns the full record
//                                  Returns Promise<{rois, saved_at, ...}|null>

const roiSave = (() => {

  const API = 'http://127.0.0.1:8000';

  // ── Save ───────────────────────────────────────────────────────────────────

  /**
   * Collect all ROIs from roiStore and POST them to /save-roi.
   * Alerts the user on success or failure.
   * Returns { filename, count } on success, null on failure.
   */
  async function save() {
    const all = roiStore.getAll();
    if (!all.length) {
      alert('No ROIs to save.');
      return null;
    }

    const payload = {
      rois: all.map(r => ({
        id:     r.id,
        name:   r.name,
        slice:  r.slice,
        points: r.points,          // already [[x,y], ...]
        color:  r.color  ?? '#ffffff',
        source: r.source ?? 'draw2d',
      })),
    };

    try {
      const res = await fetch(`${API}/save-roi`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      alert(`Saved ${data.count} ROI(s)  →  ${data.filename}`);
      return { filename: data.filename, count: data.count };
    } catch (err) {
      alert(`ROI save failed: ${err.message}`);
      return null;
    }
  }

  // ── Load list ──────────────────────────────────────────────────────────────

  /**
   * Return a list of saved ROI filenames (newest first).
   * Returns [] on failure.
   */
  async function loadList() {
    try {
      const res = await fetch(`${API}/load-roi/`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.files ?? [];
    } catch (err) {
      console.error('roiSave.loadList:', err);
      return [];
    }
  }

  // ── Load one file ──────────────────────────────────────────────────────────

  /**
   * Fetch a specific saved ROI file by name.
   * Returns the full record { saved_at, roi_count, rois } or null on failure.
   */
  async function load(filename) {
    try {
      const res = await fetch(`${API}/load-roi/${encodeURIComponent(filename)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error('roiSave.load:', err);
      return null;
    }
  }

  return { save, loadList, load };

})();
