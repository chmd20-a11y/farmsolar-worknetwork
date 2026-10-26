-- 팜솔라 업무네트웍 · AI 사용량 카운터 (과금 안전장치)
-- 발전허가증 OCR 등 AI 호출의 "일일 사용량"을 집계해 서버가 상한 초과 시 호출을 차단한다.
-- 민감정보가 없는 단순 카운터라 공개(anon) 키로 읽기/증가를 허용한다. (fsnet_deals 보안은 그대로)
-- Supabase 대시보드 → SQL Editor 에서 1회 Run.

create table if not exists public.ai_usage (
  id         text primary key,          -- 기능 구분 키 (예: 'permit_ocr')
  day        text,                      -- KST 기준 'YYYY-MM-DD'
  count      integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.ai_usage enable row level security;

-- 비민감 카운터 — anon/authenticated 모두 읽기·증가 허용
drop policy if exists ai_usage_rw on public.ai_usage;
create policy ai_usage_rw on public.ai_usage
  for all to anon, authenticated
  using (true) with check (true);

-- 2026-10-30부터 public 새 테이블 자동 GRANT 중단 → 명시적 부여 필수
grant all on public.ai_usage to anon, authenticated, service_role;
