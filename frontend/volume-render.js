// volume-render.js — GPU ray-casting volume renderer (MIP + transfer-function).
//
// Reuses the WebGL2 context and TEXTURE_3D from gpu-volume.js.
// WebGL1 is not supported (no TEXTURE_3D for ray marching).
//
// Public API (window.volumeRender):
//   init(gpuHandle) → VolumeRenderer | null
//
// VolumeRenderer:
//   render(outCanvas, wc, ww, theta, phi)
//   setPreset(name)   — 'mip' | 'bone' | 'softTissue' | 'lung'
//   destroy()

(function (global) {
  'use strict';

  // ── Vertex shader — fullscreen quad ─────────────────────────────────────────
  const VERT = `#version 300 es
    in  vec2 a_pos;
    out vec2 v_uv;
    void main() {
      v_uv        = a_pos * 0.5 + 0.5;   // [-1,1] → [0,1]
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  // ── Fragment shader — MIP or front-to-back TF compositing ───────────────────
  const FRAG = `#version 300 es
    precision mediump float;

    uniform mediump sampler3D u_volume;
    uniform mediump sampler2D u_tf;     // 256×1 RGBA transfer function texture

    // Camera basis vectors (unit-length, computed in JS)
    uniform vec3  u_eye;
    uniform vec3  u_forward;
    uniform vec3  u_right;
    uniform vec3  u_up;

    // Projection
    uniform float u_tanFov;
    uniform float u_aspect;

    // Volume value range (from upload)
    uniform float u_min;
    uniform float u_max;

    // W/L (only used in MIP mode)
    uniform float u_wc;
    uniform float u_ww;

    // Mode & density
    // u_mip > 0.5 → MIP (windowed grayscale);  u_mip ≤ 0.5 → TF compositing
    uniform float u_mip;
    // Opacity scale for TF mode: higher = more opaque / thicker appearance
    uniform float u_density;

    in  vec2 v_uv;
    out vec4 fragColor;

    // ── Ray-AABB intersection ─────────────────────────────────────────────────
    // Volume occupies the unit cube [0,1]^3.
    // tNear = last slab entry t; tFar = first slab exit t.
    // Hit: tNear < tFar and tFar > 0.
    vec2 intersectBox(vec3 orig, vec3 dir) {
      vec3 tMin  = (vec3(0.0) - orig) / dir;
      vec3 tMax  = (vec3(1.0) - orig) / dir;
      vec3 tNear = min(tMin, tMax);
      vec3 tFar  = max(tMin, tMax);
      return vec2(max(max(tNear.x, tNear.y), tNear.z),
                  min(min(tFar.x,  tFar.y),  tFar.z));
    }

    void main() {
      // ── 1. Build perspective ray ──────────────────────────────────────────
      vec2 ndc    = v_uv * 2.0 - 1.0;
      vec3 rayDir = normalize(u_forward
                             + ndc.x * u_aspect * u_tanFov * u_right
                             + ndc.y *            u_tanFov * u_up);
      vec3 rayOrig = u_eye;

      // ── 2. Clip to volume bounding box ────────────────────────────────────
      vec2 t = intersectBox(rayOrig, rayDir);
      if (t.x >= t.y) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      t.x = max(t.x, 0.0);

      // ── 3. Ray march (256 steps) ──────────────────────────────────────────
      const int STEPS    = 256;
      float     stepSize = (t.y - t.x) / float(STEPS);

      // MIP accumulator
      float mipMax = 0.0;

      // TF front-to-back compositing accumulators
      vec3  accumColor = vec3(0.0);
      float accumAlpha = 0.0;

      for (int i = 0; i < STEPS; i++) {
        float tSample = t.x + (float(i) + 0.5) * stepSize;
        vec3  pos     = rayOrig + tSample * rayDir;

        // Raw normalised sample (0..1 maps to u_min..u_max HU)
        float norm = texture(u_volume, pos).r;

        if (u_mip > 0.5) {
          // ── MIP path: windowed grayscale maximum ──────────────────────────
          // Undo upload normalisation: hu = norm × (max − min) + min
          float hu  = norm * (u_max - u_min) + u_min;
          // W/L ramp: val = clamp((hu − low) / ww, 0, 1)
          float val = clamp((hu - (u_wc - u_ww * 0.5)) / u_ww, 0.0, 1.0);
          mipMax = max(mipMax, val);

        } else {
          // ── TF path: front-to-back alpha compositing ──────────────────────
          // Look up the 1D TF texture: x-coordinate = norm (raw [0,1] sample)
          vec4  tf = texture(u_tf, vec2(norm, 0.5));

          // Scale TF alpha by step size and user density control so the result
          // is independent of the number of march steps.
          float a = clamp(tf.a * stepSize * u_density, 0.0, 1.0);

          // Porter-Duff front-to-back composite:
          // accumColor += (1 − accumAlpha) × rgb × a
          // accumAlpha += (1 − accumAlpha) × a
          accumColor += (1.0 - accumAlpha) * tf.rgb * a;
          accumAlpha += (1.0 - accumAlpha) * a;

          // Early exit when fully opaque (saves ~30% march cost on solid bone)
          if (accumAlpha >= 0.99) break;
        }
      }

      // ── 4. Output ─────────────────────────────────────────────────────────
      vec3 rgb = (u_mip > 0.5)
        ? vec3(mipMax)
        : accumColor + (1.0 - accumAlpha) * vec3(0.0);   // black background

      fragColor = vec4(rgb, 1.0);
    }
  `;

  // ── Shader helpers ──────────────────────────────────────────────────────────

  function _compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('volumeRender compile:\n' + log);
    }
    return sh;
  }

  function _link(gl, vSrc, fSrc) {
    const vert = _compile(gl, gl.VERTEX_SHADER,   vSrc);
    const frag = _compile(gl, gl.FRAGMENT_SHADER, fSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('volumeRender link:\n' + log);
    }
    return prog;
  }

  // ── Camera helpers ──────────────────────────────────────────────────────────

  function _cross(a, b) {
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  }
  function _normalize(v) {
    const l = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]) || 1;
    return [v[0]/l, v[1]/l, v[2]/l];
  }

  function _camera(theta, phi, distance) {
    phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi));
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const st = Math.sin(theta), ct = Math.cos(theta);
    const eye = [0.5 + distance*sp*ct, 0.5 + distance*cp, 0.5 + distance*sp*st];
    const F = _normalize([0.5-eye[0], 0.5-eye[1], 0.5-eye[2]]);
    const R = _normalize(_cross(F, [0,1,0]));
    const U = _cross(R, F);
    return { eye, forward: F, right: R, up: U };
  }

  // ── Transfer-function presets ───────────────────────────────────────────────
  // Each preset is a function that fills a 256×4 (RGBA) Uint8Array.
  // x = 0 → u_min HU;  x = 255 → u_max HU.
  // The shader receives the raw normalised sample [0,1] as the x coordinate,
  // so the TF texture must be authored in that same normalised space.
  //
  // All presets are authored for a typical CT range of [-1000, +3000] HU
  // (4000 HU span), which matches gpu-volume.js's normalisation.
  // We map anatomical HU values to [0,1]: normHU = (hu - (-1000)) / 4000.

  function _normHU(hu) { return Math.max(0, Math.min(1, (hu + 1000) / 4000)); }

  // Smooth linear ramp between two normalised HU positions.
  function _ramp(x, lo, hi) {
    if (hi <= lo) return x >= lo ? 1.0 : 0.0;
    return Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  }

  const TF_PRESETS = {

    // MIP — no TF texture needed (shader ignores u_tf in MIP mode)
    mip: null,

    // Bone: faint translucent soft tissue + bright opaque cortical bone
    bone: function () {
      const data = new Uint8Array(256 * 4);
      const softLo = _normHU(-100), softHi = _normHU(200);   // fat→muscle
      const boneLo = _normHU(200),  boneHi = _normHU(700);   // trabecular→cortical
      for (let i = 0; i < 256; i++) {
        const x = i / 255;
        const softA = _ramp(x, softLo, softHi) * _ramp(softHi + 0.01, x, softHi + 0.3);
        const boneA = _ramp(x, boneLo, boneHi);
        const a     = Math.max(softA * 0.15, boneA * 0.9);  // bone dominates
        const boneT = _ramp(x, boneLo, boneHi);             // 0→trabecular, 1→cortical
        // Ivory/yellow for bone, pale pink for soft tissue
        const r = boneT > 0 ? (0.85 + boneT * 0.1) : 0.78;
        const g = boneT > 0 ? (0.75 + boneT * 0.05) : 0.5;
        const b = boneT > 0 ? (0.5  - boneT * 0.1)  : 0.45;
        const o  = i * 4;
        data[o]   = Math.round(r * 255);
        data[o+1] = Math.round(g * 255);
        data[o+2] = Math.round(b * 255);
        data[o+3] = Math.round(a * 255);
      }
      return data;
    },

    // Soft Tissue: transparent air + translucent fat/muscle + hidden bone
    softTissue: function () {
      const data = new Uint8Array(256 * 4);
      const fatLo  = _normHU(-150), fatHi  = _normHU(-20);
      const muscLo = _normHU(-20),  muscHi = _normHU(80);
      const boneOn = _normHU(200);
      for (let i = 0; i < 256; i++) {
        const x = i / 255;
        let r = 0, g = 0, b = 0, a = 0;
        if (x >= fatLo && x < fatHi) {
          // Fat: yellow-orange, low opacity
          const t = _ramp(x, fatLo, fatHi);
          r = 0.95; g = 0.75; b = 0.4; a = t * 0.25;
        } else if (x >= muscLo && x < muscHi) {
          // Muscle/organs: pink/red, moderate opacity
          const t = _ramp(x, muscLo, muscHi);
          r = 0.85; g = 0.35; b = 0.35; a = t * 0.55;
        } else if (x >= boneOn) {
          // Bone: faint grey, de-emphasised so organs remain visible
          r = 0.85; g = 0.85; b = 0.85; a = 0.12;
        }
        const o = i * 4;
        data[o]   = Math.round(r * 255);
        data[o+1] = Math.round(g * 255);
        data[o+2] = Math.round(b * 255);
        data[o+3] = Math.round(a * 255);
      }
      return data;
    },

    // Lung: transparent background + blue parenchyma + vessels + rib highlights
    lung: function () {
      const data = new Uint8Array(256 * 4);
      const airLo   = _normHU(-1000), airHi   = _normHU(-800);
      const lungLo  = _normHU(-800),  lungHi  = _normHU(-400);
      const vesLo   = _normHU(-400),  vesHi   = _normHU(60);
      const ribLo   = _normHU(200),   ribHi   = _normHU(700);
      for (let i = 0; i < 256; i++) {
        const x = i / 255;
        let r = 0, g = 0, b = 0, a = 0;
        if (x >= airLo && x < airHi) {
          // Very dark air → essentially invisible
          r = 0.05; g = 0.05; b = 0.1; a = _ramp(x, airLo, airHi) * 0.04;
        } else if (x >= lungLo && x < lungHi) {
          // Lung parenchyma: cyan/blue
          const t = _ramp(x, lungLo, lungHi);
          r = 0.1; g = 0.4 + t*0.15; b = 0.75 + t*0.2; a = t * 0.45;
        } else if (x >= vesLo && x < vesHi) {
          // Vessels / bronchi: soft red
          const t = _ramp(x, vesLo, vesHi);
          r = 0.85; g = 0.25; b = 0.2; a = t * 0.65;
        } else if (x >= ribLo) {
          // Ribs: warm ivory, moderate opacity
          const t = _ramp(x, ribLo, ribHi);
          r = 0.9; g = 0.85; b = 0.7; a = t * 0.55;
        }
        const o = i * 4;
        data[o]   = Math.round(r * 255);
        data[o+1] = Math.round(g * 255);
        data[o+2] = Math.round(b * 255);
        data[o+3] = Math.round(a * 255);
      }
      return data;
    },
  };

  // ── Upload a TF preset to a 256×1 RGBA8 texture ─────────────────────────────
  function _uploadTF(gl, tfTex, data) {
    gl.bindTexture(gl.TEXTURE_2D, tfTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, data
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // ── init ────────────────────────────────────────────────────────────────────

  function init(gpuHandle) {
    if (!gpuHandle) return null;
    if (!gpuHandle.webgl2) {
      console.warn('volumeRender: requires WebGL2 (TEXTURE_3D)');
      return null;
    }

    const { gl, canvas: glCanvas, texture, min, max } = gpuHandle;

    let prog;
    try {
      prog = _link(gl, VERT, FRAG);
    } catch (e) {
      console.warn('volumeRender: shader failed —', e.message);
      return null;
    }

    // Fullscreen quad
    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,-1,  1,-1,  -1, 1,
      -1, 1,  1,-1,   1, 1,
    ]), gl.STATIC_DRAW);

    // TF texture (256×1 RGBA8) — initialised with bone preset
    const tfTex = gl.createTexture();
    _uploadTF(gl, tfTex, TF_PRESETS.bone());

    // Cache uniform / attribute locations
    const L = {
      a_pos:    gl.getAttribLocation(prog,  'a_pos'),
      u_volume: gl.getUniformLocation(prog, 'u_volume'),
      u_tf:     gl.getUniformLocation(prog, 'u_tf'),
      u_eye:    gl.getUniformLocation(prog, 'u_eye'),
      u_forward:gl.getUniformLocation(prog, 'u_forward'),
      u_right:  gl.getUniformLocation(prog, 'u_right'),
      u_up:     gl.getUniformLocation(prog, 'u_up'),
      u_tanFov: gl.getUniformLocation(prog, 'u_tanFov'),
      u_aspect: gl.getUniformLocation(prog, 'u_aspect'),
      u_wc:     gl.getUniformLocation(prog, 'u_wc'),
      u_ww:     gl.getUniformLocation(prog, 'u_ww'),
      u_min:    gl.getUniformLocation(prog, 'u_min'),
      u_max:    gl.getUniformLocation(prog, 'u_max'),
      u_mip:    gl.getUniformLocation(prog, 'u_mip'),
      u_density:gl.getUniformLocation(prog, 'u_density'),
    };

    // Current mode state
    let curMip     = 0.0;   // 0 = TF compositing (bone default)
    let curDensity = 10.0;

    // ── render ───────────────────────────────────────────────────────────────

    function render(outCanvas, wc, ww, theta, phi) {
      const dw = outCanvas.clientWidth  || 512;
      const dh = outCanvas.clientHeight || 512;
      if (outCanvas.width  !== dw) outCanvas.width  = dw;
      if (outCanvas.height !== dh) outCanvas.height = dh;
      if (glCanvas.width !== dw || glCanvas.height !== dh) {
        glCanvas.width  = dw;
        glCanvas.height = dh;
      }

      gl.viewport(0, 0, dw, dh);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);

      // Volume texture → unit 0
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.uniform1i(L.u_volume, 0);

      // TF texture → unit 1
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tfTex);
      gl.uniform1i(L.u_tf, 1);

      // Camera
      const cam = _camera(theta, phi, 2.0);
      gl.uniform3fv(L.u_eye,     cam.eye);
      gl.uniform3fv(L.u_forward, cam.forward);
      gl.uniform3fv(L.u_right,   cam.right);
      gl.uniform3fv(L.u_up,      cam.up);

      // FOV 45° → tan(22.5°)
      gl.uniform1f(L.u_tanFov, Math.tan(Math.PI / 8));
      gl.uniform1f(L.u_aspect, dw / dh);

      // W/L (used by MIP path)
      gl.uniform1f(L.u_wc,  wc);
      gl.uniform1f(L.u_ww,  ww);
      gl.uniform1f(L.u_min, min);
      gl.uniform1f(L.u_max, max);

      // Mode
      gl.uniform1f(L.u_mip,     curMip);
      gl.uniform1f(L.u_density, curDensity);

      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(L.a_pos);
      gl.vertexAttribPointer(L.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      outCanvas.getContext('2d').drawImage(glCanvas, 0, 0, dw, dh);
    }

    // ── setPreset ────────────────────────────────────────────────────────────

    /**
     * @param {string} name  'mip' | 'bone' | 'softTissue' | 'lung'
     */
    function setPreset(name) {
      if (name === 'mip') {
        curMip     = 1.0;
        curDensity = 10.0;
        // No need to update TF texture — shader ignores it in MIP mode
      } else {
        const builder = TF_PRESETS[name];
        if (!builder) { console.warn('volumeRender: unknown preset', name); return; }
        curMip     = 0.0;
        curDensity = name === 'lung' ? 15.0 : 10.0;   // lung needs slightly higher density
        _uploadTF(gl, tfTex, builder());
      }
    }

    function destroy() {
      gl.deleteProgram(prog);
      gl.deleteBuffer(quadBuf);
      gl.deleteTexture(tfTex);
    }

    return { render, setPreset, destroy };
  }

  global.volumeRender = { init };

})(window);
