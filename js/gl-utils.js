/*
 * gl-utils.js — small WebGL2 helper layer used by the optical-flow pipeline.
 * No dependencies, no build step: plain scripts loaded in order from index.html.
 */
'use strict';

const GLU = (() => {

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      const kind = type === gl.VERTEX_SHADER ? 'VERTEX' : 'FRAGMENT';
      gl.deleteShader(shader);
      throw new Error(`[GLU] ${kind} shader compile error:\n${log}\n--- source ---\n${numberLines(source)}`);
    }
    return shader;
  }

  function numberLines(src) {
    return src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
  }

  function createProgram(gl, vsSource, fsSource) {
    const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`[GLU] Program link error:\n${log}`);
    }
    const wrapped = {
      program,
      uniforms: {},
      attribs: {},
    };
    const uCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < uCount; i++) {
      const info = gl.getActiveUniform(program, i);
      const name = info.name.replace(/\[0\]$/, '');
      wrapped.uniforms[name] = gl.getUniformLocation(program, name);
    }
    const aCount = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < aCount; i++) {
      const info = gl.getActiveAttrib(program, i);
      wrapped.attribs[info.name] = gl.getAttribLocation(program, info.name);
    }
    return wrapped;
  }

  // Fullscreen triangle (no separate quad/index buffer needed).
  function createFullscreenVAO(gl, posLoc) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // Covers clip space [-1,1] with one oversized triangle.
    const verts = new Float32Array([-1, -1, 3, -1, -1, 3]);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  function createTexture(gl, width, height, internalFormat, format, type, filter, wrap) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);
    const f = filter || gl.NEAREST;
    const w = wrap || gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, w);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { tex, width, height, internalFormat, format, type };
  }

  function createFBO(gl, texObj) {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texObj.tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`[GLU] Incomplete framebuffer: 0x${status.toString(16)}`);
    }
    return { fbo, tex: texObj };
  }

  // A texture+FBO pair — the basic renderable unit used all over the flow pipeline.
  function createTarget(gl, width, height, internalFormat, format, type, filter, wrap) {
    const texObj = createTexture(gl, width, height, internalFormat, format, type, filter, wrap);
    const { fbo } = createFBO(gl, texObj);
    return { fbo, tex: texObj.tex, width, height, internalFormat, format, type };
  }

  function resizeTarget(gl, target, width, height) {
    if (target.width === width && target.height === height) return target;
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, target.internalFormat, width, height, 0, target.format, target.type, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    target.width = width;
    target.height = height;
    return target;
  }

  function bindTarget(gl, target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.width : gl.canvas.width, target ? target.height : gl.canvas.height);
  }

  function drawFullscreen(gl, progWrap, vao, uniformSetter) {
    gl.useProgram(progWrap.program);
    gl.bindVertexArray(vao);
    if (uniformSetter) uniformSetter(progWrap.uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  function bindInputTexture(gl, unit, texture, progWrap, uniformName) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (progWrap.uniforms[uniformName] !== undefined) {
      gl.uniform1i(progWrap.uniforms[uniformName], unit);
    }
  }

  return {
    createShader, createProgram, createFullscreenVAO,
    createTexture, createFBO, createTarget, resizeTarget,
    bindTarget, drawFullscreen, bindInputTexture,
  };
})();
