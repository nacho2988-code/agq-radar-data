#!/usr/bin/env node
// buscar-expediente.mjs
// Busca un expediente concreto de PLACSP por su ID en el feed completo (sin límite
// de ventana temporal), descarga sus pliegos, genera el resumen ejecutivo con Gemini
// y lo añade/actualiza en data/licitaciones.json — igual que si lo hubiera capturado
// el barrido diario normal.
//
// Uso: node scripts/buscar-expediente.mjs "<expediente o fragmento del título>"

import fs from 'node:fs';

const FEED_URL    = 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
const OUTPUT_PATH = 'data/licitaciones.json';
const RESUMENES_DIR = 'data/resumenes';
const GEMINI_KEY  = process.env.GEMINI_API_KEY || '';
const MAX_PAGES   = 60; // suficiente para cubrir varias semanas hacia atrás

const QUERY = process.argv[2];
if(!QUERY){
  console.error('Uso: node scripts/buscar-expediente.mjs "<expediente o texto a buscar>"');
  process.exit(1);
}

// ── Utilidades de parseo XML (idénticas al barrido normal) ──────────────────
function decodeXmlEntities(s){
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'");
}
function tag(block, name){
  const m = block.match(new RegExp(`<(?:[^:>]*:)?${name}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${name}>`,'i'));
  return m ? decodeXmlEntities(m[1].replace(/<[^>]+>/g,'').trim()) : '';
}
function allTagValues(block, name){
  const re = new RegExp(`<(?:[^:>]*:)?${name}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${name}>`,'gi');
  const out = []; let m;
  while((m = re.exec(block)) !== null) out.push(decodeXmlEntities(m[1].replace(/<[^>]+>/g,'').trim()));
  return out;
}
function attr(block, tagName, attrName){
  const m = block.match(new RegExp(`<(?:[^:>]*:)?${tagName}[^>]*\\b${attrName}=["']([^"']+)["']`,'i'));
  return m ? m[1] : '';
}
function nextLink(xml){
  const m = xml.match(/<link[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i)
         || xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']next["']/i);
  return m ? m[1] : null;
}

function parseEntryBlock(block){
  const expediente = tag(block,'ContractFolderID') || tag(block,'id');
  const estado = tag(block,'ContractFolderStatusCode');

  // El título real está dentro de <cac:ProcurementProject><cbc:Name>...
  // (el primer <Name> del bloque suele ser el del órgano contratante, no el título)
  let title = '';
  const ppMatch = block.match(/<cac:ProcurementProject[^>]*>([\s\S]*?)<\/cac:ProcurementProject>/i);
  if(ppMatch) title = tag(ppMatch[1], 'Name');
  if(!title) title = tag(block,'Name') || tag(block,'title');

  const cpv = allTagValues(block,'ItemClassificationCode').map(c=>c.trim().slice(0,8)).filter(Boolean);
  let organo = '';
  const orgM = block.match(/<cac:PartyName[^>]*>\s*<cbc:Name>([^<]+)/i);
  if(orgM) organo = decodeXmlEntities(orgM[1].trim());

  let importe = null;
  const impTags = ['TaxExclusiveAmount','TotalAmount','EstimatedOverallContractAmount'];
  for(const it of impTags){
    const v = tag(block, it);
    if(v){ const n = parseFloat(v.replace(/\./g,'').replace(',','.')); if(!isNaN(n)){ importe = n; break; } }
  }

  let deadline = '', deadlineSource = '';
  const dl = tag(block,'EndDate');
  if(dl){ deadline = dl; deadlineSource = 'fecha límite oficial'; }

  // Documentos del pliego
  const docs = [];
  const docMatches = block.match(/<cac:LegalDocumentReference[^>]*>[\s\S]*?<\/cac:LegalDocumentReference>/gi) || [];
  const techMatches = block.match(/<cac:TechnicalDocumentReference[^>]*>[\s\S]*?<\/cac:TechnicalDocumentReference>/gi) || [];
  [...docMatches.map(d=>['Pliego administrativo',d]), ...techMatches.map(d=>['Pliego técnico',d])].forEach(([label,d])=>{
    const urlM = d.match(/<cbc:URI>([^<]+)<\/cbc:URI>/i);
    if(urlM) docs.push({ label, url: decodeXmlEntities(urlM[1].trim()) });
  });

  let link = '';
  const linkM = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if(linkM) link = linkM[1];

  return { expediente, title, estado, cpv, organo, importe, deadline, deadlineSource, docs, link,
           updated: tag(block,'updated') || new Date().toISOString(), rawSummary: '' };
}

// ── Búsqueda en el feed completo ─────────────────────────────────────────────
async function buscarEnFeed(query){
  let url = FEED_URL;
  let page = 0;
  const qLower = query.toLowerCase();

  while(url && page < MAX_PAGES){
    page++;
    console.log(`Buscando en página ${page}...`);
    const resp = await fetch(url, { headers: { 'User-Agent': 'AGQ-Radar-Licitaciones/1.0' } });
    if(!resp.ok){ console.warn(`HTTP ${resp.status} en página ${page}`); break; }
    const xml = await resp.text();

    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    for(const block of entries){
      const expediente = tag(block,'ContractFolderID') || tag(block,'id');
      const title = tag(block,'Name') || tag(block,'title');
      if((expediente && expediente.toLowerCase().includes(qLower)) ||
         (title && title.toLowerCase().includes(qLower))){
        console.log(`✓ Encontrado en página ${page}: ${expediente} | ${title.slice(0,80)}`);
        return parseEntryBlock(block);
      }
    }
    url = nextLink(xml);
  }
  return null;
}

// ── Descarga de pliegos y resumen con Gemini (igual que el barrido normal) ──
async function fetchPdfBuffer(url){
  const resp = await fetch(url, { headers: { 'User-Agent': 'AGQ-Radar-Licitaciones/1.0' } });
  if(!resp.ok) throw new Error('HTTP ' + resp.status);
  return Buffer.from(await resp.arrayBuffer());
}

async function callGeminiSummary(entry, docs){
  if(!GEMINI_KEY){ console.log('⚠ GEMINI_API_KEY no configurada'); return null; }
  const parts = [];
  for(const d of docs.slice(0,2)){
    try{
      console.log(`  Descargando ${d.label}: ${d.url.slice(0,80)}...`);
      const buf = await fetchPdfBuffer(d.url);
      console.log(`  ✓ ${d.label}: ${buf.length} bytes`);
      parts.push({ inline_data: { mime_type:'application/pdf', data: buf.toString('base64') } });
    }catch(e){ console.warn(`  ✗ Error descargando ${d.label}: ${e.message}`); }
  }
  if(!parts.length){ console.log('⚠ No se pudo descargar ningún pliego'); return null; }

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
Basa todas las respuestas SOLO en el texto de los pliegos. Si una sección no tiene información, devuelve array vacío o cadena vacía.`
  });

  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ contents:[{ parts }] })
  });
  if(!resp.ok){ console.warn(`⚠ Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0,300)}`); return null; }
  const data = await resp.json();
  console.log('  Respuesta Gemini recibida, parseando...');
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = text.replace(/```json|```/g,'').trim();
  try{ return JSON.parse(clean); }catch(e){ console.warn('⚠ JSON de Gemini no parseable:', clean.slice(0,200)); return null; }
}

function escHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function generateSummaryHtml(entry, summary, docLabels){
  const fecha = new Date().toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'});
  const viabilidadColor = summary.viabilidad==='ALTA' ? '#5E8500' : summary.viabilidad==='MEDIA' ? '#C97B2E' : '#A23B3B';
  const viabilidadBg    = summary.viabilidad==='ALTA' ? '#EEF6DB' : summary.viabilidad==='MEDIA' ? '#FBEBD9' : '#F6E2DF';
  const importeStr = entry.importe != null ? entry.importe.toLocaleString('es-ES',{maximumFractionDigits:2})+' €' : 'No especificado';
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
<div class="footer"><strong>AGQ Labs</strong> &middot; Radar de Licitaciones &middot; Resumen IA (alta manual) &middot; ${escHtml(docLabels.join(', '))} &middot; Verificar siempre el pliego original &middot; ${fecha}</div>
</body></html>`;
}

function sanitizeFilename(s){ return String(s||'').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,80); }

// ── MAIN ──────────────────────────────────────────────────────────────────
async function run(){
  console.log(`Buscando "${QUERY}" en el feed completo de PLACSP (hasta ${MAX_PAGES} páginas)...`);
  const entry = await buscarEnFeed(QUERY);

  if(!entry){
    console.log('❌ No se encontró el expediente en el feed disponible (puede haberse retirado o estar fuera del histórico publicado).');
    process.exit(0);
  }

  console.log('\n=== DATOS ENCONTRADOS ===');
  console.log('Expediente:', entry.expediente);
  console.log('Título:', entry.title);
  console.log('Órgano:', entry.organo);
  console.log('Importe:', entry.importe);
  console.log('Fecha límite:', entry.deadline);
  console.log('CPV:', entry.cpv);
  console.log('Documentos del pliego:', entry.docs.length);

  // Generar resumen con Gemini si hay pliegos
  let resumenHtmlPath = null;
  if(entry.docs.length && GEMINI_KEY){
    console.log('\nGenerando resumen ejecutivo con IA...');
    const summary = await callGeminiSummary(entry, entry.docs);
    if(summary){
      fs.mkdirSync(RESUMENES_DIR, { recursive:true });
      const filename = sanitizeFilename(entry.expediente) + '.html';
      const html = generateSummaryHtml(entry, summary, entry.docs.map(d=>d.label));
      fs.writeFileSync(RESUMENES_DIR + '/' + filename, html, 'utf-8');
      resumenHtmlPath = RESUMENES_DIR + '/' + filename;
      console.log('✓ Resumen generado:', resumenHtmlPath);
    } else {
      console.log('⚠ No se pudo generar el resumen (sin respuesta válida de Gemini)');
    }
  } else if(!entry.docs.length){
    console.log('\n⚠ Sin pliegos descargables — no se puede generar resumen');
  }

  // Insertar/actualizar en el snapshot
  let snapshot = { entries: [] };
  if(fs.existsSync(OUTPUT_PATH)){
    snapshot = JSON.parse(fs.readFileSync(OUTPUT_PATH,'utf-8'));
  }

  const finalEntry = {
    ...entry,
    resumenHtmlPath,
    resumenGeneradoEn: resumenHtmlPath ? new Date().toISOString() : null,
    resumenVersion: resumenHtmlPath ? 2 : null,
    sectorTier: 'B', // alta manual confirmada por el usuario
    fuente: 'busqueda_manual'
  };

  const idx = snapshot.entries.findIndex(e => e.expediente === entry.expediente);
  if(idx >= 0) snapshot.entries[idx] = { ...snapshot.entries[idx], ...finalEntry };
  else snapshot.entries.push(finalEntry);

  snapshot.generatedAt = new Date().toISOString();
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(`\n✅ Expediente ${entry.expediente} añadido/actualizado en el snapshot (${snapshot.entries.length} entradas totales).`);
}

run().catch(e => { console.error('Error fatal:', e.stack||e); process.exit(1); });
