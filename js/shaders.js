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

  // 2x2 box-filter downsample (average) — used to build the grayscale pyramid.
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

  // Arbitrary-size resample of the flow field (manual bilinear via texelFetch,
  // no dependency on float-linear filtering support). u_scale converts the
  // sampled displacement into the caller's pixel units: used to project the
  // (small, compute-resolution) flow field onto the full output resolution,
  // where the interpolation shader below needs it.
  const FRAG_RESAMPLE_FLOW = PRECISION + `
  uniform sampler2D u_src;
  uniform ivec2 u_srcSize;
  uniform float u_scale;
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
    outColor = vec4(v * u_scale, 0.0, 1.0);
  }
  `;

  // Plain passthrough — used to show the source frame with no interpolation.
  const FRAG_COPY = PRECISION + `
  uniform sampler2D u_src;
  in vec2 v_uv;
  out vec4 outColor;
  void main() { outColor = texture(u_src, v_uv); }
  `;

  // Optical-flow motion-compensated frame interpolation: synthesizes the frame
  // at phase t (0=A, 1=B) between two real frames by backward-warping each one
  // along the A->B flow field and cross-dissolving the results. This is what
  // lets the app synthesize extra frames to raise a video's effective FPS.
  const FRAG_INTERPOLATE = PRECISION + `
  uniform sampler2D u_frameA;
  uniform sampler2D u_frameB;
  uniform sampler2D u_flow;   // displacement A->B, in output-pixel units
  uniform vec2 u_texel;       // 1/width, 1/height of the output, to convert px flow to uv offset
  uniform float u_t;
  in vec2 v_uv;
  out vec4 outColor;
  void main() {
    vec2 flowPx = texture(u_flow, v_uv).rg;
    vec2 flowUv = flowPx * u_texel;
    vec2 uvA = clamp(v_uv - u_t * flowUv, 0.0, 1.0);
    vec2 uvB = clamp(v_uv + (1.0 - u_t) * flowUv, 0.0, 1.0);
    vec3 colorA = texture(u_frameA, uvA).rgb;
    vec3 colorB = texture(u_frameB, uvB).rgb;
    outColor = vec4(mix(colorA, colorB, u_t), 1.0);
  }
  `;

  return {
    VERT_FULLSCREEN,
    FRAG_GRAYSCALE,
    FRAG_DOWNSAMPLE_AVG,
    FRAG_DERIVATIVES,
    FRAG_HS_ITERATE,
    FRAG_UPSAMPLE_FLOW,
    FRAG_RESAMPLE_FLOW,
    FRAG_COPY,
    FRAG_INTERPOLATE,
  };
})();
