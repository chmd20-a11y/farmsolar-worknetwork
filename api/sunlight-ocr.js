// 팜솔라 업무네트웍 · 햇빛소득마을 — 스캔(이미지) PDF·사진을 Gemini 멀티모달로 읽어 평문 텍스트 추출
// pdf.js로는 못 읽는 스캔본·가배치도·명함 속 글자를 서버에서 Gemini가 OCR한다.
//   env:  GEMINI_API_KEY (sunlight-extract.js와 동일 키)
//   선택: SUNLIGHT_GEMINI_MODEL (기본 gemini-flash-latest)
// 입력: POST { name, mimeType, dataBase64 }  — 파일 1개(이미지/PDF, Vercel 요청 4.5MB 이하)
// 출력: { text, name }   (추정·창작 금지, 보이는 글자만)
const https = require('https');

function geminiMM(key, model, system, parts) {
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0, maxOutputTokens: 8192 },
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
    r.setTimeout(90000, () => r.destroy(new Error('timeout')));
    r.write(payload);
    r.end();
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method', message: 'POST only' }); return; }
  const key = process.env.GEMINI_API_KEY;
  if (!key) { res.status(503).json({ error: 'no_key', message: 'GEMINI_API_KEY 미설정 — 서버 환경변수 등록 필요.' }); return; }
  const model = process.env.SUNLIGHT_GEMINI_MODEL || 'gemini-flash-latest';
  try {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const name = String(b.name || '파일');
    const mimeType = String(b.mimeType || '');
    const dataBase64 = String(b.dataBase64 || '');
    if (!dataBase64 || !mimeType) { res.status(400).json({ error: 'no_file', message: 'mimeType·dataBase64 필요' }); return; }
    if (!/^(application\/pdf|image\/(png|jpe?g|webp|gif))$/.test(mimeType)) { res.status(415).json({ error: 'unsupported', message: 'PDF 또는 이미지만 지원' }); return; }
    if (dataBase64.length > 5 * 1024 * 1024) { res.status(413).json({ error: 'too_large', message: '파일이 큽니다(약 4MB 초과) — 건너뜀' }); return; }

    const system = '당신은 한국 공공 행정서류(햇빛소득마을 공모)의 스캔본·사진에서 글자를 정확히 읽어내는 OCR 도우미입니다. 규칙: (1) 문서/이미지에 실제로 보이는 모든 텍스트·숫자·이름·번호·날짜·금액을 빠짐없이 그대로 추출합니다. (2) 표는 가능한 한 행/열 구조를 살려 적되, 셀 값은 보이는 그대로 적습니다. (3) 추정·창작·요약을 하지 않습니다 — 보이지 않는 값은 쓰지 않습니다. (4) 설명·머리말 없이 추출한 텍스트만 출력합니다.';
    const parts = [
      { text: '다음 파일(' + name + ')에 보이는 모든 글자를 추출하세요:' },
      { inlineData: { mimeType, data: dataBase64 } },
    ];

    const r = await geminiMM(key, model, system, parts);
    if (r.status >= 400) { res.status(502).json({ error: 'upstream', status: r.status, message: r.body.slice(0, 500) }); return; }
    let text = '';
    try {
      const j = JSON.parse(r.body);
      const cand = j.candidates && j.candidates[0];
      text = (cand && cand.content && cand.content.parts && cand.content.parts.map((p) => p.text || '').join('')) || '';
    } catch (e) { text = ''; }
    res.status(200).json({ name, text: String(text || '').slice(0, 40000), chars: (text || '').length });
  } catch (e) {
    res.status(500).json({ error: 'fail', message: String((e && e.message) || e) });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '5mb' } } };
