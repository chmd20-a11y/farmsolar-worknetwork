// 팜솔라 업무네트웍 · 햇빛소득마을 사업계획서 AI 자동채움 (Vercel 서버리스, Node/CommonJS)
// 마을 자료(폴더) 텍스트에서 서식 필드값을 추출해 {필드키: 값} 으로 돌려준다.
// ★키는 서버 env로만 주입(브라우저 노출 0):  ANTHROPIC_API_KEY  (Anthropic API 키)
//   선택 env: SUNLIGHT_MODEL (기본 claude-opus-4-8)
// 키 미설정 시 503(no_key) — 프런트는 안내만 하고 수동 입력으로 폴백(R2 패턴).
const https = require('https');

function anthropic(key, model, system, user) {
  const payload = JSON.stringify({
    model: model,
    max_tokens: 2500,
    system: system,
    messages: [{ role: 'user', content: user }],
  });
  return new Promise((resolve, reject) => {
    const r = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(payload),
      },
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
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(503).json({ error: 'no_key', message: 'ANTHROPIC_API_KEY 미설정 — Vercel 환경변수에 등록하면 AI 자동채움이 작동합니다.' }); return; }
  const model = process.env.SUNLIGHT_MODEL || 'claude-opus-4-8';
  try {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const title = String(b.title || '서식');
    const fields = Array.isArray(b.fields) ? b.fields : [];
    const corpus = String(b.corpus || '').slice(0, 60000);
    if (!fields.length) { res.status(400).json({ error: 'no_fields' }); return; }
    if (!corpus.trim()) { res.status(200).json({ values: {}, note: 'empty_corpus' }); return; }

    const fieldList = fields.map((f) => `- ${f.fk}: ${String(f.label || '').slice(0, 60)}`).join('\n');
    const system = '당신은 한국 공공 행정서식 자동작성 도우미입니다. 주어진 "마을 자료"에서 각 필드에 들어갈 값만 정확히 추출합니다. 규칙: (1) 자료에서 근거를 찾을 수 있는 값만 채우고, 불확실하거나 자료에 없으면 그 필드는 아예 생략합니다(추측 금지). (2) 금액·용량 등 숫자는 서식 라벨 단위에 맞춰 숫자만(쉼표 허용). (3) 주민등록번호·계좌번호 등 민감 고유식별정보는 절대 채우지 말고 생략. (4) 출력은 JSON 객체 하나만, 다른 설명 금지.';
    const user = `[서식 이름]\n${title}\n\n[채울 필드 — "키: 라벨" 형식]\n${fieldList}\n\n[마을 자료(폴더에서 수집한 텍스트)]\n${corpus}\n\n위 자료를 근거로 각 필드 키에 들어갈 값을 JSON 객체로만 출력하세요. 예: {"f12":"OO영농조합법인","f15":"350"}. 근거 없는 필드는 키 자체를 넣지 마세요.`;

    const r = await anthropic(key, model, system, user);
    if (r.status >= 400) { res.status(502).json({ error: 'upstream', status: r.status, message: r.body.slice(0, 400) }); return; }
    let text = '';
    try { const j = JSON.parse(r.body); text = (j.content && j.content[0] && j.content[0].text) || ''; } catch (e) { text = ''; }
    const m = text.match(/\{[\s\S]*\}/);
    let values = {};
    if (m) { try { values = JSON.parse(m[0]); } catch (e) { values = {}; } }
    // 안전: 문자열만, 키는 요청 필드에 한정
    const allow = new Set(fields.map((f) => f.fk));
    const clean = {};
    Object.keys(values).forEach((k) => { if (allow.has(k) && values[k] != null && String(values[k]).trim()) clean[k] = String(values[k]).trim().slice(0, 300); });
    res.status(200).json({ values: clean, count: Object.keys(clean).length });
  } catch (e) {
    res.status(500).json({ error: 'fail', message: String((e && e.message) || e) });
  }
};
