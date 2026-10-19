// 업무네트웍 · Cloudflare R2 첨부 저장 — presigned(임시) URL 발급 서버리스 (Vercel, Node/CommonJS)
// 브라우저는 "업로드 허가증(서명 PUT URL)"만 받아 파일을 R2로 직접 올립니다. R2 비밀키는 서버 env로만(브라우저·git 노출 0).
// ★독립 함수: 공유 proxy.js / vercel.json 을 건드리지 않음(타 기능 무영향). 기존 bldreg.js·sms.js 와 동일 패턴.
//
// 필요 환경변수 (Vercel → Settings → Environment Variables) — 카드/버킷 확보 후 채우면 자동 가동:
//   R2_ACCOUNT_ID        Cloudflare 계정 ID
//   R2_ACCESS_KEY_ID     R2 API 토큰 Access Key ID
//   R2_SECRET_ACCESS_KEY R2 API 토큰 Secret Access Key  (★비밀 — 소스/깃에 두지 않음)
//   R2_BUCKET            버킷 이름 (예: fsnet-attach)
//   R2_PUBLIC_BASE       (선택) 커스텀 공개 도메인 (예: https://files.example.com). 있으면 공개 URL, 없으면 서명 GET.
//
// 엔드포인트:
//   GET  /api/r2-sign?ping=1                 → {ok:true, ready:<env 4종 모두 설정 여부>}  (프론트 가동여부 탐지)
//   GET  /api/r2-sign?op=get&key=<r2_key>    → {ok, getUrl}  서명 GET(비공개 열람 갱신용, 만료 7일)
//   POST /api/r2-sign {filename, contentType, owner, part, docKey}
//        → {ok, key, uploadUrl, getUrl, public, expiresIn}   (uploadUrl 로 PUT 업로드)

function envReady() {
  return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
}

// 파일명 안전화: 경로/제어문자 제거, 허용문자만, 길이 제한(확장자 보존)
function safeName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  let stem = dot > 0 ? base.slice(0, dot) : base;
  let ext = dot > 0 ? base.slice(dot + 1) : '';
  stem = stem.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'file';
  ext = ext.replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
  return ext ? stem + '.' + ext : stem;
}
function seg(v, def) { return (String(v || '').replace(/[^A-Za-z0-9가-힣_-]/g, '') || def); }

// R2(S3 호환) 클라이언트 — 지연 require(ping 은 SDK 불필요). 의존성: @aws-sdk/client-s3, @aws-sdk/s3-request-presigner
function makeClient() {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: 'auto',
    endpoint: 'https://' + process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com',
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}
async function signPut(key, contentType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const cmd = new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, ContentType: contentType });
  return getSignedUrl(makeClient(), cmd, { expiresIn: 600 });        // 업로드 허가 10분
}
async function signGet(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key });
  return getSignedUrl(makeClient(), cmd, { expiresIn: 604800 });     // 서명 열람 7일(R2 최대)
}
// 열람 URL: 공개 도메인이 있으면 공개 URL, 없으면 서명 GET
async function viewUrl(key) {
  const base = process.env.R2_PUBLIC_BASE;
  if (base) return { url: base.replace(/\/+$/, '') + '/' + key, public: true };
  return { url: await signGet(key), public: false };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Content-Type', 'application/json;charset=UTF-8');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  try {
    const u = new URL(req.url, 'http://local');

    // 가동여부 탐지(프론트가 R2/base64 자동 선택) — 키 없어도 안전하게 응답
    if (u.searchParams.get('ping') != null) {
      res.statusCode = 200; res.end(JSON.stringify({ ok: true, ready: envReady() })); return;
    }
    if (!envReady()) { res.statusCode = 200; res.end(JSON.stringify({ ok: false, reason: 'nokey' })); return; }

    // 서명 GET(열람 갱신)
    if (req.method === 'GET' && u.searchParams.get('op') === 'get') {
      const key = u.searchParams.get('key') || '';
      if (!key) { res.statusCode = 200; res.end(JSON.stringify({ ok: false, reason: 'nokey_param' })); return; }
      const v = await viewUrl(key);
      res.statusCode = 200; res.end(JSON.stringify({ ok: true, getUrl: v.url, public: v.public })); return;
    }

    if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ ok: false, error: 'POST only' })); return; }

    let body = ''; await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
    const p = JSON.parse(body || '{}');
    const filename = safeName(p.filename);
    const contentType = String(p.contentType || 'application/octet-stream').slice(0, 120);
    const part = seg(p.part, 'etc');            // 영업·설계·시공·행정
    const owner = seg(p.owner, 'x');            // dealId / siteId
    const docKey = seg(p.docKey, '');
    // 키: part/owner/docKey/YYYYMMDD/<ts>-<rand>-<파일명>  (서버 생성 → 충돌·덮어쓰기 방지)
    const d = new Date();
    const ymd = '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const rand = Math.random().toString(36).slice(2, 8);
    const key = [part, owner, docKey, ymd].filter(Boolean).join('/') + '/' + Date.now() + '-' + rand + '-' + filename;

    const uploadUrl = await signPut(key, contentType);
    const v = await viewUrl(key);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, key, uploadUrl, getUrl: v.url, public: v.public, expiresIn: 600 }));
  } catch (e) {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, reason: 'error', msg: String((e && e.message) || e) }));
  }
};
