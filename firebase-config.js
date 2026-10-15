// =====================================================================
// Firebase 설정 (직접 입력해야 하는 파일)
// ---------------------------------------------------------------------
// 값 가져오는 곳:
//   Firebase 콘솔 → 프로젝트 설정(톱니바퀴) → 일반 → 내 앱 → 웹 앱(</>) → "SDK 설정 및 구성" → 구성(Config)
// databaseURL 은 Realtime Database 페이지 상단의 주소를 그대로 복사하세요.
//   예) 싱가포르: https://<프로젝트ID>-default-rtdb.asia-southeast1.firebasedatabase.app
//       미국:     https://<프로젝트ID>-default-rtdb.firebaseio.com
//
// 이 값들은 웹에 공개되어도 되는 "식별용" 정보입니다. 비밀 키가 아닙니다.
// 실제 보안은 Authentication(익명 로그인) + database.rules.json(보안 규칙)이 담당합니다.
// Spark(무료) 요금제만 사용하며 Cloud Functions 는 쓰지 않습니다.
// 서비스 계정 키(JSON) 같은 서버 비밀 값은 절대 이 파일에 넣지 마세요.
// =====================================================================

export const firebaseConfig = {
  apiKey: "AIzaSyDkezDtK3mn3LaIuDZmJQ3y_gIwuhPLURU",
  authDomain: "pokeevent4444.firebaseapp.com",
  databaseURL: "https://pokeevent4444-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "pokeevent4444",
  storageBucket: "pokeevent4444.firebasestorage.app",
  messagingSenderId: "41134232095",
  appId: "1:41134232095:web:40a80271fb491983f6fb2a"
};

// 로컬 에뮬레이터 테스트: http://localhost:8080/?emulator 처럼 주소 끝에 ?emulator 를 붙이면
// 실제 Firebase 대신 내 컴퓨터의 에뮬레이터(데모 프로젝트, 인증 + DB)에 연결합니다. (README 7단계)
const params = new URLSearchParams(location.search);
export const USE_EMULATORS =
  params.has('emulator') && ['localhost', '127.0.0.1'].includes(location.hostname);

export const EMULATOR = {
  host: location.hostname,
  projectId: 'demo-hideseek',
  authPort: 9099,
  databasePort: 9000,
};
