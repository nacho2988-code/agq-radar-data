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

// Motor v2: pre-calcular sets de CPVs y keywords para eficiencia
const CPV_NIVEL_A  = new Set((config.cpvNivelA || []).map(l=>(l.match(/^\d{8}/)||[])[0]).filter(Boolean));
const CPV_NIVEL_B  = new Set((config.cpvNivelB || []).map(l=>(l.match(/^\d{8}/)||[])[0]).filter(Boolean));
const KW_FUERTES_B = (config.keywordsFuertesNivelB || []).map(k=>k.toLowerCase());
const KW_NIVEL_C   = (config.keywordsNivelC || []).map(k=>k.toLowerCase());

// Compatibilidad: cpvCodes = unión de A+B para funciones auxiliares
const cpvCodes = [...CPV_NIVEL_A, ...CPV_NIVEL_B];

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
const SUPPLY_TYPE_RE = /\bsuministros?\s*(,|\s+y|\s+de|\s+e\s|\s+instalaci|\s+montaje|\s+puesta|\s+mantenimiento|\s+reparaci)|\badquisici[oó]n\s+de\b|\bsistema\s+din[aá]mico\s+de\s+adquisici[oó]n\b|\brenting\b|\barrendamiento\b/i;

// Palabras que indican contratos claramente fuera del sector AGQ
const OUT_OF_SCOPE_RE = /\bveh[ií]culos?\b|\bautom[oó]viles?\b|\bturismos?\b|\bcamiones?\b|\bcombustible\b|\bpapeler[ií]a\b|\bmobiliario\b|\bvestuario\b|\buniformes?\b|\bcatering\b|\balimentaci[oó]n\s+(para|de\s+comedor)\b|\bservicio\s+de\s+limpieza\s+(de\s+(?!aguas|agua|suelos?|contaminaci))\b|\bseguridad\s+privada\b|\bvigilancia\s+privada\b|\bmantenimiento\s+de\s+(edificios?|instalaciones?\s+eléctricas?|ascensores?|la\s+climatizaci[oó]n)\b|\bobras?\s+de\s+(construcci[oó]n|reforma|rehabilitaci[oó]n|urbanizaci[oó]n)\b|\bservicio\s+de\s+mensajer[ií]a\b|\btransporte\s+y\s+reparto\s+de\s+(documentaci[oó]n|paqueter[ií]a)\b|\bmonitorización\s+ambiental\s+(ip|para\s+el\s+centro|de\s+centros?)\b|monitorización\s+ambiental\s+ip\b/i;
const STRONG_SERVICE_KEYWORDS = ['ensayo','ensayos','análisis','analisis','analítica','analitica','control analítico','control analitico','servicio de análisis','externalizacion','externalización','subcontratacion','subcontratación','muestreo','toma de muestra','vigilancia ambiental','auditoría ambiental','auditoria ambiental','evaluación ambiental','evaluacion ambiental','inspección ambiental','inspeccion ambiental'];

// ── Motor de filtrado v2: 3 niveles de confianza ─────────────────────────────
// Devuelve 'A' | 'B' | 'C' | null
function getSectorTier(entry){
  const title = (entry.title || '').toLowerCase();
  const cpvs  = new Set(entry.cpv || []);
  if(OUT_OF_SCOPE_RE.test(entry.title)) return null;

  // NIVEL A: CPV muy específico → siempre relevante
  if([...cpvs].some(c => CPV_NIVEL_A.has(c))) return 'A';

  // NIVEL B: CPV amplio + keyword fuerte
  const tieneCpvB = [...cpvs].some(c => CPV_NIVEL_B.has(c));
  const tieneKwB  = KW_FUERTES_B.some(k => title.includes(k));
  if(tieneCpvB && tieneKwB) return 'B';
  if(tieneCpvB) return null; // CPV B sin keyword → descartar

  // NIVEL C: solo keywords muy específicas
  if(KW_NIVEL_C.some(k => title.includes(k))) return 'C';

  return null;
}

function isSectorRelevant(entry){
  return getSectorTier(entry) !== null;
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



// === [MOD:HTML-SUMMARY] ===
function escHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function generateSummaryHtml(entry, summary, docLabels){
  const fecha = new Date().toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'});
  const viabilidadColor = summary.viabilidad==='ALTA' ? '#5E8500' : summary.viabilidad==='MEDIA' ? '#C97B2E' : '#A23B3B';
  const viabilidadBg    = summary.viabilidad==='ALTA' ? '#EEF6DB' : summary.viabilidad==='MEDIA' ? '#FBEBD9' : '#F6E2DF';
  const importeStr = entry.importe != null ? entry.importe.toLocaleString('es-ES',{maximumFractionDigits:2})+' €' : (entry.importeRaw||'No especificado');
  const deadlineStr = entry.deadline ? new Date(entry.deadline).toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'}) : 'No especificada';

  function section(title, items, color, dotColor){
    if(!items||!items.length) return '';
    return `<div class="section"><h3 style="color:${color};border-bottom:2px solid ${color};">${escHtml(title)}</h3><ul style="--dot:${dotColor||color};">${items.map(i=>`<li>${escHtml(i)}</li>`).join('')}</ul></div>`;
  }

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Resumen · ${escHtml(entry.expediente)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#1A1830;background:#F7F6F3;line-height:1.5;}
.header{background:linear-gradient(135deg,#1A1830 0%,#2D2B4E 60%,#3C3A6B 100%);color:#fff;padding:18px 32px;display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #84BD00;}
.header .brand{font-size:18px;font-weight:700;}.header .sub{font-size:9px;color:#84BD00;letter-spacing:2px;text-transform:uppercase;margin-top:2px;}
.header .line{width:80px;height:2px;background:#84BD00;margin-top:4px;}
.header-right{text-align:right;font-size:10px;color:rgba(255,255,255,.6);}
.header-right strong{color:#84BD00;font-size:11px;display:block;margin-bottom:2px;}
.content{max-width:860px;margin:0 auto;padding:28px 32px;}
h1{font-size:20px;font-weight:700;color:#1A1830;line-height:1.3;margin-bottom:6px;}
.meta{font-size:11px;color:#5A5870;margin-bottom:16px;}
.divider{height:1px;background:#E0DED8;margin-bottom:18px;}
.ficha{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#E0DED8;border-radius:8px;overflow:hidden;margin-bottom:18px;}
.ficha-cell{background:#fff;padding:13px 16px;}
.ficha-cell label{font-size:9px;font-weight:700;color:#565294;text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:3px;}
.ficha-cell .val{font-size:17px;font-weight:700;}
.viabilidad{border-radius:8px;padding:11px 15px;margin-bottom:18px;border-left:4px solid ${viabilidadColor};background:${viabilidadBg};}
.viabilidad strong{color:${viabilidadColor};font-size:12px;}
.viabilidad p{font-size:12px;color:#1A1830;margin-top:3px;}
.objeto{background:#fff;border-left:4px solid #84BD00;padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:18px;font-size:13px;line-height:1.6;box-shadow:0 1px 3px rgba(0,0,0,.06);}
.section{background:#fff;border-radius:8px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);}
.section h3{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding-bottom:8px;margin-bottom:8px;}
.section ul{list-style:none;padding:0;}
.section ul li{padding:5px 0 5px 14px;border-bottom:1px solid #F0EEE8;position:relative;font-size:12.5px;}
.section ul li:last-child{border-bottom:none;}
.section ul li::before{content:'';position:absolute;left:0;top:11px;width:6px;height:6px;border-radius:1px;background:var(--dot,#565294);}
.footer{background:#1A1830;color:rgba(255,255,255,.4);font-size:10px;text-align:center;padding:12px 32px;border-top:3px solid #84BD00;margin-top:20px;}
.footer strong{color:rgba(255,255,255,.7);}
@media print{body{background:#fff;}.header,.footer{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}
</style></head><body>
<div class="header">
  <div><div class="brand">AGQ LABS</div><div class="sub">Technological Services</div><div class="line"></div></div>
  <div class="header-right"><strong>RESUMEN EJECUTIVO</strong>Licitación Pública · PLACSP</div>
</div>
<div class="content">
  <h1>${escHtml(entry.title)}</h1>
  <div class="meta">Expediente <strong>${escHtml(entry.expediente)}</strong>${entry.organo?' &middot; '+escHtml(entry.organo):''}</div>
  <div class="divider"></div>
  <div class="ficha">
    <div class="ficha-cell"><label>Presupuesto de licitación</label><div class="val">${escHtml(importeStr)}</div></div>
    <div class="ficha-cell"><label>Fecha límite de presentación</label><div class="val">${escHtml(deadlineStr)}</div></div>
  </div>
  ${summary.viabilidad?`<div class="viabilidad"><strong>VIABILIDAD PARA AGQ: ${escHtml(summary.viabilidad)}</strong>${summary.viabilidad_justificacion?`<p>${escHtml(summary.viabilidad_justificacion)}</p>`:''}  </div>`:''}
  ${summary.descripcion_objeto?`<div class="objeto">${escHtml(summary.descripcion_objeto)}</div>`:''}
  ${section('Criterios de valoración',summary.criterios_valoracion,'#565294')}
  ${section('Aspectos administrativos clave',summary.aspectos_administrativos,'#565294')}
  ${section('Aspectos técnicos requeridos',summary.aspectos_tecnicos,'#565294')}
  ${section('Parámetros y matrices',summary.parametros_matrices,'#5E8500','#84BD00')}
  ${section('Acreditaciones exigidas',summary.acreditaciones_exigidas,'#5E8500','#84BD00')}
  ${section('Plazos y garantías',summary.plazos_garantias,'#6B7280','#9896B0')}
  ${summary.riesgos_para_agq?.length?section('Riesgos / aspectos a verificar para AGQ',summary.riesgos_para_agq,'#A23B3B'):''}
</div>
<div class="footer"><strong>AGQ Labs</strong> &middot; Radar de Licitaciones &middot; Resumen IA · ${escHtml(docLabels.join(', '))} &middot; Verificar siempre el pliego original &middot; ${fecha}</div>
</body></html>`;
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
    if(!e.resumenHtmlPath) return true;
    if(!e.resumenVersion || e.resumenVersion < 2) return true;
    return false;
  }); // sin límite — regeneración completa
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
      const filename = sanitizeFilename(entry.expediente) + '.html';
      const htmlContent = generateSummaryHtml(entry, summary, docs.map(d=>d.label));
      fs.writeFileSync(RESUMENES_DIR + '/' + filename, htmlContent, 'utf-8');
      entry.resumenHtmlPath = RESUMENES_DIR + '/' + filename;
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
        if(isSectorRelevant(entry)) relevant.push({ ...entry, sectorTier: getSectorTier(entry) });
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

  // Recalcular tier en entradas existentes (pueden ser del motor v1 sin tier)
  existing = existing.map(e => ({
    ...e,
    sectorTier: e.sectorTier || getSectorTier(e)
  }));

  const byId = new Map(existing.map(e => [e.expediente, e]));
  relevant.forEach(e => {
    const prev = byId.get(e.expediente);
    if(prev && prev.resumenHtmlPath){
      e.resumenHtmlPath = prev.resumenHtmlPath;
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
