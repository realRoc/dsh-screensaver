/* 待机界面：塔顶书房（极繁 + HD-2D）。骑士坐在书桌前读书，双手搭在书页上；背后哥特长窗外是海上满月。
 * 满屋子的小物件：辉石结晶簇、烛台和蜡烛堆、钥匙、开着盖冒蓝光的宝箱和小匣子、水晶球、绕着飞的魔法石、
 * 半身像和星盘、沙漏和星辉仪。
 * 对外暴露：scene / camera / update() / 转场需要的书本位置。 */
export function buildStudy(H) {
  const {
    THREE, makeCanvas, pixelTex, shade, mulberry32, makeShelfTextures, makeSoftCanvas,
    pointsMaterial, flameMaterial, COMMON_GLSL, NOISE_GLSL, SOFT_POINT_FRAG, BOOK_COLORS,
    makePageCanvas, makeCoverCanvas, makeKnightMesh, orientKnight, setKnightLights, setKnightRim, makeQuietZone, placeQuietZone, makePageBurst, sitHands, sitTurn,
    glintGeometry, makeGlintMaterial,
  } = H;
  const V3 = THREE.Vector3;
  const scene = new THREE.Scene();
  const FOG = 0x0e1828;
  scene.background = new THREE.Color(FOG);
  scene.fog = new THREE.FogExp2(FOG, 0.03);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.03, 200);
  const ROOM_R = 6.5, WALL_H = 9;
  const rnd = mulberry32(4242);
  const R = (a, b) => a + rnd() * (b - a);

  // 骑士和书桌的相对位置由 Blender 里的 SIT_HANDS 决定：书正好落在他手下
  const KNIGHT_POS = new V3(-0.62, 0, 0);
  const TOP = sitHands.height - 0.085;                      // 桌面高度
  const BOOK_X = KNIGHT_POS.x + sitHands.forward;           // 书中心（世界 x）
  const DESK_X = BOOK_X + 0.34;

  /* ---------------- 材质 ---------------- */
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x4a5068, roughness: 0.85, flatShading: true });
  const marbleMat = new THREE.MeshStandardMaterial({ color: 0x9aa2b8, roughness: 0.6, flatShading: true });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xd8a850, metalness: 0.6, roughness: 0.3, emissive: 0x3a2808, emissiveIntensity: 0.6 });
  const darkGold = new THREE.MeshStandardMaterial({ color: 0x9a7030, metalness: 0.6, roughness: 0.4, emissive: 0x1a1004, emissiveIntensity: 0.5 });
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x5a3820, roughness: 0.65, flatShading: true });
  const darkWood = new THREE.MeshStandardMaterial({ color: 0x3a2414, roughness: 0.7, flatShading: true });
  const waxMat = new THREE.MeshStandardMaterial({ color: 0xf2e6cc, emissive: 0xff9a50, emissiveIntensity: 0.25, roughness: 0.5 });
  const glint = makeGlintMaterial();
  // 《Pixel Magic》圣经 §2：书房的道具都「睡着」——平时不自己发光，只被月光和书桌烛火照到；进塔转场时（pose.surge）一起醒来。
  // 所有自发光的小东西都登记在 sleepers 里，每帧按 awake 在「睡着」和「醒着」之间插值
  const uAwake = { value: 0 };
  const sleepers = [];
  const glowBasic = (r, g, b, sleep = 0.1) => {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) });
    sleepers.push({ c: m.color, base: m.color.clone(), sleep });
    return m;
  };
  const softTex = new THREE.CanvasTexture(makeSoftCanvas('rgba(255,255,255,1)', 'rgba(255,255,255,0)'));
  const halo = (col, s, sleep = 0.1) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex, color: new THREE.Color(...col), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    sp.scale.setScalar(s);
    if (sleep < 1) sleepers.push({ c: sp.material.color, base: sp.material.color.clone(), sleep });
    return sp;
  };

  // 菱形晶片：细长菱形，边缘亮、芯稍暗，按 vRot 转
  const SHARD_FRAG = /* glsl */`
    varying vec3 vColor; varying float vAlpha; varying float vRot;
    void main(){
      vec2 c = gl_PointCoord - 0.5; float cs = cos(vRot), sn = sin(vRot);
      c = mat2(cs, -sn, sn, cs) * c;
      float d = abs(c.x)/0.15 + abs(c.y)/0.47;
      if (d > 1.0) discard;
      float edge = smoothstep(0.55, 0.95, d), facet = step(0.0, c.x*c.y);
      gl_FragColor = vec4(vColor * (0.35 + 0.25*facet + edge*0.9) * clamp(vAlpha, 0.0, 2.0), 1.0);
    }`;

  /* ---------------- 像素贴图 ---------------- */
  function floorCanvas() {
    const S = 64, { c, g } = makeCanvas(S, S);
    const RP = ['#1c1a26', '#2a2736', '#3a3648', '#4a465a', '#5c5870'];
    for (let by = 0; by < 4; by++) for (let bx = 0; bx < 4; bx++) {
      const tone = 1 + ((bx * 7 + by * 3) % 3);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        let k = tone;
        if (x === 0 || y === 0) k = 0; else if (x === 1 || y === 1) k = Math.min(4, tone + 1);
        else if (x === 15 || y === 15) k = Math.max(0, tone - 1);
        if (((x * 13 + y * 7 + bx * 5) % 23) === 0) k = Math.max(0, k - 1);
        g.fillStyle = RP[k]; g.fillRect(bx * 16 + x, by * 16 + y, 1, 1);
      }
    }
    return c;
  }
  function rugCanvas() {
    const S = 128, { c, g } = makeCanvas(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = x - 63.5, dy = y - 63.5, d = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
      if (d > 63) continue;
      // 地毯在主角脚下：压一档、去掉跳的浅蓝（圣经 §2：书房的亮和饱和留给骑士、书和月光）
      let col = shade('#3c1424', 0.8 + 0.25 * Math.sin(d * 0.4));
      if (Math.abs(d - 60) < 1.5 || Math.abs(d - 50) < 0.8 || Math.abs(d - 30) < 0.8) col = '#c9993c';
      if (d > 50 && d < 60 && Math.abs(Math.sin(a * 12)) < 0.12) col = '#e2bb63';
      if (d > 30 && d < 50) { const tri = Math.abs(((a / (Math.PI * 2) * 6 + 10) % 1) - 0.5) * 2; if (Math.abs(tri * 20 + 30 - d) < 0.9) col = '#4e6a96'; }
      if (d < 30 && Math.abs(Math.sin(a * 4 + d * 0.3)) < 0.1) col = '#2a5aa0';
      if (d < 8) col = d < 4 ? '#5e86b4' : '#c9993c';
      g.fillStyle = col; g.fillRect(x, y, 1, 1);
    }
    return c;
  }
  function windowCanvas() {
    const W = 72, Hh = 168, { c, g } = makeCanvas(W, Hh);
    const ST = ['#1a1d2c', '#2c3044', '#444a62', '#5e6680', '#7e88a2', '#a6aec6'];
    const lancet = (x, y, cx, half, spring, bottom) => {
      if (x < cx - half || x > cx + half || y > bottom) return false;
      if (y >= spring) return true;
      const Rr = half * 2;
      return Math.hypot(x - (cx - half), y - spring) <= Rr && Math.hypot(x - (cx + half), y - spring) <= Rr;
    };
    const open = (x, y) => {
      if (lancet(x, y, 22, 11, 70, 158) || lancet(x, y, 50, 11, 70, 158)) return true;
      const d = Math.hypot(x - 36, y - 30);
      return d < 15 && !(Math.abs(d - 7) < 1.2) && !(d > 7 && Math.abs(Math.sin(Math.atan2(y - 30, x - 36) * 4)) < 0.16);
    };
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      if (open(x, y)) {
        if ((y > 70 && (x === 22 || x === 50)) || (y > 70 && y % 22 === 0)) { g.fillStyle = '#20202c'; g.fillRect(x, y, 1, 1); }
        continue;
      }
      let near = 9;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (open(x + dx, y + dy)) near = Math.min(near, Math.max(Math.abs(dx), Math.abs(dy)));
      let k = 2 + ((Math.floor(y / 12) + Math.floor((x + (Math.floor(y / 12) % 2) * 8) / 16)) % 2);
      if (y % 12 === 0 || (x + (Math.floor(y / 12) % 2) * 8) % 16 === 0) k = 1;
      if (near === 1) k = 5; else if (near === 2) k = 4; else if (near === 3) k = 1;
      g.fillStyle = ST[k]; g.fillRect(x, y, 1, 1);
    }
    return c;
  }
  function shieldCanvas() {
    const W = 64, Hh = 100, { c, g } = makeCanvas(W, Hh), { c: e, g: ge } = makeCanvas(W, Hh);
    ge.fillStyle = '#000'; ge.fillRect(0, 0, W, Hh);
    const S = ['#2a2e40', '#4a5268', '#6e7890', '#98a2b8', '#c6cede', '#eef2fa'];
    const inS = (x, y, k) => {
      const u = (x + 0.5 - W / 2) / (W / 2), v0 = (y + 0.5) / Hh, v = (v0 - 0.4) / k + 0.4;
      if (v < 0 || v > 1) return false;
      const lim = v < 0.35 ? 1 - Math.max(0, 0.06 - v) * 5 : Math.pow(Math.max(0, 1 - (v - 0.35) / 0.65), 0.8);
      return Math.abs(u / k) <= lim;
    };
    const edge = (x, y, k) => inS(x, y, k) && !(inS(x - 1, y, k) && inS(x + 1, y, k) && inS(x, y - 1, k) && inS(x, y + 1, k));
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      if (!inS(x, y, 1)) continue;
      const u = (x - W / 2) / (W / 2), v = y / Hh;
      let k = Math.round(2.4 + u * 1.2 - v * 1.4);
      if (Math.abs(Math.sin(x * 0.55 + Math.sin(y * 0.3) * 2.5) + Math.sin(y * 0.42 - x * 0.2)) < 0.18) k -= 1;
      let col = S[Math.max(0, Math.min(5, k))];
      for (const s of [0.82, 0.64]) if (edge(x, y, s)) col = u > 0 ? '#e6c068' : '#9a7030';
      if (edge(x, y, 0.83) || edge(x, y, 0.65)) col = S[1];
      if (edge(x, y, 1)) col = u > 0 ? '#f0cc72' : '#a87a34';
      g.fillStyle = col; g.fillRect(x, y, 1, 1);
    }
    const gem = (cx, cy, r, colr) => {
      for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + 0.5) {
        const cc = x * x + y * y < r * r * 0.3 ? '#e8faff' : colr;
        g.fillStyle = cc; g.fillRect(cx + x, cy + y, 1, 1); ge.fillStyle = cc; ge.fillRect(cx + x, cy + y, 1, 1);
      }
    };
    gem(32, 36, 4, '#3c8cff');
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; gem(Math.round(32 + Math.cos(a) * 9), Math.round(36 + Math.sin(a) * 11), 1, '#4ac8b8'); }
    return { map: c, emissive: e };
  }
  function featherCanvas() {
    const { c, g } = makeCanvas(8, 40);
    for (let y = 0; y < 40; y++) {
      const hw = y < 4 ? y * 0.6 : y > 34 ? 0 : 3.2 - (y - 4) * 0.06;
      for (let x = Math.round(4 - hw); x <= Math.round(4 + hw); x++) { g.fillStyle = x === 4 ? '#c8b89a' : (x + y) % 3 ? '#f2eee4' : '#d6d0c4'; g.fillRect(x, y, 1, 1); }
      if (y >= 34) { g.fillStyle = '#c8b89a'; g.fillRect(4, y, 1, 1); }
    }
    return c;
  }
  function circleRuneCanvas() {
    // 星盘 / 法阵用的发光符文圈：三道圆、刻度、五角星、外圈符文
    const S = 96, { c, g } = makeCanvas(S, S), r2 = mulberry32(17);
    g.fillStyle = '#fff';
    const segs = [];
    for (let k = 0; k < 5; k++) {
      const a1 = k / 5 * Math.PI * 2 - Math.PI / 2, a2 = (k + 2) / 5 * Math.PI * 2 - Math.PI / 2;
      segs.push([47.5 + Math.cos(a1) * 22, 47.5 + Math.sin(a1) * 22, 47.5 + Math.cos(a2) * 22, 47.5 + Math.sin(a2) * 22]);
    }
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - 47.5, y - 47.5), a = Math.atan2(y - 47.5, x - 47.5);
      let on = Math.abs(d - 46) < 0.8 || Math.abs(d - 38) < 0.6 || Math.abs(d - 22) < 0.6;
      if (d < 38 && d > 22) { const fa = ((a + Math.PI) / (Math.PI * 2) * 24) % 1, seg = Math.floor((a + Math.PI) / (Math.PI * 2) * 24); if (Math.abs(fa - 0.5) < 0.06 && (seg % 2 || d < 30)) on = true; }
      for (const [x1, y1, x2, y2] of segs) {
        const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / ((x2 - x1) ** 2 + (y2 - y1) ** 2)));
        if (Math.hypot(x - (x1 + (x2 - x1) * t), y - (y1 + (y2 - y1) * t)) < 0.6) on = true;
      }
      if (on) g.fillRect(x, y, 1, 1);
    }
    for (let i = 0; i < 18; i++) { const a = i / 18 * Math.PI * 2; const x = Math.round(47.5 + Math.cos(a) * 42), y = Math.round(47.5 + Math.sin(a) * 42); g.fillRect(x - 1, y - 2, 2, 4); if (r2() < 0.5) g.fillRect(x - 2, y, 4, 1); }
    return c;
  }

  /* ---------------- 房间：地面、地毯、书架墙、长窗、窗外的海上满月 ---------------- */
  const floor = new THREE.Mesh(new THREE.CircleGeometry(ROOM_R + 0.2, 72), new THREE.MeshStandardMaterial({ map: pixelTex(floorCanvas(), 10, 10), roughness: 0.85 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const rugTex = pixelTex(rugCanvas()); rugTex.wrapS = rugTex.wrapT = THREE.ClampToEdgeWrapping;
  const rug = new THREE.Mesh(new THREE.CircleGeometry(2.7, 64), new THREE.MeshStandardMaterial({ map: rugTex, roughness: 1, emissive: 0x1a1020, emissiveIntensity: 0.4 }));
  rug.rotation.x = -Math.PI / 2; rug.position.set(0.0, 0.006, 0.2);
  scene.add(rug);

  const GAP = 0.56;
  const shelf = makeShelfTextures(640, 77);
  const wallLen = (Math.PI * 2 - GAP) * ROOM_R;
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(ROOM_R, ROOM_R, WALL_H, 120, 1, true, Math.PI + GAP / 2, Math.PI * 2 - GAP), new THREE.MeshStandardMaterial({
    map: pixelTex(shelf.map, wallLen / 20, WALL_H / 1.25 / 4), emissiveMap: pixelTex(shelf.emissive, wallLen / 20, WALL_H / 1.25 / 4),
    emissive: 0xffffff, emissiveIntensity: 0.3, roughness: 0.9, side: THREE.BackSide,
  }));
  wall.position.y = WALL_H / 2;
  scene.add(wall);
  {
    const N = 14, pm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, WALL_H, 0.5), stoneMat, N), o = new THREE.Object3D();
    for (let i = 0; i < N; i++) {
      const th = Math.PI + GAP / 2 + 0.25 + i * ((Math.PI * 2 - GAP - 0.5) / (N - 1));
      o.position.set((ROOM_R - 0.15) * Math.sin(th), WALL_H / 2, (ROOM_R - 0.15) * Math.cos(th)); o.rotation.set(0, th, 0); o.updateMatrix();
      pm.setMatrixAt(i, o.matrix);
    }
    scene.add(pm);
    const ringGeo = new THREE.TorusGeometry(ROOM_R - 0.25, 0.08, 6, 120, Math.PI * 2 - GAP - 0.1); ringGeo.rotateZ(Math.PI * 1.5 + GAP / 2 + 0.05); ringGeo.rotateX(Math.PI / 2);
    for (const y of [3.75, 7.5]) { const r = new THREE.Mesh(ringGeo, goldMat); r.position.y = y; scene.add(r); }
  }
  const winTex = pixelTex(windowCanvas()); winTex.wrapS = winTex.wrapT = THREE.ClampToEdgeWrapping;
  const winW = GAP * ROOM_R + 0.25;
  const win = new THREE.Mesh(new THREE.PlaneGeometry(winW, WALL_H), new THREE.MeshStandardMaterial({ map: winTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85 }));
  win.position.set(0, WALL_H / 2, -ROOM_R + 0.05);
  scene.add(win);
  const sill = new THREE.Mesh(new THREE.BoxGeometry(winW + 0.3, 0.14, 0.7), stoneMat);
  sill.position.set(0, 0.62, -ROOM_R + 0.25);
  scene.add(sill);
  const skyMat = new THREE.ShaderMaterial({
    uniforms: { uTime: H.shared.uTime },
    vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uTime; varying vec2 vUv;
      float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(h2(i), h2(i+vec2(1,0)), f.x), mix(h2(i+vec2(0,1)), h2(i+vec2(1,1)), f.x), f.y); }
      float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a*vn(p); p *= 2.07; a *= 0.5; } return s; }
      void main(){
        // 窗外只有一轮满月：深蓝夜空 + 月面 + 一圈月晕，别的都不要
        vec2 uv = vUv; vec2 p = vec2((uv.x - 0.5)*1.66, uv.y);
        vec2 mc = vec2(0.07, 0.428); float mr = 0.066;   // 月晕跟着 3D 月球在镜头里的位置
        vec3 col = mix(vec3(0.03,0.08,0.14), vec3(0.008,0.02,0.05), smoothstep(0.1, 1.0, uv.y));
        float d = length(p - mc);
        col += vec3(0.3,0.5,0.6) * exp(-pow(max(d - mr, 0.0)*12.0, 1.3)) * 0.22;
        col += vec3(0.1,0.18,0.26) * exp(-d*4.0) * 0.25;
        gl_FragColor = vec4(col, 1.0);
      }`,
    fog: false, depthWrite: false,
  });
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(40, 24), skyMat);
  sky.position.set(0, 7, -18);
  scene.add(sky);

  // 满月：一颗通透发光的「辉石月」。月面淡蓝白、自发光为主，月海是半透明的浅蓝影；
  // 表面一层晶体裂面（Voronoi 棱线）+ 闪烁的星点，边缘一圈更亮的冷光（像光从球里透出来），
  // 外面一圈慢慢绕转的发光碎片和两道点线符文环
  const MOON_POS = new V3(1.34, 5.0, -16), MOON_R = 1.45;
  const moonMat = new THREE.ShaderMaterial({
    uniforms: { uTime: H.shared.uTime },
    vertexShader: /* glsl */`varying vec3 vObj; varying vec3 vViewPos; varying vec3 vViewN;
      void main(){ vObj = normalize(position); vec4 mv = modelViewMatrix*vec4(position,1.0); vViewPos = mv.xyz; vViewN = normalize(normalMatrix*normal); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: /* glsl */`
      uniform float uTime; varying vec3 vObj; varying vec3 vViewPos; varying vec3 vViewN;
      float h3(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7)))*43758.5453); }
      vec3 h33(vec3 p){ return fract(sin(vec3(dot(p,vec3(127.1,311.7,74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6))))*43758.5453); }
      float vn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(mix(h3(i), h3(i+vec3(1,0,0)), f.x), mix(h3(i+vec3(0,1,0)), h3(i+vec3(1,1,0)), f.x), f.y),
                   mix(mix(h3(i+vec3(0,0,1)), h3(i+vec3(1,0,1)), f.x), mix(h3(i+vec3(0,1,1)), h3(i+vec3(1,1,1)), f.x), f.y), f.z); }
      float fbm(vec3 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a*vn(p); p *= 2.03; a *= 0.5; } return s; }
      vec2 vor(vec3 p){ vec3 i = floor(p), f = fract(p); float d1 = 9.0, d2 = 9.0;
        for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++){
          vec3 o = vec3(x,y,z); float d = length(o + h33(i + o) - f);
          if (d < d1){ d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
        return vec2(d1, d2); }
      void main(){
        vec3 n = normalize(vViewN), v = normalize(-vViewPos);
        float ndv = max(dot(n, v), 0.0);
        float maria = smoothstep(0.42, 0.66, fbm(vObj*1.6 + vec3(3.1, 0.7, 5.2)));
        float fine = fbm(vObj*7.0);
        vec2 c = vor(vObj*3.2);
        float facet = 1.0 - smoothstep(0.0, 0.07, c.y - c.x);          // 晶体裂面的棱线
        vec2 c2 = vor(vObj*9.0);
        float facet2 = 1.0 - smoothstep(0.0, 0.05, c2.y - c2.x);
        vec3 base = mix(vec3(0.9,0.96,1.06), vec3(0.42,0.58,0.9), maria*0.9) * (0.88 + 0.14*fine);
        vec3 col = base * (0.62 + 0.38*ndv);                            // 自发光为主，中心略亮
        col += vec3(0.75,0.9,1.2) * (facet*0.18 + facet2*0.07) * (0.6 + 0.4*ndv);
        col += vec3(0.45,0.72,1.3) * pow(1.0 - ndv, 2.2) * 1.25;       // 透出来的边缘冷光
        vec3 cell = floor(vObj*70.0);
        float tw = pow(h3(cell), 30.0) * (0.5 + 0.5*sin(uTime*(1.5 + 3.0*h3(cell + 7.0)) + h3(cell)*40.0));
        col += vec3(0.9,0.97,1.2) * tw * 1.4;                           // 闪烁的星点
        gl_FragColor = vec4(col * 0.8, 1.0);
      }`,
    fog: false,
  });
  const moonBall = new THREE.Mesh(new THREE.SphereGeometry(MOON_R, 96, 64), moonMat);
  moonBall.position.copy(MOON_POS); moonBall.rotation.set(0.3, -0.6, 0.1); scene.add(moonBall);
  const moonFacing = new V3(-2.2, 2.2, 4.5).sub(MOON_POS).normalize();     // 朝着待机镜头
  {
    const g = halo([0.11, 0.21, 0.43], MOON_R * 5.2, 1); g.material.fog = false;   // 月亮是光源不是主角：光晕减半
    g.position.copy(MOON_POS).addScaledVector(moonFacing, -1.6); scene.add(g);
    // 两道点线符文环（面向镜头，慢慢反向转）
    const ringMat = (r0, r1, n, sp) => new THREE.ShaderMaterial({
      uniforms: { uTime: H.shared.uTime, uAwake },
      vertexShader: /* glsl */`varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: /* glsl */`uniform float uTime, uAwake; varying vec2 vP;
        void main(){
          float r = length(vP), a = atan(vP.y, vP.x) + uTime*${sp.toFixed(3)};
          float band = (1.0 - smoothstep(0.0, 0.03, abs(r - ${((r0 + r1) / 2).toFixed(3)})));
          float dots = step(0.55, fract(a*${n.toFixed(1)}/6.2832));
          float tick = step(0.93, fract(a*${(n / 6).toFixed(1)}/6.2832)) * (1.0 - smoothstep(0.0, 0.09, abs(r - ${((r0 + r1) / 2).toFixed(3)})));
          float al = (band*dots*0.5 + tick*0.6) * (0.75 + 0.25*sin(uTime*1.3 + a*3.0));
          gl_FragColor = vec4(vec3(0.5,0.75,1.3)*al*0.6*mix(0.06, 1.0, uAwake), 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    for (const [r0, r1, n, sp] of [[1.86, 1.94, 120, 0.04], [2.42, 2.5, 180, -0.025]]) {
      const m = new THREE.Mesh(new THREE.RingGeometry(r0 - 0.15, r1 + 0.15, 128, 1), ringMat(r0, r1, n, sp));
      m.position.copy(MOON_POS).addScaledVector(moonFacing, -0.3); m.lookAt(m.position.clone().add(moonFacing)); scene.add(m);
    }
    // 绕着月亮慢慢转的发光碎片（亮点 + 菱形晶片）
    const u1 = new V3().crossVectors(moonFacing, new V3(0, 1, 0)).normalize(), u2 = new V3().crossVectors(u1, moonFacing).normalize();
    for (const shard of [false, true]) {
      const N = shard ? 60 : 240, a = new Float32Array(N), r = new Float32Array(N), rr = new Float32Array(N);
      for (let k = 0; k < N; k++) { a[k] = Math.random() * 6.283; r[k] = MOON_R * (1.08 + Math.random() ** 1.6 * 1.1); rr[k] = Math.random(); }
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      g2.setAttribute('aA', new THREE.BufferAttribute(a, 1)); g2.setAttribute('aR', new THREE.BufferAttribute(r, 1)); g2.setAttribute('aRand', new THREE.BufferAttribute(rr, 1));
      const pts = new THREE.Points(g2, pointsMaterial(COMMON_GLSL + /* glsl */`
        attribute float aA, aR, aRand; uniform vec3 uC, uU1, uU2, uF; uniform float uAwake;
        varying vec3 vColor; varying float vAlpha; varying float vRot;
        void main(){
          float ang = aA + uTime*(0.03 + 0.05*aRand)*(aRand > 0.5 ? 1.0 : -1.0);
          vec3 p = uC + (uU1*cos(ang) + uU2*sin(ang))*aR + uF*(aRand - 0.5)*0.8;
          vec4 mv = viewMatrix*vec4(p,1.0);
          gl_Position = projectionMatrix*mv;
          float tw = 0.4 + 0.6*pow(0.5 + 0.5*sin(uTime*(1.0 + 2.5*aRand) + aRand*60.0), 3.0);
          vColor = mix(vec3(0.5,0.78,1.3), vec3(0.9,0.97,1.2), aRand) * 1.3 * mix(0.08, 1.0, uAwake);
          vAlpha = tw * (1.0 - smoothstep(${(MOON_R * 1.6).toFixed(2)}, ${(MOON_R * 2.3).toFixed(2)}, aR)*0.6);
          vRot = aRand*20.0 + uTime*(0.3 + aRand);
          gl_PointSize = pxSize(${shard ? '0.16 + 0.12*aRand' : '0.05 + 0.06*aRand'}, -mv.z);
        }`, shard ? SHARD_FRAG : undefined, { uC: { value: MOON_POS }, uU1: { value: u1 }, uU2: { value: u2 }, uF: { value: moonFacing }, uAwake }));
      pts.frustumCulled = false; scene.add(pts);
    }
  }

  /* ================================================================
   * 小物件工厂（蜡烛、结晶、书本最后统一收进 InstancedMesh）
   * ================================================================ */
  const candles = [];
  function addCandle(x, y, z, h = 0.2, r = 0.035, lit = null) { candles.push({ x, y, z, h, r, lit }); }
  const crystals = [], glintSites = [];
  function addCluster(x, y, z, size = 1, n = 7) {
    glintSites.push(new V3(x, y + 0.15 * size, z));
    for (let i = 0; i < n; i++) {
      const a = R(0, Math.PI * 2), tilt = i === 0 ? R(0, 0.12) : R(0.25, 0.8), h = R(0.5, 1.0) * size * 0.5 * (i === 0 ? 1.4 : 1);
      const off = i ? 0.05 * size : 0;
      crystals.push({ p: new V3(x + Math.cos(a) * off, y, z + Math.sin(a) * off), a, tilt, h, w: h * R(0.16, 0.26) });
    }
  }
  const books = [];
  function addPile(x, y, z, n, rot = R(0, 6)) {
    let hh = 0;
    for (let i = 0; i < n; i++) {
      const bh = R(0.05, 0.1);
      books.push({ x: x + R(-0.03, 0.03), y: y + hh + bh / 2, z: z + R(-0.03, 0.03), w: R(0.3, 0.46), d: R(0.22, 0.34), h: bh, rot: rot + R(-0.35, 0.35), col: new THREE.Color(BOOK_COLORS[Math.floor(rnd() * BOOK_COLORS.length)]) });
      hh += bh;
    }
    return y + hh;
  }
  // 一簇书山：中间一两摞高的，四周几摞矮的，再散几本斜靠 / 平躺的
  function addHeap(x, y, z, size = 1) {
    const base = R(0, 6);
    let top = y;
    const stacks = 2 + Math.floor(R(0, 4) * size);
    for (let s = 0; s < stacks; s++) {
      const a = base + s * 2.1 + R(-0.4, 0.4), d = s === 0 ? 0 : R(0.2, 0.36) * (0.7 + 0.3 * size);
      const n = s === 0 ? Math.max(2, Math.round(R(3, 9) * size)) : 1 + Math.floor(R(0, 5) * size);
      const t = addPile(x + Math.cos(a) * d, y, z + Math.sin(a) * d, n, base + R(-0.6, 0.6));
      if (s === 0) top = t;
    }
    for (let k = 0, m = Math.floor(R(1, 4)); k < m; k++) {        // 斜靠在书堆边上的
      const a = R(0, 6.28), d = R(0.3, 0.48) * (0.8 + 0.2 * size), bh = R(0.05, 0.08), w = R(0.3, 0.42);
      books.push({ x: x + Math.cos(a) * d, y: y + w * 0.42, z: z + Math.sin(a) * d, w, d: R(0.22, 0.3), h: bh, rot: a + Math.PI / 2,
        tz: R(1.0, 1.35) * (rnd() < 0.5 ? 1 : -1), col: new THREE.Color(BOOK_COLORS[Math.floor(rnd() * BOOK_COLORS.length)]) });
    }
    if (rnd() < 0.35) books.push({ x: x + R(-0.5, 0.5), y: y + 0.03, z: z + R(-0.5, 0.5), w: R(0.3, 0.4), d: R(0.22, 0.3), h: 0.05, rot: R(0, 6), tx: R(-0.15, 0.15),
      col: new THREE.Color(BOOK_COLORS[Math.floor(rnd() * BOOK_COLORS.length)]) });
    return top;
  }
  function addKey(x, y, z, rot, s = 1) {
    const k = new THREE.Group();
    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.008, 6, 14), goldMat); bow.rotation.x = Math.PI / 2; k.add(bow);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.14, 6), goldMat); shaft.rotation.z = Math.PI / 2; shaft.position.x = 0.1; k.add(shaft);
    for (const [bx, bz] of [[0.15, 0.012], [0.165, 0.012], [0.165, 0.022]]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.006, 0.014), goldMat); b.position.set(bx, 0, bz); k.add(b); }
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.012), glint); k.add(gem);
    k.position.set(x, y, z); k.rotation.y = rot; k.scale.setScalar(s);
    scene.add(k);
  }
  let shieldMat = null;
  const glowLights = [];
  function addChest(x, z, rot, s = 1) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot; g.scale.setScalar(s); scene.add(g);
    const W = 0.9, D = 0.55, Hb = 0.42;
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, Hb, D), darkWood); body.position.y = Hb / 2; g.add(body);
    for (const xx of [-W / 2 + 0.05, -0.15, 0.15, W / 2 - 0.05]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.05, Hb + 0.01, D + 0.02), goldMat); b.position.set(xx, Hb / 2, 0); g.add(b); }
    const lock = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.03), goldMat); lock.position.set(0, Hb - 0.08, D / 2 + 0.01); g.add(lock);
    const hinge = new THREE.Group(); hinge.position.set(0, Hb, -D / 2); hinge.rotation.x = -1.05; g.add(hinge);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(D / 2, D / 2, W, 16, 1, false, 0, Math.PI), darkWood); lid.rotation.set(0, 0, Math.PI / 2); lid.position.z = D / 2; hinge.add(lid);
    const inner = new THREE.Mesh(new THREE.BoxGeometry(W - 0.08, 0.02, D - 0.08), glowBasic(0.6, 1.4, 2.6)); inner.position.y = Hb - 0.03; g.add(inner);
    g.updateMatrixWorld(true);
    const c0 = g.localToWorld(new V3(0, Hb - 0.02, 0));
    addCluster(c0.x - 0.15 * s, c0.y, c0.z, 0.55 * s, 6); addCluster(c0.x + 0.18 * s, c0.y, c0.z + 0.05, 0.45 * s, 5);
    const l = new THREE.PointLight(0x5aa8ff, 0.9 * s, 0, 2); l.position.copy(c0).add(new V3(0, 0.3, 0)); scene.add(l); glowLights.push(l);
    const h = halo([0.25, 0.55, 1.1], 0.7 * s); h.position.copy(c0).add(new V3(0, 0.1, 0)); scene.add(h);
  }
  function addCasket(x, y, z, rot) {
    const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = rot; scene.add(g);
    const m = new THREE.MeshStandardMaterial({ color: 0x4a1a3a, roughness: 0.5 });
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 0.15), m); b.position.y = 0.05; g.add(b);
    const e = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.015, 0.16), goldMat); e.position.y = 0.1; g.add(e);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.15), m); lid.position.set(0, 0.16, -0.06); lid.rotation.x = -0.9; g.add(lid);
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.03), glint); gem.position.set(0, 0.12, 0); gem.scale.y = 1.6; g.add(gem);
  }
  function addCandelabra(x, z, height = 1.6, arms = 5, y = 0) {
    const g = new THREE.Group(); g.position.set(x, y, z); scene.add(g);
    const stem = new THREE.Mesh(new THREE.LatheGeometry([[0.16, 0], [0.12, 0.04], [0.04, 0.1], [0.03, height * 0.4], [0.06, height * 0.45], [0.025, height * 0.5], [0.025, height * 0.9], [0.05, height * 0.92]].map(([r, h]) => new THREE.Vector2(r * Math.min(1, height), h)), 10), goldMat);
    g.add(stem);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(height * 0.16, 0.012, 6, 30), goldMat); ring.rotation.x = Math.PI / 2; ring.position.y = height * 0.9; g.add(ring);
    for (let i = 0; i < arms; i++) {
      const a = i / arms * Math.PI * 2, rr = height * 0.16;
      const px = Math.cos(a) * rr, pz = Math.sin(a) * rr;
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.025, 0.03, 8), goldMat); cup.position.set(px, height * 0.92, pz); g.add(cup);
      addCandle(x + px, y + height * 0.935, z + pz, R(0.12, 0.26), 0.026);
    }
    addCandle(x, y + height * 0.95, z, 0.3, 0.03);
    if (height > 1.0) { const l = new THREE.PointLight(0xffa050, 0.8, 0, 2); l.position.set(x, y + height + 0.4, z); scene.add(l); glowLights.push(l); }
  }
  const orbMats = [];
  function addCrystalBall(x, y, z, r = 0.14) {
    const g = new THREE.Group(); g.position.set(x, y, z); scene.add(g);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.5, r * 0.85, r * 0.5, 10), darkGold); base.position.y = r * 0.25; g.add(base);
    for (let i = 0; i < 3; i++) { const cl = new THREE.Mesh(new THREE.BoxGeometry(0.015, r * 0.7, 0.015), goldMat); const a = i / 3 * Math.PI * 2; cl.position.set(Math.cos(a) * r * 0.6, r * 0.7, Math.sin(a) * r * 0.6); cl.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5); g.add(cl); }
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: H.shared.uTime, uPow: { value: 0.3 } },
      vertexShader: /* glsl */`varying vec3 vP; varying vec3 vN; varying vec3 vV; void main(){ vP = position; vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: NOISE_GLSL + /* glsl */`
        uniform float uTime, uPow; varying vec3 vP; varying vec3 vN; varying vec3 vV;
        void main(){
          float fres = pow(1.0 - clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0), 2.0);
          float sw = snoise(vP*14.0 + vec3(0.0, uTime*0.6, uTime*0.3));
          float core = smoothstep(0.1, 0.9, sw*0.5 + 0.5);
          vec3 col = vec3(0.12,0.3,0.6)*0.25*(0.4 + 0.6*min(uPow, 1.0)) + vec3(0.3,0.6,1.1)*core*(0.06 + uPow*0.99) + vec3(0.6,0.8,1.0)*fres*0.4*(0.3 + 0.7*min(uPow, 1.0));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    orbMats.push(m);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 18), m); ball.position.y = r * 1.45; g.add(ball);
    const h = halo([0.08, 0.18, 0.36], r * 2.6); h.position.y = r * 1.45; g.add(h);
    return new V3(x, y + r * 1.45, z);
  }
  const runeTex = new THREE.CanvasTexture(circleRuneCanvas()); runeTex.magFilter = THREE.NearestFilter;
  const floatStones = [];
  function addMagicStones(center, n, radius) {
    for (let i = 0; i < n; i++) {
      const st = new THREE.Mesh(new THREE.DodecahedronGeometry(R(0.06, 0.11)), new THREE.MeshStandardMaterial({ color: 0x3a3e52, roughness: 0.8, flatShading: true, emissive: 0x1a3a8a, emissiveIntensity: 0.25 }));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.005, 4, 24), glowBasic(0.12, 0.3, 0.6));
      scene.add(st, ring);
      floatStones.push({ st, ring, center, radius: radius * R(0.8, 1.2), a: i / n * Math.PI * 2, h: R(-0.15, 0.35), sp: R(0.2, 0.4) * (i % 2 ? 1 : -1) });
    }
  }
  function addBust(x, z, rot) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot; scene.add(g);
    const col = new THREE.Mesh(new THREE.LatheGeometry([[0.26, 0], [0.26, 0.08], [0.18, 0.12], [0.14, 0.2], [0.14, 0.95], [0.2, 1.0], [0.22, 1.06]].map(([r, h]) => new THREE.Vector2(r, h)), 10), marbleMat); g.add(col);
    const sh = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10), marbleMat); sh.scale.set(1.2, 0.55, 0.7); sh.position.y = 1.2; g.add(sh);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.12, 10), marbleMat); neck.position.y = 1.35; g.add(neck);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 10), marbleMat); head.scale.set(0.9, 1.1, 1); head.position.y = 1.5; g.add(head);
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.32, 12, 1, true), marbleMat); hood.position.y = 1.6; g.add(hood);
    const eyes = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.012, 0.02), glowBasic(0.6, 1.6, 3)); eyes.position.set(0, 1.51, 0.1); g.add(eyes);
  }
  function addAstrolabe(x, y, z, rot, s = 1) {
    const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = rot; g.scale.setScalar(s); scene.add(g);
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.1, 0.5, 8), darkGold); stand.position.y = 0.25; g.add(stand);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.32, 40), new THREE.MeshBasicMaterial({ map: runeTex, color: new THREE.Color(1.3, 1.1, 0.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    disc.position.y = 0.82; g.add(disc);
    sleepers.push({ c: disc.material.color, base: disc.material.color.clone(), sleep: 0.15 });   // 星盘的符文盘也睡着
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.02, 6, 40), goldMat); rim.position.y = 0.82; g.add(rim);
    const rim2 = rim.clone(); rim2.scale.setScalar(0.75); rim2.rotation.y = Math.PI / 2; g.add(rim2);
    g.userData.spin = [disc, rim2];
    return g;
  }

  /* ---------------- 书桌（高度和位置跟骑士的手对齐） ---------------- */
  const desk = new THREE.Group();
  desk.position.set(DESK_X, 0, 0);
  scene.add(desk);
  const DESK_MODEL = H.deskModel;          // Blender 建的书桌一角（pipeline/build_desk.py）；没有就用下面代码拼的旧版
  if (!DESK_MODEL) {
    const V2 = (arr) => arr.map(([r, y]) => new THREE.Vector2(r, y));
    const add = (m, x, y, z, p = desk) => { m.position.set(x, y, z); p.add(m); return m; };
    const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    const leather = new THREE.MeshStandardMaterial({ color: 0x2a3a2c, roughness: 0.85 });
    const velvet = new THREE.MeshStandardMaterial({ color: 0x5a1626, roughness: 0.95 });
    // 桌面：厚木板 + 两层线脚 + 金色嵌线框 + 皮面写字垫
    add(box(1.1, 0.06, 2.3, woodMat), 0, TOP - 0.03, 0);
    add(box(1.16, 0.025, 2.36, goldMat), 0, TOP - 0.07, 0);
    add(box(1.12, 0.035, 2.32, darkWood), 0, TOP - 0.1, 0);
    for (const [w, d, x, z] of [[0.96, 0.012, 0, -1.08], [0.96, 0.012, 0, 1.08], [0.012, 2.16, -0.48, 0], [0.012, 2.16, 0.48, 0]]) add(box(w, 0.004, d, goldMat), x, TOP + 0.001, z);
    add(box(0.62, 0.004, 0.9, leather), BOOK_X - DESK_X + 0.04, TOP + 0.001, 0);
    for (const [x, z] of [[-0.27, -0.45], [-0.27, 0.45], [0.35, -0.45], [0.35, 0.45]]) add(new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.006, 8), goldMat), BOOK_X - DESK_X + 0.04 + x * 0.88, TOP + 0.004, z);
    // 桌裙：四面围板 + 骑士这一面三个抽屉（金拉环、锁眼）
    add(box(0.04, 0.16, 2.06, darkWood), -0.5, TOP - 0.2, 0);
    add(box(0.04, 0.16, 2.06, darkWood), 0.5, TOP - 0.2, 0);
    for (const z of [-1.03, 1.03]) add(box(0.96, 0.16, 0.04, darkWood), 0, TOP - 0.2, z);
    for (const z of [-0.66, 0, 0.66]) {
      add(box(0.012, 0.11, 0.56, woodMat), -0.525, TOP - 0.2, z);
      add(box(0.008, 0.012, 0.5, goldMat), -0.533, TOP - 0.15, z);
      const ring = add(new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.005, 6, 14), goldMat), -0.54, TOP - 0.21, z); ring.rotation.y = Math.PI / 2;
      add(new THREE.Mesh(new THREE.SphereGeometry(0.01, 8, 6), goldMat), -0.535, TOP - 0.19, z);
    }
    // 桌腿：车削柱身 + 金色柱头 + 金球爪足；角上金色卷草托
    const legGeo = new THREE.LatheGeometry(V2([[0.055, 0.05], [0.07, 0.08], [0.04, 0.16], [0.05, 0.22], [0.032, 0.3], [0.055, 0.4], [0.06, 0.44], [0.035, 0.5], [0.04, TOP - 0.3], [0.062, TOP - 0.27], [0.062, TOP - 0.12]]), 12);
    const capGeo = new THREE.TorusGeometry(0.05, 0.012, 6, 16).rotateX(Math.PI / 2);
    for (const [x, z] of [[-0.46, -1.0], [0.46, -1.0], [-0.46, 1.0], [0.46, 1.0]]) {
      add(new THREE.Mesh(legGeo, darkWood), x, 0, z);
      add(new THREE.Mesh(capGeo, goldMat), x, TOP - 0.28, z);
      add(new THREE.Mesh(capGeo, goldMat), x, 0.42, z);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), goldMat), x, 0.04, z);
      for (const s of [-1, 1]) {
        const br = add(new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.01, 5, 12, Math.PI * 0.75), goldMat), x, TOP - 0.36, z + s * (z > 0 ? -0.07 : 0.07));
        br.rotation.set(0, Math.PI / 2, s > 0 ? 0.4 : 2.0);
      }
    }
    // H 形横撑 + 中间的金色宝珠
    for (const z of [-1.0, 1.0]) add(box(0.9, 0.04, 0.04, darkWood), 0, 0.2, z);
    add(box(0.04, 0.04, 2.0, darkWood), 0, 0.2, 0);
    add(new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), goldMat), 0, 0.25, 0);
    add(new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.1, 8), goldMat), 0, 0.33, 0);

    // 扶手椅（矮靠背：靠背被骑士的披风盖住，扶手在两侧露出来）
    const seat = new THREE.Group(); seat.position.copy(KNIGHT_POS); scene.add(seat);
    const SH = 0.47;
    const chairWood = woodMat;
    add(box(0.56, 0.06, 0.56, chairWood), 0, SH - 0.03, 0, seat);
    add(box(0.58, 0.018, 0.58, goldMat), 0, SH - 0.065, 0, seat);
    const cush = add(new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.06, 4, 1), velvet), 0, SH + 0.03, 0, seat); cush.rotation.y = Math.PI / 4; cush.scale.set(0.98, 1, 0.98);
    for (const [x, z] of [[-0.1, -0.1], [0.1, -0.1], [-0.1, 0.1], [0.1, 0.1], [0, 0]]) add(new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 4), goldMat), x, SH + 0.062, z, seat);
    const cLeg = new THREE.LatheGeometry(V2([[0.03, 0.03], [0.042, 0.06], [0.025, 0.14], [0.035, 0.24], [0.022, 0.34], [0.034, SH - 0.06]]), 10);
    for (const [x, z] of [[-0.24, -0.24], [0.24, -0.24], [-0.24, 0.24], [0.24, 0.24]]) {
      add(new THREE.Mesh(cLeg, chairWood), x, 0, z, seat);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), goldMat), x, 0.03, z, seat);
    }
    // 靠背：两根车削立柱 + 软包 + 拱形顶冠 + 金色尖顶
    const post = new THREE.LatheGeometry(V2([[0.032, 0], [0.026, 0.12], [0.034, 0.2], [0.022, 0.4], [0.03, 0.5]]), 10);
    for (const z of [-0.24, 0.24]) {
      add(new THREE.Mesh(post, chairWood), -0.25, SH, z, seat);
      add(new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.09, 8), goldMat), -0.25, SH + 0.55, z, seat);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), goldMat), -0.25, SH + 0.5, z, seat);
    }
    add(box(0.04, 0.3, 0.44, velvet), -0.26, SH + 0.24, 0, seat);
    const crest = add(new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.022, 6, 24, Math.PI), darkWood), -0.25, SH + 0.38, 0, seat); crest.rotation.y = Math.PI / 2; crest.scale.set(1, 0.45, 1);
    const crestG = add(new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.007, 4, 24, Math.PI), goldMat), -0.232, SH + 0.38, 0, seat); crestG.rotation.y = Math.PI / 2; crestG.scale.set(1, 0.45, 1);
    // 扶手：从靠背伸到前腿，前端金色卷头
    for (const z of [-0.27, 0.27]) {
      add(box(0.46, 0.035, 0.06, chairWood), -0.02, SH + 0.24, z, seat);
      add(box(0.46, 0.008, 0.064, goldMat), -0.02, SH + 0.262, z, seat);
      add(new THREE.Mesh(new THREE.LatheGeometry(V2([[0.022, 0], [0.03, 0.06], [0.018, 0.14], [0.026, 0.24]]), 8), darkWood), 0.2, SH - 0.01, z, seat);
      const sc = add(new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.011, 6, 12, Math.PI * 1.5), goldMat), 0.22, SH + 0.24, z, seat); sc.rotation.set(0, 0, Math.PI * 0.25);
    }
  }

  /* ---------------- Blender 书桌一角：跟骑士同一套调色板、同一种打光规矩 ----------------
   * GLB 里每块的材质名是 pal_<色阶>_<基准档>。three.js 先按场景里真实的灯（月光、烛光、阴影）算一遍，
   * 再看「亮了多少倍」，只在这条色阶里上下挪档（骑士精灵也是这么打光的），颜色永远落在调色板里；
   * 外面再套一圈往外推的暗色背面壳当描边。同材质的零件合成一个网格，省 draw call。 */
  const STUDY_RAMPS = {   // 和 pipeline/build_desk.py 的 RAMPS 一致
    wood: ['#1c110b', '#382114', '#583520', '#7c5230', '#a47648'],
    gold: ['#4a3520', '#80633b', '#b18a52', '#d5b579', '#f2e2b4'],
    leather: ['#14140e', '#22281c', '#34402a', '#4e5c3a', '#6e7c50'],
    crimson: ['#2a0b16', '#421323', '#681a32', '#8c3450', '#b25a74'],
    navy: ['#0a0f1a', '#101725', '#19243a', '#2a3650', '#43527a'],
    page: ['#5a4a36', '#9c8664', '#d2c098', '#efe4c8', '#fffaf0'],
    ink: ['#0c0a18', '#18142c', '#262242', '#363258', '#46426c'],
    gem: ['#0a1636', '#142b5c', '#2856a0', '#6b91d3', '#cfe0ff'],
  };
  const palMats = new Map();
  function paletteMat(ramp, base) {
    const key = `${ramp}_${base}`;
    if (palMats.has(key)) return palMats.get(key);
    const cols = STUDY_RAMPS[ramp].map((h) => new THREE.Color(h));
    const m = new THREE.MeshStandardMaterial({ color: cols[base], roughness: ramp === 'gold' ? 0.4 : 0.85, metalness: 0 });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uRamp = { value: cols.map((c) => new V3(c.r, c.g, c.b)) };
      sh.uniforms.uBase = { value: base };
      sh.uniforms.uBands = { value: new THREE.Vector4(0.1, 0.3, 0.75, 1.7) };
      sh.fragmentShader = 'uniform vec3 uRamp[5]; uniform float uBase; uniform vec4 uBands;\n' + sh.fragmentShader.replace('#include <opaque_fragment>', /* glsl */`
        {
          // 亮了多少倍 → 在色阶里挪几档；保留一点灯的颜色（月光偏冷、烛光偏暖）
          float lumA = max(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
          float lumO = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
          float k = lumO / lumA;
          float off = k < uBands.x ? -2.0 : k < uBands.y ? -1.0 : k < uBands.z ? 0.0 : k < uBands.w ? 1.0 : 2.0;
          int idx = int(clamp(uBase + off, 0.0, 4.0));
          vec3 pal = uRamp[0];
          for (int i = 1; i < 5; i++) if (i == idx) pal = uRamp[i];
          vec3 hue = clamp(outgoingLight / max(lumO, 1e-4), 0.0, 2.5);
          outgoingLight = pal * mix(vec3(1.0), hue, 0.3) * (k > 2.6 ? 1.0 + (k - 2.6) * 0.12 : 1.0);
        }
        #include <opaque_fragment>`);
    };
    palMats.set(key, m);
    return m;
  }
  const outlineMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(STUDY_RAMPS.ink[0]), side: THREE.BackSide });
  outlineMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n transformed += normal * 0.0055;');
  };
  if (DESK_MODEL) {
    const { GLTFLoader, mergeVertices, mergeGeometries } = DESK_MODEL;
    // 屏保主题在沙盒里不能 fetch（连 data: 地址也不行）：给了 data（GLB 的字节）就直接解析，否则按 url 加载
    const onDesk = (gltf) => {
      gltf.scene.updateMatrixWorld(true);
      for (const rootName of ['Desk', 'Chair']) {
        const root = gltf.scene.getObjectByName(rootName);
        const byMat = new Map(), all = [];
        root.traverse((o) => {
          if (!o.isMesh) return;
          const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
          for (const a of Object.keys(g.attributes)) if (a !== 'position' && a !== 'normal') g.deleteAttribute(a);
          const name = o.material.name;
          if (!byMat.has(name)) byMat.set(name, []);
          byMat.get(name).push(g);
          const h = new THREE.BufferGeometry(); h.setAttribute('position', g.getAttribute('position')); if (g.index) h.setIndex(g.index);
          all.push(h);
        });
        for (const [name, geos] of byMat) {
          const [, ramp, step] = name.match(/^pal_([a-z]+)_(\d)$/) ?? [];
          if (!ramp) continue;
          const m = new THREE.Mesh(mergeGeometries(geos), paletteMat(ramp, +step));
          m.castShadow = m.receiveShadow = true;
          scene.add(m);
        }
        // 描边：位置焊在一起再算平滑法线，背面壳沿法线往外推一点
        const hull = mergeVertices(mergeGeometries(all), 1e-4);
        hull.computeVertexNormals();
        const ol = new THREE.Mesh(hull, outlineMat);
        scene.add(ol);
      }
    };
    const loader = new GLTFLoader();
    if (DESK_MODEL.data) loader.parse(DESK_MODEL.data.buffer.slice(DESK_MODEL.data.byteOffset, DESK_MODEL.data.byteOffset + DESK_MODEL.data.byteLength), '', onDesk, (e) => console.error('[desk]', e));
    else loader.load(DESK_MODEL.url, onDesk);
  }

  /* ---------------- 主角：坐着读书的骑士 ---------------- */
  const knight = makeKnightMesh('sit');
  knight.position.copy(KNIGHT_POS);
  knight.material.uniforms.uFogColor.value.copy(scene.fog.color);
  // 坐姿精灵带逐像素深度（腿在桌下、手在书上、背靠椅背），只留一点点余量防止贴面闪烁
  knight.material.uniforms.uDepthPull.value = 0.03;
  knight.material.uniforms.uClampY.value = TOP + 0.015;   // 桌面 + 写字垫和金线的厚度
  scene.add(knight);
  const KNIGHT_FACING = new V3(1, 0, 0);
  // 主角托出来（圣经 §1.1）：身后一圈安静区；轮廓光从长窗来（见 update 里的 setKnightRim）
  const knightQuiet = makeQuietZone(3.0, 3.0, 0.55);
  scene.add(knightQuiet);
  const KNIGHT_CENTER = KNIGHT_POS.clone().add(new V3(0, 0.8, 0));

  /* ---------------- 主角书：摊在骑士手下，会翻页 ---------------- */
  const pageTex = pixelTex(makePageCanvas()); pageTex.wrapS = pageTex.wrapT = THREE.ClampToEdgeWrapping;
  const coverTex = pixelTex(makeCoverCanvas()); coverTex.wrapS = coverTex.wrapT = THREE.ClampToEdgeWrapping;
  const pageMat = new THREE.MeshStandardMaterial({ map: pageTex, color: 0xcfc4ae, roughness: 0.9, emissive: 0xffe6b0, emissiveIntensity: 0.05, side: THREE.DoubleSide });
  const book = new THREE.Group();
  book.position.set(BOOK_X - DESK_X, TOP + 0.005, 0);
  desk.add(book);
  {
    const cm = new THREE.MeshStandardMaterial({ map: coverTex, color: new THREE.Color('#2a3a7a'), roughness: 0.6 });
    for (const sgn of [-1, 1]) {
      const cov = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.016, 0.33), cm); cov.position.set(0, 0, sgn * 0.168); cov.rotation.x = sgn * 0.06; book.add(cov);
      const blk = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.035, 0.3), pageMat); blk.position.set(0, 0.024, sgn * 0.155); blk.rotation.x = sgn * 0.08; book.add(blk);
    }
    const spine = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.46, 8).rotateZ(Math.PI / 2), cm); spine.position.y = 0.01; book.add(spine);
    const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(0.012, 0.22), new THREE.MeshStandardMaterial({ color: 0xa82a3a, side: THREE.DoubleSide })); ribbon.position.set(0.28, 0.0, 0.02); ribbon.rotation.set(-Math.PI / 2, 0, 0.3); book.add(ribbon);
  }
  // 翻动的那一页：从书脊（x 轴）伸到页边的一条纸，绕书脊往上翻（不是往桌子里转），边翻边弯：
  // 页边先起、后落，像被手捏着角带过去。phi 0 = 平躺在右边，1 = 平躺在左边
  const PAGE_W = 0.29, PAGE_L = 0.42, PAGE_SEG = 10;
  function makePageGeo() {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array((PAGE_SEG + 1) * 2 * 3), uv = new Float32Array((PAGE_SEG + 1) * 2 * 2), idx = [];
    for (let i = 0; i <= PAGE_SEG; i++) {
      uv.set([0, i / PAGE_SEG, 1, i / PAGE_SEG], i * 4);
      if (i < PAGE_SEG) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
    return g;
  }
  function setPage(g, phi) {
    // phi 是页边（手捏着的地方）绕书脊转过的角度；靠书脊那段落后、页边领先，纸弯成弓，页边始终在手里
    const pos = g.attributes.position.array, c = Math.PI * phi, bend = 0.9 * Math.sin(c);
    let y = 0, z = 0;
    for (let i = 0; i <= PAGE_SEG; i++) {
      pos.set([-PAGE_L / 2, y, z, PAGE_L / 2, y, z], i * 6);
      const s = (i + 0.5) / PAGE_SEG, a = c - bend / 2 + bend * s;
      z += Math.cos(a) * PAGE_W / PAGE_SEG; y += Math.sin(a) * PAGE_W / PAGE_SEG;
    }
    g.attributes.position.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingSphere();
  }
  const FLIPS = 12;
  const flips = Array.from({ length: FLIPS }, () => { const m = new THREE.Mesh(makePageGeo(), pageMat); m.position.y = 0.045; m.visible = false; m.frustumCulled = false; book.add(m); return { m, t0: -10, dur: 0.6 }; });
  // 骑士手里那一页：跟着精灵帧走（sitTurn.phi），不按时间自己翻
  // 翻起来的纸背光时别成一块灰板：自己带一点纸色的光
  const handPageMat = pageMat.clone(); handPageMat.emissiveIntensity = 0.3;
  const handPage = new THREE.Mesh(makePageGeo(), handPageMat); handPage.position.y = 0.045; handPage.visible = false; handPage.frustumCulled = false; book.add(handPage);
  let handPhi = 0;
  // 书不挡骑士：书在桌子之后、骑士之前画，并且不写深度。精灵的深度是从一张纸推出来的，手那里差一两厘米，
  // 写深度的话书页会把手切掉一截；这样手（连同手里那页）永远完整地压在书上。书自己内部按封面 → 书页 → 翻动的纸排先后。
  const bookPageMat = pageMat.clone(); bookPageMat.depthWrite = false;
  handPageMat.depthWrite = false;
  book.traverse((o) => {
    if (!o.isMesh) return;
    const turning = o === handPage || flips.some((f) => f.m === o);
    if (o.material === pageMat) o.material = bookPageMat;
    else if (o.material !== handPageMat) { o.material = o.material.clone(); o.material.depthWrite = false; }
    o.renderOrder = turning ? 7 : o.material.map === coverTex ? 5 : 6;
  });
  knight.renderOrder = 10;
  let flipNext = 0;
  function flipPage(t, dur = 0.7) { const f = flips[flipNext]; flipNext = (flipNext + 1) % FLIPS; f.t0 = t; f.dur = dur; }
  const bookLight = new THREE.PointLight(0x9fd0ff, 0, 0, 2); bookLight.position.set(book.position.x, 1.5, 0); desk.add(bookLight);
  const bookGlowMat = new THREE.SpriteMaterial({ map: softTex, color: new THREE.Color(0.6, 1.2, 2.2), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 });
  const bookGlow = new THREE.Sprite(bookGlowMat); bookGlow.scale.setScalar(0.9); bookGlow.position.set(book.position.x, TOP + 0.08, 0); desk.add(bookGlow);
  const bookWorld = () => book.getWorldPosition(new V3());

  /* ================================================================
   * 极繁摆设
   * ================================================================ */
  const dW = (lx, lz, ly = TOP) => new V3(DESK_X + lx, ly, lz);    // 桌面局部 → 世界
  // —— 桌面：三枝烛台、蜡烛堆、书摞、墨水和羽毛笔、小星辉仪、小匣子、钥匙、辉石结晶、卷轴、小水晶球
  { const p = dW(0.32, -0.82); addCandelabra(p.x, p.z, 0.5, 3, TOP); }
  for (const [lx, lz, h] of [[0.12, -0.55, 0.12], [0.2, -0.5, 0.2], [0.05, -0.62, 0.08]]) { const p = dW(lx, lz); addCandle(p.x, p.y, p.z, h, 0.035, false); }   // 烛台脚边的散蜡烛：熄着
  if (DESK_MODEL) {
    // 书摞、墨水瓶和羽毛笔、卷轴都在 Blender 模型里；只留书摞顶上那支蜡烛（火苗还是实时画的）
    const p = dW(0.32, 0.62); addCandle(p.x, TOP + 0.1, p.z, 0.16);
  } else {
    { const p = dW(0.3, 0.95); addPile(p.x, p.y, p.z, 4); }
    { const p = dW(0.32, 0.62); const top = addPile(p.x, p.y, p.z, 2); addCandle(p.x, top, p.z, 0.16); }
    const ink = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.08, 10), new THREE.MeshStandardMaterial({ color: 0x14182c, roughness: 0.1, metalness: 0.3 }));
    ink.position.copy(dW(-0.32, 0.45, TOP + 0.04)); scene.add(ink);
    const fTex = pixelTex(featherCanvas()); fTex.wrapS = fTex.wrapT = THREE.ClampToEdgeWrapping;
    const feather = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.36), new THREE.MeshStandardMaterial({ map: fTex, alphaTest: 0.5, side: THREE.DoubleSide }));
    feather.position.copy(dW(-0.29, 0.48, TOP + 0.2)); feather.rotation.set(0.1, 0.4, -0.35); scene.add(feather);
  }
  const mini = new THREE.Group(); mini.position.copy(dW(0.22, 0.3)); scene.add(mini);
  {
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.07, 0.2, 8), goldMat); stand.position.y = 0.1; mini.add(stand);
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.008, 6, 40), goldMat), r2 = r1.clone(), r3 = r1.clone();
    r1.position.y = r2.position.y = r3.position.y = 0.36; r2.rotation.x = Math.PI / 2; r3.rotation.set(Math.PI / 2, 0.6, 0);
    mini.add(r1, r2, r3); mini.userData.rings = [r1, r2, r3];
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), glowBasic(1.2, 2.2, 3.2)); core.position.y = 0.36; mini.add(core);
  }
  addCasket(dW(0.25, -0.22).x, TOP, -0.22, 0.4);
  addKey(dW(-0.3, -0.32).x, TOP + 0.01, -0.32, 0.6);
  addKey(dW(-0.2, -0.44).x, TOP + 0.01, -0.44, 2.2, 0.8);
  addCluster(dW(-0.34, -0.66).x, TOP, -0.66, 0.32, 6);
  const scrollGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.34, 10).rotateZ(Math.PI / 2), scrollMat = new THREE.MeshStandardMaterial({ color: 0xe8dab4, roughness: 0.9 });
  if (!DESK_MODEL) for (const [lx, lz, ry] of [[0.35, 0.12, 0.3], [0.38, 0.05, 0.5], [0.33, 0.19, 0.2]]) { const s = new THREE.Mesh(scrollGeo, scrollMat); s.position.copy(dW(lx, lz, TOP + 0.03)); s.rotation.y = ry; scene.add(s); }
  { const p = dW(-0.05, 0.62); addCrystalBall(p.x, p.y, p.z, 0.07); }
  // 靠在桌边的盾和剑
  {
    const sh = shieldCanvas();
    const mapT = pixelTex(sh.map), emT = pixelTex(sh.emissive);
    for (const t of [mapT, emT]) { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.repeat.set(1 / 0.5, 1 / 0.78); t.offset.set(0.5, 0.5); }
    const shape = new THREE.Shape(), pts = [];
    for (let i = 0; i <= 24; i++) { const v = i / 24, hw = v < 0.35 ? 1 - Math.max(0, 0.06 - v) * 5 : Math.pow(Math.max(0, 1 - (v - 0.35) / 0.65), 0.8); pts.push([hw * 0.25, 0.39 - v * 0.78]); }
    shape.moveTo(-pts[0][0], pts[0][1]); pts.forEach(([x, y]) => shape.lineTo(x, y)); for (let i = pts.length - 2; i >= 0; i--) shape.lineTo(-pts[i][0], pts[i][1]);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2 });
    const shield = new THREE.Mesh(geo, [new THREE.MeshStandardMaterial({ map: mapT, emissiveMap: emT, emissive: 0xffffff, emissiveIntensity: 1.6, metalness: 0.55, roughness: 0.35 }), goldMat]);
    shieldMat = shield.material[0];
    shield.position.set(DESK_X - 0.62, 0.4, 1.0); shield.rotation.set(-0.12, 0.35, 0.06); scene.add(shield);
    const sword = new THREE.Group(); sword.position.set(DESK_X - 0.64, 0, 1.3); sword.rotation.set(0.0, 0.2, 0.22); scene.add(sword);
    const steel = new THREE.MeshStandardMaterial({ color: 0xc8d4e8, metalness: 0.8, roughness: 0.25 });
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.82, 0.012), steel); blade.position.y = 0.43; sword.add(blade);
    const fuller = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.45, 0.016), glowBasic(1.0, 2.0, 3.4)); fuller.position.y = 0.6; sword.add(fuller);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.026, 0.026), goldMat); guard.position.y = 0.86; sword.add(guard);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.15, 8), new THREE.MeshStandardMaterial({ color: 0x4a3020 })); grip.position.y = 0.95; sword.add(grip);
    const pom = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), goldMat); pom.position.y = 1.04; sword.add(pom);
  }
  let stoneSpin = 0, astroSpin = 0;
  // —— 地面：左边是宝箱、落地烛台、辉石簇、书山；右边是石柱上的水晶球和魔法石；后面是月神像、半身像、星盘
  addChest(-2.15, 1.0, 0.55, 1.0);
  addCandelabra(-2.9, -0.5, 1.7, 5);
  addCandelabra(1.55, -2.2, 1.5, 5);
  addCandelabra(-0.9, -3.4, 1.3, 4);
  addCluster(-1.5, 0, -1.7, 1.1, 9); addCluster(-1.22, 0, -1.98, 0.6, 6); addCluster(-3.4, 0, 1.6, 0.9, 8);
  addCluster(3.1, 0, 0.9, 0.8, 7); addCluster(2.1, 0, 2.3, 0.6, 6); addCluster(-0.6, 0, -2.6, 0.5, 5);
  addCluster(1.35, 0.69, -5.95, 0.4, 5); addCluster(-1.1, 0.69, -5.95, 0.35, 5);   // 窗台
  addCluster(3.05, 0.56, -3.15, 0.35, 4);                                          // 石像底座上
  for (const [x, z, n] of [[-1.6, -0.9, 7], [-1.85, -1.25, 4], [-2.6, 1.7, 6], [-1.4, 1.6, 3], [1.9, -1.0, 5], [2.6, 1.6, 8], [1.6, 1.9, 4], [0.6, -2.0, 6], [-0.3, -1.6, 3], [3.2, -1.2, 5]]) {
    const top = addPile(x, 0, z, n);
    if (rnd() < 0.35) addCandle(x, top, z, R(0.1, 0.22));
  }
  for (const [x, z] of [[-1.1, -5.95], [-0.55, -6.0], [1.0, -5.95], [1.55, -5.9]]) addHeap(x, 0.69, z, 0.55);
  { const top = addPile(-0.8, 0.69, -5.85, 3); addCandle(-0.75, top, -5.85, R(0.12, 0.2)); }
  for (const [x, z] of [[-1.0, 1.4], [-2.4, -0.2], [0.9, 1.7], [2.2, -0.2]]) addCandle(x, 0, z, R(0.14, 0.3), 0.045);
  addCasket(-1.62, 0.37, -0.9, 1.2);
  addCasket(1.9, 0.3, -1.0, -0.6);
  addKey(-1.9, 0.02, 1.7, 1.0, 1.4); addKey(0.4, 0.02, 1.4, -0.5, 1.2);
  {
    const col = new THREE.Mesh(new THREE.LatheGeometry([[0.3, 0], [0.3, 0.1], [0.16, 0.15], [0.13, 0.85], [0.22, 0.95], [0.24, 1.0]].map(([r, h]) => new THREE.Vector2(r, h)), 10), marbleMat);
    col.position.set(2.55, 0, -0.75); scene.add(col);
  }
  const ballPos = addCrystalBall(2.55, 1.0, -0.75, 0.24);
  addMagicStones(ballPos, 7, 0.55);
  addBust(-2.9, -2.6, 0.8);
  const astro = addAstrolabe(-3.7, 0, -1.5, 0.9, 1.1);

  // —— 沙漏雕像：铜底座、四根车削柱、玻璃沙漏里沙子往下漏
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xcfe6ff, roughness: 0.08, transparent: true, opacity: 0.26, depthWrite: false });
  const sandMat = new THREE.MeshStandardMaterial({ color: 0xd8b070, roughness: 0.9 });
  const v2 = (arr) => arr.map(([r2, h]) => new THREE.Vector2(r2, h));
  const hgDisc = new THREE.LatheGeometry(v2([[0, 0], [0.3, 0], [0.32, 0.03], [0.3, 0.06], [0.26, 0.08], [0, 0.08]]), 24);
  const hgCol = new THREE.LatheGeometry(v2([[0.025, 0], [0.04, 0.04], [0.02, 0.1], [0.032, 0.3], [0.018, 0.45], [0.036, 0.5], [0.018, 0.55], [0.03, 0.7], [0.02, 0.84], [0.04, 0.88], [0.025, 0.9]]), 8);
  const hgBulb = new THREE.LatheGeometry(v2([[0.02, 0], [0.17, 0.06], [0.19, 0.18], [0.12, 0.33], [0.022, 0.41]]), 24);
  function addHourglass(x, y, z, s = 1, rot = 0) {
    const g = new THREE.Group(); g.position.set(x, y, z); g.scale.setScalar(s); g.rotation.y = rot; scene.add(g);
    g.add(new THREE.Mesh(hgDisc, darkGold));
    const tp = new THREE.Mesh(hgDisc, darkGold); tp.rotation.x = Math.PI; tp.position.y = 1.06; g.add(tp);
    for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2 + Math.PI / 4; const c = new THREE.Mesh(hgCol, goldMat); c.position.set(Math.cos(a) * 0.24, 0.08, Math.sin(a) * 0.24); g.add(c); }
    const lo = new THREE.Mesh(hgBulb, glassMat); lo.position.y = 0.08; g.add(lo);
    const hi = new THREE.Mesh(hgBulb, glassMat); hi.rotation.x = Math.PI; hi.position.y = 0.98; g.add(hi);
    const sLo = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.14, 16), sandMat); sLo.position.y = 0.15; g.add(sLo);
    const sHi = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.1, 16).rotateX(Math.PI), sandMat); sHi.position.y = 0.82; g.add(sHi);
    const strm = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.36, 4), sandMat); strm.position.y = 0.48; g.add(strm);
    const fin = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), goldMat); fin.position.y = 1.16; g.add(fin);
    const spk = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.16, 8), goldMat); spk.position.y = 1.28; g.add(spk);
  }
  addHourglass(-1.95, 0, -4.45, 1.45, 0.3);
  addHourglass(-1.55, 0.69, -5.9, 0.55, 0.1);
  addHourglass(dW(-0.05, -0.88).x, TOP, -0.88, 0.28);
  addHourglass(2.2, 0, 1.1, 0.8, 0.7);

  // —— 星辉仪：铜座、可以转的经纬环、中间一颗浅蓝石球
  const armillaries = [];
  function addArmillary(x, y, z, s = 1) {
    const g = new THREE.Group(); g.position.set(x, y, z); g.scale.setScalar(s); scene.add(g);
    g.add(new THREE.Mesh(new THREE.LatheGeometry(v2([[0.34, 0], [0.34, 0.06], [0.22, 0.1], [0.13, 0.2], [0.08, 0.62], [0.15, 0.68], [0.06, 0.78]]), 16), darkGold));
    const C = new V3(0, 1.3, 0), spin = [];
    const horizon = new THREE.Mesh(new THREE.TorusGeometry(0.58, 0.025, 8, 64), goldMat); horizon.rotation.x = Math.PI / 2; horizon.position.copy(C); g.add(horizon);
    for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2; const st = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.62, 6), darkGold); st.position.set(Math.cos(a) * 0.3, 1.0, Math.sin(a) * 0.3); st.rotation.set(Math.sin(a) * 0.75, 0, -Math.cos(a) * 0.75); g.add(st); }
    const tilt = new THREE.Group(); tilt.position.copy(C); tilt.rotation.z = 0.41; g.add(tilt);
    const axis = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.3, 6), goldMat); tilt.add(axis);
    for (const [r2, rx, ry] of [[0.52, 0, 0], [0.47, Math.PI / 2, 0], [0.42, Math.PI / 2, 0.6], [0.37, 1.2, 1.2]]) {
      const p = new THREE.Group(); tilt.add(p); spin.push(p);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r2, 0.016, 6, 64), goldMat); ring.rotation.set(rx, ry, 0); p.add(ring);
    }
    const globe2 = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16), new THREE.MeshStandardMaterial({ color: 0x8fa8bc, roughness: 0.55, metalness: 0.2 }));
    tilt.add(globe2);
    armillaries.push(spin);
  }
  addArmillary(3.35, 0, -1.25, 1.25);
  addArmillary(-3.55, 0, 0.35, 0.75);
  addArmillary(1.25, 0.69, -5.9, 0.42);

  // —— 地面铺满：高低不一的书堆（有的高过人），堆顶放蜡烛或小辉石；中间地毯和走动的地方留空
  {
    const avoid = [[0, 0.2, 2.05], [KNIGHT_POS.x, 0, 0.7], [DESK_X, 0, 1.25], [DESK_X, 1.0, 0.8], [DESK_X, -1.0, 0.8],
      [-2.15, 1.0, 0.8], [2.55, -0.75, 0.55], [-2.9, -2.6, 0.5], [3.35, -1.25, 0.8], [-3.55, 0.35, 0.55], [-3.7, -1.5, 0.5],
      [-1.95, -4.45, 0.6], [-2.9, -0.5, 0.45], [1.55, -2.2, 0.45], [-0.9, -3.4, 0.45], [2.2, 1.1, 0.45], [0, -5.4, 1.0]];
    let placed = 0;
    for (let tries = 0; tries < 1400 && placed < 70; tries++) {
      const a = R(0, Math.PI * 2), rr = Math.sqrt(R(2.15 ** 2, 6.05 ** 2)), x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (avoid.some(([ax, az, ar]) => Math.hypot(x - ax, z - az) < ar)) continue;
      const nearCam = Math.hypot(x + 2.2, z - 4.5) < 2.4;
      const tall = !nearCam && rr > 4.4 && rnd() < 0.35;
      const top = addHeap(x, 0, z, nearCam ? 0.45 : tall ? 1.6 : R(0.6, 1.1));
      const roll = rnd();
      if (roll < 0.12) addCandle(x + R(-0.05, 0.05), top, z + R(-0.05, 0.05), R(0.06, 0.2), 0.03);
      else if (roll < 0.42) addCluster(x, top, z, R(0.22, 0.4), 4);
      placed++;
      avoid.push([x, z, 0.62]);
    }
    // 窗下那片地板：书堆挨着书堆铺到墙根（中间留出月光照进来的那条路）
    for (let k = 0, tries = 0; k < 16 && tries < 500; tries++) {
      const x = R(-3.2, 3.2), z = R(-6.0, -4.3);
      if (Math.hypot(x, z) > 6.1 || Math.abs(x - 0.35) < 0.45 || avoid.some(([ax, az, ar]) => Math.hypot(x - ax, z - az) < ar * 0.75)) continue;
      const top = addHeap(x, 0, z, R(0.7, 1.4));
      if (rnd() < 0.15) addCandle(x, top, z, R(0.08, 0.16), 0.03);
      avoid.push([x, z, 0.5]);
      k++;
    }
    for (let i = 0, tries = 0; i < 18 && tries < 400; tries++) {
      const a = R(0, Math.PI * 2), rr = R(2.2, 5.9), x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (avoid.some(([ax, az, ar]) => Math.hypot(x - ax, z - az) < ar * 0.8)) continue;
      if (rnd() < 0.75) addCluster(x, 0, z, R(0.25, 0.6), 5); else addCandle(x, 0, z, R(0.12, 0.34), 0.045);
      i++;
    }
  }
  {
    const pm = new THREE.MeshStandardMaterial({ map: pageTex, color: 0xd8cdb6, side: THREE.DoubleSide, roughness: 1 });
    for (let i = 0; i < 16; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.21, 0.27), pm);
      p.rotation.set(-Math.PI / 2 + R(-0.1, 0.1), 0, R(0, 6)); p.position.set(R(-3, 3), 0.01 + i * 0.0005, R(-2.5, 2.4));
      if (Math.abs(p.position.x - KNIGHT_POS.x) < 0.6 && Math.abs(p.position.z) < 0.6) p.position.x += 1.4;
      scene.add(p);
    }
  }

  /* ---------------- 把蜡烛 / 结晶 / 书本收成实例 ---------------- */
  {
    const M = new THREE.Matrix4(), q = new THREE.Quaternion();
    const wax = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1.1, 1, 10).translate(0, 0.5, 0), waxMat, candles.length);
    const pud = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), waxMat, candles.length);
    const fp = new Float32Array(candles.length * 3), fr = new Float32Array(candles.length).map(() => Math.random());
    // 点着的只有书桌一圈（主角的暖光）和窗台上的；其余是熄着的蜡烛（有烛泪、没火苗），转场时一起点亮
    const lit = new Float32Array(candles.map((c) => (c.lit ?? ((Math.abs(c.x - DESK_X) < 0.9 && Math.abs(c.z) < 1.3 && c.y > TOP - 0.05) || (c.z < -5.4 && c.y > 0.6))) ? 1 : 0));
    candles.forEach((c, i) => {
      M.compose(new V3(c.x, c.y, c.z), q, new V3(c.r, c.h, c.r)); wax.setMatrixAt(i, M);
      M.compose(new V3(c.x, c.y, c.z), q, new V3(c.r * 2.4, 0.015, c.r * 2.2)); pud.setMatrixAt(i, M);
      fp.set([c.x, c.y + c.h + 0.06, c.z], i * 3);
    });
    scene.add(wax, pud);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(fp, 3));
    g.setAttribute('aRand', new THREE.BufferAttribute(fr, 1));
    g.setAttribute('aLit', new THREE.BufferAttribute(lit, 1));
    const fl = new THREE.Points(g, flameMaterial(0.3, 0.3, uAwake));   // 火苗亮度 0.5 → 0.3：照亮他，但别比他抢眼
    fl.frustumCulled = false; scene.add(fl);

    const cr = new THREE.InstancedMesh(glintGeometry, glint, crystals.length);
    const e = new THREE.Euler();
    crystals.forEach((c, i) => {
      e.set(Math.cos(c.a) * c.tilt, c.a, Math.sin(c.a) * c.tilt);
      q.setFromEuler(e);
      M.compose(c.p, q, new V3(c.w * 1.4, c.h * 0.85, c.w * 1.4)); cr.setMatrixAt(i, M);
    });
    scene.add(cr);

    const slabs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.7 }), books.length * 3);
    const leaves = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xe6d8b6, roughness: 0.9, emissive: 0x2a2014, emissiveIntensity: 0.5 }), books.length);
    const P = new THREE.Matrix4();
    books.forEach((b, i) => {
      M.makeRotationFromEuler(new THREE.Euler(b.tx || 0, b.rot, b.tz || 0, 'YXZ')).setPosition(b.x, b.y, b.z);
      [[0, -b.h / 2 + 0.007, 0, b.w, 0.014, b.d], [0, b.h / 2 - 0.007, 0, b.w, 0.014, b.d], [-b.w / 2 + 0.008, 0, 0, 0.016, b.h, b.d]].forEach(([x, y, z, sx, sy, sz], j) => {
        P.compose(new V3(x, y, z), q.identity(), new V3(sx, sy, sz)); slabs.setMatrixAt(i * 3 + j, new THREE.Matrix4().multiplyMatrices(M, P)); slabs.setColorAt(i * 3 + j, b.col);
      });
      P.compose(new V3(0.004, 0, 0), q.identity(), new V3(b.w - 0.022, b.h - 0.026, b.d - 0.022)); leaves.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(M, P));
    });
    scene.add(slabs, leaves);
  }

  // 头顶悬着的大星辉仪
  const globe = new THREE.Group(); globe.position.set(-2.4, 5.6, -2.2); scene.add(globe);
  {
    globe.add(new THREE.Mesh(new THREE.SphereGeometry(0.9, 24, 16), new THREE.MeshStandardMaterial({ color: 0x8a7444, metalness: 0.6, roughness: 0.45, emissive: 0x1a1208, flatShading: true })));
    for (const [rx, ry] of [[0, 0], [Math.PI / 2, 0], [Math.PI / 2, Math.PI / 3]]) { const r = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.04, 6, 64), goldMat); r.rotation.set(rx, ry, 0); r.userData.ring = true; globe.add(r); }
    for (const [x, z] of [[0.8, 0.8], [-0.8, 0.8], [0, -1.1]]) { const ch = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 6, 4), goldMat); ch.position.set(x * 1.4, 3.2, z * 1.4); ch.lookAt(globe.position.clone().add(new V3(0, 6, 0))); ch.rotateX(Math.PI / 2); globe.add(ch); }
  }
  // 月光：从整面长窗斜着灌进来（约 30° 俯角），窗下地板一直铺到书桌都是窗格形状的冷光
  const WIN_Z = -ROOM_R + 0.06, WIN_X = 1.78, WIN_Y0 = 0.75, WIN_Y1 = 8.6;
  const LDIR = new V3(0.03, -0.577, 1).normalize();                          // 光的行进方向
  const BEAM_A = new V3(0, 4.6, WIN_Z), BEAM_B = BEAM_A.clone().addScaledVector(LDIR, 7.4);
  const winPat = /* glsl */`
    float winPat(vec2 q){                                                   // 长窗在窗面上的透光图案：竖棂、横棂、尖拱
      float m = 1.0;
      m *= smoothstep(0.03, 0.07, abs(q.x));
      m *= smoothstep(0.02, 0.05, abs(abs(q.x) - 0.9));
      m *= smoothstep(0.02, 0.05, abs(fract((q.y - 0.75)/1.25) - 0.5) * 1.25 - 0.58);
      float arch = length(vec2(q.x, max(q.y - 6.8, 0.0))*vec2(1.0, 0.95));
      m *= 1.0 - smoothstep(1.7, 1.8, arch);
      m *= step(abs(q.x), ${WIN_X.toFixed(2)}) * step(${WIN_Y0.toFixed(2)}, q.y) * step(q.y, ${WIN_Y1.toFixed(2)});
      return m;
    }`;
  {
    // 体积光：从窗框四边沿光线方向拉出去的棱柱，外加三张沿光线的内部薄片；按回溯到窗面的坐标画窗格
    const volMat = new THREE.ShaderMaterial({
      uniforms: { uTime: H.shared.uTime, uL: { value: LDIR } },
      vertexShader: /* glsl */`varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
      fragmentShader: winPat + /* glsl */`
        uniform float uTime; uniform vec3 uL; varying vec3 vW;
        void main(){
          float s = (vW.z - (${WIN_Z.toFixed(3)})) / uL.z;
          vec2 q = (vW - uL*s).xy;
          float m = winPat(q);
          float streak = 0.65 + 0.35*sin(q.x*23.0 + q.y*3.0 + uTime*0.2)*sin(q.y*7.0 - uTime*0.13);
          m *= (1.0 - smoothstep(${(WIN_Y1 - 3.0).toFixed(2)}, ${WIN_Y1.toFixed(2)}, q.y)) * (1.0 - smoothstep(${(WIN_X - 0.6).toFixed(2)}, ${WIN_X.toFixed(2)}, abs(q.x)));
          float a = m * streak * smoothstep(0.0, 0.6, s) * (1.0 - smoothstep(4.0, 9.5, s)) * smoothstep(-0.02, 0.35, vW.y) * (1.0 - smoothstep(1.2, 2.6, vW.z));
          gl_FragColor = vec4(vec3(0.55,0.72,1.0) * a * 0.05, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const L = 12, c = [[-WIN_X, WIN_Y0], [WIN_X, WIN_Y0], [WIN_X, WIN_Y1], [-WIN_X, WIN_Y1]];
    const pos = [];
    const quad = (a, b, cc, d) => pos.push(...a, ...b, ...cc, ...a, ...cc, ...d);
    const P = (x, y, t) => [x + LDIR.x * t, y + LDIR.y * t, WIN_Z + LDIR.z * t];
    for (const x of [-1.45, -0.72, 0.0, 0.72, 1.45]) quad(P(x, WIN_Y0, 0), P(x, WIN_Y1, 0), P(x, WIN_Y1, L), P(x, WIN_Y0, L));
    const vg = new THREE.BufferGeometry(); vg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const vol = new THREE.Mesh(vg, volMat); vol.frustumCulled = false; scene.add(vol);
  }
  {   // 光里缓缓往下飘的光尘（遍布整片月光）+ 少量发光晶片
    for (const shard of [false, true]) {
      const N = shard ? 90 : 650, wx = new Float32Array(N), wy = new Float32Array(N), tt = new Float32Array(N), rr = new Float32Array(N);
      for (let k = 0; k < N; k++) { wx[k] = (Math.random() * 2 - 1) * (WIN_X - 0.1); wy[k] = WIN_Y0 + Math.random() ** 1.3 * 5.2; tt[k] = Math.random(); rr[k] = Math.random(); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      g.setAttribute('aX', new THREE.BufferAttribute(wx, 1)); g.setAttribute('aY', new THREE.BufferAttribute(wy, 1));
      g.setAttribute('aT', new THREE.BufferAttribute(tt, 1)); g.setAttribute('aRand', new THREE.BufferAttribute(rr, 1));
      const pts = new THREE.Points(g, pointsMaterial(COMMON_GLSL + NOISE_GLSL + /* glsl */`
        attribute float aX, aY, aT, aRand; uniform vec3 uL;
        varying vec3 vColor; varying float vAlpha; varying float vRot;
        void main(){
          float sMax = min(aY / -uL.y, 8.0);                                // 走到地板或书桌前面就停
          float t = fract(aT + uTime*${shard ? '0.006' : '0.01'}*(0.5 + aRand));
          vec3 p = vec3(aX, aY, ${WIN_Z.toFixed(3)}) + uL*(t*sMax) + vec3(0.0, -t*0.3, 0.0);
          p += curlNoise(p*0.6 + uTime*0.04) * ${shard ? '0.12' : '0.07'};
          vec4 mv = viewMatrix*vec4(p,1.0);
          gl_Position = projectionMatrix*mv;
          float tw = 0.5 + 0.5*sin(uTime*(1.2 + aRand*2.5) + aRand*40.0);
          float flash = pow(max(0.0, sin(uTime*0.8 + aRand*80.0)), 20.0);
          vColor = ${shard ? 'vec3(0.55,0.8,1.35)*(0.9 + flash*1.5)' : 'mix(vec3(0.72,0.85,1.0), vec3(0.5,0.78,1.35), step(0.85, aRand))*(0.75 + flash*1.6)'};
          vAlpha = sin(t*3.14159) * (${shard ? '0.55 + 0.45*tw' : '0.2 + 0.8*tw'}) * smoothstep(0.4, 1.2, -mv.z);
          vRot = aRand*30.0 + uTime*(0.4 + aRand*0.8);
          gl_PointSize = max(1.5, pxSize(${shard ? '0.07 + 0.06*aRand' : '0.016 + 0.016*aRand + flash*0.02'}, -mv.z));
        }`, shard ? SHARD_FRAG : undefined, { uL: { value: LDIR } }));
      pts.frustumCulled = false; scene.add(pts);
    }
  }

  /* ---------------- 粒子 ---------------- */
  const uBook = { value: new V3() }, uBookPow = { value: 0.15 }, uSurge = { value: 0 };
  const addPts = (pts) => { pts.frustumCulled = false; scene.add(pts); return pts; };
  {   // 月光里的浮尘
    const N = 520, pos = new Float32Array(N * 3), rr = new Float32Array(N);
    for (let i = 0; i < N; i++) { pos.set([(Math.random() - 0.5) * 9, Math.random() * 7, (Math.random() - 0.5) * 9], i * 3); rr[i] = Math.random(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aRand', new THREE.BufferAttribute(rr, 1));
    addPts(new THREE.Points(g, pointsMaterial(COMMON_GLSL + NOISE_GLSL + /* glsl */`
      attribute float aRand;
      uniform vec3 uBeamA, uBeamB;
      varying vec3 vColor; varying float vAlpha;
      void main(){
        vec3 p = position + vec3(0.0, uTime*0.05*(0.5 + aRand), 0.0);
        p.y = mod(p.y, 7.0);
        p += curlNoise(p*0.3 + uTime*0.03) * 0.3;
        vec3 a = uBeamA, b = uBeamB;
        vec3 ab = b - a; float t = clamp(dot(p - a, ab)/dot(ab, ab), 0.0, 1.0);
        float inBeam = exp(-pow(length(p - (a + ab*t)) / (1.0 + t*0.7), 2.0) * 1.5);
        vec4 mv = viewMatrix*vec4(p,1.0);
        gl_Position = projectionMatrix*mv;
        float tw = 0.5 + 0.5*sin(uTime*(1.0 + aRand*2.0) + aRand*50.0);
        vColor = mix(vec3(0.6,0.8,1.0), vec3(1.0,0.85,0.6), step(0.8, aRand));
        vAlpha = tw * (0.015 + 1.1*inBeam) * smoothstep(0.4, 1.2, -mv.z);
        gl_PointSize = max(1.5, pxSize(0.02 + 0.015*aRand, -mv.z));
      }`, undefined, { uBeamA: { value: BEAM_A }, uBeamB: { value: BEAM_B } })));
  }
  {   // 书上冒出的符文光点（转场时变成漩涡）
    const N = 900, pos = new Float32Array(N * 3), rr = new Float32Array(N);
    for (let i = 0; i < N; i++) { pos.set([Math.random(), Math.random(), Math.random()], i * 3); rr[i] = Math.random(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aRand', new THREE.BufferAttribute(rr, 1));
    addPts(new THREE.Points(g, pointsMaterial(COMMON_GLSL + NOISE_GLSL + /* glsl */`
      attribute float aRand;
      uniform vec3 uBook; uniform float uPow;
      varying vec3 vColor; varying float vAlpha;
      void main(){
        float speed = 0.25 + uPow*1.8;
        float life = fract(uTime*speed*(0.4 + aRand*0.6) + aRand*13.0);
        float a = position.x*6.2831 + life*(2.0 + uPow*9.0)*(position.y > 0.5 ? 1.0 : -1.0);
        float r = (0.05 + position.z*0.22) * (1.0 + life*(1.0 + uPow*5.0));
        vec3 p = uBook + vec3(cos(a)*r, life*(0.5 + uPow*2.4), sin(a)*r);
        p += curlNoise(p*2.0 + uTime*0.3) * 0.04 * life;
        vec4 mv = viewMatrix*vec4(p,1.0);
        gl_Position = projectionMatrix*mv;
        vColor = mix(vec3(0.6,0.9,1.0), vec3(1.0,0.85,0.5), step(0.6, aRand)) * (1.3 + uPow*0.9);
        vAlpha = sin(life*3.14159) * (0.25 + uPow) * step(aRand, max(0.0, uPow - 0.25) * 1.3);
        gl_PointSize = max(1.5, pxSize(0.022 + 0.022*uPow, -mv.z));
      }`, SOFT_POINT_FRAG, { uBook, uPow: uBookPow })));
  }
  {   // 辉石结晶往上飘的碎屑；转场时整屋子的辉石碎屑被书吸过去
    const PER = 3, N = glintSites.length * PER, pos = new Float32Array(N * 3), rr = new Float32Array(N);
    glintSites.forEach((s, i) => { for (let j = 0; j < PER; j++) { pos.set([s.x, s.y, s.z], (i * PER + j) * 3); rr[i * PER + j] = Math.random(); } });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aRand', new THREE.BufferAttribute(rr, 1));
    addPts(new THREE.Points(g, pointsMaterial(COMMON_GLSL + NOISE_GLSL + /* glsl */`
      attribute float aRand;
      uniform vec3 uBook; uniform float uSurge;
      varying vec3 vColor; varying float vAlpha;
      void main(){
        float life = fract(uTime*(0.18 + 0.2*aRand + uSurge*0.6) + aRand*11.0);
        vec3 p = position + vec3(sin(aRand*30.0)*0.15*life, life*(0.6 + aRand*0.8), cos(aRand*21.0)*0.15*life);
        p += curlNoise(p*0.8 + uTime*0.2) * 0.12 * life;
        vec3 toBook = uBook + vec3(0.0, 0.2, 0.0) - p;
        p += toBook * smoothstep(0.0, 1.0, uSurge) * smoothstep(0.0, 1.0, life);
        vec4 mv = viewMatrix*vec4(p,1.0);
        gl_Position = projectionMatrix*mv;
        float tw = pow(0.5 + 0.5*sin(uTime*(3.0 + aRand*5.0) + aRand*60.0), 3.0);
        vColor = mix(vec3(0.45,0.8,1.0), vec3(0.85,0.95,1.0), tw) * (0.8 + tw*0.8 + uSurge*2.0);
        vAlpha = sin(life*3.14159) * (0.25 + tw*0.5 + uSurge);
        gl_PointSize = max(1.5, pxSize(0.026 + 0.03*tw, -mv.z));
      }`, SOFT_POINT_FRAG, { uBook, uSurge })));
  }
  const floaters = [];
  {
    const N = 0, fpos = new Float32Array(N * 3), frr = new Float32Array(N).map(() => Math.random());
    for (let i = 0; i < N; i++) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.3, 8), waxMat);
      const a = i / N * Math.PI * 2 + 0.4, r = 2.4 + (i % 3) * 0.8;
      floaters.push({ c, x: Math.cos(a) * r, z: Math.sin(a) * r - 0.5, y: 3.0 + (i % 4) * 0.6, ph: i * 1.7 });
      scene.add(c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(fpos, 3)); g.setAttribute('aRand', new THREE.BufferAttribute(frr, 1));
    addPts(new THREE.Points(g, flameMaterial(0.5)));
    floaters.flames = g;
  }
  const pageBurst = makePageBurst(scene, pageMat, 90);
  scene.traverse((o) => {
    if (!o.isMesh || o === knight) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (m.isShaderMaterial || m.isMeshBasicMaterial || m.transparent || m.blending === THREE.AdditiveBlending) return;
    o.castShadow = o !== floor && o !== rug && o !== wall; o.receiveShadow = true;
  });

  /* ---------------- 灯光 ---------------- */
  scene.add(new THREE.HemisphereLight(0x3a5088, 0x0e0a10, 0.22));
  const moon = new THREE.DirectionalLight(0xb8d4ff, 0.35); moon.position.set(0.2, 8, -10); moon.target.position.set(0.3, 0.8, 0.5); scene.add(moon, moon.target);
  // 主光：满月从长窗斜照进来，一道冷白的光正好落在骑士面前的书上
  const moonSpot = new THREE.SpotLight(0xd8e6ff, 15, 0, 0.25, 0, 0);
  moonSpot.position.copy(BEAM_A).addScaledVector(LDIR, -16);
  moonSpot.target.position.copy(BEAM_A);
  moonSpot.castShadow = true; moonSpot.shadow.mapSize.set(2048, 2048); moonSpot.shadow.bias = -0.0004; moonSpot.shadow.normalBias = 0.02;
  moonSpot.shadow.camera.near = 8; moonSpot.shadow.camera.far = 40;
  {
    // 窗格 cookie：在聚光灯的视角里，长窗约占宽 44%、高 83%；竖棂横棂和尖拱都画进去，边缘稍微柔一点
    const C = 256, { c, g } = makeCanvas(C, C);
    g.fillStyle = '#000'; g.fillRect(0, 0, C, C);
    const w = C * 0.44, h = C * 0.83, x0 = (C - w) / 2, y0 = (C - h) / 2;
    g.filter = 'blur(1.5px)';
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(x0, y0 + h); g.lineTo(x0, y0 + w * 0.5); g.arc(C / 2, y0 + w * 0.5, w / 2, Math.PI, 0); g.lineTo(x0 + w, y0 + h); g.closePath(); g.fill();
    g.fillStyle = '#000';
    for (const fx of [0.5, 0.5 - 0.9 / 3.56, 0.5 + 0.9 / 3.56]) g.fillRect(x0 + w * fx - 2, y0, 4, h);
    for (let k = 1; k < 7; k++) g.fillRect(x0, y0 + h - (h * k) / 6.9, w, 3);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    moonSpot.map = tex;
    // 再铺一层很淡、很宽的冷光：靠窗这半间屋子整体都浸在月光里
    const wash = new THREE.SpotLight(0x9ab8ff, 1.6, 0, 0.62, 0.9, 0);
    wash.position.copy(moonSpot.position); wash.target.position.copy(BEAM_A).addScaledVector(LDIR, 4);
    scene.add(wash, wash.target);
  }
  scene.add(moonSpot, moonSpot.target);
  const moonFill = new THREE.PointLight(0x7aa8ff, 1.8, 0, 2); moonFill.position.set(0, 3.5, -4.5); scene.add(moonFill);
  const candleLight = new THREE.PointLight(0xffa050, 1.4, 0, 2); candleLight.position.copy(dW(0.3, -0.75, TOP + 0.6)); scene.add(candleLight);
  const crystalLight = new THREE.PointLight(0x5aa8ff, 0.35, 0, 2); crystalLight.position.copy(dW(-0.3, -0.6, TOP + 0.3)); scene.add(crystalLight);

  /* ---------------- 机位 ---------------- */
  const IDLE_POS = new V3(-2.2, 2.2, 4.5), IDLE_LOOK = new V3(0.1, 1.62, -1.2);
  const BOOK_POS = () => bookWorld().add(new V3(0.2, 1.0, 0.75));
  const camLook = new V3();

  /* ---------------- 每帧 ---------------- */
  let knFrame = 0, knClock = 0, nextTurn = 4, turning = -1, lastBurst = -10, lastRapid = -10;
  function update(dt, t, pose) {
    // pose: { k 镜头贴近书本 0→1, pow 书本能量, rapid 疯狂翻页, surge 整屋辉石涌向书, burst 书页炸开 }
    const k = pose.k, surge = pose.surge || 0;
    const breathe = new V3(Math.sin(t * 0.21) * 0.06, Math.sin(t * 0.33) * 0.04, 0);
    const shake = surge * 0.03;
    camera.position.copy(IDLE_POS).add(breathe).lerp(BOOK_POS(), k).add(new V3((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, 0));
    camLook.copy(IDLE_LOOK).lerp(bookWorld(), k);
    camera.up.set(Math.sin(k * 0.25) * 0.15, 1, 0).normalize();
    camera.lookAt(camLook);
    camera.fov = 38 - k * 8; camera.updateProjectionMatrix();
    if (api.debugCam) { const [p, l, f] = api.debugCam; camera.position.set(...p); camera.lookAt(...l); camera.fov = f; camera.updateProjectionMatrix(); }

    // 读书（0-7 帧循环，约 2.7 秒一口气）；隔几秒用右手翻一页（后面 12 帧，每帧 sitTurn.frameSec 秒），手里那页按同一组角度翻
    knClock += dt;
    const T0 = sitTurn.firstFrame, TN = sitTurn.phi.length;
    if (turning < 0 && t > nextTurn && pose.pow < 0.3) { turning = 0; knClock = 0; }
    if (turning >= 0) {
      if (knClock > (sitTurn.frameSec ?? 0.11)) { knClock = 0; turning++; }
      if (turning >= TN) { turning = -1; nextTurn = t + 6 + Math.random() * 4; handPage.visible = false; handPhi = 0; }
    }
    if (turning >= 0) {
      knFrame = T0 + turning;
      const target = sitTurn.phi[turning];
      if (target === null) handPhi = 0; else handPhi += (target - handPhi) * Math.min(1, dt * 25);
      handPage.visible = target !== null || handPhi > 0.001;
      if (handPage.visible) setPage(handPage.geometry, handPhi);
    } else knFrame = Math.floor(t * 3) % T0;
    orientKnight(knight, camera, KNIGHT_FACING, knFrame);
    setKnightLights(knight, [
      { pos: candleLight.position, color: [1.0, 0.7, 0.4], pow: 0.75, range: 4.5 },   // 书桌烛台：主角的暖光
      { pos: moonSpot.position, color: [0.75, 0.88, 1.0], pow: 0.45, range: 40 },
      { pos: bookLight.getWorldPosition(new V3()), color: [0.6, 0.85, 1.0], pow: 0.1 + pose.pow * 1.4, range: 2.5 },
      { pos: crystalLight.position, color: [0.4, 0.7, 1.0], pow: 0.25 + surge * 0.6, range: 2.5 },
    ]);
    setKnightRim(knight, moonSpot.position, 1.8 * (1 - 0.7 * k));        // 长窗的月光从他身后来
    placeQuietZone(knightQuiet, KNIGHT_CENTER, camera, 0.7);

    if (pose.rapid && t - lastRapid > 0.07) { lastRapid = t; flipPage(t, 0.36); }
    flips.forEach((f) => {
      const e = (t - f.t0) / f.dur;
      f.m.visible = e >= 0 && e <= 1;
      if (f.m.visible) setPage(f.m.geometry, e * e * (3 - 2 * e));
    });
    if (pose.burst && t - lastBurst > 1) { lastBurst = t; pageBurst.fire(t, bookWorld().add(new V3(0, 0.08, 0)), camera.position.clone().sub(bookWorld()).normalize()); }
    pageBurst.update(t);
    uBookPow.value = pose.pow; uSurge.value = surge;
    uBook.value.copy(bookWorld()).add(new V3(0, 0.03, 0));
    bookLight.intensity = 0.2 + pose.pow * 0.7;
    bookGlowMat.opacity = Math.min(1, pose.pow * 0.22);
    bookGlow.scale.setScalar(0.5 + pose.pow * 0.9);
    pageMat.emissiveIntensity = bookPageMat.emissiveIntensity = 0.03 + pose.pow * 0.1;
    // 醒来的程度：进塔转场里 surge 0 → 1，回书房时 1 → 0
    const awake = uAwake.value = Math.min(1, surge);
    sleepers.forEach((s) => s.c.copy(s.base).multiplyScalar(s.sleep + (1 - s.sleep) * awake));
    if (shieldMat) shieldMat.emissiveIntensity = 0.35 + awake * 1.25;
    glint.emissiveIntensity = 0.03 + surge * 2.05 + 0.01 * Math.sin(t * 2);
    orbMats.forEach((m) => { m.uniforms.uPow.value = 0.04 + surge * 1.76; });

    mini.userData.rings.forEach((r, i) => { r.rotation.z = t * (0.3 + i * 0.25); r.rotation.y += dt * 0.2 * (i + 1); });
    astroSpin += dt * (0.15 + awake * 0.85);                                   // 睡着时慢慢转，醒来转快
    astro.userData.spin[0].rotation.z = astroSpin * 0.2; astro.userData.spin[1].rotation.z = -astroSpin * 0.35;
    armillaries.forEach((sp, k) => sp.forEach((p, i) => { p.rotation.y = t * (0.08 + i * 0.05) * (i % 2 ? -1 : 1) + k; }));
    globe.rotation.y = t * 0.05;
    globe.children.forEach((c, i) => { if (c.userData.ring) c.rotation.z = t * 0.1 * (i % 2 ? 1 : -1); });
    stoneSpin += dt * (0.12 + surge * 5);                                     // 魔法石睡着时几乎停住
    floatStones.forEach((s) => {
      const a = s.a + stoneSpin * s.sp;
      s.st.position.set(s.center.x + Math.cos(a) * s.radius, s.center.y + s.h + Math.sin(t * 0.9 + s.a) * 0.06, s.center.z + Math.sin(a) * s.radius);
      s.st.rotation.set(t * 0.5 + s.a, t * 0.7, 0);
      s.ring.position.copy(s.st.position); s.ring.rotation.set(Math.PI / 2 + Math.sin(t + s.a) * 0.3, 0, t);
    });
    const fa = floaters.flames.attributes.position.array;
    floaters.forEach((f, i) => { const y = f.y + Math.sin(t * 0.5 + f.ph) * 0.2; f.c.position.set(f.x, y, f.z); fa.set([f.x, y + 0.22, f.z], i * 3); });
    floaters.flames.attributes.position.needsUpdate = true;
    candleLight.intensity = 1.3 + Math.sin(t * 9) * 0.12 + Math.sin(t * 23) * 0.06;
    moonSpot.intensity = 15 * (1 - 0.7 * k);                 // 镜头扎进书里时月光收一收，免得书页过曝
    glowLights.forEach((l, i) => { if (l.userData.base === undefined) l.userData.base = l.intensity; l.intensity = l.userData.base * (0.9 + 0.1 * Math.sin(t * (5 + i) + i)) * awake * (1 + surge * 1.5); });   // 宝箱和落地烛台的光：睡着时关
  }

  // debugCam: [[x,y,z], [lookX,lookY,lookZ], fov]，只在调试时从控制台设
  const api = {
    scene, camera, update, debugCam: null,
    focusWorld: () => knight.position.clone().add(new V3(0.4, 0.9, 0)),
    /** 坐着的骑士大致占的空间（风格检查、主角身后的安静区用）：脚底位置、头顶高度、半宽 */
    knightBox: () => ({ base: KNIGHT_POS, height: 1.55, halfWidth: 0.5 }),
    turnPage: () => { nextTurn = -1; },          // 调试：马上翻一页
    get turning() { return turning; },
    bookWorld,
  };
  return api;
}
