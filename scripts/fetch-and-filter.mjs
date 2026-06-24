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
const ALERT_RECIPIENT = 'licitaciones.spain@agqlabs.com';
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
    // PLACSP usa distintas etiquetas según versión de CODICE: probar todas
    const wp = allBlocks(tr,'WinningParty')[0] || allBlocks(tr,'AwardedTenderer')[0];
    if(wp){
      adjudicatario = tag(wp,'Name') || tag(wp,'PartyName') ||
                      tag(wp,'CorporateName') || tag(wp,'RegisteredName') || '';
    }
    // Si no está en WinningParty, buscar directamente en TenderResult
    if(!adjudicatario){
      adjudicatario = tag(tr,'WinningTendererName') || tag(tr,'AwardedTendererName') ||
                      tag(tr,'ReceivedTendererName') || '';
    }
    const amt = tag(tr,'PayableAmount') || tag(tr,'TaxExclusiveAmount') ||
                tag(tr,'TotalAmount') || tag(tr,'AwardedTenderedAmount');
    if(amt){ const n = parseFloat(amt.replace(',','.')); importeAdjudicacion = isNaN(n) ? null : n; }
    fechaAdjudicacion = tag(tr,'AwardDate') || tag(tr,'IssueDate') || '';
  }
  // Fallback: buscar adjudicatario en el summary si no está en TenderResult
  if(!adjudicatario && summaryRaw){
    const m = summaryRaw.match(/Adjudicatario[^:]*:\s*([^;|<\n]+)/i);
    if(m) adjudicatario = m[1].trim();
  }

  const isAdjudicada = ['RES','ADJ'].includes((sp.estado||'').toUpperCase());
  const expediente = sp.expediente || idText || ('SIN-ID-' + Math.random().toString(36).slice(2,8));
  const estado = (sp.estado || '').toUpperCase();
  const importeMatch = (sp.importe || '').match(/[\d.,]+/);
  const importe = importeMatch ? (parseFloat(importeMatch[0].replace(',','.')) || null) : null;
  return {
    expediente, atomId: idText, title, organo: sp.organo || '',
    estado, estadoLabel: ESTADO_LABELS[estado] || estado || 'Desconocido',
    importe, importeRaw: sp.importe || '',
    cpv, deadline, deadlineSource,
    // Para adjudicadas solo guardamos lo esencial — sin documentos ni rawSummary
    documentos: isAdjudicada ? [] : documentos,
    link, updated,
    adjudicatario: adjudicatario.trim(), importeAdjudicacion, fechaAdjudicacion,
    rawSummary: isAdjudicada ? '' : summaryRaw,
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
    text: `Responde ÚNICAMENTE con un JSON válido (sin texto adicional, sin markdown, sin backticks) con esta estructura exacta:
{
  "descripcion_objeto": "...",
  "criterios_valoracion": ["..."],
  "aspectos_administrativos": ["..."],
  "aspectos_tecnicos": ["..."],
  "parametros_matrices": ["..."],
  "acreditaciones_exigidas": ["..."],
  "plazos_garantias": ["..."],
  "riesgos_para_agq": ["..."],
  "viabilidad": "ALTA|MEDIA|BAJA",
  "viabilidad_justificacion": "..."
}

INSTRUCCIONES POR CAMPO:
- "descripcion_objeto": párrafo breve (2-3 frases) que explique qué se contrata, para quién y con qué finalidad.
- "criterios_valoracion": lista de criterios de puntuación con sus pesos/puntos exactos (ej: "Oferta económica: 60 puntos", "Mejoras técnicas: 40 puntos"). Máximo 6 elementos.
- "aspectos_administrativos": requisitos administrativos clave (solvencia económica exigida, garantías, documentación obligatoria, forma y plazo de presentación). Máximo 6 elementos.
- "aspectos_tecnicos": requisitos técnicos necesarios para ejecutar el contrato (alcance, medios, personal, plazos de entrega). Máximo 6 elementos.
- "parametros_matrices": parámetros analíticos, matrices o ensayos concretos requeridos (ej: "Legionella spp. en agua fría y caliente"). Array vacío si no aplica.
- "acreditaciones_exigidas": habilitaciones, certificaciones o registros que exige el pliego (ISO 17025, ISO 17020, ENAC, ROESB, ROLECE...). Array vacío si no se especifican.
- "plazos_garantias": duración del contrato, prórrogas posibles, garantía definitiva, plazo de garantía del servicio.
- "riesgos_para_agq": aspectos del pliego que pueden ser un problema para AGQ Labs (registros autonómicos específicos, subcontratación necesaria, restricciones geográficas, solvencia difícil de acreditar). Array vacío si no hay riesgos evidentes.
- "viabilidad": valoración global de si AGQ puede presentar oferta: ALTA (cumple todos los requisitos evidentes), MEDIA (puede presentar con alguna subcontratación o limitación), BAJA (requisito difícil de cumplir o fuera de scope).
- "viabilidad_justificacion": una frase explicando el motivo de la valoración de viabilidad.

Basa todas las respuestas SOLO en el texto de los pliegos. Si una sección no tiene información, devuelve array vacío o cadena vacía.`
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
  const fontReg  = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const CONTENT_W = PAGE_W - 2*MARGIN;

  function checkPage(needed){
    if(y - needed < MARGIN + 30){
      drawPageFooter();
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      // Línea de color superior en páginas adicionales
      page.drawRectangle({ x:0, y:PAGE_H-4, width:PAGE_W, height:4, color:PDF_PURPLE });
      page.drawRectangle({ x:0, y:PAGE_H-7, width:PAGE_W/2, height:3, color:PDF_GREEN });
      y -= 28;
    }
  }

  function drawPageFooter(){
    page.drawLine({ start:{x:MARGIN,y:32}, end:{x:PAGE_W-MARGIN,y:32}, thickness:0.5, color:rgb(0.8,0.8,0.85) });
    page.drawText(`AGQ Labs · Radar de Licitaciones · Resumen ejecutivo generado con IA · Fuente: ${docLabels.join(', ')} · Verificar siempre el pliego original`, {
      x:MARGIN, y:20, size:6.5, font:fontReg, color:PDF_SOFT
    });
    page.drawText(new Date().toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'}),
      { x:PAGE_W-MARGIN-40, y:20, size:6.5, font:fontReg, color:PDF_SOFT });
  }

  // ─── CABECERA CORPORATIVA ───────────────────────────────────────────
  // Banda superior bicolor
  page.drawRectangle({ x:0, y:PAGE_H-4, width:PAGE_W, height:4, color:PDF_PURPLE });
  page.drawRectangle({ x:0, y:PAGE_H-7, width:PAGE_W/2, height:3, color:PDF_GREEN });

  // Fondo cabecera oscuro
  page.drawRectangle({ x:0, y:PAGE_H-56, width:PAGE_W, height:49, color:rgb(0.10,0.09,0.15) });

  // Texto AGQ LABS a la izquierda
  page.drawText('AGQ LABS', { x:MARGIN, y:PAGE_H-28, size:16, font:fontBold, color:rgb(1,1,1) });
  page.drawText('TECHNOLOGICAL SERVICES', { x:MARGIN, y:PAGE_H-40, size:7, font:fontReg, color:rgb(0.52,0.74,0) });
  // Línea verde bajo AGQ LABS
  page.drawLine({ start:{x:MARGIN,y:PAGE_H-44}, end:{x:MARGIN+92,y:PAGE_H-44}, thickness:1, color:PDF_GREEN });

  // Título del documento a la derecha
  const tipoDoc = 'RESUMEN EJECUTIVO';
  const tipoW = fontBold.widthOfTextAtSize(tipoDoc, 9);
  page.drawText(tipoDoc, { x:PAGE_W-MARGIN-tipoW, y:PAGE_H-28, size:9, font:fontBold, color:PDF_GREEN });
  page.drawText('Licitación Pública · Plataforma de Contratación del Sector Público',
    { x:PAGE_W-MARGIN-fontReg.widthOfTextAtSize('Licitación Pública · Plataforma de Contratación del Sector Público',7),
      y:PAGE_H-40, size:7, font:fontReg, color:rgb(0.65,0.63,0.78) });

  y = PAGE_H - 72;

  // ─── TÍTULO Y EXPEDIENTE ────────────────────────────────────────────
  const titleLines = wrapText(entry.title, fontBold, 13, CONTENT_W);
  titleLines.forEach(l=>{ page.drawText(l, { x:MARGIN, y, size:13, font:fontBold, color:PDF_INK }); y -= 17; });
  y -= 3;
  const meta = sanitizeForPdf(`Expediente ${entry.expediente}${entry.organo?' · '+entry.organo:''}`);
  page.drawText(meta, { x:MARGIN, y, size:9.5, font:fontReg, color:PDF_SOFT });
  y -= 18;
  page.drawLine({ start:{x:MARGIN,y}, end:{x:PAGE_W-MARGIN,y}, thickness:0.5, color:rgb(0.85,0.85,0.87) });
  y -= 16;

  // ─── FICHA RÁPIDA: importe + plazo ─────────────────────────────────
  const fichaH = 44;
  checkPage(fichaH + 20);
  const colW = CONTENT_W / 2;
  page.drawRectangle({ x:MARGIN, y:y-fichaH, width:CONTENT_W, height:fichaH, color:rgb(0.96,0.96,0.98), borderColor:rgb(0.85,0.85,0.90), borderWidth:0.5 });
  // col izq: importe
  page.drawText('PRESUPUESTO DE LICITACIÓN', { x:MARGIN+12, y:y-14, size:7.5, font:fontBold, color:PDF_PURPLE });
  page.drawText(formatImporteEs(entry), { x:MARGIN+12, y:y-32, size:13, font:fontBold, color:PDF_INK });
  // separador vertical
  page.drawLine({ start:{x:MARGIN+colW,y:y-6}, end:{x:MARGIN+colW,y:y-fichaH+6}, thickness:0.5, color:rgb(0.82,0.82,0.88) });
  // col der: fecha límite
  page.drawText('FECHA LÍMITE DE PRESENTACIÓN', { x:MARGIN+colW+12, y:y-14, size:7.5, font:fontBold, color:PDF_PURPLE });
  const deadlineStr = formatDeadlineEs(entry);
  page.drawText(sanitizeForPdf(deadlineStr), { x:MARGIN+colW+12, y:y-32, size:13, font:fontBold, color:PDF_INK });
  y -= (fichaH + 16);

  // ─── SEMÁFORO DE VIABILIDAD ─────────────────────────────────────────
  if(summary.viabilidad){
    checkPage(36);
    const vColor = summary.viabilidad==='ALTA' ? PDF_GREEN : summary.viabilidad==='MEDIA' ? rgb(0.79,0.49,0.16) : rgb(0.64,0.23,0.23);
    const vBg    = summary.viabilidad==='ALTA' ? rgb(0.93,0.98,0.88) : summary.viabilidad==='MEDIA' ? rgb(0.99,0.95,0.88) : rgb(0.98,0.92,0.92);
    const vLabel = `VIABILIDAD PARA AGQ: ${summary.viabilidad}`;
    page.drawRectangle({ x:MARGIN, y:y-30, width:CONTENT_W, height:30, color:vBg, borderColor:vColor, borderWidth:1 });
    page.drawRectangle({ x:MARGIN, y:y-30, width:4, height:30, color:vColor });
    page.drawText(sanitizeForPdf(vLabel), { x:MARGIN+14, y:y-13, size:9, font:fontBold, color:vColor });
    if(summary.viabilidad_justificacion){
      const justLines = wrapText(summary.viabilidad_justificacion, fontReg, 8.5, CONTENT_W-28);
      justLines.slice(0,1).forEach(l=>page.drawText(l, { x:MARGIN+14, y:y-24, size:8.5, font:fontReg, color:PDF_INK }));
    }
    y -= 44;
  }

  // ─── OBJETO DEL CONTRATO ────────────────────────────────────────────
  if(summary.descripcion_objeto && summary.descripcion_objeto.trim()){
    checkPage(30);
    page.drawText('OBJETO DEL CONTRATO', { x:MARGIN, y, size:9.5, font:fontBold, color:PDF_PURPLE });
    y -= 14;
    const dLines = wrapText(summary.descripcion_objeto, fontReg, 9.5, CONTENT_W-10);
    checkPage(dLines.length*13+14);
    const boxTop = y+4;
    dLines.forEach(l=>{ page.drawText(l, { x:MARGIN+10, y, size:9.5, font:fontReg, color:PDF_INK }); y -= 13; });
    page.drawRectangle({ x:MARGIN, y:y+2, width:3, height:boxTop-(y+2), color:PDF_GREEN });
    y -= 18;
  }

  // ─── FUNCIÓN GENÉRICA DE SECCIÓN ────────────────────────────────────
  function section(title, items, color){
    if(!items || !items.length) return;
    checkPage(32);
    const sColor = color || PDF_PURPLE;
    page.drawText(title.toUpperCase(), { x:MARGIN, y, size:9.5, font:fontBold, color:sColor });
    y -= 14;
    items.forEach(it=>{
      const lines = wrapText(sanitizeForPdf(it), fontReg, 9.5, CONTENT_W-16);
      checkPage(lines.length*13+6);
      // bullet cuadrado del color de la sección
      page.drawRectangle({ x:MARGIN+1, y:y-1, width:5, height:5, color:sColor });
      lines.forEach((l,i)=>{ page.drawText(l, { x:MARGIN+14, y, size:9.5, font:i===0?fontReg:fontReg, color:PDF_INK }); y -= 13; });
      y -= 3;
    });
    y -= 8;
  }

  section('Criterios de valoración', summary.criterios_valoracion, PDF_PURPLE);
  section('Aspectos administrativos clave', summary.aspectos_administrativos, PDF_PURPLE);
  section('Aspectos técnicos requeridos', summary.aspectos_tecnicos, PDF_PURPLE);
  section('Parámetros y matrices', summary.parametros_matrices, PDF_GREEN);
  section('Acreditaciones exigidas en el pliego', summary.acreditaciones_exigidas, PDF_GREEN);
  section('Plazos y garantías', summary.plazos_garantias, PDF_SOFT);
  if(summary.riesgos_para_agq && summary.riesgos_para_agq.length){
    section('⚠ Riesgos / aspectos a verificar para AGQ', summary.riesgos_para_agq, rgb(0.64,0.23,0.23));
  }

  drawPageFooter();
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
    if(sel.estadoPipeline && ['presentada','ganada','perdida','rechazada'].includes(sel.estadoPipeline)) continue;
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

// === [MOD:NUEVAS-LICITACIONES-ALERT] ===
// Envía un correo semanal (lunes) con las licitaciones nuevas detectadas en las últimas 24h
// que coinciden con nuestros CPVs o palabras clave sectoriales.
async function sendNuevasLicitacionesAlert(merged, prevSnapshot){
  const diag = { enviado: false, nuevas: 0, smtpConfigured: !!(GMAIL_USER && GMAIL_APP_PASSWORD), error: null };
  if(!diag.smtpConfigured) return diag;

  // Solo enviar si hay novedades respecto al snapshot anterior
  const prevIds = new Set((prevSnapshot || []).map(e => e.expediente));
  const nuevas = merged.filter(e =>
    isOpenForSubmission(e) && !prevIds.has(e.expediente)
  );
  diag.nuevas = nuevas.length;
  if(!nuevas.length) return diag;

  const transporter = nodemailer.createTransport({ service:'gmail', auth:{ user:GMAIL_USER, pass:GMAIL_APP_PASSWORD } });
  const filas = nuevas.slice(0, 30).map(e => `
    <tr style="border-bottom:1px solid #e8e8e8;">
      <td style="padding:8px;font-size:12px;">${e.title.slice(0,100)}</td>
      <td style="padding:8px;font-size:12px;">${e.organo||'—'}</td>
      <td style="padding:8px;font-size:12px;text-align:right;">${e.importe?e.importe.toLocaleString('es-ES',{maximumFractionDigits:0})+' €':'—'}</td>
      <td style="padding:8px;font-size:12px;">${e.deadline?new Date(e.deadline).toLocaleDateString('es-ES'):'—'}</td>
    </tr>`).join('');

  const html = `<div style="font-family:Arial,sans-serif;max-width:700px;">
    <div style="background:#565294;color:#fff;padding:14px 18px;">
      <b>AGQ Radar de Licitaciones</b> · ${nuevas.length} licitación${nuevas.length===1?'':'es'} nueva${nuevas.length===1?'':'s'} detectada${nuevas.length===1?'':'s'}
    </div>
    <div style="padding:16px;border:1px solid #e0e0e0;border-top:none;">
      <p style="font-size:13px;color:#555;margin:0 0 14px;">Nuevas licitaciones relevantes para el sector ambiental/laboratorio detectadas en el último barrido:</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#f5f4ef;">
          <th style="padding:8px;text-align:left;">Título</th>
          <th style="padding:8px;text-align:left;">Órgano</th>
          <th style="padding:8px;text-align:right;">Importe</th>
          <th style="padding:8px;text-align:left;">Fecha límite</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>
      ${nuevas.length>30?`<p style="font-size:11px;color:#999;margin-top:10px;">… y ${nuevas.length-30} más. Accede al Radar para verlas todas.</p>`:''}
    </div>
  </div>`;

  try{
    await transporter.sendMail({
      from: `"AGQ Radar de Licitaciones" <${GMAIL_USER}>`,
      to: ALERT_RECIPIENT,
      subject: `Radar Licitaciones: ${nuevas.length} nueva${nuevas.length===1?'':'s'} detectada${nuevas.length===1?'':'s'}`,
      html
    });
    diag.enviado = true;
    console.log(`[NUEVAS] Alerta enviada a ${ALERT_RECIPIENT}: ${nuevas.length} licitaciones nuevas.`);
  }catch(e){
    diag.error = e.message.slice(0, 200);
    console.warn(`[NUEVAS] Error enviando alerta: ${e.message}`);
  }
  return diag;
}

async function generateSummariesForOpenTenders(entries){
  const diag = { geminiKeyPresent: !!GEMINI_API_KEY, candidatos: 0, generados: 0, errores: [] };
  if(!GEMINI_API_KEY){
    console.warn('GEMINI_API_KEY no configurada: se omite la generación de resúmenes PDF.');
    return diag;
  }
  fs.mkdirSync(RESUMENES_DIR, { recursive: true });
  const candidates = entries.filter(e => {
    if(!isOpenForSubmission(e)) return false;
    if(!e.resumenPdfPath) return true;
    // Regenerar si el resumen es del formato antiguo (sin campos nuevos)
    // Se detecta por la ausencia del campo resumenVersion en el snapshot
    if(!e.resumenVersion || e.resumenVersion < 2) return true;
    return false;
  });
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
      entry.resumenVersion = 2;
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
  const prevEntries = existing; // guardar antes del merge para detectar novedades
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
  const nuevasDiag = await sendNuevasLicitacionesAlert(merged, prevEntries);

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalEntriesScanned: totalEntries,
    pagesFetched: pages,
    coverageHoursTarget: COVERAGE_HOURS,
    oldestEntrySeen: new Date(oldestSeen).toISOString(),
    resumenDiag,
    alertasDiag,
    nuevasDiag,
    entries: merged
  }, null, 2));

  console.log(`OK: ${merged.length} licitaciones relevantes en el snapshot (${totalEntries} entradas escaneadas en ${pages} página(s), hasta ${new Date(oldestSeen).toISOString()}).`);
}

run().catch(e => { console.error('Fallo en el barrido:', e); process.exit(1); });
