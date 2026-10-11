// Sleep analysis: turns one night's per-minute data into estimated sleep stages.
// Pure functions only (no browser APIs) so they can be tested in Node.
//
// This is an ESTIMATE. Real sleep staging needs brain waves (EEG). Like Sleep Cycle,
// we infer stages from how much you move and what sounds you make, plus what is
// known about normal sleep: ~90 minute cycles, more deep sleep early in the night,
// more dream (REM) sleep late in the night.

export const STAGES = ['awake', 'rem', 'light', 'deep'];
export const STAGE_LABEL = { awake: 'Awake', rem: 'Dream (REM)', light: 'Light', deep: 'Deep' };

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const gauss = (x, mu, sd) => Math.exp(-0.5 * ((x - mu) / sd) ** 2);

function smooth(values, sigma) {
  const r = Math.ceil(sigma * 2.5);
  const out = new Array(values.length).fill(0);
  for (let i = 0; i < values.length; i++) {
    let sum = 0, wsum = 0;
    for (let j = -r; j <= r; j++) {
      const k = i + j;
      if (k < 0 || k >= values.length) continue;
      const w = gauss(j, 0, sigma);
      sum += w * values[k];
      wsum += w;
    }
    out[i] = wsum ? sum / wsum : 0;
  }
  return out;
}

// --- Sound events ---------------------------------------------------------

// Raw events come from the recorder with a provisional kind. Snores are only
// believable when several low-pitched sounds repeat every few seconds, so we
// relabel here using the whole night.
export function classifyEvents(events) {
  const evs = events.map(e => ({ ...e }));
  const cands = evs.filter(e => e.rawKind === 'snore');
  for (const e of cands) {
    const neighbours = cands.filter(o => o !== e && Math.abs(o.t - e.t) <= 30000);
    const gaps = neighbours.map(o => Math.abs(o.t - e.t) / 1000);
    const rhythmic = gaps.filter(g => g >= 2 && g <= 12).length;
    e.kind = rhythmic >= 2 ? 'snore' : 'noise';
  }
  for (const e of evs) if (e.rawKind !== 'snore') e.kind = e.rawKind;
  return evs;
}

// Groups consecutive snore events (gap < 60 s) into snoring episodes for display.
export function snoreEpisodes(events) {
  const sn = events.filter(e => e.kind === 'snore').sort((a, b) => a.t - b.t);
  const eps = [];
  for (const e of sn) {
    const last = eps[eps.length - 1];
    if (last && e.t - last.end < 60000) {
      last.end = e.t + e.dur * 1000;
      last.count++;
      last.events.push(e);
    } else {
      eps.push({ start: e.t, end: e.t + e.dur * 1000, count: 1, events: [e] });
    }
  }
  return eps;
}

// --- Activity per minute ------------------------------------------------

export function epochActivity(epoch, events, useMotion) {
  // Sound: non-snore sounds in this minute (rustling, talking, coughing...)
  const inEpoch = events.filter(e => e.t >= epoch.t && e.t < epoch.t + 60000);
  const restless = inEpoch.filter(e => e.kind !== 'snore');
  const loudSec = restless.reduce((s, e) => s + Math.min(e.dur, 20), 0);
  const aSound = clamp(restless.length * 0.35 + loudSec / 20, 0, 2);
  if (!useMotion) return { activity: aSound, sound: aSound, motion: 0 };
  const aMotion = clamp((epoch.bursts || 0) * 0.3 + (epoch.moveSec || 0) / 15, 0, 2);
  return { activity: 0.7 * aMotion + 0.3 * aSound, sound: aSound, motion: aMotion };
}

// --- Cycle detection ----------------------------------------------------

// Sleep cycles usually end with a brief arousal (you shift position). We look for
// the biggest activity peak 70-110 minutes into each cycle; if there is none we
// assume a 90 minute cycle.
function findCycles(act, onset, end) {
  const bounds = [onset];
  let cur = onset;
  while (cur + 60 < end) {
    let best = -1, bestVal = 0.15;
    for (let i = cur + 70; i <= Math.min(cur + 110, end - 1); i++) {
      if (act[i] > bestVal) { bestVal = act[i]; best = i; }
    }
    const next = best >= 0 ? best : cur + 90;
    if (next >= end) break;
    bounds.push(next);
    cur = next;
  }
  bounds.push(end);
  return bounds;
}

// --- Main analysis -----------------------------------------------------------

export function analyzeNight(night) {
  const epochs = night.epochs || [];
  const n = epochs.length;
  const events = classifyEvents(night.events || []);
  const empty = {
    events, stages: [], segments: [], totals: { awake: 0, rem: 0, light: 0, deep: 0 },
    counts: { awake: 0, rem: 0, light: 0, deep: 0 }, minutesInBed: n, minutesAsleep: 0,
    latency: 0, efficiency: 0, wakeUps: 0, score: 0, confidence: 'none', snoring: snoreEpisodes(events),
    onset: null, wake: null,
  };
  if (n < 20) return { ...empty, tooShort: true };

  const useMotion = night.mode === 'bed' && epochs.some(e => e.hasMotion);
  const act = epochs.map(e => epochActivity(e, events, useMotion));
  const raw = act.map(a => a.activity);
  const s = smooth(raw, 2);

  // Sleep onset: first 10 calm minutes in a row. Final wake: end of last calm run.
  const CALM = 0.25;
  let onset = -1;
  for (let i = 0; i + 10 <= n; i++) {
    let ok = true;
    for (let j = i; j < i + 10; j++) if (s[j] >= CALM) { ok = false; break; }
    if (ok) { onset = i; break; }
  }
  if (onset < 0) return { ...empty, events, noSleep: true, confidence: useMotion ? 'medium' : 'low' };
  let wake = n;
  for (let i = n - 1; i >= onset; i--) {
    if (s[i] < CALM) { wake = i + 1; break; }
  }
  // Only call it a final wake if you were active for 5+ minutes at the end.
  if (n - wake < 5) wake = n;

  const stage = new Array(n).fill('light');
  for (let i = 0; i < n; i++) if (i < onset || i >= wake) stage[i] = 'awake';

  // Awakenings during the night: 2+ minutes of clear activity.
  for (let i = onset; i < wake; i++) {
    if (s[i] > 0.6 || raw[i] > 1.2) {
      let j = i;
      while (j < wake && (s[j] > 0.45 || raw[j] > 1.2)) j++;
      if (j - i >= 2) for (let k = i; k < j; k++) stage[k] = 'awake';
      i = j;
    }
  }

  // Stillness now (q) and sustained stillness over ~20 minutes (L).
  const q = s.map(v => 1 - clamp(v / 0.5, 0, 1));
  const L = smooth(q, 6);
  const snoreSec = epochs.map(e => events
    .filter(ev => ev.kind === 'snore' && ev.t >= e.t && ev.t < e.t + 60000)
    .reduce((a, ev) => a + ev.dur, 0));
  const twitch = epochs.map(e => clamp((e.twitches || 0) / 3, 0, 1));

  const bounds = findCycles(raw, onset, wake);
  const D = new Array(n).fill(0), R = new Array(n).fill(0);
  for (let c = 0; c < bounds.length - 1; c++) {
    const a = bounds[c], b = bounds[c + 1], len = Math.max(1, b - a);
    for (let i = a; i < b; i++) {
      if (stage[i] === 'awake') continue;
      const r = (i - a) / len;
      const deepPrior = gauss(r, 0.38, 0.17) * Math.max(0.15, 1 - 0.28 * c);
      const remPrior = gauss(r, 0.86, 0.11) * Math.min(1.1, 0.45 + 0.22 * c);
      D[i] = L[i] * q[i] * deepPrior;
      R[i] = q[i] * (1 - 0.5 * clamp(snoreSec[i] / 30, 0, 1)) * (0.75 + 0.25 * twitch[i]) * remPrior;
    }
  }
  for (let i = onset; i < wake; i++) {
    if (stage[i] === 'awake') continue;
    const minsAsleep = i - onset;
    if (D[i] > 0.35 && D[i] >= R[i]) stage[i] = 'deep';
    else if (R[i] > 0.3 && minsAsleep >= 45) stage[i] = 'rem';
  }

  mergeShortRuns(stage, onset, wake, 3);

  const segments = toSegments(stage, epochs);
  const totals = { awake: 0, rem: 0, light: 0, deep: 0 };
  const counts = { awake: 0, rem: 0, light: 0, deep: 0 };
  for (const st of stage) totals[st]++;
  for (const seg of segments) counts[seg.stage]++;
  const midWake = segments.filter(g => g.stage === 'awake' && g.startIdx > onset && g.endIdx < wake).length;
  const minutesAsleep = totals.light + totals.deep + totals.rem;
  const efficiency = minutesAsleep / n;
  const deepPct = minutesAsleep ? totals.deep / minutesAsleep : 0;
  const score = Math.round(100 * clamp(
    0.5 * Math.min(1, minutesAsleep / 480) +
    0.25 * efficiency +
    0.15 * (1 - Math.min(1, midWake / 6)) +
    0.10 * Math.min(1, deepPct / 0.2), 0, 1));

  return {
    events, stages: stage, segments, totals, counts,
    minutesInBed: n, minutesAsleep, latency: onset, efficiency,
    wakeUps: midWake, score, onset, wake, cycles: bounds.length - 1,
    confidence: useMotion ? 'medium' : 'low',
    snoring: snoreEpisodes(events),
    activity: s,
  };
}

// Runs shorter than minLen minutes are absorbed into the longer neighbour.
function mergeShortRuns(stage, from, to, minLen) {
  for (let pass = 0; pass < 3; pass++) {
    let i = from;
    while (i < to) {
      let j = i;
      while (j < to && stage[j] === stage[i]) j++;
      if (j - i < minLen && stage[i] !== 'awake') {
        const left = i > from ? stage[i - 1] : null;
        const right = j < to ? stage[j] : null;
        let fill = left || right;
        if (left && right && left !== right) {
          let li = i - 1; while (li > from && stage[li - 1] === left) li--;
          let rj = j; while (rj < to - 1 && stage[rj + 1] === right) rj++;
          fill = (i - li) >= (rj - j + 1) ? left : right;
        }
        if (fill === 'awake') fill = left && left !== 'awake' ? left : (right && right !== 'awake' ? right : 'light');
        if (fill) for (let k = i; k < j; k++) stage[k] = fill;
      }
      i = j;
    }
  }
}

function toSegments(stage, epochs) {
  const segs = [];
  let i = 0;
  while (i < stage.length) {
    let j = i;
    while (j < stage.length && stage[j] === stage[i]) j++;
    segs.push({
      stage: stage[i], startIdx: i, endIdx: j,
      start: epochs[i].t, end: epochs[j - 1].t + 60000, minutes: j - i,
    });
    i = j;
  }
  return segs;
}

export function formatDuration(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
