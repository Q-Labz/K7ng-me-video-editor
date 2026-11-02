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
  function toast(msg, err) {
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
    if (S.actx.state === 'suspended') S.actx.resume().catch(() => {});
    return S.actx;
  }
  function attachAudio(a) {
    if (!S.actx || a.kind !== 'video' || a.audioNode) return;
    try {
      a.audioNode = S.actx.createMediaElementSource(a.el);
      a.audioNode.connect(S.monitor);
      a.audioNode.connect(S.recDest);
    } catch (e) { console.warn('audio attach failed', e); }
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
      const k = rf.keys, t = loc.src;
      let lo = 0, hi = k.length - 1;
      if (t <= k[0].t) { fr.cx = k[0].x; fr.cy = k[0].y; }
      else if (t >= k[hi].t) { fr.cx = k[hi].x; fr.cy = k[hi].y; }
      else {
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (k[m].t <= t) lo = m; else hi = m; }
        const f = (t - k[lo].t) / (k[hi].t - k[lo].t || 1);
        fr.cx = k[lo].x + (k[hi].x - k[lo].x) * f; fr.cy = k[lo].y + (k[hi].y - k[lo].y) * f;
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
    $('btnPlay').textContent = '❚❚';
  }
  function pause() {
    S.playing = false;
    pauseAllExcept(null);
    $('btnPlay').textContent = '▶\uFE0E';
    S.dirty = true;
  }
  function togglePlay() { S.playing ? pause() : play(); }

  function seek(t) {
    S.time = clamp(t, 0, S.total);
    const loc = locate(S.time);
    if (loc) enterClip(loc.i, loc.src);
    S.dirty = true;
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
        if (S.playing) advance(dt);
        const loc = locate(S.time);
        if (loc && loc.asset) {
          const el = loc.asset.el;
          if (S.playing || S.dirty || el !== S.lastEl) {
            const isStatic = el.tagName === 'IMG' && el === S.lastEl && R.hasFrame;
            const ok = isStatic || R.upload(el);
            if (ok) { S.lastEl = el; R.draw(colorParams(), framingFor(loc), S.raw); S.dirty = false; }
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

  function colorParams() { return { ...S.color, lutAmt: S.lutId === 'none' ? 0 : S.lutAmt }; }

  /* ---------------- history ---------------- */
  function snapshot() { return JSON.stringify(S.clips); }
  function pushHistory() { S.history.push(snapshot()); if (S.history.length > 150) S.history.shift(); S.future = []; }
  function restore(json) {
    S.clips = JSON.parse(json).filter((c) => assetById(c.assetId));
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
      label.textContent = `${a.name} · ${fmt(clipDur(c))}${c.reframe ? ' · 🎯' : ''}`;
      el.appendChild(label);
      for (const z of a.silences) {
        const s = Math.max(z.start, c.in), e = Math.min(z.end, c.out);
        if (e - s <= 0.01) continue;
        const zd = document.createElement('div'); zd.className = 'zone';
        zd.style.left = (s - c.in) * S.pps + 'px'; zd.style.width = (e - s) * S.pps + 'px';
        zd.title = `Silence ${fmt(s)}–${fmt(e)}`;
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
    drawRuler();
    positionPlayhead();
    updateCanvasSize();
  }

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
  function onTrackDown(e) {
    if (e.button !== 0 || S.exporting) return;
    const marker = e.target.closest('.marker');
    if (marker) { e.stopPropagation(); seek(+marker.dataset.t); return; }
    const clipEl = e.target.closest('.clip');
    if (!clipEl) { // scrub
      S.selected = null; renderTimeline();
      drag = { type: 'scrub' }; seek(xToTime(e.clientX));
      return;
    }
    const id = clipEl.dataset.id, idx = S.clips.findIndex((c) => c.id === id), c = S.clips[idx];
    S.selected = id;
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
    if (!drag) return;
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
    if (!drag) return;
    const d = drag; drag = null;
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
      runTask('Detecting scene cuts…', async (signal, progress) => {
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
      runTask('Analyzing audio…', async (signal, progress) => {
        let zones = 0, secs = 0, noAudio = [];
        for (let k = 0; k < assets.length; k++) {
          const a = assets[k];
          progress(k / assets.length, `Decoding audio — ${a.name}`);
          let buf;
          try { buf = await actx.decodeAudioData(await a.file.arrayBuffer()); }
          catch (e) { noAudio.push(a.name); continue; }
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          progress((k + 0.6) / assets.length, `Measuring RMS — ${a.name}`);
          await new Promise((r) => setTimeout(r, 0));
          const res = Analysis.detectSilence(buf);
          a.silences = res.zones; a.peaks = res.peaks; a.silenceThreshold = res.threshold;
          zones += res.zones.length; secs += res.zones.reduce((s, z) => s + z.end - z.start, 0);
        }
        renderTimeline();
        if (noAudio.length) toast(`No decodable audio in: ${noAudio.join(', ')}`, true);
        else toast(zones ? `Marked ${zones} silent zone${zones > 1 ? 's' : ''} (${secs.toFixed(1)}s) — “Apply Silence Cuts” to remove` : 'No silences found');
        setStatus(`Silence detection: ${zones} zone${zones === 1 ? '' : 's'}, ${secs.toFixed(1)}s`);
      });
    },
    applysilence() {
      if (!S.assets.some((a) => a.silences.length)) return toast('Run “Detect Silence” first');
      pushHistory();
      let removed = 0; const next = [];
      for (const c of S.clips) {
        const a = assetById(c.assetId);
        const zs = a.silences.filter((z) => z.end > c.in && z.start < c.out).sort((x, y) => x.start - y.start);
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
      if (removed < 0.01) { S.history.pop(); return toast('No silences inside the current clips'); }
      S.clips = next; S.selected = null;
      afterEdit();
      toast(`Removed ${removed.toFixed(1)}s of silence — ${S.clips.length} clips now`);
      setStatus(`Applied silence cuts (−${removed.toFixed(1)}s)`);
    },
    colormatch() {
      if (!S.clips.length) return toast('Import footage first, then pick a reference image');
      $('refInput').value = ''; $('refInput').click();
    },
    reframe() {
      const clips = targetClips(); if (!clips.length) return toast('Import a video first');
      pushHistory();
      runTask('Smart reframe: tracking motion…', async (signal, progress) => {
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
  $('btnResetColor').onclick = () => { S.color = defaultColor(); S.lutAmt = 1; selectLut('none'); syncControls(); S.dirty = true; setStatus('Color reset'); };

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
  function closeCamera() {
    if (!S.camera) return;
    if (S.camera.rec && S.camera.rec.state !== 'inactive') S.camera.rec.stop();
    S.camera.stream.getTracks().forEach((t) => t.stop());
    S.camera = null;
    $('camBar').hidden = true; $('btnCamera').classList.remove('active'); $('camRec').hidden = true;
    $('btnCamRecord').textContent = '● Record';
    afterEdit(); setStatus('Ready');
  }
  function pickMime(list) { return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || ''; }
  function toggleCamRecord() {
    const cam = S.camera; if (!cam) return;
    if (cam.rec && cam.rec.state === 'recording') { cam.rec.stop(); return; }
    if (!window.MediaRecorder) return toast('Recording is not supported in this browser', true);
    const mime = pickMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']);
    const rec = new MediaRecorder(cam.stream, mime ? { mimeType: mime } : undefined);
    const chunks = []; const t0 = performance.now();
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      clearInterval(cam.timer);
      const type = rec.mimeType || 'video/webm';
      const blob = new Blob(chunks, { type });
      const dur = (performance.now() - t0) / 1000;
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const file = new File([blob], `camera-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${ext}`, { type });
      $('camRec').hidden = true; $('btnCamRecord').textContent = '● Record';
      closeCamera();
      importFiles([file], { durationHint: dur });
    };
    rec.start(500); cam.rec = rec;
    $('camRec').hidden = false; $('btnCamRecord').textContent = '■ Stop';
    cam.timer = setInterval(() => { $('camTime').textContent = fmt((performance.now() - t0) / 1000).replace(/\.\d$/, ''); }, 250);
  }
  $('btnCamera').onclick = openCamera;
  $('btnCamClose').onclick = closeCamera;
  $('btnCamRecord').onclick = toggleCamRecord;

  /* ---------------- export ---------------- */
  function framePng() {
    if (!R || (!S.clips.length && !S.camera)) return toast('Nothing to capture yet');
    const loc = locate(S.time);
    if (loc && !S.camera) { R.upload(loc.asset.el); R.draw(colorParams(), framingFor(loc), S.raw); }
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
    const mime = pickMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
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
      $('busy').hidden = true; $('btnExport').textContent = 'Export WebM';
      if (!ex || ex.cancelled) { setStatus('Export cancelled'); return; }
      const blob = new Blob(chunks, { type: 'video/webm' });
      download(blob, `kutlabz-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`);
      setStatus(`Exported ${fmt(S.total)} · ${(blob.size / 1048576).toFixed(1)} MB`);
      toast('Export complete — WebM downloaded');
    };
    $('busy').hidden = false; $('busy').classList.add('light');
    $('busyCancel').hidden = false; $('busyCancel').onclick = cancelExport;
    $('btnExport').textContent = '✕ Cancel export';
    toast('Exporting in real time — keep this tab visible');
    rec.start(1000);
    play();
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
    const tag = e.target.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    if (e.key === 'Escape') {
      if (S.exporting) cancelExport(); else if (S.busy) S.busy.abort(); else if (S.camera) closeCamera(); else { S.selected = null; renderTimeline(); }
      return;
    }
    if (S.exporting) return;
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

  // tiny debug/test hook
  window.KutLabz = { state: S, importFiles, seek, play, pause, splitAt: (t) => { pushHistory(); splitAt(t); afterEdit(); }, tools, undo, redo };
})();
