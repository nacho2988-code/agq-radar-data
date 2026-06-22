#!/usr/bin/env node
// backfill-historico.mjs v2 — streaming con SAX para no cargar los ZIPs en RAM
import fs      from 'node:fs';
import path    from 'node:path';
import { tmpdir } from 'node:os';
import { createWriteStream } from 'node:fs';
import { Writable, pipeline as pipelineCb } from 'node:stream';
import { promisify } from 'node:util';
const pipelineAsync = promisify(pipelineCb);

const OUTPUT_PATH  = 'data/historico_adjudicaciones.json';
const CONFIG_PATH  = 'config/accreditations.json';
const TMP_DIR      = path.join(tmpdir(), 'placsp-backfill');
const BASE_URL     = 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643';
const START_YEAR   = 2021;
const NOW          = new Date();
const CURRENT_YEAR = NOW.getFullYear();
const CURRENT_MONTH= NOW.getMonth() + 1;

// Importar unzipper (streaming)
const unzipper = (await import('unzipper')).default;

// ---- Filtros ----
const config    = JSON.parse(fs.readFileSync(CONFIG_PATH,'utf-8'));
const cpvCodes  = new Set(config.cpv.map(l=>(l.match(/^\d{8}/)||[])[0]).filter(Boolean));
const allKw     = [...new Set(config.accreditations.flatMap(a=>a.keywords.split(',').map(k=>k.trim().toLowerCase()).filter(Boolean)))];
const ambSet    = new Set((config.genericAmbiguous||[]).map(k=>k.toLowerCase()));
const actKw     = (config.activityKeywords||[]).map(k=>k.toLowerCase());
const SUPPLY_RE = /\bsuministros?\s+(de|del|de\s+los|de\s+las|y|e)\b|\badquisici[oó]n\s+de\b|\bsistema\s+din[aá]mico\s+de\s+adquisici[oó]n\b|\brenting\b|\barrendamiento\b/i;
const SVC_KW    = ['ensayo','ensayos','análisis','analisis','analítica','analitica','control analítico','muestreo','toma de muestra','vigilancia ambiental','auditoría ambiental','inspección ambiental'];

function esc(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function km(txt,k){ return new RegExp('(^|[^a-zA-Z\u00C0-\u00FF])'+esc(k)+'($|[^a-zA-Z\u00C0-\u00FF])','i').test(txt); }
function relevant(title='', cpvList=[]){
  if(cpvList.some(c=>cpvCodes.has(c))) return true;
  const t=title.toLowerCase();
  const m=allKw.filter(k=>k&&km(t,k));
  if(!m.length) return false;
  const isS=SUPPLY_RE.test(title);
  const nA=m.filter(k=>!ambSet.has(k));
  if(nA.length&&!isS) return true;
  if(isS) return SVC_KW.some(k=>km(t,k));
  return actKw.some(k=>km(t,k));
}

// ---- Parser XML mínimo en modo chunk (sin SAX externo) ----
// Procesa el XML en chunks buscando bloques <entry>...</entry>
class EntryExtractor extends Writable {
  constructor(onEntry){ super(); this._buf=''; this._onEntry=onEntry; }
  _write(chunk,enc,cb){
    this._buf += chunk.toString('utf-8');
    let start;
    while((start=this._buf.indexOf('<entry'))!==-1){
      const end=this._buf.indexOf('</entry>',start);
      if(end===-1) break;
      const block=this._buf.slice(start, end+8);
      this._buf=this._buf.slice(end+8);
      this._onEntry(block);
    }
    // Evitar acumulación infinita si no hay entries
    if(this._buf.length>2_000_000) this._buf=this._buf.slice(-500_000);
    cb();
  }
}

function txt(xml,tag){ const m=xml.match(new RegExp(`<(?:[^:>]*:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${tag}>`,'i')); return m?m[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim():''; }
function all(xml,tag){ const re=new RegExp(`<(?:[^:>]*:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${tag}>`,'gi'); const o=[];let m; while((m=re.exec(xml))!==null) o.push(m[1].replace(/<[^>]+>/g,'').trim()); return o; }
function atr(xml,tag,at){ const m=xml.match(new RegExp(`<(?:[^:>]*:)?${tag}[^>]*\\b${at}="([^"]*)"`,'i')); return m?m[1]:''; }

function parseEntry(chunk){
  const estado=(atr(chunk,'ContractFolderStatusCode','listName')||txt(chunk,'ContractFolderStatusCode')||'').toUpperCase();
  if(!['RES','ADJ','RESUELTA','ADJUDICADA'].some(s=>estado.includes(s))) return null;
  const title=txt(chunk,'title')||txt(chunk,'ContractTitle');
  const cpvList=all(chunk,'ItemClassificationCode');
  if(!relevant(title,cpvList)) return null;
  return {
    expediente:(txt(chunk,'ContractFolderID')||txt(chunk,'id')||'').trim(),
    title:title.trim(),
    organo:(txt(chunk,'PartyName')||txt(chunk,'name')||'').trim(),
    estado:'RES', cpv:cpvList,
    importe:parseFloat(txt(chunk,'TaxExclusiveAmount')||txt(chunk,'EstimatedOverallContractAmount'))||null,
    importeRaw:(txt(chunk,'TaxExclusiveAmount')||'').trim(),
    adjudicatario:(txt(chunk,'WinningPartyName')||txt(chunk,'WinningTendererName')||txt(chunk,'AwardedPartyName')||'').trim(),
    fechaAdjudicacion:(txt(chunk,'AwardDate')||txt(chunk,'updated')||'').trim(),
    link:((chunk.match(/rel="alternate"\s+href="([^"]+)"/)||chunk.match(/href="([^"]+)"\s+rel="alternate"/)||[])[1]||'').trim(),
    fuente:'backfill'
  };
}

// ---- Descarga y procesa un ZIP en streaming ----
async function processZip(url, label, existingIds){
  console.log(`  Descargando ${label}…`);
  const resp = await fetch(url, {
    headers:{'User-Agent':'Mozilla/5.0 (compatible; AGQ-Radar-Backfill/2.0)'},
    signal: AbortSignal.timeout(300_000) // 5 min por ZIP
  });
  if(!resp.ok){ console.warn(`  SKIP ${label}: HTTP ${resp.status}`); return []; }
  const sizeMB = (parseInt(resp.headers.get('content-length')||'0')/1024/1024).toFixed(0);
  console.log(`  ${label}: ~${sizeMB} MB`);

  const tmpZip = path.join(TMP_DIR, label.replace(/\//g,'_')+'.zip');
  const writer = createWriteStream(tmpZip);
  // Descargar a disco en streaming (evita cargar todo en RAM)
  const reader = resp.body.getReader();
  while(true){
    const {done,value}=await reader.read();
    if(done) break;
    await new Promise((res,rej)=>{ writer.write(value,err=>err?rej(err):res()); });
  }
  await new Promise(res=>writer.end(res));
  console.log(`  ${label}: descarga completa`);

  const entries = [];
  try{
    const directory = await unzipper.Open.file(tmpZip);
    for(const file of directory.files){
      if(!file.path.endsWith('.atom')) continue;
      // Stream del contenido del atom dentro del ZIP
      await new Promise((resolve,reject)=>{
        const extractor = new EntryExtractor(chunk=>{
          const entry=parseEntry(chunk);
          if(entry && entry.expediente && !existingIds.has(entry.expediente)){
            existingIds.add(entry.expediente);
            entries.push(entry);
          }
        });
        file.stream().pipe(extractor).on('finish',resolve).on('error',reject);
      });
    }
  }catch(e){ console.warn(`  Error procesando ${label}:`,e.message); }
  try{ fs.unlinkSync(tmpZip); }catch(e){}
  return entries;
}

async function run(){
  fs.mkdirSync(TMP_DIR,{recursive:true});
  fs.mkdirSync('data',{recursive:true});

  let existing={};
  const existingIds=new Set();
  if(fs.existsSync(OUTPUT_PATH)){
    try{
      const prev=JSON.parse(fs.readFileSync(OUTPUT_PATH,'utf-8'));
      (prev.entries||[]).forEach(e=>{ existing[e.expediente]=e; existingIds.add(e.expediente); });
      console.log(`Histórico previo: ${existingIds.size} entradas`);
    }catch(e){ console.warn('Sin histórico previo'); }
  }

  let totalNew=0;

  // Años completos 2021 → año anterior
  for(let year=START_YEAR; year<CURRENT_YEAR; year++){
    const url=`${BASE_URL}/licitacionesPerfilesContratanteCompleto3_${year}.zip`;
    const entries=await processZip(url, String(year), existingIds);
    entries.forEach(e=>{ existing[e.expediente]=e; totalNew++; });
    console.log(`  → ${entries.length} nuevas adjudicaciones de ${year}`);
  }

  // Meses del año en curso hasta el anterior
  for(let month=1; month<CURRENT_MONTH; month++){
    const mm=String(month).padStart(2,'0');
    const url=`${BASE_URL}/licitacionesPerfilesContratanteCompleto3_${CURRENT_YEAR}${mm}.zip`;
    const entries=await processZip(url,`${CURRENT_YEAR}/${mm}`,existingIds);
    entries.forEach(e=>{ existing[e.expediente]=e; totalNew++; });
    console.log(`  → ${entries.length} nuevas adjudicaciones de ${CURRENT_YEAR}/${mm}`);
  }

  const allEntries=Object.values(existing).sort((a,b)=>(b.fechaAdjudicacion||'').localeCompare(a.fechaAdjudicacion||''));
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
    generatedAt:new Date().toISOString(),
    fromYear:START_YEAR,
    totalEntries:allEntries.length,
    newThisRun:totalNew,
    entries:allEntries
  },null,2));

  console.log(`\n✓ Backfill completado: ${allEntries.length} adjudicaciones (${totalNew} nuevas esta ejecución)`);
}

run().catch(e=>{ console.error('Error fatal:', e); process.exit(1); });
