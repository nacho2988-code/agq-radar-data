// scripts/fetch-and-filter.mjs
// Barrido diario del feed oficial de licitaciones (PLACSP) filtrado por el
// perfil sectorial de AGQ Labs. Sin dependencias externas: usa fetch nativo
// de Node 18+ y parseo por expresiones regulares (mismo criterio que el
// parser del navegador: ignora el prefijo de namespace y empareja por
// nombre local de la etiqueta, para ser tolerante a variaciones de CODICE).
//
// Además, para las licitaciones abiertas y relevantes, descarga el pliego
// administrativo y técnico, pide a Google Gemini (nivel gratuito de Google
// AI Studio, sin tarjeta) un resumen estructurado y genera un PDF de resumen
// (módulo AI-SUMMARY-PDF, más abajo).

import fs from 'node:fs';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const FEED_URL = 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
// El feed está ordenado por fecha de actualización (más reciente primero), encadenado
// en páginas de 500 entradas vía <link rel="next">. Un nº fijo de páginas se queda corto
// en días de mucha actividad en PLACSP (miles de cambios en todo el sector público
// español), enterrando licitaciones legítimas bajo actualizaciones de otros organismos.
// En su lugar, seguimos paginando hasta cubrir COVERAGE_HOURS hacia atrás en el tiempo,
// con un tope de páginas de seguridad para no entrar en bucle si el feed fallara.
const COVERAGE_HOURS = 72; // colchón de seguridad: si el cron se retrasa o falla un día, igualmente cubrimos lo publicado
const SAFETY_MAX_PAGES = 40; // 40 × 500 = 20.000 entradas como límite absoluto por ejecución
const STALE_DAYS = 90;          // se purgan del histórico las entradas más antiguas que esto
const CONFIG_PATH = 'config/accreditations.json';
const OUTPUT_PATH = 'data/licitaciones.json';
const RESUMENES_DIR = 'data/resumenes';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash'; // nivel gratuito de Google AI Studio, sin tarjeta, admite PDF nativo
const MAX_DOC_BYTES = 20 * 1024 * 1024; // no mandamos pliegos descomunales a la API

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const cpvCodes = config.cpv.map(line => (line.match(/^\d{8}/) || [])[0]).filter(Boolean);
const allKeywords = [...new Set(
  config.accreditations.flatMap(a => a.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean))
)];
const activityKeywords = (config.activityKeywords || []).map(k => k.toLowerCase());
const genericAmbiguous = new Set((config.genericAmbiguous || []).map(k => k.toLowerCase()));

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
  const matched = allKeywords.filter(k => k && keywordMatches(text, k));
  if(matched.length === 0) return false;
  const nonAmbiguous = matched.filter(k => !genericAmbiguous.has(k));
  if(nonAmbiguous.length > 0) return true;
  // Solo hay coincidencias de términos ambiguos (agua, suelo, residuos...): exigimos
  // además una señal de que el contrato es de análisis/inspección, no de obra,
  // suministro, recogida o concesión de un servicio que simplemente menciona esas palabras.
  return activityKeywords.some(k => keywordMatches(text, k));
}

function nextLink(xml){
  const m = xml.match(/<link[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i)
         || xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']next["']/i);
  return m ? m[1] : null;
}

function isOpenForSubmission(entry){
  if(entry.deadline){
    const d = new Date(entry.deadline);
    if(!isNaN(d.getTime())){
      const today = new Date(); today.setHours(0,0,0,0);
      return d.getTime() >= today.getTime();
    }
  }
  return entry.estado === 'PUB' || !entry.estado;
}

async function fetchPage(url){
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'AGQ-Radar-Licitaciones/1.0 (uso interno; consumo del dataset de datos abiertos PLACSP)' }
  });
  if(!resp.ok) throw new Error('HTTP ' + resp.status + ' al pedir ' + url);
  return await resp.text();
}

// === [MOD:AI-SUMMARY-PDF] ===
async function fetchPdfBuffer(url){
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'AGQ-Radar-Licitaciones/1.0 (uso interno; consumo del dataset de datos abiertos PLACSP)' }
  });
  if(!resp.ok) throw new Error('HTTP ' + resp.status + ' al descargar pliego');
  const buf = Buffer.from(await resp.arrayBuffer());
  if(buf.length > MAX_DOC_BYTES) throw new Error('Pliego demasiado grande (' + buf.length + ' bytes), se omite');
  if(buf.length < 100) throw new Error('Respuesta vacía o no es un PDF válido');
  return buf;
}

async function callGeminiSummary(entry, docs){
  const parts = [{
    text: `Eres un asistente que ayuda a un comercial técnico de AGQ Labs (laboratorio acreditado ISO 17025 / entidad de inspección ISO 17020 en medioambiente) a evaluar rápidamente una licitación pública española.
Te paso a continuación el/los pliego(s) de la licitación "${entry.title}" (expediente ${entry.expediente}, órgano: ${entry.organo}).`
  }];
  docs.forEach(d=>{
    parts.push({ text: 'Documento: ' + d.label });
    parts.push({ inline_data: { mime_type: 'application/pdf', data: d.buffer.toString('base64') } });
  });
  parts.push({
    text: `Responde ÚNICAMENTE con un JSON válido (sin texto adicional, sin markdown, sin backticks) con esta forma exacta:
{"puntos_administrativos":["..."],"puntos_tecnicos":["..."],"parametros_matrices":["..."],"acreditaciones_exigidas":["..."],"plazos_garantias":["..."]}
Cada elemento debe ser una frase breve y concreta en español, basada solo en el texto de los pliegos proporcionados. Si una sección no tiene información, devuelve un array vacío para ella. Máximo 6 elementos por sección.`
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  });
  if(!resp.ok){
    const errBody = await resp.text().catch(()=> '');
    throw new Error('HTTP ' + resp.status + ' de la API de Gemini: ' + errBody.slice(0,300));
  }
  const data = await resp.json();
  const textOut = ((data.candidates || [])[0]?.content?.parts || []).map(p=>p.text || '').join('\n');
  const cleaned = textOut.replace(/```json|```/g,'').trim();
  return JSON.parse(cleaned);
}

const PDF_PURPLE = rgb(0x56/255, 0x52/255, 0x94/255);
const PDF_GREEN  = rgb(0x84/255, 0xBD/255, 0x00/255);
const PDF_INK    = rgb(0.13, 0.13, 0.15);
const PDF_SOFT   = rgb(0.42, 0.42, 0.46);
const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 50;

function sanitizeForPdf(s){
  if(s == null) return '';
  return String(s)
    .replace(/≤/g, '<=').replace(/≥/g, '>=')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/•/g, '-')
    .replace(/×/g, 'x').replace(/÷/g, '/')
    .replace(/[^\x00-\x7F\u00A0-\u00FF]/g, '?'); // resto fuera de Latin-1: mejor "?" que reventar la fuente
}

function wrapText(text, font, size, maxWidth){
  const words = sanitizeForPdf(text).split(/\s+/);
  const lines = []; let line = '';
  for(const w of words){
    const test = line ? line + ' ' + w : w;
    if(font.widthOfTextAtSize(test, size) > maxWidth && line){ lines.push(line); line = w; }
    else line = test;
  }
  if(line) lines.push(line);
  return lines;
}

async function generateSummaryPdf(entry, summary, docLabels){
  const doc = await PDFDocument.create();
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  function drawFooter(){
    page.drawText('AGQ Radar de Licitaciones · Resumen generado automáticamente con IA a partir de: ' + docLabels.join(', ') + ' · verificar siempre el pliego original', {
      x: MARGIN, y: 28, size: 7, font: fontReg, color: PDF_SOFT
    });
  }
  function newPageIfNeeded(needed){
    if(y - needed < MARGIN){
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      page.drawRectangle({ x:0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: PDF_PURPLE });
      y -= 30;
    }
  }

  page.drawRectangle({ x:0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: PDF_PURPLE });
  page.drawText('AGQ RADAR DE LICITACIONES', { x: MARGIN, y, size: 9, font: fontBold, color: PDF_PURPLE });
  const tag = 'RESUMEN AUTOMÁTICO DE PLIEGO';
  page.drawText(tag, { x: PAGE_W - MARGIN - fontReg.widthOfTextAtSize(tag, 9), y, size: 9, font: fontReg, color: PDF_GREEN });
  y -= 22;
  page.drawLine({ start:{x:MARGIN,y}, end:{x:PAGE_W-MARGIN,y}, thickness:0.75, color: rgb(0.85,0.85,0.87) });
  y -= 26;

  wrapText(entry.title, fontBold, 14, PAGE_W - 2*MARGIN).forEach(l=>{ page.drawText(l, { x: MARGIN, y, size: 14, font: fontBold, color: PDF_INK }); y -= 18; });
  y -= 4;
  page.drawText(sanitizeForPdf('Expediente ' + entry.expediente + (entry.organo ? ' · ' + entry.organo : '')), { x: MARGIN, y, size: 10, font: fontReg, color: PDF_SOFT });
  y -= 28;

  function section(title, items){
    newPageIfNeeded(40);
    page.drawText(title.toUpperCase(), { x: MARGIN, y, size: 10.5, font: fontBold, color: PDF_PURPLE });
    y -= 16;
    if(!items || !items.length){
      page.drawText('— Sin información detectada en el pliego —', { x: MARGIN+12, y, size: 9.5, font: fontReg, color: PDF_SOFT });
      y -= 18; return;
    }
    items.forEach(it=>{
      const lines = wrapText(it, fontReg, 10, PAGE_W - 2*MARGIN - 14);
      newPageIfNeeded(lines.length*13 + 6);
      page.drawText('•', { x: MARGIN, y, size: 10, font: fontBold, color: PDF_GREEN });
      lines.forEach(l=>{ page.drawText(l, { x: MARGIN+14, y, size: 10, font: fontReg, color: PDF_INK }); y -= 13; });
      y -= 3;
    });
    y -= 8;
  }

  section('Puntos administrativos clave', summary.puntos_administrativos);
  section('Puntos técnicos clave', summary.puntos_tecnicos);
  section('Parámetros / matrices requeridas', summary.parametros_matrices);
  section('Acreditaciones exigidas en el pliego', summary.acreditaciones_exigidas);
  section('Plazos y garantías', summary.plazos_garantias);
  drawFooter();

  return Buffer.from(await doc.save());
}

function sanitizeFilename(s){
  return String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9_-]+/g,'_').slice(0,80) || 'sin-id';
}

async function generateSummariesForOpenTenders(entries){
  const diag = { geminiKeyPresent: !!GEMINI_API_KEY, candidatos: 0, generados: 0, errores: [] };
  if(!GEMINI_API_KEY){
    console.warn('GEMINI_API_KEY no configurada: se omite la generación de resúmenes PDF.');
    return diag;
  }
  fs.mkdirSync(RESUMENES_DIR, { recursive: true });
  const candidates = entries.filter(e => isOpenForSubmission(e) && !e.resumenPdfPath);
  diag.candidatos = candidates.length;
  console.log(`Resúmenes PDF: ${candidates.length} licitación(es) abierta(s) pendiente(s) de resumir.`);

  for(const entry of candidates){
    try{
      const legal = (entry.documentos || []).find(d => d.tipo === 'LegalDocumentReference');
      const tecnico = (entry.documentos || []).find(d => d.tipo === 'TechnicalDocumentReference');
      const docsToFetch = [];
      if(legal) docsToFetch.push({ label: 'Pliego administrativo', url: legal.url });
      if(tecnico) docsToFetch.push({ label: 'Pliego técnico', url: tecnico.url });
      if(!docsToFetch.length){
        console.warn(`[${entry.expediente}] sin pliego administrativo/técnico referenciado, se omite.`);
        diag.errores.push({ expediente: entry.expediente, motivo: 'sin pliego referenciado' });
        continue;
      }

      const docs = [];
      for(const d of docsToFetch){
        try{ docs.push({ label: d.label, buffer: await fetchPdfBuffer(d.url) }); }
        catch(e){ console.warn(`[${entry.expediente}] no se pudo descargar "${d.label}": ${e.message}`); }
      }
      if(!docs.length){
        console.warn(`[${entry.expediente}] ningún pliego descargable, se omite.`);
        diag.errores.push({ expediente: entry.expediente, motivo: 'ningún pliego descargable' });
        continue;
      }

      const summary = await callGeminiSummary(entry, docs);
      const pdfBuffer = await generateSummaryPdf(entry, summary, docs.map(d=>d.label));
      const filename = sanitizeFilename(entry.expediente) + '.pdf';
      fs.writeFileSync(RESUMENES_DIR + '/' + filename, pdfBuffer);
      entry.resumenPdfPath = RESUMENES_DIR + '/' + filename;
      entry.resumenGeneradoEn = new Date().toISOString();
      diag.generados++;
      console.log(`[${entry.expediente}] resumen PDF generado (${docs.map(d=>d.label).join(' + ')}).`);
      await new Promise(r => setTimeout(r, 1500)); // ritmo prudente frente a la API y al feed
    }catch(e){
      console.warn(`[${entry.expediente}] fallo generando resumen: ${e.message}`);
      diag.errores.push({ expediente: entry.expediente, motivo: e.message.slice(0,200) });
    }
  }
  return diag;
}

async function run(){
  let url = FEED_URL;
  const relevant = [];
  let pages = 0, totalEntries = 0;
  const coverageCutoff = Date.now() - COVERAGE_HOURS * 3600000;
  let oldestSeen = Date.now();

  while(url && pages < SAFETY_MAX_PAGES){
    const xml = await fetchPage(url);
    const blocks = xml.match(/<entry[\s\S]*?<\/entry>/g) || [];
    totalEntries += blocks.length;
    blocks.forEach(b=>{
      try{
        const entry = parseEntryBlock(b);
        if(entry.updated){
          const t = new Date(entry.updated).getTime();
          if(!isNaN(t) && t < oldestSeen) oldestSeen = t;
        }
        if(isSectorRelevant(entry)) relevant.push(entry);
      }catch(e){ console.warn('Entrada omitida por error de parseo:', e.message); }
    });
    pages++;
    url = nextLink(xml);
    if(oldestSeen <= coverageCutoff){
      console.log(`Cobertura de ${COVERAGE_HOURS}h alcanzada tras ${pages} página(s) (${totalEntries} entradas).`);
      break;
    }
  }
  if(pages >= SAFETY_MAX_PAGES){
    console.warn(`Se alcanzó el tope de seguridad de ${SAFETY_MAX_PAGES} páginas sin cubrir ${COVERAGE_HOURS}h completas; la entrada más antigua vista es de ${new Date(oldestSeen).toISOString()}.`);
  }

  let existing = [];
  try{
    existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8')).entries || [];
  }catch(e){ /* primer arranque: no hay snapshot previo */ }
  // Reevaluamos las entradas ya guardadas con el filtro VIGENTE (no el de cuando se
  // guardaron): si cambias config/accreditations.json, las que dejen de cumplir el
  // criterio se purgan en la siguiente ejecución en vez de quedarse para siempre.
  existing = existing.filter(isSectorRelevant);

  const byId = new Map(existing.map(e => [e.expediente, e]));
  relevant.forEach(e => {
    const prev = byId.get(e.expediente);
    if(prev && prev.resumenPdfPath){
      e.resumenPdfPath = prev.resumenPdfPath;
      e.resumenGeneradoEn = prev.resumenGeneradoEn;
    }
    byId.set(e.expediente, e);
  });

  const cutoff = Date.now() - STALE_DAYS * 86400000;
  const merged = Array.from(byId.values()).filter(e=>{
    const ref = e.fechaAdjudicacion || e.deadline || e.updated;
    if(!ref) return true;
    const t = new Date(ref).getTime();
    return isNaN(t) || t >= cutoff;
  });

  const resumenDiag = await generateSummariesForOpenTenders(merged);

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalEntriesScanned: totalEntries,
    pagesFetched: pages,
    coverageHoursTarget: COVERAGE_HOURS,
    oldestEntrySeen: new Date(oldestSeen).toISOString(),
    resumenDiag,
    entries: merged
  }, null, 2));

  console.log(`OK: ${merged.length} licitaciones relevantes en el snapshot (${totalEntries} entradas escaneadas en ${pages} página(s), hasta ${new Date(oldestSeen).toISOString()}).`);
}

run().catch(e => { console.error('Fallo en el barrido:', e); process.exit(1); });
