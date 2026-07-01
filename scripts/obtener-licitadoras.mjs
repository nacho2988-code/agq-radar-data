#!/usr/bin/env node
// obtener-licitadoras.mjs
// Busca un expediente adjudicado en PLACSP, descarga el acta de adjudicación,
// y usa Gemini para extraer la lista completa de empresas licitadoras con sus importes.
// Actualiza data/historico_adjudicaciones.json con los resultados.
//
// Uso: node scripts/obtener-licitadoras.mjs "<expediente>"

import fs from 'node:fs';

const FEED_URL      = 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
const HISTORICO     = 'data/historico_adjudicaciones.json';
const GEMINI_KEY    = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL  = 'gemini-2.5-flash';
const MAX_PAGES     = 80; // buscar hasta 80 páginas para cubrir contratos más antiguos

const QUERY = process.argv[2];
if(!QUERY){
  console.error('Uso: node scripts/obtener-licitadoras.mjs "<expediente o texto>"');
  process.exit(1);
}

// ── Utilidades XML ────────────────────────────────────────────────────────────
function decodeXml(s){
  return String(s||'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
                      .replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#39;/g,"'");
}
function tag(block, name){
  const m = block.match(new RegExp(`<(?:[^:>]*:)?${name}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${name}>`,'i'));
  return m ? decodeXml(m[1].replace(/<[^>]+>/g,'').trim()) : '';
}
function allTagValues(block, name){
  const re = new RegExp(`<(?:[^:>]*:)?${name}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${name}>`,'gi');
  const out=[]; let m;
  while((m=re.exec(block))!==null) out.push(decodeXml(m[1].replace(/<[^>]+>/g,'').trim()));
  return out;
}
function nextLink(xml){
  const m = xml.match(/<link[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i)
         || xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']next["']/i);
  return m ? m[1] : null;
}

// ── Extraer todos los documentos adjuntos de un bloque XML ───────────────────
function extractDocuments(block){
  const docs = [];
  const sections = [
    ...block.match(/<cac:LegalDocumentReference[^>]*>[\s\S]*?<\/cac:LegalDocumentReference>/gi) || [],
    ...block.match(/<cac:TechnicalDocumentReference[^>]*>[\s\S]*?<\/cac:TechnicalDocumentReference>/gi) || [],
    ...block.match(/<cac:AdditionalDocumentReference[^>]*>[\s\S]*?<\/cac:AdditionalDocumentReference>/gi) || [],
    ...block.match(/<cac:ResultOfTenderDocumentReference[^>]*>[\s\S]*?<\/cac:ResultOfTenderDocumentReference>/gi) || [],
  ];
  for(const sec of sections){
    const urlM = sec.match(/<cbc:URI>([^<]+)<\/cbc:URI>/i);
    if(!urlM) continue;
    const url = decodeXml(urlM[1].trim());
    const id = tag(sec, 'ID') || '';
    // Detectar si es un acta / resolución de adjudicación
    const isActa = /acta|resoluci[oó]n|adjudicaci[oó]n|award|result/i.test(id)
                || /acta|resoluci[oó]n|adjudicaci[oó]n/i.test(url);
    docs.push({ id, url, isActa });
  }
  return docs;
}

// ── Buscar el expediente en el feed ─────────────────────────────────────────
async function buscarEnFeed(query){
  let url = FEED_URL;
  let page = 0;
  const qLower = query.toLowerCase();
  const resultados = [];

  while(url && page < MAX_PAGES){
    page++;
    if(page % 10 === 0) console.log(`Página ${page}...`);
    const resp = await fetch(url, { headers:{ 'User-Agent':'AGQ-Radar/1.0' } });
    if(!resp.ok){ console.warn(`HTTP ${resp.status}`); break; }
    const xml = await resp.text();

    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    for(const block of entries){
      const exp = tag(block,'ContractFolderID') || tag(block,'id');
      const title = '';
      // Buscar por expediente exacto o contenido en el bloque
      if(block.toLowerCase().includes(qLower) || (exp && exp.toLowerCase() === qLower)){
        const estado = tag(block,'ContractFolderStatusCode');
        const docs = extractDocuments(block);
        const tenderResult = block.match(/<cac:TenderResult[^>]*>([\s\S]*?)<\/cac:TenderResult>/gi) || [];
        console.log(`  → Encontrado: ${exp} | Estado: ${estado} | Docs: ${docs.length} | TenderResults: ${tenderResult.length}`);
        resultados.push({ expediente:exp, estado, docs, block });
      }
    }

    url = nextLink(xml);
  }
  return resultados;
}

// ── Descargar PDF ────────────────────────────────────────────────────────────
async function fetchPdf(url){
  const resp = await fetch(url, { headers:{ 'User-Agent':'AGQ-Radar/1.0' } });
  if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

// ── Llamar a Gemini para extraer licitadoras ─────────────────────────────────
async function extraerLicitadoras(pdfBufs, docLabels){
  if(!GEMINI_KEY){ console.warn('Sin GEMINI_API_KEY'); return null; }

  const parts = pdfBufs.map((buf,i) => ({
    inline_data: { mime_type:'application/pdf', data: buf.toString('base64') }
  }));

  parts.push({ text: `Eres un experto en licitaciones públicas españolas. Analiza este documento (puede ser un acta de adjudicación, resolución de adjudicación, propuesta de adjudicación, o clasificación de ofertas de una licitación pública).

Extrae ÚNICAMENTE la información en este formato JSON exacto (sin texto adicional, sin backticks, sin markdown):
{
  "licitadoras": [
    {
      "empresa": "Nombre completo de la empresa",
      "importe": 12345.67,
      "puntuacion_total": 85.5,
      "puntuacion_economica": 40.0,
      "puntuacion_tecnica": 45.5,
      "posicion": 1
    }
  ],
  "adjudicataria": "Nombre de la empresa ganadora",
  "importe_adjudicacion": 12345.67,
  "n_ofertas": 3,
  "criterio_principal": "descripción del criterio principal de valoración"
}

REGLAS:
- Incluye TODAS las empresas que presentaron oferta, no solo la ganadora
- "importe" = precio ofertado SIN IVA (si solo hay con IVA, divide entre 1.21)
- "posicion" = 1 para la mejor oferta, 2 para la segunda, etc.
- Si no hay información de puntuación, usa null
- Si no encuentras el dato, usa null
- El array "licitadoras" debe estar ordenado de mejor a peor (posicion 1 primero)
- Si el documento no contiene información de licitadoras, devuelve {"licitadoras": [], "error": "documento sin datos de ofertas"}` });

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ contents:[{ parts }] }) }
  );
  if(!resp.ok){
    const txt = await resp.text();
    console.warn(`Gemini HTTP ${resp.status}: ${txt.slice(0,200)}`);
    return null;
  }
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = text.replace(/```json|```/g,'').trim();
  try{ return JSON.parse(clean); }
  catch(e){ console.warn('JSON no parseable:', clean.slice(0,300)); return null; }
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function run(){
  console.log(`Buscando licitadoras para: "${QUERY}"`);
  console.log(`Explorando hasta ${MAX_PAGES} páginas del feed PLACSP...\n`);

  const resultados = await buscarEnFeed(QUERY);

  if(!resultados.length){
    console.log('❌ No se encontró el expediente en el feed actual.');
    console.log('Nota: los contratos adjudicados hace más de ~30 días suelen haberse purgado del feed.');
    process.exit(0);
  }

  // Buscar primero en entradas con estado RES/ADJ (ya adjudicadas)
  const adjudicadas = resultados.filter(r => ['RES','ADJ'].includes(r.estado));
  const aUsar = adjudicadas.length ? adjudicadas : resultados;
  const entrada = aUsar[0];

  console.log(`\nAnalizando ${aUsar.length} resultado(s) para expediente "${entrada.expediente}"`);
  console.log(`Documentos disponibles: ${entrada.docs.length}`);
  entrada.docs.forEach((d,i) => console.log(`  ${i+1}. ${d.id || 'sin nombre'} | acta:${d.isActa} | ${d.url.slice(0,60)}...`));

  // Intentar descargar primero los documentos que parecen actas
  const actasDocs = entrada.docs.filter(d => d.isActa);
  const todosDocs = actasDocs.length ? actasDocs : entrada.docs; // si no hay acta identificada, probar todos

  const pdfBufs = [];
  const docsDescargados = [];
  for(const doc of todosDocs.slice(0,4)){
    try{
      console.log(`Descargando: ${doc.id || doc.url.slice(-30)}...`);
      const buf = await fetchPdf(doc.url);
      console.log(`  ✓ ${buf.length} bytes`);
      pdfBufs.push(buf);
      docsDescargados.push(doc.id || 'documento');
    }catch(e){
      console.warn(`  ✗ ${e.message}`);
    }
  }

  if(!pdfBufs.length){
    console.log('❌ No se pudieron descargar documentos del expediente.');
    process.exit(0);
  }

  console.log(`\nAnalizando ${pdfBufs.length} documento(s) con Gemini...`);
  const resultado = await extraerLicitadoras(pdfBufs, docsDescargados);

  if(!resultado){
    console.log('❌ Gemini no devolvió resultado.');
    process.exit(0);
  }

  if(resultado.error){
    console.log(`⚠ Gemini: ${resultado.error}`);
    process.exit(0);
  }

  console.log(`\n✅ Licitadoras extraídas: ${resultado.licitadoras?.length || 0}`);
  (resultado.licitadoras||[]).forEach((l,i) => {
    console.log(`  ${i+1}. ${l.empresa} | ${l.importe ? l.importe.toLocaleString('es-ES')+'€' : '—'} | Puntos: ${l.puntuacion_total || '—'}`);
  });

  // Guardar en historico_adjudicaciones.json
  if(!fs.existsSync(HISTORICO)){
    console.log('⚠ No existe historico_adjudicaciones.json — no se puede guardar');
    process.exit(0);
  }

  const historico = JSON.parse(fs.readFileSync(HISTORICO,'utf-8'));
  const idx = historico.entries.findIndex(e =>
    e.expediente && e.expediente.toLowerCase() === (entrada.expediente||'').toLowerCase()
  );

  const datosLicitadoras = {
    licitadoras: resultado.licitadoras || [],
    n_ofertas: resultado.n_ofertas || resultado.licitadoras?.length || null,
    adjudicataria: resultado.adjudicataria || null,
    importe_adjudicacion: resultado.importe_adjudicacion || null,
    criterio_principal: resultado.criterio_principal || null,
    fuente_docs: docsDescargados,
    extraidoEn: new Date().toISOString()
  };

  if(idx >= 0){
    historico.entries[idx] = { ...historico.entries[idx], ...datosLicitadoras };
    console.log(`✅ Actualizado en histórico: posición ${idx}`);
  } else {
    // Si no está en el histórico, añadirlo como nueva entrada
    historico.entries.push({
      expediente: entrada.expediente,
      estado: entrada.estado,
      ...datosLicitadoras,
      fuente: 'busqueda_licitadoras'
    });
    console.log(`✅ Añadida nueva entrada al histórico`);
  }

  historico.generatedAt = new Date().toISOString();
  fs.writeFileSync(HISTORICO, JSON.stringify(historico, null, 2));
  console.log(`\nGuardado en ${HISTORICO}`);
}

run().catch(e => { console.error('Error fatal:', e.stack||e); process.exit(1); });
