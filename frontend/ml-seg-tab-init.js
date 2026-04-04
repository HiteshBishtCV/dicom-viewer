// ml-seg-tab-init.js — AI segmentation tab (TotalSegmentator, GPU-aware).

'use strict';

const API = 'http://127.0.0.1:8000';

const params    = new URLSearchParams(location.search);
let _seriesUid  = params.get('series_uid') || '';
let _fastMode   = true;
let _lastResult = null;
let _savedFile  = null;
let _gpuName    = null;      // null = CPU, string = GPU name
let _pollTimer  = null;

// ── On load: check TotalSegmentator + GPU ─────────────────────────────────────
(async () => {
  if (_seriesUid) {
    document.getElementById('seriesInfo').textContent =
      `Series UID: ${_seriesUid.slice(0, 40)}…`;
  }

  try {
    const r = await fetch(`${API}/check-totalseg`);
    const d = await r.json();

    if (!d.installed) {
      document.getElementById('installNotice').style.display = 'block';
      document.getElementById('configCard').style.opacity    = '0.45';
      document.getElementById('runBtn').disabled             = true;
    } else {
      // Show GPU badge
      if (d.gpu) {
        _gpuName = d.gpu.name;
        const mem = Math.round(d.gpu.memory_mb / 1024);
        _showGpuBadge(`🟢 GPU: ${_gpuName} (${mem} GB)`, '#1a4a2a', '#81c784', '#4caf50');
      } else {
        _showGpuBadge('🟡 CPU only (no CUDA GPU detected)', '#3a2a00', '#ffcc44', '#996600');
      }
      _refreshHint();
    }
  } catch (_) {
    _showGpuBadge('⚪ Backend unreachable', '#2a2a2a', '#888', '#555');
  }
})();

function _showGpuBadge(text, bg, color, border) {
  const el = document.getElementById('gpuBadge');
  if (!el) return;
  el.textContent   = text;
  el.style.display = 'inline-block';
  el.style.background   = bg;
  el.style.color        = color;
  el.style.borderColor  = border;
}

function _refreshHint() {
  const el = document.getElementById('qualityHint');
  if (!el) return;
  if (_fastMode) {
    el.textContent = _gpuName
      ? `~10–20 s on ${_gpuName}`
      : '~3–5 min on CPU  (GPU strongly recommended)';
  } else {
    el.textContent = _gpuName
      ? `~30–60 s on ${_gpuName}`
      : '~10–20 min on CPU  (GPU strongly recommended)';
  }
}

// ── Quality toggle ─────────────────────────────────────────────────────────────
function setQuality(fast) {
  _fastMode = fast;
  document.getElementById('btnFast').classList.toggle('active',  fast);
  document.getElementById('btnFull').classList.toggle('active', !fast);
  _refreshHint();
}

// ── Run segmentation ──────────────────────────────────────────────────────────
async function runSegmentation() {
  if (!_seriesUid) {
    alert('No series selected. Open this window from the MPR view.');
    return;
  }

  document.getElementById('runBtn').disabled             = true;
  document.getElementById('resultsCard').style.display  = 'none';
  document.getElementById('savedMsg').style.display     = 'none';

  const wrap = document.getElementById('progressWrap');
  const bar  = document.getElementById('progressBar');
  const msg  = document.getElementById('statusMsg');
  wrap.style.display    = 'block';
  bar.style.width       = '0%';
  bar.style.background  = '#4fc3f7';
  bar.style.animation   = 'none';

  _setStatus('Starting job…', '#4fc3f7');

  try {
    const startRes = await fetch(`${API}/ml-segment-start`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ series_uid: _seriesUid, fast: _fastMode }),
    });
    if (!startRes.ok) {
      const err = await startRes.json().catch(() => ({}));
      throw new Error(err.detail ?? `HTTP ${startRes.status}`);
    }
    const { job_id } = await startRes.json();

    // Poll every 1.5 s for progress updates.
    _pollTimer = setInterval(() => _pollJob(job_id, bar, msg), 1500);

  } catch (err) {
    _setStatus(`Error: ${err.message}`, '#ef5350');
    bar.style.width = '0%';
    document.getElementById('runBtn').disabled = false;
  }
}

async function _pollJob(job_id, bar, msg) {
  try {
    const r = await fetch(`${API}/ml-segment-status/${job_id}`);
    if (!r.ok) return;
    const job = await r.json();

    // Update progress bar.
    bar.style.width = `${job.pct ?? 0}%`;
    _setStatus(job.stage ?? '…', job.status === 'error' ? '#ef5350' : '#4fc3f7');

    if (job.status === 'done') {
      clearInterval(_pollTimer); _pollTimer = null;
      bar.style.width      = '100%';
      bar.style.background = '#81c784';
      bar.style.animation  = 'none';
      _setStatus('Segmentation complete!', '#81c784');
      _lastResult = job.result;
      _savedFile  = job.result?.saved_file ?? null;
      _showResults(job.result);
      document.getElementById('runBtn').disabled = false;

    } else if (job.status === 'error') {
      clearInterval(_pollTimer); _pollTimer = null;
      bar.style.background = '#ef5350';
      bar.style.animation  = 'none';
      _setStatus(`Failed: ${job.error}`, '#ef5350');
      document.getElementById('runBtn').disabled = false;
    }
  } catch (_) { /* network blip — keep polling */ }
}

function _setStatus(text, color) {
  const el = document.getElementById('statusMsg');
  if (!el) return;
  el.textContent    = text;
  el.style.borderColor = color ?? '#444';
}

// ── Results panel ─────────────────────────────────────────────────────────────
function _showResults(data) {
  const COLORS = { Heart: '#ef5350', 'Left Lung': '#4fc3f7', 'Right Lung': '#81c784' };
  const list   = document.getElementById('structList');
  list.innerHTML = ['Heart', 'Left Lung', 'Right Lung'].map(name => {
    const n   = (data[name] ?? []).length;
    const col = COLORS[name];
    return `<div class="struct-row">
      <span class="struct-dot" style="background:${col};"></span>
      <span class="struct-name">${name}</span>
      ${n > 0
        ? `<span class="struct-count">${n} slices</span><span class="struct-ok">✓</span>`
        : `<span class="struct-count" style="color:#f66;">not found</span>`}
    </div>`;
  }).join('');

  if (_savedFile) {
    const sm = document.getElementById('savedMsg');
    sm.style.display = 'block';
    sm.textContent   = `Auto-saved: ${_savedFile}`;
  }
  document.getElementById('resultsCard').style.display = 'block';
}

// ── Send to MPR ───────────────────────────────────────────────────────────────
function sendToMPR() {
  if (!_lastResult?.roi_list?.length) {
    alert('No result yet — run segmentation first.');
    return;
  }
  const target = window.opener;
  if (!target || target.closed) {
    alert('MPR window not found.\nUse "Load ROIs" in the MPR view and pick:\n' + (_savedFile ?? '(file)'));
    return;
  }
  target.postMessage({ type: 'ml-seg-result', rois: _lastResult.roi_list }, '*');
  const sm = document.getElementById('savedMsg');
  sm.style.display = 'block';
  sm.textContent   = 'Contours sent to MPR window! They should appear on all three planes.';
}

// ── Save / export ─────────────────────────────────────────────────────────────
function saveToBackend() {
  const sm = document.getElementById('savedMsg');
  sm.style.display = 'block';
  sm.textContent   = _savedFile
    ? `Already saved as: ${_savedFile} — load it via "↓ Load ROIs" in MPR.`
    : 'Results are auto-saved by the backend when segmentation completes.';
}

async function exportRtstruct() {
  if (!_savedFile) { alert('Run segmentation first.'); return; }
  if (typeof roiSave !== 'undefined' && roiSave.exportRtstruct) {
    await roiSave.exportRtstruct(_savedFile, _seriesUid);
  } else {
    alert(`Load "${_savedFile}" in MPR then use the ⬇ RTSTRUCT button.`);
  }
}

// ── Receive series_uid from opener if not in URL ──────────────────────────────
window.addEventListener('message', e => {
  if (e.data?.type === 'ml-seg-series') {
    _seriesUid = e.data.series_uid ?? '';
    document.getElementById('seriesInfo').textContent =
      `Series UID: ${_seriesUid.slice(0, 40)}…`;
  }
});
