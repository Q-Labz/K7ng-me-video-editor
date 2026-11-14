/* KutLabz — AI Video Studio. Single-track, browser-only editor. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const uid = () => Math.random().toString(36).slice(2, 10);
  const IMAGE_DURATION = 4;
  const PAD = 14; // timeline left padding (px)
  const MIN_CLIP = 0.1;

  const COLOR_DEFS = [
    { k: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.01, def: 0, sign: true },
    { k: 'contrast', label: 'Contrast', min: 0.5, max: 1.8, step: 0.01, def: 1 },
    { k: 'highlights', label: 'Highlights', min: -1, max: 1, step: 0.01, def: 0, sign: true },
    { k: 'shadows', label: 'Shadows', min: -1, max: 1, step: 0.01, def: 0, sign: true },
    { k: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.01, def: 0, sign: true },
    { k: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01, def: 0, sign: true },
    { k: 'saturation', label: 'Saturation', min: 0, max: 2, step: 0.01, def: 1 },
    { k: 'vibrance', label: 'Vibrance', min: -1, max: 1, step: 0.01, def: 0, sign: true },
    { k: 'vignette', label: 'Vignette', min: -1, max: 1, step: 0.01, def: 0, sign: true },
    { k: 'fade', label: 'Fade', min: 0, max: 1, step: 0.01, def: 0 },
  ];
  const defaultColor = () => Object.fromEntries(COLOR_DEFS.map((d) => [d.k, d.def]));

  const S = {
    assets: [], clips: [], starts: [], total: 0,
    selected: null, time: 0, playing: false, activeIdx: -1,
    muted: false, raw: false, pps: 40,
    color: defaultColor(), lutAmt: 1, lutId: 'none', lutList: [],
    aspect: 'source', camera: null, exporting: null, busy: null,
    dirty: true, lastEl: null, history: [], future: [],
    actx: null, monitor: null, recDest: null,
    texts: [], selText: null, music: null, voiceAn: null, duckLevel: 1,
  };

  let R;
  const canvas = $('view');
  try { R = new Renderer(canvas); } catch (e) { console.error(e); setTimeout(() => toast('WebGL unavailable: ' + e.message, true), 100); }

  /* ---------------- utilities ---------------- */
  function fmt(t) {
    t = Math.max(0, Math.floor((t || 0) * 10 + 1e-6) / 10);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), d = Math.floor((t * 10) % 10);
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0') + '.' + d;
  }
  let toastTimer;
  const toastLog = [];
  function toast(msg, err) {
    toastLog.push({ msg, err: !!err, t: Date.now() }); if (toastLog.length > 40) toastLog.shift();
    const el = $('toast'); el.textContent = msg; el.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.className = 'toast'), err ? 5000 : 3200);
  }
  function setStatus(t) { $('status').textContent = t; }
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  const assetById = (id) => S.assets.find((a) => a.id === id);
  const clipDur = (c) => c.out - c.in;

  /* ---------------- audio graph ---------------- */
  function ensureAudio() {
    if (!S.actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      S.actx = new AC();
      S.monitor = S.actx.createGain();
      S.monitor.gain.value = S.muted ? 0 : 1;
      S.monitor.connect(S.actx.destination);
      S.recDest = S.actx.createMediaStreamDestination();
    }
    for (const a of S.assets) attachAudio(a);
    attachMusic();
    if (S.actx.state === 'suspended') S.actx.resume().catch(() => {});
    return S.actx;
  }
  // Per-asset chain: source → rumble cut → mud cut → presence → compressor → clip gain → outputs.
  // Per-clip settings (gain, voice enhance) are applied whenever playback enters a clip.
  function attachAudio(a) {
    if (!S.actx || a.kind !== 'video' || a.audioNode) return;
    try {
      const ac = S.actx;
      if (!S.voiceAn) { S.voiceAn = ac.createAnalyser(); S.voiceAn.fftSize = 1024; S.voiceBuf = new Float32Array(S.voiceAn.fftSize); }
      a.audioNode = ac.createMediaElementSource(a.el);
      const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.7;
      const mud = ac.createBiquadFilter(); mud.type = 'peaking'; mud.frequency.value = 300; mud.Q.value = 1;
      const pres = ac.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3200; pres.Q.value = 0.9;
      const comp = ac.createDynamicsCompressor();
      const g = ac.createGain();
      a.audioNode.connect(hp); hp.connect(mud); mud.connect(pres); pres.connect(comp); comp.connect(g);
      g.connect(S.monitor); g.connect(S.recDest); g.connect(S.voiceAn);
      a.chain = { hp, mud, pres, comp, g };
      setChain(a, 1, false);
    } catch (e) { console.warn('audio attach failed', e); }
  }
  function setChain(a, gain, enhance) {
    const c = a.chain; if (!c) return;
    const t = S.actx.currentTime, k = 0.015;
    c.hp.frequency.setTargetAtTime(enhance ? 90 : 10, t, k);
    c.mud.gain.setTargetAtTime(enhance ? -2.5 : 0, t, k);
    c.pres.gain.setTargetAtTime(enhance ? 4 : 0, t, k);
    c.comp.threshold.setTargetAtTime(enhance ? -26 : 0, t, k);
    c.comp.ratio.setTargetAtTime(enhance ? 3.5 : 1, t, k);
    c.comp.knee.setTargetAtTime(enhance ? 8 : 0, t, k);
    c.comp.attack.value = 0.005; c.comp.release.value = 0.2;
    c.g.gain.setTargetAtTime(gain * (enhance ? 1.5 : 1), t, k);
  }
  function applyClipAudio(c, a) { if (a && a.chain) setChain(a, c.gain ?? 1, !!c.enhance); }
  function attachMusic() {
    const m = S.music; if (!S.actx || !m || m.node) return;
    m.node = S.actx.createMediaElementSource(m.el);
    m.gainNode = S.actx.createGain(); m.gainNode.gain.value = m.vol;
    m.node.connect(m.gainNode); m.gainNode.connect(S.monitor); m.gainNode.connect(S.recDest);
  }
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => { if (S.assets.length) ensureAudio(); }, { capture: true }));

  /* ---------------- layout / lookup ---------------- */
  function layout() {
    let t = 0; S.starts = S.clips.map((c) => { const s = t; t += clipDur(c); return s; });
    S.total = t;
  }
  function locate(t) {
    if (!S.clips.length) return null;
    for (let i = 0; i < S.clips.length; i++) {
      const c = S.clips[i], s = S.starts[i], e = s + clipDur(c);
      if (t < e || i === S.clips.length - 1) {
        const local = clamp(t - s, 0, clipDur(c));
        return { i, clip: c, asset: assetById(c.assetId), start: s, src: c.in + local };
      }
    }
    return null;
  }
  function framingFor(loc) {
    const fr = { fit: S.aspect === 'source' ? 'contain' : 'cover', scale: 1, cx: 0.5, cy: 0.5 };
    const rf = loc && loc.clip.reframe;
    if (rf && rf.keys && rf.keys.length) {
      fr.scale = rf.scale || 1;
      const k = rf.keys, t = loc.src, ks = (key) => key.s ?? fr.scale;
      let lo = 0, hi = k.length - 1;
      if (t <= k[0].t) { fr.cx = k[0].x; fr.cy = k[0].y; fr.scale = ks(k[0]); }
      else if (t >= k[hi].t) { fr.cx = k[hi].x; fr.cy = k[hi].y; fr.scale = ks(k[hi]); }
      else {
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (k[m].t <= t) lo = m; else hi = m; }
        const f = (t - k[lo].t) / (k[hi].t - k[lo].t || 1);
        fr.cx = k[lo].x + (k[hi].x - k[lo].x) * f; fr.cy = k[lo].y + (k[hi].y - k[lo].y) * f;
        fr.scale = ks(k[lo]) + (ks(k[hi]) - ks(k[lo])) * f; // per-key zoom (Auto Zoom)
      }
    }
    return fr;
  }

  function updateCanvasSize() {
    let w = 1280, h = 720;
    const src = S.camera ? { width: S.camera.el.videoWidth, height: S.camera.el.videoHeight }
      : (S.clips[0] && assetById(S.clips[0].assetId)) || S.assets[0];
    if (S.aspect === 'source') {
      if (src && src.width && src.height) {
        const k = Math.min(1, 1920 / Math.max(src.width, src.height));
        w = Math.round(src.width * k / 2) * 2; h = Math.round(src.height * k / 2) * 2;
      }
    } else {
      const [a, b] = S.aspect.split(':').map(Number);
      if (a >= b) { w = 1920; h = Math.round(1920 * b / a / 2) * 2; } else { h = 1920; w = Math.round(1920 * a / b / 2) * 2; }
    }
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; S.dirty = true; }
    $('statusRight').textContent = S.clips.length ? `${w}×${h} · ${S.clips.length} clip${S.clips.length > 1 ? 's' : ''} · ${fmt(S.total)}` : '';
  }

  /* ---------------- playback engine ---------------- */
  function pauseAllExcept(el) { for (const a of S.assets) if (a.kind === 'video' && a.el !== el && !a.el.paused) a.el.pause(); }

  function enterClip(i, src) {
    const c = S.clips[i]; if (!c) return;
    const a = assetById(c.assetId);
    S.activeIdx = i;
    pauseAllExcept(a.el);
    applyClipAudio(c, a);
    if (a.kind === 'video') {
      const target = src ?? c.in;
      if (Math.abs(a.el.currentTime - target) > 0.04) a.el.currentTime = target;
      if (S.playing) a.el.play().catch(() => {});
      else if (!a.el.paused) a.el.pause();
    }
    S.dirty = true;
  }

  function play() {
    if (S.camera || !S.clips.length || S.playing) return;
    ensureAudio();
    if (S.time >= S.total - 0.05) S.time = 0;
    S.playing = true;
    const loc = locate(S.time);
    enterClip(loc.i, loc.src);
    syncMusic(true);
    $('btnPlay').textContent = '❚❚';
  }
  function pause() {
    S.playing = false;
    pauseAllExcept(null);
    if (S.music) S.music.el.pause();
    $('btnPlay').textContent = '▶\uFE0E';
    S.dirty = true;
  }
  function togglePlay() { S.playing ? pause() : play(); }

  function seek(t) {
    S.time = clamp(t, 0, S.total);
    const loc = locate(S.time);
    if (loc) enterClip(loc.i, loc.src);
    syncMusic(true);
    S.dirty = true;
  }

  /* music bed follows the timeline clock; drift beyond 150 ms is corrected */
  function syncMusic(force) {
    const m = S.music; if (!m) return;
    const el = m.el, inRange = S.time < m.duration - 0.05;
    if (!S.playing || !inRange) { if (!el.paused) el.pause(); if (force && inRange) el.currentTime = S.time; return; }
    if (force || Math.abs(el.currentTime - S.time) > 0.15) el.currentTime = S.time;
    if (el.paused) el.play().catch(() => {});
  }
  /* sidechain ducking: dip the music while the clips' own audio is active */
  function duckMusic() {
    const m = S.music; if (!m || !m.gainNode || !S.voiceAn) return;
    let target = m.vol;
    if (m.duck && S.playing) {
      S.voiceAn.getFloatTimeDomainData(S.voiceBuf);
      let sum = 0; for (let i = 0; i < S.voiceBuf.length; i++) sum += S.voiceBuf[i] * S.voiceBuf[i];
      const rms = Math.sqrt(sum / S.voiceBuf.length);
      S.duckLevel = rms > 0.015 ? 0.22 : S.duckLevel;
      if (rms <= 0.015) S.duckLevel = Math.min(1, S.duckLevel + 0.012);
      target = m.vol * S.duckLevel;
    }
    m.gainNode.gain.setTargetAtTime(target, S.actx.currentTime, 0.06);
  }

  function nextClip() {
    const i = S.activeIdx + 1;
    if (i >= S.clips.length) {
      S.time = S.total; pause();
      if (S.exporting) finishExport();
      return;
    }
    S.time = S.starts[i];
    enterClip(i, S.clips[i].in);
  }

  function advance(dt) {
    const c = S.clips[S.activeIdx];
    if (!c) { pause(); return; }
    const a = assetById(c.assetId), start = S.starts[S.activeIdx];
    if (a.kind === 'video') {
      const el = a.el;
      if (el.paused && !el.seeking && !el.ended) el.play().catch(() => {});
      const t = el.currentTime;
      S.time = start + clamp(t - c.in, 0, clipDur(c));
      if (t >= c.out - 0.03 || el.ended) nextClip();
    } else {
      S.time += dt;
      if (S.time >= start + clipDur(c)) nextClip();
    }
  }

  let lastNow = performance.now(), lastUi = '';
  function loop(now) {
    const dt = Math.min(0.1, (now - lastNow) / 1000); lastNow = now;
    if (R) {
      if (S.camera) {
        if (R.upload(S.camera.el)) R.draw(colorParams(), { fit: S.aspect === 'source' ? 'contain' : 'cover', scale: 1 }, S.raw);
      } else {
        if (S.playing) { advance(dt); syncMusic(false); }
        duckMusic();
        updateOverlay();
        const loc = locate(S.time);
        if (loc && loc.asset) {
          const el = loc.asset.el;
          if (S.playing || S.dirty || el !== S.lastEl) {
            const isStatic = el.tagName === 'IMG' && el === S.lastEl && R.hasFrame;
            const ok = isStatic || R.upload(el);
            if (ok) { S.lastEl = el; R.draw(colorParams(loc), framingFor(loc), S.raw); S.dirty = false; }
          }
        } else if (S.dirty) { R.clear(); S.lastEl = null; S.dirty = false; }
      }
    }
    // UI time readouts + playhead
    const ui = S.time.toFixed(2) + '|' + S.total.toFixed(2);
    if (ui !== lastUi) {
      lastUi = ui;
      const loc = locate(S.time);
      $('tcLeft').textContent = `${fmt(S.time)} / ${fmt(S.total)}`;
      $('tcRight').textContent = loc ? `${fmt(loc.src)} / ${fmt(loc.asset.duration)}` : '0:00.0 / 0:00.0';
      positionPlayhead();
      if (S.exporting) {
        const p = S.total ? S.time / S.total : 0;
        $('busyBar').style.width = (p * 100).toFixed(1) + '%';
        $('busyText').textContent = `Exporting WebM… ${Math.round(p * 100)}%  (${fmt(S.time)} / ${fmt(S.total)})`;
      }
    }
    requestAnimationFrame(loop);
  }

  /* global grade + optional per-clip offsets written by Match Shots */
  function colorParams(loc) {
    const p = { ...S.color, lutAmt: S.lutId === 'none' ? 0 : S.lutAmt };
    const adj = loc && loc.clip && loc.clip.adj;
    if (adj) {
      p.exposure = clamp(p.exposure + (adj.exposure || 0), -3, 3);
      p.temperature = clamp(p.temperature + (adj.temperature || 0), -1.5, 1.5);
      p.tint = clamp(p.tint + (adj.tint || 0), -1.5, 1.5);
      p.saturation = clamp(p.saturation * (adj.saturation || 1), 0, 2.5);
    }
    return p;
  }

  /* ---------------- text overlay (titles, lower thirds, captions) ---------------- */
  const ovCanvas = document.createElement('canvas');
  let ovKey = '';
  const TEXT_STYLES = { title: 'Title', lower: 'Lower third', caption: 'Caption', replace: 'Replaced text' };
  const STYLE_OPTS = Object.entries(TEXT_STYLES).filter(([k]) => k !== 'replace'); // replace items need a box; they have their own editor
  const BOX_FONTS = [['Arial, Helvetica, sans-serif', 'Sans'], ['Syne, sans-serif', 'Syne'], ['"Arial Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif', 'Condensed'], ['Impact, "Arial Black", sans-serif', 'Heavy'], ['Georgia, "Times New Roman", serif', 'Serif'], ['"Courier New", monospace', 'Mono']];
  function wrapLines(g, text, maxW) {
    const out = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? line + ' ' + word : word;
        if (g.measureText(test).width > maxW && line) { out.push(line); line = word; } else line = test;
      }
      out.push(line);
    }
    return out;
  }
  function drawText(g, t, W, H, slot = 0) {
    const u = Math.min(W, H) / 1080;
    g.save(); // items of the same style that overlap in time stack instead of drawing over each other
    if (slot) g.translate(0, (t.style === 'title' ? 1 : -1) * slot * Math.round(130 * u));
    g.textBaseline = 'alphabetic';
    if (t.style === 'replace') { drawBoxText(g, t, W, H); g.restore(); return; }
    if (t.style === 'title') {
      const fs = Math.round(96 * u * (W >= H ? 1 : 0.8));
      g.font = `700 ${fs}px Syne, sans-serif`; g.textAlign = 'center';
      const lines = wrapLines(g, t.text, W * 0.82), lh = fs * 1.12;
      let y = H / 2 - ((lines.length - 1) * lh) / 2 + fs * 0.35;
      g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 24 * u;
      g.fillStyle = '#E8E4DC';
      for (const l of lines) { g.fillText(l, W / 2, y); y += lh; }
      g.shadowBlur = 0;
    } else if (t.style === 'lower') {
      const fs = Math.round(44 * u), pad = 28 * u;
      g.font = `600 ${fs}px Syne, sans-serif`; g.textAlign = 'left';
      const lines = wrapLines(g, t.text, W * 0.6), lh = fs * 1.2;
      const bw = Math.max(...lines.map((l) => g.measureText(l).width)) + pad * 2, bh = lines.length * lh + pad * 1.4;
      const x = W * 0.06, y = H * 0.86 - bh;
      g.fillStyle = 'rgba(10,10,10,.78)'; g.fillRect(x, y, bw, bh);
      g.fillStyle = '#D4A017'; g.fillRect(x, y, 4 * u, bh);
      g.fillStyle = '#E8E4DC';
      lines.forEach((l, i) => g.fillText(l, x + pad, y + pad * 0.7 + fs + i * lh - fs * 0.1));
    } else {
      const fs = Math.round(46 * u * (W >= H ? 1 : 1.15)), padX = 22 * u, padY = 12 * u;
      g.font = `600 ${fs}px Syne, sans-serif`; g.textAlign = 'center';
      const lines = wrapLines(g, t.text, W * 0.8), lh = fs * 1.25;
      let y = H * (W >= H ? 0.9 : 0.78) - (lines.length - 1) * lh;
      for (const l of lines) {
        const w = g.measureText(l).width;
        g.fillStyle = 'rgba(10,10,10,.68)'; g.fillRect(W / 2 - w / 2 - padX, y - fs - padY * 0.2, w + padX * 2, fs + padY * 1.6);
        g.fillStyle = '#E8E4DC'; g.fillText(l, W / 2, y); y += lh;
      }
    }
    g.restore();
  }
  /* replacement text, fitted inside the box it replaces */
  function drawBoxText(g, t, W, H) {
    const b = t.box, text = String(t.text || '').trim(); if (!b || !text) return;
    const bw = b.w * W, bh = b.h * H, lines = text.split('\n');
    const font = (fs) => `${t.weight || 700} ${fs}px ${t.font || BOX_FONTS[0][0]}`;
    let fs = Math.min((bh / lines.length) * 0.74 / 1.1, t.size ? t.size * H : Infinity);
    g.font = font(fs);
    const widest = Math.max(...lines.map((l) => g.measureText(l).width));
    if (widest > bw * 0.98) fs *= (bw * 0.98) / widest;
    fs = Math.max(4, fs); g.font = font(fs);
    g.fillStyle = t.color || '#111111'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const lh = fs * 1.1, cy = b.y * H + bh / 2;
    lines.forEach((l, i) => g.fillText(l, b.x * W + bw / 2, cy + (i - (lines.length - 1) / 2) * lh + fs * 0.04));
  }
  function updateOverlay(force) {
    if (!R) return;
    const vis = S.texts.filter((t) => S.time >= t.start && S.time < t.end);
    const key = vis.map((t) => t.id + t.style + t.text + (t.box ? JSON.stringify([t.box, t.color, t.font, t.weight]) : '')).join('|') + '@' + canvas.width + 'x' + canvas.height;
    if (key === ovKey && !force) return;
    ovKey = key; S.dirty = true;
    R.setCovers(vis.filter((t) => t.style === 'replace' && t.box).map((t) => t.box));
    if (!vis.some((t) => t.style !== 'replace' || String(t.text || '').trim())) { R.setOverlay(null); return; }
    ovCanvas.width = canvas.width; ovCanvas.height = canvas.height;
    const g = ovCanvas.getContext('2d');
    g.clearRect(0, 0, ovCanvas.width, ovCanvas.height);
    const slots = {};
    for (const t of vis) { const k = t.style === 'replace' ? 0 : (slots[t.style] = (slots[t.style] ?? -1) + 1); drawText(g, t, ovCanvas.width, ovCanvas.height, k); }
    R.setOverlay(ovCanvas);
  }
  if (document.fonts && document.fonts.load) {
    Promise.all(['700 48px Syne', '600 48px Syne'].map((f) => document.fonts.load(f))).then(() => { ovKey = ''; }).catch(() => {});
  }

  /* ---------------- history ---------------- */
  function snapshot() { return JSON.stringify({ clips: S.clips, texts: S.texts }); }
  function pushHistory() { S.history.push(snapshot()); if (S.history.length > 150) S.history.shift(); S.future = []; }
  function restore(json) {
    const snap = JSON.parse(json);
    S.clips = snap.clips.filter((c) => assetById(c.assetId));
    S.texts = snap.texts || [];
    if (S.selText && !S.texts.find((t) => t.id === S.selText)) S.selText = null;
    if (S.selected && !S.clips.find((c) => c.id === S.selected)) S.selected = null;
    afterEdit();
  }
  function undo() { if (!S.history.length) return toast('Nothing to undo'); S.future.push(snapshot()); restore(S.history.pop()); setStatus('Undo'); }
  function redo() { if (!S.future.length) return toast('Nothing to redo'); S.history.push(snapshot()); restore(S.future.pop()); setStatus('Redo'); }

  function afterEdit() {
    layout();
    S.time = clamp(S.time, 0, S.total);
    updateCanvasSize();
    if (S.clips.length) seek(S.time); else { pause(); S.activeIdx = -1; S.dirty = true; }
    $('empty').hidden = !!(S.clips.length || S.camera);
    renderTimeline();
  }

  /* ---------------- import ---------------- */
  function kindOf(file) {
    if (file.type.startsWith('video/')) return 'video';
    if (file.type.startsWith('image/')) return 'image';
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'].includes(ext)) return 'video';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) return 'image';
    return null;
  }

  function waitEvent(el, ev, ms = 15000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('Timed out loading media')), ms);
      el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
      el.addEventListener('error', () => { clearTimeout(t); rej(new Error('Unsupported or corrupt media')); }, { once: true });
    });
  }

  async function fixDuration(el, hint) {
    if (isFinite(el.duration) && el.duration > 0) return el.duration;
    // MediaRecorder WebM files often report Infinity until seeked to the end
    await new Promise((res) => {
      const done = () => { el.removeEventListener('durationchange', check); clearTimeout(to); res(); };
      const check = () => { if (isFinite(el.duration)) done(); };
      const to = setTimeout(done, 4000);
      el.addEventListener('durationchange', check);
      el.currentTime = 1e7;
    });
    el.currentTime = 0;
    return isFinite(el.duration) && el.duration > 0 ? el.duration : (hint || 1);
  }

  async function loadAsset(file, opts = {}) {
    const kind = kindOf(file);
    if (!kind) throw new Error(`${file.name}: unsupported file type`);
    const url = URL.createObjectURL(file);
    const a = { id: uid(), name: file.name, kind, file, url, frames: [], sceneCuts: [], silences: [], peaks: null };
    if (kind === 'video') {
      const el = document.createElement('video');
      el.preload = 'auto'; el.playsInline = true; el.crossOrigin = 'anonymous'; el.src = url;
      await waitEvent(el, 'loadedmetadata');
      if (!el.videoWidth) throw new Error(`${file.name}: no video track (audio-only files aren't supported)`);
      a.duration = await fixDuration(el, opts.durationHint);
      a.width = el.videoWidth; a.height = el.videoHeight; a.el = el;
      if (opts.screen) a.screen = true;
      el.addEventListener('seeked', () => { S.dirty = true; });
      el.addEventListener('loadeddata', () => { S.dirty = true; });
      if (el.readyState < 2) await waitEvent(el, 'loadeddata').catch(() => {});
    } else {
      const img = new Image(); img.src = url;
      await img.decode().catch(() => { throw new Error(`${file.name}: could not decode image`); });
      a.duration = IMAGE_DURATION; a.width = img.naturalWidth; a.height = img.naturalHeight; a.el = img;
      a.frames = [{ t: 0, img }];
      a.thumb = thumbFrom(img, a.width, a.height);
    }
    return a;
  }

  function thumbFrom(src, w, h) {
    const c = document.createElement('canvas'); c.width = 128; c.height = 72;
    const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 128, 72);
    const k = Math.max(128 / w, 72 / h); const dw = w * k, dh = h * k;
    g.drawImage(src, (128 - dw) / 2, (72 - dh) / 2, dw, dh);
    return c.toDataURL('image/jpeg', 0.75);
  }

  async function buildFilmstrip(a) {
    if (a.kind !== 'video') return;
    const n = clamp(Math.round(a.duration / 2), 6, 24);
    const times = Array.from({ length: n }, (_, i) => (i + 0.5) * a.duration / n);
    const w = 160, h = Math.max(40, Math.round(160 * a.height / a.width));
    const frames = [];
    try {
      await Analysis.sampleFrames(a.url, times, (img, t) => {
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        c.getContext('2d').putImageData(img, 0, 0); frames.push({ t, img: c });
      }, { w, h: Math.min(h, 160) });
    } catch (e) { console.warn('filmstrip', e); }
    a.frames = frames;
    if (frames.length) {
      a.thumb = thumbFrom(frames[Math.min(1, frames.length - 1)].img, frames[0].img.width, frames[0].img.height);
      if (!lutSwatchFromFrame) { lutSwatchFromFrame = frames[Math.floor(frames.length / 2)].img; renderLutGrid(); }
    }
    renderAssets(); renderTimeline();
  }

  async function importFiles(files, opts = {}) {
    files = Array.from(files || []);
    if (!files.length) return;
    if (S.exporting) return toast('Finish or cancel the export first', true);
    const wasEmpty = !S.clips.length;
    const added = [];
    setStatus(`Importing ${files.length} file${files.length > 1 ? 's' : ''}…`);
    for (const f of files) {
      try { const a = await loadAsset(f, opts); S.assets.push(a); attachAudio(a); added.push(a); }
      catch (e) { toast(e.message, true); console.error(e); }
    }
    if (!added.length) { setStatus('Ready'); return; }
    if (S.actx) ensureAudio();
    pushHistory();
    for (const a of added) S.clips.push({ id: uid(), assetId: a.id, in: 0, out: a.duration, reframe: null });
    renderAssets();
    afterEdit();
    if (wasEmpty) { fitZoom(); seek(0); }
    setStatus(`Imported ${added.length} asset${added.length > 1 ? 's' : ''}`);
    toast(`Added ${added.map((a) => a.name).join(', ')} to the timeline`);
    for (const a of added) buildFilmstrip(a);
  }

  function addAssetToTimeline(id, index) {
    const a = assetById(id); if (!a) return;
    pushHistory();
    const clip = { id: uid(), assetId: a.id, in: 0, out: a.duration, reframe: null };
    if (index == null || index > S.clips.length) S.clips.push(clip); else S.clips.splice(index, 0, clip);
    S.selected = clip.id;
    afterEdit();
  }

  function removeAsset(id) {
    const a = assetById(id); if (!a) return;
    pushHistory();
    S.clips = S.clips.filter((c) => c.assetId !== id);
    if (a.kind === 'video') { a.el.pause(); a.el.removeAttribute('src'); a.el.load(); }
    S.assets = S.assets.filter((x) => x !== a);
    URL.revokeObjectURL(a.url);
    S.history = S.history.filter((h) => !h.includes(`"assetId":"${id}"`));
    renderAssets(); afterEdit();
  }

  /* ---------------- asset panel ---------------- */
  function renderAssets() {
    const list = $('assetList'); list.innerHTML = '';
    $('assetCount').textContent = S.assets.length;
    for (const a of S.assets) {
      const row = document.createElement('div'); row.className = 'asset'; row.draggable = true;
      row.title = 'Double-click or + to add to timeline · drag onto the timeline';
      row.innerHTML = `${a.thumb ? `<img alt="">` : '<div class="ph"></div>'}<div class="meta"><div class="name"></div><div class="sub"></div></div><div><button class="add" title="Add to timeline">＋</button><button class="x" title="Remove asset">✕</button></div>`;
      if (a.thumb) row.querySelector('img').src = a.thumb;
      row.querySelector('.name').textContent = a.name;
      row.querySelector('.sub').textContent = `${a.kind === 'video' ? 'VID' : 'IMG'} · ${fmt(a.duration)} · ${a.width}×${a.height}`;
      row.querySelector('.add').onclick = (e) => { e.stopPropagation(); addAssetToTimeline(a.id); };
      row.querySelector('.x').onclick = (e) => { e.stopPropagation(); removeAsset(a.id); };
      row.ondblclick = () => addAssetToTimeline(a.id);
      row.ondragstart = (e) => { e.dataTransfer.setData('text/x-kutlabz-asset', a.id); e.dataTransfer.effectAllowed = 'copy'; };
      list.appendChild(row);
    }
  }

  /* ---------------- timeline ---------------- */
  const tlScroll = $('tlScroll'), tlInner = $('tlInner'), track = $('track'), ruler = $('ruler'), playhead = $('playhead');
  const ppsFromZoom = (z) => 4 * Math.pow(100, z);
  const zoomFromPps = (p) => clamp(Math.log(p / 4) / Math.log(100), 0, 1);
  const xToTime = (clientX) => clamp((clientX - tlInner.getBoundingClientRect().left - PAD) / S.pps, 0, S.total);

  function fitZoom() {
    const avail = tlScroll.clientWidth - PAD * 2 - 20;
    if (S.total > 0) { S.pps = clamp(avail / S.total, 4, 400); $('zoom').value = zoomFromPps(S.pps); }
    renderTimeline();
    tlScroll.scrollLeft = 0;
  }

  function renderTimeline() {
    const width = Math.max(tlScroll.clientWidth, PAD * 2 + S.total * S.pps + 200);
    tlInner.style.width = width + 'px';
    track.innerHTML = '';
    const th = track.clientHeight - 8;
    S.clips.forEach((c, i) => {
      const a = assetById(c.assetId); if (!a) return;
      const x = PAD + S.starts[i] * S.pps, w = Math.max(2, clipDur(c) * S.pps);
      const el = document.createElement('div');
      el.className = 'clip' + (c.id === S.selected ? ' sel' : '');
      el.style.left = x + 'px'; el.style.width = w + 'px';
      el.dataset.id = c.id;
      const strip = document.createElement('canvas'); strip.className = 'strip';
      el.appendChild(strip);
      drawStrip(strip, c, a, w, th);
      const label = document.createElement('div'); label.className = 'label';
      const tags = [];
      if (c.reframe) tags.push({ stab: 'STAB', zoom: 'ZOOM' }[c.reframe.kind] || 'REFRAME');
      if (c.adj) tags.push('MATCH');
      if (c.gain && Math.abs(c.gain - 1) > 0.01) { const db = 20 * Math.log10(c.gain); tags.push((db >= 0 ? '+' : '') + db.toFixed(1) + ' dB'); }
      if (c.enhance) tags.push('VOICE');
      if (a.screen) tags.unshift('SCREEN');
      label.textContent = [a.name, fmt(clipDur(c)), ...tags].join(' · ');
      el.appendChild(label);
      for (const z of a.silences) {
        const s = Math.max(z.start, c.in), e = Math.min(z.end, c.out);
        if (e - s <= 0.01) continue;
        const zd = document.createElement('div'); zd.className = 'zone';
        zd.style.left = (s - c.in) * S.pps + 'px'; zd.style.width = (e - s) * S.pps + 'px';
        zd.title = `Silence ${fmt(s)}–${fmt(e)}`;
        el.appendChild(zd);
      }
      for (const z of a.dead || []) {
        const s = Math.max(z.start, c.in), e = Math.min(z.end, c.out);
        if (e - s <= 0.01) continue;
        const zd = document.createElement('div'); zd.className = 'zone dead';
        zd.style.left = (s - c.in) * S.pps + 'px'; zd.style.width = (e - s) * S.pps + 'px';
        zd.title = `${z.kind === 'black' ? 'Black' : 'Frozen'} frames ${fmt(s)}–${fmt(e)}`;
        el.appendChild(zd);
      }
      for (const t of a.sceneCuts) {
        if (t <= c.in + 0.02 || t >= c.out - 0.02) continue;
        const m = document.createElement('div'); m.className = 'marker';
        m.style.left = (t - c.in) * S.pps - 1 + 'px'; m.title = `Scene cut @ ${fmt(S.starts[i] + t - c.in)} — click to seek`;
        m.dataset.t = S.starts[i] + t - c.in;
        el.appendChild(m);
      }
      const hl = document.createElement('div'); hl.className = 'h l'; hl.dataset.edge = 'in';
      const hr = document.createElement('div'); hr.className = 'h r'; hr.dataset.edge = 'out';
      el.append(hl, hr);
      track.appendChild(el);
    });
    renderTextLane();
    renderMusicLane();
    drawRuler();
    positionPlayhead();
    updateCanvasSize();
  }

  const textLane = $('textLane'), musicLane = $('musicLane');
  function renderTextLane() {
    textLane.innerHTML = '';
    const rowEnd = [-1, -1]; // two rows: captions prefer row 2, everything else row 1, overlaps take the other row
    for (const t of S.texts) {
      const b = document.createElement('div');
      let row = t.style === 'caption' ? 1 : 0;
      if (t.start < rowEnd[row] - 1e-3 && t.start >= rowEnd[1 - row] - 1e-3) row = 1 - row;
      rowEnd[row] = Math.max(rowEnd[row], t.end);
      b.className = 'tblock ' + t.style + (row ? ' row2' : '') + (t.id === S.selText ? ' sel' : '');
      b.style.left = PAD + t.start * S.pps + 'px'; b.style.width = Math.max(4, (t.end - t.start) * S.pps) + 'px';
      b.textContent = t.style === 'replace' ? '⇄ ' + (t.text.trim() ? t.text.replace(/\n/g, ' ') : 'removed text') : t.text.replace(/\n/g, ' '); b.title = `${TEXT_STYLES[t.style]} · ${fmt(t.start)}–${fmt(t.end)} · double-click to edit, Del to remove`;
      b.dataset.id = t.id;
      textLane.appendChild(b);
    }
  }
  textLane.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.tblock'); if (!b || S.exporting) return;
    e.stopPropagation();
    const t = S.texts.find((x) => x.id === b.dataset.id); if (!t) return;
    S.selText = t.id; S.selected = null; seek(t.start + 0.001); renderTimeline();
  });
  textLane.addEventListener('dblclick', (e) => { const b = e.target.closest('.tblock'); if (b) editText(b.dataset.id); });

  function renderMusicLane() {
    const m = S.music;
    musicLane.hidden = !m;
    if (!m) return;
    musicLane.innerHTML = '';
    const wCss = Math.max(4, m.duration * S.pps);
    const cv = document.createElement('canvas'); cv.className = 'wave';
    const W = Math.min(16384, Math.round(wCss)), H = 30, k = W / wCss;
    cv.width = W; cv.height = H; cv.style.left = PAD + 'px'; cv.style.width = wCss + 'px';
    const g = cv.getContext('2d');
    g.fillStyle = '#141414'; g.fillRect(0, 0, W, H);
    if (m.peaks) {
      g.fillStyle = 'rgba(138,138,133,.75)';
      for (let px = 0; px < W; px++) { const v = m.peaks[Math.floor((px / k) / S.pps / 0.02)] || 0; const hh = Math.max(1, v * (H - 6)); g.fillRect(px, (H - hh) / 2, 1, hh); }
    }
    if (m.beats && S.pps * (m.beats[1] - m.beats[0] || 1) > 3) {
      g.fillStyle = 'rgba(232,228,220,.55)';
      m.beats.forEach((b, i) => g.fillRect(Math.round(b * S.pps * k), i % 4 ? H - 6 : 0, 1, i % 4 ? 6 : H));
    }
    const lab = document.createElement('div'); lab.className = 'mlabel';
    lab.innerHTML = '<span></span><button class="duck"></button><button class="x" title="Remove music">✕</button>';
    lab.querySelector('span').textContent = `${m.name}${m.bpm ? ` · ${m.bpm} BPM` : ''}`;
    const dk = lab.querySelector('.duck'); dk.textContent = m.duck ? 'Duck on' : 'Duck off'; dk.classList.toggle('on', m.duck);
    dk.title = 'Lower the music automatically while clip audio is playing';
    dk.onclick = (e) => { e.stopPropagation(); m.duck = !m.duck; renderMusicLane(); setStatus(`Auto duck ${m.duck ? 'on' : 'off'}`); };
    lab.querySelector('.x').onclick = (e) => { e.stopPropagation(); removeMusic(); };
    musicLane.append(cv, lab);
  }
  musicLane.addEventListener('pointerdown', (e) => { if (e.target.closest('button') || S.exporting) return; drag = { type: 'scrub' }; seek(xToTime(e.clientX)); });

  function drawStrip(cv, c, a, wCss, hCss) {
    const W = Math.min(4096, Math.max(1, Math.round(wCss))), H = Math.max(10, Math.round(hCss));
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d'); const sx = W / wCss;
    g.fillStyle = '#141414'; g.fillRect(0, 0, W, H);
    if (a.frames.length) {
      const f0 = a.frames[0].img, ar = (f0.naturalWidth || f0.width) / (f0.naturalHeight || f0.height);
      const tileW = H * ar;
      for (let x = 0; x < wCss; x += tileW) {
        const t = c.in + (x + tileW / 2) / S.pps;
        let best = a.frames[0], bd = Infinity;
        for (const f of a.frames) { const d = Math.abs(f.t - t); if (d < bd) { bd = d; best = f; } }
        g.drawImage(best.img, x * sx, 0, tileW * sx + 1, H);
      }
    }
    if (a.peaks) {
      g.fillStyle = 'rgba(232,228,220,.8)';
      const base = H - 3, amp = H * 0.38;
      for (let px = 0; px < W; px++) {
        const t = c.in + (px / sx) / S.pps;
        const v = a.peaks[Math.floor(t / 0.02)] || 0;
        const hh = Math.max(1, v * amp); g.fillRect(px, base - hh, 1, hh);
      }
    }
  }

  function niceStep(pps) {
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    return steps.find((s) => s * pps >= 70) || 3600;
  }
  function drawRuler() {
    const W = tlScroll.clientWidth, sl = tlScroll.scrollLeft;
    ruler.style.position = 'relative'; ruler.style.left = sl + 'px';
    ruler.width = W; ruler.style.width = W + 'px';
    const g = ruler.getContext('2d');
    g.clearRect(0, 0, W, 22);
    g.font = '10px "DM Mono", ui-monospace, monospace'; g.textBaseline = 'top';
    const step = niceStep(S.pps), minor = step / 5;
    const t0 = Math.max(0, (sl - PAD) / S.pps), t1 = (sl + W - PAD) / S.pps;
    for (let k = Math.floor(t0 / minor); k * minor <= t1; k++) {
      const t = Math.round(k * minor * 1000) / 1000;
      const x = Math.round(PAD + t * S.pps - sl) + 0.5;
      const major = k % 5 === 0;
      g.fillStyle = t > S.total + 1e-6 ? '#242424' : major ? '#8A8A85' : '#3a3a37';
      g.fillRect(x, major ? 10 : 15, 1, major ? 12 : 7);
      if (major) { g.fillStyle = t > S.total + 1e-6 ? '#3a3a37' : '#8A8A85'; g.fillText(step < 1 ? fmt(t) : fmt(t).replace(/\.0$/, ''), x + 3, 1); }
    }
  }
  function positionPlayhead() { playhead.style.left = PAD + S.time * S.pps + 'px'; }

  tlScroll.addEventListener('scroll', drawRuler);
  window.addEventListener('resize', () => { renderTimeline(); });
  $('zoom').addEventListener('input', (e) => {
    const center = (tlScroll.scrollLeft + tlScroll.clientWidth / 2 - PAD) / S.pps;
    S.pps = ppsFromZoom(+e.target.value); renderTimeline();
    tlScroll.scrollLeft = center * S.pps + PAD - tlScroll.clientWidth / 2;
  });
  $('btnFit').onclick = fitZoom;
  tlScroll.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const z = clamp(+$('zoom').value - e.deltaY * 0.0015, 0, 1);
    const tAt = xToTime(e.clientX);
    S.pps = ppsFromZoom(z); $('zoom').value = z; renderTimeline();
    tlScroll.scrollLeft = PAD + tAt * S.pps - (e.clientX - tlScroll.getBoundingClientRect().left);
  }, { passive: false });

  // --- timeline pointer interactions ---
  let drag = null;
  const touches = new Map(); let pinch = null;
  function onTrackDown(e) {
    if (e.button !== 0 || S.exporting) return;
    const marker = e.target.closest('.marker');
    if (marker) { e.stopPropagation(); seek(+marker.dataset.t); return; }
    const clipEl = e.target.closest('.clip');
    if (e.pointerType === 'touch') {
      if (pinch || touches.size > 1) return; // second finger: the pinch handler owns it
      const edgeT = e.target.dataset && e.target.dataset.edge;
      const tid = clipEl && clipEl.dataset.id;
      if (!edgeT && !(tid && tid === S.selected)) {
        // a finger on empty track or an unselected clip pans the timeline; a tap (no movement) selects / seeks
        drag = { type: 'pan', pid: e.pointerId, x0: e.clientX, sl0: tlScroll.scrollLeft, moved: false, tapClip: tid || null };
        return;
      }
    }
    if (!clipEl) { // scrub
      S.selected = null; S.selText = null; renderTimeline();
      drag = { type: 'scrub' }; seek(xToTime(e.clientX));
      return;
    }
    const id = clipEl.dataset.id, idx = S.clips.findIndex((c) => c.id === id), c = S.clips[idx];
    S.selected = id; S.selText = null;
    const edge = e.target.dataset.edge;
    if (edge) {
      pushHistory();
      drag = { type: 'trim', edge, id, x0: e.clientX, in0: c.in, out0: c.out, wasPlaying: S.playing };
      if (S.playing) pause();
    } else {
      drag = { type: 'move', id, idx, x0: e.clientX, moved: false, el: clipEl, startX: parseFloat(clipEl.style.left) };
    }
    renderTimeline();
    if (drag.type === 'move') drag.el = track.querySelector(`.clip[data-id="${id}"]`);
    e.preventDefault();
  }
  function onMove(e) {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, e.clientX);
    if (pinch && touches.size >= 2) {
      const [a, b] = [...touches.values()], d = Math.max(20, Math.abs(a - b));
      const z = clamp(pinch.z + Math.log(d / pinch.d) / Math.log(100), 0, 1);
      S.pps = ppsFromZoom(z); $('zoom').value = z; renderTimeline();
      tlScroll.scrollLeft = PAD + pinch.t * S.pps - (pinch.mid - tlScroll.getBoundingClientRect().left);
      return;
    }
    if (!drag) return;
    if (drag.type === 'pan') { if (e.pointerId !== drag.pid) return; const dx = e.clientX - drag.x0; if (Math.abs(dx) > 6) drag.moved = true; if (drag.moved) tlScroll.scrollLeft = drag.sl0 - dx; return; }
    if (drag.type === 'scrub') { seek(xToTime(e.clientX)); return; }
    const c = S.clips.find((x) => x.id === drag.id); if (!c) return;
    const a = assetById(c.assetId);
    if (drag.type === 'trim') {
      const dt = (e.clientX - drag.x0) / S.pps;
      if (drag.edge === 'in') c.in = clamp(drag.in0 + dt, 0, c.out - MIN_CLIP);
      else c.out = clamp(drag.out0 + dt, c.in + MIN_CLIP, a.kind === 'image' ? 600 : a.duration);
      layout(); renderTimeline();
      const idx = S.clips.indexOf(c);
      const edgeT = drag.edge === 'in' ? S.starts[idx] : S.starts[idx] + clipDur(c) - 0.001;
      seek(edgeT);
      setStatus(`Trim ${drag.edge === 'in' ? 'in' : 'out'}: ${fmt(drag.edge === 'in' ? c.in : c.out)} · duration ${fmt(clipDur(c))}`);
    } else if (drag.type === 'move') {
      const dx = e.clientX - drag.x0;
      if (!drag.moved && Math.abs(dx) < 4) return;
      drag.moved = true;
      drag.el.classList.add('dragging');
      drag.el.style.left = drag.startX + dx + 'px';
      const t = xToTime(e.clientX);
      let ins = S.clips.length;
      for (let i = 0; i < S.clips.length; i++) if (t < S.starts[i] + clipDur(S.clips[i]) / 2) { ins = i; break; }
      drag.ins = ins;
      let line = track.querySelector('.insert-line');
      if (!line) { line = document.createElement('div'); line.className = 'insert-line'; track.appendChild(line); }
      line.style.left = PAD + (ins < S.clips.length ? S.starts[ins] : S.total) * S.pps - 1 + 'px';
    }
  }
  function onUp(e) {
    const wasPinch = !!pinch;
    touches.delete(e.pointerId); if (touches.size < 2) pinch = null;
    if (wasPinch) { drag = null; return; } // lifting a finger after a pinch is not a tap
    if (!drag) return;
    if (drag.type === 'pan' && e.pointerId !== drag.pid) return;
    const d = drag; drag = null;
    if (d.type === 'pan') {
      if (!d.moved && e.type === 'pointerup') {
        if (d.tapClip) { S.selected = d.tapClip; S.selText = null; renderTimeline(); setStatus('Clip selected — drag it to move, drag its edges to trim'); }
        else { S.selected = null; S.selText = null; seek(xToTime(e.clientX)); renderTimeline(); }
      }
      return;
    }
    if (d.type === 'trim') { afterEdit(); setStatus('Trimmed clip'); if (d.wasPlaying) play(); }
    else if (d.type === 'move') {
      if (d.moved && d.ins != null) {
        let to = d.ins; const from = S.clips.findIndex((c) => c.id === d.id);
        if (to > from) to--;
        if (to !== from) { pushHistory(); const [c] = S.clips.splice(from, 1); S.clips.splice(to, 0, c); setStatus('Moved clip'); }
        afterEdit();
      } else if (!d.moved) seek(xToTime(e.clientX));
      else renderTimeline();
    }
  }
  track.addEventListener('pointerdown', onTrackDown);
  tlScroll.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    touches.set(e.pointerId, e.clientX);
    if (touches.size === 2) {
      const [a, b] = [...touches.values()], mid = (a + b) / 2;
      pinch = { d: Math.max(20, Math.abs(a - b)), z: +$('zoom').value, mid, t: xToTime(mid) };
      if (drag && drag.type === 'trim') afterEdit();
      drag = null;
    }
  }, true);
  ruler.addEventListener('pointerdown', (e) => { if (S.exporting) return; drag = { type: 'scrub' }; seek(xToTime(e.clientX)); e.preventDefault(); });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  // asset drag-in
  track.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-kutlabz-asset')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  track.addEventListener('drop', (e) => {
    const id = e.dataTransfer.getData('text/x-kutlabz-asset'); if (!id) return;
    e.preventDefault(); e.stopPropagation();
    const t = xToTime(e.clientX); let ins = S.clips.length;
    for (let i = 0; i < S.clips.length; i++) if (t < S.starts[i] + clipDur(S.clips[i]) / 2) { ins = i; break; }
    addAssetToTimeline(id, ins);
  });

  /* ---------------- edit operations ---------------- */
  function splitAt(t, select = true) {
    const loc = locate(t); if (!loc) return false;
    const c = loc.clip;
    if (loc.src - c.in < MIN_CLIP || c.out - loc.src < MIN_CLIP) return false;
    const b = { ...c, id: uid(), in: loc.src };
    c.out = loc.src;
    S.clips.splice(loc.i + 1, 0, b);
    if (select) S.selected = b.id;
    layout();
    return true;
  }
  function splitPlayhead() {
    if (!S.clips.length) return;
    pushHistory();
    if (splitAt(S.time)) { afterEdit(); setStatus(`Split at ${fmt(S.time)}`); }
    else { S.history.pop(); toast('Move the playhead inside a clip to split'); }
  }
  function deleteSelected() {
    if (S.selText) {
      pushHistory(); S.texts = S.texts.filter((t) => t.id !== S.selText); S.selText = null;
      ovKey = ''; renderTimeline(); setStatus('Deleted text'); return;
    }
    const i = S.clips.findIndex((c) => c.id === S.selected);
    if (i < 0) return toast('Select a clip first');
    pushHistory();
    S.clips.splice(i, 1);
    S.selected = S.clips[Math.min(i, S.clips.length - 1)]?.id || null;
    afterEdit(); setStatus('Deleted clip');
  }
  function splitAtCuts() {
    let n = 0; pushHistory();
    const next = [];
    for (const c of S.clips) {
      const a = assetById(c.assetId);
      const cuts = a.sceneCuts.filter((t) => t > c.in + MIN_CLIP && t < c.out - MIN_CLIP).sort((x, y) => x - y);
      let start = c.in;
      for (const t of cuts) { next.push({ ...c, id: uid(), in: start, out: t }); start = t; n++; }
      next.push({ ...c, id: start === c.in ? c.id : uid(), in: start, out: c.out });
    }
    if (!n) { S.history.pop(); return toast('No scene-cut markers inside clips — run Detect Scene Cuts first'); }
    S.clips = next; afterEdit(); toast(`Split at ${n} scene cut${n > 1 ? 's' : ''} — ${S.clips.length} clips now`);
  }

  $('btnSplit').onclick = splitPlayhead;
  $('btnSplitCuts').onclick = splitAtCuts;
  $('btnDelete').onclick = deleteSelected;
  $('btnUndo').onclick = undo;
  $('btnRedo').onclick = redo;
  $('btnClearMarks').onclick = () => { for (const a of S.assets) { a.sceneCuts = []; a.silences = []; } renderTimeline(); setStatus('Cleared markers'); };

  /* ---------------- tasks (busy overlay) ---------------- */
  async function runTask(label, fn) {
    if (S.busy) return toast('Another task is running');
    if (S.exporting) return toast('Wait for the export to finish', true);
    const ctl = new AbortController();
    S.busy = ctl;
    pause();
    $('busy').hidden = false; $('busy').classList.remove('light');
    $('busyText').textContent = label; $('busyBar').style.width = '0%';
    $('busyCancel').hidden = false; $('busyCancel').onclick = () => ctl.abort();
    document.querySelectorAll('.tool').forEach((b) => (b.disabled = true));
    setStatus(label);
    const progress = (p, text) => { $('busyBar').style.width = (clamp(p, 0, 1) * 100).toFixed(1) + '%'; if (text) $('busyText').textContent = text; };
    try { await fn(ctl.signal, progress); }
    catch (e) {
      if (e.name === 'AbortError') { toast('Cancelled'); setStatus('Cancelled'); }
      else { console.error(e); toast(e.message || String(e), true); setStatus('Error: ' + (e.message || e)); }
    } finally {
      S.busy = null; $('busy').hidden = true;
      document.querySelectorAll('.tool').forEach((b) => (b.disabled = false));
    }
  }

  function targetClips(videoOnly = true) {
    const sel = S.clips.filter((c) => c.id === S.selected);
    const list = sel.length ? sel : S.clips;
    return list.filter((c) => !videoOnly || assetById(c.assetId).kind === 'video');
  }
  function targetAssets() { return [...new Set(targetClips().map((c) => assetById(c.assetId)))]; }

  function grabCurrentFrame(w = 96, h = 54) {
    const loc = locate(S.time); if (!loc) return null;
    const el = loc.asset.el;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    try { g.drawImage(el, 0, 0, w, h); return g.getImageData(0, 0, w, h); } catch (e) { return null; }
  }

  /* ---------------- AI tools ---------------- */
  const tools = {
    autograde() {
      if (!S.clips.length) return toast('Import a video first');
      const img = grabCurrentFrame(128, 72); if (!img) return toast('Frame not ready yet — try again', true);
      const g = Analysis.autoGrade(img);
      Object.assign(S.color, g);
      syncControls(); S.dirty = true;
      const sgn = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
      toast(`Auto grade: exposure ${sgn(g.exposure)} · temp ${sgn(g.temperature)} · contrast ${g.contrast.toFixed(2)} · sat ${g.saturation.toFixed(2)}`);
      setStatus('Auto grade applied from current frame — fine-tune in Color Controls');
    },
    scenes() {
      const assets = targetAssets(); if (!assets.length) return toast('Import a video first');
      return runTask('Detecting scene cuts…', async (signal, progress) => {
        let total = 0;
        for (let k = 0; k < assets.length; k++) {
          const a = assets[k];
          a.sceneCuts = await Analysis.detectScenes(a.url, a.duration, { signal, onProgress: (p) => progress((k + p) / assets.length, `Analyzing ${a.name}… ${Math.round(p * 100)}%`) });
          total += a.sceneCuts.length;
        }
        renderTimeline();
        toast(total ? `Found ${total} scene cut${total > 1 ? 's' : ''} — click a marker to seek, “Split at cuts” (Shift+S) to cut at every marker` : 'No hard scene cuts detected');
        setStatus(`Scene detection: ${total} cut${total === 1 ? '' : 's'}`);
      });
    },
    silence() {
      const assets = targetAssets(); if (!assets.length) return toast('Import a video first');
      const actx = ensureAudio(); if (!actx) return toast('Web Audio is not supported', true);
      return runTask('Analyzing audio…', async (signal, progress) => {
        let zones = 0, secs = 0, noAudio = [];
        for (let k = 0; k < assets.length; k++) {
          const a = assets[k];
          progress(k / assets.length, `Decoding audio — ${a.name}`);
          const buf = await getAudioBuffer(a);
          if (!buf) { noAudio.push(a.name); continue; }
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          progress((k + 0.6) / assets.length, `Measuring RMS — ${a.name}`);
          await new Promise((r) => setTimeout(r, 0));
          const res = Analysis.detectSilence(buf);
          a.silences = res.zones; a.peaks = res.peaks; a.silenceThreshold = res.threshold;
          zones += res.zones.length; secs += res.zones.reduce((s, z) => s + z.end - z.start, 0);
        }
        renderTimeline();
        if (noAudio.length) toast(`No decodable audio in: ${noAudio.join(', ')}`, true);
        else toast(zones ? `Marked ${zones} silent zone${zones > 1 ? 's' : ''} (${secs.toFixed(1)}s) — “Cut Marked Zones” removes them` : 'No silences found');
        setStatus(`Silence detection: ${zones} zone${zones === 1 ? '' : 's'}, ${secs.toFixed(1)}s`);
      });
    },
    applysilence() {
      const zonesOf = (a) => [...a.silences, ...(a.dead || [])];
      if (!S.assets.some((a) => zonesOf(a).length)) return toast('Run “Detect Silence” or “Detect Dead Frames” first');
      pushHistory();
      let removed = 0; const next = [];
      for (const c of S.clips) {
        const a = assetById(c.assetId);
        const zs = zonesOf(a).filter((z) => z.end > c.in && z.start < c.out).sort((x, y) => x.start - y.start);
        if (!zs.length || (S.selected && S.selected !== c.id && S.clips.some((x) => x.id === S.selected))) { next.push(c); continue; }
        let cur = c.in; let first = true;
        for (const z of zs) {
          const s = Math.max(z.start, c.in), e = Math.min(z.end, c.out);
          if (s - cur >= MIN_CLIP) { next.push({ ...c, id: first ? c.id : uid(), in: cur, out: s }); first = false; }
          removed += e - Math.max(s, cur) > 0 ? e - Math.max(s, cur) : 0;
          cur = Math.max(cur, e);
        }
        if (c.out - cur >= MIN_CLIP) next.push({ ...c, id: first ? c.id : uid(), in: cur, out: c.out });
      }
      if (removed < 0.01) { S.history.pop(); return toast('No marked zones inside the current clips'); }
      S.clips = next; S.selected = null;
      afterEdit();
      toast(`Removed ${removed.toFixed(1)}s of marked zones — ${S.clips.length} clips now`);
      setStatus(`Cut marked zones (−${removed.toFixed(1)}s)`);
    },
    colormatch() {
      if (!S.clips.length) return toast('Import footage first, then pick a reference image');
      $('refInput').value = ''; $('refInput').click();
    },
    reframe() {
      const clips = targetClips(); if (!clips.length) return toast('Import a video first');
      pushHistory();
      return runTask('Smart reframe: tracking motion…', async (signal, progress) => {
        for (let k = 0; k < clips.length; k++) {
          const c = clips[k], a = assetById(c.assetId);
          const keys = await Analysis.trackMotion(a.url, c.in, c.out, { signal, onProgress: (p) => progress((k + p) / clips.length, `Tracking ${a.name} (${k + 1}/${clips.length})… ${Math.round(p * 100)}%`) });
          const sameAspect = S.aspect === 'source';
          c.reframe = { scale: sameAspect ? 1.35 : 1.0, keys };
        }
        afterEdit();
        toast(`Reframed ${clips.length} clip${clips.length > 1 ? 's' : ''}${S.aspect === 'source' ? ' (1.35× punch-in)' : ` to ${S.aspect}`} following the motion center`);
        setStatus('Smart reframe applied');
      }).then(() => { if (!clips.some((c) => c.reframe)) S.history.pop(); });
    },
    resetframe() {
      const clips = targetClips(false).filter((c) => c.reframe);
      if (!clips.length) return toast('No reframed clips');
      pushHistory(); clips.forEach((c) => (c.reframe = null)); afterEdit();
      setStatus('Framing reset');
    },
  };
  /* ---------------- shared helpers for the extended toolset ---------------- */
  async function getAudioBuffer(a) {
    if (a.audioBuf !== undefined) return a.audioBuf;
    const actx = ensureAudio(); if (!actx) return null;
    let buf = null;
    try { buf = await actx.decodeAudioData(await a.file.arrayBuffer()); } catch (e) { buf = null; }
    if (!buf || a.duration < 1200) a.audioBuf = buf; // cache decoded PCM for clips up to 20 min
    return buf;
  }
  async function clipFrame(c, w = 96, h = 54, signal) {
    const a = assetById(c.assetId);
    if (a.kind === 'image') {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(a.el, 0, 0, w, h);
      return g.getImageData(0, 0, w, h);
    }
    let out = null;
    await Analysis.sampleFrames(a.url, [c.in + clipDur(c) / 2], (img) => { out = img; }, { w, h, signal });
    return out;
  }
  async function frameReady() {
    const loc = locate(S.time); if (!loc) return;
    const el = loc.asset.el;
    if (el.tagName === 'VIDEO') {
      if (el.seeking) await new Promise((r) => el.addEventListener('seeked', r, { once: true }));
      if (el.readyState < 2) await new Promise((r) => el.addEventListener('loadeddata', r, { once: true }));
    }
    await new Promise((r) => requestAnimationFrame(() => r()));
  }
  const checkAbort = (signal) => { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); };

  /* ---------------- dialog ---------------- */
  let dlgOpen = false, dlgClose = null;
  function dialog({ title, fields = [], ok = 'OK', note }) {
    return new Promise((resolve) => {
      const box = $('dlg'), body = $('dlgBody'), form = $('dlgForm');
      $('dlgTitle').textContent = title; $('dlgOk').textContent = ok;
      body.innerHTML = '';
      if (note) { const p = document.createElement('p'); p.className = 'dlg-note'; p.textContent = note; body.appendChild(p); }
      const inputs = {};
      for (const f of fields) {
        const lab = document.createElement('label'); lab.className = 'dlg-field';
        const sp = document.createElement('span'); sp.textContent = f.label; lab.appendChild(sp);
        let inp;
        if (f.type === 'select') {
          inp = document.createElement('select');
          for (const [v, t] of f.options) { const o = document.createElement('option'); o.value = v; o.textContent = t; inp.appendChild(o); }
        } else if (f.type === 'textarea') { inp = document.createElement('textarea'); inp.rows = f.rows || 3; }
        else { inp = document.createElement('input'); inp.type = f.type || 'text'; if (f.step) inp.step = f.step; if (f.min != null) inp.min = f.min; }
        inp.value = f.value ?? '';
        lab.appendChild(inp); body.appendChild(lab); inputs[f.k] = inp;
      }
      const close = (v) => { box.hidden = true; dlgOpen = false; dlgClose = null; form.onsubmit = null; $('dlgCancel').onclick = null; resolve(v); };
      form.onsubmit = (e) => {
        e.preventDefault();
        const out = {}; for (const f of fields) out[f.k] = f.type === 'number' ? +inputs[f.k].value : inputs[f.k].value;
        close(out);
      };
      $('dlgCancel').onclick = () => close(null);
      dlgClose = () => close(null);
      box.hidden = false; dlgOpen = true;
      const first = body.querySelector('textarea, input, select'); if (first) setTimeout(() => first.focus(), 0);
    });
  }

  /* ---------------- text items ---------------- */
  async function editText(id) {
    const t = S.texts.find((x) => x.id === id); if (!t) return;
    if (t.style === 'replace') return editReplace(t);
    const v = await dialog({
      title: 'Edit text', ok: 'Save',
      fields: [
        { k: 'text', label: 'Text', type: 'textarea', value: t.text },
        { k: 'style', label: 'Style', type: 'select', options: STYLE_OPTS, value: t.style },
        { k: 'start', label: 'Start (s)', type: 'number', step: 0.01, min: 0, value: t.start },
        { k: 'end', label: 'End (s)', type: 'number', step: 0.01, min: 0, value: t.end },
      ],
    });
    if (!v || !v.text.trim()) return;
    pushHistory();
    Object.assign(t, { text: v.text.trim(), style: v.style, start: Math.max(0, v.start), end: Math.max(Math.max(0, v.start) + 0.2, v.end) });
    S.texts.sort((a, b) => a.start - b.start);
    ovKey = ''; renderTimeline(); setStatus('Text updated');
  }
  /* ---------------- replace text burned into the video ---------------- */
  // Drag a box on the preview. Returns {x, y, w, h} in 0..1 of the output frame, or null.
  function pickRegion(hint) {
    return new Promise((resolve) => {
      const view = canvas, stage = $('stage');
      const ov = document.createElement('div'); ov.className = 'pick';
      ov.innerHTML = '<div class="pick-bar"><span></span><button class="btn small">Cancel</button></div><div class="pick-box" hidden></div>';
      ov.querySelector('span').textContent = hint;
      const place = () => { const r = view.getBoundingClientRect(), s = stage.getBoundingClientRect(); Object.assign(ov.style, { left: r.left - s.left + 'px', top: r.top - s.top + 'px', width: r.width + 'px', height: r.height + 'px' }); };
      place(); stage.appendChild(ov);
      const boxEl = ov.querySelector('.pick-box');
      let a = null, cur = null;
      const pt = (e) => { const r = ov.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) }; };
      const rect = () => ({ x: Math.min(a.x, cur.x), y: Math.min(a.y, cur.y), w: Math.abs(cur.x - a.x), h: Math.abs(cur.y - a.y) });
      const done = (v) => { ov.remove(); window.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', place); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(null); } };
      window.addEventListener('keydown', onKey, true); window.addEventListener('resize', place);
      ov.querySelector('button').onclick = (e) => { e.stopPropagation(); done(null); };
      ov.addEventListener('pointerdown', (e) => { if (e.target.closest('.pick-bar button')) return; ov.setPointerCapture(e.pointerId); a = cur = pt(e); boxEl.hidden = false; ov.classList.add('dragging'); });
      ov.addEventListener('pointermove', (e) => { if (!a) return; cur = pt(e); const r = rect(); Object.assign(boxEl.style, { left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%' }); });
      ov.addEventListener('pointerup', () => {
        if (!a) return; const r = rect(), br = ov.getBoundingClientRect(); a = null; ov.classList.remove('dragging');
        if (r.w * br.width < 8 || r.h * br.height < 6) { boxEl.hidden = true; return toast('Drag a box around the text'); }
        done(r);
      });
    });
  }
  // Read the rendered frame inside a box: tighten it to the text it contains and pick up the text colour.
  function inspectRegion(box) {
    const W = canvas.width, H = canvas.height, pad = 4;
    const x0 = clamp(Math.floor(box.x * W) - pad, 0, W - 1), y0 = clamp(Math.floor(box.y * H) - pad, 0, H - 1);
    const x1 = clamp(Math.ceil((box.x + box.w) * W) + pad, x0 + 1, W), y1 = clamp(Math.ceil((box.y + box.h) * H) + pad, y0 + 1, H);
    const w = x1 - x0, h = y1 - y0;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    try { g.drawImage(canvas, x0, y0, w, h, 0, 0, w, h); } catch (e) { return { box, color: '#111111' }; }
    const d = g.getImageData(0, 0, w, h).data;
    const med = (arr) => { arr.sort((p, q) => p - q); return arr[arr.length >> 1]; };
    // expected background at each pixel: the same edge interpolation (Coons patch) the renderer uses to erase
    const px = (x, y, k) => d[(y * w + x) * 4 + k];
    const edge = (x0, y0, x1, y1, k) => (px(x0, y0, k) + px(x1, y1, k)) / 2;
    const bgAt = (x, y, k) => {
      const u = w > 1 ? x / (w - 1) : 0, v = h > 1 ? y / (h - 1) : 0;
      const T = edge(x, 0, x, 1, k), B = edge(x, h - 1, x, h - 2, k), L = edge(0, y, 1, y, k), Rr = edge(w - 1, y, w - 2, y, k);
      const TL = px(0, 0, k), TR = px(w - 1, 0, k), BL = px(0, h - 1, k), BR = px(w - 1, h - 1, k);
      return (1 - v) * T + v * B + (1 - u) * L + u * Rr - ((1 - u) * (1 - v) * TL + u * (1 - v) * TR + (1 - u) * v * BL + u * v * BR);
    };
    let minX = w, minY = h, maxX = -1, maxY = -1; const ink = [];
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = (y * w + x) * 4, dist = Math.abs(d[i] - bgAt(x, y, 0)) + Math.abs(d[i + 1] - bgAt(x, y, 1)) + Math.abs(d[i + 2] - bgAt(x, y, 2));
      if (dist < 60) continue;
      ink.push([dist, d[i], d[i + 1], d[i + 2]]);
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (ink.length < 12) return { box, color: '#111111', found: false };
    ink.sort((p, q) => q[0] - p[0]);
    const core = ink.slice(0, Math.max(6, ink.length >> 2)); // the most distinct pixels are the text's fill, not its antialiased edge
    const color = '#' + [1, 2, 3].map((k) => Math.round(med(core.map((p) => p[k]))).toString(16).padStart(2, '0')).join('');
    const th = maxY - minY + 1, m = Math.max(3, Math.round(th * 0.22)); // margin for glow, shadow and antialiasing
    const size = (th / 0.72) / H; // font size that gives the original's letter height (capitals ≈ 0.72 em)
    const bx0 = clamp(x0 + minX - m, 0, W), by0 = clamp(y0 + minY - m, 0, H), bx1 = clamp(x0 + maxX + 1 + m, 0, W), by1 = clamp(y0 + maxY + 1 + m, 0, H);
    return { box: { x: bx0 / W, y: by0 / H, w: (bx1 - bx0) / W, h: (by1 - by0) / H }, color, size, found: true };
  }
  // How long the original text stays on screen: compare the box against the frame under the playhead.
  async function textSpan(box, signal) {
    const loc = locate(S.time); if (!loc) return null;
    const i = S.clips.indexOf(loc.clip), c = loc.clip, a = loc.asset, clipStart = S.starts[i], full = { start: clipStart, end: clipStart + clipDur(c) };
    if (a.kind !== 'video' || !R.lastRect) return full;
    const [rx, ry, rw, rh] = R.lastRect;
    const mb = { x: rx + box.x * rw, y: ry + box.y * rh, w: box.w * rw, h: box.h * rh };
    const sw = clamp(Math.round(24 / Math.max(mb.h, 0.005)), 320, 960), sh = Math.max(2, Math.round(sw * a.height / a.width));
    const px = { x: clamp(Math.floor(mb.x * sw), 0, sw - 2), y: clamp(Math.floor(mb.y * sh), 0, sh - 2) };
    px.w = clamp(Math.ceil(mb.w * sw), 2, sw - px.x); px.h = clamp(Math.ceil(mb.h * sh), 2, sh - px.y);
    const dur = clipDur(c), step = Math.max(0.2, dur / 240), times = [];
    for (let t = c.in; t < c.out; t += step) times.push(t);
    let refIdx = 0; times.forEach((t, k) => { if (Math.abs(t - loc.src) < Math.abs(times[refIdx] - loc.src)) refIdx = k; });
    const lumas = [];
    await Analysis.sampleFrames(a.url, times, (img) => {
      const out = new Float32Array(px.w * px.h);
      for (let y = 0; y < px.h; y++) for (let x = 0; x < px.w; x++) { const j = ((px.y + y) * sw + px.x + x) * 4; out[y * px.w + x] = img.data[j] * 0.2126 + img.data[j + 1] * 0.7152 + img.data[j + 2] * 0.0722; }
      lumas.push(out);
    }, { w: sw, h: sh, signal });
    const stats = (v) => { let m = 0; for (const x of v) m += x; m /= v.length; let s2 = 0; for (const x of v) s2 += (x - m) ** 2; return { m, s: Math.sqrt(s2 / v.length) }; };
    const ref = lumas[refIdx], rs = stats(ref);
    if (rs.s < 4) return full; // nothing distinct under the box at the playhead
    const present = lumas.map((v) => { const vs = stats(v); if (vs.s < rs.s * 0.25) return false; let cov = 0; for (let k = 0; k < v.length; k++) cov += (v[k] - vs.m) * (ref[k] - rs.m); return cov / v.length / (vs.s * rs.s) > 0.5; });
    let lo = refIdx, hi = refIdx;
    while (lo > 0 && present[lo - 1]) lo--;
    while (hi < times.length - 1 && present[hi + 1]) hi++;
    const start = lo === 0 ? full.start : clipStart + times[lo] - c.in - step / 2;
    const end = hi === times.length - 1 ? full.end : clipStart + times[hi] - c.in + step / 2;
    return { start: +Math.max(full.start, start).toFixed(3), end: +Math.min(full.end, end).toFixed(3) };
  }
  function replaceFields(t) {
    return [
      { k: 'text', label: 'New text (leave empty to just remove the original)', type: 'textarea', rows: 2, value: t.text || '' },
      { k: 'font', label: 'Font', type: 'select', options: BOX_FONTS, value: t.font || BOX_FONTS[0][0] },
      { k: 'weight', label: 'Weight', type: 'select', options: [['400', 'Regular'], ['600', 'Semibold'], ['700', 'Bold'], ['900', 'Black']], value: String(t.weight || 700) },
      { k: 'color', label: 'Colour (picked from the original)', type: 'color', value: t.color || '#111111' },
      { k: 'start', label: 'From (s)', type: 'number', step: 0.01, min: 0, value: t.start },
      { k: 'end', label: 'To (s)', type: 'number', step: 0.01, min: 0, value: t.end },
    ];
  }
  function applyReplaceValues(t, v) {
    Object.assign(t, { text: v.text.trim(), font: v.font, weight: +v.weight || 700, color: v.color, start: Math.max(0, v.start), end: Math.max(Math.max(0, v.start) + 0.1, v.end) });
  }
  async function editReplace(t) {
    const v = await dialog({ title: 'Replace text', ok: 'Save', fields: replaceFields(t), note: 'To move the box, delete this item and use Replace Text again.' });
    if (!v) return;
    pushHistory(); applyReplaceValues(t, v); S.texts.sort((a, b) => a.start - b.start);
    ovKey = ''; renderTimeline(); setStatus(t.text ? `Text replaced with "${t.text}"` : 'Text removed');
  }
  async function replaceText(opts = {}) {
    if (!S.clips.length) return toast('Import a video first');
    if (S.busy || S.exporting) return toast('Wait for the current task to finish');
    pause();
    let box = opts.box;
    if (!box) {
      box = await pickRegion('Drag a box around the text you want to replace');
      if (!box) return;
    }
    await frameReady();
    const res = inspectRegion(box);
    let span = null;
    await runTask('Finding when that text is on screen…', async (signal, progress) => {
      progress(0.1);
      try { span = await textSpan(res.box, signal); } catch (e) { if (e.name === 'AbortError') throw e; span = null; }
    });
    const loc = locate(S.time), idx = loc ? S.clips.indexOf(loc.clip) : 0;
    span = span || { start: S.starts[idx] || 0, end: (S.starts[idx] || 0) + (loc ? clipDur(loc.clip) : 3) };
    const draft = { id: uid(), style: 'replace', text: opts.text ?? '', box: res.box, color: opts.color || res.color, font: opts.font || BOX_FONTS[0][0], weight: opts.weight || 700, size: res.size || null, start: span.start, end: span.end };
    // preview the clean-up while the dialog is open
    S.texts.push(draft); ovKey = ''; S.dirty = true;
    let v = opts.text != null ? { text: opts.text, font: draft.font, weight: draft.weight, color: draft.color, start: draft.start, end: draft.end } : null;
    if (!v) v = await dialog({ title: 'Replace text', ok: 'Replace', fields: replaceFields(draft), note: `${res.found ? 'Box fitted to the text' : 'No clear text found in the box — it will be covered as drawn'} · on screen ${fmt(span.start)}–${fmt(span.end)}.` });
    S.texts = S.texts.filter((t) => t !== draft);
    if (!v) { ovKey = ''; S.dirty = true; return; }
    pushHistory(); applyReplaceValues(draft, v);
    S.texts.push(draft); S.texts.sort((a, b) => a.start - b.start); S.selText = draft.id;
    ovKey = ''; renderTimeline();
    setStatus(draft.text ? `Replaced text with "${draft.text}" (${fmt(draft.start)}–${fmt(draft.end)}) — double-click ⇄ on the text lane to edit` : `Removed text (${fmt(draft.start)}–${fmt(draft.end)})`);
    return draft;
  }

  function parseSubs(raw) {
    const txt = raw.replace(/\r/g, '').replace(/^﻿/, '');
    const re = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})[^\n]*\n([\s\S]*?)(?=\n[ \t]*\n|$)/g;
    const sec = (h, m, s, ms) => (h ? +h : 0) * 3600 + +m * 60 + +s + +ms.padEnd(3, '0') / 1000;
    const out = []; let m;
    while ((m = re.exec(txt))) {
      const text = m[9].replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
      if (!text) continue;
      const start = sec(m[1], m[2], m[3], m[4]), end = sec(m[5], m[6], m[7], m[8]);
      if (end > start) out.push({ id: uid(), text, style: 'caption', start: +start.toFixed(3), end: +end.toFixed(3) });
    }
    return out;
  }
  $('srtInput').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const items = parseSubs(await f.text());
      if (!items.length) throw new Error('no cues found');
      pushHistory();
      S.texts = S.texts.filter((t) => t.style !== 'caption').concat(items).sort((a, b) => a.start - b.start);
      ovKey = ''; renderTimeline();
      toast(`Loaded ${items.length} captions from ${f.name}`);
      setStatus('Captions loaded — double-click a caption on the text lane to edit it');
    } catch (err) { toast(`Could not read captions: ${err.message}`, true); }
  });

  /* ---------------- music bed ---------------- */
  function removeMusic(silent) {
    const m = S.music; if (!m) return;
    m.el.pause();
    try { if (m.node) m.node.disconnect(); if (m.gainNode) m.gainNode.disconnect(); } catch (e) { /* already disconnected */ }
    m.el.removeAttribute('src'); m.el.load(); URL.revokeObjectURL(m.url);
    S.music = null; renderTimeline();
    if (!silent) setStatus('Music removed');
  }
  $('musicInput').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    const actx = ensureAudio(); if (!actx) return toast('Web Audio is not supported', true);
    runTask('Loading music…', async (signal, progress) => {
      let buf;
      try { buf = await actx.decodeAudioData(await f.arrayBuffer()); } catch (err) { throw new Error(`${f.name}: could not decode audio`); }
      progress(0.35, 'Detecting beats…');
      const res = await Analysis.detectBeats(buf, { signal });
      removeMusic(true);
      const url = URL.createObjectURL(f), el = new Audio(); el.preload = 'auto'; el.src = url;
      S.music = { name: f.name, url, el, duration: buf.duration, beats: res.beats, bpm: res.bpm, peaks: res.peaks, duck: true, vol: 0.8 };
      attachMusic(); syncMusic(true); renderTimeline();
      toast(`Music bed added${res.bpm ? ` — ${res.bpm} BPM, ${res.beats.length} beats` : ''}. Auto duck is on.`);
      setStatus('Music bed: plays under the edit and exports with it');
    });
  });

  /* ---------------- extended AI toolset ---------------- */
  Object.assign(tools, {
    async highlight(len) {
      const clips = S.clips.filter((c) => assetById(c.assetId).kind === 'video');
      if (!clips.length) return toast('Import a video first');
      const v = len ? { len } : await dialog({
        title: 'Highlight Reel', ok: 'Build reel',
        note: 'Scores every half second by motion, audio energy and visual interest, then keeps the strongest moments in their original order. Undo restores the full edit.',
        fields: [{ k: 'len', label: 'Target length', type: 'select', options: [['15', '15 s'], ['30', '30 s'], ['60', '60 s'], ['90', '90 s']], value: '30' }],
      });
      if (!v) return;
      const target = +v.len;
      if (target >= S.total - 0.5) return toast(`The edit is already ${fmt(S.total)} — nothing to trim`);
      return runTask('Highlight reel: scoring moments…', async (signal, progress) => {
        const step = 0.5, samples = [];
        for (let k = 0; k < clips.length; k++) {
          const c = clips[k], a = assetById(c.assetId);
          const prof = await Analysis.activityProfile(a.url, c.in, c.out, step, { signal, onProgress: (p) => progress((k + p * 0.9) / clips.length, `Scoring ${a.name}… ${Math.round(p * 100)}%`) });
          const buf = await getAudioBuffer(a);
          const loud = buf ? Analysis.loudnessProfile(buf, c.in + 0, c.out, step) : null;
          prof.forEach((p, i) => samples.push({ c, t: p.t, motion: p.motion, interest: p.interest, loud: loud ? (loud[i] ?? -120) : -120 }));
        }
        if (!samples.length) throw new Error('Not enough footage to score');
        const norm = (key) => {
          const v = samples.map((s) => s[key]).sort((x, y) => x - y);
          const lo = v[Math.floor(v.length * 0.05)], hi = v[Math.floor(v.length * 0.95)];
          return (x) => (hi > lo ? clamp((x - lo) / (hi - lo), 0, 1) : 0.5);
        };
        const nm = norm('motion'), ni = norm('interest'), nl = norm('loud');
        samples.forEach((s) => (s.score = 0.45 * nm(s.motion) + 0.35 * nl(s.loud) + 0.2 * ni(s.interest)));
        const seg = clamp(target / 8, 1.5, 4), cands = [];
        for (const c of clips) {
          const ss = samples.filter((s) => s.c === c), len = Math.min(seg, clipDur(c));
          for (let t0 = c.in; t0 <= c.out - len + 1e-6; t0 += Math.max(0.25, len / 2)) {
            const inside = ss.filter((s) => s.t >= t0 && s.t < t0 + len);
            if (inside.length) cands.push({ c, in: t0, out: t0 + len, score: inside.reduce((x, s) => x + s.score, 0) / inside.length });
          }
        }
        cands.sort((x, y) => y.score - x.score);
        const picked = []; let total = 0;
        for (const k of cands) {
          if (total >= target - 0.05) break;
          if (picked.some((p) => p.c === k.c && k.in < p.out - 1e-6 && k.out > p.in + 1e-6)) continue;
          const out = Math.min(k.out, k.in + Math.max(target - total, 0.5));
          picked.push({ ...k, out }); total += out - k.in;
        }
        const order = (p) => S.clips.indexOf(p.c);
        picked.sort((x, y) => order(x) - order(y) || x.in - y.in);
        const merged = [];
        for (const p of picked) { const l = merged[merged.length - 1]; if (l && l.c === p.c && Math.abs(l.out - p.in) < 0.05) l.out = p.out; else merged.push({ ...p }); }
        pushHistory();
        S.clips = merged.map((p) => ({ ...p.c, id: uid(), in: +p.in.toFixed(3), out: +p.out.toFixed(3) }));
        S.selected = null; afterEdit(); fitZoom(); seek(0);
        toast(`Highlight reel: ${merged.length} moments, ${fmt(S.total)}`);
        setStatus(`Highlight reel built (${fmt(S.total)}) — Undo restores the full edit`);
      });
    },

    deadframes() {
      const assets = targetAssets(); if (!assets.length) return toast('Import a video first');
      return runTask('Scanning for black and frozen frames…', async (signal, progress) => {
        let n = 0, secs = 0;
        for (let k = 0; k < assets.length; k++) {
          const a = assets[k];
          a.dead = await Analysis.detectDeadFrames(a.url, a.duration, { signal, onProgress: (p) => progress((k + p) / assets.length, `Scanning ${a.name}… ${Math.round(p * 100)}%`) });
          n += a.dead.length; secs += a.dead.reduce((s, z) => s + z.end - z.start, 0);
        }
        renderTimeline();
        toast(n ? `Marked ${n} dead stretch${n > 1 ? 'es' : ''} (${secs.toFixed(1)}s) — “Cut Marked Zones” removes them` : 'No black or frozen stretches found');
        setStatus(`Dead frames: ${n} zone${n === 1 ? '' : 's'}, ${secs.toFixed(1)}s`);
      });
    },

    loudness() {
      const clips = targetClips(); if (!clips.length) return toast('Import a video first');
      if (!ensureAudio()) return toast('Web Audio is not supported', true);
      return runTask('Measuring loudness…', async (signal, progress) => {
        const TARGET = -18, changes = []; let skipped = 0;
        for (let k = 0; k < clips.length; k++) {
          const c = clips[k], a = assetById(c.assetId);
          progress(k / clips.length, `Measuring ${a.name} (${k + 1}/${clips.length})`);
          const buf = await getAudioBuffer(a); checkAbort(signal);
          if (!buf) { skipped++; continue; }
          const m = Analysis.measureLoudness(buf, c.in, c.out);
          if (m.db < -60) { skipped++; continue; }
          const g = clamp(Math.min(Math.pow(10, (TARGET - m.db) / 20), 0.98 / Math.max(m.peak, 1e-4)), 0.25, 4);
          changes.push([c, +g.toFixed(3)]);
          await new Promise((r) => setTimeout(r, 0));
        }
        if (!changes.length) throw new Error('No clips with measurable audio');
        pushHistory(); changes.forEach(([c, g]) => (c.gain = g)); afterEdit();
        toast(`Leveled ${changes.length} clip${changes.length > 1 ? 's' : ''} to a common loudness${skipped ? ` (${skipped} silent or without audio skipped)` : ''}`);
        setStatus('Loudness matched — per-clip gain shown on each clip');
      });
    },

    voice() {
      const clips = targetClips(); if (!clips.length) return toast('Import a video first');
      ensureAudio();
      const on = !clips.every((c) => c.enhance);
      pushHistory(); clips.forEach((c) => (c.enhance = on)); afterEdit();
      toast(on ? `Voice enhance on for ${clips.length} clip${clips.length > 1 ? 's' : ''}: rumble cut, de-mud, presence lift, gentle compression` : 'Voice enhance off');
    },

    music() { $('musicInput').value = ''; $('musicInput').click(); },

    beatcut() {
      const m = S.music; if (!m || m.beats.length < 2) return toast('Add a music bed first — the beat grid comes from the music');
      if (!S.clips.length) return toast('Import footage first');
      pushHistory();
      const beats = m.beats, minLen = Math.max(MIN_CLIP, (beats[1] - beats[0]) * 0.5);
      let t = 0, moved = 0;
      for (const c of S.clips) {
        const end = t + clipDur(c);
        let b = -1; for (const x of beats) { if (x > end + 1e-3) break; if (x >= t + minLen) b = x; }
        if (b > 0 && Math.abs(b - end) > 1e-3) { c.out = +(c.in + (b - t)).toFixed(3); moved++; }
        t += clipDur(c);
      }
      if (!moved) { S.history.pop(); return toast('Cuts already land on the beat'); }
      afterEdit();
      toast(`Snapped ${moved} cut${moved > 1 ? 's' : ''} to the beat (${m.bpm} BPM)`);
      setStatus('Cut to beat — each clip now ends on a beat');
    },

    matchshots() {
      if (S.clips.length < 2) return toast('Add at least two clips to match');
      const loc = locate(S.time);
      const ref = S.clips.find((c) => c.id === S.selected) || (loc && loc.clip);
      const refName = assetById(ref.assetId).name;
      return runTask('Matching shots…', async (signal, progress) => {
        const refImg = await clipFrame(ref, 96, 54, signal); if (!refImg) throw new Error('Reference frame not ready');
        const rs = Analysis.frameStats(refImg), updates = [];
        for (let k = 0; k < S.clips.length; k++) {
          const c = S.clips[k]; checkAbort(signal);
          progress(k / S.clips.length, `Analyzing shot ${k + 1}/${S.clips.length}`);
          if (c === ref) { updates.push([c, null]); continue; }
          const img = await clipFrame(c, 96, 54, signal); if (!img) continue;
          const st = Analysis.frameStats(img), r2 = (x) => Math.round(x * 100) / 100;
          updates.push([c, {
            exposure: r2(clamp(Math.log2(rs.medLin / st.medLin) * 0.85, -1.5, 1.5)),
            temperature: r2(clamp(st.temp - rs.temp, -1, 1)),
            tint: r2(clamp(st.tint - rs.tint, -1, 1)),
            saturation: r2(clamp(rs.chroma / Math.max(st.chroma, 0.02), 0.7, 1.4)),
          }]);
        }
        pushHistory(); updates.forEach(([c, adj]) => (c.adj = adj)); afterEdit();
        toast(`Matched ${updates.length - 1} shot${updates.length > 2 ? 's' : ''} to “${refName}” — Reset Color clears per-shot matches`);
        setStatus('Shots matched (exposure, white balance, saturation) on top of the global grade');
      });
    },

    stabilize() {
      const clips = targetClips(); if (!clips.length) return toast('Import a video first');
      return runTask('Stabilizing: measuring camera shake…', async (signal, progress) => {
        const res = [];
        for (let k = 0; k < clips.length; k++) {
          const c = clips[k], a = assetById(c.assetId);
          const r = await Analysis.estimateShake(a.url, c.in, c.out, { signal, onProgress: (p) => progress((k + p) / clips.length, `Measuring shake — ${a.name} (${k + 1}/${clips.length})… ${Math.round(p * 100)}%`) });
          res.push([c, r]);
        }
        pushHistory();
        res.forEach(([c, r]) => (c.reframe = { scale: r.scale, keys: r.keys, kind: 'stab' }));
        afterEdit();
        const crop = Math.round((1 - 1 / Math.max(...res.map(([, r]) => r.scale))) * 100);
        toast(`Stabilized ${res.length} clip${res.length > 1 ? 's' : ''} (up to ${crop}% crop) — Reset Framing undoes it`);
        setStatus('Stabilize applied (replaces Smart Reframe on these clips)');
      });
    },

    title(opts) {
      return (opts ? Promise.resolve({ text: opts.text, style: opts.style || 'title', dur: opts.duration || 3, start: opts.start }) : dialog({
        title: 'Add text', ok: 'Add at playhead',
        fields: [
          { k: 'text', label: 'Text', type: 'textarea', value: '' },
          { k: 'style', label: 'Style', type: 'select', options: STYLE_OPTS, value: 'title' },
          { k: 'dur', label: 'Duration (s)', type: 'number', step: 0.1, min: 0.5, value: 3 },
        ],
      })).then((v) => {
        if (!v || !v.text.trim()) return;
        if (!TEXT_STYLES[v.style] || v.style === 'replace') v.style = 'title';
        pushHistory();
        const start = +(v.start != null ? clamp(+v.start, 0, Math.max(0, S.total)) : S.time).toFixed(3);
        const t = { id: uid(), text: v.text.trim(), style: v.style, start, end: +(start + Math.max(0.5, v.dur || 3)).toFixed(3) };
        S.texts.push(t); S.texts.sort((a, b) => a.start - b.start); S.selText = t.id;
        ovKey = ''; renderTimeline();
        setStatus(`${TEXT_STYLES[t.style]} added at ${fmt(start)} — double-click it on the text lane to edit`);
      });
    },

    captions() { $('srtInput').value = ''; $('srtInput').click(); },

    replace(opts) { return replaceText(opts); },

    screen() { return openScreen(); },

    async reel(opts) {
      if (!S.clips.length) return toast('Import footage first');
      if (S.busy || S.exporting) return toast('Wait for the current task to finish');
      const v = opts || await dialog({
        title: 'Make a Reel', ok: 'Make it',
        note: 'Vertical 9:16 with the subject kept in frame, dead air removed, trimmed to the strongest moments and leveled — ready for Reels, TikTok and Shorts. Every step is undoable.',
        fields: [
          { k: 'len', label: 'Length', type: 'select', options: [['keep', 'Keep everything'], ['15', '15 s'], ['30', '30 s'], ['60', '60 s'], ['90', '90 s']], value: '30' },
          { k: 'silence', label: 'Dead air', type: 'select', options: [['cut', 'Cut silences and dead frames'], ['keep', 'Keep']], value: 'cut' },
          { k: 'audio', label: 'Audio', type: 'select', options: [['level', 'Level loudness'], ['voice', 'Level + voice enhance'], ['keep', 'Leave as is']], value: 'level' },
        ],
      });
      if (!v) return;
      const steps = [], hasVideo = () => S.clips.some((c) => assetById(c.assetId).kind === 'video');
      const step = async (label, fn) => { S.selected = null; const mark = toastLog.length; await fn(); while (S.busy) await new Promise((r) => setTimeout(r, 100)); steps.push(`${label}: ${(toastLog.slice(mark).pop() || {}).msg || 'done'}`); };
      if (v.silence === 'cut' && hasVideo()) {
        await step('Silence', () => tools.silence());
        await step('Dead frames', () => tools.deadframes());
        await step('Cut', () => tools.applysilence());
      }
      const target = +v.len;
      if (target && S.total > target + 0.5 && hasVideo()) await step('Highlights', () => tools.highlight(String(target)));
      $('aspect').value = '9:16'; S.aspect = '9:16'; updateCanvasSize(); S.dirty = true;
      if (hasVideo()) await step('Reframe', () => tools.reframe());
      if (v.audio !== 'keep' && hasVideo()) {
        await step('Loudness', () => tools.loudness());
        if (v.audio === 'voice' && !S.clips.every((c) => c.enhance)) await step('Voice', () => tools.voice());
      }
      seek(0); fitZoom();
      toast(`Reel ready: ${fmt(S.total)} at 9:16 — preview, add text, then Export`);
      setStatus('Make a Reel: ' + steps.map((x) => x.split(':')[0]).join(' → '));
      return steps;
    },
    studio() { openStudio(); },

    autozoom() {
      const clips = targetClips(); if (!clips.length) return toast('Import or record a screen capture first');
      return runTask('Auto Zoom: finding activity…', async (signal, progress) => {
        const res = [];
        for (let k = 0; k < clips.length; k++) {
          const c = clips[k], a = assetById(c.assetId);
          const r = await Analysis.detectFocus(a.url, c.in, c.out, { signal, onProgress: (p) => progress((k + p) / clips.length, `Watching ${a.name} for activity… ${Math.round(p * 100)}%`) });
          res.push([c, r]);
        }
        pushHistory();
        res.forEach(([c, r]) => (c.reframe = { scale: 1, keys: r.keys, kind: 'zoom' }));
        afterEdit();
        const n = res.reduce((s, [, r]) => s + r.zooms, 0);
        toast(n ? `Auto Zoom: ${n} push-in${n > 1 ? 's' : ''} on typing, clicks and scrolling — Reset Framing removes them` : 'No localised activity found — nothing to zoom into');
        setStatus('Auto Zoom applied (replaces other framing on these clips)');
      });
    },

    thumbnail() {
      if (!S.clips.length) return toast('Import footage first');
      if (!R) return toast('WebGL is required to render the thumbnail', true);
      return runTask('Finding the best thumbnail frame…', async (signal, progress) => {
        const N = clamp(Math.round(S.total * 2), 12, 48), cands = [];
        for (let i = 0; i < N; i++) { const t = (i + 0.5) * S.total / N, l = locate(t); if (l) cands.push({ t, a: l.asset, src: l.src, score: 0 }); }
        const byAsset = new Map();
        cands.forEach((c) => { if (!byAsset.has(c.a)) byAsset.set(c.a, []); byAsset.get(c.a).push(c); });
        let done = 0;
        for (const [a, list] of byAsset) {
          if (a.kind === 'image') {
            const cv = document.createElement('canvas'); cv.width = 160; cv.height = 90;
            const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(a.el, 0, 0, 160, 90);
            const sc = Analysis.thumbScore(g.getImageData(0, 0, 160, 90)).score;
            list.forEach((c) => (c.score = sc)); done += list.length; continue;
          }
          await Analysis.sampleFrames(a.url, list.map((c) => c.src), (img, t, i) => {
            list[i].score = Analysis.thumbScore(img).score; done++;
            progress(done / cands.length, `Scoring frame ${done}/${cands.length}`);
          }, { w: 160, h: 90, signal });
        }
        for (const c of cands) {
          if (c.a.sceneCuts.some((x) => Math.abs(x - c.src) < 0.35)) c.score *= 0.7;
          if ((c.a.dead || []).some((z) => c.src >= z.start && c.src <= z.end)) c.score *= 0.3;
        }
        const best = cands.reduce((b, c) => (!b || c.score > b.score ? c : b), null);
        if (!best) throw new Error('No frames to score');
        seek(best.t); await frameReady();
        const l = locate(S.time); updateOverlay(true);
        R.upload(l.asset.el); R.draw(colorParams(l), framingFor(l), false);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        if (!blob) throw new Error('Capture failed');
        download(blob, `kutlabz-thumbnail-${fmt(best.t).replace(/[:.]/g, '-')}.png`);
        toast(`Best frame at ${fmt(best.t)} saved as a ${canvas.width}×${canvas.height} PNG`);
        setStatus(`Thumbnail: sharpest, best-exposed frame at ${fmt(best.t)}`);
      });
    },

    async chapters() {
      if (!S.clips.length) return toast('Import footage first');
      const pts = new Set([0]), hasCuts = S.assets.some((a) => a.sceneCuts.length);
      S.clips.forEach((c, i) => {
        const a = assetById(c.assetId);
        if (hasCuts) a.sceneCuts.forEach((t) => { if (t > c.in && t < c.out) pts.add(S.starts[i] + t - c.in); });
        else if (i) pts.add(S.starts[i]);
      });
      S.texts.filter((t) => t.style === 'title').forEach((t) => pts.add(t.start));
      const keep = [];
      for (const t of [...pts].sort((x, y) => x - y)) if (!keep.length || (t - keep[keep.length - 1] >= 10 && S.total - t >= 10)) keep.push(t);
      if (keep.length < 3) return toast('YouTube needs at least 3 chapters, 10 s apart — run Detect Scene Cuts or split the edit first');
      const p2 = (n) => String(n).padStart(2, '0');
      const ts = (t) => { t = Math.floor(t); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return h ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`; };
      const lines = keep.map((t, i) => {
        const next = keep[i + 1] ?? Infinity;
        const tt = S.texts.find((x) => x.style === 'title' && x.start >= t - 0.01 && x.start < next);
        return `${ts(t)} ${tt ? tt.text.split('\n')[0] : i === 0 ? 'Intro' : `Chapter ${i + 1}`}`;
      });
      const v = await dialog({
        title: 'Chapters', ok: 'Copy',
        note: 'YouTube chapter list from scene cuts, clip boundaries and titles. Rename them here, then paste into the video description.',
        fields: [{ k: 'text', label: `${keep.length} chapters`, type: 'textarea', rows: Math.min(12, keep.length + 1), value: lines.join('\n') }],
      });
      if (!v) return;
      try { await navigator.clipboard.writeText(v.text); toast('Chapters copied to the clipboard'); }
      catch (e) { download(new Blob([v.text], { type: 'text/plain' }), 'kutlabz-chapters.txt'); toast('Clipboard unavailable — chapters saved as a text file'); }
    },
  });

  document.querySelectorAll('.tool').forEach((b) => (b.onclick = () => tools[b.dataset.tool]()));

  $('refInput').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const img = new Image(); img.src = URL.createObjectURL(f); await img.decode();
      const c = document.createElement('canvas'); c.width = 96; c.height = 54;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, 96, 54);
      const refStats = LUTS.labStats(g.getImageData(0, 0, 96, 54).data);
      const cur = grabCurrentFrame(96, 54); if (!cur) throw new Error('Current frame not ready');
      const srcStats = LUTS.labStats(cur.data);
      const lut = LUTS.colorTransferLut(srcStats, refStats, 0.85);
      URL.revokeObjectURL(img.src);
      const entry = { id: 'match-' + uid(), name: 'Match: ' + f.name.replace(/\.[^.]+$/, ''), lut, custom: true };
      S.lutList.push(entry);
      selectLut(entry.id);
      toast('Color matched to reference — adjust “LUT intensity” to taste');
      setStatus('AI color match applied');
    } catch (err) { toast('Color match failed: ' + err.message, true); }
  });

  /* ---------------- color controls + LUTs ---------------- */
  function fmtVal(d, v) { return d.k === 'exposure' ? (v >= 0 ? '+' : '') + v.toFixed(2) : d.sign ? (v >= 0 ? '+' : '') + Math.round(v * 100) : d.def === 1 ? v.toFixed(2) : Math.round(v * 100); }
  function buildControls() {
    const box = $('controls');
    for (const d of COLOR_DEFS) {
      const lab = document.createElement('label'); lab.className = 'slider'; lab.title = 'Double-click to reset';
      lab.innerHTML = `<span>${d.label}</span><input type="range" min="${d.min}" max="${d.max}" step="${d.step}"><output></output>`;
      const input = lab.querySelector('input'), out = lab.querySelector('output');
      input.value = S.color[d.k]; out.textContent = fmtVal(d, S.color[d.k]);
      input.dataset.k = d.k;
      input.addEventListener('input', () => { S.color[d.k] = +input.value; out.textContent = fmtVal(d, +input.value); S.dirty = true; });
      lab.addEventListener('dblclick', () => { S.color[d.k] = d.def; syncControls(); S.dirty = true; });
      box.appendChild(lab);
    }
  }
  function syncControls() {
    document.querySelectorAll('#controls input').forEach((inp) => {
      const d = COLOR_DEFS.find((x) => x.k === inp.dataset.k);
      inp.value = S.color[d.k]; inp.nextElementSibling.textContent = fmtVal(d, S.color[d.k]);
    });
    $('lutAmt').value = S.lutAmt; $('lutAmt').nextElementSibling.textContent = Math.round(S.lutAmt * 100) + '%';
  }
  $('lutAmt').addEventListener('input', (e) => { S.lutAmt = +e.target.value; e.target.nextElementSibling.textContent = Math.round(S.lutAmt * 100) + '%'; S.dirty = true; });
  $('btnResetColor').onclick = () => {
    if (S.clips.some((c) => c.adj)) { pushHistory(); S.clips.forEach((c) => delete c.adj); renderTimeline(); }
    S.color = defaultColor(); S.lutAmt = 1; selectLut('none'); syncControls(); S.dirty = true; setStatus('Color reset (global grade and per-shot matches)');
  };

  let lutSwatchFromFrame = null, swatchBase = null;
  function swatchSource() {
    const W = 96, H = 54;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    if (lutSwatchFromFrame) { g.drawImage(lutSwatchFromFrame, 0, 0, W, H); return g.getImageData(0, 0, W, H); }
    if (swatchBase) return swatchBase;
    const sky = g.createLinearGradient(0, 0, 0, H * 0.55); sky.addColorStop(0, '#3b6fb6'); sky.addColorStop(1, '#f2c7a0');
    g.fillStyle = sky; g.fillRect(0, 0, W, H * 0.55);
    g.fillStyle = '#2f4a2a'; g.fillRect(0, H * 0.55, W, H);
    g.fillStyle = '#c98f6e'; g.beginPath(); g.arc(W * 0.62, H * 0.58, 11, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#1d1a22'; g.fillRect(W * 0.55, H * 0.72, 18, H);
    g.fillStyle = '#ffe9b0'; g.beginPath(); g.arc(W * 0.22, H * 0.36, 6, 0, Math.PI * 2); g.fill();
    swatchBase = g.getImageData(0, 0, W, H);
    return swatchBase;
  }
  function renderLutGrid() {
    const grid = $('lutGrid'); grid.innerHTML = '';
    const base = swatchSource();
    for (const L of S.lutList) {
      const b = document.createElement('button'); b.className = 'lut' + (L.id === S.lutId ? ' on' : ''); b.title = L.name;
      const cv = document.createElement('canvas'); cv.width = base.width; cv.height = base.height;
      const out = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
      if (L.lut) for (let i = 0; i < out.data.length; i += 4) {
        const o = LUTS.sampleLut(L.lut, out.data[i] / 255, out.data[i + 1] / 255, out.data[i + 2] / 255);
        out.data[i] = o[0] * 255; out.data[i + 1] = o[1] * 255; out.data[i + 2] = o[2] * 255;
      }
      cv.getContext('2d').putImageData(out, 0, 0);
      const sp = document.createElement('span'); sp.textContent = L.name;
      b.append(cv, sp);
      b.onclick = () => selectLut(L.id);
      grid.appendChild(b);
    }
  }
  function selectLut(id) {
    const L = S.lutList.find((x) => x.id === id) || S.lutList[0];
    S.lutId = L.id;
    if (R) R.setLut(L.lut);
    document.querySelectorAll('.lut').forEach((b, i) => b.classList.toggle('on', S.lutList[i].id === L.id));
    if (!document.querySelector('.lut.on')) renderLutGrid();
    S.dirty = true;
  }
  function initLuts() {
    S.lutList = LUTS.LOOKS.map((l) => ({ id: l.id, name: l.name, lut: l.id === 'none' ? null : LUTS.buildLut(l.fn, 33) }));
    renderLutGrid();
  }
  $('btnCube').onclick = () => { $('cubeInput').value = ''; $('cubeInput').click(); };
  $('cubeInput').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const lut = LUTS.parseCube(await f.text());
      const entry = { id: 'cube-' + uid(), name: lut.title || f.name.replace(/\.cube$/i, ''), lut, custom: true };
      S.lutList.push(entry); renderLutGrid(); selectLut(entry.id);
      toast(`Loaded ${lut.size}³ LUT “${entry.name}”`);
    } catch (err) { toast('Could not load LUT: ' + err.message, true); }
  });

  /* ---------------- camera ---------------- */
  async function openCamera() {
    if (S.camera) return closeCamera();
    if (S.exporting) return;
    if (!navigator.mediaDevices?.getUserMedia) return toast('Camera is not available in this browser', true);
    pause();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: true }); }
    catch (e) {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: true }); }
      catch (e2) { return toast('Camera access denied: ' + e2.message, true); }
    }
    const el = document.createElement('video'); el.muted = true; el.playsInline = true; el.srcObject = stream;
    await el.play().catch(() => {});
    if (!el.videoWidth) await new Promise((r) => el.addEventListener('loadedmetadata', r, { once: true }));
    S.camera = { stream, el, rec: null };
    $('camBar').hidden = false; $('empty').hidden = true; $('btnCamera').classList.add('active');
    updateCanvasSize(); setStatus('Camera live — grading is applied in real time');
  }
  /* ---------------- Image Studio bridge ---------------- */
  function openStudio() {
    if (!window.ImageStudio) return toast('Image Studio failed to load', true);
    pause();
    const onSend = (file) => { importFiles([file]); };
    const sel = S.clips.find((c) => c.id === S.selected), selAsset = sel && assetById(sel.assetId);
    const base = (n) => n.replace(/\.[^.]+$/, '');
    if (selAsset && selAsset.kind === 'image') return ImageStudio.open({ source: selAsset.el, name: base(selAsset.name), onSend });
    const loc = locate(S.time);
    if (!loc) return ImageStudio.open({ onSend });
    const a = loc.asset;
    if (a.kind === 'image') return ImageStudio.open({ source: a.el, name: base(a.name), onSend });
    // the frame under the playhead, at the source resolution (ungraded: the studio has its own adjustments)
    const c = document.createElement('canvas'); c.width = a.width; c.height = a.height;
    try { c.getContext('2d').drawImage(a.el, 0, 0, a.width, a.height); } catch (e) { return toast('Frame not ready — try again', true); }
    ImageStudio.open({ source: c, name: `${base(a.name)}-${fmt(S.time).replace(/[:.]/g, '-')}`, onSend });
  }
  $('btnStudio').onclick = openStudio;

  async function openScreen() {
    if (S.camera) closeCamera();
    if (S.exporting) return;
    if (!navigator.mediaDevices?.getDisplayMedia) return toast('Screen capture is not available in this browser', true);
    const v = await dialog({
      title: 'Record screen', ok: 'Choose screen…',
      note: 'Pick a screen, window or tab. The preview appears here; press Record, switch to what you want to capture, and come back to stop. The recording lands on the timeline — try Auto Zoom and Detect Dead Frames on it.',
      fields: [
        { k: 'mic', label: 'Microphone', type: 'select', options: [['yes', 'Record narration'], ['no', 'No microphone']], value: 'yes' },
        { k: 'sys', label: 'System / tab audio', type: 'select', options: [['yes', 'Include when shared'], ['no', 'Mute']], value: 'yes' },
        { k: 'fps', label: 'Frame rate', type: 'select', options: [['30', '30 fps'], ['60', '60 fps']], value: '30' },
      ],
    });
    if (!v) return;
    pause();
    let display;
    try { display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: +v.fps, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: v.sys === 'yes' }); }
    catch (e) { return toast('Screen capture cancelled' + (e.name === 'NotAllowedError' ? '' : ': ' + e.message), e.name !== 'NotAllowedError'); }
    let mic = null;
    if (v.mic === 'yes') { try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch (e) { toast('Microphone unavailable — recording screen audio only', true); } }
    const audioIn = [...display.getAudioTracks(), ...(mic ? mic.getAudioTracks() : [])];
    let recStream = new MediaStream(display.getVideoTracks());
    let mixCtx = null;
    if (audioIn.length) {
      mixCtx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = mixCtx.createMediaStreamDestination();
      for (const tr of audioIn) mixCtx.createMediaStreamSource(new MediaStream([tr])).connect(dest);
      recStream = new MediaStream([...display.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    }
    const el = document.createElement('video'); el.muted = true; el.playsInline = true; el.srcObject = display;
    await el.play().catch(() => {});
    if (!el.videoWidth) await new Promise((r) => el.addEventListener('loadedmetadata', r, { once: true }));
    S.camera = { stream: display, el, rec: null, kind: 'screen', recStream, extra: mic, mixCtx };
    display.getVideoTracks()[0].addEventListener('ended', () => { if (S.camera && S.camera.el === el) { if (S.camera.rec && S.camera.rec.state === 'recording') S.camera.rec.stop(); else closeCamera(); } });
    $('camBar').hidden = false; $('empty').hidden = true; $('btnScreen').classList.add('active');
    updateCanvasSize(); setStatus('Screen preview — press Record (Space) to start, Stop or end sharing to finish');
  }

  function closeCamera() {
    if (!S.camera) return;
    if (S.camera.rec && S.camera.rec.state !== 'inactive') S.camera.rec.stop();
    S.camera.stream.getTracks().forEach((t) => t.stop());
    if (S.camera.extra) S.camera.extra.getTracks().forEach((t) => t.stop());
    if (S.camera.mixCtx) S.camera.mixCtx.close().catch(() => {});
    S.camera = null;
    $('camBar').hidden = true; $('btnCamera').classList.remove('active'); $('btnScreen').classList.remove('active'); $('camRec').hidden = true;
    $('btnCamRecord').textContent = '● Record';
    afterEdit(); setStatus('Ready');
  }
  function pickMime(list) { return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || ''; }
  function toggleCamRecord() {
    const cam = S.camera; if (!cam) return;
    if (cam.rec && cam.rec.state === 'recording') { cam.rec.stop(); return; }
    if (!window.MediaRecorder) return toast('Recording is not supported in this browser', true);
    const mime = pickMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']);
    const rec = new MediaRecorder(cam.recStream || cam.stream, mime ? { mimeType: mime } : undefined);
    const isScreen = cam.kind === 'screen';
    const chunks = []; const t0 = performance.now();
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      clearInterval(cam.timer);
      const type = rec.mimeType || 'video/webm';
      const blob = new Blob(chunks, { type });
      const dur = (performance.now() - t0) / 1000;
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const file = new File([blob], `${isScreen ? 'screen' : 'camera'}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${ext}`, { type });
      $('camRec').hidden = true; $('btnCamRecord').textContent = '● Record';
      closeCamera();
      importFiles([file], { durationHint: dur, screen: isScreen });
    };
    rec.start(500); cam.rec = rec;
    $('camRec').hidden = false; $('btnCamRecord').textContent = '■ Stop';
    cam.timer = setInterval(() => { $('camTime').textContent = fmt((performance.now() - t0) / 1000).replace(/\.\d$/, ''); }, 250);
  }
  $('btnCamera').onclick = openCamera;
  $('btnScreen').onclick = openScreen;
  $('btnCamClose').onclick = closeCamera;
  $('btnCamRecord').onclick = toggleCamRecord;

  /* ---------------- export ---------------- */
  function framePng() {
    if (!R || (!S.clips.length && !S.camera)) return toast('Nothing to capture yet');
    const loc = locate(S.time);
    if (loc && !S.camera) { updateOverlay(true); R.upload(loc.asset.el); R.draw(colorParams(loc), framingFor(loc), S.raw); }
    canvas.toBlob((b) => { if (!b) return toast('Capture failed', true); download(b, `kutlabz-frame-${fmt(S.time).replace(/[:.]/g, '-')}.png`); toast(`Saved ${canvas.width}×${canvas.height} PNG`); }, 'image/png');
  }
  $('btnFrame').onclick = framePng;

  async function exportWebM() {
    if (S.exporting) return cancelExport();
    if (!S.clips.length) return toast('Add clips to the timeline first');
    if (S.busy) return toast('Wait for the current task to finish');
    if (!canvas.captureStream || !window.MediaRecorder) return toast('Export needs MediaRecorder + canvas.captureStream (try Chrome, Edge or Firefox)', true);
    closeCamera();
    ensureAudio();
    pause(); seek(0);
    await new Promise((r) => setTimeout(r, 350));
    const mime = pickMime(['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
    const isMp4 = mime.startsWith('video/mp4');
    const tracks = [...canvas.captureStream(30).getVideoTracks()];
    if (S.recDest) tracks.push(...S.recDest.stream.getAudioTracks());
    const stream = new MediaStream(tracks);
    const px = canvas.width * canvas.height;
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: Math.round(px * 30 * 0.12), audioBitsPerSecond: 160000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    S.exporting = { rec, chunks, cancelled: false, t0: performance.now() };
    rec.onstop = () => {
      const ex = S.exporting; S.exporting = null;
      tracks.forEach((t) => t.kind === 'video' && t.stop());
      $('busy').hidden = true; $('btnExport').textContent = 'Export Video';
      if (!ex || ex.cancelled) { setStatus('Export cancelled'); return; }
      const type = isMp4 ? 'video/mp4' : 'video/webm', ext = isMp4 ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type });
      const name = `kutlabz-${S.aspect === '9:16' ? 'reel' : 'export'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
      setStatus(`Exported ${fmt(S.total)} · ${(blob.size / 1048576).toFixed(1)} MB ${ext.toUpperCase()}`);
      deliverExport(blob, name, ext);
    };
    $('busy').hidden = false; $('busy').classList.add('light');
    $('busyCancel').hidden = false; $('busyCancel').onclick = cancelExport;
    $('btnExport').textContent = '✕ Cancel export';
    toast('Exporting in real time — keep this tab visible');
    rec.start(1000);
    play();
  }
  /* phones: hand the file to the share sheet (Instagram, TikTok, YouTube, Photos…); otherwise download */
  async function deliverExport(blob, name, ext) {
    const file = new File([blob], name, { type: blob.type });
    const canShare = navigator.canShare && navigator.share && (() => { try { return navigator.canShare({ files: [file] }); } catch (e) { return false; } })();
    if (canShare && document.body.classList.contains('mobile')) {
      const v = await dialog({
        title: 'Your video is ready', ok: 'Share…',
        note: `${ext.toUpperCase()} · ${(blob.size / 1048576).toFixed(1)} MB · ${canvas.width}×${canvas.height}. Share opens your phone's share sheet: post to Instagram, TikTok or YouTube, or save to Photos.${ext === 'webm' ? ' This browser records WebM; some apps need MP4.' : ''}`,
      });
      if (v) {
        try { await navigator.share({ files: [file], title: 'KutLabz edit' }); toast('Shared'); return; }
        catch (e) { if (e.name === 'AbortError') { toast('Share cancelled — use Export again to retry, or the file is saved below'); } }
      }
    }
    download(blob, name);
    toast(`Export complete — ${ext.toUpperCase()} downloaded`);
  }
  function finishExport() { const ex = S.exporting; if (ex && ex.rec.state !== 'inactive') setTimeout(() => ex.rec.state !== 'inactive' && ex.rec.stop(), 150); }
  function cancelExport() { const ex = S.exporting; if (!ex) return; ex.cancelled = true; pause(); if (ex.rec.state !== 'inactive') ex.rec.stop(); }
  $('btnExport').onclick = exportWebM;

  /* ---------------- transport ---------------- */
  $('btnPlay').onclick = () => { if (!S.exporting) togglePlay(); };
  $('btnStart').onclick = () => { if (!S.exporting) seek(0); };
  $('btnEnd').onclick = () => { if (!S.exporting) { pause(); seek(S.total); } };
  function setMuted(m) {
    S.muted = m; $('btnMute').textContent = m ? 'MUTE' : 'VOL'; $('btnMute').classList.toggle('active', m);
    if (S.monitor) S.monitor.gain.value = m ? 0 : 1;
    else S.assets.forEach((a) => a.kind === 'video' && (a.el.muted = m));
  }
  $('btnMute').onclick = () => setMuted(!S.muted);
  const setRaw = (v) => { S.raw = v; $('btnRaw').classList.toggle('active', v); S.dirty = true; };
  $('btnRaw').addEventListener('pointerdown', (e) => { e.preventDefault(); setRaw(true); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => $('btnRaw').addEventListener(ev, () => S.raw && setRaw(false)));
  $('aspect').addEventListener('change', (e) => { S.aspect = e.target.value; updateCanvasSize(); S.dirty = true; setStatus(`Output aspect: ${e.target.selectedOptions[0].text}`); });
  $('btnImport').onclick = () => { $('fileInput').value = ''; $('fileInput').click(); };
  $('fileInput').addEventListener('change', (e) => { ensureAudio(); importFiles(e.target.files); });

  /* ---------------- keyboard ---------------- */
  window.addEventListener('keydown', (e) => {
    if (dlgOpen) { if (e.key === 'Escape' && dlgClose) dlgClose(); return; }
    if (window.ImageStudio && ImageStudio.isOpen()) return;
    if (e.target.closest && e.target.closest('#chatPanel')) return; // typing to the assistant
    const tag = e.target.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    if (e.key === 'Escape') {
      if (S.exporting) cancelExport(); else if (S.busy) S.busy.abort(); else if (S.camera) closeCamera(); else { S.selected = null; S.selText = null; renderTimeline(); }
      return;
    }
    if (S.exporting) return;
    // typing in any text field (prompt bar, recipe editor, dialogs) never triggers editor shortcuts
    if (typing && !['range', 'checkbox', 'radio', 'button', 'submit'].includes(e.target.type)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') { e.preventDefault(); if (typing) e.target.blur(); if (S.camera) toggleCamRecord(); else togglePlay(); return; }
    if (typing && e.target.type !== 'range') return;
    if (typing && (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End')) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); seek(S.time - (e.shiftKey ? 5 : 1)); break;
      case 'ArrowRight': e.preventDefault(); seek(S.time + (e.shiftKey ? 5 : 1)); break;
      case ',': seek(S.time - 1 / 30); break;
      case '.': seek(S.time + 1 / 30); break;
      case 'Home': seek(0); break;
      case 'End': pause(); seek(S.total); break;
      case 's': splitPlayhead(); break;
      case 'S': splitAtCuts(); break;
      case 'Delete': case 'Backspace': e.preventDefault(); deleteSelected(); break;
      case 'm': case 'M': setMuted(!S.muted); break;
      case '\\': if (!e.repeat) setRaw(true); break;
      case '=': case '+': $('zoom').value = clamp(+$('zoom').value + 0.08, 0, 1); $('zoom').dispatchEvent(new Event('input')); break;
      case '-': $('zoom').value = clamp(+$('zoom').value - 0.08, 0, 1); $('zoom').dispatchEvent(new Event('input')); break;
      default: return;
    }
  });
  window.addEventListener('keyup', (e) => { if (e.key === '\\') setRaw(false); });

  /* ---------------- drag & drop files ---------------- */
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; $('dropOverlay').hidden = false; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropOverlay').hidden = true; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true;
    ensureAudio(); importFiles(e.dataTransfer.files);
  });

  window.addEventListener('beforeunload', (e) => { if (S.clips.length) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.exporting) toast('Export paused while the tab is hidden — keep it visible', true); });

  /* ---------------- boot ---------------- */
  buildControls();
  initLuts();
  $('zoom').value = zoomFromPps(S.pps);
  afterEdit();
  requestAnimationFrame(loop);

  /* ---------------- programmatic API (assistant + tests) ---------------- */
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const api = {
    state: S, tools, importFiles, seek, play, pause, undo, redo, toastLog, openStudio,
    splitAt: (t) => { pushHistory(); const ok = splitAt(t); if (!ok) S.history.pop(); afterEdit(); return ok; },
    summary() {
      return {
        duration: r3(S.total), playhead: r3(S.time), aspect: S.aspect, canvas: `${canvas.width}x${canvas.height}`,
        clips: S.clips.map((c, i) => {
          const a = assetById(c.assetId);
          return {
            index: i, name: a.name, kind: a.screen ? 'screen' : a.kind, start: r3(S.starts[i]), duration: r3(clipDur(c)), source_in: r3(c.in), source_out: r3(c.out),
            framing: c.reframe ? (c.reframe.kind || 'reframe') : null, gain_db: c.gain ? r3(20 * Math.log10(c.gain)) : 0, voice_enhance: !!c.enhance, shot_match: !!c.adj,
            scene_cuts: a.sceneCuts.filter((t) => t > c.in && t < c.out).length, silences: a.silences.length, dead_zones: (a.dead || []).length,
          };
        }),
        texts: S.texts.map((t, i) => ({ index: i, style: t.style, text: t.text, start: t.start, end: t.end })),
        music: S.music ? { name: S.music.name, bpm: S.music.bpm, duration: r3(S.music.duration), auto_duck: S.music.duck } : null,
        grade: { ...S.color, look: (S.lutList.find((l) => l.id === S.lutId) || {}).name, look_intensity: S.lutAmt },
        looks_available: S.lutList.map((l) => l.name),
      };
    },
    setColor(vals, mode = 'set') {
      const changed = [];
      for (const d of COLOR_DEFS) {
        if (typeof vals[d.k] !== 'number' || !isFinite(vals[d.k])) continue;
        const v = mode === 'adjust' ? (d.def === 1 ? S.color[d.k] * (1 + vals[d.k]) : S.color[d.k] + vals[d.k]) : vals[d.k];
        S.color[d.k] = r3(clamp(v, d.min, d.max)); changed.push(`${d.k} ${S.color[d.k]}`);
      }
      syncControls(); S.dirty = true;
      return changed.length ? `Grade: ${changed.join(', ')}` : 'No valid grade values given';
    },
    setLook(name, intensity) {
      const q = String(name || '').toLowerCase().trim();
      const L = S.lutList.find((l) => l.name.toLowerCase() === q) || S.lutList.find((l) => l.name.toLowerCase().includes(q) || q.includes(l.name.toLowerCase()));
      if (!L) return `Unknown look "${name}". Available: ${S.lutList.map((l) => l.name).join(', ')}`;
      selectLut(L.id);
      if (typeof intensity === 'number') { S.lutAmt = clamp(intensity, 0, 1); syncControls(); }
      return `Look: ${L.name} at ${Math.round(S.lutAmt * 100)}%`;
    },
    setAspect(a) {
      const opts = ['source', '16:9', '9:16', '1:1', '4:5'];
      if (!opts.includes(a)) return `Aspect must be one of ${opts.join(', ')}`;
      $('aspect').value = a; S.aspect = a; updateCanvasSize(); S.dirty = true; return `Output aspect ${a} (${canvas.width}×${canvas.height})`;
    },
    editClip({ action, clip_index, time, in: tin, out: tout, to_index }) {
      const c = S.clips[clip_index];
      if (action === 'split') { if (typeof time !== 'number') return 'split needs time'; return api.splitAt(time) ? `Split at ${fmt(time)}` : 'No clip long enough at that time'; }
      if (!c) return `No clip at index ${clip_index} (there are ${S.clips.length})`;
      const a = assetById(c.assetId);
      pushHistory();
      if (action === 'delete') { S.clips.splice(clip_index, 1); if (S.selected === c.id) S.selected = null; afterEdit(); return `Deleted clip ${clip_index}`; }
      if (action === 'trim') {
        const maxOut = a.kind === 'image' ? 600 : a.duration;
        const ni = typeof tin === 'number' ? clamp(tin, 0, maxOut) : c.in, no = typeof tout === 'number' ? clamp(tout, 0, maxOut) : c.out;
        if (no - ni < MIN_CLIP) { S.history.pop(); return 'Trim would leave less than 0.1 s'; }
        c.in = r3(ni); c.out = r3(no); afterEdit(); return `Clip ${clip_index} now ${fmt(c.in)}–${fmt(c.out)} of the source`;
      }
      if (action === 'move') {
        const to = clamp(to_index | 0, 0, S.clips.length - 1);
        S.clips.splice(clip_index, 1); S.clips.splice(to, 0, c); afterEdit(); return `Moved clip ${clip_index} to position ${to}`;
      }
      S.history.pop(); return `Unknown action ${action}`;
    },
    deleteText(i) { if (!S.texts[i]) return `No text at index ${i}`; pushHistory(); const [t] = S.texts.splice(i, 1); ovKey = ''; renderTimeline(); return `Removed text "${t.text}"`; },
    async runTool(name, clipIndex) {
      if (!tools[name]) return `Unknown tool ${name}`;
      const mark = toastLog.length;
      S.selected = clipIndex != null && S.clips[clipIndex] ? S.clips[clipIndex].id : null;
      renderTimeline();
      await tools[name]();
      while (S.busy) await new Promise((r) => setTimeout(r, 100));
      const msgs = toastLog.slice(mark).map((m) => (m.err ? 'Error: ' : '') + m.msg);
      return msgs.join(' | ') || 'Done';
    },
  };
  window.KutLabz = api;
})();
