// 브라우저 스모크 테스트 (개발 전용)
// 실제 index.html/game.js/world.js/controls.js 를 Chromium 에서 실행하되,
//  - Firebase CDN 모듈 → 브라우저 안의 메모리 DB (실제 database.rules.json 을 적용)
//  - three.js → 아무 동작도 하지 않는 대체 모듈 (렌더링 결과는 검사하지 않음)
// 로 바꿔서 화면 흐름, 입력, 타이머, 포획/변신/결과/전적 흐름에 런타임 오류가 없는지 확인합니다.
//
// 실행:  PLAYWRIGHT_BROWSERS_PATH=... node tests/browser/smoke.mjs
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as stubs from './stubs.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = process.env.SHOT_DIR || null;
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json' };

async function route(r) {
  const url = new URL(r.request().url());
  const headers = { 'access-control-allow-origin': '*' };
  const js = (body) => r.fulfill({ status: 200, headers: { ...headers, 'content-type': 'text/javascript' }, body });
  if (url.host === 'www.gstatic.com') {
    if (url.pathname.endsWith('firebase-app.js')) return js(stubs.firebaseApp);
    if (url.pathname.endsWith('firebase-auth.js')) return js(stubs.firebaseAuth);
    if (url.pathname.endsWith('firebase-database.js')) return js(stubs.firebaseDatabase);
  }
  if (url.host === 'cdn.jsdelivr.net' && url.pathname.includes('three')) return js(stubs.threeStub);
  if (url.host === 'localhost:8765') {
    try {
      const body = await readFile(join(ROOT, decodeURIComponent(url.pathname)));
      return r.fulfill({ status: 200, headers: { ...headers, 'content-type': MIME[extname(url.pathname)] || 'application/octet-stream' }, body });
    } catch {
      return r.fulfill({ status: 404, body: 'not found' });
    }
  }
  return r.abort();
}

const errors = [];
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

async function openPage(browser, opts = {}) {
  const ctx = await browser.newContext(opts);
  await ctx.route('**/*', route);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (process.env.DEBUG_CONSOLE && ['warning','debug'].includes(m.type())) console.log('  [console]', m.text());
    if (m.type() === 'error' && !/fonts\.g|ERR_FAILED|net::/i.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  await page.goto('http://localhost:8765/index.html?emulator');
  return page;
}

const visible = (page, sel) => page.locator(sel).isVisible();
const dbGet = (page, path) => page.evaluate((p) => window.__backend.db.get(p), path);
const shiftTime = (page, ms) =>
  page.evaluate((d) => {
    window.__shift = (window.__shift || 0) + d;
    window.__backend.setOffset(window.__shift);
  }, ms);
/** 두 번째 플레이어(봇)가 규칙을 거쳐 참가·준비 */
const addBot = (page, code) =>
  page.evaluate(async (id) => {
    const A = await import('/shared/actions.js');
    const { db } = window.__backend;
    const TS = { '.sv': 'timestamp' };
    const slot = A.freeSlot(db.get(`rooms/${id}/slots`));
    const r1 = db.update('bot01', A.joinUpdate({ uid: 'bot01', code: id, nickname: '봇친구', character: 'aqua', slot, TS }));
    const r2 = db.update('bot01', { [`roomPresence/${id}/bot01`]: { online: true, at: TS } });
    return r1.ok && r2.ok;
  }, code);
const botReady = (page, code) => page.evaluate((id) => window.__backend.db.update('bot01', { [`rooms/${id}/players/bot01/ready`]: true }).ok, code);

async function playRound(page, iAmSeeker) {
  // 역할 배정 고정: 정렬된 [bot01, tester01] 를 섞을 때 0.1 → tester01 이 술래
  await page.evaluate((v) => (Math.random = () => v), iAmSeeker ? 0.1 : 0.9);
  const startBtn = (await visible(page, '#btn-start')) ? '#btn-start' : '#btn-next';
  await page.click(startBtn);
  await page.waitForSelector('#game-layer:not([hidden])', { timeout: 4000 });
  await page.waitForTimeout(400);
  const roomId = await page.evaluate(() => document.getElementById('lobby-code').textContent);
  const round = await dbGet(page, `rooms/${roomId}/round`);
  const role = round.seekers.tester01 ? 'seeker' : 'hider';
  check(role === (iAmSeeker ? 'seeker' : 'hider'), `역할 배정 (${role}, 규칙 통과)`);
  check((await page.textContent('#role-chip')).includes(iAmSeeker ? '술래' : '숨는 팀'), 'HUD 역할 표시');
  if (iAmSeeker) check(await visible(page, '#blindfold'), '숨는 시간 동안 술래 가림막 표시');

  const before = await dbGet(page, `roomPos/${roomId}/tester01`);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(600);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);
  const after = await dbGet(page, `roomPos/${roomId}/tester01`);
  if (iAmSeeker) check(before.x === after.x && before.z === after.z, '숨는 시간에 술래 위치 고정');
  else check(before.x !== after.x || before.z !== after.z, '숨는 팀 이동 → 위치 기록 (속도 규칙 통과)');

  if (!iAmSeeker) {
    await page.keyboard.press('KeyE');
    check(await visible(page, '#disguise-panel'), 'E 키로 변신 패널 열림');
    await page.keyboard.press('Digit1');
    await page.waitForTimeout(400);
    check((await dbGet(page, `rooms/${roomId}/players/tester01/disguise`)) === 'barrel', '1번 선택 → 나무통 변신 (규칙 통과)');
    check((await page.textContent('#role-chip')).includes('나무통'), 'HUD 변신 상태 표시');
    const p1 = await dbGet(page, `roomPos/${roomId}/tester01`);
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(500);
    await page.keyboard.up('KeyD');
    const p2 = await dbGet(page, `roomPos/${roomId}/tester01`);
    check(p1.x === p2.x && p1.z === p2.z, '변신 중 이동 불가');
    // 시간 종료 → 브라우저 점검 작업이 종료 기록 → 숨는 팀 승리
    await shiftTime(page, round.roundEndsAt - Date.now() + 1500);
    await page.waitForSelector('#screen-results:not([hidden])', { timeout: 8000 });
    check((await page.textContent('#res-winner')).includes('숨는 팀'), '시간 종료 → 숨는 팀 승리 결과 화면');
    await page.waitForTimeout(3300);
    return;
  }

  await shiftTime(page, round.hideEndsAt - Date.now() + 500);
  await page.waitForTimeout(400);
  check(!(await visible(page, '#blindfold')), '추격 시간 → 가림막 해제');
  check(await visible(page, '#crosshair'), '조준점 표시');
  check(await visible(page, '#btn-capture'), '포획 버튼 표시');
  const me = await dbGet(page, `roomPos/${roomId}/tester01`);
  await page.evaluate(([id, x, z]) => window.__backend.db.force(`roomPos/${id}/bot01`, { x: x + 1, z, r: 0, t: window.__backend.now() }), [roomId, me.x, me.z]);
  await page.waitForTimeout(800);
  let alive = await dbGet(page, `rooms/${roomId}/round/alive`);
  check(alive && alive.bot01 === true, '바로 옆에 있어도 버튼을 누르지 않으면 포획되지 않음');
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(300);
  const toastText = await page.textContent('#toasts');
  check(/조준/.test(toastText), `조준 없이 포획 → 안내 ("${toastText.trim().slice(0, 30)}")`);
  alive = await dbGet(page, `rooms/${roomId}/round/alive`);
  check(alive && alive.bot01 === true, '조준하지 않은 포획 요청으로는 잡히지 않음');
  // 규칙 검사: 대상이 멀리 있으면 거부
  const capture = (bx) =>
    page.evaluate(async ([id, x, z, b]) => {
      const A = await import('/shared/actions.js');
      const { db, now } = window.__backend;
      db.force(`roomPos/${id}/bot01`, { x: x + b, z, r: 0, t: now() });
      const round = db.get(`rooms/${id}/round`);
      return db.update('tester01', A.captureUpdate({ code: id, uid: 'tester01', target: 'bot01', round, pos: { x, z, r: 0 }, TS: { '.sv': 'timestamp' } })).ok;
    }, [roomId, me.x, me.z, bx]);
  check((await capture(6)) === false, '대상이 6m 떨어져 있으면 규칙이 포획 거부');
  check((await capture(1.5)) === true, '규칙을 만족하면 포획 성공');
  await page.waitForSelector('#screen-results:not([hidden])', { timeout: 6000 });
  check((await page.textContent('#res-winner')).includes('술래'), '모두 포획 → 브라우저가 종료 기록 → 술래 팀 승리');
  check((await page.textContent('#res-body')).includes('봇친구'), '결과표에 플레이어 표시');
  check(await page.locator('#btn-next').isDisabled(), '결과 직후 3초간 다음 라운드 대기 (전적 기록 시간)');
  await page.waitForTimeout(3300);
}

const browser = await chromium.launch();
try {
  // ---------------- PC ----------------
  const page = await openPage(browser, { viewport: { width: 1366, height: 768 } });
  await page.waitForSelector('#screen-home:not([hidden])', { timeout: 6000 });
  check(true, '시작 화면 표시');
  await page.fill('#nickname', '테스터');
  await page.click('#btn-create');
  await page.waitForSelector('#screen-lobby:not([hidden])', { timeout: 4000 });
  const code = await page.textContent('#lobby-code');
  check(/^[A-Z0-9]{6}$/.test(code), `방 생성 (규칙 통과) → 대기실 (코드 ${code})`);
  check(await page.locator('#btn-start').isDisabled(), '혼자일 때 시작 버튼 비활성');
  check(await addBot(page, code), '두 번째 플레이어 참가 (규칙 통과)');
  await page.waitForTimeout(300);
  check((await page.locator('#player-list li').count()) === 2, '참가자 목록 2명');
  check(await page.locator('#btn-start').isDisabled(), '상대가 준비 전이면 시작 불가');
  await botReady(page, code);
  await page.waitForTimeout(300);
  check(!(await page.locator('#btn-start').isDisabled()), '모두 준비 → 시작 가능');
  await page.click('.char[data-char="leaf"]');
  await page.waitForTimeout(200);
  check((await dbGet(page, `rooms/${code}/players/tester01/character`)) === 'leaf', '캐릭터 선택 저장');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lobby-pc.png` });

  await playRound(page, true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/results-pc.png` });
  const st1 = await dbGet(page, 'playerStats/tester01');
  check(st1 && st1.gamesPlayed === 1 && st1.captures === 1 && st1.wins === 1 && st1.points === 20, `전적 자동 기록 (규칙 검사 통과): ${JSON.stringify(st1 && { g: st1.gamesPlayed, c: st1.captures, p: st1.points })}`);
  check(!!(await dbGet(page, `matchHistory/${st1 && st1.lastRound}`)), '방장이 경기 기록 저장');
  await playRound(page, false);

  await page.click('#btn-to-lobby');
  await page.waitForSelector('#screen-lobby:not([hidden])', { timeout: 4000 });
  check(true, '대기실로 돌아가기');
  await page.click('#btn-leave');
  await page.waitForSelector('#screen-home:not([hidden])', { timeout: 4000 });
  check(true, '방 나가기 → 시작 화면');
  await page.click('#btn-stats');
  await page.waitForTimeout(400);
  const statsText = await page.textContent('#modal-body');
  check(/2회/.test(statsText), '내 전적: 2판 기록');
  await page.click('#modal-close');
  await page.click('#btn-ranking');
  await page.waitForTimeout(300);
  check((await page.locator('.rank-table tbody tr').count()) >= 1, '전체 순위 표시');
  await page.click('#modal-close');

  await page.fill('#join-code', 'ZZZZZZ');
  await page.click('#btn-join');
  await page.waitForTimeout(400);
  check(/존재하지/.test(await page.textContent('#toasts')), '잘못된 방 코드 안내');

  // ---------------- 모바일 (가로) ----------------
  const m = await openPage(browser, { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await m.waitForSelector('#screen-home:not([hidden])', { timeout: 6000 });
  if (SHOTS) await m.screenshot({ path: `${SHOTS}/home-mobile.png` });
  await m.fill('#nickname', '모바일');
  await m.click('#btn-create');
  await m.waitForSelector('#screen-lobby:not([hidden])');
  const mcode = await m.textContent('#lobby-code');
  await addBot(m, mcode);
  await botReady(m, mcode);
  await m.waitForTimeout(300);
  await m.evaluate(() => (Math.random = () => 0.1));
  await m.tap('#btn-start');
  await m.waitForSelector('#game-layer:not([hidden])');
  const rd = await dbGet(m, `rooms/${mcode}/round`);
  await shiftTime(m, rd.hideEndsAt - Date.now() + 500);
  await m.waitForTimeout(500);
  const cap = await m.locator('#btn-capture').boundingBox();
  const mini = await m.locator('#minimap').boundingBox();
  check(!!cap && cap.x + cap.width <= 844 && cap.y + cap.height <= 390, '모바일 포획 버튼이 화면 안에 있음');
  check(!!mini && !(cap.x < mini.x + mini.width && cap.y < mini.y + mini.height), '포획 버튼과 미니맵이 겹치지 않음');
  const p0 = await dbGet(m, `roomPos/${mcode}/tester01`);
  const cdp = await m.context().newCDPSession(m);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await touch('touchStart', 150, 280);
  for (let i = 1; i <= 6; i++) await touch('touchMove', 150, 280 - i * 10);
  await m.waitForTimeout(700);
  await touch('touchEnd', 0, 0);
  await m.waitForTimeout(300);
  const p1 = await dbGet(m, `roomPos/${mcode}/tester01`);
  check(p0.x !== p1.x || p0.z !== p1.z, '모바일 가상 조이스틱으로 이동 (속도 규칙 통과)');
  if (SHOTS) await m.screenshot({ path: `${SHOTS}/game-mobile.png` });
} catch (e) {
  failures++;
  console.log('FAIL  예외: ' + e.message.split('\n')[0]);
} finally {
  await browser.close();
}

if (errors.length) {
  console.log('\n런타임 오류:');
  errors.forEach((e) => console.log('  ' + e));
}
console.log(`\n${failures === 0 && errors.length === 0 ? '모든 스모크 테스트 통과' : `실패 ${failures}건, 오류 ${errors.length}건`}`);
process.exit(failures || errors.length ? 1 : 0);
