// 骑士（像素风高斯泼溅版）：同一个 Blender 骑士，不再渲成精灵表，而是撒成一层贴着表面的小圆片（surfel），
// 每片带着它那个部件的色阶 + 档位、部件编号和法线。每个刚体部件（头盔片、肩甲、护手、剑……）是一根骨头，四片披风
// 各有一张骨头网格跟着布面走；关键帧只是每根骨头相对静止姿势的刚体变换（desk-pet demos/splat-knight/export_rig.py）。
// 好处：任何角度都是真的三维（不用挑精灵表的行）、关键帧之间能插值（翻页 60 fps 连续，不是每 0.11 秒跳一格）、
// 运行时还能叠自己的动作（抬头看月亮）。
//
// 画法照搬精灵管线（desk-pet process_sprites.py + scene.js 的精灵着色器），只是从「离线一张张图」变成「每帧在 GPU 上」：
//   1. 骑士单独画进一层 2 倍分辨率的缓冲，不打光，只写属性：色阶档位 + 部件编号 + 深度（一遍）、法线（一遍）
//   2. 塔 / 书房里能挡住他的不透明物体只画深度（另一张缓冲，和画面同分辨率），用来做遮挡
//   3. 合成（composer 里紧跟 RenderPass 的一个 pass）：每个画面像素取 2×2 个样本按部件投票（墨色、辉光、宝石和
//      高光档加倍）→ 去掉孤立像素和孤儿像素 → 被更近部件压住的一侧加内描线 → 外圈 1 像素描边取相邻部件自己色阶的
//      最暗档 → 按精灵着色器打光（环境 + 4 盏灯，亮度分档挪色阶，墨色压暗、辉光不受光、灯色微染、雾）→ 比场景深度，
//      看得见才盖上去。之后照常走辉光和 HD-2D。
// 开关：地址里带 #splat（可和 #demo 连写：#demo,splat）或 ?knight=splat。
import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SparkRenderer, SplatMesh, SplatSkinning, dyno } from '@sparkjsdev/spark';
import RIG from '../assets/knight_rig.json';
import RIG_GZ from '../assets/knight_rig.bin.gz';

export const SPLAT_KNIGHT = /(^|[#,])splat(,|$)/.test(location.hash) || new URLSearchParams(location.search).get('knight') === 'splat';

const STEPS = RIG.ramps[0].colors.length;
const PALETTE = RIG.ramps.flatMap((r) => r.colors);
const RAMP = Object.fromEntries(RIG.ramps.map((r, i) => [r.name, i]));
const OCCLUDER_LAYER = 31;
const INNER_T = 3 * 4 / 255;      // process_sprites.py INNER_DEPTH_T：近 4.7 cm 才算「压在前面」
const Z_SPAN = 3;                 // 骑士深度编码范围（米）：以骑士到镜头的距离为中心 ±1.5 m

// 数据只解压一次，塔和书房两个骑士共用
const RIG_DATA = new Response(new Blob([RIG_GZ]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();

/**
 * @param renderer  WebGLRenderer
 * @param host      骑士所在的场景（塔或书房），用来找挡住他的东西
 * @param opts      { ambient, bands: [3], fogColor: THREE.Color（线性）, fogD: { value }, depthPull（米，同精灵 uDepthPull） }
 * @returns { group, ready, pass, setPose(anim, a, b, k), headLook(yaw, pitch), setLights(list), update(camera, glow), render(camera, composer) }
 *          group 摆位置朝向；pass 插进 composer 紧跟 RenderPass；每帧 composer.render() 之前调 render()
 */
export function createSplatKnight(renderer, host, opts = {}) {
  const { ambient = 0.46, bands = [0.32, 0.62, 0.9], fogColor = new THREE.Color(0), fogD = { value: 0 }, depthPull = 0 } = opts;

  // 骑士自己一个场景：主场景里不放泼溅，只放合成结果
  const kScene = new THREE.Scene();
  const spark = new SparkRenderer({ renderer });
  // 硬边圆片：不要高斯羽化（属性没法混合）；preBlur 让最小的片也至少盖一个样本，不漏底
  spark.falloff = 0;
  spark.maxStdDev = 1.5;
  spark.blurAmount = 0;
  spark.preBlurAmount = 0.3;
  kScene.add(spark);
  const group = new THREE.Group();
  kScene.add(group);

  const { count, bones: NB, bbox: [lo, hi], spacing, stride, sizeSpacing } = RIG;
  const U = {
    cam: dyno.dynoVec3(new THREE.Vector3()),
    fwd: dyno.dynoVec3(new THREE.Vector3(0, 0, -1)),
    zMin: dyno.dynoFloat(0),
    mode: dyno.dynoFloat(0),             // 0：色阶档位 / 部件 / 深度；1：法线
    layer: dyno.dynoFloat(1.2 * spacing * sizeSpacing[2]),
  };

  let mesh = null, skinning = null, dv = null, frames = null;
  const ready = RIG_DATA.then((buf) => {
    dv = new DataView(buf);
    frames = new Float32Array(buf, RIG.framesOffset, (buf.byteLength - RIG.framesOffset) / 4);
    const deq = (v, a, b) => a + ((v + 32767) / 65534) * (b - a);
    const scales = [0, 1, 2].map((c) => {
      const h = spacing * sizeSpacing[c];
      return new THREE.Vector3(0.66 * h, 0.66 * h, 0.3 * h);
    });
    const Z = new THREE.Vector3(0, 0, 1);
    mesh = new SplatMesh({
      constructSplats: (splats) => {
        const p = new THREE.Vector3(), n = new THREE.Vector3(), q = new THREE.Quaternion(), c = new THREE.Color();
        for (let i = 0; i < count; i++) {
          const o = i * stride;
          p.set(deq(dv.getInt16(o, true), lo[0], hi[0]), deq(dv.getInt16(o + 2, true), lo[1], hi[1]), deq(dv.getInt16(o + 4, true), lo[2], hi[2]));
          let x = dv.getInt8(o + 6) / 127, y = dv.getInt8(o + 7) / 127;     // 八面体法线
          const z = 1 - Math.abs(x) - Math.abs(y);
          if (z < 0) { const ox = x; x = (1 - Math.abs(y)) * Math.sign(ox || 1); y = (1 - Math.abs(ox)) * Math.sign(y || 1); }
          n.set(x, y, z).normalize();
          q.setFromUnitVectors(Z, n);
          // 颜色通道只拿来带编号：r = 色阶档位（ramp*5+step），g = 部件
          c.setRGB((dv.getUint8(o + 8) + 0.5) / 64, (dv.getUint8(o + 9) + 0.5) / 128, 0, THREE.NoColorSpace);
          splats.pushSplat(p, scales[dv.getUint8(o + 10)], q, 1, c);
        }
      },
    });
    mesh.worldModifier = attributeModifier(U);
    group.add(mesh);
    return mesh.initialized;
  }).then(() => {
    skinning = new SplatSkinning({ mesh, numSplats: count, numBones: NB });
    const idx = new THREE.Vector4(), w = new THREE.Vector4();
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      const w0 = dv.getUint8(o + 11), w1 = dv.getUint8(o + 12), w2 = dv.getUint8(o + 13);
      idx.set(dv.getUint16(o + 14, true), dv.getUint16(o + 16, true), dv.getUint16(o + 18, true), dv.getUint16(o + 20, true));
      w.set(w0, w1, w2, Math.max(0, 255 - w0 - w1 - w2)).multiplyScalar(1 / 255);
      skinning.setSplatBones(i, idx, w);
    }
    skinning.skinTexture.needsUpdate = true;
    mesh.skinning = skinning;
    mesh.updateGenerator();
  });

  // ---- 姿势：关键帧之间插值，写成对偶四元数
  const headBones = new Uint8Array(NB), propBones = new Uint8Array(NB);
  RIG.headBones.forEach((b) => (headBones[b] = 1));
  (RIG.propBones ?? []).forEach((b) => (propBones[b] = 1));
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), ta = new THREE.Vector3(), tb = new THREE.Vector3();
  const D = new THREE.Quaternion(), pivot = new THREE.Vector3(), look = new THREE.Quaternion(), tmp = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  let lookYaw = 0, lookPitch = 0;
  function readBone(anim, f, b, q, t) {
    const o = (RIG.anims[anim].offset >> 2) + (f * NB + b) * 7;
    q.set(frames[o], frames[o + 1], frames[o + 2], frames[o + 3]);
    t.set(frames[o + 4], frames[o + 5], frames[o + 6]);
  }
  /** 在 anim 的关键帧 a 和 b 之间按 k 插值（a、b 可以是任意两帧：读书循环 7 → 0、翻完回到读书） */
  function setPose(anim, a, b, k) {
    if (!skinning) return;
    const A = RIG.anims[anim];
    const pa = A.pivots[a], pb = A.pivots[b];
    pivot.set(pa[0] + (pb[0] - pa[0]) * k, pa[1] + (pb[1] - pa[1]) * k, pa[2] + (pb[2] - pa[2]) * k);
    look.setFromEuler(euler.set(lookPitch, lookYaw, 0));
    const data = skinning.boneData;
    for (let i = 0; i < NB; i++) {
      readBone(anim, a, i, qa, ta);
      readBone(anim, b, i, qb, tb);
      qa.slerp(qb, k);
      ta.lerp(tb, k);
      // 坐着读书时不带剑（Blender 管线里 set_props_visible(anim != "sit")）：骨头没法隐藏，挪到看不见的地方
      if (propBones[i] && A.hideProps) ta.set(0, -1000, 0);
      else if (headBones[i] && (lookYaw || lookPitch)) {
        // 头和头盔上的部件：绕颈部（Head 节点）再转一下
        qa.premultiply(look);
        tmp.copy(ta).sub(pivot).applyQuaternion(look).add(pivot);
        ta.copy(tmp);
      }
      // 对偶四元数混合要求相邻骨头的四元数在同一个半球（q 和 -q 是同一个转动，混起来却会互相抵消）
      if (qa.w < 0) qa.set(-qa.x, -qa.y, -qa.z, -qa.w);
      D.set(ta.x, ta.y, ta.z, 0).multiply(qa);
      const o = i * 16;
      data[o] = qa.x; data[o + 1] = qa.y; data[o + 2] = qa.z; data[o + 3] = qa.w;
      data[o + 4] = 0.5 * D.x; data[o + 5] = 0.5 * D.y; data[o + 6] = 0.5 * D.z; data[o + 7] = 0.5 * D.w;
    }
    skinning.updateBones();
  }

  // ---- 缓冲：属性两张（2 倍分辨率）、遮挡深度一张（画面分辨率）
  const rtOpts = { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false };
  const keyRT = new THREE.WebGLRenderTarget(1, 1, rtOpts);
  const nrmRT = new THREE.WebGLRenderTarget(1, 1, rtOpts);
  const occRT = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  occRT.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });

  // 能挡住骑士的：不透明、写深度、正面的普通网格（天空球之类的 ShaderMaterial、反面描边壳、半透明特效都不算）。
  // 书桌模型是异步加载的，隔一阵重新扫一遍
  let scanAt = 0;
  function markOccluders() {
    host.traverse((o) => {
      if (!o.isMesh || o.isSprite) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      const ok = ms.every((m) => m && !m.isShaderMaterial && !m.transparent && m.depthWrite !== false && m.side !== THREE.BackSide && m.colorWrite !== false);
      if (ok) o.layers.enable(OCCLUDER_LAYER); else o.layers.disable(OCCLUDER_LAYER);
    });
  }

  // ---- 合成
  const palLin = PALETTE.map((hex) => new THREE.Color().setStyle(hex));   // 线性（和精灵 sRGB 色表 knLut 采样出来的一样）
  const v3 = () => new THREE.Vector3();
  const pass = new ShaderPass(new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null }, tKey: { value: keyRT.texture }, tNrm: { value: nrmRT.texture }, tOcc: { value: occRT.depthTexture },
      uPal: { value: palLin }, uLit: { value: RIG.ramps.map((r) => (r.lit ? 1 : 0)) },
      uAmbient: { value: ambient }, uBands: { value: new THREE.Vector3(...bands) }, uGlow: { value: 2.2 },
      uLightPos: { value: [v3(), v3(), v3(), v3()] }, uLightCol: { value: [v3(), v3(), v3(), v3()] },
      uLightPow: { value: [0, 0, 0, 0] }, uLightRange: { value: [1, 1, 1, 1] },
      uFogColor: { value: fogColor }, uFogD: fogD,
      uCam: { value: v3() }, uRight: { value: v3() }, uUp: { value: v3() }, uFwd: { value: v3() }, uTan: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.1 }, uFar: { value: 100 }, uZMin: { value: 0 }, uPull: { value: depthPull },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: COMPOSITE_FRAG,
  }));
  pass.enabled = false;

  // 每帧的灯、镜头、辉光
  const state = { glow: 2.2, camera: null };
  const api = {
    group, ready, pass, rig: RIG, uniforms: U,
    get mesh() { return mesh; },
    setPose,
    /** 头在关键帧之上额外转多少（弧度，骑士自己的坐标：yaw 绕竖轴、pitch 抬头为负） */
    headLook(yaw, pitch) { lookYaw = yaw; lookPitch = pitch; },
    /** [{ pos, color: [r,g,b], pow, range }]，和 setKnightLights 同一个格式 */
    setLights(list) {
      const u = pass.uniforms;
      for (let i = 0; i < 4; i++) {
        const L = list[i];
        if (!L) { u.uLightPow.value[i] = 0; continue; }
        u.uLightPos.value[i].copy(L.pos); u.uLightCol.value[i].set(...L.color);
        u.uLightPow.value[i] = L.pow; u.uLightRange.value[i] = L.range;
      }
    },
    update(camera, glow = 2.2) { state.camera = camera; state.glow = glow; },
    /** composer.render() 之前调：画遮挡深度和骑士的两层属性，填好合成 pass 的参数 */
    render(camera, composer) {
      if (!skinning) { pass.enabled = false; return; }
      const rt = composer.readBuffer, W = rt.width, H = rt.height;
      if (keyRT.width !== 2 * W || keyRT.height !== 2 * H) { keyRT.setSize(2 * W, 2 * H); nrmRT.setSize(2 * W, 2 * H); occRT.setSize(W, H); }
      if (renderer.info.render.frame >= scanAt) { markOccluders(); scanAt = renderer.info.render.frame + 120; }

      const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevShadow = renderer.shadowMap.autoUpdate;
      const prevMask = camera.layers.mask, prevOverride = host.overrideMaterial, prevBg = host.background;
      const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
      renderer.autoClear = false;
      renderer.setClearColor(0x000000, 0);

      // 1. 遮挡深度
      renderer.shadowMap.autoUpdate = false;
      camera.layers.set(OCCLUDER_LAYER);
      host.overrideMaterial = depthOnly;
      host.background = null;
      renderer.setRenderTarget(occRT);
      renderer.clear();
      renderer.render(host, camera);
      host.overrideMaterial = prevOverride;
      host.background = prevBg;
      camera.layers.mask = prevMask;
      renderer.shadowMap.autoUpdate = prevShadow;

      // 2. 骑士属性（两遍：同一批片，修改器按 mode 写不同的东西）
      camera.updateMatrixWorld();
      const fwd = camera.getWorldDirection(new THREE.Vector3());
      const center = group.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.9, 0));
      const zMin = center.clone().sub(camera.position).dot(fwd) - Z_SPAN / 2;
      U.cam.value.copy(camera.position); U.fwd.value.copy(fwd); U.zMin.value = zMin;
      for (const [mode, target] of [[0, keyRT], [1, nrmRT]]) {
        U.mode.value = mode;
        mesh.updateVersion();
        renderer.setRenderTarget(target);
        renderer.clear();
        renderer.render(kScene, camera);
      }
      renderer.setRenderTarget(prevRT);
      renderer.autoClear = prevAuto;
      renderer.setClearColor(prevClear, prevAlpha);

      // 3. 合成参数
      const u = pass.uniforms;
      u.uCam.value.copy(camera.position);
      u.uFwd.value.copy(fwd);
      u.uRight.value.setFromMatrixColumn(camera.matrixWorld, 0);
      u.uUp.value.setFromMatrixColumn(camera.matrixWorld, 1);
      const ty = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / camera.zoom;
      u.uTan.value.set(ty * camera.aspect, ty);
      u.uNear.value = camera.near; u.uFar.value = camera.far;
      u.uZMin.value = zMin;
      u.uGlow.value = state.glow;
      pass.enabled = true;
    },
  };
  // 调试：控制台里 __splatKnights[0] 是塔里的、[1] 是书房的
  (globalThis.__splatKnights ??= []).push(api);
  return api;
}

/** 片 → 属性：mode 0 写 (色阶档位, 部件, 深度)，mode 1 写法线。背面的片透明（也省得穿过正面） */
function attributeModifier(U) {
  const inputs = { cam: U.cam, fwd: U.fwd, zMin: U.zMin, mode: U.mode, layer: U.layer };
  const inTypes = { gsplat: dyno.Gsplat, cam: 'vec3', fwd: 'vec3', zMin: 'float', mode: 'float', layer: 'float' };
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const node = new dyno.Dyno({
      inTypes,
      outTypes: { gsplat: dyno.Gsplat },
      inputs: { gsplat, ...inputs },
      statements: ({ inputs: i, outputs: o }) => [`
      ${o.gsplat} = ${i.gsplat};
      {
        vec3 n = quatVec(${o.gsplat}.quaternion, vec3(0.0, 0.0, 1.0));
        vec3 p = ${o.gsplat}.center;
        float idx = floor(${o.gsplat}.rgba.r * 64.0);
        float part = floor(${o.gsplat}.rgba.g * 128.0);
        int ramp = int(floor(idx / ${STEPS}.0));
        vec3 toCam = normalize(${i.cam} - p);
        float alpha = dot(n, toCam) < -0.08 ? 0.0 : 1.0;
        // 金边、宝石、辉石压在布和甲片上只有几毫米：往镜头方向抬一点，下面那层的圆片就戳不穿它们
        if (ramp == ${RAMP.gold} || ramp == ${RAMP.glow} || ramp == ${RAMP.gem}) ${o.gsplat}.center += toCam * ${i.layer};
        float z = (dot(${o.gsplat}.center - ${i.cam}, ${i.fwd}) - ${i.zMin}) / ${Z_SPAN.toFixed(1)};
        // 写进渲染目标时 Spark 会做 sRGB → 线性，合成时再按 2.2 次方还原
        ${o.gsplat}.rgba = ${i.mode} < 0.5 ? vec4(idx / 63.0, part / 127.0, clamp(z, 0.0, 1.0), alpha) : vec4(n * 0.5 + 0.5, alpha);
      }`],
    });
    return { gsplat: node.outputs.gsplat };
  });
}

const COMPOSITE_FRAG = /* glsl */`
  uniform sampler2D tDiffuse, tKey, tNrm, tOcc;
  uniform vec3 uPal[${PALETTE.length}];
  uniform float uLit[${RIG.ramps.length}];
  uniform float uAmbient, uGlow, uFogD, uNear, uFar, uZMin, uPull;
  uniform vec3 uBands, uFogColor, uCam, uRight, uUp, uFwd;
  uniform vec2 uTan;
  uniform vec3 uLightPos[4]; uniform vec3 uLightCol[4]; uniform float uLightPow[4]; uniform float uLightRange[4];
  varying vec2 vUv;

  const int STEPS = ${STEPS};
  const int INK = ${RAMP.ink}, GLOW = ${RAMP.glow}, GEM = ${RAMP.gem};

  struct Px { bool a; int idx; int part; float z; vec3 n; };

  vec3 dec(vec3 v) { return pow(max(v, 0.0), vec3(1.0 / 2.2)); }

  // 一个画面像素 = 2×2 个样本；按 (档位, 部件) 投票，墨色 / 辉光 / 宝石 / 高光档（step ≥ 3）票数加倍
  Px vote(ivec2 c) {
    Px r; r.a = false; r.idx = 0; r.part = -1; r.z = 1e9; r.n = vec3(0.0, 0.0, 1.0);
    ivec2 sz = textureSize(tKey, 0);
    if (c.x < 0 || c.y < 0 || 2 * c.x + 1 >= sz.x || 2 * c.y + 1 >= sz.y) return r;
    int id[4]; int pt[4]; float zz[4]; float w[4]; bool op[4];
    int nOp = 0;
    for (int s = 0; s < 4; s++) {
      vec4 k = texelFetch(tKey, 2 * c + ivec2(s - (s / 2) * 2, s / 2), 0);
      op[s] = k.a > 0.5;
      vec3 d = dec(k.rgb);
      id[s] = int(floor(d.r * 63.0 + 0.5)); pt[s] = int(floor(d.g * 127.0 + 0.5)); zz[s] = d.b;
      int ramp = id[s] / STEPS, st = id[s] - ramp * STEPS;
      w[s] = (ramp == INK || ramp == GLOW || ramp == GEM || st >= 3) ? 2.0 : 1.0;
      if (op[s]) nOp++;
    }
    if (nOp < 2) return r;                       // 精灵：覆盖 ≥ 45% 才算这一格有人
    float best = -1.0; int bi = 0;
    for (int s = 0; s < 4; s++) {
      if (!op[s]) continue;
      float score = 0.0;
      for (int t = 0; t < 4; t++) if (op[t] && id[t] == id[s] && pt[t] == pt[s]) score += w[t];
      if (score > best) { best = score; bi = s; }
    }
    r.a = true; r.idx = id[bi]; r.part = pt[bi];
    vec3 n = vec3(0.0);
    for (int s = 0; s < 4; s++) {
      if (!op[s] || id[s] != r.idx || pt[s] != r.part) continue;
      r.z = min(r.z, zz[s]);
      n += dec(texelFetch(tNrm, 2 * c + ivec2(s - (s / 2) * 2, s / 2), 0).rgb) * 2.0 - 1.0;
    }
    r.n = normalize(n);
    return r;
  }

  float sceneZ(ivec2 c) {
    float d = texelFetch(tOcc, c, 0).r;
    if (d >= 1.0) return 1e9;
    float ndc = d * 2.0 - 1.0;
    return 2.0 * uNear * uFar / (uFar + uNear - ndc * (uFar - uNear));   // 视线方向的深度（正数）
  }

  void main() {
    vec4 base = texture2D(tDiffuse, vUv);
    ivec2 P = ivec2(gl_FragCoord.xy);
    Px c = vote(P);
    Px nb[4];
    nb[0] = vote(P + ivec2(1, 0)); nb[1] = vote(P - ivec2(1, 0)); nb[2] = vote(P + ivec2(0, 1)); nb[3] = vote(P - ivec2(0, 1));
    int nOp = 0;
    for (int i = 0; i < 4; i++) if (nb[i].a) nOp++;

    bool outline = false, inner = false;
    if (c.a) {
      int ramp = c.idx / STEPS;
      bool protect = ramp == INK || ramp == GLOW || ramp == GEM;
      if (nOp <= 1) c.a = false;                 // 孤立像素
      else if (!protect && nOp >= 3) {
        // 孤儿：四周都是别的部件、其中至少两个是同一个 → 跟它们
        bool alone = true;
        for (int i = 0; i < 4; i++) if (nb[i].a && nb[i].part == c.part) alone = false;
        if (alone) for (int i = 0; i < 4; i++) {
          if (!nb[i].a) continue;
          int same = 0;
          for (int j = 0; j < 4; j++) if (nb[j].a && nb[j].part == nb[i].part) same++;
          if (same >= 2) { c.idx = nb[i].idx; c.part = nb[i].part; break; }
        }
      }
    }
    if (c.a) {
      // 内描线：旁边是别的部件、而且比我近 4.7 cm 以上 → 我这一侧暗一档
      for (int i = 0; i < 4; i++)
        if (nb[i].a && nb[i].part != c.part && nb[i].z * ${Z_SPAN.toFixed(1)} < c.z * ${Z_SPAN.toFixed(1)} - ${INNER_T.toFixed(4)} && c.idx / STEPS != GLOW) inner = true;
    } else {
      // 外描边：空格子贴着骑士 → 取最近那个邻居的色阶，最暗档
      float bz = 1e9; int bi = -1;
      for (int i = 0; i < 4; i++) if (nb[i].a && nb[i].z < bz) { bz = nb[i].z; bi = i; }
      if (bi < 0) { gl_FragColor = base; return; }
      for (int i = 0; i < 4; i++) if (i == bi) c = nb[i];
      int ramp = c.idx / STEPS;
      if (ramp == GLOW) ramp = INK;
      c.idx = ramp * STEPS; c.a = true; outline = true;
    }

    // 遮挡：骑士这一格比场景近（带精灵同款的 depthPull 余量）才画
    float kz = uZMin + c.z * ${Z_SPAN.toFixed(1)};
    if (kz - uPull > sceneZ(P)) { gl_FragColor = base; return; }

    // 这一格在世界里的位置（打点光用）
    vec2 ndc = gl_FragCoord.xy / vec2(textureSize(tOcc, 0)) * 2.0 - 1.0;
    vec3 ray = uFwd + uRight * ndc.x * uTan.x + uUp * ndc.y * uTan.y;
    vec3 world = uCam + ray * kz;

    // 精灵着色器（scene.js makeKnightMesh）原样
    int ramp = c.idx / STEPS;
    float baseSt = float(c.idx - ramp * STEPS);
    vec3 n = c.n;
    float shade = uAmbient; vec3 tint = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      vec3 Lw = uLightPos[i] - world; float d = length(Lw); Lw /= max(d, 1e-4);
      float att = clamp(1.0 - d / uLightRange[i], 0.0, 1.0); att *= att;
      float k = max(dot(n, Lw), 0.0) * att * uLightPow[i];
      shade += k; tint += uLightCol[i] * k;
    }
    shade += mod(float(P.x + P.y), 2.0) < 0.5 ? 0.03 : -0.03;
    float off = shade < uBands.x ? -1.0 : shade < uBands.y ? 0.0 : shade < uBands.z ? 1.0 : 2.0;
    bool lit = uLit[ramp] > 0.5;
    float st = baseSt + off;
    if (inner) st -= 1.0;
    if (outline) st = off >= 1.0 ? 1.0 : 0.0;
    if (ramp == INK) st = min(st, 1.0);
    if (!lit) st = baseSt;
    st = clamp(st, 0.0, float(STEPS - 1));
    vec3 col = uPal[ramp * STEPS + int(st)];
    if (!lit) col *= uGlow;
    else { float tl = length(tint); if (tl > 1e-3) col = mix(col, col * (tint / tl) * 1.3, clamp(tl, 0.0, 1.0) * 0.22); }
    float f = uFogD * kz; col = mix(uFogColor, col, exp(-f * f));
    gl_FragColor = vec4(col, 1.0);
  }`;
