// 팜솔라 업무네트웍 · 행정 — 토지(임야)대장(이미지/PDF)에서 「토지 소재」(지번 제외 주소)를 Gemini Vision으로 읽어 반환
//   env:  GEMINI_API_KEY (permit-date-ocr.js·sunlight-ocr.js와 동일 키)
//   선택: SUNLIGHT_GEMINI_MODEL (기본 gemini-flash-latest)
//   [과금 안전장치]
//     LANDREG_OCR_DISABLED=1     → 기능 즉시 OFF(킬스위치)
//     LANDREG_OCR_DAILY_CAP=200  → 하루 호출 상한(기본 200). 무료 한도보다 낮게 잡아 과금 선에 닿기 전에 차단
// 입력: POST { name, mimeType, dataBase64 }  — 파일 1개(이미지/PDF, Vercel 요청 4.5MB 이하)
// 출력: { landAddr: '경기도 파주시 문발동'|'', raw }   — 개발행위 사업계획서 6번 표 「토지소재지」 자동채움용
const https = require('https');

// 사용량 카운터 저장소 = 전용 테이블 public.ai_usage (민감정보 없음 → 공개 publishable 키로 읽기/증가 허용).
//   fsnet_deals는 RLS로 anon 쓰기가 막혀 있어(보안 유지) 별도 카운터 테이블을 둔다. → supabase_ai_usage.sql 1회 Run 필요.
const SB_URL = 'https://cgthfwlswaohxolgixvv.supabase.co';
const SB_KEY = 'sb_publishable_8wN2rwb0gQUKI89Z6jwHuQ_BSoJFDRI';
const USAGE_ID = 'landreg_ocr';
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
    generationConfig: { temperature: 0, maxOutputTokens: 512, responseMimeType: 'application/json' },
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
// 지번·산·번지 제거하고 '시·도 시·군·구 읍·면·동(리)'까지만 남김
function normAddr(v) {
  let t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  t = t.replace(/\s*(산\s*)?\d+(-\d+)?\s*(번지)?\s*$/, '').trim();
  return t.length > 60 ? '' : t;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method', message: 'POST only' }); return; }
  // [안전장치 ③] 킬스위치
  if (process.env.LANDREG_OCR_DISABLED === '1') { res.status(503).json({ error: 'disabled', message: 'AI 자동읽기가 일시 중지되었습니다 — 토지소재지를 직접 입력하세요.' }); return; }
  const key = process.env.GEMINI_API_KEY;
  if (!key) { res.status(503).json({ error: 'no_key', message: 'GEMINI_API_KEY 미설정 — 서버 환경변수 등록 필요.' }); return; }
  const primary = process.env.SUNLIGHT_GEMINI_MODEL || 'gemini-flash-latest';
  const models = [...new Set([primary, 'gemini-2.5-flash', 'gemini-flash-lite-latest'])];
  try {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const name = String(b.name || '토지대장');
    const mimeType = String(b.mimeType || '');
    const dataBase64 = String(b.dataBase64 || '');
    if (!dataBase64 || !mimeType) { res.status(400).json({ error: 'no_file', message: 'mimeType·dataBase64 필요' }); return; }
    if (!/^(application\/pdf|image\/(png|jpe?g|webp|gif))$/.test(mimeType)) { res.status(415).json({ error: 'unsupported', message: 'PDF 또는 이미지만 지원' }); return; }
    if (dataBase64.length > 5 * 1024 * 1024) { res.status(413).json({ error: 'too_large', message: '파일이 큽니다(약 4MB 초과)' }); return; }

    const system = '당신은 한국의 토지대장·임야대장에서 "토지 소재"(토지 소재지)를 찾아내는 도우미입니다. 규칙: '
      + '(1) 반드시 JSON 객체 하나만 출력합니다: {"landAddr":"주소"}. '
      + '(2) 표 상단의 "토지 소재" 칸에 적힌 주소를 그대로 쓰되, 시·도부터 읍·면·동(리)까지만 씁니다(예: "경기도 파주시 문발동", "경기도 연천군 전곡읍 은대리"). '
      + '(3) 지번(예: 66, 140-40, 산12)·"번지"는 절대 넣지 않습니다. 소유자 주소·발급기관 주소 등 다른 주소는 쓰지 않습니다. '
      + '(4) 토지 소재가 보이지 않으면 {"landAddr":""}로 둡니다. 추정·창작 금지 — 문서에 실제로 보이는 글자만 사용합니다. '
      + '(5) 설명·머리말·마크다운·코드펜스 없이 JSON 객체만 출력합니다.';
    const parts = [
      { text: '다음 파일(' + name + ')에서 토지 소재(지번 제외)를 찾아 JSON으로 답하세요:' },
      { inlineData: { mimeType, data: dataBase64 } },
    ];

    // [안전장치 ②] 일일 호출 상한 — 호출 "시도" 기준으로 집계
    const CAP = parseInt(process.env.LANDREG_OCR_DAILY_CAP || '200', 10) || 200;
    const today = kstDay();
    let used = 0;
    try { const u = await getUsage(); if (u && u.day === today) used = u.count || 0; } catch (e) {}
    if (used >= CAP) { res.status(429).json({ error: 'daily_cap', cap: CAP, message: '오늘 AI 자동읽기 한도(' + CAP + '회)에 도달했습니다 — 토지소재지를 직접 입력하세요.' }); return; }
    try { await setUsage(today, used + 1); } catch (e) {}

    const r = await geminiTryModels(key, models, system, parts);
    if (r.status >= 400) { res.status(502).json({ error: 'upstream', status: r.status, message: String(r.body || '').slice(0, 500) }); return; }
    let raw = '';
    try {
      const j = JSON.parse(r.body);
      const cand = j.candidates && j.candidates[0];
      raw = (cand && cand.content && cand.content.parts && cand.content.parts.map((p) => p.text || '').join('')) || '';
    } catch (e) { raw = ''; }
    let landAddr = '';
    try { landAddr = normAddr(JSON.parse(raw).landAddr); } catch (e) { /* JSON이 아니면 빈 값 */ }
    res.status(200).json({ landAddr, raw: String(raw || '').slice(0, 2000) });
  } catch (e) {
    res.status(500).json({ error: 'fail', message: String((e && e.message) || e) });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '5mb' } }, maxDuration: 60 };
