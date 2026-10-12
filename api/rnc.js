// Vercel serverless: consulta un RNC o cédula en la DGII (consulta pública web)
// GET /api/rnc?rnc=130238202  ->  { rnc, nombre, nombreComercial, categoria, regimen, estado, actividad, administracionLocal, facturadorElectronico }
const DGII_URL = 'https://www.dgii.gov.do/app/WebApps/ConsultasWeb2/ConsultasWeb/consultas/rnc.aspx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function decode(s){
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ').trim();
}
function hidden(html, name){
  const m = html.match(new RegExp('id="' + name + '"[^>]*value="([^"]*)"')) || html.match(new RegExp('name="' + name + '"[^>]*value="([^"]*)"'));
  return m ? m[1].replace(/&amp;/g, '&') : '';
}

async function consultar(raw){
  const r1 = await fetch(DGII_URL, { headers: { 'user-agent': UA } });
  if(!r1.ok) throw new Error('DGII respondió ' + r1.status);
  const page = await r1.text();
  const cookie = (r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie') || ''])
    .filter(Boolean).map(c => c.split(';')[0]).join('; ');
  const form = new URLSearchParams();
  for(const n of ['__EVENTTARGET', '__EVENTARGUMENT', '__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION']) form.set(n, hidden(page, n));
  form.set('ctl00$cphMain$txtRNCCedula', raw);
  form.set('ctl00$cphMain$btnBuscarPorRNC', 'BUSCAR');
  form.set('ctl00$cphMain$hidActiveTab', '');
  const r2 = await fetch(DGII_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, 'referer': DGII_URL, 'origin': 'https://www.dgii.gov.do', ...(cookie ? { cookie } : {}) },
    body: form.toString()
  });
  if(!r2.ok) throw new Error('DGII respondió ' + r2.status);
  const html = await r2.text();
  const tbl = html.match(/id="cphMain_dvDatosContribuyentes"[\s\S]*?<\/table>/);
  const data = {};
  if(tbl){
    const re = /<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g;
    let m; while((m = re.exec(tbl[0]))) data[decode(m[1]).toLowerCase()] = decode(m[2]);
  }
  const info = decode((html.match(/id="cphMain_lblInformacion"[^>]*>([\s\S]*?)<\/span>/) || [])[1]);
  return { data, info };
}

export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  const raw = String((req.query && req.query.rnc) || '').replace(/\D/g, '');
  if(raw.length !== 9 && raw.length !== 11){
    return res.status(400).json({ error: 'El RNC debe tener 9 dígitos (o 11 si es cédula).' });
  }
  try{
    let out = await consultar(raw);
    /* La DGII a veces responde un error genérico; se reintenta una vez */
    if(!Object.keys(out.data).length && /ocurri[oó] un error/i.test(out.info)){
      await new Promise(r => setTimeout(r, 700));
      out = await consultar(raw);
    }
    const data = out.data;
    if(!Object.keys(data).length){
      if(/ocurri[oó] un error/i.test(out.info)) return res.status(503).json({ error: 'La DGII no pudo hacer la búsqueda en este momento. Intenta de nuevo en unos segundos.' });
      return res.status(404).json({ error: out.info || 'El RNC/Cédula no se encuentra inscrito como contribuyente.' });
    }
    const pick = (...keys) => { for(const k of keys){ const f = Object.keys(data).find(x => x.startsWith(k)); if(f && data[f]) return data[f]; } return ''; };
    return res.status(200).json({
      rnc: pick('cédula/rnc', 'cedula/rnc') || raw,
      nombre: pick('nombre/razón', 'nombre/razon'),
      nombreComercial: pick('nombre comercial'),
      categoria: pick('categor'),
      regimen: pick('régimen', 'regimen'),
      estado: pick('estado'),
      actividad: pick('actividad'),
      administracionLocal: pick('administraci'),
      facturadorElectronico: pick('facturador'),
      fuente: 'DGII', consultado: new Date().toISOString()
    });
  }catch(e){
    return res.status(502).json({ error: 'No se pudo consultar la DGII: ' + (e && e.message ? e.message : e) });
  }
}
