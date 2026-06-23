#!/usr/bin/env node
// backfill-historico.mjs v5
// Pagina el feed en tiempo real de PLACSP hacia atrás hasta cubrir START_YEAR completo.
// Usa exactamente el mismo mecanismo que el barrido diario (que ya funciona),
// sin depender de los ZIPs históricos (que PLACSP bloquea desde GitHub Actions).

import fs from 'node:fs';

const OUTPUT_PATH  = 'data/historico_adjudicaciones.json';
const CONFIG_PATH  = 'config/accreditations.json';
const FEED_URL     = 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
const START_YEAR   = 2021;
const CUTOFF_DATE  = new Date(`${START_YEAR}-01-01T00:00:00Z`);
const SAFETY_MAX_PAGES = 500; // límite de seguridad: 500 × 500 = 250.000 entradas máx

// ---- Filtros (igual que en fetch-and-filter.mjs) ----
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

// ---- Parser (igual que en fetch-and-filter.mjs) ----
function extractText(xml, tag){
  const m=xml.match(new RegExp(`<(?:[^:>]*:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${tag}>`,'i'));
  return m?m[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim():'';
}
function extractAll(xml,tag){
  const re=new RegExp(`<(?:[^:>]*:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]*:)?${tag}>`,'gi');
  const o=[];let m;while((m=re.exec(xml))!==null)o.push(m[1].replace(/<[^>]+>/g,'').trim());return o;
}
function extractAttr(xml,tag,attr){
  const m=xml.match(new RegExp(`<(?:[^:>]*:)?${tag}[^>]*\\b${attr}="([^"]*)"`,'i'));return m?m[1]:'';
}

function parseBlock(chunk){
  const estado=(extractAttr(chunk,'ContractFolderStatusCode','listName')||extractText(chunk,'ContractFolderStatusCode')||'').toUpperCase();
  if(!['RES','ADJ'].some(s=>estado.includes(s))) return null;
  const title=extractText(chunk,'title')||extractText(chunk,'ContractTitle');
  const cpvList=extractAll(chunk,'ItemClassificationCode');
  if(!relevant(title,cpvList)) return null;
  const updated=extractText(chunk,'updated')||'';
  return {
    expediente:(extractText(chunk,'ContractFolderID')||extractText(chunk,'id')||'').trim(),
    title:title.trim(),
    organo:(extractText(chunk,'PartyName')||extractText(chunk,'name')||'').trim(),
    estado:'RES', cpv:cpvList,
    importe:parseFloat(extractText(chunk,'TaxExclusiveAmount')||extractText(chunk,'EstimatedOverallContractAmount'))||null,
    importeRaw:(extractText(chunk,'TaxExclusiveAmount')||'').trim(),
    adjudicatario:(extractText(chunk,'WinningPartyName')||extractText(chunk,'WinningTendererName')||extractText(chunk,'AwardedPartyName')||'').trim(),
    fechaAdjudicacion:(extractText(chunk,'AwardDate')||updated).trim(),
    updated:updated.trim(),
    link:((chunk.match(/rel="alternate"\s+href="([^"]+)"/)||chunk.match(/href="([^"]+)"\s+rel="alternate"/)||[])[1]||'').trim(),
    fuente:'backfill'
  };
}

function nextLink(xml){
  const m=xml.match(/<link[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i)
          ||xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']next["']/i);
  return m?m[1]:null;
}

async function fetchPage(url){
  const resp=await fetch(url,{
    headers:{'User-Agent':'Mozilla/5.0 (compatible; AGQ-Radar-Backfill/5.0)'},
    signal:AbortSignal.timeout(30000)
  });
  if(!resp.ok) throw new Error(`HTTP ${resp.status} en ${url}`);
  return resp.text();
}

async function run(){
  fs.mkdirSync('data',{recursive:true});

  // Cargar histórico existente para hacer merge
  let existing={};
  if(fs.existsSync(OUTPUT_PATH)){
    try{
      const prev=JSON.parse(fs.readFileSync(OUTPUT_PATH,'utf-8'));
      (prev.entries||[]).forEach(e=>{ existing[e.expediente]=e; });
      console.log(`Histórico previo: ${Object.keys(existing).length} entradas`);
    }catch(e){ console.warn('Sin histórico previo válido'); }
  }

  let url=FEED_URL;
  let pages=0, totalEntries=0, newFound=0;
  let oldestSeen=new Date();
  let reachedCutoff=false;

  console.log(`Paginando el feed hacia atrás hasta ${CUTOFF_DATE.toISOString().slice(0,10)}...`);

  while(url && pages<SAFETY_MAX_PAGES){
    let xml;
    try{
      xml = await fetchPage(url);
    }catch(e){
      console.warn(`Error en página ${pages+1}: ${e.message}. Reintentando en 5s...`);
      await new Promise(r=>setTimeout(r,5000));
      try{
        xml = await fetchPage(url);
      }catch(e2){
        console.error(`Fallo definitivo en página ${pages+1}: ${e2.message}`);
        break; // sale del while; xml sigue undefined pero el break evita usarlo
      }
    }
    if(!xml) break; // seguridad: si xml es undefined por cualquier razón, salir limpiamente

    const blocks = xml.match(/<entry[\s\S]*?<\/entry>/g)||[];
    totalEntries += blocks.length;
    console.log(`Página ${pages+1}: ${blocks.length} entradas en el feed`);

    for(const b of blocks){
      const updated=extractText(b,'updated');
      if(updated){
        const t=new Date(updated);
        if(!isNaN(t)&&t<oldestSeen) oldestSeen=t;
        if(t<CUTOFF_DATE){ reachedCutoff=true; break; }
      }
      const entry=parseBlock(b);
      if(entry&&entry.expediente&&!existing[entry.expediente]){
        existing[entry.expediente]=entry;
        newFound++;
      }
    }

    pages++;
    if(pages%10===0) console.log(`  Página ${pages}: ${newFound} adjudicaciones encontradas hasta ahora | más antigua vista: ${oldestSeen.toISOString().slice(0,10)}`);

    if(reachedCutoff){
      console.log(`Corte alcanzado en página ${pages}: fecha más antigua = ${oldestSeen.toISOString().slice(0,10)}`);
      break;
    }
    url=nextLink(xml);
    if(!url){ console.log(`Feed agotado en página ${pages} (no hay más entradas)`); break; }

    // Pequeña pausa para no saturar el servidor
    await new Promise(r=>setTimeout(r,500));
  }

  const allEntries=Object.values(existing)
    .sort((a,b)=>(b.fechaAdjudicacion||'').localeCompare(a.fechaAdjudicacion||''));

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
    generatedAt:new Date().toISOString(),
    fromYear:START_YEAR,
    totalPagesScanned:pages,
    totalEntriesScanned:totalEntries,
    totalEntries:allEntries.length,
    newThisRun:newFound,
    oldestSeen:oldestSeen.toISOString(),
    entries:allEntries
  },null,2));

  console.log(`\n✓ Backfill completado: ${allEntries.length} adjudicaciones (${newFound} nuevas)`);
  console.log(`  Páginas escaneadas: ${pages} | Entradas totales vistas: ${totalEntries}`);
  console.log(`  Fecha más antigua en el feed: ${oldestSeen.toISOString().slice(0,10)}`);
}

run().catch(e=>{ console.error('Error fatal:', e.stack||e); process.exit(1); });
