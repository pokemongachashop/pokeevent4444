// =====================================================================
// database.rules.json 생성기
// ---------------------------------------------------------------------
// Spark 요금제에는 서버 코드가 없으므로, 게임 규칙(역할, 시간, 이동 속도,
// 포획 거리, 쿨다운, 중복 포획 방지, 전적 계산)을 Realtime Database 보안 규칙이 검사합니다.
// 규칙에 들어가는 숫자를 shared/config.js 와 항상 같게 유지하려고 이 스크립트로 만듭니다.
//
// 사용:  node scripts/build-rules.mjs          → database.rules.json 생성
//        node scripts/build-rules.mjs --check  → 파일이 최신인지 확인만
// =====================================================================

import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GAME_CONFIG as C,
  SCORE_CONFIG as SC,
  CHARACTER_IDS,
  PROP_TYPE_IDS,
  ROOM_CODE_PATTERN,
  SLOT_IDS,
} from '../shared/config.js';
import { FOREST_MAP_ID } from '../shared/forest-map.js';

const and = (...xs) => '(' + xs.filter(Boolean).join(' && ') + ')';
const or = (...xs) => '(' + xs.filter(Boolean).join(' || ') + ')';
const oneOf = (expr, values) => or(...values.map((v) => `${expr} === ${typeof v === 'string' ? `'${v}'` : v}`));
const up = (n) => 'newData' + '.parent()'.repeat(n); // n 단계 위의 "쓰기 후" 데이터

// --- 방 관련 공통 식 (모두 "쓰기 전" 데이터 기준) ---
const ROOM = `root.child('rooms').child($roomId)`;
const META = (f) => `${ROOM}.child('meta').child('${f}')`;
const RD = (f) => `${ROOM}.child('round').child('${f}')`;
const AUTH = 'auth != null';
const MEMBER = (u) => `${ROOM}.child('players').child(${u}).exists()`;
const IS_HOST = `${META('hostId')}.val() === auth.uid`;
const STATUS = `${META('status')}.val()`;
const PLAYING = and(`${STATUS} === 'playing'`, `${RD('phase')}.val() === 'playing'`);
const PRES = (u) => `root.child('roomPresence').child($roomId).child(${u})`;
const OFFLINE_FOR = (u, ms) => and(`${PRES(u)}.child('online').val() === false`, `now - ${PRES(u)}.child('at').val() >= ${ms}`);
const IN_ROUND = (u) => or(`${RD('seekers')}.child(${u}).exists()`, `${RD('hiders')}.child(${u}).exists()`);

const codeRe = `/${ROOM_CODE_PATTERN}/`;
const slotRe = `/^(${SLOT_IDS.join('|')})$/`;
const charRe = `/^(${CHARACTER_IDS.join('|')})$/`;
const propRe = `/^(${PROP_TYPE_IDS.join('|')})$/`;
const NICK_OK = (s) => and(`${s}.isString()`, `${s}.val().length >= 2`, `${s}.val().length <= 12`);

const HIDE_TOTAL = (C.START_COUNTDOWN_SECONDS + C.HIDE_SECONDS) * 1000;
const SEEK_MS = C.SEEK_SECONDS * 1000;
const HALF = C.MAP_HALF_SIZE;
const PER_MS = (C.MOVE_SPEED * C.MAX_SPEED_FACTOR) / 1000;
const SLACK = 1.2;
const RANGE = C.CAPTURE_RANGE + C.CAPTURE_RANGE_TOLERANCE;

// ---------------------------------------------------------------------
// 위치 (roomPos/$roomId/$uid): 속도·경계·고정 검사
// ---------------------------------------------------------------------
const DX = `(newData.child('x').val() - data.child('x').val())`;
const DZ = `(newData.child('z').val() - data.child('z').val())`;
const D2 = `(${DX} * ${DX} + ${DZ} * ${DZ})`;
const DT = `(now - data.child('t').val())`;
const STILL = and(`${DX} === 0`, `${DZ} === 0`);
const posRules = {
  '.write': and(
    AUTH,
    or(
      // 본인 이동: 게임 중이고 술래이거나 살아 있는 숨는 팀
      and('auth.uid === $uid', 'data.exists()', 'newData.exists()', PLAYING, or(`${RD('activeSeekers')}.child($uid).exists()`, `${RD('alive')}.child($uid).exists()`)),
      // 본인 위치 삭제 (나가기)
      and('auth.uid === $uid', '!newData.exists()'),
      // 방장: 라운드 시작 시 시작 위치 기록 / 정리
      and(IS_HOST, `${STATUS} !== 'playing'`, or('!newData.exists()', `${up(3)}.child('rooms').child($roomId).child('meta').child('status').val() === 'playing'`))
    )
  ),
  '.validate': and(
    "newData.hasChildren(['x', 'z', 'r', 't'])",
    "newData.child('t').val() === now",
    or(
      '!data.exists()',
      `${STATUS} !== 'playing'`,
      and(
        `${D2} <= ${C.MAX_STEP_PER_WRITE * C.MAX_STEP_PER_WRITE}`,
        `${D2} <= (${PER_MS} * ${DT} + ${SLACK}) * (${PER_MS} * ${DT} + ${SLACK})`,
        // 변신 중에는 이동 불가
        or(`!${ROOM}.child('players').child($uid).child('disguise').exists()`, STILL),
        // 숨는 시간 동안 술래 이동 불가
        or(`!${RD('seekers')}.child($uid).exists()`, `now >= ${RD('hideEndsAt')}.val()`, STILL)
      )
    )
  ),
  x: { '.validate': `newData.isNumber() && newData.val() >= ${-HALF} && newData.val() <= ${HALF}` },
  z: { '.validate': `newData.isNumber() && newData.val() >= ${-HALF} && newData.val() <= ${HALF}` },
  r: { '.validate': 'newData.isNumber() && newData.val() >= -7 && newData.val() <= 7' },
  t: { '.validate': 'newData.isNumber()' },
  $other: { '.validate': false },
};

// ---------------------------------------------------------------------
// 라운드 (rooms/$roomId/round)
// ---------------------------------------------------------------------
const NR = up(2); // round 하위 2단계(…/round/<필드>/$key)에서 본 새 round
const SP = `${up(5)}.child('roomPos').child($roomId).child(auth.uid)`; // captures/$t 에서 본 새 술래 위치
const TP = `root.child('roomPos').child($roomId).child($t)`;
const CDX = `(${SP}.child('x').val() - ${TP}.child('x').val())`;
const CDZ = `(${SP}.child('z').val() - ${TP}.child('z').val())`;
const LAST_CAP = (s) => `${NR}.child('captures').child(${NR}.child('lastCaptureBy').child(${s}).val())`;

const roundRules = {
  '.write': and(
    AUTH,
    IS_HOST,
    or(
      // 시작 (대기실/결과 → 진행)
      and(`${STATUS} !== 'playing'`, 'newData.exists()', `newData.child('phase').val() === 'playing'`, `newData.parent().child('meta').child('status').val() === 'playing'`),
      // 결과 → 대기실
      and(`${STATUS} === 'results'`, '!newData.exists()')
    )
  ),
  '.validate': and(
    "newData.hasChildren(['id', 'number', 'phase', 'startedAt', 'hideEndsAt', 'roundEndsAt', 'seekers', 'hiders', 'names'])",
    `newData.child('id').val().beginsWith($roomId + '_')`,
    `newData.child('number').val() === newData.parent().child('meta').child('roundNumber').val()`,
    `newData.child('hideEndsAt').val() === newData.child('startedAt').val() + ${HIDE_TOTAL}`,
    `newData.child('roundEndsAt').val() === newData.child('hideEndsAt').val() + ${SEEK_MS}`
  ),
  id: { '.validate': 'newData.isString()' },
  number: { '.validate': 'newData.isNumber()' },
  startedAt: {
    '.validate': `newData.isNumber() && newData.val() >= now - ${C.START_TIME_TOLERANCE_MS} && newData.val() <= now + ${C.START_TIME_TOLERANCE_MS}`,
  },
  hideEndsAt: { '.validate': 'newData.isNumber()' },
  roundEndsAt: { '.validate': 'newData.isNumber()' },
  phase: {
    '.write': and(AUTH, MEMBER('auth.uid'), "data.val() === 'playing'", "newData.val() === 'ended'", "newData.parent().child('winner').exists()", "newData.parent().child('endedAt').val() === now"),
    '.validate': oneOf('newData.val()', ['playing', 'ended']),
  },
  winner: {
    '.write': and(
      AUTH,
      MEMBER('auth.uid'),
      '!data.exists()',
      `${RD('phase')}.val() === 'playing'`,
      "newData.parent().child('phase').val() === 'ended'",
      or(
        and("newData.val() === 'seekers'", "!newData.parent().child('alive').exists()"),
        and("newData.val() === 'hiders'", or(`now >= ${RD('roundEndsAt')}.val()`, "!newData.parent().child('activeSeekers').exists()"))
      )
    ),
    '.validate': oneOf('newData.val()', ['seekers', 'hiders']),
  },
  endedAt: {
    '.write': and(AUTH, MEMBER('auth.uid'), '!data.exists()', 'newData.val() === now', "newData.parent().child('phase').val() === 'ended'"),
    '.validate': 'newData.isNumber()',
  },
  seekers: {
    $u: {
      '.validate': and('newData.val() === true', `${up(3)}.child('players').child($u).exists()`, `!${up(2)}.child('hiders').child($u).exists()`),
    },
  },
  hiders: {
    $u: { '.validate': and('newData.val() === true', `${up(3)}.child('players').child($u).exists()`) },
  },
  names: { $u: { '.validate': 'newData.isString()' } },
  alive: {
    $u: {
      // 포획되었거나 이탈 기록이 함께 있을 때만 삭제 가능
      '.write': and(AUTH, 'data.exists()', '!newData.exists()', or(`${NR}.child('captures').child($u).exists()`, `${NR}.child('left').child($u).exists()`)),
      '.validate': and('newData.val() === true', `${NR}.child('hiders').child($u).exists()`),
    },
  },
  activeSeekers: {
    $u: {
      '.write': and(AUTH, 'data.exists()', '!newData.exists()', `${NR}.child('left').child($u).exists()`),
      '.validate': and('newData.val() === true', `${NR}.child('seekers').child($u).exists()`),
    },
  },
  left: {
    $u: {
      '.write': and(
        AUTH,
        MEMBER('auth.uid'),
        '!data.exists()',
        'newData.exists()',
        PLAYING,
        IN_ROUND('$u'),
        `!${NR}.child('alive').child($u).exists()`,
        `!${NR}.child('activeSeekers').child($u).exists()`,
        or(
          and('auth.uid === $u', 'newData.val() === now'),
          and(OFFLINE_FOR('$u', C.DISCONNECT_GRACE_MS), `newData.val() === ${PRES('$u')}.child('at').val()`),
          and(`!${MEMBER('$u')}`, 'newData.val() === now')
        )
      ),
      '.validate': 'newData.isNumber()',
    },
  },
  captures: {
    $t: {
      // ★ 핵심 규칙: 술래가 직접 기록한 포획만, 시간·생존·거리·쿨다운을 만족할 때만 허용
      '.write': and(
        AUTH,
        '!data.exists()',
        'newData.exists()',
        PLAYING,
        `${RD('activeSeekers')}.child(auth.uid).exists()`,
        `${RD('alive')}.child($t).exists()`,
        `now >= ${RD('hideEndsAt')}.val()`,
        `now < ${RD('roundEndsAt')}.val()`,
        "newData.child('by').val() === auth.uid",
        "newData.child('at').val() === now",
        `!${NR}.child('alive').child($t).exists()`,
        `${NR}.child('lastCaptureBy').child(auth.uid).val() === $t`,
        `${NR}.child('lastCaptureAt').child(auth.uid).val() === now`,
        or(`!${RD('lastCaptureAt')}.child(auth.uid).exists()`, `now - ${RD('lastCaptureAt')}.child(auth.uid).val() >= ${C.RULE_CAPTURE_COOLDOWN_MS}`),
        `${SP}.child('t').val() === now`,
        `${TP}.exists()`,
        `${CDX} * ${CDX} + ${CDZ} * ${CDZ} <= ${+(RANGE * RANGE).toFixed(6)}`
      ),
      '.validate': "newData.hasChildren(['by', 'at'])",
    },
  },
  captureCount: {
    $s: {
      '.write': and(
        AUTH,
        'auth.uid === $s',
        `${LAST_CAP('$s')}.child('by').val() === $s`,
        `${LAST_CAP('$s')}.child('at').val() === now`,
        or(and('!data.exists()', 'newData.val() === 1'), and('data.exists()', 'newData.val() === data.val() + 1'))
      ),
      '.validate': 'newData.isNumber()',
    },
  },
  lastCaptureBy: {
    $s: {
      '.write': and(AUTH, 'auth.uid === $s', `${NR}.child('captures').child(newData.val()).child('by').val() === $s`, `${NR}.child('captures').child(newData.val()).child('at').val() === now`),
      '.validate': 'newData.isString()',
    },
  },
  lastCaptureAt: {
    $s: {
      '.write': and(AUTH, 'auth.uid === $s', 'newData.val() === now', `${LAST_CAP('$s')}.child('at').val() === now`),
      '.validate': 'newData.isNumber()',
    },
  },
  $other: { '.validate': false },
};

// ---------------------------------------------------------------------
// 참가자 (rooms/$roomId/players/$uid)
// ---------------------------------------------------------------------
const playerRules = {
  '.write': and(
    AUTH,
    or(
      // 참가: 내 자리만, 게임 진행 중이 아닐 때
      and('auth.uid === $uid', '!data.exists()', 'newData.exists()', `${STATUS} !== 'playing'`, `${ROOM}.child('meta').exists()`),
      // 나가기: 게임 중 참가자라면 이탈 기록을 함께 남겨야 함
      and('auth.uid === $uid', 'data.exists()', '!newData.exists()', or(`!${PLAYING}`, `!${IN_ROUND('$uid')}`, `${RD('left')}.child($uid).exists()`, `${up(2)}.child('round').child('left').child($uid).exists()`)),
      // 방장: 게임 중이 아닐 때 내보내기
      and(IS_HOST, 'auth.uid !== $uid', 'data.exists()', '!newData.exists()', `${STATUS} !== 'playing'`)
    )
  ),
  '.validate': and(
    "newData.hasChildren(['nickname', 'nickKey', 'slot', 'character', 'ready', 'joinedAt'])",
    `${up(2)}.child('slots').child(newData.child('slot').val()).val() === $uid`,
    `${up(2)}.child('nicks').child(newData.child('nickKey').val()).val() === $uid`
  ),
  nickname: { '.validate': NICK_OK('newData') },
  nickKey: { '.validate': "newData.val() === newData.parent().child('nickname').val().toLowerCase()" },
  slot: { '.validate': `newData.isString() && newData.val().matches(${slotRe})` },
  character: {
    '.write': and(AUTH, 'auth.uid === $uid', `${STATUS} !== 'playing'`),
    '.validate': `newData.isString() && newData.val().matches(${charRe})`,
  },
  ready: {
    '.write': and(AUTH, or('auth.uid === $uid', IS_HOST), `${STATUS} !== 'playing'`),
    '.validate': 'newData.isBoolean()',
  },
  joinedAt: { '.validate': 'newData.val() === now' },
  disguise: {
    '.write': and(
      AUTH,
      or(
        and(
          'auth.uid === $uid',
          PLAYING,
          `${RD('alive')}.child($uid).exists()`,
          `now < ${RD('roundEndsAt')}.val()`,
          or(
            // 변신: 해제 후 쿨다운이 지났을 때
            and('!data.exists()', 'newData.exists()', or("!newData.parent().child('undisguisedAt').exists()", `now - newData.parent().child('undisguisedAt').val() >= ${C.DISGUISE_COOLDOWN_MS}`)),
            // 해제: 해제 시각을 함께 기록
            and('data.exists()', '!newData.exists()', "newData.parent().child('undisguisedAt').val() === now")
          )
        ),
        and(IS_HOST, '!newData.exists()', `${STATUS} !== 'playing'`)
      )
    ),
    '.validate': `newData.isString() && newData.val().matches(${propRe})`,
  },
  undisguisedAt: {
    '.write': and(AUTH, or(and('auth.uid === $uid', 'newData.val() === now', "!newData.parent().child('disguise').exists()"), and(IS_HOST, '!newData.exists()', `${STATUS} !== 'playing'`))),
    '.validate': 'newData.isNumber()',
  },
  $other: { '.validate': false },
};

// 자리(slots)와 닉네임 예약(nicks): 같은 방식으로 "하나의 키 = 한 사람" 보장
const claimRules = (validateExtra) => ({
  '.write': and(
    AUTH,
    or(
      and('!data.exists()', 'newData.val() === auth.uid', `${up(2)}.child('players').child(auth.uid).exists()`, `!${MEMBER('auth.uid')}`, `${STATUS} !== 'playing'`),
      and('data.val() === auth.uid', '!newData.exists()'),
      and(IS_HOST, '!newData.exists()', 'data.val() !== auth.uid', `${STATUS} !== 'playing'`)
    )
  ),
  '.validate': validateExtra,
});

// ---------------------------------------------------------------------
// 전적 (playerStats/$uid): 라운드 데이터와 대조해서만 증가
// ---------------------------------------------------------------------
const FIELDS = ['gamesPlayed', 'wins', 'losses', 'captures', 'survivals', 'totalSurvivalSeconds', 'points'];
const O = (f) => `data.child('${f}').val()`;
const N = (f) => `newData.child('${f}').val()`;
const INC = (f, d) => `${N(f)} === ${O(f)} + ${d}`;
const RR = `root.child('rooms').child(newData.child('lastRoom').val()).child('round')`;
const RRC = (f) => `${RR}.child('${f}')`;
const SURV_D = `(${N('totalSurvivalSeconds')} - ${O('totalSurvivalSeconds')})`;
const FLOOR_OK = (ms) => and(`${SURV_D} * 1000 <= ${ms}`, `(${SURV_D} + 1) * 1000 > ${ms}`);

function statCase({ team, win, extra = [], captures = '0', survived = 0, survMs = null }) {
  const points = team === 'seekers' ? `${captures} * ${SC.CAPTURE} + ${win ? SC.WIN_BONUS : 0}` : `${survived * SC.SURVIVE + (win ? SC.WIN_BONUS : 0)}`;
  return and(
    `${RRC(team)}.child($uid).exists()`,
    `${RRC('winner')}.val() === '${win ? team : team === 'seekers' ? 'hiders' : 'seekers'}'`,
    ...extra,
    INC('wins', win ? 1 : 0),
    INC('losses', win ? 0 : 1),
    INC('captures', captures),
    INC('survivals', survived),
    INC('points', `(${points})`),
    survMs === null ? INC('totalSurvivalSeconds', 0) : FLOOR_OK(survMs)
  );
}

const CC = `${RRC('captureCount')}.child($uid)`;
const CAP = `${RRC('captures')}.child($uid)`;
const HIDE_END = RRC('hideEndsAt') + '.val()';
const statCases = [
  statCase({ team: 'seekers', win: true, extra: [`${CC}.exists()`], captures: `${CC}.val()` }),
  statCase({ team: 'seekers', win: false, extra: [`${CC}.exists()`], captures: `${CC}.val()` }),
  statCase({ team: 'seekers', win: true, extra: [`!${CC}.exists()`] }),
  statCase({ team: 'seekers', win: false, extra: [`!${CC}.exists()`] }),
  statCase({ team: 'hiders', win: true, extra: [`${CAP}.exists()`], survMs: `(${CAP}.child('at').val() - ${HIDE_END})` }),
  statCase({ team: 'hiders', win: false, extra: [`${CAP}.exists()`], survMs: `(${CAP}.child('at').val() - ${HIDE_END})` }),
  statCase({
    team: 'hiders',
    win: true,
    survived: 1,
    extra: [`!${CAP}.exists()`, `${RRC('alive')}.child($uid).exists()`, `${RRC('endedAt')}.val() <= ${RRC('roundEndsAt')}.val()`],
    survMs: `(${RRC('endedAt')}.val() - ${HIDE_END})`,
  }),
  statCase({
    team: 'hiders',
    win: true,
    survived: 1,
    extra: [`!${CAP}.exists()`, `${RRC('alive')}.child($uid).exists()`, `${RRC('endedAt')}.val() > ${RRC('roundEndsAt')}.val()`],
    survMs: `(${RRC('roundEndsAt')}.val() - ${HIDE_END})`,
  }),
];

const STATS_INIT = and('!data.exists()', ...FIELDS.map((f) => `${N(f)} === 0`), `${N('lastRound')} === 'none'`, `${N('lastRoom')} === 'none'`);
const STATS_RECORD = and(
  'data.exists()',
  `newData.child('lastRoom').val().matches(${codeRe})`,
  `${N('lastRound')} !== ${O('lastRound')}`,
  `${up(2)}.child('statRounds').child($uid).child(newData.child('lastRound').val()).val() === true`,
  `!root.child('statRounds').child($uid).child(newData.child('lastRound').val()).exists()`,
  `${RRC('id')}.val() === ${N('lastRound')}`,
  `${RRC('phase')}.val() === 'ended'`,
  `!${RRC('left')}.child($uid).exists()`,
  INC('gamesPlayed', 1),
  or(...statCases)
);

const statsRules = {
  '.read': AUTH,
  '.indexOn': ['points'],
  $uid: {
    '.write': and(AUTH, 'auth.uid === $uid'),
    '.validate': and(
      `newData.hasChildren(['nickname', 'updatedAt', 'lastRound', 'lastRoom', ${FIELDS.map((f) => `'${f}'`).join(', ')}])`,
      "newData.child('updatedAt').val() === now",
      or(STATS_INIT, STATS_RECORD)
    ),
    nickname: { '.validate': NICK_OK('newData') },
    lastRound: { '.validate': 'newData.isString()' },
    lastRoom: { '.validate': 'newData.isString()' },
    updatedAt: { '.validate': 'newData.isNumber()' },
    ...Object.fromEntries(FIELDS.map((f) => [f, { '.validate': 'newData.isNumber() && newData.val() >= 0' }])),
    $other: { '.validate': false },
  },
};

// ---------------------------------------------------------------------
const rules = {
  rules: {
    '.read': false,
    '.write': false,
    rooms: {
      $roomId: {
        '.read': and(AUTH, "data.child('players').child(auth.uid).exists()"),
        '.write': and(
          AUTH,
          or(
            // 방 만들기: 내가 방장, 첫 자리
            and('!data.exists()', "newData.child('meta').child('hostId').val() === auth.uid", "newData.child('players').child(auth.uid).exists()", "newData.child('slots').child('s0').val() === auth.uid", `$roomId.matches(${codeRe})`),
            // 방 삭제: 아무도 없거나 너무 오래된 방
            and('data.exists()', '!newData.exists()', or("!data.child('players').exists()", `now - data.child('meta').child('createdAt').val() >= ${C.STALE_ROOM_MS}`))
          )
        ),
        '.validate': "newData.hasChildren(['meta'])",
        meta: {
          '.read': AUTH, // 방 코드를 아는 사람은 참가 전에 상태 확인 가능
          '.validate': "newData.hasChildren(['hostId', 'status', 'mapId', 'roundNumber', 'maxPlayers', 'createdAt', 'seekerMode'])",
          hostId: {
            // 방장이 나갔거나 오래 연결이 끊기면 다른 참가자가 이어받음
            '.write': and(AUTH, MEMBER('auth.uid'), 'newData.val() === auth.uid', or(`!${ROOM}.child('players').child(data.val()).exists()`, OFFLINE_FOR('data.val()', C.HOST_OFFLINE_CLAIM_MS))),
            '.validate': `newData.isString() && ${up(2)}.child('players').child(newData.val()).exists()`,
          },
          status: {
            '.write': and(
              AUTH,
              or(
                and(IS_HOST, "data.val() === 'results'", "newData.val() === 'lobby'", `!${up(2)}.child('round').exists()`),
                and(IS_HOST, "data.val() !== 'playing'", "newData.val() === 'playing'", `${up(2)}.child('round').child('phase').val() === 'playing'`),
                and(MEMBER('auth.uid'), "data.val() === 'playing'", "newData.val() === 'results'", `${up(2)}.child('round').child('phase').val() === 'ended'`, `${up(2)}.child('round').child('endedAt').val() === now`)
              )
            ),
            '.validate': oneOf('newData.val()', ['lobby', 'playing', 'results']),
          },
          roundNumber: {
            '.write': and(AUTH, IS_HOST, 'newData.val() === data.val() + 1', `${STATUS} !== 'playing'`, `${up(1)}.child('status').val() === 'playing'`),
            '.validate': 'newData.isNumber()',
          },
          seekerMode: {
            '.write': and(AUTH, IS_HOST, `${STATUS} !== 'playing'`),
            '.validate': oneOf('newData.val()', ['auto', 1, 2, 3]),
          },
          mapId: { '.validate': `newData.val() === '${FOREST_MAP_ID}'` },
          maxPlayers: { '.validate': `newData.val() === ${C.MAX_PLAYERS}` },
          createdAt: { '.validate': 'newData.val() === now' },
          $other: { '.validate': false },
        },
        slots: {
          '.read': AUTH,
          $slot: claimRules(`$slot.matches(${slotRe}) && newData.isString()`),
        },
        nicks: {
          '.read': AUTH,
          $nick: claimRules(`newData.isString() && ${up(2)}.child('players').child(newData.val()).child('nickKey').val() === $nick`),
        },
        players: { $uid: playerRules },
        round: roundRules,
        $other: { '.validate': false },
      },
    },
    roomPos: {
      $roomId: {
        '.read': and(AUTH, MEMBER('auth.uid')),
        '.write': and(AUTH, '!newData.exists()', or(IS_HOST, `!${ROOM}.exists()`)),
        $uid: posRules,
      },
    },
    roomPresence: {
      $roomId: {
        '.read': and(AUTH, MEMBER('auth.uid')),
        '.write': and(AUTH, '!newData.exists()', `!${ROOM}.exists()`),
        $uid: {
          '.write': and(AUTH, or(and('auth.uid === $uid', or('!newData.exists()', MEMBER('$uid'))), and(IS_HOST, '!newData.exists()', `${STATUS} !== 'playing'`))),
          '.validate': "newData.hasChildren(['online', 'at'])",
          online: { '.validate': 'newData.isBoolean()' },
          at: { '.validate': 'newData.isNumber() && newData.val() <= now + 1000' },
          $other: { '.validate': false },
        },
      },
    },
    userRooms: {
      $uid: {
        '.read': and(AUTH, 'auth.uid === $uid'),
        '.write': and(AUTH, 'auth.uid === $uid'),
        '.validate': `newData.isString() && newData.val().matches(${codeRe})`,
      },
    },
    playerStats: statsRules,
    statRounds: {
      $uid: {
        '.read': and(AUTH, 'auth.uid === $uid'),
        $rid: {
          '.write': and(AUTH, 'auth.uid === $uid', '!data.exists()', `${up(3)}.child('playerStats').child($uid).child('lastRound').val() === $rid`),
          '.validate': 'newData.val() === true',
        },
      },
    },
    matchHistory: {
      '.read': AUTH,
      '.indexOn': ['endedAt'],
      $rid: {
        '.write': and(
          AUTH,
          '!data.exists()',
          'newData.exists()',
          `root.child('rooms').child(newData.child('roomId').val()).child('players').child(auth.uid).exists()`,
          `root.child('rooms').child(newData.child('roomId').val()).child('round').child('id').val() === $rid`,
          `root.child('rooms').child(newData.child('roomId').val()).child('round').child('phase').val() === 'ended'`
        ),
        '.validate': "newData.hasChildren(['roomId', 'winner', 'startedAt', 'endedAt', 'playerResults'])",
      },
    },
  },
};

const out = JSON.stringify(rules, null, 2) + '\n';
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'database.rules.json');
if (process.argv.includes('--check')) {
  const cur = readFileSync(file, 'utf8');
  if (cur !== out) {
    console.error('database.rules.json 이 shared/config.js 와 맞지 않습니다. node scripts/build-rules.mjs 를 실행하세요.');
    process.exit(1);
  }
  console.log('database.rules.json 최신 상태');
} else {
  writeFileSync(file, out);
  console.log(`database.rules.json 생성 (${(out.length / 1024).toFixed(1)} KB)`);
}
export default rules;
