// Prototype: the magic-tower knight as pixel-art Gaussian splats.
//
// export_splats.py samples the Blender knight into surfels (8 walk frames, same samples every frame). Each splat
// carries its palette ramp + base step (encoded in its colour) and its normal (its quaternion's thin axis). A Spark
// world modifier lights every splat each frame with the tower's knight lighting (scene.js makeKnightMesh: ambient
// + 4 lights, bands -> step offset, ink capped, glow unlit) and writes the ramp colour, so the output only ever uses
// the knight's 45 palette colours. post.js then turns the 2x supersampled render into pixels.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh, dyno } from '@sparkjsdev/spark';
import { createPost } from './post.js';

THREE.ColorManagement.enabled = false;   // palette colours stay exactly as authored

const BG = '#0d1422';
const AMBIENT = 0.46, BANDS = [0.32, 0.62, 0.9];   // scene.js uAmbient, knight.json shading.bands
const R_WALK = 6.8;                                  // tower centre is this far to his right

const $ = (id) => document.getElementById(id);
const ui = {
  px: $('px'), elev: $('elev'), spin: $('spin'), walk: $('walk'),
  pixel: $('pixel'), outline: $('outline'), cull: $('cull'), stats: $('stats'), panel: $('panel'),
};
for (const el of [ui.px, ui.elev, ui.spin, ui.walk]) {
  const out = el.nextElementSibling;
  const show = () => (out.value = el.value);
  el.addEventListener('input', show);
  show();
}
addEventListener('keydown', (e) => { if (e.key === 'h' || e.key === 'H') ui.panel.hidden = !ui.panel.hidden; });

// ---- data ---------------------------------------------------------------------------------------------------------
const meta = await (await fetch('./knight_walk.json')).json();
const bin = await (await fetch('./knight_walk.bin')).arrayBuffer();
const STEPS = meta.ramps[0].colors.length;
const palette = meta.ramps.flatMap((r) => r.colors);
const lit = meta.ramps.map((r) => r.lit);

// ---- renderer ------------------------------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
const dpr = Math.min(devicePixelRatio || 1, 2);
renderer.setPixelRatio(dpr);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
const spark = new SparkRenderer({ renderer });
scene.add(spark);
const lowRes = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.HalfFloatType });
const post = createPost(palette, STEPS);
post.uniforms.background.value.set(BG);

function setCrisp(on) {   // hard discs for the pixel pass; soft Gaussians for the raw view
  spark.falloff = on ? 0 : 1;
  spark.maxStdDev = on ? 1.5 : Math.sqrt(8);
  spark.blurAmount = on ? 0 : 0.3;
  spark.preBlurAmount = on ? 0.3 : 0;
}
setCrisp(true);

function resize() {
  const w = innerWidth, h = innerHeight, px = Number(ui.px.value);
  renderer.setSize(w, h);
  const lw = Math.max(1, Math.round(w / px)), lh = Math.max(1, Math.round(h / px));
  lowRes.setSize(lw * 2, lh * 2);
  post.uniforms.lowRes.value.set(lw, lh);
  post.uniforms.pixelSize.value = px * dpr;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
ui.px.addEventListener('input', resize);
resize();

// ---- lighting modifier ---------------------------------------------------------------------------------------------
const U = {
  cam: dyno.dynoVec3(new THREE.Vector3()),
  cull: dyno.dynoFloat(1),
  layer: dyno.dynoFloat(0),   // set once the spacing is known (metres the trim is lifted toward the camera)
  lights: [0, 1, 2, 3].map(() => ({
    pos: dyno.dynoVec3(new THREE.Vector3()), col: dyno.dynoVec3(new THREE.Vector3()), k: dyno.dynoVec2(new THREE.Vector2(0, 1)),
  })),
};
const glslPalette = `const vec3 PAL[${palette.length}] = vec3[${palette.length}](${palette.map((hex) => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`;
}).join(', ')});`;
const glslLit = `const float LIT[${lit.length}] = float[${lit.length}](${lit.map((l) => (l ? '1.0' : '0.0')).join(', ')});`;

function lightingModifier() {
  const inputs = { cam: U.cam, cull: U.cull, layer: U.layer }, inTypes = { gsplat: dyno.Gsplat, cam: 'vec3', cull: 'float', layer: 'float' };
  U.lights.forEach((L, k) => {
    Object.assign(inputs, { [`p${k}`]: L.pos, [`c${k}`]: L.col, [`k${k}`]: L.k });
    Object.assign(inTypes, { [`p${k}`]: 'vec3', [`c${k}`]: 'vec3', [`k${k}`]: 'vec2' });
  });
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const node = new dyno.Dyno({
      inTypes,
      outTypes: { gsplat: dyno.Gsplat },
      inputs: { gsplat, ...inputs },
      statements: ({ inputs: i, outputs: o }) => [`
      ${o.gsplat} = ${i.gsplat};
      {
        ${glslPalette}
        ${glslLit}
        vec3 n = quatVec(${o.gsplat}.quaternion, vec3(0.0, 0.0, 1.0));
        vec3 p = ${o.gsplat}.center;
        float ramp = floor(${o.gsplat}.rgba.r * 16.0);
        float base = floor(${o.gsplat}.rgba.g * 8.0);
        vec3 toCam = normalize(${i.cam} - p);
        float alpha = 1.0;
        if (${i.cull} > 0.5 && dot(n, toCam) < -0.08) alpha = 0.0;
        // trim, gems and glintstone lie a few mm over cloth / plate: lift them toward the camera so the discs of the
        // surface underneath (radius ~ one spacing) can't poke through and speckle them
        if (${i.layer} > 0.0 && (int(ramp) == 3 || int(ramp) == 7 || int(ramp) == 8)) ${o.gsplat}.center += toCam * ${i.layer};
        float shade = ${AMBIENT.toFixed(3)};
        vec3 tint = vec3(0.0);
        ${U.lights.map((_, k) => `{
          vec3 Lw = ${i[`p${k}`]} - p; float d = length(Lw); Lw /= max(d, 1e-4);
          float att = clamp(1.0 - d / ${i[`k${k}`]}.y, 0.0, 1.0); att *= att;
          float kk = max(dot(n, Lw), 0.0) * att * ${i[`k${k}`]}.x;
          shade += kk; tint += ${i[`c${k}`]} * kk;
        }`).join('\n        ')}
        // the sprite shader's checker nudge, per splat instead of per texel
        shade += fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453) < 0.5 ? 0.03 : -0.03;
        float off = shade < ${BANDS[0]} ? -1.0 : shade < ${BANDS[1]} ? 0.0 : shade < ${BANDS[2]} ? 1.0 : 2.0;
        int r = int(ramp);
        float st = base + off;
        if (r == 0) st = min(st, 1.0);
        if (LIT[r] < 0.5) st = base;
        st = clamp(st, 0.0, ${(STEPS - 1).toFixed(1)});
        vec3 col = PAL[r * ${STEPS} + int(st)];
        float tl = length(tint);
        if (LIT[r] > 0.5 && tl > 1e-3) col = mix(col, col * (tint / tl) * 1.3, clamp(tl, 0.0, 1.0) * 0.22);
        ${o.gsplat}.rgba = vec4(clamp(col, 0.0, 1.0), alpha);
      }`],
    });
    return { gsplat: node.outputs.gsplat };
  });
}

// ---- the knight: one SplatMesh per walk frame -----------------------------------------------------------------------
const knight = new THREE.Group();
scene.add(knight);
const { frames, count, spacing, stride } = meta;
const h = spacing;
U.layer.value = 1.2 * h;
const scale = new THREE.Vector3(0.66 * h, 0.66 * h, 0.3 * h);
const Z = new THREE.Vector3(0, 0, 1);
const dv = new DataView(bin);
const frameMeshes = [];
for (let f = 0; f < frames; f++) {
  const p = new THREE.Vector3(), n = new THREE.Vector3(), q = new THREE.Quaternion(), color = new THREE.Color();
  const mesh = new SplatMesh({
    constructSplats: (splats) => {
      for (let i = 0; i < count; i++) {
        const o = (f * count + i) * stride;
        p.set(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true));
        n.set(dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true), dv.getFloat32(o + 20, true));
        q.setFromUnitVectors(Z, n);
        const ramp = dv.getUint8(o + 24), step = dv.getUint8(o + 25);
        color.setRGB((ramp + 0.5) / 16, (step + 0.5) / 8, 0);
        splats.pushSplat(p, scale, q, 1, color);
      }
    },
  });
  mesh.worldModifier = lightingModifier();
  mesh.updateGenerator();
  mesh.visible = f === 0;
  knight.add(mesh);
  frameMeshes.push(mesh);
}
ui.stats.textContent = `${count.toLocaleString()} splats × ${frames} frames`;

// ---- lights: the tower's four knight lights, placed relative to him ----------------------------------------------
// he stands at the origin facing +z on the stair carpet; the tower axis is R_WALK to his right (-x)
const lightDefs = [
  { pos: new THREE.Vector3(1.35, 1.5, 0.6), color: [1.0, 0.7, 0.4], pow: 1.1, range: 6, flicker: true },   // wall candle
  { pos: new THREE.Vector3(-R_WALK, 3.4, 0), color: [0.6, 0.85, 1.0], pow: 0.8, range: 10 },               // well light
  { pos: new THREE.Vector3(-R_WALK, -3.6, 0), color: [0.4, 0.6, 1.0], pow: 0.5, range: 12 },               // deep light
  { pos: new THREE.Vector3(-60, 200, -40), color: [0.75, 0.9, 1.0], pow: 0.45, range: 1e4 },              // moon
];

// ---- camera ---------------------------------------------------------------------------------------------------------
const target = new THREE.Vector3(0, 0.95, 0);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(target);
controls.enableDamping = true;
let idle = true;
controls.addEventListener('start', () => (idle = false));
ui.elev.addEventListener('input', () => (idle = true));
ui.spin.addEventListener('input', () => (idle = true));
ui.cull.addEventListener('change', () => (U.cull.value = ui.cull.checked ? 1 : 0));
ui.outline.addEventListener('change', () => (post.uniforms.outline.value = ui.outline.checked ? 1 : 0));
ui.pixel.addEventListener('change', () => setCrisp(ui.pixel.checked));
$('layer').addEventListener('change', (e) => (U.layer.value = e.target.checked ? 1.2 * h : 0));

// ---- frame ----------------------------------------------------------------------------------------------------------
let angle = 2.4, walkT = 0, last = performance.now(), fpsAcc = 0, fpsN = 0;
function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));   // the first rAF stamp can predate `last`
  last = now;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 1) { ui.stats.textContent = `${count.toLocaleString()} splats × ${frames} frames · ${Math.round(fpsN / fpsAcc)} fps`; fpsAcc = 0; fpsN = 0; }

  walkT += dt * Number(ui.walk.value);
  const f = Math.floor(walkT / 0.13) % frames;
  frameMeshes.forEach((m, i) => (m.visible = i === f));

  if (idle) {
    angle += dt * Number(ui.spin.value);
    const e = THREE.MathUtils.degToRad(Number(ui.elev.value)), dist = 4.4;
    camera.position.set(Math.sin(angle) * Math.cos(e) * dist, target.y + Math.sin(e) * dist, Math.cos(angle) * Math.cos(e) * dist);
    camera.lookAt(target);
  } else controls.update();

  U.cam.value.copy(camera.position);
  lightDefs.forEach((L, k) => {
    const u = U.lights[k], pow = L.flicker ? L.pow * (0.9 + 0.06 * Math.sin(now * 0.011) + 0.04 * Math.sin(now * 0.0237)) : L.pow;
    u.pos.value.copy(L.pos);
    u.col.value.set(...L.color);
    u.k.value.set(pow, L.range);
  });
  frameMeshes[f].updateVersion();
  draw();
  requestAnimationFrame(frame);
}
function draw() {
  if (ui.pixel.checked) {
    renderer.setRenderTarget(lowRes);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    post.render(renderer, lowRes.texture);
  } else {
    renderer.setRenderTarget(null);
    renderer.setClearColor(BG, 1);
    renderer.clear();
    renderer.render(scene, camera);
  }
}
requestAnimationFrame(frame);
// for screenshots: knightProto.pose({ angle, elev, frame }) freezes the orbit and the walk on one view
window.knightProto = {
  pose({ angle: a = angle, elev, frame: f } = {}) {
    idle = true; angle = a;
    ui.spin.value = 0; ui.spin.dispatchEvent(new Event('input'));
    if (elev !== undefined) { ui.elev.value = elev; ui.elev.dispatchEvent(new Event('input')); }
    if (f !== undefined) { walkT = f * 0.13 + 0.01; ui.walk.value = 0; ui.walk.dispatchEvent(new Event('input')); }
  },
  // GPU cost per frame, independent of rAF throttling: draw n times, stepping through the walk frames and
  // regenerating the lit splats like the live loop, and wait for the GPU with a 1-pixel read-back each time
  bench(n = 60) {
    const gl = renderer.getContext(), px = new Uint8Array(4), t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const f = i % frames;
      frameMeshes.forEach((m, j) => (m.visible = j === f));
      frameMeshes[f].updateVersion();
      draw();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    const ms = (performance.now() - t0) / n;
    return `${ms.toFixed(2)} ms/frame at ${renderer.domElement.width}x${renderer.domElement.height} device px, art ${post.uniforms.lowRes.value.x}x${post.uniforms.lowRes.value.y}`;
  },
};
