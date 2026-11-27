/*
 * The printer dashboard: one card per printer with its state and levels.
 * Shared by the settings screen (in the Homebridge UI) and the plugin's own
 * dashboard page (the dashboardPort setting). Plain browser script, no build.
 *
 * PrinterDashboard.render(element, printers), where each printer is
 *   { name, host, online, updated, error, result }
 * and result is what the settings screen's connection test returns.
 */
(function () {
  'use strict';

  const CSS = `
    .pd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: .75rem; }
    .pd-card { border: 1px solid rgba(128,128,128,.35); border-radius: .5rem; padding: .75rem .85rem; }
    .pd-head { display: flex; justify-content: space-between; align-items: baseline; gap: .5rem; }
    .pd-name { font-weight: 600; }
    .pd-state { font-size: .8rem; white-space: nowrap; }
    .pd-dot { display: inline-block; width: .55rem; height: .55rem; border-radius: 50%; margin-right: .3rem; background: #888; }
    .pd-ok .pd-dot { background: #3aa870; }
    .pd-printing .pd-dot { background: #2f80ed; }
    .pd-problem .pd-dot { background: #e5484d; }
    .pd-offline .pd-dot { background: #888; }
    .pd-muted { opacity: .7; font-size: .8rem; }
    .pd-status { margin: .25rem 0 .5rem; font-size: .9rem; }
    .pd-bar { display: grid; grid-template-columns: 5.5rem 1fr 2.6rem; align-items: center; gap: .4rem; font-size: .8rem; margin: .2rem 0; }
    .pd-track { display: block; height: .5rem; border-radius: .25rem; background: rgba(128,128,128,.25); overflow: hidden; }
    .pd-fill { display: block; height: 100%; border-radius: .25rem; }
    .pd-pct { text-align: right; font-variant-numeric: tabular-nums; }
    .pd-rows { margin-top: .5rem; font-size: .8rem; }
    .pd-rows div { margin: .1rem 0; }
  `;
  const COLORS = {
    black: '#555', photoBlack: '#555', gray: '#999', cyan: '#00a6d6', lightCyan: '#6fd3f0', magenta: '#d6007e',
    lightMagenta: '#f07dbd', yellow: '#e6b800', tricolor: 'linear-gradient(90deg,#00a6d6,#d6007e,#e6b800)', drum: '#8a7f72',
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function ago(ms) {
    if (!ms) { return ''; }
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) { return 'just now'; }
    if (s < 5400) { return `${Math.round(s / 60)} min ago`; }
    return `${Math.round(s / 3600)} h ago`;
  }

  function card(p) {
    const r = p.result;
    const state = p.online === false || !r ? 'offline' : r.problem ? 'problem' : r.printing ? 'printing' : 'ok';
    const label = { offline: p.error ? 'Not reachable' : 'Offline', problem: 'Problem', printing: 'Printing', ok: 'Ready' }[state];
    const bars = (r && r.bars) || [];
    const rows = r ? [
      r.pages !== null && r.pages !== undefined
        ? `Pages printed: ${Number(r.pages).toLocaleString('en-US')}${r.pageDetail ? ` (${r.pageDetail})` : ''}` : '',
      r.usage ? `Recently: ${r.usage}` : '',
      r.left || '',
      r.paper ? `Paper: ${r.paper}` : '',
    ].filter(Boolean) : [];
    return `<div class="pd-card pd-${state}">
      <div class="pd-head"><span class="pd-name">${esc(p.name)}</span>
        <span class="pd-state"><span class="pd-dot"></span>${label}</span></div>
      <div class="pd-muted">${esc(r && r.model ? r.model : '')}${r && r.model ? ' · ' : ''}${esc(p.host)}</div>
      ${r ? `<div class="pd-status">${esc(r.status)}</div>` : `<div class="pd-status">${esc(p.error || 'No reading yet')}</div>`}
      ${bars.map((b) => `<div class="pd-bar"><span>${esc(b.label)}</span>
        <span class="pd-track"><span class="pd-fill" style="width:${Math.max(0, Math.min(100, b.percent))}%;background:${COLORS[b.color] || '#888'}"></span></span>
        <span class="pd-pct">${esc(b.percent)}%</span></div>`).join('')}
      ${rows.length ? `<div class="pd-rows">${rows.map((x) => `<div>${esc(x)}</div>`).join('')}</div>` : ''}
      ${p.updated ? `<div class="pd-muted mt-1" style="margin-top:.4rem">Updated ${ago(p.updated)}${r ? ` · ${esc(r.via)}` : ''}</div>` : ''}
    </div>`;
  }

  function render(element, printers) {
    const document = globalThis.document;
    if (!document.getElementById('pd-style')) {
      const style = document.createElement('style');
      style.id = 'pd-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    element.innerHTML = printers.length
      ? `<div class="pd-grid">${printers.map(card).join('')}</div>`
      : '<p class="pd-muted">No printers set up yet.</p>';
  }

  globalThis.PrinterDashboard = { render };
})();
