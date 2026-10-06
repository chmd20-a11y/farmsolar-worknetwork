// 구조검토 외주 이관 — 메일(SMTP) + 문자(중계기) 서버리스 (Vercel, 서울 icn1)
// 브라우저는 업체 키(vendorKey)만 전송 → 실제 수신 이메일/휴대폰은 서버 env가 보유·발송(공개 소스 무노출).
//
// 필요 환경변수 (Vercel → Settings → Environment Variables):
//   SMTP_HOST   메일 발송 SMTP 호스트 (@kakao.com → smtp.kakao.com / @daum.net → smtp.daum.net)
//   SMTP_PORT   (선택) 기본 465 (SSL)
//   SMTP_USER   발송 계정 아이디(이메일 주소)
//   SMTP_PASS   발송 계정 비밀번호(또는 앱 비밀번호) — 절대 소스/깃에 두지 않음
//   MAIL_FROM   (선택) 보내는 사람 표기 (기본 SMTP_USER)
//   VENDOR_A_NAME / VENDOR_A_PERSON / VENDOR_A_FIELD / VENDOR_A_EMAIL / VENDOR_A_PHONE
//   VENDOR_B_NAME / VENDOR_B_PERSON / VENDOR_B_FIELD / VENDOR_B_EMAIL / VENDOR_B_PHONE
//   RELAY_URL / RELAY_KEY (문자 발송 — 기존 /api/sms 와 동일, 맥미니 중계기)
//   RELAY_SENDER (선택, 기본 0625754745) / RELAY_ACCOUNT (선택, 기본 gwangju)
//
//   (테스트 수신·선택) STRUCT_TEST_TO / STRUCT_TEST_PHONE : 설정 시 실제 업체 대신 이 주소로 발송([테스트] 프리픽스)
// GET  /api/struct-mail?list=1  → {ok, vendors:[{key,name,person,field,email(마스킹),phone(마스킹),configured}]}
// POST /api/struct-mail {vendorKey, subject, html, text, smsText, attachments:[...], test?:{to,phone}}
//      test(요청) 또는 STRUCT_TEST_TO(env)가 있으면 그 주소로 발송. → {ok, mailOk, smsOk, mailErr, smsErr, test}
const https = require('https');

function vendorEnv(key) {
  const K = key === 'B' ? 'B' : 'A';
  return {
    key: K,
    name: process.env['VENDOR_' + K + '_NAME'] || '',
    person: process.env['VENDOR_' + K + '_PERSON'] || '',
    field: process.env['VENDOR_' + K + '_FIELD'] || '',
    email: process.env['VENDOR_' + K + '_EMAIL'] || '',
    phone: process.env['VENDOR_' + K + '_PHONE'] || '',
  };
}
function maskEmail(e) {
  e = String(e || ''); const at = e.indexOf('@'); if (at < 1) return e ? '***' : '';
  const loc = e.slice(0, at), dom = e.slice(at);
  const keep = loc.length <= 3 ? 1 : 3;
  return loc.slice(0, keep) + '***' + dom;
}
function maskPhone(p) {
  const n = String(p || '').replace(/[^0-9]/g, ''); if (!n) return '';
  if (n.length < 7) return n;
  return n.slice(0, 3) + '-****-' + n.slice(-4);
}
function relayPost(urlStr, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const r = https.request(u, { method: 'POST', headers }, (up) => {
      const c = []; up.on('data', d => c.push(d)); up.on('end', () => resolve({ status: up.statusCode || 200, body: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject); r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    r.write(bodyStr); r.end();
  });
}
async function sendSms(phone, message, name) {
  const RELAY_URL = process.env.RELAY_URL, RELAY_KEY = process.env.RELAY_KEY;
  if (!RELAY_URL || !RELAY_KEY) return { ok: false, err: '문자중계기 미설정' };
  const payload = JSON.stringify({
    receiver: String(phone).replace(/[^0-9]/g, ''), message: String(message || ''), receiver_name: name || '',
    sender: process.env.RELAY_SENDER || '0625754745', account: process.env.RELAY_ACCOUNT || 'gwangju'
  });
  try {
    const r = await relayPost(RELAY_URL.replace(/\/+$/, '') + '/send',
      { 'Content-Type': 'application/json', 'X-Relay-Key': RELAY_KEY, 'ngrok-skip-browser-warning': 'true' }, payload);
    let j = {}; try { j = JSON.parse(r.body || '{}'); } catch (e) {}
    const ok = r.status < 400 && (j.ok || String(j.code) === '9');
    return { ok, err: ok ? '' : (j.error || ('문자 서버오류 ' + r.status)) };
  } catch (e) { return { ok: false, err: '문자중계기 연결 실패' }; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  // 업체 표시정보(마스킹) 목록
  if (req.method === 'GET') {
    const vendors = ['A', 'B'].map(k => {
      const v = vendorEnv(k);
      return { key: k, name: v.name, person: v.person, field: v.field, email: maskEmail(v.email), phone: maskPhone(v.phone), configured: !!v.email };
    });
    res.statusCode = 200; res.end(JSON.stringify({ ok: true, vendors })); return;
  }
  if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ ok: false, error: 'GET/POST only' })); return; }

  const SMTP_HOST = process.env.SMTP_HOST, SMTP_USER = process.env.SMTP_USER, SMTP_PASS = process.env.SMTP_PASS;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    res.statusCode = 503; res.end(JSON.stringify({ ok: false, error: '메일서버 미설정 (SMTP_HOST/SMTP_USER/SMTP_PASS 환경변수 필요)' })); return;
  }
  try {
    let body = ''; await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
    const p = JSON.parse(body || '{}');
    const v = vendorEnv(p.vendorKey);
    // 🧪 테스트 수신 모드 — 요청의 test.to(또는 env STRUCT_TEST_TO)가 있으면 실제 업체 대신 테스트 주소로 발송
    const reqTest = (p.test && p.test.to) ? p.test : null;
    const envTestTo = process.env.STRUCT_TEST_TO || '';
    const test = reqTest || (envTestTo ? { to: envTestTo, phone: process.env.STRUCT_TEST_PHONE || '' } : null);
    const toEmail = test ? test.to : v.email;
    const toPhone = test ? (test.phone || '') : v.phone;
    if (!toEmail) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, mailOk: false, error: '수신 이메일 없음 (업체 VENDOR_' + v.key + '_EMAIL 또는 테스트 주소 필요)' })); return; }
    const intended = v.email ? (v.name ? (v.name + ' <' + v.email + '>') : v.email) : ('업체 ' + v.key);
    const testNoteHtml = test ? ('<div style="background:#fff6e5;border:1px solid #e8a33d;border-radius:6px;padding:8px 10px;margin-bottom:12px;color:#7a4a00;font-size:13px">🧪 <b>테스트 발송</b> — 실제 수신 예정처: ' + intended + '</div>') : '';
    const testNoteText = test ? ('[테스트 발송] 실제 수신 예정처: ' + intended + '\n\n') : '';

    const nodemailer = require('nodemailer');
    const tx = nodemailer.createTransport({
      host: SMTP_HOST, port: Number(process.env.SMTP_PORT || 465), secure: true,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    const attachments = (Array.isArray(p.attachments) ? p.attachments : []).filter(a => a && a.contentBase64).map(a => ({
      filename: a.filename || 'attachment', content: Buffer.from(a.contentBase64, 'base64'), contentType: a.contentType || undefined
    }));

    let mailOk = false, mailErr = '';
    try {
      await tx.sendMail({
        from: process.env.MAIL_FROM || SMTP_USER,
        to: (!test && v.person) ? `${v.person} <${v.email}>` : toEmail,
        subject: (test ? '[테스트] ' : '') + String(p.subject || '구조검토 의뢰'),
        text: p.text ? (testNoteText + String(p.text)) : undefined,
        html: p.html ? (testNoteHtml + String(p.html)) : undefined,
        attachments
      });
      mailOk = true;
    } catch (e) { mailErr = String((e && e.message) || e); }

    // 문자(업체 담당자 확인요청) — 테스트 주소 또는 업체 번호 등록 시에만
    let smsOk = false, smsErr = '';
    if (toPhone && p.smsText) {
      const s = await sendSms(toPhone, (test ? '[테스트] ' : '') + p.smsText, test ? '테스트' : (v.person || '담당자'));
      smsOk = s.ok; smsErr = s.err;
    } else { smsErr = toPhone ? '' : '수신 휴대폰 미설정'; }

    res.statusCode = (mailOk ? 200 : 502);
    res.end(JSON.stringify({ ok: mailOk, mailOk, smsOk, mailErr, smsErr, test: !!test }));
  } catch (e) {
    res.statusCode = 502; res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  }
};
