'use strict';

const API = 'http://127.0.0.1:8000';

let _seriesUid = '';
let _allRois   = [];   // ROI objects forwarded from the MPR window

// ── Receive payload from MPR window ──────────────────────────────────────────

window.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'field-stats-data') return;

  _seriesUid = e.data.series_uid ?? '';
  _allRois   = e.data.rois        ?? [];

  const uid  = _seriesUid ? _seriesUid.slice(0, 40) + '…' : 'unknown series';
  document.getElementById('seriesInfo').textContent =
    `${_allRois.length} ROI contours received · Series: ${uid}`;

  _populateSelects(_allRois);
  document.getElementById('computeBtn').disabled = false;
});

// Signal opener that we are ready to receive data.
if (window.opener && !window.opener.closed) {
  window.opener.postMessage({ type: 'field-stats-ready' }, '*');
}

// ── Populate structure selectors from ROI names ───────────────────────────────

function _populateSelects(rois) {
  // Collect unique names, preserving insertion order.
  const names = [...new Set(rois.map(r => r.name).filter(Boolean))];

  const fieldSel = document.getElementById('fieldSelect');
  const lungSel  = document.getElementById('lungSelect');
  const heartSel = document.getElementById('heartSelect');

  const opt = (v, label) => `<option value="${v}">${label}</option>`;

  fieldSel.innerHTML  = '<option value="">— select —</option>' +
    names.map(n => opt(n, n)).join('');
  heartSel.innerHTML  = '<option value="">— none / skip —</option>' +
    names.map(n => opt(n, n)).join('');
  lungSel.innerHTML   = names.map(n => opt(n, n)).join('');

  // Auto-select by common naming conventions.
  const lower = n => n.toLowerCase();
  const autoField = names.find(n => lower(n).includes('roi') ||
                                    lower(n).includes('field') ||
                                    lower(n).includes('ptv') ||
                                    lower(n).includes('gtv'));
  const autoHeart = names.find(n => lower(n).includes('heart'));

  if (autoField) fieldSel.value = autoField;
  if (autoHeart) heartSel.value = autoHeart;

  // Auto-select lung options (multi-select: select all lung entries).
  for (const opt of lungSel.options) {
    opt.selected = lower(opt.value).includes('lung');
  }
}

// ── Compute ───────────────────────────────────────────────────────────────────

async function computeStats() {
  const fieldName = document.getElementById('fieldSelect').value;
  if (!fieldName) { alert('Select a Treatment Field ROI first.'); return; }

  const lungSel   = document.getElementById('lungSelect');
  const lungNames = [...lungSel.options].filter(o => o.selected).map(o => o.value);
  const heartName = document.getElementById('heartSelect').value;

  if (!lungNames.length && !heartName) {
    alert('Select at least one organ (lung or heart) to compute overlap against.');
    return;
  }

  const bx = parseFloat(document.getElementById('beamBx').value) || 0;
  const by = parseFloat(document.getElementById('beamBy').value) || 0;
  const hasCld = lungNames.length > 0 && (bx !== 0 || by !== 0);

  _setStatus('Computing… (rasterising + SDT interpolation)', '#4fc3f7');
  document.getElementById('computeBtn').disabled = true;
  document.getElementById('resultsCard').style.display = 'none';

  try {
    const body = {
      series_uid:     _seriesUid,
      rois:           _allRois,
      field_roi_name: fieldName,
      lung_roi_names: lungNames,
      heart_roi_name: heartName,
    };
    if (hasCld) body.beam_direction = [bx, by];

    const res = await fetch(`${API}/rt-features`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail ?? `HTTP ${res.status}`);
    }

    const data = await res.json();
    _showResults(data, lungNames.length > 0, !!heartName);
    _setStatus('Done.', '#81c784');

  } catch (err) {
    _setStatus(`Error: ${err.message}`, '#ef5350');
  } finally {
    document.getElementById('computeBtn').disabled = false;
  }
}

// ── Display results ───────────────────────────────────────────────────────────

function _showResults(data, showLung, showHeart) {
  // ── Summary ───────────────────────────────────────────────────────────────
  document.getElementById('fieldVolume').textContent  = data.field_volume_cc  ?? '—';
  document.getElementById('centralSlice').textContent = data.central_slice_index ?? '—';
  document.getElementById('voxelVol').textContent     = '—';   // not in flat dict
  const sp = data.spacing_mm ?? [];
  document.getElementById('spacingTxt').textContent   =
    sp.length === 3 ? `${sp[0]} × ${sp[1]} × ${sp[2]} mm` : '—';

  // ── Lung ──────────────────────────────────────────────────────────────────
  const lungRow = document.getElementById('lungRow');
  if (showLung && data.lung_volume_cc != null) {
    const pct = data.lung_percent_in_field ?? 0;
    lungRow.style.display = 'flex';
    document.getElementById('lungTotal').textContent   = data.lung_volume_cc;
    document.getElementById('lungInField').textContent = data.lung_volume_in_field_cc;
    document.getElementById('lungPct').textContent     = pct + '%';
    document.getElementById('lungBar').style.width     = Math.min(pct, 100) + '%';
    const lungColour = pct > 35 ? '#ef5350' : pct > 20 ? '#ffb74d' : '#4fc3f7';
    document.getElementById('lungBar').style.background = lungColour;
    document.getElementById('lungPct').style.color      = lungColour;
  } else {
    lungRow.style.display = 'none';
  }

  // ── Heart ─────────────────────────────────────────────────────────────────
  const heartRow = document.getElementById('heartRow');
  if (showHeart && data.heart_volume_cc != null) {
    const pct = data.heart_percent_in_field ?? 0;
    heartRow.style.display = 'flex';
    document.getElementById('heartTotal').textContent   = data.heart_volume_cc;
    document.getElementById('heartInField').textContent = data.heart_volume_in_field_cc;
    document.getElementById('heartPct').textContent     = pct + '%';
    document.getElementById('heartBar').style.width     = Math.min(pct, 100) + '%';
    const heartColour = pct > 10 ? '#ef5350' : pct > 5 ? '#ffb74d' : '#81c784';
    document.getElementById('heartBar').style.background = heartColour;
    document.getElementById('heartPct').style.color      = heartColour;
  } else {
    heartRow.style.display = 'none';
  }

  // ── CLD ───────────────────────────────────────────────────────────────────
  const cldRow = document.getElementById('cldRow');
  if (data.cld_mm != null) {
    document.getElementById('cldValue').textContent = `${data.cld_mm} mm`;
    cldRow.style.display = 'flex';
  } else {
    cldRow.style.display = 'none';
  }

  document.getElementById('resultsCard').style.display = 'block';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _setStatus(text, color) {
  const el = document.getElementById('statusMsg');
  el.textContent       = text;
  el.style.borderColor = color ?? '#444';
  el.style.display     = 'block';
}
