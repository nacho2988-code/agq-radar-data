import json, re, zipfile, io, urllib.request, datetime, os, sys

HISTORICO = 'data/historico_adjudicaciones.json'
TARGET_YEAR = os.environ.get('TARGET_YEAR', 'all')
YEARS = [2020,2021,2022,2023,2024,2025,2026] if TARGET_YEAR == 'all' else [int(TARGET_YEAR)]
BASE_URL = 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3_{}.zip'

def tag(text, name):
    m = re.search(rf'<(?:[^:>]*:)?{name}[^>]*>([\s\S]*?)</(?:[^:>]*:)?{name}>', text, re.I)
    if not m: return ''
    return re.sub(r'<[^>]+>', '', m.group(1)).strip().replace('&amp;','&').replace('&lt;','<').replace('&gt;','>')

def to_float(s):
    if not s: return None
    try: return float(s.replace(',','.'))
    except: return None

hist = json.load(open(HISTORICO))
entries = hist.get('entries', hist) if isinstance(hist, dict) else hist
if not isinstance(entries, list): entries = list(hist.values())
by_exp = {e['expediente'].strip().upper(): e for e in entries if e.get('expediente')}
print(f"Histórico: {len(entries)} entradas | Procesando años: {YEARS}", flush=True)

total = 0
for year in YEARS:
    url = BASE_URL.format(year)
    print(f"\n--- {year} ---", flush=True)
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'AGQ-Radar/1.0'})
        with urllib.request.urlopen(req, timeout=180) as r:
            data = r.read()
        print(f"  {len(data)//1024//1024} MB descargados", flush=True)
    except Exception as e:
        print(f"  Error descarga: {e}"); continue
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
        xml_files = [n for n in zf.namelist() if n.endswith('.xml') or n.endswith('.atom')]
        print(f"  {len(xml_files)} ficheros XML", flush=True)
    except Exception as e:
        print(f"  Error ZIP: {e}"); continue

    year_n = 0
    for fname in xml_files:
        try: content = zf.read(fname).decode('utf-8', errors='replace')
        except: continue
        blocks = re.findall(r'<entry>([\s\S]*?)</entry>', content, re.I)
        if not blocks:
            blocks = re.findall(r'<CallForTenders[^>]*>([\s\S]*?)</CallForTenders>', content, re.I)
        for block in blocks:
            exp_m = re.search(r'<(?:cbc:)?ContractFolderID>([^<]+)</(?:cbc:)?ContractFolderID>', block, re.I)
            if not exp_m: continue
            exp = exp_m.group(1).strip().upper()
            if exp not in by_exp: continue
            entry = by_exp[exp]
            changed = False

            # Presupuesto base de licitación
            bm = re.search(r'<cac:BudgetAmount[^>]*>([\s\S]*?)</cac:BudgetAmount>', block, re.I)
            if bm and not entry.get('presupuestoBase'):
                v = to_float(tag(bm.group(1),'TaxExclusiveAmount') or tag(bm.group(1),'TotalAmount'))
                if v and v > 0: entry['presupuestoBase'] = v; changed = True

            # TenderResult: importe adjudicación, n_ofertas, rangos
            trm = re.search(r'<cac:TenderResult[^>]*>([\s\S]*?)</cac:TenderResult>', block, re.I)
            if trm:
                tr = trm.group(1)
                if not entry.get('importeAdjudicacion'):
                    v = to_float(tag(tr,'PayableAmount') or tag(tr,'TaxExclusiveAmount') or tag(tr,'AwardedTenderedAmount'))
                    if v and v > 0: entry['importeAdjudicacion'] = v; changed = True
                if not entry.get('n_ofertas'):
                    no = tag(tr,'ReceivedTenderQuantity') or tag(tr,'SubmittedTenderQuantity')
                    if no:
                        try:
                            n = int(float(no))
                            if n > 0: entry['n_ofertas'] = n; changed = True
                        except: pass
                if not entry.get('importe_min'):
                    v = to_float(tag(tr,'LowerTenderAmount'))
                    if v and v > 0: entry['importe_min'] = v; changed = True
                if not entry.get('importe_max'):
                    v = to_float(tag(tr,'HigherTenderAmount'))
                    if v and v > 0: entry['importe_max'] = v; changed = True

            if changed: year_n += 1; total += 1; by_exp.pop(exp)  # ya procesado

    print(f"  Enriquecidas: {year_n}", flush=True)

if isinstance(hist, dict):
    hist['generatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
json.dump(hist, open(HISTORICO,'w'), ensure_ascii=False, indent=2)

con_base = sum(1 for e in entries if e.get('presupuestoBase'))
con_adj  = sum(1 for e in entries if e.get('importeAdjudicacion'))
con_n    = sum(1 for e in entries if e.get('n_ofertas'))
con_min  = sum(1 for e in entries if e.get('importe_min'))
print(f"\n=== RESULTADO ===")
print(f"Enriquecidas: {total}")
print(f"presupuestoBase:     {con_base}/{len(entries)} ({con_base/len(entries)*100:.1f}%)")
print(f"importeAdjudicacion: {con_adj}/{len(entries)} ({con_adj/len(entries)*100:.1f}%)")
print(f"n_ofertas:           {con_n}/{len(entries)}")
print(f"importe_min/max:     {con_min}/{len(entries)}")
