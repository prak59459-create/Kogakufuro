/*
 * video-source.js — loading/utility helpers for the three input kinds the
 * app supports: a video file, a webcam stream, or a still-image pair.
 * Keeps browser-API quirks (metadata loading, seek events, drag & drop) out
 * of app.js so the main controller can stay about *orchestration*.
 */
'use strict';

const VideoSource = {
  /** Load a local video file into a hidden <video> element. Resolves once metadata is known. */
  loadVideoFile(file) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      video.preload = 'auto';
      const url = URL.createObjectURL(file);
      video.src = url;
      video.addEventListener('loadedmetadata', () => resolve({ video, url, name: file.name }), { once: true });
      video.addEventListener('error', () => reject(new Error('動画の読み込みに失敗しました / Failed to load video')), { once: true });
    });
  },

  /** Start a webcam capture into a hidden <video> element. */
  async startWebcam(constraints) {
    const stream = await navigator.mediaDevices.getUserMedia(constraints || {
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await new Promise((resolve) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
    });
    await video.play();
    return { video, stream };
  },

  /** Load a still image file into an HTMLImageElement. */
  loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => resolve({ img, url, name: file.name });
      img.onerror = () => reject(new Error('画像の読み込みに失敗しました / Failed to load image'));
      img.src = url;
    });
  },

  supportsRVFC(video) {
    return typeof video.requestVideoFrameCallback === 'function';
  },

  /** Seek a video to an exact time and resolve once the frame is actually decoded. */
  seekTo(video, time) {
    return new Promise((resolve) => {
      const clamped = Math.min(Math.max(time, 0), Math.max(video.duration - 1e-3, 0));
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(video.currentTime); } };
      video.addEventListener('seeked', done, { once: true });
      // Safety net: some browsers can miss 'seeked' for micro-seeks near duplicate frames.
      setTimeout(done, 250);
      video.currentTime = clamped;
    });
  },

  attachDropZone(el, onFiles) {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((evt) => el.addEventListener(evt, stop));
    el.addEventListener('dragenter', () => el.classList.add('drop-active'));
    el.addEventListener('dragleave', (e) => {
      if (e.target === el) el.classList.remove('drop-active');
    });
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-active');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        onFiles(e.dataTransfer.files);
      }
    });
  },

  stopStream(stream) {
    if (!stream) return;
    stream.getTracks().forEach((t) => t.stop());
  },
};
