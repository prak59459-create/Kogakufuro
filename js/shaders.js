/*
 * shaders.js — all GLSL ES 3.00 sources used by the optical-flow pipeline,
 * kept as plain JS template strings so the whole site works from a single
 * `file://` open with zero build step and zero extra network requests.
 */
'use strict';

const SHADERS = (() => {

  const VERT_FULLSCREEN = `#version 300 es
  layout(location = 0) in vec2 a_pos;
  out vec2 v_uv;
  void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
  `;

  const PRECISION = `#version 300 es
  precision highp float;
  precision highp int;
  `;

  // RGBA video/image frame -> single-channel luminance (Rec. 601).
  const FRAG_GRAYSCALE = PRECISION + `
  uniform sampler2D u_src;
  in vec2 v_uv;
  out vec4 outColor;
  void main() {
    vec3 c = texture(u_src, v_uv).rgb;
    float y = dot(c, vec3(0.299, 0.587, 0.114));
    outColor = vec4(y, 0.0, 0.0, 1.0);
  }
  `;

  // Generic 2x2 box-filter downsample (average). Works on R or RG payloads.
  const FRAG_DOWNSAMPLE_AVG = PRECISION + `
  uniform sampler2D u_src;
  uniform ivec2 u_srcSize;
  in vec2 v_uv;
  out vec4 outColor;
  void main() {
    ivec2 dstXY = ivec2(gl_FragCoord.xy);
    ivec2 srcXY = clamp(dstXY * 2, ivec2(0), u_srcSize - ivec2(1));
    ivec2 s1 = min(srcXY + ivec2(1,0), u_srcSize - ivec2(1));
    ivec2 s2 = min(srcXY + ivec2(0,1), u_srcSize - ivec2(1));
    ivec2 s3 = min(srcXY + ivec2(1,1), u_srcSize - ivec2(1));
    vec4 a = texelFetch(u_src, srcXY, 0);
    vec4 b = texelFetch(u_src, s1, 0);
    vec4 c = texelFetch(u_src, s2, 0);
    vec4 d = texelFetch(u_src, s3, 0);
    outColor = (a + b + c + d) * 0.25;
  }
  `;

  // Same footprint, but MAX instead of AVG — used for the "peak motion" stat reduction.
  const FRAG_DOWNSAMPLE_MAX = PRECISION + `
  uniform sampler2D u_src;
  uniform ivec2 u_srcSize;
  in vec2 v_uv;
  out vec4 outColor;
  void main() {
    ivec2 dstXY = ivec2(gl_FragCoord.xy);
    ivec2 srcXY = clamp(dstXY * 2, ivec2(0), u_srcSize - ivec2(1));
    ivec2 s1 = min(srcXY + ivec2(1,0), u_srcSize - ivec2(1));
    ivec2 s2 = min(srcXY + ivec2(0,1), u_srcSize - ivec2(1));
    ivec2 s3 = min(srcXY + ivec2(1,1), u_srcSize - ivec2(1));
    vec4 a = texelFetch(u_src, srcXY, 0);
    vec4 b = texelFetch(u_src, s1, 0);
    vec4 c = texelFetch(u_src, s2, 0);
    vec4 d = texelFetch(u_src, s3, 0);
    outColor = max(max(a,b), max(c,d));
  }
  `;

  // Classic Horn & Schunck discrete derivative masks from two grayscale frames.
  // Output: (Ix, Iy, It, 1)
  const FRAG_DERIVATIVES = PRECISION + `
  uniform sampler2D u_prev;
  uniform sampler2D u_curr;
  uniform ivec2 u_size;
  in vec2 v_uv;
  out vec4 outColor;
  float A(ivec2 p){ p = clamp(p, ivec2(0), u_size-ivec2(1)); return texelFetch(u_prev, p, 0).r; }
  float B(ivec2 p){ p = clamp(p, ivec2(0), u_size-ivec2(1)); return texelFetch(u_curr, p, 0).r; }
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec2 px = p + ivec2(1,0);
    ivec2 py = p + ivec2(0,1);
    ivec2 pxy = p + ivec2(1,1);
    float ix = 0.25 * ((A(px)-A(p)) + (A(pxy)-A(py)) + (B(px)-B(p)) + (B(pxy)-B(py)));
    float iy = 0.25 * ((A(py)-A(p)) + (A(pxy)-A(px)) + (B(py)-B(p)) + (B(pxy)-B(px)));
    float it = 0.25 * ((B(p)-A(p)) + (B(px)-A(px)) + (B(py)-A(py)) + (B(pxy)-A(pxy)));
    outColor = vec4(ix, iy, it, 1.0);
  }
  `;

  // One Jacobi relaxation step of the Horn-Schunck energy minimization.
  const FRAG_HS_ITERATE = PRECISION + `
  uniform sampler2D u_flow;   // previous iterate (u,v) in .rg
  uniform sampler2D u_deriv;  // (Ix,Iy,It) in .rgb
  uniform ivec2 u_size;
  uniform float u_alpha2;     // smoothness weight squared
  in vec2 v_uv;
  out vec4 outColor;
  vec2 F(ivec2 p){ p = clamp(p, ivec2(0), u_size-ivec2(1)); return texelFetch(u_flow, p, 0).rg; }
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec2 up = F(p + ivec2(-1,0));
    vec2 down = F(p + ivec2(1,0));
    vec2 left = F(p + ivec2(0,-1));
    vec2 right = F(p + ivec2(0,1));
    vec2 bar = (up + down + left + right) * 0.25;
    vec3 d = texelFetch(u_deriv, p, 0).rgb;
    float ix = d.x, iy = d.y, it = d.z;
    float denom = u_alpha2 + ix*ix + iy*iy;
    float t = (ix*bar.x + iy*bar.y + it) / max(denom, 1e-6);
    vec2 result = bar - vec2(ix, iy) * t;
    outColor = vec4(result, 0.0, 1.0);
  }
  `;

  // Upsample a coarse flow field to 2x resolution (manual bilinear via texelFetch,
  // so it never depends on OES_texture_float_linear support) and double the
  // displacement magnitude to account for the resolution doubling.
  const FRAG_UPSAMPLE_FLOW = PRECISION + `
  uniform sampler2D u_src;
  uniform ivec2 u_srcSize;
  in vec2 v_uv;
  out vec4 outColor;
  void main() {
    vec2 srcCoord = v_uv * vec2(u_srcSize) - 0.5;
    vec2 f = fract(srcCoord);
    ivec2 base = ivec2(floor(srcCoord));
    ivec2 c00 = clamp(base, ivec2(0), u_srcSize-ivec2(1));
    ivec2 c10 = clamp(base+ivec2(1,0), ivec2(0), u_srcSize-ivec2(1));
    ivec2 c01 = clamp(base+ivec2(0,1), ivec2(0), u_srcSize-ivec2(1));
    ivec2 c11 = clamp(base+ivec2(1,1), ivec2(0), u_srcSize-ivec2(1));
    vec2 v00 = texelFetch(u_src, c00, 0).rg;
    vec2 v10 = texelFetch(u_src, c10, 0).rg;
    vec2 v01 = texelFetch(u_src, c01, 0).rg;
    vec2 v11 = texelFetch(u_src, c11, 0).rg;
    vec2 v0 = mix(v00, v10, f.x);
    vec2 v1 = mix(v01, v11, f.x);
    vec2 v = mix(v0, v1, f.y);
    outColor = vec4(v * 2.0, 0.0, 1.0);
  }
  `;

  // Magnitude reduction source: flow(u,v) -> length in .r (replicated to rgb for reduction reuse).
  const FRAG_MAGNITUDE = PRECISION + `
  uniform sampler2D u_flow;
  in vec2 v_uv;
  out vec4 outColor;
  void main() {
    vec2 uv = texture(u_flow, v_uv).rg;
    float m = length(uv);
    outColor = vec4(m, m, m, 1.0);
  }
  `;

  // Middlebury-style flow color wheel: hue = direction, value = magnitude/maxMag.
  const FRAG_COLORIZE_WHEEL = PRECISION + `
  uniform sampler2D u_flow;
  uniform float u_maxMag;
  uniform float u_gamma;
  in vec2 v_uv;
  out vec4 outColor;
  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }
  void main() {
    vec2 uv = texture(u_flow, v_uv).rg;
    float mag = length(uv);
    float ang = atan(uv.y, uv.x); // -pi..pi
    float hue = ang / (2.0 * 3.14159265) + 0.5;
    float val = clamp(pow(mag / max(u_maxMag, 1e-5), u_gamma), 0.0, 1.0);
    vec3 rgb = hsv2rgb(vec3(hue, 1.0, val));
    outColor = vec4(rgb, 1.0);
  }
  `;

  // Perceptual-ish heatmap (turbo-like polynomial approximation) driven by magnitude only.
  const FRAG_COLORIZE_HEATMAP = PRECISION + `
  uniform sampler2D u_flow;
  uniform float u_maxMag;
  uniform float u_gamma;
  in vec2 v_uv;
  out vec4 outColor;
  vec3 turbo(float t) {
    t = clamp(t, 0.0, 1.0);
    const vec3 c0 = vec3(0.1140,0.0629,0.2248);
    const vec3 c1 = vec3(2.7965,1.5127,0.0862);
    const vec3 c2 = vec3(-6.2568,0.1970,3.4526);
    const vec3 c3 = vec3(6.0947,-4.7396,-5.9917);
    const vec3 c4 = vec3(-2.0812,3.9276,3.1130);
    vec3 r = c0 + t*(c1 + t*(c2 + t*(c3 + t*c4)));
    return clamp(r, 0.0, 1.0);
  }
  void main() {
    vec2 uv = texture(u_flow, v_uv).rg;
    float mag = length(uv);
    float t = clamp(pow(mag / max(u_maxMag, 1e-5), u_gamma), 0.0, 1.0);
    outColor = vec4(turbo(t), 1.0);
  }
  `;

  // Arbitrary-size resample of the flow field (manual bilinear via texelFetch,
  // no magnitude rescale) — used to read back a small vector grid to the CPU
  // for arrow / particle overlays without depending on float-linear filtering.
  const FRAG_RESAMPLE_FLOW = PRECISION + `
  uniform sampler2D u_src;
  uniform ivec2 u_srcSize;
  in vec2 v_uv;
  out vec4 outColor;
  void main() {
    vec2 srcCoord = v_uv * vec2(u_srcSize) - 0.5;
    vec2 f = fract(srcCoord);
    ivec2 base = ivec2(floor(srcCoord));
    ivec2 c00 = clamp(base, ivec2(0), u_srcSize-ivec2(1));
    ivec2 c10 = clamp(base+ivec2(1,0), ivec2(0), u_srcSize-ivec2(1));
    ivec2 c01 = clamp(base+ivec2(0,1), ivec2(0), u_srcSize-ivec2(1));
    ivec2 c11 = clamp(base+ivec2(1,1), ivec2(0), u_srcSize-ivec2(1));
    vec2 v00 = texelFetch(u_src, c00, 0).rg;
    vec2 v10 = texelFetch(u_src, c10, 0).rg;
    vec2 v01 = texelFetch(u_src, c01, 0).rg;
    vec2 v11 = texelFetch(u_src, c11, 0).rg;
    vec2 v0 = mix(v00, v10, f.x);
    vec2 v1 = mix(v01, v11, f.x);
    vec2 v = mix(v0, v1, f.y);
    outColor = vec4(v, 0.0, 1.0);
  }
  `;

  // Colorized flow, alpha-blended over the original source frame in a single pass
  // (mode 0 = direction wheel, mode 1 = speed heatmap).
  const FRAG_COLORIZE_BLEND = PRECISION + `
  uniform sampler2D u_source;
  uniform sampler2D u_flow;
  uniform float u_maxMag;
  uniform float u_gamma;
  uniform float u_alpha;
  uniform int u_mode;
  in vec2 v_uv;
  out vec4 outColor;
  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }
  vec3 turbo(float t) {
    t = clamp(t, 0.0, 1.0);
    const vec3 c0 = vec3(0.1140,0.0629,0.2248);
    const vec3 c1 = vec3(2.7965,1.5127,0.0862);
    const vec3 c2 = vec3(-6.2568,0.1970,3.4526);
    const vec3 c3 = vec3(6.0947,-4.7396,-5.9917);
    const vec3 c4 = vec3(-2.0812,3.9276,3.1130);
    vec3 r = c0 + t*(c1 + t*(c2 + t*(c3 + t*c4)));
    return clamp(r, 0.0, 1.0);
  }
  void main() {
    vec3 src = texture(u_source, v_uv).rgb;
    vec2 uv = texture(u_flow, v_uv).rg;
    float mag = length(uv);
    float norm = clamp(pow(mag / max(u_maxMag, 1e-5), u_gamma), 0.0, 1.0);
    vec3 flowColor;
    if (u_mode == 1) {
      flowColor = turbo(norm);
    } else {
      float ang = atan(uv.y, uv.x);
      float hue = ang / (2.0 * 3.14159265) + 0.5;
      flowColor = hsv2rgb(vec3(hue, 1.0, norm));
    }
    float a = u_alpha * clamp(norm * 1.4, 0.0, 1.0);
    outColor = vec4(mix(src, flowColor, a), 1.0);
  }
  `;

  // Original frame passthrough, used for split display compositing.
  const FRAG_COPY = PRECISION + `
  uniform sampler2D u_src;
  in vec2 v_uv;
  out vec4 outColor;
  void main() { outColor = texture(u_src, v_uv); }
  `;

  return {
    VERT_FULLSCREEN,
    FRAG_GRAYSCALE,
    FRAG_DOWNSAMPLE_AVG,
    FRAG_DOWNSAMPLE_MAX,
    FRAG_DERIVATIVES,
    FRAG_HS_ITERATE,
    FRAG_UPSAMPLE_FLOW,
    FRAG_MAGNITUDE,
    FRAG_COLORIZE_WHEEL,
    FRAG_COLORIZE_HEATMAP,
    FRAG_COLORIZE_BLEND,
    FRAG_COPY,
    FRAG_RESAMPLE_FLOW,
  };
})();
