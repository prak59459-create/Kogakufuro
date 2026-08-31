/*
 * optical-flow.js — GPU pyramidal Horn-Schunck dense optical flow.
 *
 * Pipeline per computed frame pair (prev, curr), both uploaded as raw RGBA
 * textures at the chosen processing resolution:
 *   1. RGBA -> grayscale (R8) for both frames.
 *   2. Build an image pyramid (box downsample) of `levels` octaves for each.
 *   3. Solve at the coarsest level first (classic Horn-Schunck derivative
 *      masks + Jacobi relaxation of the energy minimization), then upsample
 *      the flow field as the initial guess for the next finer level, and
 *      repeat down to full resolution. This coarse-to-fine scheme lets the
 *      solver capture larger displacements than a single-scale solve would.
 *
 * Requires EXT_color_buffer_float (to render into RG32F/RGBA32F targets).
 * All resampling is done with manual texelFetch-based bilinear/box filters,
 * so no *_texture_float_linear extension is needed.
 */
'use strict';

class OpticalFlowGL {
  constructor(gl) {
    this.gl = gl;

    const ext = gl.getExtension('EXT_color_buffer_float');
    if (!ext) {
      throw new Error('EXT_color_buffer_float is not supported by this browser/GPU. ' +
        'High-precision flow textures cannot be rendered.');
    }

    this.progGrayscale = GLU.createProgram(gl, SHADERS.VERT_FULLSCREEN, SHADERS.FRAG_GRAYSCALE);
    this.progDownAvg = GLU.createProgram(gl, SHADERS.VERT_FULLSCREEN, SHADERS.FRAG_DOWNSAMPLE_AVG);
    this.progDownMax = GLU.createProgram(gl, SHADERS.VERT_FULLSCREEN, SHADERS.FRAG_DOWNSAMPLE_MAX);
    this.progDeriv = GLU.createProgram(gl, SHADERS.VERT_FULLSCREEN, SHADERS.FRAG_DERIVATIVES);
    this.progIterate = GLU.createProgram(gl, SHADERS.VERT_FULLSCREEN, SHADERS.FRAG_HS_ITERATE);
    this.progUpsample = GLU.createProgram(gl, SHADERS.VERT_FULLSCREEN, SHADERS.FRAG_UPSAMPLE_FLOW);
    this.progMagnitude = GLU.createProgram(gl, SHADERS.VERT_FULLSCREEN, SHADERS.FRAG_MAGNITUDE);

    this.vao = GLU.createFullscreenVAO(gl, 0);

    this.width = 0;
    this.height = 0;
    this.levels = 0;
    this.pyrA = [];   // grayscale pyramid, frame A (prev)
    this.pyrB = [];   // grayscale pyramid, frame B (curr)
    this.deriv = [];  // derivative targets per level
    this.flowPing = [];
    this.flowPong = [];
    this.rawA = null; // full-res raw RGBA upload targets (ping-pong across frames)
    this.rawB = null;
    this.reduceChain = []; // magnitude reduction pyramid down to 1x1

    this.lastAvgMag = 0;
    this.lastPeakMag = 0;
  }

  _levelSize(level) {
    const w = Math.max(4, this.width >> level);
    const h = Math.max(4, this.height >> level);
    return [w, h];
  }

  setSize(width, height, levels) {
    const gl = this.gl;
    width = Math.max(8, width | 0);
    height = Math.max(8, height | 0);
    levels = Math.max(1, Math.min(8, levels | 0));
    if (this.width === width && this.height === height && this.levels === levels) return false;
    this._dispose();
    this.width = width;
    this.height = height;
    this.levels = levels;

    this.rawA = GLU.createTarget(gl, width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    this.rawB = GLU.createTarget(gl, width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);

    for (let l = 0; l < levels; l++) {
      const [w, h] = this._levelSize(l);
      this.pyrA.push(GLU.createTarget(gl, w, h, gl.R8, gl.RED, gl.UNSIGNED_BYTE, gl.LINEAR));
      this.pyrB.push(GLU.createTarget(gl, w, h, gl.R8, gl.RED, gl.UNSIGNED_BYTE, gl.LINEAR));
      this.deriv.push(GLU.createTarget(gl, w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST));
      this.flowPing.push(GLU.createTarget(gl, w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST));
      this.flowPong.push(GLU.createTarget(gl, w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST));
    }

    // Reduction chain (for avg/peak magnitude stats) starts at full res, halves to 1x1.
    let rw = width, rh = height;
    this.reduceChain.push(GLU.createTarget(gl, rw, rh, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST));
    while (rw > 1 || rh > 1) {
      rw = Math.max(1, Math.floor(rw / 2));
      rh = Math.max(1, Math.floor(rh / 2));
      this.reduceChain.push(GLU.createTarget(gl, rw, rh, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST));
    }
    return true;
  }

  _dispose() {
    const gl = this.gl;
    const all = [...this.pyrA, ...this.pyrB, ...this.deriv, ...this.flowPing, ...this.flowPong, ...this.reduceChain];
    if (this.rawA) all.push(this.rawA);
    if (this.rawB) all.push(this.rawB);
    for (const t of all) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    this.pyrA = []; this.pyrB = []; this.deriv = [];
    this.flowPing = []; this.flowPong = []; this.reduceChain = [];
    this.rawA = null; this.rawB = null;
  }

  /** Upload a video/image/canvas frame as the "current" raw frame, ping-ponging with the previous one. */
  uploadFrame(source) {
    const gl = this.gl;
    // swap raw buffers: B becomes the new "prev" target for the next call by swapping refs
    const tmp = this.rawA;
    this.rawA = this.rawB;
    this.rawB = tmp;
    gl.bindTexture(gl.TEXTURE_2D, this.rawB.tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } finally {
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  _grayscale(srcTarget, dstTarget) {
    const gl = this.gl;
    GLU.bindTarget(gl, dstTarget);
    GLU.drawFullscreen(gl, this.progGrayscale, this.vao, (u) => {
      GLU.bindInputTexture(gl, 0, srcTarget.tex, this.progGrayscale, 'u_src');
    });
  }

  _downsample(prog, srcTarget, dstTarget) {
    const gl = this.gl;
    GLU.bindTarget(gl, dstTarget);
    GLU.drawFullscreen(gl, prog, this.vao, () => {
      GLU.bindInputTexture(gl, 0, srcTarget.tex, prog, 'u_src');
      gl.uniform2i(prog.uniforms.u_srcSize, srcTarget.width, srcTarget.height);
    });
  }

  _derivatives(prevTarget, currTarget, dstTarget) {
    const gl = this.gl;
    GLU.bindTarget(gl, dstTarget);
    GLU.drawFullscreen(gl, this.progDeriv, this.vao, () => {
      GLU.bindInputTexture(gl, 0, prevTarget.tex, this.progDeriv, 'u_prev');
      GLU.bindInputTexture(gl, 1, currTarget.tex, this.progDeriv, 'u_curr');
      gl.uniform2i(this.progDeriv.uniforms.u_size, dstTarget.width, dstTarget.height);
    });
  }

  _clear(target) {
    const gl = this.gl;
    GLU.bindTarget(gl, target);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  _iterate(flowSrc, derivTarget, dstTarget, alpha2) {
    const gl = this.gl;
    GLU.bindTarget(gl, dstTarget);
    GLU.drawFullscreen(gl, this.progIterate, this.vao, () => {
      GLU.bindInputTexture(gl, 0, flowSrc.tex, this.progIterate, 'u_flow');
      GLU.bindInputTexture(gl, 1, derivTarget.tex, this.progIterate, 'u_deriv');
      gl.uniform2i(this.progIterate.uniforms.u_size, dstTarget.width, dstTarget.height);
      gl.uniform1f(this.progIterate.uniforms.u_alpha2, alpha2);
    });
  }

  _upsampleFlow(srcTarget, dstTarget) {
    const gl = this.gl;
    GLU.bindTarget(gl, dstTarget);
    GLU.drawFullscreen(gl, this.progUpsample, this.vao, () => {
      GLU.bindInputTexture(gl, 0, srcTarget.tex, this.progUpsample, 'u_src');
      gl.uniform2i(this.progUpsample.uniforms.u_srcSize, srcTarget.width, srcTarget.height);
    });
  }

  /**
   * Run the full coarse-to-fine solve. `alpha` is the smoothness weight,
   * `iterations` the Jacobi relaxation count per pyramid level.
   * Returns the finest-level flow target (RGBA32F, displacement in .rg,
   * measured in pixels-per-frame at the processing resolution).
   */
  compute(alpha, iterations) {
    const gl = this.gl;
    const alpha2 = alpha * alpha;

    // 1. grayscale conversion at full res
    this._grayscale(this.rawA, this.pyrA[0]);
    this._grayscale(this.rawB, this.pyrB[0]);

    // 2. build pyramids
    for (let l = 1; l < this.levels; l++) {
      this._downsample(this.progDownAvg, this.pyrA[l - 1], this.pyrA[l]);
      this._downsample(this.progDownAvg, this.pyrB[l - 1], this.pyrB[l]);
    }

    let coarseFlow = null;

    for (let l = this.levels - 1; l >= 0; l--) {
      this._derivatives(this.pyrA[l], this.pyrB[l], this.deriv[l]);

      let ping = this.flowPing[l];
      let pong = this.flowPong[l];

      if (coarseFlow) {
        this._upsampleFlow(coarseFlow, ping);
      } else {
        this._clear(ping);
      }

      const iters = Math.max(1, iterations | 0);
      for (let i = 0; i < iters; i++) {
        this._iterate(ping, this.deriv[l], pong, alpha2);
        const t = ping; ping = pong; pong = t;
      }
      coarseFlow = ping; // holds the most recent result at this level
    }

    this._computeStats(coarseFlow);
    return coarseFlow;
  }

  _computeStats(flowTarget) {
    const gl = this.gl;
    // magnitude of the final flow field
    GLU.bindTarget(gl, this.reduceChain[0]);
    GLU.drawFullscreen(gl, this.progMagnitude, this.vao, () => {
      GLU.bindInputTexture(gl, 0, flowTarget.tex, this.progMagnitude, 'u_flow');
    });

    // average via repeated box downsample to 1x1
    let avgSrc = this.reduceChain[0];
    for (let i = 1; i < this.reduceChain.length; i++) {
      this._downsample(this.progDownAvg, avgSrc, this.reduceChain[i]);
      avgSrc = this.reduceChain[i];
    }
    const avgPixel = new Float32Array(4);
    GLU.bindTarget(gl, avgSrc);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, avgPixel);
    this.lastAvgMag = avgPixel[0];

    // peak via repeated max downsample to 1x1 (reuse level-0 magnitude buffer as source)
    // We need a second chain pass with MAX; reuse reduceChain buffers again (they're transient).
    let maxSrc = this.reduceChain[0];
    for (let i = 1; i < this.reduceChain.length; i++) {
      this._downsample(this.progDownMax, maxSrc, this.reduceChain[i]);
      maxSrc = this.reduceChain[i];
    }
    const maxPixel = new Float32Array(4);
    GLU.bindTarget(gl, maxSrc);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, maxPixel);
    this.lastPeakMag = maxPixel[0];

    GLU.bindTarget(gl, null);
  }

  dispose() {
    this._dispose();
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    for (const p of [this.progGrayscale, this.progDownAvg, this.progDownMax, this.progDeriv,
      this.progIterate, this.progUpsample, this.progMagnitude]) {
      gl.deleteProgram(p.program);
    }
  }
}
