/* LUT library: procedural creative looks, .cube parsing, color-space helpers. */
(function () {
  'use strict';

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const mix = (a, b, t) => a + (b - a) * t;
  const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
  // gentle S-curve; k>0 adds contrast
  const scurve = (x, k) => { x = clamp01(x); return clamp01(mix(x, x * x * (3 - 2 * x), k)); };

  function satur(r, g, b, s) { const l = luma(r, g, b); return [mix(l, r, s), mix(l, g, s), mix(l, b, s)]; }

  /** Each look maps sRGB [0..1]^3 -> sRGB [0..1]^3 */
  const LOOKS = [
    { id: 'none', name: 'None', fn: (r, g, b) => [r, g, b] },
    { id: 'teal-orange', name: 'Teal & Orange', fn: (r, g, b) => {
      const l = luma(r, g, b);
      const sh = 1 - smooth(0.0, 0.55, l), hi = smooth(0.35, 1.0, l);
      r += -0.06 * sh + 0.07 * hi; g += 0.02 * sh + 0.015 * hi; b += 0.08 * sh - 0.07 * hi;
      [r, g, b] = satur(r, g, b, 1.12);
      return [scurve(r, 0.12), scurve(g, 0.12), scurve(b, 0.12)];
    } },
    { id: 'film-warm', name: 'Warm Film', fn: (r, g, b) => {
      r = r * 1.05 + 0.02; g = g * 1.0 + 0.01; b = b * 0.9 + 0.03;
      [r, g, b] = satur(r, g, b, 0.92);
      const lift = 0.04;
      return [scurve(lift + r * (1 - lift), 0.15), scurve(lift + g * (1 - lift), 0.15), scurve(lift * 0.8 + b * (1 - lift), 0.12)];
    } },
    { id: 'bleach', name: 'Bleach Bypass', fn: (r, g, b) => {
      const l = luma(r, g, b);
      const ov = (c) => (l < 0.5 ? 2 * c * l : 1 - 2 * (1 - c) * (1 - l));
      [r, g, b] = satur(mix(r, ov(r), 0.6), mix(g, ov(g), 0.6), mix(b, ov(b), 0.6), 0.55);
      return [scurve(r, 0.3), scurve(g, 0.3), scurve(b, 0.3)];
    } },
    { id: 'noir', name: 'Noir', fn: (r, g, b) => {
      const l = scurve(luma(r * 1.1, g, b * 0.9), 0.45);
      return [l, l, l * 0.98 + 0.01];
    } },
    { id: 'cross', name: 'Cross Process', fn: (r, g, b) => {
      r = scurve(r, 0.35); g = scurve(g, 0.2) * 1.03; b = clamp01(b * 0.75 + 0.12);
      return satur(r, g, b, 1.15).map(clamp01);
    } },
    { id: 'matte', name: 'Faded Matte', fn: (r, g, b) => {
      [r, g, b] = satur(r, g, b, 0.8);
      const f = (c) => 0.08 + clamp01(scurve(c, 0.1)) * 0.84;
      return [f(r) + 0.01, f(g), f(b) + 0.02];
    } },
    { id: 'night', name: 'Cool Night', fn: (r, g, b) => {
      r *= 0.85; g *= 0.95; b = b * 1.08 + 0.04;
      [r, g, b] = satur(r, g, b, 0.85);
      return [scurve(r * 0.92, 0.2), scurve(g * 0.95, 0.2), scurve(b, 0.15)];
    } },
    { id: 'vivid', name: 'Vivid Pop', fn: (r, g, b) => {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx - mn;
      const s = 1.35 - sat * 0.4; // vibrance-ish
      [r, g, b] = satur(r, g, b, s);
      return [scurve(r, 0.18), scurve(g, 0.18), scurve(b, 0.18)];
    } },
  ];

  /** Build a Float32 RGB LUT (size^3 * 3), red fastest, then green, then blue. */
  function buildLut(fn, size = 33) {
    const data = new Float32Array(size * size * size * 3);
    let i = 0;
    for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
      const o = fn(r / (size - 1), g / (size - 1), b / (size - 1));
      data[i++] = clamp01(o[0]); data[i++] = clamp01(o[1]); data[i++] = clamp01(o[2]);
    }
    return { size, data };
  }

  /** Sample a LUT on the CPU (trilinear). Used for swatches. */
  function sampleLut(lut, r, g, b) {
    const n = lut.size, d = lut.data, m = n - 1;
    const fr = clamp01(r) * m, fg = clamp01(g) * m, fb = clamp01(b) * m;
    const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
    const r1 = Math.min(r0 + 1, m), g1 = Math.min(g0 + 1, m), b1 = Math.min(b0 + 1, m);
    const dr = fr - r0, dg = fg - g0, db = fb - b0;
    const idx = (ri, gi, bi) => ((bi * n + gi) * n + ri) * 3;
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const c00 = mix(d[idx(r0, g0, b0) + c], d[idx(r1, g0, b0) + c], dr);
      const c10 = mix(d[idx(r0, g1, b0) + c], d[idx(r1, g1, b0) + c], dr);
      const c01 = mix(d[idx(r0, g0, b1) + c], d[idx(r1, g0, b1) + c], dr);
      const c11 = mix(d[idx(r0, g1, b1) + c], d[idx(r1, g1, b1) + c], dr);
      out[c] = mix(mix(c00, c10, dg), mix(c01, c11, dg), db);
    }
    return out;
  }

  /** Parse an Adobe/Resolve .cube file (3D only). */
  function parseCube(text) {
    let size = 0, dmin = [0, 0, 0], dmax = [1, 1, 1], title = '';
    const vals = [];
    const lines = text.split(/\r?\n/);
    for (let raw of lines) {
      const line = raw.trim();
      if (!line || line[0] === '#') continue;
      const parts = line.split(/\s+/);
      const key = parts[0].toUpperCase();
      if (key === 'TITLE') { title = line.slice(5).trim().replace(/^"|"$/g, ''); continue; }
      if (key === 'LUT_3D_SIZE') { size = parseInt(parts[1], 10); continue; }
      if (key === 'LUT_1D_SIZE') throw new Error('1D .cube LUTs are not supported — please use a 3D LUT.');
      if (key === 'DOMAIN_MIN') { dmin = parts.slice(1, 4).map(Number); continue; }
      if (key === 'DOMAIN_MAX') { dmax = parts.slice(1, 4).map(Number); continue; }
      if (/^[A-Z_]+$/.test(key)) continue; // unknown keyword
      if (parts.length >= 3) vals.push(+parts[0], +parts[1], +parts[2]);
    }
    if (!size || size < 2 || size > 129) throw new Error('Missing or invalid LUT_3D_SIZE.');
    if (vals.length < size * size * size * 3) throw new Error(`Expected ${size ** 3} entries, found ${vals.length / 3}.`);
    const data = new Float32Array(size * size * size * 3);
    for (let i = 0; i < data.length; i++) {
      const c = i % 3;
      data[i] = clamp01((vals[i] - dmin[c]) / ((dmax[c] - dmin[c]) || 1));
    }
    return { size, data, title };
  }

  // --- sRGB <-> CIELAB for color matching ---
  const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055);
  const Xn = 0.95047, Yn = 1.0, Zn = 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fi = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
  function rgbToLab(r, g, b) {
    r = toLin(r); g = toLin(g); b = toLin(b);
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / Xn;
    const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / Yn;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / Zn;
    const fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function labToRgb(L, a, bb) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
    const x = fi(fx) * Xn, y = fi(fy) * Yn, z = fi(fz) * Zn;
    const r = 3.2406 * x - 1.5372 * y - 0.4986 * z;
    const g = -0.9689 * x + 1.8758 * y + 0.0415 * z;
    const b = 0.0557 * x - 0.204 * y + 1.057 * z;
    return [clamp01(toSrgb(r)), clamp01(toSrgb(g)), clamp01(toSrgb(b))];
  }

  /** Mean / std in Lab of RGBA pixel data (Uint8ClampedArray). */
  function labStats(pixels) {
    const n = pixels.length / 4;
    const sum = [0, 0, 0], sq = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) {
      const lab = rgbToLab(pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255);
      for (let c = 0; c < 3; c++) { sum[c] += lab[c]; sq[c] += lab[c] * lab[c]; }
    }
    const mean = sum.map((s) => s / n);
    const std = sq.map((s, c) => Math.sqrt(Math.max(s / n - mean[c] * mean[c], 1e-6)));
    return { mean, std };
  }

  /** Reinhard-style statistical color transfer as a 3D LUT. */
  function colorTransferLut(src, ref, strength = 0.85, size = 33) {
    const ratio = src.std.map((s, c) => Math.min(2.2, Math.max(0.45, ref.std[c] / s)));
    return buildLut((r, g, b) => {
      const lab = rgbToLab(r, g, b);
      const out = lab.map((v, c) => (v - src.mean[c]) * ratio[c] + ref.mean[c]);
      const res = labToRgb(out[0], out[1], out[2]);
      return [mix(r, res[0], strength), mix(g, res[1], strength), mix(b, res[2], strength)];
    }, size);
  }

  window.LUTS = { LOOKS, buildLut, sampleLut, parseCube, labStats, colorTransferLut, clamp01, luma };
})();
