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
import nodemailer from 'nodemailer';

const FEED_URL = 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
// El feed está ordenado por fecha de actualización (más reciente primero), encadenado
// en páginas de 500 entradas vía <link rel="next">. Un nº fijo de páginas se queda corto
// en días de mucha actividad en PLACSP (miles de cambios en todo el sector público
// español), enterrando licitaciones legítimas bajo actualizaciones de otros organismos.
// En su lugar, seguimos paginando hasta cubrir COVERAGE_HOURS hacia atrás en el tiempo,
// con un tope de páginas de seguridad para no entrar en bucle si el feed fallara.
const COVERAGE_HOURS = 72; // colchón de seguridad: si el cron se retrasa o falla un día, igualmente cubrimos lo publicado
const SAFETY_MAX_PAGES = 40; // 40 × 500 = 20.000 entradas como límite absoluto por ejecución
const STALE_DAYS_OPEN = 90;        // abiertas sin actividad: purgar después de 90 días
const STALE_DAYS_ADJ  = 1096;      // adjudicadas/resueltas: conservar 3 años completos
const CONFIG_PATH = 'config/accreditations.json';
const OUTPUT_PATH = 'data/licitaciones.json';
const RESUMENES_DIR = 'data/resumenes';
const SELECCION_PATH = 'data/seleccion.json';
const ALERT_RECIPIENT = 'medioambiente.esp@agqlabs.com';
const ALERT_DAYS_THRESHOLD = 3;
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
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

// Detecta si el TIPO de contrato es un suministro/adquisición/renting de material o
// equipo (frecuente en organismos que compran reactivos, equipos o vehículos para su
// propio laboratorio interno, no que contratan un servicio de análisis a un proveedor
// externo como AGQ). En ese caso, palabras como "laboratorio" o "agua" ya no bastan
// como señal de actividad: exigimos una señal fuerte de que también incluye un
// servicio de análisis/inspección realmente prestado, no solo material/equipo.
const SUPPLY_TYPE_RE = /\bsuministros?\s+(de|del|de\s+los|de\s+las|y|e)\b|\badquisici[oó]n\s+de\b|\bsistema\s+din[aá]mico\s+de\s+adquisici[oó]n\b|\brenting\b|\barrendamiento\b/i;
const STRONG_SERVICE_KEYWORDS = ['ensayo','ensayos','análisis','analisis','analítica','analitica','control analítico','control analitico','servicio de análisis','externalizacion','externalización','subcontratacion','subcontratación','muestreo','toma de muestra','vigilancia ambiental','auditoría ambiental','auditoria ambiental','evaluación ambiental','evaluacion ambiental','inspección ambiental','inspeccion ambiental'];

function isSectorRelevant(entry){
  if(entry.cpv.some(c => cpvCodes.includes(c))) return true;
  const text = (entry.title + ' ' + entry.rawSummary).toLowerCase();
  const matched = allKeywords.filter(k => k && keywordMatches(text, k));
  if(matched.length === 0) return false;
  const esSuministro = SUPPLY_TYPE_RE.test(entry.title);
  const nonAmbiguous = matched.filter(k => !genericAmbiguous.has(k));
  if(nonAmbiguous.length > 0 && !esSuministro) return true;
  if(esSuministro){
    return STRONG_SERVICE_KEYWORDS.some(k => keywordMatches(text, k));
  }
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
  // El estado manda: si el feed dice que ya está resuelta/adjudicada/desierta, no está
  // abierta aunque arrastre algún campo de fecha residual en el pliego.
  if(entry.estado && entry.estado !== 'PUB') return false;
  if(entry.deadline){
    const d = new Date(entry.deadline);
    if(!isNaN(d.getTime())){
      const today = new Date(); today.setHours(0,0,0,0);
      return d.getTime() >= today.getTime();
    }
  }
  return true; // estado PUB (o sin estado informado) y sin fecha límite detectada: la tratamos como abierta
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
{"descripcion_objeto":"...","aspectos_administrativos":["..."],"aspectos_tecnicos":["..."]}
"descripcion_objeto" es un párrafo breve (2-4 frases) que explique en lenguaje claro qué se contrata, para quién y con qué finalidad, basado en el objeto del contrato del pliego.
"aspectos_administrativos" es una lista de los puntos administrativos a tener en cuenta antes de presentar oferta: criterios de valoración y su ponderación, documentación a aportar, garantías (provisional/definitiva), solvencia económica exigida, plazo y forma de presentación, criterios de desempate, y cualquier otro requisito administrativo relevante.
"aspectos_tecnicos" es una lista de los aspectos técnicos necesarios para poder ejecutar el contrato: alcance técnico del servicio, parámetros/matrices/ensayos requeridos, acreditaciones o habilitaciones técnicas exigidas (ISO 17025, ISO 17020, ENAC, registros sectoriales...), medios materiales o personal técnico exigido, plazos de ejecución y entrega de resultados, y cualquier otro requisito técnico relevante.
Cada elemento de las listas debe ser una frase breve y concreta en español, basada solo en el texto de los pliegos proporcionados. Si una sección no tiene información, devuelve un array vacío para ella (o cadena vacía para descripcion_objeto). Máximo 8 elementos por lista.`
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

function formatImporteEs(entry){
  if(entry.importe != null && !isNaN(entry.importe)){
    return entry.importe.toLocaleString('es-ES', { maximumFractionDigits: 2 }) + ' €';
  }
  return entry.importeRaw ? sanitizeForPdf(entry.importeRaw) : 'No especificado en el feed';
}

function formatDeadlineEs(entry){
  if(!entry.deadline) return 'No especificada';
  const d = new Date(entry.deadline);
  if(isNaN(d.getTime())) return sanitizeForPdf(entry.deadline);
  const fecha = d.toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric' });
  const tieneHora = entry.deadline.includes('T') && !/T00:00:00/.test(entry.deadline);
  const hora = tieneHora ? d.toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' }) + 'h' : '';
  return fecha + (hora ? ' · ' + hora : '') + (entry.deadlineSource ? ' (' + sanitizeForPdf(entry.deadlineSource) + ')' : '');
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

  // 1) Cabecera de marca
  page.drawRectangle({ x:0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: PDF_PURPLE });
  page.drawText('AGQ RADAR DE LICITACIONES', { x: MARGIN, y, size: 9, font: fontBold, color: PDF_PURPLE });
  const tag = 'RESUMEN AUTOMÁTICO DE PLIEGO';
  page.drawText(tag, { x: PAGE_W - MARGIN - fontReg.widthOfTextAtSize(tag, 9), y, size: 9, font: fontReg, color: PDF_GREEN });
  y -= 22;
  page.drawLine({ start:{x:MARGIN,y}, end:{x:PAGE_W-MARGIN,y}, thickness:0.75, color: rgb(0.85,0.85,0.87) });
  y -= 26;

  // 2) Título
  wrapText(entry.title, fontBold, 14, PAGE_W - 2*MARGIN).forEach(l=>{ page.drawText(l, { x: MARGIN, y, size: 14, font: fontBold, color: PDF_INK }); y -= 18; });
  y -= 4;
  page.drawText(sanitizeForPdf('Expediente ' + entry.expediente + (entry.organo ? ' · ' + entry.organo : '')), { x: MARGIN, y, size: 10, font: fontReg, color: PDF_SOFT });
  y -= 24;

  // 3) Ficha rápida: importe + fecha límite, en una caja de dos columnas
  const fichaH = 46;
  newPageIfNeeded(fichaH + 12);
  const colW = (PAGE_W - 2*MARGIN) / 2;
  page.drawRectangle({ x: MARGIN, y: y - fichaH, width: PAGE_W - 2*MARGIN, height: fichaH, color: rgb(0.96,0.96,0.97) });
  page.drawText('IMPORTE DE LA LICITACIÓN', { x: MARGIN+12, y: y-16, size: 8, font: fontBold, color: PDF_PURPLE });
  page.drawText(formatImporteEs(entry), { x: MARGIN+12, y: y-34, size: 12.5, font: fontBold, color: PDF_INK });
  page.drawText('FECHA LÍMITE DE PRESENTACIÓN', { x: MARGIN+colW+12, y: y-16, size: 8, font: fontBold, color: PDF_PURPLE });
  page.drawText(formatDeadlineEs(entry), { x: MARGIN+colW+12, y: y-34, size: 12.5, font: fontBold, color: PDF_INK });
  page.drawLine({ start:{x:MARGIN+colW, y:y-8}, end:{x:MARGIN+colW, y:y-fichaH+8}, thickness:0.75, color: rgb(0.85,0.85,0.87) });
  y -= (fichaH + 22);

  // 4) Resumen del objeto de la licitación
  if(summary.descripcion_objeto && summary.descripcion_objeto.trim()){
    newPageIfNeeded(30);
    page.drawText('RESUMEN DEL OBJETO DE LA LICITACIÓN', { x: MARGIN, y, size: 10.5, font: fontBold, color: PDF_PURPLE });
    y -= 16;
    const descLines = wrapText(summary.descripcion_objeto, fontReg, 10.5, PAGE_W - 2*MARGIN - 16);
    newPageIfNeeded(descLines.length*14 + 18);
    const boxTop = y + 6;
    descLines.forEach(l=>{ page.drawText(l, { x: MARGIN+8, y, size: 10.5, font: fontReg, color: PDF_INK }); y -= 14; });
    const boxBottom = y + 2;
    page.drawRectangle({ x: MARGIN, y: boxBottom, width: 3, height: boxTop - boxBottom, color: PDF_GREEN });
    y -= 20;
  }

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

  // 5) Aspectos administrativos a considerar
  section('Aspectos administrativos a considerar', summary.aspectos_administrativos);
  // 6) Aspectos técnicos necesarios
  section('Aspectos técnicos necesarios', summary.aspectos_tecnicos);
  drawFooter();

  return Buffer.from(await doc.save());
}

function sanitizeFilename(s){
  return String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9_-]+/g,'_').slice(0,80) || 'sin-id';
}

// === [MOD:DEADLINE-ALERTS] ===
// Lee data/seleccion.json (mantenido manualmente: Ignacio le pide a Claude que marque/
// desmarque expedientes ahí, ya que la app no escribe en GitHub directamente para no
// guardar un token con permiso de escritura en el navegador). Para cada expediente
// marcado como seleccionado, abierto y a ALERT_DAYS_THRESHOLD días o menos de su cierre,
// envía un único aviso por correo (vía Gmail SMTP) y registra que ya se envió para no
// repetirlo en ejecuciones futuras.
function escapeHtmlMail(s){ return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function sendAlertEmail(transporter, entry, daysRemaining){
  const fecha = entry.deadline ? new Date(entry.deadline) : null;
  const fechaTxt = fecha && !isNaN(fecha.getTime())
    ? fecha.toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'}) + (entry.deadline.includes('T') && !/T00:00:00/.test(entry.deadline) ? ' a las ' + fecha.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}) + 'h' : '')
    : 'No especificada';
  const importeTxt = entry.importe != null ? entry.importe.toLocaleString('es-ES',{maximumFractionDigits:2}) + ' €' : (entry.importeRaw || 'No especificado');
  const urgenciaTxt = daysRemaining < 0 ? 'EL PLAZO YA HA FINALIZADO' : daysRemaining === 0 ? 'HOY ES EL ÚLTIMO DÍA' : `Quedan ${daysRemaining} día(s)`;

  const subject = `Aviso, vencimiento plazo licitación: ${entry.title.slice(0,140)}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;">
      <div style="background:#565294;color:#fff;padding:14px 18px;font-weight:bold;">AGQ Radar de Licitaciones · Aviso de cierre de plazo</div>
      <div style="padding:18px;border:1px solid #e0e0e0;border-top:none;">
        <p style="font-size:15px;font-weight:bold;color:#c0392b;margin:0 0 14px;">${urgenciaTxt}</p>
        <h2 style="font-size:16px;margin:0 0 10px;">${escapeHtmlMail(entry.title)}</h2>
        <table style="font-size:13px;border-collapse:collapse;width:100%;">
          <tr><td style="padding:4px 0;color:#666;width:160px;">Expediente</td><td style="padding:4px 0;"><b>${escapeHtmlMail(entry.expediente)}</b></td></tr>
          <tr><td style="padding:4px 0;color:#666;">Órgano</td><td style="padding:4px 0;">${escapeHtmlMail(entry.organo||'—')}</td></tr>
          <tr><td style="padding:4px 0;color:#666;">Importe</td><td style="padding:4px 0;"><b>${escapeHtmlMail(importeTxt)}</b></td></tr>
          <tr><td style="padding:4px 0;color:#666;">Fecha y hora límite</td><td style="padding:4px 0;"><b>${escapeHtmlMail(fechaTxt)}</b></td></tr>
        </table>
        ${entry.link ? `<p style="margin:18px 0 0;"><a href="${escapeHtmlMail(entry.link)}" style="background:#84BD00;color:#fff;padding:10px 16px;text-decoration:none;border-radius:4px;font-size:13px;display:inline-block;">Ver licitación en la Plataforma de Contratación ↗</a></p>` : ''}
        <p style="font-size:11px;color:#999;margin-top:24px;">Aviso automático de AGQ Radar de Licitaciones. Esta licitación fue marcada para presentar oferta.</p>
      </div>
    </div>`;

  await transporter.sendMail({
    from: `"AGQ Radar de Licitaciones" <${GMAIL_USER}>`,
    to: ALERT_RECIPIENT,
    subject,
    html
  });
}

async function sendDeadlineAlerts(merged){
  const diag = { seleccionFileFound: false, seleccionadas: 0, alertasEnviadas: 0, smtpConfigured: !!(GMAIL_USER && GMAIL_APP_PASSWORD), errores: [] };
  let seleccion = {};
  try{
    seleccion = JSON.parse(fs.readFileSync(SELECCION_PATH, 'utf-8'));
    diag.seleccionFileFound = true;
  }catch(e){ return diag; } // sin fichero de selección todavía: nada que hacer

  const seleccionadas = Object.entries(seleccion).filter(([,s]) => s && s.seleccionado);
  diag.seleccionadas = seleccionadas.length;
  if(!seleccionadas.length) return diag;

  if(!diag.smtpConfigured){
    console.warn('GMAIL_USER/GMAIL_APP_PASSWORD no configurados: se omiten las alertas de cierre de plazo.');
    return diag;
  }

  const byId = new Map(merged.map(e => [e.expediente, e]));
  let transporter = null;
  let changed = false;

  for(const [expediente, sel] of seleccionadas){
    if(sel.alertaEnviada) continue;
    if(sel.estadoPipeline && ['presentada','ganada','perdida'].includes(sel.estadoPipeline)) continue;
    const entry = byId.get(expediente);
    if(!entry || !entry.deadline) continue;
    if(!isOpenForSubmission(entry)) continue;
    const deadlineMs = new Date(entry.deadline).getTime();
    if(isNaN(deadlineMs)) continue;
    const daysRemaining = Math.ceil((deadlineMs - Date.now()) / 86400000);
    if(daysRemaining > ALERT_DAYS_THRESHOLD) continue;
    try{
      if(!transporter){
        transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
      }
      await sendAlertEmail(transporter, entry, daysRemaining);
      sel.alertaEnviada = new Date().toISOString();
      changed = true;
      diag.alertasEnviadas++;
      console.log(`[${expediente}] alerta de cierre de plazo enviada a ${ALERT_RECIPIENT} (${daysRemaining} día(s) restantes).`);
    }catch(e){
      console.warn(`[${expediente}] fallo enviando alerta: ${e.message}`);
      diag.errores.push({ expediente, motivo: e.message.slice(0,200) });
    }
  }

  if(changed) fs.writeFileSync(SELECCION_PATH, JSON.stringify(seleccion, null, 2));
  return diag;
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

  const cutoffOpen = Date.now() - STALE_DAYS_OPEN * 86400000;
  const cutoffAdj  = Date.now() - STALE_DAYS_ADJ  * 86400000;
  const merged = Array.from(byId.values()).filter(e=>{
    const esAdj = e.estado === 'ADJ' || e.estado === 'RES';
    const cutoff = esAdj ? cutoffAdj : cutoffOpen;
    const ref = e.fechaAdjudicacion || e.deadline || e.updated;
    if(!ref) return true;
    const t = new Date(ref).getTime();
    return isNaN(t) || t >= cutoff;
  });

  const resumenDiag = await generateSummariesForOpenTenders(merged);
  const alertasDiag = await sendDeadlineAlerts(merged);

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalEntriesScanned: totalEntries,
    pagesFetched: pages,
    coverageHoursTarget: COVERAGE_HOURS,
    oldestEntrySeen: new Date(oldestSeen).toISOString(),
    resumenDiag,
    alertasDiag,
    entries: merged
  }, null, 2));

  console.log(`OK: ${merged.length} licitaciones relevantes en el snapshot (${totalEntries} entradas escaneadas en ${pages} página(s), hasta ${new Date(oldestSeen).toISOString()}).`);
}

run().catch(e => { console.error('Fallo en el barrido:', e); process.exit(1); });
