/*
 * app.js — main controller: wires the DOM to the GPU optical-flow pipeline,
 * owns playback/ROI/algorithm/visualization/calibration state, drives the
 * realtime (rAF) and step-analysis (frame-accurate seek) loops, and handles
 * export (PNG / WebM / CSV / JSON). Everything below runs client-side only.
 */
'use strict';

const $ = (id) => document.getElementById(id);

const PRESETS = {
  fast: { alpha: 0.08, iterations: 15, levels: 3 },
  balanced: { alpha: 0.05, iterations: 40, levels: 4 },
  precise: { alpha: 0.03, iterations: 80, levels: 5 },
  fluid: { alpha: 0.15, iterations: 60, levels: 5 },
  sports: { alpha: 0.02, iterations: 30, levels: 3 },
};

const state = {
  sourceType: null,       // 'video' | 'webcam' | 'images'
  video: null,
  videoURL: null,
  stream: null,
  imgA: null, imgB: null,
  imgAUrl: null, imgBUrl: null,
  hasFrameA: false,
  imagesReady: false,

  procMode: 'realtime',   // 'realtime' | 'step'
  playing: false,
  stepRunning: false,
  loop: true,
  sourceFps: 30,
  stepTime: 0,

  roi: null,              // {x,y,w,h} normalized to full source, or null = full frame
  roiDragging: false,
  roiDragStart: null,
  procScale: 1.0,

  algo: { alpha: 0.05, iterations: 40, levels: 4 },
  preset: 'balanced',

  colorMode: 'wheel',
  displayMode: 'flow',
  blendAlpha: 0.6,
  maxMag: 0,               // 0 = auto
  autoMaxMag: 8,
  gamma: 0.7,
  showArrows: false,
  arrowDensity: 28,
  showParticles: false,
  particleCount: 600,
  trailFade: 0.12,

  calib: { enabled: false, px: 100, dist: 1, unit: 'cm' },

  stats: {
    fpsEMA: 0,
    lastFrameTime: 0,
    avgHistory: new Float32Array(240),
    histIndex: 0,
    histFilled: 0,
    histBins: new Float32Array(24),
  },

  recording: { active: false, recorder: null, chunks: [], compositeCanvas: null, compositeCtx: null, track: null },

  rafHandle: null,
  procW: 0, procH: 0,
};

let gl, glCanvas, overlayCanvas, overlayCtx, roiCanvas, roiCtx, canvasWrap;
let flow, viz, particles, procCanvas, procCtx;

// ===================== INIT =====================

function init() {
  glCanvas = $('glCanvas');
  overlayCanvas = $('overlayCanvas');
  roiCanvas = $('roiCanvas');
  canvasWrap = $('canvasWrap');
  overlayCtx = overlayCanvas.getContext('2d');
  roiCtx = roiCanvas.getContext('2d');

  gl = glCanvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
  if (!gl) {
    toast(I18N.t('toastGpuError'), true);
    return;
  }

  try {
    flow = new OpticalFlowGL(gl);
  } catch (e) {
    console.error(e);
    toast(I18N.t('toastGpuError'), true);
    return;
  }
  viz = new FlowVisualizer(gl);
  particles = new ParticleField(state.particleCount);

  procCanvas = document.createElement('canvas');
  procCtx = procCanvas.getContext('2d', { willReadFrequently: false });

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
  wireImageInput();
  wirePlayback();
  wireRoi();
  wireAlgorithm();
  wireVisualization();
  wireCalibration();
  wireExport();
  wireKeyboard();

  window.addEventListener('resize', fitCanvasToContainer);
  new ResizeObserver(fitCanvasToContainer).observe(canvasWrap);

  requestAnimationFrame(idleTick);
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
  $('btnPlayPause').textContent = I18N.t(state.playing || state.stepRunning ? 'pause' : 'play');
  $('btnRecord').textContent = I18N.t(state.recording.active ? 'exportRecStop' : 'exportRecStart');
  $('btnRecord').classList.toggle('recording', state.recording.active);
  updateStatUnits();
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
  const isWebcam = kind === 'webcam';
  document.querySelectorAll('#procModeSeg .seg').forEach((b) => { b.disabled = isWebcam; });
  if (isWebcam) setProcMode('realtime');
}

function stopEverything() {
  state.playing = false;
  state.stepRunning = false;
  if (state.rafHandle) cancelAnimationFrame(state.rafHandle);
  state.rafHandle = null;
  if (state.stream) { VideoSource.stopStream(state.stream); state.stream = null; }
  if (state.videoURL) { URL.revokeObjectURL(state.videoURL); state.videoURL = null; }
  if (state.video) { state.video.pause(); state.video = null; }
  state.hasFrameA = false;
  state.imagesReady = false;
  stopRecording();
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
    state.roi = null;
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
      state.roi = null;
      state.hasFrameA = false;
      $('emptyState').style.display = 'none';
      $('btnWebcamStart').hidden = true;
      $('btnWebcamStop').hidden = false;
      fitCanvasToContainer(true);
      startRealtime();
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

// ===================== IMAGE PAIR INPUT =====================

function wireImageInput() {
  $('fileImageA').addEventListener('change', (e) => loadImageSlot('A', e.target.files[0]));
  $('fileImageB').addEventListener('change', (e) => loadImageSlot('B', e.target.files[0]));
  $('btnSwapImages').addEventListener('click', () => {
    [state.imgA, state.imgB] = [state.imgB, state.imgA];
    [state.imgAUrl, state.imgBUrl] = [state.imgBUrl, state.imgAUrl];
    if (state.imagesReady) computeImagePair();
  });
}

async function loadImageSlot(slot, file) {
  if (!file) return;
  try {
    const { img, url } = await VideoSource.loadImageFile(file);
    if (slot === 'A') { state.imgA = img; state.imgAUrl = url; }
    else { state.imgB = img; state.imgBUrl = url; }
    if (state.imgA && state.imgB) {
      state.sourceType = 'images';
      $('emptyState').style.display = 'none';
      fitCanvasToContainer(true);
      computeImagePair();
    }
  } catch (err) {
    toast(String(err.message || err), true);
  }
}

function computeImagePair() {
  if (!state.imgA || !state.imgB) { toast(I18N.t('toastImagesNeedBoth'), true); return; }
  ensureProcSizing(state.imgA.naturalWidth, state.imgA.naturalHeight);
  drawToProc(state.imgA);
  flow.uploadFrame(procCanvas);
  drawToProc(state.imgB);
  flow.uploadFrame(procCanvas);
  state.imagesReady = true;
  state.hasFrameA = true;
  const flowTex = flow.compute(state.algo.alpha, state.algo.iterations);
  const t0 = performance.now();
  renderVisualization(flowTex);
  updateOverlayAndStats(flowTex, performance.now() - t0);
}

// ===================== SIZING / FIT =====================

function currentSourceSize() {
  if (state.sourceType === 'video' || state.sourceType === 'webcam') {
    return [state.video.videoWidth || 640, state.video.videoHeight || 480];
  }
  if (state.sourceType === 'images') {
    return [state.imgA.naturalWidth, state.imgA.naturalHeight];
  }
  return [640, 480];
}

function ensureProcSizing(srcW, srcH) {
  const roi = state.roi || { x: 0, y: 0, w: 1, h: 1 };
  const sw = Math.max(1, Math.round(roi.w * srcW));
  const sh = Math.max(1, Math.round(roi.h * srcH));
  const pw = Math.max(8, Math.round(sw * state.procScale));
  const ph = Math.max(8, Math.round(sh * state.procScale));
  if (procCanvas.width !== pw || procCanvas.height !== ph) {
    procCanvas.width = pw;
    procCanvas.height = ph;
  }
  if (glCanvas.width !== pw || glCanvas.height !== ph) {
    glCanvas.width = pw; glCanvas.height = ph;
    overlayCanvas.width = pw; overlayCanvas.height = ph;
    roiCanvas.width = pw; roiCanvas.height = ph;
  }
  const resized = flow.setSize(pw, ph, state.algo.levels);
  if (resized) state.hasFrameA = false;
  state.procW = pw; state.procH = ph;
  $('statRes').textContent = `${pw}×${ph}`;
  return [pw, ph];
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
  for (const c of [glCanvas, overlayCanvas, roiCanvas]) {
    c.style.width = `${dispW}px`;
    c.style.height = `${dispH}px`;
    c.style.left = `${left}px`;
    c.style.top = `${top}px`;
  }
  if (forceReflow && state.sourceType) ensureProcSizing(srcW, srcH);
}

// ===================== FRAME PIPELINE =====================

function drawToProc(source) {
  const roi = state.roi || { x: 0, y: 0, w: 1, h: 1 };
  const [srcW, srcH] = currentSourceSize();
  const sx = roi.x * srcW, sy = roi.y * srcH, sw = roi.w * srcW, sh = roi.h * srcH;
  procCtx.drawImage(source, sx, sy, sw, sh, 0, 0, procCanvas.width, procCanvas.height);
}

function currentFrameSource() {
  if (state.sourceType === 'video' || state.sourceType === 'webcam') return state.video;
  return null;
}

/** Grab one frame from the live source, upload it, and (if we have a pair) compute + render. */
function processOneFrame(updateVisuals) {
  const [srcW, srcH] = currentSourceSize();
  ensureProcSizing(srcW, srcH);
  const src = currentFrameSource();
  if (!src) return false;
  drawToProc(src);
  flow.uploadFrame(procCanvas);
  if (!state.hasFrameA) { state.hasFrameA = true; return false; }

  const t0 = performance.now();
  const flowTex = flow.compute(state.algo.alpha, state.algo.iterations);
  const dt = performance.now() - t0;

  if (updateVisuals) {
    renderVisualization(flowTex);
    updateOverlayAndStats(flowTex, dt);
  } else {
    recordThroughput(dt);
    pushAvgHistory(flow.lastAvgMag);
  }
  return true;
}

function renderVisualization(flowTex) {
  const mag = state.maxMag > 0 ? state.maxMag : Math.max(0.6, flow.lastPeakMag * 1.15, state.autoMaxMag);
  state.autoMaxMag = state.autoMaxMag * 0.9 + mag * 0.1;

  if (state.displayMode === 'split') {
    GLU.bindTarget(gl, null);
    const half = glCanvas.width / 2;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, half, glCanvas.height);
    viz.render('source', flow.rawB, mag, state.gamma, null);
    gl.scissor(half, 0, glCanvas.width - half, glCanvas.height);
    viz.render(state.colorMode, flowTex, mag, state.gamma, null);
    gl.disable(gl.SCISSOR_TEST);
  } else if (state.displayMode === 'blend' && state.colorMode !== 'source') {
    viz.renderBlend(flow.rawB, flowTex, state.colorMode, mag, state.gamma, state.blendAlpha, null);
  } else {
    viz.render(state.colorMode, state.colorMode === 'source' ? flow.rawB : flowTex, mag, state.gamma, null);
  }
}

function updateOverlayAndStats(flowTex, computeMs) {
  recordThroughput(computeMs);
  pushAvgHistory(flow.lastAvgMag);

  if (state.showParticles) {
    Overlay.fadeTrails(overlayCtx, overlayCanvas.width, overlayCanvas.height, state.trailFade);
  } else {
    Overlay.clear(overlayCtx, overlayCanvas.width, overlayCanvas.height);
  }

  // Grid readback drives arrows/particles AND the always-on histogram chart.
  const gridW = Math.max(6, Math.round(state.arrowDensity));
  const gridH = Math.max(4, Math.round(gridW * (procCanvas.height / procCanvas.width)));
  const grid = viz.readGrid(flowTex, gridW, gridH);
  const mag = state.maxMag > 0 ? state.maxMag : state.autoMaxMag;
  if (state.showArrows) {
    Overlay.drawArrows(overlayCtx, grid, gridW, gridH, overlayCanvas.width, overlayCanvas.height, mag, 1.0);
  }
  if (state.showParticles) {
    particles.step(grid, gridW, gridH, procCanvas.width, procCanvas.height, 26);
    particles.draw(overlayCtx, overlayCanvas.width, overlayCanvas.height);
  }
  updateHistogram(grid);

  updateStatsUI();
  drawCharts();
}

function recordThroughput(computeMs) {
  const now = performance.now();
  if (state.stats.lastFrameTime > 0) {
    const dt = now - state.stats.lastFrameTime;
    const instFps = 1000 / Math.max(dt, 0.001);
    state.stats.fpsEMA = state.stats.fpsEMA === 0 ? instFps : state.stats.fpsEMA * 0.85 + instFps * 0.15;
  }
  state.stats.lastFrameTime = now;
}

function pushAvgHistory(v) {
  const s = state.stats;
  s.avgHistory[s.histIndex % s.avgHistory.length] = v;
  s.histIndex++;
  s.histFilled = Math.min(s.histFilled + 1, s.avgHistory.length);
}

function updateHistogram(grid) {
  const bins = new Float32Array(state.stats.histBins.length);
  const mag = state.maxMag > 0 ? state.maxMag : state.autoMaxMag;
  for (let i = 0; i < grid.length; i += 4) {
    const m = Math.hypot(grid[i], grid[i + 1]);
    let b = Math.floor((m / Math.max(mag, 1e-5)) * bins.length);
    if (b < 0) b = 0; if (b >= bins.length) b = bins.length - 1;
    bins[b]++;
  }
  const hb = state.stats.histBins;
  for (let i = 0; i < hb.length; i++) hb[i] = hb[i] * 0.7 + bins[i] * 0.3;
}

function updateStatsUI() {
  $('statFps').textContent = state.stats.fpsEMA.toFixed(1);
  const avg = flow.lastAvgMag, peak = flow.lastPeakMag;
  if (state.calib.enabled && state.calib.px > 0) {
    const unitPerPx = state.calib.dist / state.calib.px;
    $('statAvg').textContent = (avg * state.sourceFps * unitPerPx).toFixed(3);
    $('statPeak').textContent = (peak * state.sourceFps * unitPerPx).toFixed(3);
  } else {
    $('statAvg').textContent = avg.toFixed(2);
    $('statPeak').textContent = peak.toFixed(2);
  }
}

function updateStatUnits() {
  const unit = state.calib.enabled ? `${state.calib.unit}/s` : 'px/f';
  $('statAvgUnit').textContent = unit;
  $('statPeakUnit').textContent = unit;
}

function drawCharts() {
  const s = state.stats;
  const sc = $('sparklineCanvas'), hc = $('histogramCanvas');
  const sctx = sc.getContext('2d'), hctx = hc.getContext('2d');
  sctx.clearRect(0, 0, sc.width, sc.height);
  hctx.clearRect(0, 0, hc.width, hc.height);
  const n = s.histFilled;
  const ordered = new Float32Array(n);
  for (let i = 0; i < n; i++) ordered[i] = s.avgHistory[(s.histIndex - n + i + s.avgHistory.length * 4) % s.avgHistory.length];
  const maxV = Math.max(1e-5, ...ordered, state.maxMag > 0 ? state.maxMag : 0);
  Overlay.drawSparkline(sctx, 0, 0, sc.width, sc.height, ordered, n, maxV, '#5ee7ff');
  Overlay.drawHistogram(hctx, 0, 0, hc.width, hc.height, s.histBins, 'rgba(160,107,255,0.7)');

  const lc = $('legendCanvas');
  if (!lc._drawn) { Overlay.drawLegendWheel(lc.getContext('2d'), 36, 36, 30); lc._drawn = true; }
  lc.style.display = state.colorMode === 'wheel' ? '' : 'none';
}

// ===================== PLAYBACK =====================

function wirePlayback() {
  $('btnPlayPause').addEventListener('click', togglePlay);
  $('btnStepBack').addEventListener('click', () => stepOnce(-1));
  $('btnStepFwd').addEventListener('click', () => stepOnce(1));
  $('chkLoop').addEventListener('change', (e) => { state.loop = e.target.checked; });
  $('seekBar').addEventListener('input', onSeekBarInput);

  document.querySelectorAll('#procModeSeg .seg').forEach((b) => {
    b.addEventListener('click', () => setProcMode(b.dataset.mode));
  });

  const FPS_PRESETS = [30, 60, 120, 240, 480, 960, 1000];
  $('sourceFps').addEventListener('input', (e) => {
    state.sourceFps = Math.max(1, Math.min(1000, Number(e.target.value) || 30));
    $('fpsPreset').value = FPS_PRESETS.includes(state.sourceFps) ? String(state.sourceFps) : '';
  });
  $('fpsPreset').addEventListener('change', (e) => {
    state.sourceFps = Number(e.target.value);
    $('sourceFps').value = state.sourceFps;
  });
}

function setProcMode(mode) {
  if (state.sourceType === 'webcam' && mode === 'step') return;
  state.procMode = mode;
  document.querySelectorAll('#procModeSeg .seg').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  if (state.playing || state.stepRunning) { pausePlayback(); }
}

function togglePlay() {
  if (!state.sourceType || state.sourceType === 'images') { toast(I18N.t('toastNoSource'), true); return; }
  if (state.playing || state.stepRunning) pausePlayback();
  else startPlayback();
}

function startPlayback() {
  if (state.procMode === 'step' && state.sourceType === 'video') {
    state.video.pause();
    state.stepRunning = true;
    refreshDynamicLabels();
    runStepLoop({ live: true });
  } else {
    state.playing = true;
    if (state.sourceType === 'video') state.video.play().catch(() => {});
    refreshDynamicLabels();
    startRealtime();
  }
}

function pausePlayback() {
  state.playing = false;
  state.stepRunning = false;
  if (state.video && state.sourceType === 'video') state.video.pause();
  if (state.rafHandle) cancelAnimationFrame(state.rafHandle);
  state.rafHandle = null;
  refreshDynamicLabels();
}

function startRealtime() {
  if (state.rafHandle) return;
  const tick = () => {
    if (!state.playing) { state.rafHandle = null; return; }
    processOneFrame(true);
    updateSeekUI();
    state.rafHandle = requestAnimationFrame(tick);
  };
  state.rafHandle = requestAnimationFrame(tick);
}

async function runStepLoop({ live, collectStats, maxFrames, onProgress }) {
  const video = state.video;
  const dt = 1 / state.sourceFps;
  const results = [];
  let frameIdx = 0;
  const total = maxFrames || Math.ceil(video.duration / dt);
  while ((live ? state.stepRunning : true) && frameIdx < total) {
    await VideoSource.seekTo(video, state.stepTime);
    ensureProcSizing(video.videoWidth, video.videoHeight);
    drawToProc(video);
    flow.uploadFrame(procCanvas);
    if (state.hasFrameA) {
      const t0 = performance.now();
      const flowTex = flow.compute(state.algo.alpha, state.algo.iterations);
      const ms = performance.now() - t0;
      if (live) { renderVisualization(flowTex); updateOverlayAndStats(flowTex, ms); }
      else { recordThroughput(ms); pushAvgHistory(flow.lastAvgMag); }
      if (collectStats) {
        results.push({ frame: frameIdx, t: state.stepTime, avg: flow.lastAvgMag, peak: flow.lastPeakMag });
      }
    } else {
      state.hasFrameA = true;
    }
    frameIdx++;
    state.stepTime += dt;
    if (onProgress) onProgress(frameIdx / total);
    if (state.stepTime >= video.duration) {
      if (live && state.loop && !collectStats) { state.stepTime = 0; state.hasFrameA = false; }
      else break;
    }
    if (live) updateSeekUI();
    await new Promise((r) => setTimeout(r, 0));
  }
  if (live) { state.stepRunning = false; refreshDynamicLabels(); }
  return results;
}

function stepOnce(dir) {
  if (state.sourceType !== 'video') return;
  pausePlayback();
  const dt = 1 / state.sourceFps;
  state.stepTime = Math.max(0, (state.video.currentTime || 0) + dir * dt);
  VideoSource.seekTo(state.video, state.stepTime).then(() => {
    ensureProcSizing(state.video.videoWidth, state.video.videoHeight);
    drawToProc(state.video);
    flow.uploadFrame(procCanvas);
    const hadPrev = state.hasFrameA;
    state.hasFrameA = true;
    if (hadPrev) {
      const t0 = performance.now();
      const flowTex = flow.compute(state.algo.alpha, state.algo.iterations);
      renderVisualization(flowTex);
      updateOverlayAndStats(flowTex, performance.now() - t0);
    }
    updateSeekUI();
  });
}

function onSeekBarInput(e) {
  if (state.sourceType !== 'video') return;
  pausePlayback();
  const frac = Number(e.target.value) / Number(e.target.max);
  const t = frac * state.video.duration;
  state.stepTime = t;
  state.hasFrameA = false;
  VideoSource.seekTo(state.video, t).then(() => {
    ensureProcSizing(state.video.videoWidth, state.video.videoHeight);
    drawToProc(state.video);
    flow.uploadFrame(procCanvas);
    state.hasFrameA = true;
    updateSeekUI();
  });
}

function updateSeekUI() {
  if (state.sourceType !== 'video' || !state.video) return;
  const v = state.video;
  const cur = state.procMode === 'step' ? state.stepTime : v.currentTime;
  const dur = v.duration || 0;
  if (dur > 0) $('seekBar').value = String(Math.round((cur / dur) * Number($('seekBar').max)));
  $('timeLabel').textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  $('frameLabel').textContent = `frame ${Math.round(cur * state.sourceFps)}`;
}

function fmtTime(t) {
  if (!isFinite(t)) return '00:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function idleTick() {
  // Keeps ROI overlay / legend responsive even when nothing is playing.
  requestAnimationFrame(idleTick);
}

// ===================== ROI =====================

function wireRoi() {
  $('chkRoi').addEventListener('change', (e) => {
    if (!e.target.checked) { state.roi = null; ensureCurrentProcSizing(); Overlay.clear(roiCtx, roiCanvas.width, roiCanvas.height); }
    else toast(I18N.t('toastRoiOn'));
  });
  $('btnRoiReset').addEventListener('click', () => {
    state.roi = null;
    ensureCurrentProcSizing();
    Overlay.clear(roiCtx, roiCanvas.width, roiCanvas.height);
  });

  roiCanvas.addEventListener('pointerdown', (e) => {
    if (!$('chkRoi').checked) return;
    roiCanvas.style.pointerEvents = 'auto';
    state.roiDragging = true;
    state.roiDragStart = pointerFrac(e);
    roiCanvas.setPointerCapture(e.pointerId);
  });
  roiCanvas.addEventListener('pointermove', (e) => {
    if (!state.roiDragging) return;
    const cur = pointerFrac(e);
    drawRoiPreview(state.roiDragStart, cur);
  });
  roiCanvas.addEventListener('pointerup', (e) => {
    if (!state.roiDragging) return;
    state.roiDragging = false;
    roiCanvas.style.pointerEvents = 'none';
    const cur = pointerFrac(e);
    finalizeRoi(state.roiDragStart, cur);
  });
}

function pointerFrac(e) {
  const r = roiCanvas.getBoundingClientRect();
  return [
    Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  ];
}

function drawRoiPreview(a, b) {
  const w = roiCanvas.width, h = roiCanvas.height;
  Overlay.clear(roiCtx, w, h);
  const x = Math.min(a[0], b[0]) * w, y = Math.min(a[1], b[1]) * h;
  const rw = Math.abs(a[0] - b[0]) * w, rh = Math.abs(a[1] - b[1]) * h;
  roiCtx.strokeStyle = '#5ee7ff';
  roiCtx.lineWidth = 2;
  roiCtx.setLineDash([6, 4]);
  roiCtx.strokeRect(x, y, rw, rh);
  roiCtx.fillStyle = 'rgba(94,231,255,0.12)';
  roiCtx.fillRect(x, y, rw, rh);
  roiCtx.setLineDash([]);
}

function finalizeRoi(a, b) {
  const w = Math.abs(a[0] - b[0]), h = Math.abs(a[1] - b[1]);
  if (w < 0.02 || h < 0.02) { Overlay.clear(roiCtx, roiCanvas.width, roiCanvas.height); return; }
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
  const base = state.roi || { x: 0, y: 0, w: 1, h: 1 };
  state.roi = {
    x: base.x + x0 * base.w,
    y: base.y + y0 * base.h,
    w: w * base.w,
    h: h * base.h,
  };
  state.hasFrameA = false;
  Overlay.clear(roiCtx, roiCanvas.width, roiCanvas.height);
  ensureCurrentProcSizing();
  fitCanvasToContainer();
}

function ensureCurrentProcSizing() {
  if (!state.sourceType) return;
  const [w, h] = currentSourceSize();
  ensureProcSizing(w, h);
  if (state.sourceType === 'images' && state.imagesReady) computeImagePair();
}

// ===================== ALGORITHM =====================

function wireAlgorithm() {
  $('algoPreset').addEventListener('change', (e) => {
    state.preset = e.target.value;
    if (PRESETS[state.preset]) applyPreset(PRESETS[state.preset]);
  });
  bindSlider('alpha', 'alphaVal', (v) => { state.algo.alpha = v; markCustomPreset(); }, (v) => v.toFixed(3));
  bindSlider('iterations', 'itersVal', (v) => { state.algo.iterations = Math.round(v); markCustomPreset(); }, (v) => String(Math.round(v)));
  bindSlider('pyrLevels', 'levelsVal', (v) => { state.algo.levels = Math.round(v); state.hasFrameA = false; markCustomPreset(); }, (v) => String(Math.round(v)));
}

function applyPreset(p) {
  state.algo = { ...p };
  $('alpha').value = p.alpha; $('alphaVal').textContent = p.alpha.toFixed(3);
  $('iterations').value = p.iterations; $('itersVal').textContent = String(p.iterations);
  $('pyrLevels').value = p.levels; $('levelsVal').textContent = String(p.levels);
  state.hasFrameA = false;
  if (state.sourceType === 'images' && state.imagesReady) computeImagePair();
}

function markCustomPreset() {
  if (state.preset !== 'custom') {
    state.preset = 'custom';
    $('algoPreset').value = 'custom';
  }
  if (state.sourceType === 'images' && state.imagesReady) computeImagePair();
}

function bindSlider(inputId, labelId, onChange, fmt) {
  const el = $(inputId);
  el.addEventListener('input', () => {
    const v = Number(el.value);
    $(labelId).textContent = fmt(v);
    onChange(v);
  });
}

// ===================== VISUALIZATION =====================

function wireVisualization() {
  document.querySelectorAll('#colorModeSeg .seg').forEach((b) => {
    b.addEventListener('click', () => {
      state.colorMode = b.dataset.mode;
      document.querySelectorAll('#colorModeSeg .seg').forEach((x) => x.classList.toggle('active', x === b));
    });
  });
  document.querySelectorAll('#displayModeSeg .seg').forEach((b) => {
    b.addEventListener('click', () => {
      state.displayMode = b.dataset.mode;
      document.querySelectorAll('#displayModeSeg .seg').forEach((x) => x.classList.toggle('active', x === b));
      $('blendField').hidden = state.displayMode !== 'blend';
    });
  });
  bindSlider('blendAlpha', 'blendAlphaVal', (v) => { state.blendAlpha = v / 100; }, (v) => `${Math.round(v)}%`);
  bindSlider('maxMag', 'maxMagVal', (v) => { state.maxMag = v; }, (v) => v > 0 ? v.toFixed(1) : I18N.t('autoLabel'));
  bindSlider('gamma', 'gammaVal', (v) => { state.gamma = v; }, (v) => v.toFixed(2));

  $('chkArrows').addEventListener('change', (e) => { state.showArrows = e.target.checked; $('arrowField').hidden = !e.target.checked; });
  bindSlider('arrowDensity', 'arrowDensityVal', (v) => { state.arrowDensity = v; }, (v) => String(Math.round(v)));

  $('chkParticles').addEventListener('change', (e) => {
    state.showParticles = e.target.checked;
    $('particleField').hidden = !e.target.checked;
    if (e.target.checked) Overlay.clear(overlayCtx, overlayCanvas.width, overlayCanvas.height);
  });
  bindSlider('particleCount', 'particleCountVal', (v) => { state.particleCount = Math.round(v); particles.setCount(state.particleCount); }, (v) => String(Math.round(v)));
  bindSlider('trailFade', 'trailFadeVal', (v) => { state.trailFade = v; }, (v) => v.toFixed(2));
}

// ===================== CALIBRATION =====================

function wireCalibration() {
  $('chkCalib').addEventListener('change', (e) => {
    state.calib.enabled = e.target.checked;
    $('calibField').hidden = !e.target.checked;
    updateStatUnits();
  });
  $('calibPx').addEventListener('input', (e) => { state.calib.px = Math.max(1, Number(e.target.value) || 1); });
  $('calibDist').addEventListener('input', (e) => { state.calib.dist = Number(e.target.value) || 0; });
  $('calibUnit').addEventListener('change', (e) => { state.calib.unit = e.target.value; updateStatUnits(); });
}

// ===================== EXPORT =====================

function wireExport() {
  $('btnSnapshot').addEventListener('click', exportSnapshot);
  $('btnRecord').addEventListener('click', toggleRecording);
  $('btnExportCsv').addEventListener('click', () => exportGridData('csv'));
  $('btnExportJson').addEventListener('click', () => exportGridData('json'));
  $('btnBatchAnalyze').addEventListener('click', runBatchAnalyze);
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
  const out = document.createElement('canvas');
  out.width = glCanvas.width; out.height = glCanvas.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(glCanvas, 0, 0);
  ctx.drawImage(overlayCanvas, 0, 0);
  out.toBlob((blob) => {
    downloadBlob(blob, `kogakufuro-${Date.now()}.png`);
    toast(I18N.t('toastSaved'));
  }, 'image/png');
}

function toggleRecording() {
  if (state.recording.active) stopRecording();
  else startRecording();
}

function startRecording() {
  if (!state.sourceType) { toast(I18N.t('toastNoSource'), true); return; }
  const composite = document.createElement('canvas');
  composite.width = glCanvas.width; composite.height = glCanvas.height;
  const cctx = composite.getContext('2d');
  const stream = composite.captureStream(0);
  const track = stream.getVideoTracks()[0];
  let mimeType = 'video/webm;codecs=vp9';
  if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mimeType });
    downloadBlob(blob, `kogakufuro-${Date.now()}.webm`);
    toast(I18N.t('toastSaved'));
  };
  recorder.start();
  state.recording = { active: true, recorder, chunks, compositeCanvas: composite, compositeCtx: cctx, track };
  refreshDynamicLabels();
  recordCompositeTick();
}

function recordCompositeTick() {
  if (!state.recording.active) return;
  const { compositeCtx: cctx, compositeCanvas: cc, track } = state.recording;
  if (cc.width !== glCanvas.width || cc.height !== glCanvas.height) {
    cc.width = glCanvas.width; cc.height = glCanvas.height;
  }
  cctx.drawImage(glCanvas, 0, 0);
  cctx.drawImage(overlayCanvas, 0, 0);
  if (track && typeof track.requestFrame === 'function') track.requestFrame();
  requestAnimationFrame(recordCompositeTick);
}

function stopRecording() {
  if (!state.recording.active) return;
  state.recording.recorder.stop();
  VideoSource.stopStream(state.recording.recorder.stream);
  state.recording.active = false;
  refreshDynamicLabels();
}

function exportGridData(kind) {
  if (!state.hasFrameA || !state.sourceType) { toast(I18N.t('toastNoSource'), true); return; }
  const gridW = 40, gridH = Math.max(4, Math.round(gridW * (procCanvas.height / procCanvas.width)));
  const flowTex = flow.compute(state.algo.alpha, state.algo.iterations);
  const grid = viz.readGrid(flowTex, gridW, gridH);
  if (kind === 'csv') {
    let csv = 'x_px,y_px,vx_px_per_frame,vy_px_per_frame,magnitude\n';
    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        const idx = (gy * gridW + gx) * 4;
        const vx = grid[idx], vy = grid[idx + 1];
        const px = (gx / (gridW - 1)) * procCanvas.width;
        const py = (gy / (gridH - 1)) * procCanvas.height;
        csv += `${px.toFixed(1)},${py.toFixed(1)},${vx.toFixed(4)},${vy.toFixed(4)},${Math.hypot(vx, vy).toFixed(4)}\n`;
      }
    }
    downloadBlob(new Blob([csv], { type: 'text/csv' }), `kogakufuro-flow-${Date.now()}.csv`);
  } else {
    const vectors = [];
    for (let gy = 0; gy < gridH; gy++) {
      const row = [];
      for (let gx = 0; gx < gridW; gx++) {
        const idx = (gy * gridW + gx) * 4;
        row.push([Number(grid[idx].toFixed(4)), Number(grid[idx + 1].toFixed(4))]);
      }
      vectors.push(row);
    }
    const payload = {
      generatedAt: new Date().toISOString(),
      processingResolution: [procCanvas.width, procCanvas.height],
      gridSize: [gridW, gridH],
      sourceFps: state.sourceFps,
      algorithm: { name: 'pyramidal-horn-schunck', ...state.algo },
      calibration: state.calib,
      vectors,
    };
    downloadBlob(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `kogakufuro-flow-${Date.now()}.json`);
  }
  toast(I18N.t('toastSaved'));
}

async function runBatchAnalyze() {
  if (state.sourceType !== 'video') { toast(I18N.t('toastNoSource'), true); return; }
  pausePlayback();
  $('batchProgress').hidden = false;
  $('btnBatchAnalyze').disabled = true;
  state.stepTime = 0;
  state.hasFrameA = false;
  const results = await runStepLoop({
    live: false,
    collectStats: true,
    onProgress: (f) => { $('batchProgressBar').style.width = `${Math.round(f * 100)}%`; },
  });
  let csv = 'frame,time_s,avg_magnitude_px,peak_magnitude_px,avg_px_per_s,peak_px_per_s\n';
  for (const r of results) {
    csv += `${r.frame},${r.t.toFixed(4)},${r.avg.toFixed(4)},${r.peak.toFixed(4)},${(r.avg * state.sourceFps).toFixed(3)},${(r.peak * state.sourceFps).toFixed(3)}\n`;
  }
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `kogakufuro-batch-${Date.now()}.csv`);
  $('batchProgress').hidden = true;
  $('btnBatchAnalyze').disabled = false;
  toast(I18N.t('toastBatchDone'));
}

// ===================== KEYBOARD =====================

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowLeft') { stepOnce(-1); }
    else if (e.code === 'ArrowRight') { stepOnce(1); }
    else if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); }
    else if (e.key === 's' || e.key === 'S') { exportSnapshot(); }
    else if (e.key === 'r' || e.key === 'R') { $('chkRoi').checked = !$('chkRoi').checked; $('chkRoi').dispatchEvent(new Event('change')); }
    else if (e.key === 'Escape') { $('helpModal').hidden = true; }
  });
}

document.addEventListener('DOMContentLoaded', init);
