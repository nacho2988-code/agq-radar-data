#!/usr/bin/env python3
"""
Generador de Oferta Técnica AGQ Labs v3
Adapta AGQ_TEC.docx (plantilla maestra) a cada licitación.
Modo de uso:
  python3 generar_oferta_tecnica.py <datos.json> <salida.docx> [plantilla.docx]
"""

import sys, json, copy, io, zipfile, os
from docx import Document
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from lxml import etree

NS_W     = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS_A     = 'http://schemas.openxmlformats.org/drawingml/2006/main'
NS_R_OFC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
LOGO_REPSOL_RID = 'rId21'

FRAGMENTOS_TITULO = [
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

def make_paragraph(texto, pPr_ref, rPr_ref=None):
    """Crea un w:p clonando exactamente el pPr_ref y rPr_ref del párrafo original."""
    new_p = OxmlElement('w:p')
    if pPr_ref is not None:
        new_p.append(copy.deepcopy(pPr_ref))
    r = OxmlElement('w:r')
    if rPr_ref is not None:
        r.append(copy.deepcopy(rPr_ref))
    t_el = OxmlElement('w:t')
    t_el.set(qn('xml:space'), 'preserve')
    t_el.text = texto
    r.append(t_el)
    new_p.append(r)
    return new_p

def get_pPr_rPr(p):
    """Devuelve (pPr, rPr) de un párrafo."""
    pPr = p.find(qn('w:pPr'))
    rPr = None
    for r in p.findall('.//' + qn('w:r')):
        rPr = r.find(qn('w:rPr'))
        if rPr is not None:
            break
    return pPr, rPr

def replace_marker(body, marker, texto_nuevo, pPr_ref, rPr_ref=None):
    """Reemplaza el párrafo marcador por párrafos con el formato correcto."""
    for p in body.iter(qn('w:p')):
        if para_text(p) == marker:
            for texto in [t.strip() for t in texto_nuevo.split('\n\n') if t.strip()]:
                p.addprevious(make_paragraph(texto, pPr_ref, rPr_ref))
            p.getparent().remove(p)
            return True
    print(f'  AVISO: marcador "{marker}" no encontrado')
    return False

def patch_header_xml(content_bytes, titulo_nuevo, expediente_nuevo):
    root = etree.fromstring(content_bytes)
    wts = root.findall(f'.//{{{NS_W}}}t')
    changed = False
    i = 0
    while i < len(wts):
        text = wts[i].text or ''
        if any(frag in text for frag in FRAGMENTOS_TITULO):
            block = [wts[i]]
            j = i + 1
            while j < min(i + 15, len(wts)):
                block.append(wts[j])
                if 'GRUPO REPSOL' in (wts[j].text or ''):
                    break
                j += 1
            block[0].text = titulo_nuevo.upper()
            for bwt in block[1:]: bwt.text = ''
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
    root = etree.fromstring(content_bytes)
    for blip in root.findall(f'.//{{{NS_A}}}blip'):
        if blip.get(f'{{{NS_R_OFC}}}embed') == rid:
            drawing = blip
            while drawing is not None and drawing.tag != f'{{{NS_W}}}drawing':
                drawing = drawing.getparent()
            if drawing is not None:
                r = drawing.getparent()
                if r is not None and r.getparent() is not None:
                    r.getparent().remove(r)
                    print(f'  Logo de Repsol eliminado (rId={rid})')
                    break
    return etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)

# ── Pipeline principal ────────────────────────────────────────────────────────
def generar_oferta(plantilla_path, datos, salida_path):
    titulo     = datos['tituloServicio']
    expediente = datos['expediente']
    organo     = datos.get('organo', 'el cliente')

    # Paso 1: parchear headers y eliminar logo en el ZIP
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

    doc = Document(io.BytesIO(out_buf.getvalue()))
    body = doc.element.body
    elements = list(body.iterchildren())

    # ── Obtener el formato de referencia correcto del documento original ──────
    # Buscamos el primer párrafo de contenido real tras el título "OBJETO DEL DOCUMENTO"
    # que usa el estilo "Textoindependiente" (el cuerpo normal justificado del doc)
    pPr_content = None
    rPr_content = None
    for i, el in enumerate(elements):
        if el.tag == qn('w:p') and para_text(el) == 'OBJETO DEL DOCUMENTO':
            # El siguiente párrafo con contenido real es el de referencia
            for el2 in elements[i+1:i+5]:
                if el2.tag == qn('w:p') and para_text(el2).strip():
                    pPr_content, rPr_content = get_pPr_rPr(el2)
                    break
            break
    print(f'  Formato de referencia: pPr encontrado={pPr_content is not None}, rPr={rPr_content is not None}')

    # ── Portada: título ───────────────────────────────────────────────────────
    p16 = elements[16]
    wts16 = p16.findall('.//' + qn('w:t'))
    i = 0
    while i < len(wts16):
        if any(frag in (wts16[i].text or '') for frag in FRAGMENTOS_TITULO):
            block = [wts16[i]]
            j = i + 1
            while j < min(i+15, len(wts16)):
                block.append(wts16[j])
                if 'GRUPO REPSOL' in (wts16[j].text or ''): break
                j += 1
            block[0].text = titulo.upper()
            for bwt in block[1:]: bwt.text = ''
            print(f'  Portada título: {len(block)} fragmentos reemplazados')
            break
        i += 1

    # ── Portada: expediente ───────────────────────────────────────────────────
    p19 = elements[19]
    for wt in p19.findall('.//' + qn('w:t')):
        if wt.text and EXPEDIENTE_ORIGINAL in wt.text:
            wt.text = wt.text.replace(EXPEDIENTE_ORIGINAL, expediente)
            print('  Portada expediente: OK')

    # ── Índice: actualizar entradas que cambian ───────────────────────────────
    # El índice (elementos 28-75 aprox.) tiene textos fijos de la página anterior.
    # Eliminamos del índice las secciones que ya no existen en la oferta generada
    # (Caracterización básica, Caracterización de peligrosidad, Subcontrataciones,
    # Plan de muestreo AGQ) y añadimos la nueva entrada de Notas y plazos.
    INDICE_ELIMINAR = [
        'CARACTERIZACIÓN BÁSICA. Pag. 22',
        'CARACTERIZACIÓN DE PELIGROSIDAD. Pag. 22',
        'SUBCONTRACIONES. Pag 32',
    ]
    INDICE_REEMPLAZAR = {
        'ALCANCE NORMATIVO. Pag. 14': 'ALCANCE NORMATIVO',
        'ALCANCE TÉCNICO: DESCRIPCION DE LOS TRABAJOS. Pag. 16': 'ALCANCE TÉCNICO: DESCRIPCIÓN DE LOS TRABAJOS',
        'PLAN DE MUESTREO Y TOMA DE MUESTRAS. Pag. 18': 'PLAN DE MUESTREO Y TOMA DE MUESTRAS',
        'NOTAS Y PLAZO DE ENTREGA DE RESULTADOS. Pag. 31': 'NOTAS Y PLAZO DE ENTREGA DE RESULTADOS',
        'EXPERIENCIA PREVIA. Pag. 9': 'EXPERIENCIA PREVIA (pendiente de revisión)',
    }
    # Recalcular elements para el índice
    elements = list(body.iterchildren())
    for el in elements[:80]:
        if el.tag == qn('w:p'):
            t = para_text(el)
            for viejo in INDICE_ELIMINAR:
                if viejo in t:
                    el.getparent().remove(el)
                    break
            for viejo, nuevo in INDICE_REEMPLAZAR.items():
                if viejo in t:
                    for wt in el.findall('.//' + qn('w:t')):
                        if wt.text and viejo.split('.')[0] in wt.text:
                            wt.text = wt.text.replace(viejo.split('.')[0], nuevo)
                    break
    print('  Índice: entradas obsoletas eliminadas/actualizadas')

    # ── Sección 2.1 Introducción: sustituir contenido específico de Repsol ────
    # Localizar el párrafo de título INTRODUCCIÓN (subsección 2.1) y reemplazar
    # el contenido que sigue hasta el siguiente título de subsección.
    elements = list(body.iterchildren())
    idx_intro = idx_intro_end = None
    for i, el in enumerate(elements):
        if el.tag == qn('w:p'):
            t = para_text(el)
            if t == 'INTRODUCCIÓN' and idx_intro is None:
                idx_intro = i
            elif idx_intro is not None and t in ('REFERENCIAS GENERALES', '2.2', 'REFERENCIAS'):
                idx_intro_end = i
                break

    if idx_intro is not None and idx_intro_end is not None:
        # Eliminar todos los párrafos de contenido entre título y siguiente sección
        for el in elements[idx_intro+1:idx_intro_end]:
            if el.tag == qn('w:p'):
                el.getparent().remove(el)
        # Insertar párrafo nuevo adaptado a la licitación actual
        intro_texto = datos.get('introduccion',
            f'El objeto de esta propuesta es definir las actividades y operativa a seguir en la contratación del {titulo}, tal y como se recoge en el Pliego de Prescripciones Técnicas Particulares. La presente oferta incluye todos los medios técnicos y humanos necesarios para llevar a cabo el servicio con plenas garantías de calidad.')
        # El párrafo nuevo debe insertarse justo después del título INTRODUCCIÓN
        titulo_intro_el = elements[idx_intro]
        nuevo_p = make_paragraph(intro_texto, pPr_content, rPr_content)
        titulo_intro_el.addnext(nuevo_p)
        print('  Sección 2.1 Introducción: contenido adaptado')
    else:
        print(f'  AVISO: no se encontró el límite de la sección Introducción (idx={idx_intro}, end={idx_intro_end})')

    # ── Interlocutor: vaciar nombre, email y teléfono ─────────────────────────
    elements = list(body.iterchildren())
    for i, el in enumerate(elements):
        if el.tag == qn('w:tbl'):
            rows = el.findall('.//' + qn('w:tr'))
            # Detectar la tabla de interlocutor por su cabecera
            if len(rows) >= 2:
                header_text = para_text(rows[0])
                if 'INTERLOCUTOR' in header_text and 'CORREO' in header_text:
                    # Vaciar la fila de datos (segunda fila)
                    for tc in rows[1].findall(qn('w:tc')):
                        for p in tc.findall(qn('w:p')):
                            for r in p.findall('.//' + qn('w:r')):
                                for wt in r.findall(qn('w:t')):
                                    wt.text = ''
                    print('  Tabla Interlocutor: datos personales vaciados')
                    break

    # ── Experiencia Previa: reemplazar contenido por "pendiente de revisión" ──
    elements = list(body.iterchildren())
    idx_exp = idx_exp_end = None
    for i, el in enumerate(elements):
        if el.tag == qn('w:p'):
            t = para_text(el)
            if t == 'EXPERIENCIA PREVIA' and idx_exp is None:
                idx_exp = i
            elif idx_exp is not None and t in ('03', '04', 'PRESTACIÓN DEL SERVICIO'):
                idx_exp_end = i
                break

    if idx_exp is not None and idx_exp_end is not None:
        # Eliminar todo entre EXPERIENCIA PREVIA y el siguiente título de sección
        for el in elements[idx_exp+1:idx_exp_end]:
            el.getparent().remove(el)
        # Insertar texto placeholder
        exp_el = elements[idx_exp]
        placeholder = make_paragraph(
            '[PENDIENTE DE REVISIÓN — Incluir referencias de trabajos similares ejecutados por AGQ Labs en los últimos años, seleccionando las más afines al objeto de esta licitación.]',
            pPr_content, rPr_content)
        exp_el.addnext(placeholder)
        print('  Experiencia Previa: sustituida por placeholder')

    # ── Texto intro sección 02 Presentación ──────────────────────────────────
    elements = list(body.iterchildren())
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

    # ── Reunión Inicial y Plan Prevención: reemplazar menciones al cliente ────
    elements = list(body.iterchildren())
    idx_reunion = None
    for i, el in enumerate(elements):
        if el.tag == qn('w:p') and para_text(el) == 'REUNIÓN INICIAL' and idx_reunion is None:
            idx_reunion = i
    for el in elements[(idx_reunion or 0):]:
        for wt in el.findall('.//' + qn('w:t')):
            if wt.text and 'REPSOL' in wt.text:
                wt.text = wt.text.replace('REPSOL', organo)

    # ── Marcadores de contenido ───────────────────────────────────────────────
    marcadores = [
        ('{{OBJETO_DOCUMENTO}}',  datos['objetoDocumento']),
        ('{{ALCANCE_NORMATIVO}}', datos['alcanceNormativo']),
        ('{{ALCANCE_TECNICO}}',   datos['alcanceTecnico']),
        ('{{PLAN_MUESTREO}}',     datos['planMuestreo']),
        ('{{NOTAS_PLAZOS}}',      datos['notasYPlazos']),
    ]
    for marker, text in marcadores:
        ok = replace_marker(body, marker, text, pPr_content, rPr_content)
        print(f'  {marker}: {"OK" if ok else "FALLO"}')

    # ── Cortar antes del Anexo I ──────────────────────────────────────────────
    elements = list(body.iterchildren())
    cut_idx = None
    for i, el in enumerate(elements):
        if el.tag == qn('w:p') and para_text(el) == 'ANEXO I':
            cut_idx = i; break
    if cut_idx is not None:
        for el in elements[cut_idx:]:
            p = el.getparent()
            if p is not None: p.remove(el)
        print(f'  Corte en Anexo I (elem {cut_idx})')

    doc.save(salida_path)
    print(f'  ✓ Guardado: {salida_path}')
    return True

# ── Modo ejecución ────────────────────────────────────────────────────────────
if __name__ == '__main__':
    BASE = os.path.dirname(os.path.abspath(__file__))

    if len(sys.argv) >= 3:
        datos = json.load(open(sys.argv[1]))
        salida_path = sys.argv[2]
        plantilla_path = sys.argv[3] if len(sys.argv) > 3 else os.path.join(BASE, 'plantilla_maestra_oferta.docx')
    else:
        plantilla_path = '/home/claude/plantilla_maestra_oferta.docx'
        salida_path    = '/home/claude/oferta_generada_v3.docx'
        datos = {
            "tituloServicio": "Servicio de control de legionela y calidad del agua en edificios municipales del Ayuntamiento de Ejemplo (Sevilla)",
            "expediente": "2026/035020",
            "organo": "el Ayuntamiento de Ejemplo (Sevilla)",
            "introduccion": "El objeto de esta propuesta es definir las actividades y operativa a seguir en la contratación del servicio de control sanitario de legionela y calidad del agua en los edificios municipales del Ayuntamiento de Ejemplo (Sevilla), de acuerdo con lo establecido en el Pliego de Prescripciones Técnicas Particulares. Los trabajos comprenden la toma de muestras y análisis de Legionella spp. en agua caliente sanitaria y torres de refrigeración de los edificios incluidos en el Anexo I del pliego.",
            "objetoDocumento": "Es objeto de la presente documentación técnica el detallar los diferentes aspectos de la oferta presentada por LABS & TECHNOLOGICAL SERVICES AGQ, S.L. para el servicio de control sanitario de legionela y calidad del agua en las instalaciones municipales del Ayuntamiento de Ejemplo (Sevilla).\n\nEl servicio incluye la toma de muestras y análisis de Legionella spp. en agua caliente sanitaria y torres de refrigeración de los edificios municipales recogidos en el Anexo I del pliego, así como determinaciones fisicoquímicas básicas de calidad del agua en los puntos de control designados. El contrato tiene una duración inicial de un año, con posibilidad de dos prórrogas anuales.",
            "alcanceNormativo": "Resulta de aplicación el Real Decreto 865/2003, de 4 de julio, por el que se establecen los criterios higiénico-sanitarios para la prevención y control de la legionelosis, con especial atención a sus anexos sobre instalaciones de riesgo prioritario y procedimientos de muestreo.\n\nAsimismo, será de aplicación la Orden SCO/317/2003 que desarrolla el procedimiento de toma de muestras para el control sanitario de instalaciones de riesgo. En el ámbito autonómico andaluz, será de aplicación la normativa de desarrollo vigente en materia de control de legionela en instalaciones de riesgo.\n\nEn lo relativo a la calidad del agua de consumo humano en los puntos que el pliego así lo exige, será de aplicación el Real Decreto 140/2003, de 7 de febrero.",
            "alcanceTecnico": "Los trabajos consisten en la toma de muestras y análisis de Legionella spp. en agua caliente sanitaria (ACS) y torres de refrigeración de los doce edificios municipales incluidos en el Anexo I del pliego técnico, con emisión de un boletín de resultados independiente por cada punto muestreado.\n\nSe realizarán asimismo determinaciones fisicoquímicas básicas de calidad del agua —cloro libre residual, temperatura, pH y conductividad— en los puntos de control designados.\n\nTodos los análisis se realizarán en las instalaciones del Laboratorio AGQ Labs de Burguillos (Sevilla), acreditado por ENAC (nº 305/LE1322) para los ensayos de Legionella spp.",
            "planMuestreo": "Se establece una frecuencia de muestreo trimestral en torres de refrigeración y semestral en agua caliente sanitaria, conforme a lo indicado en el Anexo II del pliego técnico y en concordancia con el RD 865/2003.\n\nLa toma de muestras será realizada por personal técnico cualificado de AGQ Labs, empleando recipientes estériles homologados y protocolos de cadena de custodia certificados conforme a la norma UNE-EN ISO 19458. El traslado al laboratorio se realizará en condiciones de refrigeración controlada (2-8 °C) en un plazo máximo de 24 horas desde la toma.",
            "notasYPlazos": "El plazo de entrega de resultados será de 10 días hábiles desde la fecha de toma de muestra, pudiendo reducirse a 5 días hábiles en caso de incidencia sanitaria comunicada con carácter urgente por el responsable municipal del contrato.\n\nEl plazo de ejecución del contrato es de un año desde su formalización, con posibilidad de dos prórrogas anuales expresamente previstas en el pliego administrativo."
        }

    print('Generando oferta técnica v3...')
    generar_oferta(plantilla_path, datos, salida_path)
