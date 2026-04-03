// volume-render.js — GPU ray-casting volume renderer (MIP).
//
// Reuses the WebGL2 context and TEXTURE_3D from gpu-volume.js.
// WebGL1 is not supported (no TEXTURE_3D for ray marching).
//
// Public API (window.volumeRender):
//   init(gpuHandle) → VolumeRenderer | null
//
// VolumeRenderer:
//   render(outCanvas, wc, ww, theta, phi)
//   destroy()

(function (global) {
  'use strict';

  // ── Vertex shader — fullscreen quad (identical to gpu-slice.js) ─────────────
  const VERT = `#version 300 es
    in  vec2 a_pos;
    out vec2 v_uv;
    void main() {
      v_uv        = a_pos * 0.5 + 0.5;   // [-1,1] → [0,1]
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  // ── Fragment shader — perspective ray caster ────────────────────────────────
  const FRAG = `#version 300 es
    precision mediump float;

    uniform mediump sampler3D u_volume;

    // Camera basis vectors (all unit-length, computed in JS)
    uniform vec3  u_eye;      // camera position in volume space [0,1]^3
    uniform vec3  u_forward;  // unit vector from eye toward scene centre
    uniform vec3  u_right;    // unit vector to the right on screen
    uniform vec3  u_up;       // unit vector upward on screen

    // Projection
    uniform float u_tanFov;   // tan(halfFOV) — controls field of view width
    uniform float u_aspect;   // canvas width / height

    // W/L (same uniforms as gpu-slice.js)
    uniform float u_wc;       // window centre (HU)
    uniform float u_ww;       // window width  (HU)
    uniform float u_min;      // HU value stored as texture 0.0
    uniform float u_max;      // HU value stored as texture 1.0

    in  vec2 v_uv;
    out vec4 fragColor;

    // ── Ray-AABB intersection ─────────────────────────────────────────────────
    // Volume occupies the unit cube [0,1]^3.
    // For each axis pair of parallel slabs, compute entry/exit t values:
    //   t = (face - orig) / dir   (IEEE 754: dir=0 gives ±inf, min/max still work)
    // tNear = max of all entry ts  (last slab the ray enters)
    // tFar  = min of all exit  ts  (first slab the ray exits)
    // Hit when tNear < tFar and tFar > 0.
    vec2 intersectBox(vec3 orig, vec3 dir) {
      vec3 tMin  = (vec3(0.0) - orig) / dir;
      vec3 tMax  = (vec3(1.0) - orig) / dir;
      vec3 tNear = min(tMin, tMax);
      vec3 tFar  = max(tMin, tMax);
      return vec2(max(max(tNear.x, tNear.y), tNear.z),
                  min(min(tFar.x,  tFar.y),  tFar.z));
    }

    void main() {
      // ── 1. Build perspective ray ────────────────────────────────────────────
      // NDC screen position: (-1,-1) = bottom-left, (+1,+1) = top-right
      vec2 ndc = v_uv * 2.0 - 1.0;

      // Reconstruct ray direction from camera basis and FOV:
      //   forward + horizontal_offset * right + vertical_offset * up
      vec3 rayDir  = normalize(u_forward
                              + ndc.x * u_aspect * u_tanFov * u_right
                              + ndc.y *            u_tanFov * u_up);
      vec3 rayOrig = u_eye;

      // ── 2. Clip ray to volume bounding box ─────────────────────────────────
      vec2 t = intersectBox(rayOrig, rayDir);
      if (t.x >= t.y) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      t.x = max(t.x, 0.0);   // camera may be inside the box; clamp to origin

      // ── 3. Ray march — Maximum Intensity Projection (MIP) ──────────────────
      // MIP: keep the highest windowed voxel value along the ray.
      // Simple, no lighting equations needed, great for CT bone/vessel detail.
      // 256 evenly-spaced samples span the full ray segment [tNear, tFar].
      const int   STEPS = 256;
      float stepSize = (t.y - t.x) / float(STEPS);

      float maxVal = 0.0;
      for (int i = 0; i < STEPS; i++) {
        float tSample = t.x + (float(i) + 0.5) * stepSize;
        vec3  pos     = rayOrig + tSample * rayDir;

        // Sample the 3-D texture (normalised [0,1] → HU → windowed)
        float norm = texture(u_volume, pos).r;

        // Undo upload normalisation: hu = norm × (max − min) + min
        float hu   = norm * (u_max - u_min) + u_min;

        // Window/Level ramp: val = clamp((hu − low) / ww, 0, 1)
        float val  = clamp((hu - (u_wc - u_ww * 0.5)) / u_ww, 0.0, 1.0);

        maxVal = max(maxVal, val);
      }

      // ── 4. Grayscale output ─────────────────────────────────────────────────
      fragColor = vec4(maxVal, maxVal, maxVal, 1.0);
    }
  `;

  // ── Shader helpers (same pattern as gpu-slice.js) ───────────────────────────

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
    return [
      a[1]*b[2] - a[2]*b[1],
      a[2]*b[0] - a[0]*b[2],
      a[0]*b[1] - a[1]*b[0],
    ];
  }

  function _normalize(v) {
    const l = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]) || 1;
    return [v[0]/l, v[1]/l, v[2]/l];
  }

  /**
   * Build camera basis from spherical angles.
   * theta: horizontal rotation (azimuth), phi: vertical (elevation from top).
   * Camera orbits the volume centre [0.5, 0.5, 0.5] at the given distance.
   * Phi is clamped away from the poles to avoid gimbal lock.
   */
  function _camera(theta, phi, distance) {
    phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi));

    const sp = Math.sin(phi), cp = Math.cos(phi);
    const st = Math.sin(theta), ct = Math.cos(theta);

    // Eye position on a sphere around [0.5, 0.5, 0.5]
    const eye = [
      0.5 + distance * sp * ct,
      0.5 + distance * cp,
      0.5 + distance * sp * st,
    ];

    // forward = normalize(centre − eye)
    const F = _normalize([0.5 - eye[0], 0.5 - eye[1], 0.5 - eye[2]]);

    // right = normalize(forward × worldUp)   [worldUp = (0,1,0)]
    const R = _normalize(_cross(F, [0, 1, 0]));

    // up = cross(right, forward)  — completes the orthonormal basis
    const U = _cross(R, F);

    return { eye, forward: F, right: R, up: U };
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

    // Fullscreen quad (two triangles)
    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,   1, -1,   -1,  1,
      -1,  1,   1, -1,    1,  1,
    ]), gl.STATIC_DRAW);

    // Cache all uniform / attribute locations up front
    const L = {
      a_pos:    gl.getAttribLocation(prog,  'a_pos'),
      u_volume: gl.getUniformLocation(prog, 'u_volume'),
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
    };

    // ── render ───────────────────────────────────────────────────────────────

    /**
     * @param {HTMLCanvasElement} outCanvas  visible 2-D output canvas
     * @param {number} wc    window centre (HU)
     * @param {number} ww    window width  (HU)
     * @param {number} theta azimuth angle (radians)
     * @param {number} phi   elevation angle from top (radians)
     */
    function render(outCanvas, wc, ww, theta, phi) {
      const dw = outCanvas.clientWidth  || 512;
      const dh = outCanvas.clientHeight || 512;

      // Resize both canvases to match display resolution
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

      // Bind the volume texture (already on GPU from gpu-volume.js)
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.uniform1i(L.u_volume, 0);

      // Camera: orbits at distance 2 around the volume centre
      const cam = _camera(theta, phi, 2.0);
      gl.uniform3fv(L.u_eye,     cam.eye);
      gl.uniform3fv(L.u_forward, cam.forward);
      gl.uniform3fv(L.u_right,   cam.right);
      gl.uniform3fv(L.u_up,      cam.up);

      // FOV = 45° → tan(22.5°) ≈ 0.4142
      gl.uniform1f(L.u_tanFov, Math.tan(Math.PI / 8));
      gl.uniform1f(L.u_aspect, dw / dh);

      // W/L
      gl.uniform1f(L.u_wc,  wc);
      gl.uniform1f(L.u_ww,  ww);
      gl.uniform1f(L.u_min, min);
      gl.uniform1f(L.u_max, max);

      // Draw fullscreen quad → ray caster runs per fragment
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(L.a_pos);
      gl.vertexAttribPointer(L.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Copy rendered frame from GL canvas → visible 2-D canvas
      outCanvas.getContext('2d').drawImage(glCanvas, 0, 0, dw, dh);
    }

    function destroy() {
      gl.deleteProgram(prog);
      gl.deleteBuffer(quadBuf);
    }

    return { render, destroy };
  }

  global.volumeRender = { init };

})(window);
