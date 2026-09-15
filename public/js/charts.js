/*
 * Inline SVG charts - no chart library.
 * Palette: validated categorical slots (blue, orange, aqua, yellow, magenta,
 * green, violet) in fixed order, never cycled; the 8th and beyond fold into
 * "Other". Three slots sit under 3:1 on a white surface, so every chart here
 * ships visible direct labels plus a table view of the same numbers.
 */
(function () {
  'use strict';

  const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7'];
  const OTHER = '#64748b';
  const INK = '#0f172a';
  const INK_2 = '#64748b';
  const GRID = '#e2e8f0';
  const SURFACE = '#ffffff';

  const esc = (s) => window.ui.esc(s);
  const uid = () => `c${Math.random().toString(36).slice(2, 9)}`;

  /** Fold a long category list into the first n slots plus "Other". */
  function foldSeries(rows, max = 6) {
    if (rows.length <= max + 1) return rows.map((r, i) => ({ ...r, color: SERIES[i] || OTHER }));
    const head = rows.slice(0, max).map((r, i) => ({ ...r, color: SERIES[i] }));
    const rest = rows.slice(max);
    const tail = rest.reduce((acc, r) => ({
      label: 'Other', value: acc.value + r.value, units: (acc.units || 0) + (r.units || 0), color: OTHER,
    }), { label: 'Other', value: 0, units: 0, color: OTHER });
    tail.count = rest.length;
    return [...head, tail];
  }

  const niceMax = (max) => {
    if (max <= 0) return 1;
    const mag = 10 ** Math.floor(Math.log10(max));
    return Math.ceil(max / mag * 2) / 2 * mag;
  };

  /**
   * Time-series line chart with a hover crosshair and tooltip.
   * points: [{label, value, sub}]
   */
  function lineChart(container, points, options = {}) {
    const w = 720;
    const h = options.height || 240;
    const pad = { t: 14, r: 16, b: 28, l: 58 };
    const id = uid();

    if (!points.length) {
      container.innerHTML = '<div class="empty">No sales in this period.</div>';
      return;
    }

    const max = niceMax(Math.max(...points.map((p) => p.value)));
    const innerW = w - pad.l - pad.r;
    const innerH = h - pad.t - pad.b;
    const x = (i) => pad.l + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const y = (v) => pad.t + innerH - (v / max) * innerH;

    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const area = `${line} L${x(points.length - 1).toFixed(1)},${pad.t + innerH} L${x(0).toFixed(1)},${pad.t + innerH} Z`;

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const value = max * f;
      return `<g><line x1="${pad.l}" x2="${w - pad.r}" y1="${y(value)}" y2="${y(value)}" stroke="${GRID}" stroke-width="1"/>
        <text x="${pad.l - 8}" y="${y(value) + 4}" text-anchor="end" font-size="10" fill="${INK_2}">${window.ui.moneyShort(value)}</text></g>`;
    }).join('');

    // Label every point when there is room, otherwise thin them out.
    const step = Math.ceil(points.length / 8);
    const labels = points.map((p, i) => (i % step === 0 || i === points.length - 1
      ? `<text x="${x(i)}" y="${h - 8}" text-anchor="middle" font-size="10" fill="${INK_2}">${esc(p.label)}</text>` : '')).join('');

    const dots = points.map((p, i) => `
      <circle cx="${x(i)}" cy="${y(p.value)}" r="4" fill="${SERIES[0]}" stroke="${SURFACE}" stroke-width="2"/>`).join('');

    const hotspots = points.map((p, i) => `
      <rect class="hot" data-i="${i}" x="${x(i) - innerW / (points.length * 2) - 4}" y="${pad.t}"
        width="${Math.max(innerW / points.length, 14)}" height="${innerH}" fill="transparent"/>`).join('');

    container.innerHTML = `
      <div class="chart" id="${id}" style="position:relative">
        <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="${esc(options.title || 'Sales trend')}">
          <defs>
            <linearGradient id="${id}-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stop-color="${SERIES[0]}" stop-opacity="0.18"/>
              <stop offset="100%" stop-color="${SERIES[0]}" stop-opacity="0"/>
            </linearGradient>
          </defs>
          ${ticks}
          <path d="${area}" fill="url(#${id}-fill)"/>
          <path d="${line}" fill="none" stroke="${SERIES[0]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
          ${dots}
          <line class="crosshair" y1="${pad.t}" y2="${pad.t + innerH}" stroke="${INK_2}" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>
          ${labels}
          ${hotspots}
        </svg>
        <div class="chart-tip" hidden></div>
      </div>`;

    const root = container.querySelector(`#${id}`);
    const tip = root.querySelector('.chart-tip');
    const crosshair = root.querySelector('.crosshair');
    Object.assign(tip.style, {
      position: 'absolute', background: INK, color: '#fff', padding: '6px 9px', borderRadius: '7px',
      fontSize: '12px', pointerEvents: 'none', whiteSpace: 'nowrap', transform: 'translate(-50%, -115%)', zIndex: 5,
    });

    root.querySelectorAll('.hot').forEach((el) => {
      el.addEventListener('mouseenter', () => {
        const p = points[Number(el.dataset.i)];
        const px = (x(Number(el.dataset.i)) / w) * root.clientWidth;
        const py = (y(p.value) / h) * root.querySelector('svg').clientHeight;
        tip.innerHTML = `<strong>${esc(p.label)}</strong><br>${window.ui.money(p.value)}${p.sub ? `<br>${esc(p.sub)}` : ''}`;
        tip.hidden = false;
        tip.style.left = `${px}px`;
        tip.style.top = `${py}px`;
        crosshair.setAttribute('x1', x(Number(el.dataset.i)));
        crosshair.setAttribute('x2', x(Number(el.dataset.i)));
        crosshair.setAttribute('opacity', '1');
      });
      el.addEventListener('mouseleave', () => { tip.hidden = true; crosshair.setAttribute('opacity', '0'); });
    });
  }

  /** Donut of category share, with a legend that direct-labels every slice. */
  function donut(container, rows, options = {}) {
    const data = foldSeries(rows.filter((r) => r.value > 0));
    if (!data.length) {
      container.innerHTML = '<div class="empty">No sales in this period.</div>';
      return;
    }
    const total = data.reduce((s, r) => s + r.value, 0);
    const size = 190;
    const cx = size / 2;
    const cy = size / 2;
    const r = 78;
    const inner = 48;
    const gap = 0.012; // ~2px surface gap between segments

    let angle = -Math.PI / 2;
    const arcs = data.map((row) => {
      const share = row.value / total;
      const sweep = share * Math.PI * 2;
      const a0 = angle + (data.length > 1 ? gap : 0);
      const a1 = angle + sweep - (data.length > 1 ? gap : 0);
      angle += sweep;
      const large = sweep > Math.PI ? 1 : 0;
      const p = (rad, radius) => `${(cx + Math.cos(rad) * radius).toFixed(2)},${(cy + Math.sin(rad) * radius).toFixed(2)}`;
      const d = `M${p(a0, r)} A${r},${r} 0 ${large} 1 ${p(a1, r)} L${p(a1, inner)} A${inner},${inner} 0 ${large} 0 ${p(a0, inner)} Z`;
      return `<path d="${d}" fill="${row.color}" stroke="${SURFACE}" stroke-width="2"><title>${esc(row.label)}: ${window.ui.money(row.value)}</title></path>`;
    }).join('');

    const legend = data.map((row) => `
      <div class="bar-row">
        <span class="name"><span class="dot" style="background:${row.color}"></span>${esc(row.label)}${row.count ? ` (${row.count})` : ''}</span>
        <span class="grow small muted">${Math.round((row.value / total) * 100)}%</span>
        <span class="val">${window.ui.money(row.value)}</span>
      </div>`).join('');

    container.innerHTML = `
      <div class="cols-2 grid" style="align-items:center">
        <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img"
             aria-label="${esc(options.title || 'Share by category')}" style="margin:0 auto">
          ${arcs}
          <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="11" fill="${INK_2}">Total</text>
          <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="14" font-weight="650" fill="${INK}">${window.ui.moneyShort(total)}</text>
        </svg>
        <div>${legend}</div>
      </div>`;
  }

  /**
   * Horizontal bars for a single measure (top products, stock value by
   * category). One hue; every bar is direct-labelled with its value.
   */
  function bars(container, rows, options = {}) {
    if (!rows.length) {
      container.innerHTML = `<div class="empty">${esc(options.empty || 'Nothing to show yet.')}</div>`;
      return;
    }
    const max = Math.max(...rows.map((r) => r.value)) || 1;
    container.innerHTML = rows.map((row) => `
      <div class="bar-row" title="${esc(row.label)}: ${esc(row.display || row.value)}">
        <span class="name">${esc(row.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max((row.value / max) * 100, 2)}%;background:${row.color || SERIES[0]}"></span></span>
        <span class="val">${esc(row.display !== undefined ? row.display : window.ui.qty(row.value))}</span>
      </div>`).join('');
  }

  window.charts = { lineChart, donut, bars, SERIES, foldSeries };
})();
