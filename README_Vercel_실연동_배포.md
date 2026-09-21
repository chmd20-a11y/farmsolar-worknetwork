# 팜솔라 업무네트웍 — 실시간 API(설치 가능성 진단) 독립 배포 가이드

설계 **타당성검토 → 설치 가능성 진단**을 **국토부·한전 실시간 API**로 돌리려면,
GitHub Pages(정적)로는 불가(CORS)하므로 **Vercel**에 전용 프록시와 함께 올립니다.
> 코드·프록시·진단 로직은 이미 이 repo에 준비돼 있습니다. 아래 **①~④, 약 10분**만 하시면 됩니다.

---

## ① Vercel에 이 repo 임포트
1. https://vercel.com 로그인(GitHub 계정 `chmd20-a11y`).
2. **Add New… → Project → Import** → `farmsolar-worknetwork` 선택.
3. Framework Preset = **Other** (그대로), **Deploy** 클릭.
   - `api/proxy.js`(서버리스 프록시) + `vercel.json`(rewrites)이 자동 인식됩니다.

## ② 서버 환경변수(키) 등록  ← 브라우저에 노출 안 됨
Vercel 프로젝트 → **Settings → Environment Variables** 에 추가:

| Name | Value |
|---|---|
| `VWORLD_KEY` | VWorld 인증키 (지오코딩·필지·용도지역·규제) |
| `KEPCO_API_KEY` | 한전 OPEN API 키 (변전소·DL 여유용량) |

추가 후 **Deployments → 최신 배포 → Redeploy** (환경변수 반영).

## ③ VWorld 인증키에 도메인 등록
VWorld(vworld.kr) 마이페이지 → 인증키 관리 → **서비스 URL**에 아래를 추가:
- `http://localhost` (프록시가 이 Referer로 호출함 — 필수)
- 배포된 Vercel 도메인 (예: `https://farmsolar-worknetwork.vercel.app`)

## ④ 확인
Vercel 배포 URL 접속 → **설계 → 신규 현장 접수**(또는 타당성검토) →
**지번 입력**(예: `경기도 파주시 문발동 66`) → **🔍 진단 실행** →
상단에 **🛰 국토부·한전 실시간** 배지 + 지목·경사·용도지역·규제판정·계통 여유 판정이 뜨면 성공.

그다음 **팀 공유 링크를 이 Vercel 주소로 교체**하세요.

---

## 참고
- **키 설정 전/GitHub Pages**에서는 진단이 **📊 추정치**로 표시됩니다(프록시 미연결 자동 폴백). 동작은 계속 됩니다.
- 키가 틀리거나 도메인 미등록이면 “VWorld 인증키 오류” 안내가 뜹니다 → ②③ 재확인.
- 계통(한전)은 **읍·면 단위 실시간** 조회입니다. 필지 정확 연계는 한전 연계검토로 확정.
- Supabase(공유 데이터)는 기존 publishable 키 그대로 Vercel에서도 동작합니다(추가 설정 불필요).
- 프록시 경로: `/req`(VWorld) · `/ned`(국토부 규제) · `/dem`(경사) · `/kepco`(계통) → 모두 `api/proxy.js` 경유.
- **실사용 전환 시**: 실제 지번·고객정보를 다루므로 저장소 비공개 + 로그인(정식 모드)으로 하드닝 권장.
