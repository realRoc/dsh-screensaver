// 魔法书斋：场景本体（从 desk-pet 的 demos/magic-tower 搬过来）。
// 书房（待机）：塔顶书房里骑士在月光下读书；有会话在跑：镜头扎进书页、穿过符文漩涡进塔，骑士沿书阶上行；
// 全部结束：一本书飞到镜头前打开，回到书房。
// 骑士精灵来自 Blender 管线（desk-pet 仓库 demos/magic-tower/pipeline/），这里只用打好的 index/normal 精灵表。
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { buildStudy } from './study.js';
import { compileScore, FX_NAMES, makeCursor, normPitch, sectionAt, SWORD_TURN } from './score.js';
import KN_META from '../assets/knight.json';
import walkIndex from '../assets/knight_walk_index.png';
import walkNormal from '../assets/knight_walk_normal.png';
import sitIndex from '../assets/knight_sit_index.png';
import sitNormal from '../assets/knight_sit_normal.png';
import sitDepth from '../assets/knight_sit_depth.png';
import deskGlb from '../assets/desk_corner.glb';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeVertices, mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/* ============================================================
 * 尺寸。静态几何按「一圈」周期排布，镜头每爬一圈整座塔挪一圈 → 无尽的塔。
 * 塔顶不是几何终点：用一个跟着镜头走的裁剪平面把墙切开，切口藏在尖塔冠下面，
 * 所以抬头永远能看到开口外的星云夜空。
 * 纹理密度 32 像素 / 1 单位。
 * ============================================================ */
const SPT = 32;
const ROW_H = 1.25;
const TURN_H = ROW_H * 8;
const RISE = TURN_H / SPT;
const DTH = Math.PI * 2 / SPT;
const K_MIN = -96, K_MAX = 256;
const Y_MIN = -30, Y_MAX = 82.5;

const R_WALL_BOOK = 9.0, R_WALL_PLANK = 8.55;
const R_STAIR_IN = 4.8, R_STAIR_OUT = 8.5;     // 台阶收窄，天井放大到半径 4.8
const R_RAIL = R_STAIR_IN + 0.14;
const CARPET_IN = 5.9, CARPET_OUT = 7.7;
const R_WALK = (CARPET_IN + CARPET_OUT) / 2;
const TOP_OFF = 34;                             // 塔顶开口在镜头上方多高

const SPEED = 1.3;
const FOG_D = 0.02;
const FOG_COLOR = 0x183048;

const polar = (r, th, y) => new THREE.Vector3(r * Math.cos(th), y, r * Math.sin(th));
const railY = (s) => s * RISE + 0.5 * RISE + 1.0;
const wrap = (v, base, span) => ((((v - base) % span) + span) % span) + base;
const rand = (a, b) => a + Math.random() * (b - a);

/* ---------------- 小工具 ---------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 塔按一圈周期排布、每圈挪一次：同一样东西在每一圈的那一份要拿到同一个随机数（按它在一圈里的位置算），
// 不然塔挪回去的那一帧，闪烁的相位、亮度会整体跳一下（scripts/seam.mjs 查出来的）
function turnRand(p, j = 0) {
  const span = Math.round(TURN_H * 64), y = ((Math.round(p.y * 64) % span) + span) % span;
  let h = Math.imul(Math.round(p.x * 64), 0x85ebca6b) ^ Math.imul(Math.round(p.z * 64), 0xc2b2ae35) ^ Math.imul(y, 0x27d4eb2f) ^ Math.imul(j + 1, 0x165667b1);
  return mulberry32(h)();
}
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
// 带色相偏移的明暗：暗部往蓝紫偏、亮部往暖黄偏
const SHADOW_TINT = [46, 36, 96], LIGHT_TINT = [255, 238, 196];
function shade(h, f) {
  const src = hexToRgb(h);
  let out;
  if (f < 1) {
    const a = Math.min(1, (1 - f) * 0.55), k = 0.4 + f * 0.6;
    out = src.map((v, i) => v * f * (1 - a) + SHADOW_TINT[i] * a * k);
  } else {
    const a = Math.min(1, (f - 1) * 0.6);
    out = src.map((v, i) => v * (1 - a) + LIGHT_TINT[i] * a);
  }
  const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${c(out[0])},${c(out[1])},${c(out[2])})`;
}
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  return { c, g };
}
let maxAniso = 1;
function pixelTex(canvas, repeatX = 1, repeatY = 1) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = maxAniso;
  return t;
}
function spriteTex(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}
// 选择性描边（selout）：描边取相邻像素的颜色压暗、往紫偏，而不是一刀切的纯黑
function selout(g, W, H) {
  const img = g.getImageData(0, 0, W, H), d = img.data, out = new Uint8ClampedArray(d);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (d[i + 3] > 0) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = (ny * W + nx) * 4;
      if (d[j + 3] < 128) continue;
      out[i] = d[j] * 0.28 + 16 * 0.72; out[i + 1] = d[j + 1] * 0.28 + 12 * 0.72; out[i + 2] = d[j + 2] * 0.28 + 34 * 0.72; out[i + 3] = 255;
      break;
    }
  }
  g.putImageData(new ImageData(out, W, H), 0, 0);
}
function makeSoftCanvas(inner, outer, S = 64) {
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, inner); grd.addColorStop(1, outer);
  g.fillStyle = grd; g.fillRect(0, 0, S, S);
  return c;
}

/* ============================================================
 * 像素画纹理
 * ============================================================ */
const BOOK_COLORS = ['#8a2a36', '#a2442f', '#33597c', '#2a6070', '#46703a', '#664487', '#9a7a30',
  '#7a5432', '#344070', '#8d6a45', '#5a3048', '#a88a58', '#3d6e64', '#7c3354', '#b05c34', '#4a5a96',
  '#c2a46a', '#2f4f46'];
const GLOWS = ['#6dffae', '#ff78dc', '#78e4ff', '#ffe078', '#c3a0ff'];
const GOLD = '#d9b25c', GOLD_HI = '#f6dc8e', GOLD_SH = '#9c7a34';

function drawBook(g, ge, rnd, x, base, w, h, hex) {
  const top = base - h;
  for (let i = 0; i < w; i++) {
    const t = (i + 0.5) / w;
    let f = 0.58 + 0.62 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.18)), 0.8);
    if (i === 0) f *= 0.78;
    if (i === w - 1) f *= 0.5;
    g.fillStyle = shade(hex, f); g.fillRect(x + i, top, 1, h);
  }
  g.fillStyle = shade(hex, 1.3); g.fillRect(x + 1, top, Math.max(1, w - 2), 1);
  g.fillStyle = shade(hex, 0.45); g.fillRect(x, base - 1, w, 1);
  const style = rnd();
  if (style < 0.45 && w >= 4) {
    const n = 2 + Math.floor(rnd() * 3);
    for (let b = 0; b < n; b++) {
      const y = top + 3 + Math.floor((b + 0.5) * (h - 6) / n);
      g.fillStyle = shade(hex, 0.45); g.fillRect(x, y, w, 1);
      g.fillStyle = shade(hex, 1.35); g.fillRect(x + 1, y - 1, w - 2, 1);
    }
  } else if (style < 0.8) {
    for (const y of [top + 3, base - 5]) {
      g.fillStyle = GOLD_SH; g.fillRect(x, y + 1, w, 1);
      g.fillStyle = GOLD; g.fillRect(x, y, w, 1);
      if (w >= 3) { g.fillStyle = GOLD_HI; g.fillRect(x + 1, y, Math.max(1, Math.floor(w / 2)), 1); }
    }
    if (w >= 7) {
      const cx = x + Math.floor(w / 2), cy = top + Math.floor(h * 0.5);
      g.fillStyle = GOLD;
      g.fillRect(cx, cy - 2, 1, 5); g.fillRect(cx - 1, cy - 1, 3, 3); g.fillRect(cx - 2, cy, 5, 1);
      g.fillStyle = GOLD_HI; g.fillRect(cx, cy - 1, 1, 1);
    }
  }
  if (w >= 5 && rnd() < 0.5) {
    const ly = top + 4 + Math.floor(h * 0.12), lh = 5 + Math.floor(rnd() * 4);
    g.fillStyle = '#5c4a32'; g.fillRect(x + 1, ly - 1, w - 2, lh + 2);
    g.fillStyle = '#ecdcb2'; g.fillRect(x + 1, ly, w - 2, lh);
    g.fillStyle = '#6a5438';
    for (let yy = ly + 1; yy < ly + lh - 1; yy += 2) g.fillRect(x + 2, yy, Math.max(1, Math.floor((w - 4) * (0.4 + rnd() * 0.6))), 1);
  }
  if (rnd() < 0.12) { g.fillStyle = rnd() < 0.5 ? '#c8323c' : '#3c6ac8'; g.fillRect(x + Math.floor(w / 2), base, 1, 3); }
  if (rnd() < 0.05) {
    const rc = ['#8ff0ff', '#d0a8ff', '#a0ffc8'][Math.floor(rnd() * 3)];
    const ry = top + 4 + Math.floor(rnd() * Math.max(1, h - 10)), rx = x + Math.floor(w / 2);
    for (const [dx, dy] of [[0, 0], [0, 1], [0, 2], [-1, 1], [1, 1]]) {
      g.fillStyle = rc; g.fillRect(rx + dx, ry + dy, 1, 1);
      ge.fillStyle = rc; ge.fillRect(rx + dx, ry + dy, 1, 1);
    }
  }
}
function drawLeaningBook(g, x, base, w, h, hex) {
  for (let r = 0; r < h; r++) {
    const off = Math.floor(r / 5), y = base - 1 - r;
    for (let i = 0; i < w; i++) {
      let f = 0.6 + 0.55 * Math.sin(Math.PI * (i + 0.5) / w);
      if (i === w - 1) f *= 0.55;
      if (r === h - 1) f *= 1.25;
      g.fillStyle = shade(hex, f); g.fillRect(x + i + off, y, 1, 1);
    }
  }
}
function makeShelfTextures(W, seed) {
  const ROWH = 40, ROWS = 4, H = ROWH * ROWS;
  const { c: col, g } = makeCanvas(W, H);
  const { c: emi, g: ge } = makeCanvas(W, H);
  ge.fillStyle = '#000'; ge.fillRect(0, 0, W, H);
  const rnd = mulberry32(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  for (let row = 0; row < ROWS; row++) {
    const top = row * ROWH, base = top + ROWH - 4;
    for (let x = 0; x < W; x++) {
      const seam = x % 26 === 0, f = seam ? 0.6 : 0.9 + 0.12 * Math.sin(x * 0.7);
      g.fillStyle = shade('#33261c', f); g.fillRect(x, top, 1, ROWH);
    }
    for (let y = 0; y < 10; y++) { g.fillStyle = `rgba(6,6,14,${0.75 * (1 - y / 10)})`; g.fillRect(0, top + y, W, 1); }
    g.fillStyle = '#6e4628'; g.fillRect(0, base, W, 4);
    g.fillStyle = '#a06c3c'; g.fillRect(0, base, W, 1);
    g.fillStyle = '#4a2e18'; g.fillRect(0, base + 3, W, 1);
    let x = 0;
    while (x < W) {
      const roll = rnd(), room = W - x;
      if (roll < 0.035) { x += 2 + Math.floor(rnd() * 5); continue; }
      if (roll < 0.06 && room > 12) {
        const w = 5 + Math.floor(rnd() * 3), h = 22 + Math.floor(rnd() * 8);
        drawLeaningBook(g, x, base, w, h, pick(BOOK_COLORS));
        x += w + Math.floor(h / 5) + 1; continue;
      }
      if (roll < 0.11 && room > 24) {
        const n = 3 + Math.floor(rnd() * 3), sw = 16 + Math.floor(rnd() * 6);
        let y = base;
        for (let i = 0; i < n; i++) {
          const w = sw - Math.floor(rnd() * 5), ox = x + Math.floor(rnd() * 3), th = 3 + Math.floor(rnd() * 2), c0 = pick(BOOK_COLORS);
          g.fillStyle = shade(c0, 1); g.fillRect(ox, y - th, w, th);
          g.fillStyle = shade(c0, 1.35); g.fillRect(ox, y - th, w, 1);
          g.fillStyle = shade(c0, 0.5); g.fillRect(ox, y - 1, w, 1);
          g.fillStyle = '#e9dcbc'; g.fillRect(ox + w - 2, y - th + 1, 2, th - 2);
          if (rnd() < 0.5) { g.fillStyle = GOLD; g.fillRect(ox + 2, y - th + 1, w - 6, 1); }
          y -= th;
        }
        if (rnd() < 0.5) {
          g.fillStyle = '#efe2c4'; g.fillRect(x + 6, y - 5, 3, 5);
          g.fillStyle = '#ffd36a'; g.fillRect(x + 7, y - 7, 1, 2);
          ge.fillStyle = '#ffb040'; ge.fillRect(x + 7, y - 8, 1, 3);
        }
        x += sw + 4; continue;
      }
      if (roll < 0.15 && room > 12) {
        const pc = pick(GLOWS), bx = x + 2, cy = base - 5;
        for (let yy = -4; yy <= 4; yy++) for (let xx = -4; xx <= 4; xx++) {
          if (xx * xx + yy * yy > 18) continue;
          const lv = yy >= -1;
          g.fillStyle = lv ? shade(pc, 0.75 + 0.1 * (xx < 0)) : 'rgba(200,220,240,0.45)'; g.fillRect(bx + 4 + xx, cy + yy, 1, 1);
          if (lv) { ge.fillStyle = shade(pc, 0.9); ge.fillRect(bx + 4 + xx, cy + yy, 1, 1); }
        }
        g.fillStyle = '#ffffff'; g.fillRect(bx + 2, cy - 2, 1, 2);
        g.fillStyle = '#c6d6ea'; g.fillRect(bx + 3, cy - 8, 3, 4);
        g.fillStyle = '#8a5a32'; g.fillRect(bx + 3, cy - 10, 3, 2);
        x += 12; continue;
      }
      if (roll < 0.175 && room > 14) {
        const bx = x + 2, cy = base - 8;
        g.fillStyle = GOLD_SH; g.fillRect(bx + 1, base - 3, 9, 3);
        g.fillStyle = GOLD; g.fillRect(bx + 2, base - 3, 7, 1);
        for (let yy = -5; yy <= 5; yy++) for (let xx = -5; xx <= 5; xx++) {
          const d = xx * xx + yy * yy; if (d > 26) continue;
          const c = d < 8 ? '#d8fbff' : d < 18 ? '#86e6ff' : '#4aa8d8';
          g.fillStyle = c; g.fillRect(bx + 5 + xx, cy + yy, 1, 1);
          ge.fillStyle = c; ge.fillRect(bx + 5 + xx, cy + yy, 1, 1);
        }
        g.fillStyle = '#ffffff'; g.fillRect(bx + 3, cy - 3, 2, 1);
        x += 14; continue;
      }
      if (roll < 0.19 && room > 10) {
        const bx = x + 1;
        g.fillStyle = GOLD; g.fillRect(bx, base - 16, 8, 2); g.fillRect(bx, base - 2, 8, 2);
        g.fillStyle = GOLD_SH; g.fillRect(bx, base - 14, 1, 12); g.fillRect(bx + 7, base - 14, 1, 12);
        for (let yy = 0; yy < 12; yy++) {
          const hw = Math.max(1, Math.abs(6 - yy) * 0.5) | 0;
          g.fillStyle = 'rgba(210,230,255,0.5)'; g.fillRect(bx + 4 - hw, base - 14 + yy, hw * 2, 1);
        }
        g.fillStyle = '#f0c870'; g.fillRect(bx + 3, base - 6, 2, 3); g.fillRect(bx + 2, base - 4, 4, 2); g.fillRect(bx + 3, base - 12, 2, 2);
        x += 10; continue;
      }
      if (roll < 0.21 && room > 16) {
        for (const [ox, oy] of [[0, 0], [6, 0], [3, -5], [9, -5], [6, -10]]) {
          const cx = x + 3 + ox, cy = base - 3 + oy;
          for (let yy = -2; yy <= 2; yy++) for (let xx = -2; xx <= 2; xx++) {
            if (xx * xx + yy * yy > 5) continue;
            g.fillStyle = (xx * xx + yy * yy) <= 1 ? '#8c6a44' : '#eadbb4'; g.fillRect(cx + xx, cy + yy, 1, 1);
          }
        }
        x += 16; continue;
      }
      const big = rnd() < 0.15;
      const w = big ? 8 + Math.floor(rnd() * 5) : 4 + Math.floor(rnd() * 4);
      const h = big ? 28 + Math.floor(rnd() * 5) : 18 + Math.floor(rnd() * 12);
      drawBook(g, ge, rnd, x, base, w, h, pick(BOOK_COLORS));
      x += w;
    }
  }
  return { map: col, emissive: emi };
}

// 石头：按「石块」成簇着色 + 倒角，不再是逐像素噪点
function makeStoneCanvas() {
  const S = 64, { c, g } = makeCanvas(S, S), rnd = mulberry32(11);
  const RAMP = ['#2a2c3e', '#3e4258', '#555b74', '#6c738c', '#878ea6', '#a6adc2'];
  for (let r = 0; r < 4; r++) {
    const off = r % 2 ? 16 : 0;
    for (let b = -1; b < 2; b++) {
      const x0 = b * 32 + off, tone = 2 + Math.floor(rnd() * 2);
      const spots = Array.from({ length: 3 }, () => [Math.floor(rnd() * 28) + 2, Math.floor(rnd() * 12) + 2, 2 + rnd() * 3]);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) {
        const px = x0 + x, py = r * 16 + y;
        if (px < 0 || px >= S) continue;
        let k = tone;
        for (const [sx, sy, sr] of spots) if ((x - sx) ** 2 + (y - sy) ** 2 < sr * sr) k = tone - 1;
        if (y === 1 || x === 1) k = Math.min(5, tone + 2);
        else if (y === 2 || x === 2) k = Math.min(5, tone + 1);
        if (y === 14 || x === 30) k = Math.max(0, tone - 1);
        if (y === 0 || x === 0 || y === 15 || x === 31) k = 0;
        g.fillStyle = RAMP[k]; g.fillRect(px, py, 1, 1);
      }
    }
  }
  return c;
}
function makeCarpetCanvas() {
  const W = 64, H = 64, { c, g } = makeCanvas(W, H);
  g.fillStyle = '#1c2c5c'; g.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y++) for (let x = 10; x < W - 10; x++) {
    const dx = Math.abs(((x - 10) % 22) - 11), dy = Math.abs((y % 22) - 11), m = dx + dy;
    let col = null;
    if (m === 9) col = '#2c4686';
    else if (m === 6) col = '#d9a650';
    else if (m <= 2) col = m === 0 ? '#f2d38a' : '#5aa8e0';
    else if (m === 4 && (x + y) % 2) col = '#121c40';
    if (col) { g.fillStyle = col; g.fillRect(x, y, 1, 1); }
  }
  for (const side of [0, 1]) {
    const X = (x) => side ? W - 1 - x : x;
    const strip = [['#b8873a', 0], ['#f0cc72', 1], ['#b8873a', 2], ['#0e1430', 3], ['#3a5aa0', 4], ['#3a5aa0', 5], ['#0e1430', 6], ['#b8873a', 7], ['#e2bb63', 8], ['#101838', 9]];
    for (const [cc, x] of strip) { g.fillStyle = cc; g.fillRect(X(x), 0, 1, H); }
    for (let y = 0; y < H; y += 4) { g.fillStyle = '#f0cc72'; g.fillRect(X(4 + (y / 4) % 2), y, 1, 2); }
  }
  return c;
}
// 哥特尖拱拱廊（镂空，透出后面的书架）
function makeArcadeCanvas() {
  const W = 84, H = 80, { c, g } = makeCanvas(W, H);
  const ST = ['#1e2232', '#30364c', '#474f68', '#626c88', '#828ca8', '#aab3cc'];
  const cxA = 42, spring = 46, half = 22, R = 44;
  const open = (x, y) => {
    if (x < cxA - half || x > cxA + half || y >= H - 6) return false;
    if (y >= spring) return true;
    return Math.hypot(x - (cxA - half), y - spring) <= R && Math.hypot(x - (cxA + half), y - spring) <= R;
  };
  const tracery = (x, y) => {
    if ((x === 41 || x === 42) && y >= 30) return true;                       // 中梃
    const d = Math.hypot(x + 0.5 - 42, y + 0.5 - 22);
    if (d >= 5 && d <= 6.6) return true;                                     // 圆窗
    for (const sx of [31, 53]) {                                              // 两个小尖拱
      if (y >= 30 && y <= 44 && (Math.abs(Math.hypot(x - (sx - 9), y - 44) - 18) < 0.9 || Math.abs(Math.hypot(x - (sx + 9), y - 44) - 18) < 0.9) && Math.abs(x - sx) < 10) return true;
    }
    return false;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (open(x, y)) {
      if (tracery(x, y)) { g.fillStyle = (x === 42 || x > 44) ? ST[4] : ST[3]; g.fillRect(x, y, 1, 1); }
      continue;
    }
    let near = 9;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (open(x + dx, y + dy)) near = Math.min(near, Math.max(Math.abs(dx), Math.abs(dy)));
    let k = 2 + ((Math.floor(y / 10) + Math.floor((x + (Math.floor(y / 10) % 2) * 7) / 14)) % 2);
    if (y % 10 === 0 || (x + (Math.floor(y / 10) % 2) * 7) % 14 === 0) k = 1;
    if (near === 1) k = 5; else if (near === 2) k = 4; else if (near === 3) k = 1;
    if (y >= H - 6) k = y === H - 6 ? 5 : y === H - 1 ? 0 : 3;
    if (y < 3) k = y === 2 ? 4 : 1;
    g.fillStyle = ST[k]; g.fillRect(x, y, 1, 1);
  }
  return c;
}
function makeCoverCanvas() {
  const W = 32, H = 44, { c, g } = makeCanvas(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
    const f = edge === 0 ? 0.55 : edge === 1 ? 0.8 : 0.95 + ((x * 7 + y * 13) % 5) * 0.012;
    g.fillStyle = shade('#e8e0d0', f); g.fillRect(x, y, 1, 1);
  }
  g.fillStyle = '#fff3c0';
  g.fillRect(3, 3, W - 6, 1); g.fillRect(3, H - 4, W - 6, 1); g.fillRect(3, 3, 1, H - 6); g.fillRect(W - 4, 3, 1, H - 6);
  for (let yy = -7; yy <= 7; yy++) for (let xx = -7; xx <= 7; xx++) {
    const m = Math.abs(xx) + Math.abs(yy);
    if (m === 7 || m === 3 || m === 0) g.fillRect(W / 2 + xx, H / 2 + yy, 1, 1);
  }
  return c;
}
function makePageCanvas() {
  const { c, g } = makeCanvas(16, 20), rnd = mulberry32(5);
  g.fillStyle = '#f1e6c8'; g.fillRect(0, 0, 16, 20);
  g.fillStyle = '#d6c69e'; g.fillRect(15, 0, 1, 20); g.fillRect(0, 19, 16, 1);
  g.fillStyle = '#806c4c';
  for (let y = 3; y < 17; y += 2) g.fillRect(2, y, 4 + Math.floor(rnd() * 9), 1);
  return c;
}
function makeRuneCanvas(seed, dense) {
  const W = 512, H = 24, { c, g } = makeCanvas(W, H), rnd = mulberry32(seed);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 2, W, 1); g.fillRect(0, H - 3, W, 1);
  if (dense) g.fillRect(0, 4, W, 1);
  const step = dense ? 11 : 16;
  for (let gx = 4; gx < W - 10; gx += step) {
    const ox = gx, oy = 6;
    if (rnd() < 0.15) { g.fillRect(ox + 2, oy + 5, 4, 2); continue; }
    g.fillRect(ox + 4, oy, 1, 12);
    const strokes = 2 + Math.floor(rnd() * 3);
    for (let s = 0; s < strokes; s++) {
      const kind = Math.floor(rnd() * 3), sy = oy + Math.floor(rnd() * 10);
      if (kind === 0) g.fillRect(ox + 1, sy, 7, 1);
      else for (let i = 0; i < 4; i++) g.fillRect(ox + 4 + (kind === 1 ? i : -i), sy + i, 1, 1);
    }
  }
  return c;
}
function makeFairyFrames() {
  const frames = [];
  for (let f = 0; f < 2; f++) {
    const { c, g } = makeCanvas(16, 16);
    const px = (x, y, col) => { g.fillStyle = col; g.fillRect(x, y, 1, 1); };
    const wing = (cx, cy, rx, ry) => {
      for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) {
        const d = (x * x) / (rx * rx) + (y * y) / (ry * ry);
        if (d > 1.05) continue;
        px(cx + x, cy + y, d > 0.6 ? 'rgba(235,252,255,0.9)' : 'rgba(170,236,255,0.5)');
      }
    };
    if (f === 0) { wing(3, 5, 3, 3); wing(12, 5, 3, 3); wing(4, 10, 2, 2); wing(11, 10, 2, 2); }
    else { wing(5, 3, 2, 3); wing(10, 3, 2, 3); wing(5, 9, 1, 2); wing(10, 9, 1, 2); }
    for (const [x, y, col] of [
      [7, 3, '#ffd36e'], [8, 3, '#ffd36e'], [6, 4, '#ffd36e'], [7, 4, '#ffe8d2'], [8, 4, '#ffe8d2'], [9, 4, '#ffd36e'],
      [7, 5, '#ffe8d2'], [8, 5, '#ffe8d2'], [6, 5, '#ffd36e'], [9, 5, '#ffd36e'],
      [7, 6, '#ffffff'], [8, 6, '#ffffff'], [7, 7, '#ffffff'], [8, 7, '#ffffff'], [6, 8, '#ffffff'], [7, 8, '#f4f8ff'], [8, 8, '#f4f8ff'], [9, 8, '#ffffff'],
      [6, 9, '#e8f0ff'], [7, 9, '#ffffff'], [8, 9, '#ffffff'], [9, 9, '#e8f0ff'], [7, 10, '#ffe8d2'], [8, 11, '#ffe8d2']]) px(x, y, col);
    frames.push(c);
  }
  return frames;
}

/* 原创骑士 40×60，背影：闭盔+顶饰、钢甲肩甲、蓝披风金边、背上鸢形盾（蓝宝石）、右手发蓝光的直剑。
 * 6 帧走路循环：右脚着地 → 左腿迈出 → 左脚着地 → 右腿迈出。身体在过渡帧抬高 1px，
 * 盾比身体慢一帧（惯性），披风下摆滞后摆动、波浪沿下摆传过去，两臂反向摆，剑跟着手晃。
 * 另出一层「发光」贴图叠加在上面，喂给泛光。 */
const KNIGHT_W = 40, KNIGHT_H = 60, WALK_FRAMES = 6;
function makeKnightFrames() {
  const W = KNIGHT_W, H = KNIGHT_H, cx = 19.5;
  const ST = ['#1c2034', '#343c56', '#56627e', '#8a98b4', '#c4d0e4', '#f0f6ff'];
  const NV = ['#0a0e22', '#121a38', '#1c2856', '#283c7a', '#38529c'];
  const AU = ['#583a16', '#8a6026', '#c2903c', '#eac468', '#fff0b4'];
  const LB = ['#22160e', '#3a2818', '#5a3e26', '#7c5a38'];
  const GL = ['#1a4ad8', '#3c8cff', '#8cd4ff', '#eafcff'];
  const ramp = (R, t, lo = 0, hi = R.length - 1) => R[Math.max(lo, Math.min(hi, Math.round(lo + (hi - lo) * Math.max(0, Math.min(1, t)))))];
  const lit = (t) => Math.max(0, 1 - Math.abs(t - 0.7) * 1.7);
  const bobAt = (p) => -Math.round(Math.abs(Math.sin(p)));
  const frames = [], glows = [];
  for (let f = 0; f < WALK_FRAMES; f++) {
    const ph = f / WALK_FRAMES * Math.PI * 2, s = Math.sin(ph);
    const bob = bobAt(ph), lag = bobAt(ph - Math.PI * 2 / WALK_FRAMES);
    const liftL = Math.max(0, Math.round(s * 2.4)), liftR = Math.max(0, Math.round(-s * 2.4));
    const sway = Math.sin(ph + 0.9) * 1.6;
    const armL = Math.round(-s * 1.2), armR = Math.round(s * 1.2);
    const tilt = 0.26 - 0.07 * s;
    const spread = Math.abs(s) > 0.5 ? 1 : 0;
    const { c, g } = makeCanvas(W, H), { c: gc, g: gg } = makeCanvas(W, H);
    const px = (x, y, col) => { if (x < 0 || y < 0 || x >= W || y >= H) return; g.fillStyle = col; g.fillRect(x | 0, y | 0, 1, 1); };
    const glow = (x, y, col) => { px(x, y, col); gg.fillStyle = col; gg.fillRect(x | 0, y | 0, 1, 1); };

    // 腿 + 靴：迈出去的那条腿抬高、露出鞋底
    [[14, 17, liftL], [22, 25, liftR]].forEach(([x0, x1, lift]) => {
      const bottom = 59 - lift;
      for (let y = 46 + bob; y <= bottom; y++) for (let x = x0; x <= x1; x++) {
        const t = (x - x0) / (x1 - x0);
        let col;
        if (y > bottom - 4) col = ramp(LB, 0.2 + lit(t) * 0.8);
        else if (y === bottom - 4) col = t > 0.5 ? AU[3] : AU[1];
        else col = (y % 3 === 0) ? ST[1] : ramp(ST, lit(t) * 0.8 - (lift ? 0.2 : 0), 1, 4);
        px(x, y, col);
      }
      if (lift) for (let x = x0; x <= x1; x++) px(x, bottom, LB[0]);
      px(x0 + 2, bottom - 4, GL[2]);
    });
    // 披风：下摆随步伐甩动，后开衩张合，下摆上方一道金色藤蔓刺绣
    const hemBase = 52 + bob;
    for (let y = 21 + bob; y <= hemBase + 1; y++) {
      const yy = y - bob, hw = 8 + Math.floor((yy - 21) * 0.2) + (yy > 46 ? spread : 0);
      const off = yy > 34 ? Math.round(sway * (yy - 34) / 18) : 0;
      const x0 = Math.round(cx - hw) + off, x1 = Math.round(cx + hw) + off;
      const slitL = 19 + off - (yy > 46 ? spread : 0), slitR = 20 + off + (yy > 46 ? spread : 0);
      for (let x = x0; x <= x1; x++) {
        const hemY = hemBase + Math.round(Math.sin(x * 0.7 + ph) * 0.8);
        if (y > hemY) continue;
        if (yy > 41 && x >= slitL && x <= slitR) continue;
        const t = (x - x0) / (x1 - x0);
        let col = ramp(NV, 0.15 + lit(t) * 0.8);
        const fold = ((x - x0 + Math.round(sway)) % 5 + 5) % 5;
        if (yy > 28 && fold === 0) col = NV[1];
        if (yy > 28 && fold === 1 && t > 0.4) col = NV[4];
        if (yy > 41 && (x === slitL - 1 || x === slitR + 1)) col = AU[2];
        if (yy > 44 && y < hemY - 2 && Math.abs(Math.sin((x - off) * 0.8) * 1.6 + 48 - yy) < 0.5) col = t > 0.5 ? AU[3] : AU[2];
        if (y >= hemY - 1) col = (x + y) % 3 === 0 ? AU[3] : AU[1];
        px(x, y, col);
      }
    }
    // 两臂反向摆
    const lEnd = 34 + bob + armL;
    for (let y = 19 + bob; y <= lEnd; y++) for (let x = 6; x <= 9; x++) px(x, y, (y - bob) % 4 === 0 ? ST[1] : ramp(ST, lit((x - 6) / 3) * 0.6 + 0.1, 1, 4));
    for (let y = lEnd + 1; y <= lEnd + 4; y++) for (let x = 6; x <= 10; x++) px(x, y, ramp(ST, ((x - 6) / 4) * 0.5 + 0.2, 1, 4));
    const rEnd = 32 + bob + armR;
    for (let y = 19 + bob; y <= rEnd; y++) for (let x = 30; x <= 33; x++) px(x, y, (y - bob) % 4 === 0 ? ST[2] : ramp(ST, lit((x - 30) / 3) * 0.9 + 0.1, 2, 5));
    // 肩甲
    for (const [x0, x1] of [[7, 15], [24, 32]]) {
      for (let y = 15 + bob; y <= 22 + bob; y++) {
        const yy = y - bob, inset = yy === 15 ? 2 : yy === 16 ? 1 : 0;
        for (let x = x0 + inset; x <= x1 - inset; x++) {
          let col = ramp(ST, 0.15 + lit((x - x0) / (x1 - x0)) * 0.8, 1, 5);
          if (yy === 18 || yy === 21) col = ST[1];
          if (yy === 19 && (x === x0 + 2 || x === x1 - 2)) col = AU[3];
          px(x, y, col);
        }
      }
    }
    // 上背斗篷 + 金链
    for (let y = 14 + bob; y <= 24 + bob; y++) for (let x = 13; x <= 26; x++) {
      const yy = y - bob;
      let col = ramp(NV, 0.2 + lit((x - 13) / 13) * 0.7);
      if (yy === 16 || yy === 23) col = (x % 2) ? AU[3] : AU[1];
      if (yy === 20 && x % 3 === 0) col = AU[2];
      px(x, y, col);
    }
    // 背上的鸢形盾：比身体慢一帧，还会轻轻左右晃
    const sTop = 19 + lag, scx = cx + Math.round(Math.sin(ph + 0.6) * 0.7), sH = 28, sHW = 9;
    const inS = (x, y, k) => {
      const u = (x + 0.5 - scx) / sHW, v0 = (y + 0.5 - sTop) / sH;
      const v = (v0 - 0.4) / k + 0.4, uu = u / k;
      if (v < 0 || v > 1) return false;
      const lim = v < 0.35 ? 1 - Math.max(0, 0.08 - v) * 4 : Math.pow(Math.max(0, 1 - (v - 0.35) / 0.65), 0.8);
      return Math.abs(uu) <= lim;
    };
    const edge = (x, y, k) => inS(x, y, k) && !(inS(x - 1, y, k) && inS(x + 1, y, k) && inS(x, y - 1, k) && inS(x, y + 1, k));
    for (let y = sTop; y < sTop + sH; y++) for (let x = 7; x <= 32; x++) {
      if (!inS(x, y, 1)) continue;
      const u = (x - scx) / sHW, v = (y - sTop) / sH, l = 0.55 + u * 0.3 - v * 0.35;
      let col = ramp(ST, l, 1, 5);
      if ((x * 7 + y * 3) % 11 === 0) col = ramp(ST, l - 0.22, 1, 5);
      if (edge(x, y, 0.76) || edge(x, y, 0.52)) col = u > 0.1 ? ST[2] : ST[1];
      if (edge(x, y, 1)) col = u > 0 ? AU[3] : AU[1];
      px(x, y, col);
    }
    const gx = Math.floor(scx) - 0, gy = sTop + 9;
    for (const [dx, dy] of [[-2, 1], [3, 1], [0, -2], [1, -2], [0, 4], [1, 4], [-1, -1], [2, -1], [-1, 3], [2, 3]]) px(gx + dx, gy + dy, AU[3]);
    glow(gx, gy, GL[1]); glow(gx + 1, gy, GL[2]); glow(gx, gy + 1, GL[2]); glow(gx + 1, gy + 1, GL[3]); glow(gx, gy + 2, GL[0]); glow(gx + 1, gy + 2, GL[1]);
    // 头盔 + 顶饰
    const hwH = [0, 0, 0, 2, 3, 4, 4.5, 5, 5, 5, 5, 5, 5, 5.5, 6];
    for (let y = 3; y <= 14; y++) {
      const hw = hwH[y];
      for (let x = Math.floor(cx - hw); x <= Math.ceil(cx + hw) - 1; x++) {
        const t = (x - (cx - hw)) / (2 * hw);
        let col = ramp(ST, 0.1 + lit(t) * 0.85 - (y > 11 ? 0.15 : 0), 0, 5);
        if ((x === 19 || x === 20) && y < 11) col = x === 20 ? ST[5] : ST[3];
        if (y === 11) col = t > 0.5 ? AU[3] : AU[2];
        px(x, y + bob, col);
      }
    }
    px(19, 0 + bob, AU[4]); px(19, 1 + bob, AU[3]); px(20, 1 + bob, AU[2]); px(19, 2 + bob, AU[3]); px(20, 2 + bob, AU[2]);
    // 剑：跟着右手上下晃、剑身角度随步伐微摆
    const hy = rEnd + 1;
    for (let y = hy; y <= hy + 3; y++) for (let x = 30; x <= 34; x++) px(x, y, ramp(ST, (x - 30) / 4, 2, 5));
    px(31, hy - 2, AU[3]); px(32, hy - 2, AU[2]); px(32, hy - 1, LB[2]);
    for (let x = 29; x <= 36; x++) px(x, hy + 4, x < 33 ? AU[2] : AU[3]);
    glow(28, hy + 4, GL[2]); glow(37, hy + 4, GL[2]);
    for (let i = 0; i <= 20; i++) {
      const x = 33 + Math.floor(i * tilt), y = hy + 5 + i;
      if (y >= H) break;
      px(x + 1, y, ST[2]);
      if (i < 10) glow(x, y, i % 3 === 0 ? GL[3] : GL[2]); else px(x, y, ST[4]);
    }
    selout(g, W, H);
    frames.push(c); glows.push(gc);
  }
  return { frames, glows };
}

/* 油画：兜帽学者肖像 / 月下高塔 / 星图，金色画框 */
function makePaintingCanvas(kind) {
  const W = 48, H = 60, { c, g } = makeCanvas(W, H), rnd = mulberry32(60 + kind);
  const px = (x, y, col) => { g.fillStyle = col; g.fillRect(x, y, 1, 1); };
  const AU = ['#3e2810', '#7a5424', '#b8893a', '#e6c068', '#fff0b0'];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = y / H;
    let col;
    if (kind === 0) col = shade('#2a3a3c', 0.7 + 0.5 * (1 - Math.hypot(x - 24, y - 26) / 34));
    else if (kind === 1) col = shade(v < 0.7 ? '#1c2e5a' : '#18201e', 0.7 + v * 0.5);
    else col = shade('#4a3826', 0.75 + 0.3 * Math.sin(x * 0.3 + y * 0.2) * 0.3);
    if (rnd() < 0.08) col = shade(kind === 2 ? '#4a3826' : '#2a3a3c', 0.6);       // 油画笔触颗粒
    px(x, y, col);
  }
  if (kind === 0) {
    for (let y = 12; y < 55; y++) {
      const hw = y < 30 ? 3 + (y - 12) * 0.38 : 10 + (y - 30) * 0.28;
      for (let x = Math.round(24 - hw); x <= Math.round(24 + hw); x++) {
        const t = (x - (24 - hw)) / (2 * hw);
        px(x, y, shade('#2a3a7a', 0.45 + t * 0.7));
      }
    }
    for (let y = 18; y < 30; y++) for (let x = 20; x <= 28; x++) {
      if ((x - 24) ** 2 / 16 + (y - 24) ** 2 / 36 > 1) continue;
      px(x, y, y > 24 ? shade('#d8b090', 0.5 + (x - 20) / 16) : '#0c0e18');
    }
    px(22, 23, '#9ad8ff'); px(26, 23, '#9ad8ff');
    for (let x = 21; x <= 27; x++) px(x, 38, '#e6c068');
    px(24, 39, '#7fe6ff'); px(24, 40, '#e6c068');
    for (let y = 30; y < 50; y++) px(38, y, '#ffcf6a');
  } else if (kind === 1) {
    for (let y = 8; y < 20; y++) for (let x = 28; x < 40; x++) if ((x - 33.5) ** 2 + (y - 13.5) ** 2 < 22) px(x, y, (x - 33.5) ** 2 + (y - 13.5) ** 2 < 10 ? '#fff6dc' : '#e8dcb8');
    for (let i = 0; i < 30; i++) px(6 + Math.floor(rnd() * 36), 6 + Math.floor(rnd() * 26), '#cfe2ff');
    for (let y = 18; y < 55; y++) {
      const hw = y < 24 ? (y - 18) * 0.5 : 4 + (y > 40 ? 1 : 0);
      for (let x = Math.round(17 - hw); x <= Math.round(17 + hw); x++) px(x, y, shade('#1a2236', 0.6 + (x - 13) / 14));
      if (y % 6 === 0 && y > 26) px(17, y, '#ffd36a');
    }
    for (let x = 5; x < 43; x++) for (let y = 44 + Math.round(Math.sin(x * 0.25) * 2); y < 55; y++) px(x, y, shade('#1e2a24', 0.6 + (y - 44) * -0.02));
  } else {
    const cx = 24, cy = 30;
    for (let y = 5; y < 55; y++) for (let x = 5; x < 43; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (Math.abs(d - 16) < 0.6 || Math.abs(d - 11) < 0.5 || Math.abs(d - 5) < 0.5) px(x, y, '#d9b25c');
      if (Math.abs((x - cx) - (y - cy)) < 0.5 && d < 17) px(x, y, '#a8823e');
    }
    for (let i = 0; i < 24; i++) { const a = rnd() * Math.PI * 2, r = 3 + rnd() * 14; px(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), '#fff2c8'); }
    for (const [x, y] of [[cx, cy], [cx + 1, cy], [cx, cy + 1], [cx + 1, cy + 1]]) px(x, y, '#7fe6ff');
  }
  // 画框：外暗、中金、高光、内暗，四角花饰
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const e = Math.min(x, y, W - 1 - x, H - 1 - y);
    if (e > 4) continue;
    const k = e === 0 ? 0 : e === 1 ? 2 : e === 2 ? ((x + y) % 3 ? 3 : 2) : e === 3 ? (x < W / 2 ? 2 : 4) : 1;
    px(x, y, AU[k]);
  }
  for (const [x, y] of [[0, 0], [W - 7, 0], [0, H - 7], [W - 7, H - 7]]) for (let yy = 0; yy < 7; yy++) for (let xx = 0; xx < 7; xx++) if (Math.abs(xx - 3) + Math.abs(yy - 3) <= 3) px(x + xx, y + yy, Math.abs(xx - 3) + Math.abs(yy - 3) <= 1 ? AU[4] : AU[2]);
  return c;
}

/* 兜帽石像（抱着书），站在拱廊下的托座上 */
function makeStatueCanvas() {
  const W = 24, H = 48, { c, g } = makeCanvas(W, H);
  const S = ['#24283a', '#383e54', '#525a74', '#717b96', '#98a2bc', '#c2cadc'];
  const px = (x, y, col) => { g.fillStyle = col; g.fillRect(x, y, 1, 1); };
  const lit = (t) => Math.max(0, 1 - Math.abs(t - 0.7) * 1.6);
  for (let y = 2; y < 44; y++) {
    const hw = y < 16 ? 2 + (y - 2) * 0.32 : 6.5 + (y - 16) * 0.12;
    for (let x = Math.round(11.5 - hw); x <= Math.round(11.5 + hw); x++) {
      const t = (x - (11.5 - hw)) / (2 * hw);
      let k = Math.round(1 + lit(t) * 3.5);
      if (y > 18 && (x === 9 || x === 14)) k = Math.max(0, k - 2);
      px(x, y, S[Math.min(5, k)]);
    }
  }
  for (let y = 8; y < 15; y++) for (let x = 9; x <= 14; x++) if ((x - 11.5) ** 2 / 7 + (y - 11.5) ** 2 / 14 < 1) px(x, y, S[0]);
  for (let y = 22; y < 28; y++) for (let x = 7; x <= 16; x++) px(x, y, y === 22 ? S[5] : x > 13 ? S[4] : S[3]);
  for (let x = 7; x <= 16; x++) px(x, 27, S[1]);
  for (let y = 44; y < 48; y++) for (let x = 1; x < 23; x++) px(x, y, y === 44 ? S[5] : S[2 + (x > 14 ? 1 : 0)]);
  selout(g, W, H);
  return c;
}
function makeEndpaperCanvas() {
  const W = 32, H = 44, { c, g } = makeCanvas(W, H);
  const P = ['#f6f0e2', '#e9dcc4', '#ddc9aa', '#f1e6d2'];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = Math.sin(x * 0.35 + Math.sin(y * 0.3) * 2.2) + Math.sin(y * 0.22 + x * 0.1);
    g.fillStyle = P[Math.max(0, Math.min(3, Math.floor((v + 2) * 1.0)))]; g.fillRect(x, y, 1, 1);
  }
  return c;
}

/* ============================================================
 * 渲染器 / 场景
 * ============================================================ */
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
renderer.localClippingEnabled = true;
renderer.shadowMap.enabled = true;               // 书房里月光透过长窗投下的影子
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
maxAniso = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
scene.background = new THREE.Color(FOG_COLOR);
scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_D);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 400);

const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e5);   // 保留 y ≤ 常数 的部分
const clipped = (m) => { m.clippingPlanes = [clipPlane]; return m; };

const tower = new THREE.Group();
scene.add(tower);
const fxObjects = [];

/* ---------------- 共享 GLSL ---------------- */
const NOISE_GLSL = /* glsl */`
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+10.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
vec3 snoiseVec3(vec3 x){
  return vec3(snoise(x), snoise(vec3(x.y-19.1,x.z+33.4,x.x+47.2)), snoise(vec3(x.z+74.2,x.x-124.5,x.y+99.4)));
}
vec3 curlNoise(vec3 p){
  const float e=0.1;
  vec3 dx=vec3(e,0.0,0.0), dy=vec3(0.0,e,0.0), dz=vec3(0.0,0.0,e);
  vec3 px0=snoiseVec3(p-dx), px1=snoiseVec3(p+dx);
  vec3 py0=snoiseVec3(p-dy), py1=snoiseVec3(p+dy);
  vec3 pz0=snoiseVec3(p-dz), pz1=snoiseVec3(p+dz);
  float x=py1.z-py0.z-pz1.y+pz0.y;
  float y=pz1.x-pz0.x-px1.z+px0.z;
  float z=px1.y-px0.y-py1.x+py0.x;
  return vec3(x,y,z)/(2.0*e);
}
`;
const COMMON_GLSL = /* glsl */`
uniform float uTime;
uniform float uViewH;
uniform float uFogD;
uniform float uClipY;
const float DTH = ${DTH.toFixed(6)};
const float RISE = ${RISE.toFixed(6)};
float fogF(float depth){ float f = uFogD*depth; return exp(-f*f); }
#define pxSize(ws, d) ((ws) * projectionMatrix[1][1] * uViewH * 0.5 / max((d), 0.05))
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
`;
const SOFT_POINT_FRAG = /* glsl */`
varying vec3 vColor;
varying float vAlpha;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c) * 4.0;
  float a = exp(-d2*14.0) + exp(-d2*3.5)*0.22;
  a *= 1.0 - smoothstep(0.7, 1.0, d2);
  a *= clamp(vAlpha, 0.0, 4.0);
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor, a);
}
`;
const shared = { uTime: { value: 0 }, uViewH: { value: innerHeight }, uFogD: { value: FOG_D }, uClipY: { value: 1e5 } };
function pointsMaterial(vertexShader, fragmentShader = SOFT_POINT_FRAG, extra = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, ...extra },
    vertexShader, fragmentShader,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
function flameMaterial(size, gain = 1) {
  return pointsMaterial(COMMON_GLSL + /* glsl */`
    attribute float aRand;
    varying float vFlick;
    varying float vFog;
    void main(){
      vec4 w = modelMatrix*vec4(position,1.0);
      vec4 mv = viewMatrix*w;
      gl_Position = projectionMatrix*mv;
      float t = uTime*(7.0+aRand*3.0) + aRand*50.0;
      vFlick = 0.85 + 0.1*sin(t) + 0.05*sin(t*2.7+1.3);
      vFog = w.y > uClipY ? 0.0 : fogF(-mv.z);
      gl_PointSize = w.y > uClipY ? 0.0 : pxSize(${size.toFixed(3)}, -mv.z);
    }`, /* glsl */`
    varying float vFlick;
    varying float vFog;
    void main(){
      vec2 c = gl_PointCoord - 0.5;
      c.y = -c.y;
      float halo = exp(-dot(c,c)*16.0) * 0.4;
      vec2 q = vec2(c.x*3.6, (c.y+0.06)*1.8);
      q.y -= max(q.y,0.0)*0.6;
      float core = 1.0 - smoothstep(0.0, 0.3, max(length(q) + c.y*0.25, 0.0));
      vec3 col = vec3(1.0,0.6,0.22)*halo + mix(vec3(1.0,0.62,0.22), vec3(1.0,0.97,0.82), core)*core*3.4;
      col *= vFlick * vFog * ${gain.toFixed(3)};
      float a = max(halo, core) * vFog;
      if (a < 0.01) discard;
      gl_FragColor = vec4(col, 1.0);
    }`);
}

/* ============================================================
 * 天空：域扭曲（domain warping）星云 + 星星，罩在镜头外
 * ============================================================ */
const moonDirU = { value: new THREE.Vector3(0, 1, 0) };
const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 48, 24), new THREE.ShaderMaterial({
  uniforms: { uTime: shared.uTime, uMoonDir: moonDirU },
  vertexShader: /* glsl */`
    varying vec3 vDir;
    void main(){ vec4 w = modelMatrix*vec4(position,1.0); vDir = w.xyz - cameraPosition; gl_Position = projectionMatrix*viewMatrix*w; }`,
  fragmentShader: /* glsl */`
    uniform float uTime;
    uniform vec3 uMoonDir;
    varying vec3 vDir;
    float h3(vec3 p){ p = fract(p*0.3183099+0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
    float vnoise(vec3 x){
      vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
      return mix(mix(mix(h3(i),h3(i+vec3(1,0,0)),f.x), mix(h3(i+vec3(0,1,0)),h3(i+vec3(1,1,0)),f.x),f.y),
                 mix(mix(h3(i+vec3(0,0,1)),h3(i+vec3(1,0,1)),f.x), mix(h3(i+vec3(0,1,1)),h3(i+vec3(1,1,1)),f.x),f.y), f.z);
    }
    float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ s += a*vnoise(p); p = p*2.03 + vec3(1.7,9.2,3.1); a *= 0.5; } return s; }
    void main(){
      vec3 d = normalize(vDir);
      float up = clamp(d.y, -1.0, 1.0);
      vec3 col = mix(vec3(0.06,0.2,0.3), vec3(0.015,0.06,0.15), smoothstep(0.1, 1.0, up));
      vec3 p = d*2.4 + vec3(0.0, 0.0, uTime*0.008);
      vec3 q = vec3(fbm(p), fbm(p + vec3(5.2,1.3,2.8)), fbm(p + vec3(2.1,7.7,4.4)));
      float n = fbm(p + 3.2*q + vec3(0.0, uTime*0.015, 0.0));
      col += vec3(0.12,0.45,0.8) * smoothstep(0.38, 0.75, q.x) * 0.45;
      vec3 red = mix(vec3(0.85,0.1,0.07), vec3(1.0,0.5,0.22), smoothstep(0.62, 0.85, n));
      col += red * smoothstep(0.48, 0.78, n) * smoothstep(0.5, 0.7, q.y) * 1.6;
      vec3 sp = d*240.0; vec3 cell = floor(sp); float r = h3(cell);
      float star = step(0.986, r) * (1.0 - smoothstep(0.0, 0.45, length(fract(sp) - 0.5)));
      star *= 0.6 + 0.4*sin(uTime*(2.0 + r*5.0) + r*50.0);
      col += vec3(0.85,0.92,1.0) * star * 2.2;
      // 银河：一条斜穿天顶的星带，里面再撒一层更密更暗的小星
      float mw = exp(-pow(dot(d, normalize(vec3(0.62, 0.25, -0.74))) * 3.2, 2.0));
      col += vec3(0.2,0.36,0.5) * mw * fbm(d*7.0) * 0.7;
      vec3 sp2 = d*520.0; float r2 = h3(floor(sp2));
      col += vec3(0.7,0.85,1.0) * step(0.993 - mw*0.025, r2) * (1.0 - smoothstep(0.0, 0.45, length(fract(sp2) - 0.5))) * (0.5 + 0.5*sin(uTime*3.0 + r2*80.0));
      // 天顶满月：fbm 画月面阴影，外面一圈冷光晕
      float md = acos(clamp(dot(d, uMoonDir), -1.0, 1.0));
      const float MR = 0.21;
      col += vec3(0.45,0.72,0.82) * exp(-pow(max(md - MR, 0.0) * 8.0, 1.3)) * 0.55;
      col += vec3(0.25,0.45,0.65) * exp(-md * 2.0) * 0.3;
      if (md < MR + 0.01) {
        vec3 tA = normalize(cross(uMoonDir, vec3(0.0, 0.0, 1.0)) + vec3(1e-4)), tB = cross(uMoonDir, tA);
        vec2 q = vec2(dot(d, tA), dot(d, tB)) / sin(MR);
        float m = fbm(vec3(q*2.6, 1.7))*0.62 + fbm(vec3(q*8.0, 4.2))*0.3;
        vec3 moon = mix(vec3(0.5,0.68,0.72), vec3(0.96,1.0,0.98), smoothstep(0.4, 0.74, m));
        moon *= 0.68 + 0.32*sqrt(max(0.0, 1.0 - dot(q, q)));
        col = mix(col, moon*0.78, 1.0 - smoothstep(MR - 0.004, MR, md));   // 压在泛光阈值下面，月面纹理才不会被糊掉
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
  side: THREE.BackSide, depthWrite: false, fog: false,
}));
sky.renderOrder = -10;
sky.frustumCulled = false;
scene.add(sky);

/* ============================================================
 * 塔身：书架 + 哥特拱廊 + 石柱
 * ============================================================ */
const H_TOTAL = Y_MAX - Y_MIN;
const ROW_REPEAT = H_TOTAL / ROW_H / 4;
const stoneColMat = clipped(new THREE.MeshStandardMaterial({ color: 0x4e566e, roughness: 0.85, flatShading: true }));
const woodMat = clipped(new THREE.MeshStandardMaterial({ color: 0x7a5232, roughness: 0.7, flatShading: true, side: THREE.DoubleSide }));
const brassMat = clipped(new THREE.MeshStandardMaterial({ color: 0xd8a850, metalness: 0.55, roughness: 0.32, emissive: 0x3a2808, emissiveIntensity: 0.6 }));
const marbleMat = clipped(new THREE.MeshStandardMaterial({ color: 0x98a2bc, roughness: 0.55, flatShading: true }));
{
  const t = makeShelfTextures(640, 3);
  const mat = clipped(new THREE.MeshStandardMaterial({
    map: pixelTex(t.map, 3, ROW_REPEAT), emissiveMap: pixelTex(t.emissive, 3, ROW_REPEAT),
    emissive: 0xffffff, emissiveIntensity: 1.6, roughness: 0.9, side: THREE.BackSide,
  }));
  const g = new THREE.CylinderGeometry(R_WALL_BOOK, R_WALL_BOOK, H_TOTAL, 192, 1, true);
  g.translate(0, (Y_MIN + Y_MAX) / 2, 0);
  tower.add(new THREE.Mesh(g, mat));

  const rows = Math.round(H_TOTAL / ROW_H);
  const plank = new THREE.LatheGeometry([
    new THREE.Vector2(R_WALL_BOOK + 0.05, 0), new THREE.Vector2(R_WALL_PLANK, 0),
    new THREE.Vector2(R_WALL_PLANK - 0.04, 0.03), new THREE.Vector2(R_WALL_PLANK - 0.04, 0.1),
    new THREE.Vector2(R_WALL_PLANK, 0.125), new THREE.Vector2(R_WALL_BOOK + 0.05, 0.125),
  ], 192);
  const im = new THREE.InstancedMesh(plank, woodMat, rows + 1);
  const m = new THREE.Matrix4();
  for (let i = 0; i <= rows; i++) { m.makeTranslation(0, Y_MIN + i * ROW_H, 0); im.setMatrixAt(i, m); }
  tower.add(im);

  // 拱廊：每圈第 7-8 层是一圈镂空尖拱，书从拱里透出来
  const arcTex = pixelTex(makeArcadeCanvas(), 20, 1);
  arcTex.wrapT = THREE.ClampToEdgeWrapping;
  const arcGeo = new THREE.CylinderGeometry(8.53, 8.53, ROW_H * 2, 200, 1, true, Math.PI / 20);
  const arcMat = clipped(new THREE.MeshStandardMaterial({ map: arcTex, alphaTest: 0.5, side: THREE.BackSide, roughness: 0.85 }));
  const turns = Math.round(H_TOTAL / TURN_H);
  const arcs = new THREE.InstancedMesh(arcGeo, arcMat, turns);
  for (let i = 0; i < turns; i++) { m.makeTranslation(0, Y_MIN + i * TURN_H + ROW_H * 7, 0); arcs.setMatrixAt(i, m); }
  tower.add(arcs);

  // 石柱：束柱（主柱 + 两根细柱）+ 金色线脚
  const N = 20, o = new THREE.Object3D();
  const postGeo = new THREE.BoxGeometry(0.34, H_TOTAL, 0.6); postGeo.translate(0, (Y_MIN + Y_MAX) / 2, 0);
  const shaftGeo = new THREE.CylinderGeometry(0.09, 0.09, H_TOTAL, 8); shaftGeo.translate(0, (Y_MIN + Y_MAX) / 2, 0);
  const ribGeo = new THREE.BoxGeometry(0.05, H_TOTAL, 0.05); ribGeo.translate(0, (Y_MIN + Y_MAX) / 2, 0);
  const pm = new THREE.InstancedMesh(postGeo, stoneColMat, N), sm = new THREE.InstancedMesh(shaftGeo, stoneColMat, N * 2), rm = new THREE.InstancedMesh(ribGeo, brassMat, N);
  for (let i = 0; i < N; i++) {
    const th = (i + 0.5) * Math.PI * 2 / N;
    o.position.set(8.82 * Math.cos(th), 0, 8.82 * Math.sin(th)); o.rotation.set(0, Math.PI / 2 - th, 0); o.updateMatrix(); pm.setMatrixAt(i, o.matrix);
    for (const [k, dth] of [[0, -0.022], [1, 0.022]]) { o.position.copy(polar(8.5, th + dth, 0)); o.updateMatrix(); sm.setMatrixAt(i * 2 + k, o.matrix); }
    o.position.copy(polar(8.44, th, 0)); o.updateMatrix(); rm.setMatrixAt(i, o.matrix);
  }
  tower.add(pm, sm, rm);
}

/* ---------------- 悬挑螺旋台阶 + 地毯 + 栏杆 ---------------- */
function GeoBuilder() {
  const P = [], N = [], U = [], C = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
  function tri(p0, p1, p2, u0, u1, u2, col) {
    a.subVectors(p1, p0); b.subVectors(p2, p0); n.crossVectors(a, b).normalize();
    for (const p of [p0, p1, p2]) P.push(p.x, p.y, p.z);
    for (let i = 0; i < 3; i++) { N.push(n.x, n.y, n.z); C.push(col); }
    U.push(...u0, ...u1, ...u2);
  }
  function quad(p0, p1, p2, p3, u0, u1, u2, u3, col, want) {
    a.subVectors(p1, p0); b.subVectors(p2, p0); n.crossVectors(a, b);
    if (n.dot(want) >= 0) { tri(p0, p1, p2, u0, u1, u2, col); tri(p0, p2, p3, u0, u2, u3, col); }
    else { tri(p0, p2, p1, u0, u2, u1, col); tri(p0, p3, p2, u0, u3, u2, col); }
  }
  function build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    const col = new Float32Array(C.length * 3);
    for (let i = 0; i < C.length; i++) col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = C[i];
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  }
  return { quad, build };
}
const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
const tangent = (th) => new THREE.Vector3(-Math.sin(th), 0, Math.cos(th));
const radial = (th) => new THREE.Vector3(Math.cos(th), 0, Math.sin(th));
{
  const stairs = GeoBuilder(), carpet = GeoBuilder();
  const SEG = 4, THICK = 0.7, S = 0.5, NOSE = 0.06;
  for (let k = K_MIN; k < K_MAX; k++) {
    const th0 = k * DTH, th1 = th0 + DTH, yT = (k + 1) * RISE, yB = yT - THICK;
    const v0 = k * 0.5, r0 = R_STAIR_IN, r1 = R_STAIR_OUT;
    for (let m = 0; m < SEG; m++) {
      const ta = th0 + (m / SEG) * DTH, tb = th0 + ((m + 1) / SEG) * DTH;
      const va = v0 + (m / SEG) * 0.5, vb = v0 + ((m + 1) / SEG) * 0.5;
      stairs.quad(polar(r0, ta, yT), polar(r1, ta, yT), polar(r1, tb, yT), polar(r0, tb, yT),
        [r0 * S, va], [r1 * S, va], [r1 * S, vb], [r0 * S, vb], 1.0, UP);
      stairs.quad(polar(r0, ta, yB), polar(r1, ta, yB), polar(r1, tb, yB), polar(r0, tb, yB),
        [r0 * S, va], [r1 * S, va], [r1 * S, vb], [r0 * S, vb], 0.55, DOWN);
      const mid = (ta + tb) / 2;
      stairs.quad(polar(r1, ta, yB), polar(r1, tb, yB), polar(r1, tb, yT), polar(r1, ta, yT),
        [va, yB * S], [vb, yB * S], [vb, yT * S], [va, yT * S], 0.6, radial(mid));
      stairs.quad(polar(r0, ta, yB), polar(r0, tb, yB), polar(r0, tb, yT), polar(r0, ta, yT),
        [va, yB * S], [vb, yB * S], [vb, yT * S], [va, yT * S], 0.82, radial(mid).negate());
      const cy = yT + 0.012;
      carpet.quad(polar(CARPET_IN, ta, cy), polar(CARPET_OUT, ta, cy), polar(CARPET_OUT, tb, cy), polar(CARPET_IN, tb, cy),
        [0, va * 2], [1, va * 2], [1, vb * 2], [0, vb * 2], 1.0, UP);
    }
    const back = tangent(th0).negate(), nose = back.clone().multiplyScalar(NOSE);
    const pn = (r, y) => polar(r, th0, y).add(nose);
    stairs.quad(polar(r0, th0, yB), polar(r1, th0, yB), polar(r1, th0, yT - 0.08), polar(r0, th0, yT - 0.08),
      [r0 * S, yB * S], [r1 * S, yB * S], [r1 * S, yT * S], [r0 * S, yT * S], 0.7, back);
    stairs.quad(pn(r0, yT - 0.08), pn(r1, yT - 0.08), pn(r1, yT), pn(r0, yT),
      [r0 * S, 0.1], [r1 * S, 0.1], [r1 * S, 0.12], [r0 * S, 0.12], 1.15, back);
    stairs.quad(polar(r0, th0, yT), polar(r1, th0, yT), pn(r1, yT), pn(r0, yT),
      [r0 * S, 0.1], [r1 * S, 0.1], [r1 * S, 0.12], [r0 * S, 0.12], 1.15, UP);
    stairs.quad(polar(r0, th1, yB), polar(r1, th1, yB), polar(r1, th1, yT), polar(r0, th1, yT),
      [r0 * S, yB * S], [r1 * S, yB * S], [r1 * S, yT * S], [r0 * S, yT * S], 0.5, tangent(th1));
    const off = back.clone().multiplyScalar(NOSE + 0.012);
    const cp = (r, y) => polar(r, th0, y).add(off);
    carpet.quad(cp(CARPET_IN, yT - RISE), cp(CARPET_OUT, yT - RISE), cp(CARPET_OUT, yT + 0.012), cp(CARPET_IN, yT + 0.012),
      [0, v0 * 2 - 0.3], [1, v0 * 2 - 0.3], [1, v0 * 2], [0, v0 * 2], 0.72, back);
  }
  const SUB = 4;
  for (let k = K_MIN * SUB; k < K_MAX * SUB; k++) {
    const s0 = k / SUB, s1 = (k + 1) / SUB, ta = s0 * DTH, tb = s1 * DTH;
    const r = R_STAIR_IN - 0.06, rIn = R_STAIR_IN + 0.5;
    const top0 = s0 * RISE + 0.05, top1 = s1 * RISE + 0.05, bot0 = top0 - 1.1, bot1 = top1 - 1.1;
    const mid = (ta + tb) / 2;
    stairs.quad(polar(r, ta, bot0), polar(r, tb, bot1), polar(r, tb, top1), polar(r, ta, top0),
      [s0 * 0.5, bot0 * S], [s1 * 0.5, bot1 * S], [s1 * 0.5, top1 * S], [s0 * 0.5, top0 * S], 0.9, radial(mid).negate());
    stairs.quad(polar(r, ta, bot0), polar(r, tb, bot1), polar(rIn, tb, bot1), polar(rIn, ta, bot0),
      [s0 * 0.5, 0], [s1 * 0.5, 0], [s1 * 0.5, 0.25], [s0 * 0.5, 0.25], 0.5, DOWN);
    const tr = r - 0.05;
    stairs.quad(polar(tr, ta, top0 - 0.12), polar(tr, tb, top1 - 0.12), polar(tr, tb, top1), polar(tr, ta, top0),
      [s0 * 0.5, 0.5], [s1 * 0.5, 0.5], [s1 * 0.5, 0.53], [s0 * 0.5, 0.53], 1.2, radial(mid).negate());
    stairs.quad(polar(tr, ta, bot0 + 0.1), polar(tr, tb, bot1 + 0.1), polar(tr, tb, bot1 + 0.2), polar(tr, ta, bot0 + 0.2),
      [s0 * 0.5, 0.5], [s1 * 0.5, 0.5], [s1 * 0.5, 0.53], [s0 * 0.5, 0.53], 1.1, radial(mid).negate());
  }
  tower.add(new THREE.Mesh(stairs.build(), clipped(new THREE.MeshStandardMaterial({ map: pixelTex(makeStoneCanvas()), vertexColors: true, roughness: 0.85 }))));
  tower.add(new THREE.Mesh(carpet.build(), clipped(new THREE.MeshStandardMaterial({ map: pixelTex(makeCarpetCanvas()), vertexColors: true, roughness: 1 }))));

  // 栏杆：车削出来的石瓶柱（每级三根，带方底座）+ 刻棱石扶手 + 扶手上的铜嵌条
  const balProfile = [[0.05, 0], [0.055, 0.03], [0.035, 0.07], [0.03, 0.2], [0.055, 0.36], [0.066, 0.47], [0.045, 0.58], [0.028, 0.74], [0.034, 0.88], [0.056, 0.93], [0.05, 1.0]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const balGeo = new THREE.LatheGeometry(balProfile, 10);
  const baseGeo = new THREE.BoxGeometry(0.13, 0.05, 0.13); baseGeo.translate(0, 0.025, 0);
  const count = (K_MAX - K_MIN) * 3;
  const bal = new THREE.InstancedMesh(balGeo, marbleMat, count), bases = new THREE.InstancedMesh(baseGeo, marbleMat, count);
  const o = new THREE.Object3D();
  let i = 0;
  for (let k = K_MIN; k < K_MAX; k++) for (const fr of [1 / 6, 0.5, 5 / 6]) {
    const s = k + fr, y0 = (k + 1) * RISE;
    o.position.copy(polar(R_RAIL, s * DTH, y0)); o.rotation.set(0, -s * DTH, 0);
    o.scale.set(1, 1, 1); o.updateMatrix(); bases.setMatrixAt(i, o.matrix);
    o.position.y = y0 + 0.05; o.scale.set(1, railY(s) - 0.07 - y0 - 0.05, 1); o.updateMatrix(); bal.setMatrixAt(i, o.matrix);
    i++;
  }
  tower.add(bal, bases);
  class Helix extends THREE.Curve {
    constructor(r, f) { super(); this.r = r; this.f = f; }
    getPoint(t, target = new THREE.Vector3()) { const s = K_MIN + t * (K_MAX - K_MIN); return target.copy(polar(this.r, s * DTH, this.f(s))); }
    // 管子截面的朝向：three 默认的平行移动标架沿螺旋每圈多转 110°，六棱的扶手每圈棱线错开，
    // 塔挪一圈时扶手明暗会跳（scripts/seam.mjs 查出来的）。改成法线一直朝外（半径方向），每圈一样
    computeFrenetFrames(segs) {
      const tangents = [], normals = [], binormals = [];
      for (let i = 0; i <= segs; i++) {
        const t = i / segs, T = this.getTangentAt(t, new THREE.Vector3()), p = this.getPointAt(t);
        const N = new THREE.Vector3(p.x, 0, p.z).normalize();
        N.addScaledVector(T, -N.dot(T)).normalize();
        tangents.push(T); normals.push(N); binormals.push(new THREE.Vector3().crossVectors(T, N));
      }
      return { tangents, normals, binormals };
    }
  }
  const segs = (K_MAX - K_MIN) * 5;
  tower.add(new THREE.Mesh(new THREE.TubeGeometry(new Helix(R_RAIL, railY), segs, 0.085, 6, false), marbleMat));
  tower.add(new THREE.Mesh(new THREE.TubeGeometry(new Helix(R_RAIL, (s) => railY(s) + 0.075), segs, 0.024, 6, false), brassMat));
  tower.add(new THREE.Mesh(new THREE.TubeGeometry(new Helix(R_RAIL + 0.06, (s) => railY(s) - 0.1), segs, 0.02, 5, false), brassMat));

  // 盾纹：每两级一块鸢形盾徽（骑士背盾上的同心纹 + 蓝宝石 + 金丝卷草），扶手下一条镂空金色卷草饰带
  {
    const PW = 32, PH = 46, pc = makeCanvas(PW, PH), pe = makeCanvas(PW, PH);
    pe.g.fillStyle = '#000'; pe.g.fillRect(0, 0, PW, PH);
    const S = ['#2a2e40', '#4a5268', '#6e7890', '#98a2b8', '#c6cede', '#eef2fa'];
    const inS = (x, y, k) => {
      const u = (x + 0.5 - PW / 2) / (PW / 2), v0 = (y + 0.5) / PH, v = (v0 - 0.4) / k + 0.4;
      if (v < 0 || v > 1) return false;
      const lim = v < 0.35 ? 1 - Math.max(0, 0.06 - v) * 5 : Math.pow(Math.max(0, 1 - (v - 0.35) / 0.65), 0.8);
      return Math.abs(u / k) <= lim;
    };
    const edge = (x, y, k) => inS(x, y, k) && !(inS(x - 1, y, k) && inS(x + 1, y, k) && inS(x, y - 1, k) && inS(x, y + 1, k));
    for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
      if (!inS(x, y, 1)) continue;
      const u = (x - PW / 2) / (PW / 2), v = y / PH;
      let k = Math.round(2.6 + u * 1.2 - v * 1.4);
      if (Math.abs(Math.sin(x * 0.9 + Math.sin(y * 0.5) * 2.2)) < 0.16) k -= 1;
      let col = S[Math.max(0, Math.min(5, k))];
      if (edge(x, y, 0.8) || edge(x, y, 0.6)) col = u > 0 ? '#e6c068' : '#9a7030';
      if (edge(x, y, 1)) col = u > 0 ? '#f0cc72' : '#a87a34';
      pc.g.fillStyle = col; pc.g.fillRect(x, y, 1, 1);
    }
    pe.g.globalAlpha = 0.4; pe.g.drawImage(pc.c, 0, 0); pe.g.globalAlpha = 1;      // 银面微微自发光，暗处也看得清
    for (const [cx, cy, r, c0] of [[16, 17, 2.6, '#3c8cff'], [9, 9, 1, '#4ac8b8'], [23, 9, 1, '#4ac8b8'], [16, 33, 1, '#4ac8b8']]) {
      for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) if (x * x + y * y <= r * r + 0.5) {
        const c = x * x + y * y < r * r * 0.35 ? '#e8faff' : c0;
        pc.g.fillStyle = c; pc.g.fillRect(cx + x, cy + y, 1, 1); pe.g.fillStyle = c; pe.g.fillRect(cx + x, cy + y, 1, 1);
      }
    }
    const tm = pixelTex(pc.c), te = pixelTex(pe.c);
    for (const t of [tm, te]) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    const plaqueMat = clipped(new THREE.MeshStandardMaterial({ map: tm, emissiveMap: te, emissive: 0xffffff, emissiveIntensity: 1.3, alphaTest: 0.5, side: THREE.DoubleSide, metalness: 0.45, roughness: 0.35 }));
    const ks = [];
    for (let k = K_MIN; k < K_MAX; k++) if (((k % 2) + 2) % 2 === 0) ks.push(k);
    const plaques = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.36, 0.52), plaqueMat, ks.length);
    ks.forEach((k, j) => {
      const s2 = k + 0.5, y = (k + 1) * RISE + 0.5;
      o.position.copy(polar(R_RAIL + 0.08, s2 * DTH, y)); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1);
      o.lookAt(polar(R_RAIL + 5, s2 * DTH, y)); o.updateMatrix(); plaques.setMatrixAt(j, o.matrix);   // 朝台阶一侧，主镜头看得到
    });
    tower.add(plaques);

    const FW = 64, FH = 16, fc = makeCanvas(FW, FH);
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const t = x / FW * Math.PI * 4, wave = 8 + Math.sin(t) * 4.5;
      let on = Math.abs(y - wave) < 1.1 || y <= 1 || y >= FH - 2;
      const cx = (Math.floor(x / 16) * 16 + 8), cy = 8 + Math.sin((cx / FW) * Math.PI * 4) * -4;
      const d = Math.hypot(x - cx, (y - cy) * 1.3);
      if (Math.abs(d - 3) < 0.7) on = true;
      if (on) { fc.g.fillStyle = (y + x) % 3 ? '#e2b85c' : '#a8782e'; fc.g.fillRect(x, y, 1, 1); }
    }
    const fTex = pixelTex(fc.c); fTex.wrapT = THREE.ClampToEdgeWrapping;
    const frieze = GeoBuilder();
    for (let q = K_MIN * 4; q < K_MAX * 4; q++) {
      const s0 = q / 4, s1 = (q + 1) / 4, ta = s0 * DTH, tb = s1 * DTH, r = R_RAIL - 0.01;
      frieze.quad(polar(r, ta, railY(s0) - 0.32), polar(r, tb, railY(s1) - 0.32), polar(r, tb, railY(s1) - 0.14), polar(r, ta, railY(s0) - 0.14),
        [s0 * 0.5, 0], [s1 * 0.5, 0], [s1 * 0.5, 1], [s0 * 0.5, 1], 1.0, radial((ta + tb) / 2).negate());
    }
    tower.add(new THREE.Mesh(frieze.build(), clipped(new THREE.MeshStandardMaterial({ map: fTex, alphaTest: 0.5, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.3, emissive: 0x3a2808, emissiveIntensity: 0.8, vertexColors: true }))));
  }
}

/* ---------------- 蜡烛 + 栏杆灯球 ---------------- */
const candleK = (c) => c * 4 + 2;
function candleBase(c) { const k = candleK(c); return polar(8.15, (k + 0.5) * DTH, (k + 1) * RISE); }
const lampK = (j) => j * 8 + 4;
function lampPos(j) { const s = lampK(j) + 0.5; return polar(R_RAIL, s * DTH, railY(s) + 0.42); }
{
  const list = [];
  for (let c = Math.ceil((K_MIN - 2) / 4); candleK(c) < K_MAX; c++) list.push(candleBase(c));
  const waxMat = clipped(new THREE.MeshStandardMaterial({ color: 0xf6ead0, emissive: 0xffa060, emissiveIntensity: 0.3, roughness: 0.6 }));
  const wax = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.08, 0.32, 10), waxMat, list.length);
  const dish = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.17, 0.12, 0.05, 12), brassMat, list.length);
  const m = new THREE.Matrix4();
  list.forEach((p, i) => { m.makeTranslation(p.x, p.y + 0.185, p.z); wax.setMatrixAt(i, m); m.makeTranslation(p.x, p.y + 0.025, p.z); dish.setMatrixAt(i, m); });
  tower.add(wax, dish);
  const fp = new Float32Array(list.length * 3), fr = new Float32Array(list.length);
  list.forEach((p, i) => { fp.set([p.x, p.y + 0.44, p.z], i * 3); fr[i] = turnRand(p); });
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.BufferAttribute(fp, 3));
  fg.setAttribute('aRand', new THREE.BufferAttribute(fr, 1));
  tower.add(new THREE.Points(fg, flameMaterial(0.8)));

  const lamps = [];
  for (let j = Math.ceil((K_MIN - 4) / 8); lampK(j) < K_MAX; j++) lamps.push(j);
  // 望柱：方石柱 + 柱帽 + 铜灯笼骨架，顶上一颗辉石灯球
  const newelGeo = new THREE.BoxGeometry(0.24, 1, 0.24); newelGeo.translate(0, 0.5, 0);
  const capGeo = new THREE.BoxGeometry(0.34, 0.07, 0.34);
  const barGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.32, 4);
  const domeGeo = new THREE.ConeGeometry(0.17, 0.14, 4); domeGeo.rotateY(Math.PI / 4);
  const posts = new THREE.InstancedMesh(newelGeo, marbleMat, lamps.length), caps = new THREE.InstancedMesh(capGeo, marbleMat, lamps.length);
  const bars = new THREE.InstancedMesh(barGeo, brassMat, lamps.length * 4), domes = new THREE.InstancedMesh(domeGeo, brassMat, lamps.length);
  const orbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.1, 14, 10), clipped(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 2.6, 3.6) })), lamps.length);
  const oo = new THREE.Object3D();
  lamps.forEach((j, i) => {
    const p = lampPos(j), sIdx = lampK(j) + 0.5, base = (lampK(j) + 1) * RISE, top = p.y - 0.2;
    oo.rotation.set(0, -sIdx * DTH, 0);
    oo.position.set(p.x, base, p.z); oo.scale.set(1, top - base, 1); oo.updateMatrix(); posts.setMatrixAt(i, oo.matrix);
    oo.scale.set(1, 1, 1); oo.position.y = top + 0.035; oo.updateMatrix(); caps.setMatrixAt(i, oo.matrix);
    oo.position.y = p.y + 0.21; oo.updateMatrix(); domes.setMatrixAt(i, oo.matrix);
    for (let b = 0; b < 4; b++) {
      const a = b * Math.PI / 2 + Math.PI / 4;
      oo.position.set(p.x + Math.cos(a) * 0.12, p.y + 0.0, p.z + Math.sin(a) * 0.12); oo.updateMatrix(); bars.setMatrixAt(i * 4 + b, oo.matrix);
    }
    m.makeTranslation(p.x, p.y, p.z); orbs.setMatrixAt(i, m);
  });
  tower.add(posts, caps, bars, domes, orbs);
}

/* ---------------- 台阶靠墙一侧：蜡烛堆（带蜡泪）+ 一摞摞书（按一圈的固定花样排，保证无缝） ---------------- */
{
  const waxM = clipped(new THREE.MeshStandardMaterial({ color: 0xf2e6cc, emissive: 0xff9a50, emissiveIntensity: 0.18, roughness: 0.5 }));
  const list = [];
  for (let c = Math.ceil((K_MIN - 2) / 4); candleK(c) < K_MAX; c++) list.push(c);
  const puddleGeo = new THREE.SphereGeometry(1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const puddles = new THREE.InstancedMesh(puddleGeo, waxM, list.length * 3);
  const smallGeo = new THREE.CylinderGeometry(0.05, 0.06, 1, 8); smallGeo.translate(0, 0.5, 0);
  const smalls = new THREE.InstancedMesh(smallGeo, waxM, list.length * 2);
  const fp = new Float32Array(list.length * 2 * 3), fr = new Float32Array(list.length * 2);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  list.forEach((c, i) => {
    const p = candleBase(c), th = (candleK(c) + 0.5) * DTH, tg = tangent(th), rd = radial(th);
    m.compose(p, q, sc.set(0.3, 0.035, 0.27)); puddles.setMatrixAt(i * 3, m);
    [[0.18, 0.06, 0.2], [-0.14, 0.12, 0.13]].forEach(([ot, orr, h], j) => {
      const b = p.clone().addScaledVector(tg, ot).addScaledVector(rd, orr);
      m.compose(b, q, sc.set(1, h, 1)); smalls.setMatrixAt(i * 2 + j, m);
      m.compose(b, q, sc.set(0.13, 0.025, 0.13)); puddles.setMatrixAt(i * 3 + 1 + j, m);
      fp.set([b.x, b.y + h + 0.1, b.z], (i * 2 + j) * 3); fr[i * 2 + j] = turnRand(b);
    });
  });
  tower.add(puddles, smalls);
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.BufferAttribute(fp, 3));
  fg.setAttribute('aRand', new THREE.BufferAttribute(fr, 1));
  tower.add(new THREE.Points(fg, flameMaterial(0.55)));

  const rnd = mulberry32(900), pattern = [];
  for (let km = 0; km < SPT; km++) {
    if (km % 4 === 2 || rnd() > 0.55) continue;
    const stacks = rnd() < 0.35 ? 2 : 1;
    for (let si = 0; si < stacks; si++) {
      const n = 2 + Math.floor(rnd() * 6), books = [];
      let y = 0;
      for (let b = 0; b < n; b++) {
        const h = 0.05 + rnd() * 0.05;
        books.push({ w: 0.28 + rnd() * 0.16, d: 0.2 + rnd() * 0.12, h, y: y + h / 2, rot: (rnd() - 0.5) * 0.7, col: new THREE.Color(BOOK_COLORS[Math.floor(rnd() * BOOK_COLORS.length)]) });
        y += h;
      }
      pattern.push({ km, frac: 0.2 + rnd() * 0.6, r: 8.05 + rnd() * 0.25 - si * 0.45, books });
    }
  }
  const items = [];
  for (let T = Math.floor(K_MIN / SPT); T <= Math.floor((K_MAX - 1) / SPT); T++) for (const P of pattern) {
    const k = T * SPT + P.km;
    if (k < K_MIN || k >= K_MAX) continue;
    const th = (k + P.frac) * DTH, base = polar(P.r, th, (k + 1) * RISE);
    for (const b of P.books) items.push({ base, th, b });
  }
  const slabs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), clipped(new THREE.MeshStandardMaterial({ roughness: 0.7 })), items.length * 3);
  const leaves = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), clipped(new THREE.MeshStandardMaterial({ color: 0xe6d8b6, roughness: 0.9, emissive: 0x2a2014, emissiveIntensity: 0.5 })), items.length);
  const bookM = new THREE.Matrix4(), part = new THREE.Matrix4();
  items.forEach(({ base, th, b }, i) => {
    bookM.makeRotationY(-th + b.rot).setPosition(base.x, base.y + b.y, base.z);
    const parts = [[0, -b.h / 2 + 0.007, 0, b.w, 0.014, b.d], [0, b.h / 2 - 0.007, 0, b.w, 0.014, b.d], [-b.w / 2 + 0.008, 0, 0, 0.016, b.h, b.d]];
    parts.forEach(([x, y, z, sx, sy, sz], j) => {
      part.compose(sc.set(x, y, z).clone(), q, new THREE.Vector3(sx, sy, sz));
      slabs.setMatrixAt(i * 3 + j, m.multiplyMatrices(bookM, part)); slabs.setColorAt(i * 3 + j, b.col);
    });
    part.compose(new THREE.Vector3(0.004, 0, 0), q, new THREE.Vector3(b.w - 0.022, b.h - 0.026, b.d - 0.022));
    leaves.setMatrixAt(i, m.multiplyMatrices(bookM, part));
  });
  tower.add(slabs, leaves);
}

/* ---------------- 墙上的油画（微微前倾）+ 拱廊下托座上的兜帽石像 ---------------- */
{
  const turnsFrom = Math.floor(Y_MIN / TURN_H), turnsTo = Math.ceil(Y_MAX / TURN_H);
  const SLOTS = [{ f: 0.12, kind: 0 }, { f: 0.43, kind: 1 }, { f: 0.72, kind: 2 }];
  const paintMeshes = [0, 1, 2].map((kind) => {
    const tx = pixelTex(makePaintingCanvas(kind)); tx.wrapS = tx.wrapT = THREE.ClampToEdgeWrapping;
    return new THREE.InstancedMesh(new THREE.PlaneGeometry(1.5, 1.875),
      clipped(new THREE.MeshStandardMaterial({ map: tx, roughness: 0.65, emissive: 0x20160a, emissiveIntensity: 0.5 })), turnsTo - turnsFrom + 1);
  });
  const counts = [0, 0, 0], o = new THREE.Object3D();
  for (let T = turnsFrom; T <= turnsTo; T++) for (const S of SLOTS) {
    const th = S.f * Math.PI * 2, y = T * TURN_H + S.f * TURN_H + 3.7;
    o.position.copy(polar(8.32, th, y)); o.lookAt(0, y, 0); o.rotateX(0.12); o.updateMatrix();
    paintMeshes[S.kind].setMatrixAt(counts[S.kind]++, o.matrix);
  }
  paintMeshes.forEach((pm, i) => { pm.count = counts[i]; tower.add(pm); });

  const statMat = clipped(new THREE.SpriteMaterial({ map: spriteTex(makeStatueCanvas()), alphaTest: 0.5, color: 0xb4bcd4, fog: true }));
  const corbelGeo = new THREE.BoxGeometry(0.62, 0.22, 0.55);
  const corbels = new THREE.InstancedMesh(corbelGeo, stoneColMat, (turnsTo - turnsFrom + 1) * 3);
  let ci = 0;
  for (let T = turnsFrom; T <= turnsTo; T++) for (const pi of [1, 5, 9]) {
    const th = (pi + 0.5) * Math.PI * 2 / 20, y = T * TURN_H + ROW_H * 6;
    o.position.copy(polar(8.25, th, y - 0.11)); o.rotation.set(0, Math.PI / 2 - th, 0); o.scale.set(1, 1, 1); o.updateMatrix(); corbels.setMatrixAt(ci++, o.matrix);
    const st = new THREE.Sprite(statMat);
    st.center.set(0.5, 0); st.scale.set(0.85, 1.7, 1); st.position.copy(polar(8.2, th, y));
    tower.add(st);
  }
  tower.add(corbels);
}

/* ---------------- 辉石（书房和塔共用）：小、哑光、带像素颗粒的蓝色六棱晶柱，只透一点点光 ---------------- */
function makeGlintCanvas() {
  const S2 = 16, { c, g } = makeCanvas(S2, S2), r = mulberry32(55);
  const P = ['#1a3a7a', '#2a5ab0', '#3c78d0', '#5aa0ea', '#9fd2ff'];
  for (let y = 0; y < S2; y += 2) for (let x = 0; x < S2; x += 2) {   // 2×2 的像素块，不是逐像素噪点
    const k = r() < 0.12 ? 4 : r() < 0.3 ? 3 : r() < 0.6 ? 2 : r() < 0.85 ? 1 : 0;
    g.fillStyle = P[k]; g.fillRect(x, y, 2, 2);
  }
  for (let y = 0; y < S2; y++) { g.fillStyle = '#c8ecff'; if (y % 5 === 0) g.fillRect(7, y, 1, 2); }
  return c;
}
const glintTex = pixelTex(makeGlintCanvas());
const glintGeometry = new THREE.LatheGeometry([[0, 0], [0.5, 0.02], [0.5, 0.64], [0, 1]].map(([r2, h]) => new THREE.Vector2(r2, h)), 6);
function makeGlintMaterial() {
  return new THREE.MeshStandardMaterial({ map: glintTex, emissiveMap: glintTex, emissive: 0xffffff, emissiveIntensity: 0.28, roughness: 0.78, metalness: 0, flatShading: true });
}

/* ---------------- 辉石：台阶外沿和书架隔板上长出来的小结晶簇（随塔周期排布），偶尔冒一点碎屑 ---------------- */
const glintMat = clipped(makeGlintMaterial());
{
  const r = mulberry32(777), stairPat = [], shelfPat = [];
  for (let km = 0; km < SPT; km++) {
    if (km % 4 === 2 || r() > 0.42) continue;
    stairPat.push({ km, frac: 0.2 + r() * 0.6, rr: 7.55 + r() * 0.6, size: 0.18 + r() * 0.22, n: 4 + Math.floor(r() * 5), seed: r() });
  }
  for (let i = 0; i < 16; i++) shelfPat.push({ th: r() * Math.PI * 2, row: Math.floor(r() * 8), size: 0.14 + r() * 0.16, n: 3 + Math.floor(r() * 3), seed: r() });
  const items = [], sites = [];
  const cluster = (base, size, n, seed) => {
    const rr = mulberry32(Math.floor(seed * 1e6) + 1);
    sites.push(base.clone().add(new THREE.Vector3(0, size * 0.35, 0)));
    for (let i = 0; i < n; i++) {
      const a = rr() * Math.PI * 2, tilt = i ? 0.2 + rr() * 0.55 : rr() * 0.12, h = (0.5 + rr() * 0.5) * size * (i ? 1 : 1.45), off = i ? 0.07 * size : 0;
      items.push({ p: base.clone().add(new THREE.Vector3(Math.cos(a) * off, 0, Math.sin(a) * off)), a, tilt, h, w: h * (0.16 + rr() * 0.1) });
    }
  };
  for (let T = Math.floor(K_MIN / SPT); T <= Math.floor((K_MAX - 1) / SPT); T++) {
    for (const P of stairPat) { const k = T * SPT + P.km; if (k >= K_MIN && k < K_MAX) cluster(polar(P.rr, (k + P.frac) * DTH, (k + 1) * RISE), P.size, P.n, P.seed); }
    for (const S of shelfPat) { const y = T * TURN_H + S.row * ROW_H + 0.125; if (y > Y_MIN && y < Y_MAX) cluster(polar(8.76, S.th, y), S.size, S.n, S.seed); }
  }
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const cr = new THREE.InstancedMesh(glintGeometry, glintMat, items.length);
  items.forEach((c, i) => {
    e.set(Math.cos(c.a) * c.tilt, c.a, Math.sin(c.a) * c.tilt); q.setFromEuler(e);
    M.compose(c.p, q, new THREE.Vector3(c.w * 1.4, c.h * 0.8, c.w * 1.4)); cr.setMatrixAt(i, M);
  });
  tower.add(cr);
  const PER = 5, N = sites.length * PER, pos = new Float32Array(N * 3), rnd2 = new Float32Array(N);
  sites.forEach((st, i) => { for (let j = 0; j < PER; j++) { pos.set([st.x, st.y, st.z], (i * PER + j) * 3); rnd2[i * PER + j] = turnRand(st, j); } });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aRand', new THREE.BufferAttribute(rnd2, 1));
  const sparks = new THREE.Points(g, pointsMaterial(COMMON_GLSL + /* glsl */`
    attribute float aRand;
    varying vec3 vColor; varying float vAlpha;
    void main(){
      bool haloPt = aRand < 0.09;                                  // 每簇挑一两个点当柔光晕
      float life = fract(uTime*(0.2 + 0.25*aRand) + aRand*17.0);
      vec3 p = haloPt ? position : position + vec3(sin(aRand*40.0)*0.25*life, life*(1.0 + aRand*1.4), cos(aRand*27.0)*0.25*life);
      vec4 w = modelMatrix*vec4(p,1.0);
      vec4 mv = viewMatrix*w;
      gl_Position = projectionMatrix*mv;
      float tw = pow(0.5 + 0.5*sin(uTime*(3.0 + aRand*6.0) + aRand*70.0), 3.0);
      vColor = haloPt ? vec3(0.15,0.3,0.7) : mix(vec3(0.45,0.8,1.0), vec3(0.9,0.97,1.0), tw) * (0.9 + tw*1.0);
      vAlpha = (haloPt ? 0.12 : sin(life*3.14159)*(0.35 + tw*0.6)) * fogF(-mv.z) * step(w.y, uClipY);
      gl_PointSize = w.y > uClipY ? 0.0 : max(1.5, pxSize(haloPt ? 1.1 : 0.04 + 0.04*tw, -mv.z));
    }`));
  sparks.frustumCulled = false;
  tower.add(sparks); fxObjects.push(sparks);
}

/* ---------------- 两串吊灯垂入深井（随塔周期排布） ---------------- */
{
  const chR = 4.05, ringR = 0.6, CANDLES = 8;
  const spots = [];
  for (const [th, yOff] of [[0.9, 6.2], [0.9 + Math.PI, 1.2]]) for (let turn = -3; turn <= 8; turn++) spots.push(polar(chR, th, turn * TURN_H + yOff));
  const ringGeo = new THREE.TorusGeometry(ringR, 0.045, 6, 40); ringGeo.rotateX(Math.PI / 2);
  const ring2Geo = new THREE.TorusGeometry(0.32, 0.035, 6, 24); ring2Geo.rotateX(Math.PI / 2); ring2Geo.translate(0, 0.32, 0);
  const bowlGeo = new THREE.ConeGeometry(0.26, 0.55, 12); bowlGeo.rotateX(Math.PI); bowlGeo.translate(0, -0.28, 0);
  const chainGeo = new THREE.CylinderGeometry(0.018, 0.018, TURN_H, 4); chainGeo.translate(0, TURN_H / 2 + 0.32, 0);
  const armGeo = new THREE.BoxGeometry(ringR * 2, 0.03, 0.03); armGeo.translate(0, 0.12, 0);
  const parts = [ringGeo, ring2Geo, bowlGeo, chainGeo].map((gg) => new THREE.InstancedMesh(gg, brassMat, spots.length));
  const arms = new THREE.InstancedMesh(armGeo, brassMat, spots.length * 2);
  const cand = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.04, 0.2, 8),
    clipped(new THREE.MeshStandardMaterial({ color: 0xf6ead0, emissive: 0xffa060, emissiveIntensity: 0.4 })), spots.length * CANDLES);
  const fp = new Float32Array(spots.length * CANDLES * 3), fr = new Float32Array(spots.length * CANDLES);
  const m = new THREE.Matrix4(), o = new THREE.Object3D();
  spots.forEach((p, i) => {
    m.makeTranslation(p.x, p.y, p.z); parts.forEach((pp) => pp.setMatrixAt(i, m));
    for (const k of [0, 1]) { o.position.copy(p); o.rotation.set(0, k * Math.PI / 2, 0); o.updateMatrix(); arms.setMatrixAt(i * 2 + k, o.matrix); }
    for (let c = 0; c < CANDLES; c++) {
      const a = c / CANDLES * Math.PI * 2, q = p.clone().add(new THREE.Vector3(ringR * Math.cos(a), 0.1, ringR * Math.sin(a)));
      m.makeTranslation(q.x, q.y, q.z); cand.setMatrixAt(i * CANDLES + c, m);
      fp.set([q.x, q.y + 0.2, q.z], (i * CANDLES + c) * 3); fr[i * CANDLES + c] = turnRand(q);
    }
  });
  tower.add(...parts, arms, cand);
  const tierGeo = new THREE.TorusGeometry(0.36, 0.03, 6, 28); tierGeo.rotateX(Math.PI / 2); tierGeo.translate(0, -0.34, 0);
  const spikeGeo = new THREE.ConeGeometry(0.06, 0.42, 6); spikeGeo.rotateX(Math.PI); spikeGeo.translate(0, -0.76, 0);
  const tiers = new THREE.InstancedMesh(tierGeo, brassMat, spots.length), spikes = new THREE.InstancedMesh(spikeGeo, brassMat, spots.length);
  const crystalMat = clipped(new THREE.MeshStandardMaterial({ color: 0xd8ecff, emissive: 0x4a7ab0, emissiveIntensity: 0.9, metalness: 0.2, roughness: 0.12, flatShading: true }));
  const CR = 16, crystals = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.045), crystalMat, spots.length * CR);
  const qq = new THREE.Quaternion(), ss = new THREE.Vector3(1, 1.9, 1);
  spots.forEach((p, i) => {
    m.makeTranslation(p.x, p.y, p.z); tiers.setMatrixAt(i, m); spikes.setMatrixAt(i, m);
    for (let j = 0; j < CR; j++) {
      const outer = j < 10, a = (outer ? j / 10 : (j - 10) / 6) * Math.PI * 2 + 0.3;
      const rr = outer ? ringR : 0.36, yy = outer ? -0.13 - (j % 2) * 0.07 : -0.44;
      m.compose(new THREE.Vector3(p.x + Math.cos(a) * rr, p.y + yy, p.z + Math.sin(a) * rr), qq, ss);
      crystals.setMatrixAt(i * CR + j, m);
    }
  });
  tower.add(tiers, spikes, crystals);
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.BufferAttribute(fp, 3));
  fg.setAttribute('aRand', new THREE.BufferAttribute(fr, 1));
  tower.add(new THREE.Points(fg, flameMaterial(0.55)));
}

/* ---------------- 塔冠：开口边缘一圈尖塔（跟着镜头走，盖住裁剪切口） ---------------- */
const crown = new THREE.Group();
{
  const mat = new THREE.MeshStandardMaterial({ color: 0x3c465e, roughness: 0.9, flatShading: true });
  const band = new THREE.LatheGeometry([new THREE.Vector2(8.25, -0.6), new THREE.Vector2(9.8, -0.6), new THREE.Vector2(9.8, 1.6), new THREE.Vector2(8.25, 1.6), new THREE.Vector2(8.25, -0.6)], 120);
  crown.add(new THREE.Mesh(band, new THREE.MeshStandardMaterial({ color: 0x3c465e, roughness: 0.9, flatShading: true, side: THREE.DoubleSide })));
  const o = new THREE.Object3D();
  const merlon = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.7, 0.45), mat, 48);
  for (let i = 0; i < 48; i++) { const th = i / 48 * Math.PI * 2; o.position.copy(polar(8.45, th, 1.95)); o.rotation.set(0, Math.PI / 2 - th, 0); o.updateMatrix(); merlon.setMatrixAt(i, o.matrix); }
  const spire = new THREE.InstancedMesh(new THREE.ConeGeometry(0.34, 5.5, 6), mat, 20);
  const base = new THREE.InstancedMesh(new THREE.BoxGeometry(0.75, 1.4, 0.75), mat, 20);
  const pinn = new THREE.InstancedMesh(new THREE.ConeGeometry(0.16, 2.4, 5), mat, 20);
  const finial = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.7, 0.8) }), 20);
  for (let i = 0; i < 20; i++) {
    const th = (i + 0.5) / 20 * Math.PI * 2, th2 = i / 20 * Math.PI * 2;
    o.rotation.set(0, Math.PI / 2 - th, 0);
    o.position.copy(polar(8.9, th, 2.3)); o.updateMatrix(); base.setMatrixAt(i, o.matrix);
    o.position.copy(polar(8.9, th, 5.75)); o.updateMatrix(); spire.setMatrixAt(i, o.matrix);
    o.position.copy(polar(8.9, th, 8.55)); o.updateMatrix(); finial.setMatrixAt(i, o.matrix);
    o.position.copy(polar(8.55, th2, 3.4)); o.updateMatrix(); pinn.setMatrixAt(i, o.matrix);
  }
  crown.add(merlon, spire, base, pinn, finial);
}
scene.add(crown);

/* ---------------- 星辉仪：天井上空的巨大仪器，三层金环 + 辉石核心 ---------------- */
const armillary = new THREE.Group();
const armRings = [];
{
  const gold = new THREE.MeshStandardMaterial({ color: 0xe0b860, metalness: 0.7, roughness: 0.3, emissive: 0x4a3010, emissiveIntensity: 0.9 });
  [2.9, 2.35, 1.85].forEach((R, i) => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.TorusGeometry(R, 0.06, 8, 160), gold));
    const runeMat = new THREE.MeshBasicMaterial({
      map: pixelTex(makeRuneCanvas(40 + i, true), 4, 1), color: new THREE.Color(...[[0.6, 1.8, 2.8], [2.6, 1.8, 0.8], [1.6, 1.2, 2.8]][i]),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const band = new THREE.Mesh(annulus(R - 0.16, R - 0.06, 160, 4), runeMat);
    band.rotation.x = Math.PI / 2;
    g.add(band);
    const planet = new THREE.Mesh(new THREE.SphereGeometry(0.16 + i * 0.04, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(...[[2.4, 1.2, 0.6], [0.8, 2.2, 2.6], [2.2, 2.0, 1.4]][i]) }));
    planet.position.set(R, 0, 0);
    g.add(planet);
    armillary.add(g); armRings.push(g);
  });
  armillary.add(new THREE.Mesh(new THREE.SphereGeometry(0.7, 32, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.4, 2.6, 4.2) })));
}
scene.add(armillary); fxObjects.push(armillary);

function annulus(r0, r1, seg, uRep = 6) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pos.push(r0 * Math.cos(a), 0, r0 * Math.sin(a), r1 * Math.cos(a), 0, r1 * Math.sin(a));
    uv.push(i / seg * uRep, 0, i / seg * uRep, 1);
    if (i < seg) { const b = i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/* ---------------- 灯光 ---------------- */
scene.add(new THREE.HemisphereLight(0x7090c0, 0x2a2018, 0.95));
const CANDLE_LIGHTS = 4, LAMP_LIGHTS = 2;
const candleLights = Array.from({ length: CANDLE_LIGHTS }, () => { const l = new THREE.PointLight(0xff9a4a, 0, 0, 2); scene.add(l); return l; });
const lampLights = Array.from({ length: LAMP_LIGHTS }, () => { const l = new THREE.PointLight(0x9ad0ff, 0, 0, 2); scene.add(l); return l; });
const LAMP_COL = new THREE.Color(0x9ad0ff), WELL_COL = new THREE.Color(0x9ad8ff), LAMP_GOLD = new THREE.Color(0xffc98a);   // 乐谱落到大调（mood gold）时灯转暖
const wellLight = new THREE.PointLight(0x9ad8ff, 16, 0, 2); scene.add(wellLight);
const deepLight = new THREE.PointLight(0x5a8cff, 22, 0, 2); scene.add(deepLight);
const moonLight = new THREE.DirectionalLight(0xb4d0ff, 0.9); scene.add(moonLight, moonLight.target);   // 天顶满月往井里打的冷光   // 井底往上打的冷光，照亮台阶底面和飞书封面
const armLight = new THREE.PointLight(0x7ab8ff, 70, 0, 2); scene.add(armLight);
const swordLight = new THREE.PointLight(0x6aaeff, 3, 0, 2); scene.add(swordLight);
const flashLight = new THREE.PointLight(0xbfe4ff, 0, 0, 2); scene.add(flashLight);

/* ============================================================
 * 天井里的奇景
 * ============================================================ */
const camYU = { value: 0 }, camSU = { value: 0 };
const softWhite = new THREE.CanvasTexture(makeSoftCanvas('rgba(255,255,255,1)', 'rgba(255,255,255,0)'));
const armGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softWhite, color: new THREE.Color(0.5, 1.2, 2.4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
armGlow.scale.setScalar(7);
armillary.add(armGlow);

/* 符文光环：各不相同的宽度/颜色/纹样，一个竖着转 */
const RINGS = [
  { r: 3.9, w: 0.5, y: 0, spin: 0.12, tilt: 0.08, col: [0.6, 1.6, 2.2], seed: 21 },
  { r: 2.4, w: 0.28, y: 9, spin: -0.3, tilt: -0.12, col: [2.4, 1.0, 2.2], seed: 22 },
  { r: 3.5, w: 0.7, y: 17, spin: 0.06, tilt: 0.05, col: [2.4, 1.7, 0.7], seed: 23 },
  { r: 1.6, w: 0.22, y: 25, spin: 0.5, tilt: 1.57, col: [0.8, 2.2, 1.4], seed: 24 },
];
const ringSpan = 34;
const ringMeshes = RINGS.map((R) => {
  const tex = pixelTex(makeRuneCanvas(R.seed, R.w > 0.4)); tex.wrapT = THREE.ClampToEdgeWrapping;
  const mesh = new THREE.Mesh(annulus(R.r - R.w / 2, R.r + R.w / 2, 128), new THREE.MeshBasicMaterial({
    map: tex, color: new THREE.Color(...R.col), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
  scene.add(mesh); fxObjects.push(mesh);
  return mesh;
});

/* 飞书：6 个书群跟着领头书飞 + 4 本慢悠悠的巨型魔典。
 * 结构按真书来：书脊在中间，两片封面朝外（烫金纹样在外侧、朝下），内侧是大理石纹衬纸，
 * 书页贴着封面内侧扇开、比封面慢半拍，像鸟扇翅膀。 */
const FLOCKS = 6, PER_FLOCK = 5, GIANTS = 4, BOOKS_N = FLOCKS * PER_FLOCK + GIANTS, SHEETS = 3;
const coverTex = pixelTex(makeCoverCanvas()); coverTex.wrapS = coverTex.wrapT = THREE.ClampToEdgeWrapping;
const endTex = pixelTex(makeEndpaperCanvas()); endTex.wrapS = endTex.wrapT = THREE.ClampToEdgeWrapping;
const coverGeo = new THREE.BoxGeometry(0.32, 0.022, 0.44); coverGeo.translate(0.16, 0, 0);
const edgeMat = new THREE.MeshStandardMaterial({ color: 0x8a7c6a, roughness: 0.7 });
const coverMats = [edgeMat, edgeMat,
  new THREE.MeshStandardMaterial({ map: endTex, roughness: 0.9, emissive: 0x2a2418, emissiveIntensity: 0.5 }),          // +y 内侧衬纸
  new THREE.MeshStandardMaterial({ map: coverTex, roughness: 0.55, emissive: 0x6a5a48, emissiveMap: coverTex, emissiveIntensity: 0.35 }),   // -y 外侧封面
  edgeMat, edgeMat];
const covers = new THREE.InstancedMesh(coverGeo, coverMats, BOOKS_N * 2);
const sheetGeo = new THREE.PlaneGeometry(0.29, 0.41); sheetGeo.rotateX(-Math.PI / 2); sheetGeo.translate(0.155, 0.013, 0);
const sheets = new THREE.InstancedMesh(sheetGeo, new THREE.MeshStandardMaterial({ map: pixelTex(makePageCanvas()), color: 0xfff6e0, roughness: 0.9, emissive: 0x3a3020, emissiveIntensity: 0.7, side: THREE.DoubleSide }), BOOKS_N * 2 * SHEETS);
const spines = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.026, 0.026, 0.44, 8).rotateX(Math.PI / 2), edgeMat, BOOKS_N);
covers.frustumCulled = sheets.frustumCulled = spines.frustumCulled = false;
const leaders = Array.from({ length: FLOCKS + GIANTS }, (_, i) => {
  const r = mulberry32(100 + i), giant = i >= FLOCKS;
  return {
    th: r() * Math.PI * 2, w: (giant ? 0.08 + r() * 0.06 : 0.22 + r() * 0.2) * (r() < 0.5 ? -1 : 1),
    r0: giant ? 1.4 + r() * 1.4 : 1.6 + r() * 2.2, y0: r() * 34, vy: giant ? 0.1 + r() * 0.1 : -0.3 + r() * 0.8, ph: r() * 100,
  };
});
const flyers = Array.from({ length: BOOKS_N }, (_, i) => {
  const r = mulberry32(200 + i), giant = i >= FLOCKS * PER_FLOCK;
  const col = new THREE.Color(BOOK_COLORS[Math.floor(r() * BOOK_COLORS.length)]);
  covers.setColorAt(i * 2, col); covers.setColorAt(i * 2 + 1, col); spines.setColorAt(i, col);
  return {
    lead: giant ? FLOCKS + (i - FLOCKS * PER_FLOCK) : Math.floor(i / PER_FLOCK),
    off: giant ? new THREE.Vector3() : new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(2.2),
    ph: r() * 100, flap: giant ? 2.2 + r() : 7 + r() * 5, s: giant ? 2.6 + r() * 0.8 : 0.7 + r() * 0.5,
  };
});
covers.instanceColor.needsUpdate = true; spines.instanceColor.needsUpdate = true;
scene.add(covers, sheets, spines); fxObjects.push(covers, sheets, spines);

function leaderPos(L, t, camY, out) {
  const th = L.th + L.w * t + 0.25 * Math.sin(t * 0.5 + L.ph);
  const r = Math.min(4.3, L.r0 + 0.6 * Math.sin(t * 0.37 + L.ph * 2));
  const y = wrap(L.y0 + L.vy * t, camY - 12, 36) + 0.6 * Math.sin(t * 0.8 + L.ph);
  return out.copy(polar(r, th, y));
}

/* 天井里漂浮、自转的辉石碎片（带一点光晕），围着镜头高度循环 */
const SHARD_N = 44;
const shardMat = makeGlintMaterial(); shardMat.emissiveIntensity = 0.5;
const shards = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), shardMat, SHARD_N);
shards.frustumCulled = false;
const shardSeeds = Array.from({ length: SHARD_N }, (_, i) => { const r = mulberry32(900 + i); return { th: r() * Math.PI * 2, r: 0.8 + r() * 3.5, y0: r() * 30, vy: 0.15 + r() * 0.4, w: (r() - 0.5) * 0.3, s: 0.04 + r() * 0.08, ph: r() * 10 }; });
const shardGlowPos = new Float32Array(SHARD_N * 3), shardGlowRnd = new Float32Array(SHARD_N).map(() => Math.random());
const shardGlowGeo = new THREE.BufferGeometry();
shardGlowGeo.setAttribute('position', new THREE.BufferAttribute(shardGlowPos, 3));
shardGlowGeo.setAttribute('aRand', new THREE.BufferAttribute(shardGlowRnd, 1));
const shardGlow = new THREE.Points(shardGlowGeo, pointsMaterial(COMMON_GLSL + /* glsl */`
  attribute float aRand;
  varying vec3 vColor; varying float vAlpha;
  void main(){
    vec4 mv = viewMatrix*vec4(position,1.0);
    gl_Position = projectionMatrix*mv;
    vColor = vec3(0.35,0.7,1.4);
    vAlpha = (0.12 + 0.08*sin(uTime*2.0 + aRand*30.0)) * fogF(-mv.z);
    gl_PointSize = pxSize(0.5 + aRand*0.3, -mv.z);
  }`));
shardGlow.frustumCulled = false;
scene.add(shards, shardGlow); fxObjects.push(shards, shardGlow);
function updateShards(t, camY) {
  const o = dummy;
  shardSeeds.forEach((sd, i) => {
    const y = wrap(sd.y0 + t * sd.vy, camY - 10, 30);
    const p = polar(sd.r + 0.3 * Math.sin(t * 0.4 + sd.ph), sd.th + t * sd.w, y);
    o.position.copy(p); o.rotation.set(t * 0.7 + sd.ph, t * 1.1 + sd.ph, 0); o.scale.set(sd.s, sd.s * 2.3, sd.s); o.updateMatrix();
    shards.setMatrixAt(i, o.matrix);
    shardGlowPos.set([p.x, p.y, p.z], i * 3);
  });
  shards.instanceMatrix.needsUpdate = true;
  shardGlowGeo.attributes.position.needsUpdate = true;
}

/* 拖尾系统（精灵、彗星共用）：CPU 记录历史位置，GPU 画点 */
function makeTrails(N, L, headSize, tailSize, gain) {
  const pos = new Float32Array(N * L * 3), info = new Float32Array(N * L * 4);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
  const points = new THREE.Points(geo, pointsMaterial(COMMON_GLSL + /* glsl */`
    attribute vec4 aInfo;
    varying vec3 vColor; varying float vAlpha;
    void main(){
      float k = aInfo.w;
      vec3 p = position + vec3(sin(k*30.0+uTime*3.0), cos(k*23.0+uTime*2.0), sin(k*17.0-uTime*2.5)) * 0.07 * k;
      vec4 mv = viewMatrix*vec4(p,1.0);
      gl_Position = projectionMatrix*mv;
      vColor = mix(vec3(1.0), aInfo.rgb, 0.35 + 0.65*k) * ${gain.toFixed(2)};
      vAlpha = (k >= 1.0 ? 0.0 : pow(1.0 - k, 1.5)) * fogF(-mv.z) * (0.7 + 0.3*sin(uTime*14.0 + k*40.0));
      gl_PointSize = max(1.5, pxSize(mix(${headSize.toFixed(3)}, ${tailSize.toFixed(3)}, k), -mv.z));
    }`));
  points.frustumCulled = false;
  const hist = Array.from({ length: N }, () => []), cols = Array.from({ length: N }, () => [1, 1, 1]);
  return {
    points, hist, cols,
    push(i, p) { const h = hist[i]; if (h.length && h[0].distanceToSquared(p) > 9) h.length = 0; h.unshift(p.clone()); if (h.length > L) h.length = L; },
    flush() {
      for (let i = 0; i < N; i++) {
        const h = hist[i], c = cols[i];
        for (let j = 0; j < L; j++) {
          const o = i * L + j, q = h[Math.min(j, h.length - 1)];
          if (q) pos.set([q.x, q.y, q.z], o * 3);
          info.set([c[0], c[1], c[2], j < h.length ? j / L : 1], o * 4);
        }
      }
      geo.attributes.position.needsUpdate = true; geo.attributes.aInfo.needsUpdate = true;
    },
  };
}

/* 精灵：两种——带翅膀的小精灵、拖长尾的鬼火 */
const fairyFrames = makeFairyFrames().map(spriteTex);
const FAIRY_COLORS = [[1.0, 0.55, 0.9], [0.5, 0.95, 1.0], [1.0, 0.85, 0.45], [0.55, 1.0, 0.65], [0.8, 0.65, 1.0]];
const FAIRY_N = 12;
const fairyTrails = makeTrails(FAIRY_N, 48, 0.09, 0.02, 1.8);
scene.add(fairyTrails.points); fxObjects.push(fairyTrails.points);
const fairies = Array.from({ length: FAIRY_N }, (_, i) => {
  const r = mulberry32(300 + i), wisp = i >= 8, col = wisp ? [0.55, 0.9, 1.0] : FAIRY_COLORS[i % FAIRY_COLORS.length];
  fairyTrails.cols[i] = col;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: fairyFrames[0], transparent: true, alphaTest: 0.05, color: new THREE.Color(1.5, 1.5, 1.5), depthWrite: false }));
  const s = wisp ? 0 : 0.3 + r() * 0.2;
  sp.scale.set(s, s, 1); sp.visible = !wisp;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softWhite, color: new THREE.Color(col[0] * 1.4, col[1] * 1.4, col[2] * 1.4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.scale.setScalar(wisp ? 0.6 : 0.45);
  scene.add(glow, sp); fxObjects.push(glow, sp);
  return {
    sp, glow, wisp, th: r() * Math.PI * 2, w: (wisp ? 0.12 + r() * 0.1 : 0.3 + r() * 0.5) * (r() < 0.5 ? -1 : 1),
    y0: r() * 30, vy: (r() - 0.4) * (wisp ? 0.3 : 0.7), ph: r() * 100, ph2: r() * 100, spd: wisp ? 0.6 : 0.9 + r() * 0.8,
  };
});
function fairyPos(f, t, camY, out) {
  const tt = t * f.spd;
  const th = f.th + f.w * t + 0.8 * Math.sin(tt * 0.9 + f.ph);
  const r = 0.6 + 3.4 * (0.5 + 0.5 * Math.sin(tt * 0.33 + f.ph2));
  const y = wrap(f.y0 + f.vy * t, camY - 8, 28) + 1.1 * Math.sin(tt * 1.1 + f.ph) + (f.wisp ? 0 : 0.2 * Math.sin(tt * 5.3 + f.ph2));
  return out.copy(polar(r, th, y));
}
// （原来还有一群绕着骑士转的萤火虫：贴着他打转像一团蚊子，去掉了；他脚下每一步的辉光还在）

/* 灵光巨蛇：粒子组成的长蛇绕天井游动（一条辉石蓝、一条熔金红），带背鳍 */
function makeSerpent(o) {
  const N = 4200, body = new Float32Array(N), ang = new Float32Array(N), rad = new Float32Array(N), rnd = new Float32Array(N);
  for (let i = 0; i < N; i++) { body[i] = Math.pow(Math.random(), 1.15); ang[i] = Math.random() * Math.PI * 2; rad[i] = Math.sqrt(Math.random()); rnd[i] = Math.random(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  g.setAttribute('aBody', new THREE.BufferAttribute(body, 1));
  g.setAttribute('aAng', new THREE.BufferAttribute(ang, 1));
  g.setAttribute('aRad', new THREE.BufferAttribute(rad, 1));
  g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
  const pts = new THREE.Points(g, pointsMaterial(COMMON_GLSL + NOISE_GLSL + /* glsl */`
    attribute float aBody; attribute float aAng; attribute float aRad; attribute float aRand;
    uniform float uCamY;
    varying vec3 vColor; varying float vAlpha;
    const float SPAN = 64.0;
    vec3 path(float t){
      float th = t*${o.spin.toFixed(3)} + ${o.ph.toFixed(3)};
      float r = ${o.r0.toFixed(3)} + 0.9*sin(t*0.37 + ${o.ph.toFixed(3)}*2.0);
      float y = mod(t*${o.vy.toFixed(3)} + ${(o.ph * 20).toFixed(3)}, SPAN);
      return vec3(r*cos(th), y, r*sin(th));
    }
    void main(){
      float t = uTime - aBody*${o.len.toFixed(3)};
      vec3 c = path(t);
      float rel = c.y / SPAN;
      c.y += uCamY - 24.0;
      vec3 ahead = path(t + 0.03); ahead.y += uCamY - 24.0;
      vec3 T = ahead - c; if (dot(T,T) > 4.0) T = vec3(0.0,1.0,0.0);
      T = normalize(T);
      vec3 N = normalize(cross(T, vec3(0.0,1.0,0.0)) + vec3(1e-4));
      vec3 B = cross(N, T);
      float w = ${o.thick.toFixed(3)} * (aBody < 0.06 ? mix(0.7, 1.2, aBody/0.06) : pow(1.0 - aBody, 0.8));
      float fin = step(0.75, fract(aBody*16.0)) * step(0.0, sin(aAng)) * (1.0 - aBody);
      vec3 off = (cos(aAng)*N + sin(aAng)*B) * w * aRad * (1.0 + fin*1.6*aRad);
      vec3 p = c + off + curlNoise(c*0.4 + uTime*0.2) * 0.2 * aBody;
      vec4 mv = viewMatrix*vec4(p,1.0);
      gl_Position = projectionMatrix*mv;
      float head = 1.0 - smoothstep(0.0, 0.08, aBody);
      vec3 c0 = vec3${o.c0}, c1 = vec3${o.c1};
      vColor = mix(c0, c1, aBody) * (1.0 + 2.5*head + 0.6*(1.0 - aRad));
      vAlpha = (0.55 + 0.45*sin(uTime*7.0 + aRand*60.0)) * fogF(-mv.z) * smoothstep(0.0, 0.06, rel) * (1.0 - smoothstep(0.9, 1.0, rel))
             * smoothstep(1.0, 3.0, -mv.z) * (1.0 - aBody*0.6);
      gl_PointSize = max(1.5, pxSize(mix(0.09, 0.03, aBody) * (0.6 + 0.8*aRand), -mv.z));
    }`, SOFT_POINT_FRAG, { uCamY: camYU }));
  pts.frustumCulled = false;
  scene.add(pts); fxObjects.push(pts);
}
makeSerpent({ spin: 0.55, ph: 0.0, r0: 2.6, vy: 1.6, len: 5.5, thick: 0.38, c0: '(0.85,0.97,1.0)', c1: '(0.3,0.5,1.0)' });
makeSerpent({ spin: -0.42, ph: 1.7, r0: 3.0, vy: 1.1, len: 4.5, thick: 0.3, c0: '(1.0,0.9,0.55)', c1: '(1.0,0.25,0.12)' });

/* 爆炸/汇聚粒子池：彗星撞击、骑士蓄力都用它 */
const MAX_B = 40, P_PER = 160;
const bO = Array.from({ length: MAX_B }, () => new THREE.Vector3()), bT = new Array(MAX_B).fill(-100);
const bC = Array.from({ length: MAX_B }, () => new THREE.Vector3(1, 1, 1)), bS = new Array(MAX_B).fill(1), bK = new Array(MAX_B).fill(0);
let bNext = 0;
{
  const N = MAX_B * P_PER, idx = new Float32Array(N), dir = new Float32Array(N * 3), rnd = new Float32Array(N);
  const v = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    idx[i] = Math.floor(i / P_PER);
    v.randomDirection().multiplyScalar(0.25 + 0.75 * Math.sqrt(Math.random()));
    dir.set([v.x, v.y, v.z], i * 3); rnd[i] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  g.setAttribute('aBurst', new THREE.BufferAttribute(idx, 1));
  g.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
  g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
  const bursts = new THREE.Points(g, pointsMaterial(COMMON_GLSL + /* glsl */`
    attribute float aBurst; attribute vec3 aDir; attribute float aRand;
    uniform vec3 uBO[${MAX_B}]; uniform float uBT[${MAX_B}]; uniform vec3 uBC[${MAX_B}]; uniform float uBS[${MAX_B}]; uniform float uBK[${MAX_B}];
    varying vec3 vColor; varying float vAlpha;
    void main(){
      int bi = int(aBurst + 0.5);
      float kind = uBK[bi], sc = uBS[bi];
      float dur = kind < 0.5 ? 1.6 + aRand*0.6 : 1.0;
      float age = uTime - uBT[bi];
      if (age < 0.0 || age > dur) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; vColor = vec3(0.0); return; }
      float k = age / dur;
      vec3 p;
      if (kind < 0.5) {
        float e = 1.0 - exp(-age*3.5);
        p = uBO[bi] + aDir*sc*e*2.2 + vec3(0.0, -0.7, 0.0)*age*age*sc;
      } else {
        float a = k*4.0*(aRand - 0.5);
        vec3 d = vec3(aDir.x*cos(a) - aDir.z*sin(a), aDir.y, aDir.x*sin(a) + aDir.z*cos(a));
        p = uBO[bi] + d*sc*2.4*(1.0 - k)*(1.0 - k);
      }
      vec4 mv = viewMatrix*vec4(p,1.0);
      gl_Position = projectionMatrix*mv;
      vColor = mix(vec3(1.0), uBC[bi], smoothstep(0.0, 0.25, k)) * (1.2 + 2.0*(1.0 - k));
      vAlpha = (kind < 0.5 ? (1.0 - k) : k*1.4) * fogF(-mv.z) * (0.6 + 0.4*sin(uTime*20.0 + aRand*90.0));
      gl_PointSize = max(1.5, pxSize(0.07*(1.0 - k*0.5)*mix(0.5, 1.5, aRand)*sqrt(sc), -mv.z));
    }`, SOFT_POINT_FRAG, { uBO: { value: bO }, uBT: { value: bT }, uBC: { value: bC }, uBS: { value: bS }, uBK: { value: bK } }));
  bursts.frustumCulled = false;
  scene.add(bursts); fxObjects.push(bursts);
}
function spawnBurst(p, col, scale = 1, kind = 0) {
  const i = bNext; bNext = (bNext + 1) % MAX_B;
  bO[i].copy(p); bT[i] = time; bC[i].set(...col); bS[i] = scale; bK[i] = kind;
}

/* 彗星：随机从井边射出，弧线飞行，撞到书墙或飞出井口时炸开 */
const COMET_COLORS = [[0.35, 0.7, 1.0], [0.35, 0.7, 1.0], [1.0, 0.8, 0.35], [0.75, 0.45, 1.0], [1.0, 0.3, 0.18]];
const COMET_N = 14;
const cometTrails = makeTrails(COMET_N, 40, 0.16, 0.03, 2.2);
scene.add(cometTrails.points); fxObjects.push(cometTrails.points);
const comets = Array.from({ length: COMET_N }, () => {
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softWhite, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.scale.setScalar(0.9); glow.visible = false;
  scene.add(glow); fxObjects.push(glow);
  return { state: 0, p0: new THREE.Vector3(), p1: new THREE.Vector3(), p2: new THREE.Vector3(), t0: 0, dur: 1, col: [1, 1, 1], glow };
});
let nextComet = 1.0;
function spawnComet(camY, from, pitch = null) {
  const c = comets.find((x) => x.state === 0); if (!c) return;
  const a0 = Math.random() * Math.PI * 2, a1 = a0 + Math.PI + rand(-1, 1);
  const hitWall = Math.random() < 0.5;
  c.p0.copy(polar(4.3, a0, camY + rand(0, 14)));
  c.p2.copy(polar(hitWall ? 8.5 : 4.3, a1, camY + rand(2, 22)));
  c.p1.copy(c.p0).add(c.p2).multiplyScalar(0.5); c.p1.x *= 0.2; c.p1.z *= 0.2; c.p1.y += rand(2, 7);
  if (from) { c.p0.copy(from); c.p2.copy(polar(8.5, a1, camY + rand(-1, 15))); c.p1.copy(c.p0).add(c.p2).multiplyScalar(0.5); c.p1.y += rand(1, 4); }
  c.dur = c.p0.distanceTo(c.p2) / rand(7, 12);
  c.col = COMET_COLORS[Math.floor(Math.random() * COMET_COLORS.length)];
  if (pitch !== null) {          // 主旋律：音越高落点越高、颜色越暖
    c.p2.y = camY + 1 + pitch * 16; c.p1.y = Math.max(c.p0.y, c.p2.y) + rand(1, 4);
    c.col = pitchCol(pitch);
    c.dur = c.p0.distanceTo(c.p2) / rand(9, 12);
  }
  cometTrails.cols[comets.indexOf(c)] = c.col;
  c.glow.material.color.setRGB(c.col[0] * 3, c.col[1] * 3, c.col[2] * 3);
  c.t0 = time; c.state = 1; c.glow.visible = true;
  cometTrails.hist[comets.indexOf(c)].length = 0;
}
const bez = (c, k, out) => {
  const a = (1 - k) * (1 - k), b = 2 * (1 - k) * k, d = k * k;
  return out.set(a * c.p0.x + b * c.p1.x + d * c.p2.x, a * c.p0.y + b * c.p1.y + d * c.p2.y, a * c.p0.z + b * c.p1.z + d * c.p2.z);
};

/* ---------------- 粒子：蓝白浮尘 + 红色余烬（法环那种飘着的红点） ---------------- */
{
  const N = 3600, pos = new Float32Array(N * 3), rnd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = Math.sqrt(Math.random()) * 8.4, th = Math.random() * Math.PI * 2;
    pos.set([r * Math.cos(th), Math.random() * 36, r * Math.sin(th)], i * 3);
    rnd[i] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
  const dust = new THREE.Points(g, pointsMaterial(COMMON_GLSL + NOISE_GLSL + /* glsl */`
    attribute float aRand;
    uniform float uCamY;
    varying vec3 vColor; varying float vAlpha;
    const float SPAN = 36.0;
    void main(){
      bool ember = aRand < 0.28;
      float base = uCamY - 10.0;
      float y = mod(position.y + uTime*(ember ? 0.35 + 0.3*aRand : 0.05 + 0.1*aRand) - base, SPAN);
      float rel = y / SPAN;
      vec3 wp = vec3(position.x, y + base, position.z);
      wp += curlNoise(wp*0.15 + vec3(0.0, uTime*0.04, 0.0)) * (ember ? 0.6 : 0.25);
      float rr = length(wp.xz);
      wp.xz *= min(rr, 8.45) / max(rr, 1e-3);
      vec4 mv = viewMatrix*vec4(wp,1.0);
      gl_Position = projectionMatrix*mv;
      float depth = -mv.z;
      float tw = 0.5 + 0.5*sin(uTime*(0.7 + aRand*3.0) + aRand*60.0);
      vColor = ember ? mix(vec3(1.0,0.25,0.1), vec3(1.0,0.6,0.3), tw) * 2.2 : vec3(0.7,0.88,1.0);
      vAlpha = (ember ? 0.4 + 0.6*tw : tw*0.55) * fogF(depth) * smoothstep(2.0, 4.5, depth)
             * smoothstep(0.0, 0.08, rel) * (1.0 - smoothstep(0.92, 1.0, rel));
      gl_PointSize = max(1.5, pxSize(ember ? 0.06 : 0.03, depth));
    }`, SOFT_POINT_FRAG, { uCamY: camYU }));
  dust.frustumCulled = false;
  scene.add(dust); fxObjects.push(dust);
}

/* ---------------- 飘落的书页 ---------------- */
const PAGES = 12;
const pages = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.42, 0.52),
  new THREE.MeshStandardMaterial({ map: pixelTex(makePageCanvas()), side: THREE.DoubleSide, roughness: 1, emissive: 0x3a3020, emissiveIntensity: 0.6 }), PAGES);
pages.frustumCulled = false;
const pageSeeds = Array.from({ length: PAGES }, () => ({ th: Math.random() * Math.PI * 2, r: rand(1.0, 4.2), y: Math.random() * 28, ph: Math.random() * 100, dir: Math.random() < 0.5 ? -1 : 1 }));
scene.add(pages); fxObjects.push(pages);

/* ============================================================
 * 骑士精灵：Blender 管线（pipeline/render_knight.py → process_sprites.py）渲出来的 index/normal 精灵表。
 * 每个像素只存「哪条色阶、第几档」和法线；这里按场景里的真实灯光算明暗，
 * 明暗只决定在色阶里上下挪几档，所以颜色永远落在调色板里。
 * ============================================================ */
const KN_URL = { walk: [walkIndex, walkNormal], sit: [sitIndex, sitNormal, sitDepth] };
const knLoader = new THREE.TextureLoader();
const loadNearest = (url) => {
  const t = knLoader.load(url);
  t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.NoColorSpace;
  return t;
};
const KN_TEX = {};
for (const a of Object.keys(KN_META.anims)) {
  KN_TEX[a] = { index: loadNearest(KN_URL[a][0]), normal: loadNearest(KN_URL[a][1]) };
  // 坐姿有逐像素深度：手搭在书上、腿在桌下、身子靠着椅背，各自前后关系都对
  if (KN_URL[a][2]) KN_TEX[a].depth = loadNearest(KN_URL[a][2]);
}
const KN_R = KN_META.ramps.length, KN_S = KN_META.steps, KN_SIZE = KN_META.anims.walk.worldSize, KN_CELL = KN_META.anims.walk.cell;
const knLut = (() => {
  const data = new Uint8Array(KN_R * KN_S * 4);
  KN_META.ramps.forEach((r, i) => r.colors.forEach((hex, j) => {
    const n = parseInt(hex.slice(1), 16);
    data.set([(n >> 16) & 255, (n >> 8) & 255, n & 255, r.lit ? 255 : 0], (i * KN_S + j) * 4);
  }));
  const t = new THREE.DataTexture(data, KN_S, KN_R);
  t.colorSpace = THREE.SRGBColorSpace; t.magFilter = t.minFilter = THREE.NearestFilter; t.needsUpdate = true;
  return t;
})();
function makeKnightMesh(anim) {
  const a = KN_META.anims[anim];
  const nFrames = a.frames ?? KN_META.frames, depthTex = KN_TEX[anim].depth;
  const geo = new THREE.PlaneGeometry(a.worldSize, a.worldSize);
  geo.translate(0, a.worldSize * (0.5 - a.feetV), 0);
  const v3 = () => new THREE.Vector3();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tIndex: { value: KN_TEX[anim].index }, tNormal: { value: KN_TEX[anim].normal }, tLUT: { value: knLut },
      uCell: { value: new THREE.Vector2() }, uGrid: { value: new THREE.Vector2(nFrames, a.rows?.length ?? KN_META.dirs) }, uSheetPx: { value: a.cell * nFrames },
      uWorldSize: { value: a.worldSize },
      tDepth: { value: depthTex ?? null }, uTargetY: { value: a.target ?? 0 },
      uDepthNear: { value: KN_META.depth?.near ?? 8 }, uDepthRange: { value: KN_META.depth?.range ?? 4 }, uCamDist: { value: KN_META.depth?.camDist ?? 10 },
      uClampY: { value: -1e3 },   // 桌面高度：身上刚好算到桌面下面一点的像素（手、前臂）沿视线挪回桌面上方
      uAmbient: { value: 0.46 }, uBands: { value: new THREE.Vector3(...KN_META.shading.bands) }, uSteps: { value: KN_S }, uRamps: { value: KN_R },
      uLightPos: { value: [v3(), v3(), v3(), v3()] }, uLightCol: { value: [0, 1, 2, 3].map(() => new THREE.Color()) },
      uLightPow: { value: [0, 0, 0, 0] }, uLightRange: { value: [1, 1, 1, 1] },
      uRight: { value: v3() }, uUpV: { value: v3() }, uFwdV: { value: v3() },
      uGlow: { value: 2.2 }, uFogColor: { value: new THREE.Color(FOG_COLOR) }, uFogD: shared.uFogD,
      uDepthPull: { value: 0 },   // 只改深度不改大小：精灵是一张纸，人身体的厚度靠这个补
    },
    defines: depthTex ? { USE_SPRITE_DEPTH: '' } : {},
    vertexShader: /* glsl */`
      uniform vec2 uCell, uGrid; uniform float uDepthPull;
      varying vec2 vSheetUv; varying vec3 vWorld; varying float vDepth; varying vec3 vOrigin; varying vec2 vCellUv;
      void main(){
        vSheetUv = vec2((uCell.x + uv.x) / uGrid.x, 1.0 - (uCell.y + 1.0 - uv.y) / uGrid.y);
        vCellUv = uv;
        vOrigin = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz;
        vec4 mv = viewMatrix * w; vDepth = -mv.z;
        vec4 p0 = projectionMatrix * mv;
        vec4 p1 = projectionMatrix * vec4(mv.xyz + normalize(-mv.xyz) * uDepthPull, 1.0);
        gl_Position = vec4(p0.xy, p1.z / p1.w * p0.w, p0.w);
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tIndex, tNormal, tLUT;
      uniform float uSheetPx, uAmbient, uSteps, uRamps, uGlow, uFogD;
      uniform vec3 uBands, uRight, uUpV, uFwdV, uFogColor;
      uniform vec3 uLightPos[4]; uniform vec3 uLightCol[4]; uniform float uLightPow[4]; uniform float uLightRange[4];
      varying vec2 vSheetUv; varying vec3 vWorld; varying float vDepth; varying vec3 vOrigin; varying vec2 vCellUv;
      vec4 lut(float r, float st){ return texture2D(tLUT, vec2((st + 0.5) / uSteps, (r + 0.5) / uRamps)); }
      #ifdef USE_SPRITE_DEPTH
      uniform sampler2D tDepth; uniform mat4 projectionMatrix;
      uniform float uTargetY, uDepthNear, uDepthRange, uCamDist, uDepthPull, uClampY, uWorldSize;
      #endif
      void main(){
        vec4 idx = texture2D(tIndex, vSheetUv);
        if (idx.a < 0.5) discard;
        #ifdef USE_SPRITE_DEPTH
        {
          // Blender 渲的视深 → 这个像素真正在三维里的位置 → 写进深度缓冲。按 Blender 那台正交相机原样还原：
          // 画面中心是 target，横向 uRight、纵向 uUpV（俯视那一行的相机朝上方向），再沿视线推前推后。
          float off = uDepthNear + texture2D(tDepth, vSheetUv).r * uDepthRange - uCamDist;
          vec3 p = vOrigin + vec3(0.0, uTargetY, 0.0) + uRight * ((vCellUv.x - 0.5) * uWorldSize)
                 + uUpV * ((vCellUv.y - 0.5) * uWorldSize) - uFwdV * off;
          // 从一张纸推回来的深度在桌面附近会差一两厘米：手和前臂一沉到桌面下就被桌面 / 写字垫切掉。
          // 只在桌面下 15 cm 以内（手、前臂）沿视线把点挪到桌面上方；再往下的腿保持真实深度，照样被桌子挡住。
          if (p.y < uClampY && p.y > uClampY - 0.15 && cameraPosition.y > uClampY) {
            p = cameraPosition + (p - cameraPosition) * ((uClampY - cameraPosition.y) / (p.y - cameraPosition.y));
          }
          p += normalize(cameraPosition - p) * uDepthPull;
          vec4 clip = projectionMatrix * viewMatrix * vec4(p, 1.0);
          gl_FragDepth = clamp(0.5 * clip.z / clip.w + 0.5, 0.0, 1.0);
        }
        #endif
        float ramp = floor(idx.r*255.0 + 0.5), base = floor(idx.g*255.0 + 0.5), flags = floor(idx.b*255.0 + 0.5);
        vec3 n = normalize(texture2D(tNormal, vSheetUv).rgb*2.0 - 1.0);
        float shade = uAmbient; vec3 tint = vec3(0.0);
        for (int i = 0; i < 4; i++) {
          vec3 Lw = uLightPos[i] - vWorld; float d = length(Lw); Lw /= max(d, 1e-4);
          vec3 L = vec3(dot(Lw, uRight), dot(Lw, uUpV), dot(Lw, uFwdV));     // 世界 → 精灵渲染时的视空间
          float att = clamp(1.0 - d / uLightRange[i], 0.0, 1.0); att *= att;
          float k = max(dot(n, L), 0.0) * att * uLightPow[i];
          shade += k; tint += uLightCol[i] * k;
        }
        vec2 texel = floor(vSheetUv * uSheetPx);
        shade += mod(texel.x + texel.y, 2.0) < 0.5 ? 0.03 : -0.03;
        float off = shade < uBands.x ? -1.0 : shade < uBands.y ? 0.0 : shade < uBands.z ? 1.0 : 2.0;
        bool lit = lut(ramp, base).a > 0.5;
        float st = base + off;
        if (mod(flags, 4.0) >= 2.0) st -= 1.0;
        if (mod(flags, 2.0) >= 1.0) st = off >= 1.0 ? 1.0 : 0.0;
        if (ramp < 0.5) st = min(st, 1.0);
        if (!lit) st = base;
        st = clamp(st, 0.0, uSteps - 1.0);
        vec3 col = lut(ramp, st).rgb;
        if (!lit) col *= uGlow;
        else { float tl = length(tint); if (tl > 1e-3) col = mix(col, col * (tint / tl) * 1.3, clamp(tl, 0.0, 1.0) * 0.22); }
        float f = uFogD * vDepth; col = mix(uFogColor, col, exp(-f*f));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.userData.elev = a.elevDeg * Math.PI / 180;
  m.userData.rows = a.rows ?? null;     // 按真实机位角度渲的行（坐姿）：挑最接近镜头的一行，用那一行自己的俯角
  m.frustumCulled = false;
  return m;
}
// 圆柱式 billboard（只绕竖轴转，镜头仰拍时人不会歪），并按「人物朝向 vs 镜头方向」挑精灵表的行
function orientKnight(mesh, cam, facing, frame) {
  const p = mesh.position, F = new THREE.Vector3(cam.position.x - p.x, 0, cam.position.z - p.z).normalize();
  mesh.rotation.set(0, Math.atan2(F.x, F.z), 0);
  const a = Math.atan2(F.z * facing.x - F.x * facing.z, F.x * facing.x + F.z * facing.z);
  let dir = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8, e = mesh.userData.elev;
  const u = mesh.material.uniforms, U = new THREE.Vector3(0, 1, 0), rows = mesh.userData.rows;
  if (rows) {
    const deg = ((a * 180 / Math.PI) % 360 + 360) % 360;
    const dist = (r) => Math.abs(((deg - r.yaw) % 360 + 540) % 360 - 180);
    dir = rows.reduce((best, r, i) => (dist(r) < dist(rows[best]) ? i : best), 0);
    e = rows[dir].elev * Math.PI / 180;
    u.uTargetY.value = rows[dir].target;
  }
  u.uRight.value.crossVectors(U, F).normalize();
  u.uUpV.value.copy(U).multiplyScalar(Math.cos(e)).addScaledVector(F, -Math.sin(e));
  u.uFwdV.value.copy(F).multiplyScalar(Math.cos(e)).addScaledVector(U, Math.sin(e));
  u.uCell.value.set(frame, dir);
}
function setKnightLights(mesh, lights) {
  const u = mesh.material.uniforms;
  for (let i = 0; i < 4; i++) {
    const L = lights[i];
    if (!L) { u.uLightPow.value[i] = 0; continue; }
    u.uLightPos.value[i].copy(L.pos); u.uLightCol.value[i].setRGB(...L.color);
    u.uLightPow.value[i] = L.pow; u.uLightRange.value[i] = L.range;
  }
}
const knight = makeKnightMesh('walk');
scene.add(knight);
const KN_FEET = KN_META.anims.walk.feetV;
const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.6),
  new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(makeSoftCanvas('rgba(0,0,0,0.55)', 'rgba(0,0,0,0)')), transparent: true, depthWrite: false }));
shadow.rotation.x = -Math.PI / 2;
scene.add(shadow);
const swordTipGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softWhite, color: new THREE.Color(0.6, 1.4, 3.0), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
swordTipGlow.scale.setScalar(0.6); swordTipGlow.visible = false;
scene.add(swordTipGlow);
// 剑身上一直往下滴的辉光碎屑
const bladeA = { value: new THREE.Vector3() }, bladeB = { value: new THREE.Vector3() }, auraU = { value: 1 };
{
  const N = 140, pos = new Float32Array(N * 3), rnd = new Float32Array(N);
  for (let i = 0; i < N; i++) { pos.set([Math.random(), 0, 0], i * 3); rnd[i] = Math.random(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
  const aura = new THREE.Points(g, pointsMaterial(COMMON_GLSL + /* glsl */`
    attribute float aRand;
    uniform vec3 uBA, uBB; uniform float uAura;
    varying vec3 vColor; varying float vAlpha;
    void main(){
      float life = fract(uTime*(0.5 + aRand*0.8) + aRand*9.0);
      vec3 p = mix(uBA, uBB, position.x) + vec3(sin(aRand*40.0), 0.0, cos(aRand*31.0))*0.07*life + vec3(0.0, 0.08 - 0.5*life*life, 0.0);
      vec4 mv = viewMatrix*vec4(p,1.0);
      gl_Position = projectionMatrix*mv;
      vColor = mix(vec3(0.9,0.97,1.0), vec3(0.35,0.65,1.0), life) * (1.4 + uAura);
      vAlpha = sin(life*3.14159) * min(uAura, 2.5) * 0.7 * fogF(-mv.z);
      gl_PointSize = max(1.5, pxSize(0.03 + 0.02*uAura*(1.0 - life), -mv.z));
    }`, SOFT_POINT_FRAG, { uBA: bladeA, uBB: bladeB, uAura: auraU }));
  aura.frustumCulled = false;
  scene.add(aura); fxObjects.push(aura);
}

// 光之巨剑：一条以手为支点、在屏幕平面里挥动的发光剑身
const bladeMat = new THREE.ShaderMaterial({
  uniforms: { uTime: shared.uTime, uA: { value: 0 } },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform float uTime, uA; varying vec2 vUv;
    void main(){
      float x = (vUv.x - 0.5) * 2.0;
      float taper = 1.0 - pow(vUv.y, 6.0);
      float w = mix(1.0, 0.15, pow(vUv.y, 2.0));
      float xx = x / w;
      float core = exp(-xx*xx*30.0), body = exp(-xx*xx*5.0);
      float streak = 0.75 + 0.25*sin(vUv.y*60.0 - uTime*40.0 + x*4.0);
      vec3 col = mix(vec3(0.25,0.55,1.0), vec3(0.95,1.0,1.0), core) * (body*1.6 + core*3.0) * streak;
      float a = clamp((body*0.8 + core) * taper * smoothstep(0.0, 0.04, vUv.y) * uA, 0.0, 1.0);
      gl_FragColor = vec4(col * a, 1.0);
    }`,
  transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
});
const bladeGeo = new THREE.PlaneGeometry(0.7, 1); bladeGeo.translate(0, 0.5, 0);
const blade = new THREE.Mesh(bladeGeo, bladeMat);
blade.renderOrder = 5; blade.visible = false; blade.frustumCulled = false;
scene.add(blade);
// 挥砍轨迹：一段跟着剑尖扫过的光弧
const arcMat = new THREE.ShaderMaterial({
  uniforms: { uA0: { value: 0 }, uA1: { value: 0 }, uAlpha: { value: 0 }, uTime: shared.uTime },
  vertexShader: /* glsl */`varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform float uA0, uA1, uAlpha, uTime; varying vec2 vP;
    void main(){
      float ang = atan(vP.y, vP.x), r = length(vP);
      float lo = min(uA0, uA1), hi = max(uA0, uA1);
      if (ang < lo) ang += 6.2831853;                          // 扇面跨过 ±π 时接上
      if (ang < lo || ang > hi) discard;
      float span = uA0 - uA1; if (abs(span) < 1e-3) span = 1e-3;   // 两个方向都能挥
      float lead = 1.0 - (ang - uA1) / span;                    // 前沿最亮
      lead *= 0.35 + 0.65 * smoothstep(3.6, 4.7, r);           // 只亮外缘一道弧，不糊满整个扇面
      float radial = smoothstep(0.8, 4.6, r) * (1.0 - smoothstep(4.6, 5.0, r));
      float a = clamp(pow(lead, 2.5) * radial * uAlpha * (0.8 + 0.2*sin(r*14.0 - uTime*30.0)), 0.0, 1.0);
      gl_FragColor = vec4(mix(vec3(0.3,0.6,1.0), vec3(0.9,1.0,1.0), pow(lead, 6.0)) * a * 1.1, 1.0);
    }`,
  transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
});
const slashArc = new THREE.Mesh(new THREE.RingGeometry(0.5, 5.0, 96, 1), arcMat);
slashArc.renderOrder = 4; slashArc.visible = false; slashArc.frustumCulled = false;
scene.add(slashArc);
// 冲击波：水平扩散的光环。一个池子——光柱落点、巨剑、星辉仪脉冲可以同时各炸各的
const WAVE_FRAG = /* glsl */`
  uniform float uAlpha; uniform vec3 uColor; varying vec2 vUv;
  float g2(float x){ return exp(-x*x); }
  void main(){ float r = length(vUv - 0.5)*2.0; float a = g2((r - 0.85)*9.0) + g2((r - 0.6)*14.0)*0.4 + g2((r - 0.35)*10.0)*0.15; gl_FragColor = vec4(uColor*a*uAlpha*2.0, 1.0); }`;
const UV_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const waveGeo = new THREE.PlaneGeometry(2, 2); waveGeo.rotateX(-Math.PI / 2);
const waves = Array.from({ length: 8 }, () => {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 0 }, uColor: { value: new THREE.Color(0.45, 0.8, 1.0) } },
    vertexShader: UV_VERT, fragmentShader: WAVE_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(waveGeo, mat); m.visible = false; m.frustumCulled = false; scene.add(m);
  return { m, mat, t0: -100, dur: 1.25, r: 1 };
});
let waveNext = 0;
function startWave(y, r, col, x = 0, z = 0, dur = 1.25) {
  const w = waves[waveNext]; waveNext = (waveNext + 1) % waves.length;
  w.m.position.set(x, y, z); w.t0 = time; w.r = r; w.dur = dur; w.mat.uniforms.uColor.value.setRGB(...col);
}
function updateWaves(t) {
  for (const w of waves) {
    const k = (t - w.t0) / w.dur;
    w.m.visible = k >= 0 && k < 1;
    if (!w.m.visible) continue;
    w.m.scale.setScalar(0.5 + easeOut(k) * w.r);
    w.mat.uniforms.uAlpha.value = 1 - k;
  }
}

/* ============================================================
 * 乐器特效。先有一首有节奏的 BGM，每种乐器对应一种特效（对照表在 src/score.js 的 INSTRUMENT_FX）：
 *   beam    天光坠落  底鼓      塔顶一道光柱劈进天井，落点炸开冲击波、往上溅光屑
 *   sigil   法阵      军鼓      井中闪现一面法阵，沿圆周描出来、旋转，碎成光屑
 *   glitter 星芒      镲        一小簇十字星芒闪一下（只在局部，不让整屏变亮）
 *   ripple  地脉      贝斯      一圈符文光环贴着书墙从下往上扫过整座塔
 *   aurora  极光      铺底/弦乐 一条极光丝带绕着天井盘旋，音符多长就亮多久
 *   comet   流星      主旋律    流星划过天井，音越高落点越高、颜色越暖
 *   chime   灯链      琶音/钟琴 一点光沿栏杆往前跑，路过的灯一盏盏迸亮
 *   swell / slash / shower    重音 / 段落重拍 / 过门：星辉仪脉冲、光之巨剑、彗星齐射（原来的三个大事件）
 * 统一入口 triggerFx(name, { v 力度 0..1, p 音高 0..1, d 时值秒 })。
 * ============================================================ */
const FX_COL = { blue: [0.45, 0.8, 1.0], gold: [1.0, 0.8, 0.42] };     // 池子里的初始颜色（每次触发都会换成按音高算的颜色）
// 音高 → 外观，所有乐器特效共用一套：
//   低音：在塔里更低、更大更粗、更慢，深蓝紫；高音：更高、更小更细、更快，青白 → 金
const PITCH_STOPS = [[0, [0.5, 0.32, 1.0]], [0.35, [0.38, 0.62, 1.0]], [0.65, [0.62, 0.92, 1.0]], [1, [1.0, 0.8, 0.42]]];
// 段落状态（乐谱 sections[].mood）：骑士走多快（rate）、塔里的灯多亮（lamp）、所有特效往金色偏多少（warm）。
// 没在放乐谱时一直是 walk，跟原来一样。
const MOODS = {
  // 骑士一直同一个速度走（段落只换灯光的明暗冷暖，不让他忽快忽慢）
  calm: { rate: 1, lamp: 0.85, warm: 0 },      // 前奏
  walk: { rate: 1, lamp: 0.95, warm: 0 },
  climb: { rate: 1, lamp: 1.05, warm: 0 },
  hush: { rate: 1, lamp: 0.7, warm: 0.25 },    // 静息：灯暗下去、偏暖
  full: { rate: 1, lamp: 1.12, warm: 0 },      // 高潮：塔身全亮
  freeze: { rate: 0, lamp: 0.3, warm: 0 },     // 停步（旧谱用过，留着）
  gold: { rate: 1, lamp: 1.2, warm: 1 },
};
const moodNow = { ...MOODS.walk };
let moodName = 'walk';
function easeMood(dt) {
  const m = MOODS[moodName] ?? MOODS.walk, k = 1 - Math.exp(-dt * (moodName === 'freeze' ? 14 : 2.5));   // 急停要快，回来慢慢走起来
  for (const key in moodNow) moodNow[key] += (m[key] - moodNow[key]) * k;
}
const PITCH_GOLD = PITCH_STOPS[PITCH_STOPS.length - 1][1];
function pitchCol(p) {
  p = THREE.MathUtils.clamp(p, 0, 1);
  let c = PITCH_GOLD;
  for (let i = 1; i < PITCH_STOPS.length; i++) {
    const [p1, c1] = PITCH_STOPS[i], [p0, c0] = PITCH_STOPS[i - 1];
    if (p <= p1) { const k = (p - p0) / (p1 - p0); c = c0.map((x, j) => x + (c1[j] - x) * k); break; }
  }
  const w = moodNow.warm * 0.75;
  return w > 0.001 ? c.map((x, j) => x + (PITCH_GOLD[j] - x) * w) : c;
}
const lerp = THREE.MathUtils.lerp;
/** y：离镜头高度的偏移；size：大小倍数；speed：快慢倍数 */
const pitchStyle = (p) => ({ col: pitchCol(p), y: lerp(-0.8, 9, p), size: lerp(1.35, 0.7, p), speed: lerp(0.75, 1.45, p) });
const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const tmpF = new THREE.Vector3();
/** 天井里、镜头前方一个点（落在井口里，不落到台阶上） */
function fxPoint(spread = 1, y0 = -1, y1 = 4, d0 = 5, d1 = 9) {
  camera.getWorldDirection(tmpF); tmpF.y = 0; tmpF.normalize();
  const p = new THREE.Vector3().copy(camera.position).addScaledVector(tmpF, rand(d0, d1)).addScaledVector(camRight, rand(-3, 3) * spread);
  const r = Math.hypot(p.x, p.z), R = 4.2;
  if (r > R) { p.x *= R / r; p.z *= R / r; }
  p.y = camera.position.y + rand(y0, y1);
  return p;
}
// 闪光限流：整屏变亮（闪光灯 + 泛光加强）一秒最多 3 次，跟着鼓点打特效也不会连闪；系统设了「减弱动态效果」就不震屏、闪光减弱
const flashLog = [];
const level = (x) => (Number.isFinite(x) ? Math.min(Math.max(x, 0), 2) : 0);     // NaN / 越界的强度一律当 0 或封顶，不然一个 NaN 会让闪光、泛光永远是 NaN
function hit({ flash: f = 0, bloom: b = 0, shake: sh = 0, res = 0, ring = 0, arm = 0, at = null } = {}) {
  f = level(f); b = level(b); sh = level(sh); res = level(res); ring = level(ring); arm = level(arm);
  resonance = Math.max(resonance, res); ringFlare = Math.max(ringFlare, ring); armPulse = Math.max(armPulse, arm);
  if (!REDUCED_MOTION) shake = Math.max(shake, sh);
  if (f <= 0 && b <= 0) return;
  while (flashLog.length && time - flashLog[0] > 1) flashLog.shift();
  // 一秒 3 次是硬上限；小闪光（光柱落点）最多占 2 次，留 1 次给巨剑、星辉脉冲这种段落高潮，鼓点再密也抢不走
  if (flashLog.length >= 3 || (f < 0.4 && b < 0.25 && flashLog.length >= 2)) return;
  flashLog.push(time);
  const k = REDUCED_MOTION ? 0.4 : 1;
  flash = Math.max(flash, f * k); bloomBoost = Math.max(bloomBoost, b * k);
  if (at) flashLight.position.copy(at);
}
const VOL_VERT = /* glsl */`
  varying vec2 vUv; varying vec3 vN, vV;
  void main(){ vUv = uv; vec4 mv = modelViewMatrix*vec4(position,1.0); vV = -mv.xyz; vN = normalize(normalMatrix*normal); gl_Position = projectionMatrix*mv; }`;

// ---- beam：天光坠落。一根真的圆柱（不是转向镜头的面片），按视线和表面的夹角算出中间亮、边缘柔，绕着看都是立体的光柱
const BEAM_STRIKE = 0.12;          // 秒：光柱从塔顶劈到落点；着色器和落点冲击波共用
const beamGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 1, true); beamGeo.translate(0, -0.5, 0);   // 顶端在原点，往下长
const beams = Array.from({ length: 6 }, () => {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uAge: { value: 9 }, uCol: { value: new THREE.Color() }, uPow: { value: 1 } },
    vertexShader: VOL_VERT,
    fragmentShader: /* glsl */`
      uniform float uTime, uAge, uPow; uniform vec3 uCol; varying vec2 vUv; varying vec3 vN, vV;
      void main(){
        float down = 1.0 - vUv.y;                                          // 0 塔顶 → 1 落点
        float reach = clamp(uAge / ${BEAM_STRIKE.toFixed(3)}, 0.0, 1.0);    // 从塔顶劈到落点
        if (down > reach) discard;
        float facing = abs(dot(normalize(vN), normalize(vV)));             // 1：正对视线（柱子中线），0：轮廓
        float life = uAge < ${BEAM_STRIKE.toFixed(3)} ? 1.0 : exp(-(uAge - ${BEAM_STRIKE.toFixed(3)}) * 4.5);
        float thin = mix(1.0, 0.3, clamp((uAge - ${BEAM_STRIKE.toFixed(3)}) / 0.45, 0.0, 1.0));  // 劈下来时粗，之后收成一根细线
        float x = sqrt(max(0.0, 1.0 - facing*facing)) / thin;              // 离柱子中线多远（0..1）
        float core = exp(-x*x*40.0), body = exp(-x*x*4.0);
        float streak = 0.75 + 0.25*sin(down*90.0 - uTime*70.0);
        float hd = (reach - down) * 25.0, head = exp(-hd * hd) * (1.0 - step(1.0, reach) * 0.7);
        float a = clamp((body*0.6 + core + head) * life * smoothstep(0.0, 0.1, down) * uPow, 0.0, 1.0);
        gl_FragColor = vec4(mix(uCol, vec3(1.0), core) * (body*1.1 + core*3.0 + head*3.0) * streak * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const m = new THREE.Mesh(beamGeo, mat); m.visible = false; m.frustumCulled = false; m.renderOrder = 3; scene.add(m);
  return { m, mat, t0: -100, landed: true, at: new THREE.Vector3(), w: 1, col: FX_COL.blue, v: 1, size: 1 };
});
let beamNext = 0, lastBeamT = -100;
function fxBeam({ v = 1, p = 0.5, at = null, col = null } = {}) {
  const b = beams[beamNext], st = pitchStyle(p); beamNext = (beamNext + 1) % beams.length;
  const crowded = time - lastBeamT < 1 / 3; lastBeamT = time;      // 光柱本身也是一道整屏高的亮光：1/3 秒内的下一道调暗到三成
  b.at.copy(at ?? fxPoint(1, st.y - 1, st.y + 1)); b.t0 = time; b.landed = false; b.v = v; b.col = col ?? st.col; b.size = st.size;
  b.w = (0.45 + 0.75 * v) * st.size;
  b.mat.uniforms.uCol.value.setRGB(...b.col); b.mat.uniforms.uPow.value = (0.5 + 0.5 * v) * (crowded ? 0.3 : 1);
}
function updateBeams(t) {
  const topY = camera.position.y + TOP_OFF - 2;
  for (const b of beams) {
    const age = t - b.t0;
    b.m.visible = age >= 0 && age < 1.0;
    if (!b.m.visible) continue;
    b.m.position.set(b.at.x, topY, b.at.z); b.m.scale.set(b.w, topY - b.at.y, b.w);
    b.mat.uniforms.uAge.value = age;
    if (!b.landed && age >= BEAM_STRIKE) {
      b.landed = true;
      startWave(b.at.y, (1.8 + 2.6 * b.v) * b.size, b.col, b.at.x, b.at.z, 0.9);
      spawnBurst(b.at, b.col, (0.5 + 0.8 * b.v) * b.size, 0);
      hit({ flash: 0.22 * b.v, bloom: 0.1 * b.v, res: 0.4 * b.v, at: b.at });
    }
  }
}

// ---- sigil：法阵。平铺在天井里（不再正对镜头），三层叠成一座小塔：顶上小、底下大，从上往下一层层描出来、
// 相邻两层反着转；低音落在镜头下面（俯看），高音悬在镜头上面（仰看），透视一眼就看得出深浅
const runeTex = new THREE.CanvasTexture(makeRuneCanvas(77, true));
runeTex.wrapS = THREE.RepeatWrapping; runeTex.magFilter = runeTex.minFilter = THREE.NearestFilter; runeTex.generateMipmaps = false;
const sigilGeo = new THREE.PlaneGeometry(2, 2); sigilGeo.rotateX(-Math.PI / 2);
const SIGIL_LAYERS = [{ dy: 1.7, r: 0.36, delay: 0, spin: 1 }, { dy: 0.85, r: 0.62, delay: 0.07, spin: -1 }, { dy: 0, r: 1, delay: 0.14, spin: 1 }];
const sigilMat = () => new THREE.ShaderMaterial({
  uniforms: { uAge: { value: 9 }, uSpin: { value: 0 }, uPow: { value: 1 }, uCol: { value: new THREE.Color() }, tRune: { value: runeTex } },
  vertexShader: UV_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tRune; uniform float uAge, uSpin, uPow; uniform vec3 uCol; varying vec2 vUv;
    float line(float d, float w){ return exp(-d*d/(w*w)); }
    void main(){
      if (uAge < 0.0) discard;
      vec2 p = (vUv - 0.5) * 2.0;
      float r = length(p);
      if (r > 1.04) discard;
      float a = atan(p.y, p.x);
      float drawn = step(fract((a + uSpin) / 6.28318), smoothstep(0.0, 0.14, uAge));   // 沿圆周描出来
      float s = line(r - 0.97, 0.016) + line(r - 0.80, 0.012) + line(r - 0.46, 0.012);
      vec2 ruv = vec2((a + uSpin) / 6.28318 * 4.0, (r - 0.82) / 0.13);
      if (ruv.y > 0.0 && ruv.y < 1.0) s += texture2D(tRune, ruv).r * 0.9;
      for (int k = 0; k < 6; k++) {
        float th = -uSpin * 0.6 + float(k) * 1.0472;
        s += line(abs(dot(p, vec2(cos(th), sin(th))) - 0.40), 0.012) * step(r, 0.8);
      }
      s += line(r - 0.62, 0.035) * pow(max(0.0, 0.5 + 0.5*cos((a - uSpin*1.5) * 12.0)), 30.0) * 1.5;
      float pop = exp(-uAge * 7.0);                                     // 出现那一下最亮
      float fade = 1.0 - smoothstep(0.42, 0.72, uAge);
      float al = s * drawn * fade * uPow * (1.0 + pop * 1.5);
      gl_FragColor = vec4(mix(uCol, vec3(1.0), clamp(s - 0.8, 0.0, 1.0) * 0.6 + pop * 0.4) * al, 1.0);
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
});
const sigils = Array.from({ length: 4 }, () => {
  const layers = SIGIL_LAYERS.map(() => {
    const mat = sigilMat();
    const m = new THREE.Mesh(sigilGeo, mat); m.visible = false; m.frustumCulled = false; m.renderOrder = 3; scene.add(m);
    return { m, mat };
  });
  return { layers, t0: -100, R: 3, seed: 0, broke: true, col: FX_COL.blue, v: 1, at: new THREE.Vector3() };
});
let sigilNext = 0;
function fxSigil({ v = 1, p = 0.5, at = null, col = null } = {}) {
  const g = sigils[sigilNext], st = pitchStyle(p); sigilNext = (sigilNext + 1) % sigils.length;
  const th = rand(0, Math.PI * 2), off = rand(0, 1.0);
  // 法阵是平铺的：离镜头视线高度太近就成了一条线。低音压到视线下面（俯看），高音抬到上面（仰看），中间至少隔 1.2
  let dy = lerp(-1.8, 9, p) + rand(-0.3, 0.3);
  if (Math.abs(dy) < 1.2) dy = dy < 0.2 ? -1.2 : 1.2;
  g.at.copy(at ?? new THREE.Vector3(off * Math.cos(th), camera.position.y + dy, off * Math.sin(th)));
  g.t0 = time; g.broke = false; g.v = v; g.seed = rand(0, 6.28); g.col = col ?? st.col;
  g.R = Math.min(4.3 - off, 3.3 * st.size * (0.85 + 0.15 * v));
  for (const L of g.layers) { L.mat.uniforms.uCol.value.setRGB(...g.col); L.mat.uniforms.uPow.value = 0.45 + 0.4 * v; }
}
function updateSigils(t) {
  for (const g of sigils) {
    const age = t - g.t0;
    const on = age >= 0 && age < 0.95;
    g.layers.forEach((L, i) => {
      const S = SIGIL_LAYERS[i], a = age - S.delay;
      L.m.visible = on && a >= 0;
      if (!L.m.visible) return;
      L.m.position.set(g.at.x, g.at.y + S.dy * (g.R / 3.3), g.at.z);
      L.m.scale.setScalar(g.R * S.r * (0.8 + 0.2 * easeOut(Math.min(1, a / 0.14))));
      L.mat.uniforms.uAge.value = a; L.mat.uniforms.uSpin.value = (g.seed + a * 2.2) * S.spin;
    });
    if (on && !g.broke && age >= 0.56) {          // 底层法阵碎开：光屑从圆周上落下来
      g.broke = true;
      for (let k = 0; k < 6; k++) spawnBurst(tmpF.set(g.at.x + g.R * Math.cos(k * 1.047 + g.seed), g.at.y, g.at.z + g.R * Math.sin(k * 1.047 + g.seed)), g.col, 0.35, 0);
    }
  }
}

// ---- glitter：十字星芒（一簇 40 个，各自错开一点点时间闪一下）
const G_N = 8, G_PER = 40;
const gO = Array.from({ length: G_N }, () => new THREE.Vector3()), gT = new Array(G_N).fill(-100);
const gC = Array.from({ length: G_N }, () => new THREE.Vector3(1, 1, 1)), gS = new Array(G_N).fill(1);
let gNext = 0;
{
  const N = G_N * G_PER, idx = new Float32Array(N), dir = new Float32Array(N * 3), rnd = new Float32Array(N), v = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    idx[i] = Math.floor(i / G_PER);
    v.randomDirection().multiplyScalar(Math.cbrt(Math.random()));
    dir.set([v.x, v.y * 0.7, v.z], i * 3); rnd[i] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  g.setAttribute('aG', new THREE.BufferAttribute(idx, 1));
  g.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
  g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
  const glitter = new THREE.Points(g, pointsMaterial(COMMON_GLSL + /* glsl */`
    attribute float aG; attribute vec3 aDir; attribute float aRand;
    uniform vec3 uGO[${G_N}]; uniform float uGT[${G_N}]; uniform vec3 uGC[${G_N}]; uniform float uGS[${G_N}];
    varying vec3 vColor; varying float vAlpha;
    void main(){
      int gi = int(aG + 0.5);
      float age = uTime - uGT[gi] - aRand*0.14, dur = 0.28 + aRand*0.22;
      if (age < 0.0 || age > dur) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; vColor = vec3(0.0); return; }
      float k = age / dur, env = sin(k * 3.14159);
      vec4 mv = viewMatrix*vec4(uGO[gi] + aDir*uGS[gi]*(0.9 + 0.3*k), 1.0);
      gl_Position = projectionMatrix*mv;
      vColor = mix(vec3(1.0), uGC[gi], 0.45) * 2.6;
      vAlpha = env * fogF(-mv.z);
      gl_PointSize = max(2.0, pxSize((0.18 + 0.2*aRand) * env * sqrt(uGS[gi]), -mv.z));
    }`, /* glsl */`
    varying vec3 vColor; varying float vAlpha;
    void main(){
      vec2 c = abs(gl_PointCoord - 0.5);
      float a = exp(-c.x*42.0)*exp(-c.y*6.0) + exp(-c.y*42.0)*exp(-c.x*6.0) + exp(-dot(c,c)*90.0);
      a *= vAlpha;
      if (a < 0.004) discard;
      gl_FragColor = vec4(vColor, a);
    }`, { uGO: { value: gO }, uGT: { value: gT }, uGC: { value: gC }, uGS: { value: gS } }));
  glitter.frustumCulled = false;
  scene.add(glitter); fxObjects.push(glitter);
}
function fxGlitter({ v = 1, p = 0.5, at = null, col = null } = {}) {
  const i = gNext, st = pitchStyle(p); gNext = (gNext + 1) % G_N;
  gO[i].copy(at ?? fxPoint(1.3, st.y - 1, st.y + 2)); gT[i] = time; gS[i] = (0.7 + 0.9 * v) * st.size; gC[i].set(...(col ?? st.col));
}

// ---- ripple：一圈符文光环贴着书墙从下往上扫过（镜头在圈里，所以看到的是整面书墙被一道光扫过）。低音扫得慢、光带宽
const rippleGeo = new THREE.CylinderGeometry(8.3, 8.3, 1, 96, 1, true);
const ripples = Array.from({ length: 4 }, () => {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 0 }, uCol: { value: new THREE.Color() }, tRune: { value: runeTex } },
    vertexShader: UV_VERT,
    fragmentShader: /* glsl */`
      uniform float uAlpha; uniform vec3 uCol; uniform sampler2D tRune; varying vec2 vUv;
      void main(){
        float y = clamp(vUv.y, 0.0, 1.0), e = (y - 0.9) * 18.0;
        float edge = exp(-e * e);                                       // 上沿一道亮线
        float tail = y * y * y * 0.35;                                  // 往下拖一截淡光
        float rune = y > 0.45 && y < 0.8 ? texture2D(tRune, vec2(vUv.x * 18.0, (y - 0.45) / 0.35)).r * 0.6 : 0.0;
        float a = (edge + tail + rune) * uAlpha;
        gl_FragColor = vec4(mix(uCol, vec3(1.0), edge * 0.5) * a * 1.6, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(rippleGeo, mat); m.visible = false; m.frustumCulled = false; scene.add(m);
  return { m, mat, t0: -100, v: 1, y0: 0, dur: 1.6, h: 1.4 };
});
let rippleNext = 0;
function fxRipple({ v = 1, p = 0.5, col = null } = {}) {
  const r = ripples[rippleNext], st = pitchStyle(p); rippleNext = (rippleNext + 1) % ripples.length;
  r.t0 = time; r.v = v; r.y0 = camera.position.y - 6; r.dur = 1.6 / st.speed; r.h = 1.4 * st.size;
  r.mat.uniforms.uCol.value.setRGB(...(col ?? st.col));
}
function updateRipples(t) {
  for (const r of ripples) {
    const k = (t - r.t0) / r.dur;
    r.m.visible = k >= 0 && k < 1;
    if (!r.m.visible) continue;
    r.m.position.set(0, r.y0 + (k * k * (3 - 2 * k)) * 22, 0); r.m.scale.set(1, r.h, 1);
    r.mat.uniforms.uAlpha.value = Math.sin(Math.PI * k) * (0.5 + 0.5 * r.v);
  }
}

// ---- aurora：极光。一个音符一条丝带（最多 6 条同时）：
//   起音：丝带沿着自己的长度「长」出来（低音长得慢）；按住：保持亮度、轻轻呼吸；
//   松开：从尾巴往前收、一边往上飘一边淡掉（低音收得慢）。
//   和弦里每个音按音高分开：低音在下、圈大、帘子高、偏蓝紫，高音在上、圈小、偏青金；相邻两条反着转。
//   同时亮的条数越多，每条越暗一点（1/√n），和弦不会叠成一片白。
const AUR_N = 6, AUR_SEG = 220;
const ribbonGeo = (() => {
  const s = new Float32Array((AUR_SEG + 1) * 2), j = new Float32Array((AUR_SEG + 1) * 2), index = [];
  for (let i = 0; i <= AUR_SEG; i++) {
    s.set([i / AUR_SEG, i / AUR_SEG], i * 2); j.set([0, 1], i * 2);
    if (i < AUR_SEG) index.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((AUR_SEG + 1) * 2 * 3), 3));
  g.setAttribute('aS', new THREE.BufferAttribute(s, 1)); g.setAttribute('aJ', new THREE.BufferAttribute(j, 1)); g.setIndex(index);
  return g;
})();
const auroras = Array.from({ length: AUR_N }, (_, i) => {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime, uAmp: { value: 0 }, uGrow: { value: 0 }, uRet: { value: 0 }, uC1: { value: new THREE.Color() }, uC2: { value: new THREE.Color() },
      uR: { value: 3.3 }, uH: { value: 2.8 }, uSpan: { value: 18 }, uTurns: { value: 1.6 }, uDir: { value: 1 }, uPh: { value: 0 },
    },
    vertexShader: /* glsl */`
      attribute float aS; attribute float aJ;
      uniform float uR, uH, uSpan, uTurns, uDir, uPh;
      varying vec2 vUv;
      void main(){
        float th = uDir*aS*6.28318*uTurns + uPh, R = uR + 0.35*sin(aS*9.0 + uPh*3.0);
        vUv = vec2(aS, aJ);
        gl_Position = projectionMatrix*modelViewMatrix*vec4(R*cos(th), aS*uSpan + aJ*uH, R*sin(th), 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uAmp, uGrow, uRet, uDir; uniform vec3 uC1, uC2; varying vec2 vUv;
      void main(){
        float s = vUv.x, v = clamp(vUv.y, 0.0, 1.0);
        float grown = 1.0 - smoothstep(uGrow - 0.12, uGrow, s);           // 起音：只有已经长出来的那段
        float kept = smoothstep(uRet, uRet + 0.15, s);                     // 松开：从尾巴往前收
        float flow = 0.5 + 0.5*sin(s*55.0 - uTime*1.6*uDir + sin(s*13.0 + uTime*0.7)*2.0);
        float curtain = smoothstep(0.0, 0.1, v) * pow(1.0 - v, 1.7);       // 下沿亮、往上淡
        float rays = 0.78 + 0.22*sin(s*480.0 + uTime*2.5);
        float ends = smoothstep(0.0, 0.06, s) * (1.0 - smoothstep(0.9, 1.0, s));
        float gs = (uGrow - s) * 14.0, tip = exp(-gs * gs) * (1.0 - step(1.0, uGrow)) * 0.8;   // 正在长的那一头亮一点
        float a = curtain * rays * (0.35 + 0.65*flow) * ends * grown * kept * uAmp * (1.0 + tip);
        gl_FragColor = vec4(mix(uC1, uC2, v + 0.3*flow) * a * 1.1, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(ribbonGeo, mat); m.frustumCulled = false; m.visible = false; scene.add(m);
  return { m, mat, on: false, t0: 0, end: 0, v: 1, p: 0.5, att: 0.6, rel: 1.4, spin: 0.1, y0: 0, i };
});
let aurDir = 1;
/** 一个音符一条丝带；d 是按住多久（秒），默认 4 秒 */
function fxAurora({ v = 1, p = 0.5, d = 0 } = {}) {
  const a = auroras.find((x) => !x.on) ?? auroras.reduce((x, y) => (x.end < y.end ? x : y));   // 没有空的就顶掉最早松开的那条
  const st = pitchStyle(p), u = a.mat.uniforms;
  Object.assign(a, { on: true, t0: time, end: time + (d > 0 ? d : 4), v, p, att: lerp(0.9, 0.45, p), rel: lerp(1.8, 1.0, p), spin: lerp(0.07, 0.18, p) * (aurDir = -aurDir) });
  a.y0 = camera.position.y - 8 + p * 8;
  u.uR.value = lerp(3.4, 2.2, p); u.uH.value = lerp(2.4, 1.4, p); u.uTurns.value = lerp(1.2, 2.0, p); u.uDir.value = aurDir; u.uPh.value = rand(0, 6.28);
  u.uC1.value.setRGB(...st.col); u.uC2.value.setRGB(...pitchCol(Math.min(1, p + 0.3)));
}
function updateAurora(t) {
  const n = auroras.filter((a) => a.on).length, norm = Math.min(1, 1 / Math.sqrt(Math.max(1, n)));
  for (const a of auroras) {
    a.m.visible = a.on;
    if (!a.on) continue;
    const u = a.mat.uniforms, ret = Math.max(0, (t - a.end) / a.rel);
    if (ret >= 1) { a.on = false; a.m.visible = false; continue; }
    u.uGrow.value = easeOut(Math.min(1, (t - a.t0) / a.att)) * 1.12;      // 长到头再多一点，让前沿完全出来
    u.uRet.value = ret * 1.15;
    u.uAmp.value = a.v * norm * (0.9 + 0.1 * Math.sin(t * 1.3 + a.i)) * Math.pow(1 - ret, 0.7);
    a.m.position.set(0, a.y0 + ret * 2.0, 0);                             // 松开后一边收一边往上飘
    a.m.rotation.y = (t - a.t0) * a.spin;
  }
}

// ---- chime：一点光沿栏杆往前跑，路过的灯一盏盏迸亮（音越高跑得越远、越快、越暖）
const chimeTrails = makeTrails(4, 26, 0.13, 0.02, 2.4);
scene.add(chimeTrails.points); fxObjects.push(chimeTrails.points);
const chimes = Array.from({ length: 4 }, () => {
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softWhite, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.scale.setScalar(0.7); glow.visible = false; scene.add(glow); fxObjects.push(glow);
  return { glow, t0: -100, s0: 0, span: 16, col: FX_COL.gold, sPrev: 0, on: false, dur: 0.9, v: 1 };
});
let chimeNext = 0;
const railPoint = (s, out) => out.copy(polar(R_RAIL, s * DTH, railY(s) + 0.55));
function fxChime({ v = 1, p = 0.5, col = null } = {}) {
  const i = chimeNext, c = chimes[i]; chimeNext = (chimeNext + 1) % chimes.length;
  c.t0 = time; c.s0 = progress + 1; c.span = 12 + 14 * p; c.sPrev = c.s0; c.on = true; c.v = v; c.dur = 0.9 / pitchStyle(p).speed;
  c.col = col ?? pitchCol(p);
  chimeTrails.cols[i] = c.col; chimeTrails.hist[i].length = 0;
  c.glow.material.color.setRGB(c.col[0] * 3, c.col[1] * 3, c.col[2] * 3);
}
function updateChimes(t) {
  if (!chimes.some((c) => c.on)) return;        // 没有灯链在跑：不用每帧重传粒子缓冲
  chimes.forEach((c, i) => {
    if (!c.on) return;
    const k = (t - c.t0) / c.dur;
    if (k > 1.5) { c.on = false; c.glow.visible = false; chimeTrails.hist[i].length = 0; return; }
    const s = c.s0 + c.span * easeOut(Math.min(1, k));
    railPoint(s, tmpF);
    c.glow.visible = k < 1; c.glow.position.copy(tmpF);
    chimeTrails.push(i, tmpF);
    for (let j = Math.ceil((c.sPrev - 4.5) / 8); lampK(j) + 0.5 <= s; j++) if (lampK(j) + 0.5 > c.sPrev) spawnBurst(lampPos(j), c.col, 0.3 + 0.3 * c.v, 0);
    c.sPrev = s;
  });
  chimeTrails.flush();
}

/* ============================================================
 * 后期：泛光 → 色调映射 → HD-2D（移轴 + 冷暗暖亮 + 暗角）
 * ============================================================ */
const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const BLOOM_BASE = 0.7;
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), BLOOM_BASE, 0.45, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const hd2d = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null }, uRes: { value: new THREE.Vector2(innerWidth, innerHeight) }, uTime: { value: 0 },
    uFocusY: { value: 0.3 }, uFocusW: { value: 0.22 }, uBlur: { value: 3.0 }, uOn: { value: 1.0 },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uTime, uFocusY, uFocusW, uBlur, uOn;
    varying vec2 vUv;
    const vec2 P[12] = vec2[12](vec2(-0.326,-0.406),vec2(-0.840,-0.074),vec2(-0.696,0.457),vec2(-0.203,0.621),
      vec2(0.962,-0.195),vec2(0.473,-0.480),vec2(0.519,0.767),vec2(0.185,-0.893),vec2(0.507,0.064),
      vec2(0.896,0.412),vec2(-0.322,-0.933),vec2(-0.792,-0.598));
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      if (uOn > 0.5) {
        // 只糊对焦带下方（近处台阶）和最上沿，中段的特效保持清楚
        float d = vUv.y < uFocusY ? (uFocusY - vUv.y) * 1.6 : max(0.0, vUv.y - 0.82) * 2.0;
        float amt = smoothstep(uFocusW * 0.5, uFocusW + 0.3, d);
        vec2 r = amt * uBlur / uRes;
        if (amt > 0.01) {
          vec3 acc = col;
          for (int i = 0; i < 12; i++) acc += texture2D(tDiffuse, vUv + P[i]*r).rgb;
          col = acc / 13.0;
        }
      }
      float lum = dot(col, vec3(0.2126,0.7152,0.0722));
      col = mix(col, col*vec3(0.84,1.0,1.12), (1.0 - smoothstep(0.0, 0.5, lum))*0.35);     // 暗部偏青
      col = mix(col, col*vec3(1.08,1.0,0.88), smoothstep(0.5, 1.0, lum)*0.35);             // 亮部偏金
      col = col*0.95 + vec3(0.02, 0.035, 0.05);
      lum = dot(col, vec3(0.2126,0.7152,0.0722));
      col = mix(vec3(lum), col, 1.12);
      vec2 q = vUv - 0.5; q.x *= uRes.x/uRes.y;
      col *= mix(0.72, 1.0, 1.0 - smoothstep(0.35, 1.05, length(q)));
      col += (hash(vUv*uRes + fract(uTime)*100.0) - 0.5) * 0.012;
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
});
composer.addPass(hd2d);

/* ============================================================
 * 镜头 / 每帧更新
 * ============================================================ */
composer.renderToScreen = false;
let running = true;

// 低机位：镜头贴着台阶、在骑士身后，往天井和塔顶仰拍。
// 骑士身体中心落在画面左下的黄金分割点（左 0.382、上 0.618）：竖向由 lh 定（竖直视角固定，跟屏幕宽高比无关），
// 横向每帧按宽高比把镜头转一点（宽屏不会往中间跑）；tilt 只留一点慢慢的抬头低头，不把骑士带离分割点
const CAM = { back: 8.5, r: 8.1, h: 2.8, ahead: 0.4, lr: 5.0, lh: 2.25, tilt: 0.35, fov: 72, gx: 0.29, gy: 0.58 };
const knAim = new THREE.Vector3(), knAimCam = new THREE.Vector3();
// 光之巨剑的镜头：turn 秒抬头（缓入缓出），剑显形到劈完 strike 秒一直看着，再用 back 秒回到骑士的黄金分割点。
// 朝中轴线上剑身砸下来的地方看过去：先抬头、再往天井那边转，各自只转到骑士还留在画面里为止
// （骑士身体中心离左右边、下边留 keep，脚不出下边）—— 骑士一直在画面里，转过去刚好看见剑身从上面劈下来
const SWORD = { turn: SWORD_TURN, strike: 2.7, back: 1.8, height: 14, length: 12, keepX: 0.8, keepY: -0.7, keepFeet: -0.97 };
const swordQ0 = new THREE.Quaternion(), swordQ = new THREE.Quaternion(), swordQ2 = new THREE.Quaternion(), swordAim = new THREE.Vector3(), swordP = new THREE.Vector3();
// 剑从塔顶开口的圆心劈下来：剑柄在塔的中轴线上、比镜头高 height（出场那一刻定下，之后固定在塔里），剑长 length
function swordPivot() {
  if (!ev.pivot) { ev.pivot = new THREE.Vector3(0, camera.position.y + SWORD.height, 0); ev.L = SWORD.length; }
  return ev.pivot;
}
function knightInFrame() {
  camera.updateMatrixWorld();
  const c = swordP.copy(knAim).project(camera);
  if (Math.abs(c.x) > SWORD.keepX || c.y < SWORD.keepY) return false;
  return swordP.copy(knight.position).project(camera).y >= SWORD.keepFeet;
}
function swordLook(t) {
  if (!ev || ev.type !== 'sword') return 0;
  const e = t - ev.t0, ss = THREE.MathUtils.smoothstep;
  if (e < SWORD.turn) return ss(e, 0, SWORD.turn);
  return 1 - ss(e, SWORD.turn + SWORD.strike, SWORD.turn + SWORD.strike + SWORD.back);
}
let progress = SPT;
let time = 0;
// 接缝检测用（scripts/seam.mjs）：塔每爬一圈整体往上挪一圈，平时是 0；调试时拨成 ±1 看「换一圈塔」画面变不变
let towerShift = 0;
let freeCam = false;
const clock = new THREE.Clock();
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), tmp3 = new THREE.Vector3(), camRight = new THREE.Vector3(), camUp = new THREE.Vector3(), prevKn = new THREE.Vector3();
const mBook = new THREE.Matrix4(), mPart = new THREE.Matrix4(), mOut = new THREE.Matrix4(), vScale = new THREE.Vector3();
const dummy = new THREE.Object3D();
let nextEvent = 4, ev = null, shake = 0, bloomBoost = 0, flash = 0, resonance = 0, lastFrame = -1;

function stairTop(s) {
  const k = Math.floor(s), f = s - k;
  const e = THREE.MathUtils.smoothstep(f, 0.55, 1.0);
  return (k + 1 + e) * RISE + Math.sin(Math.PI * e) * 0.07;
}
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
// 精灵贴图像素 → 世界坐标（精灵始终面向镜头）
// px, py are in the original 80 px cell; scaled to whatever cell the sprite sheet uses now
function knightPixel(px, py, out) {
  const k = KN_CELL / 80;
  return out.copy(knight.position).addScaledVector(camRight, ((px * k + 0.5) / KN_CELL - 0.5) * KN_SIZE)
    .addScaledVector(UP, (1 - (py * k + 0.5) / KN_CELL) * KN_SIZE - KN_FEET * KN_SIZE);
}

function updateWell(t, camY) {
  updateShards(t, camY);
  wellLight.position.set(0, camY + 2, 0);
  deepLight.position.set(0, camY - 5, 0);
  armillary.position.set(0, camY + 19 + Math.sin(t * 0.3) * 0.6, 0);
  armRings[0].rotation.set(t * 0.25, 0, 0.4);
  armRings[1].rotation.set(1.1, t * 0.4, t * 0.15);
  armRings[2].rotation.set(t * -0.5, 0.7, t * 0.3);
  armLight.position.copy(armillary.position);
  armGlow.material.opacity = 0.75 + 0.25 * Math.sin(t * 1.7);
  armGlow.scale.setScalar(4.2 * (1 + armPulse * 0.9));

  RINGS.forEach((R, i) => {
    const m = ringMeshes[i];
    const y = wrap(R.y + t * 0.12, camY - 8, ringSpan);
    m.position.set(0, y, 0);
    m.rotation.set(R.tilt > 1 ? R.tilt : R.tilt * Math.sin(t * 0.2 + i), t * R.spin, R.tilt > 1 ? 0 : R.tilt * Math.cos(t * 0.17 + i));
    const rel = (y - (camY - 8)) / ringSpan;
    m.material.opacity = 0.85 * THREE.MathUtils.smoothstep(rel, 0, 0.12) * (1 - THREE.MathUtils.smoothstep(rel, 0.85, 1));
    m.material.color.setRGB(...R.col).multiplyScalar(1 + ringFlare * 1.5);
  });

  const FLIP = new THREE.Matrix4().makeRotationX(Math.PI);    // 左半边：先绕书脊翻面，再转到左侧 → 衬纸仍朝里
  flyers.forEach((b, i) => {
    const L = leaders[b.lead];
    const sway = tmp2.copy(b.off).applyAxisAngle(UP, Math.sin(t * 0.7 + b.ph) * 0.6);
    const p = leaderPos(L, t, camY, tmp).add(sway);
    const q = leaderPos(L, t + 0.06, camY, new THREE.Vector3()).add(sway);
    // 书别糊到镜头上（进塔俯冲时镜头从天井里穿过）：离得太近就往外让开，大书让得多
    const keep = 1.6 + b.s * 0.8, away = tmp3.subVectors(p, camera.position), d = away.length();
    if (d < keep) p.addScaledVector(d > 1e-4 ? away.divideScalar(d) : UP, keep - d);
    const vel = q.sub(p);
    if (vel.lengthSq() > 1 || vel.lengthSq() < 1e-8) vel.copy(tangent(Math.atan2(p.z, p.x))).multiplyScalar(Math.sign(L.w));
    mBook.lookAt(p, new THREE.Vector3().copy(p).sub(vel), UP);
    mBook.multiply(mPart.makeRotationZ(-0.3 * Math.sign(L.w) + 0.15 * Math.sin(t + b.ph)));
    mBook.scale(vScale.setScalar(b.s));
    mBook.setPosition(p);
    const wing = (lagPh) => 0.22 + 0.6 * Math.sin(t * b.flap + b.ph - lagPh);
    const a = wing(0);
    const side = (ang, flip) => flip ? mOut.multiplyMatrices(mBook, mPart.makeRotationZ(Math.PI - ang)).multiply(FLIP) : mOut.multiplyMatrices(mBook, mPart.makeRotationZ(ang));
    covers.setMatrixAt(i * 2, side(a, false));
    covers.setMatrixAt(i * 2 + 1, side(a, true));
    spines.setMatrixAt(i, mBook);
    for (let j = 0; j < SHEETS; j++) {
      const pa = Math.min(1.45, Math.max(a + 0.04 + j * 0.05, wing(0.5 * (j + 1)) + 0.1 + j * 0.08));
      sheets.setMatrixAt((i * 2) * SHEETS + j, side(pa, false));
      sheets.setMatrixAt((i * 2 + 1) * SHEETS + j, side(pa, true));
    }
  });
  covers.instanceMatrix.needsUpdate = true;
  sheets.instanceMatrix.needsUpdate = true;
  spines.instanceMatrix.needsUpdate = true;

  const frame = Math.floor(t * 14) % 2;
  fairies.forEach((f, i) => {
    const p = fairyPos(f, t, camY, tmp);
    f.sp.position.copy(p); f.glow.position.copy(p);
    f.sp.material.map = fairyFrames[(frame + i) % 2];
    const near = THREE.MathUtils.smoothstep(p.distanceTo(camera.position), 1.5, 4.0);
    f.glow.material.opacity = (0.75 + 0.25 * Math.sin(t * 6 + f.ph)) * near;
    f.sp.material.opacity = near;
    fairyTrails.push(i, p);
  });
  fairyTrails.flush();

  pageSeeds.forEach((p, i) => {
    const y = wrap(p.y - t * 0.12, camY - 8, 28) + Math.sin(t * 0.4 + p.ph) * 0.5;
    dummy.position.copy(polar(p.r + Math.sin(t * 0.3 + p.ph) * 0.4, p.th + t * 0.05 * p.dir, y));
    dummy.rotation.set(Math.sin(t * 1.6 + p.ph) * 0.9, t * 0.5 + p.ph, Math.cos(t * 1.2 + p.ph) * 0.6);
    dummy.updateMatrix(); pages.setMatrixAt(i, dummy.matrix);
  });
  pages.instanceMatrix.needsUpdate = true;

  // 彗星
  if (t >= nextComet) { if (!scoreRun) spawnComet(camY); nextComet = t + rand(0.6, 1.8); }   // 放乐谱时流星只跟主旋律走
  comets.forEach((c, i) => {
    if (c.state === 0) return;
    const k = (t - c.t0) / c.dur;
    if (c.state === 1) {
      if (k >= 1) {
        bez(c, 1, tmp);
        spawnBurst(tmp, c.col, rand(0.8, 1.4), 0);
        c.state = 2; c.t0 = t; c.glow.visible = false;
      } else {
        bez(c, k, tmp);
        c.glow.position.copy(tmp);
        cometTrails.push(i, tmp);
      }
    } else if (c.state === 2) {
      bez(c, 1, tmp); cometTrails.push(i, tmp);           // 尾巴收进撞击点
      if (t - c.t0 > 0.6) { c.state = 0; cometTrails.hist[i].length = 0; }
    }
  });
  cometTrails.flush();
}

// 天井里的大型魔法事件，骑士照常走路：
//   sword  —— 一柄光之巨剑在井中显形、劈落，冲击波横扫天井（slash）
//   shower —— 星辉仪一口气朝四面书墙射出一串彗星（shower）
//   pulse  —— 星辉仪先吸光、再爆开一圈横贯塔身的脉冲（swell）
// 骑士的剑会和这些事件「共鸣」：剑光变亮、碎屑变多。
// 没有乐谱时（屏保平时就是这样）每隔 6–11 秒随机上演一段：三个大事件，和用乐器特效编的三小段。
// 随机但不轰炸：不连着放同一段，两个大事件之间至少隔一小段，段与段之间留足空。
const AMBIENT = ['sword', 'beams', 'shower', 'sigils', 'pulse', 'aurora'];
const PHRASES = {
  beams: [[0, 'beam', { v: 1 }], [0.2, 'glitter', { v: 0.6 }], [0.45, 'beam', { v: 0.65, p: 0.2 }], [0.9, 'beam', { v: 0.65, p: 0.8 }], [1.6, 'beam', { v: 1, p: 0.5 }]],
  sigils: [[0, 'sigil', { v: 0.8 }], [0.5, 'sigil', { v: 0.8, p: 0.8 }], [0.55, 'glitter'], [1.0, 'sigil', { v: 1 }], [1.3, 'ripple', { v: 0.8 }]],
  aurora: [[0, 'aurora', { d: 6 }], [0.8, 'chime', { p: 0.3 }], [2.4, 'chime', { p: 0.8 }], [4, 'ripple', { v: 0.6 }]],
};
let ringFlare = 0, armPulse = 0;
const pendingFx = [];                     // 排着队等打的特效 [时刻, 名字, 参数]
let scoreRun = null, gallery = null, evClock = 0;
function startEvent(type) { ev = { t0: time, type, n: 0 }; }
function endEvent(t) { ev = null; nextEvent = Math.max(nextEvent, t + rand(6, 11)); }
let lastAmbient = null;
function pickAmbient() {
  const big = (a) => !PHRASES[a];
  const pool = AMBIENT.filter((a) => a !== lastAmbient && !(lastAmbient && big(lastAmbient) && big(a)));
  return (lastAmbient = pool[Math.floor(Math.random() * pool.length)]);
}
function queueFx(list, t0 = time) { for (const [dt, name, o] of list) pendingFx.push([t0 + dt, name, o]); }
/** 打一个特效。name 见 FX_NAMES；o = { v 力度 0..1, p 音高 0..1, d 时值秒 } */
function triggerFx(name, opts = {}) {
  const camY = camera.position.y;
  const o = { v: Number.isFinite(opts.v) ? Math.min(Math.max(opts.v, 0), 1) : 1, p: normPitch(opts.p), d: Number.isFinite(opts.d) ? Math.max(0, opts.d) : 0 };
  switch (name) {
    case 'beam': return fxBeam(o);
    case 'sigil': return fxSigil(o);
    case 'glitter': return fxGlitter(o);
    case 'ripple': return fxRipple(o);
    case 'aurora': return fxAurora(o);
    case 'chime': return fxChime(o);
    case 'comet': return spawnComet(camY, null, o.p);
    case 'swell': return startEvent('pulse');
    case 'slash': return startEvent('sword');
    case 'shower': return startEvent('shower');
  }
}
/** 换播放方式（乐谱 / 画廊 / 停）时先清场：排队的特效、正在演的大事件都不带进下一段 */
function clearStage() { pendingFx.length = 0; ev = null; }
/**
 * 按乐谱打特效（乐谱格式见 src/score.js）。晚了 0.25 秒以上的音符直接跳过，不补打。
 *   play(score, delay)              delay 秒后从第 0 拍开始，用塔自己的时钟
 *   play(score, { clock })          跟着外面的时钟走：clock() 返回乐谱时间（秒），比如正在放的 BGM 的播放位置
 */
function playScore(score, opts = 0) {
  const { delay = 0, clock = null } = typeof opts === 'number' ? { delay: opts } : (opts ?? {});
  const compiled = compileScore(score);
  clearStage();
  scoreRun = { compiled, cursor: makeCursor(compiled, { maxLag: 0.25 }), t0: time + delay, clock: typeof clock === 'function' ? clock : null };
  gallery = null;
}
function stopScore() { clearStage(); scoreRun = null; gallery = null; moodName = 'walk'; nextEvent = Math.max(nextEvent, time + 2); }
/** 演示：每种特效轮流放一遍（onName(name) 告诉页面现在放的是哪个） */
const GALLERY = {      // 每种都从低音走到高音，看得出音高怎么变；极光是三个音错开起止的和弦
  beam: [[0, { v: 1, p: 0 }], [0.6, { v: 0.9, p: 0.33 }], [1.2, { v: 0.9, p: 0.66 }], [1.8, { v: 1, p: 1 }]],
  sigil: [[0, { v: 1, p: 0.05 }], [1.0, { v: 0.9, p: 0.5 }], [2.0, { v: 0.9, p: 0.95 }]],
  glitter: [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0].map((x, i) => [x, { v: 0.8, p: i / 8 }]),
  ripple: [[0, { v: 1, p: 0.1 }], [1.6, { v: 0.8, p: 0.9 }]],
  aurora: [[0, { v: 1, p: 0.15, d: 4.6 }], [0.8, { v: 1, p: 0.5, d: 3.0 }], [1.6, { v: 1, p: 0.9, d: 1.6 }]],
  comet: [[0, { p: 0.0 }], [0.45, { p: 0.33 }], [0.9, { p: 0.66 }], [1.35, { p: 1 }]],
  chime: [[0, { p: 0.1 }], [1.1, { p: 0.9 }]],
  swell: [[0, {}]], slash: [[0, {}]], shower: [[0, {}]],
};
function playGallery(onName) { clearStage(); gallery = { next: time + 0.5, i: 0, onName }; scoreRun = null; moodName = 'walk'; }

function updateEvents(t, camY) {
  blade.visible = false; slashArc.visible = false; swordTipGlow.visible = false;
  const dt = Math.max(0, t - evClock); evClock = t;
  if (mode !== 'run') {
    // 进塔、离塔的转场里（书房里塔的时钟停着）：乐谱和画廊的时钟一起停，排队的特效作废，
    // 不然再进塔时这几秒错过的特效会在同一帧全部打出来
    pendingFx.length = 0;
    if (scoreRun && !scoreRun.clock) scoreRun.t0 += dt;
    if (gallery) gallery.next += dt;
  } else {
    if (scoreRun) {
      const st = scoreRun.clock ? scoreRun.clock() : t - scoreRun.t0;
      for (const c of scoreRun.cursor.advance(st)) triggerFx(c.fx, c);
      moodName = sectionAt(scoreRun.compiled, st)?.mood ?? 'walk';
    } else if (gallery) {
      if (t >= gallery.next) {
        const name = FX_NAMES[gallery.i++ % FX_NAMES.length];
        gallery.onName?.(name);
        queueFx(GALLERY[name].map(([dt, o]) => [dt, name, o]), t);
        gallery.next = t + (name === 'aurora' ? 7.5 : 3.4);
      }
    } else if (!ev && t >= nextEvent) {
      const a = pickAmbient();
      if (PHRASES[a]) { queueFx(PHRASES[a], t); nextEvent = t + rand(6, 11); } else startEvent(a);
    }
  }
  for (let i = pendingFx.length - 1; i >= 0; i--) if (pendingFx[i][0] <= t) { const [, name, o] = pendingFx.splice(i, 1)[0]; triggerFx(name, o); }
  if (ev) {
    const e = t - ev.t0;
    if (ev.type === 'sword') {
      // 先给镜头 SWORD.turn 秒抬头转向塔顶（见 swordLook），剑再显形、劈落；劈完镜头慢慢回到骑士
      const e = t - ev.t0 - SWORD.turn;
      // 剑柄钉在塔顶圆心：剑先斜着显形（剑身伸向画面里那一侧、略往下），再往下劈到快竖直、砸进天井。
      // 圆心在画面右边就横在左边，反之在右边（a 是剑在画面里偏离「朝上」的角度：π/2 横、π 竖直朝下）
      const pivot = swordPivot(), L = ev.L;
      if (ev.side === undefined) { camera.updateMatrixWorld(); ev.side = swordP.copy(pivot).project(camera).x > 0 ? 1 : -1; }
      const A0 = 1.85 * ev.side, A1 = 2.9 * ev.side;
      const k = THREE.MathUtils.clamp((e - 0.9) / 0.38, 0, 1), a = A0 + (A1 - A0) * easeOut(k);
      const fade = e < 1.4 ? Math.min(1, e / 0.6) : Math.max(0, 1 - (e - 1.4) / 0.7);    // 砸到底后 0.7 秒收掉，让冲击波露出来
      const dir = new THREE.Vector3().addScaledVector(camRight, -Math.sin(a)).addScaledVector(camUp, Math.cos(a));
      blade.visible = fade > 0.01; blade.position.copy(pivot);
      blade.quaternion.copy(camera.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a));
      blade.scale.set(3.0 * L / 11, L, 1); bladeMat.uniforms.uA.value = fade;
      if (k > 0 && fade > 0.01) {
        slashArc.visible = true; slashArc.position.copy(pivot); slashArc.quaternion.copy(camera.quaternion); slashArc.scale.setScalar(L / 5);
        arcMat.uniforms.uA0.value = A0 + Math.PI / 2; arcMat.uniforms.uA1.value = a + Math.PI / 2; arcMat.uniforms.uAlpha.value = fade * 0.5;   // 剑很长，刀光扇面淡一点
      }
      if (ev.n === 0 && e > 0.1) { ev.n = 1; spawnBurst(pivot.clone().addScaledVector(dir, L * 0.8), [0.5, 0.8, 1.0], 2.2, 1); hit({ res: 0.8 }); }
      if (ev.n === 1 && k >= 1) {
        ev.n = 2;
        for (const f of [0.35, 0.65]) spawnBurst(pivot.clone().addScaledVector(dir, L * f), [0.35, 0.7, 1.0], 0.9 + f * 1.2, 0);
        // 砸到底：剑尖那个高度上，一圈冲击波从塔心横扫整个天井，后面跟一圈慢一点的余波
        const tip = pivot.clone().addScaledVector(dir, L), waveY = THREE.MathUtils.clamp(tip.y, camY - 1.5, camY + 5);
        startWave(waveY, 5.5, [0.6, 0.85, 1.0], 0, 0, 0.9);            // 横扫到栏杆为止，不从镜头头顶扫过去（不然整屏发白）
        startWave(waveY - 0.6, 4.0, [0.4, 0.7, 1.0], 0, 0, 1.6);
        spawnBurst(tip, [0.9, 0.95, 1.0], 1.3, 0);
        hit({ flash: 0.3, shake: 0.12, bloom: 0.15, res: 1.2, ring: 1, at: tip });   // 闪光收着点，让冲击波的圈看得见
      }
      if (e > SWORD.strike + SWORD.back) endEvent(t);
    } else if (ev.type === 'shower') {
      armPulse = Math.max(armPulse, Math.min(1, e * 2));
      if (e < 1.7 && e > ev.n * 0.17) { ev.n++; spawnComet(camY, armillary.position); }
      if (ev.n === 3) hit({ res: 0.8 });
      if (e > 2.3) endEvent(t);
    } else {
      if (ev.n === 0) { ev.n = 1; spawnBurst(armillary.position, [0.6, 0.85, 1.0], 3.0, 1); spawnBurst(armillary.position, [1.0, 0.85, 0.5], 2.0, 1); }
      if (e < 1) armPulse = Math.max(armPulse, e * 1.2);
      if (ev.n === 1 && e > 1.0) {
        ev.n = 2;
        spawnBurst(armillary.position, [0.45, 0.8, 1.0], 3.4, 0); spawnBurst(armillary.position, [1.0, 0.85, 0.5], 2.4, 0);
        startWave(armillary.position.y, 11, [0.65, 0.85, 1.0]);
        hit({ flash: 0.6, bloom: 0.3, ring: 1.3, arm: 1.6, res: 1.2, at: armillary.position });
      }
      if (e > 2.6) endEvent(t);
    }
  }
  updateWaves(t); updateBeams(t); updateSigils(t); updateRipples(t); updateAurora(t); updateChimes(t);
}

function update(dt) {
  time += dt;
  easeMood(dt);
  progress += dt * SPEED * moodNow.rate;
  const knS = progress, camS = knS - CAM.back;
  shared.uTime.value = time;
  hd2d.uniforms.uTime.value = time;
  camSU.value = camS;
  tower.position.y = TURN_H * (Math.floor(camS / SPT) + towerShift);

  const knTh = knS * DTH;
  prevKn.copy(knight.position);
  knight.position.copy(polar(R_WALK, knTh, stairTop(knS)));
  shadow.position.copy(polar(R_WALK, knTh, (Math.floor(knS) + 1) * RISE + 0.02));

  if (!freeCam) {
    camera.position.copy(polar(CAM.r, camS * DTH, camS * RISE + RISE + CAM.h + Math.sin(time * 0.5) * 0.05));
    const ts = knS + CAM.ahead;
    camera.lookAt(polar(CAM.lr, ts * DTH, knS * RISE + CAM.lh));
    // 把骑士身体中心放到画面 (gx, gy)：绕竖轴、再绕镜头横轴各转一点（各转三次收掉互相带出的误差），跟屏幕宽高比无关；
    // gy 带一点很慢的起伏（原来「慢慢抬头低头」的那一下）
    knAim.copy(knight.position).addScaledVector(UP, (0.5 - KN_FEET) * KN_SIZE);
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const wantX = Math.atan((2 * CAM.gx - 1) * tanH * camera.aspect);
    const wantY = Math.atan((1 - 2 * (CAM.gy + CAM.tilt * 0.04 * Math.sin(time * 0.09))) * tanH);
    for (let i = 0; i < 3; i++) {
      camera.updateMatrixWorld();
      knAimCam.copy(knAim).applyMatrix4(camera.matrixWorldInverse);
      camera.rotateOnWorldAxis(UP, wantX - Math.atan2(knAimCam.x, -knAimCam.z));
      camera.updateMatrixWorld();
      knAimCam.copy(knAim).applyMatrix4(camera.matrixWorldInverse);
      camera.rotateX(Math.atan2(knAimCam.y, -knAimCam.z) - wantY);
    }
    // 光之巨剑：镜头抬头看向塔顶下面悬着的剑，劈完再回来（只转不挪、视角不变）
    const sw = swordLook(time);
    if (sw > 0) {
      swordQ0.copy(camera.quaternion);
      camera.updateMatrixWorld();
      const q = swordP.copy(swordPivot()).addScaledVector(UP, -0.35 * ev.L).applyMatrix4(camera.matrixWorldInverse);   // 看剑身砸下来的地方
      const pitch = Math.max(0, Math.atan2(q.y, -q.z)), yaw = -Math.atan2(q.x, -q.z);
      swordQ.copy(camera.quaternion);
      const most = (apply) => {                            // 二分：这一步最多能转多少（0..1）还看得见骑士
        let lo = 0, hi = 1;
        for (let i = 0; i < 10; i++) {
          const mid = (lo + hi) / 2;
          camera.quaternion.copy(swordQ); apply(mid);
          if (knightInFrame()) lo = mid; else hi = mid;
        }
        return lo;
      };
      const kp = most((k) => camera.rotateX(pitch * k));
      camera.quaternion.copy(swordQ); camera.rotateX(pitch * kp); swordQ.copy(camera.quaternion);
      const ky = most((k) => camera.rotateOnWorldAxis(UP, yaw * k));
      camera.quaternion.copy(swordQ); camera.rotateOnWorldAxis(UP, yaw * ky);
      swordQ2.copy(camera.quaternion);
      camera.quaternion.copy(swordQ0).slerp(swordQ2, sw);
    }
    if (shake > 0.001) camera.position.add(new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(shake));
  } else {
    tmp.subVectors(knight.position, prevKn);
    camera.position.add(tmp);
    controls.target.copy(knight.position).add(new THREE.Vector3(0, 0.9, 0));
    controls.update();
  }
  camera.updateMatrixWorld();
  camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  camYU.value = camera.position.y;
  sky.position.copy(camera.position);
  // 满月挂在塔口里、略偏向镜头前方，避开正中星辉仪的光晕
  camera.getWorldDirection(tmp3); tmp3.y = 0; tmp3.normalize();
  moonDirU.value.set(tmp3.x * 13, camera.position.y + TOP_OFF + 46, tmp3.z * 13).sub(camera.position).normalize();
  moonLight.position.copy(camera.position).addScaledVector(moonDirU.value, 60);
  moonLight.target.position.copy(knight.position);
  crown.position.set(0, camera.position.y + TOP_OFF, 0);
  clipPlane.constant = camera.position.y + TOP_OFF + 0.6;
  shared.uClipY.value = clipPlane.constant;

  updateEvents(time, camera.position.y);
  // 走路帧：每两级台阶一个循环；着地那一帧在脚下迸一点辉光
  const WF = KN_META.anims.walk.frames ?? KN_META.frames;     // 走路表自己的帧数（和精灵表宽度对得上）
  const cyc = ((knS / 2) % 1 + 1) % 1, f = Math.min(WF - 1, Math.floor(cyc * WF));
  if (f !== lastFrame) {
    if (lastFrame !== -1 && (f === 2 || f === 6)) spawnBurst(knightPixel(f === 2 ? 35 : 45, 70, new THREE.Vector3()).add(new THREE.Vector3(0, 0.03, 0)), [0.45, 0.75, 1.0], 0.2, 0);
    lastFrame = f;
  }
  orientKnight(knight, camera, tangent(knTh), f);
  const nc = candleLights[1];
  setKnightLights(knight, [
    { pos: nc.position, color: [1.0, 0.7, 0.4], pow: 1.1 * Math.min(1, nc.intensity / 3), range: 6 },
    { pos: wellLight.position, color: [0.6, 0.85, 1.0], pow: 0.8, range: 10 },
    { pos: deepLight.position, color: [0.4, 0.6, 1.0], pow: 0.5, range: 12 },
    { pos: tmp3.copy(camera.position).add(moonDirU.value.clone().multiplyScalar(200)), color: [0.75, 0.9, 1.0], pow: 0.45, range: 1e4 },
  ]);
  knight.material.uniforms.uGlow.value = 2.2 + resonance * 2.4 + 0.25 * Math.sin(time * 3);
  bladeA.value.copy(knightPixel(25, 46, tmp2));
  bladeB.value.copy(knightPixel(12, 62, tmp2));
  auraU.value = 1 + resonance * 2;
  swordLight.position.copy(knightPixel(20, 54, tmp));
  swordLight.intensity = 3 + resonance * 9;

  shake *= Math.pow(0.02, dt); bloomBoost *= Math.pow(0.05, dt); flash *= Math.pow(0.03, dt);
  resonance *= Math.pow(0.3, dt); ringFlare *= Math.pow(0.15, dt); armPulse *= Math.pow(0.25, dt);
  bloom.strength = BLOOM_BASE + bloomBoost;
  flashLight.intensity = flash * 160;

  const cf = camS / 4 - 0.5, c0 = Math.floor(cf), frac = cf - c0;
  candleLights.forEach((l, i) => {
    const c = c0 + i, p = candleBase(c);
    l.position.set(p.x, p.y + 0.5, p.z);
    const w = i === 0 ? 1 - frac : i === CANDLE_LIGHTS - 1 ? frac : 1;
    l.intensity = 3.5 * w * (0.85 + 0.1 * Math.sin(time * 8 + c * 1.7) + 0.05 * Math.sin(time * 19 + c));
  });
  const lf = camS / 8, l0 = Math.floor(lf), lfr = lf - l0;
  lampLights.forEach((l, i) => { l.position.copy(lampPos(l0 + i)); l.intensity = 4 * moodNow.lamp * (i === 0 ? 1 - lfr : lfr); l.color.copy(LAMP_COL).lerp(LAMP_GOLD, moodNow.warm); });
  wellLight.intensity = 16 * (0.4 + 0.6 * moodNow.lamp); deepLight.intensity = 22 * (0.4 + 0.6 * moodNow.lamp);
  wellLight.color.copy(WELL_COL).lerp(LAMP_GOLD, moodNow.warm * 0.6);

  updateWell(time, camera.position.y);

  tmp.copy(knight.position).add(new THREE.Vector3(0, 0.9, 0)).project(camera);
  hd2d.uniforms.uFocusY.value = THREE.MathUtils.clamp(tmp.y * 0.5 + 0.5, 0.1, 0.7);
}

/* 书页爆飞：一把纸页从书里炸出来、翻滚着朝镜头飞（书房进塔、塔里那本书打开时都用） */
function makePageBurst(sceneRef, mat, N = 80) {
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.2, 0.26), mat, N);
  mesh.frustumCulled = false; mesh.visible = false; sceneRef.add(mesh);
  const parts = Array.from({ length: N }, () => ({ v: new THREE.Vector3(), w: new THREE.Vector3(), ph: Math.random() * 6 }));
  const origin = new THREE.Vector3(), o = new THREE.Object3D();
  let t0 = -100;
  return {
    fire(t, at, dir) {
      t0 = t; origin.copy(at);
      parts.forEach((pt) => {
        pt.v.randomDirection().multiplyScalar(0.8 + Math.random() * 2.4).addScaledVector(dir, 0.4 + Math.random() * 1.6);
        pt.v.y += Math.random() * 1.6;
        pt.w.set(rand(-9, 9), rand(-9, 9), rand(-9, 9));
      });
    },
    update(t) {
      const e = t - t0;
      mesh.visible = e >= 0 && e < 2.6;
      if (!mesh.visible) return;
      const drag = (1 - Math.exp(-e * 1.6)) / 1.6;
      parts.forEach((pt, i) => {
        o.position.copy(origin).addScaledVector(pt.v, drag);
        o.position.y -= 0.22 * e * e;
        o.position.x += Math.sin(e * 3 + pt.ph) * 0.12 * e;
        o.rotation.set(pt.w.x * drag * 0.6 + pt.ph, pt.w.y * drag * 0.6, pt.w.z * drag * 0.6);
        o.scale.setScalar(Math.max(0.001, Math.min(1, e * 8) * (1 - Math.max(0, e - 1.8) / 0.8)));
        o.updateMatrix(); mesh.setMatrixAt(i, o.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

/* ============================================================
 * 两个世界：书房（待机）和魔法塔（会话进行中）。各自离屏渲染（各带泛光 + HD-2D 后期），
 * 最后由一个合成着色器决定屏幕上显示哪个、以及转场时的符文传送门。
 * ============================================================ */
const study = buildStudy({
  THREE, makeCanvas, pixelTex, spriteTex, shade, mulberry32, makeShelfTextures, makeSoftCanvas,
  pointsMaterial, flameMaterial, COMMON_GLSL, NOISE_GLSL, SOFT_POINT_FRAG, BOOK_COLORS,
  makePageCanvas, makeCoverCanvas, makeEndpaperCanvas, makeKnightMesh, orientKnight, setKnightLights, shared,
  makePageBurst, sitHands: KN_META.sitHands, sitTurn: KN_META.sitTurn, glintGeometry, makeGlintMaterial,
  // Blender 建的书桌一角：GLB 的字节打包进来，直接解析（沙盒里不能 fetch）
  deskModel: { data: deskGlb, GLTFLoader, mergeVertices, mergeGeometries },
});
const studyComposer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 }));
studyComposer.addPass(new RenderPass(study.scene, study.camera));
const studyBloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.42, 0.4, 0.9);
studyComposer.addPass(studyBloom);
studyComposer.addPass(new OutputPass());
const studyHD = new ShaderPass(hd2d.material.clone());
studyComposer.addPass(studyHD);
studyComposer.renderToScreen = false;

// 合成：符文传送门。半径从「书」所在的屏幕位置往外长，边缘是噪声撕开的、蓝金交替的光环，
// 门里的画面带一点由小变大的拉伸，像从书页里钻出去 / 从书页里落回来
const compMat = new THREE.ShaderMaterial({
  uniforms: {
    tStudy: { value: null }, tTower: { value: null }, uMix: { value: 0 }, uDir: { value: 1 },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uAspect: { value: 1 }, uWall: { value: 0 }, uFlash: { value: 0 },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tStudy, tTower; uniform float uMix, uDir, uAspect, uWall, uFlash; uniform vec2 uCenter;
    varying vec2 vUv;
    float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
    float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(h2(i), h2(i+vec2(1,0)), f.x), mix(h2(i+vec2(0,1)), h2(i+vec2(1,1)), f.x), f.y); }
    float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ s += a*vn(p); p *= 2.1; a *= 0.5; } return s; }
    // 径向速度模糊：沿「到传送门中心」的方向多采几次，像被吸进去 / 被喷出来
    vec3 zoomBlur(sampler2D t, vec2 uv, float amt){
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 8; i++) { float k = float(i) / 7.0; acc += texture2D(t, uCenter + (uv - uCenter) * (1.0 - amt*k)).rgb; }
      return acc / 8.0;
    }
    void main(){
      vec2 q = (vUv - uCenter) * vec2(uAspect, 1.0);
      float d = length(q), ang = atan(q.y, q.x);
      float live = step(0.001, uMix) * step(uMix, 0.999);
      float n = fbm(vec2(ang*2.5, d*5.0 - uWall*2.5))*0.34 + fbm(vUv*9.0 + uWall*0.5)*0.12;
      float R = uMix * 2.4;
      float e = d + n - R;
      float inside = 1.0 - smoothstep(-0.012, 0.012, e);
      float amt = sin(clamp(uMix, 0.0, 1.0) * 3.14159) * 0.16 * live;
      vec2 zoomUv = uCenter + (vUv - uCenter) * mix(0.35, 1.0, smoothstep(0.0, 1.0, uMix));
      vec2 swirl = vec2(cos(ang + 1.57), sin(ang + 1.57)) * exp(-e*e*60.0) * 0.02 * live;
      vec2 ca = (vUv - uCenter) * amt * 0.25;                    // 色散
      vec3 study, tower;
      if (uDir > 0.0) {
        study = zoomBlur(tStudy, vUv + swirl, amt);
        tower = vec3(texture2D(tTower, zoomUv + ca).r, texture2D(tTower, zoomUv).g, texture2D(tTower, zoomUv - ca).b);
      } else {
        tower = zoomBlur(tTower, vUv + swirl, amt);
        study = vec3(texture2D(tStudy, zoomUv + ca).r, texture2D(tStudy, zoomUv).g, texture2D(tStudy, zoomUv - ca).b);
      }
      vec3 inner = uDir > 0.0 ? tower : study, outer = uDir > 0.0 ? study : tower;
      vec3 col = mix(outer, inner, inside);
      float ring = exp(-e*e*700.0) * live, ring2 = exp(-pow(e + 0.09, 2.0)*900.0) * live * 0.6, halo = exp(-e*e*40.0) * live * 0.4;
      vec3 rc = mix(vec3(0.3,0.7,1.0), vec3(1.0,0.82,0.45), 0.5 + 0.5*sin(ang*7.0 + uWall*6.0));
      vec3 rc2 = mix(vec3(0.75,0.5,1.0), vec3(0.4,0.95,1.0), 0.5 + 0.5*sin(ang*11.0 - uWall*8.0));
      col += rc * (ring*2.6 + halo) + rc2 * ring2 * 2.0;
      // 门边一圈闪烁的符文刻度
      float ticks = step(0.86, fract(ang * 36.0 / 6.2831 + uWall*1.5)) * exp(-pow(e + 0.05, 2.0)*1600.0) * live;
      col += vec3(1.0,0.9,0.6) * ticks * 2.0;
      col *= mix(1.0, 0.68, (1.0 - inside) * smoothstep(0.0, 0.6, uMix) * live);
      col += vec3(0.75,0.88,1.0) * uFlash;
      gl_FragColor = vec4(col, 1.0);
    }`,
  depthTest: false, depthWrite: false,
});
const compScene = new THREE.Scene(), compCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
compScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compMat));

// 屏幕空间的符文爆发：一圈蓝金光点 + 像素符文从书页（或镜头前的书）里旋转着喷出去
const glyphCanvas = (() => {
  const { c, g } = makeCanvas(64, 64), r = mulberry32(31);
  g.fillStyle = '#fff';
  for (let i = 0; i < 16; i++) {
    const ox = (i % 4) * 16 + 3, oy = Math.floor(i / 4) * 16 + 2;
    g.fillRect(ox + 4, oy, 2, 12);
    for (let k = 0; k < 3; k++) {
      const kind = Math.floor(r() * 3), sy = oy + Math.floor(r() * 9);
      if (kind === 0) g.fillRect(ox, sy, 10, 2);
      else for (let j = 0; j < 5; j++) g.fillRect(ox + 4 + (kind === 1 ? j : -j), sy + j, 2, 2);
    }
  }
  return c;
})();
const glyphTex = new THREE.CanvasTexture(glyphCanvas); glyphTex.magFilter = glyphTex.minFilter = THREE.NearestFilter; glyphTex.generateMipmaps = false;
const ovU = { uOrigin: { value: new THREE.Vector2() }, uT: { value: 2 }, uAspect: { value: 1 }, uScale: { value: 1 }, tGlyph: { value: glyphTex } };
const overlay = (() => {
  const N = 4200, seed = new Float32Array(N * 4);
  for (let i = 0; i < N * 4; i++) seed[i] = Math.random();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  const pts = new THREE.Points(g, new THREE.ShaderMaterial({
    uniforms: ovU,
    vertexShader: /* glsl */`
      attribute vec4 aSeed;
      uniform vec2 uOrigin; uniform float uT, uAspect, uScale;
      varying vec3 vColor; varying float vAlpha; varying float vType; varying float vGlyph; varying vec2 vDir;
      void main(){
        float delay = fract(aSeed.x*7.31) < 0.35 ? 0.2 : 0.0;           // 第二波晚一点再炸
        float tt = uT - delay;
        float t = clamp(tt / 0.95, 0.0, 1.0);
        float spin = (aSeed.w > 0.5 ? 1.0 : -1.0) * (1.0 + aSeed.y*5.0);
        float ang = aSeed.x*6.2831 + t*spin;
        float sp = 0.2 + aSeed.y*2.2;
        float r = sp * (1.0 - pow(1.0 - t, 2.6)) * 1.6;
        vec2 dir = vec2(cos(ang), sin(ang));
        vec2 p = uOrigin + vec2(dir.x / uAspect, dir.y) * r;
        p.y += t*t*0.3*(aSeed.w - 0.35);
        gl_Position = vec4(p, 0.0, 1.0);
        vType = aSeed.z < 0.22 ? 2.0 : aSeed.z < 0.5 ? 1.0 : 0.0;         // 2 符文, 1 拉丝, 0 光点
        vGlyph = floor(aSeed.w*16.0);
        vDir = normalize(vec2(cos(ang + spin*0.05), sin(ang + spin*0.05)));
        float base = vType > 1.5 ? 9.0 + aSeed.w*14.0 : vType > 0.5 ? 26.0 + aSeed.y*60.0 : 4.0 + aSeed.w*14.0;
        gl_PointSize = base * uScale * (vType > 0.5 && vType < 1.5 ? (0.4 + t*1.2) : (1.0 - t*0.45));
        float hue = fract(aSeed.x*3.7);
        vec3 c = hue < 0.3 ? vec3(0.35,0.8,1.0) : hue < 0.55 ? vec3(0.3,0.5,1.0) : hue < 0.82 ? vec3(1.0,0.82,0.45) : vec3(0.78,0.5,1.0);
        vColor = c * (0.9 + 1.4*(1.0 - t));
        vAlpha = smoothstep(0.0, 0.04, tt) * (1.0 - smoothstep(0.55, 1.0, t)) * step(tt, 1.0) * mix(0.35, 1.0, smoothstep(0.0, 0.25, r));
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tGlyph;
      varying vec3 vColor; varying float vAlpha; varying float vType; varying float vGlyph; varying vec2 vDir;
      void main(){
        vec2 c = gl_PointCoord - 0.5; c.y = -c.y;
        float a;
        if (vType > 1.5) {
          vec2 cell = vec2(mod(vGlyph, 4.0), floor(vGlyph / 4.0));
          vec2 uv = (cell + vec2(gl_PointCoord.x, gl_PointCoord.y)) / 4.0;
          a = texture2D(tGlyph, vec2(uv.x, 1.0 - uv.y)).a;
        } else if (vType > 0.5) {
          float along = dot(c, vDir), across = dot(c, vec2(-vDir.y, vDir.x));
          a = exp(-across*across*1400.0) * (1.0 - smoothstep(0.0, 0.5, abs(along))) * (0.35 + 0.65*smoothstep(-0.5, 0.5, along));
        } else {
          float d2 = dot(c, c)*4.0;
          a = exp(-d2*10.0) + exp(-d2*3.0)*0.25;
        }
        a *= vAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vColor*a, 1.0);
      }`,
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  pts.frustumCulled = false;
  return pts;
})();
// 一圈从爆点展开、边转边长大的魔法阵（屏幕空间）
const circleOverlay = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: ovU,
  vertexShader: /* glsl */`varying vec2 vNdc; void main(){ vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform vec2 uOrigin; uniform float uT, uAspect;
    varying vec2 vNdc;
    void main(){
      float t = clamp(uT, 0.0, 1.0);
      vec2 q = (vNdc - uOrigin) * vec2(uAspect, 1.0);
      float R = 0.1 + (1.0 - pow(1.0 - t, 3.0)) * 1.5;
      float d = length(q), ang = atan(q.y, q.x);
      float rings = exp(-pow((d - R)*70.0, 2.0)) + exp(-pow((d - R*0.84)*110.0, 2.0))*0.8 + exp(-pow((d - R*0.58)*140.0, 2.0))*0.6;
      float seg = (ang + t*4.0) * 36.0 / 6.2831;
      float ticks = step(0.8, fract(seg)) * step(R*0.84, d) * step(d, R);
      float rseg = (ang - t*3.0) * 18.0 / 6.2831;
      float runes = step(0.45, fract(sin(floor(rseg)*91.7)*437.5)) * step(0.25, fract(rseg)) * step(fract(rseg), 0.75) * step(R*0.62, d) * step(d, R*0.8);
      float star = 0.0;
      for (int k = 0; k < 5; k++) {   // 内圈五角星
        float a1 = float(k)/5.0*6.2831 + t*1.5, a2 = float(k+2)/5.0*6.2831 + t*1.5;
        vec2 p1 = vec2(cos(a1), sin(a1))*R*0.58, p2 = vec2(cos(a2), sin(a2))*R*0.58;
        vec2 pa = q - p1, ba = p2 - p1; float hh = clamp(dot(pa, ba)/dot(ba, ba), 0.0, 1.0);
        star += exp(-pow(length(pa - ba*hh)*180.0, 2.0));
      }
      float a = (rings + ticks*0.8 + runes*0.45 + star*0.7) * smoothstep(0.0, 0.05, uT) * (1.0 - smoothstep(0.5, 1.0, t)) * step(uT, 1.0);
      vec3 col = mix(vec3(1.0,0.82,0.45), vec3(0.4,0.85,1.0), 0.5 + 0.5*sin(ang*3.0 + t*6.0));
      gl_FragColor = vec4(col * a * 1.6, 1.0);
    }`,
  transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
}));
circleOverlay.frustumCulled = false;
const overlayScene = new THREE.Scene();
overlayScene.add(circleOverlay, overlay);
let burstT0 = -100;
function fireBurst(ndcX, ndcY) { ovU.uOrigin.value.set(ndcX, ndcY); burstT0 = wall; }

// 离开时那本冲到镜头前的书：前封面朝镜头，封面掀开时书页爆出光
const heroBook = new THREE.Group();
const heroPages = new THREE.MeshStandardMaterial({ map: pixelTex(makePageCanvas()), color: 0xfff4dc, roughness: 0.9, emissive: 0xffe0a8, emissiveIntensity: 0.2 });
const heroFront = new THREE.Group();
{
  const ct = pixelTex(makeCoverCanvas()); ct.wrapS = ct.wrapT = THREE.ClampToEdgeWrapping;
  const et = pixelTex(makeEndpaperCanvas()); et.wrapS = et.wrapT = THREE.ClampToEdgeWrapping;
  const edge = new THREE.MeshStandardMaterial({ color: 0x2a2a5a, roughness: 0.6 });
  const outer = new THREE.MeshStandardMaterial({ map: ct, color: 0x3a4c9a, roughness: 0.5, emissive: 0x6a5a48, emissiveMap: ct, emissiveIntensity: 0.4 });
  const inner = new THREE.MeshStandardMaterial({ map: et, color: 0x8a96d0, roughness: 0.9 });
  const cg = new THREE.BoxGeometry(0.32, 0.44, 0.022); cg.translate(0.16, 0, 0);
  const front = new THREE.Mesh(cg, [edge, edge, edge, edge, outer, inner]);
  heroFront.add(front);
  heroBook.add(heroFront);
  const blk = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.42, 0.06), heroPages); blk.position.set(0.16, 0, -0.042); heroBook.add(blk);
  const back = new THREE.Mesh(cg, [edge, edge, edge, edge, inner, outer]); back.position.z = -0.084; heroBook.add(back);
  const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.44, 10), edge); sp.position.set(0, 0, -0.042); heroBook.add(sp);
}
heroBook.visible = false;
scene.add(heroBook);
const towerPages = makePageBurst(scene, new THREE.MeshStandardMaterial({ map: pixelTex(makePageCanvas()), color: 0xe8dcc4, side: THREE.DoubleSide, roughness: 0.9, emissive: 0xffe0a8, emissiveIntensity: 0.25 }), 90);
let heroBurstDone = false;
// 书页的光不挂在书上：书藏起来时灯也跟着不算数，塔里灯数一变，所有材质都要重编着色器（离开那一下会卡 0.4 秒）。
// 灯一直在场景里，不用时亮度 0，位置每帧跟着书走。
const heroLight = new THREE.PointLight(0xffe0b0, 0, 0, 2); scene.add(heroLight);
const HERO_LIGHT_AT = new THREE.Vector3(0.16, 0, 0.3);

/* ---------------- 状态机：idle（书房）→ enter → run（塔）→ leave → idle ---------------- */
let mode = 'idle', modeT = 0, wall = 0, queued = null;
const T_ENTER = 4.2, T_LEAVE = 4.0;
const ss = THREE.MathUtils.smoothstep, clamp01 = (x) => Math.min(1, Math.max(0, x));
function setMode(m) { mode = m; modeT = 0; demoT = 0; }
function enterTower() { if (mode === 'idle') setMode('enter'); else if (mode === 'leave') queued = 'enter'; }
function leaveTower() { if (mode === 'run') setMode('leave'); else if (mode === 'enter') queued = 'leave'; }

let demo = false, demoT = 0;
const IDLE_DEMO = 7, RUN_DEMO = 26;

const swoopFrom = new THREE.Vector3(), swoopLook = new THREE.Vector3(), normLook = new THREE.Vector3();
function swoopCamera(k) {
  // 刚进塔：镜头从天井高处俯冲下来，绕到骑士身后
  const e = ss(k, 0, 1);
  camera.getWorldDirection(normLook); normLook.multiplyScalar(10).add(camera.position);
  swoopFrom.set(knight.position.x * 0.25, camera.position.y + 16, knight.position.z * 0.25);
  swoopLook.copy(knight.position).add(new THREE.Vector3(0, 0.8, 0));
  camera.position.lerpVectors(swoopFrom, camera.position.clone(), e);
  camera.position.y += Math.sin(e * Math.PI) * 1.5;
  const roll = (1 - e) * (1 - e) * 2.4;                     // 俯冲时镜头翻滚着落下来
  camera.up.set(Math.sin(roll), Math.cos(roll), 0);
  camera.lookAt(swoopLook.lerp(normLook, e));
  camera.fov = CAM.fov + (1 - e) * 22; camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}
function placeHeroBook(e) {
  // 离开：一本书从天井飞来，转着圈冲到镜头前、正对镜头，封面掀开
  const k = clamp01(e / 1.25), ke = ss(k, 0, 1);
  const fwd = camera.getWorldDirection(new THREE.Vector3());
  const end = camera.position.clone().addScaledVector(fwd, 0.5).addScaledVector(camRight, -0.16);
  const start = camera.position.clone().addScaledVector(fwd, 13).addScaledVector(camUp, 3.5).addScaledVector(camRight, 2.5);
  const ctrl = start.clone().lerp(end, 0.5).addScaledVector(camRight, -3).addScaledVector(camUp, 1.5);
  const a = (1 - ke) * (1 - ke), b = 2 * (1 - ke) * ke, c = ke * ke;
  heroBook.position.set(a * start.x + b * ctrl.x + c * end.x, a * start.y + b * ctrl.y + c * end.y, a * start.z + b * ctrl.z + c * end.z);
  heroBook.quaternion.copy(camera.quaternion).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler((1 - ke) * 1.2, (1 - ke) * Math.PI * 6, (1 - ke) * 0.8)));
  heroBook.scale.setScalar(0.6 + ke * 0.9);
  const open = ss(e, 1.15, 1.6);
  heroFront.rotation.y = -open * 2.5;
  heroPages.emissiveIntensity = 0.15 + open * 1.1;
  heroBook.visible = e < 2.6;
  heroBook.updateMatrixWorld();
  heroLight.position.copy(HERO_LIGHT_AT).applyMatrix4(heroBook.matrixWorld);
  heroLight.intensity = heroBook.visible ? open * 1.5 : 0;
}

function frame(dt, draw = true) {
  wall += dt; modeT += dt;
  compMat.uniforms.uWall.value = wall;
  if (demo) {
    demoT += dt;
    if (mode === 'idle' && demoT > IDLE_DEMO) enterTower();
    else if (mode === 'run' && demoT > RUN_DEMO) leaveTower();
  }
  const e = modeT;
  let showStudy = false, showTower = false, mix = 0, dir = 1, flash = 0;
  const pose = { k: 0, pow: 0.15, rapid: false };
  if (mode === 'idle') showStudy = true;
  else if (mode === 'enter') {
    // 0 → 1.5s 镜头扎进书页、书越翻越快越亮；1.3s 符文从书里喷出、传送门打开；之后塔里俯冲到骑士身后
    pose.k = ss(e, 0, 1.5); pose.pow = 0.15 + ss(e, 0.2, 1.4) * 1.1; pose.rapid = e > 0.45;
    pose.surge = ss(e, 0.2, 1.3); pose.burst = e > 1.25;
    showStudy = e < 2.5; showTower = e > 1.2;
    mix = ss(e, 1.35, 2.45); dir = 1;
    flash = Math.max(0, 1 - Math.abs(e - 1.4) / 0.12) * 0.35;
    if (e > T_ENTER) { setMode('run'); if (queued === 'leave') { queued = null; setMode('leave'); } }
  } else if (mode === 'run') showTower = true;
  else if (mode === 'leave') {
    // 0 → 1.25s 书飞到镜头前；1.2s 封面掀开、光爆，传送门从屏幕中央打开回到书房；书房镜头从书页上拉回来
    showTower = e < 2.6; showStudy = e > 1.3;
    mix = ss(e, 1.45, 2.5); dir = -1;
    pose.k = 1 - ss(e, 1.45, 3.7); pose.pow = 0.8 - ss(e, 1.5, 3.4) * 0.65; pose.rapid = e > 1.4 && e < 2.4;
    pose.surge = 1 - ss(e, 1.6, 3.4);
    flash = Math.max(0, 1 - Math.abs(e - 1.45) / 0.14) * 0.25;
    if (e > T_LEAVE) { setMode('idle'); if (queued === 'enter') { queued = null; setMode('enter'); } }
  }
  if (mode === 'enter' && e > 1.28 && burstT0 < wall - e + 1.28) {
    const bp = study.bookWorld().project(study.camera); fireBurst(bp.x, bp.y);
  }
  if (mode === 'leave' && e > 1.42 && burstT0 < wall - e + 1.42) fireBurst(0, 0);

  if (showTower) {
    camera.up.set(0, 1, 0);
    update(dt);
    if (mode === 'enter') swoopCamera(clamp01((e - 1.2) / 2.8));
    else if (camera.fov !== CAM.fov) { camera.fov = CAM.fov; camera.updateProjectionMatrix(); }
    if (mode === 'leave') {
      placeHeroBook(e);
      if (e > 1.4 && !heroBurstDone) { heroBurstDone = true; towerPages.fire(time, heroBook.position.clone(), camera.getWorldDirection(new THREE.Vector3()).negate()); }
    } else { heroBook.visible = false; heroLight.intensity = 0; heroBurstDone = false; }
    towerPages.update(time);
    renderer.toneMappingExposure = 1.25;
    if (draw) composer.render();
  }
  if (showStudy) {
    shared.uTime.value = wall;
    study.update(dt, wall, pose);
    const fp = (pose.k > 0.3 ? study.bookWorld() : study.focusWorld()).project(study.camera);   // 扎进书页时对焦到书上
    studyHD.uniforms.uFocusY.value = THREE.MathUtils.clamp(fp.y * 0.5 + 0.5, 0.15, 0.8);
    studyHD.uniforms.uFocusW.value = 0.18 + pose.k * 0.25;
    studyHD.uniforms.uTime.value = wall;
    studyBloom.strength = 0.42 + pose.pow * 0.2 + (pose.surge || 0) * 0.35;
    renderer.toneMappingExposure = 0.95;
    shared.uViewH.value = innerHeight * studyPR;          // 粒子按书房的渲染分辨率算像素大小
    if (draw) studyComposer.render();
    shared.uViewH.value = towerViewH;
    renderer.toneMappingExposure = 1.25;
  }
  if (!draw) return;
  compMat.uniforms.tStudy.value = studyComposer.readBuffer.texture;
  compMat.uniforms.tTower.value = composer.readBuffer.texture;
  compMat.uniforms.uMix.value = showStudy && showTower ? mix : showTower ? (dir > 0 ? 1 : 0) : (dir > 0 ? 0 : 1);
  if (!showTower) { compMat.uniforms.uDir.value = 1; compMat.uniforms.uMix.value = 0; }
  else if (!showStudy) { compMat.uniforms.uDir.value = 1; compMat.uniforms.uMix.value = 1; }
  else { compMat.uniforms.uDir.value = dir; compMat.uniforms.uMix.value = mix; }
  if (mode === 'enter') { const bp = study.bookWorld().project(study.camera); compMat.uniforms.uCenter.value.set(bp.x * 0.5 + 0.5, bp.y * 0.5 + 0.5); }
  else compMat.uniforms.uCenter.value.set(0.5, 0.5);
  compMat.uniforms.uFlash.value = flash;
  renderer.setRenderTarget(null);
  renderer.render(compScene, compCam);
  ovU.uT.value = (wall - burstT0) / 1.7;
  if (ovU.uT.value < 1.25) {
    renderer.autoClear = false;
    renderer.render(overlayScene, compCam);
    renderer.autoClear = true;
  }
}
/* ---------------- 预热：进塔那一下不卡 ----------------
 * 塔里的场景、书房里一开始藏着的东西（翻飞的书页、符文）、转场光爆，着色器都是第一次画到时才编译，
 * 进塔第 1.2 秒塔第一次露面会整个卡住 2 秒多。开屏画出第一帧后，趁书房还停着，在后台把它们编好
 * （有 KHR_parallel_shader_compile 就不占画面），编好后再把塔往离屏缓冲里画一帧，贴图也先传上去。 */
let warm = 'no';
function warmUp() {
  warm = 'compiling';
  const was = renderer.getRenderTarget();
  // 塔和书房都画进合成用的缓冲（不做色调映射），光爆直接画到屏幕：着色器版本跟着画到哪儿走，编的时候要对上
  renderer.setRenderTarget(rt);
  const jobs = [renderer.compileAsync(scene, camera), renderer.compileAsync(study.scene, study.camera)];
  renderer.setRenderTarget(null);
  jobs.push(renderer.compileAsync(overlayScene, compCam));
  renderer.setRenderTarget(was);
  Promise.all(jobs).then(() => { warm = 'render'; }, () => { warm = 'done'; });
}
function warmRender() {
  warm = 'done';
  // 藏着的东西（离开时那本书、翻飞的书页）画不到：贴图直接传上去
  for (const sc of [scene, study.scene]) sc.traverse((o) => {
    for (const m of [o.material].flat()) {
      if (!m) continue;
      for (const v of Object.values(m)) if (v?.isTexture && !v.isRenderTargetTexture) renderer.initTexture(v);
      if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u?.value?.isTexture && !u.value.isRenderTargetTexture) renderer.initTexture(u.value);
    }
  });
  if (mode !== 'idle') return;                          // 已经在进塔了：塔自己会画
  renderer.toneMappingExposure = 1.25;
  composer.render();                                    // 画进离屏缓冲，不上屏
}

let quality = { pr: Math.min(devicePixelRatio, 1.25), frameMs: 1000 / 61 }, lastT = -1e9, frames = 0;
const frameHooks = [];
function loop(t) {
  if (t - lastT < quality.frameMs - 2) return;
  lastT = t;
  const dt = Math.min(clock.getDelta(), 0.05);
  frame(dt);
  for (const f of frameHooks) f(dt);
  if (++frames === 2 && warm === 'no') warmUp();
  else if (warm === 'render') warmRender();
}
function renderFrame() { frame(0); }

// 书房按大约 520 行渲染再放大（不插值）：跟坐着的骑士精灵差不多一个像素一格，书桌和骑士的颗粒对得上
const STUDY_LINES = 520;
let studyPR = 1, towerViewH = 1;
function resize() {
  const w = innerWidth, h = innerHeight, pr = quality.pr;
  renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
  studyPR = Math.min(pr, STUDY_LINES / h);
  composer.setPixelRatio(pr); composer.setSize(w, h);
  studyComposer.setPixelRatio(studyPR); studyComposer.setSize(w, h);
  for (const rt of [studyComposer.renderTarget1, studyComposer.renderTarget2]) rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
  for (const cam of [camera, study.camera]) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
  shared.uViewH.value = towerViewH = h * pr;
  hd2d.uniforms.uRes.value.set(w * pr, h * pr); hd2d.uniforms.uBlur.value = 3.5 * pr;
  studyHD.uniforms.uRes.value.set(w * studyPR, h * studyPR); studyHD.uniforms.uBlur.value = 3.5 * studyPR;
  compMat.uniforms.uAspect.value = w / h;
  ovU.uAspect.value = w / h; ovU.uScale.value = pr * Math.max(0.7, h / 900);
  if (!running) renderFrame();
}
addEventListener('resize', resize);

/* ---------------- 对外接口（主题的 main.js 用） ---------------- */
export const magicTower = {
  /** 有会话开始跑：书房 → 进塔 */
  enter: enterTower,
  /** 全部结束：塔 → 回书房 */
  leave: leaveTower,
  get mode() { return mode; },
  get modeT() { return modeT; },
  /** pr：像素比；fps：最多多少帧 */
  setQuality(pr, fps) {
    quality = { pr, frameMs: 1000 / fps };
    resize();
  },
  onFrame(fn) { frameHooks.push(fn); },
  /** manual：不开动画循环，由 tick() 一帧一帧推（录视频） */
  start({ manual = false } = {}) {
    resize();
    update(0);
    clock.getDelta();
    if (!manual) renderer.setAnimationLoop(loop);
  },
  get canvas() { return renderer.domElement; },
  /** 乐器特效：trigger(name, { v, p, d }) 打一个；play(score) 按乐谱打（格式见 src/score.js）；gallery(onName) 每种轮流放一遍 */
  fx: { names: FX_NAMES, trigger: triggerFx, play: playScore, stop: stopScore, gallery: playGallery, get mood() { return moodName; } },
  /** 录视频：不靠 requestAnimationFrame，往前走一帧（draw 时画出来） */
  tick(dt, draw = true) { frame(dt, draw); for (const f of frameHooks) f(dt); },
  /** 调试：不靠 requestAnimationFrame 往前推 sec 秒（只在最后画一帧） */
  simulate(sec, fps = 30) {
    for (let i = 0; i < sec * fps; i++) { frame(1 / fps, false); for (const f of frameHooks) f(1 / fps); }
    frame(0);
  },
  /** 调试（接缝检测 scripts/seam.mjs）：停掉动画循环，把骑士摆到第 s 级台阶、时钟拨到 t 秒、塔多挪 shift 圈，画一帧。
   *  不推进时间、不起随机事件，同样的参数画出来的帧一模一样 */
  pose(s, t = time, shift = 0) {
    renderer.setAnimationLoop(null);
    progress = s; time = t; towerShift = shift;
    nextEvent = Infinity; lastFrame = -1;                 // 不起环境大事件；走路帧变了也不迸脚下辉光
    clearStage();                                         // 正在演的大事件收掉，余震、闪光也归零（镜头抖动每帧带随机数）
    shake = bloomBoost = flash = resonance = ringFlare = armPulse = 0;
    nextComet = Infinity; bT.fill(-1e9);                  // 随机路线的流星、已经迸开的辉光都收掉（时钟会被拨来拨去）
    comets.forEach((c, i) => { c.state = 0; c.glow.visible = false; cometTrails.hist[i].length = 0; });
    frame(0);
    towerShift = 0;
  },
  /** 塔的周期：每圈多少级台阶、骑士在镜头前多少级（塔在 s - back 是 SPT 的整数倍时整体挪一圈） */
  loop: { SPT, back: CAM.back, SPEED },
};
