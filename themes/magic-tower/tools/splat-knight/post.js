// The pixel pass: a 2x supersampled render of hard-edged splats -> pixel art in the knight's own palette.
// Adapted from cobanov/pixelart-gaussiansplat src/render/post.js (MIT): coverage by 2x2 samples, colour by vote,
// so a pixel never becomes the average of two materials. The outline follows the sprite pipeline instead of a
// generic "darker ink": an edge pixel drops to its own ramp's step 0 (step 1 when it is lit), like the
// sprite shader's outline flag.
import * as THREE from 'three';

export function createPost(palette, steps) {
  const n = palette.length;
  const uniforms = {
    source: { value: null },
    lowRes: { value: new THREE.Vector2(1, 1) },
    pixelSize: { value: 1 },
    outline: { value: 1 },
    background: { value: new THREE.Color() },
    palette: { value: palette.map((hex) => new THREE.Color(hex)) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */`
      precision highp float;
      uniform sampler2D source;
      uniform vec2 lowRes;
      uniform float pixelSize, outline;
      uniform vec3 background;
      uniform vec3 palette[${n}];
      const float SOLID = 0.95;
      const int STEPS = ${steps};

      // one source texel, back in display space (Spark linearises splat colours into a render target)
      vec4 texel(vec2 t) {
        vec4 s = texture2D(source, (t + 0.5) / (lowRes * 2.0));
        if (s.a > 0.0) s.rgb = pow(max(s.rgb / s.a, 0.0), vec3(1.0 / 2.2)) * s.a;
        return s;
      }
      float coverage(vec2 cell) {
        if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= lowRes.x || cell.y >= lowRes.y) return 0.0;
        vec2 t = cell * 2.0;
        return 0.25 * (step(SOLID, texel(t).a) + step(SOLID, texel(t + vec2(1.0, 0.0)).a)
                     + step(SOLID, texel(t + vec2(0.0, 1.0)).a) + step(SOLID, texel(t + vec2(1.0, 1.0)).a));
      }
      int nearest(vec3 c) {
        int best = 0; float bd = 1e9;
        for (int i = 0; i < ${n}; i++) {
          vec3 e = c - palette[i];
          float d = dot(e * vec3(0.30, 0.59, 0.11), e * vec3(0.30, 0.59, 0.11)) + 0.25 * dot(e, e);
          if (d < bd) { bd = d; best = i; }
        }
        return best;
      }
      void main() {
        vec2 cell = floor(gl_FragCoord.xy / pixelSize);
        int lab[4];
        int solid = 0;
        for (int i = 0; i < 4; i++) {
          vec4 s = texel(cell * 2.0 + vec2(float(i - (i / 2) * 2), float(i / 2)));
          lab[i] = -1;
          if (s.a > SOLID) { lab[i] = nearest(s.rgb / s.a); solid++; }
        }
        if (solid < 2) { gl_FragColor = vec4(background, 1.0); return; }
        int best = -1, score = 0;
        for (int i = 0; i < 4; i++) {
          if (lab[i] < 0) continue;
          int c = 0;
          for (int j = 0; j < 4; j++) if (lab[j] == lab[i]) c++;
          if (c > score) { score = c; best = lab[i]; }
        }
        if (outline > 0.5) {
          int k = int(coverage(cell + vec2(1.0, 0.0)) >= 0.5) + int(coverage(cell - vec2(1.0, 0.0)) >= 0.5)
                + int(coverage(cell + vec2(0.0, 1.0)) >= 0.5) + int(coverage(cell - vec2(0.0, 1.0)) >= 0.5);
          if (k > 0 && k < 4) {
            int ramp = best / STEPS, st = best - ramp * STEPS;
            best = ramp * STEPS + (st >= 3 ? 1 : 0);
          }
        }
        gl_FragColor = vec4(palette[best], 1.0);
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.Camera();
  return {
    uniforms,
    render(renderer, texture) {
      uniforms.source.value = texture;
      renderer.render(scene, camera);
    },
  };
}
