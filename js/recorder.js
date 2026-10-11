// Overnight recorder: listens to the microphone (and the motion sensor when the
// phone is on the bed), detects sound events, keeps short audio clips of them and
// writes a one-minute summary ("epoch") to storage as it goes, so nothing is lost
// if the app is closed.

import { saveNight, saveClip, deleteClip } from './storage.js';

const FRAME_MS = 100;
const MAX_CLIPS = 120;
const MAX_CLIP_SEC = 30;

export class SleepRecorder {
  constructor({ mode, sensitivity, onUpdate }) {
    this.mode = mode;                       // 'bed' | 'nightstand'
    this.triggerDb = 14 - sensitivity;      // sensitivity 0..10 -> 14..4 dB above background
    this.onUpdate = onUpdate || (() => {});
    this.levels = [];                       // last 60 s of levels for the background estimate
    this.floor = -70;
    this.event = null;
    this.quietFrames = 0;
    this.loudFrames = 0;
    this.clips = [];                        // {id, peak}
    this.recorder = null;
    this.motion = { prev: null, moving: false, lastMove: 0, burstStart: 0 };
    this.resetEpoch();
  }

  resetEpoch() {
    this.ep = { sum: 0, frames: 0, peak: -120, events: 0, moveSec: 0, bursts: 0, twitches: 0, hasMotion: false };
    this.epStart = Date.now();
  }

  async start() {
    const now = Date.now();
    this.night = { id: now, start: now, end: null, mode: this.mode, epochs: [], events: [], version: 1 };

    // iOS needs the motion permission requested directly from the tap.
    if (this.mode === 'bed' && typeof DeviceMotionEvent !== 'undefined') {
      try {
        if (typeof DeviceMotionEvent.requestPermission === 'function') {
          const res = await DeviceMotionEvent.requestPermission();
          this.motionAllowed = res === 'granted';
        } else this.motionAllowed = true;
      } catch { this.motionAllowed = false; }
      if (this.motionAllowed) {
        this.onMotion = e => this.handleMotion(e);
        window.addEventListener('devicemotion', this.onMotion);
      }
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    await this.ctx.resume();
    this.ctx.onstatechange = () => { if (this.ctx.state !== 'running' && this.running) this.ctx.resume().catch(() => {}); };
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    src.connect(this.analyser);
    this.timeBuf = new Float32Array(this.analyser.fftSize);
    this.freqBuf = new Float32Array(this.analyser.frequencyBinCount);
    this.binHz = this.ctx.sampleRate / this.analyser.fftSize;
    this.mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
      .find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';

    this.running = true;
    this.resetEpoch();
    await saveNight(this.night);
    this.timer = setInterval(() => this.tick(), FRAME_MS);
  }

  tick() {
    if (this.ctx.state !== 'running') return;
    this.analyser.getFloatTimeDomainData(this.timeBuf);
    let sq = 0;
    for (const v of this.timeBuf) sq += v * v;
    const db = 10 * Math.log10(sq / this.timeBuf.length + 1e-12);

    this.levels.push(db);
    if (this.levels.length > 600) this.levels.shift();
    this.frameCount = (this.frameCount || 0) + 1;
    if (this.frameCount % 10 === 0 || this.levels.length < 20) {
      const sorted = [...this.levels].sort((a, b) => a - b);
      this.floor = sorted[Math.floor(sorted.length * 0.15)];
    }

    this.ep.sum += db; this.ep.frames++;
    if (db > this.ep.peak) this.ep.peak = db;

    const above = db - this.floor;
    if (!this.event) {
      this.loudFrames = above > this.triggerDb ? this.loudFrames + 1 : 0;
      if (this.loudFrames >= 2) this.beginEvent(db);
    } else {
      this.updateEvent(db, above);
      this.quietFrames = above < this.triggerDb - 3 ? this.quietFrames + 1 : 0;
      const dur = (Date.now() - this.event.t) / 1000;
      if (this.quietFrames >= 8 || dur > 60) this.endEvent();
    }

    this.prevDb = db;
    if (Date.now() - this.epStart >= 60000) this.closeEpoch();
    this.onUpdate({ db, floor: this.floor, above, inEvent: !!this.event, night: this.night });
  }

  spectrum() {
    this.analyser.getFloatFrequencyData(this.freqBuf);
    let total = 0, low = 0, mid = 0, cent = 0;
    for (let i = 1; i < this.freqBuf.length; i++) {
      const p = 10 ** (this.freqBuf[i] / 10);
      const hz = i * this.binHz;
      total += p; cent += p * hz;
      if (hz < 500) low += p;
      if (hz >= 300 && hz <= 3400) mid += p;
    }
    return { total, low, mid, centroid: total > 0 ? cent / total : 0 };
  }

  beginEvent(db) {
    this.event = { t: Date.now() - 2 * FRAME_MS, peak: Math.max(db, this.prevDb ?? db), frames: 0, bursts: 1, wasLoud: true, total: 0, low: 0, mid: 0, cent: 0, centSq: 0 };
    this.quietFrames = 0;
    this.ep.events++;
    if (this.mime) this.startClip();
  }

  updateEvent(db, above) {
    const e = this.event;
    e.peak = Math.max(e.peak, db);
    const loud = above >= this.triggerDb - 3;
    if (loud && !e.wasLoud) e.bursts = (e.bursts || 0) + 1; // syllables in speech, one push in a snore
    e.wasLoud = loud;
    if (!loud) return; // only describe the loud part, not the tail
    // Louder frames count for more, so the quiet edges don't blur the picture.
    const sp = this.spectrum();
    e.frames++;
    e.total += sp.total; e.low += sp.low; e.mid += sp.mid;
    e.cent += sp.total * sp.centroid; e.centSq += sp.total * sp.centroid ** 2;
  }

  endEvent() {
    const e = this.event;
    this.event = null;
    const dur = (Date.now() - e.t) / 1000 - this.quietFrames * FRAME_MS / 1000;
    const T = e.total || 1;
    const low = e.low / T, mid = e.mid / T, cent = e.cent / T;
    const centVar = Math.sqrt(Math.max(0, e.centSq / T - cent * cent));
    const aboveFloor = e.peak - this.floor;
    // Rough sound type from pitch and length. Snores are low and short; speech is
    // mid-pitched and keeps changing; bangs are short and loud.
    let rawKind = 'noise';
    if (this.motion.lastMove && Math.abs(this.motion.lastMove - e.t) < 3000) rawKind = 'movement';
    else if (dur >= 1 && e.bursts >= 3 && cent > 120 && cent < 3000) rawKind = 'talk';
    else if (low > 0.6 && cent < 700 && centVar < 300 && dur >= 0.4 && dur <= 4 && e.bursts <= 2) rawKind = 'snore';
    else if (dur < 1.5 && cent > 3000 && aboveFloor <= 28) rawKind = 'rustle';
    else if (dur < 1.5 && aboveFloor > 22) rawKind = 'bang';

    const ev = {
      id: `${this.night.id}-${e.t}`, t: e.t, dur: Math.round(dur * 10) / 10,
      peak: Math.round(e.peak), aboveFloor: Math.round(aboveFloor), rawKind, kind: rawKind,
      f: { bursts: e.bursts, low: +low.toFixed(2), mid: +mid.toFixed(2), cent: Math.round(cent), centVar: Math.round(centVar) },
      clipId: null,
    };
    this.night.events.push(ev);
    if (this.recorder) this.stopClip(ev, dur);
  }

  startClip() {
    try {
      const rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
      const chunks = [];
      rec.ondataavailable = d => d.data.size && chunks.push(d.data);
      rec.start();
      this.recorder = { rec, chunks, started: Date.now() };
      this.clipTimeout = setTimeout(() => this.recorder && this.recorder.rec.state === 'recording' && this.recorder.rec.stop(), MAX_CLIP_SEC * 1000);
    } catch { this.recorder = null; }
  }

  stopClip(ev, dur) {
    const { rec, chunks } = this.recorder;
    this.recorder = null;
    clearTimeout(this.clipTimeout);
    const finish = async () => {
      if (dur < 0.4 || !chunks.length) return;
      // Keep only the loudest clips once the budget is used up.
      if (this.clips.length >= MAX_CLIPS) {
        this.clips.sort((a, b) => a.peak - b.peak);
        if (this.clips[0].peak >= ev.aboveFloor) return;
        const drop = this.clips.shift();
        await deleteClip(drop.id);
        const old = this.night.events.find(x => x.clipId === drop.id);
        if (old) old.clipId = null;
      }
      const blob = new Blob(chunks, { type: rec.mimeType || this.mime });
      const id = ev.id;
      await saveClip({ id, nightId: this.night.id, blob, mime: blob.type });
      ev.clipId = id;
      this.clips.push({ id, peak: ev.aboveFloor });
    };
    if (rec.state === 'inactive') finish();
    else { rec.onstop = finish; setTimeout(() => rec.state === 'recording' && rec.stop(), 500); }
  }

  handleMotion(e) {
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (!a || a.x == null) return;
    this.ep.hasMotion = true;
    const m = this.motion, now = Date.now();
    if (m.prev) {
      const d = Math.hypot(a.x - m.prev.x, a.y - m.prev.y, a.z - m.prev.z);
      const interval = (e.interval || 16) / 1000;
      if (d > 0.08) {
        if (!m.moving) {
          m.moving = true;
          if (now - m.lastMove > 1500) { this.ep.bursts++; m.burstStart = now; }
        }
        this.ep.moveSec += interval;
        m.lastMove = now;
      } else if (m.moving && now - m.lastMove > 500) {
        m.moving = false;
        if (now - m.burstStart < 1200) this.ep.twitches++;
      }
    }
    m.prev = { x: a.x, y: a.y, z: a.z };
  }

  closeEpoch() {
    const ep = this.ep;
    this.night.epochs.push({
      t: this.epStart,
      db: ep.frames ? Math.round(ep.sum / ep.frames * 10) / 10 : null,
      peak: Math.round(ep.peak),
      floor: Math.round(this.floor),
      events: ep.events,
      moveSec: Math.round(ep.moveSec * 10) / 10,
      bursts: ep.bursts,
      twitches: ep.twitches,
      hasMotion: ep.hasMotion,
    });
    this.resetEpoch();
    saveNight(this.night).catch(() => {});
  }

  async stop() {
    this.running = false;
    clearInterval(this.timer);
    if (this.event) this.endEvent();
    if (this.ep.frames > 300) this.closeEpoch();
    if (this.onMotion) window.removeEventListener('devicemotion', this.onMotion);
    this.stream && this.stream.getTracks().forEach(t => t.stop());
    this.ctx && this.ctx.close().catch(() => {});
    await new Promise(r => setTimeout(r, 800)); // let the last clip finish saving
    this.night.end = Date.now();
    await saveNight(this.night);
    return this.night;
  }
}
