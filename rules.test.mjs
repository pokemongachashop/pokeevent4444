// 보안 규칙 + 게임 동작 테스트:  npm test
// shared/actions.js 가 만드는 실제 업데이트 묶음을 database.rules.json 으로 검사합니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRulesDb } from './rules-sim.js';
import * as A from '../shared/actions.js';
import { GAME_CONFIG as C, seekerCountFor, computeRoundResults, compareLeaderboard } from '../shared/config.js';
import { getForestMap, mulberry32, hasLineOfSight } from '../shared/forest-map.js';

const RULES = JSON.parse(readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8'));
const TS = { '.sv': 'timestamp' };
const map = getForestMap();
const CODE = 'ABCDEF';
const uid = (i) => `user${String(i).padStart(2, '0')}`;

function env() {
  const clock = { t: 1_800_000_000_000 };
  const db = createRulesDb(RULES, { now: () => clock.t });
  const room = () => db.get(`rooms/${CODE}`);
  const online = (u) => db.force(`roomPresence/${CODE}/${u}`, { online: true, at: clock.t });
  const offline = (u) => db.force(`roomPresence/${CODE}/${u}`, { online: false, at: clock.t });
  return { clock, db, room, online, offline };
}

function lobby(n) {
  const e = env();
  const r = e.db.update(uid(0), A.createRoomUpdate({ uid: uid(0), code: CODE, nickname: '방장', character: 'volt', TS }));
  assert.ok(r.ok, JSON.stringify(r));
  e.online(uid(0));
  for (let i = 1; i < n; i++) {
    const slot = A.freeSlot(e.room().slots);
    const j = e.db.update(uid(i), A.joinUpdate({ uid: uid(i), code: CODE, nickname: `플레이어${i}`, character: 'leaf', slot, TS }));
    assert.ok(j.ok, `${i}번째 참가 실패 ${JSON.stringify(j)}`);
    e.online(uid(i));
  }
  return e;
}

function started(n, seed = 1) {
  const e = lobby(n);
  const rm = e.room();
  const { update } = A.startRoundUpdate({
    code: CODE,
    room: { ...rm, pos: e.db.get(`roomPos/${CODE}`) || {} },
    participants: Object.keys(rm.players),
    serverNow: e.clock.t,
    map,
    rand: mulberry32(seed),
    TS,
  });
  const r = e.db.update(uid(0), update);
  assert.ok(r.ok, JSON.stringify(r));
  const round = e.room().round;
  return { ...e, round, seekers: Object.keys(round.seekers), hiders: Object.keys(round.hiders) };
}

const pos = (e, u) => e.db.get(`roomPos/${CODE}/${u}`);
/** 테스트 준비: 규칙을 거치지 않고 위치 지정 */
const place = (e, u, x, z) => e.db.force(`roomPos/${CODE}/${u}`, { x, z, r: 0, t: e.clock.t });
const move = (e, u, x, z) => e.db.set(u, `roomPos/${CODE}/${u}`, A.positionValue({ x, z, r: 0, TS }));
const capture = (e, s, t, p = pos(e, s)) => e.db.update(s, A.captureUpdate({ code: CODE, uid: s, target: t, round: e.room().round, pos: { x: p.x, z: p.z, r: 0 }, TS }));
const toSeek = (e) => (e.clock.t = e.round.hideEndsAt + 500);

// ---------------------------------------------------------------------
test('규칙 파일이 shared/config.js 와 일치', () => {
  execFileSync(process.execPath, [new URL('../scripts/build-rules.mjs', import.meta.url).pathname, '--check']);
});

test('술래 수 / 맵 / 점수 / 순위 규칙', () => {
  assert.deepEqual([2, 6, 7, 13, 14, 20].map((n) => seekerCountFor(n)), [1, 1, 2, 2, 3, 3]);
  assert.equal(seekerCountFor(3, 3), 2);
  assert.equal(map.props.length, 92);
  assert.equal(hasLineOfSight(map, 14, -10, 26, -10), false);
  const r = computeRoundResults({
    seekers: { s: true }, hiders: { a: true, b: true }, alive: { b: true }, names: {},
    captures: { a: { by: 's', at: 1000 + 35_500 } }, captureCount: { s: 1 },
    hideEndsAt: 1000, roundEndsAt: 181_000, endedAt: 181_400, winner: 'hiders',
  });
  assert.deepEqual([r.s.points, r.a.points, r.b.points, r.a.survivalSeconds, r.b.survivalSeconds], [10, 10, 30, 35, 180]);
  const rows = [{ uid: '1', points: 50, wins: 2, gamesPlayed: 5 }, { uid: '2', points: 50, wins: 2, gamesPlayed: 4 }, { uid: '3', points: 50, wins: 3, gamesPlayed: 9 }];
  assert.deepEqual(rows.sort(compareLeaderboard).map((x) => x.uid), ['3', '2', '1']);
});

test('참가: 20명까지, 21번째 거부, 중복 닉네임, 잘못된 자리, 진행 중 참가 거부', () => {
  const e = lobby(20);
  assert.equal(Object.keys(e.room().players).length, 20);
  assert.equal(A.freeSlot(e.room().slots), null);
  const x = e.db.update('late', A.joinUpdate({ uid: 'late', code: CODE, nickname: '늦은사람', character: 'volt', slot: 's3', TS }));
  assert.equal(x.ok, false, '이미 찬 자리');
  const y = e.db.update('late', A.joinUpdate({ uid: 'late', code: CODE, nickname: '늦은사람', character: 'volt', slot: 's20', TS }));
  assert.equal(y.ok, false, '존재하지 않는 자리');

  const f = lobby(2);
  const dup = f.db.update('z', A.joinUpdate({ uid: 'z', code: CODE, nickname: '플레이어1', character: 'volt', slot: 's5', TS }));
  assert.equal(dup.ok, false, '중복 닉네임');
  const dupCase = f.db.update('z', A.joinUpdate({ uid: 'z', code: CODE, nickname: '방장', character: 'volt', slot: 's5', TS }));
  assert.equal(dupCase.ok, false);

  const g = started(3);
  const late = g.db.update('z', A.joinUpdate({ uid: 'z', code: CODE, nickname: '늦음', character: 'volt', slot: 's9', TS }));
  assert.equal(late.ok, false, '게임 중 참가 불가');
});

test('읽기 권한: 참가자만 방 내용, 코드를 알면 meta 만', () => {
  const e = lobby(2);
  assert.equal(e.db.canRead('stranger', `rooms/${CODE}/players`), false);
  assert.equal(e.db.canRead('stranger', `rooms/${CODE}/meta`), true);
  assert.equal(e.db.canRead(uid(1), `rooms/${CODE}/players`), true);
  assert.equal(e.db.canRead(null, `rooms/${CODE}/meta`), false);
  assert.equal(e.db.canRead('stranger', `roomPos/${CODE}`), false);
});

test('시작 권한: 방장만, 역할을 스스로 바꿀 수 없음', () => {
  const e = lobby(3);
  const rm = e.room();
  const args = { code: CODE, room: rm, participants: Object.keys(rm.players), serverNow: e.clock.t, map, TS };
  assert.equal(e.db.update(uid(1), A.startRoundUpdate(args).update).ok, false, '방장이 아님');
  const stale = A.startRoundUpdate({ ...args, serverNow: e.clock.t - 60_000 }).update;
  assert.equal(e.db.update(uid(0), stale).ok, false, '시작 시각 조작');
  assert.equal(e.db.update(uid(0), A.startRoundUpdate(args).update).ok, true);
  const round = e.room().round;
  const hider = Object.keys(round.hiders)[0];
  assert.equal(e.db.set(hider, `rooms/${CODE}/round/seekers/${hider}`, true).ok, false);
  assert.equal(e.db.set(hider, `rooms/${CODE}/round/activeSeekers/${hider}`, true).ok, false);
  assert.equal(e.db.set(hider, `rooms/${CODE}/round/roundEndsAt`, round.roundEndsAt + 999999).ok, false);
});

test('이동 규칙: 정상 이동, 순간이동, 숨는 시간 술래 고정, 변신 중 고정', () => {
  const e = started(2);
  const [s] = e.seekers;
  const [h] = e.hiders;
  const hp = pos(e, h);
  e.clock.t += 150;
  assert.equal(move(e, h, hp.x + 0.8, hp.z).ok, true, '정상 이동');
  e.clock.t += 150;
  assert.equal(move(e, h, hp.x + 4.5, hp.z).ok, false, '0.15초에 3.7 이동 = 너무 빠름');
  e.clock.t += 150;
  assert.equal(move(e, h, 50, 0).ok, false, '맵 밖');
  const sp = pos(e, s);
  e.clock.t += 1000;
  assert.equal(move(e, s, sp.x + 1, sp.z).ok, false, '숨는 시간에 술래 이동');
  assert.equal(e.db.update(h, A.disguiseUpdate({ code: CODE, uid: h, propType: 'barrel', TS })).ok, true);
  e.clock.t += 1000;
  const cur = pos(e, h);
  assert.equal(move(e, h, cur.x + 0.5, cur.z).ok, false, '변신 중 이동');
  toSeek(e);
  assert.equal(move(e, s, sp.x + 1, sp.z).ok, true, '추격 시간 술래 이동');
});

test('변신: 숨는 팀만, 허용 사물만, 해제 후 쿨다운', () => {
  const e = started(2);
  const [s] = e.seekers;
  const [h] = e.hiders;
  assert.equal(e.db.update(s, A.disguiseUpdate({ code: CODE, uid: s, propType: 'barrel', TS })).ok, false);
  assert.equal(e.db.update(h, A.disguiseUpdate({ code: CODE, uid: h, propType: 'castle', TS })).ok, false);
  assert.equal(e.db.update(h, A.disguiseUpdate({ code: CODE, uid: h, propType: 'barrel', TS })).ok, true);
  assert.equal(e.db.update(h, A.disguiseUpdate({ code: CODE, uid: h, propType: null, TS })).ok, true);
  e.clock.t += 1000;
  assert.equal(e.db.update(h, A.disguiseUpdate({ code: CODE, uid: h, propType: 'crate', TS })).ok, false, '쿨다운');
  e.clock.t += C.DISGUISE_COOLDOWN_MS;
  assert.equal(e.db.update(h, A.disguiseUpdate({ code: CODE, uid: h, propType: 'crate', TS })).ok, true);
  assert.equal(e.db.set(s, `rooms/${CODE}/players/${h}/disguise`, null).ok, false, '남의 변신 해제 불가');
});

test('포획 규칙: 자동 포획 없음, 숨는 시간·거리·대상·쿨다운·중복·숨는 팀 포획 거부', () => {
  const e = started(3, 5);
  const [s] = e.seekers;
  const [h1, h2] = e.hiders;
  place(e, s, 0, 0);
  place(e, h1, 0, 2);
  // 옆을 지나가며 이동만 해서는 아무 일도 없음
  toSeek(e);
  for (let i = 1; i <= 8; i++) {
    e.clock.t += 150;
    assert.equal(move(e, s, 0, i * 0.5).ok, true);
  }
  assert.equal(e.room().round.alive[h1], true, '접촉만으로는 포획되지 않음');

  // 숨는 시간
  const f = started(3, 5);
  place(f, f.seekers[0], 0, 0);
  place(f, f.hiders[0], 0, 2);
  f.clock.t += 100;
  assert.equal(capture(f, f.seekers[0], f.hiders[0]).ok, false, '숨는 시간');

  e.clock.t += 2000;
  place(e, s, 0, 0);
  place(e, h1, 0, 3.6);
  e.clock.t += 50;
  assert.equal(capture(e, s, h1).ok, false, '거리 밖');
  assert.equal(capture(e, s, 'p12').ok, false, '일반 사물');
  assert.equal(capture(e, s, s).ok, false, '술래 자신');

  // 위치 위조: 저장된 위치에서 10 떨어진 곳이라 주장
  place(e, h1, 10, 0);
  e.clock.t += 50;
  assert.equal(capture(e, s, h1, { x: 9, z: 0 }).ok, false, '위치 위조 (속도 규칙)');

  place(e, h1, 0, 2.5);
  e.clock.t += 50;
  assert.equal(capture(e, s, h1).ok, true, '정상 포획');
  assert.equal(e.room().round.alive[h1], undefined);
  assert.equal(e.room().round.captureCount[s], 1);

  place(e, h2, 1, 1);
  e.clock.t += 300;
  assert.equal(capture(e, s, h2).ok, false, '쿨다운');
  e.clock.t += 1500;
  assert.equal(capture(e, s, h1).ok, false, '이미 포획됨');
  place(e, h1, 0, 1);
  assert.equal(capture(e, h2, h1).ok, false, '숨는 팀은 포획 불가');
  // 포획 수 부풀리기
  assert.equal(e.db.set(s, `rooms/${CODE}/round/captureCount/${s}`, 5).ok, false);
  // 포획된 사람은 다시 움직일 수 없음
  e.clock.t += 200;
  assert.equal(move(e, h1, 0.3, 1).ok, false);
  // 쿨다운이 지나면 다음 포획 가능 (위 거부 사유가 쿨다운이었음을 확인)
  place(e, s, 0, 0);
  place(e, h2, 1, 1);
  e.clock.t += 50;
  assert.equal(capture(e, s, h2).ok, true);
});

test('동시 포획: 같은 대상은 한 번만', () => {
  const e = started(8, 11);
  assert.equal(e.seekers.length, 2);
  const [s1, s2] = e.seekers;
  const [h] = e.hiders;
  toSeek(e);
  place(e, h, 0, 0);
  place(e, s1, 0, -2);
  place(e, s2, 0, 2);
  e.clock.t += 50;
  const a = capture(e, s1, h);
  const b = capture(e, s2, h);
  assert.deepEqual([a.ok, b.ok], [true, false]);
});

test('라운드 종료 조건: 미리 끝낼 수 없음, 모두 포획/시간 종료 시에만', () => {
  const e = started(3, 5);
  const [s] = e.seekers;
  const [h1, h2] = e.hiders;
  assert.equal(e.db.update(h1, A.endRoundUpdate({ code: CODE, winner: 'hiders', TS })).ok, false, '시간 전 숨는 팀 승리');
  assert.equal(e.db.update(s, A.endRoundUpdate({ code: CODE, winner: 'seekers', TS })).ok, false, '생존자 있음');
  toSeek(e);
  for (const h of [h1, h2]) {
    e.clock.t += 2000;
    place(e, s, 0, 0);
    place(e, h, 1, 1);
    e.clock.t += 50;
    assert.equal(capture(e, s, h).ok, true);
  }
  assert.equal(A.endCondition(e.room().round, e.clock.t), 'seekers');
  assert.equal(e.db.update(h1, A.endRoundUpdate({ code: CODE, winner: 'hiders', TS })).ok, false);
  assert.equal(e.db.update(h1, A.endRoundUpdate({ code: CODE, winner: 'seekers', TS })).ok, true);
  assert.equal(e.db.update(s, A.endRoundUpdate({ code: CODE, winner: 'seekers', TS })).ok, false, '두 번 종료 불가');
  e.clock.t += 2000;
  place(e, s, 0, 0);
  assert.equal(capture(e, s, h1).ok, false, '종료 후 포획 불가');

  const t = started(2, 3);
  t.clock.t = t.round.roundEndsAt + 100;
  assert.equal(t.db.update(t.hiders[0], A.endRoundUpdate({ code: CODE, winner: 'hiders', TS })).ok, true, '시간 종료');
});

test('전적: 결과대로만, 라운드당 한 번만, 조작 거부', () => {
  const e = started(3, 5);
  const [s] = e.seekers;
  const [h1, h2] = e.hiders;
  toSeek(e);
  e.clock.t += 30_000;
  place(e, s, 0, 0);
  place(e, h1, 1, 1);
  e.clock.t += 50;
  assert.equal(capture(e, s, h1).ok, true);
  e.clock.t = e.round.roundEndsAt + 700;
  assert.equal(e.db.update(s, A.endRoundUpdate({ code: CODE, winner: 'hiders', TS })).ok, true);
  const round = e.room().round;

  const record = (u, tamper) => {
    let old = e.db.get(`playerStats/${u}`);
    if (!old) {
      assert.equal(e.db.set(u, `playerStats/${u}`, A.statsInitValue({ nickname: '이름', TS })).ok, true, 'init');
      old = e.db.get(`playerStats/${u}`);
    }
    const up = A.statsRecordUpdate({ uid: u, code: CODE, round, old, nickname: '이름', TS });
    if (tamper) tamper(up[`playerStats/${u}`]);
    return e.db.update(u, up);
  };
  assert.equal(record(s, (v) => (v.points += 100)).ok, false, '점수 부풀리기');
  assert.equal(record(s, (v) => (v.wins += 1)).ok, false, '승리 조작');
  assert.equal(record(s).ok, true, '술래 기록');
  assert.deepEqual(
    (({ gamesPlayed, wins, losses, captures, points }) => ({ gamesPlayed, wins, losses, captures, points }))(e.db.get(`playerStats/${s}`)),
    { gamesPlayed: 1, wins: 0, losses: 1, captures: 1, points: 10 }
  );
  assert.equal(record(s).ok, false, '같은 라운드 중복 기록');
  assert.equal(record(h1).ok, true, '포획된 숨는 팀 (팀 승리)');
  assert.equal(e.db.get(`playerStats/${h1}`).totalSurvivalSeconds, 30);
  assert.equal(record(h2, (v) => (v.totalSurvivalSeconds += 50)).ok, false, '생존 시간 조작');
  assert.equal(record(h2).ok, true, '생존');
  const st = e.db.get(`playerStats/${h2}`);
  assert.deepEqual([st.survivals, st.points, st.totalSurvivalSeconds], [1, 30, C.SEEK_SECONDS]);
  // 남의 전적 수정 불가
  assert.equal(e.db.set(s, `playerStats/${h2}/points`, 0).ok, false);
  // 경기 기록은 한 번만
  assert.equal(e.db.update(s, A.matchHistoryUpdate({ code: CODE, round, mapId: map.id })).ok, true);
  assert.equal(e.db.update(h1, A.matchHistoryUpdate({ code: CODE, round, mapId: map.id })).ok, false);

  // 진행 중인 라운드로는 기록 불가
  const g = started(2, 2);
  const u = g.seekers[0];
  g.db.set(u, `playerStats/${u}`, A.statsInitValue({ nickname: '이름', TS }));
  const fake = A.statsRecordUpdate({ uid: u, code: CODE, round: { ...g.room().round, phase: 'ended', winner: 'seekers', endedAt: g.clock.t }, old: g.db.get(`playerStats/${u}`), nickname: '이름', TS });
  assert.equal(g.db.update(u, fake).ok, false);
});

test('나가기 / 연결 끊김 / 기권 / 방장 위임', () => {
  const e = started(3, 5);
  const [s] = e.seekers;
  const [h1, h2] = e.hiders;
  // 게임 중 이탈 기록 없이 플레이어만 지우기는 불가
  assert.equal(e.db.set(h2, `rooms/${CODE}/players/${h2}`, null).ok, false);
  // 연결 끊긴 지 얼마 안 됐으면 기권 처리 불가
  e.offline(h1);
  e.clock.t += 10_000;
  const ff = A.forfeitUpdate({ code: CODE, round: e.room().round, target: h1, offlineAt: e.db.get(`roomPresence/${CODE}/${h1}`).at, TS });
  assert.equal(e.db.update(s, ff).ok, false);
  e.clock.t += C.DISCONNECT_GRACE_MS;
  assert.equal(e.db.update(s, ff).ok, true, '유예 시간 후 기권');
  // 스스로 나가기 (게임 중)
  assert.equal(e.db.update(h2, A.leaveUpdate({ uid: h2, code: CODE, room: e.room(), TS })).ok, true);
  assert.equal(A.endCondition(e.room().round, e.clock.t), 'seekers');
  // 방장 위임: 방장이 온라인이면 불가, 오래 끊기면 가능
  const host = e.room().meta.hostId;
  const other = [uid(0), uid(1), uid(2)].find((u) => u !== host && e.room().players[u]);
  assert.equal(e.db.update(other, A.claimHostUpdate({ code: CODE, uid: other })).ok, false);
  e.offline(host);
  e.clock.t += C.HOST_OFFLINE_CLAIM_MS + 1;
  assert.equal(e.db.update(other, A.claimHostUpdate({ code: CODE, uid: other })).ok, true);
});

test('대기실: 방장 내보내기, 마지막 사람이 나가면 방 삭제', () => {
  const e = lobby(3);
  assert.equal(e.db.update(uid(1), A.kickUpdate({ code: CODE, room: e.room(), target: uid(2) })).ok, false, '방장만');
  assert.equal(e.db.update(uid(0), A.kickUpdate({ code: CODE, room: e.room(), target: uid(2) })).ok, true);
  assert.equal(e.room().slots.s2, undefined, '자리 반환');
  assert.equal(e.db.set(uid(1), `rooms/${CODE}`, null).ok, false, '사람이 있으면 삭제 불가');
  for (const u of [uid(0), uid(1)]) assert.equal(e.db.update(u, A.leaveUpdate({ uid: u, code: CODE, room: e.room(), TS })).ok, true);
  assert.equal(e.db.set(uid(1), `rooms/${CODE}`, null).ok, true, '빈 방 삭제');
  assert.equal(e.db.set(uid(1), `roomPresence/${CODE}`, null).ok, true);
  assert.equal(e.db.get(`rooms/${CODE}`), null);
});

test('다음 라운드 / 대기실 복귀', () => {
  const e = started(3, 5);
  e.clock.t = e.round.roundEndsAt + 10;
  assert.equal(e.db.update(uid(1), A.endRoundUpdate({ code: CODE, winner: 'hiders', TS })).ok, true);
  const rm = e.room();
  const next = A.startRoundUpdate({ code: CODE, room: { ...rm, pos: e.db.get(`roomPos/${CODE}`) }, participants: Object.keys(rm.players), serverNow: e.clock.t, map, TS });
  assert.equal(e.db.update(uid(0), next.update).ok, true, '결과 → 다음 라운드');
  assert.equal(e.room().meta.roundNumber, 2);
  e.clock.t = e.room().round.roundEndsAt + 10;
  assert.equal(e.db.update(uid(2), A.endRoundUpdate({ code: CODE, winner: 'hiders', TS })).ok, true);
  assert.equal(e.db.update(uid(1), A.returnToLobbyUpdate({ code: CODE, room: e.room() })).ok, false, '방장만');
  assert.equal(e.db.update(uid(0), A.returnToLobbyUpdate({ code: CODE, room: e.room() })).ok, true);
  assert.equal(e.room().meta.status, 'lobby');
});
