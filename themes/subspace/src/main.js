// 亚空间跃迁：有 Claude Code / Codex / DeepSeek Harness 会话在跑就进亚空间跃迁，全部结束就出来回到三星系统。
// 打包时（scripts/build.mjs）连同 three.js、图标一起塞进主题包根目录的 index.html 一个文件：
// 屏保主题跑在沙盒 iframe 里，只能用内联脚本。样式和页面结构在旁边的 index.html。
//
//   常规宇宙(space) ──有会话在跑──▶ 进入亚空间(enter, 8.5s) ──▶ 跃迁(tunnel, 不限时) ──全部结束──▶ 脱离亚空间(exit, 6.5s) ──▶ 常规宇宙
//   进出都不切白屏：入口 / 出口是一扇「窗」，里面画的就是另一边的场景，镜头穿过去两边画面接得上。
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

// ============================================================ 文字（屏保外壳给 ?lang=zh|en，跟系统语言）
const ZH = new URLSearchParams(location.search).get('lang') !== 'en'
document.documentElement.lang = ZH ? 'zh-CN' : 'en'
const TX = ZH
  ? {
      lockOn: '锁定亚空间入口 · 准备跃迁', locking: '锁定亚空间入口 · 视界展开中', dist: (au) => `距视界 ${au} AU`, leaving: '全部任务结束 · 脱离亚空间',
      st: { running: '运行中', waiting: '等你确认', done: '已完成', aborted: '已中断' },
      back: '已返回常规宇宙', tExit: '正在脱离亚空间', tEnter: '正在进入亚空间', tReady: '准备跃迁', tJump: '跃迁中',
      nRun: (n) => `· ${n} 个任务在跑`, wrap: '· 收尾中', foot: (d, a) => `完成 ${d} · 中断 ${a}`, voyage: (t) => ` · 本次跃迁 ${t}`,
    }
  : {
      lockOn: 'Portal locked · Preparing to jump', locking: 'Portal locked · Horizon opening', dist: (au) => `Horizon in ${au} AU`, leaving: 'All tasks finished · Leaving subspace',
      st: { running: 'Running', waiting: 'Needs you', done: 'Done', aborted: 'Stopped' },
      back: 'Back in normal space', tExit: 'Leaving subspace', tEnter: 'Entering subspace', tReady: 'Preparing to jump', tJump: 'In subspace',
      nRun: (n) => `· ${n} running`, wrap: '· wrapping up', foot: (d, a) => `Done ${d} · Stopped ${a}`, voyage: (t) => ` · Jump ${t}`,
    }

// ============================================================ 工具
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const lerp = (a, b, t) => a + (b - a) * t
const seg = (t, a, b) => clamp((t - a) / (b - a))
const easeIn = (t) => t * t * t
const easeOut = (t) => 1 - Math.pow(1 - t, 3)
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const rand = (a, b) => a + Math.random() * (b - a)
const pick = (arr) => arr[(Math.random() * arr.length) | 0]
const $ = (id) => document.getElementById(id)

// ============================================================ GLSL：3D simplex noise + fbm
const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<4;i++){ s+=a*snoise(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=0.5; } return s; }
`

// ============================================================ 渲染器、两个场景
const renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: false, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05

const spaceScene = new THREE.Scene()
spaceScene.background = new THREE.Color(0x000000)
const tunScene = new THREE.Scene()
tunScene.background = new THREE.Color(0x000000)

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 8000)
// 另一边的镜头：进亚空间时画隧道、出亚空间时画太空，画进 rt，亚空间入口当窗户贴出来
const auxCam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 8000)
const resV = new THREE.Vector2()
renderer.getDrawingBufferSize(resV)
const rt = new THREE.WebGLRenderTarget(resV.x, resV.y, { type: THREE.HalfFloatType })
const uRes = { value: resV.clone() }

const composer = new EffectComposer(renderer)
const renderPass = new RenderPass(spaceScene, camera)
composer.addPass(renderPass)
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.55, 0.32)
composer.addPass(bloom)
composer.addPass(new OutputPass())

addEventListener('resize', () => {
  for (const c of [camera, auxCam]) { c.aspect = innerWidth / innerHeight; c.updateProjectionMatrix() }
  renderer.setSize(innerWidth, innerHeight)
  composer.setSize(innerWidth, innerHeight)
  renderer.getDrawingBufferSize(resV)
  rt.setSize(resV.x, resV.y)
  uRes.value.copy(resV)
})

function glowTexture(stops) {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128)
  for (const [o, col] of stops) grd.addColorStop(o, col)
  g.fillStyle = grd
  g.fillRect(0, 0, 256, 256)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
const GLOW_TEX = glowTexture([[0, 'rgba(255,255,255,1)'], [0.12, 'rgba(255,255,255,0.6)'], [0.4, 'rgba(255,255,255,0.12)'], [1, 'rgba(255,255,255,0)']])

// ============================================================ 常规宇宙：星云 + 星星
const nebula = new THREE.Mesh(
  new THREE.SphereGeometry(3000, 64, 32),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: NOISE + `
      uniform float uTime; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        float band = exp(-pow(dot(d, normalize(vec3(0.35,1.0,0.25)))*2.6, 2.0));
        float w = fbm(d*1.6 + vec3(0.0,0.0,uTime*0.003));
        float n = fbm(d*3.2 + w*1.3);
        float m = smoothstep(-0.15, 0.7, n);
        vec3 col = mix(vec3(0.004,0.004,0.014), vec3(0.16,0.05,0.24), m);
        col += vec3(0.02,0.16,0.22) * smoothstep(0.1, 0.8, fbm(d*2.4 - 3.0)) * 0.9;
        col += vec3(0.32,0.14,0.06) * smoothstep(0.35, 0.9, fbm(d*5.0 + w)) * band * 0.6;
        col *= 1.0 - 0.75*smoothstep(0.2, 0.7, fbm(d*7.0 + 11.0)) * band;
        col *= (0.22 + band*1.05)*0.45;
        gl_FragColor = vec4(col, 1.0);
      }`,
  }),
)
spaceScene.add(nebula)

function makeStars(count, rMin, rMax, sizeMin, sizeMax) {
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3), size = new Float32Array(count), seed = new Float32Array(count)
  const tints = [[1, 1, 1], [0.75, 0.85, 1], [1, 0.88, 0.72], [0.85, 0.9, 1], [1, 0.75, 0.6]]
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(rand(rMin, rMax))
    pos.set([v.x, v.y, v.z], i * 3)
    const t = pick(tints), b = rand(0.5, 1.4)
    col.set([t[0] * b, t[1] * b, t[2] * b], i * 3)
    size[i] = Math.pow(Math.random(), 4) * (sizeMax - sizeMin) + sizeMin
    seed[i] = Math.random()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
  return new THREE.Points(g, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uPR: { value: renderer.getPixelRatio() } },
    vertexShader: `
      attribute vec3 aColor; attribute float aSize; attribute float aSeed;
      uniform float uTime, uPR; varying vec3 vColor; varying float vTw;
      void main(){
        vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv;
        vTw = 0.7 + 0.3*sin(uTime*(0.6+aSeed*2.5) + aSeed*60.0);
        vColor = aColor; gl_PointSize = aSize*uPR*(0.85+0.15*vTw);
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vTw;
      void main(){ float d = length(gl_PointCoord-0.5); float a = smoothstep(0.5,0.0,d); a*=a; gl_FragColor = vec4(vColor*vTw*a*1.5, a); }`,
  }))
}
const starfield = [makeStars(6000, 1600, 2400, 1.2, 3.2), makeStars(500, 1400, 1800, 2.5, 7)]
starfield.forEach((s) => spaceScene.add(s))

// ============================================================ 常规宇宙：三体
// 三颗恒星真按引力算（软化 + 远了才拉回来的约束，免得被甩出去），一直在混沌地乱转；
// 还有一颗行星被三颗太阳拉扯，被吞了或者甩远了就过一会儿在别处重新出现。
const SYS = new THREE.Vector3(0, 0, -520)
const system = new THREE.Group()
system.position.copy(SYS)
spaceScene.add(system)

const G = 4000, EPS2 = 14 * 14, SIM_SPEED = 1.7, SIM_H = 1 / 90, CONF_R = 220, CONF_K = 0.02
const TILT = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.32, 0, 0.18))
const PLANE_N = new THREE.Vector3(0, 1, 0).applyQuaternion(TILT)
const bodies = [
  { m: 1.0, R: 9, col: [0.68, 0.8, 1.0], hot: 3.2 },
  { m: 0.85, R: 8, col: [1.0, 0.86, 0.6], hot: 3.0 },
  { m: 0.62, R: 6.5, col: [1.0, 0.48, 0.24], hot: 2.8 },
].map((d) => ({ ...d, color: new THREE.Color(...d.col), p: new THREE.Vector3(), v: new THREE.Vector3(), a: new THREE.Vector3() }))

const _d = new THREE.Vector3(), _com = new THREE.Vector3()
function computeCom() {
  _com.set(0, 0, 0)
  let M = 0
  for (const b of bodies) { _com.addScaledVector(b.p, b.m); M += b.m }
  return _com.multiplyScalar(1 / M)
}
function gravAt(p, out, skip) {
  out.set(0, 0, 0)
  for (const b of bodies) {
    if (b === skip) continue
    _d.subVectors(b.p, p)
    const r2 = _d.lengthSq() + EPS2
    out.addScaledVector(_d, (G * b.m) / (r2 * Math.sqrt(r2)))
  }
  return out
}
function confine(p, out) {
  _d.subVectors(p, _com)
  const r = _d.length()
  if (r > CONF_R) out.addScaledVector(_d, (-CONF_K * (r - CONF_R)) / r)
}
function accelAll() {
  computeCom()
  for (const b of bodies) { gravAt(b.p, b.a, b); confine(b.p, b.a) }
}
function initBodies() {
  const off = rand(0, Math.PI * 2)
  bodies.forEach((b, i) => {
    const a = off + (i / 3) * Math.PI * 2 + rand(-0.35, 0.35), r = rand(60, 100)
    b.p.set(Math.cos(a) * r, rand(-10, 10), Math.sin(a) * r).applyQuaternion(TILT)
    const vt = Math.sqrt((G * 2.47) / r) * rand(0.42, 0.58)
    b.v.set(-Math.sin(a) * vt, rand(-1.5, 1.5), Math.cos(a) * vt).applyQuaternion(TILT)
  })
  let M = 0
  const vc = new THREE.Vector3()
  for (const b of bodies) { vc.addScaledVector(b.v, b.m); M += b.m }
  vc.multiplyScalar(1 / M)
  const c = computeCom().clone()
  for (const b of bodies) { b.v.sub(vc); b.p.sub(c) }
  accelAll()
}

// 恒星：表面 + 两层光晕
const starMat = (b) => new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uCol: { value: b.color }, uHot: { value: b.hot }, uSeed: { value: Math.random() * 50 } },
  vertexShader: `varying vec3 vObj; varying vec3 vN; varying vec3 vV;
    void main(){ vObj = normalize(position); vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
  fragmentShader: NOISE + `uniform float uTime, uHot, uSeed; uniform vec3 uCol; varying vec3 vObj; varying vec3 vN; varying vec3 vV;
    void main(){ float g = fbm(vObj*5.0 + vec3(uSeed, uTime*0.12, 0.0))*0.5+0.5;
      float limb = pow(max(dot(normalize(vN), normalize(vV)), 0.0), 0.45);
      vec3 c = uCol*uHot*(0.7 + 0.55*g)*(0.5 + 0.5*limb) + vec3(1.0)*limb*0.6;
      gl_FragColor = vec4(c, 1.0); }`,
})
for (const b of bodies) {
  b.holder = new THREE.Group()
  b.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), starMat(b))
  b.mesh.scale.setScalar(b.R)
  const near = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW_TEX, color: b.color.clone().multiplyScalar(1.6), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }))
  near.scale.setScalar(b.R * 11)
  const wide = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW_TEX, color: b.color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.22 }))
  wide.scale.setScalar(b.R * 42)
  b.holder.add(b.mesh, near, wide)
  system.add(b.holder)
}

// 轨迹线
function makeTrail(n, color, k) {
  const pos = new Float32Array(n * 3), t = new Float32Array(n)
  for (let i = 0; i < n; i++) t[i] = i / (n - 1)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aT', new THREE.BufferAttribute(t, 1))
  const line = new THREE.Line(g, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uCol: { value: color }, uK: { value: k } },
    vertexShader: `attribute float aT; varying float vT; void main(){ vT = aT; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uCol; uniform float uK; varying float vT; void main(){ gl_FragColor = vec4(uCol*pow(1.0-vT,1.7)*uK, 1.0); }`,
  }))
  line.frustumCulled = false
  system.add(line)
  const attr = g.attributes.position
  return {
    line,
    reset(p) { for (let i = 0; i < n; i++) pos.set([p.x, p.y, p.z], i * 3); attr.needsUpdate = true },
    push(p) { pos.copyWithin(3, 0, (n - 1) * 3); pos[0] = p.x; pos[1] = p.y; pos[2] = p.z; attr.needsUpdate = true },
    head(p) { pos[0] = p.x; pos[1] = p.y; pos[2] = p.z; attr.needsUpdate = true },
  }
}
for (const b of bodies) b.trail = makeTrail(460, b.color, 0.9)

// 被三颗太阳拉扯的行星
const lightPos = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
const planet = { p: new THREE.Vector3(), v: new THREE.Vector3(), a: new THREE.Vector3(), alive: false, fade: 0, respawnIn: 0.5 }
planet.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), new THREE.ShaderMaterial({
  uniforms: { uLp: { value: lightPos }, uLc: { value: bodies.map((b) => b.color) } },
  vertexShader: `varying vec3 vObj; varying vec3 vN; varying vec3 vP;
    void main(){ vObj = normalize(position); vN = normalize(mat3(modelMatrix)*normal); vP = (modelMatrix*vec4(position,1.0)).xyz; gl_Position = projectionMatrix*viewMatrix*vec4(vP,1.0); }`,
  fragmentShader: NOISE + `uniform vec3 uLp[3]; uniform vec3 uLc[3]; varying vec3 vObj; varying vec3 vN; varying vec3 vP;
    void main(){
      float n = fbm(vObj*2.6);
      vec3 base = mix(vec3(0.04,0.1,0.22), vec3(0.36,0.3,0.2), smoothstep(0.02,0.12,n));
      base = mix(base, vec3(0.9), smoothstep(0.78,0.86,abs(vObj.y)));
      vec3 N = normalize(vN); vec3 L = vec3(0.0);
      for (int i=0;i<3;i++){ vec3 d = uLp[i]-vP; L += uLc[i]*max(dot(N, normalize(d)),0.0)*1.5; }
      gl_FragColor = vec4(base*L + base*0.02, 1.0);
    }`,
}))
system.add(planet.mesh)
planet.trail = makeTrail(220, new THREE.Color(0.75, 0.85, 1.0), 0.35)
function spawnPlanet() {
  const b = pick(bodies), d = rand(24, 34)
  const dir = new THREE.Vector3().randomDirection()
  dir.addScaledVector(PLANE_N, -dir.dot(PLANE_N)).normalize()
  planet.p.copy(b.p).addScaledVector(dir, d)
  const tan = new THREE.Vector3().crossVectors(PLANE_N, dir).normalize()
  const vc = Math.sqrt((G * b.m * d * d) / Math.pow(d * d + EPS2, 1.5))
  planet.v.copy(b.v).addScaledVector(tan, vc)
  gravAt(planet.p, planet.a, null)
  planet.alive = true
  planet.trail.reset(planet.p)
}

let simAcc = 0, trailAcc = 0, spread = 100
function simulate(dt) {
  simAcc += dt * SIM_SPEED
  while (simAcc > SIM_H) {
    const h = SIM_H
    simAcc -= h
    for (const b of bodies) b.v.addScaledVector(b.a, h / 2)
    for (const b of bodies) b.p.addScaledVector(b.v, h)
    accelAll()
    for (const b of bodies) { b.v.addScaledVector(b.a, h / 2); if (b.v.lengthSq() > 4900) b.v.setLength(70) }
    if (planet.alive) {
      planet.v.addScaledVector(planet.a, h / 2)
      planet.p.addScaledVector(planet.v, h)
      gravAt(planet.p, planet.a, null)
      confine(planet.p, planet.a)
      planet.v.addScaledVector(planet.a, h / 2)
    }
  }
  // 质心钉在原点（限速会破坏动量守恒，不钉住会慢慢漂走），镜头按三颗星散开的程度拉远拉近
  computeCom()
  const vc = _d.set(0, 0, 0)
  let M = 0
  for (const b of bodies) { vc.addScaledVector(b.v, b.m); M += b.m }
  vc.multiplyScalar(1 / M)
  for (const b of bodies) { b.p.sub(_com); b.v.sub(vc) }
  planet.p.sub(_com); planet.v.sub(vc)
  _com.set(0, 0, 0)
  let far = 0
  for (const b of bodies) far = Math.max(far, b.p.length())
  spread = lerp(spread, far, 1 - Math.exp(-dt * 0.4))
  // 行星被吞 / 被甩远
  if (planet.alive) {
    const lost = planet.p.distanceTo(_com) > 380
    const eaten = bodies.some((b) => planet.p.distanceTo(b.p) < b.R + 2.5)
    if (lost || eaten) { planet.alive = false; planet.respawnIn = rand(2.5, 5) }
  } else if ((planet.respawnIn -= dt) <= 0) spawnPlanet()
  planet.fade = clamp(planet.fade + (planet.alive ? dt / 1.5 : -dt / 0.35))
  planet.mesh.position.copy(planet.p)
  planet.mesh.scale.setScalar(4.2 * easeOut(planet.fade) + 0.001)
  planet.trail.line.material.uniforms.uK.value = 0.35 * planet.fade

  trailAcc += dt
  const sample = trailAcc > 0.07
  if (sample) trailAcc = 0
  bodies.forEach((b, i) => {
    b.holder.position.copy(b.p)
    lightPos[i].copy(b.p).add(SYS)
    sample ? b.trail.push(b.p) : b.trail.head(b.p)
  })
  if (planet.alive) sample ? planet.trail.push(planet.p) : planet.trail.head(planet.p)
}
initBodies()
bodies.forEach((b) => b.trail.reset(b.p))
// 先空跑一会儿，打开就有轨迹
for (let i = 0; i < 400; i++) simulate(1 / 30)

// 太空镜头：绕三体系统慢慢转
const _look = new THREE.Vector3()
// arrive < 1：刚从亚空间出来时离得近，然后慢慢退到全景
function spacePose(cam, t, arrive = 1) {
  const th = 0.55 + t * 0.012, D = clamp(spread * 2.4 + 120, 260, 600) * arrive
  cam.position.set(SYS.x + Math.sin(th) * D, SYS.y + D * 0.28 + Math.sin(t * 0.027) * 15, SYS.z + Math.cos(th) * D)
  _look.copy(SYS)
  cam.up.set(0, 1, 0)
  cam.lookAt(_look)
  cam.rotateY(0.07) // 系统稍微偏右，让开左边的会话面板
}
const arriveK = () => (voyageStart && state === 'space' ? lerp(0.55, 1, easeInOut(seg(stateT, 0.3, 10))) : 1)

// 亚空间入口：一扇窗，里面贴的是隧道那边画出来的画面
const portalPos = new THREE.Vector3()
const portalCenter = { value: new THREE.Vector2(0.5, 0.5) }
const portalMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  uniforms: { uTime: { value: 0 }, uOpen: { value: 0 }, uTex: { value: rt.texture }, uRes, uCenter: portalCenter },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: NOISE + `
    uniform float uTime, uOpen; uniform sampler2D uTex; uniform vec2 uRes, uCenter; varying vec2 vUv;
    void main(){
      vec2 p = vUv*2.0-1.0; float r = length(p); if (r > 1.0) discard;
      float ang = atan(p.y,p.x);
      float n = fbm(vec3(cos(ang - uTime*0.5)*1.6, sin(ang - uTime*0.5)*1.6, uTime*0.35))*0.5+0.5;
      float edge = 0.5 + (n-0.5)*0.05;
      float inside = smoothstep(edge, edge-0.05, r);
      // 窗里：按屏幕坐标取隧道那边的画面，边缘往里压一点，像透镜
      vec2 suv = gl_FragCoord.xy/uRes;
      float lens = smoothstep(edge*0.45, edge, r);
      suv = uCenter + (suv-uCenter)*(1.0 - 0.32*lens*lens);
      vec3 tun = texture2D(uTex, suv).rgb;
      float ring = exp(-pow((r-edge)/(0.022+0.03*n),2.0));
      float halo = exp(-pow((r-edge)/0.24,2.0))*(0.35+0.65*n);
      vec3 blue = vec3(0.25,0.55,1.0);
      vec3 col = tun*inside + (vec3(0.45,0.78,1.0)*ring*1.3 + blue*halo*0.5)*(1.0 - inside*0.75);
      float core = exp(-r*r*500.0)*(1.0-uOpen);
      col += vec3(0.75,0.9,1.0)*core*2.5;
      float a = max(inside*uOpen, clamp((ring + halo*0.8)*uOpen + core, 0.0, 1.0))*smoothstep(1.0,0.75,r);
      gl_FragColor = vec4(col, a);
    }`,
})
const portal = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), portalMat)
portal.visible = false
spaceScene.add(portal)

// ============================================================ 跃迁隧道
const TUN_R = 14, TUN_L = 420
const BEND_GLSL = `vec2 bend(float s){ return vec2(sin(s*0.011)*14.0 + sin(s*0.023+1.3)*8.0, cos(s*0.009)*12.0 + sin(s*0.017+0.4)*9.0)*uAmp; }`
function bend(s, amp) {
  return [(Math.sin(s * 0.011) * 14 + Math.sin(s * 0.023 + 1.3) * 8) * amp, (Math.cos(s * 0.009) * 12 + Math.sin(s * 0.017 + 0.4) * 9) * amp]
}
function tubeGeo() {
  const g = new THREE.CylinderGeometry(1, 1, TUN_L, 112, 220, true)
  g.rotateX(-Math.PI / 2)
  g.translate(0, 0, -TUN_L / 2 + 12)
  return g
}
const pal = { deep: new THREE.Color(), mid: new THREE.Color(), hi: new THREE.Color(), glow: new THREE.Color() }
const PALETTES = {
  blue: { deep: [0.0, 0.015, 0.06], mid: [0.04, 0.3, 0.85], hi: [0.62, 0.9, 1.0], glow: [0.45, 0.75, 1.0] },
  violet: { deep: [0.02, 0.0, 0.06], mid: [0.38, 0.14, 0.88], hi: [0.88, 0.72, 1.0], glow: [0.72, 0.55, 1.0] },
  teal: { deep: [0.0, 0.04, 0.04], mid: [0.03, 0.55, 0.6], hi: [0.7, 1.0, 0.95], glow: [0.45, 0.95, 0.9] },
  amber: { deep: [0.06, 0.02, 0.0], mid: [0.85, 0.38, 0.08], hi: [1.0, 0.86, 0.58], glow: [1.0, 0.68, 0.32] },
}
const tunU = {
  uTime: { value: 0 }, uTravel: { value: 0 }, uAmp: { value: 0.6 }, uTwist: { value: 0.001 }, uIntensity: { value: 1 }, uOpen: { value: 0.1 }, uFlash: { value: 0 },
  uDeep: { value: pal.deep }, uMid: { value: pal.mid }, uHi: { value: pal.hi }, uGlow: { value: pal.glow },
}
const TUN_VERT = NOISE + `
  uniform float uTravel, uAmp, uTime, uRate, uRadius;
  varying float vAngle, vS, vDepth;
  ${BEND_GLSL}
  void main(){
    vec3 p = position; float d = -p.z;
    vAngle = atan(p.y, p.x); vS = d + uTravel*uRate; vDepth = d;
    float s = d + uTravel;
    float wob = snoise(vec3(cos(vAngle)*1.3, sin(vAngle)*1.3, s*0.022))*0.26 + snoise(vec3(s*0.008, 3.0, uTime*0.04))*0.16;
    p.xy *= uRadius*(1.0 + wob);
    p.xy += bend(s) - bend(uTravel);
    gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.0);
  }`
// 所有旋转都朝同一个方向、很慢：花纹随时间转 + 沿隧道的螺旋（uTwist 只取正值）
const wall = new THREE.Mesh(tubeGeo(), new THREE.ShaderMaterial({
  side: THREE.BackSide, transparent: true, depthWrite: false,
  uniforms: { ...tunU, uRate: { value: 1 }, uRadius: { value: TUN_R } },
  vertexShader: TUN_VERT,
  fragmentShader: NOISE + `
    uniform float uTime, uIntensity, uTwist, uOpen, uFlash; uniform vec3 uDeep, uMid, uHi, uGlow;
    varying float vAngle, vS, vDepth;
    void main(){
      float a = vAngle + vS*uTwist + uTime*0.035;
      vec3 q = vec3(cos(a)*1.4, sin(a)*1.4, vS*0.028);
      float w = fbm(q*0.8 + vec3(0.0,0.0,uTime*0.05));
      float n = fbm(q + vec3(w*1.4, w*1.1, w*0.8));
      float cloud = smoothstep(-0.45, 0.6, n);
      float hi = smoothstep(0.2, 0.8, fbm(q*2.1 + w*2.0 + 7.0));
      float streak = pow(clamp(snoise(vec3(cos(a)*6.0, sin(a)*6.0, vS*0.004))*0.5+0.5, 0.0, 1.0), 7.0);
      vec3 col = mix(uDeep, uMid*0.75, cloud*cloud*cloud);
      col += uHi*(pow(hi,3.0)*1.1 + streak*0.55)*(0.15 + cloud);
      col += uHi*uFlash*0.1*(0.2 + cloud);
      float fog = smoothstep(60.0, 400.0, vDepth);
      col = mix(col, uGlow*0.8, fog*0.8*(1.0 - uOpen*0.75));
      // 云墙上撕开的缝：uOpen 越大缝越多，开阔段几乎只剩几缕
      float gt = -0.7 + uOpen*1.15;
      float a2 = smoothstep(gt, gt + 0.12, n) * (1.0 - uOpen*0.25);
      a2 = mix(a2, 1.0, fog*(1.0 - uOpen)*0.85);
      a2 *= smoothstep(-8.0, 6.0, vDepth);
      gl_FragColor = vec4(col*uIntensity, a2);
    }`,
}))
const wisps = new THREE.Mesh(tubeGeo(), new THREE.ShaderMaterial({
  side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { ...tunU, uRate: { value: 1.45 }, uRadius: { value: TUN_R * 0.6 } },
  vertexShader: TUN_VERT,
  fragmentShader: NOISE + `
    uniform float uTime, uIntensity, uTwist, uOpen; uniform vec3 uMid, uHi;
    varying float vAngle, vS, vDepth;
    void main(){
      float a = vAngle + vS*uTwist*1.2 + uTime*0.045;
      vec3 q = vec3(cos(a)*2.0, sin(a)*2.0, vS*0.045);
      float n = fbm(q + fbm(q*0.7)*1.2);
      float m = smoothstep(0.12, 0.75, n);
      vec3 col = mix(uMid, uHi, m*m)*m*m*0.4;
      col *= smoothstep(0.0, 22.0, vDepth)*(1.0 - smoothstep(140.0, 380.0, vDepth))*(1.0 - uOpen*0.85);
      gl_FragColor = vec4(col*uIntensity, 1.0);
    }`,
}))
tunScene.add(wall, wisps)

const endGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW_TEX, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }))
endGlow.scale.setScalar(110)
tunScene.add(endGlow)

// 出口：尽头张开一扇窗，里面是三体那边的太空
const exitMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, depthTest: false,
  uniforms: { uTime: { value: 0 }, uRing: { value: new THREE.Color(1, 0.7, 0.35) }, uOpen: { value: 0 }, uTex: { value: rt.texture }, uRes, uCenter: { value: new THREE.Vector2(0.5, 0.5) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: NOISE + `
    uniform float uTime, uOpen; uniform vec3 uRing; uniform sampler2D uTex; uniform vec2 uRes, uCenter; varying vec2 vUv;
    void main(){
      vec2 p = vUv*2.0-1.0; float r = length(p); if (r > 1.0) discard;
      float ang = atan(p.y,p.x);
      float n = fbm(vec3(cos(ang)*2.0, sin(ang)*2.0, uTime*0.6))*0.5+0.5;
      float edge = 0.58 + (n-0.5)*0.07;
      float hole = smoothstep(edge+0.01, edge-0.04, r);
      vec2 suv = gl_FragCoord.xy/uRes;
      float lens = smoothstep(edge*0.45, edge, r);
      suv = uCenter + (suv-uCenter)*(1.0 - 0.3*lens*lens);
      vec3 sp = texture2D(uTex, suv).rgb;
      float ring = exp(-pow((r-edge-0.02)/(0.04+0.05*n),2.0));
      float halo = exp(-pow((r-edge)/0.28,2.0))*n;
      vec3 col = sp*hole + uRing*(ring*1.5 + halo*0.45)*(1.0-hole);
      float a = max(hole, clamp(ring*1.2 + halo*0.6, 0.0, 1.0))*smoothstep(1.0, 0.8, r);
      gl_FragColor = vec4(col, a*uOpen);
    }`,
})
const exitHole = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), exitMat)
exitHole.visible = false
exitHole.renderOrder = 10
tunScene.add(exitHole)

// 隧道上的点：位置 = 该处隧道中心（跟着隧道一起弯），出口用它定位
let b0 = [0, 0]
const _p = new THREE.Vector3()
function trackPos(s, x, y, out) {
  const b = bend(s, tunU.uAmp.value)
  return out.set(b[0] - b0[0] + x, b[1] - b0[1] + y, -(s - tunTravel))
}

// ============================================================ 亚空间的天：雷云 + 闪电（通道有缝 / 开阔时看得到）
const flashU = { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] }
const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 64, 32), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: { uTime: tunU.uTime, uTravel: tunU.uTravel, uDeep: tunU.uDeep, uMid: tunU.uMid, uHi: tunU.uHi, uGlow: tunU.uGlow, uFlash: flashU },
  vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: NOISE + `
    uniform float uTime, uTravel; uniform vec3 uDeep, uMid, uHi, uGlow; uniform vec4 uFlash[3]; varying vec3 vDir;
    void main(){
      vec3 d = normalize(vDir);
      vec3 q = d*2.0 + vec3(0.0, 0.0, uTravel*0.0016);
      float w = fbm(q*0.7 + vec3(0.0, uTime*0.012, 0.0));
      float n = fbm(q*1.4 + w*1.6);
      float dens = smoothstep(-0.3, 0.5, n);
      float ridge = 1.0 - abs(fbm(q*3.1 + w*1.2));
      vec3 col = uDeep*0.3 + uMid*0.045*dens + uMid*0.2*pow(ridge, 6.0)*dens;
      col *= 0.6 + 0.4*smoothstep(-0.2, 0.6, fbm(q*0.5 - 4.0));
      float fwd = max(-d.z, 0.0);
      col += uGlow*(pow(fwd, 12.0)*0.3 + pow(fwd, 3.0)*0.03);
      for (int i = 0; i < 3; i++) {
        float k = max(dot(d, uFlash[i].xyz), 0.0);
        col += uHi*uFlash[i].w*(pow(k, 40.0)*1.6 + pow(k, 7.0)*0.25)*(0.25 + dens);
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
}))
sky.renderOrder = -10
tunScene.add(sky)

const BOLT_V = 96
const bolts = [0, 1, 2].map(() => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BOLT_V * 3), 3))
  g.setDrawRange(0, 0)
  const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
  line.frustumCulled = false
  line.renderOrder = -5
  tunScene.add(line)
  return { line, life: 0, age: 1, dir: new THREE.Vector3(), i: 0 }
})
function midDisp(a, b, disp, lvl, out) {
  if (lvl === 0) { out.push(a, b); return }
  const m = a.clone().lerp(b, 0.5).add(new THREE.Vector3().randomDirection().multiplyScalar(disp))
  midDisp(a, m, disp * 0.55, lvl - 1, out)
  midDisp(m, b, disp * 0.55, lvl - 1, out)
}
let boltIn = 2
const _white = new THREE.Color(1, 1, 1)
function fireBolt() {
  const b = bolts.find((x) => x.age >= x.life) ?? bolts[0]
  const R = 520
  let dir
  do dir = new THREE.Vector3().randomDirection(); while (dir.z > 0.35) // 别打在身后
  const d2 = dir.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(rand(0.15, 0.35))).normalize()
  const A = dir.clone().multiplyScalar(R), B = d2.clone().multiplyScalar(R)
  const segs = []
  midDisp(A, B, A.distanceTo(B) * 0.22, 5, segs)
  const from = segs[((Math.random() * segs.length) / 2 | 0) * 2]
  midDisp(from, from.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(A.distanceTo(B) * 0.4)), A.distanceTo(B) * 0.1, 3, segs)
  const arr = b.line.geometry.attributes.position.array
  const n = Math.min(segs.length, BOLT_V)
  for (let i = 0; i < n; i++) arr.set([segs[i].x, segs[i].y, segs[i].z], i * 3)
  b.line.geometry.setDrawRange(0, n)
  b.line.geometry.attributes.position.needsUpdate = true
  b.dir.copy(dir).add(d2).normalize()
  b.life = rand(0.28, 0.5)
  b.age = 0
}
function updateBolts(dt, open) {
  boltIn -= dt
  if (boltIn <= 0) { fireBolt(); boltIn = rand(0.6, 3.2) * (1.5 - open) }
  let total = 0
  bolts.forEach((b, i) => {
    b.age += dt
    const t = b.age / b.life
    const I = t < 1 ? (1 - t) * (0.55 + 0.45 * Math.round(Math.random())) : 0
    b.line.material.color.copy(pal.hi).lerp(_white, 0.5).multiplyScalar(I * 6)
    b.line.visible = I > 0.01
    const fl = t < 1.6 ? Math.max(0, 1 - t / 1.6) : 0
    flashU.value[i].set(b.dir.x, b.dir.y, b.dir.z, fl * (0.6 + 0.4 * I))
    total += fl
  })
  tunU.uFlash.value = Math.min(1, total)
}

// ============================================================ 速度线
const STREAKS = 1600, STREAK_L = 260
const streakGeo = new THREE.BufferGeometry()
{
  const pos = new Float32Array(STREAKS * 6), end = new Float32Array(STREAKS * 2), seed = new Float32Array(STREAKS * 2)
  for (let i = 0; i < STREAKS; i++) {
    const a = rand(0, Math.PI * 2), r = Math.sqrt(rand(0.04, 1)), z = rand(0, STREAK_L), s = Math.random()
    pos.set([Math.cos(a) * r, Math.sin(a) * r, z, Math.cos(a) * r, Math.sin(a) * r, z], i * 6)
    end.set([0, 1], i * 2)
    seed.set([s, s], i * 2)
  }
  streakGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  streakGeo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1))
  streakGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
}
const streakU = { uTravel: { value: 0 }, uLen: { value: 2 }, uRadius: { value: 40 }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color(0.75, 0.88, 1) } }
const streaks = new THREE.LineSegments(streakGeo, new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: streakU,
  vertexShader: `
    attribute float aEnd, aSeed; uniform float uTravel, uLen, uRadius;
    varying float vA;
    void main(){
      vec3 p = position; p.xy *= uRadius;
      float z = -${STREAK_L.toFixed(1)} + mod(p.z + uTravel*(0.75+aSeed*0.5), ${STREAK_L.toFixed(1)});
      z -= aEnd*uLen*(0.6+aSeed*0.8);
      vA = (1.0-aEnd)*smoothstep(-${STREAK_L.toFixed(1)}, -${(STREAK_L * 0.55).toFixed(1)}, z)*(0.35+0.65*aSeed);
      gl_Position = projectionMatrix*modelViewMatrix*vec4(p.xy, z, 1.0);
    }`,
  fragmentShader: `uniform float uOpacity; uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor*vA*uOpacity*1.6, 1.0); }`,
}))
streaks.frustumCulled = false
spaceScene.add(streaks)

function activate(name) {
  const sc = name === 'space' ? spaceScene : tunScene
  renderPass.scene = sc
  sc.add(streaks)
}

// ============================================================ 状态机
//   space ──(有会话在跑)──▶ enter(8.5s) ──▶ tunnel(无限) ──(全部结束，宽限 GRACE 秒)──▶ exit(6.5s) ──▶ space
const ENTER_DUR = 8.5, ENTER_CROSS = 7.1, EXIT_DUR = 6.5, EXIT_CROSS = 5.2
// 全部结束后再等一会儿才出来：Claude Code 两轮之间、等子代理时会短暂变成空闲
const GRACE = location.hash.includes('demo') ? 3 : 15
let state = 'space', stateT = 0, idleT = 0, voyageStart = 0, voyageEnd = 0, now = 0
let demoTick = () => {}
let speed = 0, streakTravel = 0, tunTravel = 0, tunSpeed = 70, needRT = null

let palNow = 'blue', palFrom = PALETTES.blue, palTo = PALETTES.blue, palT = 1, palDur = 8, palNext = 30
function setPalette(name, dur = 8) {
  palFrom = { deep: pal.deep.toArray(), mid: pal.mid.toArray(), hi: pal.hi.toArray(), glow: pal.glow.toArray() }
  palTo = PALETTES[name]
  palNow = name
  palT = 0
  palDur = dur
}
function applyPalette(dt) {
  palT = Math.min(1, palT + dt / palDur)
  const k = easeInOut(palT)
  for (const key of ['deep', 'mid', 'hi', 'glow']) pal[key].setRGB(...palFrom[key].map((v, i) => lerp(v, palTo[key][i], k)))
}
setPalette('blue', 0.001); applyPalette(1)

// 慢慢游走的随机参数：弯曲度、螺旋、速度（都限制在不晕的范围，螺旋只往一个方向）
const walk = { amp: [0.55, 0.55], twist: [0.001, 0.001], cruise: [70, 70], open: [0.1, 0.1] }
let walkNext = 0
function stepWalk(dt) {
  walkNext -= dt
  if (walkNext <= 0) {
    walkNext = rand(8, 16)
    walk.amp[1] = rand(0.3, 0.75)
    walk.twist[1] = rand(0.0005, 0.0015)
    walk.cruise[1] = rand(58, 85)
    // 一半时间是窄通道，一半时间通道散开、露出外面的雷云和巨物
    walk.open[1] = state === 'exit' ? 0.12 : Math.random() < 0.5 ? rand(0.05, 0.25) : rand(0.6, 0.9)
  }
  for (const k in walk) walk[k][0] = lerp(walk[k][0], walk[k][1], 1 - Math.exp(-dt * (k === 'open' ? 0.3 : 0.18)))
}

function setupTunnel() {
  tunTravel = rand(0, 5000) // 每次进来都是没见过的一段
  setPalette(pick(['blue', 'blue', 'violet', 'teal']), 0.001)
  applyPalette(1)
  palNext = rand(30, 50)
  b0 = bend(tunTravel, tunU.uAmp.value)
  walk.open[0] = walk.open[1] = 0.1
  walkNext = 9 // 进来先是窄通道，过一会儿才可能散开
  tunU.uIntensity.value = 1
}

function tunnelPose(cam) {
  const A = tunU.uAmp.value, h = bend(tunTravel + 45, A)
  cam.up.set(0, 1, 0)
  cam.position.set(Math.sin(now * 1.3) * 0.03, Math.cos(now * 1.1) * 0.02, 0)
  cam.lookAt(h[0] - b0[0], h[1] - b0[1], -45)
}

function tunnelTick(dt, { surge = 1, ampMul = 1 } = {}) {
  stepWalk(dt)
  palNext -= dt
  if (state === 'tunnel' && palNext <= 0) {
    palNext = rand(35, 55)
    setPalette(pick(Object.keys(PALETTES).filter((k) => k !== palNow)), 10)
  }
  applyPalette(dt)
  tunSpeed = walk.cruise[0] * surge
  tunTravel += tunSpeed * dt
  tunU.uTravel.value = tunTravel
  tunU.uAmp.value = walk.amp[0] * ampMul
  tunU.uTwist.value = walk.twist[0]
  b0 = bend(tunTravel, tunU.uAmp.value)
  tunScene.background.copy(pal.glow).multiplyScalar(0.55)
  const bg = bend(tunTravel + 300, tunU.uAmp.value)
  endGlow.position.set(bg[0] - b0[0], bg[1] - b0[1], -300)
  endGlow.material.color.copy(pal.glow)
  tunU.uOpen.value = walk.open[0]
  updateBolts(dt, walk.open[0])
}

function setState(s) {
  state = s
  stateT = 0
  idleT = 0
  if (s === 'enter') {
    voyageWall = Date.now()
    voyageStart = now
    // 亚空间入口出现在镜头前方偏左上
    const fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3()
    camera.getWorldDirection(fwd)
    right.crossVectors(fwd, camera.up).normalize()
    up.crossVectors(right, fwd)
    enter.from.copy(camera.position)
    enter.look.copy(camera.position).addScaledVector(fwd, 500)
    portalPos.copy(camera.position).addScaledVector(fwd, 300).addScaledVector(right, -60).addScaledVector(up, 36)
    enter.to.copy(portalPos).addScaledVector(_p.subVectors(portalPos, camera.position).normalize(), -12)
    portal.position.copy(portalPos)
    portal.visible = true
    portalMat.uniforms.uOpen.value = 0
    setupTunnel()
    banner(TX.lockOn)
  }
  if (s === 'exit') {
    setPalette('amber', 2.2)
    walk.open[1] = 0.12
    exitHole.visible = true
    exitMat.uniforms.uOpen.value = 0
    banner(TX.leaving)
  }
  if (s === 'tunnel') banner('')
  if (s === 'space') { banner(''); voyageEnd = now }
}
const enter = { from: new THREE.Vector3(), to: new THREE.Vector3(), look: new THREE.Vector3() }

const flash = $('flash')
function setFlash(v, warm) {
  flash.style.opacity = v.toFixed(3)
  flash.style.background = warm
    ? 'radial-gradient(circle at 50% 50%, #fff 0%, #ffe2b8 40%, #ff9b4a 100%)'
    : 'radial-gradient(circle at 50% 50%, #fff 0%, #d6ecff 38%, #5f9fff 100%)'
}
const _v = new THREE.Vector3()
function screenUv(world, out) {
  _v.copy(world).project(camera)
  return out.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5)
}

function update(dt) {
  now += dt
  stateT += dt
  const running = sessions.some((s) => s.status === 'running' || s.status === 'waiting')

  if (state === 'space' && running && stateT > 1.5) setState('enter')
  else if (state === 'tunnel') {
    idleT = running ? 0 : idleT + dt
    if (idleT > GRACE && stateT > 3) setState('exit')
  }

  simulate(dt)
  let fov = 60, bloomK = 0.55, flashV = 0, flashWarm = false
  needRT = null
  streakU.uOpacity.value = 0

  if (state === 'space') {
    // 刚从亚空间出来：减速，速度线收回
    const decel = voyageStart ? easeOut(seg(stateT, 0, 2.6)) : 1
    fov = lerp(110, 60, decel)
    speed = lerp(240, 2, decel)
    streakU.uRadius.value = 70
    streakU.uOpacity.value = 0.6 * (1 - decel)
    streakU.uColor.value.setRGB(1, 0.85, 0.65)
    streakU.uLen.value = speed * 0.12
    if (voyageStart) { flashV = 0.22 * (1 - seg(stateT, 0, 0.6)); flashWarm = true }
    spacePose(camera, now, arriveK())
  } else if (state === 'enter') {
    const t = stateT
    // 0–3.2s 亚空间入口张开；2.6–7.1s 加速冲过去；7.1s 穿过窗口，直接接上隧道那边
    const open = easeOut(seg(t, 0.2, 3.2))
    portalMat.uniforms.uOpen.value = open
    portal.scale.setScalar(lerp(4, 200, open))
    const go = easeIn(seg(t, 2.6, ENTER_CROSS))
    if (t < ENTER_CROSS) {
      camera.position.lerpVectors(enter.from, enter.to, go)
      camera.up.set(0, 1, 0)
      camera.lookAt(_look.lerpVectors(enter.look, portalPos, easeInOut(seg(t, 0.3, 3.0))))
      portal.lookAt(camera.position)
      screenUv(portalPos, portalCenter.value)
    }
    fov = lerp(60, 100, easeIn(seg(t, 3.0, ENTER_CROSS)))
    speed = lerp(2, 300, go)
    streakU.uRadius.value = 45
    streakU.uOpacity.value = 0.4 * seg(t, 3.4, 6.2)
    streakU.uColor.value.setRGB(0.45, 0.7, 1)
    streakU.uLen.value = speed * 0.1
    bloomK = lerp(0.55, 0.85, go)
    // 隧道那边一直在跑（窗户里看得到）
    tunU.uIntensity.value = t < ENTER_CROSS ? 1 + 0.45 * easeIn(seg(t, 5.2, ENTER_CROSS)) : lerp(1.45, 1, easeOut(seg(t, ENTER_CROSS, ENTER_DUR)))
    tunnelTick(dt)
    flashV = 0.16 * (t < ENTER_CROSS ? easeIn(seg(t, 6.8, ENTER_CROSS)) : 1 - seg(t, ENTER_CROSS, 7.6))
    if (t < ENTER_CROSS) {
      auxCam.fov = camera.fov
      auxCam.updateProjectionMatrix()
      tunnelPose(auxCam)
      needRT = 'tunnel'
    } else {
      if (renderPass.scene !== tunScene) { activate('tunnel'); portal.visible = false }
      tunnelPose(camera)
      streakU.uRadius.value = 10.5
      streakU.uColor.value.copy(pal.hi)
    }
    if (t >= ENTER_DUR) setState('tunnel')
    updateLock()
  } else {
    // 跃迁中 / 脱离亚空间
    const exiting = state === 'exit'
    const t = stateT
    const surge = exiting ? lerp(1, 2.4, easeIn(seg(t, 1.6, EXIT_CROSS))) : 1
    tunnelTick(dt, { surge, ampMul: exiting ? lerp(1, 0.3, seg(t, 0, 3)) : 1 })
    if (!exiting) tunU.uIntensity.value = lerp(tunU.uIntensity.value, 1, 1 - Math.exp(-dt))
    speed = tunSpeed
    fov = exiting ? lerp(86, 110, easeIn(seg(t, 1.6, EXIT_CROSS))) : 86
    bloomK = 0.7
    streakU.uRadius.value = 10.5
    streakU.uOpacity.value = exiting ? 0.65 : 0.35
    streakU.uColor.value.copy(pal.hi)
    streakU.uLen.value = speed * 0.09
    tunnelPose(camera)
    endGlow.material.opacity = (exiting ? 1 - seg(t, 1, 3) : 1) * (0.55 + Math.sin(now * 2.3) * 0.08) * (1 - walk.open[0] * 0.6)

    if (exiting) {
      // 0–2.6s 变琥珀色、尽头张开出口；2.0–5.2s 冲向出口；5.2s 穿过去就是三体那边
      const open = easeOut(seg(t, 0.4, 2.6))
      const d = lerp(320, 2, easeIn(seg(t, 2.0, EXIT_CROSS)))
      trackPos(tunTravel + d, 0, 0, exitHole.position)
      exitHole.scale.setScalar(lerp(10, 110, open))
      exitHole.lookAt(camera.position)
      exitMat.uniforms.uOpen.value = open
      exitMat.uniforms.uRing.value.copy(pal.glow)
      screenUv(exitHole.position, exitMat.uniforms.uCenter.value)
      auxCam.fov = camera.fov
      auxCam.updateProjectionMatrix()
      spacePose(auxCam, now, 0.55)
      needRT = 'space'
      flashV = 0.18 * easeIn(seg(t, 4.9, EXIT_CROSS))
      flashWarm = true
      if (t >= EXIT_CROSS) {
        exitHole.visible = false
        activate('space')
        setState('space')
        spacePose(camera, now, 0.55)
        needRT = null
      }
    }
  }

  // 统一推进
  streakTravel += speed * dt
  streakU.uTravel.value = streakTravel
  streaks.position.copy(camera.position)
  streaks.quaternion.copy(camera.quaternion)
  camera.fov = lerp(camera.fov, fov, 1 - Math.exp(-dt * 6))
  camera.updateProjectionMatrix()
  bloom.strength = lerp(bloom.strength, bloomK, 1 - Math.exp(-dt * 3))
  setFlash(flashV, flashWarm)

  tunU.uTime.value = now
  nebula.material.uniforms.uTime.value = now
  portalMat.uniforms.uTime.value = now
  exitMat.uniforms.uTime.value = now
  starfield.forEach((s) => (s.material.uniforms.uTime.value = now))
  bodies.forEach((b) => (b.mesh.material.uniforms.uTime.value = now))

  updateHud(dt, running)
}

// ============================================================ HUD
const lock = $('lock'), lockText = $('lockText')
function updateLock() {
  const t = stateT
  if (!(state === 'enter' && t < 6.2)) { lock.style.opacity = 0; return }
  _v.copy(portalPos).project(camera)
  const x = (_v.x * 0.5 + 0.5) * innerWidth, y = (-_v.y * 0.5 + 0.5) * innerHeight
  const size = lerp(220, 130, easeOut(seg(t, 0.2, 1.6))) + Math.max(0, camera.fov - 60) * 4 + easeIn(seg(t, 3, 6.2)) * 500
  lock.style.width = lock.style.height = size + 'px'
  lock.style.transform = `translate(${x - size / 2}px, ${y - size / 2}px)`
  lock.style.opacity = (seg(t, 0.2, 0.8) * (1 - seg(t, 5.2, 6.2)) * (t < 1.6 ? 0.6 + 0.4 * Math.round(Math.sin(t * 22) * 0.5 + 0.5) : 1)).toFixed(2)
  const dist = camera.position.distanceTo(portalPos)
  lockText.textContent = t < 2.6 ? TX.locking : TX.dist((dist * 0.0071).toFixed(2))
}

let bannerTimer = 0
function banner(text) {
  const b = $('banner')
  clearTimeout(bannerTimer)
  if (!text) { b.classList.remove('on'); return }
  b.textContent = text
  b.classList.add('on')
  bannerTimer = setTimeout(() => b.classList.remove('on'), 4200)
}

const pad = (n) => String(n).padStart(2, '0')
const mmss = (ms) => { const s = Math.max(0, ms / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s % 60))}` : `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}` }
let hudAcc = 0
function updateHud(dt, running) {
  hudAcc += dt
  $('log').style.transform = `translate(${Math.sin(now * 0.05) * 6}px, calc(-50% + ${Math.cos(now * 0.04) * 8}px))` // 慢慢漂，防烧屏
  if (hudAcc < 0.25) return
  hudAcc = 0
  renderSessions(running)
}

// ============================================================ 会话
// dsh-screensaver 读本机 Claude Code / Codex / DeepSeek Harness 会话（app/agents.js），经屏保外壳 postMessage 过来：
//   { type: 'desk:sessions', primary, lowPower, sessions: [{ id, kind: 'claude'|'codex'|'dsh', name, status: 'running'|'waiting'|'done'|'aborted', progress, startedAt, endedAt? }] }
// 列表里是这一轮屏保见过在跑的会话；结束的会留着，这里只显示本次跃迁里的。
const ST = TX.st
const isLive = (s) => s.status === 'running' || s.status === 'waiting'
let sessions = []
let voyageWall = 0 // 本次跃迁开始的钟点（毫秒）
const rows = new Map()

function valid(s) {
  return s && typeof s.id === 'string' && (s.kind === 'claude' || s.kind === 'codex' || s.kind === 'dsh') && s.status in ST && typeof s.startedAt === 'number'
}
function setSessions(list) {
  sessions = list.filter(valid).map((s) => ({ ...s, name: String(s.name ?? ''), progress: String(s.progress ?? '') }))
}
// 副屏：不显示会话；副屏和用电池时：最多 30 帧，分辨率也降一点（屏保一开几个钟头，多屏时每块屏一个渲染器）
let primary = true, lowPower = false, frameMs = 1000 / 61
function setRender(p, low) {
  if (p === primary && low === lowPower) return
  primary = p
  lowPower = low
  document.body.classList.toggle('secondary', !p)
  frameMs = p && !low ? 1000 / 61 : 1000 / 31
  renderer.setPixelRatio(!p ? 0.75 : low ? 1 : Math.min(devicePixelRatio, 1.25))
  composer.setPixelRatio(renderer.getPixelRatio())
  composer.setSize(innerWidth, innerHeight)
  renderer.getDrawingBufferSize(resV)
  rt.setSize(resV.x, resV.y)
  uRes.value.copy(resV)
}
addEventListener('message', (e) => {
  if (e.source !== parent) return
  const d = e.data
  // 纯享：屏保外壳 30 秒没人动就发 { type: 'desk:pure', on: true }，藏起播报、横幅、锁定框，只剩画面
  if (d && d.type === 'desk:pure') return void document.body.classList.toggle('pure', d.on === true)
  if (!d || d.type !== 'desk:sessions' || !Array.isArray(d.sessions)) return
  setRender(d.primary !== false, d.lowPower === true)
  setSessions(d.sessions)
})
if (parent !== window) parent.postMessage({ type: 'desk:ready' }, '*')

function renderSessions(running) {
  const log = $('log'), ul = $('sessions')
  const shown = sessions.filter((s) => isLive(s) || (s.endedAt ?? 0) >= voyageWall)
  const wall = Date.now()
  for (const s of shown) {
    let li = rows.get(s.id)
    if (!li) {
      li = document.createElement('li')
      li.innerHTML = `<span class="chip ${s.kind}"><i></i></span><div><div class="name"></div><div class="prog"></div></div><div class="meta"><span class="st"></span><span class="tm"></span></div>`
      ul.appendChild(li)
      rows.set(s.id, li)
    }
    li.className = s.status
    li.querySelector('.name').textContent = s.name
    const prog = li.querySelector('.prog')
    if (prog.dataset.t !== s.progress) {
      prog.textContent = ''
      const caret = document.createElement('span')
      caret.className = 'caret'
      caret.textContent = '›'
      prog.append(caret, s.progress)
      prog.dataset.t = s.progress
      prog.classList.remove('fresh')
      void prog.offsetWidth
      prog.classList.add('fresh')
    }
    const st = li.querySelector('.st')
    st.className = `st ${s.status}`
    st.textContent = (s.status === 'done' ? '✓ ' : s.status === 'aborted' ? '✕ ' : '') + ST[s.status]
    li.querySelector('.tm').textContent = mmss((s.endedAt ?? wall) - s.startedAt)
  }
  for (const [id, li] of rows) if (!shown.find((s) => s.id === id)) { li.remove(); rows.delete(id) }

  const nRun = shown.filter(isLive).length
  const nDone = shown.filter((s) => s.status === 'done').length
  const nAb = shown.filter((s) => s.status === 'aborted').length
  log.classList.toggle('on', shown.length > 0 && !(state === 'space' && stateT > 18))
  log.classList.toggle('calm', !running)
  if (state === 'space' && !running) {
    $('logTitle').textContent = TX.back
    $('logSub').textContent = ''
  } else {
    $('logTitle').textContent = state === 'exit' ? TX.tExit : state === 'enter' ? TX.tEnter : state === 'space' ? TX.tReady : TX.tJump
    $('logSub').textContent = nRun ? TX.nRun(nRun) : TX.wrap
  }
  $('logFoot').textContent = TX.foot(nDone, nAb) + (voyageStart ? TX.voyage(mmss(((state === 'space' ? voyageEnd : now) - voyageStart) * 1000)) : '')
}

// ============================================================ 演示（地址带 #demo 才有：在浏览器里单独看主题用，屏保里不会出现）
const DEMO = location.hash.includes('demo')
if (DEMO) {
  const dev = $('dev')
  const PROG = {
    claude: ['读取 saver.ts', '搜索 "sessionStatus"', '编辑 main.ts', 'Bash npm test', 'Bash npm run typecheck', '子代理：查 Codex 日志格式', '思考中…'],
    codex: ['exec rg -n "saver" src', 'apply_patch', 'exec npm run build', 'exec gh pr view 10', '推理中…', 'exec npx vitest run'],
    dsh: ['bash npm test', 'read_file agents.js', 'edit_file saver.js', '思考中…', 'web_search zstd frame format'],
  }
  const demo = []
  let seq = 0
  const add = (kind, name) => demo.push({ id: `demo:${++seq}`, kind, name, status: 'running', progress: PROG[kind][0], startedAt: Date.now() })
  const finish = (s, status) => { if (s && isLive(s)) Object.assign(s, { status, endedAt: Date.now(), progress: status === 'done' ? '本轮完成' : '被中断' }) }
  const SCRIPT = [
    [5, () => { add('claude', '亚空间跃迁屏保动画'); add('codex', 'api · PR #10 review') }],
    [12, () => add('dsh', '给 dsh 插件补测试')],
    [18, () => add('claude', '樱花树 3D 资产效果测试')],
    [34, () => { const s = demo.find((x) => x.kind === 'codex' && x.status === 'running'); if (s) Object.assign(s, { status: 'waiting', progress: '要执行 git push，等你点头' }) }],
    [41, () => { const s = demo.find((x) => x.status === 'waiting'); if (s) Object.assign(s, { status: 'running', progress: 'exec git push' }) }],
    [52, () => finish(demo.find((x) => x.kind === 'codex'), 'done')],
    [62, () => finish(demo.find((x) => x.name.startsWith('樱花')), 'aborted')],
    [74, () => finish(demo.find(isLive), 'done')],
  ]
  let demoT = 0, idx = 0, auto = true, progT = 0
  demoTick = (dt) => {
    if (auto) {
      demoT += dt
      while (idx < SCRIPT.length && demoT >= SCRIPT[idx][0]) SCRIPT[idx++][1]()
      if (idx >= SCRIPT.length && state === 'space' && stateT > 20) { demoT = 0; idx = 0; demo.length = 0 }
    }
    if ((progT += dt) > 3) {
      progT = 0
      for (const s of demo) if (s.status === 'running') s.progress = pick(PROG[s.kind])
    }
    setSessions(demo)
    $('devState').textContent = state
  }
  const NAMES = { claude: ['重构 IM 限流', '写屏保单测', '修 room 光照'], codex: ['迁移 vite 6', 'review PR #11', '补 README'], dsh: ['整理 changelog', '修 CI', '写插件文档'] }
  dev.addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a
    if (!a) return
    auto = false
    const live = demo.filter(isLive)
    if (a === 'claude' || a === 'codex' || a === 'dsh') add(a, pick(NAMES[a]))
    if (a === 'done') finish(live[0], 'done')
    if (a === 'abort') finish(live[0], 'aborted')
    if (a === 'wait' && live[0]) Object.assign(live[0], { status: 'waiting', progress: '要改 .env，等你点头' })
    if (a === 'all') live.forEach((s) => finish(s, 'done'))
  })
  addEventListener('keydown', (e) => { if (e.key === 'd' || e.key === 'D') dev.classList.toggle('hide') })
  window.__subspace = {
    get state() { return state }, demo, add, finish, walk, fireBolt,
    pause() { timeScale = 0 }, play() { timeScale = 1 },
    /** 不靠 requestAnimationFrame 往前推 sec 秒（页面在后台时用来截图检查） */
    step(sec, fps = 30) { for (let i = 0; i < sec * fps; i++) { demoTick(1 / fps); update(1 / fps) } render() },
  }
}

// ============================================================ 主循环（最多 60 帧，副屏 / 用电池 30 帧：屏保一开几个钟头，高刷屏上没必要跑满）
const clock = new THREE.Clock()
let timeScale = 1, lastFrame = 0
function frame(t) {
  requestAnimationFrame(frame)
  if (t - lastFrame < frameMs) return
  lastFrame = t
  const dt = Math.min(clock.getDelta(), 1 / 20) * timeScale
  demoTick(dt)
  update(dt)
  render()
}
function render() {
  if (needRT) {
    renderer.setRenderTarget(rt)
    renderer.render(needRT === 'tunnel' ? tunScene : spaceScene, auxCam)
    renderer.setRenderTarget(null)
  }
  composer.render()
}
spacePose(camera, 0)
requestAnimationFrame(frame)
