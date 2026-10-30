// 팜솔라 업무네트웍 · 행정 — 건축물대장(이미지/PDF)에서 「건축면적(㎡)」을 Gemini Vision으로 읽어 반환
//   env:  GEMINI_API_KEY (permit-date-ocr.js·sunlight-ocr.js와 동일 키)
//   선택: SUNLIGHT_GEMINI_MODEL (기본 gemini-flash-latest)
//   [과금 안전장치]
//     BLDREG_OCR_DISABLED=1      → 기능 즉시 OFF(킬스위치)
//     BLDREG_OCR_DAILY_CAP=200   → 하루 호출 상한(기본 200). 무료 한도보다 낮게 잡아 과금 선에 닿기 전에 차단
// 입력: POST { name, mimeType, dataBase64 }  — 파일 1개(이미지/PDF, Vercel 요청 4.5MB 이하)
// 출력: { bldArea: 숫자(㎡)|'', gubun, struct, use, mainUse, owners:[{name,addr}], raw }
//   — 개발행위 사업계획서 「건축면적」·7번 건축물 면적 조서 자동채움용 (주민번호는 읽지 않음)
const https = require('https');

// 사용량 카운터 저장소 = 전용 테이블 public.ai_usage (민감정보 없음 → 공개 publishable 키로 읽기/증가 허용).
//   fsnet_deals는 RLS로 anon 쓰기가 막혀 있어(보안 유지) 별도 카운터 테이블을 둔다. → supabase_ai_usage.sql 1회 Run 필요.
const SB_URL = 'https://cgthfwlswaohxolgixvv.supabase.co';
const SB_KEY = 'sb_publishable_8wN2rwb0gQUKI89Z6jwHuQ_BSoJFDRI';
const USAGE_ID = 'bldreg_ocr';
function sbReq(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { apikey: SB_KEY, authorization: 'Bearer ' + SB_KEY };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); headers['prefer'] = 'resolution=merge-duplicates,return=minimal'; }
    const rq = https.request(SB_URL + path, { method, headers }, (up) => {
      const c = []; up.on('data', (x) => c.push(x)); up.on('end', () => resolve({ status: up.statusCode || 0, body: Buffer.concat(c).toString('utf8') }));
    });
    rq.on('error', () => resolve({ status: 0, body: '' })); rq.setTimeout(6000, () => rq.destroy());
    if (data) rq.write(data); rq.end();
  });
}
function kstDay() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
async function getUsage() {
  const r = await sbReq('GET', '/rest/v1/ai_usage?id=eq.' + USAGE_ID + '&select=day,count');
  try { const a = JSON.parse(r.body); return (a && a[0]) || null; } catch (e) { return null; }
}
async function setUsage(day, count) {
  await sbReq('POST', '/rest/v1/ai_usage', [{ id: USAGE_ID, day: day, count: count }]);
}

function geminiMM(key, model, system, parts, timeoutMs) {
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0, maxOutputTokens: 2048, responseMimeType: 'application/json' },
  });
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);
  return new Promise((resolve, reject) => {
    const r = https.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (up) => {
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => resolve({ status: up.statusCode || 200, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.setTimeout(timeoutMs || 24000, () => r.destroy(new Error('timeout')));
    r.write(payload);
    r.end();
  });
}
// 과부하(503)·혼잡(429)·5xx·타임아웃·모델없음(404)이면 다음 모델로 폴백(Vercel 60s 한도 안, 모델당 1회 17s).
// 400/415(요청·포맷 문제)는 모델을 바꿔도 소용없어 즉시 반환.
async function geminiTryModels(key, models, system, parts) {
  let last = null;
  for (const mdl of models) {
    try { last = await geminiMM(key, mdl, system, parts, 16000); }
    catch (e) { last = { status: 599, body: String((e && e.message) || e) }; }
    if (last.status < 400) return last;
    if (last.status === 400 || last.status === 415) return last;   // 다른 모델로도 해결 안 됨
    // 404/429/503/5xx/599 → 다음 모델 시도
  }
  return last;
}

// '1,234.56㎡' 같은 값 → 숫자(㎡). 0 이하·비정상이면 ''
function normArea(v) {
  const m = /([\d,]+(?:\.\d+)?)/.exec(String(v == null ? '' : v));
  if (!m) return '';
  const n = parseFloat(m[1].replace(/,/g, ''));
  return (n > 0 && n < 10000000) ? n : '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method', message: 'POST only' }); return; }
  // [안전장치 ③] 킬스위치
  if (process.env.BLDREG_OCR_DISABLED === '1') { res.status(503).json({ error: 'disabled', message: 'AI 자동읽기가 일시 중지되었습니다 — 건축면적을 직접 입력하세요.' }); return; }
  const key = process.env.GEMINI_API_KEY;
  if (!key) { res.status(503).json({ error: 'no_key', message: 'GEMINI_API_KEY 미설정 — 서버 환경변수 등록 필요.' }); return; }
  const primary = process.env.SUNLIGHT_GEMINI_MODEL || 'gemini-flash-latest';
  const models = [...new Set([primary, 'gemini-2.5-flash', 'gemini-flash-lite-latest'])];
  try {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const name = String(b.name || '건축물대장');
    const mimeType = String(b.mimeType || '');
    const dataBase64 = String(b.dataBase64 || '');
    if (!dataBase64 || !mimeType) { res.status(400).json({ error: 'no_file', message: 'mimeType·dataBase64 필요' }); return; }
    if (!/^(application\/pdf|image\/(png|jpe?g|webp|gif))$/.test(mimeType)) { res.status(415).json({ error: 'unsupported', message: 'PDF 또는 이미지만 지원' }); return; }
    if (dataBase64.length > 5 * 1024 * 1024) { res.status(413).json({ error: 'too_large', message: '파일이 큽니다(약 4MB 초과)' }); return; }

    const system = '당신은 한국의 건축물대장(일반건축물대장·집합건축물대장 표제부)에서 값을 찾아내는 도우미입니다. 규칙: '
      + '(1) 반드시 JSON 객체 하나만 출력합니다: {"bldArea":"숫자","gubun":"","struct":"","use":"","mainUse":"","owners":[{"name":"","addr":""}]}. '
      + '(2) bldArea = "건축면적" 칸의 값(단위 ㎡, 쉼표 없이). "대지면적"·"연면적"·"용적률산정용연면적"·"건폐율" 등 다른 면적은 절대 넣지 않습니다. '
      + '(3) "건축물 현황" 표의 첫 번째 줄에서 gubun = 구분(예: "주1"), struct = 구조(예: "철골조"), use = 용도의 맨 첫 번째 항목 하나만(예: "축사,퇴비사"이면 "축사"). '
      + '(4) mainUse = 표제부 "주용도" 칸의 값(예: "동물 및 식물관련시설"). '
      + '(5) owners = "소유자 현황"의 각 소유자 성명(명칭)과 주소(최대 10명, 위에서부터 순서대로). 주민(법인)등록번호·소유권 지분·변동일은 절대 넣지 않습니다. '
      + '(6) 보이지 않는 값은 빈 문자열로 둡니다. 추정·창작 금지 — 문서에 실제로 보이는 글자만 사용합니다. '
      + '(7) 설명·머리말·마크다운·코드펜스 없이 JSON 객체만 출력합니다.';
    const parts = [
      { text: '다음 파일(' + name + ')에서 건축면적·건축물 현황 첫 줄·주용도·소유자(성명·주소)를 찾아 JSON으로 답하세요:' },
      { inlineData: { mimeType, data: dataBase64 } },
    ];

    // [안전장치 ②] 일일 호출 상한 — 호출 "시도" 기준으로 집계
    const CAP = parseInt(process.env.BLDREG_OCR_DAILY_CAP || '200', 10) || 200;
    const today = kstDay();
    let used = 0;
    try { const u = await getUsage(); if (u && u.day === today) used = u.count || 0; } catch (e) {}
    if (used >= CAP) { res.status(429).json({ error: 'daily_cap', cap: CAP, message: '오늘 AI 자동읽기 한도(' + CAP + '회)에 도달했습니다 — 건축면적을 직접 입력하세요.' }); return; }
    try { await setUsage(today, used + 1); } catch (e) {}

    const r = await geminiTryModels(key, models, system, parts);
    if (r.status >= 400) { res.status(502).json({ error: 'upstream', status: r.status, message: String(r.body || '').slice(0, 500) }); return; }
    let raw = '';
    try {
      const j = JSON.parse(r.body);
      const cand = j.candidates && j.candidates[0];
      raw = (cand && cand.content && cand.content.parts && cand.content.parts.map((p) => p.text || '').join('')) || '';
    } catch (e) { raw = ''; }
    let bldArea = '', gubun = '', struct = '', use = '', mainUse = '', owners = [];
    const T = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 80);
    try {
      const o = JSON.parse(raw);
      bldArea = normArea(o.bldArea); gubun = T(o.gubun); struct = T(o.struct); mainUse = T(o.mainUse);
      use = T(o.use).split(/[,，·]/)[0].trim();
      owners = (Array.isArray(o.owners) ? o.owners : []).map((w) => ({ name: T(w && w.name), addr: T(w && w.addr) }))
        .filter((w) => w.name || w.addr).slice(0, 10);
    } catch (e) { /* JSON이 아니면 빈 값 */ }
    res.status(200).json({ bldArea, gubun, struct, use, mainUse, owners, raw: String(raw || '').slice(0, 2000) });
  } catch (e) {
    res.status(500).json({ error: 'fail', message: String((e && e.message) || e) });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '5mb' } }, maxDuration: 60 };
