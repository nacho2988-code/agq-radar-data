#!/usr/bin/env node
// backfill-licitadoras.mjs
// Recorre el feed de PLACSP buscando contratos RES/ADJ del histórico,
// extrae importeAdjudicacion, n_ofertas, importe_min/max y parsea
// el acta de adjudicación con Gemini para obtener todas las empresas y precios.
//
// Procesa N entradas por ejecución (límite para no agotar cuota de Gemini).
// Ejecutar varias veces hasta cubrir todo el histórico.

import fs from 'node:fs';

const HISTORICO_PATH = 'data/historico_adjudicaciones.json';
const FEED_URL       = 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
const GEMINI_KEY     = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = 'gemini-2.5-flash';
const MAX_PAGES_FEED = 100; // páginas del feed a recorrer (cada una tiene ~500 entradas)
const MAX_GEMINI     = parseInt(process.env.MAX_GEMINI || '10'); // actas a parsear por ejecución

// ── Utilidades XML ────────────────────────────────────────────────────────────
function decodeXml(s){ return String(s||'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'"); }
function tag(block, name){ const m=block.match(new RegExp(`<(?:[^:>]*:)?${name}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${name}>`,'i')); return m?decodeXml(m[1].replace(/<[^>]+>/g,'').trim()):''; }
function allBlocks(xml, name){ const re=new RegExp(`<(?:[^:>]*:)?${name}[^>]*>[\\s\\S]*?<\\/(?:[^:>]*:)?${name}>`,'gi'); return xml.match(re)||[]; }
function nextLink(xml){ const m=xml.match(/<link[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i)||xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']next["']/i); return m?m[1]:null; }

// ── Parsear un bloque de entrada para extraer datos de adjudicación ───────────
function parseTenderResult(block){
  const resultados = { importeAdjudicacion:null, adjudicatario:'', fechaAdjudicacion:'',
                       n_ofertas:null, importe_min:null, importe_max:null, docUrls:[] };
  const trBlocks = allBlocks(block,'TenderResult');
  if(trBlocks.length){
    const tr = trBlocks[0];
    const amt = tag(tr,'PayableAmount')||tag(tr,'TaxExclusiveAmount')||tag(tr,'AwardedTenderedAmount')||tag(tr,'TotalAmount');
    if(amt){ const n=parseFloat(amt.replace(',','.')); if(!isNaN(n)) resultados.importeAdjudicacion=n; }
    const wp = allBlocks(tr,'WinningParty')[0]||allBlocks(tr,'AwardedTenderer')[0];
    if(wp) resultados.adjudicatario = tag(wp,'Name')||tag(wp,'PartyName')||'';
    resultados.fechaAdjudicacion = tag(tr,'AwardDate')||tag(tr,'IssueDate')||'';
    const nOfertas = tag(tr,'ReceivedTenderQuantity')||tag(tr,'SubmittedTenderQuantity');
    if(nOfertas){ const n=parseInt(nOfertas); if(!isNaN(n)) resultados.n_ofertas=n; }
    const low  = tag(tr,'LowerTenderAmount')||tag(tr,'MinimumAmount');
    const high = tag(tr,'HigherTenderAmount')||tag(tr,'MaximumAmount');
    if(low){ const n=parseFloat(low.replace(',','.')); if(!isNaN(n)) resultados.importe_min=n; }
    if(high){ const n=parseFloat(high.replace(',','.')); if(!isNaN(n)) resultados.importe_max=n; }
  }
  // URLs de documentos (actas)
  const allUris = block.match(/<cbc:URI>([^<]+)<\/cbc:URI>/gi)||[];
  allUris.forEach(m=>{ const u=(m.match(/<cbc:URI>([^<]+)/i)||[])[1]; if(u){ const clean=decodeXml(u.trim()); resultados.docUrls.push(clean); }});
  return resultados;
}

// ── Descargar PDF ─────────────────────────────────────────────────────────────
async function fetchPdf(url){ const r=await fetch(url,{headers:{'User-Agent':'AGQ-Radar/1.0'}}); if(!r.ok) throw new Error('HTTP '+r.status); return Buffer.from(await r.arrayBuffer()); }

// ── Gemini: extraer licitadoras del acta ──────────────────────────────────────
async function geminiLicitadoras(pdfBufs){
  if(!GEMINI_KEY||!pdfBufs.length) return null;
  const parts = pdfBufs.map(b=>({inline_data:{mime_type:'application/pdf',data:b.toString('base64')}}));
  parts.push({text:`Eres experto en licitaciones públicas españolas. Analiza este documento (acta de adjudicación, resolución, propuesta de adjudicación o clasificación de ofertas).
Extrae SOLO en JSON sin texto ni backticks:
{"licitadoras":[{"empresa":"Nombre completo","importe":12345.67,"puntuacion_total":85.5,"puntuacion_economica":40.0,"puntuacion_tecnica":45.5,"posicion":1}],"adjudicataria":"...","importe_adjudicacion":12345.67,"n_ofertas":3}
REGLAS: incluye TODAS las empresas; importe=precio ofertado sin IVA; posicion=1 para la ganadora; usa null si falta dato; ordena de mejor a peor.
Si el documento no contiene datos de licitadoras, devuelve: {"licitadoras":[],"error":"sin datos"}`});
  const resp=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts}]})});
  if(!resp.ok){console.warn(`Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0,200)}`);return null;}
  const data=await resp.json();
  const text=data.candidates?.[0]?.content?.parts?.[0]?.text||'';
  try{return JSON.parse(text.replace(/```json|```/g,'').trim());}catch(e){return null;}
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function run(){
  if(!fs.existsSync(HISTORICO_PATH)){console.error('No existe',HISTORICO_PATH);process.exit(1);}
  const historico = JSON.parse(fs.readFileSync(HISTORICO_PATH,'utf-8'));
  const entries = historico.entries||historico;

  // Entradas que necesitan enriquecimiento
  const pendientes = entries.filter(e=>
    !e.importeAdjudicacion || !e.licitadoras
  );
  console.log(`Total histórico: ${entries.length} | Pendientes de enriquecer: ${pendientes.length}`);
  if(!pendientes.length){ console.log('Todo el histórico está enriquecido.'); return; }

  // Construir índice por expediente
  const byExp = new Map();
  pendientes.forEach(e=>{ if(e.expediente) byExp.set(e.expediente.trim().toUpperCase(),e); });

  // Recorrer el feed de PLACSP
  let url = FEED_URL;
  let page = 0, encontrados = 0, geminiUsado = 0;

  while(url && page < MAX_PAGES_FEED){
    page++;
    if(page%10===0) console.log(`Página ${page}... (encontrados: ${encontrados})`);
    let xml;
    try{
      const resp=await fetch(url,{headers:{'User-Agent':'AGQ-Radar/1.0'}});
      if(!resp.ok) break;
      xml=await resp.text();
    }catch(e){ console.warn(`Error pág ${page}: ${e.message}`); break; }

    const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g)||[];
    for(const block of entryBlocks){
      // Extraer expediente del bloque
      const expRaw = (block.match(/<cbc:ContractFolderID>([^<]+)<\/cbc:ContractFolderID>/i)||[])[1]
                  || (block.match(/<id>([^<]+)<\/id>/i)||[])[1]||'';
      const expKey = expRaw.trim().toUpperCase();
      if(!byExp.has(expKey)) continue;

      const entry = byExp.get(expKey);
      const parsed = parseTenderResult(block);
      let changed = false;

      // 1. Actualizar importeAdjudicacion si no lo teníamos
      if(!entry.importeAdjudicacion && parsed.importeAdjudicacion){
        entry.importeAdjudicacion = parsed.importeAdjudicacion;
        changed = true;
      }
      if(!entry.fechaAdjudicacion && parsed.fechaAdjudicacion){
        entry.fechaAdjudicacion = parsed.fechaAdjudicacion;
        changed = true;
      }
      if(!entry.adjudicatario && parsed.adjudicatario){
        entry.adjudicatario = parsed.adjudicatario;
        changed = true;
      }

      // 2. Extraer estadísticas de ofertas (n_ofertas, min, max)
      if(!entry.n_ofertas && parsed.n_ofertas){ entry.n_ofertas=parsed.n_ofertas; changed=true; }
      if(!entry.importe_min && parsed.importe_min){ entry.importe_min=parsed.importe_min; changed=true; }
      if(!entry.importe_max && parsed.importe_max){ entry.importe_max=parsed.importe_max; changed=true; }

      // 3. Descargar acta y extraer licitadoras con Gemini (si no las tenemos aún)
      if(!entry.licitadoras && parsed.docUrls.length && GEMINI_KEY && geminiUsado < MAX_GEMINI){
        console.log(`  [Gemini] ${expRaw}: ${parsed.docUrls.length} doc(s)...`);
        const pdfBufs = [];
        for(const docUrl of parsed.docUrls.slice(0,3)){
          try{ pdfBufs.push(await fetchPdf(docUrl)); }catch(e){ console.warn(`    Error doc: ${e.message}`); }
        }
        if(pdfBufs.length){
          const resultado = await geminiLicitadoras(pdfBufs);
          geminiUsado++;
          if(resultado && resultado.licitadoras && resultado.licitadoras.length && !resultado.error){
            entry.licitadoras = resultado.licitadoras;
            if(resultado.importe_adjudicacion) entry.importeAdjudicacion = resultado.importe_adjudicacion;
            if(resultado.n_ofertas) entry.n_ofertas = resultado.n_ofertas;
            entry.extraidoEn = new Date().toISOString();
            changed = true;
            console.log(`    ✓ ${resultado.licitadoras.length} licitadoras`);
          } else {
            console.log(`    ✗ Sin datos de licitadoras`);
          }
        }
        if(geminiUsado >= MAX_GEMINI){
          console.log(`[Gemini] Límite de ${MAX_GEMINI} llamadas alcanzado. Parar aquí.`);
        }
      }

      if(changed){ encontrados++; byExp.delete(expKey); }
    }

    if(byExp.size === 0){ console.log('Todos los pendientes encontrados en el feed.'); break; }
    url = nextLink(xml);
  }

  // Guardar histórico actualizado
  if(encontrados > 0){
    historico.generatedAt = new Date().toISOString();
    fs.writeFileSync(HISTORICO_PATH, JSON.stringify(historico, null, 2));
    console.log(`\n✅ Guardados ${encontrados} registros enriquecidos.`);
    const aun_sin_adj = (historico.entries||historico).filter(e=>!e.importeAdjudicacion).length;
    const aun_sin_lic = (historico.entries||historico).filter(e=>!e.licitadoras).length;
    console.log(`   Sin importeAdjudicacion: ${aun_sin_adj} | Sin licitadoras: ${aun_sin_lic}`);
  } else {
    console.log('\nNo se encontraron nuevos datos en el feed.');
  }
}

run().catch(e=>{console.error('Error fatal:',e.stack||e);process.exit(1);});
