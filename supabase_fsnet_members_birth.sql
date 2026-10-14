-- 대리인 위임장 '위임받는 사람(수임인)'의 생년월일 저장용 칼럼
-- Supabase → SQL Editor 에 붙여넣고 Run (1회).
-- 추가 전까지는 회원가입/프로필이 생년월일 없이 정상 동작하며, 추가하면 가입·관리자편집·위임장 자동기입이 활성화됩니다.

alter table public.fsnet_members
  add column if not exists birth text;

-- 형식: 'YYYY-MM-DD' (회원가입/관리자 화면의 날짜 선택기 값 그대로 저장)
-- RLS 정책은 기존 fsnet_members 정책을 그대로 사용(칼럼만 추가).
