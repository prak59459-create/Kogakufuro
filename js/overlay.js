/*
 * overlay.js — everything drawn with the 2D canvas API on top of the WebGL
 * flow-color canvas: vector-grid arrows, an advected particle/streakline
 * field, the magnitude sparkline & histogram mini-charts, and the direction
 * color-wheel legend. Pure CPU/canvas2d, driven by the small vector grid
 * that visualization.js reads back from the GPU each frame.
 */
'use strict';

function sampleFlowGrid(grid, gridW, gridH, u, v) {
  const gx = Math.min(Math.max(u, 0), 1) * (gridW - 1);
  const gy = Math.min(Math.max(v, 0), 1) * (gridH - 1);
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const x1 = Math.min(x0 + 1, gridW - 1), y1 = Math.min(y0 + 1, gridH - 1);
  const fx = gx - x0, fy = gy - y0;
  const i00 = (y0 * gridW + x0) * 4, i10 = (y0 * gridW + x1) * 4;
  const i01 = (y1 * gridW + x0) * 4, i11 = (y1 * gridW + x1) * 4;
  const vx = (grid[i00] * (1 - fx) + grid[i10] * fx) * (1 - fy) + (grid[i01] * (1 - fx) + grid[i11] * fx) * fy;
  const vy = (grid[i00 + 1] * (1 - fx) + grid[i10 + 1] * fx) * (1 - fy) + (grid[i01 + 1] * (1 - fx) + grid[i11 + 1] * fx) * fy;
  return [vx, vy];
}

function hueColor(angle, alpha) {
  const hue = ((angle / (2 * Math.PI) + 0.5) * 360 + 360) % 360;
  return `hsla(${hue.toFixed(1)}, 90%, 62%, ${alpha})`;
}

class ParticleField {
  constructor(count) {
    this.count = count;
    this.pos = new Float32Array(count * 2);
    this.prev = new Float32Array(count * 2);
    this.age = new Float32Array(count);
    this.maxAge = new Float32Array(count);
    for (let i = 0; i < count; i++) this._respawn(i, true);
  }

  _respawn(i, initial) {
    this.pos[i * 2] = Math.random();
    this.pos[i * 2 + 1] = Math.random();
    this.prev[i * 2] = this.pos[i * 2];
    this.prev[i * 2 + 1] = this.pos[i * 2 + 1];
    this.age[i] = initial ? Math.random() * 60 : 0;
    this.maxAge[i] = 40 + Math.random() * 60;
  }

  setCount(count) {
    if (count === this.count) return;
    this.count = count;
    this.pos = new Float32Array(count * 2);
    this.prev = new Float32Array(count * 2);
    this.age = new Float32Array(count);
    this.maxAge = new Float32Array(count);
    for (let i = 0; i < count; i++) this._respawn(i, true);
  }

  step(grid, gridW, gridH, procW, procH, scale) {
    for (let i = 0; i < this.count; i++) {
      const x = this.pos[i * 2], y = this.pos[i * 2 + 1];
      this.prev[i * 2] = x;
      this.prev[i * 2 + 1] = y;
      const [vx, vy] = sampleFlowGrid(grid, gridW, gridH, x, y);
      const dx = (vx / procW) * scale;
      const dy = (vy / procH) * scale;
      let nx = x + dx, ny = y + dy;
      this.age[i]++;
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1 || this.age[i] > this.maxAge[i]) {
        this._respawn(i, false);
      } else {
        this.pos[i * 2] = nx;
        this.pos[i * 2 + 1] = ny;
      }
    }
  }

  draw(ctx, w, h) {
    ctx.lineWidth = 1.4;
    for (let i = 0; i < this.count; i++) {
      const x0 = this.prev[i * 2] * w, y0 = this.prev[i * 2 + 1] * h;
      const x1 = this.pos[i * 2] * w, y1 = this.pos[i * 2 + 1] * h;
      const dx = x1 - x0, dy = y1 - y0;
      const speed = Math.hypot(dx, dy);
      if (speed < 0.01) continue;
      ctx.strokeStyle = hueColor(Math.atan2(dy, dx), Math.min(1, 0.35 + speed * 0.15));
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }
}

const Overlay = {
  fadeTrails(ctx, w, h, amount) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${amount})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  },

  clear(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
  },

  drawArrows(ctx, grid, gridW, gridH, w, h, maxMag, arrowScale) {
    const stepX = w / gridW, stepY = h / gridH;
    ctx.lineWidth = 1.5;
    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        const idx = (gy * gridW + gx) * 4;
        const vx = grid[idx], vy = grid[idx + 1];
        const mag = Math.hypot(vx, vy);
        if (mag < 1e-3) continue;
        const cx = (gx + 0.5) * stepX, cy = (gy + 0.5) * stepY;
        const norm = Math.min(1, mag / Math.max(maxMag, 1e-5));
        const len = Math.min(stepX, stepY) * 0.5 * (0.25 + norm) * arrowScale;
        const ang = Math.atan2(vy, vx);
        const ex = cx + Math.cos(ang) * len, ey = cy + Math.sin(ang) * len;
        ctx.strokeStyle = hueColor(ang, 0.55 + 0.4 * norm);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        const headLen = Math.max(2.5, len * 0.35);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - headLen * Math.cos(ang - 0.5), ey - headLen * Math.sin(ang - 0.5));
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - headLen * Math.cos(ang + 0.5), ey - headLen * Math.sin(ang + 0.5));
        ctx.stroke();
      }
    }
  },

  drawSparkline(ctx, x, y, w, h, data, count, maxVal, color) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    if (count < 2 || maxVal <= 0) { ctx.restore(); return; }
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const v = data[i];
      const px = x + (i / (count - 1)) * w;
      const py = y + h - Math.min(1, v / maxVal) * h;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = color || '#5ee7ff';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  },

  drawHistogram(ctx, x, y, w, h, bins, color) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    const n = bins.length;
    const maxV = Math.max(1e-6, ...bins);
    const bw = w / n;
    ctx.fillStyle = color || 'rgba(94,231,255,0.65)';
    for (let i = 0; i < n; i++) {
      const bh = (bins[i] / maxV) * (h - 2);
      ctx.fillRect(x + i * bw + 1, y + h - bh, Math.max(1, bw - 1), bh);
    }
    ctx.restore();
  },

  drawLegendWheel(ctx, cx, cy, r) {
    const img = ctx.createImageData(r * 2, r * 2);
    for (let py = 0; py < r * 2; py++) {
      for (let px = 0; px < r * 2; px++) {
        const dx = px - r, dy = py - r;
        const d = Math.hypot(dx, dy);
        const idx = (py * r * 2 + px) * 4;
        if (d > r) { img.data[idx + 3] = 0; continue; }
        const ang = Math.atan2(dy, dx);
        const hue = ((ang / (2 * Math.PI) + 0.5) * 360 + 360) % 360;
        const sat = 90, light = 55;
        const [rr, gg, bb] = hslToRgb(hue / 360, sat / 100, light / 100);
        img.data[idx] = rr; img.data[idx + 1] = gg; img.data[idx + 2] = bb;
        img.data[idx + 3] = Math.round(255 * Math.min(1, d / r + 0.15));
      }
    }
    ctx.putImageData(img, cx - r, cy - r);
  },
};

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
