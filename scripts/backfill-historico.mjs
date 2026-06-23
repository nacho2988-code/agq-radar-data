#!/usr/bin/env node
// backfill-historico.mjs v7 — Apispain con esquema real de la API
import fs from 'node:fs';

const OUTPUT_PATH  = 'data/historico_adjudicaciones.json';
const CONFIG_PATH  = 'config/accreditations.json';
const APISPAIN_KEY = process.env.APISPAIN_KEY || '';
const BASE_URL     = 'https://api.apispain.es/v1/place/licitaciones';
const START_YEAR   = 2021;
const DELAY_MS     = 7000; // ~8 req/min para no superar el límite de 10/min del plan Free

if(!APISPAIN_KEY){ console.error('Falta APISPAIN_KEY en las variables de entorno'); process.exit(1); }

const config   = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const cpvCodes = [...new Set(config.cpv.map(l=>(l.match(/^\d{8}/)||[])[0]).filter(Boolean))];
console.log(`CPVs a consultar: ${cpvCodes.length}`);

async function fetchPage(cpv, page){
  // Probamos sin filtro de estado para ver todos los campos y luego filtramos localmente
  const url = `${BASE_URL}?cpv=${cpv}&page=${page}&limit=50`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${APISPAIN_KEY}`, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  if(resp.status === 429){
    console.log('  Rate limit: esperar 60s...');
    await new Promise(r => setTimeout(r, 62000));
    return fetchPage(cpv, page); // reintentar
  }
  if(!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text().then(t=>t.slice(0,200))}`);
  return resp.json();
}

function isAdjudicada(item){
  // Detectar si está adjudicada/resuelta en base a los campos disponibles
  const estado = (item.estado || item.status || item.estadoContrato || '').toLowerCase();
  const adjudicatario = item.adjudicatario || item.empresaAdjudicataria ||
                        item.adjudicatarioNombre || item.ganador || '';
  const fechaAdj = item.fechaAdjudicacion || item.fechaResolucion || item.fechaFormalizacion || '';
  // Si tiene adjudicatario o fecha de adjudicación: es adjudicada
  if(adjudicatario) return true;
  if(fechaAdj) return true;
  // Si el estado indica resolución
  if(['res','adj','resuelta','adjudicada','formalizada','resolucion'].some(s => estado.includes(s))) return true;
  return false;
}

function normalize(item, cpv){
  const adjudicatario = (item.adjudicatario || item.empresaAdjudicataria ||
                         item.adjudicatarioNombre || item.ganador || '').trim();
  const fechaAdj = (item.fechaAdjudicacion || item.fechaResolucion ||
                    item.fechaFormalizacion || item.fechaPublicacion || '').trim();
  const importe = parseFloat(item.importeAdjudicacion || item.importeContrato ||
                              item.presupuesto || item.importeBase || '') || null;
  return {
    expediente: (item.placeId || item.expediente || item.id || item.numeroExpediente || '').trim(),
    title: (item.objeto || item.titulo || item.title || item.descripcion || '').trim(),
    organo: (item.organoContratante || item.organo || item.entidad || '').trim(),
    estado: 'RES',
    cpv: item.cpvCodigos || item.cpv ? (item.cpvCodigos || [item.cpv]) : [cpv],
    importe,
    adjudicatario,
    fechaAdjudicacion: fechaAdj,
    link: (item.url || item.enlace || item.link || '').trim(),
    fuente: 'apispain'
  };
}

async function run(){
  fs.mkdirSync('data', { recursive: true });

  let existing = {};
  if(fs.existsSync(OUTPUT_PATH)){
    try{
      const prev = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
      (prev.entries||[]).forEach(e=>{ if(e.expediente) existing[e.expediente]=e; });
      console.log(`Histórico previo: ${Object.keys(existing).length} entradas`);
    }catch(e){ console.warn('Sin histórico previo'); }
  }

  let totalNew = 0, totalRequests = 0, firstItemShown = false;

  for(const cpv of cpvCodes){
    let page = 1, hasMore = true, cpvNew = 0;
    console.log(`\nCPV ${cpv}...`);

    while(hasMore){
      try{
        await new Promise(r => setTimeout(r, DELAY_MS));
        const data = await fetchPage(cpv, page);
        totalRequests++;

        // Mostrar estructura real la primera vez
        if(!firstItemShown && data.data && data.data.length > 0){
          firstItemShown = true;
          const sample = data.data[0];
          console.log('=== CAMPOS DISPONIBLES EN APISPAIN ===');
          console.log(Object.keys(sample).join(', '));
          // Mostrar valores relevantes del primer item
          const relevant = ['estado','adjudicatario','empresaAdjudicataria','fechaAdjudicacion',
                            'fechaResolucion','importeAdjudicacion','importeContrato','placeId',
                            'objeto','organoContratante'];
          relevant.forEach(k => {
            if(sample[k] !== undefined) console.log(`  ${k}: ${String(sample[k]).slice(0,100)}`);
          });
          console.log('=== FIN MUESTRA ===');
        }

        const items = data.data || [];
        if(!items.length){ hasMore = false; break; }

        for(const item of items){
          // Solo procesar las adjudicadas
          if(!isAdjudicada(item)) continue;
          const entry = normalize(item, cpv);
          if(!entry.expediente) continue;
          // Solo desde START_YEAR
          if(entry.fechaAdjudicacion){
            const year = parseInt(entry.fechaAdjudicacion.slice(0,4));
            if(year < START_YEAR) continue;
          }
          if(!existing[entry.expediente]){
            existing[entry.expediente] = entry;
            cpvNew++; totalNew++;
          }
        }

        const total = data.pagination?.total || data.meta?.total || data.total;
        const perPage = items.length;
        hasMore = total ? ((page * perPage) < total) : (perPage === 50);
        if(page >= 40){ console.log(`  CPV ${cpv}: límite de 40 páginas`); break; }
        page++;

      }catch(e){
        console.warn(`  CPV ${cpv} pág ${page}: ${e.message.slice(0,200)}`);
        hasMore = false;
      }
    }
    console.log(`  CPV ${cpv}: ${cpvNew} nuevas adjudicaciones`);
  }

  const allEntries = Object.values(existing)
    .sort((a,b) => (b.fechaAdjudicacion||'').localeCompare(a.fechaAdjudicacion||''));

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    fromYear: START_YEAR,
    source: 'apispain',
    totalRequests,
    totalEntries: allEntries.length,
    newThisRun: totalNew,
    entries: allEntries
  }, null, 2));

  console.log(`\n✓ Completado: ${allEntries.length} adjudicaciones (${totalNew} nuevas, ${totalRequests} requests)`);
}

run().catch(e => { console.error('Error fatal:', e.stack||e); process.exit(1); });
