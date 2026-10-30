-- =============================================================================
-- 0010 · Cierre anual automático
-- =============================================================================
-- Al cerrar un ejercicio:
--   1. Asiento de CIERRE: salda todas las cuentas de resultado (ingresos y gastos)
--      contra la cuenta de resultado del ejercicio configurada por la empresa.
--   2. Asiento de APERTURA del ejercicio siguiente (que se crea si no existe) con
--      los saldos de las cuentas de balance y de orden, conservando el detalle por
--      tercero y centro de costo.
-- Si el Directorio reabre el ejercicio, el cierre y la apertura automática se
-- reversan solos; al volver a cerrar, se regeneran con los saldos corregidos.
-- Estos asientos los genera el sistema (origen MODULO): no pasan por las reglas de
-- períodos abiertos, porque se registran justamente al cerrar.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Configuración contable por empresa
-- ---------------------------------------------------------------------------
CREATE TABLE configuracion_contable (
  empresa_id                    uuid PRIMARY KEY REFERENCES empresas(id),
  cuenta_resultado_ejercicio_id uuid NOT NULL REFERENCES plan_cuentas(id),
  actualizado_en                timestamptz NOT NULL DEFAULT now(),
  actualizado_por               uuid NOT NULL REFERENCES usuarios(id)
);
ALTER TABLE configuracion_contable ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON configuracion_contable TO erp_app;
CREATE POLICY configuracion_contable_ver ON configuracion_contable FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id));

CREATE FUNCTION contabilidad_configurar(p_empresa uuid, p_cuenta_resultado text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario uuid := contabilidad_exigir(p_empresa, 'contabilidad.periodos.administrar');
  v_cuenta  plan_cuentas;
BEGIN
  SELECT * INTO v_cuenta FROM plan_cuentas WHERE empresa_id = p_empresa AND codigo = p_cuenta_resultado;
  IF v_cuenta.id IS NULL OR v_cuenta.clasificacion <> 'PATRIMONIO' OR NOT v_cuenta.imputable OR NOT v_cuenta.activa THEN
    RAISE EXCEPTION 'La cuenta de resultado del ejercicio debe ser una cuenta de patrimonio imputable y activa'
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO configuracion_contable (empresa_id, cuenta_resultado_ejercicio_id, actualizado_por)
  VALUES (p_empresa, v_cuenta.id, v_usuario)
  ON CONFLICT (empresa_id) DO UPDATE
    SET cuenta_resultado_ejercicio_id = EXCLUDED.cuenta_resultado_ejercicio_id,
        actualizado_en = now(), actualizado_por = EXCLUDED.actualizado_por;
  PERFORM contabilidad_auditar('contabilidad.configurada', 'configuracion_contable', p_empresa::text,
    jsonb_build_object('cuenta_resultado_ejercicio', v_cuenta.codigo), p_empresa);
END;
$$;

-- ---------------------------------------------------------------------------
-- Piezas internas (no se conceden a ningún rol: solo las usan otras funciones)
-- ---------------------------------------------------------------------------
CREATE FUNCTION contabilidad_crear_ejercicio_interno(p_empresa uuid, p_anio int, p_inicio date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id  uuid;
  v_mes int;
BEGIN
  INSERT INTO ejercicios_contables (empresa_id, anio, fecha_inicio, fecha_termino)
  VALUES (p_empresa, p_anio, p_inicio, make_date(p_anio, 12, 31))
  RETURNING id INTO v_id;
  FOR v_mes IN extract(month FROM p_inicio)::int .. 12 LOOP
    INSERT INTO periodos_contables (empresa_id, ejercicio_id, anio, mes, fecha_inicio, fecha_termino)
    VALUES (p_empresa, v_id, p_anio, v_mes,
            greatest(make_date(p_anio, v_mes, 1), p_inicio),
            (make_date(p_anio, v_mes, 1) + interval '1 month - 1 day')::date);
  END LOOP;
  RETURN v_id;
END;
$$;

-- Asiento generado por el sistema. p_lineas: [{cuenta_id, tercero_id, centro_costo_id, debe, haber}]
CREATE FUNCTION contabilidad_asiento_sistema(
  p_empresa uuid, p_ejercicio uuid, p_fecha date, p_tipo text, p_glosa text,
  p_lineas jsonb, p_reversa_de uuid, p_usuario uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_periodo periodos_contables;
  v_debe    numeric;
  v_haber   numeric;
  v_n       int;
  v_numero  int;
  v_id      uuid := gen_random_uuid();
BEGIN
  IF p_tipo NOT IN ('CIERRE', 'APERTURA', 'REVERSA') THEN
    RAISE EXCEPTION 'Tipo de asiento de sistema inválido: %', p_tipo USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_periodo FROM periodos_contables
  WHERE ejercicio_id = p_ejercicio AND p_fecha BETWEEN fecha_inicio AND fecha_termino;
  IF v_periodo.id IS NULL THEN
    RAISE EXCEPTION 'No existe un período para el %', p_fecha USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(debe), 0), coalesce(sum(haber), 0), count(*) INTO v_debe, v_haber, v_n
  FROM jsonb_to_recordset(p_lineas) AS x(cuenta_id uuid, debe numeric, haber numeric);
  IF v_n < 2 OR v_debe <> v_haber OR v_debe <= 0 THEN
    RAISE EXCEPTION 'Asiento de sistema descuadrado: debe %, haber %, líneas %', v_debe, v_haber, v_n
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE ejercicios_contables SET ultimo_numero = ultimo_numero + 1
  WHERE id = p_ejercicio RETURNING ultimo_numero INTO v_numero;

  INSERT INTO asientos (id, empresa_id, ejercicio_id, periodo_id, numero, fecha, tipo, origen, glosa,
                        reversa_de, total, registrado_por)
  VALUES (v_id, p_empresa, p_ejercicio, v_periodo.id, v_numero, p_fecha, p_tipo, 'MODULO', p_glosa,
          p_reversa_de, v_debe, p_usuario);
  INSERT INTO asiento_lineas (asiento_id, empresa_id, linea, cuenta_id, debe, haber, tercero_id, centro_costo_id)
  SELECT v_id, p_empresa, x.n, x.cuenta_id, x.debe, x.haber, x.tercero_id, x.centro_costo_id
  FROM ROWS FROM (jsonb_to_recordset(p_lineas)
                  AS (cuenta_id uuid, tercero_id uuid, centro_costo_id uuid, debe numeric, haber numeric))
       WITH ORDINALITY AS x(cuenta_id, tercero_id, centro_costo_id, debe, haber, n);

  PERFORM contabilidad_auditar('asiento.registrado', 'asientos', v_id::text,
    jsonb_build_object('numero', v_numero, 'fecha', p_fecha, 'tipo', p_tipo, 'origen', 'MODULO',
                       'total', v_debe, 'glosa', p_glosa, 'reversa_de', p_reversa_de),
    p_empresa);
  RETURN v_id;
END;
$$;

-- Reversa generada por el sistema (mismas líneas, debe y haber invertidos).
CREATE FUNCTION contabilidad_reversa_sistema(p_asiento uuid, p_fecha date, p_motivo text, p_usuario uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_original asientos;
  v_lineas   jsonb;
  v_ejercicio uuid;
BEGIN
  SELECT * INTO v_original FROM asientos WHERE id = p_asiento;
  SELECT jsonb_agg(jsonb_build_object('cuenta_id', cuenta_id, 'tercero_id', tercero_id, 'centro_costo_id', centro_costo_id,
                                      'debe', haber, 'haber', debe) ORDER BY linea)
    INTO v_lineas
  FROM asiento_lineas WHERE asiento_id = p_asiento;
  SELECT id INTO v_ejercicio FROM ejercicios_contables
  WHERE empresa_id = v_original.empresa_id AND p_fecha BETWEEN fecha_inicio AND fecha_termino;
  RETURN contabilidad_asiento_sistema(
    v_original.empresa_id, v_ejercicio, p_fecha, 'REVERSA',
    format('Reversa del asiento N° %s: %s', v_original.numero, p_motivo), v_lineas, p_asiento, p_usuario);
END;
$$;

-- Asiento vigente (no reversado) de un tipo en un ejercicio.
CREATE FUNCTION contabilidad_asiento_vigente(p_ejercicio uuid, p_tipo text) RETURNS asientos
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.* FROM asientos a
  WHERE a.ejercicio_id = p_ejercicio AND a.tipo = p_tipo
    AND NOT EXISTS (SELECT 1 FROM asientos r WHERE r.reversa_de = a.id)
  ORDER BY a.numero DESC LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- Crear ejercicio (mismo comportamiento, ahora sobre la pieza interna)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION contabilidad_crear_ejercicio(p_empresa uuid, p_anio int, p_fecha_inicio date DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario uuid := contabilidad_exigir(p_empresa, 'contabilidad.periodos.administrar');
  v_inicio  date := coalesce(p_fecha_inicio, make_date(p_anio, 1, 1));
  v_id      uuid;
BEGIN
  IF extract(year FROM v_inicio) <> p_anio THEN
    RAISE EXCEPTION 'La fecha de inicio debe pertenecer al año %', p_anio USING ERRCODE = 'check_violation';
  END IF;
  v_id := contabilidad_crear_ejercicio_interno(p_empresa, p_anio, v_inicio);
  PERFORM contabilidad_auditar('ejercicio.creado', 'ejercicios_contables', v_id::text,
    jsonb_build_object('anio', p_anio, 'inicio', v_inicio), p_empresa);
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Cierre del ejercicio con asiento de cierre y apertura del siguiente
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION contabilidad_cerrar_ejercicio(p_ejercicio uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ejercicio  ejercicios_contables;
  v_siguiente  ejercicios_contables;
  v_usuario    uuid;
  v_cuenta_res uuid;
  v_lineas     jsonb;
  v_neto       numeric;
  v_cierre     uuid;
  v_apertura   uuid;
  v_previa     asientos;
BEGIN
  SELECT * INTO v_ejercicio FROM ejercicios_contables WHERE id = p_ejercicio FOR UPDATE;
  IF v_ejercicio.id IS NULL OR v_ejercicio.empresa_id IS DISTINCT FROM app_empresa_id() THEN
    RAISE EXCEPTION 'El ejercicio no existe' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_usuario := contabilidad_exigir(v_ejercicio.empresa_id, 'contabilidad.ejercicio.cerrar');
  IF v_ejercicio.estado = 'CERRADO' AND v_ejercicio.reabierto_hasta IS NULL THEN
    RAISE EXCEPTION 'El ejercicio ya está cerrado' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM periodos_contables WHERE ejercicio_id = p_ejercicio AND estado = 'ABIERTO') THEN
    RAISE EXCEPTION 'Todos los meses del ejercicio deben estar cerrados' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM ejercicios_contables e
             WHERE e.empresa_id = v_ejercicio.empresa_id AND e.anio < v_ejercicio.anio
               AND contabilidad_ejercicio_admite_movimientos(e)) THEN
    RAISE EXCEPTION 'Primero debe cerrarse el ejercicio anterior' USING ERRCODE = 'check_violation';
  END IF;
  SELECT cuenta_resultado_ejercicio_id INTO v_cuenta_res
  FROM configuracion_contable WHERE empresa_id = v_ejercicio.empresa_id;
  IF v_cuenta_res IS NULL THEN
    RAISE EXCEPTION 'Configure la cuenta de resultado del ejercicio antes de cerrar' USING ERRCODE = 'check_violation';
  END IF;

  -- 1) Cierre de cuentas de resultado (si no hay uno vigente).
  IF (contabilidad_asiento_vigente(p_ejercicio, 'CIERRE')).id IS NULL THEN
    WITH saldos AS (
      SELECT l.cuenta_id, sum(l.debe - l.haber) AS saldo
      FROM asiento_lineas l
      JOIN asientos a ON a.id = l.asiento_id
      JOIN plan_cuentas c ON c.id = l.cuenta_id
      WHERE a.ejercicio_id = p_ejercicio AND c.clasificacion IN ('INGRESO', 'GASTO')
      GROUP BY l.cuenta_id
      HAVING sum(l.debe - l.haber) <> 0
    )
    SELECT jsonb_agg(jsonb_build_object(
             'cuenta_id', cuenta_id,
             'debe',  CASE WHEN saldo < 0 THEN -saldo ELSE 0 END,
             'haber', CASE WHEN saldo > 0 THEN saldo ELSE 0 END)),
           sum(saldo)
      INTO v_lineas, v_neto
    FROM saldos;
    IF v_lineas IS NOT NULL THEN
      -- Saldo neto deudor = pérdida (al debe de la cuenta de resultado); acreedor = utilidad.
      IF v_neto <> 0 THEN
        v_lineas := v_lineas || jsonb_build_array(jsonb_build_object(
          'cuenta_id', v_cuenta_res,
          'debe',  CASE WHEN v_neto > 0 THEN v_neto ELSE 0 END,
          'haber', CASE WHEN v_neto < 0 THEN -v_neto ELSE 0 END));
      END IF;
      v_cierre := contabilidad_asiento_sistema(
        v_ejercicio.empresa_id, p_ejercicio, v_ejercicio.fecha_termino, 'CIERRE',
        format('Cierre de cuentas de resultado del ejercicio %s', v_ejercicio.anio),
        v_lineas, NULL, v_usuario);
    END IF;
  END IF;

  -- 2) Ejercicio siguiente (se crea si no existe).
  SELECT * INTO v_siguiente FROM ejercicios_contables
  WHERE empresa_id = v_ejercicio.empresa_id AND anio = v_ejercicio.anio + 1 FOR UPDATE;
  IF v_siguiente.id IS NULL THEN
    PERFORM contabilidad_crear_ejercicio_interno(v_ejercicio.empresa_id, v_ejercicio.anio + 1, make_date(v_ejercicio.anio + 1, 1, 1));
    SELECT * INTO v_siguiente FROM ejercicios_contables
    WHERE empresa_id = v_ejercicio.empresa_id AND anio = v_ejercicio.anio + 1 FOR UPDATE;
  END IF;

  -- Una apertura vigente previa: si la generó el sistema, se reemplaza; si es manual, se detiene.
  v_previa := contabilidad_asiento_vigente(v_siguiente.id, 'APERTURA');
  IF v_previa.id IS NOT NULL THEN
    IF v_previa.origen <> 'MODULO' THEN
      RAISE EXCEPTION 'El ejercicio % tiene un asiento de apertura registrado manualmente (N° %); reverselo antes de cerrar %',
        v_siguiente.anio, v_previa.numero, v_ejercicio.anio USING ERRCODE = 'check_violation';
    END IF;
    PERFORM contabilidad_reversa_sistema(v_previa.id, v_siguiente.fecha_inicio,
      format('reemplazada por la apertura regenerada al cerrar %s', v_ejercicio.anio), v_usuario);
  END IF;

  -- 3) Apertura con los saldos de balance y de orden (incluido el resultado traspasado).
  WITH saldos AS (
    SELECT l.cuenta_id, l.tercero_id, l.centro_costo_id, sum(l.debe - l.haber) AS saldo
    FROM asiento_lineas l
    JOIN asientos a ON a.id = l.asiento_id
    JOIN plan_cuentas c ON c.id = l.cuenta_id
    WHERE a.ejercicio_id = p_ejercicio AND c.clasificacion IN ('ACTIVO', 'PASIVO', 'PATRIMONIO', 'ORDEN')
    GROUP BY l.cuenta_id, l.tercero_id, l.centro_costo_id
    HAVING sum(l.debe - l.haber) <> 0
  )
  SELECT jsonb_agg(jsonb_build_object(
           'cuenta_id', cuenta_id, 'tercero_id', tercero_id, 'centro_costo_id', centro_costo_id,
           'debe',  CASE WHEN saldo > 0 THEN saldo ELSE 0 END,
           'haber', CASE WHEN saldo < 0 THEN -saldo ELSE 0 END))
    INTO v_lineas
  FROM saldos;
  IF v_lineas IS NOT NULL THEN
    v_apertura := contabilidad_asiento_sistema(
      v_ejercicio.empresa_id, v_siguiente.id, v_siguiente.fecha_inicio, 'APERTURA',
      format('Apertura del ejercicio %s con los saldos al cierre de %s', v_siguiente.anio, v_ejercicio.anio),
      v_lineas, NULL, v_usuario);
  END IF;

  UPDATE ejercicios_contables
  SET estado = 'CERRADO', cerrado_en = now(), cerrado_por = v_usuario, reabierto_hasta = NULL
  WHERE id = p_ejercicio;
  PERFORM contabilidad_auditar('ejercicio.cerrado', 'ejercicios_contables', p_ejercicio::text,
    jsonb_build_object('anio', v_ejercicio.anio, 'asiento_cierre', v_cierre, 'asiento_apertura', v_apertura,
                       'ejercicio_siguiente', v_siguiente.anio),
    v_ejercicio.empresa_id);
END;
$$;

-- Los asientos de cierre solo los reversa el sistema (al reabrir el ejercicio).
CREATE OR REPLACE FUNCTION contabilidad_reversar_asiento(p_asiento uuid, p_fecha date, p_motivo text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_original asientos;
  v_lineas   jsonb;
BEGIN
  SELECT * INTO v_original FROM asientos WHERE id = p_asiento;
  IF v_original.id IS NULL OR v_original.empresa_id IS DISTINCT FROM app_empresa_id() THEN
    RAISE EXCEPTION 'El asiento no existe' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM contabilidad_exigir(v_original.empresa_id, 'contabilidad.asientos.registrar');
  IF v_original.tipo = 'REVERSA' THEN
    RAISE EXCEPTION 'Una reversa no se reversa; registre un asiento nuevo' USING ERRCODE = 'check_violation';
  END IF;
  IF v_original.tipo = 'CIERRE' THEN
    RAISE EXCEPTION 'El asiento de cierre lo reversa el sistema al reabrir el ejercicio' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM asientos WHERE reversa_de = p_asiento) THEN
    RAISE EXCEPTION 'El asiento N° % ya fue reversado', v_original.numero USING ERRCODE = 'check_violation';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 10 THEN
    RAISE EXCEPTION 'Indique el motivo de la reversa (al menos 10 caracteres)' USING ERRCODE = 'check_violation';
  END IF;
  IF p_fecha < v_original.fecha THEN
    RAISE EXCEPTION 'La reversa no puede tener fecha anterior al asiento original (%)', v_original.fecha
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'cuenta', c.codigo, 'debe', l.haber, 'haber', l.debe,
           'tercero', t.rut, 'centro_costo', cc.codigo, 'glosa', l.glosa) ORDER BY l.linea)
    INTO v_lineas
  FROM asiento_lineas l
  JOIN plan_cuentas c ON c.id = l.cuenta_id
  LEFT JOIN terceros t ON t.id = l.tercero_id
  LEFT JOIN centros_costo cc ON cc.id = l.centro_costo_id
  WHERE l.asiento_id = p_asiento;

  RETURN contabilidad_registrar_asiento(
    v_original.empresa_id, p_fecha,
    format('Reversa del asiento N° %s: %s', v_original.numero, trim(p_motivo)),
    v_lineas, 'REVERSA', v_original.documento_referencia, 'MANUAL', NULL, p_asiento);
END;
$$;

-- No se pide reabrir un ejercicio si uno posterior ya está cerrado: primero se reabre ese.
CREATE OR REPLACE FUNCTION contabilidad_solicitar_reapertura_ejercicio(
  p_ejercicio uuid, p_motivo text, p_acta text, p_plazo_dias int
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ejercicio ejercicios_contables;
  v_usuario   uuid;
  v_id        uuid;
  v_vencida   uuid;
BEGIN
  SELECT * INTO v_ejercicio FROM ejercicios_contables WHERE id = p_ejercicio FOR UPDATE;
  IF v_ejercicio.id IS NULL OR v_ejercicio.empresa_id IS DISTINCT FROM app_empresa_id() THEN
    RAISE EXCEPTION 'El ejercicio no existe' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_usuario := contabilidad_exigir(v_ejercicio.empresa_id, 'contabilidad.ejercicio.cerrar');
  IF v_ejercicio.estado <> 'CERRADO' OR contabilidad_ejercicio_admite_movimientos(v_ejercicio) THEN
    RAISE EXCEPTION 'Solo se solicita la reapertura de un ejercicio cerrado' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM ejercicios_contables e
             WHERE e.empresa_id = v_ejercicio.empresa_id AND e.anio > v_ejercicio.anio AND e.estado = 'CERRADO') THEN
    RAISE EXCEPTION 'Hay un ejercicio posterior cerrado: debe reabrirse primero' USING ERRCODE = 'check_violation';
  END IF;
  FOR v_vencida IN
    UPDATE solicitudes_reapertura_ejercicio SET estado = 'VENCIDA', resuelta_en = now()
    WHERE ejercicio_id = p_ejercicio AND estado = 'PENDIENTE' AND vence_en <= now()
    RETURNING id
  LOOP
    PERFORM contabilidad_auditar('ejercicio.reapertura_vencida', 'solicitudes_reapertura_ejercicio', v_vencida::text,
      '{}'::jsonb, v_ejercicio.empresa_id);
  END LOOP;
  INSERT INTO solicitudes_reapertura_ejercicio (empresa_id, ejercicio_id, motivo, acta_referencia, plazo_dias, solicitado_por)
  VALUES (v_ejercicio.empresa_id, p_ejercicio, trim(p_motivo), trim(p_acta), p_plazo_dias, v_usuario)
  RETURNING id INTO v_id;
  PERFORM contabilidad_auditar('ejercicio.reapertura_solicitada', 'solicitudes_reapertura_ejercicio', v_id::text,
    jsonb_build_object('anio', v_ejercicio.anio, 'motivo', trim(p_motivo), 'acta', trim(p_acta), 'plazo_dias', p_plazo_dias),
    v_ejercicio.empresa_id);
  RETURN v_id;
END;
$$;

-- Al aprobarse la reapertura, se reversan el cierre y la apertura automática del siguiente.
CREATE OR REPLACE FUNCTION contabilidad_resolver_reapertura_ejercicio(p_solicitud uuid, p_decision text, p_comentario text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_sol        solicitudes_reapertura_ejercicio;
  v_usuario    uuid;
  v_aprobadas  int;
  v_requeridas constant int := 2;
  v_ejercicio  ejercicios_contables;
  v_siguiente  ejercicios_contables;
  v_cierre     asientos;
  v_apertura   asientos;
BEGIN
  SELECT * INTO v_sol FROM solicitudes_reapertura_ejercicio WHERE id = p_solicitud FOR UPDATE;
  IF v_sol.id IS NULL OR v_sol.empresa_id IS DISTINCT FROM app_empresa_id() THEN
    RAISE EXCEPTION 'La solicitud no existe' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_usuario := contabilidad_exigir(v_sol.empresa_id, 'contabilidad.ejercicio.autorizar_reapertura');
  IF p_decision NOT IN ('APROBAR', 'RECHAZAR') THEN
    RAISE EXCEPTION 'Decisión inválida' USING ERRCODE = 'check_violation';
  END IF;
  IF v_sol.estado <> 'PENDIENTE' THEN
    RAISE EXCEPTION 'La solicitud ya está %', v_sol.estado USING ERRCODE = 'check_violation';
  END IF;
  IF v_sol.vence_en <= now() THEN
    UPDATE solicitudes_reapertura_ejercicio SET estado = 'VENCIDA', resuelta_en = now() WHERE id = p_solicitud;
    PERFORM contabilidad_auditar('ejercicio.reapertura_vencida', 'solicitudes_reapertura_ejercicio', p_solicitud::text,
      '{}'::jsonb, v_sol.empresa_id);
    RETURN 'VENCIDA';
  END IF;
  IF v_usuario = v_sol.solicitado_por THEN
    RAISE EXCEPTION 'Quien solicita la reapertura no puede autorizarla' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM usuarios WHERE id = v_usuario AND totp_activo) THEN
    RAISE EXCEPTION 'El director debe tener el doble factor activo para autorizar' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM membresias_empresa
                 WHERE usuario_id = v_usuario AND empresa_id = v_sol.empresa_id
                   AND rol_codigo = 'DIRECTOR' AND creado_en < v_sol.creado_en) THEN
    RAISE EXCEPTION 'Solo puede autorizar un director designado en la empresa antes de la solicitud'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO aprobaciones_reapertura_ejercicio (solicitud_id, director_id, decision, comentario)
  VALUES (p_solicitud, v_usuario, p_decision, nullif(trim(p_comentario), ''));
  PERFORM contabilidad_auditar('ejercicio.reapertura_decision', 'solicitudes_reapertura_ejercicio', p_solicitud::text,
    jsonb_build_object('decision', p_decision, 'comentario', p_comentario), v_sol.empresa_id);

  IF p_decision = 'RECHAZAR' THEN
    UPDATE solicitudes_reapertura_ejercicio SET estado = 'RECHAZADA', resuelta_en = now() WHERE id = p_solicitud;
    RETURN 'RECHAZADA';
  END IF;

  SELECT count(*) INTO v_aprobadas FROM aprobaciones_reapertura_ejercicio
  WHERE solicitud_id = p_solicitud AND decision = 'APROBAR';
  IF v_aprobadas < v_requeridas THEN
    RETURN 'PENDIENTE';
  END IF;

  SELECT * INTO v_ejercicio FROM ejercicios_contables WHERE id = v_sol.ejercicio_id FOR UPDATE;
  -- Deshacer el cierre automático: reversa del cierre y de la apertura generada en el siguiente.
  v_cierre := contabilidad_asiento_vigente(v_ejercicio.id, 'CIERRE');
  IF v_cierre.id IS NOT NULL THEN
    PERFORM contabilidad_reversa_sistema(v_cierre.id, v_ejercicio.fecha_termino,
      format('reapertura del ejercicio autorizada (%s)', v_sol.acta_referencia), v_usuario);
  END IF;
  SELECT * INTO v_siguiente FROM ejercicios_contables
  WHERE empresa_id = v_ejercicio.empresa_id AND anio = v_ejercicio.anio + 1 FOR UPDATE;
  IF v_siguiente.id IS NOT NULL THEN
    v_apertura := contabilidad_asiento_vigente(v_siguiente.id, 'APERTURA');
    IF v_apertura.id IS NOT NULL AND v_apertura.origen = 'MODULO' THEN
      PERFORM contabilidad_reversa_sistema(v_apertura.id, v_siguiente.fecha_inicio,
        format('reapertura del ejercicio %s autorizada (%s)', v_ejercicio.anio, v_sol.acta_referencia), v_usuario);
    END IF;
  END IF;

  UPDATE solicitudes_reapertura_ejercicio SET estado = 'APROBADA', resuelta_en = now() WHERE id = p_solicitud;
  UPDATE ejercicios_contables SET reabierto_hasta = contabilidad_hoy() + v_sol.plazo_dias WHERE id = v_sol.ejercicio_id;
  PERFORM contabilidad_auditar('ejercicio.reabierto', 'ejercicios_contables', v_sol.ejercicio_id::text,
    jsonb_build_object('solicitud', p_solicitud, 'acta', v_sol.acta_referencia,
                       'vigente_hasta', contabilidad_hoy() + v_sol.plazo_dias, 'aprobaciones', v_aprobadas,
                       'cierre_reversado', v_cierre.id, 'apertura_reversada', v_apertura.id),
    v_sol.empresa_id);
  RETURN 'APROBADA';
END;
$$;

-- Permisos: las piezas internas no se conceden a nadie (0009 ya retiró PUBLIC por defecto).
GRANT EXECUTE ON FUNCTION contabilidad_configurar(uuid, text) TO erp_app;
