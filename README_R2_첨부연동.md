# 첨부파일 R2 연동 — 가동 절차 (카드 확보 후)

첨부파일(사진·문서)을 Supabase DB(base64) 대신 **Cloudflare R2**에 저장하고 DB엔 링크만 두는 구조입니다.
**코드 뼈대는 이미 배포됨.** 아래 ①~④만 하면 자동으로 R2 모드로 전환됩니다. (하기 전까지는 기존 base64 방식으로 정상 동작)

## 지금 상태
- R2 env 미설정 → 업로드는 **기존 base64 저장**(변화 없음). 기존 첨부본도 그대로 열람.
- env 채우면 → 이후 업로드부터 **R2 저장**. 프론트 코드 수정 불필요.

## ① Cloudflare R2 (콘솔)
1. 계정 결제수단 등록 → R2 활성화
2. 버킷 생성 (예: `fsnet-attach`) — **비공개** 권장
3. R2 **API 토큰** 발급 → `Account ID` / `Access Key ID` / `Secret Access Key` 확보
4. 버킷 **CORS** 설정: 허용 Origin = 대시보드 도메인(`https://farmsolar-worknetwork.vercel.app`), 메서드 = `PUT, GET`
5. (선택) 비민감 이미지를 공개로 열람하려면 커스텀 도메인 연결 → 그 주소를 `R2_PUBLIC_BASE`로

## ② Supabase (SQL Editor, 1회)
- `supabase_fsnet_attachments.sql` 전체 붙여넣고 Run (첨부 메타 테이블 생성)

## ③ Vercel 환경변수 (Settings → Environment Variables)
| 변수 | 값 | 비고 |
|---|---|---|
| `R2_ACCOUNT_ID` | Cloudflare 계정 ID | |
| `R2_ACCESS_KEY_ID` | R2 Access Key ID | |
| `R2_SECRET_ACCESS_KEY` | R2 Secret Access Key | ★비밀 — 절대 소스/깃 금지 |
| `R2_BUCKET` | `fsnet-attach` | 버킷명 |
| `R2_PUBLIC_BASE` | (선택) `https://files.example.com` | 공개 도메인 쓸 때만 |

→ 입력 후 **재배포**(Deploy). `GET /api/r2-sign?ping=1` 이 `{"ok":true,"ready":true}` 면 가동 상태.

## ④ 확인
- 행정 「발전사업 허가」 또는 시공 「시공서류함」에서 파일 업로드 → 열기 ↗ 로 R2 링크 열람
- Supabase `fsnet_attachments`에 메타 행 적재 확인, Cloudflare R2 대시보드에서 오브젝트 확인

## 참고 (범위)
- 이번 전환 대상: **행정 발전허가 첨부(`permitDocUpload`)·시공서류함 첨부(`piDocUpload`)**
- 범위 밖(별도 base64, 추후): 회원 **ID 사진(내/대리인 신분증)**, 구조검토 **메일 첨부**(DB 저장 아님)
- 기존에 base64로 저장된 첨부본은 R2 가동 후에도 계속 열람됨(혼용 안전). 이관은 선택(`R2_연동_작업계획.md` §5).
