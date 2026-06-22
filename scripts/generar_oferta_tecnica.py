#!/usr/bin/env python3
"""
Generador de Oferta Técnica AGQ Labs v2
Adapta AGQ_TEC.docx (plantilla maestra) a cada licitación.
Modo de uso:
  python3 generar_oferta_tecnica.py <datos.json> <salida.docx> [plantilla.docx]
Si no se indica plantilla, usa plantilla_maestra_oferta.docx en el mismo directorio.
"""

import sys, json, copy, io, zipfile, os
from docx import Document
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from lxml import etree

# ── Constantes ──────────────────────────────────────────────────────────────
NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
NS_R_OFC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
LOGO_REPSOL_RID = 'rId21'          # rId del logo de Repsol en la portada

FRAGMENTOS_TITULO_ORIGINAL = [
    'SERVICIO DE ANALITICAS PARA LOS',
    'RESIDUOS QUE VAN A VERTEDERO SEGÚN RD 646/ 2020',
    'PARA LOS CENTROS',
    'INDUSTRIALES DEL GRUPO REPSOL',
    'ANALITICAS PARA LOS RESIDUOS',
]
EXPEDIENTE_ORIGINAL = 'WS2803434877/Doc2803462141'

# ── Utilidades ───────────────────────────────────────────────────────────────
def para_text(el):
    return ''.join(t.text or '' for t in el.findall('.//' + qn('w:t'))).strip()

def replace_marker(body, marker, texto_nuevo, pPr_ref=None):
    """Reemplaza el párrafo exacto con el marcador por uno o más párrafos nuevos."""
    for p in body.iter(qn('w:p')):
        if para_text(p) == marker:
            pPr_src = p.find(qn('w:pPr')) if pPr_ref is None else pPr_ref
            parrafos = [t.strip() for t in texto_nuevo.split('\n\n') if t.strip()]
            for texto in parrafos:
                new_p = OxmlElement('w:p')
                if pPr_src is not None:
                    new_p.append(copy.deepcopy(pPr_src))
                r = OxmlElement('w:r')
                rPr = OxmlElement('w:rPr')
                color = OxmlElement('w:color'); color.set(qn('w:val'), '231F20')
                rPr.append(color); r.append(rPr)
                t_el = OxmlElement('w:t')
                t_el.set(qn('xml:space'), 'preserve'); t_el.text = texto
                r.append(t_el); new_p.append(r)
                p.addprevious(new_p)
            p.getparent().remove(p)
            return True
    print(f'  AVISO: marcador "{marker}" no encontrado')
    return False

def patch_header_xml(content_bytes, titulo_nuevo, expediente_nuevo):
    """Sustituye título y expediente en un XML de header."""
    root = etree.fromstring(content_bytes)
    wts = root.findall(f'.//{{{NS_W}}}t')
    changed = False
    i = 0
    while i < len(wts):
        text = wts[i].text or ''
        if any(frag in text for frag in FRAGMENTOS_TITULO_ORIGINAL):
            # Consolidar bloque de fragmentos
            block = [wts[i]]
            j = i + 1
            while j < min(i + 15, len(wts)):
                block.append(wts[j])
                if 'GRUPO REPSOL' in (wts[j].text or ''):
                    break
                j += 1
            block[0].text = titulo_nuevo.upper()
            for bwt in block[1:]:
                bwt.text = ''
            changed = True
            i = j + 1
        elif EXPEDIENTE_ORIGINAL in text:
            wts[i].text = text.replace(EXPEDIENTE_ORIGINAL, expediente_nuevo)
            changed = True
            i += 1
        else:
            i += 1
    if not changed:
        return content_bytes
    return etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)

def remove_logo_repsol(content_bytes, rid=LOGO_REPSOL_RID):
    """Elimina el w:drawing con el logo de Repsol del document.xml."""
    root = etree.fromstring(content_bytes)
    for blip in root.findall(f'.//{{{NS_A}}}blip'):
        if blip.get(f'{{{NS_R_OFC}}}embed') == rid:
            drawing = blip
            while drawing is not None and drawing.tag != f'{{{NS_W}}}drawing':
                drawing = drawing.getparent()
            if drawing is not None:
                r = drawing.getparent()
                if r is not None:
                    p = r.getparent()
                    if p is not None:
                        p.remove(r)
                        print(f'  Logo de Repsol eliminado (rId={rid})')
                        break
    return etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)

# ── Pipeline principal ────────────────────────────────────────────────────────
def generar_oferta(plantilla_path, datos, salida_path):
    titulo     = datos['tituloServicio']
    expediente = datos['expediente']

    # ── Paso 1: Parchear headers y eliminar logo directamente en el ZIP ──────
    with open(plantilla_path, 'rb') as f:
        zip_data = f.read()

    out_buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(zip_data), 'r') as zin, \
         zipfile.ZipFile(out_buf, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            name = item.filename.lower()
            if name.startswith('word/header') and name.endswith('.xml'):
                data = patch_header_xml(data, titulo, expediente)
            elif name == 'word/document.xml':
                data = remove_logo_repsol(data)
            zout.writestr(item, data)

    # ── Paso 2: Abrir el ZIP parchado con python-docx ────────────────────────
    doc = Document(io.BytesIO(out_buf.getvalue()))
    body = doc.element.body
    elements = list(body.iterchildren())

    # Portada: p16 -> título (multi-fragmento)
    p16 = elements[16]
    wts16 = p16.findall('.//' + qn('w:t'))
    i = 0
    while i < len(wts16):
        t = wts16[i].text or ''
        if any(frag in t for frag in FRAGMENTOS_TITULO_ORIGINAL):
            block = [wts16[i]]
            j = i + 1
            while j < min(i+15, len(wts16)):
                block.append(wts16[j])
                if 'GRUPO REPSOL' in (wts16[j].text or ''):
                    break
                j += 1
            block[0].text = titulo.upper()
            for bwt in block[1:]: bwt.text = ''
            print(f'  Portada título: {len(block)} fragmentos reemplazados')
            break
        i += 1

    # Portada: p19 -> expediente
    p19 = elements[19]
    for wt in p19.findall('.//' + qn('w:t')):
        if wt.text and EXPEDIENTE_ORIGINAL in wt.text:
            wt.text = wt.text.replace(EXPEDIENTE_ORIGINAL, expediente)
            print(f'  Portada expediente: OK')

    # Texto genérico de la sección 02 Presentación: reescribir para que no mencione Repsol
    for p in body.findall('.//' + qn('w:p')):
        full = ''.join(t.text or '' for t in p.findall('.//' + qn('w:t')))
        if 'tipo de servicios que necesita cubrir' in full and ('REPSOL' in full or 'Peligrosidad' in full):
            runs = p.findall('.//' + qn('w:r'))
            if runs:
                first_rPr = runs[0].find(qn('w:rPr'))
                for r in runs: r.getparent().remove(r)
                for hp in p.findall('.//' + qn('w:hyperlink')): hp.getparent().remove(hp)
                new_r = OxmlElement('w:r')
                if first_rPr is not None: new_r.append(copy.deepcopy(first_rPr))
                t_el = OxmlElement('w:t'); t_el.set(qn('xml:space'), 'preserve')
                t_el.text = 'LABS & TECHNOLOGICAL SERVICES AGQ, S.L. como empresa especializada en el tipo de servicios que necesita cubrir el cliente, con la presente propuesta técnica, es capaz de abordar con plena capacidad técnica y con la garantía de calidad los trabajos que se requieren según el pliego de condiciones técnicas.'
                new_r.append(t_el); p.append(new_r)
                print('  Texto intro sección 02: reescrito')
            break

    # Reunión Inicial y Plan de Prevención: reemplazar menciones al cliente anterior
    idx_reunion = idx_equipo = idx_plan_prev = None
    for i, el in enumerate(elements):
        if el.tag == qn('w:p'):
            t = para_text(el)
            if t == 'REUNIÓN INICIAL' and idx_reunion is None: idx_reunion = i
            if t == 'EQUIPO DE LABORATORIO' and idx_equipo is None: idx_equipo = i
            if t == 'PLAN DE PREVENCIÓN DE RIESGOS LABORALES' and idx_plan_prev is None: idx_plan_prev = i

    nombre_cliente = datos.get('organo', 'el cliente')
    for el in elements[(idx_reunion or 0):]:
        for wt in el.findall('.//' + qn('w:t')):
            if wt.text and 'REPSOL' in wt.text:
                wt.text = wt.text.replace('REPSOL', nombre_cliente)

    # Marcadores de contenido: sustituir los 5 bloques variables
    marcadores = [
        ('{{OBJETO_DOCUMENTO}}',   datos['objetoDocumento']),
        ('{{ALCANCE_NORMATIVO}}',  datos['alcanceNormativo']),
        ('{{ALCANCE_TECNICO}}',    datos['alcanceTecnico']),
        ('{{PLAN_MUESTREO}}',      datos['planMuestreo']),
        ('{{NOTAS_PLAZOS}}',       datos['notasYPlazos']),
    ]
    for marker, text in marcadores:
        ok = replace_marker(body, marker, text)
        print(f'  {marker}: {"OK" if ok else "FALLO"}')

    # Cortar antes del Anexo I
    elements = list(body.iterchildren())
    cut_idx = None
    for i, el in enumerate(elements):
        if el.tag == qn('w:p') and para_text(el) == 'ANEXO I':
            cut_idx = i; break
    if cut_idx is not None:
        print(f'  Cortando en el elemento {cut_idx} (Anexo I)')
        for el in elements[cut_idx:]:
            p = el.getparent()
            if p is not None: p.remove(el)

    doc.save(salida_path)
    print(f'  ✓ Guardado: {salida_path}')
    return True


# ── Modo de ejecución ─────────────────────────────────────────────────────────
if __name__ == '__main__':
    BASE = os.path.dirname(os.path.abspath(__file__))

    if len(sys.argv) >= 3:
        datos_path    = sys.argv[1]
        salida_path   = sys.argv[2]
        plantilla_path = sys.argv[3] if len(sys.argv) > 3 else os.path.join(BASE, 'plantilla_maestra_oferta.docx')
        with open(datos_path) as f:
            datos = json.load(f)
    else:
        # Datos de prueba
        plantilla_path = '/home/claude/plantilla_maestra_oferta.docx'
        salida_path    = '/home/claude/oferta_generada_final3.docx'
        datos = {
            "tituloServicio": "Servicio de control de legionela y calidad del agua en edificios municipales del Ayuntamiento de Ejemplo (Sevilla)",
            "expediente": "2026/035020",
            "organo": "el Ayuntamiento de Ejemplo (Sevilla)",
            "objetoDocumento": "Es objeto de la presente documentación técnica el detallar los diferentes aspectos de la oferta presentada por LABS & TECHNOLOGICAL SERVICES AGQ, S.L. para el servicio de control sanitario de legionela y calidad del agua en las instalaciones municipales del Ayuntamiento de Ejemplo (Sevilla).\n\nEl servicio incluye la toma de muestras y análisis de Legionella spp. en agua caliente sanitaria y torres de refrigeración de los edificios municipales recogidos en el Anexo I del pliego, así como determinaciones fisicoquímicas básicas de calidad del agua en los puntos de control designados. El contrato tiene una duración inicial de un año, con posibilidad de dos prórrogas anuales.",
            "alcanceNormativo": "Resulta de aplicación el Real Decreto 865/2003, de 4 de julio, por el que se establecen los criterios higiénico-sanitarios para la prevención y control de la legionelosis, con especial atención a sus anexos sobre instalaciones de riesgo prioritario y procedimientos de muestreo.\n\nAsimismo, será de aplicación la Orden SCO/317/2003 que desarrolla el procedimiento de toma de muestras para el control sanitario de instalaciones de riesgo. En el ámbito autonómico andaluz, será de aplicación la normativa de desarrollo vigente en materia de control de legionela en instalaciones de riesgo.\n\nEn lo relativo a la calidad del agua de consumo humano en los puntos que el pliego así lo exige, será de aplicación el Real Decreto 140/2003, de 7 de febrero.",
            "alcanceTecnico": "Los trabajos consisten en la toma de muestras y análisis de Legionella spp. en agua caliente sanitaria (ACS) y torres de refrigeración de los doce edificios municipales incluidos en el Anexo I del pliego técnico, con emisión de un boletín de resultados independiente por cada punto muestreado.\n\nSe realizarán asimismo determinaciones fisicoquímicas básicas de calidad del agua —cloro libre residual, temperatura, pH y conductividad— en los puntos de control designados.\n\nTodos los análisis se realizarán en las instalaciones del Laboratorio AGQ Labs de Burguillos (Sevilla), acreditado por ENAC (nº 305/LE1322) para los ensayos de Legionella spp.",
            "planMuestreo": "Se establece una frecuencia de muestreo trimestral en torres de refrigeración y semestral en agua caliente sanitaria, conforme a lo indicado en el Anexo II del pliego técnico y en concordancia con el RD 865/2003.\n\nLa toma de muestras será realizada por personal técnico cualificado de AGQ Labs, empleando recipientes estériles homologados y protocolos de cadena de custodia certificados conforme a la norma UNE-EN ISO 19458. El traslado al laboratorio se realizará en condiciones de refrigeración controlada (2-8 °C) en un plazo máximo de 24 horas desde la toma.",
            "notasYPlazos": "El plazo de entrega de resultados será de 10 días hábiles desde la fecha de toma de muestra, pudiendo reducirse a 5 días hábiles en caso de incidencia sanitaria comunicada con carácter urgente por el responsable municipal del contrato.\n\nEl plazo de ejecución del contrato es de un año desde su formalización, con posibilidad de dos prórrogas anuales expresamente previstas en el pliego administrativo."
        }

    print('Generando oferta técnica...')
    generar_oferta(plantilla_path, datos, salida_path)
