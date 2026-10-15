// 스모크 테스트에서 CDN 모듈 대신 돌려주는 가짜 모듈 소스 (개발 전용)
const B = 'http://localhost:8765/tests/browser/fake-backend.js';

export const firebaseApp = `export function initializeApp(cfg){ return { cfg }; }`;

export const firebaseAuth = `
import { auth } from '${B}';
export function getAuth(){ return {}; }
export function initializeAuth(){ return {}; }
export const inMemoryPersistence = {};
export const browserLocalPersistence = {};
export function onAuthStateChanged(a, cb){ setTimeout(() => cb({ uid: auth.uid }), 10); return () => {}; }
export async function signInAnonymously(){ return { user: { uid: auth.uid } }; }
export function connectAuthEmulator(){}
`;

export const firebaseDatabase = `
import { listen, db, auth, snapshot, denied, writeAs } from '${B}';
export function getDatabase(){ return {}; }
export function connectDatabaseEmulator(){}
export function ref(d, path = ''){ return { path, key: path.split('/').filter(Boolean).pop() || null }; }
const join = (base, p) => [base, p].filter(Boolean).join('/');
export async function update(r, updates){
  const full = {};
  for (const [k, v] of Object.entries(updates)) full[join(r.path, k)] = v;
  return writeAs(auth.uid, full);
}
export async function set(r, v){ return writeAs(auth.uid, { [r.path]: v }); }
export async function get(r){
  if (!db.canRead(auth.uid, r.path)) throw denied();
  let v = db.get(r.path);
  if (r.limit && v && typeof v === 'object') {
    const entries = Object.entries(v).sort((a, b) => ((a[1] || {})[r.orderBy] || 0) - ((b[1] || {})[r.orderBy] || 0)).slice(-r.limit);
    v = Object.fromEntries(entries);
  }
  return snapshot(r.key, v);
}
export function onValue(r, cb, err){ return listen(r.path, 'value', cb, err); }
export function onChildAdded(r, cb, err){ return listen(r.path, 'added', cb, err); }
export function onChildChanged(r, cb, err){ return listen(r.path, 'changed', cb, err); }
export function onChildRemoved(r, cb, err){ return listen(r.path, 'removed', cb, err); }
export function onDisconnect(r){ return { set: async () => {}, remove: async () => {}, cancel: async () => {} }; }
export function serverTimestamp(){ return { '.sv': 'timestamp' }; }
export function query(r, ...c){ const q = { ...r }; for (const x of c) Object.assign(q, x); return q; }
export function orderByChild(k){ return { orderBy: k }; }
export function limitToLast(n){ return { limit: n }; }
`;

// three.js 대체: 어떤 속성/호출도 받아 주는 Proxy (렌더링 없이 게임 로직만 실행)
export const threeStub = `
function any(){
  const f = function(){};
  return new Proxy(f, {
    get(t, p){
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === 'then') return undefined;
      if (p === 'children') { if (!t.__c) t.__c = []; return t.__c; }
      if (!(p in t)) t[p] = any();
      return t[p];
    },
    set(t, p, v){ t[p] = v; return true; },
    apply(){ return any(); },
    construct(){ return any(); },
  });
}
${[
  'WebGLRenderer', 'Scene', 'Color', 'Fog', 'PerspectiveCamera', 'HemisphereLight', 'DirectionalLight', 'Group',
  'Matrix4', 'Quaternion', 'Euler', 'Vector3', 'MeshLambertMaterial', 'MeshBasicMaterial', 'CylinderGeometry',
  'BoxGeometry', 'SphereGeometry', 'IcosahedronGeometry', 'DodecahedronGeometry', 'ConeGeometry', 'TorusGeometry',
  'RingGeometry', 'OctahedronGeometry', 'PlaneGeometry', 'BufferGeometry', 'BufferAttribute', 'Float32BufferAttribute',
  'Mesh', 'InstancedMesh', 'Sprite', 'SpriteMaterial', 'CanvasTexture', 'PCFSoftShadowMap', 'SRGBColorSpace', 'DoubleSide',
].map((n) => `export const ${n} = any();`).join('\n')}
`;
