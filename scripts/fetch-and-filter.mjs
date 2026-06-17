// scripts/fetch-and-filter.mjs
// Barrido diario del feed oficial de licitaciones (PLACSP) filtrado por el
// perfil sectorial de AGQ Labs. Sin dependencias externas: usa fetch nativo
// de Node 18+ y parseo por expresiones regulares (mismo criterio que el
// parser del navegador: ignora el prefijo de namespace y empareja por
// nombre local de la etiqueta, para ser tolerante a variaciones de CODICE).

import fs from 'node:fs';

const FEED_URL = 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
const MAX_PAGES = 3;            // nº de páginas del feed a seguir cada día (500 entradas/página)
const STALE_DAYS = 90;          // se purgan del histórico las entradas más antiguas que esto
const CONFIG_PATH = 'config/accreditations.json';
const OUTPUT_PATH = 'data/licitaciones.json';

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const cpvCodes = config.cpv.map(line => (line.match(/^\d{8}/) || [])[0]).filter(Boolean);
const allKeywords = [...new Set(
  config.accreditations.flatMap(a => a.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean))
)];

const ESTADO_LABELS = {
  PUB:'Publicada / en plazo', EV:'En evaluación', ADJ:'Adjudicada (sin formalizar)',
  RES:'Resuelta / Formalizada', DES:'Desierta', ANUL:'Anulada', ARCH:'Archivada',
  PRE:'Anuncio previo', RET:'Retirada'
};

function decodeXmlEntities(s){
  if(!s) return s;
  return s
    .replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"')
    .replace(/&apos;/g,"'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n,16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n,10)))
    .replace(/&amp;/g,'&');
}

function tag(block, name){
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}>`, 'i');
  const m = block.match(re);
  return m ? decodeXmlEntities(m[1].trim()) : '';
}
function attr(block, tagName, attrName){
  const re = new RegExp(`<(?:[\\w-]+:)?${tagName}\\b[^>]*${attrName}=["']([^"']*)["']`, 'i');
  const m = block.match(re);
  return m ? decodeXmlEntities(m[1]) : '';
}
function allTagValues(block, name){
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}>`, 'gi');
  const out = []; let m;
  while((m = re.exec(block))) out.push(decodeXmlEntities(m[1].trim()));
  return out;
}
function allBlocks(block, name){
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b[\\s\\S]*?<\\/(?:[\\w-]+:)?${name}>`, 'gi');
  const out = []; let m;
  while((m = re.exec(block))) out.push(m[0]);
  return out;
}

function parseSummary(text){
  const out = {};
  text.split(';').forEach(part=>{
    const idx = part.indexOf(':');
    if(idx<0) return;
    const k = part.slice(0,idx).trim().toLowerCase();
    const v = part.slice(idx+1).trim();
    if(k.includes('id licit')) out.expediente = v;
    else if(k.includes('rgano')) out.organo = v;
    else if(k.includes('importe')) out.importe = v;
    else if(k.includes('estado')) out.estado = v;
  });
  return out;
}

function parseEntryBlock(block){
  const title = tag(block,'title') || '(sin título)';
  const idText = tag(block,'id');
  const updated = tag(block,'updated');
  const link = attr(block,'link','href');
  const summaryRaw = tag(block,'summary');
  const sp = parseSummary(summaryRaw);

  const cpv = [...new Set(
    allTagValues(block,'ItemClassificationCode').map(v=>v.split('-')[0]).filter(v=>/^\d{8}$/.test(v))
  )];

  let deadline = null, deadlineSource = 'desconocido';
  const tsdp = allBlocks(block,'TenderSubmissionDeadlinePeriod')[0];
  if(tsdp){ const ed = tag(tsdp,'EndDate'); if(ed){ deadline = ed; deadlineSource = 'periodo de presentación'; } }
  if(!deadline){
    const prrp = allBlocks(block,'ParticipationRequestReceptionPeriod')[0];
    if(prrp){ const ed = tag(prrp,'EndDate'); if(ed){ deadline = ed; deadlineSource = 'periodo de recepción de solicitudes'; } }
  }
  if(!deadline){
    const allEnd = allTagValues(block,'EndDate').filter(Boolean).sort();
    if(allEnd.length){ deadline = allEnd[allEnd.length-1]; deadlineSource = 'estimado (campo EndDate genérico)'; }
  }

  const documentos = [];
  ['LegalDocumentReference','TechnicalDocumentReference','AdditionalDocumentReference','DocumentReference'].forEach(t=>{
    allBlocks(block,t).forEach(docBlock=>{
      const uri = tag(docBlock,'URI');
      if(uri) documentos.push({ tipo:t, url:uri });
    });
  });

  let adjudicatario = '', importeAdjudicacion = null, fechaAdjudicacion = '';
  const tr = allBlocks(block,'TenderResult')[0];
  if(tr){
    const wp = allBlocks(tr,'WinningParty')[0];
    if(wp) adjudicatario = tag(wp,'Name') || tag(wp,'PartyName');
    const amt = tag(tr,'PayableAmount') || tag(tr,'TaxExclusiveAmount') || tag(tr,'TotalAmount');
    if(amt){ const n = parseFloat(amt.replace(',','.')); importeAdjudicacion = isNaN(n) ? null : n; }
    fechaAdjudicacion = tag(tr,'AwardDate');
  }

  const expediente = sp.expediente || idText || ('SIN-ID-' + Math.random().toString(36).slice(2,8));
  const estado = (sp.estado || '').toUpperCase();
  const importeMatch = (sp.importe || '').match(/[\d.,]+/);
  const importe = importeMatch ? (parseFloat(importeMatch[0]) || null) : null;

  return {
    expediente, atomId: idText, title, organo: sp.organo || '',
    estado, estadoLabel: ESTADO_LABELS[estado] || estado || 'Desconocido',
    importe, importeRaw: sp.importe || '',
    cpv, deadline, deadlineSource, documentos, link, updated,
    adjudicatario, importeAdjudicacion, fechaAdjudicacion,
    rawSummary: summaryRaw,
    importedAt: new Date().toISOString()
  };
}

function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Coincidencia con límites de palabra (no substring suelto): evita falsos positivos
// como 'ica' dentro de 'técnica' o 'ler' dentro de 'taller'/'alquiler'. Las letras
// acentuadas cuentan como parte de la palabra para que los límites no se rompan
// en medio de términos como 'inspección'.
function keywordMatches(text, keyword){
  const re = new RegExp('(^|[^a-zA-Z\u00C0-\u00FF])' + escapeRegex(keyword) + '($|[^a-zA-Z\u00C0-\u00FF])', 'i');
  return re.test(text);
}

function isSectorRelevant(entry){
  if(entry.cpv.some(c => cpvCodes.includes(c))) return true;
  const text = (entry.title + ' ' + entry.rawSummary).toLowerCase();
  return allKeywords.some(k => k && keywordMatches(text, k));
}

function nextLink(xml){
  const m = xml.match(/<link[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i)
         || xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']next["']/i);
  return m ? m[1] : null;
}

async function fetchPage(url){
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'AGQ-Radar-Licitaciones/1.0 (uso interno; consumo del dataset de datos abiertos PLACSP)' }
  });
  if(!resp.ok) throw new Error('HTTP ' + resp.status + ' al pedir ' + url);
  return await resp.text();
}

async function run(){
  let url = FEED_URL;
  const relevant = [];
  let pages = 0, totalEntries = 0;

  while(url && pages < MAX_PAGES){
    const xml = await fetchPage(url);
    const blocks = xml.match(/<entry[\s\S]*?<\/entry>/g) || [];
    totalEntries += blocks.length;
    blocks.forEach(b=>{
      try{
        const entry = parseEntryBlock(b);
        if(isSectorRelevant(entry)) relevant.push(entry);
      }catch(e){ console.warn('Entrada omitida por error de parseo:', e.message); }
    });
    pages++;
    url = nextLink(xml);
  }

  let existing = [];
  try{
    existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8')).entries || [];
  }catch(e){ /* primer arranque: no hay snapshot previo */ }

  const byId = new Map(existing.map(e => [e.expediente, e]));
  relevant.forEach(e => byId.set(e.expediente, e));

  const cutoff = Date.now() - STALE_DAYS * 86400000;
  const merged = Array.from(byId.values()).filter(e=>{
    const ref = e.fechaAdjudicacion || e.deadline || e.updated;
    if(!ref) return true;
    const t = new Date(ref).getTime();
    return isNaN(t) || t >= cutoff;
  });

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalEntriesScanned: totalEntries,
    pagesFetched: pages,
    entries: merged
  }, null, 2));

  console.log(`OK: ${merged.length} licitaciones relevantes en el snapshot (${totalEntries} entradas escaneadas en ${pages} página(s)).`);
}

run().catch(e => { console.error('Fallo en el barrido:', e); process.exit(1); });
