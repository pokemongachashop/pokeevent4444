// =====================================================================
// Realtime Database 보안 규칙 시뮬레이터 (개발/테스트 전용)
// ---------------------------------------------------------------------
// database.rules.json 의 .read/.write/.validate 식을 JavaScript 로 평가해
// "이 다중 경로 업데이트가 허용되는가"를 확인합니다.
// Firebase 의 실제 규칙 엔진과 100% 같지는 않으므로, 배포 전에 Firebase 에뮬레이터
// (README 8단계)나 콘솔의 규칙 플레이그라운드로 한 번 더 확인하는 것을 권장합니다.
// 브라우저 스모크 테스트와 Node 테스트가 함께 사용합니다.
// =====================================================================

// 규칙 식에서 쓰는 문자열 메서드
for (const [name, fn] of [
  ['matches', function (re) { return re.test(String(this)); }],
  ['beginsWith', function (s) { return String(this).startsWith(s); }],
  ['contains', function (s) { return String(this).includes(s); }],
]) {
  if (!String.prototype[name]) Object.defineProperty(String.prototype, name, { value: fn, configurable: true, writable: true });
}

const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const split = (p) => String(p || '').split('/').filter(Boolean);

function getAt(tree, parts) {
  let cur = tree;
  for (const k of parts) {
    if (cur === null || typeof cur !== 'object' || !(k in cur)) return null;
    cur = cur[k];
  }
  return cur === undefined ? null : cur;
}

function prune(v) {
  if (v === null || typeof v !== 'object') return v;
  for (const k of Object.keys(v)) {
    const c = prune(v[k]);
    if (c === null || c === undefined) delete v[k];
    else v[k] = c;
  }
  return Object.keys(v).length ? v : null;
}

function setAt(tree, parts, value) {
  if (!parts.length) return clone(value) || {};
  tree = tree && typeof tree === 'object' ? tree : {};
  let cur = tree;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = clone(value);
  return prune(tree) || {};
}

class Snap {
  constructor(tree, parts) {
    this.tree = tree;
    this.parts = parts;
  }
  child(p) {
    if (typeof p !== 'string' || !p.length) throw new Error('child() 인자는 문자열이어야 합니다');
    return new Snap(this.tree, [...this.parts, ...split(p)]);
  }
  parent() {
    if (!this.parts.length) throw new Error('루트의 parent()');
    return new Snap(this.tree, this.parts.slice(0, -1));
  }
  val() {
    const v = getAt(this.tree, this.parts);
    return v !== null && typeof v === 'object' ? clone(v) : v;
  }
  exists() {
    return getAt(this.tree, this.parts) !== null;
  }
  hasChildren(list) {
    const v = getAt(this.tree, this.parts);
    if (v === null || typeof v !== 'object') return false;
    if (!list) return Object.keys(v).length > 0;
    return list.every((k) => getAt(v, split(k)) !== null);
  }
  hasChild(k) {
    return this.child(k).exists();
  }
  isNumber() {
    return typeof getAt(this.tree, this.parts) === 'number';
  }
  isString() {
    return typeof getAt(this.tree, this.parts) === 'string';
  }
  isBoolean() {
    return typeof getAt(this.tree, this.parts) === 'boolean';
  }
}

const fnCache = new Map();
function evalRule(expr, ctx) {
  if (expr === true || expr === false) return expr;
  if (typeof expr !== 'string') return false;
  const names = Object.keys(ctx.vars);
  const key = expr + '|' + names.join(',');
  let fn = fnCache.get(key);
  if (!fn) {
    fn = new Function('root', 'data', 'newData', 'auth', 'now', ...names, `return (${expr});`);
    fnCache.set(key, fn);
  }
  try {
    return fn(ctx.root, ctx.data, ctx.newData, ctx.auth, ctx.now, ...names.map((n) => ctx.vars[n])) === true;
  } catch {
    return false;
  }
}

function matchChild(node, key) {
  if (!node || typeof node !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(node, key) && !key.startsWith('.')) return { node: node[key], varName: null };
  const v = Object.keys(node).find((k) => k.startsWith('$'));
  return v ? { node: node[v], varName: v } : null;
}

function resolveServerValues(v, now) {
  if (v && typeof v === 'object') {
    if (v['.sv'] === 'timestamp') return now;
    const out = Array.isArray(v) ? [] : {};
    for (const [k, c] of Object.entries(v)) out[k] = resolveServerValues(c, now);
    return out;
  }
  return v;
}

export function createRulesDb(rulesJson, { now = () => Date.now(), initial = {} } = {}) {
  const rules = rulesJson.rules;
  let tree = clone(initial) || {};
  const listeners = new Set();

  function ctxFor(oldTree, newTree, parts, vars, uid, t) {
    return {
      root: new Snap(oldTree, []),
      data: new Snap(oldTree, parts),
      newData: new Snap(newTree, parts),
      auth: uid ? { uid } : null,
      now: t,
      vars,
    };
  }

  function canRead(uid, path) {
    const parts = split(path);
    let node = rules;
    const vars = {};
    const t = now();
    for (let i = 0; i <= parts.length; i++) {
      const loc = parts.slice(0, i);
      if (node['.read'] !== undefined && evalRule(node['.read'], ctxFor(tree, tree, loc, vars, uid, t))) return true;
      if (i === parts.length) break;
      const m = matchChild(node, parts[i]);
      if (!m) return false;
      if (m.varName) vars[m.varName] = parts[i];
      node = m.node;
    }
    return false;
  }

  function writeAllowed(oldTree, newTree, parts, uid, t) {
    let node = rules;
    const vars = {};
    for (let i = 0; i <= parts.length; i++) {
      const loc = parts.slice(0, i);
      if (node['.write'] !== undefined && evalRule(node['.write'], ctxFor(oldTree, newTree, loc, vars, uid, t))) return true;
      if (i === parts.length) break;
      const m = matchChild(node, parts[i]);
      if (!m) return false;
      if (m.varName) vars[m.varName] = parts[i];
      node = m.node;
    }
    return false;
  }

  function validateTree(oldTree, newTree, uid, t, failures) {
    const walk = (node, parts, vars) => {
      const o = getAt(oldTree, parts);
      const n = getAt(newTree, parts);
      if (n === null || JSON.stringify(o) === JSON.stringify(n)) return;
      if (node && node['.validate'] !== undefined && !evalRule(node['.validate'], ctxFor(oldTree, newTree, parts, vars, uid, t))) {
        failures.push('/' + parts.join('/'));
      }
      if (typeof n !== 'object') return;
      for (const k of Object.keys(n)) {
        const m = matchChild(node, k);
        if (!m) continue;
        walk(m.node, [...parts, k], m.varName ? { ...vars, [m.varName]: k } : vars);
      }
    };
    walk(rules, [], {});
  }

  /** 다중 경로 업데이트. 반환: { ok, denied: [경로], invalid: [경로] } */
  function update(uid, updates) {
    const t = now();
    let next = clone(tree) || {};
    const entries = Object.entries(updates).map(([p, v]) => [split(p), resolveServerValues(v, t)]);
    for (const [parts, v] of entries) next = setAt(next, parts, v);
    const denied = entries.filter(([parts]) => !writeAllowed(tree, next, parts, uid, t)).map(([p]) => '/' + p.join('/'));
    const invalid = [];
    if (!denied.length) validateTree(tree, next, uid, t, invalid);
    const ok = !denied.length && !invalid.length;
    if (ok) {
      tree = next;
      listeners.forEach((fn) => fn());
    }
    return { ok, denied, invalid };
  }

  return {
    update,
    set: (uid, path, value) => update(uid, { [path]: value }),
    canRead,
    get: (path) => clone(getAt(tree, split(path))),
    /** 규칙을 거치지 않는 직접 쓰기 (테스트 준비용 / 서버 동작 흉내: onDisconnect 등) */
    force(path, value) {
      tree = setAt(tree, split(path), resolveServerValues(value, now()));
      listeners.forEach((fn) => fn());
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dump: () => clone(tree),
  };
}
