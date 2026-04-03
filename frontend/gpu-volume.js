// gpu-volume.js — Upload a DICOM volume to GPU as a WebGL texture.
//
// Public API (attached to window.gpuVolume):
//   isWebGLAvailable()     → boolean
//   uploadVolumeToGPU(volume) → GpuVolumeHandle | null (null = no GPU support)
//
// Expected volume shape (matches mpr.js buildVolume output):
//   { buffer: Float32Array, rows, cols, slices }
//   buffer is in HU (Hounsfield Units); layout is slice-major, row-major.
//
// Returns a GpuVolumeHandle on success, null on any GPU failure:
//   { gl, canvas, texture, width, height, depth, min, max, webgl2 }
//
// WebGL2 → real TEXTURE_3D (trilinear sampling across all axes).
// WebGL1 fallback → tall 2-D atlas (slices stacked vertically), LUMINANCE.
// No WebGL at all → returns null; caller skips GPU path silently.
//
// No rendering code is included. Does NOT touch Cornerstone canvases.

(function (global) {
  'use strict';

  /**
   * Normalize volume.buffer (Float32Array, HU values) to [0, 255] Uint8.
   * Returns { data: Uint8Array, min: number, max: number }.
   */
  function _normalize(buffer) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] < min) min = buffer[i];
      if (buffer[i] > max) max = buffer[i];
    }
    const range = (max - min) || 1;
    const data  = new Uint8Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      data[i] = ((buffer[i] - min) / range * 255 + 0.5) | 0;
    }
    return { data, min, max };
  }

  /**
   * Probe whether WebGL is available at all (no GPU / software renderer, etc.).
   * Uses a throw-away canvas that is never added to the DOM.
   * @returns {boolean}
   */
  function isWebGLAvailable() {
    try {
      const probe = document.createElement('canvas');
      return !!(
        probe.getContext('webgl2') ||
        probe.getContext('webgl') ||
        probe.getContext('experimental-webgl')
      );
    } catch (_) {
      return false;
    }
  }

  /**
   * uploadVolumeToGPU(volume)
   *
   * @param {{ buffer: Float32Array, rows: number, cols: number, slices: number }} volume
   * @returns {{ gl: WebGLRenderingContext, canvas: HTMLCanvasElement,
   *             texture: WebGLTexture,
   *             width: number, height: number, depth: number,
   *             min: number, max: number, webgl2: boolean } | null}
   */
  function uploadVolumeToGPU(volume) {
    const width  = volume.cols;
    const height = volume.rows;
    const depth  = volume.slices;

    if (!width || !height || !depth) {
      console.warn('gpuVolume: volume has zero dimension, skipping GPU upload');
      return null;
    }

    // ── 1. Normalize to [0, 255] ──────────────────────────────────────────────
    const { data, min, max } = _normalize(volume.buffer);

    // ── 2. Hidden canvas for the WebGL context ────────────────────────────────
    // Kept off-screen; does not interfere with Cornerstone's own canvases.
    const canvas = document.createElement('canvas');
    canvas.width  = 1;
    canvas.height = 1;
    canvas.style.display = 'none';
    document.body.appendChild(canvas);

    // ── 3. Acquire context (WebGL2 preferred) ─────────────────────────────────
    let gl     = canvas.getContext('webgl2');
    const webgl2 = !!gl;
    if (!gl) {
      gl = canvas.getContext('webgl') ||
           canvas.getContext('experimental-webgl');
    }
    if (!gl) {
      document.body.removeChild(canvas);
      console.warn('gpuVolume: WebGL not available, GPU path skipped');
      return null;
    }

    // ── 4. Texture upload ─────────────────────────────────────────────────────
    const texture = gl.createTexture();

    if (webgl2) {
      // ── WebGL2: true 3-D texture ──────────────────────────────────────────
      // texImage3D layout: data[z * width * height + y * width + x]
      // which matches our slice-major, row-major buffer exactly.
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R,     gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,                  // mip level
        gl.R8,              // internal format: single-channel 8-bit unorm
        width, height, depth,
        0,                  // border (must be 0)
        gl.RED,             // source format
        gl.UNSIGNED_BYTE,   // source type
        data
      );
    } else {
      // ── WebGL1 fallback: 2-D atlas (slices stacked top-to-bottom) ─────────
      // Sampling shader must convert a (u, v, slice) coordinate to
      // atlas UV: atlasV = (slice + v) / depth.
      // Note: atlas height = height * depth; check gl.MAX_TEXTURE_SIZE if
      // this is expected to exceed it for very large volumes.
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,                  // mip level
        gl.LUMINANCE,       // internal format (WebGL1 single-channel)
        width,
        height * depth,     // atlas height
        0,                  // border
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        data
      );
    }

    // ── 5. Error check ────────────────────────────────────────────────────────
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      gl.deleteTexture(texture);
      document.body.removeChild(canvas);
      console.warn('gpuVolume: texImage upload failed (GL error ' + err + '), GPU path skipped');
      return null;
    }

    gl.bindTexture(webgl2 ? gl.TEXTURE_3D : gl.TEXTURE_2D, null);

    return { gl, canvas, texture, width, height, depth, min, max, webgl2 };
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  global.gpuVolume = { isWebGLAvailable, uploadVolumeToGPU };

})(window);
