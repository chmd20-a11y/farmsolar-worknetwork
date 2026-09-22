// 문자나라 발송 프록시 (Vercel 서버리스, 서울 icn1)
// 브라우저 POST /api/sms {receiver, message, receiver_name, sender?} → 문자나라 중계기 /send
// 중계기 발송키는 서버 env로만 주입(브라우저 무노출):
//   RELAY_URL   = https://projector-fetch-underpaid.ngrok-free.dev  (맥미니 중계기 ngrok 고정주소)
//   RELAY_KEY   = rk_...  (X-Relay-Key 발송키)
//   RELAY_SENDER(선택) = 기본 발신번호 (미지정 시 0625754745)
//   RELAY_ACCOUNT(선택) = 기본 계정 (미지정 시 gwangju)
// 한글 EUC-KR 인코딩·발신번호 인증·2차비번은 전부 중계기(맥미니)가 처리. 성공코드 9.
const https = require('https');

function post(urlStr, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const r = https.request(u, { method: 'POST', headers }, (up) => {
      const c = [];
      up.on('data', d => c.push(d));
      up.on('end', () => resolve({ status: up.statusCode || 200, body: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    r.write(bodyStr); r.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ ok: false, error: 'POST only' })); return; }

  const RELAY_URL = process.env.RELAY_URL, RELAY_KEY = process.env.RELAY_KEY;
  if (!RELAY_URL || !RELAY_KEY) {
    res.statusCode = 503; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: '발송서버 미설정 (RELAY_URL/RELAY_KEY 환경변수 필요)' })); return;
  }
  try {
    let body = '';
    await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
    const p = JSON.parse(body || '{}');
    const receiver = String(p.receiver || '').replace(/[^0-9]/g, '');
    if (!receiver) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: '수신번호 없음' })); return; }
    const payload = JSON.stringify({
      receiver,
      message: String(p.message || ''),
      receiver_name: p.receiver_name || '',
      sender: p.sender || process.env.RELAY_SENDER || '0625754745',
      account: p.account || process.env.RELAY_ACCOUNT || 'gwangju'
    });
    const r = await post(RELAY_URL.replace(/\/+$/, '') + '/send',
      { 'Content-Type': 'application/json', 'X-Relay-Key': RELAY_KEY, 'ngrok-skip-browser-warning': 'true' }, payload);
    res.statusCode = r.status; res.setHeader('Content-Type', 'application/json'); res.end(r.body || '{}');
  } catch (e) {
    res.statusCode = 502; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  }
};
