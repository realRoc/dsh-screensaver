// 亚空间风格「浪涌龙卷」：在海浪卷成的龙卷风口里穿行。
// 通道不是一根光管：壁上是一股股拧着转的浪绳，时宽时窄；不时有柱子斜着穿过风口，两头像喇叭一样散开、跟洞壁平滑地长在一起（smooth min），
// 把风口分成几股。这种形状用网格拼不自然，所以用距离场光线步进画，先画进一张低分辨率的图（很费 GPU），再当背景贴进隧道场景。
import * as THREE from 'three'

const PSP = 62 // 柱子的平均间距（沿隧道）
const MAXT = 380

export function createVortex({ NOISE, BEND_GLSL, STYLE_GLSL, tunU }) {
  const uniforms = {
    uTime: tunU.uTime, uTravel: tunU.uTravel, uAmp: tunU.uAmp, uIntensity: tunU.uIntensity,
    uDeep: tunU.uDeep, uMid: tunU.uMid, uHi: tunU.uHi, uGlow: tunU.uGlow,
    uB0: { value: new THREE.Vector2() },
    uSW: { value: new THREE.Vector4(0, 1, 0, 0) },
    uCamWorld: { value: new THREE.Matrix4() },
    uInvProj: { value: new THREE.Matrix4() },
    uR: { value: 16 },
    uPillars: { value: 0.72 }, // 一段里有柱子的概率
  }
  const FULL_VERT = `varying vec2 vNdc; void main(){ vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }`
  const march = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, uniforms, vertexShader: FULL_VERT,
    fragmentShader: NOISE + STYLE_GLSL + `
      uniform float uTime, uTravel, uAmp, uIntensity, uR, uPillars;
      uniform vec2 uB0; uniform vec3 uDeep, uMid, uHi, uGlow; uniform mat4 uCamWorld, uInvProj;
      varying vec2 vNdc;
      ${BEND_GLSL}
      const float PSP = ${PSP.toFixed(1)};
      float smin(float a, float b, float k){ float h = clamp(0.5 + 0.5*(b - a)/k, 0.0, 1.0); return mix(b, a, h) - k*h*(1.0 - h); }
      vec4 hash4(float n){ return fract(sin(vec4(n*12.9898, n*78.233, n*37.719, n*91.531))*43758.5453); }

      // 洞壁半径：一节节的腔室（时宽时窄）+ 三股主浪绳、五股细浪绳，绕着轴慢慢往同一个方向拧
      float wallR(float s, float a){
        float ch = 1.0 + 0.2*sin(s*0.0105 + 1.0)*sin(s*0.0047 + 2.3);
        float rope = 1.7*sin(3.0*a + s*0.045 - uTime*0.5) + 0.75*sin(5.0*a - s*0.028 - uTime*0.32 + 1.3);
        return uR*ch + rope;
      }
      // 第 k 根柱子：斜着横穿风口的一条弦（离轴线至少半个半径，镜头从旁边过），两头喇叭口扎进洞壁；柱身拧成绳
      float pillar(vec3 P, float k){
        vec4 h = hash4(k + 17.0);
        if (h.x > uPillars) return 1e4;
        float sk = (k + 0.5 + (h.y - 0.5)*0.4)*PSP;
        float phi = h.z*6.2832;
        vec2 n = vec2(cos(phi), sin(phi)), t = vec2(-n.y, n.x);
        float off = uR*(0.52 + 0.24*h.w);
        float span = 8.0 + 24.0*fract(h.x*17.0 + h.y*5.0);
        vec3 A = vec3(n*off + t*uR*1.6, sk - span), B = vec3(n*off - t*uR*1.6, sk + span);
        vec3 ba = B - A, pa = P - A;
        float u = clamp(dot(pa, ba)/dot(ba, ba), 0.0, 1.0);
        vec3 dv = pa - ba*u;
        float e = abs(u*2.0 - 1.0);
        float r0 = mix(1.5, 2.7, fract(h.w*13.0));
        float tw = 0.35*sin(u*30.0 + atan(dv.y, dv.x)*2.0 - uTime*0.7);
        return length(dv) - (r0*(1.0 + 2.6*e*e*e*e) + tw);
      }
      float map(vec3 p){
        float s = uTravel - p.z;
        vec2 q = p.xy - (bend(s) - uB0);
        float d = wallR(s, atan(q.y, q.x)) - length(q);
        vec3 P = vec3(q, s);
        float k = floor(s/PSP);
        d = smin(d, pillar(P, k - 1.0), 5.0);
        d = smin(d, pillar(P, k), 5.0);
        d = smin(d, pillar(P, k + 1.0), 5.0);
        return d;
      }
      vec3 normalAt(vec3 p, float e){
        const vec2 k = vec2(1.0, -1.0);
        return normalize(k.xyy*map(p + k.xyy*e) + k.yyx*map(p + k.yyx*e) + k.yxy*map(p + k.yxy*e) + k.xxx*map(p + k.xxx*e));
      }

      void main(){
        vec4 v = uInvProj*vec4(vNdc, 1.0, 1.0);
        vec3 rd = normalize((uCamWorld*vec4(normalize(v.xyz/v.w), 0.0)).xyz);
        vec3 ro = (uCamWorld*vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float t = 0.4, d = 1.0, mist = 0.0;
        bool hit = false;
        for (int i = 0; i < 84; i++){
          d = map(ro + rd*t);
          mist += exp(-max(d, 0.0)*0.4);   // 擦着浪面过去的光线带上一层水雾
          if (d < 0.02 + t*0.0025){ hit = true; break; }
          t += d*0.8;
          if (t > ${MAXT.toFixed(1)}) break;
        }
        t = min(t, ${MAXT.toFixed(1)});
        vec3 p = ro + rd*t;
        float s = uTravel - p.z;
        // 远处一团暖光：风口尽头
        vec2 cEnd = bend(uTravel + 260.0) - uB0;
        vec3 Lp = vec3(cEnd, -260.0);
        float fwd = max(dot(rd, normalize(Lp - ro)), 0.0);
        vec3 haze = uGlow*(0.07 + 0.55*pow(fwd, 14.0) + 0.08*pow(fwd, 3.0));
        vec3 col = haze;
        float n01 = 0.5;
        if (hit){
          vec3 N = normalAt(p, 0.04 + t*0.002);
          vec2 q = p.xy - (bend(s) - uB0);
          float a = atan(q.y, q.x);
          // 浪面花纹沿着拧的方向拉长：大块明暗 + 细长水纹
          float sw = a + s*0.03 - uTime*0.3;
          vec3 qn = vec3(cos(sw)*1.5, sin(sw)*1.5, s*0.016);
          float w = fbm(qn*0.9 + vec3(0.0, 0.0, uTime*0.04));
          float n = fbm(qn + w*1.3);
          n01 = clamp(n*0.5 + 0.5, 0.0, 1.0);
          float fib = pow(clamp(snoise(vec3(cos(sw)*7.0, sin(sw)*7.0, s*0.006 + w))*0.5 + 0.5, 0.0, 1.0), 5.0);
          vec3 L = normalize(Lp - p);
          float diff = max(dot(N, L), 0.0); diff = diff*diff*0.85 + 0.15*max(dot(N, -rd), 0.0);
          float spec = pow(max(dot(reflect(rd, N), L), 0.0), 18.0);
          float fres = pow(1.0 - max(dot(N, -rd), 0.0), 3.0);
          float ao = clamp(map(p + N*2.5)/2.5, 0.0, 1.0);
          vec3 base = mix(uDeep*1.5, uMid*0.85, smoothstep(-0.45, 0.65, n));
          col = base*(0.06 + 1.25*diff)*(0.2 + 0.8*ao);
          col += uHi*(spec*0.45 + fib*0.4*diff)*(0.3 + 0.7*ao);
          col += uGlow*fres*0.22;
          col = mix(col, haze, 1.0 - exp(-t*0.0045));
        }
        col += uGlow*min(mist, 30.0)*0.0025;
        // 跟别的风格交接：按这个点在隧道上的位置算权重，边界不是一条直线，是被浪纹啃出来的一圈亮边
        float sw2 = styleW(s);
        float th = sw2*1.12 - 0.06;
        float vis = smoothstep(n01 - 0.06, n01 + 0.06, th);
        float edge = exp(-pow((th - n01)/0.05, 2.0))*smoothstep(0.0, 0.04, sw2)*(1.0 - smoothstep(0.96, 1.0, sw2));
        col += uHi*edge*0.9;
        gl_FragColor = vec4(col*uIntensity, clamp(max(vis, edge), 0.0, 1.0));
      }`,
  }))
  march.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(march)
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false })

  // 贴回隧道场景：一张全屏的背景，排在天空之后、云墙之前
  const show = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false,
    uniforms: { uTex: { value: target.texture } },
    vertexShader: FULL_VERT,
    fragmentShader: `uniform sampler2D uTex; varying vec2 vNdc; void main(){ gl_FragColor = texture2D(uTex, vNdc*0.5 + 0.5); }`,
  }))
  show.frustumCulled = false
  show.renderOrder = -9
  show.visible = false

  let scale = 0.6, w = 4, h = 4
  return {
    show,
    uniforms,
    setSize(width, height, s = scale) {
      scale = s
      w = Math.max(4, Math.round(width * scale))
      h = Math.max(4, Math.round(height * scale))
      target.setSize(w, h)
    },
    /** 用这台相机（主镜头或画入口窗户的那台）先把龙卷画进低分辨率的图 */
    prepare(renderer, cam) {
      if (!show.visible) return
      cam.updateMatrixWorld()
      uniforms.uCamWorld.value.copy(cam.matrixWorld)
      uniforms.uInvProj.value.copy(cam.projectionMatrixInverse)
      const prev = renderer.getRenderTarget()
      renderer.setRenderTarget(target)
      renderer.render(scene, ortho)
      renderer.setRenderTarget(prev)
    },
  }
}
