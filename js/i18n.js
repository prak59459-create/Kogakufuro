/*
 * i18n.js — tiny JA/EN dictionary + DOM binder. No frameworks: walk elements
 * carrying data-i18n and set their textContent; app.js also calls I18N.t(key)
 * directly for text it generates dynamically (play/pause toggle, toasts...).
 */
'use strict';

const I18N = (() => {
  const dict = {
    ja: {
      brandSub: '光学フローで動画のFPSを上げる — 端末内完結・最大1000fps対応',
      privacyPill: '100% ローカル処理',
      secInput: '1. 入力ソース',
      tabVideo: '動画ファイル', tabWebcam: 'Webカメラ',
      dropHint: '動画をドラッグ&ドロップ<br>またはクリックして選択',
      webcamStart: 'カメラを起動', webcamStop: 'カメラを停止',
      secPlayback: '2. 再生 / ソースFPS',
      play: '▶ 再生', pause: '⏸ 一時停止', loop: 'ループ',
      sourceFps: 'ソースFPS（元動画の実際のフレームレート）',
      sourceFpsHint: 'この値をもとに「今、実フレームを新しく取得すべきタイミング」を判定し、その間を補間フレームで埋めます。実際のファイルのフレームレートに合わせてください。',
      secInterp: '★ FPSを上げる（フレーム補間）',
      interpHint: 'GPU上で計算した光学フローを使い、実フレームの間に中間フレームを合成して滑らかさ(FPS)を引き上げます。動画の長さ・再生速度はそのままです（スローモーションにはなりません）。',
      targetFps: '目標FPS',
      interpSmooth: 'プレビューもなめらか表示にする',
      interpSmoothHint: '画面上のプレビュー更新頻度はディスプレイのリフレッシュレートが実質的な上限です。書き出しはこの上限の影響を受けません。',
      interpExport: '高FPS動画を書き出す（WebM）',
      interpExportHint: '動画の長さ・速度を変えずに、目標FPS分のフレームを正確なタイムスタンプで書き出します。長い動画・高い目標FPSほど処理に時間がかかります。',
      interpUnsupported: 'この端末/ブラウザはWebCodecs APIに対応していないため、書き出し機能は使用できません（最新のChrome/Edgeでお試しください）。プレビューは引き続き利用できます。',
      secQuality: '3. 補間品質 / 速度',
      qualityHint: '光学フローの計算精度です。精度を上げるほど補間が滑らかで正確になりますが、処理は重くなります。',
      preset: 'プリセット',
      presetTurbo: '爆速(超高速)', presetFast: '高速', presetBalanced: 'バランス',
      presetPrecise: '高精度', presetUltraPrecise: '超高精度', presetCustom: 'カスタム',
      procScale: '処理解像度スケール',
      procScaleHint: '計算だけを縮小し、出力解像度は元映像を保ちます。下げるほど高速化します。',
      alpha: '平滑化の強さ α', iterations: '反復回数', pyrLevels: 'ピラミッド段数',
      secExport: '4. スナップショット',
      exportPng: '現在のフレームをPNG保存',
      statFps: 'フロー計算', statRenderFps: '表示fps', statRes: '出力解像度', statResCompute: '計算',
      emptyTitle: '入力ソースを選択してください',
      emptySub: '動画ファイルまたはWebカメラから開始できます。すべての処理はこの端末内だけで行われます。',
      footerPrivacy: '🔒 すべての処理はこの端末のブラウザ（WebGL2 / WebCodecs）内で完結します。動画・カメラ映像がサーバーへ送信されることは一切ありません。',
      helpTitle: 'ヘルプ / キーボードショートカット',
      kbdSpace: '再生 / 一時停止',
      kbdFullscreen: 'フルスクリーン切替', kbdSnapshot: 'PNGスナップショット保存',
      helpAlgo: '仕組み: 2枚の実フレームの間でGPU上のピラミッド型 Horn–Schunck 密光学フローを計算し、その変位場を使って任意のタイミングの中間フレームを1回のシェーダ描画で合成(モーション補償フレーム補間)します。プレビューはリアルタイムに、書き出しはWebCodecs APIで正確なフレーム間隔のWebM動画として生成します。映像データが端末外に出ることはありません。',
      toastNoSource: '先に入力ソースを選択してください',
      toastWebcamDenied: 'カメラへのアクセスが許可されませんでした',
      toastSaved: '保存しました',
      toastGpuError: 'この端末/ブラウザはWebGL2の高精度テクスチャ(EXT_color_buffer_float)に対応していないため動作できません。',
      toastInterpDone: '高FPS動画の書き出しが完了しました',
      framesWord: 'フレーム',
    },
    en: {
      brandSub: 'Client-side optical-flow FPS boost — 100% on-device, up to 1000fps',
      privacyPill: '100% local processing',
      secInput: '1. Input source',
      tabVideo: 'Video file', tabWebcam: 'Webcam',
      dropHint: 'Drag & drop a video<br>or click to choose one',
      webcamStart: 'Start camera', webcamStop: 'Stop camera',
      secPlayback: '2. Playback / source FPS',
      play: '▶ Play', pause: '⏸ Pause', loop: 'Loop',
      sourceFps: 'Source FPS (true frame rate of the file)',
      sourceFpsHint: 'Used to decide when a genuinely new real frame is due; the time between real frames is filled with interpolated ones. Match this to your file\'s actual frame rate.',
      secInterp: '★ Raise FPS (frame interpolation)',
      interpHint: 'Uses the optical flow computed on the GPU to synthesize in-between frames, raising the smoothness (FPS). Duration and playback speed stay unchanged — this is not slow motion.',
      targetFps: 'Target FPS',
      interpSmooth: 'Also smooth the live preview',
      interpSmoothHint: "The on-screen preview update rate is effectively capped by your display's refresh rate. Export is not affected by this cap.",
      interpExport: 'Export high-FPS video (WebM)',
      interpExportHint: 'Exports the whole video at the target FPS with exact per-frame timestamps, without changing its length or speed. Longer clips and higher target FPS take more time.',
      interpUnsupported: 'This device/browser does not support the WebCodecs API, so export is unavailable (try a recent Chrome/Edge). The live preview still works.',
      secQuality: '3. Interpolation quality / speed',
      qualityHint: 'How precisely the optical flow is computed. Higher precision makes the interpolation smoother and more accurate, at the cost of speed.',
      preset: 'Preset',
      presetTurbo: 'Turbo (ultra-fast)', presetFast: 'Fast', presetBalanced: 'Balanced',
      presetPrecise: 'High precision', presetUltraPrecise: 'Ultra precision', presetCustom: 'Custom',
      procScale: 'Processing resolution scale',
      procScaleHint: 'Only the internal computation shrinks — output stays at the source resolution. Lower = faster.',
      alpha: 'Smoothness α', iterations: 'Iterations', pyrLevels: 'Pyramid levels',
      secExport: '4. Snapshot',
      exportPng: 'Save current frame as PNG',
      statFps: 'Flow compute', statRenderFps: 'Display fps', statRes: 'Output resolution', statResCompute: 'compute',
      emptyTitle: 'Choose an input source to begin',
      emptySub: 'Start from a video file or webcam. Everything runs on this device only.',
      footerPrivacy: '🔒 All processing runs entirely inside this browser (WebGL2 / WebCodecs). Video and camera frames are never sent to any server.',
      helpTitle: 'Help / keyboard shortcuts',
      kbdSpace: 'Play / pause',
      kbdFullscreen: 'Toggle fullscreen', kbdSnapshot: 'Save PNG snapshot',
      helpAlgo: 'How it works: a pyramidal Horn–Schunck dense optical flow is computed on the GPU between two real frames, and its displacement field is used to synthesize an in-between frame at any phase in a single shader pass (motion-compensated frame interpolation). The live preview runs in real time; export uses the WebCodecs API to produce a WebM file with exact, evenly-spaced frame timestamps. No frame data ever leaves this device.',
      toastNoSource: 'Choose an input source first',
      toastWebcamDenied: 'Camera access was denied',
      toastSaved: 'Saved',
      toastGpuError: 'This device/browser does not support WebGL2 high-precision textures (EXT_color_buffer_float) and cannot run this app.',
      toastInterpDone: 'High-FPS video export complete',
      framesWord: 'frames',
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
