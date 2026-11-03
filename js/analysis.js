/* Local "AI" analysis: all heuristics run on downscaled frames / decoded PCM in the browser. */
(function () {
  'use strict';

  const AW = 64, AH = 36; // analysis resolution

  function once(el, ev, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for ' + ev)); }, timeout);
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); reject(new Error('Media error')); };
      function cleanup() { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); }
      el.addEventListener(ev, ok, { once: true });
      el.addEventListener('error', bad, { once: true });
    });
  }

  /** Seek an offscreen copy of a video through `times`, calling onFrame(ImageData, t, index). */
  async function sampleFrames(url, times, onFrame, opts = {}) {
    const w = opts.w || AW, h = opts.h || AH;
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = url;
    if (v.readyState < 2) await once(v, 'loadeddata', 15000);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    try {
      for (let i = 0; i < times.length; i++) {
        if (opts.signal && opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const t = Math.min(times[i], Math.max(0, v.duration - 0.01));
        if (Math.abs(v.currentTime - t) > 0.001) { v.currentTime = t; await once(v, 'seeked'); }
        ctx.drawImage(v, 0, 0, w, h);
        onFrame(ctx.getImageData(0, 0, w, h), times[i], i);
        if (opts.onProgress) opts.onProgress((i + 1) / times.length);
        if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
      }
    } finally { v.removeAttribute('src'); v.load(); }
  }

  function toLuma(img) {
    const d = img.data, out = new Float32Array(d.length / 4);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return out;
  }
  function hist(img) {
    const d = img.data, hgm = new Float32Array(48);
    for (let i = 0; i < d.length; i += 4) { hgm[d[i] >> 4]++; hgm[16 + (d[i + 1] >> 4)]++; hgm[32 + (d[i + 2] >> 4)]++; }
    const n = d.length / 4; for (let i = 0; i < 48; i++) hgm[i] /= n;
    return hgm;
  }

  /** Detect hard scene changes. Returns array of source-times (seconds). */
  async function detectScenes(url, duration, opts = {}) {
    const step = Math.max(0.2, duration / 1500);
    const times = []; for (let i = 0; i * step < duration; i++) times.push(i * step);
    const scores = []; let prevL = null, prevH = null;
    await sampleFrames(url, times, (img) => {
      const L = toLuma(img), H = hist(img);
      if (prevL) {
        let dl = 0; for (let i = 0; i < L.length; i++) dl += Math.abs(L[i] - prevL[i]);
        dl /= L.length * 255;
        let dh = 0; for (let i = 0; i < 48; i++) dh += Math.abs(H[i] - prevH[i]);
        dh /= 6; // 3 channels * L1 max 2
        scores.push(0.55 * Math.min(1, dl * 3) + 0.45 * dh);
      } else scores.push(0);
      prevL = L; prevH = H;
    }, opts);
    // adaptive threshold: local median + k * global spread
    const sorted = scores.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] || 0;
    const mad = sorted.map((s) => Math.abs(s - med)).sort((a, b) => a - b)[Math.floor(sorted.length / 2)] || 0.01;
    const thr = Math.max(0.16, med + 8 * mad) * (opts.sensitivity ? 1 / opts.sensitivity : 1);
    const coarse = []; let last = -Infinity;
    for (let i = 1; i < scores.length; i++) {
      const s = scores[i];
      const isPeak = s >= (scores[i - 1] || 0) && s >= (scores[i + 1] || 0);
      if (s > thr && isPeak && times[i] - last > 0.6) { coarse.push(i); last = times[i]; }
    }
    if (!coarse.length) return [];
    // refine each cut to frame accuracy (~1/30s) between the two coarse samples
    const fine = [], owner = [];
    coarse.forEach((i, k) => {
      const t0 = times[i - 1], t1 = times[i], n = Math.max(1, Math.round((t1 - t0) * 30));
      for (let j = 0; j <= n; j++) { fine.push(t0 + (j * (t1 - t0)) / n + 0.002); owner.push(k); }
    });
    const best = coarse.map((i) => ({ t: times[i], d: -1 }));
    let prev = null, prevOwner = -1;
    await sampleFrames(url, fine, (img, t, j) => {
      const L = toLuma(img);
      if (prev && owner[j] === prevOwner) {
        let d = 0; for (let i = 0; i < L.length; i++) d += Math.abs(L[i] - prev[i]);
        if (d > best[owner[j]].d) best[owner[j]] = { t, d };
      }
      prev = L; prevOwner = owner[j];
    }, { signal: opts.signal });
    // first sample showing the new scene — splitting here starts the next clip cleanly on the cut
    return best.map((b) => +b.t.toFixed(3));
  }

  /** Detect silent regions in an AudioBuffer. Returns {zones:[{start,end}], threshold}. */
  function detectSilence(buffer, opts = {}) {
    const win = opts.window || 0.02, minDur = opts.minDur || 0.45, pad = opts.pad ?? 0.08;
    const sr = buffer.sampleRate, n = Math.floor(win * sr), chs = buffer.numberOfChannels;
    const data = []; for (let c = 0; c < chs; c++) data.push(buffer.getChannelData(c));
    const frames = Math.floor(buffer.length / n);
    const db = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let sum = 0; const o = f * n;
      for (let c = 0; c < chs; c++) { const ch = data[c]; for (let i = 0; i < n; i++) { const s = ch[o + i]; sum += s * s; } }
      const rms = Math.sqrt(sum / (n * chs));
      db[f] = 20 * Math.log10(rms + 1e-9);
    }
    const sorted = Array.from(db).sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.1)] ?? -90;
    const peak = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    let thr = opts.threshold ?? Math.min(Math.max(floor + 10, peak - 35, -58), -24);
    const zones = []; let start = -1;
    for (let f = 0; f <= frames; f++) {
      const quiet = f < frames && db[f] < thr;
      if (quiet && start < 0) start = f;
      if (!quiet && start >= 0) {
        const s = start * win, e = f * win;
        if (e - s >= minDur) zones.push({ start: +(s + (s > 0 ? pad : 0)).toFixed(3), end: +(e - (f < frames ? pad : 0)).toFixed(3) });
        start = -1;
      }
    }
    return { zones: zones.filter((z) => z.end - z.start > 0.05), threshold: thr, peaks: makePeaks(db) };
  }

  function makePeaks(db) { // normalized 0..1 envelope for waveform drawing
    const out = new Float32Array(db.length);
    for (let i = 0; i < db.length; i++) out[i] = Math.max(0, Math.min(1, (db[i] + 60) / 60));
    return out;
  }

  /** Track the motion center of a clip range. Returns keys [{t, x, y}] (source time, normalized coords). */
  async function trackMotion(url, tIn, tOut, opts = {}) {
    const step = Math.max(0.15, (tOut - tIn) / 400);
    const times = []; for (let i = 0; tIn + i * step <= tOut; i++) times.push(tIn + i * step);
    const raw = []; let prev = null;
    await sampleFrames(url, times, (img, t) => {
      const L = toLuma(img);
      let sx = 0, sy = 0, sw = 0;
      if (prev) {
        for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
          const i = y * AW + x; const d = Math.abs(L[i] - prev[i]);
          if (d > 12) { const w = d * d; sx += x * w; sy += y * w; sw += w; }
        }
      }
      // little motion → fall back to edge-saliency (detail) centroid
      if (sw < 4000) {
        sx = sy = sw = 0;
        for (let y = 1; y < AH - 1; y++) for (let x = 1; x < AW - 1; x++) {
          const i = y * AW + x;
          const g = Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + AW] - L[i - AW]);
          const cw = 1 - 0.6 * Math.hypot(x / AW - 0.5, y / AH - 0.5); // center bias
          const w = g * g * cw; sx += x * w; sy += y * w; sw += w;
        }
        raw.push({ t, x: sw ? (sx / sw + 0.5) / AW : 0.5, y: sw ? (sy / sw + 0.5) / AH : 0.5, w: 0.3 });
      } else raw.push({ t, x: (sx / sw + 0.5) / AW, y: (sy / sw + 0.5) / AH, w: 1 });
      prev = L;
    }, opts);
    if (raw.length > 1) raw[0] = { ...raw[0], x: raw[1].x, y: raw[1].y };
    // forward-backward exponential smoothing for a steady virtual camera
    const a = 0.18; const sm = raw.map((k) => ({ ...k }));
    for (let i = 1; i < sm.length; i++) { const k = a * sm[i].w; sm[i].x = sm[i - 1].x + (sm[i].x - sm[i - 1].x) * k; sm[i].y = sm[i - 1].y + (sm[i].y - sm[i - 1].y) * k; }
    for (let i = sm.length - 2; i >= 0; i--) { sm[i].x = sm[i + 1].x + (sm[i].x - sm[i + 1].x) * 0.5; sm[i].y = sm[i + 1].y + (sm[i].y - sm[i + 1].y) * 0.5; }
    return sm.map((k) => ({ t: +k.t.toFixed(3), x: +k.x.toFixed(4), y: +k.y.toFixed(4) }));
  }

  /** Suggest grading parameters from an ImageData sample. */
  function autoGrade(img) {
    const d = img.data, n = d.length / 4;
    const lum = new Float32Array(n);
    let mr = 0, mg = 0, mb = 0, mw = 0, chroma = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; lum[j] = l;
      chroma += Math.max(r, g, b) - Math.min(r, g, b);
      if (l > 0.12 && l < 0.92) { mr += r; mg += g; mb += b; mw++; } // grey-world on mid-tones
    }
    lum.sort();
    const p = (q) => lum[Math.min(n - 1, Math.floor(q * n))];
    const p02 = p(0.02), p50 = p(0.5), p98 = p(0.98);
    const medLin = Math.pow(Math.max(p50, 0.01), 2.2);
    let exposure = Math.log2(Math.pow(0.42, 2.2) / medLin) * 0.7;
    exposure = Math.max(-1.5, Math.min(1.5, exposure));
    const spread = Math.max(0.05, p98 - p02);
    const contrast = Math.max(0.85, Math.min(1.45, 0.82 / spread));
    let temperature = 0, tint = 0;
    if (mw > n * 0.05) {
      mr /= mw; mg /= mw; mb /= mw; const m = (mr + mg + mb) / 3 || 1;
      temperature = Math.max(-1, Math.min(1, ((mb - mr) / m) * 2.2));
      tint = Math.max(-1, Math.min(1, ((mr + mb) / 2 - mg) / m * 2.6));
    }
    const meanChroma = chroma / n;
    const saturation = Math.max(0.85, Math.min(1.5, 0.22 / Math.max(meanChroma, 0.05)));
    const shadows = p02 > 0.08 ? -0.15 : p02 < 0.01 ? 0.15 : 0;
    const highlights = p98 > 0.98 ? -0.25 : 0;
    const r2 = (v) => Math.round(v * 100) / 100;
    return { exposure: r2(exposure), contrast: r2(contrast), temperature: r2(temperature), tint: r2(tint), saturation: r2(saturation), shadows: r2(shadows), highlights: r2(highlights), vibrance: 0.15 };
  }

  /* ---------- shared helpers ---------- */
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));
  const aborted = (signal) => { if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError'); };

  function monoMix(buffer) {
    const n = buffer.length, chs = buffer.numberOfChannels, out = new Float32Array(n);
    for (let c = 0; c < chs; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / chs; }
    return out;
  }

  /** Colour statistics of a frame, used to match shots to each other. */
  function frameStats(img) {
    const d = img.data, n = d.length / 4, lum = new Float32Array(n);
    let mr = 0, mg = 0, mb = 0, mw = 0, chroma = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; lum[j] = l;
      chroma += Math.max(r, g, b) - Math.min(r, g, b);
      if (l > 0.12 && l < 0.92) { mr += r; mg += g; mb += b; mw++; }
    }
    lum.sort();
    let temp = 0, tint = 0;
    if (mw > n * 0.05) {
      mr /= mw; mg /= mw; mb /= mw; const m = (mr + mg + mb) / 3 || 1;
      temp = ((mb - mr) / m) * 2.2; tint = (((mr + mb) / 2 - mg) / m) * 2.6;
    }
    return { medLin: Math.pow(Math.max(lum[n >> 1], 0.01), 2.2), temp, tint, chroma: chroma / n };
  }

  /** Per-sample visual activity: motion (frame difference) and interest (contrast + colour). */
  async function activityProfile(url, tIn, tOut, step, opts = {}) {
    const times = []; for (let t = tIn + step / 2; t < tOut; t += step) times.push(t);
    const out = []; let prev = null;
    await sampleFrames(url, times, (img, t) => {
      const L = toLuma(img), d = img.data, n = L.length;
      let mean = 0, motion = 0, colour = 0;
      for (let i = 0; i < n; i++) mean += L[i];
      mean /= n;
      let v = 0; for (let i = 0; i < n; i++) v += (L[i] - mean) ** 2;
      for (let i = 0; i < d.length; i += 4) colour += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
      if (prev) { for (let i = 0; i < n; i++) motion += Math.abs(L[i] - prev[i]); motion /= n * 255; }
      out.push({ t, motion, interest: Math.sqrt(v / n) / 128 + colour / (n * 255), mean: mean / 255 });
      prev = L;
    }, opts);
    if (out.length > 1) out[0].motion = out[1].motion;
    return out;
  }

  /** RMS loudness in dBFS for consecutive windows of `step` seconds over [tIn, tOut). */
  function loudnessProfile(buffer, tIn, tOut, step) {
    const mono = buffer._mono || (buffer._mono = monoMix(buffer));
    const sr = buffer.sampleRate, out = [];
    for (let t = tIn; t < tOut - 1e-6; t += step) {
      const a = Math.floor(t * sr), b = Math.min(mono.length, Math.floor(Math.min(t + step, tOut) * sr));
      let s = 0; for (let i = a; i < b; i++) s += mono[i] * mono[i];
      out.push(b > a ? 10 * Math.log10(s / (b - a) + 1e-12) : -120);
    }
    return out;
  }

  /** Gated integrated loudness (LUFS-style gating on plain RMS) and peak of a range. */
  function measureLoudness(buffer, tIn, tOut) {
    const mono = buffer._mono || (buffer._mono = monoMix(buffer));
    const sr = buffer.sampleRate, a = Math.floor(tIn * sr), b = Math.min(mono.length, Math.floor(tOut * sr));
    let peak = 0; for (let i = a; i < b; i++) { const v = Math.abs(mono[i]); if (v > peak) peak = v; }
    const blk = Math.floor(0.4 * sr), hop = Math.floor(0.1 * sr), ms = [];
    for (let s = a; s + blk <= b; s += hop) { let e = 0; for (let i = s; i < s + blk; i++) e += mono[i] * mono[i]; ms.push(e / blk); }
    if (!ms.length) return { db: -120, peak };
    const db = (x) => 10 * Math.log10(x + 1e-12);
    let gated = ms.filter((m) => db(m) > -70);
    if (!gated.length) return { db: -120, peak };
    const rel = db(gated.reduce((s, m) => s + m, 0) / gated.length) - 10;
    gated = gated.filter((m) => db(m) > rel);
    return { db: db(gated.reduce((s, m) => s + m, 0) / gated.length), peak };
  }

  /** Beat tracking: onset envelope → autocorrelation tempo → best-phase grid → local snap. */
  async function detectBeats(buffer, opts = {}) {
    const mono = buffer._mono || (buffer._mono = monoMix(buffer));
    const sr = buffer.sampleRate, hop = Math.round(sr * 0.01), frames = Math.floor(mono.length / hop) - 1;
    if (frames < 300) return { bpm: 0, beats: [], peaks: new Float32Array(0) };
    // log energy per 10 ms frame, 20 ms window; first-order low-pass emphasises kick / bass
    const e = new Float32Array(frames), lp = new Float32Array(frames);
    let y = 0;
    for (let f = 0; f < frames; f++) {
      let s = 0, sl = 0; const o = f * hop;
      for (let i = o; i < o + 2 * hop; i++) { const x = mono[i]; s += x * x; y += 0.08 * (x - y); sl += y * y; }
      e[f] = Math.log10(s + 1e-9); lp[f] = Math.log10(sl + 1e-9);
      if (f % 4000 === 0) { aborted(opts.signal); await yieldUI(); }
    }
    const on = new Float32Array(frames);
    for (let f = 1; f < frames; f++) on[f] = Math.max(0, e[f] - e[f - 1]) + 1.5 * Math.max(0, lp[f] - lp[f - 1]);
    // remove local mean (0.5 s) so only sharp onsets remain
    const W = 25, onN = new Float32Array(frames); let acc = 0;
    for (let f = 0; f < frames; f++) {
      acc += on[f]; if (f >= 2 * W) acc -= on[f - 2 * W];
      const c = f - W; if (c >= 0) onN[c] = Math.max(0, on[c] - acc / (2 * W));
    }
    // tempo: autocorrelation over 70–180 BPM, weighted toward ~120 BPM
    let bestLag = 50, bestScore = -1;
    for (let lag = 33; lag <= 86; lag++) {
      let s = 0; for (let f = lag; f < frames; f++) s += onN[f] * onN[f - lag];
      const bpm = 6000 / lag, w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
      if (s * w > bestScore) { bestScore = s * w; bestLag = lag; }
    }
    // phase: grid offset that collects the most onset energy
    let bestPh = 0, phScore = -1;
    for (let p = 0; p < bestLag; p++) { let s = 0; for (let f = p; f < frames; f += bestLag) s += onN[f]; if (s > phScore) { phScore = s; bestPh = p; } }
    const beats = [];
    for (let f = bestPh; f < frames; f += bestLag) {
      let bf = f, bv = onN[f];
      for (let k = -4; k <= 4; k++) { const g = f + k; if (g > 0 && g < frames && onN[g] > bv) { bv = onN[g]; bf = g; } }
      beats.push(+((bf + 1) * 0.01).toFixed(3)); // frame f measures the rise into the window centred at f+1
    }
    const peaks = new Float32Array(Math.ceil(mono.length / (sr * 0.02)));
    for (let i = 0; i < peaks.length; i++) {
      const a = Math.floor(i * sr * 0.02), b = Math.min(mono.length, a + Math.floor(sr * 0.02));
      let m = 0; for (let j = a; j < b; j += 4) m = Math.max(m, Math.abs(mono[j])); peaks[i] = Math.min(1, m * 1.2);
    }
    return { bpm: Math.round(6000 / bestLag), beats, peaks };
  }

  /** Black and frozen stretches. Returns zones [{start, end, kind}] in source seconds. */
  async function detectDeadFrames(url, duration, opts = {}) {
    const step = Math.max(0.25, duration / 1200);
    const times = []; for (let t = step / 2; t < duration; t += step) times.push(t);
    const kinds = []; let prev = null;
    await sampleFrames(url, times, (img) => {
      const L = toLuma(img), n = L.length;
      let mean = 0; for (let i = 0; i < n; i++) mean += L[i]; mean /= n;
      let v = 0; for (let i = 0; i < n; i++) v += (L[i] - mean) ** 2;
      const std = Math.sqrt(v / n);
      let diff = 255; if (prev) { diff = 0; for (let i = 0; i < n; i++) diff += Math.abs(L[i] - prev[i]); diff /= n; }
      kinds.push(mean < 16 && std < 8 ? 'black' : diff < 0.35 ? 'frozen' : null);
      prev = L;
    }, opts);
    const zones = [];
    for (let i = 0; i < kinds.length;) {
      if (!kinds[i]) { i++; continue; }
      const k = kinds[i]; let j = i; while (j < kinds.length && kinds[j] === k) j++;
      const start = Math.max(0, times[i] - step / 2), end = Math.min(duration, times[j - 1] + step / 2);
      if (end - start >= (k === 'black' ? 0.3 : 1.5)) zones.push({ start: +start.toFixed(3), end: +end.toFixed(3), kind: k });
      i = j;
    }
    return zones;
  }

  /** Camera shake: global translation per frame, smoothed into stabilising crop keys. */
  async function estimateShake(url, tIn, tOut, opts = {}) {
    const W = 160, H = 90, w2 = 80, h2 = 45;
    const step = Math.max(1 / 15, (tOut - tIn) / 600);
    const times = []; for (let t = tIn; t <= tOut; t += step) times.push(t);
    const half = (L) => { const o = new Float32Array(w2 * h2); for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) { const i = 2 * y * W + 2 * x; o[y * w2 + x] = (L[i] + L[i + 1] + L[i + W] + L[i + W + 1]) / 4; } return o; };
    // SAD of cur shifted by (dx,dy) against prev over the interior: cur(x+dx, y+dy) ≈ prev(x, y)
    const sad = (P, C, w, h, dx, dy, m, st) => { let s = 0; for (let y = m; y < h - m; y += st) for (let x = m; x < w - m; x += st) s += Math.abs(C[(y + dy) * w + x + dx] - P[y * w + x]); return s; };
    const path = [{ t: times[0], x: 0, y: 0 }]; let prev = null, prevH = null, X = 0, Y = 0;
    await sampleFrames(url, times, (img, t) => {
      const L = toLuma(img), Lh = half(L);
      if (prev) {
        // start from "no motion" and only move when a shift is clearly better, so flat or
        // static frames (black, frozen, sky) can't drift the path on ties
        let bx = 0, by = 0, bs = sad(prevH, Lh, w2, h2, 0, 0, 6, 1);
        for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) { const s = sad(prevH, Lh, w2, h2, dx, dy, 6, 1); if (s < bs * 0.97 - 1) { bs = s; bx = dx; by = dy; } }
        const fx = 2 * bx, fy = 2 * by; let rx = fx, ry = fy;
        bs = sad(prev, L, W, H, fx, fy, 14, 2);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const s = sad(prev, L, W, H, fx + dx, fy + dy, 14, 2); if (s < bs * 0.99 - 1) { bs = s; rx = fx + dx; ry = fy + dy; } }
        // a poor best match means a cut or a flash, not camera motion: don't let it drift the path
        const perPx = bs / (Math.ceil((W - 28) / 2) * Math.ceil((H - 28) / 2));
        if (perPx > 18) { rx = 0; ry = 0; }
        X += rx / W; Y += ry / H; path.push({ t, x: X, y: Y });
      }
      prev = L; prevH = Lh;
    }, { ...opts, w: W, h: H });
    // smooth the camera path (≈1 s gaussian); the crop follows the jitter (raw − smooth)
    const sigma = Math.max(2, 0.5 / step), R = Math.ceil(sigma * 2.5), keys = [];
    let maxDev = 0;
    for (let i = 0; i < path.length; i++) {
      let sx = 0, sy = 0, sw = 0;
      for (let k = -R; k <= R; k++) { const j = Math.min(path.length - 1, Math.max(0, i + k)); const w = Math.exp(-(k * k) / (2 * sigma * sigma)); sx += path[j].x * w; sy += path[j].y * w; sw += w; }
      // jitter moved the content by +d → move the crop window by +d as well so the content holds still
      const dx = path[i].x - sx / sw, dy = path[i].y - sy / sw;
      maxDev = Math.max(maxDev, Math.abs(dx), Math.abs(dy));
      keys.push({ t: +path[i].t.toFixed(3), x: +(0.5 + dx).toFixed(4), y: +(0.5 + dy).toFixed(4) });
    }
    return { keys, scale: +Math.min(1.25, Math.max(1.06, 1 + 2.2 * maxDev)).toFixed(3), shake: maxDev };
  }

  /** Thumbnail score of a frame: sharpness, exposure, contrast and colourfulness. */
  function thumbScore(img) {
    const L = toLuma(img), d = img.data, w = img.width, h = img.height, n = L.length;
    let mean = 0; for (let i = 0; i < n; i++) mean += L[i]; mean /= n;
    let v = 0; for (let i = 0; i < n; i++) v += (L[i] - mean) ** 2;
    let lap = 0, lc = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; const q = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w]; lap += q * q; lc++; }
    let rg = 0, yb = 0, rg2 = 0, yb2 = 0;
    for (let i = 0; i < d.length; i += 4) { const a = d[i] - d[i + 1], b = (d[i] + d[i + 1]) / 2 - d[i + 2]; rg += a; yb += b; rg2 += a * a; yb2 += b * b; }
    rg /= n; yb /= n;
    const colourful = Math.sqrt(Math.max(0, rg2 / n - rg * rg) + Math.max(0, yb2 / n - yb * yb)) + 0.3 * Math.hypot(rg, yb);
    const sharp = Math.log10(1 + lap / lc), expo = 1 - Math.min(1, Math.abs(mean / 255 - 0.47) * 2.2), contrast = Math.min(1, Math.sqrt(v / n) / 70);
    return { score: 0.4 * Math.min(1, sharp / 3) + 0.25 * expo + 0.2 * contrast + 0.15 * Math.min(1, colourful / 90), sharp, expo, contrast, colourful };
  }

  /**
   * Auto Zoom for screen recordings: find where the screen is changing (typing, clicks,
   * scrolling a panel) and return zoom keys [{t, x, y, s}] that push in on localised
   * activity, hold for a beat, then ease back out when the activity spreads or stops.
   */
  async function detectFocus(url, tIn, tOut, opts = {}) {
    const W = 96, H = 54, step = Math.max(0.2, (tOut - tIn) / 900), maxZoom = opts.maxZoom || 1.9;
    const times = []; for (let t = tIn; t <= tOut; t += step) times.push(t);
    const raw = []; let prev = null;
    await sampleFrames(url, times, (img, t) => {
      const L = toLuma(img);
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
      if (prev) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x; if (Math.abs(L[i] - prev[i]) > 14) { n++; sx += x; sy += y; sxx += x * x; syy += y * y; }
      }
      const frac = n / (W * H);
      if (n >= 3 && frac < 0.18) {
        const mx = sx / n, my = sy / n, vx = Math.sqrt(Math.max(1, sxx / n - mx * mx)), vy = Math.sqrt(Math.max(1, syy / n - my * my));
        const spread = Math.max((vx * 4) / W, (vy * 4) / H); // ~±2σ box as a fraction of the frame
        raw.push({ t, x: (mx + 0.5) / W, y: (my + 0.5) / H, s: Math.min(maxZoom, Math.max(1, 0.8 / Math.max(spread, 0.2))), active: true });
      } else raw.push({ t, x: 0.5, y: 0.5, s: 1, active: false });
      prev = L;
    }, { ...opts, w: W, h: H });
    // hold each zoom ~1.5 s after the last activity, then release
    const hold = Math.ceil(1.5 / step); let last = -1e9;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i].active && raw[i].s > 1.15) last = i;
      else if (i - last <= hold && last >= 0) raw[i] = { ...raw[last], t: raw[i].t, active: false };
    }
    // ease: camera position follows quickly, zoom level slowly (no snapping)
    const out = []; let cx = 0.5, cy = 0.5, cs = 1;
    for (const k of raw) {
      const a = k.s > 1 ? 0.25 : 0.12, b = k.s > cs ? 0.12 : 0.08;
      cx += (k.x - cx) * a; cy += (k.y - cy) * a; cs += (k.s - cs) * b;
      out.push({ t: +k.t.toFixed(3), x: +cx.toFixed(4), y: +cy.toFixed(4), s: +cs.toFixed(3) });
    }
    // backward pass so zooms start slightly before the action instead of lagging behind it
    for (let i = out.length - 2; i >= 0; i--) { out[i].s = +Math.max(out[i].s, out[i + 1].s - 0.04).toFixed(3); }
    return { keys: out, zooms: raw.filter((k, i) => k.active && k.s > 1.15 && !(raw[i - 1] && raw[i - 1].active && raw[i - 1].s > 1.15)).length };
  }

  window.Analysis = {
    sampleFrames, detectScenes, detectSilence, trackMotion, autoGrade, AW, AH,
    frameStats, activityProfile, loudnessProfile, measureLoudness, detectBeats, detectDeadFrames, estimateShake, thumbScore, detectFocus,
  };
})();
