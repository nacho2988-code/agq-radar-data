#!/usr/bin/env node
// procesar-zip-local.mjs
// Recibe un ZIP de PLACSP como argumento, extrae las adjudicaciones relevantes
// por CPV y las merge con data/historico_adjudicaciones.json
// Uso: node scripts/procesar-zip-local.mjs <path-al-zip> <anyo>

import fs   from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ZIP_PATH   = process.argv[2];
const YEAR_LABEL = process.argv[3] || 'backfill';
const OUTPUT     = 'data/historico_adjudicaciones.json';
const CONFIG     = 'config/accreditations.json';

if(!ZIP_PATH){ console.error('Uso: node procesar-zip-local.mjs <zip> <año>'); process.exit(1); }

const unzipper = (await import('unzipper')).default;
const config   = JSON.parse(fs.readFileSync(CONFIG,'utf-8'));
const CPV_SET  = new Set(config.cpv.map(l=>(l.match(/^\d{8}/)||[])[0]).filter(Boolean));
const allKw    = [...new Set(config.accreditations.flatMap(a=>a.keywords.split(',').map(k=>k.trim().toLowerCase()).filter(Boolean)))];
const ambSet   = new Set((config.genericAmbiguous||[]).map(k=>k.toLowerCase()));
const actKw    = (config.activityKeywords||[]).map(k=>k.toLowerCase());
const SUPPLY   = /\bsuministros?\s+(de|del)\b|\badquisici[oó]n\s+de\b/i;
const SVC_KW   = ['ensayo','ensayos','análisis','analisis','muestreo','toma de muestra','vigilancia ambiental','inspección ambiental'];

function esc(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function km(t,k){ return new RegExp('(^|[^a-zA-Z\u00C0-\u00FF])'+esc(k)+'($|[^a-zA-Z\u00C0-\u00FF])','i').test(t); }
function relevant(title='',cpvs=[]){
  if(cpvs.some(c=>CPV_SET.has(c))) return true;
  const t=title.toLowerCase();
  const m=allKw.filter(k=>k&&km(t,k));
  if(!m.length) return false;
  const isS=SUPPLY.test(title);
  const nA=m.filter(k=>!ambSet.has(k));
  if(nA.length&&!isS) return true;
  if(isS) return SVC_KW.some(k=>km(t,k));
  return actKw.some(k=>km(t,k));
}

function txt(x,t){ const m=x.match(new RegExp(`<(?:[^:>]*:)?${t}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${t}>`,'i')); return m?m[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim():''; }
function all(x,t){ const re=new RegExp(`<(?:[^:>]*:)?${t}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${t}>`,'gi');const o=[];let m;while((m=re.exec(x))!==null)o.push(m[1].replace(/<[^>]+>/g,'').trim());return o; }

function parseEntry(chunk){
  const estado=(txt(chunk,'ContractFolderStatusCode')||'').toUpperCase();
  if(!['RES','ADJ'].includes(estado)) return null;
  const cpvs=all(chunk,'ItemClassificationCode').map(c=>c.slice(0,8));
  const title=txt(chunk,'Name')||txt(chunk,'title')||'';
  if(!relevant(title,cpvs)) return null;
  let adj='', imp=null, fecha='';
  const tr=chunk.match(/<cac:TenderResult[^>]*>([\s\S]*?)<\/cac:TenderResult>/i);
  if(tr){
    const wp=tr[1].match(/<[^>]*WinningParty[^>]*>([\s\S]*?)<\/[^>]*WinningParty>/i);
    if(wp) adj=txt(wp[1],'Name')||txt(wp[1],'PartyName')||'';
    if(!adj) adj=txt(tr[1],'WinningTendererName')||'';
    const amt=txt(tr[1],'PayableAmount')||txt(tr[1],'TaxExclusiveAmount')||'';
    if(amt){ const n=parseFloat(amt.replace(',','.')); if(!isNaN(n)) imp=n; }
    fecha=txt(tr[1],'AwardDate')||'';
  }
  if(!adj) return null;
  return {
    expediente:(txt(chunk,'ContractFolderID')||'').trim(),
    title:title.trim().slice(0,200),
    organo:(chunk.match(/PartyName[^>]*>[\s\S]*?<cbc:Name>([^<]+)/i)||['',''])[1].trim().slice(0,150),
    estado:'RES', cpv:cpvs, importe:imp,
    adjudicatario:adj.trim().slice(0,150),
    fechaAdjudicacion:fecha.trim(), fuente:'backfill'
  };
}

// Cargar histórico previo
let existing={};
let prevYears=[];
if(fs.existsSync(OUTPUT)){
  const prev=JSON.parse(fs.readFileSync(OUTPUT,'utf-8'));
  (prev.entries||[]).forEach(e=>{ if(e.expediente) existing[e.expediente]=e; });
  prevYears=prev.years||[];
  console.log(`Histórico previo: ${Object.keys(existing).length} entradas, años: ${prevYears}`);
}

// Procesar el ZIP
let newFound=0, scanned=0;
const directory = await unzipper.Open.file(ZIP_PATH);
const atoms = directory.files.filter(f=>f.path.endsWith('.atom'));
console.log(`Ficheros atom en el ZIP: ${atoms.length}`);

for(let i=0; i<atoms.length; i++){
  const buf = await atoms[i].buffer();
  const xml = buf.toString('utf-8');
  const blocks = xml.match(/<entry[\s\S]*?<\/entry>/g)||[];
  scanned+=blocks.length;
  for(const b of blocks){
    const e=parseEntry(b);
    if(e&&e.expediente&&!existing[e.expediente]){ existing[e.expediente]=e; newFound++; }
  }
  if((i+1)%200===0) console.log(`  ${i+1}/${atoms.length} | ${scanned.toLocaleString()} escaneadas | ${newFound} nuevas`);
}

const years=[...new Set([...prevYears, parseInt(YEAR_LABEL)||new Date().getFullYear()])].sort();
const all_entries=Object.values(existing).sort((a,b)=>(b.fechaAdjudicacion||'').localeCompare(a.fechaAdjudicacion||''));
fs.writeFileSync(OUTPUT, JSON.stringify({generatedAt:new Date().toISOString(), years, totalEntries:all_entries.length, newThisRun:newFound, entries:all_entries},null,2));
console.log(`\n✓ ${all_entries.length} adjudicaciones totales (${newFound} nuevas de ${YEAR_LABEL})`);
