// Small SVG chart helpers. Colours come from CSS variables in styles.css.

import { STAGE_LABEL } from './analysis.js';

const ROWS = ['awake', 'rem', 'light', 'deep'];
const fmtHour = t => new Date(t).toLocaleTimeString([], { hour: 'numeric' }).replace(/\s?[AP]M/i, m => m.trim().toLowerCase());

function hourTicks(start, end, x) {
  const out = [];
  const d = new Date(start); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1);
  const span = (end - start) / 3600000;
  const step = span > 9 ? 2 : 1;
  for (let t = d.getTime(); t < end; t += step * 3600000) out.push({ t, x: x(t), label: fmtHour(t) });
  return out;
}

export function hypnogram(analysis, epochs, W = 340, H = 170) {
  if (!analysis.segments.length) return '';
  const padL = 64, padR = 8, padT = 6, padB = 22;
  const start = epochs[0].t, end = epochs[epochs.length - 1].t + 60000;
  const x = t => padL + (t - start) / (end - start) * (W - padL - padR);
  const rowH = (H - padT - padB) / ROWS.length;
  const y = st => padT + ROWS.indexOf(st) * rowH;
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Sleep stages through the night">`;
  ROWS.forEach((st, i) => {
    svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(st) + rowH}" y2="${y(st) + rowH}" class="grid"/>`;
    svg += `<text x="${padL - 6}" y="${y(st) + rowH / 2 + 4}" text-anchor="end" class="axis">${STAGE_LABEL[st].replace(' (REM)', '')}</text>`;
  });
  for (const s of analysis.segments) {
    const x0 = x(s.start), x1 = x(s.end);
    svg += `<rect x="${x0.toFixed(1)}" y="${(y(s.stage) + 2).toFixed(1)}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${(rowH - 4).toFixed(1)}" rx="2" class="st-${s.stage}"><title>${STAGE_LABEL[s.stage]} ${s.minutes} min</title></rect>`;
  }
  for (const tk of hourTicks(start, end, x)) {
    svg += `<text x="${tk.x}" y="${H - 6}" text-anchor="middle" class="axis">${tk.label}</text>`;
  }
  return svg + '</svg>';
}

export function soundTimeline(epochs, events, W = 340, H = 110) {
  if (!epochs.length) return '';
  const padL = 8, padR = 8, padT = 14, padB = 22;
  const start = epochs[0].t, end = epochs[epochs.length - 1].t + 60000;
  const x = t => padL + (t - start) / (end - start) * (W - padL - padR);
  const maxAbove = 40;
  const h = v => Math.max(0, Math.min(1, v / maxAbove)) * (H - padT - padB);
  const bw = Math.max(0.6, (W - padL - padR) / epochs.length);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Sound level through the night">`;
  for (const e of epochs) {
    const v = (e.peak ?? e.floor) - (e.floor ?? -70);
    const hh = h(v);
    svg += `<rect x="${x(e.t).toFixed(1)}" y="${(H - padB - hh).toFixed(1)}" width="${bw.toFixed(2)}" height="${hh.toFixed(1)}" class="lvl"/>`;
  }
  for (const ev of events) {
    svg += `<circle cx="${x(ev.t).toFixed(1)}" cy="${padT - 6}" r="3" class="ev-${ev.kind}" data-ev="${ev.id}"><title>${ev.kind}</title></circle>`;
  }
  for (const tk of hourTicks(start, end, x)) {
    svg += `<text x="${tk.x}" y="${H - 6}" text-anchor="middle" class="axis">${tk.label}</text>`;
  }
  return svg + '</svg>';
}

export function stageBar(totals) {
  const sum = ROWS.reduce((s, k) => s + (totals[k] || 0), 0) || 1;
  return `<div class="stagebar">${ROWS.map(k => `<span class="st-${k}" style="width:${(100 * (totals[k] || 0) / sum).toFixed(1)}%"></span>`).join('')}</div>`;
}

export function scoreRing(score, size = 132) {
  const r = size / 2 - 9, c = 2 * Math.PI * r, off = c * (1 - score / 100);
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="ring" role="img" aria-label="Sleep quality ${score} percent">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-bg"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-fg" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="50%" dy="0.1em" text-anchor="middle" class="ring-num">${score}%</text>
    <text x="50%" y="50%" dy="1.9em" text-anchor="middle" class="ring-lbl">quality</text>
  </svg>`;
}

export function trendChart(nights, W = 340, H = 120) {
  // nights: oldest first, each {id, a: analysis}
  if (nights.length < 2) return '';
  const padL = 28, padR = 8, padT = 8, padB = 20;
  const max = Math.max(60, ...nights.map(n => n.a.minutesAsleep));
  const bw = (W - padL - padR) / nights.length;
  const y = m => H - padB - m / max * (H - padT - padB);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Time in each stage per night">`;
  for (let hTick = 2; hTick * 60 <= max; hTick += 2) {
    svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(hTick * 60)}" y2="${y(hTick * 60)}" class="grid"/><text x="${padL - 4}" y="${y(hTick * 60) + 4}" text-anchor="end" class="axis">${hTick}h</text>`;
  }
  nights.forEach((n, i) => {
    let base = 0;
    for (const k of ['deep', 'light', 'rem']) {
      const v = n.a.totals[k];
      svg += `<rect x="${(padL + i * bw + bw * 0.15).toFixed(1)}" y="${y(base + v).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${(y(base) - y(base + v)).toFixed(1)}" class="st-${k}"/>`;
      base += v;
    }
    if (nights.length <= 14 || i % 2 === 0) {
      const d = new Date(n.id);
      svg += `<text x="${(padL + i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="axis">${d.getDate()}/${d.getMonth() + 1}</text>`;
    }
  });
  return svg + '</svg>';
}
