#!/usr/bin/env node
// backfill-historico.mjs v6 — usa Apispain (plan gratuito) para obtener el histórico
// de adjudicaciones filtradas por CPV directamente en JSON limpio, sin descargar ZIPs.
// Una sola ejecución manual cubre 2021-hoy. El barrido diario (fetch-and-filter.mjs)
// mantiene el histórico al día de forma incremental.

import fs from 'node:fs';

const OUTPUT_PATH    = 'data/historico_adjudicaciones.json';
const CONFIG_PATH    = 'config/accreditations.json';
const APISPAIN_KEY   = process.env.APISPAIN_KEY || '';
const BASE_URL       = 'https://api.apispain.es/v1/place/licitaciones';
const START_YEAR     = 2021;
const DELAY_MS       = 1200; // pausa entre calls para respetar el rate limit (10 req/min en plan Free)

if(!APISPAIN_KEY){ console.error('Falta APISPAIN_KEY en las variables de entorno'); process.exit(1); }

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const cpvCodes = [...new Set(config.cpv.map(l=>(l.match(/^\d{8}/)||[])[0]).filter(Boolean))];
console.log(`CPVs a consultar: ${cpvCodes.length}`);

async function fetchAdjudicaciones(cpv, page=1){
  const url = `${BASE_URL}?cpv=${cpv}&estado=RES&desde=${START_YEAR}-01-01&page=${page}&limit=50`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${APISPAIN_KEY}`, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  if(!resp.ok){
    const txt = await resp.text().catch(()=>'');
    throw new Error(`HTTP ${resp.status}: ${txt.slice(0,200)}`);
  }
  return resp.json();
}

function normalizeEntry(item, cpv){
  return {
    expediente: (item.expediente || item.id || item.codigo || '').trim(),
    title: (item.objeto || item.titulo || item.title || '').trim(),
    organo: (item.organo || item.entidad || item.comprador || '').trim(),
    estado: 'RES',
    cpv: item.cpv ? [String(item.cpv)] : [cpv],
    importe: parseFloat(item.importe_adjudicacion || item.importe || item.presupuesto || '') || null,
    importeRaw: String(item.importe_adjudicacion || item.importe || '').trim(),
    adjudicatario: (item.adjudicatario || item.empresa || item.proveedor || '').trim(),
    fechaAdjudicacion: (item.fecha_adjudicacion || item.fecha || item.updated || '').trim(),
    link: (item.url || item.enlace || item.link || '').trim(),
    fuente: 'apispain'
  };
}

async function run(){
  fs.mkdirSync('data', { recursive: true });

  // Cargar histórico existente para hacer merge
  let existing = {};
  if(fs.existsSync(OUTPUT_PATH)){
    try{
      const prev = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
      (prev.entries||[]).forEach(e=>{ if(e.expediente) existing[e.expediente]=e; });
      console.log(`Histórico previo cargado: ${Object.keys(existing).length} entradas`);
    }catch(e){ console.warn('Sin histórico previo'); }
  }

  let totalNew = 0, totalRequests = 0;

  for(const cpv of cpvCodes){
    let page = 1, hasMore = true, cpvNew = 0;
    console.log(`\nConsultando CPV ${cpv}...`);

    while(hasMore){
      try{
        await new Promise(r => setTimeout(r, DELAY_MS));
        const data = await fetchAdjudicaciones(cpv, page);
        totalRequests++;

        // Volcar la primera respuesta para depuración de estructura
        if(page === 1 && cpvCodes.indexOf(cpv) === 0){
          const sample = JSON.stringify(data, null, 2);
          fs.writeFileSync('data/apispain-sample.json', sample.slice(0, 8000));
          console.log('=== PRIMERA RESPUESTA APISPAIN ===');
          console.log('HTTP response keys:', Object.keys(data).join(', '));
          console.log('Raw (primeros 800 chars):', sample.slice(0,800));
          console.log('=== FIN MUESTRA ===');
        }

        const items = data.data || data.items || data.results || data.licitaciones || (Array.isArray(data) ? data : []);
        if(!items.length){ hasMore=false; break; }

        for(const item of items){
          const entry = normalizeEntry(item, cpv);
          if(entry.expediente && !existing[entry.expediente]){
            existing[entry.expediente] = entry;
            cpvNew++; totalNew++;
          }
        }

        const total = data.total || data.count || data.totalItems;
        const perPage = items.length;
        hasMore = total ? (page * perPage < total) : (items.length === 50);
        page++;

        if(page > 20){ console.log(`  CPV ${cpv}: límite de 20 páginas alcanzado`); break; }
      }catch(e){
        console.warn(`  CPV ${cpv} pág ${page}: ${e.message}`);
        hasMore = false;
      }
    }

    console.log(`  CPV ${cpv}: ${cpvNew} nuevas adjudicaciones (${totalRequests} requests usadas)`);
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

  console.log(`\n✓ Backfill completado: ${allEntries.length} adjudicaciones (${totalNew} nuevas, ${totalRequests} requests usadas)`);
}

run().catch(e => { console.error('Error fatal:', e.stack||e); process.exit(1); });
