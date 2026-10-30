-- ============================================================
-- 업무네트웍 · 첨부파일 메타 테이블 (Cloudflare R2 분리 저장용)
-- ▶ 파일 실물은 R2(오브젝트 스토리지)에 저장하고, DB에는 "링크(경로)·메타"만 둡니다.
--   이 테이블은 감사/검색용 인덱스입니다. 화면 표시는 기존처럼 딜/현장 JSON의 첨부 레코드(url·r2_key)로 동작합니다.
-- 사용법: Supabase → SQL Editor → New query → 아래 전체 붙여넣기 → Run (1회).
--   ※ R2 연동(카드·버킷·env) 전에 미리 만들어 두어도 안전합니다(앱은 이 테이블이 없어도 정상 동작).
-- 되돌리기: 맨 아래 주석의 DROP 1줄 실행.
-- ============================================================

create table if not exists public.fsnet_attachments (
  id           bigint generated always as identity primary key,
  owner_id     text,                                   -- 딜 id(D-xxxx) 또는 현장 id(FS-xxxx)
  part         text,                                   -- 영업 · 설계 · 시공 · 행정
  doc_key      text,                                   -- 서류 종류 키(어느 첨부 슬롯인지)
  filename     text,
  content_type text,
  size         bigint,
  r2_key       text not null,                          -- R2 오브젝트 키(경로) — 열람 URL 생성의 기준
  uploaded_by  text,                                   -- 올린 사람(이름)
  created_at   timestamptz not null default now()
);
create index if not exists fsnet_attachments_owner_idx on public.fsnet_attachments (owner_id);

-- 접근정책 (기존 fsnet_ 테이블과 동일 간편모드: anon/authenticated 읽기·쓰기)
--   ※ fsnet_ 접두어 테이블에만 적용. 같은 프로젝트의 다른 앱(PLOT 등)은 각자 RLS로 그대로 보호됩니다.
alter table public.fsnet_attachments enable row level security;
drop policy if exists fsnet_attachments_all on public.fsnet_attachments;
create policy fsnet_attachments_all on public.fsnet_attachments for all to anon, authenticated using (true) with check (true);

-- 완료.
-- ============================================================
-- [되돌리기]  drop table if exists public.fsnet_attachments cascade;
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- Data API 접근 권한 (GRANT)
-- Supabase가 2026-10-30부터 public 스키마 새 테이블에 자동 부여를 중단.
-- 기존 자동권한과 동일 범위로 명시 유지(기존 테이블엔 no-op).
-- 실제 행 보안은 RLS 정책이 담당하며 이 GRANT는 그 범위를 넓히지 않음.
-- ──────────────────────────────────────────────────────────────
grant all on public.fsnet_attachments to anon, authenticated, service_role;
