#!/usr/bin/env node
// backfill-historico.mjs v4 — usa ZIPs MENSUALES para todos los años (más pequeños, más fiables)
import fs      from 'node:fs';
import path    from 'node:path';
import { tmpdir } from 'node:os';
import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';

const OUTPUT_PATH  = 'data/historico_adjudicaciones.json';
const CONFIG_PATH  = 'config/accreditations.json';
const TMP_DIR      = path.join(tmpdir(), 'placsp-backfill');
const BASE_URL     = 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643';
const START_YEAR   = 2021;
const NOW          = new Date();
const CURRENT_YEAR = NOW.getFullYear();
const CURRENT_MONTH= NOW.getMonth() + 1;
const DL_TIMEOUT_MS = 8 * 60 * 1000; // 8 min por ZIP mensual

const unzipper = (await import('unzipper')).default;

// ---- Filtros ----
const config   = JSON.parse(fs.readFileSync(CONFIG_PATH,'utf-8'));
const cpvCodes = new Set(config.cpv.map(l=>(l.match(/^\d{8}/)||[])[0]).filter(Boolean));
const allKw    = [...new Set(config.accreditations.flatMap(a=>a.keywords.split(',').map(k=>k.trim().toLowerCase()).filter(Boolean)))];
const ambSet   = new Set((config.genericAmbiguous||[]).map(k=>k.toLowerCase()));
const actKw    = (config.activityKeywords||[]).map(k=>k.toLowerCase());
const SUPPLY_RE= /\bsuministros?\s+(de|del|de\s+los|de\s+las|y|e)\b|\badquisici[oó]n\s+de\b|\bsistema\s+din[aá]mico\s+de\s+adquisici[oó]n\b|\brenting\b|\barrendamiento\b/i;
const SVC_KW   = ['ensayo','ensayos','análisis','analisis','analítica','muestreo','toma de muestra','vigilancia ambiental','inspección ambiental','auditoría ambiental'];

function esc(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function km(txt,k){ return new RegExp('(^|[^a-zA-Z\u00C0-\u00FF])'+esc(k)+'($|[^a-zA-Z\u00C0-\u00FF])','i').test(txt); }
function relevant(title='',cpvList=[]){
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

class EntryExtractor extends Writable {
  constructor(onEntry){ super(); this._buf=''; this._fn=onEntry; }
  _write(chunk,enc,cb){
    this._buf+=chunk.toString('utf-8');
    let s;
    while((s=this._buf.indexOf('<entry'))!==-1){
      const e=this._buf.indexOf('</entry>',s);
      if(e===-1) break;
      this._fn(this._buf.slice(s,e+8));
      this._buf=this._buf.slice(e+8);
    }
    if(this._buf.length>2_000_000) this._buf=this._buf.slice(-200_000);
    cb();
  }
}

function txt(x,t){ const m=x.match(new RegExp(`<(?:[^:>]*:)?${t}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${t}>`,'i')); return m?m[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim():''; }
function all(x,t){ const re=new RegExp(`<(?:[^:>]*:)?${t}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${t}>`,'gi');const o=[];let m;while((m=re.exec(x))!==null)o.push(m[1].replace(/<[^>]+>/g,'').trim());return o; }
function atr(x,t,a){ const m=x.match(new RegExp(`<(?:[^:>]*:)?${t}[^>]*\\b${a}="([^"]*)"`,'i'));return m?m[1]:''; }

function parseEntry(chunk){
  const estado=(atr(chunk,'ContractFolderStatusCode','listName')||txt(chunk,'ContractFolderStatusCode')||'').toUpperCase();
  if(!['RES','ADJ'].some(s=>estado.includes(s))) return null;
  const title=txt(chunk,'title')||txt(chunk,'ContractTitle');
  const cpvList=all(chunk,'ItemClassificationCode');
  if(!relevant(title,cpvList)) return null;
  return {
    expediente:(txt(chunk,'ContractFolderID')||txt(chunk,'id')||'').trim(),
    title:title.trim(),
    organo:(txt(chunk,'PartyName')||txt(chunk,'name')||'').trim(),
    estado:'RES', cpv:cpvList,
    importe:parseFloat(txt(chunk,'TaxExclusiveAmount')||txt(chunk,'EstimatedOverallContractAmount'))||null,
    adjudicatario:(txt(chunk,'WinningPartyName')||txt(chunk,'WinningTendererName')||txt(chunk,'AwardedPartyName')||'').trim(),
    fechaAdjudicacion:(txt(chunk,'AwardDate')||txt(chunk,'updated')||'').trim(),
    link:((chunk.match(/rel="alternate"\s+href="([^"]+)"/)||chunk.match(/href="([^"]+)"\s+rel="alternate"/)||[])[1]||'').trim(),
    fuente:'backfill'
  };
}

async function downloadToFile(url, dest){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), DL_TIMEOUT_MS);
  try{
    const resp = await fetch(url, {
      headers:{ 'User-Agent':'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0' },
      signal: ctrl.signal
    });
    if(!resp.ok){ clearTimeout(timer); return { ok:false, status:resp.status }; }
    const writer = createWriteStream(dest);
    const reader = resp.body.getReader();
    let bytes=0;
    while(true){
      const {done,value}=await reader.read();
      if(done) break;
      bytes+=value.length;
      await new Promise((res,rej)=>writer.write(value,e=>e?rej(e):res()));
    }
    await new Promise(res=>writer.end(res));
    clearTimeout(timer);
    return { ok:true, bytes };
  }catch(e){
    clearTimeout(timer);
    return { ok:false, error:e.message };
  }
}

async function processZip(url, label, existingIds){
  const tmpZip = path.join(TMP_DIR, label.replace(/\//g,'_')+'.zip');
  const dl = await downloadToFile(url, tmpZip);
  if(!dl.ok){
    if(dl.status===404) return { entries:[], skipped:true };
    console.warn(`  [${label}] SKIP: ${dl.error||'HTTP '+dl.status}`);
    return { entries:[], skipped:true };
  }
  console.log(`  [${label}] ${(dl.bytes/1024/1024).toFixed(1)} MB descargados`);

  const entries=[];
  try{
    const directory = await unzipper.Open.file(tmpZip);
    for(const file of directory.files){
      if(!file.path.endsWith('.atom')) continue;
      await new Promise((resolve,reject)=>{
        const extractor=new EntryExtractor(chunk=>{
          const entry=parseEntry(chunk);
          if(entry&&entry.expediente&&!existingIds.has(entry.expediente)){
            existingIds.add(entry.expediente);
            entries.push(entry);
          }
        });
        file.stream().pipe(extractor).on('finish',resolve).on('error',reject);
      });
    }
  }catch(e){ console.warn(`  [${label}] Error procesando ZIP: ${e.message}`); }
  try{ fs.unlinkSync(tmpZip); }catch(e){}
  return { entries, skipped:false };
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
    }catch(e){ console.warn('Sin histórico previo válido'); }
  }

  let totalNew=0, totalSkipped=0;

  // Iterar mes a mes desde START_YEAR hasta el mes anterior al actual
  for(let year=START_YEAR; year<=CURRENT_YEAR; year++){
    const lastMonth = (year===CURRENT_YEAR) ? CURRENT_MONTH-1 : 12;
    for(let month=1; month<=lastMonth; month++){
      const mm=String(month).padStart(2,'0');
      const label=`${year}/${mm}`;
      const url=`${BASE_URL}/licitacionesPerfilesContratanteCompleto3_${year}${mm}.zip`;
      const { entries, skipped } = await processZip(url, label, existingIds);
      if(skipped && entries.length===0) continue; // 404: mes sin datos todavía
      entries.forEach(e=>{ existing[e.expediente]=e; totalNew++; });
      if(entries.length>0) console.log(`  [${label}] → ${entries.length} nuevas adjudicaciones`);
    }
    console.log(`Año ${year} completado. Total acumulado: ${Object.keys(existing).length}`);
  }

  const allEntries=Object.values(existing)
    .sort((a,b)=>(b.fechaAdjudicacion||'').localeCompare(a.fechaAdjudicacion||''));

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
    generatedAt:new Date().toISOString(),
    fromYear:START_YEAR,
    totalEntries:allEntries.length,
    newThisRun:totalNew,
    entries:allEntries
  },null,2));

  console.log(`\n✓ Backfill completado: ${allEntries.length} adjudicaciones (${totalNew} nuevas, ${totalSkipped} meses sin datos)`);
}

run().catch(e=>{ console.error('Error fatal:', e.stack||e); process.exit(1); });
