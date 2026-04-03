// gpu-slice.js — GPU axial slice rendering via WebGL shaders.
//
// Requires gpu-volume.js to have already uploaded the volume texture.
//
// Public API (window.gpuSlice):
//   init(gpuHandle) → SliceRenderer | null
//
// SliceRenderer:
//   renderAxial(z, wc, ww)   — render axial slice z with window centre/width
//   destroy()                — remove canvas from DOM, free GL resources
//
// The GPU canvas is inserted into the axial mprPane automatically.
// The existing CPU axialCanvas is untouched.

(function (global) {
  'use strict';

  // ── Vertex shaders ──────────────────────────────────────────────────────────
  // Draws a fullscreen quad (6 verts, 2 triangles) covering NDC [-1,1]×[-1,1].
  // UV: (0,0)=bottom-left, (1,1)=top-right — standard WebGL convention.

  const VERT_GL2 = `#version 300 es
    in  vec2 a_pos;
    out vec2 v_uv;
    void main() {
      v_uv        = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const VERT_GL1 = `
    attribute vec2 a_pos;
    varying   vec2 v_uv;
    void main() {
      v_uv        = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  // ── Fragment shaders ────────────────────────────────────────────────────────

  // WebGL2 — samples TEXTURE_3D.
  // Row 0 of the image was uploaded as the first element of the buffer, which
  // lands at texture v=0 (bottom).  Flipping (1.0 - v_uv.y) maps screen-top
  // to v=0, so row 0 appears at the top of the display — matching the CPU path.
  const FRAG_GL2 = `#version 300 es
    precision mediump float;
    uniform mediump sampler3D u_volume;
    uniform float u_sliceZ;  // normalised [0,1]: (z + 0.5) / depth
    uniform float u_wc;      // window centre (HU)
    uniform float u_ww;      // window width  (HU)
    uniform float u_min;     // HU value stored as texture 0.0
    uniform float u_max;     // HU value stored as texture 1.0
    in  vec2 v_uv;
    out vec4 fragColor;
    void main() {
      float norm = texture(u_volume, vec3(v_uv.x, 1.0 - v_uv.y, u_sliceZ)).r;
      float hu   = norm * (u_max - u_min) + u_min;
      float val  = clamp((hu - (u_wc - u_ww * 0.5)) / u_ww, 0.0, 1.0);
      fragColor  = vec4(val, val, val, 1.0);
    }
  `;

  // WebGL1 — samples TEXTURE_2D atlas (slices stacked bottom-to-top in GPU memory).
  // Atlas layout: slice z occupies v ∈ [z/depth, (z+1)/depth].
  // Row 0 of slice z (top of image) sits at atlas v = z/depth.
  // Screen-top (v_uv.y=1) must map to v=z/depth, giving:
  //   atlas_v = (u_sliceIdx + 1.0 - v_uv.y) / u_depth
  const FRAG_GL1 = `
    precision mediump float;
    uniform sampler2D u_volume;
    uniform float u_sliceIdx; // integer slice index (0..depth-1) passed as float
    uniform float u_depth;    // total slice count
    uniform float u_wc;
    uniform float u_ww;
    uniform float u_min;
    uniform float u_max;
    varying vec2 v_uv;
    void main() {
      float atlas_v = (u_sliceIdx + 1.0 - v_uv.y) / u_depth;
      float norm    = texture2D(u_volume, vec2(v_uv.x, atlas_v)).r;
      float hu      = norm * (u_max - u_min) + u_min;
      float val     = clamp((hu - (u_wc - u_ww * 0.5)) / u_ww, 0.0, 1.0);
      gl_FragColor  = vec4(val, val, val, 1.0);
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
      throw new Error('gpuSlice shader compile:\n' + log);
    }
    return sh;
  }

  function _link(gl, vertSrc, fragSrc) {
    const vert = _compile(gl, gl.VERTEX_SHADER,   vertSrc);
    const frag = _compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('gpuSlice program link:\n' + log);
    }
    return prog;
  }

  // ── init ────────────────────────────────────────────────────────────────────

  /**
   * Build a SliceRenderer from an existing GpuVolumeHandle.
   * @param {object} gpuHandle  — returned by gpuVolume.uploadVolumeToGPU()
   * @returns {object|null}     — SliceRenderer, or null on any failure
   */
  function init(gpuHandle) {
    if (!gpuHandle) return null;

    const { gl, canvas, texture, depth, min, max, webgl2 } = gpuHandle;

    // ── Build shader program ────────────────────────────────────────────────
    let prog;
    try {
      prog = webgl2
        ? _link(gl, VERT_GL2, FRAG_GL2)
        : _link(gl, VERT_GL1, FRAG_GL1);
    } catch (e) {
      console.warn('gpuSlice: shader build failed —', e.message);
      return null;
    }

    // ── Fullscreen quad buffer ──────────────────────────────────────────────
    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,   1, -1,   -1,  1,
      -1,  1,   1, -1,    1,  1,
    ]), gl.STATIC_DRAW);

    // ── Cache uniform / attribute locations ────────────────────────────────
    const a_pos    = gl.getAttribLocation(prog,  'a_pos');
    const u_volume = gl.getUniformLocation(prog, 'u_volume');
    const u_wc     = gl.getUniformLocation(prog, 'u_wc');
    const u_ww     = gl.getUniformLocation(prog, 'u_ww');
    const u_min    = gl.getUniformLocation(prog, 'u_min');
    const u_max    = gl.getUniformLocation(prog, 'u_max');
    // WebGL2 uses u_sliceZ (0..1); WebGL1 uses u_sliceIdx + u_depth.
    const u_sliceZ   = webgl2 ? gl.getUniformLocation(prog, 'u_sliceZ')   : null;
    const u_sliceIdx = webgl2 ? null : gl.getUniformLocation(prog, 'u_sliceIdx');
    const u_depth_u  = webgl2 ? null : gl.getUniformLocation(prog, 'u_depth');

    // ── Insert GPU canvas into axial pane ──────────────────────────────────
    // The gpuHandle canvas lives in document.body (hidden). Move it into the
    // axial mprPane so it appears directly below the CPU canvas.
    const axialEl = document.getElementById('axialCanvas');
    const pane    = axialEl && axialEl.closest('.mprPane');
    if (pane) {
      const label       = document.createElement('div');
      label.className   = 'mprLabel';
      label.textContent = 'AXIAL \u00b7 GPU (' + (webgl2 ? 'WebGL2 · 3D tex' : 'WebGL1 · atlas') + ')';
      label.style.color = '#81c784';  // green to distinguish from CPU label

      canvas.style.cssText = 'width:100%;aspect-ratio:1/1;background:#000;display:block;';
      pane.appendChild(label);
      pane.appendChild(canvas);
    } else {
      // Fallback: make it visible in body if pane not found yet
      canvas.style.cssText = 'width:300px;height:300px;background:#000;display:block;margin-top:8px;';
    }

    // ── renderAxial ─────────────────────────────────────────────────────────

    /**
     * Render axial slice z with window centre wc and window width ww.
     * @param {number} z   — slice index (0 .. depth-1)
     * @param {number} wc  — window centre in HU
     * @param {number} ww  — window width  in HU
     */
    function renderAxial(z, wc, ww) {
      // Match canvas pixel size to its CSS display size.
      const dw = canvas.clientWidth  || 300;
      const dh = canvas.clientHeight || 300;
      if (canvas.width !== dw || canvas.height !== dh) {
        canvas.width  = dw;
        canvas.height = dh;
      }

      gl.viewport(0, 0, dw, dh);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(prog);

      // Bind volume texture to unit 0
      const target = webgl2 ? gl.TEXTURE_3D : gl.TEXTURE_2D;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(target, texture);
      gl.uniform1i(u_volume, 0);

      // Slice position
      if (webgl2) {
        gl.uniform1f(u_sliceZ, (z + 0.5) / depth);
      } else {
        gl.uniform1f(u_sliceIdx, z);
        gl.uniform1f(u_depth_u,  depth);
      }

      // W/L + HU range
      gl.uniform1f(u_wc,  wc);
      gl.uniform1f(u_ww,  ww);
      gl.uniform1f(u_min, min);
      gl.uniform1f(u_max, max);

      // Draw fullscreen quad
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(a_pos);
      gl.vertexAttribPointer(a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // ── destroy ─────────────────────────────────────────────────────────────

    function destroy() {
      gl.deleteProgram(prog);
      gl.deleteBuffer(quadBuf);
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }

    return { renderAxial, destroy };
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  global.gpuSlice = { init };

})(window);
