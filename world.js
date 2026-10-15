// =====================================================================
// 3D 월드 (Three.js): 맵, 캐릭터, 사물, 카메라, 효과
// ---------------------------------------------------------------------
// 모든 모델은 Three.js 기본 도형으로 직접 만든 테스트 모델입니다.
// (공식 포켓몬 모델/이미지를 포함하지 않습니다)
// 나중에 GLB 모델로 교체하려면 아래 MODEL_OVERRIDES 를 채우세요. README "모델 교체" 참고.
// =====================================================================

import * as THREE from 'three';
import { PROP_TYPES, CHARACTERS } from './shared/config.js';
import { pointBlocked, mulberry32, distToObstacle } from './shared/forest-map.js';

/**
 * GLB 모델 교체 설정 (선택)
 * 예) characters: { volt: { url: './assets/volt.glb', scale: 0.9, y: 0 } }
 *     props: { barrel: { url: './assets/barrel.glb', scale: 1, y: 0 } }
 * 사물 모델을 바꿀 때는 shared/config.js 의 PROP_TYPES radius/height 도 실제 크기에 맞추세요.
 * 비워 두면 아래 기본 테스트 모델을 사용합니다.
 */
export const MODEL_OVERRIDES = {
  characters: {},
  props: {},
};

// 불러온 GLB 부품 (preloadModelOverrides 가 채움)
const LOADED = { characters: {}, props: {} };

async function loadOverrideParts(GLTFLoader, spec) {
  const gltf = await new GLTFLoader().loadAsync(spec.url);
  gltf.scene.updateMatrixWorld(true);
  const base = new THREE.Matrix4().compose(
    new THREE.Vector3(0, spec.y || 0, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, spec.rotY || 0, 0)),
    new THREE.Vector3().setScalar(spec.scale || 1)
  );
  const parts = [];
  gltf.scene.traverse((o) => {
    if (o.isMesh) parts.push({ g: o.geometry, m: o.material, local: base.clone().multiply(o.matrixWorld) });
  });
  return parts;
}

/**
 * MODEL_OVERRIDES 에 적힌 GLB 를 미리 불러옵니다. (World 생성 전에 한 번 호출)
 * 정적(애니메이션 없는) 모델만 지원합니다. 실패한 모델은 기본 테스트 모델로 대체됩니다.
 */
export async function preloadModelOverrides() {
  const jobs = [];
  const groups = [
    ['characters', MODEL_OVERRIDES.characters],
    ['props', MODEL_OVERRIDES.props],
  ];
  if (!groups.some(([, g]) => Object.keys(g).length)) return;
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  for (const [kind, specs] of groups) {
    for (const [id, spec] of Object.entries(specs)) {
      jobs.push(
        loadOverrideParts(GLTFLoader, spec)
          .then((parts) => {
            if (parts.length) LOADED[kind][id] = parts;
          })
          .catch((e) => console.warn(`모델 불러오기 실패 (${kind}/${id}): 기본 모델 사용`, e))
      );
    }
  }
  await Promise.all(jobs);
}

export const QUALITY_PRESETS = {
  low: { label: '낮음', pixelRatio: 1, shadows: false, shadowSize: 512, decor: 0.35 },
  medium: { label: '중간', pixelRatio: 1.5, shadows: true, shadowSize: 1024, decor: 0.7 },
  high: { label: '높음', pixelRatio: 2, shadows: true, shadowSize: 2048, decor: 1 },
};

const C = {
  sky: 0xbfe6f5,
  fog: 0xcfeadb,
  grass: 0x8ccf68,
  grassDark: 0x6fb556,
  hill: 0x5f9e4c,
  path: 0xe6cf9a,
  trunk: 0x8a5a36,
  leaf: 0x63bf5c,
  leafDark: 0x3f9e4e,
  pine: 0x3f8f5c,
  rock: 0xa9adb6,
  rockDark: 0x8b8f99,
  wood: 0xc98b50,
  woodDark: 0x8e5a2e,
  metal: 0x6d6a66,
  terracotta: 0xd9774a,
  soil: 0x5b3b22,
  cream: 0xfbeed3,
  roof: 0xc4553f,
  capRed: 0xe2574c,
  white: 0xffffff,
  black: 0x2b2a33,
  bush: 0x58b34f,
  window: 0x9ed4ee,
  seekerHat: 0xd84a3e,
};

// ---------------------------------------------------------------------
// 공유 지오메트리/머티리얼 캐시 (같은 모양은 한 번만 만들고 재사용)
// ---------------------------------------------------------------------
const geoCache = new Map();
const matCache = new Map();
function geo(key, make) {
  if (!geoCache.has(key)) geoCache.set(key, make());
  return geoCache.get(key);
}
function mat(color, flat = false) {
  const key = `${color}-${flat}`;
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshLambertMaterial({ color, flatShading: flat }));
  return matCache.get(key);
}
const cyl = (rt, rb, h, s = 12) => geo(`cyl${rt}-${rb}-${h}-${s}`, () => new THREE.CylinderGeometry(rt, rb, h, s));
const box = (w, h, d) => geo(`box${w}-${h}-${d}`, () => new THREE.BoxGeometry(w, h, d));
const sph = (r, ws = 14, hs = 10) => geo(`sph${r}-${ws}-${hs}`, () => new THREE.SphereGeometry(r, ws, hs));
const ico = (r, d = 1) => geo(`ico${r}-${d}`, () => new THREE.IcosahedronGeometry(r, d));
const dode = (r) => geo(`dode${r}`, () => new THREE.DodecahedronGeometry(r, 0));
const cone = (r, h, s = 8) => geo(`cone${r}-${h}-${s}`, () => new THREE.ConeGeometry(r, h, s));

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();

function localMatrix(pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) {
  tmpE.set(rot[0], rot[1], rot[2]);
  tmpQ.setFromEuler(tmpE);
  return new THREE.Matrix4().compose(new THREE.Vector3(...pos), tmpQ.clone(), new THREE.Vector3(...scale));
}
const part = (g, m, pos, rot, scale) => ({ g, m, local: localMatrix(pos, rot, scale) });

// ---------------------------------------------------------------------
// 변신 가능한 사물 모델 (맵 배치용 InstancedMesh 와 변신 플레이어가 "같은" 부품을 사용)
// 치수는 shared/config.js PROP_TYPES 의 radius/height 와 맞춰져 있습니다.
// ---------------------------------------------------------------------
function buildPropParts() {
  const wood = mat(C.wood);
  const woodDark = mat(C.woodDark);
  const rock = mat(C.rock, true);
  const rockDark = mat(C.rockDark, true);
  const bush = mat(C.bush, true);
  const leafDark = mat(C.leafDark, true);
  return {
    barrel: [
      part(cyl(0.44, 0.41, 1.0, 14), wood, [0, 0.5, 0]),
      part(cyl(0.455, 0.455, 0.07, 14), mat(C.metal), [0, 0.2, 0]),
      part(cyl(0.455, 0.455, 0.07, 14), mat(C.metal), [0, 0.8, 0]),
      part(cyl(0.39, 0.39, 0.04, 14), woodDark, [0, 1.01, 0]),
    ],
    crate: [
      part(box(0.84, 0.84, 0.84), wood, [0, 0.43, 0]),
      part(box(0.9, 0.1, 0.9), woodDark, [0, 0.06, 0]),
      part(box(0.9, 0.1, 0.9), woodDark, [0, 0.82, 0]),
      part(box(0.1, 0.84, 0.1), woodDark, [0.41, 0.43, 0.41]),
      part(box(0.1, 0.84, 0.1), woodDark, [-0.41, 0.43, 0.41]),
      part(box(0.1, 0.84, 0.1), woodDark, [0.41, 0.43, -0.41]),
      part(box(0.1, 0.84, 0.1), woodDark, [-0.41, 0.43, -0.41]),
    ],
    rock: [
      part(dode(0.6), rock, [0, 0.33, 0], [0.3, 0.5, 0], [1, 0.68, 0.92]),
      part(dode(0.28), rockDark, [0.32, 0.18, 0.2], [0.6, 0.2, 0.1]),
    ],
    bush: [
      part(ico(0.55, 1), bush, [0, 0.47, 0]),
      part(ico(0.42, 1), bush, [0.34, 0.36, 0.16]),
      part(ico(0.4, 1), bush, [-0.3, 0.38, -0.2]),
      part(ico(0.34, 1), leafDark, [0.02, 0.78, 0.04]),
    ],
    log: [
      part(cyl(0.3, 0.3, 1.25, 12), mat(C.trunk), [0, 0.3, 0], [0, 0, Math.PI / 2]),
      part(cyl(0.26, 0.26, 0.02, 12), mat(0xe2b77f), [0.63, 0.3, 0], [0, 0, Math.PI / 2]),
      part(cyl(0.26, 0.26, 0.02, 12), mat(0xe2b77f), [-0.63, 0.3, 0], [0, 0, Math.PI / 2]),
      part(ico(0.12, 0), mat(C.leaf, true), [0.2, 0.6, 0.05]),
    ],
    pot: [
      part(cyl(0.34, 0.25, 0.46, 12), mat(C.terracotta), [0, 0.23, 0]),
      part(cyl(0.38, 0.38, 0.08, 12), mat(C.terracotta), [0, 0.46, 0]),
      part(cyl(0.31, 0.31, 0.02, 12), mat(C.soil), [0, 0.5, 0]),
      part(ico(0.22, 1), mat(C.leaf, true), [0, 0.62, 0]),
      part(sph(0.07, 8, 6), mat(0xffd84d), [0.08, 0.76, 0.05]),
    ],
    mushroom: [
      part(cyl(0.11, 0.15, 0.5, 10), mat(C.cream), [0, 0.25, 0]),
      part(
        geo('mushcap', () => new THREE.SphereGeometry(0.38, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2)),
        mat(C.capRed),
        [0, 0.44, 0]
      ),
      part(sph(0.06, 8, 6), mat(C.white), [0.17, 0.73, 0.1]),
      part(sph(0.05, 8, 6), mat(C.white), [-0.15, 0.7, 0.16]),
      part(sph(0.05, 8, 6), mat(C.white), [0.02, 0.8, -0.15]),
    ],
  };
}

// ---------------------------------------------------------------------
// 캐릭터 (직접 만든 테스트 캐릭터)
// ---------------------------------------------------------------------
function buildAvatar(characterId, isSeeker) {
  const ch = CHARACTERS.find((c) => c.id === characterId) || CHARACTERS[0];
  const body = mat(new THREE.Color(ch.color).getHex());
  const accent = mat(new THREE.Color(ch.accent).getHex());
  const g = new THREE.Group();
  g.rotation.order = 'YXZ'; // 바라보는 방향(Y) 기준으로 앞으로 숙이는 포획 동작(X)
  const custom = LOADED.characters[characterId];
  if (custom) {
    for (const p of custom) {
      const m = new THREE.Mesh(p.g, p.m);
      p.local.decompose(m.position, m.quaternion, m.scale);
      m.castShadow = true;
      g.add(m);
    }
    if (isSeeker) {
      const hat = new THREE.Mesh(geo('scarf', () => new THREE.TorusGeometry(0.3, 0.06, 6, 16)), mat(C.seekerHat));
      hat.position.y = 0.82;
      hat.rotation.x = Math.PI / 2;
      g.add(hat);
    }
    return g;
  }
  const add = (geometry, material, pos, rot = [0, 0, 0], scale = [1, 1, 1]) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(...pos);
    m.rotation.set(...rot);
    m.scale.set(...scale);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  const torso = add(sph(0.42), body, [0, 0.55, 0], [0, 0, 0], [1, 0.95, 0.9]);
  const head = add(sph(0.36), body, [0, 1.08, 0.02]);
  add(cone(0.11, 0.36, 7), body, [0.2, 1.42, 0], [0, 0, -0.38]);
  add(cone(0.11, 0.36, 7), body, [-0.2, 1.42, 0], [0, 0, 0.38]);
  add(cone(0.06, 0.13, 7), accent, [0.265, 1.585, 0], [0, 0, -0.38]);
  add(cone(0.06, 0.13, 7), accent, [-0.265, 1.585, 0], [0, 0, 0.38]);
  add(sph(0.055, 8, 6), mat(C.black), [0.13, 1.12, 0.31]);
  add(sph(0.055, 8, 6), mat(C.black), [-0.13, 1.12, 0.31]);
  add(sph(0.02, 6, 4), mat(C.white), [0.115, 1.14, 0.36]);
  add(sph(0.02, 6, 4), mat(C.white), [-0.145, 1.14, 0.36]);
  add(sph(0.07, 8, 6), accent, [0.24, 0.99, 0.25], [0, 0, 0], [1, 1, 0.5]);
  add(sph(0.07, 8, 6), accent, [-0.24, 0.99, 0.25], [0, 0, 0], [1, 1, 0.5]);
  add(sph(0.1, 8, 6), body, [0.39, 0.62, 0.1]);
  add(sph(0.1, 8, 6), body, [-0.39, 0.62, 0.1]);
  add(sph(0.13, 8, 6), accent, [0.17, 0.11, 0.08], [0, 0, 0], [1, 0.6, 1.2]);
  add(sph(0.13, 8, 6), accent, [-0.17, 0.11, 0.08], [0, 0, 0], [1, 0.6, 1.2]);
  add(box(0.12, 0.34, 0.08), accent, [0, 0.62, -0.44], [-0.7, 0, 0]);
  add(box(0.18, 0.26, 0.08), accent, [0, 0.86, -0.55], [0.4, 0, 0]);
  if (isSeeker) {
    const red = mat(C.seekerHat);
    add(geo('hatcap', () => new THREE.SphereGeometry(0.34, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2)), red, [0, 1.3, 0.0], [0, 0, 0], [1, 0.7, 1]);
    add(box(0.42, 0.04, 0.24), red, [0, 1.31, 0.32]);
    add(geo('scarf', () => new THREE.TorusGeometry(0.3, 0.06, 6, 16)), red, [0, 0.82, 0], [Math.PI / 2, 0, 0]);
  }
  g.userData.torso = torso;
  g.userData.head = head;
  return g;
}

// ---------------------------------------------------------------------
// 이름표
// ---------------------------------------------------------------------
function makeLabel(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = '600 30px "Noto Sans KR", sans-serif';
  const w = Math.min(248, ctx.measureText(text).width + 28);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  const x = (256 - w) / 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, 10, w, 44, 22);
  else ctx.rect(x, 10, w, 44);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 33, 230);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(1.7, 0.425, 1);
  return sprite;
}

function disposeLabel(sprite) {
  if (!sprite) return;
  sprite.material.map.dispose();
  sprite.material.dispose();
}

// =====================================================================
export class World {
  constructor(canvas, map, quality = 'medium') {
    this.map = map;
    this.canvas = canvas;
    this.qualityKey = QUALITY_PRESETS[quality] ? quality : 'medium';
    const q = QUALITY_PRESETS[this.qualityKey];
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.qualityKey !== 'low', powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(C.sky);
    this.scene.fog = new THREE.Fog(C.fog, 38, 105);

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 220);
    this.camera.position.set(0, 8, -10);

    this.hemi = new THREE.HemisphereLight(0xe3f4ff, 0x6d9a52, 1.25);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1d8, 2.3);
    this.sun.position.set(18, 30, 10);
    this.sun.castShadow = q.shadows;
    this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
    const sc = this.sun.shadow.camera;
    sc.left = -26;
    sc.right = 26;
    sc.top = 26;
    sc.bottom = -26;
    sc.near = 1;
    sc.far = 80;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.propParts = { ...buildPropParts(), ...LOADED.props };
    this.players = new Map(); // uid -> { group, key, label, labelKey, moving }
    this.effects = [];
    this.clock = 0;
    this.mapGroup = new THREE.Group();
    this.scene.add(this.mapGroup);
    this.buildMap();
    this.resize();
  }

  // -------------------------------------------------------------------
  setQuality(key) {
    if (!QUALITY_PRESETS[key]) return;
    this.qualityKey = key;
    const q = QUALITY_PRESETS[key];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
    this.sun.castShadow = q.shadows;
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
    this.scene.traverse((o) => {
      if (o.material) o.material.needsUpdate = true;
    });
    if (this.decor) this.decor.forEach((m) => (m.count = Math.floor(m.userData.full * q.decor)));
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  // -------------------------------------------------------------------
  // 맵 구성
  // -------------------------------------------------------------------
  buildMap() {
    const map = this.map;
    const g = this.mapGroup;
    const rng = mulberry32(777); // 장식 전용 난수 (게임 판정과 무관)

    // 지면 (플레이 영역 바깥은 언덕)
    const size = 170;
    const ground = new THREE.PlaneGeometry(size, size, 85, 85);
    ground.rotateX(-Math.PI / 2);
    const pos = ground.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const cA = new THREE.Color(C.grass);
    const cB = new THREE.Color(C.grassDark);
    const cH = new THREE.Color(C.hill);
    const tmpC = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const edge = Math.max(Math.abs(x), Math.abs(z)) - (map.half + 3);
      const n = Math.sin(x * 0.21) * Math.cos(z * 0.17) * 0.5 + Math.sin(x * 0.05 + z * 0.07) * 0.5;
      let y = 0;
      if (edge > 0) y = edge * 0.45 + Math.max(0, n) * edge * 0.25;
      pos.setY(i, y);
      tmpC.copy(cA).lerp(cB, 0.5 + n * 0.5);
      if (edge > 0) tmpC.lerp(cH, Math.min(1, edge / 6));
      colors[i * 3] = tmpC.r;
      colors[i * 3 + 1] = tmpC.g;
      colors[i * 3 + 2] = tmpC.b;
    }
    ground.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    ground.computeVertexNormals();
    const groundMesh = new THREE.Mesh(ground, new THREE.MeshLambertMaterial({ vertexColors: true }));
    groundMesh.receiveShadow = true;
    g.add(groundMesh);

    // 길
    const pathMat = new THREE.MeshLambertMaterial({ color: C.path, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    for (const poly of map.paths) {
      const w = 1.35;
      const verts = [];
      const idx = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[Math.max(0, i - 1)];
        const b = poly[Math.min(poly.length - 1, i + 1)];
        let tx = b[0] - a[0];
        let tz = b[1] - a[1];
        const l = Math.hypot(tx, tz) || 1;
        tx /= l;
        tz /= l;
        const [x, z] = poly[i];
        verts.push(x - tz * w, 0.02, z + tx * w, x + tz * w, 0.02, z - tx * w);
        if (i > 0) {
          const k = i * 2;
          idx.push(k - 2, k, k - 1, k - 1, k, k + 1); // 위쪽을 향하는 면
        }
      }
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      pg.setIndex(idx);
      pg.computeVertexNormals();
      const pm = new THREE.Mesh(pg, pathMat);
      pm.receiveShadow = true;
      g.add(pm);
    }

    // 나무 (게임 판정용 나무 + 경계 바깥 장식 나무)
    const trees = map.trees.map((t) => ({ x: t.x, z: t.z, s: t.scale, rot: t.rot, variant: t.variant }));
    for (let i = 0; i < 150; i++) {
      const side = Math.floor(rng() * 4);
      const along = (rng() * 2 - 1) * (map.half + 10);
      const out = map.half + 2.5 + rng() * 10;
      const [x, z] = side === 0 ? [along, out] : side === 1 ? [along, -out] : side === 2 ? [out, along] : [-out, along];
      trees.push({ x, z, s: 0.9 + rng() * 0.6, rot: rng() * 6.28, variant: rng() < 0.5 ? 'round' : 'pine', outside: true });
    }
    const treeParts = {
      round: [
        part(cyl(0.26, 0.36, 2.2, 8), mat(C.trunk), [0, 1.1, 0]),
        part(ico(1.45, 1), mat(C.leaf, true), [0, 2.95, 0], [0, 0, 0], [1, 0.9, 1]),
        part(ico(1.0, 1), mat(C.leaf, true), [0.5, 3.75, 0.2]),
      ],
      pine: [
        part(cyl(0.22, 0.32, 1.6, 8), mat(C.trunk), [0, 0.8, 0]),
        part(cone(1.55, 2.2, 8), mat(C.pine, true), [0, 2.3, 0]),
        part(cone(1.15, 1.8, 8), mat(C.pine, true), [0, 3.4, 0]),
        part(cone(0.75, 1.4, 8), mat(C.pine, true), [0, 4.35, 0]),
      ],
    };
    for (const variant of ['round', 'pine']) {
      const list = trees.filter((t) => t.variant === variant);
      this.addInstanced(treeParts[variant], list.map((t) => this.placeMatrix(t.x, t.z, t.rot, t.s, t.outside ? groundHeight(t.x, t.z, map.half) : 0)), {
        tint: (pi) => (pi > 0 ? 0.88 + rng() * 0.24 : 1),
      });
    }

    // 큰 바위
    const bigRockParts = [part(dode(1), mat(C.rock, true), [0, 0.5, 0]), part(dode(0.45), mat(C.rockDark, true), [0.7, 0.25, 0.3])];
    this.addInstanced(
      bigRockParts,
      map.bigRocks.map((r) => new THREE.Matrix4().compose(tmpV.set(r.x, 0, r.z).clone(), tmpQ.setFromEuler(tmpE.set(0, r.rot, 0)).clone(), tmpS.set(r.r * 1.05, r.h, r.r * 1.05).clone()))
    );

    // 바위 절벽
    const wallMat = mat(C.rock, true);
    const wallDark = mat(C.rockDark, true);
    const boulderA = [];
    const boulderB = [];
    for (const w of map.walls) {
      const dx = w.bx - w.ax;
      const dz = w.bz - w.az;
      const len = Math.hypot(dx, dz);
      const ang = Math.atan2(dx, dz);
      const body = new THREE.Mesh(box(w.r * 2, w.h, len), wallMat);
      body.position.set((w.ax + w.bx) / 2, w.h / 2, (w.az + w.bz) / 2);
      body.rotation.y = ang;
      const capA = new THREE.Mesh(cyl(w.r, w.r * 1.05, w.h, 9), wallMat);
      capA.position.set(w.ax, w.h / 2, w.az);
      const capB = capA.clone();
      capB.position.set(w.bx, w.h / 2, w.bz);
      for (const m of [body, capA, capB]) {
        m.castShadow = true;
        m.receiveShadow = true;
        g.add(m);
      }
      const n = Math.max(2, Math.floor(len / 1.6));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const sc = 0.6 + rng() * 0.5;
        tmpE.set(rng() * 3, rng() * 3, 0);
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(w.ax + dx * t + (rng() - 0.5) * 0.6, w.h - 0.1 + rng() * 0.3, w.az + dz * t + (rng() - 0.5) * 0.6),
          new THREE.Quaternion().setFromEuler(tmpE),
          new THREE.Vector3(sc, sc, sc)
        );
        (rng() < 0.5 ? boulderA : boulderB).push(m);
      }
    }
    // 절벽 위 바위 덩어리는 InstancedMesh 두 개로 그립니다 (그리기 호출 절약)
    this.addInstanced([part(dode(1), wallMat)], boulderA);
    this.addInstanced([part(dode(1), wallDark)], boulderB);

    // 건물
    for (const b of map.buildings) this.buildBuilding(b);

    // 변신 가능한 사물 (맵 배치)
    for (const type of Object.keys(this.propParts)) {
      const list = map.props.filter((p) => p.propType === type);
      if (!list.length) continue;
      this.addInstanced(this.propParts[type], list.map((p) => this.placeMatrix(p.x, p.z, p.rot, 1)));
    }

    // 장식: 풀과 꽃 (충돌/판정 없음)
    this.decor = [];
    const tufts = [];
    const flowers = [];
    for (let i = 0; i < 700; i++) {
      const x = (rng() * 2 - 1) * (map.half - 1);
      const z = (rng() * 2 - 1) * (map.half - 1);
      if (map.queryObstacles(x, z, 1).some((o) => distToObstacle(o, x, z) < 0.35)) continue;
      if (rng() < 0.82) tufts.push(this.placeMatrix(x, z, rng() * 6.28, 0.7 + rng() * 0.6));
      else flowers.push(this.placeMatrix(x, z, 0, 0.8 + rng() * 0.5));
    }
    const tuftParts = [
      part(cone(0.07, 0.36, 4), mat(C.grassDark, true), [0, 0.18, 0]),
      part(cone(0.06, 0.28, 4), mat(C.leaf, true), [0.09, 0.14, 0.04], [0, 0, -0.3]),
      part(cone(0.06, 0.3, 4), mat(C.leaf, true), [-0.08, 0.15, -0.03], [0, 0, 0.3]),
    ];
    const flowerParts = [part(cyl(0.015, 0.015, 0.3, 4), mat(C.leafDark), [0, 0.15, 0]), part(sph(0.07, 6, 4), mat(0xffffff), [0, 0.32, 0])];
    this.decor.push(...this.addInstanced(tuftParts, tufts, { shadows: false }));
    const flowerMeshes = this.addInstanced(flowerParts, flowers, { shadows: false });
    const petal = [0xffe066, 0xff8fab, 0xffffff, 0xb197fc];
    flowers.forEach((_, i) => flowerMeshes[1].setColorAt(i, new THREE.Color(petal[i % petal.length])));
    if (flowerMeshes[1].instanceColor) flowerMeshes[1].instanceColor.needsUpdate = true;
    this.decor.push(...flowerMeshes);
    const dq = QUALITY_PRESETS[this.qualityKey].decor;
    this.decor.forEach((m) => {
      m.userData.full = m.count;
      m.count = Math.floor(m.count * dq);
    });
  }

  buildBuilding(b) {
    const g = new THREE.Group();
    const w = b.maxX - b.minX;
    const d = b.maxZ - b.minZ;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const add = (geometry, material, x, y, z, ry = 0) => {
      const m = new THREE.Mesh(geometry, material);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    if (b.kind === 'hut') {
      const wallH = 2.8;
      add(box(w, wallH, d), mat(C.cream), cx, wallH / 2, cz);
      // 사각뿔 지붕: 반지름 √½ 인 4각 원뿔을 45° 돌리면 1×1 바닥이 되고, 이를 건물 크기로 늘립니다.
      const roofGeo = new THREE.ConeGeometry(Math.SQRT1_2, 1.7, 4);
      roofGeo.rotateY(Math.PI / 4);
      roofGeo.scale(w + 0.9, 1, d + 0.9);
      add(roofGeo, mat(C.roof, true), cx, wallH + 0.85, cz);
      add(box(0.12, 1.9, 1.3), mat(C.woodDark), b.minX - 0.04, 0.95, cz);
      add(box(0.1, 0.8, 1.0), mat(C.window), b.minX - 0.04, 1.6, cz - 2);
      add(box(0.1, 0.8, 1.0), mat(C.window), b.minX - 0.04, 1.6, cz + 2);
      add(box(1.2, 0.8, 0.1), mat(C.window), cx, 1.6, b.minZ - 0.04);
      add(box(0.6, 1.4, 0.6), mat(C.rockDark, true), cx + 1.8, wallH + 1.3, cz + 1.2);
      add(box(w + 0.1, 0.25, d + 0.1), mat(C.woodDark), cx, 0.12, cz);
    } else {
      add(box(w, 2.2, d), mat(C.wood), cx, 1.1, cz);
      const roof = add(box(w + 0.6, 0.22, d + 0.8), mat(C.woodDark), cx, 2.45, cz);
      roof.rotation.x = 0.16;
      add(box(1.4, 1.7, 0.1), mat(C.woodDark), cx, 0.85, b.maxZ + 0.04);
    }
    this.mapGroup.add(g);
  }

  placeMatrix(x, z, rot, s, y = 0) {
    tmpE.set(0, rot, 0);
    tmpQ.setFromEuler(tmpE);
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), tmpQ.clone(), new THREE.Vector3(s, s, s));
  }

  /** 부품 목록 × 배치 행렬 목록 → 부품마다 InstancedMesh 하나 */
  addInstanced(parts, matrices, { shadows = true, tint = null } = {}) {
    const meshes = [];
    parts.forEach((p, pi) => {
      const im = new THREE.InstancedMesh(p.g, p.m, Math.max(1, matrices.length));
      im.count = matrices.length;
      matrices.forEach((m, i) => {
        tmpM.multiplyMatrices(m, p.local);
        im.setMatrixAt(i, tmpM);
        if (tint) {
          const k = tint(pi);
          if (k !== 1) im.setColorAt(i, new THREE.Color(k, k, k));
        }
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = shadows;
      im.receiveShadow = shadows;
      im.computeBoundingSphere();
      this.mapGroup.add(im);
      meshes.push(im);
    });
    return meshes;
  }

  buildPropGroup(type) {
    const g = new THREE.Group();
    for (const p of this.propParts[type] || []) {
      const m = new THREE.Mesh(p.g, p.m);
      p.local.decompose(m.position, m.quaternion, m.scale);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    }
    return g;
  }

  // -------------------------------------------------------------------
  // 플레이어 표시
  // desc: { mode: 'avatar'|'prop'|'hidden', character, seeker, propType, label, labelColor }
  // -------------------------------------------------------------------
  setPlayerVisual(uid, desc) {
    let p = this.players.get(uid);
    const key = desc.mode === 'avatar' ? `a:${desc.character}:${desc.seeker ? 1 : 0}` : desc.mode === 'prop' ? `p:${desc.propType}` : 'hidden';
    if (!p) {
      p = { group: new THREE.Group(), key: null, label: null, labelKey: null, model: null, lunge: 0, moving: false };
      this.scene.add(p.group);
      this.players.set(uid, p);
    }
    if (p.key !== key) {
      if (p.model) p.group.remove(p.model);
      p.model = null;
      if (desc.mode === 'avatar') p.model = buildAvatar(desc.character, desc.seeker);
      else if (desc.mode === 'prop') p.model = this.buildPropGroup(desc.propType);
      if (p.model) p.group.add(p.model);
      p.key = key;
    }
    const labelKey = desc.label ? `${desc.label}|${desc.labelColor}` : null;
    if (p.labelKey !== labelKey) {
      if (p.label) {
        p.group.remove(p.label);
        disposeLabel(p.label);
      }
      p.label = labelKey ? makeLabel(desc.label, desc.labelColor || '#333') : null;
      if (p.label) {
        p.label.position.y = desc.mode === 'prop' ? 1.5 : 2.0;
        p.group.add(p.label);
      }
      p.labelKey = labelKey;
    }
    p.group.visible = desc.mode !== 'hidden';
  }

  setPlayerTransform(uid, x, z, yaw, moving) {
    const p = this.players.get(uid);
    if (!p) return;
    p.group.position.set(x, 0, z);
    if (p.model) p.model.rotation.y = yaw;
    p.moving = moving;
  }

  removePlayer(uid) {
    const p = this.players.get(uid);
    if (!p) return;
    this.scene.remove(p.group);
    disposeLabel(p.label);
    this.players.delete(uid);
  }

  clearPlayers() {
    for (const uid of [...this.players.keys()]) this.removePlayer(uid);
  }

  playLunge(uid) {
    const p = this.players.get(uid);
    if (p) p.lunge = 0.28;
  }

  // -------------------------------------------------------------------
  // 효과
  // -------------------------------------------------------------------
  spawnCaptureEffect(x, z) {
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xfff2a8, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(geo('fxring', () => new THREE.RingGeometry(0.35, 0.5, 32).rotateX(-Math.PI / 2)), ringMat);
    ring.position.set(x, 0.08, z);
    this.scene.add(ring);
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, depthWrite: false });
    const sparks = [];
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Mesh(geo('fxspark', () => new THREE.OctahedronGeometry(0.09)), sparkMat);
      const a = (i / 14) * Math.PI * 2;
      s.position.set(x, 0.6, z);
      s.userData.v = new THREE.Vector3(Math.sin(a) * 3, 2.5 + (i % 3), Math.cos(a) * 3);
      this.scene.add(s);
      sparks.push(s);
    }
    this.effects.push({ t: 0, life: 0.7, ring, sparks, mats: [ringMat, sparkMat] });
  }

  // -------------------------------------------------------------------
  // 카메라: 3인칭, 장애물 안으로 들어가지 않게 당겨옴
  // -------------------------------------------------------------------
  updateCamera(tx, ty, tz, yaw, pitch, dist, shoulder = 0.55) {
    const cp = Math.cos(pitch);
    const fx = Math.sin(yaw) * cp;
    const fy = -Math.sin(pitch);
    const fz = Math.cos(yaw) * cp;
    const rx = -Math.cos(yaw);
    const rz = Math.sin(yaw);
    const ox = tx + rx * shoulder;
    const oz = tz + rz * shoulder;
    let d = dist;
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      const k = (dist * i) / steps;
      const px = ox - fx * k;
      const py = ty - fy * k;
      const pz = oz - fz * k;
      if (pointBlocked(this.map, px, py, pz, 0.3)) {
        d = Math.max(0.6, (dist * (i - 1)) / steps);
        break;
      }
    }
    let cy = ty - fy * d;
    if (cy < 0.35) cy = 0.35;
    this.camera.position.set(ox - fx * d, cy, oz - fz * d);
    this.camera.lookAt(ox + fx * 10, ty + fy * 10, oz + fz * 10);
  }

  getAimRay() {
    const origin = this.camera.position.clone();
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    return { origin, dir };
  }

  // -------------------------------------------------------------------
  update(dt, focusX = 0, focusZ = 0) {
    this.clock += dt;
    // 그림자 카메라를 관심 지점 근처로
    this.sun.position.set(focusX + 18, 30, focusZ + 10);
    this.sun.target.position.set(focusX, 0, focusZ);

    for (const p of this.players.values()) {
      if (!p.model || p.key.startsWith('p:')) continue;
      const ud = p.model.userData;
      const bob = p.moving ? Math.abs(Math.sin(this.clock * 11)) * 0.08 : Math.sin(this.clock * 2) * 0.015;
      if (ud.torso) ud.torso.position.y = 0.55 + bob;
      if (ud.head) ud.head.position.y = 1.08 + bob * 1.2;
      if (p.lunge > 0) {
        p.lunge = Math.max(0, p.lunge - dt);
        const k = Math.sin((1 - p.lunge / 0.28) * Math.PI);
        p.model.rotation.x = 0.35 * k;
      } else if (p.model.rotation.x !== 0) {
        p.model.rotation.x = 0;
      }
    }

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.t += dt;
      const k = e.t / e.life;
      e.ring.scale.setScalar(1 + k * 5);
      e.ring.material.opacity = 1 - k;
      for (const s of e.sparks) {
        s.userData.v.y -= 9 * dt;
        s.position.addScaledVector(s.userData.v, dt);
        s.rotation.y += dt * 8;
      }
      e.sparks[0].material.opacity = 1 - k;
      if (k >= 1) {
        this.scene.remove(e.ring);
        e.sparks.forEach((s) => this.scene.remove(s));
        e.mats.forEach((m) => m.dispose());
        this.effects.splice(i, 1);
      }
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.clearPlayers();
    this.renderer.dispose();
    geoCache.forEach((g) => g.dispose());
    matCache.forEach((m) => m.dispose());
    geoCache.clear();
    matCache.clear();
  }
}

function groundHeight(x, z, half) {
  const edge = Math.max(Math.abs(x), Math.abs(z)) - (half + 3);
  return edge > 0 ? edge * 0.45 : 0;
}
