// ml-seg-tab-init.js — AI segmentation tab using TotalSegmentator backend.

(async function () {
  'use strict';

  const API = 'http://127.0.0.1:8000';

  // Series UID comes from opener (MPR tab) via URL param or postMessage.
  const params    = new URLSearchParams(location.search);
  let _seriesUid  = params.get('series_uid') || '';
  let _fastMode   = true;
  let _lastResult = null;   // last successful backend response
  let _savedFile  = null;   // last auto-saved filename

  // Update subtitle
  if (_seriesUid) {
    document.getElementById('seriesInfo').textContent =
      `Series: ${_seriesUid.slice(0, 32)}… · TotalSegmentator`;
  }

  // ── Check if TotalSegmentator is installed ────────────────────────────────
  try {
    const r = await fetch(`${API}/check-totalseg`);
    const d = await r.json();
    if (!d.installed) {
      document.getElementById('installNotice').style.display = 'block';
      document.getElementById('runBtn').disabled = true;
      document.getElementById('configCard').style.opacity = '0.4';
    }
  } catch (_) {
    // Backend not reachable — let user try anyway
  }

})();

// ── Quality toggle ─────────────────────────────────────────────────────────────
function setQuality(fast) {
  _fastMode = fast;
  document.getElementById('btnFast').classList.toggle('active', fast);
  document.getElementById('btnFull').classList.toggle('active', !fast);
  document.getElementById('qualityHint').textContent = fast
    ? '3 mm isotropic, good for planning'
    : '1.5 mm isotropic, higher accuracy, slower';
}

// ── Run segmentation ──────────────────────────────────────────────────────────
async function runSegmentation() {
  const seriesUid = _seriesUid;
  if (!seriesUid) {
    alert('No series selected. Open this window from the DICOM viewer or MPR tab.');
    return;
  }

  const btn = document.getElementById('runBtn');
  btn.disabled = true;
  document.getElementById('resultsCard').style.display = 'none';
  document.getElementById('savedMsg').style.display    = 'none';

  const wrap = document.getElementById('progressWrap');
  const bar  = document.getElementById('progressBar');
  const msg  = document.getElementById('statusMsg');
  wrap.style.display = 'block';

  // Animate progress bar (indeterminate — we don't get server events)
  let pct = 0;
  const tick = setInterval(() => {
    pct = Math.min(pct + (pct < 70 ? 2 : 0.3), 95);
    bar.style.width = pct + '%';
  }, 800);

  const quality = _fastMode ? 'fast (~30 s)' : 'full quality (~3–5 min)';
  msg.style.borderColor = '#4fc3f7';
  msg.textContent = `Running TotalSegmentator in ${quality} mode… please wait.`;

  try {
    const res = await fetch(`${API}/ml-segment`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ series_uid: seriesUid, fast: _fastMode }),
    });

    clearInterval(tick);
    bar.style.width = '100%';

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail ?? `HTTP ${res.status}`);
    }

    const data = await res.json();
    _lastResult = data;
    _savedFile  = data.saved_file ?? null;

    msg.style.borderColor = '#81c784';
    msg.textContent = `Done! Contours loaded for ${Object.keys(data).filter(k => k !== 'saved_file' && k !== 'roi_list').length} structures.`;

    _showResults(data);

  } catch (err) {
    clearInterval(tick);
    bar.style.width = '0%';
    bar.style.background = '#ef5350';
    msg.style.borderColor = '#ef5350';
    msg.textContent = `Segmentation failed: ${err.message}`;
    btn.disabled = false;
  }
}

// ── Display results panel ─────────────────────────────────────────────────────
function _showResults(data) {
  const COLORS = { 'Heart': '#ef5350', 'Left Lung': '#4fc3f7', 'Right Lung': '#81c784' };
  const STRUCTURES = ['Heart', 'Left Lung', 'Right Lung'];

  const list = document.getElementById('structList');
  list.innerHTML = STRUCTURES.map(name => {
    const contours = data[name] ?? [];
    const color    = COLORS[name] ?? '#ffcc44';
    const count    = contours.length;
    return `
      <div class="struct-row">
        <span class="struct-dot" style="background:${color};"></span>
        <span class="struct-name">${name}</span>
        ${count > 0
          ? `<span class="struct-count">${count} slices</span>
             <span class="struct-ok">✓</span>`
          : `<span class="struct-count" style="color:#f66;">not found</span>`
        }
      </div>`;
  }).join('');

  if (_savedFile) {
    const msg = document.getElementById('savedMsg');
    msg.style.display = 'block';
    msg.textContent   = `Auto-saved: ${_savedFile} — use "Load ROIs" in MPR to import.`;
  }

  document.getElementById('resultsCard').style.display = 'block';
  document.getElementById('runBtn').disabled = false;
}

// ── Send results to MPR window via postMessage ────────────────────────────────
function sendToMPR() {
  if (!_lastResult || !_lastResult.roi_list) {
    alert('No segmentation result available. Run segmentation first.');
    return;
  }
  const target = window.opener;
  if (!target) {
    alert('MPR window not found — use "Save ROIs" then "Load ROIs" in the MPR view.');
    return;
  }
  target.postMessage({ type: 'ml-seg-result', rois: _lastResult.roi_list }, '*');
  document.getElementById('savedMsg').textContent =
    'Sent to MPR view! The contours should appear on all three planes.';
  document.getElementById('savedMsg').style.display = 'block';
}

// ── Save ROIs to backend ──────────────────────────────────────────────────────
async function saveToBackend() {
  if (!_lastResult || !_lastResult.roi_list) {
    alert('No segmentation result to save.');
    return;
  }
  // roi_list is already saved by the backend; just confirm.
  const msg = document.getElementById('savedMsg');
  msg.style.display = 'block';
  if (_savedFile) {
    msg.textContent = `Already saved as: ${_savedFile}`;
  } else {
    // Shouldn't happen, but re-save via roi-save.js if roiStore is available.
    msg.textContent = 'Results were auto-saved by the backend when segmentation completed.';
  }
}

// ── Export RTSTRUCT ───────────────────────────────────────────────────────────
async function exportRtstruct() {
  if (!_savedFile) {
    alert('Save ROIs first.');
    return;
  }
  // Delegate to roi-save.js exportRtstruct helper if available.
  if (typeof roiSave !== 'undefined' && typeof roiSave.exportRtstruct === 'function') {
    await roiSave.exportRtstruct(_savedFile, _seriesUid ?? '');
  } else {
    alert(`Load "${_savedFile}" in the MPR view, then use the ⬇ RTSTRUCT button there.`);
  }
}

// ── Receive series_uid from opener if not in URL params ───────────────────────
window.addEventListener('message', e => {
  if (e.data && e.data.type === 'ml-seg-series') {
    _seriesUid = e.data.series_uid ?? '';
    document.getElementById('seriesInfo').textContent =
      `Series: ${_seriesUid.slice(0, 32)}… · TotalSegmentator`;
  }
});

// Expose for inline onclick attrs
/* global _fastMode, _seriesUid, _lastResult, _savedFile */
