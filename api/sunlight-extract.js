// 팜솔라 업무네트웍 · 햇빛소득마을 사업계획서 AI 자동채움 (Vercel 서버리스, Node/CommonJS)
// 마을 자료(폴더) 텍스트에서 서식 필드값을 추출해 {필드키: 값}과 {필드키: 근거문장}으로 돌려준다.
// ★무료 Google Gemini 사용 — 키는 서버 env로만(브라우저 노출 0), 무료등급이라 전 담당자가 공유해도 비용 0.
//   env:  GEMINI_API_KEY   (Google AI Studio 무료 키)
//   선택: SUNLIGHT_GEMINI_MODEL (기본 gemini-flash-latest / 모델 리네임 시 여기서 교체. 예: gemini-3.8-flash)
// 키 미설정 시 503(no_key) — 프런트는 안내만 하고 수동 입력으로 폴백.
const https = require('https');

function gemini(key, model, system, user) {
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 8192 },
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
    r.setTimeout(60000, () => r.destroy(new Error('timeout')));
    r.write(payload);
    r.end();
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method', message: 'POST only' }); return; }
  const key = process.env.GEMINI_API_KEY;
  if (!key) { res.status(503).json({ error: 'no_key', message: 'GEMINI_API_KEY 미설정 — Google AI Studio 무료 키를 Vercel 환경변수에 등록하면 AI 자동채움이 작동합니다(무료).' }); return; }
  const model = process.env.SUNLIGHT_GEMINI_MODEL || 'gemini-flash-latest';
  try {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const title = String(b.title || '서식');
    const fields = Array.isArray(b.fields) ? b.fields : [];
    const corpus = String(b.corpus || '').slice(0, 200000);
    if (!fields.length) { res.status(400).json({ error: 'no_fields' }); return; }
    if (!corpus.trim()) { res.status(200).json({ values: {}, sources: {}, note: 'empty_corpus' }); return; }

    const fieldList = fields.map((f) => {
      const base = `- ${f.fk}: ${String(f.label || '').slice(0, 120)}`;
      if (Array.isArray(f.options) && f.options.length) return base + ` [선택지 — 다음 중 정확히 하나의 문자열로만 답: ${f.options.map((o) => String(o)).join(' / ')}]`;
      return base;
    }).join('\n');
    const system = '당신은 한국 공공 행정서식(햇빛소득마을 공모) 자동작성을 돕는 매우 꼼꼼한 도우미입니다. "마을 자료"에서 각 필드에 들어갈 값을 정확히 추출합니다. 반드시 지킬 규칙: (1) 자료에서 명확한 근거를 찾은 값만 채웁니다. 근거가 불명확하거나 자료에 없으면 그 필드는 결과에서 생략합니다(절대 추측·창작 금지). (2) 금액·용량·인원·비율 등 숫자는 라벨의 단위에 맞게 숫자만 적습니다(쉼표 허용). (3) 이 서식은 정부 공모 신청 제출용 서류이므로, 라벨이 요구하면 주민등록번호(13자리 전체)·사업자등록번호·법인등록번호·생년월일·주소·전화번호·계좌번호 등 민감정보도 자료에 있으면 "있는 그대로 전부" 채웁니다. 절대 마스킹하지 말고(별표 *·동그라미 ● 금지), 뒷자리 생략 없이 전체 값을 그대로 출력합니다. 자료에 없으면 생략합니다. (4) 채운 값마다 자료에서 근거가 된 "원문 문장/구절"을 그대로 함께 제시합니다. (5) 라벨에 [선택지 …]가 있는 필드는 반드시 그 선택지 중 정확히 하나의 문자열로만 답합니다(선택지에 없는 값·여러 개 금지). 자료에서 어느 선택지인지 명확히 판단되지 않으면 그 필드는 생략합니다(추측 금지). (6) 출력은 아래 형식의 JSON 하나만: {"values":{"<키>":"<값>"}, "sources":{"<키>":"<근거 원문>"}}.';
    const user = `[서식 이름]\n${title}\n\n[채울 필드 — "키: 라벨" 형식]\n${fieldList}\n\n[마을 자료(폴더에서 수집한 텍스트)]\n${corpus}\n\n위 자료만 근거로, 각 필드 키에 들어갈 값과 그 근거 원문을 JSON으로 출력하세요. 근거를 못 찾은 필드는 values/sources 어디에도 넣지 마세요.`;

    const r = await gemini(key, model, system, user);
    if (r.status >= 400) { res.status(502).json({ error: 'upstream', status: r.status, message: r.body.slice(0, 500) }); return; }
    let text = '';
    try {
      const j = JSON.parse(r.body);
      const cand = j.candidates && j.candidates[0];
      text = (cand && cand.content && cand.content.parts && cand.content.parts.map((p) => p.text || '').join('')) || '';
    } catch (e) { text = ''; }
    const m = text.match(/\{[\s\S]*\}/);
    let parsed = {};
    if (m) { try { parsed = JSON.parse(m[0]); } catch (e) { parsed = {}; } }
    const vIn = parsed.values || parsed || {};
    const sIn = parsed.sources || {};
    const allow = new Set(fields.map((f) => f.fk));
    const values = {}, sources = {};
    Object.keys(vIn).forEach((k) => {
      if (allow.has(k) && vIn[k] != null && String(vIn[k]).trim()) {
        values[k] = String(vIn[k]).trim().slice(0, 400);
        if (sIn[k]) sources[k] = String(sIn[k]).trim().slice(0, 300);
      }
    });
    res.status(200).json({ values, sources, count: Object.keys(values).length });
  } catch (e) {
    res.status(500).json({ error: 'fail', message: String((e && e.message) || e) });
  }
};
