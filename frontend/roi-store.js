// roi-store.js — global ROI data store.
//
// Single source of truth for all user-drawn ROIs. roi-draw.js (2D viewer)
// and mpr-roi.js (MPR view) mirror every mutation here so any future module
// (backend upload, export, analysis) can read from one place.
//
// ── Entry schema ─────────────────────────────────────────────────────────────
//
//   {
//     id:     number,          — unique identifier (Date.now() at creation)
//     name:   string,          — display name, editable by the user
//     slice:  number,          — slice index (z), 0-based, matches the CT stack
//                                order used by the 2D viewer (InstanceNumber asc)
//     points: [[x, y], ...],  — polygon vertices in image pixel coordinates;
//                                x = column (left→right), y = row (top→bottom)
//     color:  string,          — CSS color string, e.g. '#ff4444'
//   }
//
// Optional / extended fields (set by the caller, not required by the store):
//
//   source:  'draw2d' | 'mpr-axial' | 'mpr-coronal' | 'mpr-sagittal'
//            Identifies which tool created the ROI.  Useful for filtering or
//            applying different coordinate transforms per tool.
//
// ── Global access ─────────────────────────────────────────────────────────────
//
//   roiStore.rois            — the raw array (read-only; mutate via API)
//   roiStore.add(entry)      — append a validated entry
//   roiStore.remove(id)      — remove by id
//   roiStore.update(id, {…}) — shallow-merge fields into an existing entry
//   roiStore.getAll()        — return the full array
//   roiStore.forSlice(z)     — return entries where slice === z
//   roiStore.clear()         — empty the store

const roiStore = (() => {

  // The global ROI array. Exposed directly so callers can do
  //   console.log(roiStore.rois)   or   JSON.stringify(roiStore.rois)
  // without going through a getter.
  const rois = [];

  // ── Write API ───────────────────────────────────────────────────────────────

  /**
   * Add a new ROI. Missing required fields are filled with safe defaults
   * so callers can pass partial objects during early construction.
   */
  function add(entry) {
    const roi = {
      id:     entry.id     ?? Date.now(),
      name:   entry.name   ?? 'Unnamed ROI',
      slice:  entry.slice  ?? 0,
      points: entry.points ?? [],   // [[x,y], ...]
      color:  entry.color  ?? '#ffffff',
    };
    // Preserve any extra fields the caller provided (e.g. source, plane).
    Object.assign(roi, entry, roi);
    rois.push(roi);
    return roi;
  }

  /** Remove the entry with the given id. No-op if not found. */
  function remove(id) {
    const idx = rois.findIndex(r => r.id === id);
    if (idx !== -1) rois.splice(idx, 1);
  }

  /**
   * Shallow-merge `fields` into the entry with the given id.
   * Use this for name edits, color changes, or adding optional fields.
   */
  function update(id, fields) {
    const roi = rois.find(r => r.id === id);
    if (roi) Object.assign(roi, fields);
  }

  /** Empty the store entirely. */
  function clear() { rois.length = 0; }

  // ── Read API ────────────────────────────────────────────────────────────────

  /** Return all ROIs. */
  function getAll() { return rois; }

  /** Return ROIs whose slice matches z. */
  function forSlice(z) { return rois.filter(r => r.slice === z); }

  return { rois, add, remove, update, getAll, forSlice, clear };

})();
