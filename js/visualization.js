/*
 * visualization.js — turns the computed flow field into pixels on the WebGL
 * canvas. Two things happen here: plain pass-through display of a source
 * frame (progCopy), and the motion-compensated frame interpolation that is
 * the whole point of the site (progInterpolate). getDisplayFlow bridges the
 * two: it projects the (small, compute-resolution) flow field up to full
 * output resolution, in correctly-scaled pixel units, once per frame.
 */
'use strict';

class FlowVisualizer {
  constructor(gl) {
    this.gl = gl;
    this.progCopy = GLU.createProgram(gl, SHADERS.VERT_FULLSCREEN, SHADERS.FRAG_COPY);
    this.progResample = GLU.createProgram(gl, SHADERS.VERT_FULLSCREEN, SHADERS.FRAG_RESAMPLE_FLOW);
    this.progInterpolate = GLU.createProgram(gl, SHADERS.VERT_FULLSCREEN, SHADERS.FRAG_INTERPOLATE);
    this.vao = GLU.createFullscreenVAO(gl, 0);
    this.dispFlowTarget = null;
    this.dispFlowW = 0;
    this.dispFlowH = 0;
  }

  /** Show a raw source frame with no interpolation. */
  renderSource(sourceTarget, target) {
    const gl = this.gl;
    GLU.bindTarget(gl, target || null);
    GLU.drawFullscreen(gl, this.progCopy, this.vao, () => {
      GLU.bindInputTexture(gl, 0, sourceTarget.tex, this.progCopy, 'u_src');
    });
  }

  /**
   * Synthesize the in-between frame at phase t (0=frameA, 1=frameB) by
   * motion-compensated warping along `flowTarget` (must already be in the
   * same pixel-unit space as frameA/frameB, e.g. the getDisplayFlow output).
   * This is the core of the FPS-raising frame-interpolation feature.
   */
  renderInterpolated(frameA, frameB, flowTarget, t, target) {
    const gl = this.gl;
    const w = target ? target.width : gl.canvas.width;
    const h = target ? target.height : gl.canvas.height;
    GLU.bindTarget(gl, target || null);
    GLU.drawFullscreen(gl, this.progInterpolate, this.vao, () => {
      GLU.bindInputTexture(gl, 0, frameA.tex, this.progInterpolate, 'u_frameA');
      GLU.bindInputTexture(gl, 1, frameB.tex, this.progInterpolate, 'u_frameB');
      GLU.bindInputTexture(gl, 2, flowTarget.tex, this.progInterpolate, 'u_flow');
      gl.uniform2f(this.progInterpolate.uniforms.u_texel, 1 / w, 1 / h);
      gl.uniform1f(this.progInterpolate.uniforms.u_t, t);
    });
  }

  /**
   * Resample a (small, compute-resolution) flow field up to the full output
   * resolution, scaling displacement values by `scale` (outputRes/computeRes)
   * so magnitudes stay correct in the larger pixel grid. This is what keeps
   * interpolation quality close to source-image sharpness even when the
   * solver itself runs at a much smaller internal resolution.
   */
  getDisplayFlow(flowTarget, outW, outH, scale) {
    const gl = this.gl;
    if (!this.dispFlowTarget || this.dispFlowW !== outW || this.dispFlowH !== outH) {
      if (this.dispFlowTarget) {
        gl.deleteTexture(this.dispFlowTarget.tex);
        gl.deleteFramebuffer(this.dispFlowTarget.fbo);
      }
      this.dispFlowTarget = GLU.createTarget(gl, outW, outH, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);
      this.dispFlowW = outW;
      this.dispFlowH = outH;
    }
    GLU.bindTarget(gl, this.dispFlowTarget);
    GLU.drawFullscreen(gl, this.progResample, this.vao, () => {
      GLU.bindInputTexture(gl, 0, flowTarget.tex, this.progResample, 'u_src');
      gl.uniform2i(this.progResample.uniforms.u_srcSize, flowTarget.width, flowTarget.height);
      gl.uniform1f(this.progResample.uniforms.u_scale, scale);
    });
    return this.dispFlowTarget;
  }

  dispose() {
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    for (const p of [this.progCopy, this.progResample, this.progInterpolate]) {
      gl.deleteProgram(p.program);
    }
    if (this.dispFlowTarget) {
      gl.deleteTexture(this.dispFlowTarget.tex);
      gl.deleteFramebuffer(this.dispFlowTarget.fbo);
    }
  }
}
