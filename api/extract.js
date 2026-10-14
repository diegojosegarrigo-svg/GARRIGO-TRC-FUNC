// Vercel serverless: lee el texto de una cotización TRC (o de fianza, con kind:'fianza') y devuelve los datos estructurados con IA.
// POST /api/extract   body: { text, insurer, hints, requested, kind }
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
- coverage: para CADA endoso de la lista "Endosos solicitados" indica su estado en la cotización, usando la misma clave que viene en la lista:
    "accepted" = lo incluye (aunque lo llame con otro nombre o sin número, ej: "Huelga, motín y conmoción civil" = End. 001; "Riesgo del diseñador" o "LEG 2" = End. 115),
    "rejected" = lo excluye o dice que no lo otorga,
    "modified" = lo incluye con condiciones distintas o un límite menor al solicitado,
    "unknown" = la cotización no lo menciona.
- sublimits: monto del sub-límite que la aseguradora da a cada endoso solicitado, si lo indica (clave = número del endoso, ej "006": 5000000).
- currency: "DOP" o "USD".`;

function buildUser(text, insurer, hints, requested){
  let u = `Aseguradora: ${insurer || 'no indicada'}\n`;
  if(hints && hints.labels && typeof hints.labels === 'object'){
    const lines = Object.entries(hints.labels)
      .filter(([, v]) => Array.isArray(v) && v.length)
      .map(([k, v]) => `- ${k}: ${v.join(' | ')}`);
    if(lines.length) u += `Esta aseguradora suele llamar así a estos campos en sus cotizaciones (aprendido de cotizaciones revisadas):\n${lines.join('\n')}\n`;
  }
  const req = Array.isArray(requested) ? requested.filter(r => r && r.code).slice(0, 40) : [];
  if(req.length) u += `\nEndosos solicitados en el Slip (devuelve el estado de cada uno en "coverage"):\n${req.map(r => `- ${r.code}: ${r.title || ''}`).join('\n')}\n`;
  u += `\nDevuelve este JSON:\n{"premiumNet":number|null,"isc":number|null,"premiumTotal":number|null,"sumSeccionI":number|null,"sumSeccionII":number|null,"deductibles":{"catastrophic":string|null,"other":string|null,"liability":string|null},"clausesAccepted":string[],"coverage":{"End. 001":"accepted"|"rejected"|"modified"|"unknown"},"sublimits":{"006":number},"currency":"DOP"|"USD"|null}\n\nTexto de la cotización:\n"""\n${text}\n"""`;
  return u;
}

const SYSTEM_FIANZA = `Eres un analista de seguros en República Dominicana. Lees cotizaciones de FIANZAS (seriedad de oferta, fiel cumplimiento, anticipo, vicios ocultos, judiciales, aduanales, etc.) que envían las aseguradoras a un corredor, y devuelves sus datos en JSON.
Reglas:
- Responde SOLO con un objeto JSON válido, sin texto antes ni después.
- Montos como números (sin símbolos, sin comas). Si un dato no aparece, usa null. No inventes.
- premiumNet = prima neta (antes de impuestos). isc = impuesto selectivo al consumo (ISC, normalmente 16%). premiumTotal = prima total a pagar (neta + ISC).
- bondAmount = monto afianzado. rate = tasa en porcentaje (ej. 1.25 si dice 1.25% anual).
- minPremium = prima mínima, si la indica.
- counterGuarantee = contragarantía o garantías que exige la aseguradora (pagaré, hipoteca, depósito, firma solidaria de socios…), texto corto.
- issueDays = días hábiles para emitir, si lo indica (número).
- conditions = otras condiciones o requisitos importantes, texto corto (máx. 250 caracteres).
- validity = vigencia de la fianza o de la cotización, texto corto.
- currency: "DOP" o "USD".`;

function buildUserFianza(text, insurer){
  return `Aseguradora: ${insurer || 'no indicada'}\n\nDevuelve este JSON:\n{"premiumNet":number|null,"isc":number|null,"premiumTotal":number|null,"bondAmount":number|null,"rate":number|null,"minPremium":number|null,"counterGuarantee":string|null,"issueDays":number|null,"conditions":string|null,"validity":string|null,"currency":"DOP"|"USD"|null}\n\nTexto de la cotización:\n"""\n${text}\n"""`;
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

  const isFianza = body && body.kind === 'fianza';
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
        max_tokens: 3000,
        system: isFianza ? SYSTEM_FIANZA : SYSTEM,
        messages: [{ role: 'user', content: isFianza ? buildUserFianza(text, body.insurer) : buildUser(text, body.insurer, body.hints, body.requested) }]
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
