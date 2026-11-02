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

  window.Analysis = { sampleFrames, detectScenes, detectSilence, trackMotion, autoGrade, AW, AH };
})();
