// 팜솔라 업무네트웍 · 통합 프록시 (Vercel 서버리스, Node/CommonJS)
// GitHub Pages(정적)는 CORS로 VWorld/국토부/한전 직접호출 불가 → 이 프록시가 서버에서 대신 호출.
// 키는 서버 env로 주입(브라우저 노출 0):  VWORLD_KEY / KEPCO_API_KEY (Vercel 프로젝트 Settings → Environment Variables)
//  - /req/*   → api.vworld.kr/req/*   (VWorld: 주소검색·필지·용도지역)     [rewrite __path]
//  - /ned/*   → api.vworld.kr/ned/*   (국토부: getLandUseAttr 지역지구)     [rewrite __npath]
//  - /dem/*   → api.opentopodata.org  (표고 → 경사도)                        [rewrite __dpath]
//  - /kepco/* → bigdata.kepco.co.kr   (분산전원연계정보: 변전소·DL 여유)    [rewrite __kpath]
const https = require('https');

function vget(target, referer) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };
    if (referer) headers.Referer = referer;
    const r = https.request(target, { method: 'GET', headers }, (up) => {
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => resolve({ status: up.statusCode || 200, type: up.headers['content-type'] || 'application/octet-stream', buf: Buffer.concat(chunks) }));
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
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  try {
    const u = new URL(req.url, 'http://local');

    // ---- DEM (OpenTopoData 표고 → 경사도 산출) ----
    const dpath = u.searchParams.get('__dpath');
    if (dpath != null) {
      u.searchParams.delete('__dpath');
      const target = 'https://api.opentopodata.org/' + dpath + '?' + u.searchParams.toString();
      const r = await vget(target);
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json;charset=UTF-8'); res.end(r.buf); return;
    }

    // ---- KEPCO 분산전원연계정보 (변전소·DL 여유용량) ----
    const kpath = u.searchParams.get('__kpath');
    if (kpath != null) {
      u.searchParams.delete('__kpath');
      if (process.env.KEPCO_API_KEY) u.searchParams.set('apiKey', process.env.KEPCO_API_KEY);
      if (!u.searchParams.get('returnType')) u.searchParams.set('returnType', 'json');
      const target = 'https://bigdata.kepco.co.kr/openapi/v1/' + kpath + '?' + u.searchParams.toString();
      const r = await vget(target);
      res.statusCode = r.status;   // KEPCO 404(NotFound=해당 읍면동 자료없음)는 그대로 전달 → 클라가 폴백
      res.setHeader('Content-Type', 'application/json;charset=UTF-8');
      res.end(r.buf); return;
    }

    // ---- NED (VWorld 국토부: getLandUseAttr 지역지구 등) ----
    const npath = u.searchParams.get('__npath');
    if (npath != null) {
      u.searchParams.delete('__npath');
      const NKEY = process.env.VWORLD_KEY;
      if (NKEY && !u.searchParams.get('key')) u.searchParams.set('key', NKEY);
      if (!u.searchParams.get('domain')) u.searchParams.set('domain', 'http://localhost');
      const target = 'https://api.vworld.kr/ned/' + npath + '?' + u.searchParams.toString();
      const r = await vget(target, 'http://localhost');
      res.statusCode = 200;
      res.setHeader('Content-Type', r.type);
      res.end(r.buf); return;
    }

    // ---- VWorld (주소검색·필지·용도지역) ----
    let p = u.searchParams.get('__path') || '';
    u.searchParams.delete('__path');
    const KEY = process.env.VWORLD_KEY;
    if (KEY) p = p.replace('__KEY__', KEY);
    if (KEY && !u.searchParams.get('key')) u.searchParams.set('key', KEY);
    const qs = u.searchParams.toString();
    const target = 'https://api.vworld.kr/req/' + p + (qs ? ('?' + qs) : '');
    const r = await vget(target, 'http://localhost');
    res.statusCode = 200;
    res.setHeader('Content-Type', r.type);
    res.end(r.buf);
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ proxy_error: String((e && e.message) || e), code: e && e.code }));
  }
};
