// =====================================================================
// 게임 동작 → Realtime Database "다중 경로 업데이트" 묶음 생성
// ---------------------------------------------------------------------
// 서버(Cloud Functions) 없이 Spark 요금제로 동작하므로, 모든 게임 동작은
// 클라이언트가 한 번의 원자적 update() 로 기록하고, database.rules.json 이
// 그 묶음이 규칙에 맞는지(역할, 시간, 거리, 쿨다운, 중복 등) 검사합니다.
// 규칙에 맞지 않으면 묶음 전체가 거부되고 아무것도 바뀌지 않습니다.
//
// 이 파일은 순수 함수만 담고 있어 게임(game.js)과 테스트(tests/)가 같이 사용합니다.
// TS 인자는 서버 시각 자리표시자입니다. (브라우저: serverTimestamp(), 테스트: {'.sv':'timestamp'})
// =====================================================================

import {
  GAME_CONFIG as C,
  SLOT_IDS,
  nicknameKey,
  seekerCountFor,
  computeRoundResults,
} from './config.js';
import { FOREST_MAP_ID } from './forest-map.js';

const round2 = (v) => Math.round(v * 100) / 100;

export function createRoomUpdate({ uid, code, nickname, character, TS }) {
  const key = nicknameKey(nickname);
  return {
    [`rooms/${code}`]: {
      meta: {
        hostId: uid,
        status: 'lobby',
        mapId: FOREST_MAP_ID,
        roundNumber: 0,
        maxPlayers: C.MAX_PLAYERS,
        createdAt: TS,
        seekerMode: 'auto',
      },
      slots: { s0: uid },
      nicks: { [key]: uid },
      players: { [uid]: { nickname, nickKey: key, slot: 's0', character, ready: false, joinedAt: TS } },
    },
    [`userRooms/${uid}`]: code,
  };
}

/** 비어 있는 첫 자리. 없으면 null (방이 가득 참) */
export function freeSlot(slots) {
  return SLOT_IDS.find((s) => !(slots && slots[s])) || null;
}

export function joinUpdate({ uid, code, nickname, character, slot, TS }) {
  const key = nicknameKey(nickname);
  return {
    [`rooms/${code}/slots/${slot}`]: uid,
    [`rooms/${code}/nicks/${key}`]: uid,
    [`rooms/${code}/players/${uid}`]: { nickname, nickKey: key, slot, character, ready: false, joinedAt: TS },
    [`userRooms/${uid}`]: code,
  };
}

function isParticipantInPlay(room, uid) {
  const r = room && room.round;
  return !!(
    room &&
    room.meta &&
    room.meta.status === 'playing' &&
    r &&
    r.phase === 'playing' &&
    ((r.seekers && r.seekers[uid]) || (r.hiders && r.hiders[uid])) &&
    !(r.left && r.left[uid])
  );
}

/** 스스로 나가기 (게임 중이면 기권 기록 포함) */
export function leaveUpdate({ uid, code, room, TS }) {
  const me = room && room.players && room.players[uid];
  const u = {
    [`roomPos/${code}/${uid}`]: null,
    [`roomPresence/${code}/${uid}`]: null,
    [`userRooms/${uid}`]: null,
  };
  if (!me) return u;
  u[`rooms/${code}/players/${uid}`] = null;
  if (room.slots && room.slots[me.slot] === uid) u[`rooms/${code}/slots/${me.slot}`] = null;
  if (room.nicks && room.nicks[me.nickKey] === uid) u[`rooms/${code}/nicks/${me.nickKey}`] = null;
  if (isParticipantInPlay(room, uid)) {
    u[`rooms/${code}/round/left/${uid}`] = TS;
    if (room.round.alive && room.round.alive[uid]) u[`rooms/${code}/round/alive/${uid}`] = null;
    if (room.round.activeSeekers && room.round.activeSeekers[uid]) u[`rooms/${code}/round/activeSeekers/${uid}`] = null;
  }
  return u;
}

/** 방장: 대기실/결과 화면에서 참가자 내보내기 (연결이 끊긴 사람 정리) */
export function kickUpdate({ code, room, target }) {
  const p = room.players[target];
  const u = {
    [`rooms/${code}/players/${target}`]: null,
    [`roomPos/${code}/${target}`]: null,
    [`roomPresence/${code}/${target}`]: null,
  };
  if (p && room.slots && room.slots[p.slot] === target) u[`rooms/${code}/slots/${p.slot}`] = null;
  if (p && room.nicks && room.nicks[p.nickKey] === target) u[`rooms/${code}/nicks/${p.nickKey}`] = null;
  return u;
}

export function claimHostUpdate({ code, uid }) {
  return { [`rooms/${code}/meta/hostId`]: uid };
}

export function seekerModeUpdate({ code, mode }) {
  return { [`rooms/${code}/meta/seekerMode`]: mode };
}

/**
 * 방장: 라운드 시작.
 * @param participants 이번 라운드 참가자 uid 목록 (연결된 사람)
 * @param serverNow 서버 기준 현재 시각 추정값 (규칙이 ±3초 허용)
 */
export function startRoundUpdate({ code, room, participants, serverNow, map, rand = Math.random, TS }) {
  const order = participants.slice().sort();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const n = seekerCountFor(order.length, room.meta.seekerMode || 'auto');
  const seekers = order.slice(0, n);
  const hiders = order.slice(n);
  const startedAt = Math.round(serverNow);
  const hideEndsAt = startedAt + (C.START_COUNTDOWN_SECONDS + C.HIDE_SECONDS) * 1000;
  const number = (room.meta.roundNumber || 0) + 1;
  const round = {
    id: `${code}_${startedAt}`,
    number,
    phase: 'playing',
    startedAt,
    hideEndsAt,
    roundEndsAt: hideEndsAt + C.SEEK_SECONDS * 1000,
    seekers: {},
    hiders: {},
    alive: {},
    activeSeekers: {},
    names: {},
  };
  const u = {};
  const spawns = map.spawns.hiders.slice();
  for (let i = spawns.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [spawns[i], spawns[j]] = [spawns[j], spawns[i]];
  }
  seekers.forEach((uid, i) => {
    round.seekers[uid] = true;
    round.activeSeekers[uid] = true;
    const [x, z] = map.spawns.seekers[i % map.spawns.seekers.length];
    u[`roomPos/${code}/${uid}`] = { x, z, r: 0, t: TS };
  });
  hiders.forEach((uid, i) => {
    round.hiders[uid] = true;
    round.alive[uid] = true;
    const [x, z] = spawns[i % spawns.length];
    u[`roomPos/${code}/${uid}`] = { x: round2(x), z: round2(z), r: round2(Math.atan2(x, z)), t: TS };
  });
  for (const uid of order) round.names[uid] = room.players[uid].nickname;

  u[`rooms/${code}/round`] = round;
  u[`rooms/${code}/meta/status`] = 'playing';
  u[`rooms/${code}/meta/roundNumber`] = number;
  for (const [uid, p] of Object.entries(room.players || {})) {
    if (p.ready) u[`rooms/${code}/players/${uid}/ready`] = false;
    if (p.disguise) u[`rooms/${code}/players/${uid}/disguise`] = null;
    if (p.undisguisedAt) u[`rooms/${code}/players/${uid}/undisguisedAt`] = null;
  }
  // 이번 라운드에 참가하지 않는 사람의 지난 위치 정리
  for (const uid of Object.keys((room.pos || {}))) {
    if (!round.seekers[uid] && !round.hiders[uid]) u[`roomPos/${code}/${uid}`] = null;
  }
  return { update: u, round };
}

/** 방장: 결과 화면 → 대기실 */
export function returnToLobbyUpdate({ code, room }) {
  const u = {
    [`rooms/${code}/meta/status`]: 'lobby',
    [`rooms/${code}/round`]: null,
    [`roomPos/${code}`]: null,
  };
  for (const [uid, p] of Object.entries(room.players || {})) {
    if (p.ready) u[`rooms/${code}/players/${uid}/ready`] = false;
  }
  return u;
}

export function positionValue({ x, z, r, TS }) {
  return { x: round2(x), z: round2(z), r: round2(r), t: TS };
}

/** 술래: 포획. 현재 위치를 함께 기록하고, 규칙이 그 위치로 거리를 검사합니다. */
export function captureUpdate({ code, uid, target, round, pos, TS }) {
  const prev = (round.captureCount && round.captureCount[uid]) || 0;
  return {
    [`roomPos/${code}/${uid}`]: positionValue({ ...pos, TS }),
    [`rooms/${code}/round/captures/${target}`]: { by: uid, at: TS },
    [`rooms/${code}/round/alive/${target}`]: null,
    [`rooms/${code}/round/captureCount/${uid}`]: prev + 1,
    [`rooms/${code}/round/lastCaptureBy/${uid}`]: target,
    [`rooms/${code}/round/lastCaptureAt/${uid}`]: TS,
  };
}

export function disguiseUpdate({ code, uid, propType, TS }) {
  if (propType) return { [`rooms/${code}/players/${uid}/disguise`]: propType };
  return {
    [`rooms/${code}/players/${uid}/disguise`]: null,
    [`rooms/${code}/players/${uid}/undisguisedAt`]: TS,
  };
}

/** 라운드 종료 (조건을 만족하면 누구나 기록 가능, 규칙이 조건 검사) */
export function endRoundUpdate({ code, winner, TS }) {
  return {
    [`rooms/${code}/round/phase`]: 'ended',
    [`rooms/${code}/round/winner`]: winner,
    [`rooms/${code}/round/endedAt`]: TS,
    [`rooms/${code}/meta/status`]: 'results',
  };
}

/** 지금 끝낼 수 있다면 승리 팀, 아니면 null */
export function endCondition(round, serverNow) {
  if (!round || round.phase !== 'playing') return null;
  if (!round.alive || !Object.keys(round.alive).length) return 'seekers';
  if (!round.activeSeekers || !Object.keys(round.activeSeekers).length) return 'hiders';
  if (serverNow >= round.roundEndsAt) return 'hiders';
  return null;
}

/** 연결이 끊긴 지 오래된 참가자 기권 처리 (offlineAt = 그 사람 presence.at) */
export function forfeitUpdate({ code, round, target, offlineAt, TS }) {
  const u = { [`rooms/${code}/round/left/${target}`]: offlineAt == null ? TS : offlineAt };
  if (round.alive && round.alive[target]) u[`rooms/${code}/round/alive/${target}`] = null;
  if (round.activeSeekers && round.activeSeekers[target]) u[`rooms/${code}/round/activeSeekers/${target}`] = null;
  return u;
}

export const STAT_FIELDS = ['gamesPlayed', 'wins', 'losses', 'captures', 'survivals', 'totalSurvivalSeconds', 'points'];

export function statsInitValue({ nickname, TS }) {
  const v = { nickname, updatedAt: TS, lastRound: 'none', lastRoom: 'none' };
  for (const f of STAT_FIELDS) v[f] = 0;
  return v;
}

/** 라운드 결과를 내 전적에 반영 (규칙이 라운드 데이터와 대조해 검사, 같은 라운드는 한 번만) */
export function statsRecordUpdate({ uid, code, round, old, nickname, TS }) {
  const r = computeRoundResults(round)[uid];
  if (!r || r.outcome === 'left') return null;
  const win = r.outcome === 'win';
  const v = {
    nickname,
    gamesPlayed: old.gamesPlayed + 1,
    wins: old.wins + (win ? 1 : 0),
    losses: old.losses + (win ? 0 : 1),
    captures: old.captures + r.captures,
    survivals: old.survivals + (r.survived ? 1 : 0),
    totalSurvivalSeconds: old.totalSurvivalSeconds + r.survivalSeconds,
    points: old.points + r.points,
    updatedAt: TS,
    lastRound: round.id,
    lastRoom: code,
  };
  return {
    [`playerStats/${uid}`]: v,
    [`statRounds/${uid}/${round.id}`]: true,
  };
}

export function matchHistoryUpdate({ code, round, mapId }) {
  return {
    [`matchHistory/${round.id}`]: {
      roomId: code,
      mapId,
      roundNumber: round.number,
      startedAt: round.startedAt,
      endedAt: round.endedAt,
      winner: round.winner,
      playerResults: computeRoundResults(round),
    },
  };
}
