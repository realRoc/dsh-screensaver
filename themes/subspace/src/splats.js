// 亚空间风格「高斯粒子」：隧道壁由几万个贴在壁上的扁椭圆高斯（3D Gaussian Splatting 那种 splat）拼成。
// 「烧成高斯」的玩法受 willeastcott/splat-walk 启发（那边是 PlayCanvas + 一份 78 MB 的街道扫描，这里没法直接搬，
// 代码也是这里自己写的）：一道火线扫过，每个高斯先闪白、缩成自己椭圆的一圈亮边，再塌成一颗余烬绕着轴飘；
// 几秒后一道青色的波从同一点扫回来，余烬飞回原位、重新鼓成一片完整的壁。
// 跟别的风格交接也走这一套：在交界那一段，壁「烧」成轮廓和余烬，飞过去就到了另一种风格里。
import * as THREE from 'three'

export function createSplats({ NOISE, BEND_GLSL, STYLE_GLSL, tunU, count, TUN_L, radius }) {
  // 分成几段（按在隧道上的位置），每段里从远到近排好；每帧再按离镜头远近排各段的先后，画出来基本是从远到近盖的
  const CHUNKS = 10, per = Math.ceil(count / CHUNKS), chunkL = TUN_L / CHUNKS
  const base = new THREE.PlaneGeometry(2, 2)
  const geos = []
  for (let c = 0; c < CHUNKS; c++) {
    const list = []
    for (let i = 0; i < per; i++) {
      const floater = Math.random() < 0.14 // 一部分飘在通道里，像空气里的尘
      const k = Math.pow(Math.random(), 1.6)
      list.push({
        // 角度、在隧道上的位置、离轴多远、在壁面里的朝向（沿着螺旋拉长：大多顺着隧道、带一点拧）
        sp: [Math.random() * Math.PI * 2, (c + Math.random()) * chunkL, floater ? 0.3 + Math.random() * 0.55 : 0.93 + Math.random() * 0.13, 1.2 + (Math.random() - 0.5) * 0.7],
        size: floater ? [0.1 + k * 0.22, 0.08 + k * 0.14] : [0.45 + k * 1.3, 0.22 + k * 0.5],
        seed: [Math.random(), Math.random(), Math.random()],
      })
    }
    list.sort((a, b) => b.sp[1] - a.sp[1])
    const sp = new Float32Array(per * 4), size = new Float32Array(per * 2), seed = new Float32Array(per * 3)
    list.forEach((o, i) => { sp.set(o.sp, i * 4); size.set(o.size, i * 2); seed.set(o.seed, i * 3) })
    const geo = new THREE.InstancedBufferGeometry()
    geo.index = base.index
    geo.setAttribute('position', base.getAttribute('position'))
    geo.setAttribute('aSplat', new THREE.InstancedBufferAttribute(sp, 4))
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 2))
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 3))
    geo.instanceCount = per
    geos.push(geo)
  }

  const uniforms = {
    uTime: tunU.uTime, uTravel: tunU.uTravel, uAmp: tunU.uAmp, uIntensity: tunU.uIntensity,
    uDeep: tunU.uDeep, uMid: tunU.uMid, uHi: tunU.uHi, uGlow: tunU.uGlow,
    uB0: { value: new THREE.Vector2() },
    uSW: { value: new THREE.Vector4(0, 1, 0, 0) },
    uRadius: { value: radius },
    // 引燃：起点（隧道上的位置 s、角度）、引燃后过了几秒、开没开
    uBurn: { value: new THREE.Vector4(0, 0, 0, 0) },
    // 火线能烧多远、火线变慢的时间常数、几秒后开始复原、复原波的时间常数
    uBurnShape: { value: new THREE.Vector4(240, 1.5, 4.2, 1.2) },
  }
  const L = TUN_L.toFixed(1)
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms,
    vertexShader: NOISE + STYLE_GLSL + `
      attribute vec4 aSplat; attribute vec2 aSize; attribute vec3 aSeed;
      uniform float uTime, uTravel, uAmp, uIntensity, uRadius;
      uniform vec2 uB0; uniform vec4 uBurn, uBurnShape; uniform vec3 uDeep, uMid, uHi, uGlow;
      varying vec2 vUv; varying vec3 vCol; varying float vA, vRing, vDot;
      ${BEND_GLSL}
      void main(){
        float d = mod(aSplat.y - uTravel, ${L}) - 12.0;
        float s = uTravel + d;
        float a = aSplat.x;

        // ---- 风格交接：这一段的权重决定它是完整的高斯、一圈轮廓，还是余烬；每个高斯错开一点，交界是一片不是一条线
        float ph = clamp(styleW(s)*1.5 - 0.25 + (aSeed.x - 0.5)*0.5, 0.0, 1.0);
        float ring = smoothstep(0.52, 0.68, ph)*(1.0 - smoothstep(0.76, 0.92, ph));
        float dotv = 1.0 - smoothstep(0.42, 0.6, ph);
        float life = smoothstep(0.0, 0.3, ph);
        float drift = dotv*(1.0 - ph);
        float heat = dotv*0.6;
        vec3 flash = uHi*exp(-pow((ph - 0.72)/0.05, 2.0))*0.3;

        // ---- 引燃 / 复原
        if (uBurn.w > 0.0){
          vec3 o = vec3(uRadius*cos(uBurn.y), uRadius*sin(uBurn.y), uBurn.x);
          vec3 me = vec3(uRadius*aSplat.z*cos(a), uRadius*aSplat.z*sin(a), s);
          float dist = distance(me, o), reach = uBurnShape.x;
          if (dist < reach){
            float tau = uBurn.z;
            float since = tau + uBurnShape.y*log(1.0 - dist/reach); // 火线越走越慢
            float tr = tau - uBurnShape.z;
            float sr = tr > 0.0 ? tr + uBurnShape.w*log(1.0 - dist/(reach + 4.0)) : -10.0;
            float back = smoothstep(0.0, 0.6, sr), whole = smoothstep(0.6, 1.1, sr);
            ring = max(ring, smoothstep(-0.05, 0.15, since)*(1.0 - smoothstep(0.7, 1.2, since))*(1.0 - back) + smoothstep(0.15, 0.4, sr)*(1.0 - whole));
            float bd = smoothstep(0.7, 1.3, since)*(1.0 - back);
            dotv = max(dotv, bd);
            flash += vec3(1.0, 0.62, 0.3)*exp(-since*since/0.012)*(1.0 - back)*1.8 + vec3(0.3, 0.78, 1.0)*exp(-pow(sr - 0.08, 2.0)/0.012)*1.5;
            drift = max(drift, (1.0 - exp(-max(since - 0.7, 0.0)/1.6))*(1.0 - back));
            heat = max(heat, bd*(0.25 + 0.75*exp(-max(since - 0.9, 0.0)/1.4)));
          }
        }
        // 塌成点的只留一半左右，余烬才清爽
        life *= mix(1.0, step(aSeed.y, 0.55), smoothstep(0.3, 0.8, dotv));

        // ---- 余烬：绕轴来回荡、往轴心落、朝镜头这边漂（都是有界的摆动，跑几个钟头也不会越飘越远）
        a += drift*(0.9*sin(uTime*(0.25 + 0.3*aSeed.z) + aSeed.x*6.2832) + 0.6*(aSeed.z - 0.5));
        float r = uRadius*aSplat.z*(1.0 + 0.12*sin(a*3.0 + s*0.02));
        r *= 1.0 - drift*(0.15 + 0.5*aSeed.z);
        float dd = d - drift*(3.0 + 10.0*aSeed.x) + drift*sin(uTime*0.7 + aSeed.y*6.2832)*1.5;
        vec2 c = bend(uTravel + dd) - uB0;
        vec3 center = vec3(c + r*vec2(cos(a), sin(a)), -dd);

        // 完整的高斯贴着壁（切平面里的椭圆）；塌成点以后朝着镜头
        vec3 T1 = vec3(-sin(a), cos(a), 0.0), T2 = vec3(0.0, 0.0, 1.0);
        float rot = aSplat.w;
        vec3 e1 = cos(rot)*T1 + sin(rot)*T2, e2 = -sin(rot)*T1 + cos(rot)*T2;
        vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        e1 = normalize(mix(e1, camR, dotv)); e2 = normalize(mix(e2, camU, dotv));
        vec2 sz = mix(aSize, vec2(0.1 + 0.09*aSeed.z), dotv);
        vec3 wp = center + (e1*position.x*sz.x + e2*position.y*sz.y)*3.0;
        vUv = position.xy;
        gl_Position = projectionMatrix*viewMatrix*vec4(wp, 1.0);

        // ---- 颜色：壁上大块明暗跟着调色板走，远处融进雾里；余烬是暖的
        float n = snoise(vec3(cos(a)*1.3, sin(a)*1.3, s*0.02));
        float n2 = snoise(vec3(cos(a)*3.0, sin(a)*3.0, s*0.05 + 4.0));
        vec3 col = mix(uDeep*2.0 + uMid*0.12, uMid, smoothstep(-0.5, 0.6, n));
        col = mix(col, uHi, smoothstep(0.35, 0.9, n2)*0.4);
        col *= 0.22 + 0.55*aSeed.z*aSeed.z;
        col = mix(col, uGlow*0.3, smoothstep(90.0, 390.0, d));
        col = mix(col, col*1.7 + uHi*0.22, ring);
        vec3 ember = mix(vec3(1.0, 0.36, 0.08), vec3(1.0, 0.86, 0.6), heat)*(0.35 + 1.15*heat);
        vCol = (mix(col, ember, dotv) + flash)*uIntensity;
        vRing = ring;
        vDot = dotv;
        vA = life*smoothstep(-10.0, 6.0, dd)*(1.0 - smoothstep(340.0, 404.0, d));
      }`,
    fragmentShader: `
      varying vec2 vUv; varying vec3 vCol; varying float vA, vRing, vDot;
      void main(){
        float r2 = dot(vUv, vUv);
        if (r2 > 1.0 || vA < 0.002) discard;
        float g = exp(-4.5*r2);
        float ring = exp(-pow((sqrt(r2) - 0.62)/0.07, 2.0));
        float shape = mix(g, ring*1.3 + g*0.08, vRing);
        shape = mix(shape, exp(-6.0*r2), vDot);
        float al = shape*vA;
        gl_FragColor = vec4(vCol*al, al*mix(0.92, 0.3, vDot)); // 完整的高斯基本不透明、按顺序盖住后面的；余烬是发光的
      }`,
  })
  const mesh = new THREE.Group()
  const parts = geos.map((g) => { const m = new THREE.Mesh(g, mat); m.frustumCulled = false; mesh.add(m); return m })
  mesh.visible = false
  function sortChunks() {
    const tr = uniforms.uTravel.value
    parts.forEach((m, c) => {
      const d = (((c + 0.5) * chunkL - tr) % TUN_L + TUN_L) % TUN_L - 12
      m.renderOrder = -4 + (1 - d / TUN_L) * 3 // 远的先画（renderOrder 小的先画）；整体排在龙卷背景(-9)之后、云墙(0)之前
    })
  }

  // 引燃：起点放在前方远处，镜头飞进去的时候正好是一片余烬，然后青色的复原波追上来
  const burn = { on: false, tau: 0 }
  return {
    mesh,
    uniforms,
    get burning() { return burn.on },
    ignite(sNow) {
      burn.on = true
      burn.tau = 0
      uniforms.uBurn.value.set(sNow + 300 + Math.random() * 60, Math.random() * Math.PI * 2, 0, 1)
    },
    tick(dt) {
      if (mesh.visible) sortChunks()
      if (!burn.on) return
      burn.tau += dt
      uniforms.uBurn.value.z = burn.tau
      const sh = uniforms.uBurnShape.value
      if (burn.tau > sh.z + sh.w * 6 + 2) { burn.on = false; uniforms.uBurn.value.w = 0 }
    },
  }
}
