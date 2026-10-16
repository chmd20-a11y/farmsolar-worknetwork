// 팜솔라 업무네트웍 · 건축물대장 표제부(건축HUB) 프록시 (Vercel 서버리스, Node/CommonJS)
// 발전사업 허가 '건물명세서' 자동채움용 — PNU로 건축면적·구조·용도·소재지를 조회.
// ★독립 함수: 공유 proxy.js / vercel.json 을 건드리지 않음(계통여유 등 타 대시보드 무영향).
// 키는 서버 env로만 주입(브라우저 노출 0):  BLDREG_KEY  (data.go.kr 건축HUB 일반 인증키)
// 소유자 등 개인정보는 다루지 않음(표제부에 없음 → 등기부 수동).
const https = require('https');

function get(target) {
  return new Promise((resolve, reject) => {
    const r = https.request(target, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, (up) => {
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => resolve({ status: up.statusCode || 200, buf: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    r.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Content-Type', 'application/json;charset=UTF-8');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  try {
    const u = new URL(req.url, 'http://local');
    const pnu = (u.searchParams.get('pnu') || '').replace(/[^0-9]/g, '');
    const KEY = process.env.BLDREG_KEY;
    if (!KEY) { res.statusCode = 200; res.end(JSON.stringify({ ok: false, reason: 'nokey' })); return; }
    if (pnu.length !== 19) { res.statusCode = 200; res.end(JSON.stringify({ ok: false, reason: 'badpnu' })); return; }

    // PNU(19) = 법정동코드(10) + 필지구분(1: 1=대지,2=산) + 본번(4) + 부번(4)
    const sigunguCd = pnu.slice(0, 5), bjdongCd = pnu.slice(5, 10);
    const platGbCd = (pnu[10] === '2') ? '1' : '0';   // 건축HUB platGbCd: 0=대지, 1=산
    const bun = pnu.slice(11, 15), ji = pnu.slice(15, 19);

    const qs = new URLSearchParams({ serviceKey: KEY, sigunguCd, bjdongCd, platGbCd, bun, ji, numOfRows: '30', pageNo: '1', _type: 'json' }).toString();
    const r = await get('https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?' + qs);

    let j; try { j = JSON.parse(r.buf.toString('utf8')); } catch (_) { res.statusCode = 200; res.end(JSON.stringify({ ok: false, reason: 'badresp' })); return; }
    const resultCode = j && j.response && j.response.header && j.response.header.resultCode;
    if (resultCode && resultCode !== '00') { res.statusCode = 200; res.end(JSON.stringify({ ok: false, reason: 'api', code: resultCode, msg: (j.response.header.resultMsg || '') })); return; }

    const body = (j.response && j.response.body) || {};
    let it = (body.items && body.items.item) || [];
    if (it && !Array.isArray(it)) it = [it];
    const norm = it.map((b) => ({
      bldNm: b.bldNm || '',
      addr: b.platPlc || '',
      bldArea: (b.archArea != null && b.archArea !== '' ? String(b.archArea) : ''),
      struct: b.strctCdNm || '',
      use: b.mainPurpsCdNm || '',
      totArea: (b.totArea != null && b.totArea !== '' ? String(b.totArea) : ''),
      bun: b.bun || '', ji: b.ji || ''
    }));
    const real = norm.filter((x) => parseFloat(x.bldArea) > 0).sort((a, b) => parseFloat(b.bldArea || 0) - parseFloat(a.bldArea || 0));
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, total: body.totalCount || '0', primary: real[0] || norm[0] || null, items: norm }));
  } catch (e) {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, reason: 'error', msg: String((e && e.message) || e) }));
  }
};
