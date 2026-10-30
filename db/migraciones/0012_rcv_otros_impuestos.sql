-- =============================================================================
-- 0012 · RCV: código de otros impuestos, IVA no retenido e impuestos sin crédito
-- =============================================================================
-- Resultado del cotejo con archivos reales del SII y de la revisión independiente:
--   * "Valor Otro Impuesto" agrupa impuestos de naturaleza distinta (ILA, IVA anticipado,
--     diésel, retenciones); se guarda su código para que el contador sepa qué revisar.
--   * "IVA No Retenido" (facturas de compra con retención parcial) tiene concepto propio.
--   * Tabacos e "Impto. Sin Derecho a Credito" no tienen efecto en el F29: se guardan
--     aparte (impuestos_sin_credito) y no generan advertencia.
--   * Nueva advertencia cuando hay crédito fiscal y las ventas del mes son solo exentas
--     o de exportación (art. 23 D.L. 825).
-- =============================================================================

ALTER TABLE rcv_documentos
  ADD COLUMN codigo_otro_impuesto   int CHECK (codigo_otro_impuesto > 0),
  ADD COLUMN iva_no_retenido        numeric(18, 0) NOT NULL DEFAULT 0 CHECK (iva_no_retenido >= 0),
  ADD COLUMN impuestos_sin_credito  numeric(18, 0) NOT NULL DEFAULT 0 CHECK (impuestos_sin_credito >= 0);

CREATE OR REPLACE FUNCTION rcv_registrar_importacion(
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
    iva_no_retenido numeric, impuestos_sin_credito numeric,
    monto_total numeric, tipo_operacion text, fecha_documento date, fecha_recepcion date)
  WHERE EXISTS (SELECT 1 FROM unnest(ARRAY[d.monto_exento, d.monto_neto, d.monto_iva, d.iva_no_recuperable, d.iva_uso_comun,
                  d.neto_activo_fijo, d.iva_activo_fijo, d.otros_impuestos, d.iva_retenido, d.iva_fuera_plazo,
                  d.montos_especiales, d.iva_no_retenido, d.impuestos_sin_credito, d.monto_total]) m
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
    iva_retenido, iva_fuera_plazo, montos_especiales, iva_no_retenido, impuestos_sin_credito, codigo_otro_impuesto, monto_total)
  SELECT v_id, p_empresa, d.tipo_documento, d.tipo_operacion, d.rut_contraparte, left(d.razon_social, 200),
    d.folio, d.fecha_documento, d.fecha_recepcion, coalesce(d.cantidad, 1), coalesce(d.monto_exento, 0), coalesce(d.monto_neto, 0),
    coalesce(d.monto_iva, 0), coalesce(d.iva_no_recuperable, 0), d.codigo_iva_no_recuperable, coalesce(d.iva_uso_comun, 0),
    coalesce(d.neto_activo_fijo, 0), coalesce(d.iva_activo_fijo, 0), coalesce(d.otros_impuestos, 0),
    coalesce(d.iva_retenido, 0), coalesce(d.iva_fuera_plazo, 0), coalesce(d.montos_especiales, 0),
    coalesce(d.iva_no_retenido, 0), coalesce(d.impuestos_sin_credito, 0), d.codigo_otro_impuesto, d.monto_total
  FROM jsonb_to_recordset(p_documentos) AS d(
    tipo_documento int, tipo_operacion text, rut_contraparte text, razon_social text, folio bigint,
    fecha_documento date, fecha_recepcion date, cantidad int, monto_exento numeric, monto_neto numeric, monto_iva numeric,
    iva_no_recuperable numeric, codigo_iva_no_recuperable int, iva_uso_comun numeric, neto_activo_fijo numeric,
    iva_activo_fijo numeric, otros_impuestos numeric, iva_retenido numeric, iva_fuera_plazo numeric,
    montos_especiales numeric, iva_no_retenido numeric, impuestos_sin_credito numeric, codigo_otro_impuesto int,
    monto_total numeric);

  PERFORM contabilidad_auditar('RCV_IMPORTADO', 'rcv_importaciones', v_id::text,
    jsonb_build_object('libro', p_libro, 'seccion', p_seccion, 'periodo', v_periodo, 'origen', p_origen,
                       'archivo', p_archivo_nombre, 'sha256', p_archivo_sha256,
                       'documentos', jsonb_array_length(p_documentos), 'reemplaza', v_anterior.id), p_empresa);
  RETURN v_id;
END;
$$;

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
        ('IVA no retenido (factura de compra con retención parcial)', d.iva_no_retenido),
        ('IVA de nota de crédito fuera de plazo', d.iva_fuera_plazo),
        ('Crédito de empresa constructora o IVA de terceros', d.montos_especiales),
        (format('Otro impuesto, código SII %s (ILA, IVA anticipado, diésel u otro)',
                coalesce(d.codigo_otro_impuesto::text, 'no informado')), d.otros_impuestos)) AS c(concepto, monto)
      WHERE d.importacion_id IN (v_venta, v_compra) AND c.monto > 0
    ) t GROUP BY concepto ORDER BY concepto) y;
  IF jsonb_array_length(v_especiales) > 0 THEN
    v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'DOCUMENTOS_CON_MONTOS_ESPECIALES',
      'mensaje', 'Hay documentos con IVA retenido o no retenido por cambio de sujeto, notas de crédito fuera de plazo, crédito de empresa constructora, IVA de terceros u otros impuestos con código del SII. El traspaso automático no los considera: revíselos y agregue los ajustes que correspondan.',
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

