// =====================================================================
// 포켓몬 숨바꼭질 3D - 메인 클라이언트 (Firebase Spark 무료 요금제용)
// ---------------------------------------------------------------------
// 서버 코드(Cloud Functions) 없이 동작합니다.
//   - 모든 게임 동작은 shared/actions.js 가 만든 "다중 경로 업데이트" 한 번으로 기록
//   - database.rules.json(보안 규칙)이 역할·시간·이동 속도·포획 거리·쿨다운·중복·전적을 검사
//   - 규칙에 맞지 않는 쓰기는 통째로 거부됨
//   - 시간 종료·연결 끊김 처리처럼 "누군가 해야 하는 일"은 방장(없으면 참가자) 브라우저가 수행
// =====================================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  initializeAuth,
  inMemoryPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  signInAnonymously,
  connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  onValue,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onDisconnect,
  serverTimestamp,
  query,
  orderByChild,
  limitToLast,
  connectDatabaseEmulator,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js';

import { firebaseConfig, USE_EMULATORS, EMULATOR } from './firebase-config.js';
import {
  GAME_CONFIG as GC,
  SCORE_CONFIG,
  CHARACTERS,
  PROP_TYPES,
  PROP_TYPE_IDS,
  ROOM_CODE_ALPHABET,
  normalizeNickname,
  normalizeRoomCode,
  nicknameKey,
  seekerCountFor,
  compareLeaderboard,
  computeRoundResults,
} from './shared/config.js';
import { getForestMap, resolveCollision, hasLineOfSight, angleDiff } from './shared/forest-map.js';
import * as A from './shared/actions.js';
import { World, QUALITY_PRESETS, preloadModelOverrides } from './world.js';
import { Controls } from './controls.js';

// ---------------------------------------------------------------------
// 도우미
// ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round2 = (v) => Math.round(v * 100) / 100;
const wrapAngle = (a) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};
const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;
const fmtTime = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtLong = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}시간 ${m}분 ${s}초` : m ? `${m}분 ${s}초` : `${s}초`;
};
const LS = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* 저장 공간을 쓸 수 없는 환경 */
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* 무시 */
    }
  },
};
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(message)), ms);
    }),
  ]);
}

const PARAMS = new URLSearchParams(location.search);
// 테스트용: 클라이언트 사전 검사(거리/시야/일반 사물)를 건너뛰고 보안 규칙의 거부를 직접 확인
const DEBUG_SERVER_CAPTURE = PARAMS.has('debugCapture');

const map = getForestMap();
const isTouchDevice = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

// ---------------------------------------------------------------------
// 상태
// ---------------------------------------------------------------------
const fb = { app: null, auth: null, db: null };
const settings = {
  quality: LS.get('phs.quality', 'auto'),
  sensitivity: LS.get('phs.sensitivity', 1),
  invertY: LS.get('phs.invertY', false),
};

const S = {
  uid: null,
  nickname: LS.get('phs.nickname', ''),
  character: LS.get('phs.character', CHARACTERS[0].id),
  connected: false,
  serverOffset: 0,
  roomId: null,
  meta: null,
  players: {},
  round: null,
  presence: {}, // uid -> { online, at }
  pos: new Map(), // uid -> {x,z,r,t}  (DB 값)
  remote: new Map(), // uid -> {x,z,r,moving} (화면 보간 값)
  unsubs: [],
  presenceRef: null,
  joinedOnce: false,
  rejoining: false,
  leaving: false,
  me: { x: 0, z: 0, yaw: 0, ready: false, moving: false },
  cam: { yaw: 0, pitch: 0.32, dist: 5.2 },
  lastSent: { x: 0, z: 0, r: 0, at: 0 },
  posInFlight: 0,
  lastPosResync: 0,
  aim: null,
  capturePending: false,
  captureCooldownUntil: 0,
  disguisePending: false,
  disguiseCooldownUntil: 0,
  spectateUid: null,
  dutyAt: 0,
  dutyBusy: false,
  tried: new Map(), // 같은 정리 작업을 너무 자주 시도하지 않도록
  recorded: new Set(),
  bannerUntil: 0,
  screen: 'loading',
  inGame: false,
};

let world = null;
let controls = null;
let minimapBg = null;

const TS = () => serverTimestamp();
const serverNow = () => Date.now() + S.serverOffset;
const myPlayer = () => (S.players ? S.players[S.uid] : null);
const isHost = () => !!(S.meta && S.meta.hostId === S.uid);
const roundActive = () => !!(S.meta && S.meta.status === 'playing' && S.round && S.round.phase === 'playing');
const isSeeker = (uid = S.uid) => !!(S.round && S.round.seekers && S.round.seekers[uid]);
const isHider = (uid = S.uid) => !!(S.round && S.round.hiders && S.round.hiders[uid]);
const hasLeft = (uid = S.uid) => !!(S.round && S.round.left && S.round.left[uid]);
const isAliveHider = (uid = S.uid) => isHider(uid) && !!(S.round.alive && S.round.alive[uid]) && !hasLeft(uid);
const isActiveSeeker = (uid = S.uid) => isSeeker(uid) && !!(S.round.activeSeekers && S.round.activeSeekers[uid]);
const iAmActive = () => roundActive() && (isActiveSeeker() || isAliveHider());
const inHidePhase = () => !!(S.round && serverNow() < S.round.hideEndsAt);
const myDisguise = () => (myPlayer() && myPlayer().disguise) || null;
const nameOf = (uid) => (S.round && S.round.names && S.round.names[uid]) || (S.players[uid] && S.players[uid].nickname) || '알 수 없음';
const isOnline = (uid) => !!(S.presence[uid] && S.presence[uid].online);
const offlineMs = (uid) => {
  const p = S.presence[uid];
  if (!p || p.online) return 0;
  return serverNow() - (p.at || 0);
};
/** 접속 정보가 아직 없으면(막 들어옴) 연결된 것으로 봄 */
const isConnected = (uid) => !S.presence[uid] || !!S.presence[uid].online;
/** 현재 방 상태를 actions.js 가 쓰는 형태로 */
const roomState = () => ({ meta: S.meta, players: S.players, round: S.round, pos: Object.fromEntries(S.pos) });

// ---------------------------------------------------------------------
// 화면 전환 / 공용 UI
// ---------------------------------------------------------------------
function showScreen(name) {
  S.screen = name;
  $('screen-home').hidden = name !== 'home';
  $('screen-lobby').hidden = name !== 'lobby';
  $('screen-loading').hidden = name !== 'loading';
  const gameVisible = name === 'game' || name === 'results';
  $('game-layer').hidden = !gameVisible;
  $('game-canvas').style.visibility = gameVisible ? 'visible' : 'hidden';
  $('screen-results').hidden = name !== 'results';
  $('net-status').hidden = !S.roomId;
  S.inGame = gameVisible;
  if (controls) controls.setEnabled(name === 'game');
  if (name !== 'game') closeDisguisePanel();
  document.body.dataset.screen = name;
}

function showLoading(text, { error = false, retry = false } = {}) {
  showScreen('loading');
  $('loading-text').textContent = text;
  $('loading-spinner').hidden = error;
  $('btn-retry').hidden = !retry;
  $('screen-loading').classList.toggle('error', error);
}

function toast(text, kind = 'info', ms = 2600) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

function openModal(title, html) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = html;
  $('modal').hidden = false;
  if (controls) controls.releaseLock();
}
function closeModal() {
  $('modal').hidden = true;
}

function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  btn.classList.toggle('busy', busy);
}

// ---------------------------------------------------------------------
// Firebase
// ---------------------------------------------------------------------
function configLooksValid() {
  if (USE_EMULATORS) return true;
  const c = firebaseConfig;
  return !!(c && c.apiKey && !c.apiKey.startsWith('YOUR_') && c.databaseURL && !c.databaseURL.includes('YOUR_') && c.projectId && !c.projectId.startsWith('YOUR_'));
}

function initFirebase() {
  const cfg = USE_EMULATORS
    ? {
        apiKey: 'demo-key',
        projectId: EMULATOR.projectId,
        authDomain: `${EMULATOR.projectId}.firebaseapp.com`,
        databaseURL: `https://${EMULATOR.projectId}-default-rtdb.firebaseio.com`,
      }
    : firebaseConfig;
  fb.app = initializeApp(cfg);
  // 테스트용: 주소에 ?newUser 를 붙이면 탭마다 새 익명 사용자로 접속 (한 컴퓨터에서 여러 명 테스트)
  fb.auth = PARAMS.has('newUser')
    ? initializeAuth(fb.app, { persistence: inMemoryPersistence })
    : initializeAuth(fb.app, { persistence: browserLocalPersistence });
  fb.db = getDatabase(fb.app);
  if (USE_EMULATORS) {
    connectAuthEmulator(fb.auth, `http://${EMULATOR.host}:${EMULATOR.authPort}`, { disableWarnings: true });
    connectDatabaseEmulator(fb.db, EMULATOR.host, EMULATOR.databasePort);
  }
}

function signIn() {
  return new Promise((resolve, reject) => {
    const off = onAuthStateChanged(
      fb.auth,
      async (user) => {
        if (user) {
          off();
          resolve(user);
          return;
        }
        try {
          await signInAnonymously(fb.auth);
        } catch (e) {
          off();
          reject(e);
        }
      },
      (e) => reject(e)
    );
  });
}

const isDenied = (e) => /permission[_ ]denied/i.test(`${(e && e.code) || ''} ${(e && e.message) || ''}`);

/** 다중 경로 업데이트 1회. 보안 규칙에 맞지 않으면 전체가 거부됩니다. */
async function write(updates) {
  return withTimeout(update(ref(fb.db), updates), GC.WRITE_TIMEOUT_MS, '응답이 늦습니다. 인터넷 연결을 확인해 주세요.');
}

/** 작업 시도 간격 제한 (같은 정리 작업 반복 방지) */
function throttle(key, ms) {
  const now = performance.now();
  if ((S.tried.get(key) || 0) > now) return false;
  S.tried.set(key, now + ms);
  return true;
}

function watchConnection() {
  onValue(ref(fb.db, '.info/connected'), (snap) => {
    const was = S.connected;
    S.connected = !!snap.val();
    updateNetStatus();
    if (S.connected && !was && S.roomId && S.joinedOnce && !S.leaving) reattachRoom('reconnect');
  });
  onValue(ref(fb.db, '.info/serverTimeOffset'), (snap) => {
    S.serverOffset = Number(snap.val()) || 0;
  });
}

function updateNetStatus() {
  const el = $('net-status');
  el.classList.toggle('offline', !S.connected);
  el.querySelector('span').textContent = S.connected ? '연결됨' : '연결 끊김 · 재연결 중';
}

// ---------------------------------------------------------------------
// 방 만들기 / 참가 / 퇴장
// ---------------------------------------------------------------------
function currentNickname() {
  return normalizeNickname($('nickname').value || S.nickname);
}

function randomCode() {
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => ROOM_CODE_ALPHABET[n % ROOM_CODE_ALPHABET.length]).join('');
}

async function createRoom() {
  const nick = currentNickname();
  if (!nick) return toast('닉네임은 2~12자의 한글, 영문, 숫자로 입력해 주세요.', 'warn');
  saveNickname(nick);
  const btn = $('btn-create');
  setBusy(btn, true);
  try {
    let code = null;
    for (let i = 0; i < 5 && !code; i++) {
      const c = randomCode();
      try {
        await write(A.createRoomUpdate({ uid: S.uid, code: c, nickname: nick, character: S.character, TS: TS() }));
        code = c;
      } catch (e) {
        if (!isDenied(e)) throw e; // 거부 = 이미 있는 코드 → 다른 코드로 재시도
      }
    }
    if (!code) throw new Error('방을 만들지 못했습니다. 보안 규칙이 배포되었는지 확인해 주세요. (README 5단계)');
    await enterRoom(code);
  } catch (e) {
    toast(e.message, 'error', 4000);
  } finally {
    setBusy(btn, false);
  }
}

/** 참가 전 확인 (방 코드를 아는 사람은 meta/slots/nicks 를 읽을 수 있음) */
async function inspectRoom(code) {
  const [meta, slots, nicks] = await Promise.all(
    ['meta', 'slots', 'nicks'].map((k) => withTimeout(get(ref(fb.db, `rooms/${code}/${k}`)), GC.WRITE_TIMEOUT_MS, '응답이 늦습니다.').then((s) => s.val()))
  );
  return { meta, slots: slots || {}, nicks: nicks || {} };
}

async function joinRoom(codeRaw, btn) {
  const nick = currentNickname();
  if (!nick) return toast('닉네임은 2~12자의 한글, 영문, 숫자로 입력해 주세요.', 'warn');
  const code = normalizeRoomCode(codeRaw);
  if (!code) return toast('방 코드는 영문/숫자 6자리입니다.', 'warn');
  saveNickname(nick);
  setBusy(btn, true);
  try {
    const rejoined = await joinFlow(code, nick);
    await enterRoom(code);
    if (rejoined) toast('방에 다시 연결되었습니다.', 'good');
  } catch (e) {
    toast(e.message, 'error', 4000);
    if (e.gone) {
      LS.del('phs.lastRoom');
      $('rejoin-box').hidden = true;
    }
  } finally {
    setBusy(btn, false);
  }
}

/** 참가 처리. 이미 참가자면 true(재접속) */
async function joinFlow(code, nick) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const info = await inspectRoom(code);
    if (!info.meta) {
      const err = new Error('존재하지 않거나 이미 종료된 방입니다.');
      err.gone = true;
      throw err;
    }
    if (Object.values(info.slots).includes(S.uid)) return true;
    if (info.meta.status === 'playing') throw new Error('게임이 진행 중입니다. 라운드가 끝난 뒤 참가해 주세요.');
    const slot = A.freeSlot(info.slots);
    if (!slot) throw new Error(`방이 가득 찼습니다. (최대 ${GC.MAX_PLAYERS}명)`);
    const owner = info.nicks[nicknameKey(nick)];
    if (owner && owner !== S.uid) throw new Error('이 방에서 이미 사용 중인 닉네임입니다.');
    try {
      await write(A.joinUpdate({ uid: S.uid, code, nickname: nick, character: S.character, slot, TS: TS() }));
      return false;
    } catch (e) {
      if (!isDenied(e)) throw e; // 동시에 같은 자리를 잡은 경우 → 다시 확인 후 재시도
    }
  }
  throw new Error('참가하지 못했습니다. 잠시 후 다시 시도해 주세요.');
}

function saveNickname(nick) {
  S.nickname = nick;
  LS.set('phs.nickname', nick);
  $('nickname').value = nick;
}

async function enterRoom(roomId) {
  S.roomId = roomId;
  S.joinedOnce = true;
  S.leaving = false;
  LS.set('phs.lastRoom', roomId);
  subscribeRoom(roomId);
  await attachPresence();
  $('net-status').hidden = false;
}

function subscribeRoom(roomId) {
  unsubscribeRoom();
  const base = `rooms/${roomId}`;
  const onErr = () => handleAccessLost();
  S.unsubs.push(onValue(ref(fb.db, `${base}/meta`), (s) => onMeta(s.val()), onErr));
  S.unsubs.push(onValue(ref(fb.db, `${base}/players`), (s) => onPlayers(s.val() || {}), onErr));
  S.unsubs.push(onValue(ref(fb.db, `${base}/round`), (s) => onRound(s.val()), onErr));
  S.unsubs.push(
    onValue(ref(fb.db, `roomPresence/${roomId}`), (s) => {
      S.presence = s.val() || {};
      renderLobby();
    }, onErr)
  );
  const posRef = ref(fb.db, `roomPos/${roomId}`);
  const onPos = (s) => onPosition(s.key, s.val());
  S.unsubs.push(onChildAdded(posRef, onPos, onErr));
  S.unsubs.push(onChildChanged(posRef, onPos, onErr));
  S.unsubs.push(
    onChildRemoved(posRef, (s) => {
      S.pos.delete(s.key);
    })
  );
}

function unsubscribeRoom() {
  S.unsubs.forEach((off) => {
    try {
      off();
    } catch {
      /* 이미 해제됨 */
    }
  });
  S.unsubs = [];
}

/** 접속 상태: 연결이 끊기면 Firebase 서버가 online:false 로 바꿉니다 (onDisconnect) */
async function attachPresence() {
  if (!S.roomId) return;
  const pRef = ref(fb.db, `roomPresence/${S.roomId}/${S.uid}`);
  S.presenceRef = pRef;
  try {
    await onDisconnect(pRef).set({ online: false, at: TS() });
    await set(pRef, { online: true, at: TS() });
  } catch (e) {
    console.warn('presence 설정 실패', e);
  }
}

/** 재연결: 아직 참가자면 접속 상태만 복구, 대기실에서 정리되었으면 다시 참가 */
async function reattachRoom(reason) {
  if (S.rejoining || !S.roomId) return;
  S.rejoining = true;
  const code = S.roomId;
  try {
    const nick = S.nickname || (myPlayer() && myPlayer().nickname);
    await joinFlow(code, nick);
    subscribeRoom(code);
    await attachPresence();
    if (reason === 'reconnect') toast('다시 연결되었습니다.', 'good');
  } catch (e) {
    exitToHome(e.message);
  } finally {
    S.rejoining = false;
  }
}

function handleAccessLost() {
  if (!S.roomId || S.leaving) return;
  reattachRoom('access');
}

async function leaveRoom() {
  if (!S.roomId) return;
  const code = S.roomId;
  S.leaving = true;
  try {
    if (S.presenceRef) await onDisconnect(S.presenceRef).cancel();
  } catch {
    /* 무시 */
  }
  const me = myPlayer();
  const room = {
    ...roomState(),
    slots: me ? { [me.slot]: S.uid } : {},
    nicks: me ? { [me.nickKey]: S.uid } : {},
  };
  unsubscribeRoom();
  try {
    await write(A.leaveUpdate({ uid: S.uid, code, room, TS: TS() }));
  } catch (e) {
    console.warn('나가기 기록 실패', e);
  }
  // 마지막 사람이었다면 빈 방 정리 (다른 사람이 남아 있으면 규칙이 거부 → 무시)
  try {
    await set(ref(fb.db, `rooms/${code}`), null);
    await Promise.allSettled([set(ref(fb.db, `roomPresence/${code}`), null), set(ref(fb.db, `roomPos/${code}`), null)]);
  } catch {
    /* 아직 다른 참가자가 있음 */
  }
  LS.del('phs.lastRoom');
  exitToHome();
}

function exitToHome(message) {
  unsubscribeRoom();
  S.roomId = null;
  S.meta = null;
  S.players = {};
  S.round = null;
  S.presence = {};
  S.pos.clear();
  S.remote.clear();
  S.presenceRef = null;
  S.joinedOnce = false;
  S.leaving = false;
  if (world) world.clearPlayers();
  closeModal();
  showScreen('home');
  checkRejoin();
  if (message) toast(message, 'warn', 4000);
}

// ---------------------------------------------------------------------
// 데이터 수신
// ---------------------------------------------------------------------
function onMeta(meta) {
  if (!S.roomId) return;
  if (!meta) {
    LS.del('phs.lastRoom');
    exitToHome('방이 종료되었습니다.');
    return;
  }
  const prevStatus = S.meta && S.meta.status;
  S.meta = meta;
  if (prevStatus !== meta.status) onStatusChange(meta.status);
  renderLobby();
}

function onPlayers(players) {
  if (!S.roomId) return;
  S.players = players;
  if (!players[S.uid] && !S.leaving) {
    handleAccessLost();
    return;
  }
  const me = players[S.uid];
  if (me && me.character) S.character = me.character;
  renderLobby();
}

function onRound(round) {
  if (!S.roomId) return;
  const prev = S.round;
  S.round = round;
  if (round && (!prev || prev.id !== round.id)) onNewRound(round);
  if (round && prev && prev.id === round.id) {
    const before = prev.captures || {};
    for (const [target, cap] of Object.entries(round.captures || {})) {
      if (!before[target]) onCaptured(target, cap);
    }
    if (prev.phase === 'playing' && round.phase === 'ended') onRoundEnded();
  }
  if (S.meta && S.meta.status === 'results') renderResults();
}

function onPosition(uid, val) {
  if (!val || typeof val.x !== 'number') return;
  S.pos.set(uid, val);
  if (uid === S.uid) {
    // 새 라운드의 시작 위치(방장이 기록)를 받으면 내 위치를 맞춥니다.
    if (!S.me.ready && S.round && val.t >= S.round.startedAt) {
      S.me.x = val.x;
      S.me.z = val.z;
      S.me.yaw = val.r || 0;
      S.cam.yaw = val.r || 0;
      S.lastSent = { x: val.x, z: val.z, r: val.r || 0, at: performance.now() };
      S.me.ready = true;
    }
    return;
  }
  if (!S.remote.has(uid)) S.remote.set(uid, { x: val.x, z: val.z, r: val.r || 0, moving: false });
}

function onStatusChange(status) {
  if (status === 'lobby') {
    S.round = null;
    S.pos.clear();
    S.remote.clear();
    if (world) world.clearPlayers();
    showScreen('lobby');
  } else if (status === 'playing') {
    if (!ensureWorld()) return;
    showScreen('game');
  } else if (status === 'results') {
    if (!ensureWorld()) return;
    showScreen('results');
    renderResults();
  }
}

function onNewRound(round) {
  S.me.ready = false;
  S.aim = null;
  S.capturePending = false;
  S.captureCooldownUntil = 0;
  S.disguisePending = false;
  S.disguiseCooldownUntil = 0;
  S.spectateUid = null;
  S.remote.clear();
  S.cam.pitch = 0.32;
  if (world) world.clearPlayers();
  const role = round.seekers && round.seekers[S.uid] ? 'seeker' : round.hiders && round.hiders[S.uid] ? 'hider' : null;
  const banner = $('banner');
  if (role === 'seeker') banner.innerHTML = `<b>당신은 술래입니다</b><span>숨는 시간 동안 기다린 뒤, 조준하고 직접 포획하세요.</span>`;
  else if (role === 'hider') banner.innerHTML = `<b>당신은 숨는 팀입니다</b><span>${GC.HIDE_SECONDS}초 안에 흩어져 사물로 변신하세요.</span>`;
  else banner.innerHTML = `<b>관전 중</b><span>이번 라운드는 관전합니다.</span>`;
  banner.className = `banner ${role || 'spectator'}`;
  banner.hidden = false;
  S.bannerUntil = performance.now() + 3800;
  // 시작 위치가 이미 도착해 있으면 바로 적용
  const mine = S.pos.get(S.uid);
  if (mine) onPosition(S.uid, mine);
}

function onCaptured(target, cap) {
  const p = S.remote.get(target) || S.pos.get(target);
  if (p && world) world.spawnCaptureEffect(p.x, p.z);
  if (cap && cap.by && world) world.playLunge(cap.by);
  if (target === S.uid) {
    toast(`${nameOf(cap.by)}님에게 포획되었습니다. 관전 모드로 전환합니다.`, 'warn', 3500);
    closeDisguisePanel();
  } else if (cap && cap.by === S.uid) {
    toast(`${nameOf(target)}님을 포획했습니다!`, 'good');
  } else {
    toast(`${nameOf(cap.by)}님이 ${nameOf(target)}님을 포획했습니다.`, 'info');
  }
}

function onRoundEnded() {
  closeDisguisePanel();
  if (controls) controls.releaseLock();
  // 다음 라운드가 시작되기 전에 바로 내 전적을 기록 (규칙이 현재 라운드 데이터와 대조하므로)
  if (S.round) recordMyStats(S.roomId, S.round);
}

// ---------------------------------------------------------------------
// 로비
// ---------------------------------------------------------------------
function renderLobby() {
  if (!S.meta) return;
  if (S.meta.status === 'lobby' && S.screen !== 'lobby' && S.screen !== 'loading') showScreen('lobby');
  else if (S.meta.status === 'lobby' && S.screen === 'loading') showScreen('lobby');
  const players = Object.entries(S.players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  const max = S.meta.maxPlayers || GC.MAX_PLAYERS;
  $('lobby-code').textContent = S.roomId;
  $('lobby-count').textContent = players.length;
  $('lobby-max').textContent = max;
  $('player-list').innerHTML = players
    .map(([uid, p]) => {
      const ch = CHARACTERS.find((c) => c.id === p.character) || CHARACTERS[0];
      const host = uid === S.meta.hostId;
      const badges = [
        host ? '<span class="badge host">방장</span>' : '',
        uid === S.uid ? '<span class="badge me">나</span>' : '',
        isConnected(uid) ? '' : '<span class="badge off">연결 끊김</span>',
      ].join('');
      const state = host ? '<span class="state host">방장</span>' : p.ready ? '<span class="state ready">준비 완료</span>' : '<span class="state wait">대기 중</span>';
      return `<li class="${uid === S.uid ? 'me' : ''}"><i class="dot" style="background:${ch.color}"></i><span class="pname">${esc(p.nickname)}</span>${badges}${state}</li>`;
    })
    .join('');

  // 캐릭터 선택
  const me = myPlayer();
  $('char-grid').innerHTML = CHARACTERS.map(
    (c) =>
      `<button class="char ${me && me.character === c.id ? 'selected' : ''}" data-char="${c.id}"><i style="background:${c.color};box-shadow:inset 0 -6px 0 ${c.accent}"></i><b>${c.name}</b><small>${c.type}</small></button>`
  ).join('');

  // 방장 설정
  const host = isHost();
  $('host-settings').hidden = !host;
  $('seeker-info').hidden = host;
  const mode = S.meta.seekerMode || 'auto';
  $('seeker-mode').value = String(mode);
  const n = players.filter(([uid]) => isConnected(uid)).length;
  $('seeker-preview').textContent = n >= 2 ? `현재 ${n}명 → 술래 ${seekerCountFor(n, mode)}명` : '2명 이상이 되면 시작할 수 있습니다.';
  $('seeker-info').textContent = `술래 수: ${mode === 'auto' ? '자동' : `${mode}명`} (현재 인원 기준 ${n >= 2 ? seekerCountFor(n, mode) : '-'}명)`;

  // 시작/준비 버튼
  const others = players.filter(([uid]) => uid !== S.uid && isConnected(uid));
  const notReady = others.filter(([uid, p]) => uid !== S.meta.hostId && !p.ready).length;
  $('btn-start').hidden = !host;
  $('btn-ready').hidden = host;
  if (me) {
    $('btn-ready').textContent = me.ready ? '준비 취소' : '준비';
    $('btn-ready').classList.toggle('primary', !me.ready);
  }
  let hint = '';
  if (host) {
    if (n < GC.MIN_PLAYERS) hint = `최소 ${GC.MIN_PLAYERS}명이 필요합니다.`;
    else if (notReady) hint = `${notReady}명이 아직 준비하지 않았습니다.`;
    else hint = '모두 준비되었습니다!';
    $('btn-start').disabled = n < GC.MIN_PLAYERS || notReady > 0;
  } else {
    hint = me && me.ready ? '방장이 시작하기를 기다리는 중입니다.' : '준비 버튼을 눌러 주세요.';
  }
  $('start-hint').textContent = hint;
}

async function toggleReady() {
  const me = myPlayer();
  if (!me) return;
  try {
    await set(ref(fb.db, `rooms/${S.roomId}/players/${S.uid}/ready`), !me.ready);
  } catch (e) {
    toast('준비 상태를 바꿀 수 없습니다.', 'error');
  }
}

async function chooseCharacter(id) {
  if (!CHARACTERS.some((c) => c.id === id)) return;
  S.character = id;
  LS.set('phs.character', id);
  if (!S.roomId) return;
  try {
    await set(ref(fb.db, `rooms/${S.roomId}/players/${S.uid}/character`), id);
  } catch {
    toast('지금은 캐릭터를 바꿀 수 없습니다.', 'warn');
  }
}

/** 방장이 라운드 시작: 역할 무작위 배정과 시작 위치를 한 번에 기록 */
async function startRound(btn) {
  if (!isHost()) return;
  const participants = Object.keys(S.players).filter(isConnected);
  if (participants.length < GC.MIN_PLAYERS) return toast(`최소 ${GC.MIN_PLAYERS}명이 있어야 시작할 수 있습니다.`, 'warn');
  if (S.meta.status === 'lobby') {
    const notReady = participants.filter((u) => u !== S.uid && !S.players[u].ready).length;
    if (notReady) return toast(`아직 준비하지 않은 참가자가 ${notReady}명 있습니다.`, 'warn');
  }
  setBusy(btn, true);
  try {
    const { update: up } = A.startRoundUpdate({ code: S.roomId, room: roomState(), participants, serverNow: serverNow(), map, TS: TS() });
    await write(up);
  } catch (e) {
    toast(isDenied(e) ? '시작할 수 없습니다. 기기 시간이 크게 어긋났거나 방장 권한이 없습니다.' : e.message, 'error', 4000);
  } finally {
    setBusy(btn, false);
  }
}

async function returnToLobby(btn) {
  if (!isHost()) return;
  setBusy(btn, true);
  try {
    await write(A.returnToLobbyUpdate({ code: S.roomId, room: roomState() }));
  } catch (e) {
    toast(isDenied(e) ? '지금은 대기실로 이동할 수 없습니다.' : e.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

// ---------------------------------------------------------------------
// 결과 화면
// ---------------------------------------------------------------------
function renderResults() {
  const round = S.round;
  if (!round || round.phase !== 'ended') return;
  if (S.screen !== 'results') showScreen('results');
  const results = round.results || computeRoundResults(round);
  const winner = round.winner;
  const myRes = results[S.uid];
  $('res-winner').textContent = winner === 'seekers' ? '술래 팀 승리' : '숨는 팀 승리';
  $('res-winner').className = `res-winner ${winner}`;
  $('res-mine').textContent = myRes
    ? myRes.outcome === 'win'
      ? `승리! +${myRes.points}점`
      : myRes.outcome === 'left'
        ? '중도 이탈 (기록: 패배, 0점)'
        : `패배 · +${myRes.points}점`
    : '이번 라운드를 관전했습니다.';
  const duration = Math.max(0, (round.endedAt || round.roundEndsAt) - round.startedAt);
  const chase = Math.max(0, (round.endedAt || round.roundEndsAt) - round.hideEndsAt);
  $('res-meta').textContent = `라운드 ${round.number || ''} · 총 ${fmtTime(duration)} (추격 ${fmtTime(chase)})`;
  const entries = Object.entries(results);
  const captured = entries.filter(([, r]) => r.team === 'hiders' && r.captured);
  const survived = entries.filter(([, r]) => r.team === 'hiders' && r.survived);
  $('res-captured').innerHTML =
    captured
      .map(([, r]) => `<li>${esc(r.nickname)} <small>← ${esc((results[r.capturedBy] && results[r.capturedBy].nickname) || '술래')}</small></li>`)
      .join('') || '<li class="muted">없음</li>';
  $('res-survived').innerHTML = survived.map(([, r]) => `<li>${esc(r.nickname)} <small>${r.survivalSeconds}초</small></li>`).join('') || '<li class="muted">없음</li>';
  const outcomeLabel = { win: '승리', loss: '패배', left: '이탈' };
  $('res-body').innerHTML = entries
    .sort((a, b) => b[1].points - a[1].points)
    .map(
      ([uid, r]) =>
        `<tr class="${uid === S.uid ? 'me' : ''}"><td>${esc(r.nickname)}</td><td><span class="team ${r.team}">${r.team === 'seekers' ? '술래' : '숨는 팀'}</span></td><td>${outcomeLabel[r.outcome] || '-'}</td><td>${r.team === 'seekers' ? r.captures : r.captured ? '포획됨' : '-'}</td><td>${r.team === 'hiders' ? `${r.survivalSeconds}초` : '-'}</td><td><b>${r.points}</b></td></tr>`
    )
    .join('');
  const host = isHost();
  $('btn-next').hidden = !host;
  $('btn-to-lobby').hidden = !host;
  $('res-wait').hidden = host;
  // 모든 참가자가 전적을 기록할 시간을 주기 위해 결과 화면 직후 3초간 다음 라운드 대기
  const wait = (round.endedAt || 0) + RESULT_LOCK_MS - serverNow();
  $('btn-next').disabled = wait > 0;
  $('btn-to-lobby').disabled = wait > 0;
  if (wait > 0) {
    clearTimeout(renderResults.timer);
    renderResults.timer = setTimeout(() => S.meta && S.meta.status === 'results' && renderResults(), wait + 50);
  }
}
const RESULT_LOCK_MS = 3000;

// ---------------------------------------------------------------------
// 전적 / 순위 / 설정
// ---------------------------------------------------------------------
async function fetchLeaderboard() {
  const snap = await get(query(ref(fb.db, 'playerStats'), orderByChild('points'), limitToLast(100)));
  const rows = [];
  snap.forEach((c) => {
    rows.push({ uid: c.key, ...c.val() });
  });
  rows.sort(compareLeaderboard);
  return rows;
}

async function showStats() {
  if (!fb.db || !S.uid) return;
  openModal('내 전적', '<p class="muted">불러오는 중…</p>');
  try {
    const [snap, board] = await Promise.all([get(ref(fb.db, `playerStats/${S.uid}`)), fetchLeaderboard()]);
    const s = snap.val() || {};
    const games = s.gamesPlayed || 0;
    const rank = board.findIndex((r) => r.uid === S.uid);
    const rate = games ? Math.round(((s.wins || 0) / games) * 1000) / 10 : 0;
    const cells = [
      ['총 플레이', `${games}회`],
      ['승리', `${s.wins || 0}회`],
      ['패배', `${s.losses || 0}회`],
      ['승률', `${rate}%`],
      ['술래로 포획', `${s.captures || 0}명`],
      ['숨어서 생존', `${s.survivals || 0}회`],
      ['누적 생존 시간', fmtLong(s.totalSurvivalSeconds)],
      ['개인 점수', `${s.points || 0}점`],
      ['전체 순위', rank >= 0 ? `${rank + 1}위` : games ? '100위 밖' : '기록 없음'],
    ];
    $('modal-body').innerHTML = `<div class="stat-grid">${cells.map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('')}</div>
      <p class="muted small">전적은 라운드가 끝날 때 보안 규칙이 라운드 결과와 대조해 검사한 값만 기록됩니다. 익명 로그인이므로 브라우저 데이터를 지우면 새 사용자로 시작합니다.</p>`;
  } catch (e) {
    $('modal-body').innerHTML = `<p class="error-text">전적을 불러오지 못했습니다. (${esc(e.message)})</p>`;
  }
}

async function showRanking() {
  if (!fb.db) return;
  openModal('전체 순위', '<p class="muted">불러오는 중…</p>');
  try {
    const rows = await fetchLeaderboard();
    if (!rows.length) {
      $('modal-body').innerHTML = '<p class="muted">아직 기록이 없습니다.</p>';
      return;
    }
    $('modal-body').innerHTML = `<table class="rank-table"><thead><tr><th>순위</th><th>닉네임</th><th>점수</th><th>승</th><th>판</th><th>승률</th></tr></thead><tbody>
      ${rows
        .map((r, i) => {
          const g = r.gamesPlayed || 0;
          return `<tr class="${r.uid === S.uid ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.nickname)}</td><td><b>${r.points || 0}</b></td><td>${r.wins || 0}</td><td>${g}</td><td>${g ? Math.round(((r.wins || 0) / g) * 100) : 0}%</td></tr>`;
        })
        .join('')}</tbody></table>
      <p class="muted small">정렬: 점수 → 승리 수 → 적은 플레이 수 → 닉네임 순. 상위 100명 표시.</p>`;
  } catch (e) {
    $('modal-body').innerHTML = `<p class="error-text">순위를 불러오지 못했습니다. (${esc(e.message)})</p>`;
  }
}

function resolvedQuality() {
  if (settings.quality !== 'auto') return settings.quality;
  return isTouchDevice || Math.min(screen.width, screen.height) < 600 ? 'low' : 'medium';
}

function showSettings() {
  const q = settings.quality;
  openModal(
    '설정',
    `<label class="field"><span>그래픽 품질</span><select id="set-quality">
      <option value="auto" ${q === 'auto' ? 'selected' : ''}>자동 (현재: ${QUALITY_PRESETS[resolvedQuality()].label})</option>
      ${Object.entries(QUALITY_PRESETS).map(([k, v]) => `<option value="${k}" ${q === k ? 'selected' : ''}>${v.label}</option>`).join('')}
    </select></label>
    <label class="field"><span>시점 감도 <b id="sens-val">${settings.sensitivity.toFixed(1)}</b></span><input id="set-sens" type="range" min="0.3" max="2.5" step="0.1" value="${settings.sensitivity}"></label>
    <label class="check"><input id="set-invert" type="checkbox" ${settings.invertY ? 'checked' : ''}> 상하 시점 반전</label>
    <p class="muted small">낮음: 그림자 끔, 해상도 1배 (모바일 권장). 안티에일리어싱 변경은 새로고침 후 적용됩니다.</p>
    <h4>조작 방법</h4>${controlsHelpHtml()}`
  );
  $('set-quality').onchange = (e) => {
    settings.quality = e.target.value;
    LS.set('phs.quality', settings.quality);
    if (world) world.setQuality(resolvedQuality());
  };
  $('set-sens').oninput = (e) => {
    settings.sensitivity = Number(e.target.value);
    $('sens-val').textContent = settings.sensitivity.toFixed(1);
    LS.set('phs.sensitivity', settings.sensitivity);
    if (controls) controls.sensitivity = settings.sensitivity;
  };
  $('set-invert').onchange = (e) => {
    settings.invertY = e.target.checked;
    LS.set('phs.invertY', settings.invertY);
  };
}

function controlsHelpHtml() {
  return `<div class="help-cols">
    <div><h5>PC</h5><ul>
      <li><kbd>W A S D</kbd> / 방향키: 이동</li>
      <li>화면 클릭: 마우스 시점 잠금 (<kbd>Esc</kbd> 해제)</li>
      <li>마우스: 시점 회전 · 조준</li>
      <li>술래: <kbd>좌클릭</kbd>(잠금 중) 또는 <kbd>F</kbd> 포획</li>
      <li>숨는 팀: <kbd>E</kbd> 변신 / 해제, <kbd>1</kbd>~<kbd>7</kbd> 사물 선택</li>
    </ul></div>
    <div><h5>모바일</h5><ul>
      <li>화면 왼쪽 드래그: 이동 조이스틱</li>
      <li>화면 오른쪽 드래그: 시점 회전</li>
      <li>포획 버튼: 조준점이 대상에 맞을 때 누르기</li>
      <li>변신 버튼: 사물 선택 / 해제</li>
      <li>가로 화면을 권장합니다</li>
    </ul></div></div>`;
}

function showMenu() {
  openModal(
    '메뉴',
    `<div class="menu-list">
      <button class="btn wide" id="menu-resume">계속하기</button>
      <button class="btn wide ghost" id="menu-settings">설정 · 조작 방법</button>
      <button class="btn wide danger" id="menu-leave">방 나가기</button>
    </div>
    <p class="muted small">게임 중 나가면 기권(패배, 0점)으로 기록됩니다. 연결이 끊긴 경우 ${GC.DISCONNECT_GRACE_MS / 1000}초 안에 돌아오면 이어서 플레이할 수 있습니다.</p>`
  );
  $('menu-resume').onclick = closeModal;
  $('menu-settings').onclick = showSettings;
  $('menu-leave').onclick = () => {
    closeModal();
    leaveRoom();
  };
}

async function checkRejoin() {
  $('rejoin-box').hidden = true;
  if (!fb.db || !S.uid) return;
  try {
    const snap = await get(ref(fb.db, `userRooms/${S.uid}`));
    const code = snap.val() || null;
    if (typeof code === 'string' && !S.roomId) {
      $('rejoin-code').textContent = code;
      $('rejoin-box').hidden = false;
    }
  } catch {
    /* 무시 */
  }
}

// ---------------------------------------------------------------------
// 3D 월드 준비
// ---------------------------------------------------------------------
function ensureWorld() {
  if (world) return true;
  try {
    world = new World($('game-canvas'), map, resolvedQuality());
  } catch (e) {
    console.error(e);
    openModal('3D를 시작할 수 없습니다', '<p>이 브라우저 또는 기기에서 WebGL을 사용할 수 없습니다. 최신 Chrome, Safari, Edge에서 다시 시도해 주세요.</p>');
    return false;
  }
  controls = new Controls($('game-layer'), $('game-canvas'), { joyBase: $('joy-base'), joyKnob: $('joy-knob') });
  controls.sensitivity = settings.sensitivity;
  controls.on('capture', doCapture);
  controls.on('interact', onInteract);
  controls.on('number', (n) => {
    if (!$('disguise-panel').hidden && PROP_TYPE_IDS[n - 1]) chooseDisguise(PROP_TYPE_IDS[n - 1]);
  });
  controls.on('escape', closeDisguisePanel);
  minimapBg = buildMinimapBackground();
  window.addEventListener('resize', () => world && world.resize());
  return true;
}

// ---------------------------------------------------------------------
// 변신
// ---------------------------------------------------------------------
function onInteract() {
  if (!roundActive() || !isAliveHider()) return;
  if (!$('disguise-panel').hidden) return closeDisguisePanel();
  if (myDisguise()) return undisguise();
  openDisguisePanel();
}

function nearestPropType() {
  let best = null;
  for (const o of map.queryObstacles(S.me.x, S.me.z, 4)) {
    if (o.kind !== 'prop') continue;
    const d = Math.hypot(o.x - S.me.x, o.z - S.me.z);
    if (d < 3.5 && (!best || d < best.d)) best = { d, type: o.propType };
  }
  return best && best.type;
}

function openDisguisePanel() {
  const near = nearestPropType();
  const cd = S.disguiseCooldownUntil - performance.now();
  $('disguise-grid').innerHTML = PROP_TYPE_IDS.map(
    (id, i) =>
      `<button class="prop-opt ${near === id ? 'near' : ''}" data-prop="${id}" ${cd > 0 ? 'disabled' : ''}><kbd>${i + 1}</kbd><b>${PROP_TYPES[id].name}</b><small>맵에 ${map.propCounts[id] || 0}개${near === id ? ' · 바로 근처' : ''}</small></button>`
  ).join('');
  $('disguise-note').textContent =
    cd > 0 ? `재변신 대기 ${Math.ceil(cd / 1000)}초` : '변신하면 이동할 수 없습니다(회전 불가). 같은 종류가 많은 곳에 숨으세요.';
  $('disguise-panel').hidden = false;
  if (controls) controls.releaseLock();
}

function closeDisguisePanel() {
  $('disguise-panel').hidden = true;
}

async function chooseDisguise(type) {
  closeDisguisePanel();
  if (!isAliveHider() || S.disguisePending || myDisguise()) return;
  const left = S.disguiseCooldownUntil - performance.now();
  if (left > 0) return toast(`변신 대기 시간입니다. (${Math.ceil(left / 1000)}초)`, 'warn');
  S.disguisePending = true;
  try {
    await sendPosition(true); // 현재 위치를 DB와 일치시킨 뒤 변신 (변신 중 이동 금지 규칙 때문)
    await write(A.disguiseUpdate({ code: S.roomId, uid: S.uid, propType: type, TS: TS() }));
    toast(`${PROP_TYPES[type].name}(으)로 변신했습니다. 움직이려면 변신을 해제하세요.`, 'good', 3000);
  } catch (e) {
    toast(isDenied(e) ? '지금은 변신할 수 없습니다. (재변신 대기 시간이거나 라운드가 끝났습니다)' : e.message, 'error');
  } finally {
    S.disguisePending = false;
  }
}

async function undisguise() {
  if (S.disguisePending) return;
  S.disguisePending = true;
  try {
    await write(A.disguiseUpdate({ code: S.roomId, uid: S.uid, propType: null, TS: TS() }));
    S.disguiseCooldownUntil = performance.now() + GC.DISGUISE_COOLDOWN_MS + 300;
    toast('변신을 해제했습니다.', 'info', 1800);
  } catch (e) {
    toast(isDenied(e) ? '변신을 해제할 수 없습니다.' : e.message, 'error');
  } finally {
    S.disguisePending = false;
  }
}

// ---------------------------------------------------------------------
// 포획 (술래): 조준 + 버튼 입력 + 보안 규칙 검사
// ---------------------------------------------------------------------
function rayCylinder(o, d, cx, cz, r, h) {
  const ox = o.x - cx;
  const oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  let hit = null;
  if (a > 1e-8) {
    const b = 2 * (ox * d.x + oz * d.z);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t > 0) {
        const y = o.y + d.y * t;
        if (y >= 0 && y <= h) hit = t;
      }
    }
  }
  if (hit === null && d.y < 0) {
    const t = (h - o.y) / d.y;
    if (t > 0) {
      const px = ox + d.x * t;
      const pz = oz + d.z * t;
      if (px * px + pz * pz <= r * r) hit = t;
    }
  }
  return hit;
}

function updateAim() {
  S.aim = null;
  if (!world || !roundActive() || !isActiveSeeker() || inHidePhase()) return;
  const { origin, dir } = world.getAimRay();
  const sx = S.me.x;
  const sz = S.me.z;
  let best = null;
  const consider = (kind, id, x, z, r, h) => {
    if (Math.hypot(x - sx, z - sz) > GC.AIM_MAX_DISTANCE) return;
    const t = rayCylinder(origin, dir, x, z, r, h);
    if (t !== null && (!best || t < best.t)) best = { kind, id, x, z, t };
  };
  for (const o of map.queryObstacles(sx, sz, GC.AIM_MAX_DISTANCE)) {
    if (o.kind === 'prop') consider('prop', o.id, o.x, o.z, o.r, o.h);
  }
  for (const uid of Object.keys((S.round && S.round.alive) || {})) {
    const rp = S.remote.get(uid);
    if (!rp || hasLeft(uid)) continue;
    const p = S.players[uid];
    const type = p && p.disguise;
    if (type && PROP_TYPES[type]) consider('player', uid, rp.x, rp.z, PROP_TYPES[type].radius, PROP_TYPES[type].height);
    else consider('player', uid, rp.x, rp.z, 0.5, 1.6);
  }
  if (best) {
    best.dist = Math.hypot(best.x - sx, best.z - sz);
    best.inRange = best.dist <= GC.CAPTURE_RANGE;
    best.visible = hasLineOfSight(map, sx, sz, best.x, best.z);
  }
  S.aim = best;
}

async function doCapture() {
  if (!roundActive() || !isActiveSeeker()) return;
  if (!$('modal').hidden) return;
  if (S.capturePending) return; // 응답 대기 중 중복 요청 방지
  const now = performance.now();
  if (now < S.captureCooldownUntil) return toast('포획 대기 중입니다.', 'warn', 1200);
  if (inHidePhase()) return toast('숨는 시간에는 포획할 수 없습니다.', 'warn');
  const aim = S.aim;
  if (!aim) return toast('조준점을 대상에 맞춘 뒤 포획하세요.', 'warn', 1800);
  S.captureCooldownUntil = now + GC.CAPTURE_COOLDOWN_MS;
  world.playLunge(S.uid);
  if (!DEBUG_SERVER_CAPTURE) {
    if (!aim.inRange) return toast(`너무 멉니다. (${aim.dist.toFixed(1)}m / ${GC.CAPTURE_RANGE}m)`, 'warn');
    if (!aim.visible) return toast('장애물에 가려져 있습니다.', 'warn');
    if (aim.kind === 'prop') return toast('빗나갔습니다! 진짜 사물이었습니다.', 'warn');
  }
  // 포획 기록 + 현재 위치를 한 번에 씁니다. 보안 규칙이 역할·시간·생존·거리·쿨다운을 검사하고,
  // 조건이 맞지 않으면 전체가 거부됩니다. (두 술래가 동시에 잡으면 먼저 도착한 쪽만 성공)
  S.capturePending = true;
  const pos = { x: S.me.x, z: S.me.z, r: wrapAngle(S.me.yaw) };
  try {
    await write(A.captureUpdate({ code: S.roomId, uid: S.uid, target: aim.id, round: S.round, pos, TS: TS() }));
    S.lastSent = { x: round2(pos.x), z: round2(pos.z), r: round2(pos.r), at: performance.now() };
  } catch (e) {
    if (isDenied(e)) toast('포획 실패: 거리·시간 조건이 맞지 않거나 이미 잡힌 대상입니다.', 'warn');
    else toast(e.message, 'error');
  } finally {
    S.capturePending = false;
  }
}

// ---------------------------------------------------------------------
// 위치 전송 (초당 최대 8회, 변화가 있을 때만)
// ---------------------------------------------------------------------
function canSendPosition() {
  if (!S.me.ready || !iAmActive()) return false;
  if (isHider() && myDisguise()) return false; // 변신 중에는 이동하지 않음
  if (isSeeker() && inHidePhase()) return false; // 숨는 시간 동안 술래는 고정
  return true;
}

function sendPosition(force = false) {
  if (!canSendPosition()) return Promise.resolve();
  const now = performance.now();
  const last = S.lastSent;
  const dx = S.me.x - last.x;
  const dz = S.me.z - last.z;
  const moved = Math.hypot(dx, dz);
  const turned = angleDiff(S.me.yaw, last.r);
  if (!force && moved < 0.01 && turned < 0.06) return Promise.resolve();
  if (!force && now - last.at < GC.POS_SEND_INTERVAL_MS && moved < GC.POS_FORCE_SEND_DISTANCE) return Promise.resolve();
  if (!force && S.posInFlight > 2) return Promise.resolve();
  const x = round2(S.me.x);
  const z = round2(S.me.z);
  const r = round2(wrapAngle(S.me.yaw));
  S.me.x = x;
  S.me.z = z;
  S.lastSent = { x, z, r, at: now };
  S.posInFlight++;
  return set(ref(fb.db, `roomPos/${S.roomId}/${S.uid}`), { x, z, r, t: serverTimestamp() })
    .catch(() => resyncPosition())
    .finally(() => {
      S.posInFlight--;
    });
}

/** 규칙 검사에 막혔을 때(너무 빠른 이동 등) DB에 저장된 위치로 되돌림 */
async function resyncPosition() {
  const now = performance.now();
  if (now - S.lastPosResync < 800) return;
  S.lastPosResync = now;
  try {
    const snap = await get(ref(fb.db, `roomPos/${S.roomId}/${S.uid}`));
    const v = snap.val();
    if (v) {
      S.me.x = v.x;
      S.me.z = v.z;
      S.lastSent = { x: v.x, z: v.z, r: v.r || 0, at: performance.now() };
    }
  } catch {
    /* 연결 문제는 연결 표시로 안내 */
  }
}

// ---------------------------------------------------------------------
// 게임 루프
// ---------------------------------------------------------------------
let lastFrame = performance.now();
let hudTimer = 0;
let miniTimer = 0;

function loop(ts) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, Math.max(0, (ts - lastFrame) / 1000));
  lastFrame = ts;
  if (S.roomId) runDuties();
  if (!S.inGame || !world) return;
  stepGame(dt);
  hudTimer += dt;
  if (hudTimer > 0.1) {
    hudTimer = 0;
    updateHud();
  }
  miniTimer += dt;
  if (miniTimer > 0.2) {
    miniTimer = 0;
    drawMinimap();
  }
  world.render();
}

function disguisedColliders() {
  const out = [];
  for (const uid of Object.keys((S.round && S.round.alive) || {})) {
    if (uid === S.uid) continue;
    const p = S.players[uid];
    const rp = S.remote.get(uid);
    if (p && p.disguise && rp && PROP_TYPES[p.disguise]) out.push({ x: rp.x, z: rp.z, r: PROP_TYPES[p.disguise].radius });
  }
  return out;
}

function stepGame(dt) {
  const round = S.round;
  // 시점
  if (controls) {
    const look = controls.consumeLook();
    S.cam.yaw = wrapAngle(S.cam.yaw - look.dx);
    S.cam.pitch = clamp(S.cam.pitch + look.dy * (settings.invertY ? -1 : 1), -0.3, 1.1);
  }

  // 내 이동
  S.me.moving = false;
  const panelOpen = !$('disguise-panel').hidden || !$('modal').hidden;
  const canMove = S.me.ready && iAmActive() && !myDisguise() && !S.disguisePending && !(isSeeker() && inHidePhase()) && !panelOpen;
  if (canMove && controls) {
    const mv = controls.getMove();
    if (mv.x || mv.y) {
      const fy = S.cam.yaw;
      const fx = Math.sin(fy);
      const fz = Math.cos(fy);
      const rx = -Math.cos(fy);
      const rz = Math.sin(fy);
      const wx = fx * mv.y + rx * mv.x;
      const wz = fz * mv.y + rz * mv.x;
      const speed = GC.MOVE_SPEED * Math.min(1, Math.hypot(mv.x, mv.y));
      const len = Math.hypot(wx, wz) || 1;
      const nx = S.me.x + (wx / len) * speed * dt;
      const nz = S.me.z + (wz / len) * speed * dt;
      const [cx, cz] = resolveCollision(map, nx, nz, GC.PLAYER_RADIUS, disguisedColliders());
      S.me.x = cx;
      S.me.z = cz;
      S.me.yaw = lerpAngle(S.me.yaw, Math.atan2(wx, wz), Math.min(1, dt * 12));
      S.me.moving = true;
    }
  }
  if (roundActive()) sendPosition(false);

  // 다른 플레이어 보간
  const k = 1 - Math.exp(-dt * 12);
  for (const [uid, target] of S.pos) {
    if (uid === S.uid) continue;
    let rp = S.remote.get(uid);
    if (!rp) {
      rp = { x: target.x, z: target.z, r: target.r || 0, moving: false };
      S.remote.set(uid, rp);
    }
    const dx = target.x - rp.x;
    const dz = target.z - rp.z;
    if (dx * dx + dz * dz > 100) {
      rp.x = target.x;
      rp.z = target.z;
    } else {
      rp.x += dx * k;
      rp.z += dz * k;
    }
    rp.r = lerpAngle(rp.r, target.r || 0, k);
    rp.moving = dx * dx + dz * dz > 0.0025;
  }

  // 표시
  const ids = new Set([...Object.keys((round && round.seekers) || {}), ...Object.keys((round && round.hiders) || {})]);
  if (world) {
    for (const uid of world.players.keys()) if (!ids.has(uid)) world.removePlayer(uid);
    for (const uid of ids) {
      const desc = visualFor(uid);
      world.setPlayerVisual(uid, desc);
      if (desc.mode === 'hidden') continue;
      if (uid === S.uid) world.setPlayerTransform(uid, S.me.x, S.me.z, S.me.yaw, S.me.moving);
      else {
        const rp = S.remote.get(uid);
        if (rp) world.setPlayerTransform(uid, rp.x, rp.z, rp.r, rp.moving);
      }
    }
  }

  // 카메라 대상
  let fx = S.me.x;
  let fz = S.me.z;
  const spectating = !iAmActive() || !S.me.ready;
  if (spectating && round) {
    const target = pickSpectateTarget();
    const rp = target && (target === S.uid ? S.me : S.remote.get(target));
    if (rp) {
      fx = rp.x;
      fz = rp.z;
    }
  }
  const disguised = !!myDisguise();
  world.updateCamera(fx, disguised ? 1.1 : 1.45, fz, S.cam.yaw, S.cam.pitch, disguised ? 4.2 : S.cam.dist, isSeeker() && !spectating ? 0.55 : 0.35);
  world.update(dt, fx, fz);
  updateAim();
}

function visualFor(uid) {
  const round = S.round;
  const hidden = { mode: 'hidden' };
  if (!round || !S.meta || S.meta.status === 'lobby') return hidden;
  const p = S.players[uid];
  if (!p) return hidden;
  if (uid !== S.uid && !S.pos.has(uid)) return hidden;
  if (uid === S.uid && !S.me.ready) return hidden;
  if (hasLeft(uid)) return hidden;
  const seeker = isSeeker(uid);
  const hider = isHider(uid);
  if (hider && !round.alive?.[uid]) return hidden; // 포획됨
  const viewerSeeker = isSeeker(S.uid);
  const viewerHiderTeam = isHider(S.uid);
  // 숨는 시간에는 술래 화면에서 숨는 팀을 표시하지 않음 (술래는 가림막 화면)
  if (hider && viewerSeeker && serverNow() < round.hideEndsAt && round.phase === 'playing') return hidden;
  if (hider && p.disguise) {
    return {
      mode: 'prop',
      propType: p.disguise,
      label: viewerHiderTeam && uid !== S.uid ? p.nickname : null,
      labelColor: '#2f7fc1',
    };
  }
  let label = null;
  let labelColor = '#333';
  if (uid !== S.uid) {
    if (seeker) {
      label = `술래 ${p.nickname}`;
      labelColor = '#c8403a';
    } else if (viewerHiderTeam) {
      label = p.nickname;
      labelColor = '#2f7fc1';
    }
  }
  return { mode: 'avatar', character: p.character, seeker, label, labelColor };
}

function participantsAlive() {
  const round = S.round;
  if (!round) return [];
  return [...Object.keys(round.seekers || {}).filter((u) => !hasLeft(u)), ...Object.keys(round.alive || {})].filter((u) => S.pos.has(u));
}

function pickSpectateTarget() {
  const list = participantsAlive().filter((u) => u !== S.uid);
  if (!list.length) return null;
  if (!S.spectateUid || !list.includes(S.spectateUid)) S.spectateUid = list[0];
  return S.spectateUid;
}

function cycleSpectate() {
  const list = participantsAlive().filter((u) => u !== S.uid);
  if (!list.length) return;
  const i = list.indexOf(S.spectateUid);
  S.spectateUid = list[(i + 1) % list.length];
  toast(`${nameOf(S.spectateUid)}님 관전 중`, 'info', 1200);
}

// ---------------------------------------------------------------------
// 점검 작업: 서버가 없으므로 "누군가 해야 하는 일"을 브라우저가 대신합니다.
// 모든 작업은 보안 규칙이 조건(시간, 연결 끊김 시간 등)을 다시 검사하므로
// 여러 명이 동시에 시도해도 한 번만 반영되고, 조건이 안 되면 거부됩니다.
// ---------------------------------------------------------------------
const keysOf = (o) => (o ? Object.keys(o) : []);

function runDuties() {
  const now = performance.now();
  if (now < S.dutyAt || S.dutyBusy || !S.connected || !S.meta || !S.roomId || S.leaving) return;
  S.dutyAt = now + 1000;
  S.dutyBusy = true;
  doDuties()
    .catch((e) => console.warn('점검 작업 실패', e))
    .finally(() => {
      S.dutyBusy = false;
    });
}

async function doDuties() {
  const code = S.roomId;
  const round = S.round;
  const sNow = serverNow();
  const quiet = (p) => p.catch(() => {});

  // 1) 방장이 나갔거나 오래 끊겼으면, 가장 먼저 들어온 접속 중인 참가자가 이어받음
  const hostId = S.meta.hostId;
  if (hostId !== S.uid && (!S.players[hostId] || offlineMs(hostId) >= GC.HOST_OFFLINE_CLAIM_MS)) {
    const next = Object.entries(S.players)
      .filter(([u]) => u !== hostId && isOnline(u))
      .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))[0];
    if (next && next[0] === S.uid && throttle('claim', 5000)) {
      await quiet(write(A.claimHostUpdate({ code, uid: S.uid })).then(() => toast('방장이 연결되지 않아 방장을 이어받았습니다.', 'info', 3500)));
    }
  }

  if (roundActive()) {
    // 2) 라운드 종료 (모두 포획 / 술래 없음 / 시간 종료)
    let winner = A.endCondition(round, sNow - 300); // 시계 오차를 감안해 시간 종료는 살짝 늦게
    if (winner && throttle(`end:${round.id}`, 2000 + Math.random() * 1500)) {
      await quiet(write(A.endRoundUpdate({ code, winner, TS: TS() })));
    }
    // 3) 방장: 오래 연결이 끊긴 참가자 기권 처리
    if (isHost()) {
      for (const u of [...keysOf(round.seekers), ...keysOf(round.hiders)]) {
        const inPlay = (round.alive && round.alive[u]) || (round.activeSeekers && round.activeSeekers[u]);
        if (!inPlay || hasLeft(u)) continue;
        const gone = !S.players[u];
        const longOffline = offlineMs(u) >= GC.DISCONNECT_GRACE_MS + 1000;
        if ((gone || longOffline) && throttle(`ff:${u}`, 5000)) {
          const offlineAt = gone ? null : S.presence[u].at;
          await quiet(write(A.forfeitUpdate({ code, round, target: u, offlineAt, TS: TS() })));
        }
      }
    }
  }

  // 4) 방장: 대기실/결과 화면에서 오래 연결이 끊긴 사람 정리 (자리 반환)
  if (isHost() && S.meta.status !== 'playing') {
    for (const [u, p] of Object.entries(S.players)) {
      if (u === S.uid || offlineMs(u) < GC.LOBBY_OFFLINE_KICK_MS || !throttle(`kick:${u}`, 5000)) continue;
      const room = { players: S.players, slots: { [p.slot]: u }, nicks: { [p.nickKey]: u } };
      await quiet(write(A.kickUpdate({ code, room, target: u })));
    }
  }

  // 5) 라운드가 끝났으면 내 전적 기록 (+ 방장은 경기 기록)
  if (round && round.phase === 'ended') {
    await recordMyStats(code, round);
    if (isHost() && throttle(`mh:${round.id}`, 1e9)) await quiet(write(A.matchHistoryUpdate({ code, round, mapId: map.id })));
  }
}

/** 내 전적 기록: 보안 규칙이 라운드 결과와 대조해 검사하며, 같은 라운드는 한 번만 반영됩니다. */
async function recordMyStats(code, round) {
  if (S.recorded.has(round.id)) return;
  S.recorded.add(round.id);
  const res = computeRoundResults(round)[S.uid];
  if (!res || res.outcome === 'left') return;
  const nick = (myPlayer() && myPlayer().nickname) || S.nickname;
  const sRef = ref(fb.db, `playerStats/${S.uid}`);
  try {
    let old = (await get(sRef)).val();
    if (!old) {
      await set(sRef, A.statsInitValue({ nickname: nick, TS: TS() }));
      old = (await get(sRef)).val();
    }
    if (old.lastRound === round.id) return;
    const up = A.statsRecordUpdate({ uid: S.uid, code, round, old, nickname: nick, TS: TS() });
    if (up) await write(up);
  } catch (e) {
    console.warn('전적 기록 실패', e);
    toast('전적 기록에 실패했습니다. 이번 라운드는 순위에 반영되지 않습니다.', 'warn', 4000);
  }
}

// ---------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------
function updateHud() {
  const round = S.round;
  if (!round) return;
  const sNow = serverNow();
  const ended = round.phase !== 'playing';
  const hide = sNow < round.hideEndsAt;
  const countdown = sNow < round.hideEndsAt - GC.HIDE_SECONDS * 1000;

  // 타이머
  let phase;
  let remain;
  if (ended) {
    phase = '라운드 종료';
    remain = 0;
  } else if (countdown) {
    phase = '곧 시작';
    remain = round.hideEndsAt - GC.HIDE_SECONDS * 1000 - sNow;
  } else if (hide) {
    phase = '숨는 시간';
    remain = round.hideEndsAt - sNow;
  } else {
    phase = '추격 시간';
    remain = round.roundEndsAt - sNow;
  }
  $('hud-phase').textContent = phase;
  $('hud-timer').textContent = fmtTime(remain);
  $('hud-timer').classList.toggle('urgent', !ended && !hide && remain < 30000);

  // 역할 / 인원
  const chip = $('role-chip');
  let role = '관전 중';
  let roleCls = 'spectator';
  if (isActiveSeeker()) {
    role = '술래';
    roleCls = 'seeker';
  } else if (isAliveHider()) {
    role = myDisguise() ? `숨는 팀 · ${PROP_TYPES[myDisguise()].name}` : '숨는 팀';
    roleCls = 'hider';
  } else if (isHider() && !hasLeft()) {
    role = '포획됨 · 관전';
  }
  chip.textContent = role;
  chip.className = `chip ${roleCls}`;
  const hidersTotal = Object.keys(round.hiders || {}).length;
  const aliveN = Object.keys(round.alive || {}).length;
  const caps = Object.keys(round.captures || {}).length;
  $('hud-alive').textContent = `생존 ${aliveN}/${hidersTotal}`;
  const mine = (round.captureCount && round.captureCount[S.uid]) || 0;
  $('hud-captures').textContent = isSeeker() ? `포획 ${caps} (내 ${mine})` : `포획 ${caps}`;

  // 술래 가림막
  const blind = !ended && isSeeker() && hide;
  $('blindfold').hidden = !blind;
  if (blind) $('blind-timer').textContent = fmtTime(round.hideEndsAt - sNow);

  // 배너
  if (S.bannerUntil && performance.now() > S.bannerUntil) {
    $('banner').hidden = true;
    S.bannerUntil = 0;
  }

  // 포획됨 표시
  $('captured-overlay').hidden = !(isHider() && !isAliveHider() && !ended && !hasLeft());

  // 조준점 / 버튼
  const seekerTurn = !ended && isActiveSeeker() && !hide;
  const cooling = performance.now() < S.captureCooldownUntil || S.capturePending;
  const aim = S.aim;
  const ready = !!(aim && aim.inRange && aim.visible);
  const ch = $('crosshair');
  ch.hidden = !seekerTurn;
  ch.className = `crosshair ${ready ? 'ready' : ''} ${cooling ? 'cooling' : ''}`;
  $('aim-label').hidden = !seekerTurn || !aim;
  if (aim) $('aim-label').textContent = ready ? '포획 가능' : aim.visible ? `${aim.dist.toFixed(1)}m` : '가려짐';
  const capBtn = $('btn-capture');
  capBtn.hidden = !seekerTurn;
  capBtn.classList.toggle('ready', ready && !cooling);
  capBtn.classList.toggle('cooling', cooling);

  const disBtn = $('btn-disguise');
  const hiderTurn = !ended && isAliveHider();
  disBtn.hidden = !hiderTurn;
  if (hiderTurn) {
    const cd = S.disguiseCooldownUntil - performance.now();
    disBtn.textContent = myDisguise() ? '변신 해제' : cd > 0 ? `변신 ${Math.ceil(cd / 1000)}` : '변신';
    disBtn.classList.toggle('active', !!myDisguise());
  }
  $('btn-spectate').hidden = !(!ended && !iAmActive() && participantsAlive().some((u) => u !== S.uid));

  // 안내 문구 (PC)
  let hint = '';
  if (!isTouchDevice && !ended) {
    const lock = document.pointerLockElement ? '' : '화면 클릭: 마우스 시점 · ';
    if (seekerTurn) hint = `${lock}WASD 이동 · 조준 후 좌클릭/F 포획`;
    else if (isSeeker() && hide) hint = '숨는 시간이 끝나면 움직일 수 있습니다';
    else if (hiderTurn) hint = myDisguise() ? `${lock}E: 변신 해제 (해제해야 이동 가능)` : `${lock}WASD 이동 · E: 사물로 변신`;
    else hint = `${lock}관전 중`;
  }
  $('hint-bar').textContent = hint;
  $('hint-bar').hidden = !hint;
}

// ---------------------------------------------------------------------
// 미니맵 (내 위치와 같은 팀만 표시)
// ---------------------------------------------------------------------
const MINI = 150;
function miniXY(x, z) {
  const s = MINI / (map.half * 2);
  return [(map.half - x) * s, (map.half - z) * s];
}

function buildMinimapBackground() {
  const c = document.createElement('canvas');
  c.width = MINI;
  c.height = MINI;
  const g = c.getContext('2d');
  const s = MINI / (map.half * 2);
  g.fillStyle = '#5f9e4c';
  g.fillRect(0, 0, MINI, MINI);
  g.strokeStyle = '#e6cf9a';
  g.lineWidth = 2.6 * s;
  g.lineCap = 'round';
  for (const poly of map.paths) {
    g.beginPath();
    poly.forEach(([x, z], i) => {
      const [px, py] = miniXY(x, z);
      if (i) g.lineTo(px, py);
      else g.moveTo(px, py);
    });
    g.stroke();
  }
  g.fillStyle = '#2f6b3a';
  for (const t of map.trees) {
    const [px, py] = miniXY(t.x, t.z);
    g.beginPath();
    g.arc(px, py, 1.6, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#9aa0a8';
  for (const r of map.bigRocks) {
    const [px, py] = miniXY(r.x, r.z);
    g.beginPath();
    g.arc(px, py, r.r * s, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = '#8b8f99';
  for (const w of map.walls) {
    g.lineWidth = w.r * 2 * s;
    const [ax, ay] = miniXY(w.ax, w.az);
    const [bx, by] = miniXY(w.bx, w.bz);
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.stroke();
  }
  g.fillStyle = '#c4553f';
  for (const b of map.buildings) {
    const [x1, y1] = miniXY(b.maxX, b.maxZ);
    const [x2, y2] = miniXY(b.minX, b.minZ);
    g.fillRect(x1, y1, x2 - x1, y2 - y1);
  }
  return c;
}

function drawMinimap() {
  const cv = $('minimap');
  if (!minimapBg || !S.round) return;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, MINI, MINI);
  g.drawImage(minimapBg, 0, 0);
  const viewerSeeker = isSeeker();
  const viewerHider = isHider();
  for (const [uid, rp] of S.remote) {
    const teammate = (viewerSeeker && isActiveSeeker(uid)) || (viewerHider && isAliveHider(uid));
    if (!teammate) continue;
    const [px, py] = miniXY(rp.x, rp.z);
    g.fillStyle = viewerSeeker ? '#e2574c' : '#4aa3df';
    g.beginPath();
    g.arc(px, py, 3, 0, Math.PI * 2);
    g.fill();
  }
  // 나 (또는 관전 대상)
  const self = iAmActive() ? S.me : S.remote.get(S.spectateUid);
  if (self) {
    const [px, py] = miniXY(self.x, self.z);
    const yaw = iAmActive() ? S.cam.yaw : self.r || 0;
    g.save();
    g.translate(px, py);
    g.rotate(-yaw); // 화살표가 바라보는 방향 = 시점 방향
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#1f3b2d';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, -6);
    g.lineTo(4.5, 5);
    g.lineTo(-4.5, 5);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }
}

// ---------------------------------------------------------------------
// UI 연결
// ---------------------------------------------------------------------
function bindUI() {
  $('nickname').value = S.nickname;
  $('btn-create').onclick = createRoom;
  $('btn-join').onclick = () => joinRoom($('join-code').value, $('btn-join'));
  $('join-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom($('join-code').value, $('btn-join'));
  });
  $('join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  $('btn-rejoin').onclick = () => joinRoom($('rejoin-code').textContent, $('btn-rejoin'));
  $('btn-stats').onclick = showStats;
  $('btn-ranking').onclick = showRanking;
  $('btn-settings').onclick = showSettings;
  $('btn-retry').onclick = () => location.reload();

  $('btn-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(S.roomId);
      toast('방 코드를 복사했습니다.', 'good', 1500);
    } catch {
      toast(`방 코드: ${S.roomId}`, 'info', 4000);
    }
  };
  $('char-grid').onclick = (e) => {
    const b = e.target.closest('[data-char]');
    if (b) chooseCharacter(b.dataset.char);
  };
  $('seeker-mode').onchange = async (e) => {
    const v = e.target.value === 'auto' ? 'auto' : Number(e.target.value);
    try {
      await write(A.seekerModeUpdate({ code: S.roomId, mode: v }));
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  $('btn-ready').onclick = toggleReady;
  $('btn-start').onclick = () => startRound($('btn-start'));
  $('btn-leave').onclick = leaveRoom;

  $('btn-next').onclick = () => startRound($('btn-next'));
  $('btn-to-lobby').onclick = () => returnToLobby($('btn-to-lobby'));
  $('btn-leave2').onclick = leaveRoom;

  $('btn-menu').onclick = showMenu;
  $('modal-close').onclick = closeModal;
  $('modal').addEventListener('click', (e) => {
    if (e.target === $('modal')) closeModal();
  });

  // 액션 버튼: pointerdown 한 번 = 요청 한 번 (누르고 있어도 반복하지 않음)
  const tap = (el, fn) =>
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
  tap($('btn-capture'), doCapture);
  tap($('btn-disguise'), onInteract);
  tap($('btn-spectate'), cycleSpectate);
  $('disguise-grid').onclick = (e) => {
    const b = e.target.closest('[data-prop]');
    if (b && !b.disabled) chooseDisguise(b.dataset.prop);
  };
  $('disguise-close').onclick = closeDisguisePanel;

  $('rules-list').innerHTML = [
    `숨는 팀은 ${GC.HIDE_SECONDS}초 동안 흩어져 맵의 사물로 변신합니다. 변신 중에는 움직일 수 없습니다.`,
    `술래는 화면 중앙 조준점으로 대상을 맞추고 포획 버튼을 눌러야만 잡을 수 있습니다. 부딪히기만 해서는 잡히지 않습니다.`,
    `포획 거리 ${GC.CAPTURE_RANGE}m, 벽이나 바위에 가려지면 실패. 빗나가면 ${GC.CAPTURE_COOLDOWN_MS / 1000}초 대기.`,
    `${GC.SEEK_SECONDS}초 동안 한 명이라도 살아남으면 숨는 팀 승리, 모두 잡히면 술래 팀 승리.`,
    `점수: 포획 1명당 ${SCORE_CONFIG.CAPTURE} · 끝까지 생존 ${SCORE_CONFIG.SURVIVE} · 승리 팀 보너스 ${SCORE_CONFIG.WIN_BONUS}`,
  ]
    .map((t) => `<li>${t}</li>`)
    .join('');

  // 페이지를 닫을 때 Three.js 자원 정리
  window.addEventListener('pagehide', () => {
    if (controls) controls.dispose();
    if (world) world.dispose();
  });
}

// ---------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------
async function boot() {
  bindUI();
  if (!configLooksValid()) {
    showLoading('firebase-config.js 에 Firebase 프로젝트 설정값을 먼저 입력해 주세요. (README 3단계 참고)', { error: true });
    return;
  }
  showLoading(USE_EMULATORS ? '로컬 에뮬레이터에 연결하는 중…' : 'Firebase에 연결하는 중…');
  try {
    initFirebase();
    const user = await withTimeout(signIn(), 15000, '로그인 시간이 초과되었습니다.');
    S.uid = user.uid;
  } catch (e) {
    const hint =
      e && e.code === 'auth/operation-not-allowed'
        ? 'Firebase 콘솔에서 익명 로그인을 사용 설정해 주세요. (README 4단계)'
        : e && e.code === 'auth/configuration-not-found'
          ? 'Authentication 이 아직 시작되지 않았습니다. Firebase 콘솔에서 Authentication 을 시작해 주세요.'
          : (e && e.message) || '알 수 없는 오류';
    showLoading(`연결에 실패했습니다. ${hint}`, { error: true, retry: true });
    return;
  }
  try {
    await withTimeout(preloadModelOverrides(), 20000, '모델 불러오기 시간 초과');
  } catch (e) {
    console.warn(e);
  }
  watchConnection();
  showScreen('home');
  checkRejoin();
  requestAnimationFrame(loop);
}

boot();
