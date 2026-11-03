/* KutLabz Image Studio — layered photo editor: retouch, adjust, filter, enhance. Runs fully in the browser. */
(function () {
  'use strict';

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const uid = () => Math.random().toString(36).slice(2, 9);
  const MAX_SIDE = 8192, HISTORY = 20;
  const BLENDS = [['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['soft-light', 'Soft light'], ['hard-light', 'Hard light'], ['color-dodge', 'Color dodge'], ['color-burn', 'Color burn'], ['darken', 'Darken'], ['lighten', 'Lighten'], ['difference', 'Difference'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity']];
  const FONTS = [['Syne', 'Syne'], ['DM Mono', 'DM Mono'], ['Cormorant Garamond', 'Cormorant Garamond'], ['system-ui', 'System']];
  const TOOLS = [
    ['move', 'V', 'Move', 'Drag the active layer'],
    ['brush', 'B', 'Brush', 'Paint on the active layer'],
    ['eraser', 'E', 'Eraser', 'Erase to transparency'],
    ['clone', 'S', 'Clone', 'Alt-click a source, then paint'],
    ['heal', 'J', 'Spot heal', 'Paint over blemishes, dust or small objects'],
    ['fill', 'G', 'Fill', 'Flood-fill similar colours'],
    ['wand', 'W', 'Wand erase', 'Erase a contiguous colour region'],
    ['eyedrop', 'I', 'Eyedropper', 'Pick a colour from the image'],
    ['text', 'T', 'Text', 'Click to add a text layer'],
    ['crop', 'C', 'Crop', 'Drag a crop box, Enter to apply'],
  ];
  const ADJ = [
    ['exposure', 'Exposure', -2, 2, 0.01, 0], ['contrast', 'Contrast', -1, 1, 0.01, 0], ['highlights', 'Highlights', -1, 1, 0.01, 0],
    ['shadows', 'Shadows', -1, 1, 0.01, 0], ['temperature', 'Temperature', -1, 1, 0.01, 0], ['tint', 'Tint', -1, 1, 0.01, 0],
    ['saturation', 'Saturation', -1, 1, 0.01, 0], ['vibrance', 'Vibrance', -1, 1, 0.01, 0], ['clarity', 'Clarity', 0, 1, 0.01, 0],
    ['sharpen', 'Sharpen', 0, 1, 0.01, 0], ['denoise', 'Denoise', 0, 1, 0.01, 0], ['vignette', 'Vignette', -1, 1, 0.01, 0], ['grain', 'Grain', 0, 1, 0.01, 0],
  ];

  /* ---------------- pixel operations ---------------- */
  function boxBlurChannelPass(src, dst, w, h, r, horizontal) {
    const len = horizontal ? w : h, lines = horizontal ? h : w, stride = horizontal ? 4 : w * 4, lineStride = horizontal ? w * 4 : 4, k = 1 / (2 * r + 1);
    for (let l = 0; l < lines; l++) {
      const base = l * lineStride;
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) acc += src[base + clamp(i, 0, len - 1) * stride + c];
        for (let i = 0; i < len; i++) {
          dst[base + i * stride + c] = acc * k;
          acc += src[base + Math.min(len - 1, i + r + 1) * stride + c] - src[base + Math.max(0, i - r) * stride + c];
        }
      }
    }
  }
  /** Approximate gaussian: three box passes in each direction. Returns a new Float32Array. */
  function blur(data, w, h, radius) {
    const r = Math.max(1, Math.round(radius / 1.8));
    let a = Float32Array.from(data), b = new Float32Array(data.length);
    for (let p = 0; p < 3; p++) { boxBlurChannelPass(a, b, w, h, r, true); boxBlurChannelPass(b, a, w, h, r, false); }
    return a;
  }
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  /** Tonal + colour adjustments in place (0–255 RGBA). Mirrors the video grade so stills and footage match. */
  function adjustPixels(img, p) {
    const d = img.data, w = img.width, h = img.height;
    const ex = Math.pow(2, p.exposure || 0), con = 1 + (p.contrast || 0), hi = p.highlights || 0, sh = p.shadows || 0;
    const tr = 1 + (p.temperature || 0) * 0.18 - (p.tint || 0) * 0.04, tg = 1 + (p.tint || 0) * 0.14, tb = 1 - (p.temperature || 0) * 0.18 - (p.tint || 0) * 0.04;
    const sat = 1 + (p.saturation || 0), vib = p.vibrance || 0, vig = p.vignette || 0, grain = p.grain || 0;
    const lut = new Float32Array(256); for (let i = 0; i < 256; i++) lut[i] = Math.pow(i / 255, 2.2);
    const cx = w / 2, cy = h / 2, maxR = Math.hypot(cx, cy);
    let seed = 12345; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
    for (let i = 0, px = 0; i < d.length; i += 4, px++) {
      let r = Math.pow(lut[d[i]] * ex * tr, 1 / 2.2), g = Math.pow(lut[d[i + 1]] * ex * tg, 1 / 2.2), b = Math.pow(lut[d[i + 2]] * ex * tb, 1 / 2.2);
      let l = lum(r, g, b);
      if (sh) { const wS = 1 - Math.min(1, l / 0.5); const k = sh * 0.6 * wS * wS; r += r * k + sh * 0.06 * wS; g += g * k + sh * 0.06 * wS; b += b * k + sh * 0.06 * wS; }
      if (hi) { const wH = Math.max(0, (l - 0.5) / 0.5); const k = hi * 0.35 * wH; r += k * (hi < 0 ? r : 1 - r); g += k * (hi < 0 ? g : 1 - g); b += k * (hi < 0 ? b : 1 - b); }
      if (con !== 1) { r = (r - 0.5) * con + 0.5; g = (g - 0.5) * con + 0.5; b = (b - 0.5) * con + 0.5; }
      if (sat !== 1 || vib) {
        l = lum(r, g, b); const s = Math.max(r, g, b) - Math.min(r, g, b), f = sat * (1 + vib * (1 - Math.min(1, s * 1.5)));
        r = l + (r - l) * f; g = l + (g - l) * f; b = l + (b - l) * f;
      }
      if (vig) { const x = px % w, y = (px / w) | 0; const v = Math.pow(Math.hypot(x - cx, y - cy) / maxR, 2); const k = vig > 0 ? 1 - vig * v * 0.85 : 1; if (vig > 0) { r *= k; g *= k; b *= k; } else { const m = -vig * v * 0.6; r += (1 - r) * m; g += (1 - g) * m; b += (1 - b) * m; } }
      if (grain) { const n = rnd() * grain * 0.16; r += n; g += n; b += n; }
      d[i] = clamp(r * 255, 0, 255); d[i + 1] = clamp(g * 255, 0, 255); d[i + 2] = clamp(b * 255, 0, 255);
    }
    if (p.denoise) denoise(img, p.denoise);
    if (p.clarity) unsharp(img, Math.max(8, Math.min(w, h) / 40), p.clarity * 0.6, 2);
    if (p.sharpen) unsharp(img, 1.4, p.sharpen * 1.4, 1);
    return img;
  }
  function unsharp(img, radius, amount, threshold = 0) {
    const d = img.data, bl = blur(d, img.width, img.height, radius);
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) {
      const diff = d[i + c] - bl[i + c];
      if (Math.abs(diff) > threshold) d[i + c] = clamp(d[i + c] + diff * amount, 0, 255);
    }
    return img;
  }
  /** Edge-preserving smoothing: pull each pixel toward its blur only where the difference looks like noise. */
  function denoise(img, strength) {
    const d = img.data, bl = blur(d, img.width, img.height, 2 + strength * 3), sig = 6 + strength * 26, s2 = 2 * sig * sig;
    for (let i = 0; i < d.length; i += 4) {
      const dr = bl[i] - d[i], dg = bl[i + 1] - d[i + 1], db = bl[i + 2] - d[i + 2];
      const k = Math.exp(-(dr * dr + dg * dg + db * db) / 3 / s2) * Math.min(1, 0.4 + strength);
      d[i] += dr * k; d[i + 1] += dg * k; d[i + 2] += db * k;
    }
    return img;
  }
  const FILTERS = {
    blur: (img) => { const b = blur(img.data, img.width, img.height, Math.max(2, Math.min(img.width, img.height) / 200)); img.data.set(b); return img; },
    sharpen: (img) => unsharp(img, 1.4, 1.0, 1),
    denoise: (img) => denoise(img, 0.6),
    bw: (img) => { const d = img.data; for (let i = 0; i < d.length; i += 4) { const l = lum(d[i], d[i + 1], d[i + 2]); d[i] = d[i + 1] = d[i + 2] = l; } return img; },
    sepia: (img) => { const d = img.data; for (let i = 0; i < d.length; i += 4) { const r = d[i], g = d[i + 1], b = d[i + 2]; d[i] = clamp(r * 0.393 + g * 0.769 + b * 0.189, 0, 255); d[i + 1] = clamp(r * 0.349 + g * 0.686 + b * 0.168, 0, 255); d[i + 2] = clamp(r * 0.272 + g * 0.534 + b * 0.131, 0, 255); } return img; },
    invert: (img) => { const d = img.data; for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } return img; },
    posterize: (img) => { const d = img.data, q = 255 / 4; for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = Math.round(d[i + c] / q) * q; return img; },
    pixelate: (img) => {
      const d = img.data, w = img.width, h = img.height, s = Math.max(4, Math.round(Math.min(w, h) / 80));
      for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) {
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let yy = y; yy < Math.min(h, y + s); yy++) for (let xx = x; xx < Math.min(w, x + s); xx++) { const i = (yy * w + xx) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++; }
        for (let yy = y; yy < Math.min(h, y + s); yy++) for (let xx = x; xx < Math.min(w, x + s); xx++) { const i = (yy * w + xx) * 4; d[i] = r / n; d[i + 1] = g / n; d[i + 2] = b / n; d[i + 3] = a / n; }
      }
      return img;
    },
  };

  /** One-click enhance: levels from luminance percentiles, partial grey-world white balance, vibrance, light denoise + sharpen. */
  function autoEnhance(img) {
    const d = img.data, n = d.length / 4, hist = new Uint32Array(256);
    let mr = 0, mg = 0, mb = 0, mw = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      const l = lum(d[i], d[i + 1], d[i + 2]) | 0; hist[l]++;
      if (l > 30 && l < 230) { mr += d[i]; mg += d[i + 1]; mb += d[i + 2]; mw++; }
    }
    const pct = (q) => { let acc = 0; const target = q * n; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; } return 255; };
    const lo = pct(0.005), hiP = Math.max(lo + 40, pct(0.995));
    const m = mw ? (mr + mg + mb) / (3 * mw) : 1;
    const wr = mw ? 1 + 0.6 * (m / (mr / mw) - 1) : 1, wg = mw ? 1 + 0.6 * (m / (mg / mw) - 1) : 1, wb = mw ? 1 + 0.6 * (m / (mb / mw) - 1) : 1;
    const span = 255 / (hiP - lo);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = clamp((d[i] * wr - lo) * span, 0, 255); d[i + 1] = clamp((d[i + 1] * wg - lo) * span, 0, 255); d[i + 2] = clamp((d[i + 2] * wb - lo) * span, 0, 255);
    }
    adjustPixels(img, { vibrance: 0.25, contrast: 0.05, shadows: 0.1, denoise: 0.25, sharpen: 0.35 });
    return { levels: [lo, hiP] };
  }

  /** Background removal for product shots, logos and screenshots: flood from the borders through colours close to the border's. */
  function removeFlatBackground(img, tol = 36) {
    const d = img.data, w = img.width, h = img.height, mask = new Uint8Array(w * h);
    const border = [];
    for (let x = 0; x < w; x += Math.max(1, (w / 64) | 0)) { border.push(x, (h - 1) * w + x); }
    for (let y = 0; y < h; y += Math.max(1, (h / 64) | 0)) { border.push(y * w, y * w + w - 1); }
    // dominant border colours (≤ 6 clusters on a 16-level grid) keep the per-pixel test cheap
    const bins = new Map();
    for (const p of border) {
      const key = ((d[p * 4] >> 4) << 8) | ((d[p * 4 + 1] >> 4) << 4) | (d[p * 4 + 2] >> 4);
      const b = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 }; b.n++; b.r += d[p * 4]; b.g += d[p * 4 + 1]; b.b += d[p * 4 + 2]; bins.set(key, b);
    }
    const seeds = [...bins.values()].sort((a, b) => b.n - a.n).filter((b) => b.n >= border.length * 0.04).slice(0, 6).map((b) => [b.r / b.n, b.g / b.n, b.b / b.n]);
    if (!seeds.length) return 0;
    const near = (p) => { const r = d[p * 4], g = d[p * 4 + 1], b = d[p * 4 + 2]; for (const s of seeds) { if (Math.abs(r - s[0]) + Math.abs(g - s[1]) + Math.abs(b - s[2]) < tol * 1.6) return true; } return false; };
    const stack = border.filter((p, i, arr) => arr.indexOf(p) === i && near(p));
    stack.forEach((p) => (mask[p] = 1));
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0;
      const ns = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of ns) if (q >= 0 && !mask[q]) {
        const dr = d[q * 4] - d[p * 4], dg = d[q * 4 + 1] - d[p * 4 + 1], db = d[q * 4 + 2] - d[p * 4 + 2];
        if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) < tol && near(q)) { mask[q] = 1; stack.push(q); }
      }
    }
    // feather the cut edge
    const m = new Float32Array(w * h * 4); for (let i = 0; i < w * h; i++) m[i * 4] = mask[i] ? 0 : 255;
    const fm = blur(m, w, h, 1.5);
    let removed = 0;
    for (let i = 0; i < w * h; i++) { if (mask[i]) removed++; d[i * 4 + 3] = Math.min(d[i * 4 + 3], fm[i * 4]); }
    return removed / (w * h);
  }

  /** Spot heal: harmonic (Laplace) fill of a circular patch from its surrounding ring. */
  function healPatch(ctx, cx, cy, r) {
    r = Math.max(3, Math.round(r));
    const x0 = Math.round(cx - r - 2), y0 = Math.round(cy - r - 2), S = 2 * r + 5;
    const img = ctx.getImageData(x0, y0, S, S), d = img.data;
    const inside = new Uint8Array(S * S); const c = r + 2;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if ((x - c) ** 2 + (y - c) ** 2 <= r * r && x > 0 && y > 0 && x < S - 1 && y < S - 1) inside[y * S + x] = 1;
    // initialise with ring average, then relax
    for (let ch = 0; ch < 4; ch++) {
      let acc = 0, n = 0;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const i = y * S + x; if (!inside[i]) { acc += d[i * 4 + ch]; n++; } }
      const avg = n ? acc / n : 0; for (let i = 0; i < S * S; i++) if (inside[i]) d[i * 4 + ch] = avg;
    }
    const iters = Math.min(160, 30 + r * 3);
    for (let it = 0; it < iters; it++) for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) {
      const i = y * S + x; if (!inside[i]) continue;
      for (let ch = 0; ch < 4; ch++) d[i * 4 + ch] = (d[(i - 1) * 4 + ch] + d[(i + 1) * 4 + ch] + d[(i - S) * 4 + ch] + d[(i + S) * 4 + ch]) / 4;
    }
    // a touch of the original texture back in from the ring's grain
    ctx.putImageData(img, x0, y0);
  }

  function floodRegion(img, sx, sy, tol) {
    const d = img.data, w = img.width, h = img.height, mask = new Uint8Array(w * h);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
    const s = (sy * w + sx) * 4, sr = d[s], sg = d[s + 1], sb = d[s + 2], sa = d[s + 3];
    const ok = (p) => Math.abs(d[p * 4] - sr) + Math.abs(d[p * 4 + 1] - sg) + Math.abs(d[p * 4 + 2] - sb) + Math.abs(d[p * 4 + 3] - sa) <= tol * 3;
    const stack = [sy * w + sx]; mask[stack[0]] = 1;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0;
      if (x > 0 && !mask[p - 1] && ok(p - 1)) { mask[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && !mask[p + 1] && ok(p + 1)) { mask[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && !mask[p - w] && ok(p - w)) { mask[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && !mask[p + w] && ok(p + w)) { mask[p + w] = 1; stack.push(p + w); }
    }
    return mask;
  }

  /* ---------------- document model ---------------- */
  const newCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });
  function cloneCanvas(src) { const c = newCanvas(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0); return c; }
  function makeLayer(name, w, h, kind = 'paint') {
    return { id: uid(), name, kind, canvas: newCanvas(w, h), visible: true, opacity: 1, blend: 'source-over', x: 0, y: 0, text: null };
  }

  const St = {
    open: false, doc: { w: 1920, h: 1080, name: 'untitled' }, layers: [], active: 0,
    tool: 'brush', color: '#E8E4DC', size: 40, hardness: 0.6, flow: 1, tol: 32,
    zoom: 1, ox: 0, oy: 0, hist: [], fut: [], cloneSrc: null, cloneOff: null, crop: null,
    adj: Object.fromEntries(ADJ.map((a) => [a[0], a[5]])), preview: null, onSend: null, dirty: true,
  };
  let root, view, vctx, scheduled = false;

  function snapshot() {
    return {
      doc: { ...St.doc }, active: St.active,
      layers: St.layers.map((l) => ({ ...l, text: l.text ? { ...l.text } : null, canvas: cloneCanvas(l.canvas) })),
    };
  }
  function pushHist() { St.hist.push(snapshot()); if (St.hist.length > HISTORY) St.hist.shift(); St.fut = []; }
  function restoreSnap(s) { St.doc = s.doc; St.layers = s.layers; St.active = Math.min(s.active, s.layers.length - 1); St.preview = null; render(); renderLayers(); }
  function undo() { if (!St.hist.length) return note('Nothing to undo'); St.fut.push(snapshot()); restoreSnap(St.hist.pop()); }
  function redo() { if (!St.fut.length) return note('Nothing to redo'); St.hist.push(snapshot()); restoreSnap(St.fut.pop()); }
  const active = () => St.layers[St.active];

  function loadDocument(src, name) {
    let w = src.naturalWidth || src.videoWidth || src.width, h = src.naturalHeight || src.videoHeight || src.height;
    const k = Math.min(1, MAX_SIDE / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
    St.doc = { w, h, name: name || 'image' };
    const base = makeLayer('Background', w, h, 'image');
    base.canvas.getContext('2d').drawImage(src, 0, 0, w, h);
    St.layers = [base]; St.active = 0; St.hist = []; St.fut = []; St.crop = null; St.preview = null; St.cloneSrc = null;
    resetAdj(); fit(); renderLayers();
  }

  /* ---------------- rendering ---------------- */
  function composite(target, withChecker) {
    const g = target.getContext('2d');
    g.save();
    for (const l of St.layers) {
      if (!l.visible) continue;
      g.globalAlpha = l.opacity; g.globalCompositeOperation = l.blend;
      g.drawImage(St.preview && St.preview.id === l.id ? St.preview.canvas : l.canvas, l.x, l.y);
    }
    g.restore();
    return withChecker;
  }
  function flatten(bg) {
    const c = newCanvas(St.doc.w, St.doc.h), g = c.getContext('2d');
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height); }
    composite(c);
    return c;
  }
  let checker = null;
  function render() {
    if (scheduled || !view) return; scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const W = view.clientWidth, H = view.clientHeight, dpr = window.devicePixelRatio || 1;
      if (view.width !== Math.round(W * dpr) || view.height !== Math.round(H * dpr)) { view.width = Math.round(W * dpr); view.height = Math.round(H * dpr); }
      const g = vctx; g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#0A0A0A'; g.fillRect(0, 0, view.width, view.height);
      g.setTransform(dpr * St.zoom, 0, 0, dpr * St.zoom, dpr * St.ox, dpr * St.oy);
      if (!checker) {
        const c = newCanvas(16, 16), cg = c.getContext('2d'); cg.fillStyle = '#1A1A1A'; cg.fillRect(0, 0, 16, 16); cg.fillStyle = '#242424'; cg.fillRect(0, 0, 8, 8); cg.fillRect(8, 8, 8, 8);
        checker = g.createPattern(c, 'repeat');
      }
      g.fillStyle = checker; g.fillRect(0, 0, St.doc.w, St.doc.h);
      g.save(); g.beginPath(); g.rect(0, 0, St.doc.w, St.doc.h); g.clip();
      for (const l of St.layers) { if (!l.visible) continue; g.globalAlpha = l.opacity; g.globalCompositeOperation = l.blend; g.drawImage(St.preview && St.preview.id === l.id ? St.preview.canvas : l.canvas, l.x, l.y); }
      g.restore();
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      g.lineWidth = 1 / St.zoom; g.strokeStyle = '#333331'; g.strokeRect(0, 0, St.doc.w, St.doc.h);
      if (St.crop) {
        const c = normRect(St.crop);
        g.fillStyle = 'rgba(10,10,10,.6)';
        g.fillRect(0, 0, St.doc.w, c.y); g.fillRect(0, c.y + c.h, St.doc.w, St.doc.h - c.y - c.h); g.fillRect(0, c.y, c.x, c.h); g.fillRect(c.x + c.w, c.y, St.doc.w - c.x - c.w, c.h);
        g.strokeStyle = '#E8E4DC'; g.lineWidth = 1.5 / St.zoom; g.strokeRect(c.x, c.y, c.w, c.h);
        g.lineWidth = 0.5 / St.zoom; for (let i = 1; i < 3; i++) { g.beginPath(); g.moveTo(c.x + c.w * i / 3, c.y); g.lineTo(c.x + c.w * i / 3, c.y + c.h); g.moveTo(c.x, c.y + c.h * i / 3); g.lineTo(c.x + c.w, c.y + c.h * i / 3); g.stroke(); }
      }
      if (cursor && ['brush', 'eraser', 'clone', 'heal'].includes(St.tool)) {
        g.strokeStyle = 'rgba(232,228,220,.85)'; g.lineWidth = 1 / St.zoom; g.beginPath(); g.arc(cursor.x, cursor.y, St.size / 2, 0, Math.PI * 2); g.stroke();
        if (St.tool === 'clone' && St.cloneSrc) { g.strokeStyle = 'rgba(138,138,133,.9)'; g.beginPath(); const sx = St.cloneOff ? cursor.x + St.cloneOff.x : St.cloneSrc.x, sy = St.cloneOff ? cursor.y + St.cloneOff.y : St.cloneSrc.y; g.moveTo(sx - 6 / St.zoom, sy); g.lineTo(sx + 6 / St.zoom, sy); g.moveTo(sx, sy - 6 / St.zoom); g.lineTo(sx, sy + 6 / St.zoom); g.stroke(); }
      }
      $('stZoom').textContent = Math.round(St.zoom * 100) + '%';
      $('stSize').textContent = `${St.doc.w}×${St.doc.h}`;
    });
  }
  function fit() {
    if (!view) return;
    const W = view.clientWidth, H = view.clientHeight;
    St.zoom = Math.min((W - 48) / St.doc.w, (H - 48) / St.doc.h, 4);
    St.ox = (W - St.doc.w * St.zoom) / 2; St.oy = (H - St.doc.h * St.zoom) / 2; render();
  }
  const normRect = (r) => ({ x: Math.min(r.x0, r.x1), y: Math.min(r.y0, r.y1), w: Math.abs(r.x1 - r.x0), h: Math.abs(r.y1 - r.y0) });

  /* ---------------- painting ---------------- */
  function dab(l, x, y, mode) {
    const g = l.canvas.getContext('2d'), r = St.size / 2, lx = x - l.x, ly = y - l.y;
    if (mode === 'heal') { healPatch(ctx2d(l.canvas), lx, ly, r); return; }
    g.save();
    const grad = g.createRadialGradient(lx, ly, r * St.hardness * 0.98, lx, ly, r);
    if (mode === 'clone') {
      if (!St.cloneSrc) return g.restore();
      // brush-shaped mask × source pixels, drawn through a scratch canvas
      const s = Math.ceil(r * 2) + 2, tmp = newCanvas(s, s), tg = tmp.getContext('2d');
      tg.drawImage(cloneSource, lx + St.cloneOff.x - s / 2, ly + St.cloneOff.y - s / 2, s, s, 0, 0, s, s);
      tg.globalCompositeOperation = 'destination-in';
      const mg = tg.createRadialGradient(s / 2, s / 2, r * St.hardness * 0.98, s / 2, s / 2, r);
      mg.addColorStop(0, 'rgba(0,0,0,1)'); mg.addColorStop(1, 'rgba(0,0,0,0)'); tg.fillStyle = mg; tg.fillRect(0, 0, s, s);
      g.globalAlpha = St.flow; g.drawImage(tmp, lx - s / 2, ly - s / 2); g.restore(); return;
    }
    const col = hexToRgb(St.color);
    grad.addColorStop(0, `rgba(${col.r},${col.g},${col.b},1)`); grad.addColorStop(1, `rgba(${col.r},${col.g},${col.b},0)`);
    if (mode === 'eraser') g.globalCompositeOperation = 'destination-out';
    g.globalAlpha = St.flow; g.fillStyle = grad; g.beginPath(); g.arc(lx, ly, r, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  function hexToRgb(h) { const n = parseInt(h.replace('#', ''), 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }
  let cloneSource = null;

  /* ---------------- pointer handling ---------------- */
  let drag = null, cursor = null;
  const toDoc = (e) => { const r = view.getBoundingClientRect(); return { x: (e.clientX - r.left - St.ox) / St.zoom, y: (e.clientY - r.top - St.oy) / St.zoom }; };
  function onDown(e) {
    if (e.button === 1 || (e.button === 0 && spaceHeld)) { drag = { type: 'pan', x: e.clientX, y: e.clientY, ox: St.ox, oy: St.oy }; view.setPointerCapture(e.pointerId); return; }
    if (e.button !== 0) return;
    const p = toDoc(e), l = active(); if (!l) return;
    view.setPointerCapture(e.pointerId);
    switch (St.tool) {
      case 'move': pushHist(); drag = { type: 'move', sx: p.x, sy: p.y, lx: l.x, ly: l.y }; break;
      case 'crop': St.crop = { x0: clamp(p.x, 0, St.doc.w), y0: clamp(p.y, 0, St.doc.h), x1: clamp(p.x, 0, St.doc.w), y1: clamp(p.y, 0, St.doc.h) }; drag = { type: 'crop' }; showCropBar(true); break;
      case 'eyedrop': { const c = flatten(); const px = ctx2d(c).getImageData(clamp(p.x | 0, 0, c.width - 1), clamp(p.y | 0, 0, c.height - 1), 1, 1).data; setColor('#' + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('')); note(`Picked ${St.color.toUpperCase()}`); break; }
      case 'text': addTextLayer(p.x, p.y); break;
      case 'fill': case 'wand': {
        if (l.kind === 'text') return note('Rasterize text first (merge it down)');
        pushHist();
        const g = ctx2d(l.canvas), img = g.getImageData(0, 0, l.canvas.width, l.canvas.height);
        const mask = floodRegion(img, Math.round(p.x - l.x), Math.round(p.y - l.y), St.tol);
        const col = hexToRgb(St.color), d = img.data; let n = 0;
        for (let i = 0; i < mask.length; i++) if (mask[i]) { n++; if (St.tool === 'wand') d[i * 4 + 3] = 0; else { d[i * 4] = col.r; d[i * 4 + 1] = col.g; d[i * 4 + 2] = col.b; d[i * 4 + 3] = 255; } }
        g.putImageData(img, 0, 0); render(); renderLayers(); note(`${St.tool === 'wand' ? 'Erased' : 'Filled'} ${(n / mask.length * 100).toFixed(1)}% of the layer`); break;
      }
      case 'clone':
        if (e.altKey) { St.cloneSrc = { x: p.x, y: p.y }; St.cloneOff = null; note('Clone source set — paint to copy from it'); render(); return; }
        if (!St.cloneSrc) return note('Alt-click to set a clone source first');
        if (!St.cloneOff) St.cloneOff = { x: St.cloneSrc.x - p.x, y: St.cloneSrc.y - p.y };
        cloneSource = cloneCanvas(l.canvas);
        // fallthrough to painting
      case 'brush': case 'eraser': case 'heal':
        if (l.kind === 'text') return note('Pick a pixel layer to paint on');
        pushHist(); drag = { type: 'paint', last: p }; dab(l, p.x, p.y, St.tool); render(); break;
      default:
    }
  }
  function onMove(e) {
    const p = toDoc(e); cursor = p;
    if (!drag) { render(); return; }
    const l = active();
    if (drag.type === 'pan') { St.ox = drag.ox + e.clientX - drag.x; St.oy = drag.oy + e.clientY - drag.y; render(); return; }
    if (drag.type === 'move') { l.x = Math.round(drag.lx + p.x - drag.sx); l.y = Math.round(drag.ly + p.y - drag.sy); render(); return; }
    if (drag.type === 'crop') {
      St.crop.x1 = clamp(p.x, 0, St.doc.w); St.crop.y1 = clamp(p.y, 0, St.doc.h);
      if (e.shiftKey) { const w = St.crop.x1 - St.crop.x0, h = St.crop.y1 - St.crop.y0, s = Math.max(Math.abs(w), Math.abs(h)); St.crop.x1 = St.crop.x0 + Math.sign(w || 1) * s; St.crop.y1 = St.crop.y0 + Math.sign(h || 1) * s; }
      render(); return;
    }
    if (drag.type === 'paint') {
      const spacing = Math.max(1, St.size * (St.tool === 'heal' ? 0.5 : 0.15)), dx = p.x - drag.last.x, dy = p.y - drag.last.y, dist = Math.hypot(dx, dy);
      for (let s = spacing; s <= dist; s += spacing) dab(l, drag.last.x + dx * s / dist, drag.last.y + dy * s / dist, St.tool);
      if (dist >= spacing) drag.last = p;
      render();
    }
  }
  function onUp() { if (drag && drag.type === 'paint') renderLayers(); drag = null; }
  let spaceHeld = false;

  /* ---------------- operations ---------------- */
  function applyToActive(label, fn) {
    const l = active(); if (!l) return;
    if (l.kind === 'text') return note('That works on pixel layers — merge the text down first');
    pushHist();
    const g = ctx2d(l.canvas), img = g.getImageData(0, 0, l.canvas.width, l.canvas.height);
    const t0 = performance.now(); const res = fn(img); g.putImageData(img, 0, 0);
    St.preview = null; render(); renderLayers();
    note(`${label}${res && res.msg ? ' — ' + res.msg : ''} (${Math.round(performance.now() - t0)} ms)`);
  }
  function resetAdj() { for (const a of ADJ) St.adj[a[0]] = a[5]; root && root.querySelectorAll('.st-adj input').forEach((i) => { i.value = St.adj[i.dataset.k]; i.nextElementSibling.textContent = fmtAdj(+i.value); }); }
  const fmtAdj = (v) => (v > 0 ? '+' : '') + Math.round(v * 100);
  let previewTimer = 0;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const l = active(); if (!l || l.kind === 'text') return;
      if (ADJ.every((a) => St.adj[a[0]] === a[5])) { St.preview = null; render(); return; }
      const c = cloneCanvas(l.canvas), g = ctx2d(c), img = g.getImageData(0, 0, c.width, c.height);
      adjustPixels(img, St.adj); g.putImageData(img, 0, 0);
      St.preview = { id: l.id, canvas: c }; render();
    }, 90);
  }
  function applyAdjust() {
    if (ADJ.every((a) => St.adj[a[0]] === a[5])) return note('Move a slider first');
    const p = { ...St.adj };
    applyToActive('Adjustments applied', (img) => adjustPixels(img, p));
    resetAdj();
  }
  function transformAll(kind) {
    pushHist();
    const rot = kind === 'rotl' || kind === 'rotr', W = St.doc.w, H = St.doc.h, nw = rot ? H : W, nh = rot ? W : H;
    for (const l of St.layers) {
      const full = newCanvas(W, H); full.getContext('2d').drawImage(l.canvas, l.x, l.y);
      const out = newCanvas(nw, nh), g = out.getContext('2d');
      if (kind === 'rotr') { g.translate(nw, 0); g.rotate(Math.PI / 2); }
      if (kind === 'rotl') { g.translate(0, nh); g.rotate(-Math.PI / 2); }
      if (kind === 'fliph') { g.translate(nw, 0); g.scale(-1, 1); }
      if (kind === 'flipv') { g.translate(0, nh); g.scale(1, -1); }
      g.drawImage(full, 0, 0);
      l.canvas = out; l.x = 0; l.y = 0;
      if (l.kind === 'text') { l.kind = 'paint'; l.text = null; } // transformed text becomes pixels
    }
    St.doc.w = nw; St.doc.h = nh; fit(); renderLayers();
  }
  function applyCrop() {
    if (!St.crop) return; const c = normRect(St.crop);
    if (c.w < 2 || c.h < 2) { St.crop = null; showCropBar(false); render(); return; }
    pushHist();
    const x = Math.round(c.x), y = Math.round(c.y), w = Math.round(c.w), h = Math.round(c.h);
    for (const l of St.layers) { l.x -= x; l.y -= y; }
    St.doc.w = w; St.doc.h = h; St.crop = null; showCropBar(false); fit(); renderLayers(); note(`Cropped to ${w}×${h}`);
  }
  function upscale2x() {
    if (St.doc.w * 2 > MAX_SIDE || St.doc.h * 2 > MAX_SIDE) return note(`Upscale would exceed ${MAX_SIDE}px`);
    pushHist();
    for (const l of St.layers) {
      const out = newCanvas(l.canvas.width * 2, l.canvas.height * 2), g = out.getContext('2d');
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(l.canvas, 0, 0, out.width, out.height);
      if (l.kind !== 'text') { const gg = ctx2d(out), img = gg.getImageData(0, 0, out.width, out.height); unsharp(img, 1.6, 0.7, 2); gg.putImageData(img, 0, 0); }
      l.canvas = out; l.x *= 2; l.y *= 2;
      if (l.kind === 'text' && l.text) { l.text.size *= 2; renderText(l); }
    }
    St.doc.w *= 2; St.doc.h *= 2; fit(); renderLayers(); note(`Upscaled to ${St.doc.w}×${St.doc.h} with detail sharpening`);
  }

  /* ---------------- layers ---------------- */
  function addLayer(kind = 'paint', init) {
    pushHist();
    const l = makeLayer(kind === 'paint' ? `Layer ${St.layers.length}` : 'Text', St.doc.w, St.doc.h, kind);
    if (init) init(l); // e.g. text content, so the panel never sees a half-built layer
    St.layers.splice(St.active + 1, 0, l); St.active += 1; renderLayers(); render(); return l;
  }
  function renderText(l) {
    const t = l.text, g = l.canvas.getContext('2d');
    g.font = `${t.weight || 700} ${t.size}px "${t.font}", sans-serif`;
    const lines = t.value.split('\n'), lh = t.size * 1.15;
    const w = Math.ceil(Math.max(1, ...lines.map((s) => g.measureText(s).width))) + 8, h = Math.ceil(lines.length * lh + t.size * 0.4);
    l.canvas.width = w; l.canvas.height = h;
    const g2 = l.canvas.getContext('2d'); g2.font = `${t.weight || 700} ${t.size}px "${t.font}", sans-serif`; g2.fillStyle = t.color; g2.textBaseline = 'alphabetic';
    if (t.shadow) { g2.shadowColor = 'rgba(0,0,0,.5)'; g2.shadowBlur = t.size * 0.2; }
    lines.forEach((s, i) => g2.fillText(s, 4, t.size + i * lh));
  }
  function addTextLayer(x, y) {
    const l = addLayer('text', (layer) => {
      layer.text = { value: 'Your text', size: Math.round(Math.max(24, St.doc.h / 12)), font: 'Syne', color: St.color, weight: 700, shadow: true };
      renderText(layer); layer.x = Math.round(x); layer.y = Math.round(y - layer.text.size);
    });
    syncOptions();
    const inp = root.querySelector('#stTextValue'); if (inp) { inp.focus(); inp.select(); }
  }
  function mergeDown() {
    if (St.active === 0) return note('Nothing below to merge into');
    pushHist();
    const top = St.layers[St.active], below = St.layers[St.active - 1];
    const full = newCanvas(St.doc.w, St.doc.h), g = full.getContext('2d');
    g.drawImage(below.canvas, below.x, below.y);
    g.globalAlpha = top.opacity; g.globalCompositeOperation = top.blend; g.drawImage(top.canvas, top.x, top.y);
    below.canvas = full; below.x = 0; below.y = 0; if (below.kind === 'text') { below.kind = 'paint'; below.text = null; }
    St.layers.splice(St.active, 1); St.active -= 1; renderLayers(); render();
  }
  function renderLayers() {
    const box = $('stLayers'); if (!box) return; box.innerHTML = '';
    for (let i = St.layers.length - 1; i >= 0; i--) {
      const l = St.layers[i], row = document.createElement('div');
      row.className = 'st-layer' + (i === St.active ? ' on' : '');
      const th = newCanvas(40, 28), tg = th.getContext('2d'); const k = Math.min(40 / St.doc.w, 28 / St.doc.h);
      tg.fillStyle = '#1A1A1A'; tg.fillRect(0, 0, 40, 28); tg.save(); tg.translate((40 - St.doc.w * k) / 2, (28 - St.doc.h * k) / 2); tg.scale(k, k); tg.drawImage(l.canvas, l.x, l.y); tg.restore();
      const eye = document.createElement('button'); eye.className = 'st-eye'; eye.textContent = l.visible ? 'ON' : 'OFF'; eye.title = 'Toggle visibility';
      eye.onclick = (e) => { e.stopPropagation(); l.visible = !l.visible; renderLayers(); render(); };
      const name = document.createElement('span'); name.textContent = l.name + (l.kind === 'text' ? ' · T' : '');
      name.ondblclick = () => { const n = prompt('Layer name', l.name); if (n) { l.name = n; renderLayers(); } };
      row.append(eye, th, name);
      row.onclick = () => { St.active = i; St.preview = null; resetAdj(); renderLayers(); syncOptions(); render(); };
      box.appendChild(row);
    }
    const l = active();
    if (l) { $('stOpacity').value = l.opacity; $('stBlend').value = l.blend; }
    syncOptions();
  }

  /* ---------------- UI ---------------- */
  const $ = (id) => document.getElementById(id);
  let noteTimer;
  function note(msg) { const el = $('stNote'); if (!el) return; el.textContent = msg; el.classList.add('show'); clearTimeout(noteTimer); noteTimer = setTimeout(() => el.classList.remove('show'), 2800); }
  function setColor(c) { St.color = c; const i = $('stColor'); if (i) i.value = c; const l = active(); if (l && l.kind === 'text' && St.tool === 'text') { /* explicit apply via text options */ } }
  function setTool(t) {
    St.tool = t; root.querySelectorAll('.st-tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    if (t !== 'crop' && St.crop) { St.crop = null; showCropBar(false); }
    view.style.cursor = t === 'move' ? 'move' : ['brush', 'eraser', 'clone', 'heal'].includes(t) ? 'none' : 'crosshair';
    syncOptions(); render();
  }
  function showCropBar(on) { $('stCropBar').hidden = !on; }
  function syncOptions() {
    const box = $('stOptions'); if (!box) return;
    const l = active(), t = St.tool;
    const showBrush = ['brush', 'eraser', 'clone', 'heal'].includes(t), showTol = ['fill', 'wand'].includes(t), showText = !!(l && l.kind === 'text' && l.text);
    box.querySelector('.o-brush').hidden = !showBrush; box.querySelector('.o-tol').hidden = !showTol; box.querySelector('.o-text').hidden = !showText;
    if (showText) { $('stTextValue').value = l.text.value; $('stTextSize').value = l.text.size; $('stTextFont').value = l.text.font; $('stTextColor').value = l.text.color; }
  }

  function build() {
    root = document.createElement('div'); root.id = 'studio'; root.className = 'studio'; root.hidden = true;
    root.innerHTML = `
      <header class="st-top">
        <div class="st-title"><svg class="mark" viewBox="0 0 96 96" aria-hidden="true"><rect x="12" y="12" width="16" height="72"/><path d="M36 48 72 12h18L54 48l36 36H72z"/></svg><strong>Image Studio</strong><span id="stName"></span></div>
        <div class="st-actions">
          <button class="btn small" id="stOpen">Open</button>
          <button class="btn small" id="stUndo" title="Ctrl+Z">Undo</button><button class="btn small" id="stRedo" title="Ctrl+Shift+Z">Redo</button>
          <button class="btn small" id="stPng">PNG</button><button class="btn small" id="stJpg">JPG</button>
          <button class="btn small primary" id="stSend">Add to timeline</button>
          <button class="btn small" id="stClose" title="Esc">Close</button>
          <input type="file" id="stFile" accept="image/*" hidden>
        </div>
      </header>
      <div class="st-options" id="stOptions">
        <label class="o-color"><span>Colour</span><input type="color" id="stColor" value="#E8E4DC"></label>
        <span class="o-brush"><label><span>Size</span><input type="range" id="stBrush" min="1" max="400" value="40"></label><label><span>Hardness</span><input type="range" id="stHard" min="0" max="1" step="0.01" value="0.6"></label><label><span>Flow</span><input type="range" id="stFlow" min="0.05" max="1" step="0.01" value="1"></label></span>
        <span class="o-tol"><label><span>Tolerance</span><input type="range" id="stTol" min="0" max="128" value="32"></label></span>
        <span class="o-text"><label><span>Text</span><input type="text" id="stTextValue"></label><label><span>Size</span><input type="number" id="stTextSize" min="6" max="1000"></label><label><span>Font</span><select id="stTextFont">${FONTS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label><label><span>Colour</span><input type="color" id="stTextColor"></label></span>
        <span class="st-cropbar" id="stCropBar" hidden><button class="btn small primary" id="stCropOk">Apply crop</button><button class="btn small" id="stCropNo">Cancel</button><small>Shift = square</small></span>
        <span class="st-meta"><span id="stSize"></span> · <span id="stZoom"></span> <button class="btn small" id="stFit">Fit</button></span>
      </div>
      <div class="st-body">
        <nav class="st-tools">${TOOLS.map(([id, key, name, tip]) => `<button class="st-tool" data-tool="${id}" title="${name} (${key}) — ${tip}"><b>${key}</b><small>${name}</small></button>`).join('')}</nav>
        <div class="st-stage"><canvas id="stView"></canvas><div class="st-note" id="stNote"></div></div>
        <aside class="st-panel">
          <section><h3>AI ENHANCE</h3><div class="st-grid">
            <button class="tool" data-op="auto"><b>Auto Enhance</b><small>levels · white balance · clarity</small></button>
            <button class="tool" data-op="upscale"><b>Upscale 2×</b><small>high-quality resample + detail</small></button>
            <button class="tool" data-op="removebg"><b>Remove Background</b><small>flat / studio backdrops</small></button>
            <button class="tool" data-op="denoise"><b>Denoise</b><small>edge-preserving smoothing</small></button>
          </div></section>
          <section><h3>ADJUST <button class="btn small" id="stAdjReset">Reset</button></h3>
            <div class="st-adj">${ADJ.map(([k, l, mn, mx, st, df]) => `<label class="slider"><span>${l}</span><input type="range" data-k="${k}" min="${mn}" max="${mx}" step="${st}" value="${df}"><output>0</output></label>`).join('')}</div>
            <button class="btn small primary st-apply" id="stAdjApply">Apply to layer</button>
          </section>
          <section><h3>FILTERS</h3><div class="st-chips">${[['blur', 'Blur'], ['sharpen', 'Sharpen'], ['bw', 'Black & white'], ['sepia', 'Sepia'], ['invert', 'Invert'], ['posterize', 'Posterize'], ['pixelate', 'Pixelate']].map(([k, t]) => `<button class="btn small" data-filter="${k}">${t}</button>`).join('')}</div></section>
          <section><h3>TRANSFORM</h3><div class="st-chips"><button class="btn small" data-tf="rotl">Rotate ⟲</button><button class="btn small" data-tf="rotr">Rotate ⟳</button><button class="btn small" data-tf="fliph">Flip H</button><button class="btn small" data-tf="flipv">Flip V</button></div></section>
          <section class="st-layers-sec"><h3>LAYERS</h3>
            <div class="st-layer-opts"><select id="stBlend">${BLENDS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select><label><span>Opacity</span><input type="range" id="stOpacity" min="0" max="1" step="0.01" value="1"></label></div>
            <div id="stLayers" class="st-layers"></div>
            <div class="st-chips"><button class="btn small" id="stAddLayer">New</button><button class="btn small" id="stDupLayer">Duplicate</button><button class="btn small" id="stMerge">Merge down</button><button class="btn small" id="stUp">Up</button><button class="btn small" id="stDown">Down</button><button class="btn small" id="stDelLayer">Delete</button></div>
          </section>
        </aside>
      </div>`;
    document.body.appendChild(root);
    view = $('stView'); vctx = view.getContext('2d');
    view.addEventListener('pointerdown', onDown); view.addEventListener('pointermove', onMove);
    view.addEventListener('pointerup', onUp); view.addEventListener('pointercancel', onUp);
    view.addEventListener('pointerleave', () => { cursor = null; render(); });
    view.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = view.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const z = clamp(St.zoom * Math.exp(-e.deltaY * 0.0015), 0.05, 32);
      St.ox = mx - (mx - St.ox) * z / St.zoom; St.oy = my - (my - St.oy) * z / St.zoom; St.zoom = z; render();
    }, { passive: false });
    root.querySelectorAll('.st-tool').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
    $('stColor').oninput = (e) => setColor(e.target.value);
    $('stBrush').oninput = (e) => { St.size = +e.target.value; render(); };
    $('stHard').oninput = (e) => (St.hardness = +e.target.value);
    $('stFlow').oninput = (e) => (St.flow = +e.target.value);
    $('stTol').oninput = (e) => (St.tol = +e.target.value);
    const textEdit = (fn) => { const l = active(); if (!l || l.kind !== 'text') return; fn(l.text); renderText(l); render(); };
    $('stTextValue').oninput = (e) => textEdit((t) => (t.value = e.target.value.replace(/\\n/g, '\n') || ' '));
    $('stTextSize').oninput = (e) => textEdit((t) => (t.size = clamp(+e.target.value || 12, 6, 1000)));
    $('stTextFont').onchange = (e) => textEdit((t) => (t.font = e.target.value));
    $('stTextColor').oninput = (e) => textEdit((t) => (t.color = e.target.value));
    $('stFit').onclick = fit;
    $('stCropOk').onclick = applyCrop; $('stCropNo').onclick = () => { St.crop = null; showCropBar(false); render(); };
    $('stUndo').onclick = undo; $('stRedo').onclick = redo;
    $('stClose').onclick = close;
    $('stOpen').onclick = () => { $('stFile').value = ''; $('stFile').click(); };
    $('stFile').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const img = new Image(); img.src = URL.createObjectURL(f);
      try { await img.decode(); loadDocument(img, f.name.replace(/\.[^.]+$/, '')); $('stName').textContent = St.doc.name; } catch (err) { note('Could not open that image'); }
      URL.revokeObjectURL(img.src);
    };
    const save = (type) => {
      const c = flatten(type === 'image/jpeg' ? '#FFFFFF' : null);
      c.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${St.doc.name}-edit.${type === 'image/jpeg' ? 'jpg' : 'png'}`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }, type, 0.92);
    };
    $('stPng').onclick = () => save('image/png'); $('stJpg').onclick = () => save('image/jpeg');
    $('stSend').onclick = () => {
      flatten().toBlob((b) => {
        const file = new File([b], `${St.doc.name}-edit.png`, { type: 'image/png' });
        if (St.onSend) { St.onSend(file); close(); } else note('Open from the editor to send to the timeline');
      }, 'image/png');
    };
    root.querySelectorAll('.st-adj input').forEach((i) => (i.oninput = () => { St.adj[i.dataset.k] = +i.value; i.nextElementSibling.textContent = fmtAdj(+i.value); schedulePreview(); }));
    $('stAdjReset').onclick = () => { resetAdj(); St.preview = null; render(); };
    $('stAdjApply').onclick = applyAdjust;
    root.querySelectorAll('[data-filter]').forEach((b) => (b.onclick = () => applyToActive(b.textContent, FILTERS[b.dataset.filter])));
    root.querySelectorAll('[data-tf]').forEach((b) => (b.onclick = () => transformAll(b.dataset.tf)));
    root.querySelectorAll('[data-op]').forEach((b) => (b.onclick = () => op(b.dataset.op)));
    $('stOpacity').oninput = (e) => { const l = active(); if (l) { l.opacity = +e.target.value; render(); } };
    $('stBlend').onchange = (e) => { const l = active(); if (l) { pushHist(); l.blend = e.target.value; render(); } };
    $('stAddLayer').onclick = () => addLayer('paint');
    $('stDupLayer').onclick = () => { const l = active(); if (!l) return; pushHist(); const c = { ...l, id: uid(), name: l.name + ' copy', canvas: cloneCanvas(l.canvas), text: l.text ? { ...l.text } : null }; St.layers.splice(St.active + 1, 0, c); St.active++; renderLayers(); render(); };
    $('stMerge').onclick = mergeDown;
    $('stUp').onclick = () => { if (St.active >= St.layers.length - 1) return; pushHist(); const [l] = St.layers.splice(St.active, 1); St.layers.splice(++St.active, 0, l); renderLayers(); render(); };
    $('stDown').onclick = () => { if (St.active <= 0) return; pushHist(); const [l] = St.layers.splice(St.active, 1); St.layers.splice(--St.active, 0, l); renderLayers(); render(); };
    $('stDelLayer').onclick = () => { if (St.layers.length <= 1) return note('Keep at least one layer'); pushHist(); St.layers.splice(St.active, 1); St.active = Math.max(0, St.active - 1); renderLayers(); render(); };
    window.addEventListener('resize', () => St.open && render());
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceHeld = false; }, true);
  }
  function op(name) {
    if (name === 'auto') applyToActive('Auto Enhance', (img) => { const r = autoEnhance(img); return { msg: `levels ${r.levels[0]}–${r.levels[1]}` }; });
    if (name === 'upscale') upscale2x();
    if (name === 'denoise') applyToActive('Denoise', (img) => denoise(img, 0.6));
    if (name === 'removebg') applyToActive('Background removed', (img) => { const f = removeFlatBackground(img, St.tol); return { msg: f < 0.01 ? 'no flat border colour found — try raising Tolerance with the Fill or Wand tool' : `${Math.round(f * 100)}% cleared` }; });
  }
  function onKey(e) {
    if (!St.open) return;
    const tag = e.target.tagName; const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    e.stopPropagation(); // the video editor underneath ignores keys while the studio is open
    if (e.key === 'Escape') { if (St.crop) { St.crop = null; showCropBar(false); render(); } else close(); return; }
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;
    if (e.code === 'Space') { spaceHeld = true; e.preventDefault(); return; }
    if (e.key === 'Enter' && St.crop) { applyCrop(); return; }
    if (e.key === '[') { St.size = clamp(St.size / 1.2, 1, 400); $('stBrush').value = St.size; render(); return; }
    if (e.key === ']') { St.size = clamp(St.size * 1.2, 1, 400); $('stBrush').value = St.size; render(); return; }
    if (e.key === '0') { fit(); return; }
    const t = TOOLS.find((x) => x[1].toLowerCase() === e.key.toLowerCase()); if (t) setTool(t[0]);
  }

  function open(opts = {}) {
    if (!root) build();
    St.onSend = opts.onSend || null;
    root.hidden = false; St.open = true;
    if (opts.source) loadDocument(opts.source, opts.name);
    else if (!St.layers.length) { const c = newCanvas(1920, 1080); const g = c.getContext('2d'); g.fillStyle = '#0A0A0A'; g.fillRect(0, 0, 1920, 1080); loadDocument(c, 'untitled'); }
    $('stName').textContent = St.doc.name;
    setTool(St.tool); requestAnimationFrame(fit);
  }
  function close() { if (!root) return; root.hidden = true; St.open = false; St.preview = null; }

  window.ImageStudio = {
    open, close, isOpen: () => St.open,
    // exposed for tests and the chat assistant
    _state: St, _ops: { autoEnhance, removeFlatBackground, adjustPixels, upscale2x, applyToActive, transformAll, op, flatten, setTool, undo, redo, applyAdjust },
  };
})();
