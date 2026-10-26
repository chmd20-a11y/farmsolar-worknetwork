// 팜솔라 업무네트웍 · 행정 — 발전허가증(이미지/PDF)에서 공사 착공·준공 예정일(사업기간)을 Gemini Vision으로 읽어 반환
//   env:  GEMINI_API_KEY (sunlight-ocr.js와 동일 키)
//   선택: SUNLIGHT_GEMINI_MODEL (기본 gemini-flash-latest)
// 입력: POST { name, mimeType, dataBase64 }  — 파일 1개(이미지/PDF, Vercel 요청 4.5MB 이하)
// 출력: { start:'YYYY-MM-DD'|'', end:'YYYY-MM-DD'|'', raw }   — 개발행위 신청서 「사업기간」 자동채움용
const https = require('https');

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

// 'YYYY-M-D'(또는 유사) → 'YYYY-MM-DD' 정규화·유효성 검사. 아니면 ''
function normDate(v) {
  const m = /(\d{4})\s*[-.\/년]\s*(\d{1,2})\s*[-.\/월]?\s*(\d{1,2})/.exec(String(v || '').trim());
  if (!m) return '';
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

module.exports = async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { res.status(503).json({ error: 'no_key', message: 'GEMINI_API_KEY 미설정 — 서버 환경변수 등록 필요.' }); return; }
  // [임시 진단] GET ?diag=models → 이 키가 generateContent로 쓸 수 있는 모델 목록
  if (req.method === 'GET') {
    const u = String(req.url || '');
    if (/diag=models/.test(u)) {
      const r = await new Promise((resolve) => {
        const rq = https.request('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + encodeURIComponent(key), { method: 'GET' }, (up) => {
          const c = []; up.on('data', (x) => c.push(x)); up.on('end', () => resolve({ status: up.statusCode, body: Buffer.concat(c).toString('utf8') }));
        });
        rq.on('error', (e) => resolve({ status: 599, body: String(e) })); rq.setTimeout(20000, () => rq.destroy(new Error('timeout'))); rq.end();
      });
      let names = [];
      try { const j = JSON.parse(r.body); names = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0).map((m) => m.name.replace('models/', '')); } catch (e) {}
      res.status(200).json({ status: r.status, flashModels: names.filter((n) => /flash|pro/.test(n)) });
      return;
    }
    res.status(405).json({ error: 'method', message: 'POST only' }); return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method', message: 'POST only' }); return; }
  // 기본 모델 + 과부하 시 폴백 후보(중복 제거). 한 모델이 503이어도 다른 모델로 시도.
  const primary = process.env.SUNLIGHT_GEMINI_MODEL || 'gemini-flash-latest';
  const models = [...new Set([primary, 'gemini-2.0-flash', 'gemini-1.5-flash'])];
  try {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const name = String(b.name || '발전허가증');
    const mimeType = String(b.mimeType || '');
    const dataBase64 = String(b.dataBase64 || '');
    if (!dataBase64 || !mimeType) { res.status(400).json({ error: 'no_file', message: 'mimeType·dataBase64 필요' }); return; }
    if (!/^(application\/pdf|image\/(png|jpe?g|webp|gif))$/.test(mimeType)) { res.status(415).json({ error: 'unsupported', message: 'PDF 또는 이미지만 지원' }); return; }
    if (dataBase64.length > 5 * 1024 * 1024) { res.status(413).json({ error: 'too_large', message: '파일이 큽니다(약 4MB 초과)' }); return; }

    const system = '당신은 한국의 발전사업 허가증(발전허가증) 등 행정서류에서 공사의 "착공 예정일"과 "준공 예정일"(=사업기간)을 찾아내는 도우미입니다. 규칙: '
      + '(1) 반드시 JSON 객체 하나만 출력합니다: {"start":"YYYY-MM-DD","end":"YYYY-MM-DD"}. '
      + '(2) start=공사 착공(시작) 예정일, end=준공(완료) 예정일. 문서에 "착공/준공" 외에 "공사기간·사업기간·공사착수·사용전검사·준공예정" 등으로 표기될 수 있으니 의미로 판단합니다. '
      + '(3) 해당 날짜가 문서에 보이지 않으면 그 값은 빈 문자열 ""로 둡니다. '
      + '(4) 추정·창작 금지 — 문서에 실제로 보이는 날짜만 사용합니다. 허가일자·유효기간 등 사업기간이 아닌 날짜는 넣지 않습니다. '
      + '(5) 설명·머리말·마크다운·코드펜스 없이 JSON 객체만 출력합니다.';
    const parts = [
      { text: '다음 파일(' + name + ')에서 공사 착공 예정일과 준공 예정일을 찾아 JSON으로 답하세요:' },
      { inlineData: { mimeType, data: dataBase64 } },
    ];

    const r = await geminiTryModels(key, models, system, parts);
    if (r.status >= 400) { res.status(502).json({ error: 'upstream', status: r.status, message: String(r.body || '').slice(0, 500) }); return; }
    let raw = '';
    try {
      const j = JSON.parse(r.body);
      const cand = j.candidates && j.candidates[0];
      raw = (cand && cand.content && cand.content.parts && cand.content.parts.map((p) => p.text || '').join('')) || '';
    } catch (e) { raw = ''; }
    let start = '', end = '';
    try {
      const o = JSON.parse(raw);
      start = normDate(o.start);
      end = normDate(o.end);
    } catch (e) { /* raw가 JSON이 아니면 클라이언트가 평문에서 보조 추출 */ }
    res.status(200).json({ start, end, raw: String(raw || '').slice(0, 4000) });
  } catch (e) {
    res.status(500).json({ error: 'fail', message: String((e && e.message) || e) });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '5mb' } }, maxDuration: 60 };
