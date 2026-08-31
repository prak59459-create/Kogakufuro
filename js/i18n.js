/*
 * i18n.js — tiny JA/EN dictionary + DOM binder. No frameworks: walk elements
 * carrying data-i18n and set their textContent; app.js also calls I18N.t(key)
 * directly for text it generates dynamically (play/pause toggle, toasts...).
 */
'use strict';

const I18N = (() => {
  const dict = {
    ja: {
      brandSub: '光学フロー解析 — 端末内完結・最大1000fps対応',
      privacyPill: '100% ローカル処理',
      secInput: '1. 入力ソース',
      tabVideo: '動画ファイル', tabWebcam: 'Webカメラ', tabImages: '静止画2枚',
      dropHint: '動画をドラッグ&ドロップ<br>またはクリックして選択',
      videoHint: '高速度カメラで撮影した動画(240/480/1000fps等)も読み込めます。実際のfpsは下の「ソースfps」で指定してください。',
      webcamStart: 'カメラを起動', webcamStop: 'カメラを停止',
      imageA: '画像 A（前）', imageB: '画像 B（後）', swapImages: 'A / B を入れ替え',
      secPlayback: '2. 再生 / フレームレート',
      play: '▶ 再生', pause: '⏸ 一時停止', loop: 'ループ',
      procMode: '解析モード', modeRealtime: 'リアルタイム', modeStep: 'ステップ解析（〜1000fps）',
      sourceFps: 'ソースfps（撮影時の実際のフレームレート）',
      sourceFpsHint: '正確な移動速度（px/s・実距離/s）の算出に使用します。ステップ解析モードでは、この値の間隔で動画を厳密にコマ送りして1フレームずつ解析します。',
      secRoi: '3. 解析範囲 / 解像度',
      roiEnable: 'ROI（解析範囲）を指定する — キャンバス上をドラッグ', roiReset: 'ROIをリセット',
      procScale: '処理解像度スケール', procScaleHint: '計算だけを縮小し、表示・書き出しは元映像に近い解像度を保ちます。下げるほど高速化(1000fps級のステップ解析にはスケールを下げるのがおすすめ)',
      secAlgo: '4. アルゴリズム（Pyramidal Horn–Schunck）',
      preset: 'プリセット',
      presetTurbo: '爆速(超高速)', presetBalanced: 'バランス', presetFast: '高速',
      presetPrecise: '高精度', presetUltraPrecise: '超高精度',
      presetFluid: '流体・煙', presetSports: 'スポーツ / スローモーション', presetCustom: 'カスタム',
      alpha: '平滑化の強さ α', iterations: '反復回数', pyrLevels: 'ピラミッド段数',
      secViz: '5. 可視化',
      colorMode: 'カラーモード', modeWheel: '方向ホイール', modeHeatmap: '速さヒートマップ', modeSource: '元映像',
      displayMode: '表示レイアウト', displayFlow: 'フローのみ', displaySplit: '分割表示', displayBlend: '重ね合わせ',
      blendAlpha: '重ね合わせ不透明度', maxMag: '色スケール最大値', gamma: 'ガンマ',
      showArrows: '矢印グリッドを表示', arrowDensity: '密度',
      showParticles: '流線パーティクルを表示', particleCount: '粒子数', trailFade: 'トレイルの残り方',
      secCalib: '6. 実寸キャリブレーション', calibEnable: '実距離換算を有効化',
      calibPx: '基準ピクセル数', calibDist: '実距離',
      secExport: '7. エクスポート',
      exportPng: '現在のフレームをPNG保存',
      exportRecStart: '録画開始（WebM）', exportRecStop: '⏹ 録画停止',
      exportCsv: 'フローデータをCSV書き出し', exportJson: 'フローデータをJSON書き出し',
      batchAnalyze: '全フレーム一括解析（統計CSV）',
      statFps: '処理速度', statAvg: '平均速さ', statPeak: '最大速さ', statRes: '出力解像度', statResCompute: '計算',
      emptyTitle: '入力ソースを選択してください',
      emptySub: '動画ファイル・Webカメラ・静止画2枚のいずれかから開始できます。すべての処理はこの端末内だけで行われます。',
      chartHistory: '速さの時間変化', chartHist: '速さの分布',
      footerPrivacy: '🔒 すべての解析処理はこの端末のブラウザ（WebGL2）内で完結します。動画・画像・カメラ映像がサーバーへ送信されることは一切ありません。',
      helpTitle: 'ヘルプ / キーボードショートカット',
      kbdSpace: '再生 / 一時停止', kbdStep: '1フレーム戻る / 進む',
      kbdFullscreen: 'フルスクリーン切替', kbdSnapshot: 'PNGスナップショット保存', kbdRoi: 'ROI選択のON/OFF',
      helpAlgo: 'アルゴリズム: ピラミッド型 Horn–Schunck 密光学フロー。フレームをGPU上でグレースケール化 → 複数解像度のピラミッドを構築 → 最も粗い階層から反復的にエネルギー最小化(ヤコビ法)で解を求め、順に高解像度へアップサンプリングしながら精緻化します。全計算はWebGL2のフラグメントシェーダ上で実行され、映像データが端末外に出ることはありません。',
      toastNoSource: '先に入力ソースを選択してください',
      toastWebcamDenied: 'カメラへのアクセスが許可されませんでした',
      toastRoiOn: 'ROI選択モード: キャンバス上をドラッグして範囲を指定',
      toastSaved: '保存しました',
      toastBatchDone: '一括解析が完了しました',
      toastGpuError: 'この端末/ブラウザはWebGL2の高精度テクスチャ(EXT_color_buffer_float)に対応していないため動作できません。',
      toastImagesNeedBoth: '画像A・画像Bの両方を選択してください',
      autoLabel: '自動',
    },
    en: {
      brandSub: 'Client-side optical flow — 100% on-device, up to 1000fps',
      privacyPill: '100% local processing',
      secInput: '1. Input source',
      tabVideo: 'Video file', tabWebcam: 'Webcam', tabImages: '2 still images',
      dropHint: 'Drag & drop a video<br>or click to choose one',
      videoHint: 'High-speed camera footage (240/480/1000fps...) is supported. Set the real capture rate below in "Source FPS".',
      webcamStart: 'Start camera', webcamStop: 'Stop camera',
      imageA: 'Image A (before)', imageB: 'Image B (after)', swapImages: 'Swap A / B',
      secPlayback: '2. Playback / frame rate',
      play: '▶ Play', pause: '⏸ Pause', loop: 'Loop',
      procMode: 'Processing mode', modeRealtime: 'Real-time', modeStep: 'Step analysis (up to 1000fps)',
      sourceFps: 'Source FPS (true capture rate)',
      sourceFpsHint: 'Used to compute real-world speed (px/s, distance/s). In step-analysis mode the video is stepped frame-accurately at this interval.',
      secRoi: '3. Region of interest / resolution',
      roiEnable: 'Enable ROI — drag on the canvas', roiReset: 'Reset ROI',
      procScale: 'Processing resolution scale', procScaleHint: 'Only the internal computation shrinks — display and export stay close to source resolution. Lower = faster (recommended for 1000fps-class step analysis)',
      secAlgo: '4. Algorithm (Pyramidal Horn–Schunck)',
      preset: 'Preset',
      presetTurbo: 'Turbo (ultra-fast)', presetBalanced: 'Balanced', presetFast: 'Fast',
      presetPrecise: 'High precision', presetUltraPrecise: 'Ultra precision',
      presetFluid: 'Fluid / smoke', presetSports: 'Sports / slow-mo', presetCustom: 'Custom',
      alpha: 'Smoothness α', iterations: 'Iterations', pyrLevels: 'Pyramid levels',
      secViz: '5. Visualization',
      colorMode: 'Color mode', modeWheel: 'Direction wheel', modeHeatmap: 'Speed heatmap', modeSource: 'Source video',
      displayMode: 'Display layout', displayFlow: 'Flow only', displaySplit: 'Split view', displayBlend: 'Blend overlay',
      blendAlpha: 'Blend opacity', maxMag: 'Color scale max', gamma: 'Gamma',
      showArrows: 'Show arrow grid', arrowDensity: 'Density',
      showParticles: 'Show streak particles', particleCount: 'Particle count', trailFade: 'Trail persistence',
      secCalib: '6. Real-world calibration', calibEnable: 'Enable real-distance conversion',
      calibPx: 'Reference pixel count', calibDist: 'Real distance',
      secExport: '7. Export',
      exportPng: 'Save current frame as PNG',
      exportRecStart: 'Start recording (WebM)', exportRecStop: '⏹ Stop recording',
      exportCsv: 'Export flow field as CSV', exportJson: 'Export flow field as JSON',
      batchAnalyze: 'Batch-analyze all frames (stats CSV)',
      statFps: 'Throughput', statAvg: 'Avg speed', statPeak: 'Peak speed', statRes: 'Output resolution', statResCompute: 'compute',
      emptyTitle: 'Choose an input source to begin',
      emptySub: 'Start from a video file, webcam, or a pair of still images. Everything runs on this device only.',
      chartHistory: 'Speed over time', chartHist: 'Speed distribution',
      footerPrivacy: '🔒 All analysis runs entirely inside this browser (WebGL2). Video, images and camera frames are never sent to any server.',
      helpTitle: 'Help / keyboard shortcuts',
      kbdSpace: 'Play / pause', kbdStep: 'Step one frame back / forward',
      kbdFullscreen: 'Toggle fullscreen', kbdSnapshot: 'Save PNG snapshot', kbdRoi: 'Toggle ROI selection',
      helpAlgo: 'Algorithm: pyramidal Horn–Schunck dense optical flow. Frames are converted to grayscale on the GPU, a multi-resolution pyramid is built, and the energy-minimization system is solved iteratively (Jacobi relaxation) from the coarsest level up, upsampling the flow field as the initial guess at each finer level. Everything runs in WebGL2 fragment shaders — no frame data ever leaves this device.',
      toastNoSource: 'Choose an input source first',
      toastWebcamDenied: 'Camera access was denied',
      toastRoiOn: 'ROI selection: drag on the canvas to set the region',
      toastSaved: 'Saved',
      toastBatchDone: 'Batch analysis complete',
      toastGpuError: 'This device/browser does not support WebGL2 high-precision textures (EXT_color_buffer_float) and cannot run this app.',
      toastImagesNeedBoth: 'Please choose both image A and image B',
      autoLabel: 'Auto',
    },
  };

  let lang = 'ja';

  function t(key) {
    const table = dict[lang] || dict.ja;
    return (table && table[key] !== undefined) ? table[key] : (dict.ja[key] || key);
  }

  function apply() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      el.innerHTML = t(key);
    });
  }

  function setLang(l) {
    lang = (l === 'en') ? 'en' : 'ja';
    apply();
  }

  function getLang() { return lang; }

  function toggle() {
    setLang(lang === 'ja' ? 'en' : 'ja');
    return lang;
  }

  return { t, apply, setLang, getLang, toggle };
})();
