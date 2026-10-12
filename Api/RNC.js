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

export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  const raw = String((req.query && req.query.rnc) || '').replace(/\D/g, '');
  if(raw.length !== 9 && raw.length !== 11){
    return res.status(400).json({ error: 'El RNC debe tener 9 dígitos (o 11 si es cédula).' });
  }
  try{
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
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, 'referer': DGII_URL, ...(cookie ? { cookie } : {}) },
      body: form.toString()
    });
    if(!r2.ok) throw new Error('DGII respondió ' + r2.status);
    const html = await r2.text();// Vercel serverless: lee el texto de una cotización TRC y devuelve los datos estructurados con IA.
// POST /api/extract   body: { text, insurer, hints }
// Requiere la variable de entorno ANTHROPIC_API_KEY en Vercel (Settings → Environment Variables).
// Opcional: ANTHROPIC_MODEL (por defecto claude-opus-5-5).

export const config = { maxDuration: 60 };

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';

const SYSTEM = `Eres un analista de seguros en República Dominicana. Lees cotizaciones de seguro Todo Riesgo Construcción (TRC/CAR) y Todo Riesgo Montaje que envían las aseguradoras a un corredor, y devuelves sus datos en JSON.
Reglas:
- Responde SOLO con un objeto JSON válido, sin texto antes ni después.
- Montos como números (sin símbolos, sin comas). Si un dato no aparece, usa null. No inventes.
- premiumNet = prima neta (antes de impuestos). isc = impuesto selectivo al consumo (ISC, normalmente 16%). premiumTotal = prima total a pagar (neta + ISC).
- sumSeccionI = suma asegurada de la Sección I (daño material / obras). sumSeccionII = límite de Responsabilidad Civil (Sección II).
- deductibles: separa los deducibles en tres textos cortos, copiando el valor como lo da la aseguradora (porcentaje, mínimo, monto por evento):
    catastrophic = terremoto, huracán, ciclón, inundación y demás riesgos catastróficos o de la naturaleza.
    other = otros riesgos / demás riesgos / todo otro riesgo de la Sección I.
    liability = responsabilidad civil / daños a terceros / TPL / Sección II.
  Si no aparece alguno, usa null. No incluyas el nombre del tipo en el valor (ej: "2% del valor asegurado, mín. RD$ 500,000").
- clausesAccepted: lista de endosos o cláusulas que la aseguradora incluye, como "End. 001 SRCC", "End. 006 Gastos extras", "LMA 3100".
- currency: "DOP" o "USD".`;

function buildUser(text, insurer, hints){
  let u = `Aseguradora: ${insurer || 'no indicada'}\n`;
  if(hints && hints.labels && typeof hints.labels === 'object'){
    const lines = Object.entries(hints.labels)
      .filter(([, v]) => Array.isArray(v) && v.length)
      .map(([k, v]) => `- ${k}: ${v.join(' | ')}`);
    if(lines.length) u += `Esta aseguradora suele llamar así a estos campos en sus cotizaciones (aprendido de cotizaciones revisadas):\n${lines.join('\n')}\n`;
  }
  u += `\nDevuelve este JSON:\n{"premiumNet":number|null,"isc":number|null,"premiumTotal":number|null,"sumSeccionI":number|null,"sumSeccionII":number|null,"deductibles":{"catastrophic":string|null,"other":string|null,"liability":string|null},"clausesAccepted":string[],"currency":"DOP"|"USD"|null}\n\nTexto de la cotización:\n"""\n${text}\n"""`;
  return u;
}

function parseJson(raw){
  const s = String(raw || '').trim();
  try{ return JSON.parse(s); }catch(e){}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if(a !== -1 && b > a){ try{ return JSON.parse(s.slice(a, b + 1)); }catch(e){} }
  return null;
}

export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  if(req.method !== 'POST') return res.status(405).json({ error: 'Usa POST.' });
  if(!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Falta la variable ANTHROPIC_API_KEY en Vercel.' });

  let body = req.body;
  if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(e){ body = {}; } }
  const text = String((body && body.text) || '').slice(0, 60000);
  if(text.replace(/\s+/g, '').length < 30) return res.status(400).json({ error: 'El PDF no tiene texto suficiente para leer (¿es escaneado?).' });

  try{
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        messages: [{ role: 'user', content: buildUser(text, body.insurer, body.hints) }]
      })
    });
    const data = await r.json().catch(() => ({}));
    if(!r.ok){
      const msg = (data && data.error && data.error.message) || ('HTTP ' + r.status);
      return res.status(502).json({ error: 'La IA no respondió: ' + msg });
    }
    const out = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
    const json = parseJson(out);
    if(!json) return res.status(502).json({ error: 'La IA respondió en un formato que no se pudo leer.' });
    return res.status(200).json(json);
  }catch(e){
    return res.status(502).json({ error: 'No se pudo contactar la IA: ' + (e && e.message ? e.message : e) });
  }
}


    const tbl = html.match(/id="cphMain_dvDatosContribuyentes"[\s\S]*?<\/table>/);
    const data = {};
    if(tbl){
      const re = /<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g;
      let m; while((m = re.exec(tbl[0]))) data[decode(m[1]).toLowerCase()] = decode(m[2]);
    }
    if(!Object.keys(data).length){
      const info = decode((html.match(/id="cphMain_lblInformacion"[^>]*>([\s\S]*?)<\/span>/) || [])[1]);
      return res.status(404).json({ error: info || 'El RNC/Cédula no se encuentra inscrito como contribuyente.' });
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
