/*
 * app.js — main controller. Kogakufuro does exactly one thing: raise a
 * video's effective FPS using optical-flow frame interpolation, entirely
 * client-side. This file wires the DOM to the GPU pipeline (optical-flow.js
 * + visualization.js), drives the playback/preview loop, and drives the
 * WebCodecs-based high-FPS export.
 */
'use strict';

const $ = (id) => document.getElementById(id);

// `scale` (0-1) is the compute-resolution knob (see ensureProcSizing) — the
// rendered/exported output always stays at the source resolution regardless
// of how low this goes, so turbo trades *internal* detail for raw speed, not
// visual sharpness.
const PRESETS = {
  turbo: { alpha: 0.12, iterations: 4, levels: 2, scale: 0.20 },
  fast: { alpha: 0.08, iterations: 15, levels: 3, scale: 0.5 },
  balanced: { alpha: 0.05, iterations: 40, levels: 4, scale: 1.0 },
  precise: { alpha: 0.03, iterations: 80, levels: 5, scale: 1.0 },
  ultraPrecise: { alpha: 0.01, iterations: 250, levels: 6, scale: 1.0 },
};

const state = {
  sourceType: null,       // 'video' | 'webcam'
  video: null,
  videoURL: null,
  stream: null,
  hasFrameA: false,

  playing: false,
  loop: true,
  sourceFps: 30,

  procScale: 1.0,
  algo: { alpha: 0.05, iterations: 40, levels: 4 },
  preset: 'balanced',

  // Optical-flow frame interpolation — the whole point of the site.
  interpSmooth: true,       // show interpolated (not just raw) frames in the live preview
  targetFps: 240,
  interpFlowReady: false,   // do we have a real frame pair + flow field to interpolate between?
  interpDispFlow: null,     // last computed display-resolution flow field (GLU target)
  interpLastCaptureTime: 0, // performance.now() at the last real captured frame
  interpExportRunning: false,

  stats: { fpsEMA: 0, lastFrameTime: 0, renderFpsEMA: 0, lastRenderTime: 0 },

  rafHandle: null,
  procW: 0, procH: 0,   // internal compute resolution (speed knob, can be tiny)
  outW: 0, outH: 0,     // output/display/export resolution (kept at the source's own resolution)
  outScale: 1,          // outW/procW — converts compute-resolution flow values to output-resolution units
};

const MAX_OUTPUT_DIM = 2048; // sanity cap so a 4K/8K source can't blow up GPU memory

let gl, glCanvas, canvasWrap;
let flow, viz, procCanvas, procCtx, dispCanvas, dispCtx, dispRawA, dispRawB;

// ===================== INIT =====================

function init() {
  glCanvas = $('glCanvas');
  canvasWrap = $('canvasWrap');

  gl = glCanvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
  if (!gl) {
    toast(I18N.t('toastGpuError'), true);
    return;
  }
  // Canvas/video/image sources are top-left-origin, but WebGL texture v=0 is
  // the bottom row — without this every uploaded frame renders upside down.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  try {
    flow = new OpticalFlowGL(gl);
  } catch (e) {
    console.error(e);
    toast(I18N.t('toastGpuError'), true);
    return;
  }
  viz = new FlowVisualizer(gl);

  procCanvas = document.createElement('canvas');
  procCtx = procCanvas.getContext('2d', { willReadFrequently: false });
  dispCanvas = document.createElement('canvas');
  dispCtx = dispCanvas.getContext('2d', { willReadFrequently: false });
  dispRawA = GLU.createTarget(gl, 8, 8, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
  dispRawB = GLU.createTarget(gl, 8, 8, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);

  const savedTheme = localStorage.getItem('kogakufuro-theme');
  if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
  const savedLang = localStorage.getItem('kogakufuro-lang');
  if (savedLang) I18N.setLang(savedLang);
  I18N.apply();
  refreshDynamicLabels();

  wireTopbar();
  wireSourceTabs();
  wireVideoInput();
  wireWebcamInput();
  wirePlayback();
  wireQuality();
  wireInterpolation();
  wireExport();
  wireKeyboard();

  window.addEventListener('resize', fitCanvasToContainer);
  new ResizeObserver(fitCanvasToContainer).observe(canvasWrap);
}

function toast(msg, isError) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

// ===================== TOPBAR =====================

function wireTopbar() {
  $('btnLang').addEventListener('click', () => {
    const l = I18N.toggle();
    localStorage.setItem('kogakufuro-lang', l);
    $('btnLang').textContent = l === 'ja' ? 'EN' : 'JA';
    refreshDynamicLabels();
  });
  $('btnLang').textContent = I18N.getLang() === 'ja' ? 'EN' : 'JA';

  $('btnTheme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = cur === 'light' ? 'dark' : 'light';
    if (next === 'dark') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('kogakufuro-theme', next);
  });

  $('btnFullscreen').addEventListener('click', toggleFullscreen);
  $('btnExitFullscreen').addEventListener('click', () => document.exitFullscreen());
  document.addEventListener('fullscreenchange', () => {
    $('btnExitFullscreen').hidden = !document.fullscreenElement;
    fitCanvasToContainer();
  });

  $('btnHelp').addEventListener('click', () => { $('helpModal').hidden = false; });
  $('btnHelpClose').addEventListener('click', () => { $('helpModal').hidden = true; });
  $('helpModal').addEventListener('click', (e) => { if (e.target.id === 'helpModal') $('helpModal').hidden = true; });
}

function toggleFullscreen() {
  if (!document.fullscreenElement) canvasWrap.requestFullscreen().catch(() => {});
  else document.exitFullscreen();
}

function refreshDynamicLabels() {
  $('btnPlayPause').textContent = I18N.t(state.playing ? 'pause' : 'play');
}

// ===================== SOURCE TABS =====================

function wireSourceTabs() {
  document.querySelectorAll('#sourceTabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => switchSource(btn.dataset.source));
  });
  VideoSource.attachDropZone($('dropZone'), (files) => handleVideoFiles(files));
  $('dropZone').addEventListener('click', () => $('fileVideo').click());
}

function switchSource(kind) {
  if (kind === state.sourceType) return;
  stopEverything();
  document.querySelectorAll('#sourceTabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.source === kind));
  document.querySelectorAll('.source-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === kind));
  state.sourceType = null; // becomes set once a real source is loaded
}

function stopEverything() {
  state.playing = false;
  if (state.rafHandle) cancelAnimationFrame(state.rafHandle);
  state.rafHandle = null;
  if (state.stream) { VideoSource.stopStream(state.stream); state.stream = null; }
  if (state.videoURL) { URL.revokeObjectURL(state.videoURL); state.videoURL = null; }
  if (state.video) { state.video.pause(); state.video = null; }
  state.hasFrameA = false;
  state.interpFlowReady = false;
  refreshDynamicLabels();
}

// ===================== VIDEO FILE INPUT =====================

function wireVideoInput() {
  $('fileVideo').addEventListener('change', (e) => handleVideoFiles(e.target.files));
}

async function handleVideoFiles(files) {
  if (!files || !files.length) return;
  const file = files[0];
  if (!file.type.startsWith('video/')) { toast(I18N.t('toastNoSource'), true); return; }
  try {
    const { video, url } = await VideoSource.loadVideoFile(file);
    stopEverything();
    state.sourceType = 'video';
    state.video = video;
    state.videoURL = url;
    state.hasFrameA = false;
    $('emptyState').style.display = 'none';
    $('seekBar').max = String(Math.max(1, Math.floor(video.duration * 1000)));
    fitCanvasToContainer(true);
    updateSeekUI();
    video.addEventListener('ended', onVideoEnded);
  } catch (err) {
    console.error(err);
    toast(String(err.message || err), true);
  }
}

function onVideoEnded() {
  if (state.loop) {
    state.video.currentTime = 0;
    state.hasFrameA = false;
    state.interpFlowReady = false;
    if (state.playing) state.video.play();
  } else {
    state.playing = false;
    refreshDynamicLabels();
  }
}

// ===================== WEBCAM INPUT =====================

function wireWebcamInput() {
  $('btnWebcamStart').addEventListener('click', async () => {
    try {
      const { video, stream } = await VideoSource.startWebcam();
      stopEverything();
      state.sourceType = 'webcam';
      state.video = video;
      state.stream = stream;
      state.hasFrameA = false;
      $('emptyState').style.display = 'none';
      $('btnWebcamStart').hidden = true;
      $('btnWebcamStop').hidden = false;
      fitCanvasToContainer(true);
      startPlayback();
    } catch (err) {
      console.error(err);
      toast(I18N.t('toastWebcamDenied'), true);
    }
  });
  $('btnWebcamStop').addEventListener('click', () => {
    stopEverything();
    $('btnWebcamStart').hidden = false;
    $('btnWebcamStop').hidden = true;
    $('emptyState').style.display = '';
  });
}

// ===================== SIZING / FIT =====================

function currentSourceSize() {
  return [state.video && state.video.videoWidth || 640, state.video && state.video.videoHeight || 480];
}

function ensureProcSizing(srcW, srcH) {
  // Compute resolution: the actual size the GPU solver runs at (the speed knob).
  const pw = Math.max(8, Math.round(srcW * state.procScale));
  const ph = Math.max(8, Math.round(srcH * state.procScale));

  // Output resolution: the source's own resolution (capped only to protect
  // GPU memory on very large sources), rounded to even dimensions since the
  // WebCodecs video encoder requires that. This is what preview, PNG export,
  // and the high-FPS video export all render at — sharpness never depends
  // on how low the compute scale above is set.
  const outCapScale = Math.min(1, MAX_OUTPUT_DIM / Math.max(srcW, srcH));
  let ow = Math.max(pw, Math.round(srcW * outCapScale));
  let oh = Math.max(ph, Math.round(srcH * outCapScale));
  ow -= ow % 2;
  oh -= oh % 2;

  if (procCanvas.width !== pw || procCanvas.height !== ph) {
    procCanvas.width = pw;
    procCanvas.height = ph;
  }
  if (dispCanvas.width !== ow || dispCanvas.height !== oh) {
    dispCanvas.width = ow;
    dispCanvas.height = oh;
  }
  if (glCanvas.width !== ow || glCanvas.height !== oh) {
    glCanvas.width = ow; glCanvas.height = oh;
    GLU.resizeTarget(gl, dispRawA, ow, oh);
    GLU.resizeTarget(gl, dispRawB, ow, oh);
  }
  const resized = flow.setSize(pw, ph, state.algo.levels);
  if (resized) { state.hasFrameA = false; state.interpFlowReady = false; }
  state.procW = pw; state.procH = ph;
  state.outW = ow; state.outH = oh;
  state.outScale = ow / pw;
  $('statRes').textContent = (pw === ow && ph === oh) ? `${ow}×${oh}` : `${ow}×${oh} (${I18N.t('statResCompute')}: ${pw}×${ph})`;
}

function fitCanvasToContainer(forceReflow) {
  const [srcW, srcH] = currentSourceSize();
  const cw = canvasWrap.clientWidth, ch = canvasWrap.clientHeight;
  if (!cw || !ch) return;
  const srcAspect = srcW / srcH;
  const boxAspect = cw / ch;
  let dispW, dispH;
  if (srcAspect > boxAspect) { dispW = cw; dispH = cw / srcAspect; }
  else { dispH = ch; dispW = ch * srcAspect; }
  const left = (cw - dispW) / 2, top = (ch - dispH) / 2;
  glCanvas.style.width = `${dispW}px`;
  glCanvas.style.height = `${dispH}px`;
  glCanvas.style.left = `${left}px`;
  glCanvas.style.top = `${top}px`;
  if (forceReflow && state.sourceType) ensureProcSizing(srcW, srcH);
}

// ===================== FRAME PIPELINE =====================

/**
 * Draw one source frame into the full-resolution display buffer, downsample a
 * copy into the (possibly much smaller) compute buffer, and upload both to the
 * GPU: the small one drives the flow solver, the full-res one is what gets
 * shown/exported, and — kept as both "previous" and "current" via ping-pong —
 * is what motion-compensated frame interpolation warps between.
 */
function captureFrame(source) {
  const [srcW, srcH] = currentSourceSize();
  dispCtx.drawImage(source, 0, 0, srcW, srcH, 0, 0, dispCanvas.width, dispCanvas.height);
  procCtx.drawImage(dispCanvas, 0, 0, dispCanvas.width, dispCanvas.height, 0, 0, procCanvas.width, procCanvas.height);
  flow.uploadFrame(procCanvas);
  // Ping-pong the full-res raw textures the same way flow.uploadFrame ping-pongs
  // its own internal ones, so both the previous and current full-res frame stay
  // available (needed for motion-compensated frame interpolation).
  const tmp = dispRawA; dispRawA = dispRawB; dispRawB = tmp;
  gl.bindTexture(gl.TEXTURE_2D, dispRawB.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, dispCanvas);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

function currentFrameSource() {
  return state.sourceType === 'video' || state.sourceType === 'webcam' ? state.video : null;
}

function recordThroughput() {
  const now = performance.now();
  if (state.stats.lastFrameTime > 0) {
    const dt = now - state.stats.lastFrameTime;
    const instFps = 1000 / Math.max(dt, 0.001);
    state.stats.fpsEMA = state.stats.fpsEMA === 0 ? instFps : state.stats.fpsEMA * 0.85 + instFps * 0.15;
  }
  state.stats.lastFrameTime = now;
  $('statFps').textContent = state.stats.fpsEMA.toFixed(1);
}

/** Separate from recordThroughput: how many frames actually hit the screen per
 * second, which — unlike the flow-compute rate — benefits from interpolation. */
function recordRenderThroughput() {
  const now = performance.now();
  if (state.stats.lastRenderTime > 0) {
    const dt = now - state.stats.lastRenderTime;
    const instFps = 1000 / Math.max(dt, 0.001);
    state.stats.renderFpsEMA = state.stats.renderFpsEMA === 0 ? instFps : state.stats.renderFpsEMA * 0.85 + instFps * 0.15;
  }
  state.stats.lastRenderTime = now;
  $('statRenderFps').textContent = state.stats.renderFpsEMA.toFixed(1);
}

// ===================== PLAYBACK / LIVE PREVIEW =====================

function wirePlayback() {
  $('btnPlayPause').addEventListener('click', togglePlay);
  $('chkLoop').addEventListener('change', (e) => { state.loop = e.target.checked; });
  $('seekBar').addEventListener('input', onSeekBarInput);
  const FPS_PRESETS = [24, 30, 60, 120, 240];
  $('sourceFps').addEventListener('input', (e) => {
    state.sourceFps = Math.max(1, Math.min(1000, Number(e.target.value) || 30));
    $('fpsPreset').value = FPS_PRESETS.includes(state.sourceFps) ? String(state.sourceFps) : '';
  });
  $('fpsPreset').addEventListener('change', (e) => {
    state.sourceFps = Number(e.target.value);
    $('sourceFps').value = state.sourceFps;
  });
}

function togglePlay() {
  if (!state.sourceType) { toast(I18N.t('toastNoSource'), true); return; }
  if (state.playing) pausePlayback();
  else startPlayback();
}

function startPlayback() {
  state.playing = true;
  if (state.sourceType === 'video') state.video.play().catch(() => {});
  refreshDynamicLabels();
  if (!state.rafHandle) {
    const tick = () => {
      if (!state.playing) { state.rafHandle = null; return; }
      playbackTick();
      updateSeekUI();
      state.rafHandle = requestAnimationFrame(tick);
    };
    state.rafHandle = requestAnimationFrame(tick);
  }
}

function pausePlayback() {
  state.playing = false;
  if (state.video && state.sourceType === 'video') state.video.pause();
  if (state.rafHandle) cancelAnimationFrame(state.rafHandle);
  state.rafHandle = null;
  refreshDynamicLabels();
}

/**
 * The live preview tick: only captures + computes flow when a new real
 * source frame is actually due (every 1/sourceFps of wall-clock time); on
 * every other rAF tick, if "smooth preview" is on, it just re-draws an
 * interpolated in-between frame from the flow field already on hand. This
 * decouples the (expensive) flow solve from the (cheap) render, so the
 * screen can update faster than the source's real frame rate — the actual
 * mechanism behind raising the FPS.
 */
function playbackTick() {
  const [srcW, srcH] = currentSourceSize();
  ensureProcSizing(srcW, srcH);
  const src = currentFrameSource();
  if (!src) return;

  const now = performance.now();
  const frameIntervalMs = 1000 / state.sourceFps;
  const dueForNextFrame = !state.interpFlowReady || (now - state.interpLastCaptureTime) >= frameIntervalMs;

  if (dueForNextFrame) {
    captureFrame(src);
    state.interpLastCaptureTime = now;
    if (!state.hasFrameA) {
      state.hasFrameA = true;
      state.interpFlowReady = false;
      return;
    }
    const flowTex = flow.compute(state.algo.alpha, state.algo.iterations);
    recordThroughput();
    state.interpDispFlow = viz.getDisplayFlow(flowTex, state.outW, state.outH, state.outScale);
    state.interpFlowReady = true;
  }

  if (!state.interpFlowReady) return;

  if (state.interpSmooth) {
    const t = Math.min(1, (performance.now() - state.interpLastCaptureTime) / frameIntervalMs);
    viz.renderInterpolated(dispRawA, dispRawB, state.interpDispFlow, t, null);
    recordRenderThroughput();
  } else if (dueForNextFrame) {
    viz.renderSource(dispRawB, null);
    recordRenderThroughput();
  }
}

function onSeekBarInput(e) {
  if (state.sourceType !== 'video') return;
  pausePlayback();
  const frac = Number(e.target.value) / Number(e.target.max);
  const t = frac * state.video.duration;
  state.hasFrameA = false;
  state.interpFlowReady = false;
  VideoSource.seekTo(state.video, t).then(() => {
    ensureProcSizing(state.video.videoWidth, state.video.videoHeight);
    captureFrame(state.video);
    state.hasFrameA = true;
    viz.renderSource(dispRawB, null);
    updateSeekUI();
  });
}

function updateSeekUI() {
  if (state.sourceType !== 'video' || !state.video) return;
  const v = state.video;
  const cur = v.currentTime;
  const dur = v.duration || 0;
  if (dur > 0) $('seekBar').value = String(Math.round((cur / dur) * Number($('seekBar').max)));
  $('timeLabel').textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
}

function fmtTime(t) {
  if (!isFinite(t)) return '00:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ===================== QUALITY (algorithm + compute scale) =====================

function wireQuality() {
  bindSlider('procScale', 'procScaleVal', (v) => {
    state.procScale = v / 100;
    ensureCurrentProcSizing();
  }, (v) => `${Math.round(v)}%`);

  $('algoPreset').addEventListener('change', (e) => {
    state.preset = e.target.value;
    if (PRESETS[state.preset]) applyPreset(PRESETS[state.preset]);
  });
  bindSlider('alpha', 'alphaVal', (v) => { state.algo.alpha = v; markCustomPreset(); }, (v) => v.toFixed(3));
  bindSlider('iterations', 'itersVal', (v) => { state.algo.iterations = Math.round(v); markCustomPreset(); }, (v) => String(Math.round(v)));
  bindSlider('pyrLevels', 'levelsVal', (v) => { state.algo.levels = Math.round(v); state.hasFrameA = false; markCustomPreset(); }, (v) => String(Math.round(v)));
}

function applyPreset(p) {
  state.algo = { alpha: p.alpha, iterations: p.iterations, levels: p.levels };
  $('alpha').value = p.alpha; $('alphaVal').textContent = p.alpha.toFixed(3);
  $('iterations').value = p.iterations; $('itersVal').textContent = String(p.iterations);
  $('pyrLevels').value = p.levels; $('levelsVal').textContent = String(p.levels);
  if (p.scale !== undefined) {
    state.procScale = p.scale;
    $('procScale').value = Math.round(p.scale * 100);
    $('procScaleVal').textContent = `${Math.round(p.scale * 100)}%`;
  }
  state.hasFrameA = false;
  state.interpFlowReady = false;
  ensureCurrentProcSizing();
}

function markCustomPreset() {
  if (state.preset !== 'custom') {
    state.preset = 'custom';
    $('algoPreset').value = 'custom';
  }
  state.interpFlowReady = false;
  ensureCurrentProcSizing();
}

function ensureCurrentProcSizing() {
  if (!state.sourceType) return;
  const [w, h] = currentSourceSize();
  ensureProcSizing(w, h);
}

function bindSlider(inputId, labelId, onChange, fmt) {
  const el = $(inputId);
  el.addEventListener('input', () => {
    const v = Number(el.value);
    $(labelId).textContent = fmt(v);
    onChange(v);
  });
}

// ===================== SNAPSHOT =====================

function wireExport() {
  $('btnSnapshot').addEventListener('click', exportSnapshot);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportSnapshot() {
  if (!state.sourceType) { toast(I18N.t('toastNoSource'), true); return; }
  glCanvas.toBlob((blob) => {
    downloadBlob(blob, `kogakufuro-${Date.now()}.png`);
    toast(I18N.t('toastSaved'));
  }, 'image/png');
}

// ===================== FRAME INTERPOLATION EXPORT (WebCodecs + WebM) =====================

function wireInterpolation() {
  bindSlider('targetFps', 'targetFpsVal', (v) => { state.targetFps = Math.max(1, Math.round(v)); }, (v) => String(Math.round(v)));
  $('targetFpsPreset').addEventListener('change', (e) => {
    if (!e.target.value) return;
    state.targetFps = Number(e.target.value);
    $('targetFps').value = state.targetFps;
    $('targetFpsVal').textContent = String(state.targetFps);
  });
  $('chkInterpSmooth').addEventListener('change', (e) => { state.interpSmooth = e.target.checked; });
  $('btnInterpExport').addEventListener('click', exportInterpolatedVideo);

  if (typeof VideoEncoder === 'undefined' || typeof WebMMuxer === 'undefined') {
    $('btnInterpExport').disabled = true;
    $('interpUnsupportedHint').hidden = false;
  }
}

async function pickVideoCodec(w, h, fps) {
  const candidates = [
    { trackCodec: 'V_VP9', encoderCodec: 'vp09.00.10.08' },
    { trackCodec: 'V_VP8', encoderCodec: 'vp8' },
  ];
  for (const c of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec: c.encoderCodec, width: w, height: h, bitrate: 8_000_000, framerate: fps,
      });
      if (support && support.supported) return c;
    } catch (e) { /* try next candidate */ }
  }
  return null;
}

/**
 * Exports the whole video at the target FPS, keeping the original duration
 * and playback speed (i.e. NOT slow motion — every synthesized frame gets an
 * exact timestamp of i/targetFps). This is done with WebCodecs' VideoEncoder
 * rather than MediaRecorder: MediaRecorder infers frame timing from real
 * wall-clock capture time, which can't be trusted when frames are rendered
 * faster or slower than real time (exactly what happens here), and produced
 * unevenly-timed, glitchy output. VideoEncoder lets each frame carry an
 * explicit timestamp, independent of how long generating it actually took.
 */
async function exportInterpolatedVideo() {
  if (state.interpExportRunning) return;
  if (state.sourceType !== 'video') { toast(I18N.t('toastNoSource'), true); return; }
  if (typeof VideoEncoder === 'undefined' || typeof WebMMuxer === 'undefined') {
    toast(I18N.t('interpUnsupported'), true);
    return;
  }
  pausePlayback();
  state.interpExportRunning = true;
  $('btnInterpExport').disabled = true;
  $('interpProgress').hidden = false;
  $('interpProgressBar').style.width = '0%';

  const video = state.video;
  ensureProcSizing(video.videoWidth, video.videoHeight);
  const encW = state.outW, encH = state.outH;

  const codec = await pickVideoCodec(encW, encH, state.targetFps);
  if (!codec) {
    toast(I18N.t('interpUnsupported'), true);
    state.interpExportRunning = false;
    $('btnInterpExport').disabled = false;
    $('interpProgress').hidden = true;
    return;
  }

  const target = new WebMMuxer.ArrayBufferTarget();
  const muxer = new WebMMuxer.Muxer({
    target,
    video: { codec: codec.trackCodec, width: encW, height: encH, frameRate: state.targetFps },
  });

  let encodeError = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  const bitrate = Math.min(30_000_000, Math.max(4_000_000, Math.round(encW * encH * 0.08 * Math.min(state.targetFps, 60))));
  videoEncoder.configure({ codec: codec.encoderCodec, width: encW, height: encH, bitrate, framerate: state.targetFps });

  const dt = 1 / state.sourceFps;
  const totalFrames = Math.max(1, Math.round(video.duration * state.targetFps));
  const frameDurationUs = 1e6 / state.targetFps;
  const maxPair = Math.max(0, Math.ceil(video.duration / dt) - 1);
  const keyFrameEvery = Math.max(1, Math.round(state.targetFps * 2));

  let currentPair = -1;
  let dispFlow = null;

  async function advanceToPair(pairIndex) {
    if (pairIndex === currentPair) return;
    ensureProcSizing(video.videoWidth, video.videoHeight);
    if (currentPair === -1 || pairIndex !== currentPair + 1) {
      await VideoSource.seekTo(video, pairIndex * dt);
      captureFrame(video);
    }
    await VideoSource.seekTo(video, (pairIndex + 1) * dt);
    captureFrame(video);
    currentPair = pairIndex;
    const flowTex = flow.compute(state.algo.alpha, state.algo.iterations);
    dispFlow = viz.getDisplayFlow(flowTex, state.outW, state.outH, state.outScale);
  }

  for (let i = 0; i < totalFrames && !encodeError; i++) {
    const ot = i / state.targetFps;
    const rawPair = ot / dt;
    const pairIndex = Math.min(maxPair, Math.floor(rawPair));
    const t = Math.min(1, Math.max(0, rawPair - pairIndex));

    await advanceToPair(pairIndex);
    if (dispFlow) viz.renderInterpolated(dispRawA, dispRawB, dispFlow, t, null);
    else viz.renderSource(dispRawB, null);

    while (videoEncoder.encodeQueueSize > 24) {
      await new Promise((r) => setTimeout(r, 4));
    }
    const vf = new VideoFrame(glCanvas, { timestamp: Math.round(i * frameDurationUs) });
    videoEncoder.encode(vf, { keyFrame: i % keyFrameEvery === 0 });
    vf.close();

    if (i % 3 === 0) {
      await new Promise((r) => setTimeout(r, 0));
      $('interpProgressBar').style.width = `${Math.round(((i + 1) / totalFrames) * 100)}%`;
    }
  }

  await videoEncoder.flush();
  videoEncoder.close();

  state.hasFrameA = false;
  state.interpFlowReady = false;
  state.interpExportRunning = false;
  $('btnInterpExport').disabled = false;
  $('interpProgress').hidden = true;

  if (encodeError) {
    toast(String(encodeError.message || encodeError), true);
    return;
  }

  muxer.finalize();
  downloadBlob(new Blob([target.buffer], { type: 'video/webm' }), `kogakufuro-${state.targetFps}fps-${Date.now()}.webm`);
  toast(`${I18N.t('toastInterpDone')} (${totalFrames} ${I18N.t('framesWord')})`);
}

// ===================== KEYBOARD =====================

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); }
    else if (e.key === 's' || e.key === 'S') { exportSnapshot(); }
    else if (e.key === 'Escape') { $('helpModal').hidden = true; }
  });
}

document.addEventListener('DOMContentLoaded', init);
