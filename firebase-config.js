// ─────────────────────────────────────────────────────────────
//  모의창업 IR 펀딩 · 설정 파일 (이 파일만 고치면 돼요)
// ─────────────────────────────────────────────────────────────

// 1) Firebase 콘솔 › 프로젝트 설정 › 일반 › 내 앱(웹 </>) 에서
//    "firebaseConfig" 값을 복사해 아래에 그대로 붙여넣으세요.
//    apiKey 와 appId 는 웹 앱을 등록해야 나와요.
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "irfund.firebaseapp.com",
  projectId: "irfund",
  storageBucket: "irfund.firebasestorage.app",
  messagingSenderId: "1077419221787",
  appId: "YOUR_APP_ID"
};

// 2) 관리자(선생님) 구글 계정 이메일. 여러 명이면 쉼표로 추가하세요.
//    firestore.rules 파일의 adminEmails() 목록과 똑같이 맞춰야 해요.
export const ADMIN_EMAILS = [
  "bnlee0525@gmail.com"
];

// 3) 학생 화면의 금액·순위가 갱신되는 간격(초).
//    관리자 화면이 열려 있는 동안 이 간격으로 집계해 학생들에게 보내요.
//    숫자를 키우면 Firebase 무료 사용량을 아낄 수 있어요. (권장 3~6)
export const SUMMARY_INTERVAL_SEC = 4;
