#!/usr/bin/env node
// backfill-historico.mjs
// Descarga los ZIPs anuales/mensuales de la sindicación 643 de PLACSP (2021-hoy),
// extrae las licitaciones adjudicadas/resueltas que coincidan con nuestros CPVs
// o palabras clave sectoriales, y genera data/historico_adjudicaciones.json.
//
// Se ejecuta UNA SOLA VEZ (o cuando se quiera actualizar manualmente). El barrido
// diario (fetch-and-filter.mjs) se encarga de mantener el histórico al día
// añadiendo las adjudicaciones nuevas incrementalmente.

import fs   from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';

// ---------- Configuración ----------
const OUTPUT_PATH  = 'data/historico_adjudicaciones.json';
const CONFIG_PATH  = 'config/accreditations.json';
const TMP_DIR      = path.join(tmpdir(), 'placsp-backfill');
const BASE_URL     = 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643';
const START_YEAR   = 2021;
const NOW          = new Date();
const CURRENT_YEAR = NOW.getFullYear();
const CURRENT_MONTH= NOW.getMonth() + 1; // 1-based

// Importar unzipper dinámicamente (disponible en entorno GitHub Actions via npm)
let unzipper;
try { unzipper = (await import('unzipper')).default; }
catch(e){ console.error('Instala unzipper: npm install unzipper'); process.exit(1); }

// ---------- Configuración de filtros ----------
const config    = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const cpvCodes  = new Set(config.cpv.map(l => (l.match(/^\d{8}/)||[])[0]).filter(Boolean));
const allKeywords = [...new Set(
  config.accreditations.flatMap(a => a.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean))
)];
const genericAmbiguous  = new Set((config.genericAmbiguous||[]).map(k=>k.toLowerCase()));
const activityKeywords  = (config.activityKeywords||[]).map(k=>k.toLowerCase());
const SUPPLY_TYPE_RE    = /\bsuministros?\s+(de|del|de\s+los|de\s+las|y|e)\b|\badquisici[oó]n\s+de\b|\bsistema\s+din[aá]mico\s+de\s+adquisici[oó]n\b|\brenting\b|\barrendamiento\b/i;
const STRONG_SERVICE_KW = ['ensayo','ensayos','análisis','analisis','analítica','analitica','control analítico','control analitico','servicio de análisis','muestreo','toma de muestra','vigilancia ambiental','auditoría ambiental','inspección ambiental','inspeccion ambiental'];

function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function kwMatch(text, kw){ return new RegExp('(^|[^a-zA-Z\u00C0-\u00FF])'+escapeRegex(kw)+'($|[^a-zA-Z\u00C0-\u00FF])','i').test(text); }

function isRelevant(title='', cpvList=[]){
  if(cpvList.some(c => cpvCodes.has(c))) return true;
  const text = title.toLowerCase();
  const matched = allKeywords.filter(k => k && kwMatch(text,k));
  if(!matched.length) return false;
  const esSuministro = SUPPLY_TYPE_RE.test(title);
  const nonAmb = matched.filter(k => !genericAmbiguous.has(k));
  if(nonAmb.length && !esSuministro) return true;
  if(esSuministro) return STRONG_SERVICE_KW.some(k => kwMatch(text,k));
  return activityKeywords.some(k => kwMatch(text,k));
}

// ---------- Parser XML mínimo (sin dependencias) ----------
function extractText(xml, tag){
  const m = xml.match(new RegExp(`<(?:[^:>]*:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${tag}>`, 'i'));
  return m ? m[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').trim() : '';
}
function extractAll(xml, tag){
  const re = new RegExp(`<(?:[^:>]*:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${tag}>`, 'gi');
  const out=[]; let m;
  while((m=re.exec(xml))!==null) out.push(m[1].replace(/<[^>]+>/g,'').trim());
  return out;
}
function extractAttr(xml, tag, attr){
  const m = xml.match(new RegExp(`<(?:[^:>]*:)?${tag}[^>]*\\b${attr}="([^"]*)"`, 'i'));
  return m ? m[1] : '';
}

function parseAtom(xml){
  const entries = [];
  const entryRe = /<entry[\s\S]*?<\/entry>/gi;
  let m;
  while((m=entryRe.exec(xml))!==null){
    const chunk = m[0];
    const estado = extractAttr(chunk,'ContractFolderStatusCode','listName') ||
                   extractText(chunk,'ContractFolderStatusCode') || '';
    if(!['RES','ADJ','RESUELTA','ADJUDICADA'].some(s=>estado.toUpperCase().includes(s))) continue;

    const title   = extractText(chunk,'title') || extractText(chunk,'ContractTitle');
    const cpvList = extractAll(chunk,'ItemClassificationCode');
    if(!isRelevant(title, cpvList)) continue;

    const expediente     = extractText(chunk,'ContractFolderID') || extractText(chunk,'id');
    const organo         = extractText(chunk,'PartyName') || extractText(chunk,'name');
    const importeRaw     = extractText(chunk,'TaxExclusiveAmount') || extractText(chunk,'EstimatedOverallContractAmount');
    const importe        = parseFloat(importeRaw) || null;
    const adjudicatario  = extractText(chunk,'ReceivedTendererQuantity') !== '' ? '' :
                           extractText(chunk,'WinningPartyName') || extractText(chunk,'WinningTendererName') ||
                           extractText(chunk,'AwardedPartyName');
    const fechaRaw       = extractText(chunk,'AwardDate') || extractText(chunk,'updated');
    const link           = (chunk.match(/rel="alternate"\s+href="([^"]+)"/)||[])[1] ||
                           (chunk.match(/href="([^"]+)"\s+rel="alternate"/)||[])[1] || '';

    entries.push({
      expediente: expediente.trim(),
      title: title.trim(),
      organo: organo.trim(),
      estado: 'RES',
      cpv: cpvList,
      importe,
      importeRaw: importeRaw.trim(),
      adjudicatario: adjudicatario.trim(),
      fechaAdjudicacion: fechaRaw.trim(),
      link: link.trim(),
      fuente: 'backfill'
    });
  }
  return entries;
}

// ---------- Descarga y procesado de un ZIP ----------
async function processZip(url, label){
  const tmpZip = path.join(TMP_DIR, label.replace(/\//g,'_') + '.zip');
  console.log(`  Descargando ${label}…`);
  const resp = await fetch(url, { headers:{ 'User-Agent':'AGQ-Radar-Backfill/1.0' } });
  if(!resp.ok){ console.warn(`  SKIP ${label}: HTTP ${resp.status}`); return []; }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(tmpZip, buf);
  console.log(`  ${label}: ${(buf.length/1024/1024).toFixed(1)} MB descargados`);

  const entries = [];
  try{
    const directory = await unzipper.Open.file(tmpZip);
    for(const file of directory.files){
      if(!file.path.endsWith('.atom')) continue;
      const content = await file.buffer();
      const xml = content.toString('utf-8');
      const parsed = parseAtom(xml);
      entries.push(...parsed);
    }
  }catch(e){ console.warn(`  Error procesando ZIP ${label}:`, e.message); }
  fs.unlinkSync(tmpZip);
  return entries;
}

// ---------- Main ----------
async function run(){
  fs.mkdirSync(TMP_DIR, { recursive:true });
  fs.mkdirSync('data', { recursive:true });

  // Cargar histórico existente (si lo hay) para hacer merge
  let existing = {};
  if(fs.existsSync(OUTPUT_PATH)){
    try{
      const prev = JSON.parse(fs.readFileSync(OUTPUT_PATH,'utf-8'));
      (prev.entries||[]).forEach(e=>{ existing[e.expediente]=e; });
      console.log(`Histórico existente: ${Object.keys(existing).length} entradas`);
    }catch(e){ console.warn('No se pudo leer el histórico existente, se crea uno nuevo'); }
  }

  let totalParsed = 0;
  let totalNew    = 0;

  // Años completos (2021 → año anterior)
  for(let year=START_YEAR; year<CURRENT_YEAR; year++){
    const url     = `${BASE_URL}/licitacionesPerfilesContratanteCompleto3_${year}.zip`;
    const entries = await processZip(url, String(year));
    totalParsed += entries.length;
    entries.forEach(e=>{
      if(!existing[e.expediente]){ existing[e.expediente]=e; totalNew++; }
    });
    console.log(`  → ${entries.length} adjudicaciones relevantes de ${year}`);
  }

  // Meses del año en curso (hasta el mes anterior)
  for(let month=1; month<CURRENT_MONTH; month++){
    const mm  = String(month).padStart(2,'0');
    const url = `${BASE_URL}/licitacionesPerfilesContratanteCompleto3_${CURRENT_YEAR}${mm}.zip`;
    const entries = await processZip(url, `${CURRENT_YEAR}/${mm}`);
    totalParsed += entries.length;
    entries.forEach(e=>{
      if(!existing[e.expediente]){ existing[e.expediente]=e; totalNew++; }
    });
    console.log(`  → ${entries.length} adjudicaciones relevantes de ${CURRENT_YEAR}/${mm}`);
  }

  const allEntries = Object.values(existing).sort((a,b)=>(b.fechaAdjudicacion||'').localeCompare(a.fechaAdjudicacion||''));
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    fromYear: START_YEAR,
    totalEntries: allEntries.length,
    newThisRun: totalNew,
    entries: allEntries
  }, null, 2));

  console.log(`\nBackfill completado: ${allEntries.length} adjudicaciones en total (${totalNew} nuevas esta ejecución)`);
}

run().catch(e=>{ console.error('Error en el backfill:', e); process.exit(1); });
