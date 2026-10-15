// =====================================================================
// 포켓몬 숲 맵 데이터 (결정적 생성)
// ---------------------------------------------------------------------
// 같은 시드로 모든 참가자의 브라우저가 "완전히 같은" 맵을 만듭니다.
// 이 데이터로 3D 모델 배치, 충돌, 포획 시야(벽/나무/바위 차단) 판정을 합니다.
//
// 엔진마다 Math.sin/cos 결과의 마지막 자릿수가 다를 수 있으므로
// 배치 계산에는 삼각함수를 쓰지 않습니다. (Math.imul, 사칙연산, sqrt 만 사용)
//
// 장애물 형태:
//   circle  : { x, z, r }
//   capsule : { ax, az, bx, bz, r }   (두께가 있는 선분 = 바위 절벽/산울타리)
//   aabb    : { minX, maxX, minZ, maxZ } (축 정렬 상자 = 오두막/창고)
// =====================================================================

import { GAME_CONFIG, PROP_TYPES } from './config.js';

export const FOREST_MAP_ID = 'forest';

// 맵 설정: 사물 종류와 수량은 여기서 바꿉니다.
export const FOREST_SETTINGS = Object.freeze({
  seed: 20261015,
  name: '포켓몬 숲',
  treeCount: 70,
  bigRockCount: 9,
  clearingRadius: 8.5, // 중앙 공터(술래 시작 지점)
  propCounts: Object.freeze({
    barrel: 14,
    crate: 14,
    rock: 14,
    bush: 18,
    log: 10,
    pot: 10,
    mushroom: 12,
  }),
  // 굽이치는 메인 길 (남 → 북) 과 오두막으로 가는 갈림길
  paths: Object.freeze([
    Object.freeze([[0, -38], [4, -26], [-3, -16], [0, -6], [0, 0], [5, 8], [-2, 18], [5, 28], [3, 38]]),
    Object.freeze([[0, 0], [8, -4], [16.5, -9.5]]),
  ]),
  walls: Object.freeze([
    // [ax, az, bx, bz, 두께반경, 높이]
    [-20, -4, -10, -12, 1.0, 2.6],
    [6, 16, 18, 10, 1.0, 2.6],
    [-28, -18, -24, -28, 1.0, 2.8],
    [20, 18, 26, 26, 1.0, 2.6],
    [-12, 24, -3, 28, 1.0, 2.4],
    [24, -24, 30, -20, 1.0, 2.6],
    [-30, 0, -30, 10, 1.0, 2.8],
    [10, -20, 16, -28, 1.0, 2.6],
    [-18, 8, -12, 14, 0.9, 2.2],
  ]),
  buildings: Object.freeze([
    // 오두막 (문은 서쪽)
    Object.freeze({ id: 'hut', kind: 'hut', minX: 16.5, maxX: 23.5, minZ: -13, maxZ: -7, h: 3.8 }),
    // 창고
    Object.freeze({ id: 'shed', kind: 'shed', minX: -24, maxX: -20, minZ: 16, maxZ: 20, h: 2.9 }),
  ]),
});

// ---------------------------------------------------------------------
// 결정적 난수
// ---------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------
// 기하 유틸
// ---------------------------------------------------------------------
export function distPointSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + dx * t;
  const cz = az + dz * t;
  const ex = px - cx;
  const ez = pz - cz;
  return Math.sqrt(ex * ex + ez * ez);
}

function closestOnSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return [ax + dx * t, az + dz * t];
}

function segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function distSegmentSegment(ax, az, bx, bz, cx, cz, dx, dz) {
  if (segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz)) return 0;
  return Math.min(
    distPointSegment(ax, az, cx, cz, dx, dz),
    distPointSegment(bx, bz, cx, cz, dx, dz),
    distPointSegment(cx, cz, ax, az, bx, bz),
    distPointSegment(dx, dz, ax, az, bx, bz)
  );
}

function segmentHitsAabb(ax, az, bx, bz, minX, maxX, minZ, maxZ) {
  // 슬랩(slab) 방식
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  const axes = [
    [dx, ax, minX, maxX],
    [dz, az, minZ, maxZ],
  ];
  for (const [d, p, lo, hi] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (p < lo || p > hi) return false;
    } else {
      let ta = (lo - p) / d;
      let tb = (hi - p) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
  }
  return true;
}

/** 점에서 장애물 표면까지의 거리 (내부면 음수) */
export function distToObstacle(o, x, z) {
  if (o.shape === 'circle') {
    const dx = x - o.x;
    const dz = z - o.z;
    return Math.sqrt(dx * dx + dz * dz) - o.r;
  }
  if (o.shape === 'capsule') {
    return distPointSegment(x, z, o.ax, o.az, o.bx, o.bz) - o.r;
  }
  // aabb
  const cx = Math.max(o.minX, Math.min(x, o.maxX));
  const cz = Math.max(o.minZ, Math.min(z, o.maxZ));
  if (cx === x && cz === z) {
    return -Math.min(x - o.minX, o.maxX - x, z - o.minZ, o.maxZ - z);
  }
  const dx = x - cx;
  const dz = z - cz;
  return Math.sqrt(dx * dx + dz * dz);
}

function obstacleBounds(o) {
  if (o.shape === 'circle') return [o.x - o.r, o.x + o.r, o.z - o.r, o.z + o.r];
  if (o.shape === 'capsule') {
    return [
      Math.min(o.ax, o.bx) - o.r,
      Math.max(o.ax, o.bx) + o.r,
      Math.min(o.az, o.bz) - o.r,
      Math.max(o.az, o.bz) + o.r,
    ];
  }
  return [o.minX, o.maxX, o.minZ, o.maxZ];
}

// ---------------------------------------------------------------------
// 길 (Catmull-Rom 보간, 다항식만 사용)
// ---------------------------------------------------------------------
function samplePath(points, stepsPerSegment = 8) {
  const out = [];
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];
    for (let s = 0; s < stepsPerSegment; s++) {
      const t = s / stepsPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a, b, c, d) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push([points[n - 1][0], points[n - 1][1]]);
  return out;
}

function distToPolyline(poly, x, z) {
  let best = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const d = distPointSegment(x, z, poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1]);
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------
// 맵 생성
// ---------------------------------------------------------------------
let cachedMap = null;

/** 맵을 한 번만 생성해 재사용합니다. */
export function getForestMap() {
  if (!cachedMap) cachedMap = buildForestMap();
  return cachedMap;
}

export function buildForestMap(settings = FOREST_SETTINGS) {
  const rng = mulberry32(settings.seed);
  const half = GAME_CONFIG.MAP_HALF_SIZE;
  const rand = (lo, hi) => lo + (hi - lo) * rng();

  const map = {
    id: FOREST_MAP_ID,
    name: settings.name,
    half,
    obstacles: [], // 충돌 대상 전부
    blockers: [], // 시야 차단 대상 (포획 검증에 사용)
    trees: [],
    bigRocks: [],
    walls: [],
    buildings: [],
    props: [], // 변신 가능한 일반 사물
    paths: settings.paths.map((p) => samplePath(p)),
    spawns: { seekers: [], hiders: [] },
    propCounts: { ...settings.propCounts },
  };

  const addObstacle = (o) => {
    map.obstacles.push(o);
    if (o.blocksSight) map.blockers.push(o);
    return o;
  };

  // 1) 건물
  for (const b of settings.buildings) {
    const o = addObstacle({ id: b.id, kind: b.kind, shape: 'aabb', minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, h: b.h, blocksSight: true });
    map.buildings.push(o);
  }

  // 2) 바위 절벽 (시야 차단 지형)
  settings.walls.forEach((w, i) => {
    const o = addObstacle({ id: `wall${i}`, kind: 'wall', shape: 'capsule', ax: w[0], az: w[1], bx: w[2], bz: w[3], r: w[4], h: w[5], blocksSight: true });
    map.walls.push(o);
  });

  const nearPath = (x, z) => Math.min(...map.paths.map((p) => distToPolyline(p, x, z)));
  const clearOf = (x, z, r, margin) => {
    for (const o of map.obstacles) {
      if (distToObstacle(o, x, z) < r + margin) return false;
    }
    return true;
  };
  const inBounds = (x, z, pad) => x > -half + pad && x < half - pad && z > -half + pad && z < half - pad;
  const outsideClearing = (x, z, extra = 0) => x * x + z * z > (settings.clearingRadius + extra) ** 2;

  // 3) 큰 바위 (시야 차단)
  for (let tries = 0; map.bigRocks.length < settings.bigRockCount && tries < 2000; tries++) {
    const x = rand(-half + 3, half - 3);
    const z = rand(-half + 3, half - 3);
    const r = rand(1.2, 1.8);
    if (!outsideClearing(x, z, 2) || nearPath(x, z) < r + 2.2 || !clearOf(x, z, r, 2.2)) continue;
    const o = addObstacle({ id: `bigrock${map.bigRocks.length}`, kind: 'bigrock', shape: 'circle', x, z, r, h: rand(1.6, 2.4), blocksSight: true, rot: rng() * Math.PI * 2, variant: rng() });
    map.bigRocks.push(o);
  }

  // 4) 나무 (줄기가 시야 차단)
  for (let tries = 0; map.trees.length < settings.treeCount && tries < 5000; tries++) {
    const x = rand(-half + 1.5, half - 1.5);
    const z = rand(-half + 1.5, half - 1.5);
    const r = 0.45;
    if (!outsideClearing(x, z, 0.5) || nearPath(x, z) < 2.6 || !clearOf(x, z, r, 1.6)) continue;
    const o = addObstacle({
      id: `tree${map.trees.length}`,
      kind: 'tree',
      shape: 'circle',
      x,
      z,
      r,
      h: 4,
      blocksSight: true,
      variant: rng() < 0.55 ? 'round' : 'pine',
      scale: rand(0.85, 1.25),
      rot: rng() * Math.PI * 2,
    });
    map.trees.push(o);
  }

  // 5) 변신 가능한 사물
  const placeProp = (type, x, z) => {
    const def = PROP_TYPES[type];
    const o = addObstacle({
      id: `p${map.props.length}`,
      kind: 'prop',
      propType: type,
      shape: 'circle',
      x,
      z,
      r: def.radius,
      h: def.height,
      blocksSight: false,
      rot: rng() * Math.PI * 2,
    });
    map.props.push(o);
  };
  const propOk = (type, x, z) => {
    const r = PROP_TYPES[type].radius;
    return inBounds(x, z, 2) && outsideClearing(x, z, -1) && nearPath(x, z) > 1.9 + r && clearOf(x, z, r, 0.75);
  };
  const tryNear = (type, cx, cz, rMin, rMax, attempts = 80) => {
    for (let i = 0; i < attempts; i++) {
      const x = cx + rand(-rMax, rMax);
      const z = cz + rand(-rMax, rMax);
      const dx = x - cx;
      const dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < rMin * rMin || d2 > rMax * rMax) continue;
      if (propOk(type, x, z)) {
        placeProp(type, x, z);
        return true;
      }
    }
    return false;
  };
  const tryAnywhere = (type, attempts = 600) => {
    for (let i = 0; i < attempts; i++) {
      const x = rand(-half + 2, half - 2);
      const z = rand(-half + 2, half - 2);
      if (propOk(type, x, z)) {
        placeProp(type, x, z);
        return true;
      }
    }
    return false;
  };
  const tryNearPath = (type, attempts = 300) => {
    const main = map.paths[0];
    for (let i = 0; i < attempts; i++) {
      const p = main[Math.floor(rng() * main.length)];
      if (tryNear(type, p[0], p[1], 2.6, 4.2, 4)) return true;
    }
    return false;
  };

  const hut = map.buildings[0];
  const shed = map.buildings[1];
  const hutC = [(hut.minX + hut.maxX) / 2, (hut.minZ + hut.maxZ) / 2];
  const shedC = [(shed.minX + shed.maxX) / 2, (shed.minZ + shed.maxZ) / 2];

  const counts = settings.propCounts;
  const plan = [];
  // 무리 배치 (자연스러운 섞임을 위해 같은 종류끼리 모아 둡니다)
  for (let i = 0; i < Math.min(6, counts.barrel); i++) plan.push(['barrel', 'hut']);
  for (let i = 0; i < Math.min(2, counts.barrel - 6); i++) plan.push(['barrel', 'shed']);
  for (let i = 0; i < Math.min(5, counts.crate); i++) plan.push(['crate', 'shed']);
  for (let i = 0; i < Math.min(4, counts.crate - 5); i++) plan.push(['crate', 'hut']);
  for (let i = 0; i < Math.min(4, counts.pot); i++) plan.push(['pot', 'hut']);
  for (let i = 0; i < Math.ceil(counts.log / 2); i++) plan.push(['log', 'path']);
  const planned = {};
  for (const [t] of plan) planned[t] = (planned[t] || 0) + 1;
  for (const type of Object.keys(counts)) {
    for (let i = 0; i < counts[type] - (planned[type] || 0); i++) plan.push([type, 'any']);
  }
  for (const [type, where] of plan) {
    let ok = false;
    if (where === 'hut') ok = tryNear(type, hutC[0], hutC[1], 4.6, 7.5);
    else if (where === 'shed') ok = tryNear(type, shedC[0], shedC[1], 3.2, 6);
    else if (where === 'path') ok = tryNearPath(type);
    if (!ok) tryAnywhere(type);
  }

  // 6) 시작 지점
  map.spawns.seekers = [
    [-1.4, 0],
    [1.4, 0],
    [0, 1.4],
  ];
  for (let tries = 0; map.spawns.hiders.length < GAME_CONFIG.MAX_PLAYERS && tries < 4000; tries++) {
    const x = rand(-7, 7);
    const z = rand(-7, 7);
    const d2 = x * x + z * z;
    if (d2 < 4.2 * 4.2 || d2 > 7 * 7) continue;
    if (!clearOf(x, z, GAME_CONFIG.PLAYER_RADIUS, 0.2)) continue;
    if (map.spawns.hiders.some(([sx, sz]) => (sx - x) ** 2 + (sz - z) ** 2 < 1.3 * 1.3)) continue;
    map.spawns.hiders.push([x, z]);
  }

  buildGrid(map);
  return map;
}

// ---------------------------------------------------------------------
// 공간 격자 (충돌 질의를 빠르게)
// ---------------------------------------------------------------------
const CELL = 4;
function buildGrid(map) {
  const n = Math.ceil((map.half * 2 + 8) / CELL);
  const offset = map.half + 4;
  const cells = new Array(n * n);
  for (let i = 0; i < cells.length; i++) cells[i] = [];
  const clampCell = (v) => Math.max(0, Math.min(n - 1, Math.floor((v + offset) / CELL)));
  map.obstacles.forEach((o, idx) => {
    o.index = idx;
    const [x0, x1, z0, z1] = obstacleBounds(o);
    for (let cx = clampCell(x0); cx <= clampCell(x1); cx++) {
      for (let cz = clampCell(z0); cz <= clampCell(z1); cz++) cells[cz * n + cx].push(o);
    }
  });
  let stamp = 1;
  const marks = new Uint32Array(map.obstacles.length);
  map.queryObstacles = (x, z, radius, out = []) => {
    out.length = 0;
    stamp++;
    for (let cx = clampCell(x - radius); cx <= clampCell(x + radius); cx++) {
      for (let cz = clampCell(z - radius); cz <= clampCell(z + radius); cz++) {
        for (const o of cells[cz * n + cx]) {
          if (marks[o.index] !== stamp) {
            marks[o.index] = stamp;
            out.push(o);
          }
        }
      }
    }
    return out;
  };
}

// ---------------------------------------------------------------------
// 충돌 처리 (클라이언트 이동용)
// extraCircles: [{x, z, r}] 변신한 플레이어 등 동적 원형 충돌체
// ---------------------------------------------------------------------
const scratch = [];
export function resolveCollision(map, x, z, radius, extraCircles = null) {
  for (let iter = 0; iter < 3; iter++) {
    const list = map.queryObstacles(x, z, radius + 2, scratch);
    let moved = false;
    const handle = (o) => {
      let px;
      let pz;
      let limit = radius;
      if (o.shape === 'circle') {
        px = o.x;
        pz = o.z;
        limit = radius + o.r;
      } else if (o.shape === 'capsule') {
        [px, pz] = closestOnSegment(x, z, o.ax, o.az, o.bx, o.bz);
        limit = radius + o.r;
      } else {
        const inside = x > o.minX && x < o.maxX && z > o.minZ && z < o.maxZ;
        if (inside) {
          const dl = x - o.minX;
          const dr = o.maxX - x;
          const db = z - o.minZ;
          const dt = o.maxZ - z;
          const m = Math.min(dl, dr, db, dt);
          if (m === dl) x = o.minX - radius;
          else if (m === dr) x = o.maxX + radius;
          else if (m === db) z = o.minZ - radius;
          else z = o.maxZ + radius;
          moved = true;
          return;
        }
        px = Math.max(o.minX, Math.min(x, o.maxX));
        pz = Math.max(o.minZ, Math.min(z, o.maxZ));
      }
      const dx = x - px;
      const dz = z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < limit * limit) {
        const d = Math.sqrt(d2);
        if (d < 1e-6) {
          x += limit;
        } else {
          x = px + (dx / d) * limit;
          z = pz + (dz / d) * limit;
        }
        moved = true;
      }
    };
    for (const o of list) handle(o);
    if (extraCircles) for (const c of extraCircles) handle({ shape: 'circle', x: c.x, z: c.z, r: c.r });
    const lim = map.half - radius;
    if (x < -lim) x = -lim;
    if (x > lim) x = lim;
    if (z < -lim) z = -lim;
    if (z > lim) z = lim;
    if (!moved) break;
  }
  return [x, z];
}

// ---------------------------------------------------------------------
// 시야(Line of Sight) 판정 - 술래의 조준 표시와 포획 전 검사에 사용
// ---------------------------------------------------------------------
const LOS_EPS = 0.05;
export function hasLineOfSight(map, ax, az, bx, bz) {
  for (const o of map.blockers) {
    if (o.shape === 'circle') {
      if (distPointSegment(o.x, o.z, ax, az, bx, bz) < o.r - LOS_EPS) return false;
    } else if (o.shape === 'capsule') {
      if (distSegmentSegment(ax, az, bx, bz, o.ax, o.az, o.bx, o.bz) < o.r - LOS_EPS) return false;
    } else if (
      segmentHitsAabb(ax, az, bx, bz, o.minX + LOS_EPS, o.maxX - LOS_EPS, o.minZ + LOS_EPS, o.maxZ - LOS_EPS)
    ) {
      return false;
    }
  }
  return true;
}

/** 카메라 충돌용: (x, y, z) 지점이 높이를 가진 장애물 내부인지 */
export function pointBlocked(map, x, y, z, margin = 0.25) {
  const list = map.queryObstacles(x, z, margin + 2, scratch);
  for (const o of list) {
    if (!o.blocksSight) continue;
    if (y > o.h + 0.2) continue;
    if (distToObstacle(o, x, z) < margin) return true;
  }
  return false;
}

/** 각도 차이 (라디안, 0 ~ PI) */
export function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d < -Math.PI) d += Math.PI * 2;
  if (d > Math.PI) d -= Math.PI * 2;
  return Math.abs(d);
}

/** 게임 좌표계의 yaw: 0 = +Z 방향, 시계 반대가 아닌 atan2(dx, dz) 규약 */
export function yawTo(ax, az, bx, bz) {
  return Math.atan2(bx - ax, bz - az);
}
