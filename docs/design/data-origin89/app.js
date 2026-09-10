(() => {
  'use strict';
  const D = window.ORIGIN89_DATA;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeUrl = (url) => { try { const u = new URL(url); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
  const labels = {'modbus-rs485':'Modbus / RS-485','modbus-tcp':'Modbus TCP','ve-direct':'VE.Direct','can-bms':'CAN / BMS','other-serial':'Other serial','lan-http':'LAN / HTTP','local-io':'Local I/O','no-comms':'No communications'};
  const confidence = {'vendor-doc':'Vendor document','community-crosschecked':'Community · cross-checked','community-single':'Community · single source','unverified':'Unverified'};
  const kindLabel = (kind) => kind ? kind.replaceAll('-', ' ') : 'Unclassified';
  const badge = (label, tone = '') => `<span class="evidence ${tone}">${esc(label)}</span>`;
  const modelStatus = m => m.reviewed_by ? badge('Human reviewed','blue') : m.tier === 'feed' ? badge('Public feed','blue') : badge('Not reviewed');
  const specStatus = s => s.reviewed_by ? badge('Human reviewed','blue') : s.extracted_by ? badge('Extracted','amber') : s.tier === 'feed' ? badge('Public feed','blue') : badge('Not reviewed');
  const familyLabel = id => labels[id] || id;
  const sourceLink = source => safeUrl(source?.url);
  let state = { table: 'models', page: 0, query: '', filter: '' };
  const pageSize = 6;

  $('stats').innerHTML = [['models','Equipment models'],['specs','Specification rows'],['dialects','Protocol dialects'],['sources','Source records']].map(([key,label]) => `<div class="stat"><strong>${fmt(D.counts[key])}</strong><span>${label}</span></div>`).join('');
  const heroUrl = sourceLink(D.hero.source);
  $('source-link').href = heroUrl ? `${heroUrl}#page=${encodeURIComponent(D.hero.page)}` : '#evidence';
  $('source-name').textContent = heroUrl ? decodeURIComponent(new URL(heroUrl).pathname.split('/').pop()).replace(/\.pdf$/i,'').replaceAll('_',' ').replaceAll('-',' ') : 'Manufacturer document';

  const filtered = () => D[state.table].filter(r => {
    const text = state.table === 'models' ? [r.name,r.maker,r.id,r.kind] : state.table === 'specs' ? [r.model_id,r.name,r.value,r.unit,r.source_id] : [r.id,r.family,r.confidence,r.driver_status];
    const filterValue = state.table === 'models' ? (r.kind || 'unclassified') : state.table === 'specs' ? (r.unit || 'unstated') : r.family;
    return text.join(' ').toLowerCase().includes(state.query.toLowerCase()) && (!state.filter || state.filter === filterValue);
  });
  function renderTable() {
    const rows = filtered();
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    state.page = Math.min(state.page, pages - 1);
    const start = state.page * pageSize;
    const headers = state.table === 'models' ? ['Equipment model','Manufacturer','Type','Evidence',''] : state.table === 'specs' ? ['Specification','Value','Unit','Evidence',''] : ['Protocol dialect','Family','Driver status','Evidence',''];
    $('table-head').innerHTML = `<tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr>`;
    const nameCell = (name,id) => `<td><button class="record-trigger" data-record="${esc(id)}">${esc(name)}<small>${esc(id)}</small></button></td>`;
    $('table-body').innerHTML = rows.slice(start, start + pageSize).map(r => {
      let cells;
      if (state.table === 'models') cells = `${nameCell(r.name,r.id)}<td>${esc(r.maker)}</td><td class="record-kind">${esc(kindLabel(r.kind))}</td><td>${modelStatus(r)}</td>`;
      else if (state.table === 'specs') cells = `${nameCell(r.name,r.id)}<td class="td-num">${esc(r.value)}</td><td class="td-num">${esc(r.unit || '—')}</td><td>${specStatus(r)}</td>`;
      else cells = `${nameCell(r.id.replaceAll('-',' '),r.id)}<td>${esc(familyLabel(r.family))}</td><td>${esc(r.driver_status)}</td><td>${badge(confidence[r.confidence] || r.confidence, r.confidence === 'vendor-doc' ? 'blue' : r.confidence === 'unverified' ? 'amber' : '')}</td>`;
      return `<tr>${cells}<td><button class="row-open" data-record="${esc(r.id)}" aria-label="Inspect ${esc(r.name || r.id)}">↗</button></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="empty">No sample records match. Try another search or filter.</td></tr>';
    $('result-count').textContent = `${rows.length ? `${start + 1}–${Math.min(start + pageSize, rows.length)}` : '0'} of ${rows.length} sample records · ${D.models.length} equipment examples in this draft`;
    if (state.table !== 'models') $('result-count').textContent = `${rows.length ? `${start + 1}–${Math.min(start + pageSize, rows.length)}` : '0'} of ${rows.length} sample records · local release`;
    $('page-count').textContent = `${state.page + 1} / ${pages}`;
    $('previous').disabled = state.page === 0;
    $('next').disabled = state.page >= pages - 1;
  }
  function setTable(table, filter = '') {
    state = { table, filter, page:0, query:'' };
    document.querySelectorAll('[data-table]').forEach(b => {
      b.setAttribute('aria-selected', String(b.dataset.table === table));
      b.tabIndex = b.dataset.table === table ? 0 : -1;
    });
    $('explorer-panel').setAttribute('aria-labelledby', `tab-${table}`);
    $('search').value = '';
    $('search').placeholder = table === 'models' ? 'Search equipment, makers, or model IDs…' : table === 'specs' ? 'Search specifications, values, or model IDs…' : 'Search dialects, families, or confidence…';
    const values = [...new Set(D[table].map(r => table === 'models' ? r.kind || 'unclassified' : table === 'specs' ? r.unit || 'unstated' : r.family))].sort();
    $('filter').innerHTML = `<option value="">${table === 'models' ? 'All equipment types' : table === 'specs' ? 'All units' : 'All families'}</option>` + values.map(v => `<option value="${esc(v)}">${esc(table === 'models' ? kindLabel(v) : table === 'dialects' ? familyLabel(v) : v)}</option>`).join('');
    $('filter').value = filter;
    renderTable();
  }
  document.querySelectorAll('[data-table]').forEach(b => b.addEventListener('click', () => setTable(b.dataset.table)));
  document.querySelectorAll('[data-explore]').forEach(a => a.addEventListener('click', () => setTable(a.dataset.explore)));
  $('search').addEventListener('input', e => { state.query = e.target.value; state.page = 0; renderTable(); });
  $('filter').addEventListener('change', e => { state.filter = e.target.value; state.page = 0; renderTable(); });
  $('previous').addEventListener('click', () => { state.page--; renderTable(); });
  $('next').addEventListener('click', () => { state.page++; renderTable(); });
  $('table-body').addEventListener('click', e => { const b = e.target.closest('[data-record]'); if (b) showRecord(D[state.table].find(r => r.id === b.dataset.record), state.table); });

  function sourceHtml(s) {
    const url = sourceLink(s.source);
    return `<div class="detail-meta">${specStatus(s)}${s.reviewed_by ? `<span>Reviewer: ${esc(s.reviewed_by)}</span>` : '<span>No human review recorded</span>'}${url ? `<a href="${esc(url)}${s.page ? `#page=${encodeURIComponent(s.page)}` : ''}" target="_blank" rel="noopener">Original source${s.page ? ` · page ${esc(s.page)}` : ''} ↗</a>` : '<span>Source URL unavailable</span>'}</div>`;
  }
  function specHtml(s) {
    return `<article class="detail-spec"><header><h3>${esc(s.english || s.name)}</h3><strong>${esc(s.value)} ${esc(s.unit)}</strong></header>${s.conditions ? `<p>Conditions: ${esc(s.conditions)}</p>` : '<p>Conditions: not separately recorded in this row.</p>'}${sourceHtml(s)}${s.doubt ? `<p class="amber-text">Doubt: ${esc(s.doubt)}</p>` : ''}<p>Source record: ${esc(s.source_id)}</p></article>`;
  }
  function openDetail(markup) { $('detail-content').innerHTML = markup; if (!$('detail-dialog').open) $('detail-dialog').showModal(); }
  function showRecord(r, table) {
    if (!r) return;
    let body = '';
    if (table === 'models') {
      body = `<p class="eyebrow">${esc(r.maker)}</p><h2 id="detail-title">${esc(r.name)}</h2><p class="detail-sub">${esc(r.id)}</p><div class="detail-notice">${r.reviewed_by ? `Reviewed by ${esc(r.reviewed_by)}.` : r.tier === 'feed' ? 'Imported from a public equipment library. Feed records retain their own licence and provenance.' : 'No human reviewer is recorded for this model. The raw tier name “reviewed” identifies the authored-record pipeline; it does not establish that a person checked this row.'}</div><dl class="detail-dl"><div><dt>Equipment type</dt><dd>${esc(kindLabel(r.kind))}</dd></div><div><dt>Specifications</dt><dd>${fmt(r.spec_count)} linked rows${r.spec_count > r.specs.length ? ` · showing ${r.specs.length} in this sample` : ''}</dd></div></dl>${r.specs.length ? r.specs.map(specHtml).join('') : '<p class="detail-notice">No specification rows are linked to this model in the local release. An empty value stays empty.</p>'}`;
    } else if (table === 'specs') {
      body = `<p class="eyebrow">SPECIFICATION</p><h2 id="detail-title">${esc(r.english || r.name)}</h2><p class="detail-sub">${esc(r.model_id)}</p>${specHtml(r)}<div class="detail-notice">This is the value recorded in the dataset. Consult the original document and its conditions before using it for equipment sizing.</div>`;
    } else {
      body = `<p class="eyebrow">${esc(familyLabel(r.family))}</p><h2 id="detail-title">${esc(r.id.replaceAll('-',' '))}</h2><p class="detail-sub">${esc(r.id)}</p><dl class="detail-dl"><div><dt>Confidence</dt><dd>${esc(confidence[r.confidence])}</dd></div><div><dt>Driver status</dt><dd>${esc(r.driver_status)}</dd></div><div><dt>Refuter</dt><dd>${esc(r.refuter)}</dd></div><div><dt>Transport</dt><dd>${esc(r.transport || 'Not recorded')}</dd></div><div><dt>Register / frame</dt><dd>${esc(r.blocks || 'Not recorded')}</dd></div></dl><div class="detail-notice">Catalogue families preserve the source organisation. A family label alone does not establish the wire protocol or equipment compatibility. Read the transport evidence.</div>${r.sources.filter(s => sourceLink(s)).map(s => `<p style="margin-top:12px;font-size:12px;overflow-wrap:anywhere"><a class="accent-text" href="${esc(sourceLink(s))}" target="_blank" rel="noopener">${esc(s.title || new URL(s.url).hostname)} ↗</a></p>`).join('')}`;
    }
    openDetail(body);
  }
  $('hero-record').addEventListener('click', () => showRecord(D.hero, 'specs'));
  $('inspect-evidence').addEventListener('click', () => showRecord(D.hero, 'specs'));
  document.querySelectorAll('.close-dialog').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', e => { if (e.target !== dialog) return; const box = dialog.getBoundingClientRect(); if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) dialog.close(); }));

  function renderCoverage(key = 'count') {
    const max = Math.max(...D.families.map(f => f.count));
    $('coverage-bars').innerHTML = D.families.map(f => `<div class="bar-row"><span>${esc(familyLabel(f.id))}</span><div class="bar-track"><div class="bar-fill" style="width:${f[key]/max*100}%"></div></div><span class="bar-count">${f[key]}</span></div>`).join('');
    $('chart-caption').textContent = key === 'count' ? `${D.counts.dialects} dialect entries across ${D.families.length} catalogue families.` : `${D.confidence['vendor-doc']} dialects cite vendor documents. Same scale as all entries.`;
    document.querySelectorAll('[data-coverage]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.coverage === key)));
  }
  $('vendor-count').innerHTML = `${D.confidence['vendor-doc']}<span>/ ${D.counts.dialects}</span>`;
  $('confidence-list').innerHTML = ['community-crosschecked','community-single','unverified'].map(k => `<div><span>${esc(confidence[k])}</span><strong>${D.confidence[k] || 0}</strong></div>`).join('');
  document.querySelectorAll('[data-coverage]').forEach(b => b.addEventListener('click', () => renderCoverage(b.dataset.coverage)));

  function openBuddy(prompt) {
    if (!$('buddy-dialog').open) $('buddy-dialog').showModal();
    if (!prompt) return;
    const replies = {
      battery: `<p>There are <strong>${fmt(D.kinds.battery)} models classified as batteries</strong> in this snapshot. The explorer has a few examples to get you started. A model’s presence doesn’t mean its specifications have been checked.</p><button class="button primary" data-buddy-action="battery">Explore battery examples ↗</button>`,
      source: `<p>The <strong>100 Ah</strong> value for Rolls S48-100LFP was extracted from a vendor document, with a reference to <strong>page ${esc(D.hero.page)}</strong>. No human reviewer is recorded. Let’s open the source trail together.</p><button class="button primary" data-buddy-action="source">Inspect this figure ↗</button>`,
      protocol: `<p>The catalogue has <strong>${D.families.find(f=>f.id==='ve-direct').count} VE.Direct entries</strong>. Each carries its own evidence and driver status. Let’s look at the examples before making any compatibility assumptions.</p><button class="button primary" data-buddy-action="protocol">Explore VE.Direct examples ↗</button>`
    };
    $('buddy-answer').innerHTML = replies[prompt];
  }
  document.querySelectorAll('.buddy-open').forEach(b => b.addEventListener('click', () => openBuddy()));
  document.querySelectorAll('[data-prompt]').forEach(b => b.addEventListener('click', () => openBuddy(b.dataset.prompt)));
  $('buddy-answer').addEventListener('click', e => {
    const action = e.target.closest('[data-buddy-action]')?.dataset.buddyAction;
    if (!action) return;
    $('buddy-dialog').close();
    if (action === 'source') showRecord(D.hero,'specs');
    else { setTable(action === 'battery' ? 'models':'dialects', action === 'battery' ? 'battery':'ve-direct'); $('explore').scrollIntoView(); }
  });

  const base = 'https://data.origin89.com/v1/';
  const snippets = {
    sql: `-- A specification, with its evidence attached.\nSELECT\n  model_id, name, value, unit,\n  source_id, page, confidence, reviewed_by\nFROM read_parquet(\n  '${base}specs.parquet'\n)\nWHERE unit = 'Ah'\nORDER BY model_id, name\nLIMIT 20;`,
    python: `# pip install pandas pyarrow\nimport pandas as pd\n\nspecs = pd.read_parquet(\n    '${base}specs.parquet'\n)\n\n# Keep the source and review status with the value.\nprint(specs.loc[specs.unit.eq('Ah'), [\n    'model_id', 'value', 'source_id', 'reviewed_by'\n]].head(20))`,
    curl: `# Inspect the published index and content hashes.\ncurl -H 'Accept: application/json' \\\n  'https://data.origin89.com/'\n\n# Download a table for your own application.\ncurl -O \\\n  '${base}models.parquet'\n\n# CSV is available for every published table.\ncurl -O '${base}specs.csv'`
  };
  let codeKey = 'sql';
  function renderCode(key) {
    codeKey = key;
    // Escape every segment before adding syntax spans; raw source is never HTML.
    $('code-text').innerHTML = snippets[key].split('\n').map(line => {
      if (line.trimStart().startsWith('--') || line.trimStart().startsWith('#')) return `<span class="syntax-comment">${esc(line)}</span>`;
      return line.split(/('(?:[^']*)')/g).map(part => part.startsWith("'") ? `<span class="syntax-string">${esc(part)}</span>` : esc(part).replace(/\b(SELECT|FROM|WHERE|ORDER BY|LIMIT|AS|import|as|print|curl)\b/g,'<span class="syntax-key">$1</span>')).join('');
    }).join('\n');
    document.querySelectorAll('[data-code]').forEach(b => { b.setAttribute('aria-selected', String(b.dataset.code === key)); b.tabIndex = b.dataset.code === key ? 0 : -1; });
    $('code-content').setAttribute('aria-labelledby', `code-${key}`);
  }
  document.querySelectorAll('[data-code]').forEach(b => b.addEventListener('click', () => renderCode(b.dataset.code)));
  let toastTimer;
  function toast(message) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3000); }
  $('copy-code').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(snippets[codeKey]); toast('Code copied. Ready for your own tools.'); }
    catch { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents($('code-text')); selection.removeAllRanges(); selection.addRange(range); toast('Code selected. Press ⌘C or Ctrl+C to copy.'); }
  });
  $('export').addEventListener('click', () => {
    const rows = filtered().map(row => { const {specs,source,sources,...flat} = row; return flat; });
    if (!rows.length) { toast('No matching sample records to export.'); return; }
    const keys = Object.keys(rows[0]);
    const csvCell = v => '"' + String(v ?? '').replaceAll('"','""') + '"';
    const csv = [keys.map(csvCell).join(','), ...rows.map(row => keys.map(key => csvCell(row[key])).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
    const a = document.createElement('a'); a.href = url; a.download = `origin89-${state.table}-sample-${D.snapshot}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    toast(`Exported ${rows.length} sample records.`);
  });
  $('view-manifest').addEventListener('click', () => openDetail(`<p class="eyebrow">LOCAL RELEASE / ${D.snapshot}</p><h2 id="detail-title">Dataset index</h2><p class="detail-notice">Row counts, byte sizes, and SHA-256 hashes from the local build. These describe the design snapshot; the published index may differ.</p><pre>${esc(JSON.stringify(D.manifest,null,2))}</pre>`));
  document.querySelector('.menu-toggle').addEventListener('click', e => { const b = e.currentTarget; const open = b.getAttribute('aria-expanded') !== 'true'; b.setAttribute('aria-expanded', String(open)); b.setAttribute('aria-label', open ? 'Close menu' : 'Open menu'); $('navigation').classList.toggle('is-open',open); });
  $('navigation').addEventListener('click', e => { if (e.target.closest('a')) { $('navigation').classList.remove('is-open'); document.querySelector('.menu-toggle').setAttribute('aria-expanded','false'); document.querySelector('.menu-toggle').setAttribute('aria-label','Open menu'); } });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')) { e.preventDefault(); $('explore').scrollIntoView(); $('search').focus({preventScroll:true}); }
  });
  document.querySelectorAll('[role="tablist"]').forEach(list => list.addEventListener('keydown', e => {
    const tabs = [...list.querySelectorAll('[role="tab"]')]; const index = tabs.indexOf(document.activeElement);
    if (index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click(); tabs[next].focus();
  }));
  setTable('models'); renderCoverage(); renderCode('sql');
})();
