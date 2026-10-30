-- =============================================================================
-- 0014 · Configuración tributaria: régimen e IVA de compras no recuperable
-- =============================================================================
-- Pedido de la gerencia: InnovAgile (Pro Pyme Transparente, solo operaciones exentas)
-- recibe facturas con IVA que el SII registra con crédito, y hoy se cambian a mano a
-- "IVA no recuperable". El sistema lo hace solo en la propuesta de F29 y lista los
-- documentos que deben reclasificarse en el RCV del SII.
--   * Configuración por empresa, con vigencia desde un mes, versionada (no se borra).
--   * La tasa de PPM se compara con las tasas que la ley fija para el régimen.
-- =============================================================================

CREATE TABLE tributario_configuracion (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id                  uuid NOT NULL REFERENCES empresas(id),
  vigente_desde               date NOT NULL CHECK (extract(day FROM vigente_desde) = 1),
  regimen                     text NOT NULL CHECK (regimen IN ('PRO_PYME_TRANSPARENTE', 'PRO_PYME_GENERAL', 'SEMI_INTEGRADO', 'OTRO')),
  iva_compras_no_recuperable  boolean NOT NULL,
  -- Código de IVA no recuperable del SII (1: operaciones exentas o no gravadas).
  codigo_iva_no_recuperable   int CHECK (codigo_iva_no_recuperable IN (1, 2, 3, 4, 9)),
  motivo                      text NOT NULL CHECK (length(trim(motivo)) >= 10),
  estado                      text NOT NULL DEFAULT 'VIGENTE' CHECK (estado IN ('VIGENTE', 'REEMPLAZADA')),
  registrado_por              uuid NOT NULL REFERENCES usuarios(id),
  registrado_en               timestamptz NOT NULL DEFAULT now(),
  CHECK (iva_compras_no_recuperable = (codigo_iva_no_recuperable IS NOT NULL))
);
CREATE UNIQUE INDEX tributario_configuracion_vigente_uq ON tributario_configuracion (empresa_id, vigente_desde) WHERE estado = 'VIGENTE';

CREATE FUNCTION tributario_configuracion_transicion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.estado <> 'VIGENTE' OR NEW.estado <> 'REEMPLAZADA'
     OR (to_jsonb(NEW) - 'estado') IS DISTINCT FROM (to_jsonb(OLD) - 'estado') THEN
    RAISE EXCEPTION 'La configuración tributaria no se modifica ni se borra: se reemplaza' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tributario_configuracion_transicion BEFORE UPDATE OR DELETE ON tributario_configuracion
  FOR EACH ROW EXECUTE FUNCTION tributario_configuracion_transicion();
CREATE TRIGGER tributario_configuracion_sin_truncate BEFORE TRUNCATE ON tributario_configuracion
  FOR EACH STATEMENT EXECUTE FUNCTION tributario_rechazar_cambios();

ALTER TABLE tributario_configuracion ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON tributario_configuracion TO erp_app;
CREATE POLICY tributario_configuracion_ver ON tributario_configuracion FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'tributario.ver'));

CREATE FUNCTION tributario_configurar(p_empresa uuid, p_desde date, p_regimen text,
  p_iva_compras_no_recuperable boolean, p_codigo_iva_no_recuperable int, p_motivo text)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario uuid := tributario_exigir(p_empresa, 'tributario.f29.aprobar', p_desde);
  v_id bigint;
BEGIN
  IF tributario_es_agente() THEN
    RAISE EXCEPTION 'La configuración tributaria la registra una persona' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_desde IS NULL OR extract(day FROM p_desde) <> 1 THEN
    RAISE EXCEPTION 'La vigencia parte el primer día de un mes' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('config-trib:' || p_empresa::text, 0));
  IF EXISTS (SELECT 1 FROM f29_declaraciones WHERE empresa_id = p_empresa AND periodo >= p_desde
             AND estado IN ('APROBADA', 'DECLARADA')) THEN
    RAISE EXCEPTION 'Hay F29 aprobados o declarados desde %: la nueva configuración debe regir después del último', to_char(p_desde, 'MM-YYYY')
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE tributario_configuracion SET estado = 'REEMPLAZADA'
  WHERE empresa_id = p_empresa AND vigente_desde = p_desde AND estado = 'VIGENTE';
  INSERT INTO tributario_configuracion (empresa_id, vigente_desde, regimen, iva_compras_no_recuperable,
    codigo_iva_no_recuperable, motivo, registrado_por)
  VALUES (p_empresa, p_desde, p_regimen, p_iva_compras_no_recuperable,
    CASE WHEN p_iva_compras_no_recuperable THEN coalesce(p_codigo_iva_no_recuperable, 1) END, trim(p_motivo), v_usuario)
  RETURNING id INTO v_id;
  PERFORM contabilidad_auditar('CONFIGURACION_TRIBUTARIA', 'tributario_configuracion', v_id::text,
    (SELECT jsonb_build_object('desde', c.vigente_desde, 'regimen', c.regimen, 'iva_compras_no_recuperable', c.iva_compras_no_recuperable,
                               'codigo', c.codigo_iva_no_recuperable, 'motivo', c.motivo)
     FROM tributario_configuracion c WHERE c.id = v_id), p_empresa);
  RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION tributario_configurar(uuid, date, text, boolean, int, text), tributario_configuracion_transicion() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tributario_configurar(uuid, date, text, boolean, int, text) TO erp_app;

-- Tasas de PPM que la ley fija por régimen. Pro Pyme General: 0,25% / 0,5% (art. 14 D N°3
-- letra k) con rebaja transitoria a 0,125% / 0,25% para los ingresos de agosto 2025 a
-- diciembre 2027 (Ley 21.755, Circular SII 53/2025). Pro Pyme Transparente: 0,2% / 0,5%,
-- sin rebaja. La tasa menor rige el año de inicio o con ingresos del año anterior ≤ 50.000 UF.
INSERT INTO tablas_legales
  (clave, contenido, vigente_desde, vigente_hasta, fuente, url_fuente, nota, estado, cargado_por, aprobado_por)
VALUES
  ('PPM.TASAS_POR_REGIMEN', '{"PRO_PYME_TRANSPARENTE": [0.2, 0.5], "PRO_PYME_GENERAL": [0.25, 0.5]}'::jsonb,
   '2025-01-01', '2025-08-01', 'LIR art. 14 letra D N°3 letra k) y N°8; Circular SII 53/2025',
   'https://www.sii.cl/normativa_legislacion/circulares/2025/circu53.pdf', 'Tasas permanentes.',
   'APROBADO', 'migracion-0014', 'verificacion-documental-2026-10-30'),
  ('PPM.TASAS_POR_REGIMEN', '{"PRO_PYME_TRANSPARENTE": [0.2, 0.5], "PRO_PYME_GENERAL": [0.125, 0.25]}'::jsonb,
   '2025-08-01', '2028-01-01', 'Ley 21.755 art. 25; Circular SII 53/2025',
   'https://www.sii.cl/normativa_legislacion/circulares/2025/circu53.pdf',
   'Rebaja transitoria del Pro Pyme General para los ingresos de agosto 2025 a diciembre 2027. El Transparente no tiene rebaja.',
   'APROBADO', 'migracion-0014', 'verificacion-documental-2026-10-30'),
  ('PPM.TASAS_POR_REGIMEN', '{"PRO_PYME_TRANSPARENTE": [0.2, 0.5], "PRO_PYME_GENERAL": [0.25, 0.5]}'::jsonb,
   '2028-01-01', NULL, 'LIR art. 14 letra D N°3 letra k) y N°8; Circular SII 53/2025',
   'https://www.sii.cl/normativa_legislacion/circulares/2025/circu53.pdf',
   'Vuelven las tasas permanentes; revisar si una ley posterior extiende la rebaja.',
   'APROBADO', 'migracion-0014', 'verificacion-documental-2026-10-30');

-- Nueva versión de las reglas RCV → F29 (revisión independiente): con IVA no recuperable,
-- las notas de crédito y débito recibidas ajustan el 521 y el 562, la DIN sin derecho a
-- crédito va a 566/560 y el neto sin crédito toma el de activo fijo si el SII lo trae ahí.
-- Las versiones anteriores quedan como REEMPLAZADO (las propuestas que las usaron las
-- siguen referenciando) y la aprobación exige preparar de nuevo con las reglas vigentes.
ALTER TABLE tablas_legales DROP CONSTRAINT tablas_legales_estado_check;
ALTER TABLE tablas_legales ADD CONSTRAINT tablas_legales_estado_check
  CHECK (estado IN ('PROPUESTO', 'APROBADO', 'RECHAZADO', 'REEMPLAZADO'));

CREATE TEMP TABLE reglas_nuevas ON COMMIT DROP AS
SELECT t.clave,
       jsonb_set(
         jsonb_set(t.contenido, '{reglas}',
           (SELECT jsonb_agg(CASE WHEN r ->> 'nombre' = 'Compras afectas sin derecho a crédito'
                                  THEN jsonb_set(r, '{montos}', '[{"campo": "neto_sin_credito", "codigo": "521"}]')
                                  ELSE r END)
            FROM jsonb_array_elements(t.contenido -> 'reglas') r)
           || $json$[
             {"nombre": "Notas de crédito recibidas sin derecho a crédito", "libro": "COMPRA", "tipos": [60, 61], "operaciones": ["IVA_NO_RECUPERABLE"],
              "montos": [{"campo": "neto_sin_credito", "codigo": "521", "signo": -1}, {"campo": "monto_exento", "codigo": "562", "signo": -1}]},
             {"nombre": "Notas de débito recibidas sin derecho a crédito", "libro": "COMPRA", "tipos": [55, 56], "operaciones": ["IVA_NO_RECUPERABLE"],
              "montos": [{"campo": "neto_sin_credito", "codigo": "521"}, {"campo": "monto_exento", "codigo": "562"}]},
             {"nombre": "Importaciones sin derecho a crédito (DIN)", "libro": "COMPRA", "tipos": [914], "operaciones": ["IVA_NO_RECUPERABLE"],
              "cantidad": {"codigo": "566"},
              "montos": [{"campo": "neto_sin_credito", "codigo": "560"}]}
           ]$json$::jsonb),
         '{codigos_ajustables}', (t.contenido -> 'codigos_ajustables') || '["566", "560"]'::jsonb) AS contenido,
       t.vigente_desde, t.vigente_hasta, t.fuente, t.url_fuente,
       t.nota || ' Versión 2 (migración 0014): notas de crédito y débito y DIN sin derecho a crédito.' AS nota
FROM tablas_legales t
WHERE t.clave = 'F29.REGLAS_RCV' AND t.estado = 'APROBADO';

UPDATE tablas_legales SET estado = 'REEMPLAZADO' WHERE clave = 'F29.REGLAS_RCV' AND estado = 'APROBADO';
INSERT INTO tablas_legales (clave, contenido, vigente_desde, vigente_hasta, fuente, url_fuente, nota, estado, cargado_por, aprobado_por)
SELECT clave, contenido, vigente_desde, vigente_hasta, fuente, url_fuente, nota, 'APROBADO', 'migracion-0014', 'verificacion-documental-2026-10-30'
FROM reglas_nuevas;

CREATE OR REPLACE FUNCTION f29_preparar(
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
  v_config tributario_configuracion;
  v_no_rec boolean := false;
  v_reclasificar jsonb;
  v_tasas_regimen jsonb;
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

  -- Configuración tributaria vigente: régimen y regla de IVA de compras.
  SELECT * INTO v_config FROM tributario_configuracion
  WHERE empresa_id = p_empresa AND estado = 'VIGENTE' AND vigente_desde <= v_periodo
  ORDER BY vigente_desde DESC LIMIT 1;
  v_no_rec := coalesce(v_config.iva_compras_no_recuperable, false);

  -- IVA de uso común: crédito proporcional (art. 23 N°3 D.L. 825) con el factor que informa el contador.
  SELECT count(*) INTO v_uso_comun FROM rcv_documentos
  WHERE importacion_id = v_compra AND tipo_operacion = 'IVA_USO_COMUN' AND NOT v_no_rec;
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
    SELECT d.id, i.libro, d.tipo_documento, e.tipo_operacion, d.tipo_operacion AS tipo_operacion_rcv, d.folio, d.cantidad,
           jsonb_build_object(
             'monto_exento', d.monto_exento, 'monto_neto', d.monto_neto, 'monto_iva', d.monto_iva,
             'neto_sin_credito', CASE WHEN d.monto_neto > 0 THEN d.monto_neto ELSE d.neto_activo_fijo END,
             'iva_credito', CASE e.tipo_operacion
               WHEN 'ACTIVO_FIJO' THEN CASE WHEN d.iva_activo_fijo > 0 THEN d.iva_activo_fijo ELSE d.monto_iva END
               WHEN 'IVA_USO_COMUN' THEN CASE WHEN d.iva_uso_comun > 0 THEN d.iva_uso_comun ELSE d.monto_iva END * v_factor
               WHEN 'IVA_NO_RECUPERABLE' THEN 0
               ELSE d.monto_iva END) AS v
    FROM rcv_documentos d JOIN rcv_importaciones i ON i.id = d.importacion_id
    -- Si la empresa solo tiene operaciones exentas o no gravadas, el IVA de sus compras
    -- no es crédito (art. 23 N°1 D.L. 825): se trata como IVA no recuperable.
    CROSS JOIN LATERAL (SELECT CASE
        WHEN v_no_rec AND i.libro = 'COMPRA'
             AND d.tipo_operacion IN ('DEL_GIRO', 'SUPERMERCADOS', 'BIENES_RAICES', 'ACTIVO_FIJO', 'IVA_USO_COMUN')
        THEN 'IVA_NO_RECUPERABLE' ELSE d.tipo_operacion END AS tipo_operacion) e
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
                     'tipo_operacion', tipo_operacion_rcv, 'documentos', n, 'folios', folios)), '[]')
       FROM (SELECT d.libro, d.tipo_documento, d.tipo_operacion_rcv, count(*) AS n,
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
        ('IVA no retenido (factura de compra con retención parcial)', d.iva_no_retenido),
        ('IVA de nota de crédito fuera de plazo', d.iva_fuera_plazo),
        (format('Otro impuesto, código SII %s (ILA, IVA anticipado, diésel u otro)',
                coalesce(d.codigo_otro_impuesto::text, 'no informado')), d.otros_impuestos)) AS c(concepto, monto)
      WHERE d.importacion_id IN (v_venta, v_compra) AND c.monto > 0
      UNION ALL
      -- Montos especiales con el nombre de la columna del RCV (crédito de constructoras, IVA de
      -- terceros, IVA propio, comisiones de liquidaciones-factura, zona franca, pasajes, envases).
      SELECT d.folio, format('Columna del RCV "%s"', x.key), (x.value)::numeric
      FROM rcv_documentos d CROSS JOIN LATERAL jsonb_each(d.montos_especiales_detalle) AS x
      WHERE d.importacion_id IN (v_venta, v_compra)
      UNION ALL
      -- Documentos importados antes de que existiera el detalle.
      SELECT d.folio, 'Crédito de empresa constructora o IVA de terceros', d.montos_especiales
      FROM rcv_documentos d
      WHERE d.importacion_id IN (v_venta, v_compra) AND d.montos_especiales > 0 AND d.montos_especiales_detalle = '{}'
    ) t GROUP BY concepto ORDER BY concepto) y;
  IF jsonb_array_length(v_especiales) > 0 THEN
    v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'DOCUMENTOS_CON_MONTOS_ESPECIALES',
      'mensaje', 'Hay documentos con IVA retenido o no retenido por cambio de sujeto, notas de crédito fuera de plazo, otros impuestos con código del SII u otras columnas especiales del RCV (crédito de empresa constructora, IVA de terceros o propio, comisiones de liquidaciones-factura, zona franca, pasajes, envases). El traspaso automático no los considera: revíselos y agregue los ajustes que correspondan.',
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

  -- Documentos que el SII registró con crédito y que deben reclasificarse en el RCV.
  IF v_no_rec THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('tipo_documento', d.tipo_documento, 'folio', d.folio,
             'rut', d.rut_contraparte, 'razon_social', d.razon_social, 'tipo_compra_sii', d.tipo_operacion,
             'iva', CASE d.tipo_operacion
                      WHEN 'ACTIVO_FIJO' THEN CASE WHEN d.iva_activo_fijo > 0 THEN d.iva_activo_fijo ELSE d.monto_iva END
                      WHEN 'IVA_USO_COMUN' THEN CASE WHEN d.iva_uso_comun > 0 THEN d.iva_uso_comun ELSE d.monto_iva END
                      ELSE d.monto_iva END) ORDER BY d.folio), '[]')
    INTO v_reclasificar
    FROM rcv_documentos d
    WHERE d.importacion_id = v_compra
      AND d.tipo_operacion IN ('DEL_GIRO', 'SUPERMERCADOS', 'BIENES_RAICES', 'ACTIVO_FIJO', 'IVA_USO_COMUN')
      AND d.tipo_documento <> 914
      AND d.monto_iva + d.iva_activo_fijo + d.iva_uso_comun > 0;
    IF jsonb_array_length(v_reclasificar) > 0 THEN
      v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'RECLASIFICAR_EN_SII',
        'mensaje', format('La empresa solo tiene operaciones exentas: el IVA de %s compra(s) no es crédito y se declaró como IVA no recuperable. En el RCV del SII, cámbielas a "IVA no recuperable" con el código %s antes de declarar, para que coincidan con este F29.',
                          jsonb_array_length(v_reclasificar), v_config.codigo_iva_no_recuperable),
        'detalle', v_reclasificar));
    END IF;
  END IF;

  -- PPM: base (563) por la tasa vigente de la empresa.
  SELECT * INTO v_tasa FROM tributario_tasas_ppm
  WHERE empresa_id = p_empresa AND estado = 'VIGENTE' AND vigente_desde <= v_periodo
  ORDER BY vigente_desde DESC LIMIT 1;
  IF v_tasa.id IS NULL THEN
    RAISE EXCEPTION 'Configure la tasa de PPM de la empresa vigente para %', to_char(v_periodo, 'MM-YYYY')
      USING ERRCODE = 'check_violation';
  END IF;
  -- La tasa debe ser una de las que la ley fija para el régimen de la empresa.
  IF v_config.regimen IS NOT NULL THEN
    SELECT contenido -> v_config.regimen INTO v_tasas_regimen FROM normativa_tabla('PPM.TASAS_POR_REGIMEN', v_periodo);
    IF v_tasas_regimen IS NULL AND v_config.regimen IN ('PRO_PYME_TRANSPARENTE', 'PRO_PYME_GENERAL') THEN
      v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'TASAS_PPM_NO_CARGADAS',
        'mensaje', format('No hay tasas legales de PPM cargadas para el régimen %s en %s: la tasa no se pudo verificar.',
                          v_config.regimen, to_char(v_periodo, 'MM-YYYY'))));
    ELSIF v_tasas_regimen IS NOT NULL AND NOT v_tasas_regimen @> to_jsonb(v_tasa.tasa) THEN
      v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'TASA_PPM_FUERA_DE_REGIMEN',
        'mensaje', format('La tasa de PPM configurada (%s%%) no es una de las que la ley fija para el régimen %s (%s).',
                          v_tasa.tasa, v_config.regimen, v_tasas_regimen)));
    END IF;
  ELSE
    v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'REGIMEN_NO_CONFIGURADO',
      'mensaje', 'No está configurado el régimen tributario de la empresa: no se puede verificar la tasa de PPM.'));
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

  IF v_no_rec AND v_538 > 0 THEN
    v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'CONFIG_NO_RECUPERABLE_CON_VENTAS_AFECTAS',
      'mensaje', 'La empresa está configurada con solo operaciones exentas, pero este mes tiene ventas afectas: el IVA de las compras destinadas a ellas sí es crédito (total o proporcional). Revise la configuración tributaria.'));
  END IF;

  -- Art. 23 N°1 y N°2 D.L. 825: el IVA de compras solo es crédito si se destina a operaciones gravadas.
  IF v_537 - coalesce((v_cod ->> '504')::numeric, 0) > 0 AND v_538 <= 0
     AND (coalesce((v_cod ->> '142')::numeric, 0) > 0 OR coalesce((v_cod ->> '20')::numeric, 0) > 0) THEN
    v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'CREDITO_SIN_VENTAS_AFECTAS',
      'mensaje', 'Hay crédito fiscal del mes, pero las ventas del período son solo exentas o de exportación. Confirme que esas compras se destinan a operaciones gravadas (art. 23 D.L. 825); si no, corresponde clasificarlas como IVA no recuperable o de uso común.'));
  END IF;

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
      'configuracion', jsonb_build_object('id', v_config.id, 'regimen', v_config.regimen,
                                          'iva_compras_no_recuperable', v_no_rec),
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


-- La aprobación también exige que la configuración tributaria no haya cambiado.
CREATE OR REPLACE FUNCTION f29_aprobar(p_id uuid, p_confirmo_advertencias boolean DEFAULT false) RETURNS void
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
  IF (SELECT c.id FROM tributario_configuracion c
      WHERE c.empresa_id = v.empresa_id AND c.estado = 'VIGENTE' AND c.vigente_desde <= v.periodo
      ORDER BY c.vigente_desde DESC LIMIT 1) IS DISTINCT FROM (v.detalle -> 'configuracion' ->> 'id')::bigint THEN
    RAISE EXCEPTION 'La configuración tributaria cambió después de preparar esta propuesta: prepárela de nuevo' USING ERRCODE = 'check_violation';
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

