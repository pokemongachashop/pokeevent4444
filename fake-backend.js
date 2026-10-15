// 브라우저 스모크 테스트용 가짜 Firebase (개발 전용, 배포 불필요)
// 메모리 DB에 실제 database.rules.json 을 적용합니다. (tests/rules-sim.js)
import { createRulesDb } from '../rules-sim.js';

const rules = await (await fetch('/database.rules.json')).json();
let offset = 0;
export const now = () => Date.now() + offset;
export const db = createRulesDb(rules, { now });
export const auth = { uid: 'tester01' };

const infoListeners = new Set();
export function setOffset(ms) {
  offset = ms;
  infoListeners.forEach((fn) => fn());
}

export function snapshot(key, v) {
  const val = v === undefined ? null : JSON.parse(JSON.stringify(v));
  return {
    key,
    val: () => (val === null ? null : JSON.parse(JSON.stringify(val))),
    exists: () => val !== null,
    forEach(fn) {
      if (val && typeof val === 'object') for (const [k, c] of Object.entries(val)) fn(snapshot(k, c));
    },
  };
}

export function denied() {
  const e = new Error('PERMISSION_DENIED: permission_denied');
  e.code = 'PERMISSION_DENIED';
  return e;
}

/** onValue / onChild* 흉내. 읽기 권한이 없어지면 실제 Firebase 처럼 오류 콜백 후 해제 */
export function listen(path, kind, cb, onErr) {
  const key = path.split('/').filter(Boolean).pop() || null;
  if (path.startsWith('.info/')) {
    const fire = () => cb(snapshot(key, path === '.info/connected' ? true : offset));
    infoListeners.add(fire);
    setTimeout(fire, 0);
    return () => infoListeners.delete(fire);
  }
  let last;
  let dead = false;
  const known = new Map();
  const check = () => {
    if (dead) return;
    if (!db.canRead(auth.uid, path)) {
      dead = true;
      off();
      if (onErr) onErr(denied());
      return;
    }
    const v = db.get(path);
    if (kind === 'value') {
      const j = JSON.stringify(v);
      if (j !== last) {
        last = j;
        cb(snapshot(key, v));
      }
      return;
    }
    const cur = v && typeof v === 'object' ? v : {};
    for (const [k, c] of Object.entries(cur)) {
      const j = JSON.stringify(c);
      if (!known.has(k)) {
        known.set(k, j);
        if (kind === 'added') cb(snapshot(k, c));
      } else if (known.get(k) !== j) {
        known.set(k, j);
        if (kind === 'changed') cb(snapshot(k, c));
      }
    }
    for (const k of [...known.keys()]) {
      if (!(k in cur)) {
        known.delete(k);
        if (kind === 'removed') cb(snapshot(k, null));
      }
    }
  };
  const off = db.onChange(() => setTimeout(check, 0));
  setTimeout(check, 0);
  return () => {
    dead = true;
    off();
  };
}

export async function writeAs(uid, updates) {
  const r = db.update(uid, updates);
  if (!r.ok) {
    console.debug('규칙 거부 ' + JSON.stringify(r) + ' ' + Object.keys(updates).join(','));
    throw denied();
  }
}

window.__backend = { db, auth, now, setOffset, writeAs };
