/*
 * visualization.js — turns a flow field (RGBA32F texture, displacement in .rg)
 * into pixels: full-canvas color coding (HSV wheel / heatmap / raw copy) on
 * the WebGL canvas, plus a small CPU-side vector grid readback used by the
 * 2D-canvas arrow/particle overlay in particles.js.
 */
'use strict';

class FlowVisualizer {
  constructor(gl) {
    this.gl = gl;
    this.progWheel = GLU.createProgram(gl, SHADERS.VERT_FULLSCREEN, SHADERS.FRAG_COLORIZE_WHEEL);
    this.progHeatmap = GLU.createProgram(gl, SHADERS.VERT_FULLSCREEN, SHADERS.FRAG_COLORIZE_HEATMAP);
    this.progCopy = GLU.createProgram(gl, SHADERS.VERT_FULLSCREEN, SHADERS.FRAG_COPY);
    this.progBlend = GLU.createProgram(gl, SHADERS.VERT_FULLSCREEN, SHADERS.FRAG_COLORIZE_BLEND);
    this.progResample = GLU.createProgram(gl, SHADERS.VERT_FULLSCREEN, SHADERS.FRAG_RESAMPLE_FLOW);
    this.vao = GLU.createFullscreenVAO(gl, 0);
    this.gridTarget = null;
    this.gridW = 0;
    this.gridH = 0;
  }

  /** Render the flow field to the canvas (or `target` if given). mode: 'wheel' | 'heatmap' | 'source' */
  render(mode, flowOrSourceTarget, maxMag, gamma, target) {
    const gl = this.gl;
    GLU.bindTarget(gl, target || null);
    if (mode === 'heatmap') {
      GLU.drawFullscreen(gl, this.progHeatmap, this.vao, () => {
        GLU.bindInputTexture(gl, 0, flowOrSourceTarget.tex, this.progHeatmap, 'u_flow');
        gl.uniform1f(this.progHeatmap.uniforms.u_maxMag, maxMag);
        gl.uniform1f(this.progHeatmap.uniforms.u_gamma, gamma);
      });
    } else if (mode === 'source') {
      GLU.drawFullscreen(gl, this.progCopy, this.vao, () => {
        GLU.bindInputTexture(gl, 0, flowOrSourceTarget.tex, this.progCopy, 'u_src');
      });
    } else {
      GLU.drawFullscreen(gl, this.progWheel, this.vao, () => {
        GLU.bindInputTexture(gl, 0, flowOrSourceTarget.tex, this.progWheel, 'u_flow');
        gl.uniform1f(this.progWheel.uniforms.u_maxMag, maxMag);
        gl.uniform1f(this.progWheel.uniforms.u_gamma, gamma);
      });
    }
  }

  /** Colorized flow alpha-blended over the raw source frame in a single GPU pass. */
  renderBlend(sourceTarget, flowTarget, mode, maxMag, gamma, alpha, target) {
    const gl = this.gl;
    GLU.bindTarget(gl, target || null);
    GLU.drawFullscreen(gl, this.progBlend, this.vao, () => {
      GLU.bindInputTexture(gl, 0, sourceTarget.tex, this.progBlend, 'u_source');
      GLU.bindInputTexture(gl, 1, flowTarget.tex, this.progBlend, 'u_flow');
      gl.uniform1f(this.progBlend.uniforms.u_maxMag, maxMag);
      gl.uniform1f(this.progBlend.uniforms.u_gamma, gamma);
      gl.uniform1f(this.progBlend.uniforms.u_alpha, alpha);
      gl.uniform1i(this.progBlend.uniforms.u_mode, mode === 'heatmap' ? 1 : 0);
    });
  }

  /**
   * Downsample the flow field to a small gridW x gridH grid and read it back
   * to the CPU. Returns a Float32Array of length gridW*gridH*4 (rgba, use .rg).
   */
  readGrid(flowTarget, gridW, gridH) {
    const gl = this.gl;
    if (!this.gridTarget || this.gridW !== gridW || this.gridH !== gridH) {
      if (this.gridTarget) {
        gl.deleteTexture(this.gridTarget.tex);
        gl.deleteFramebuffer(this.gridTarget.fbo);
      }
      this.gridTarget = GLU.createTarget(gl, gridW, gridH, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);
      this.gridW = gridW;
      this.gridH = gridH;
    }
    GLU.bindTarget(gl, this.gridTarget);
    GLU.drawFullscreen(gl, this.progResample, this.vao, () => {
      GLU.bindInputTexture(gl, 0, flowTarget.tex, this.progResample, 'u_src');
      gl.uniform2i(this.progResample.uniforms.u_srcSize, flowTarget.width, flowTarget.height);
    });
    const out = new Float32Array(gridW * gridH * 4);
    gl.readPixels(0, 0, gridW, gridH, gl.RGBA, gl.FLOAT, out);
    GLU.bindTarget(gl, null);
    return out;
  }

  dispose() {
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    for (const p of [this.progWheel, this.progHeatmap, this.progCopy, this.progBlend, this.progResample]) {
      gl.deleteProgram(p.program);
    }
    if (this.gridTarget) {
      gl.deleteTexture(this.gridTarget.tex);
      gl.deleteFramebuffer(this.gridTarget.fbo);
    }
  }
}
