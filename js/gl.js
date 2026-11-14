/* WebGL grading renderer: framing → color controls → 3D LUT → vignette. */
(function () {
  'use strict';

  const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5); // y down, matches un-flipped texture rows
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

  const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_lut;
uniform sampler2D u_overlay;
uniform float u_ovOn;
uniform float u_lutSize;
uniform float u_lutAmt;
uniform vec4 u_rect;       // media-uv rect visible on canvas: x, y, w, h
uniform float u_raw;
uniform float u_exposure, u_contrast, u_highlights, u_shadows, u_temp, u_tint, u_sat, u_vibrance, u_vignette, u_fade;
uniform vec2 u_aspect;
uniform vec4 u_cover[4];   // output-uv boxes whose content is replaced by the surrounding background
uniform float u_coverN;
uniform vec2 u_px;         // one output pixel in uv

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 overlay(vec3 c) {
  if (u_ovOn < 0.5) return c;
  vec4 o = texture2D(u_overlay, v_uv);
  return mix(c, o.rgb, o.a);
}

vec3 srcAt(vec2 o) { return texture2D(u_tex, u_rect.xy + clamp(o, 0.0, 1.0) * u_rect.zw).rgb; }
vec3 ring(vec2 o, vec2 d) { return (srcAt(o) + srcAt(o + d) + srcAt(o + 2.0 * d)) / 3.0; } // a few pixels outward, averaged
// Coons patch: rebuild the inside of each box from its four edges, so text burned into the video disappears
vec3 cover(vec3 c) {
  for (int i = 0; i < 4; i++) {
    if (float(i) >= u_coverN) break;
    vec4 r = u_cover[i];
    vec2 q = (v_uv - r.xy) / r.zw;
    if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) continue;
    vec2 m = u_px * 2.0, dx = vec2(u_px.x * 2.0, 0.0), dy = vec2(0.0, u_px.y * 2.0);
    float x0 = r.x - m.x, x1 = r.x + r.z + m.x, y0 = r.y - m.y, y1 = r.y + r.w + m.y;
    float X = r.x + q.x * r.z, Y = r.y + q.y * r.w;
    vec3 T = ring(vec2(X, y0), -dy), B = ring(vec2(X, y1), dy), L = ring(vec2(x0, Y), -dx), R = ring(vec2(x1, Y), dx);
    vec3 TL = ring(vec2(x0, y0), -dx - dy), TR = ring(vec2(x1, y0), dx - dy), BL = ring(vec2(x0, y1), dy - dx), BR = ring(vec2(x1, y1), dx + dy);
    return (1.0 - q.y) * T + q.y * B + (1.0 - q.x) * L + q.x * R
      - ((1.0 - q.x) * (1.0 - q.y) * TL + q.x * (1.0 - q.y) * TR + (1.0 - q.x) * q.y * BL + q.x * q.y * BR);
  }
  return c;
}

vec3 lutLookup(vec3 c) {
  float n = u_lutSize;
  c = clamp(c, 0.0, 1.0);
  float bz = c.b * (n - 1.0);
  float b0 = floor(bz);
  float b1 = min(b0 + 1.0, n - 1.0);
  float f = bz - b0;
  float x = c.r * (n - 1.0) + 0.5;
  float y = (c.g * (n - 1.0) + 0.5) / n;
  vec3 s0 = texture2D(u_lut, vec2((b0 * n + x) / (n * n), y)).rgb;
  vec3 s1 = texture2D(u_lut, vec2((b1 * n + x) / (n * n), y)).rgb;
  return mix(s0, s1, f);
}

void main() {
  vec2 muv = u_rect.xy + v_uv * u_rect.zw;
  if (muv.x < 0.0 || muv.y < 0.0 || muv.x > 1.0 || muv.y > 1.0) { gl_FragColor = vec4(overlay(vec3(0.0)), 1.0); return; }
  vec3 c = texture2D(u_tex, muv).rgb;
  if (u_coverN > 0.0) c = clamp(cover(c), 0.0, 1.0);
  if (u_raw > 0.5) { gl_FragColor = vec4(overlay(c), 1.0); return; }

  // exposure (in stops, applied in approx-linear space)
  vec3 lin = pow(c, vec3(2.2));
  lin *= exp2(u_exposure);
  // white balance
  lin *= vec3(1.0 + u_temp * 0.18 - u_tint * 0.04, 1.0 + u_tint * 0.14, 1.0 - u_temp * 0.18 - u_tint * 0.04);
  c = pow(max(lin, 0.0), vec3(1.0 / 2.2));

  // highlights / shadows (luma-weighted)
  float l = luma(c);
  float shW = 1.0 - smoothstep(0.0, 0.5, l);
  float hiW = smoothstep(0.5, 1.0, l);
  c += c * u_shadows * 0.6 * shW + u_shadows * 0.08 * shW;
  c += u_highlights * 0.35 * hiW * (u_highlights < 0.0 ? c : (1.0 - c));

  // contrast around mid-grey with soft shoulder
  c = clamp((c - 0.5) * u_contrast + 0.5, 0.0, 1.0);

  // saturation + vibrance
  l = luma(c);
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  float vib = 1.0 + u_vibrance * (1.0 - sat);
  c = mix(vec3(l), c, u_sat * vib);
  c = clamp(c, 0.0, 1.0);

  // creative LUT
  if (u_lutAmt > 0.0) c = mix(c, lutLookup(c), u_lutAmt);

  // fade (lifted blacks)
  c = c * (1.0 - u_fade * 0.25) + u_fade * 0.12;

  // vignette
  if (u_vignette != 0.0) {
    vec2 d = (v_uv - 0.5) * u_aspect;
    float v = smoothstep(0.85, 0.25, length(d));
    c *= mix(1.0, v, clamp(u_vignette, 0.0, 1.0));
    if (u_vignette < 0.0) c = mix(c, vec3(1.0), (1.0 - v) * -u_vignette * 0.6);
  }
  gl_FragColor = vec4(overlay(clamp(c, 0.0, 1.0)), 1.0);
}`;

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      const opts = { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false };
      const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
      if (!gl) throw new Error('WebGL is not available in this browser.');
      this.gl = gl;
      this.prog = this._program(VERT, FRAG);
      gl.useProgram(this.prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(this.prog, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.u = {};
      const n = gl.getProgramParameter(this.prog, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(this.prog, i); this.u[info.name] = gl.getUniformLocation(this.prog, info.name); }
      this.tex = this._texture();
      this.lutTex = this._texture();
      this.ovTex = this._texture();
      this.ovOn = false;
      this.covers = [];
      gl.uniform1i(this.u.u_tex, 0);
      gl.uniform1i(this.u.u_lut, 1);
      gl.uniform1i(this.u.u_overlay, 2);
      this.hasFrame = false;
      this.mediaSize = [16, 9];
      this.setLut(null);
    }

    _program(vs, fs) {
      const gl = this.gl;
      const mk = (type, src) => {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    }

    _texture() {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      return t;
    }

    /** lut: {size, data: Float32Array rgb} or null (identity) */
    setLut(lut) {
      const gl = this.gl;
      if (!lut) lut = { size: 2, data: new Float32Array([0,0,0, 1,0,0, 0,1,0, 1,1,0, 0,0,1, 1,0,1, 0,1,1, 1,1,1]) };
      const n = lut.size, w = n * n, h = n;
      const px = new Uint8Array(w * h * 4);
      for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
        const si = ((b * n + g) * n + r) * 3;
        const di = (g * w + b * n + r) * 4;
        px[di] = Math.round(lut.data[si] * 255);
        px[di + 1] = Math.round(lut.data[si + 1] * 255);
        px[di + 2] = Math.round(lut.data[si + 2] * 255);
        px[di + 3] = 255;
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      this.lutSize = n;
    }

    /** Text/graphics layer drawn over the graded image (straight alpha, output-sized canvas) or null. */
    setOverlay(cv) {
      const gl = this.gl;
      this.ovOn = !!cv;
      if (!cv) return;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.ovTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    }

    /** Boxes ({x, y, w, h} in 0..1 of the output) to fill from their surroundings, before grading. Up to 4. */
    setCovers(list) { this.covers = (list || []).slice(0, 4); }

    /** Upload a frame from a video / image / canvas element. Returns true on success. */
    upload(el) {
      const gl = this.gl;
      const w = el.videoWidth || el.naturalWidth || el.width, h = el.videoHeight || el.naturalHeight || el.height;
      if (!w || !h) return false;
      if (el.tagName === 'VIDEO' && el.readyState < 2) return false;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el); } catch (e) { return false; }
      this.mediaSize = [w, h];
      this.hasFrame = true;
      return true;
    }

    clear() {
      const gl = this.gl;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      this.hasFrame = false;
    }

    /**
     * params: color settings; frame: {fit:'contain'|'cover', scale, cx, cy}
     */
    draw(params, frame, raw) {
      const gl = this.gl, u = this.u;
      const cw = this.canvas.width, ch = this.canvas.height;
      gl.viewport(0, 0, cw, ch);
      if (!this.hasFrame) { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); return; }
      const ma = this.mediaSize[0] / this.mediaSize[1], ca = cw / ch;
      let w, h;
      if (frame.fit === 'cover') { if (ma > ca) { h = 1; w = ca / ma; } else { w = 1; h = ma / ca; } }
      else { if (ma > ca) { w = 1; h = ma / ca; } else { h = 1; w = ca / ma; } }
      const s = frame.scale || 1;
      w /= s; h /= s;
      const cx = w <= 1 ? Math.min(1 - w / 2, Math.max(w / 2, frame.cx ?? 0.5)) : 0.5;
      const cy = h <= 1 ? Math.min(1 - h / 2, Math.max(h / 2, frame.cy ?? 0.5)) : 0.5;
      gl.useProgram(this.prog);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.ovTex);
      gl.uniform1f(u.u_ovOn, this.ovOn ? 1 : 0);
      gl.uniform4f(u.u_rect, cx - w / 2, cy - h / 2, w, h);
      this.lastRect = [cx - w / 2, cy - h / 2, w, h];
      const cov = new Float32Array(16);
      this.covers.forEach((b, i) => cov.set([b.x, b.y, b.w, b.h], i * 4));
      gl.uniform4fv(u['u_cover[0]'], cov);
      gl.uniform1f(u.u_coverN, this.covers.length);
      gl.uniform2f(u.u_px, 1 / cw, 1 / ch);
      gl.uniform1f(u.u_raw, raw ? 1 : 0);
      gl.uniform1f(u.u_lutSize, this.lutSize);
      gl.uniform1f(u.u_lutAmt, this.lutSize > 2 ? params.lutAmt : 0);
      gl.uniform1f(u.u_exposure, params.exposure);
      gl.uniform1f(u.u_contrast, params.contrast);
      gl.uniform1f(u.u_highlights, params.highlights);
      gl.uniform1f(u.u_shadows, params.shadows);
      gl.uniform1f(u.u_temp, params.temperature);
      gl.uniform1f(u.u_tint, params.tint);
      gl.uniform1f(u.u_sat, params.saturation);
      gl.uniform1f(u.u_vibrance, params.vibrance);
      gl.uniform1f(u.u_vignette, params.vignette);
      gl.uniform1f(u.u_fade, params.fade);
      gl.uniform2f(u.u_aspect, ca >= 1 ? ca : 1, ca >= 1 ? 1 : 1 / ca);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  window.Renderer = Renderer;
})();
