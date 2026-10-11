import { SleepRecorder } from './recorder.js';
import { analyzeNight, formatDuration, STAGE_LABEL } from './analysis.js';
import { hypnogram, soundTimeline, stageBar, scoreRing, trendChart } from './charts.js';
import {
  getAllNights, getNight, saveNight, deleteNight, getClip, requestPersistence,
  storageEstimate, exportData, importData,
} from './storage.js';

const VERSION = '1.0.0';
const $ = sel => document.querySelector(sel);
const view = $('#view');
const tabs = $('#tabs');

const KIND = {
  snore: { label: 'Snoring', icon: '💤' },
  talk: { label: 'Talking', icon: '💬' },
  movement: { label: 'Movement', icon: '↔️' },
  bang: { label: 'Loud bang', icon: '💥' },
  rustle: { label: 'Rustling', icon: '🍃' },
  noise: { label: 'Other noise', icon: '🔊' },
};

const settings = {
  get mode() { return read('mode', 'bed'); },
  set mode(v) { write('mode', v); },
  get sensitivity() { return Number(read('sensitivity', 5)); },
  set sensitivity(v) { write('sensitivity', v); },
};
function read(k, d) { try { return localStorage.getItem('st.' + k) ?? d; } catch { return d; } }
function write(k, v) { try { localStorage.setItem('st.' + k, v); } catch { /* private mode */ } }

const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDate = t => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let recorder = null;
let wakeLock = null;
const analysisCache = new Map();
const analyse = night => {
  const key = `${night.id}:${night.end}:${night.epochs.length}`;
  if (!analysisCache.has(key)) analysisCache.set(key, analyzeNight(night));
  return analysisCache.get(key);
};

// ---------- Routing ----------
window.addEventListener('hashchange', route);
async function route() {
  if (recorder && location.hash !== '#/recording') { location.hash = '#/recording'; return; }
  const [, page, arg] = (location.hash || '#/').split('/');
  tabs.hidden = page === 'recording';
  document.body.classList.toggle('night', page === 'recording');
  tabs.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.page === (page || '')));
  if (page === 'recording') return renderRecording();
  if (page === 'night') return renderNight(Number(arg));
  if (page === 'history') return renderHistory();
  if (page === 'settings') return renderSettings();
  return renderTonight();
}

// ---------- Tonight ----------
async function renderTonight() {
  const nights = (await getAllNights()).filter(n => n.end);
  const last = nights[0];
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  view.innerHTML = `
    <header class="top"><h1>Tonight</h1><p class="sub">${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</p></header>
    ${ios && !standalone ? `<div class="card warn"><b>Add this app to your Home Screen first.</b> Tap the Share button in Safari, then <i>Add to Home Screen</i>. It then opens full screen and keeps your data safe.</div>` : ''}
    <section class="card">
      <h2>Where is your phone?</h2>
      <div class="seg" role="radiogroup">
        <button data-mode="bed" class="${settings.mode === 'bed' ? 'on' : ''}">On the bed</button>
        <button data-mode="nightstand" class="${settings.mode === 'nightstand' ? 'on' : ''}">Bedside table</button>
      </div>
      <p class="hint">${settings.mode === 'bed'
        ? 'Best results: phone face down on the mattress near your pillow. Uses sound and movement.'
        : 'Sound only. Sleep stages will be rougher without movement data.'}</p>
      <label class="slider">Sound sensitivity <span id="sensVal">${settings.sensitivity}</span>
        <input type="range" min="0" max="10" step="1" value="${settings.sensitivity}" id="sens">
      </label>
    </section>
    <button class="big" id="start">Start sleep tracking</button>
    <ul class="checklist">
      <li>Plug your phone into the charger.</li>
      <li>Keep this app open. The screen stays on but goes dark; locking the phone stops recording.</li>
      <li>Turn on Do Not Disturb so calls don't interrupt the microphone.</li>
    </ul>
    ${last ? lastNightCard(last) : '<p class="empty">No nights yet. Your first result appears here in the morning.</p>'}
  `;
  view.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { settings.mode = b.dataset.mode; renderTonight(); });
  $('#sens').oninput = e => { settings.sensitivity = e.target.value; $('#sensVal').textContent = e.target.value; };
  $('#start').onclick = startTracking;
}

function lastNightCard(n) {
  const a = analyse(n);
  return `<a class="card link" href="#/night/${n.id}">
    <h2>Last night</h2>
    <div class="row"><div class="mini-score">${a.score}%</div>
      <div><b>${formatDuration(a.minutesAsleep)}</b> asleep<br><span class="muted">${fmtTime(n.start)} – ${fmtTime(n.end)} · ${a.events.length} sounds</span></div></div>
    ${stageBar(a.totals)}
  </a>`;
}

async function startTracking() {
  const btn = $('#start');
  btn.disabled = true; btn.textContent = 'Starting…';
  try {
    recorder = new SleepRecorder({ mode: settings.mode, sensitivity: settings.sensitivity, onUpdate: onLevel });
    await recorder.start();
    requestPersistence();
    await keepAwake();
    location.hash = '#/recording';
  } catch (err) {
    recorder = null;
    btn.disabled = false; btn.textContent = 'Start sleep tracking';
    alert(err && err.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it in Settings › Safari › Microphone (or for this app) and try again.'
      : 'Could not start recording: ' + (err && err.message || err));
  }
}

// ---------- Keep the screen awake ----------
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
      return true;
    }
  } catch { /* not allowed right now */ }
  return false;
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && recorder) {
    if (!wakeLock) await keepAwake();
    recorder.ctx && recorder.ctx.state !== 'running' && recorder.ctx.resume().catch(() => {});
  }
});

// ---------- Recording ----------
let clockTimer;
function renderRecording() {
  if (!recorder) { location.hash = '#/'; return; }
  view.innerHTML = `
    <div class="nightscreen" id="ns">
      <div class="clock" id="clock"></div>
      <div class="since" id="since"></div>
      <div class="meter"><span id="lvl"></span></div>
      <div class="stats" id="rstats"></div>
      ${!('wakeLock' in navigator) ? '<p class="warn-dim">This iPhone can\'t keep the screen on by itself. Set Settings › Display & Brightness › Auto-Lock to Never tonight.</p>' : ''}
      <button class="hold" id="stop"><span class="fill"></span><span class="lbl">Hold to stop</span></button>
    </div>`;
  const tick = () => {
    const c = $('#clock'); if (!c) return clearInterval(clockTimer);
    c.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('#since').textContent = `Tracking for ${formatDuration((Date.now() - recorder.night.start) / 60000)}`;
    $('#rstats').textContent = `${recorder.night.events.length} sounds detected${recorder.motionAllowed ? ' · movement on' : ''}${wakeLock ? '' : ' · screen lock not held'}`;
  };
  clearInterval(clockTimer); clockTimer = setInterval(tick, 5000); tick();
  holdToStop($('#stop'), stopTracking);
}

let lastLevelPaint = 0;
function onLevel({ above, inEvent }) {
  const now = Date.now();
  if (now - lastLevelPaint < 250) return;
  lastLevelPaint = now;
  const el = $('#lvl');
  if (el) { el.style.width = Math.max(2, Math.min(100, above * 2.5)) + '%'; el.classList.toggle('hot', inEvent); }
}

function holdToStop(btn, done) {
  let t0 = 0, raf;
  const fill = btn.querySelector('.fill');
  const step = () => {
    const p = Math.min(1, (Date.now() - t0) / 1500);
    fill.style.width = p * 100 + '%';
    if (p >= 1) { cancel(); done(); } else raf = requestAnimationFrame(step);
  };
  const begin = e => { e.preventDefault(); t0 = Date.now(); raf = requestAnimationFrame(step); };
  const cancel = () => { cancelAnimationFrame(raf); fill.style.width = '0'; };
  btn.addEventListener('pointerdown', begin);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, cancel));
}

async function stopTracking() {
  clearInterval(clockTimer);
  view.innerHTML = '<p class="empty">Analysing your night…</p>';
  const night = await recorder.stop();
  recorder = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  location.hash = `#/night/${night.id}`;
}

// ---------- Night details ----------
async function renderNight(id) {
  const night = await getNight(id);
  if (!night) { view.innerHTML = '<p class="empty">That night was not found.</p>'; return; }
  const a = analyse(night);
  const header = `<header class="top"><a href="#/history" class="back">‹ History</a>
    <h1>${fmtDate(night.start)}</h1><p class="sub">${fmtTime(night.start)} – ${fmtTime(night.end || Date.now())}${night.recovered ? ' · recovered after the app closed' : ''}</p></header>`;
  if (a.tooShort) {
    view.innerHTML = header + `<p class="empty">This recording is under 20 minutes, too short to estimate sleep stages.</p>` + soundSection(night, a) + deleteBtn();
    wireNight(night); return;
  }
  const stageCards = ['deep', 'light', 'rem', 'awake'].map(k => {
    const longest = Math.max(0, ...a.segments.filter(s => s.stage === k).map(s => s.minutes));
    const pct = k === 'awake' ? '' : ` · ${a.minutesAsleep ? Math.round(100 * a.totals[k] / a.minutesAsleep) : 0}%`;
    return `<div class="stage st-card-${k}"><div class="dot st-${k}"></div><div>
      <b>${STAGE_LABEL[k]}</b><br><span class="big-num">${formatDuration(a.totals[k])}</span><span class="muted">${pct}</span><br>
      <span class="muted">${a.counts[k]} ${a.counts[k] === 1 ? 'period' : 'periods'}${longest ? ` · longest ${formatDuration(longest)}` : ''}</span></div></div>`;
  }).join('');
  view.innerHTML = header + `
    ${a.noSleep ? '<div class="card warn">No settled sleep was detected in this recording.</div>' : ''}
    <section class="card summary">
      ${scoreRing(a.score)}
      <dl>
        <dt>Asleep</dt><dd>${formatDuration(a.minutesAsleep)}</dd>
        <dt>In bed</dt><dd>${formatDuration(a.minutesInBed)}</dd>
        <dt>Fell asleep after</dt><dd>${formatDuration(a.latency)}</dd>
        <dt>Woke up</dt><dd>${a.wakeUps} ${a.wakeUps === 1 ? 'time' : 'times'}</dd>
        <dt>Sleep cycles</dt><dd>${a.cycles || 0}</dd>
      </dl>
    </section>
    <section class="card">
      <h2>Sleep stages</h2>
      ${hypnogram(a, night.epochs)}
      <div class="stages">${stageCards}</div>
      <p class="hint">Estimated from ${a.confidence === 'medium' ? 'your movement and sounds' : 'sounds only (put the phone on the bed for better estimates)'}. These are estimates, not a medical measurement.</p>
    </section>
    ${soundSection(night, a)}
    ${deleteBtn()}`;
  wireNight(night);
}

function soundSection(night, a) {
  const evs = a.events;
  const byKind = {};
  for (const e of evs) if (e.kind !== 'snore') byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  if (a.snoring.length) byKind.snore = a.snoring.length;
  const snoreMin = a.snoring.reduce((s, ep) => s + (ep.end - ep.start) / 60000, 0);
  const chips = Object.entries(byKind).sort((x, y) => y[1] - x[1])
    .map(([k, c]) => `<button class="chip" data-kind="${k}">${KIND[k]?.icon || ''} ${KIND[k]?.label || k} <b>${c}</b></button>`).join('');
  // Snores are listed as episodes rather than one row per breath.
  const rows = [
    ...evs.filter(e => e.kind !== 'snore').map(e => ({ t: e.t, kind: e.kind, id: e.id, clipId: e.clipId,
      label: KIND[e.kind]?.label || e.kind, detail: `${e.dur}s · +${e.aboveFloor} dB` })),
    ...a.snoring.map(ep => {
      const withClip = ep.events.filter(e => e.clipId).sort((x, y) => y.aboveFloor - x.aboveFloor)[0];
      return { t: ep.start, kind: 'snore', id: ep.events[0].id, clipId: withClip && withClip.clipId,
        label: 'Snoring', detail: `${formatDuration(Math.max(1, (ep.end - ep.start) / 60000))} · ${ep.count} snores` };
    }),
  ].sort((x, y) => x.t - y.t);
  const list = rows.map(r => `
    <li data-kind="${r.kind}" id="ev-${esc(r.id)}">
      <span class="ev-dot ev-${r.kind}"></span>
      <span class="ev-time">${fmtTime(r.t)}</span>
      <span class="ev-kind">${r.label}</span>
      <span class="muted">${r.detail}</span>
      ${r.clipId ? `<button class="play" data-clip="${esc(r.clipId)}" aria-label="Play">▶</button>` : '<span class="play off"></span>'}
    </li>`).join('');
  return `<section class="card">
    <h2>Sounds</h2>
    ${soundTimeline(night.epochs, evs)}
    <p class="muted">${evs.length} sounds${snoreMin ? ` · snoring for ${snoreMin < 1 ? 'under a minute' : 'about ' + formatDuration(snoreMin)} in ${a.snoring.length} ${a.snoring.length === 1 ? 'episode' : 'episodes'}` : ''}</p>
    <div class="chips"><button class="chip on" data-kind="">All</button>${chips}</div>
    <ul class="events">${list || '<li class="muted">No sounds above the background noise.</li>'}</ul>
  </section>`;
}

const deleteBtn = () => '<button class="danger" id="del">Delete this night</button>';

function wireNight(night) {
  let audio;
  view.querySelectorAll('.play[data-clip]').forEach(b => b.onclick = async () => {
    if (audio) { audio.pause(); URL.revokeObjectURL(audio.src); }
    const clip = await getClip(b.dataset.clip);
    if (!clip) { b.classList.add('off'); return; }
    audio = new Audio(URL.createObjectURL(clip.blob));
    audio.play().catch(() => alert('Could not play this clip.'));
  });
  view.querySelectorAll('.chip').forEach(c => c.onclick = () => {
    view.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c));
    view.querySelectorAll('.events li[data-kind]').forEach(li => { li.hidden = c.dataset.kind && li.dataset.kind !== c.dataset.kind; });
  });
  view.querySelectorAll('circle[data-ev]').forEach(cEl => cEl.addEventListener('click', () => {
    const li = document.getElementById('ev-' + cEl.dataset.ev);
    if (li) { li.scrollIntoView({ behavior: 'smooth', block: 'center' }); li.classList.add('flash'); setTimeout(() => li.classList.remove('flash'), 1200); }
  }));
  $('#del').onclick = async () => {
    if (!confirm('Delete this night and its sound clips? This cannot be undone.')) return;
    await deleteNight(night.id);
    location.hash = '#/history';
  };
}

// ---------- History ----------
async function renderHistory() {
  const nights = (await getAllNights()).filter(n => n.end);
  const withA = nights.map(n => ({ n, a: analyse(n) }));
  const valid = withA.filter(x => !x.a.tooShort && !x.a.noSleep);
  const avg = k => valid.length ? valid.reduce((s, x) => s + x.a.totals[k], 0) / valid.length : 0;
  const recent = valid.slice(0, 21).reverse().map(x => ({ id: x.n.id, a: x.a }));
  view.innerHTML = `
    <header class="top"><h1>History</h1><p class="sub">${nights.length} ${nights.length === 1 ? 'night' : 'nights'} recorded</p></header>
    ${valid.length >= 2 ? `<section class="card"><h2>Averages</h2>
      <div class="avgs">
        <div><span class="dot st-deep"></span>Deep<br><b>${formatDuration(avg('deep'))}</b></div>
        <div><span class="dot st-light"></span>Light<br><b>${formatDuration(avg('light'))}</b></div>
        <div><span class="dot st-rem"></span>REM<br><b>${formatDuration(avg('rem'))}</b></div>
        <div>Score<br><b>${Math.round(valid.reduce((s, x) => s + x.a.score, 0) / valid.length)}%</b></div>
      </div>${trendChart(recent)}</section>` : ''}
    <ul class="nights">${withA.map(({ n, a }) => `
      <li><a href="#/night/${n.id}">
        <div class="row"><b>${fmtDate(n.start)}</b><span class="muted">${a.tooShort ? 'short' : a.score + '%'}</span></div>
        <div class="muted">${fmtTime(n.start)} – ${fmtTime(n.end)} · ${formatDuration(a.minutesAsleep)} asleep · ${a.events.length} sounds</div>
        ${stageBar(a.totals)}
      </a></li>`).join('') || '<li class="empty">Nothing here yet.</li>'}</ul>`;
}

// ---------- Settings ----------
async function renderSettings() {
  const est = await storageEstimate();
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  view.innerHTML = `
    <header class="top"><h1>Settings</h1></header>
    <section class="card">
      <h2>Your data</h2>
      <p class="muted">Everything stays on this phone. Nothing is uploaded.${est ? ` Using ${(est.usage / 1048576).toFixed(1)} MB.` : ''}${persisted ? ' Protected from automatic clean-up.' : ''}</p>
      <button class="secondary" id="exp">Export backup</button>
      <label class="secondary file">Import backup<input type="file" accept="application/json,.json" id="imp"></label>
      <p class="hint">Backups include sleep data and sound times, not the audio clips.</p>
    </section>
    <section class="card">
      <h2>How it works</h2>
      <p>The microphone measures the background noise of your room and flags any sound that rises clearly above it. Short clips of those sounds are saved so you can play them back. Repeating low sounds every few seconds are counted as snoring.</p>
      <p>When the phone is on the bed, its motion sensor also feels you move. Long still periods early in the night are scored as deep sleep, still periods at the end of each ~90 minute cycle as dream (REM) sleep, the rest as light sleep, and lots of movement as awake.</p>
      <p class="hint">Real sleep stages need a sleep lab. Treat these numbers as a guide to trends, not a diagnosis.</p>
    </section>
    <p class="muted center">Sleep Tracker ${VERSION}</p>`;
  $('#exp').onclick = async () => {
    const json = await exportData();
    const name = `sleep-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).catch(() => {});
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = name; a.click();
    }
  };
  $('#imp').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { alert(`Imported ${await importData(await f.text())} new nights.`); }
    catch (err) { alert('Import failed: ' + err.message); }
  };
}

// ---------- Start-up ----------
async function recoverUnfinished() {
  // If the app was closed mid-night, close that night off at its last saved minute.
  for (const n of await getAllNights()) {
    if (!n.end) {
      const last = n.epochs[n.epochs.length - 1];
      n.end = last ? last.t + 60000 : n.start;
      n.recovered = true;
      await saveNight(n);
    }
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
recoverUnfinished().finally(route);
