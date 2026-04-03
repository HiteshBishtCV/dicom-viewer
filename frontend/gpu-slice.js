// gpu-slice.js — GPU MPR slice rendering (axial · coronal · sagittal).
//
// Requires gpu-volume.js (window.gpuVolume) to have uploaded the texture first.
//
// Public API (window.gpuSlice):
//   init(gpuHandle) → SliceRenderer | null
//
// SliceRenderer:
//   renderAxial(z, wc, ww)
//   renderCoronal(y, wc, ww)
//   renderSagittal(x, wc, ww)
//   destroy()
//
// Strategy:
//   WebGL2  — one parameterised TEXTURE_3D shader covers all three planes.
//             Per-plane origin/dx/dy uniforms encode the texture axis mapping.
//             Renders into the hidden gpuHandle.canvas, then drawImage() copies
//             the result to a per-plane visible 2-D canvas.
//   WebGL1  — 2-D atlas can only support axial efficiently; coronal and sagittal
//             are no-ops (CPU path continues for those planes unchanged).
//
// Texture coordinate derivation (3-D texture, WebGL2):
//   data[0] → texel (u=0, v=0, w=0).  Row 0 of each slice lands at v=0 (GL
//   bottom), slice 0 at w=0.  Screen UV: v_uv=a_pos*0.5+0.5, so (0,0)=screen
//   bottom-left, (1,1)=top-right.
//
//   Axial   (w fixed):  u=v_uv.x,   v=1-v_uv.y,  w=(z+.5)/D
//     origin=(0,1,w)   dx=(1,0,0)   dy=(0,-1,0)
//
//   Coronal (v fixed, L-on-left flip, slice-0 at top):
//     origin=(1,v,1)   dx=(-1,0,0)  dy=(0,0,-1)
//
//   Sagittal(u fixed, P-on-left flip, slice-0 at top):
//     origin=(u,1,1)   dx=(0,-1,0)  dy=(0,0,-1)

(function (global) {
  'use strict';

  // ── Vertex shaders (unchanged from before) ──────────────────────────────────
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

  // ── Fragment shader — WebGL2 ────────────────────────────────────────────────
  // Parameterised by origin/dx/dy so one program handles all three planes.
  const FRAG_GL2 = `#version 300 es
    precision mediump float;
    uniform mediump sampler3D u_volume;
    uniform vec3  u_origin;  // texture coord at screen (0,0) = bottom-left
    uniform vec3  u_dx;      // texture coord delta per unit v_uv.x
    uniform vec3  u_dy;      // texture coord delta per unit v_uv.y
    uniform float u_wc;      // window centre (HU)
    uniform float u_ww;      // window width  (HU)
    uniform float u_min;     // HU value stored as tex 0.0
    uniform float u_max;     // HU value stored as tex 1.0
    in  vec2 v_uv;
    out vec4 fragColor;
    void main() {
      vec3  coord = u_origin + v_uv.x * u_dx + v_uv.y * u_dy;
      float norm  = texture(u_volume, coord).r;
      float hu    = norm * (u_max - u_min) + u_min;
      float val   = clamp((hu - (u_wc - u_ww * 0.5)) / u_ww, 0.0, 1.0);
      fragColor   = vec4(val, val, val, 1.0);
    }
  `;

  // ── Fragment shader — WebGL1 (axial via 2-D atlas only) ────────────────────
  const FRAG_GL1 = `
    precision mediump float;
    uniform sampler2D u_volume;
    uniform float u_sliceIdx;
    uniform float u_depth;
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
      throw new Error('gpuSlice compile:\n' + log);
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
      throw new Error('gpuSlice link:\n' + log);
    }
    return prog;
  }

  // ── DOM helper — create a labelled output canvas in an mprPane ─────────────
  function _makeOutputCanvas(siblingId, labelText) {
    const sibling = document.getElementById(siblingId);
    const pane    = sibling && sibling.closest('.mprPane');
    const out     = document.createElement('canvas');
    out.style.cssText = 'width:100%;aspect-ratio:1/1;background:#000;display:block;';
    if (pane) {
      const lbl       = document.createElement('div');
      lbl.className   = 'mprLabel';
      lbl.textContent = labelText;
      lbl.style.color = '#81c784';   // green distinguishes GPU from CPU label
      pane.appendChild(lbl);
      pane.appendChild(out);
    }
    return out;
  }

  // ── init ────────────────────────────────────────────────────────────────────

  function init(gpuHandle) {
    if (!gpuHandle) return null;

    const { gl, canvas: glCanvas, texture, width, height, depth, min, max, webgl2 } = gpuHandle;

    // ── Build shader program ────────────────────────────────────────────────
    let prog;
    try {
      prog = webgl2 ? _link(gl, VERT_GL2, FRAG_GL2)
                    : _link(gl, VERT_GL1, FRAG_GL1);
    } catch (e) {
      console.warn('gpuSlice: shader build failed —', e.message);
      return null;
    }

    // ── Fullscreen quad ─────────────────────────────────────────────────────
    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,   1, -1,   -1,  1,
      -1,  1,   1, -1,    1,  1,
    ]), gl.STATIC_DRAW);

    // ── Uniform / attribute locations ───────────────────────────────────────
    const a_pos    = gl.getAttribLocation(prog,  'a_pos');
    const u_volume = gl.getUniformLocation(prog, 'u_volume');
    const u_wc     = gl.getUniformLocation(prog, 'u_wc');
    const u_ww     = gl.getUniformLocation(prog, 'u_ww');
    const u_min    = gl.getUniformLocation(prog, 'u_min');
    const u_max    = gl.getUniformLocation(prog, 'u_max');

    // WebGL2-only uniforms (plane parameterisation)
    const u_origin   = webgl2 ? gl.getUniformLocation(prog, 'u_origin')   : null;
    const u_dx       = webgl2 ? gl.getUniformLocation(prog, 'u_dx')       : null;
    const u_dy       = webgl2 ? gl.getUniformLocation(prog, 'u_dy')       : null;
    // WebGL1-only uniforms (axial atlas)
    const u_sliceIdx = webgl2 ? null : gl.getUniformLocation(prog, 'u_sliceIdx');
    const u_depthU   = webgl2 ? null : gl.getUniformLocation(prog, 'u_depth');

    // ── Output canvases (visible 2-D; glCanvas is the hidden render target) ─
    const axialOut    = _makeOutputCanvas('axialCanvas',    'AXIAL \u00b7 GPU');
    const coronalOut  = webgl2 ? _makeOutputCanvas('coronalCanvas',  'CORONAL \u00b7 GPU') : null;
    const sagittalOut = webgl2 ? _makeOutputCanvas('sagittalCanvas', 'SAGITTAL \u00b7 GPU') : null;

    // ── Core draw helper (WebGL2 only) ──────────────────────────────────────
    // Resizes glCanvas to match out, renders with given plane coords, copies.
    function _drawGL2(origin, dx, dy, wc, ww, out) {
      const dw = out.clientWidth  || 300;
      const dh = out.clientHeight || 300;
      if (out.width  !== dw) out.width  = dw;
      if (out.height !== dh) out.height = dh;
      if (glCanvas.width !== dw || glCanvas.height !== dh) {
        glCanvas.width  = dw;
        glCanvas.height = dh;
      }

      gl.viewport(0, 0, dw, dh);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.uniform1i(u_volume, 0);

      gl.uniform3fv(u_origin, origin);
      gl.uniform3fv(u_dx,     dx);
      gl.uniform3fv(u_dy,     dy);
      gl.uniform1f(u_wc,  wc);
      gl.uniform1f(u_ww,  ww);
      gl.uniform1f(u_min, min);
      gl.uniform1f(u_max, max);

      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(a_pos);
      gl.vertexAttribPointer(a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Copy rendered frame from GL canvas → visible 2-D output canvas.
      out.getContext('2d').drawImage(glCanvas, 0, 0, dw, dh);
    }

    // ── Public render functions ─────────────────────────────────────────────

    function renderAxial(z, wc, ww) {
      if (webgl2) {
        const w = (z + 0.5) / depth;
        _drawGL2(
          [0, 1, w],    // origin: u=0, v=1(flipped), w=slice
          [1, 0, 0],    // dx:     u increases right
          [0, -1, 0],   // dy:     v decreases going up (row 0 at top)
          wc, ww, axialOut
        );
      } else {
        // WebGL1 atlas path (unchanged from original)
        const dw = axialOut.clientWidth  || 300;
        const dh = axialOut.clientHeight || 300;
        if (axialOut.width  !== dw) axialOut.width  = dw;
        if (axialOut.height !== dh) axialOut.height = dh;
        if (glCanvas.width !== dw || glCanvas.height !== dh) {
          glCanvas.width  = dw;
          glCanvas.height = dh;
        }
        gl.viewport(0, 0, dw, dh);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(prog);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(u_volume, 0);
        gl.uniform1f(u_sliceIdx, z);
        gl.uniform1f(u_depthU,   depth);
        gl.uniform1f(u_wc,  wc);
        gl.uniform1f(u_ww,  ww);
        gl.uniform1f(u_min, min);
        gl.uniform1f(u_max, max);
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.enableVertexAttribArray(a_pos);
        gl.vertexAttribPointer(a_pos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        axialOut.getContext('2d').drawImage(glCanvas, 0, 0, dw, dh);
      }
    }

    function renderCoronal(y, wc, ww) {
      if (!webgl2) return;   // WebGL1: CPU path handles coronal
      const v = (y + 0.5) / height;
      _drawGL2(
        [1, v, 1],    // origin: u=1(L on left), v=fixed row, w=1(last slice at bottom)
        [-1, 0, 0],   // dx:     u decreases going right (L→R flip)
        [0, 0, -1],   // dy:     w decreases going up (slice 0 at top)
        wc, ww, coronalOut
      );
    }

    function renderSagittal(x, wc, ww) {
      if (!webgl2) return;   // WebGL1: CPU path handles sagittal
      const u = (x + 0.5) / width;
      _drawGL2(
        [u, 1, 1],    // origin: u=fixed col, v=1(P on left), w=1(last slice at bottom)
        [0, -1, 0],   // dx:     v decreases going right (P→A flip)
        [0, 0, -1],   // dy:     w decreases going up (slice 0 at top)
        wc, ww, sagittalOut
      );
    }

    function destroy() {
      gl.deleteProgram(prog);
      gl.deleteBuffer(quadBuf);
      [axialOut, coronalOut, sagittalOut].forEach(c => {
        if (c && c.parentNode) c.parentNode.removeChild(c);
      });
      // Remove the GPU label nodes that were inserted alongside the canvases
      document.querySelectorAll('.mprLabel').forEach(el => {
        if (el.style.color === 'rgb(129, 196, 132)') el.remove();
      });
    }

    return { renderAxial, renderCoronal, renderSagittal, destroy };
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  global.gpuSlice = { init };

})(window);
