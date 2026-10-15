// =====================================================================
// 포켓몬 숨바꼭질 3D - 공용 게임 설정
// ---------------------------------------------------------------------
// 브라우저 코드와 보안 규칙 생성기(scripts/build-rules.mjs)가 함께 사용합니다.
// 숫자를 바꾼 뒤에는  node scripts/build-rules.mjs  로 database.rules.json 을
// 다시 만들고 규칙을 재배포하세요. (규칙이 이 값들로 이동 속도·포획 거리·시간을 검사합니다)
// =====================================================================

export const GAME_CONFIG = Object.freeze({
  GAME_TITLE: '포켓몬 숨바꼭질 3D',

  // --- 인원 ---
  MAX_PLAYERS: 20,
  MIN_PLAYERS: 2,

  // --- 라운드 시간 ---
  START_COUNTDOWN_SECONDS: 3, // 역할 발표 후 숨기 시간이 시작되기 전 여유
  HIDE_SECONDS: 20,
  SEEK_SECONDS: 180,
  START_TIME_TOLERANCE_MS: 3000, // 방장 기기 시계 오차 허용 (규칙 검사)

  // --- 술래 수 ---
  // 방장이 '자동'을 고르면 아래 표를 사용합니다. (참가 인원 >= minPlayers 인 마지막 행)
  MAX_SEEKERS: 3,
  SEEKER_TABLE: Object.freeze([
    Object.freeze({ minPlayers: 2, seekers: 1 }),
    Object.freeze({ minPlayers: 7, seekers: 2 }),
    Object.freeze({ minPlayers: 14, seekers: 3 }),
  ]),

  // --- 이동 ---
  MOVE_SPEED: 6.0, // 게임 단위/초
  MAX_SPEED_FACTOR: 1.5, // 규칙은 MOVE_SPEED × 1.5 까지 허용 (지연 여유)
  MAX_STEP_PER_WRITE: 5, // 위치 1회 전송당 최대 이동
  PLAYER_RADIUS: 0.45,

  // --- 포획 ---
  CAPTURE_RANGE: 3.0, // 술래 중심 ~ 대상 중심 수평 거리
  CAPTURE_RANGE_TOLERANCE: 0.35, // 상대 위치 전송 지연을 감안한 규칙 측 여유
  CAPTURE_COOLDOWN_MS: 1500, // 클라이언트 쿨다운 (빗나감 포함)
  RULE_CAPTURE_COOLDOWN_MS: 1200, // 보안 규칙이 강제하는 성공 포획 간 최소 간격
  AIM_MAX_DISTANCE: 14, // 조준 후보를 찾는 최대 거리

  // --- 변신 ---
  // 'locked' : 변신 중 이동 불가. 이동하려면 변신을 해제해야 함. (규칙이 강제)
  DISGUISE_MOVE_MODE: 'locked',
  DISGUISE_COOLDOWN_MS: 3000, // 변신 해제 후 재변신까지 대기 (규칙이 강제)

  // --- 네트워크 / 접속 ---
  POS_SEND_INTERVAL_MS: 150, // 위치 전송 최소 간격 (초당 최대 약 6.7회, Spark 전송량 절약)
  POS_FORCE_SEND_DISTANCE: 1.5, // 이 거리 이상 움직이면 간격과 무관하게 전송
  DUTY_INTERVAL_MS: 3000, // 방장/참가자 점검 주기 (시간 종료, 연결 끊김)
  DISCONNECT_GRACE_MS: 45000, // 게임 중 연결 끊김 후 기권 처리까지 대기 (규칙이 강제)
  LOBBY_OFFLINE_KICK_MS: 20000, // 대기실에서 연결이 끊긴 사람을 방장이 정리
  HOST_OFFLINE_CLAIM_MS: 15000, // 방장이 이만큼 끊겨 있으면 다른 참가자가 방장을 이어받음
  STALE_ROOM_MS: 12 * 60 * 60 * 1000, // 12시간 지난 방은 누구나 삭제 가능
  WRITE_TIMEOUT_MS: 10000,

  // --- 맵 ---
  MAP_HALF_SIZE: 36, // 플레이 영역: x, z 모두 -36 ~ 36
});

// 점수 기준 (규칙이 전적 기록을 이 공식으로 검사합니다)
export const SCORE_CONFIG = Object.freeze({
  CAPTURE: 10, // 술래가 1명 포획할 때마다
  SURVIVE: 20, // 숨는 플레이어가 끝까지 살아남았을 때
  WIN_BONUS: 10, // 승리 팀 전원 (중도 이탈자 제외)
  // 중도 이탈/기권: 패배, 0점 (이탈한 브라우저가 기록하지 않으면 전적에 남지 않음, README 참고)
});

// 기본 캐릭터 (공식 포켓몬 모델이 아닌, 이 프로젝트에서 직접 만든 테스트 캐릭터)
export const CHARACTERS = Object.freeze([
  Object.freeze({ id: 'volt', name: '볼트', type: '전기', color: '#f4c935', accent: '#d9822b' }),
  Object.freeze({ id: 'leaf', name: '리프', type: '풀', color: '#6cc46a', accent: '#2f7d4a' }),
  Object.freeze({ id: 'blaze', name: '블레이즈', type: '불꽃', color: '#f2884b', accent: '#c4472c' }),
  Object.freeze({ id: 'aqua', name: '아쿠아', type: '물', color: '#5aa9e6', accent: '#2c6fb0' }),
  Object.freeze({ id: 'coco', name: '코코', type: '노말', color: '#c79a6b', accent: '#7d5634' }),
  Object.freeze({ id: 'momo', name: '모모', type: '페어리', color: '#f3a6c8', accent: '#c4628f' }),
]);
export const CHARACTER_IDS = Object.freeze(CHARACTERS.map((c) => c.id));

// 변신 가능한 사물 종류. radius/height 는 충돌체와 조준 판정 크기입니다.
export const PROP_TYPES = Object.freeze({
  barrel: Object.freeze({ name: '나무통', radius: 0.5, height: 1.05 }),
  crate: Object.freeze({ name: '나무 상자', radius: 0.6, height: 0.9 }),
  rock: Object.freeze({ name: '바위', radius: 0.6, height: 0.75 }),
  bush: Object.freeze({ name: '덤불', radius: 0.75, height: 1.0 }),
  log: Object.freeze({ name: '통나무', radius: 0.65, height: 0.6 }),
  pot: Object.freeze({ name: '화분', radius: 0.4, height: 0.75 }),
  mushroom: Object.freeze({ name: '버섯 장식', radius: 0.4, height: 0.8 }),
});
export const PROP_TYPE_IDS = Object.freeze(Object.keys(PROP_TYPES));

// 닉네임: 2~12자, 한글/영문/숫자/공백/_/-  (Firebase 키로도 쓰이므로 . # $ [ ] / 는 불가)
export const NICKNAME_PATTERN = '^[가-힣a-zA-Z0-9_ -]{2,12}$';
export const NICKNAME_RE = new RegExp(NICKNAME_PATTERN);
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O/1/I/L 제외
export const ROOM_CODE_PATTERN = '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$';
export const ROOM_CODE_RE = new RegExp(ROOM_CODE_PATTERN);
// 참가 자리: s0 ~ s19 (자리 수 = 최대 인원. 규칙이 자리로 인원 제한을 강제)
export const SLOT_IDS = Object.freeze(Array.from({ length: GAME_CONFIG.MAX_PLAYERS }, (_, i) => `s${i}`));

export function normalizeNickname(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!NICKNAME_RE.test(s)) return null;
  return s;
}

export function nicknameKey(nick) {
  return nick.toLowerCase();
}

export function normalizeRoomCode(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  return ROOM_CODE_RE.test(s) ? s : null;
}

/**
 * 술래 수 결정.
 * @param {number} playerCount 라운드 참가 인원
 * @param {'auto'|1|2|3} mode 방장 설정
 */
export function seekerCountFor(playerCount, mode = 'auto') {
  if (playerCount < 2) return 0;
  let n;
  if (mode === 'auto' || mode == null) {
    n = 1;
    for (const row of GAME_CONFIG.SEEKER_TABLE) {
      if (playerCount >= row.minPlayers) n = row.seekers;
    }
  } else {
    n = Number(mode);
    if (!Number.isInteger(n) || n < 1) n = 1;
  }
  n = Math.min(n, GAME_CONFIG.MAX_SEEKERS, playerCount - 1); // 숨는 사람이 최소 1명
  return Math.max(1, n);
}

/** 숨는 플레이어의 생존 시간(ms): 포획 시각 또는 라운드 종료 시각(제한 시간을 넘지 않게) - 추격 시작 */
export function survivalMs(round, uid) {
  const cap = round.captures && round.captures[uid];
  const end = cap ? cap.at : Math.min(round.endedAt || round.roundEndsAt, round.roundEndsAt);
  return Math.max(0, end - round.hideEndsAt);
}

/**
 * 라운드 결과와 점수 계산. 모든 클라이언트가 같은 라운드 데이터로 같은 결과를 얻고,
 * 전적 기록 시 보안 규칙이 같은 공식으로 다시 검사합니다.
 */
export function computeRoundResults(round) {
  const results = {};
  const names = round.names || {};
  const left = round.left || {};
  const captureCount = round.captureCount || {};
  const alive = round.alive || {};
  const captures = round.captures || {};

  for (const uid of Object.keys(round.seekers || {})) {
    const didLeave = !!left[uid];
    const won = !didLeave && round.winner === 'seekers';
    const caps = captureCount[uid] || 0;
    results[uid] = {
      nickname: names[uid] || '?',
      team: 'seekers',
      outcome: didLeave ? 'left' : won ? 'win' : 'loss',
      captures: caps,
      captured: false,
      survived: false,
      survivalSeconds: 0,
      points: didLeave ? 0 : caps * SCORE_CONFIG.CAPTURE + (won ? SCORE_CONFIG.WIN_BONUS : 0),
    };
  }
  for (const uid of Object.keys(round.hiders || {})) {
    const didLeave = !!left[uid];
    const cap = captures[uid];
    const won = !didLeave && round.winner === 'hiders';
    const survived = !didLeave && !cap && !!alive[uid] && round.winner === 'hiders';
    results[uid] = {
      nickname: names[uid] || '?',
      team: 'hiders',
      outcome: didLeave ? 'left' : won ? 'win' : 'loss',
      captures: 0,
      captured: !!cap,
      capturedBy: cap ? cap.by : null,
      survived,
      survivalSeconds: didLeave ? 0 : Math.floor(survivalMs(round, uid) / 1000),
      points: didLeave ? 0 : (survived ? SCORE_CONFIG.SURVIVE : 0) + (won ? SCORE_CONFIG.WIN_BONUS : 0),
    };
  }
  return results;
}

/** 순위 정렬: 점수 내림차순 → 승리 수 내림차순 → 플레이 수 오름차순 → 닉네임 가나다순 → uid */
export function compareLeaderboard(a, b) {
  return (
    (b.points || 0) - (a.points || 0) ||
    (b.wins || 0) - (a.wins || 0) ||
    (a.gamesPlayed || 0) - (b.gamesPlayed || 0) ||
    String(a.nickname || '').localeCompare(String(b.nickname || ''), 'ko') ||
    String(a.uid || '').localeCompare(String(b.uid || ''))
  );
}
