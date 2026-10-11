// Run: node test/analysis.test.mjs
import { analyzeNight, classifyEvents, formatDuration } from '../js/analysis.js';
import assert from 'node:assert';

let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function synthNight(mode = 'bed', minutes = 480) {
  const start = Date.UTC(2026, 9, 10, 22, 30);
  const epochs = [], events = [];
  for (let i = 0; i < minutes; i++) {
    const t = start + i * 60000;
    let bursts = 0, moveSec = 0, twitches = 0;
    const falling = i < 18, ending = i > minutes - 12, cycleEdge = i > 20 && (i - 20) % 92 < 3, midWake = i >= 300 && i < 305;
    if (falling || ending || midWake) { bursts = 2 + Math.floor(rnd() * 3); moveSec = 5 + rnd() * 10; }
    else if (cycleEdge) { bursts = 1; moveSec = 2 + rnd() * 2; }
    else if (rnd() < 0.04) { bursts = 1; moveSec = 0.5; twitches = 1; }
    epochs.push({ t, db: -60, peak: -50, floor: -62, events: 0, moveSec, bursts, twitches, hasMotion: mode === 'bed' });
    if (falling && rnd() < 0.5) events.push({ id: 'r' + i, t: t + 10000, dur: 1, peak: -40, aboveFloor: 20, rawKind: 'rustle' });
    if (i > 40 && i < 70) for (let s = 0; s < 60; s += 4) events.push({ id: `s${i}-${s}`, t: t + s * 1000, dur: 1.2, peak: -45, aboveFloor: 15, rawKind: 'snore' });
  }
  events.push({ id: 'lone', t: start + 200 * 60000, dur: 1, peak: -45, aboveFloor: 15, rawKind: 'snore' });
  return { id: start, start, end: start + minutes * 60000, mode, epochs, events };
}

const a = analyzeNight(synthNight());
console.log('score', a.score, 'asleep', formatDuration(a.minutesAsleep), 'latency', a.latency, 'wakeUps', a.wakeUps, 'cycles', a.cycles);
for (const k of ['deep', 'light', 'rem', 'awake']) console.log(k.padEnd(6), formatDuration(a.totals[k]).padStart(7), `${a.counts[k]} periods`);
console.log(a.segments.map(s => `${s.stage[0]}${s.minutes}`).join(' '));
assert(a.latency >= 15 && a.latency <= 25, 'falls asleep after ~18 min');
assert(a.wakeUps >= 1, 'detects the 5 minute wake at 3am');
assert(a.totals.deep > 30 && a.totals.rem > 20, 'has deep and REM');
const firstDeep = a.segments.find(s => s.stage === 'deep'), firstRem = a.segments.find(s => s.stage === 'rem');
assert(firstDeep.startIdx < firstRem.startIdx, 'deep comes before REM');
const ev = classifyEvents(synthNight().events);
assert.equal(ev.find(e => e.id === 'lone').kind, 'noise', 'lone low sound is not snoring');
assert.equal(ev.find(e => e.id === 's50-20').kind, 'snore', 'rhythmic sounds are snoring');
assert(a.snoring.length >= 1);

const b = analyzeNight(synthNight('nightstand'));
console.log('nightstand: confidence', b.confidence, 'asleep', formatDuration(b.minutesAsleep), 'deep', b.totals.deep, 'rem', b.totals.rem);
assert.equal(b.confidence, 'low');
assert(analyzeNight({ ...synthNight(), epochs: synthNight().epochs.slice(0, 10) }).tooShort);
console.log('all tests passed');
