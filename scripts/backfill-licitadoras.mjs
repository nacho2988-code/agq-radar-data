#!/usr/bin/env node
// backfill-licitadoras.mjs — versión agresiva con rate limiting de Gemini
// Límite Gemini gratuito: 1500 req/día, 10 RPM → delay 6s entre llamadas
// Procesa el máximo posible en el tiempo de ejecución disponible.

import fs from 'node:fs';

const HISTORICO_PATH = 'data/historico_adjudicaciones.json';
const FEED_URL       = 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
const GEMINI_KEY     = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = 'gemini-2.5-flash';
const GEMINI_RPM     = 10;                            // límite del plan gratuito
const GEMINI_DELAY   = Math.ceil(60000 / GEMINI_RPM); // 6000 ms entre llamadas
const MAX_PAGES      = 150;                           // ~75.000 entradas = toda la historia disponible
const SAVE_EVERY     = 50;                            // guardar progreso cada N registros

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Utilidades XML ────────────────────────────────────────────────────────────
function decodeXml(s){ return String(s||'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'"); }
function tag(block, name){ const m=block.match(new RegExp(`<(?:[^:>]*:)?${name}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${name}>`,'i')); return m?decodeXml(m[1].replace(/<[^>]+>/g,'').trim()):''; }
function allBlocks(xml, name){ const re=new RegExp(`<(?:[^:>]*:)?${name}[^>]*>[\\s\\S]*?<\\/(?:[^:>]*:)?${name}>`,'gi'); return xml.match(re)||[]; }
function nextLink(xml){ const m=xml.match(/<link[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i)||xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']next["']/i); return m?m[1]:null; }

// ── Parsear TenderResult del XML ──────────────────────────────────────────────
function parseTenderResult(block){
  const r = { importeAdjudicacion:null, adjudicatario:'', fechaAdjudicacion:'',
               n_ofertas:null, importe_min:null, importe_max:null, docUrls:[] };
  const trBlocks = allBlocks(block,'TenderResult');
  if(trBlocks.length){
    const tr = trBlocks[0];
    const amt = tag(tr,'PayableAmount')||tag(tr,'TaxExclusiveAmount')||tag(tr,'AwardedTenderedAmount')||tag(tr,'TotalAmount');
    if(amt){ const n=parseFloat(amt.replace(',','.')); if(!isNaN(n)) r.importeAdjudicacion=n; }
    const wp = allBlocks(tr,'WinningParty')[0]||allBlocks(tr,'AwardedTenderer')[0];
    if(wp) r.adjudicatario = tag(wp,'Name')||tag(wp,'PartyName')||'';
    if(!r.adjudicatario) r.adjudicatario = tag(tr,'WinningTendererName')||'';
    r.fechaAdjudicacion = tag(tr,'AwardDate')||tag(tr,'IssueDate')||'';
    const no = tag(tr,'ReceivedTenderQuantity')||tag(tr,'SubmittedTenderQuantity');
    if(no){ const n=parseInt(no); if(!isNaN(n)) r.n_ofertas=n; }
    const low  = tag(tr,'LowerTenderAmount');
    const high = tag(tr,'HigherTenderAmount');
    if(low){ const n=parseFloat(low.replace(',','.')); if(!isNaN(n)) r.importe_min=n; }
    if(high){ const n=parseFloat(high.replace(',','.')); if(!isNaN(n)) r.importe_max=n; }
  }
  const uris = block.match(/<cbc:URI>([^<]+)<\/cbc:URI>/gi)||[];
  uris.forEach(m=>{ const u=(m.match(/<cbc:URI>([^<]+)/i)||[])[1]; if(u) r.docUrls.push(decodeXml(u.trim())); });
  return r;
}

// ── Descargar PDF ─────────────────────────────────────────────────────────────
async function fetchPdf(url){
  const r = await fetch(url,{headers:{'User-Agent':'AGQ-Radar/1.0'},signal:AbortSignal.timeout(30000)});
  if(!r.ok) throw new Error('HTTP '+r.status);
  return Buffer.from(await r.arrayBuffer());
}

// ── Gemini: extraer licitadoras ───────────────────────────────────────────────
let lastGeminiCall = 0;
async function geminiLicitadoras(pdfBufs){
  if(!GEMINI_KEY||!pdfBufs.length) return null;
  // Rate limiting: esperar el tiempo necesario para no superar 10 RPM
  const ahora = Date.now();
  const espera = GEMINI_DELAY - (ahora - lastGeminiCall);
  if(espera > 0){ await sleep(espera); }
  lastGeminiCall = Date.now();

  const parts = pdfBufs.slice(0,2).map(b=>({inline_data:{mime_type:'application/pdf',data:b.toString('base64')}}));
  parts.push({text:`Analiza este acta de adjudicación o resolución de licitación pública española.
Extrae SOLO en JSON sin texto ni backticks:
{"licitadoras":[{"empresa":"Nombre completo","importe":12345.67,"puntuacion_total":85.5,"posicion":1}],"adjudicataria":"...","importe_adjudicacion":12345.67,"n_ofertas":3}
REGLAS: incluye TODAS las empresas; importe=precio ofertado sin IVA; posicion=1 ganadora; null si falta dato.
Si no hay datos de licitadoras: {"licitadoras":[],"error":"sin datos"}`});

  try{
    const resp=await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
      {method:'POST',headers:{'Content-Type':'application/json'},
       body:JSON.stringify({contents:[{parts}]}),signal:AbortSignal.timeout(60000)});
    if(!resp.ok){
      const txt=await resp.text();
      if(resp.status===429){ console.warn('  [429] Cuota Gemini agotada — deteniendo'); return 'QUOTA_EXCEEDED'; }
      console.warn(`  Gemini HTTP ${resp.status}: ${txt.slice(0,100)}`);
      return null;
    }
    const data=await resp.json();
    const text=data.candidates?.[0]?.content?.parts?.[0]?.text||'';
    return JSON.parse(text.replace(/```json|```/g,'').trim());
  }catch(e){
    console.warn(`  Gemini error: ${e.message}`);
    return null;
  }
}

// ── Guardar histórico ─────────────────────────────────────────────────────────
function saveHistorico(historico){
  historico.generatedAt = new Date().toISOString();
  fs.writeFileSync(HISTORICO_PATH, JSON.stringify(historico, null, 2));
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function run(){
  const historico = JSON.parse(fs.readFileSync(HISTORICO_PATH,'utf-8'));
  const entries = historico.entries||historico;

  const pendientes = entries.filter(e => !e.importeAdjudicacion || !e.licitadoras);
  console.log(`Total: ${entries.length} | Pendientes: ${pendientes.length}`);
  if(!pendientes.length){ console.log('Histórico completamente enriquecido.'); return; }

  const byExp = new Map();
  pendientes.forEach(e=>{ if(e.expediente) byExp.set(e.expediente.trim().toUpperCase(),e); });

  let url = FEED_URL, page=0, encontrados=0, geminiCalls=0, quotaExceeded=false;
  let lastSave = 0;

  while(url && page < MAX_PAGES && !quotaExceeded){
    page++;
    if(page%20===0) console.log(`Pág ${page} | encontrados: ${encontrados} | Gemini: ${geminiCalls} | pendientes: ${byExp.size}`);

    let xml;
    try{
      const resp = await fetch(url,{headers:{'User-Agent':'AGQ-Radar/1.0'},signal:AbortSignal.timeout(30000)});
      if(!resp.ok){ console.warn(`HTTP ${resp.status} en pág ${page}`); break; }
      xml = await resp.text();
    }catch(e){ console.warn(`Error pág ${page}: ${e.message}`); await sleep(5000); url=null; break; }

    const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g)||[];
    for(const block of entryBlocks){
      if(byExp.size === 0) break;
      const expRaw = (block.match(/<cbc:ContractFolderID>([^<]+)<\/cbc:ContractFolderID>/i)||[])[1]
                  || (block.match(/<id>([^<]+)<\/id>/i)||[])[1]||'';
      const expKey = expRaw.trim().toUpperCase();
      if(!byExp.has(expKey)) continue;

      const entry = byExp.get(expKey);
      const parsed = parseTenderResult(block);
      let changed = false;

      // 1. Enriquecer con datos del TenderResult (sin Gemini)
      if(!entry.importeAdjudicacion && parsed.importeAdjudicacion){ entry.importeAdjudicacion=parsed.importeAdjudicacion; changed=true; }
      if(!entry.fechaAdjudicacion && parsed.fechaAdjudicacion){ entry.fechaAdjudicacion=parsed.fechaAdjudicacion; changed=true; }
      if(!entry.adjudicatario && parsed.adjudicatario){ entry.adjudicatario=parsed.adjudicatario.trim(); changed=true; }
      if(!entry.n_ofertas && parsed.n_ofertas){ entry.n_ofertas=parsed.n_ofertas; changed=true; }
      if(!entry.importe_min && parsed.importe_min){ entry.importe_min=parsed.importe_min; changed=true; }
      if(!entry.importe_max && parsed.importe_max){ entry.importe_max=parsed.importe_max; changed=true; }

      // 2. Parsear acta con Gemini para obtener todas las empresas
      if(!entry.licitadoras && parsed.docUrls.length && GEMINI_KEY){
        const pdfBufs = [];
        for(const docUrl of parsed.docUrls.slice(0,3)){
          try{ pdfBufs.push(await fetchPdf(docUrl)); break; }// 1 PDF suele ser suficiente
          catch(e){ /* ignorar */ }
        }
        if(pdfBufs.length){
          const resultado = await geminiLicitadoras(pdfBufs);
          geminiCalls++;
          if(resultado === 'QUOTA_EXCEEDED'){ quotaExceeded=true; break; }
          if(resultado && resultado.licitadoras && resultado.licitadoras.length && !resultado.error){
            entry.licitadoras = resultado.licitadoras;
            if(resultado.importe_adjudicacion && !entry.importeAdjudicacion) entry.importeAdjudicacion=resultado.importe_adjudicacion;
            if(resultado.n_ofertas && !entry.n_ofertas) entry.n_ofertas=resultado.n_ofertas;
            entry.extraidoEn = new Date().toISOString();
            changed=true;
            process.stdout.write(`  ✓ ${expRaw}: ${resultado.licitadoras.length} empresas\n`);
          }
        }
      }

      if(changed){
        encontrados++;
        byExp.delete(expKey);
        // Guardar progreso cada N registros para no perderlo si el workflow se interrumpe
        if(encontrados - lastSave >= SAVE_EVERY){
          saveHistorico(historico);
          lastSave = encontrados;
          console.log(`  [Guardado parcial: ${encontrados} registros]`);
        }
      }
    }

    if(byExp.size === 0){ console.log('Todos los pendientes encontrados.'); break; }
    url = nextLink(xml);
  }

  // Guardar resultado final
  saveHistorico(historico);

  const sinAdj = entries.filter(e=>!e.importeAdjudicacion).length;
  const sinLic = entries.filter(e=>!e.licitadoras).length;
  console.log(`\n✅ Completado: ${encontrados} enriquecidos | Gemini: ${geminiCalls} llamadas`);
  console.log(`   Restantes sin importeAdjudicacion: ${sinAdj}`);
  console.log(`   Restantes sin licitadoras: ${sinLic}`);
  if(quotaExceeded) console.log('   ⚠ Cuota Gemini agotada — ejecutar de nuevo mañana');
}

run().catch(e=>{console.error('Error fatal:',e.stack||e);process.exit(1);});
