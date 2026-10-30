-- =============================================================================
-- 0011 · Tributario: Registro de Compras y Ventas (RCV) y propuesta de F29
-- =============================================================================
-- Reglas (todas aplicadas por la base de datos):
--   * El RCV se importa por empresa, período, libro (COMPRA/VENTA) y sección
--     (REGISTRO, PENDIENTE, NO_INCLUIR, RECLAMADO). Cada importación es inmutable;
--     una nueva importación del mismo libro y sección reemplaza a la anterior, que
--     queda en el historial. No se reimporta un período con F29 aprobado o declarado.
--   * La propuesta de F29 se calcula aquí, a partir del RCV vigente y de reglas
--     versionadas en tablas_legales (F29.REGLAS_RCV). Nadie escribe las cifras a mano:
--     las correcciones van como ajustes por código, con motivo, y quedan a la vista.
--   * Nunca se supone un valor: sin RCV importado, sin tasa de PPM, sin UTM o sin el
--     remanente del período anterior, la propuesta no se prepara.
--   * La aprobación es de una persona (no de un agente), después de terminado el mes,
--     y exige confirmar las advertencias. Todo queda en la bitácora.
--   * Todo requiere el módulo TRIBUTARIO contratado para el período.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
INSERT INTO permisos (codigo, descripcion) VALUES
  ('tributario.ver',           'Ver el RCV importado, las propuestas de F29 y la configuración tributaria'),
  ('tributario.rcv.importar',  'Importar el Registro de Compras y Ventas del SII'),
  ('tributario.f29.preparar',  'Preparar propuestas de F29'),
  ('tributario.f29.aprobar',   'Aprobar, anular y registrar la declaración del F29; configurar la tasa de PPM');

INSERT INTO rol_permisos (rol_codigo, permiso_codigo) VALUES
  ('ADMIN_CLIENTE_ERP', 'tributario.ver'),
  ('CONTADOR',          'tributario.ver'),
  ('CONTADOR',          'tributario.rcv.importar'),
  ('CONTADOR',          'tributario.f29.preparar'),
  ('CONTADOR',          'tributario.f29.aprobar'),
  ('GERENTE_GENERAL',   'tributario.ver'),
  ('AUDITOR',           'tributario.ver');

-- ---------------------------------------------------------------------------
-- Normativa: tasas y reglas de traspaso RCV → F29
-- ---------------------------------------------------------------------------
INSERT INTO parametros_legales
  (clave, valor, unidad, vigente_desde, vigente_hasta, fuente, url_fuente, nota, estado, cargado_por, aprobado_por)
VALUES
  ('IVA.TASA_GENERAL', 19, 'PORCENTAJE', '2003-10-01', NULL,
   'D.L. 825 art. 14 (tasa fijada por Ley 19.888)', 'https://www.bcn.cl/leychile/navegar?idNorma=6369',
   NULL, 'APROBADO', 'migracion-0011', 'verificacion-documental-2026-10-29'),
  ('HONORARIOS.RETENCION', 14.5, 'PORCENTAJE', '2025-01-01', '2026-01-01',
   'Ley 21.133 (gradualidad de la retención de boletas de honorarios); SII', 'https://www.sii.cl/noticias/2025/261225noti01smn.htm',
   NULL, 'APROBADO', 'migracion-0011', 'verificacion-documental-2026-10-29'),
  ('HONORARIOS.RETENCION', 15.25, 'PORCENTAJE', '2026-01-01', '2027-01-01',
   'Ley 21.133 (gradualidad de la retención de boletas de honorarios); SII', 'https://www.sii.cl/noticias/2025/261225noti01smn.htm',
   'Termina el 31-12-2026: el valor de 2027 debe cargarse y aprobarse antes de usarse.', 'APROBADO', 'migracion-0011', 'verificacion-documental-2026-10-29');

-- Reglas de traspaso. Cada regla toma los documentos de un libro y de ciertos tipos
-- (y tipos de operación), cuenta documentos en un código y suma campos en otros.
-- Los campos "iva_credito" y "credito_uso_comun" se calculan al preparar (ver f29_preparar).
-- Los totales se arman con los signos del formulario. Montos en pesos.
INSERT INTO tablas_legales
  (clave, contenido, vigente_desde, vigente_hasta, fuente, url_fuente, nota, estado, cargado_por, aprobado_por)
SELECT 'F29.REGLAS_RCV', base || extra, desde, hasta,
       fuente, url, nota, 'APROBADO', 'migracion-0011', 'verificacion-documental-2026-10-29'
FROM (SELECT $json${
  "reglas": [
    {"nombre": "Facturas de venta del giro", "libro": "VENTA", "tipos": [30, 33], "operaciones": ["DEL_GIRO"],
     "cantidad": {"codigo": "503"},
     "montos": [{"campo": "monto_iva", "codigo": "502"}, {"campo": "monto_exento", "codigo": "142"},
                {"campo": "monto_neto", "codigo": "563"}, {"campo": "monto_exento", "codigo": "563"}]},
    {"nombre": "Facturas de venta de activo fijo (no del giro)", "libro": "VENTA", "tipos": [30, 33], "operaciones": ["ACTIVO_FIJO"],
     "cantidad": {"codigo": "716"},
     "montos": [{"campo": "monto_iva", "codigo": "717"}]},
    {"nombre": "Facturas de venta de bienes inmuebles", "libro": "VENTA", "tipos": [30, 33], "operaciones": ["BIENES_RAICES"],
     "cantidad": {"codigo": "763"},
     "montos": [{"campo": "monto_iva", "codigo": "764"}]},
    {"nombre": "Facturas de venta exentas", "libro": "VENTA", "tipos": [32, 34], "operaciones": ["DEL_GIRO"],
     "cantidad": {"codigo": "586"},
     "montos": [{"campo": "monto_exento", "codigo": "142"}, {"campo": "monto_exento", "codigo": "563"}]},
    {"nombre": "Boletas", "libro": "VENTA", "tipos": [35, 39], "operaciones": ["DEL_GIRO"],
     "cantidad": {"codigo": "110"},
     "montos": [{"campo": "monto_iva", "codigo": "111"}, {"campo": "monto_neto", "codigo": "563"}, {"campo": "monto_exento", "codigo": "563"}]},
    {"nombre": "Boletas exentas", "libro": "VENTA", "tipos": [38, 41], "operaciones": ["DEL_GIRO"],
     "cantidad": {"codigo": "586"},
     "montos": [{"campo": "monto_exento", "codigo": "142"}, {"campo": "monto_exento", "codigo": "563"}]},
    {"nombre": "Comprobantes de pago electrónico", "libro": "VENTA", "tipos": [48], "operaciones": ["DEL_GIRO"],
     "cantidad": {"codigo": "758"},
     "montos": [{"campo": "monto_iva", "codigo": "759"}, {"campo": "monto_neto", "codigo": "563"}, {"campo": "monto_exento", "codigo": "563"}]},
    {"nombre": "Notas de débito emitidas", "libro": "VENTA", "tipos": [55, 56], "operaciones": ["DEL_GIRO"],
     "cantidad": {"codigo": "512"},
     "montos": [{"campo": "monto_iva", "codigo": "513"}, {"campo": "monto_exento", "codigo": "142"},
                {"campo": "monto_neto", "codigo": "563"}, {"campo": "monto_exento", "codigo": "563"}]},
    {"nombre": "Notas de crédito emitidas", "libro": "VENTA", "tipos": [60, 61], "operaciones": ["DEL_GIRO"],
     "cantidad": {"codigo": "509"},
     "montos": [{"campo": "monto_iva", "codigo": "510"}, {"campo": "monto_exento", "codigo": "142", "signo": -1},
                {"campo": "monto_neto", "codigo": "563", "signo": -1}, {"campo": "monto_exento", "codigo": "563", "signo": -1}]},
    {"nombre": "Notas de crédito por ventas que no son del giro", "libro": "VENTA", "tipos": [60, 61], "operaciones": ["ACTIVO_FIJO", "BIENES_RAICES"],
     "cantidad": {"codigo": "733"},
     "montos": [{"campo": "monto_iva", "codigo": "734"}]},
    {"nombre": "Documentos de exportación", "libro": "VENTA", "tipos": [110, 111], "operaciones": ["DEL_GIRO"],
     "cantidad": {"codigo": "585"},
     "montos": [{"campo": "monto_exento", "codigo": "20"}, {"campo": "monto_neto", "codigo": "20"},
                {"campo": "monto_exento", "codigo": "563"}, {"campo": "monto_neto", "codigo": "563"}]},
    {"nombre": "Notas de crédito de exportación", "libro": "VENTA", "tipos": [112], "operaciones": ["DEL_GIRO"],
     "cantidad": {"codigo": "585"},
     "montos": [{"campo": "monto_exento", "codigo": "20", "signo": -1}, {"campo": "monto_neto", "codigo": "20", "signo": -1},
                {"campo": "monto_exento", "codigo": "563", "signo": -1}, {"campo": "monto_neto", "codigo": "563", "signo": -1}]},

    {"nombre": "Facturas de compra del giro (incluye IVA de uso común proporcional)", "libro": "COMPRA", "tipos": [30, 33], "operaciones": ["DEL_GIRO", "IVA_USO_COMUN"],
     "cantidad": {"codigo": "519"},
     "montos": [{"campo": "iva_credito", "codigo": "520"}]},
    {"nombre": "Facturas de supermercados y comercios similares", "libro": "COMPRA", "tipos": [30, 33], "operaciones": ["SUPERMERCADOS"],
     "cantidad": {"codigo": "761"},
     "montos": [{"campo": "iva_credito", "codigo": "762"}]},
    {"nombre": "Facturas de construcción o adquisición de inmuebles", "libro": "COMPRA", "tipos": [30, 33], "operaciones": ["BIENES_RAICES"],
     "cantidad": {"codigo": "765"},
     "montos": [{"campo": "iva_credito", "codigo": "766"}]},
    {"nombre": "Facturas de activo fijo", "libro": "COMPRA", "tipos": [30, 33], "operaciones": ["ACTIVO_FIJO"],
     "cantidad": {"codigo": "524"},
     "montos": [{"campo": "iva_credito", "codigo": "525"}]},
    {"nombre": "Compras afectas sin derecho a crédito", "libro": "COMPRA", "tipos": [30, 33], "operaciones": ["IVA_NO_RECUPERABLE"],
     "cantidad": {"codigo": "564"},
     "montos": [{"campo": "monto_neto", "codigo": "521"}]},
    {"nombre": "Parte exenta de facturas de compra", "libro": "COMPRA", "tipos": [30, 33], "operaciones": ["DEL_GIRO", "IVA_USO_COMUN", "SUPERMERCADOS", "BIENES_RAICES", "ACTIVO_FIJO", "IVA_NO_RECUPERABLE"],
     "montos": [{"campo": "monto_exento", "codigo": "562"}]},
    {"nombre": "Facturas de compra exentas o no gravadas", "libro": "COMPRA", "tipos": [32, 34], "operaciones": ["DEL_GIRO", "IVA_USO_COMUN", "SUPERMERCADOS", "BIENES_RAICES", "ACTIVO_FIJO", "IVA_NO_RECUPERABLE"],
     "cantidad": {"codigo": "584"},
     "montos": [{"campo": "monto_exento", "codigo": "562"}]},
    {"nombre": "Notas de crédito recibidas", "libro": "COMPRA", "tipos": [60, 61], "operaciones": ["DEL_GIRO", "IVA_USO_COMUN", "SUPERMERCADOS", "BIENES_RAICES", "ACTIVO_FIJO"],
     "cantidad": {"codigo": "527"},
     "montos": [{"campo": "iva_credito", "codigo": "528"}, {"campo": "monto_exento", "codigo": "562", "signo": -1}]},
    {"nombre": "Notas de débito recibidas", "libro": "COMPRA", "tipos": [55, 56], "operaciones": ["DEL_GIRO", "IVA_USO_COMUN", "SUPERMERCADOS", "BIENES_RAICES", "ACTIVO_FIJO"],
     "cantidad": {"codigo": "531"},
     "montos": [{"campo": "iva_credito", "codigo": "532"}, {"campo": "monto_exento", "codigo": "562"}]},
    {"nombre": "Declaraciones de importación (DIN)", "libro": "COMPRA", "tipos": [914], "operaciones": ["DEL_GIRO", "IVA_USO_COMUN"],
     "cantidad": {"codigo": "534"},
     "montos": [{"campo": "iva_credito", "codigo": "535"}]},
    {"nombre": "Declaraciones de importación de activo fijo", "libro": "COMPRA", "tipos": [914], "operaciones": ["ACTIVO_FIJO"],
     "cantidad": {"codigo": "536"},
     "montos": [{"campo": "iva_credito", "codigo": "553"}]}
  ],
  "totales": {
    "537": {"520": 1, "762": 1, "766": 1, "525": 1, "528": -1, "532": 1, "535": 1, "553": 1, "504": 1,
            "593": -1, "594": -1, "592": -1, "539": -1, "718": -1, "790": -1, "523": 1, "712": 1, "757": 1}
  },
  "suma_595": {"89": 1, "151": 1, "48": 1, "153": 1, "49": 1, "155": 1, "50": 1,
               "62": 1, "152": 1, "70": 1, "66": 1, "156": 1, "157": 1},
  "codigos_ajustables": ["503", "502", "142", "586", "110", "111", "758", "759", "512", "513", "509", "510",
                         "716", "717", "763", "764", "733", "734", "585", "20", "563",
                         "154", "518", "713", "791", "500", "501", "516", "517",
                         "519", "520", "761", "762", "765", "766", "524", "525", "527", "528", "531", "532",
                         "534", "535", "536", "553", "564", "521", "584", "562",
                         "593", "594", "592", "539", "718", "790", "523", "712", "757",
                         "151", "48", "153", "49", "155", "50", "152", "70", "66", "156", "157"]
}$json$::jsonb AS base) b,
(VALUES
  ('{"totales_538": {"502": 1, "764": 1, "717": 1, "111": 1, "759": 1, "513": 1, "510": -1, "709": -1, "734": -1,
                     "517": 1, "501": 1, "154": 1, "518": 1, "713": 1, "791": 1}}'::jsonb,
   '2025-01-01'::date, '2026-07-01'::date,
   'SII, Instrucciones de llenado del Formulario 29 (versión 12-11-2024)',
   'https://www.sii.cl/servicios_online/instrucciones_f29_20241112.pdf',
   'Traspaso RCV → F29 preparado con las instrucciones oficiales. Pendiente de validar contra tres F29 declarados de la empresa piloto. Liquidaciones-factura (tipo 43) y facturas de compra (tipo 46) se dejan como advertencia para revisión manual.'),
  ('{"totales_538": {"502": 1, "764": 1, "717": 1, "111": 1, "759": 1, "513": 1, "510": -1, "709": -1, "734": -1,
                     "517": 1, "501": 1, "818": -1, "154": 1, "518": 1, "713": 1, "791": 1},
     "codigos_ajustables_extra": ["817", "818"]}'::jsonb,
   '2026-07-01'::date, NULL::date,
   'SII, Instrucciones del F29 (12-11-2024) y Res. Ex. SII N°38 de 2026 (nueva línea 18, códigos 817 y 818)',
   'https://www.sii.cl/normativa_legislacion/resoluciones/2026/reso38.pdf',
   'Desde el período julio 2026: liquidaciones y liquidaciones-factura emitidas como mandatario (817 cantidad, 818 IVA por cuenta de terceros, resta débito). Pendiente de validar contra F29 declarados de la empresa piloto.')
) AS v(extra, desde, hasta, fuente, url, nota);

-- ---------------------------------------------------------------------------
-- Módulo contratado
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_modulo_vigente(p_empresa uuid, p_modulo text, p_fecha date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM suscripciones_modulo s
    WHERE s.empresa_id = p_empresa AND s.modulo_codigo = p_modulo
      AND daterange(s.vigente_desde, s.vigente_hasta, '[)') @> p_fecha
  )
$$;

-- Usuario con permiso y módulo TRIBUTARIO vigente en la fecha. Devuelve el usuario.
CREATE FUNCTION tributario_exigir(p_empresa uuid, p_permiso text, p_fecha date) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario uuid := contabilidad_exigir(p_empresa, p_permiso);
BEGIN
  IF NOT app_modulo_vigente(p_empresa, 'TRIBUTARIO', p_fecha) THEN
    RAISE EXCEPTION 'La empresa no tiene el módulo Tributario contratado para %', to_char(p_fecha, 'MM-YYYY')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_usuario;
END;
$$;

CREATE FUNCTION tributario_es_agente() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.actor_tipo', true), ''), 'USUARIO') <> 'USUARIO'
$$;

-- ---------------------------------------------------------------------------
-- Tasa de PPM por empresa (cambia cada año o por suspensión)
-- ---------------------------------------------------------------------------
CREATE TABLE tributario_tasas_ppm (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id        uuid NOT NULL REFERENCES empresas(id),
  vigente_desde     date NOT NULL CHECK (extract(day FROM vigente_desde) = 1),
  tasa              numeric(6, 3) NOT NULL CHECK (tasa >= 0 AND tasa <= 25),
  fuente            text NOT NULL CHECK (length(trim(fuente)) >= 5),
  estado            text NOT NULL DEFAULT 'VIGENTE' CHECK (estado IN ('VIGENTE', 'REEMPLAZADA')),
  -- Si corrige una tasa anterior del mismo mes, por qué.
  motivo_reemplazo  text,
  registrado_por    uuid NOT NULL REFERENCES usuarios(id),
  registrado_en     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tasas_ppm_vigente_uq ON tributario_tasas_ppm (empresa_id, vigente_desde) WHERE estado = 'VIGENTE';

-- ---------------------------------------------------------------------------
-- RCV
-- ---------------------------------------------------------------------------
CREATE TABLE rcv_importaciones (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id           uuid NOT NULL REFERENCES empresas(id),
  periodo              date NOT NULL CHECK (extract(day FROM periodo) = 1),
  libro                text NOT NULL CHECK (libro IN ('COMPRA', 'VENTA')),
  seccion              text NOT NULL CHECK (seccion IN ('REGISTRO', 'PENDIENTE', 'NO_INCLUIR', 'RECLAMADO')),
  estado               text NOT NULL DEFAULT 'VIGENTE' CHECK (estado IN ('VIGENTE', 'REEMPLAZADA')),
  origen               text NOT NULL CHECK (origen IN ('ARCHIVO_SII', 'ROBOT_SII')),
  archivo_nombre       text NOT NULL,
  archivo_sha256       text NOT NULL CHECK (archivo_sha256 ~ '^[0-9a-f]{64}$'),
  cantidad_documentos  int NOT NULL CHECK (cantidad_documentos >= 0),
  total_exento         numeric(18, 0) NOT NULL,
  total_neto           numeric(18, 0) NOT NULL,
  total_iva            numeric(18, 0) NOT NULL,
  total_general        numeric(18, 0) NOT NULL,
  importado_por        uuid NOT NULL REFERENCES usuarios(id),
  importado_en         timestamptz NOT NULL DEFAULT now(),
  reemplazada_en       timestamptz,
  CHECK (libro = 'COMPRA' OR seccion = 'REGISTRO'),
  CHECK ((estado = 'REEMPLAZADA') = (reemplazada_en IS NOT NULL))
);
CREATE UNIQUE INDEX rcv_importaciones_vigente_uq ON rcv_importaciones (empresa_id, periodo, libro, seccion)
  WHERE estado = 'VIGENTE';

CREATE TABLE rcv_documentos (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  importacion_id       uuid NOT NULL REFERENCES rcv_importaciones(id),
  empresa_id           uuid NOT NULL REFERENCES empresas(id),
  tipo_documento       int NOT NULL CHECK (tipo_documento > 0),
  tipo_operacion       text NOT NULL CHECK (tipo_operacion IN
                         ('DEL_GIRO', 'SUPERMERCADOS', 'BIENES_RAICES', 'ACTIVO_FIJO',
                          'IVA_USO_COMUN', 'IVA_NO_RECUPERABLE', 'NO_CORRESPONDE_INCLUIR')),
  rut_contraparte      text NOT NULL CHECK (rut_es_valido(rut_contraparte)),
  razon_social         text,
  folio                bigint NOT NULL CHECK (folio > 0),
  fecha_documento      date NOT NULL,
  fecha_recepcion      date,
  cantidad             int NOT NULL DEFAULT 1 CHECK (cantidad > 0),
  monto_exento         numeric(18, 0) NOT NULL DEFAULT 0 CHECK (monto_exento >= 0),
  monto_neto           numeric(18, 0) NOT NULL DEFAULT 0 CHECK (monto_neto >= 0),
  monto_iva            numeric(18, 0) NOT NULL DEFAULT 0 CHECK (monto_iva >= 0),
  iva_no_recuperable   numeric(18, 0) NOT NULL DEFAULT 0 CHECK (iva_no_recuperable >= 0),
  codigo_iva_no_recuperable int,
  iva_uso_comun        numeric(18, 0) NOT NULL DEFAULT 0 CHECK (iva_uso_comun >= 0),
  neto_activo_fijo     numeric(18, 0) NOT NULL DEFAULT 0 CHECK (neto_activo_fijo >= 0),
  iva_activo_fijo      numeric(18, 0) NOT NULL DEFAULT 0 CHECK (iva_activo_fijo >= 0),
  otros_impuestos      numeric(18, 0) NOT NULL DEFAULT 0 CHECK (otros_impuestos >= 0),
  -- Montos que el traspaso automático no considera; si vienen, la propuesta lo advierte.
  iva_retenido         numeric(18, 0) NOT NULL DEFAULT 0 CHECK (iva_retenido >= 0),
  iva_fuera_plazo      numeric(18, 0) NOT NULL DEFAULT 0 CHECK (iva_fuera_plazo >= 0),
  montos_especiales    numeric(18, 0) NOT NULL DEFAULT 0 CHECK (montos_especiales >= 0),
  monto_total          numeric(18, 0) NOT NULL CHECK (monto_total >= 0),
  UNIQUE (importacion_id, tipo_documento, rut_contraparte, folio)
);
CREATE INDEX rcv_documentos_importacion_idx ON rcv_documentos (importacion_id);

-- ---------------------------------------------------------------------------
-- F29
-- ---------------------------------------------------------------------------
CREATE TABLE f29_declaraciones (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id               uuid NOT NULL REFERENCES empresas(id),
  periodo                  date NOT NULL CHECK (extract(day FROM periodo) = 1),
  version                  int NOT NULL CHECK (version > 0),
  estado                   text NOT NULL DEFAULT 'BORRADOR'
                             CHECK (estado IN ('BORRADOR', 'REEMPLAZADA', 'APROBADA', 'DECLARADA', 'ANULADA')),
  codigos                  jsonb NOT NULL,
  detalle                  jsonb NOT NULL,
  advertencias             jsonb NOT NULL DEFAULT '[]',
  importacion_venta_id     uuid NOT NULL REFERENCES rcv_importaciones(id),
  importacion_compra_id    uuid NOT NULL REFERENCES rcv_importaciones(id),
  reglas_id                bigint NOT NULL REFERENCES tablas_legales(id),
  origen                   text NOT NULL CHECK (origen IN ('MANUAL', 'AGENTE', 'AGENTE_APROBADO')),
  preparado_por            uuid NOT NULL REFERENCES usuarios(id),
  preparado_en             timestamptz NOT NULL DEFAULT now(),
  aprobado_por             uuid REFERENCES usuarios(id),
  aprobado_en              timestamptz,
  folio_sii                text,
  fecha_declaracion        date,
  declaracion_registrada_por uuid REFERENCES usuarios(id),
  anulado_por              uuid REFERENCES usuarios(id),
  motivo_anulacion         text,
  UNIQUE (empresa_id, periodo, version),
  CHECK ((estado IN ('APROBADA', 'DECLARADA')) <= (aprobado_por IS NOT NULL)),
  CHECK ((estado = 'DECLARADA') = (folio_sii IS NOT NULL)),
  CHECK ((estado = 'ANULADA') = (motivo_anulacion IS NOT NULL))
);
-- Un solo F29 aprobado o declarado por período (las anuladas quedan en el historial).
CREATE UNIQUE INDEX f29_aprobada_uq ON f29_declaraciones (empresa_id, periodo)
  WHERE estado IN ('APROBADA', 'DECLARADA');
CREATE UNIQUE INDEX f29_borrador_uq ON f29_declaraciones (empresa_id, periodo)
  WHERE estado = 'BORRADOR';

-- ---------------------------------------------------------------------------
-- Inmutabilidad
-- ---------------------------------------------------------------------------
CREATE FUNCTION tributario_rechazar_cambios() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Los registros tributarios no se modifican ni se borran (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER rcv_documentos_inmutables BEFORE UPDATE OR DELETE ON rcv_documentos
  FOR EACH ROW EXECUTE FUNCTION tributario_rechazar_cambios();
CREATE TRIGGER rcv_documentos_sin_truncate BEFORE TRUNCATE ON rcv_documentos
  FOR EACH STATEMENT EXECUTE FUNCTION tributario_rechazar_cambios();
CREATE TRIGGER rcv_importaciones_sin_truncate BEFORE TRUNCATE ON rcv_importaciones
  FOR EACH STATEMENT EXECUTE FUNCTION tributario_rechazar_cambios();
CREATE TRIGGER f29_sin_truncate BEFORE TRUNCATE ON f29_declaraciones
  FOR EACH STATEMENT EXECUTE FUNCTION tributario_rechazar_cambios();
CREATE TRIGGER tasas_ppm_sin_truncate BEFORE TRUNCATE ON tributario_tasas_ppm
  FOR EACH STATEMENT EXECUTE FUNCTION tributario_rechazar_cambios();

-- Importación: solo pasa de VIGENTE a REEMPLAZADA; nada más cambia.
CREATE FUNCTION rcv_importacion_transicion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Las importaciones del RCV no se borran' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.estado <> 'VIGENTE' OR NEW.estado <> 'REEMPLAZADA'
     OR (to_jsonb(NEW) - 'estado' - 'reemplazada_en') IS DISTINCT FROM (to_jsonb(OLD) - 'estado' - 'reemplazada_en') THEN
    RAISE EXCEPTION 'Una importación del RCV solo puede quedar reemplazada' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rcv_importaciones_transicion BEFORE UPDATE OR DELETE ON rcv_importaciones
  FOR EACH ROW EXECUTE FUNCTION rcv_importacion_transicion();

-- Tasa de PPM: solo pasa de VIGENTE a REEMPLAZADA.
CREATE FUNCTION tasa_ppm_transicion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.estado <> 'VIGENTE' OR NEW.estado <> 'REEMPLAZADA'
     OR (to_jsonb(NEW) - 'estado') IS DISTINCT FROM (to_jsonb(OLD) - 'estado') THEN
    RAISE EXCEPTION 'Una tasa de PPM no se modifica ni se borra: se reemplaza con motivo' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tasas_ppm_transicion BEFORE UPDATE OR DELETE ON tributario_tasas_ppm
  FOR EACH ROW EXECUTE FUNCTION tasa_ppm_transicion();

-- F29: las cifras nunca cambian; el estado sigue su ciclo de vida.
CREATE FUNCTION f29_transicion() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cambiables text[] := ARRAY['estado', 'aprobado_por', 'aprobado_en', 'folio_sii', 'fecha_declaracion',
                               'declaracion_registrada_por', 'anulado_por', 'motivo_anulacion'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Los F29 no se borran: se anulan' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - v_cambiables) IS DISTINCT FROM (to_jsonb(OLD) - v_cambiables) THEN
    RAISE EXCEPTION 'Las cifras de un F29 no se modifican: prepare una nueva versión' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT ((OLD.estado = 'BORRADOR' AND NEW.estado IN ('REEMPLAZADA', 'APROBADA', 'ANULADA'))
       OR (OLD.estado = 'APROBADA' AND NEW.estado IN ('DECLARADA', 'ANULADA'))) THEN
    RAISE EXCEPTION 'Cambio de estado no permitido: % → %', OLD.estado, NEW.estado USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER f29_transiciones BEFORE UPDATE OR DELETE ON f29_declaraciones
  FOR EACH ROW EXECUTE FUNCTION f29_transicion();

-- ---------------------------------------------------------------------------
-- Funciones de operación
-- ---------------------------------------------------------------------------
CREATE FUNCTION tributario_configurar_ppm(p_empresa uuid, p_desde date, p_tasa numeric, p_fuente text,
  p_motivo_reemplazo text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario uuid := tributario_exigir(p_empresa, 'tributario.f29.aprobar', p_desde);
  v_anterior tributario_tasas_ppm;
BEGIN
  IF tributario_es_agente() THEN
    RAISE EXCEPTION 'La tasa de PPM la configura una persona' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_tasa IS NULL OR p_tasa = 'NaN' OR p_tasa < 0 OR p_tasa > 25 OR p_tasa <> round(p_tasa, 3) THEN
    RAISE EXCEPTION 'Tasa de PPM inválida' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ppm:' || p_empresa::text, 0));
  SELECT * INTO v_anterior FROM tributario_tasas_ppm
  WHERE empresa_id = p_empresa AND vigente_desde = p_desde AND estado = 'VIGENTE' FOR UPDATE;
  IF v_anterior.id IS NOT NULL THEN
    IF length(trim(coalesce(p_motivo_reemplazo, ''))) < 10 THEN
      RAISE EXCEPTION 'Ya hay una tasa de PPM desde %: indique el motivo del reemplazo (al menos 10 caracteres)', to_char(p_desde, 'MM-YYYY')
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE tributario_tasas_ppm SET estado = 'REEMPLAZADA' WHERE id = v_anterior.id;
  END IF;
  INSERT INTO tributario_tasas_ppm (empresa_id, vigente_desde, tasa, fuente, motivo_reemplazo, registrado_por)
  VALUES (p_empresa, p_desde, p_tasa, trim(p_fuente), nullif(trim(coalesce(p_motivo_reemplazo, '')), ''), v_usuario);
  PERFORM contabilidad_auditar('PPM_CONFIGURADO', 'tributario_tasas_ppm', p_empresa::text || ':' || p_desde::text,
    jsonb_build_object('desde', p_desde, 'tasa', p_tasa, 'fuente', p_fuente, 'tasa_anterior', v_anterior.tasa,
                       'motivo_reemplazo', p_motivo_reemplazo), p_empresa);
END;
$$;

-- Importa una sección del RCV. p_documentos es un arreglo JSON de objetos con los
-- campos de rcv_documentos. Devuelve la importación (la existente si el archivo es
-- idéntico al vigente).
CREATE FUNCTION rcv_registrar_importacion(
  p_empresa uuid, p_libro text, p_seccion text, p_anio int, p_mes int,
  p_origen text, p_archivo_nombre text, p_archivo_sha256 text, p_documentos jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_periodo date;
  v_usuario uuid;
  v_id uuid := gen_random_uuid();
  v_anterior rcv_importaciones;
  v_estado_f29 text;
  v_invalidos int;
BEGIN
  IF p_anio IS NULL OR p_mes IS NULL OR p_anio NOT BETWEEN 2000 AND 2100 OR p_mes NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'Período inválido' USING ERRCODE = 'check_violation';
  END IF;
  v_periodo := make_date(p_anio, p_mes, 1);
  v_usuario := tributario_exigir(p_empresa, 'tributario.rcv.importar', v_periodo);
  IF p_origen IS NULL OR p_origen NOT IN ('ARCHIVO_SII', 'ROBOT_SII') THEN
    RAISE EXCEPTION 'Origen de importación inválido' USING ERRCODE = 'check_violation';
  END IF;
  -- Solo el proceso automático del sistema declara que el archivo lo bajó el robot.
  IF p_origen = 'ROBOT_SII' AND coalesce(nullif(current_setting('app.actor_tipo', true), ''), 'USUARIO') <> 'SISTEMA' THEN
    RAISE EXCEPTION 'Solo el proceso del sistema registra importaciones del robot' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_archivo_sha256 IS NULL OR p_archivo_sha256 !~ '^[0-9a-f]{64}$' OR length(trim(coalesce(p_archivo_nombre, ''))) = 0 THEN
    RAISE EXCEPTION 'Archivo inválido' USING ERRCODE = 'check_violation';
  END IF;
  IF v_periodo > date_trunc('month', contabilidad_hoy())::date THEN
    RAISE EXCEPTION 'No se importa el RCV de un período futuro' USING ERRCODE = 'check_violation';
  END IF;
  IF p_documentos IS NULL OR jsonb_typeof(p_documentos) IS DISTINCT FROM 'array' OR jsonb_array_length(p_documentos) > 100000
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_documentos) x WHERE jsonb_typeof(x) <> 'object') THEN
    RAISE EXCEPTION 'Documentos inválidos (máximo 100.000 por archivo)' USING ERRCODE = 'check_violation';
  END IF;

  -- Una importación del mismo período a la vez.
  PERFORM pg_advisory_xact_lock(hashtextextended('rcv:' || p_empresa::text || ':' || v_periodo::text, 0));

  SELECT estado INTO v_estado_f29 FROM f29_declaraciones
  WHERE empresa_id = p_empresa AND periodo = v_periodo AND estado IN ('APROBADA', 'DECLARADA');
  IF v_estado_f29 = 'DECLARADA' THEN
    RAISE EXCEPTION 'El F29 de % ya fue declarado; el RCV de ese período no se reemplaza', to_char(v_periodo, 'MM-YYYY')
      USING ERRCODE = 'check_violation';
  ELSIF v_estado_f29 = 'APROBADA' THEN
    RAISE EXCEPTION 'El F29 de % está aprobado: anúlelo antes de reimportar el RCV', to_char(v_periodo, 'MM-YYYY')
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_anterior FROM rcv_importaciones
  WHERE empresa_id = p_empresa AND periodo = v_periodo AND libro = p_libro AND seccion = p_seccion AND estado = 'VIGENTE'
  FOR UPDATE;
  IF v_anterior.id IS NOT NULL AND v_anterior.archivo_sha256 = p_archivo_sha256 THEN
    RETURN v_anterior.id;
  END IF;
  IF v_anterior.id IS NOT NULL THEN
    UPDATE rcv_importaciones SET estado = 'REEMPLAZADA', reemplazada_en = now() WHERE id = v_anterior.id;
  END IF;

  -- Montos en pesos enteros de hasta 12 dígitos (numeric(18,0) redondearía en silencio),
  -- operaciones coherentes con el libro y fechas que corresponden al período.
  SELECT count(*) INTO v_invalidos
  FROM jsonb_to_recordset(p_documentos) AS d(monto_exento numeric, monto_neto numeric, monto_iva numeric,
    iva_no_recuperable numeric, iva_uso_comun numeric, neto_activo_fijo numeric, iva_activo_fijo numeric,
    otros_impuestos numeric, iva_retenido numeric, iva_fuera_plazo numeric, montos_especiales numeric,
    monto_total numeric, tipo_operacion text, fecha_documento date, fecha_recepcion date)
  WHERE EXISTS (SELECT 1 FROM unnest(ARRAY[d.monto_exento, d.monto_neto, d.monto_iva, d.iva_no_recuperable, d.iva_uso_comun,
                  d.neto_activo_fijo, d.iva_activo_fijo, d.otros_impuestos, d.iva_retenido, d.iva_fuera_plazo,
                  d.montos_especiales, d.monto_total]) m
                WHERE m IS NOT NULL AND (m = 'NaN' OR m <> trunc(m) OR m > 999999999999))
     OR d.tipo_operacion IS NULL
     OR (p_libro = 'VENTA' AND d.tipo_operacion IS DISTINCT FROM 'DEL_GIRO'
         AND d.tipo_operacion IS DISTINCT FROM 'BIENES_RAICES' AND d.tipo_operacion IS DISTINCT FROM 'ACTIVO_FIJO')
     OR d.fecha_documento IS NULL
     OR d.fecha_documento >= (v_periodo + interval '1 month')::date
     OR (p_libro = 'VENTA' AND d.fecha_documento < v_periodo)
     OR d.fecha_recepcion >= (v_periodo + interval '1 month')::date;
  IF v_invalidos > 0 THEN
    RAISE EXCEPTION '% documento(s) con montos inválidos, tipo de operación inválido para el libro de % o fechas que no corresponden a %',
      v_invalidos, lower(p_libro), to_char(v_periodo, 'MM-YYYY') USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO rcv_importaciones (id, empresa_id, periodo, libro, seccion, origen, archivo_nombre, archivo_sha256,
    cantidad_documentos, total_exento, total_neto, total_iva, total_general, importado_por)
  SELECT v_id, p_empresa, v_periodo, p_libro, p_seccion, p_origen, left(trim(p_archivo_nombre), 200), p_archivo_sha256,
    count(*)::int, coalesce(sum(d.monto_exento), 0), coalesce(sum(d.monto_neto), 0), coalesce(sum(d.monto_iva), 0),
    coalesce(sum(d.monto_total), 0), v_usuario
  FROM jsonb_to_recordset(p_documentos) AS d(monto_exento numeric, monto_neto numeric, monto_iva numeric, monto_total numeric);

  INSERT INTO rcv_documentos (importacion_id, empresa_id, tipo_documento, tipo_operacion, rut_contraparte, razon_social,
    folio, fecha_documento, fecha_recepcion, cantidad, monto_exento, monto_neto, monto_iva, iva_no_recuperable,
    codigo_iva_no_recuperable, iva_uso_comun, neto_activo_fijo, iva_activo_fijo, otros_impuestos,
    iva_retenido, iva_fuera_plazo, montos_especiales, monto_total)
  SELECT v_id, p_empresa, d.tipo_documento, d.tipo_operacion, d.rut_contraparte, left(d.razon_social, 200),
    d.folio, d.fecha_documento, d.fecha_recepcion, coalesce(d.cantidad, 1), coalesce(d.monto_exento, 0), coalesce(d.monto_neto, 0),
    coalesce(d.monto_iva, 0), coalesce(d.iva_no_recuperable, 0), d.codigo_iva_no_recuperable, coalesce(d.iva_uso_comun, 0),
    coalesce(d.neto_activo_fijo, 0), coalesce(d.iva_activo_fijo, 0), coalesce(d.otros_impuestos, 0),
    coalesce(d.iva_retenido, 0), coalesce(d.iva_fuera_plazo, 0), coalesce(d.montos_especiales, 0), d.monto_total
  FROM jsonb_to_recordset(p_documentos) AS d(
    tipo_documento int, tipo_operacion text, rut_contraparte text, razon_social text, folio bigint,
    fecha_documento date, fecha_recepcion date, cantidad int, monto_exento numeric, monto_neto numeric, monto_iva numeric,
    iva_no_recuperable numeric, codigo_iva_no_recuperable int, iva_uso_comun numeric, neto_activo_fijo numeric,
    iva_activo_fijo numeric, otros_impuestos numeric, iva_retenido numeric, iva_fuera_plazo numeric,
    montos_especiales numeric, monto_total numeric);

  PERFORM contabilidad_auditar('RCV_IMPORTADO', 'rcv_importaciones', v_id::text,
    jsonb_build_object('libro', p_libro, 'seccion', p_seccion, 'periodo', v_periodo, 'origen', p_origen,
                       'archivo', p_archivo_nombre, 'sha256', p_archivo_sha256,
                       'documentos', jsonb_array_length(p_documentos), 'reemplaza', v_anterior.id), p_empresa);
  RETURN v_id;
END;
$$;

-- Prepara una propuesta de F29 (nueva versión en BORRADOR). Orden del cálculo:
-- traspaso del RCV → remanente reajustado (504) → ajustes con motivo → PPM → totales.
CREATE FUNCTION f29_preparar(
  p_empresa uuid, p_anio int, p_mes int,
  p_remanente_anterior numeric DEFAULT NULL,
  p_factor_proporcionalidad numeric DEFAULT NULL,
  p_ajustes jsonb DEFAULT '[]'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_periodo date;
  v_anterior date;
  v_siguiente date;
  v_usuario uuid;
  v_reglas tablas_legales;
  v_venta uuid;
  v_compra uuid;
  v_pendiente uuid;
  v_cod jsonb;
  v_aplicadas jsonb;
  v_sin_regla jsonb;
  v_especiales jsonb;
  v_adv jsonb := '[]';
  v_n int;
  v_uso_comun int;
  v_factor numeric;
  v_f29_ant f29_declaraciones;
  v_rem numeric;
  v_rem_origen text;
  v_utm_imputacion numeric;
  v_utm_pago numeric;
  v_tasa tributario_tasas_ppm;
  v_ajustables jsonb;
  v_ajuste jsonb;
  v_codigo text;
  v_monto numeric;
  v_k text;
  v_signo numeric;
  v_538 numeric := 0;
  v_537 numeric := 0;
  v_595 numeric := 0;
  v_version int;
  v_id uuid := gen_random_uuid();
  v_propuesta text := nullif(current_setting('app.propuesta_agente', true), '');
  v_origen text;
BEGIN
  IF p_anio IS NULL OR p_mes IS NULL OR p_anio NOT BETWEEN 2000 AND 2100 OR p_mes NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'Período inválido' USING ERRCODE = 'check_violation';
  END IF;
  v_periodo := make_date(p_anio, p_mes, 1);
  v_anterior := (v_periodo - interval '1 month')::date;
  v_siguiente := (v_periodo + interval '1 month')::date;
  v_usuario := tributario_exigir(p_empresa, 'tributario.f29.preparar', v_periodo);
  IF v_periodo > date_trunc('month', contabilidad_hoy())::date THEN
    RAISE EXCEPTION 'No se prepara el F29 de un período futuro' USING ERRCODE = 'check_violation';
  END IF;

  -- Origen: un agente directo, o una propuesta del agente que una persona aprobó.
  IF tributario_es_agente() THEN
    v_origen := 'AGENTE';
  ELSIF v_propuesta IS NOT NULL AND EXISTS (
      SELECT 1 FROM propuestas_agente WHERE id::text = v_propuesta AND empresa_id = p_empresa
        AND herramienta = 'preparar_f29' AND estado = 'PENDIENTE') THEN
    v_origen := 'AGENTE_APROBADO';
  ELSE
    v_origen := 'MANUAL';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('rcv:' || p_empresa::text || ':' || v_periodo::text, 0));

  IF EXISTS (SELECT 1 FROM f29_declaraciones WHERE empresa_id = p_empresa AND periodo = v_periodo
             AND estado IN ('APROBADA', 'DECLARADA')) THEN
    RAISE EXCEPTION 'El F29 de % ya está aprobado o declarado', to_char(v_periodo, 'MM-YYYY') USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_reglas FROM normativa_tabla('F29.REGLAS_RCV', v_periodo);
  IF v_reglas.id IS NULL THEN
    RAISE EXCEPTION 'No hay reglas de F29 aprobadas para %', to_char(v_periodo, 'MM-YYYY') USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO v_venta FROM rcv_importaciones WHERE empresa_id = p_empresa AND periodo = v_periodo
    AND libro = 'VENTA' AND seccion = 'REGISTRO' AND estado = 'VIGENTE';
  SELECT id INTO v_compra FROM rcv_importaciones WHERE empresa_id = p_empresa AND periodo = v_periodo
    AND libro = 'COMPRA' AND seccion = 'REGISTRO' AND estado = 'VIGENTE';
  SELECT id INTO v_pendiente FROM rcv_importaciones WHERE empresa_id = p_empresa AND periodo = v_periodo
    AND libro = 'COMPRA' AND seccion = 'PENDIENTE' AND estado = 'VIGENTE';
  IF v_venta IS NULL OR v_compra IS NULL THEN
    RAISE EXCEPTION 'Falta importar el registro de % de %. Si no hubo movimientos, importe el archivo del SII sin documentos',
      CASE WHEN v_venta IS NULL THEN 'ventas' ELSE 'compras' END, to_char(v_periodo, 'MM-YYYY')
      USING ERRCODE = 'check_violation';
  END IF;

  -- IVA de uso común: crédito proporcional (art. 23 N°3 D.L. 825) con el factor que informa el contador.
  SELECT count(*) INTO v_uso_comun FROM rcv_documentos WHERE importacion_id = v_compra AND tipo_operacion = 'IVA_USO_COMUN';
  IF v_uso_comun > 0 THEN
    IF p_factor_proporcionalidad IS NULL OR p_factor_proporcionalidad = 'NaN'
       OR p_factor_proporcionalidad < 0 OR p_factor_proporcionalidad > 1 THEN
      RAISE EXCEPTION 'Hay % documento(s) con IVA de uso común: indique el factor de proporcionalidad (entre 0 y 1)', v_uso_comun
        USING ERRCODE = 'check_violation';
    END IF;
    v_factor := p_factor_proporcionalidad;
    v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'FACTOR_INFORMADO',
      'mensaje', format('El crédito de IVA de uso común (%s documento(s)) usa un factor de proporcionalidad de %s, informado %s. Verifique su cálculo.',
                        v_uso_comun, v_factor, CASE WHEN v_origen = 'MANUAL' THEN 'por el usuario' ELSE 'por el agente' END)));
  END IF;

  -- Traspaso del RCV según las reglas vigentes. El crédito de uso común se suma sin
  -- redondear y cada código se redondea al final (el factor se aplica sobre el total).
  WITH docs AS (
    SELECT d.id, i.libro, d.tipo_documento, d.tipo_operacion, d.folio, d.cantidad,
           jsonb_build_object(
             'monto_exento', d.monto_exento, 'monto_neto', d.monto_neto, 'monto_iva', d.monto_iva,
             'iva_credito', CASE d.tipo_operacion
               WHEN 'ACTIVO_FIJO' THEN CASE WHEN d.iva_activo_fijo > 0 THEN d.iva_activo_fijo ELSE d.monto_iva END
               WHEN 'IVA_USO_COMUN' THEN CASE WHEN d.iva_uso_comun > 0 THEN d.iva_uso_comun ELSE d.monto_iva END * v_factor
               WHEN 'IVA_NO_RECUPERABLE' THEN 0
               ELSE d.monto_iva END) AS v
    FROM rcv_documentos d JOIN rcv_importaciones i ON i.id = d.importacion_id
    WHERE d.importacion_id IN (v_venta, v_compra)
  ), coinc AS (
    SELECT g.r, d.*
    FROM jsonb_array_elements(v_reglas.contenido -> 'reglas') AS g(r)
    JOIN docs d ON d.libro = g.r ->> 'libro'
               AND g.r -> 'tipos' @> to_jsonb(d.tipo_documento)
               AND g.r -> 'operaciones' @> to_jsonb(d.tipo_operacion)
  ), aportes AS (
    SELECT c.r -> 'cantidad' ->> 'codigo' AS codigo, c.cantidad::numeric AS valor FROM coinc c WHERE c.r ? 'cantidad'
    UNION ALL
    SELECT m ->> 'codigo', coalesce((m ->> 'signo')::numeric, 1) * (c.v ->> (m ->> 'campo'))::numeric
    FROM coinc c CROSS JOIN jsonb_array_elements(c.r -> 'montos') AS m
  )
  SELECT
    (SELECT coalesce(jsonb_object_agg(codigo, total), '{}')
       FROM (SELECT codigo, round(sum(valor)) AS total FROM aportes GROUP BY codigo) t),
    (SELECT coalesce(jsonb_agg(jsonb_build_object('regla', nombre, 'documentos', n) ORDER BY nombre), '[]')
       FROM (SELECT c.r ->> 'nombre' AS nombre, sum(c.cantidad) AS n FROM coinc c GROUP BY 1) t),
    (SELECT coalesce(jsonb_agg(jsonb_build_object('libro', libro, 'tipo_documento', tipo_documento,
                     'tipo_operacion', tipo_operacion, 'documentos', n, 'folios', folios)), '[]')
       FROM (SELECT d.libro, d.tipo_documento, d.tipo_operacion, count(*) AS n,
                    (array_agg(d.folio ORDER BY d.folio))[1:20] AS folios
             FROM docs d
             WHERE NOT EXISTS (SELECT 1 FROM coinc c WHERE c.id = d.id)
             GROUP BY 1, 2, 3) t)
  INTO v_cod, v_aplicadas, v_sin_regla;

  IF jsonb_array_length(v_sin_regla) > 0 THEN
    v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'DOCUMENTOS_SIN_REGLA',
      'mensaje', 'Hay documentos que no se traspasan automáticamente (liquidaciones-factura, facturas de compra, otros tipos o marcados "no corresponde incluir"). Revíselos y agregue los ajustes que correspondan.',
      'detalle', v_sin_regla));
  END IF;

  -- Montos que el traspaso automático no considera (cambio de sujeto, notas de crédito fuera
  -- de plazo, crédito de empresas constructoras, IVA de terceros, otros impuestos).
  SELECT coalesce(jsonb_agg(x), '[]') INTO v_especiales FROM (
    SELECT jsonb_build_object('concepto', concepto, 'documentos', count(*), 'monto', sum(monto),
                              'folios', (array_agg(folio ORDER BY folio))[1:20]) AS x
    FROM (
      SELECT d.folio, c.concepto, c.monto
      FROM rcv_documentos d
      CROSS JOIN LATERAL (VALUES
        ('IVA retenido (cambio de sujeto)', d.iva_retenido),
        ('IVA de nota de crédito fuera de plazo', d.iva_fuera_plazo),
        ('Crédito de empresa constructora o IVA de terceros', d.montos_especiales),
        ('Otros impuestos', d.otros_impuestos)) AS c(concepto, monto)
      WHERE d.importacion_id IN (v_venta, v_compra) AND c.monto > 0
    ) t GROUP BY concepto ORDER BY concepto) y;
  IF jsonb_array_length(v_especiales) > 0 THEN
    v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'DOCUMENTOS_CON_MONTOS_ESPECIALES',
      'mensaje', 'Hay documentos con IVA retenido, notas de crédito fuera de plazo, crédito de empresa constructora, IVA de terceros u otros impuestos. El traspaso automático no los considera: revíselos y agregue los ajustes que correspondan.',
      'detalle', v_especiales));
  END IF;

  SELECT coalesce(sum(d.cantidad), 0) INTO v_n FROM rcv_documentos d WHERE d.importacion_id = v_pendiente;
  IF v_n > 0 THEN
    v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'COMPRAS_PENDIENTES',
      'mensaje', format('Hay %s documento(s) de compra pendientes de aceptar o reclamar; no se incluyen en el crédito.', v_n)));
  END IF;

  -- Remanente del período anterior (código 77). Art. 27 D.L. 825: se convierte a UTM del
  -- mes en que debió pagarse el impuesto del período anterior (este período) y se
  -- reconvierte a la UTM del mes en que se imputa (el mes en que se declara este F29).
  SELECT * INTO v_f29_ant FROM f29_declaraciones
  WHERE empresa_id = p_empresa AND periodo = v_anterior AND estado IN ('BORRADOR', 'APROBADA', 'DECLARADA')
  ORDER BY (estado = 'BORRADOR') LIMIT 1
  FOR SHARE;
  IF v_f29_ant.estado = 'BORRADOR' THEN
    RAISE EXCEPTION 'El F29 de % está en borrador: apruébelo para tomar su remanente, o anúlelo', to_char(v_anterior, 'MM-YYYY')
      USING ERRCODE = 'check_violation';
  ELSIF v_f29_ant.id IS NOT NULL THEN
    IF p_remanente_anterior IS NOT NULL THEN
      RAISE EXCEPTION 'El remanente se toma del F29 de % registrado en el sistema; no se informa a mano', to_char(v_anterior, 'MM-YYYY')
        USING ERRCODE = 'check_violation';
    END IF;
    v_rem := coalesce((v_f29_ant.codigos ->> '77')::numeric, 0);
    v_rem_origen := format('F29 de %s (versión %s, %s)', to_char(v_anterior, 'MM-YYYY'), v_f29_ant.version, lower(v_f29_ant.estado));
  ELSE
    IF p_remanente_anterior IS NULL THEN
      RAISE EXCEPTION 'Indique el remanente de crédito fiscal del F29 de % (código 77); si no hubo, indique 0', to_char(v_anterior, 'MM-YYYY')
        USING ERRCODE = 'check_violation';
    END IF;
    IF p_remanente_anterior = 'NaN' OR p_remanente_anterior < 0 OR p_remanente_anterior <> trunc(p_remanente_anterior)
       OR p_remanente_anterior > 999999999999999 THEN
      RAISE EXCEPTION 'El remanente debe ser un monto en pesos, entero y no negativo' USING ERRCODE = 'check_violation';
    END IF;
    v_rem := p_remanente_anterior;
    v_rem_origen := CASE WHEN v_origen = 'MANUAL' THEN 'Informado por el usuario' ELSE 'Informado al agente' END;
    v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'REMANENTE_INFORMADO',
      'mensaje', format('El remanente del F29 de %s ($%s) no está en el sistema y fue informado %s: verifíquelo contra el F29 declarado.',
                        to_char(v_anterior, 'MM-YYYY'), v_rem, CASE WHEN v_origen = 'MANUAL' THEN 'por el usuario' ELSE 'al agente' END)));
  END IF;
  IF v_rem > 0 THEN
    SELECT valor INTO v_utm_pago FROM indicadores_economicos WHERE tipo = 'UTM' AND fecha = v_periodo;
    SELECT valor INTO v_utm_imputacion FROM indicadores_economicos WHERE tipo = 'UTM' AND fecha = v_siguiente;
    IF v_utm_pago IS NULL OR v_utm_imputacion IS NULL THEN
      RAISE EXCEPTION 'Falta la UTM de % o de % para reajustar el remanente', to_char(v_periodo, 'MM-YYYY'), to_char(v_siguiente, 'MM-YYYY')
        USING ERRCODE = 'check_violation';
    END IF;
    v_cod := v_cod || jsonb_build_object('504', round(v_rem * v_utm_imputacion / v_utm_pago));
  ELSE
    v_cod := v_cod || jsonb_build_object('504', 0);
  END IF;

  -- Ajustes manuales por código, cada uno con su motivo.
  v_ajustables := (v_reglas.contenido -> 'codigos_ajustables') || coalesce(v_reglas.contenido -> 'codigos_ajustables_extra', '[]');
  IF p_ajustes IS NULL OR jsonb_typeof(p_ajustes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_ajustes) > 50 THEN
    RAISE EXCEPTION 'Ajustes inválidos (máximo 50)' USING ERRCODE = 'check_violation';
  END IF;
  FOR v_ajuste IN SELECT * FROM jsonb_array_elements(p_ajustes) LOOP
    IF jsonb_typeof(v_ajuste) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Ajuste inválido' USING ERRCODE = 'check_violation';
    END IF;
    v_codigo := v_ajuste ->> 'codigo';
    IF v_codigo IS NULL OR NOT v_ajustables @> to_jsonb(v_codigo) THEN
      RAISE EXCEPTION 'El código % no admite ajustes manuales', coalesce(v_codigo, '(vacío)') USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_typeof(v_ajuste -> 'monto') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Ajuste del código %: monto inválido', v_codigo USING ERRCODE = 'check_violation';
    END IF;
    v_monto := (v_ajuste ->> 'monto')::numeric;
    IF v_monto = 0 OR v_monto <> trunc(v_monto) OR abs(v_monto) > 999999999999999 THEN
      RAISE EXCEPTION 'Ajuste del código %: el monto debe ser un entero distinto de cero', v_codigo USING ERRCODE = 'check_violation';
    END IF;
    IF length(trim(coalesce(v_ajuste ->> 'motivo', ''))) < 10 THEN
      RAISE EXCEPTION 'Ajuste del código %: indique el motivo (al menos 10 caracteres)', v_codigo USING ERRCODE = 'check_violation';
    END IF;
    v_cod := v_cod || jsonb_build_object(v_codigo, coalesce((v_cod ->> v_codigo)::numeric, 0) + v_monto);
  END LOOP;

  -- PPM: base (563) por la tasa vigente de la empresa.
  SELECT * INTO v_tasa FROM tributario_tasas_ppm
  WHERE empresa_id = p_empresa AND estado = 'VIGENTE' AND vigente_desde <= v_periodo
  ORDER BY vigente_desde DESC LIMIT 1;
  IF v_tasa.id IS NULL THEN
    RAISE EXCEPTION 'Configure la tasa de PPM de la empresa vigente para %', to_char(v_periodo, 'MM-YYYY')
      USING ERRCODE = 'check_violation';
  END IF;
  v_cod := v_cod || jsonb_build_object('563', coalesce((v_cod ->> '563')::numeric, 0), '115', v_tasa.tasa);
  v_cod := v_cod || jsonb_build_object('62', greatest(round((v_cod ->> '563')::numeric * v_tasa.tasa / 100), 0));

  -- Totales con los signos del formulario.
  FOR v_k, v_signo IN SELECT key, value::numeric FROM jsonb_each_text(v_reglas.contenido -> 'totales_538') LOOP
    v_538 := v_538 + v_signo * coalesce((v_cod ->> v_k)::numeric, 0);
  END LOOP;
  FOR v_k, v_signo IN SELECT key, value::numeric FROM jsonb_each_text(v_reglas.contenido -> 'totales' -> '537') LOOP
    v_537 := v_537 + v_signo * coalesce((v_cod ->> v_k)::numeric, 0);
  END LOOP;
  v_cod := v_cod || jsonb_build_object('538', v_538, '537', v_537,
    '89', greatest(v_538 - v_537, 0), '77', greatest(v_537 - v_538, 0));
  FOR v_k, v_signo IN SELECT key, value::numeric FROM jsonb_each_text(v_reglas.contenido -> 'suma_595') LOOP
    v_595 := v_595 + v_signo * coalesce((v_cod ->> v_k)::numeric, 0);
  END LOOP;
  v_cod := v_cod || jsonb_build_object('595', v_595, '91', greatest(v_595, 0));

  SELECT coalesce(jsonb_agg(key ORDER BY key), '[]') INTO v_sin_regla
  FROM jsonb_each_text(v_cod) WHERE key <> '115' AND value::numeric < 0;
  IF jsonb_array_length(v_sin_regla) > 0 THEN
    v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'CODIGOS_NEGATIVOS',
      'mensaje', 'Hay códigos con valor negativo (por ejemplo, más notas de crédito que ventas). Revise antes de aprobar.',
      'detalle', v_sin_regla));
  END IF;
  IF jsonb_array_length(p_ajustes) > 0 THEN
    v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'AJUSTES_MANUALES',
      'mensaje', format('La propuesta incluye %s ajuste(s) manual(es).', jsonb_array_length(p_ajustes))));
  END IF;

  UPDATE f29_declaraciones SET estado = 'REEMPLAZADA'
  WHERE empresa_id = p_empresa AND periodo = v_periodo AND estado = 'BORRADOR';
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM f29_declaraciones WHERE empresa_id = p_empresa AND periodo = v_periodo;

  INSERT INTO f29_declaraciones (id, empresa_id, periodo, version, codigos, detalle, advertencias,
    importacion_venta_id, importacion_compra_id, reglas_id, origen, preparado_por)
  VALUES (v_id, p_empresa, v_periodo, v_version, v_cod,
    jsonb_build_object(
      'reglas_aplicadas', v_aplicadas,
      'ajustes', p_ajustes,
      'ppm', jsonb_build_object('id', v_tasa.id, 'tasa', v_tasa.tasa, 'vigente_desde', v_tasa.vigente_desde, 'fuente', v_tasa.fuente),
      'remanente', jsonb_build_object('origen', v_rem_origen, 'f29_id', v_f29_ant.id, 'monto_codigo_77_anterior', v_rem,
                                      'utm_mes_pago', v_utm_pago, 'utm_mes_imputacion', v_utm_imputacion),
      'factor_proporcionalidad', v_factor,
      'importacion_pendiente_id', v_pendiente,
      'propuesta_agente_id', CASE WHEN v_origen = 'AGENTE_APROBADO' THEN v_propuesta END,
      'normativa', jsonb_build_object('id', v_reglas.id, 'fuente', v_reglas.fuente, 'url', v_reglas.url_fuente)),
    v_adv, v_venta, v_compra, v_reglas.id, v_origen, v_usuario);

  PERFORM contabilidad_auditar('F29_PREPARADO', 'f29_declaraciones', v_id::text,
    jsonb_build_object('periodo', v_periodo, 'version', v_version, 'origen', v_origen,
                       'iva_determinado', v_cod -> '89', 'remanente', v_cod -> '77', 'total_a_pagar', v_cod -> '91',
                       'ajustes', jsonb_array_length(p_ajustes)), p_empresa);
  RETURN v_id;
END;
$$;

-- Carga y valida el F29 para un cambio de estado hecho por una persona. Toma primero
-- el candado del período (el mismo que la importación del RCV y la preparación), y
-- el del mes siguiente si se pide, para no cruzarse con ellas.
CREATE FUNCTION f29_para_cambio(p_id uuid, p_bloquear_siguiente boolean DEFAULT false) RETURNS f29_declaraciones
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_empresa uuid;
  v_periodo date;
  v f29_declaraciones;
BEGIN
  SELECT empresa_id, periodo INTO v_empresa, v_periodo FROM f29_declaraciones WHERE id = p_id;
  IF v_empresa IS NULL OR v_empresa IS DISTINCT FROM app_empresa_id() THEN
    RAISE EXCEPTION 'F29 no encontrado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM tributario_exigir(v_empresa, 'tributario.f29.aprobar', v_periodo);
  IF tributario_es_agente() THEN
    RAISE EXCEPTION 'Solo una persona aprueba, anula o registra la declaración de un F29' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rcv:' || v_empresa::text || ':' || v_periodo::text, 0));
  IF p_bloquear_siguiente THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('rcv:' || v_empresa::text || ':' || (v_periodo + interval '1 month')::date::text, 0));
  END IF;
  SELECT * INTO v FROM f29_declaraciones WHERE id = p_id FOR UPDATE;
  RETURN v;
END;
$$;

CREATE FUNCTION f29_aprobar(p_id uuid, p_confirmo_advertencias boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v f29_declaraciones := f29_para_cambio(p_id);
  v_rem_f29 uuid := (v.detalle -> 'remanente' ->> 'f29_id')::uuid;
  v_pendiente uuid;
BEGIN
  IF v.estado <> 'BORRADOR' THEN
    RAISE EXCEPTION 'Solo se aprueba un F29 en borrador (está %)', lower(v.estado) USING ERRCODE = 'check_violation';
  END IF;
  IF contabilidad_hoy() < (v.periodo + interval '1 month')::date THEN
    RAISE EXCEPTION 'El período % aún no termina', to_char(v.periodo, 'MM-YYYY') USING ERRCODE = 'check_violation';
  END IF;

  -- Todo lo que se usó para preparar la propuesta debe seguir vigente.
  SELECT id INTO v_pendiente FROM rcv_importaciones WHERE empresa_id = v.empresa_id AND periodo = v.periodo
    AND libro = 'COMPRA' AND seccion = 'PENDIENTE' AND estado = 'VIGENTE';
  IF EXISTS (SELECT 1 FROM rcv_importaciones WHERE id IN (v.importacion_venta_id, v.importacion_compra_id) AND estado <> 'VIGENTE')
     OR v_pendiente IS DISTINCT FROM (v.detalle ->> 'importacion_pendiente_id')::uuid THEN
    RAISE EXCEPTION 'El RCV se reimportó después de preparar esta propuesta: prepárela de nuevo' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tributario_tasas_ppm WHERE id = (v.detalle -> 'ppm' ->> 'id')::bigint AND estado = 'VIGENTE') THEN
    RAISE EXCEPTION 'La tasa de PPM cambió después de preparar esta propuesta: prepárela de nuevo' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT id FROM normativa_tabla('F29.REGLAS_RCV', v.periodo)) IS DISTINCT FROM v.reglas_id THEN
    RAISE EXCEPTION 'Las reglas del F29 cambiaron después de preparar esta propuesta: prepárela de nuevo' USING ERRCODE = 'check_violation';
  END IF;
  IF v_rem_f29 IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM f29_declaraciones WHERE id = v_rem_f29 AND estado IN ('APROBADA', 'DECLARADA')) THEN
      RAISE EXCEPTION 'El F29 del mes anterior, del que se tomó el remanente, ya no está vigente: prepare de nuevo' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM f29_declaraciones WHERE empresa_id = v.empresa_id
                AND periodo = (v.periodo - interval '1 month')::date AND estado IN ('BORRADOR', 'APROBADA', 'DECLARADA')) THEN
    RAISE EXCEPTION 'Ahora hay un F29 del mes anterior en el sistema: prepare de nuevo para tomar su remanente' USING ERRCODE = 'check_violation';
  END IF;

  IF jsonb_array_length(v.advertencias) > 0 AND p_confirmo_advertencias IS NOT TRUE THEN
    RAISE EXCEPTION 'La propuesta tiene % advertencia(s): revíselas y confirme para aprobar', jsonb_array_length(v.advertencias)
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE f29_declaraciones SET estado = 'APROBADA', aprobado_por = app_usuario_id(), aprobado_en = now() WHERE id = p_id;
  PERFORM contabilidad_auditar('F29_APROBADO', 'f29_declaraciones', p_id::text,
    jsonb_build_object('periodo', v.periodo, 'version', v.version, 'advertencias_confirmadas', jsonb_array_length(v.advertencias),
                       'total_a_pagar', v.codigos -> '91'), v.empresa_id);
END;
$$;

CREATE FUNCTION f29_registrar_declaracion(p_id uuid, p_folio text, p_fecha date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v f29_declaraciones := f29_para_cambio(p_id);
BEGIN
  IF v.estado <> 'APROBADA' THEN
    RAISE EXCEPTION 'Solo se registra la declaración de un F29 aprobado' USING ERRCODE = 'check_violation';
  END IF;
  IF p_folio IS NULL OR p_folio !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'Folio del SII inválido' USING ERRCODE = 'check_violation';
  END IF;
  IF p_fecha IS NULL OR p_fecha < (v.periodo + interval '1 month')::date OR p_fecha > contabilidad_hoy() THEN
    RAISE EXCEPTION 'La fecha de declaración debe ser posterior al período y no futura' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE f29_declaraciones SET estado = 'DECLARADA', folio_sii = p_folio, fecha_declaracion = p_fecha,
    declaracion_registrada_por = app_usuario_id() WHERE id = p_id;
  PERFORM contabilidad_auditar('F29_DECLARADO', 'f29_declaraciones', p_id::text,
    jsonb_build_object('periodo', v.periodo, 'folio', p_folio, 'fecha', p_fecha), v.empresa_id);
END;
$$;

CREATE FUNCTION f29_anular(p_id uuid, p_motivo text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v f29_declaraciones := f29_para_cambio(p_id, true);
BEGIN
  IF v.estado NOT IN ('BORRADOR', 'APROBADA') THEN
    RAISE EXCEPTION 'Un F29 % no se anula%', lower(v.estado),
      CASE WHEN v.estado = 'DECLARADA' THEN ': corresponde una rectificatoria ante el SII' ELSE '' END
      USING ERRCODE = 'check_violation';
  END IF;
  IF length(trim(coalesce(p_motivo, ''))) < 10 THEN
    RAISE EXCEPTION 'Indique el motivo de la anulación (al menos 10 caracteres)' USING ERRCODE = 'check_violation';
  END IF;
  IF v.estado = 'APROBADA' AND EXISTS (SELECT 1 FROM f29_declaraciones WHERE empresa_id = v.empresa_id
       AND periodo = (v.periodo + interval '1 month')::date AND estado IN ('BORRADOR', 'APROBADA', 'DECLARADA')) THEN
    RAISE EXCEPTION 'El F29 del mes siguiente usa el remanente de este: anúlelo primero' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE f29_declaraciones SET estado = 'ANULADA', anulado_por = app_usuario_id(), motivo_anulacion = trim(p_motivo) WHERE id = p_id;
  PERFORM contabilidad_auditar('F29_ANULADO', 'f29_declaraciones', p_id::text,
    jsonb_build_object('periodo', v.periodo, 'version', v.version, 'estado_anterior', v.estado, 'motivo', trim(p_motivo)), v.empresa_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Lectura (seguridad por fila) y permisos de ejecución
-- ---------------------------------------------------------------------------
ALTER TABLE tributario_tasas_ppm ENABLE ROW LEVEL SECURITY;
ALTER TABLE rcv_importaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE rcv_documentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE f29_declaraciones ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON tributario_tasas_ppm, rcv_importaciones, rcv_documentos, f29_declaraciones TO erp_app;

CREATE POLICY tasas_ppm_ver ON tributario_tasas_ppm FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'tributario.ver'));
CREATE POLICY rcv_importaciones_ver ON rcv_importaciones FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'tributario.ver'));
CREATE POLICY rcv_documentos_ver ON rcv_documentos FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'tributario.ver'));
CREATE POLICY f29_ver ON f29_declaraciones FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'tributario.ver'));

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  tributario_configurar_ppm(uuid, date, numeric, text, text),
  rcv_registrar_importacion(uuid, text, text, int, int, text, text, text, jsonb),
  f29_preparar(uuid, int, int, numeric, numeric, jsonb),
  f29_aprobar(uuid, boolean),
  f29_registrar_declaracion(uuid, text, date),
  f29_anular(uuid, text)
TO erp_app;
