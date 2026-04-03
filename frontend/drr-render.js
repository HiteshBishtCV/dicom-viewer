// drr-render.js — Digitally Reconstructed Radiograph (DRR) renderer.
//
// A DRR simulates a plain X-ray from a CT volume.
//
// Physical analogy (Beer-Lambert law):
//   A real X-ray source emits photons that are exponentially attenuated as
//   they pass through tissue:  I = I₀ · exp(−∫ μ(x) dx)
//   where μ is the linear attenuation coefficient, closely proportional to
//   electron density and therefore to the CT Hounsfield Unit:
//       μ  ∝  HU + 1000   (air=-1000 → μ≈0; water=0 → μ≈1000; bone≈700 → μ≈1700)
//   The detector records transmitted intensity — dense structures appear darker
//   because they absorb more photons.
//
// This implementation:
//   • Orthographic (parallel) rays — no focal-spot geometry, simpler and
//     adequate for DRR use cases (radiation therapy planning, anatomy review).
//   • Accumulates attenuation along each ray (sum of μ·Δx).
//   • Applies Beer-Lambert inversion so bone = dark, air = bright.
//   • Mouse-drag changes the projection angle (theta / phi spherical coords).
//
// Public API (window.drrRender):
//   init(gpuHandle) → DRRRenderer | null
//
// DRRRenderer:
//   render(outCanvas, theta, phi, scale)
//   destroy()

(function (global) {
  'use strict';

  // ── Vertex shader — fullscreen quad ─────────────────────────────────────────
  const VERT = `#version 300 es
    in  vec2 a_pos;
    out vec2 v_uv;
    void main() {
      v_uv        = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  // ── Fragment shader ──────────────────────────────────────────────────────────
  const FRAG = `#version 300 es
    precision mediump float;

    uniform mediump sampler3D u_volume;

    // Orthographic ray basis (all unit-length, computed in JS from theta/phi).
    // Every pixel casts a parallel ray in u_rayDir; the screen plane is spanned
    // by u_right and u_up, both perpendicular to u_rayDir.
    uniform vec3  u_rayDir;   // direction each ray travels (normalised)
    uniform vec3  u_right;    // screen-right vector (perpendicular to rayDir)
    uniform vec3  u_up;       // screen-up vector (perpendicular to rayDir & right)
    uniform float u_aspect;   // canvas width / height

    // Volume HU range (from gpu-volume.js upload)
    uniform float u_min;      // HU value at normalised texture 0.0
    uniform float u_max;      // HU value at normalised texture 1.0

    // Contrast control:
    //   u_scale  multiplies the raw attenuation integral before exp().
    //   Larger → more contrast (darker structures stand out more).
    //   Typical range: 0.001 – 0.01.
    uniform float u_scale;

    in  vec2 v_uv;
    out vec4 fragColor;

    // ── Ray-AABB intersection ─────────────────────────────────────────────────
    // Volume occupies unit cube [0,1]^3.
    // Returns (tNear, tFar); hit when tNear < tFar.
    vec2 intersectBox(vec3 orig, vec3 dir) {
      vec3 tMin  = (vec3(0.0) - orig) / dir;
      vec3 tMax  = (vec3(1.0) - orig) / dir;
      vec3 tNear = min(tMin, tMax);
      vec3 tFar  = max(tMin, tMax);
      return vec2(max(max(tNear.x, tNear.y), tNear.z),
                  min(min(tFar.x,  tFar.y),  tFar.z));
    }

    void main() {
      // ── 1. Orthographic ray ───────────────────────────────────────────────
      // NDC position on the virtual detector plane.
      vec2 ndc = v_uv * 2.0 - 1.0;

      // Detector is centred at volume centre [0.5, 0.5, 0.5].
      // Scale 0.5 so the detector exactly covers the diagonal of the unit cube.
      // Aspect ratio compensates for non-square canvases.
      vec3 screenPos = vec3(0.5)
                     + (ndc.x * u_aspect * 0.5) * u_right
                     + (ndc.y          * 0.5) * u_up;

      // Push ray origin back along the *opposite* of rayDir so it starts
      // well outside the volume (distance 2 gives safe clearance for any angle).
      vec3 rayOrig = screenPos - 2.0 * u_rayDir;
      vec3 rayDir  = u_rayDir;

      // ── 2. Clip to volume ─────────────────────────────────────────────────
      vec2 t = intersectBox(rayOrig, rayDir);
      if (t.x >= t.y || t.y < 0.0) {
        // Ray misses volume — white background (no attenuation, like air)
        fragColor = vec4(1.0);
        return;
      }
      t.x = max(t.x, 0.0);

      // ── 3. Integrate attenuation along the ray ────────────────────────────
      // Discretise the ray segment [tNear, tFar] into STEPS equal steps.
      // 256 steps is enough for diagnostic quality without GPU stall.
      const int STEPS    = 256;
      float     stepSize = (t.y - t.x) / float(STEPS);
      float     attenSum = 0.0;

      for (int i = 0; i < STEPS; i++) {
        float tSam = t.x + (float(i) + 0.5) * stepSize;
        vec3  pos  = rayOrig + tSam * rayDir;

        // Convert normalised texture value back to HU
        float norm = texture(u_volume, pos).r;
        float hu   = norm * (u_max - u_min) + u_min;

        // Linear attenuation proxy: μ = max(0, HU + 1000).
        //   Air  (HU=-1000) → μ = 0   → transparent on X-ray
        //   Water(HU=0)     → μ = 1000 → moderate attenuation
        //   Bone (HU≈700)   → μ = 1700 → strong attenuation → dark on film
        attenSum += max(0.0, hu + 1000.0) * stepSize;
      }

      // ── 4. Beer-Lambert inversion ─────────────────────────────────────────
      // Transmitted fraction: I/I₀ = exp(−attenSum · u_scale)
      // High attenuation → low transmission → dark pixel (like X-ray film).
      float transmitted = exp(-attenSum * u_scale);

      fragColor = vec4(transmitted, transmitted, transmitted, 1.0);
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
      throw new Error('drrRender compile:\n' + log);
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
      throw new Error('drrRender link:\n' + log);
    }
    return prog;
  }

  // ── Projection basis from spherical angles ───────────────────────────────────
  // theta: azimuth (0 = AP view, π/2 = lateral)
  // phi:   elevation from superior pole (π/2 = horizontal beam)
  // Returns { rayDir, right, up } — all unit vectors.

  function _cross(a, b) {
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  }
  function _normalize(v) {
    const l = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]) || 1;
    return [v[0]/l, v[1]/l, v[2]/l];
  }

  function _basis(theta, phi) {
    phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi));
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const st = Math.sin(theta), ct = Math.cos(theta);

    // Ray travels from "source" toward "detector":
    // same parameterisation as the vol-tab camera forward vector.
    const rayDir = _normalize([sp * ct, cp, sp * st]);

    // right = rayDir × worldUp  (worldUp = [0,1,0])
    const right  = _normalize(_cross(rayDir, [0, 1, 0]));

    // up = right × rayDir  — completes orthonormal basis
    const up     = _normalize(_cross(right, rayDir));

    return { rayDir, right, up };
  }

  // ── init ────────────────────────────────────────────────────────────────────

  function init(gpuHandle) {
    if (!gpuHandle) return null;
    if (!gpuHandle.webgl2) {
      console.warn('drrRender: requires WebGL2 (TEXTURE_3D)');
      return null;
    }

    const { gl, canvas: glCanvas, texture, min, max } = gpuHandle;

    let prog;
    try {
      prog = _link(gl, VERT, FRAG);
    } catch (e) {
      console.warn('drrRender: shader failed —', e.message);
      return null;
    }

    // Fullscreen quad
    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,-1,  1,-1,  -1, 1,
      -1, 1,  1,-1,   1, 1,
    ]), gl.STATIC_DRAW);

    // Cache locations
    const L = {
      a_pos:    gl.getAttribLocation(prog,  'a_pos'),
      u_volume: gl.getUniformLocation(prog, 'u_volume'),
      u_rayDir: gl.getUniformLocation(prog, 'u_rayDir'),
      u_right:  gl.getUniformLocation(prog, 'u_right'),
      u_up:     gl.getUniformLocation(prog, 'u_up'),
      u_aspect: gl.getUniformLocation(prog, 'u_aspect'),
      u_min:    gl.getUniformLocation(prog, 'u_min'),
      u_max:    gl.getUniformLocation(prog, 'u_max'),
      u_scale:  gl.getUniformLocation(prog, 'u_scale'),
    };

    // ── render ───────────────────────────────────────────────────────────────

    /**
     * @param {HTMLCanvasElement} outCanvas  visible 2D output canvas
     * @param {number} theta  azimuth angle in radians
     * @param {number} phi    elevation angle (from top) in radians
     * @param {number} scale  attenuation scale (contrast), default 0.003
     */
    function render(outCanvas, theta, phi, scale) {
      const dw = outCanvas.clientWidth  || 512;
      const dh = outCanvas.clientHeight || 512;
      if (outCanvas.width  !== dw) outCanvas.width  = dw;
      if (outCanvas.height !== dh) outCanvas.height = dh;
      if (glCanvas.width !== dw || glCanvas.height !== dh) {
        glCanvas.width  = dw;
        glCanvas.height = dh;
      }

      gl.viewport(0, 0, dw, dh);
      gl.clearColor(1, 1, 1, 1);   // white clear (air background)
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.uniform1i(L.u_volume, 0);

      const b = _basis(theta, phi);
      gl.uniform3fv(L.u_rayDir, b.rayDir);
      gl.uniform3fv(L.u_right,  b.right);
      gl.uniform3fv(L.u_up,     b.up);
      gl.uniform1f(L.u_aspect, dw / dh);
      gl.uniform1f(L.u_min, min);
      gl.uniform1f(L.u_max, max);
      gl.uniform1f(L.u_scale, scale != null ? scale : 0.003);

      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(L.a_pos);
      gl.vertexAttribPointer(L.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      outCanvas.getContext('2d').drawImage(glCanvas, 0, 0, dw, dh);
    }

    function destroy() {
      gl.deleteProgram(prog);
      gl.deleteBuffer(quadBuf);
    }

    return { render, destroy };
  }

  global.drrRender = { init };

})(window);
