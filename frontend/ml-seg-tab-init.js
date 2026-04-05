// ml-seg-tab-init.js — AI segmentation tab.
// Methods: totalsegmentator | platipy | ts-heart | monai | medsam

'use strict';

const API = 'http://127.0.0.1:8000';

const params    = new URLSearchParams(location.search);
let _seriesUid  = params.get('series_uid') || '';
let _fastMode   = true;
let _method     = 'totalsegmentator';
let _lastResult = null;
let _savedFile  = null;
let _gpuName    = null;
let _pollTimer  = null;

// Per-method install/readiness flags (set by startup checks)
const _notInstalled = {};   // package not installed → disable Run + show notice
const _noLicense    = {};   // installed but licence missing → show notice, disable Run

// ── On load: check all backends ───────────────────────────────────────────────
(async () => {
  if (_seriesUid) {
    document.getElementById('seriesInfo').textContent =
      `Series UID: ${_seriesUid.slice(0, 40)}…`;
  }

  // Check TotalSegmentator (also used by ts-heart)
  try {
    const r = await fetch(`${API}/check-totalseg`);
    const d = await r.json();
    if (!d.installed) {
      document.getElementById('installNotice').style.display = 'block';
      _notInstalled['totalsegmentator'] = true;
    } else {
      if (d.gpu) {
        _gpuName = d.gpu.name;
        const mem = Math.round(d.gpu.memory_mb / 1024);
        _showBadge('gpuBadge', `GPU: ${_gpuName} (${mem} GB)`,
                   '#1a4a2a', '#81c784', '#4caf50');
      } else {
        _showBadge('gpuBadge', 'CPU only (no CUDA GPU detected)',
                   '#3a2a00', '#ffcc44', '#996600');
      }
    }
  } catch (_) {
    _showBadge('gpuBadge', 'Backend unreachable', '#2a2a2a', '#888', '#555');
  }

  // Check Platipy
  try {
    const r = await fetch(`${API}/check-platipy`);
    const d = await r.json();
    if (!d.installed) {
      _notInstalled['platipy'] = true;
    } else if (!d.atlas_ready) {
      _showBadge('platipyBadge',
        'Platipy: atlas not yet downloaded (will auto-download on first run)',
        '#3a2a00', '#ffcc44', '#996600');
    } else {
      _showBadge('platipyBadge', 'Platipy: atlas ready', '#1a4a2a', '#81c784', '#4caf50');
    }
  } catch (_) { /* ignore */ }

  // Check TS Cardiac HR (licence awareness)
  try {
    const r = await fetch(`${API}/check-ts-heart`);
    const d = await r.json();
    if (!d.installed) {
      _notInstalled['ts-heart'] = true;
    } else if (d.license === false) {
      _noLicense['ts-heart'] = true;
      _showBadge('tsHeartBadge', 'TS Cardiac HR: licence not configured (see notice)',
                 '#3a2a00', '#ffcc44', '#996600');
    } else if (d.license === true) {
      const gpu = d.gpu;
      const label = gpu ? `${gpu.name} (${Math.round(gpu.memory_mb/1024)} GB)` : 'CPU only';
      _showBadge('tsHeartBadge', `TS Cardiac HR ready · ${label}`,
                 '#1a4a2a', '#81c784', '#4caf50');
    } else {
      // licence status unknown (None returned) — still usable, will error on run if missing
      const gpu = d.gpu;
      const label = gpu ? `${gpu.name} (${Math.round(gpu.memory_mb/1024)} GB)` : 'CPU only';
      _showBadge('tsHeartBadge', `TS Cardiac HR installed · ${label}`,
                 '#1a4a2a', '#81c784', '#4caf50');
    }
  } catch (_) { /* ignore */ }

  // Check MONAI
  try {
    const r = await fetch(`${API}/check-monai`);
    const d = await r.json();
    if (!d.installed) {
      _notInstalled['monai'] = true;
    } else if (!d.bundle_ready) {
      _showBadge('monaiBadge', 'MONAI: bundle downloads on first run (~200 MB)',
                 '#3a2a00', '#ffcc44', '#996600');
    } else {
      _showBadge('monaiBadge', 'MONAI: bundle ready', '#1a4a2a', '#81c784', '#4caf50');
    }
  } catch (_) { /* ignore */ }

  // Check MedSAM
  try {
    const r = await fetch(`${API}/check-medsam`);
    const d = await r.json();
    if (!d.installed) {
      _notInstalled['medsam'] = true;
    } else if (!d.model_cached) {
      const gpu = d.gpu;
      const label = gpu ? `GPU: ${gpu.name}` : 'CPU only';
      _showBadge('medsamBadge', `MedSAM: model downloads on first run (~375 MB) · ${label}`,
                 '#3a2a00', '#ffcc44', '#996600');
    } else {
      const gpu = d.gpu;
      const label = gpu ? `GPU: ${gpu.name} (${Math.round(gpu.memory_mb/1024)} GB)` : 'CPU only';
      _showBadge('medsamBadge', `MedSAM: model cached · ${label}`,
                 '#1a4a2a', '#81c784', '#4caf50');
    }
  } catch (_) { /* ignore */ }

  _applyMethod();
})();

function _showBadge(id, text, bg, color, border) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent        = text;
  el.style.display      = 'inline-block';
  el.style.background   = bg;
  el.style.color        = color;
  el.style.borderColor  = border;
}

// ── Method toggle ─────────────────────────────────────────────────────────────
const _METHOD_BTN = {
  'totalsegmentator': 'btnMethodTS',
  'platipy':          'btnMethodPlatipy',
  'ts-heart':         'btnMethodTSHeart',
  'monai':            'btnMethodMonai',
  'medsam':           'btnMethodMedSAM',
};

function setMethod(m) {
  _method = m;
  _applyMethod();   // handles active-class + all UI updates
}

// Descriptions and timing notes per method
const _METHOD_DESC = {
  'totalsegmentator': 'Heart + Lungs — GPU accelerated',
  'platipy':          'Full cardiac atlas — CPU only, ~2–4 min',
  'ts-heart':         'Heart chambers (highres) — requires TS research licence',
  'monai':            'MONAI whole-heart bundle — GPU accelerated',
  'medsam':           'MedSAM slice-by-slice — heart only, prompt-based SAM',
};
const _METHOD_NOTE = {
  'ts-heart': 'TS heartchambers_highres segments myocardium + all 4 chambers at full resolution. ' +
              'Requires a <strong style="color:#4fc3f7;">free</strong> research licence ' +
              '(<code style="color:#4fc3f7;background:#111;padding:1px 3px;border-radius:3px;">' +
              'totalseg_get_license_key --email you@example.com</code>). ' +
              'Weights cached in <code style="color:#4fc3f7;background:#111;padding:1px 3px;border-radius:3px;">' +
              '~/.totalsegmentator/</code>.',
  'monai':    'Uses the MONAI Model Zoo <em>wholeBody_ct_segmentation</em> bundle ' +
              '(SegResNet, 104 structures, same training set as TotalSegmentator). ' +
              'Heart labels are extracted from the full-body segmentation. ' +
              'Bundle auto-downloads on first run (~1 GB) and is cached in ' +
              '<code style="color:#4fc3f7;background:#111;padding:1px 3px;border-radius:3px;">' +
              '~/.cache/monai_bundles/</code>. GPU strongly recommended.',
  'medsam':   'Segments the heart slice-by-slice using MedSAM-ViT-B (HuggingFace). ' +
              'Model auto-downloads on first run (~375 MB) and is cached in ' +
              '<code style="color:#4fc3f7;background:#111;padding:1px 3px;border-radius:3px;">' +
              '~/.cache/huggingface/</code>. GPU strongly recommended — CPU takes ~3 min.',
  'platipy':  'Segments the <strong style="color:#ef5350;">complete heart</strong> via atlas ' +
              'registration: Whole Heart · L/R Atrium · L/R Ventricle · Aorta · Pulmonary Artery · SVC. ' +
              '<span style="color:#555;">Lungs not segmented.</span>',
};

function _applyMethod() {
  try {
    const m       = _method;
    const isTS    = m === 'totalsegmentator';

    // ── Method selector buttons ───────────────────────────────────────────
    for (const [key, id] of Object.entries(_METHOD_BTN)) {
      document.getElementById(id)?.classList.toggle('active', key === m);
    }

    // ── Status badges: show only the active method's badge ────────────────
    const BADGE_IDS = {
      'totalsegmentator': 'gpuBadge',
      'platipy':          'platipyBadge',
      'ts-heart':         'tsHeartBadge',
      'monai':            'monaiBadge',
      'medsam':           'medsamBadge',
    };
    for (const [key, bid] of Object.entries(BADGE_IDS)) {
      const el = document.getElementById(bid);
      if (el) el.style.display = (key === m) ? 'inline-block' : 'none';
    }

    // ── Install / licence notices ─────────────────────────────────────────
    const NOTICE_IDS = {
      'totalsegmentator': 'installNotice',
      'platipy':          'platipyNotice',
      'ts-heart':         'tsHeartNotice',
      'monai':            'monaiNotice',
      'medsam':           'medsamNotice',
    };
    for (const [key, nid] of Object.entries(NOTICE_IDS)) {
      const el = document.getElementById(nid);
      if (!el) continue;
      if (key !== m) {
        el.style.display = 'none';
        continue;
      }
      // Active method — show if package missing or licence missing
      if (key === 'ts-heart') {
        el.style.display = _noLicense[key] ? 'block' : 'none';
      } else if (key === 'totalsegmentator') {
        // already set by startup check, leave it
      } else {
        el.style.display = _notInstalled[key] ? 'block' : 'none';
      }
    }

    // ── Config card sections ──────────────────────────────────────────────
    const show = (id, visible) => {
      const el = document.getElementById(id);
      if (el) el.style.display = visible ? '' : 'none';
    };
    show('tsOrganGrid',   isTS);
    show('qualitySection', isTS);

    // Heart-only info
    const infoEl = document.getElementById('heartOnlyInfo');
    if (infoEl) {
      const note = _METHOD_NOTE[m];
      if (!isTS && note) {
        infoEl.innerHTML     = note;
        infoEl.style.display = 'block';
      } else {
        infoEl.style.display = 'none';
      }
    }

    // ── Method description ────────────────────────────────────────────────
    const descEl = document.getElementById('methodDesc');
    if (descEl) descEl.textContent = _METHOD_DESC[m] ?? '';

    // ── Run button ────────────────────────────────────────────────────────
    const runBtn = document.getElementById('runBtn');
    if (runBtn) {
      const LABELS = {
        'totalsegmentator': '▶ Run Segmentation',
        'platipy':          '▶ Run Platipy Cardiac',
        'ts-heart':         '▶ Run TS Cardiac HR',
        'monai':            '▶ Run MONAI',
        'medsam':           '▶ Run MedSAM',
      };
      runBtn.textContent = LABELS[m] ?? '▶ Run';
      runBtn.disabled    = !!(_notInstalled[m] || _noLicense[m]);
    }

    if (isTS) _refreshHint();

  } catch (err) {
    console.error('[ml-seg] _applyMethod error:', err);
  }
}

// ── Quality toggle (TS only) ──────────────────────────────────────────────────
function setQuality(fast) {
  _fastMode = fast;
  document.getElementById('btnFast').classList.toggle('active',  fast);
  document.getElementById('btnFull').classList.toggle('active', !fast);
  _refreshHint();
}

function _refreshHint() {
  const el = document.getElementById('qualityHint');
  if (!el) return;
  if (_fastMode) {
    el.textContent = _gpuName
      ? `~30–60 s on ${_gpuName}`
      : '~5–10 min on CPU  (GPU strongly recommended)';
  } else {
    el.textContent = _gpuName
      ? `~2–4 min on ${_gpuName}`
      : '~15–30 min on CPU  (GPU strongly recommended)';
  }
}

// ── Run segmentation ──────────────────────────────────────────────────────────
async function runSegmentation() {
  if (!_seriesUid) {
    alert('No series selected. Open this window from the MPR view.');
    return;
  }

  document.getElementById('runBtn').disabled            = true;
  document.getElementById('resultsCard').style.display  = 'none';
  document.getElementById('savedMsg').style.display     = 'none';

  const wrap = document.getElementById('progressWrap');
  const bar  = document.getElementById('progressBar');
  wrap.style.display   = 'block';
  bar.style.width      = '0%';
  bar.style.background = '#4fc3f7';
  bar.style.animation  = 'none';

  _setStatus('Starting job…', '#4fc3f7');

  try {
    const body = { series_uid: _seriesUid, fast: _fastMode, method: _method };
    const startRes = await fetch(`${API}/ml-segment-start`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!startRes.ok) {
      const err = await startRes.json().catch(() => ({}));
      throw new Error(err.detail ?? `HTTP ${startRes.status}`);
    }
    const { job_id } = await startRes.json();
    _pollTimer = setInterval(() => _pollJob(job_id, bar), 1500);

  } catch (err) {
    _setStatus(`Error: ${err.message}`, '#ef5350');
    bar.style.width = '0%';
    document.getElementById('runBtn').disabled = false;
  }
}

async function _pollJob(job_id, bar) {
  try {
    const r = await fetch(`${API}/ml-segment-status/${job_id}`);
    if (!r.ok) return;
    const job = await r.json();

    bar.style.width = `${job.pct ?? 0}%`;
    _setStatus(job.stage ?? '…', job.status === 'error' ? '#ef5350' : '#4fc3f7');

    if (job.status === 'done') {
      clearInterval(_pollTimer); _pollTimer = null;
      bar.style.width      = '100%';
      bar.style.background = '#81c784';
      _setStatus('Segmentation complete!', '#81c784');
      _lastResult = job.result;
      _savedFile  = job.result?.saved_file ?? null;
      _showResults(job.result);
      document.getElementById('runBtn').disabled = false;

    } else if (job.status === 'error') {
      clearInterval(_pollTimer); _pollTimer = null;
      bar.style.background = '#ef5350';
      _setStatus(job.error ?? 'Unknown error', '#ef5350');
      document.getElementById('runBtn').disabled = false;
    }
  } catch (_) { /* network blip */ }
}

function _setStatus(text, color) {
  const el = document.getElementById('statusMsg');
  if (!el) return;
  el.textContent       = text;
  el.style.borderColor = color ?? '#444';
}

// ── Results panel ─────────────────────────────────────────────────────────────
function _showResults(data) {
  const COLORS = { Heart: '#ef5350', 'Left Lung': '#4fc3f7', 'Right Lung': '#81c784' };
  const HEART_ONLY = ['platipy', 'ts-heart', 'monai', 'medsam'];
  const structs = HEART_ONLY.includes(_method)
    ? ['Heart']
    : ['Heart', 'Left Lung', 'Right Lung'];

  const list = document.getElementById('structList');
  list.innerHTML = structs.map(name => {
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
  sm.textContent   = 'Contours sent to MPR window!';
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

// ── ROI → 3D Field Mask ───────────────────────────────────────────────────────

let _fmLastResult = null;   // last response from /roi-field-mask

// Populate the ROI file picker from the backend.
async function fmRefreshFiles() {
  try {
    const r = await fetch(`${API}/load-roi/`);
    const d = await r.json();
    const sel = document.getElementById('fmRoiFileSelect');
    sel.innerHTML = '<option value="">— saved ROI file —</option>' +
      (d.files ?? []).map(f => `<option value="${f}">${f}</option>`).join('');
  } catch (err) {
    _fmSetStatus(`Could not load ROI list: ${err.message}`, '#ef5350');
  }
}

async function generateFieldMask() {
  const filename = document.getElementById('fmRoiFileSelect').value.trim();
  const roiName  = document.getElementById('fmRoiName').value.trim();

  if (!filename) {
    alert('Select a saved ROI file first (or press ↻ Refresh to load the list).');
    return;
  }

  _fmSetStatus('Computing field mask…', '#4fc3f7');
  document.getElementById('fmResult').style.display = 'none';
  _fmLastResult = null;

  try {
    const body = { filename, series_uid: _seriesUid };
    if (roiName) body.roi_name = roiName;

    const r = await fetch(`${API}/roi-field-mask`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail ?? `HTTP ${r.status}`);
    }

    const data = await r.json();
    _fmLastResult = data;

    // Show saved filename
    const savedEl = document.getElementById('fmSavedMsg');
    savedEl.textContent = `✓ Saved to backend: ${data.saved_file}`;

    // Show stats
    const [nz, nr, nc] = data.shape;
    document.getElementById('fmStats').innerHTML =
      `<b>Shape:</b> ${nz} × ${nr} × ${nc}&ensp;` +
      `<b>Annotated:</b> ${data.annotated_slices} slices&ensp;` +
      `<b>Interpolated:</b> ${data.interpolated_slices} slices&ensp;` +
      `<b>Voxels:</b> ${data.voxel_count.toLocaleString()}`;

    // Wire download link directly to backend
    const dlLink = document.getElementById('fmDownloadLink');
    dlLink.href  = `${API}/saved-masks/${encodeURIComponent(data.saved_file)}`;
    dlLink.style.display = 'inline-block';

    document.getElementById('fmResult').style.display = 'block';
    _fmSetStatus('Done — mask saved on server.', '#81c784');

  } catch (err) {
    _fmSetStatus(`Error: ${err.message}`, '#ef5350');
  }
}

function _fmSetStatus(text, color) {
  const el = document.getElementById('fmStatus');
  if (!el) return;
  el.textContent       = text;
  el.style.borderColor = color ?? '#444';
  el.style.display     = 'block';
}

// Pre-populate the file picker on load
fmRefreshFiles();

// ── Receive series_uid from opener ────────────────────────────────────────────
window.addEventListener('message', e => {
  if (e.data?.type === 'ml-seg-series') {
    _seriesUid = e.data.series_uid ?? '';
    document.getElementById('seriesInfo').textContent =
      `Series UID: ${_seriesUid.slice(0, 40)}…`;
  }
});
