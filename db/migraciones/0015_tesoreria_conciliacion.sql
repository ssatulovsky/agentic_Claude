-- =============================================================================
-- 0015 · Tesorería: cuentas bancarias, cartolas y conciliación bancaria
-- =============================================================================
-- Reglas (todas aplicadas por la base de datos):
--   * Cada cuenta bancaria está asociada a una cuenta contable imputable de activo.
--   * Una cartola se importa solo si cuadra: saldo anterior + abonos − cargos = saldo
--     final, los totales coinciden con los movimientos y, si trae saldo diario, cada
--     línea cuadra con la anterior. Cartolas que se traslapan no duplican movimientos.
--   * Cartolas y movimientos no se modifican ni se borran.
--   * Conciliar es asociar uno o más movimientos del banco con una o más líneas de la
--     cuenta contable del banco cuyo neto sea exactamente el mismo. Una conciliación
--     se anula con motivo y queda en el historial. Todo queda en la bitácora.
--   * Todo requiere el módulo TESORERIA contratado.
-- =============================================================================

INSERT INTO permisos (codigo, descripcion) VALUES
  ('tesoreria.cuentas.administrar', 'Registrar cuentas bancarias y reglas de clasificación de movimientos'),
  ('tesoreria.cartolas.importar',   'Importar cartolas bancarias'),
  ('tesoreria.conciliar',           'Conciliar y anular conciliaciones bancarias');

INSERT INTO rol_permisos (rol_codigo, permiso_codigo) VALUES
  ('CONTADOR', 'tesoreria.cuentas.administrar'),
  ('CONTADOR', 'tesoreria.cartolas.importar'),
  ('CONTADOR', 'tesoreria.conciliar'),
  ('AUDITOR',  'tesoreria.saldos.ver');

CREATE FUNCTION tesoreria_exigir(p_empresa uuid, p_permiso text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario uuid := contabilidad_exigir(p_empresa, p_permiso);
BEGIN
  IF NOT app_modulo_vigente(p_empresa, 'TESORERIA', contabilidad_hoy()) THEN
    RAISE EXCEPTION 'La empresa no tiene el módulo Tesorería contratado' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_usuario;
END;
$$;

-- ---------------------------------------------------------------------------
-- Cuentas bancarias
-- ---------------------------------------------------------------------------
CREATE TABLE cuentas_bancarias (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid NOT NULL REFERENCES empresas(id),
  banco               text NOT NULL CHECK (banco IN ('SCOTIABANK', 'BANCO_ESTADO', 'BANCO_CHILE', 'BCI', 'SANTANDER',
                                                     'ITAU', 'BICE', 'SECURITY', 'FALABELLA', 'OTRO')),
  numero              text NOT NULL CHECK (numero ~ '^[0-9]{4,20}$'),
  moneda              text NOT NULL DEFAULT 'CLP' CHECK (moneda = 'CLP'),
  cuenta_contable_id  uuid NOT NULL REFERENCES plan_cuentas(id),
  activa              boolean NOT NULL DEFAULT true,
  creado_por          uuid NOT NULL REFERENCES usuarios(id),
  creado_en           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, banco, numero),
  UNIQUE (empresa_id, cuenta_contable_id)
);

CREATE FUNCTION tesoreria_crear_cuenta(p_empresa uuid, p_banco text, p_numero text, p_cuenta_contable text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario uuid := tesoreria_exigir(p_empresa, 'tesoreria.cuentas.administrar');
  v_cuenta plan_cuentas;
  v_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_cuenta FROM plan_cuentas WHERE empresa_id = p_empresa AND codigo = p_cuenta_contable;
  IF v_cuenta.id IS NULL OR NOT v_cuenta.imputable OR NOT v_cuenta.activa OR v_cuenta.clasificacion <> 'ACTIVO' THEN
    RAISE EXCEPTION 'La cuenta contable % debe existir, ser imputable, estar activa y ser de activo', p_cuenta_contable
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO cuentas_bancarias (id, empresa_id, banco, numero, cuenta_contable_id, creado_por)
  VALUES (v_id, p_empresa, p_banco, regexp_replace(coalesce(p_numero, ''), '[^0-9]', '', 'g'), v_cuenta.id, v_usuario);
  PERFORM contabilidad_auditar('CUENTA_BANCARIA_CREADA', 'cuentas_bancarias', v_id::text,
    jsonb_build_object('banco', p_banco, 'numero', p_numero, 'cuenta_contable', p_cuenta_contable), p_empresa);
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Cartolas y movimientos
-- ---------------------------------------------------------------------------
CREATE TABLE cartolas (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL REFERENCES empresas(id),
  cuenta_id        uuid NOT NULL REFERENCES cuentas_bancarias(id),
  numero_estado    int,
  desde            date NOT NULL,
  hasta            date NOT NULL,
  saldo_anterior   numeric(18, 0) NOT NULL,
  total_abonos     numeric(18, 0) NOT NULL CHECK (total_abonos >= 0),
  total_cargos     numeric(18, 0) NOT NULL CHECK (total_cargos >= 0),
  saldo_final      numeric(18, 0) NOT NULL,
  formato          text NOT NULL CHECK (formato IN ('SCOTIABANK_XLS', 'TABLA_GENERICA')),
  archivo_nombre   text NOT NULL,
  archivo_sha256   text NOT NULL CHECK (archivo_sha256 ~ '^[0-9a-f]{64}$'),
  -- Movimientos del archivo; los nuevos son los movimientos_bancarios con esta cartola_id
  -- (los demás ya venían en una cartola anterior que se traslapa).
  movimientos      int NOT NULL,
  importado_por    uuid NOT NULL REFERENCES usuarios(id),
  importado_en     timestamptz NOT NULL DEFAULT now(),
  CHECK (hasta >= desde),
  CHECK (saldo_anterior + total_abonos - total_cargos = saldo_final),
  UNIQUE (cuenta_id, archivo_sha256)
);
CREATE INDEX cartolas_cuenta_idx ON cartolas (cuenta_id, desde);

CREATE TABLE movimientos_bancarios (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id         uuid NOT NULL REFERENCES empresas(id),
  cuenta_id          uuid NOT NULL REFERENCES cuentas_bancarias(id),
  cartola_id         uuid NOT NULL REFERENCES cartolas(id),
  fecha              date NOT NULL,
  descripcion        text NOT NULL,
  numero_documento   text,
  -- Abono positivo, cargo negativo.
  monto              numeric(18, 0) NOT NULL CHECK (monto <> 0),
  saldo              numeric(18, 0),
  rut_contraparte    text CHECK (rut_contraparte IS NULL OR rut_es_valido(rut_contraparte)),
  -- N-ésimo movimiento idéntico (fecha, descripción, monto) en la cartola: permite que
  -- cartolas traslapadas no dupliquen movimientos y que dos transferencias iguales el
  -- mismo día se distingan.
  ocurrencia         int NOT NULL CHECK (ocurrencia > 0),
  UNIQUE (cuenta_id, fecha, descripcion, monto, ocurrencia)
);
CREATE INDEX movimientos_bancarios_fecha_idx ON movimientos_bancarios (cuenta_id, fecha);

CREATE TRIGGER cartolas_inmutables BEFORE UPDATE OR DELETE ON cartolas
  FOR EACH ROW EXECUTE FUNCTION tributario_rechazar_cambios();
CREATE TRIGGER movimientos_inmutables BEFORE UPDATE OR DELETE ON movimientos_bancarios
  FOR EACH ROW EXECUTE FUNCTION tributario_rechazar_cambios();
CREATE TRIGGER cartolas_sin_truncate BEFORE TRUNCATE ON cartolas
  FOR EACH STATEMENT EXECUTE FUNCTION tributario_rechazar_cambios();
CREATE TRIGGER movimientos_sin_truncate BEFORE TRUNCATE ON movimientos_bancarios
  FOR EACH STATEMENT EXECUTE FUNCTION tributario_rechazar_cambios();

-- Registra una cartola ya leída. p_cabecera: {numero_estado, desde, hasta, saldo_anterior,
-- total_abonos, total_cargos, saldo_final}; p_movimientos: arreglo en el orden del archivo
-- de {fecha, descripcion, numero_documento, monto, saldo, rut_contraparte}.
CREATE FUNCTION tesoreria_registrar_cartola(
  p_empresa uuid, p_cuenta uuid, p_formato text, p_archivo_nombre text, p_archivo_sha256 text,
  p_cabecera jsonb, p_movimientos jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario uuid := tesoreria_exigir(p_empresa, 'tesoreria.cartolas.importar');
  v_cuenta cuentas_bancarias;
  v_id uuid := gen_random_uuid();
  v_existente uuid;
  v_desde date;
  v_hasta date;
  v_anterior numeric;
  v_abonos numeric;
  v_cargos numeric;
  v_final numeric;
  v_n int;
  v_malos int;
  v_nuevos int;
  v_previa cartolas;
  v_adv jsonb := '[]';
BEGIN
  SELECT * INTO v_cuenta FROM cuentas_bancarias WHERE id = p_cuenta AND empresa_id = p_empresa FOR SHARE;
  IF v_cuenta.id IS NULL OR NOT v_cuenta.activa THEN
    RAISE EXCEPTION 'Cuenta bancaria no encontrada o inactiva' USING ERRCODE = 'check_violation';
  END IF;
  IF p_archivo_sha256 IS NULL OR p_archivo_sha256 !~ '^[0-9a-f]{64}$' OR length(trim(coalesce(p_archivo_nombre, ''))) = 0 THEN
    RAISE EXCEPTION 'Archivo inválido' USING ERRCODE = 'check_violation';
  END IF;
  IF p_movimientos IS NULL OR jsonb_typeof(p_movimientos) IS DISTINCT FROM 'array' OR jsonb_array_length(p_movimientos) > 50000
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_movimientos) x WHERE jsonb_typeof(x) <> 'object') THEN
    RAISE EXCEPTION 'Movimientos inválidos (máximo 50.000 por cartola)' USING ERRCODE = 'check_violation';
  END IF;
  IF p_cabecera IS NULL OR jsonb_typeof(p_cabecera) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Cabecera de cartola inválida' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('cartola:' || p_cuenta::text, 0));
  SELECT id INTO v_existente FROM cartolas WHERE cuenta_id = p_cuenta AND archivo_sha256 = p_archivo_sha256;
  IF v_existente IS NOT NULL THEN
    RETURN jsonb_build_object('cartola_id', v_existente, 'nuevos', 0, 'ya_importada', true, 'advertencias', '[]'::jsonb);
  END IF;

  v_desde := (p_cabecera ->> 'desde')::date;
  v_hasta := (p_cabecera ->> 'hasta')::date;
  v_anterior := (p_cabecera ->> 'saldo_anterior')::numeric;
  v_abonos := (p_cabecera ->> 'total_abonos')::numeric;
  v_cargos := (p_cabecera ->> 'total_cargos')::numeric;
  v_final := (p_cabecera ->> 'saldo_final')::numeric;
  IF v_desde IS NULL OR v_hasta IS NULL OR v_hasta < v_desde OR v_hasta > contabilidad_hoy()
     OR v_anterior IS NULL OR v_abonos IS NULL OR v_cargos IS NULL OR v_final IS NULL
     OR v_abonos < 0 OR v_cargos < 0
     OR EXISTS (SELECT 1 FROM unnest(ARRAY[v_anterior, v_abonos, v_cargos, v_final]) m
                WHERE m = 'NaN' OR m <> trunc(m) OR abs(m) > 999999999999999) THEN
    RAISE EXCEPTION 'La cabecera de la cartola tiene fechas o montos inválidos' USING ERRCODE = 'check_violation';
  END IF;
  IF v_anterior + v_abonos - v_cargos <> v_final THEN
    RAISE EXCEPTION 'La cartola no cuadra: saldo anterior % + abonos % − cargos % ≠ saldo final %',
      v_anterior, v_abonos, v_cargos, v_final USING ERRCODE = 'check_violation';
  END IF;

  -- Movimientos: fechas dentro del período, montos enteros distintos de cero.
  SELECT count(*),
         count(*) FILTER (WHERE m.fecha IS NULL OR m.fecha < v_desde OR m.fecha > v_hasta
                            OR m.monto IS NULL OR m.monto = 0 OR m.monto <> trunc(m.monto) OR abs(m.monto) > 999999999999
                            OR (m.saldo IS NOT NULL AND m.saldo <> trunc(m.saldo))
                            OR length(trim(coalesce(m.descripcion, ''))) = 0 OR length(m.descripcion) > 300
                            OR (m.rut_contraparte IS NOT NULL AND NOT rut_es_valido(m.rut_contraparte)))
  INTO v_n, v_malos
  FROM jsonb_to_recordset(p_movimientos) AS m(fecha date, descripcion text, monto numeric, saldo numeric, rut_contraparte text);
  IF v_malos > 0 THEN
    RAISE EXCEPTION '% movimiento(s) con fecha fuera del período de la cartola, monto inválido o descripción vacía', v_malos
      USING ERRCODE = 'check_violation';
  END IF;

  -- Totales y saldo diario.
  IF (SELECT coalesce(sum(monto) FILTER (WHERE monto > 0), 0) FROM jsonb_to_recordset(p_movimientos) AS m(monto numeric)) <> v_abonos
     OR (SELECT coalesce(-sum(monto) FILTER (WHERE monto < 0), 0) FROM jsonb_to_recordset(p_movimientos) AS m(monto numeric)) <> v_cargos THEN
    RAISE EXCEPTION 'La suma de los movimientos no coincide con los totales de abonos y cargos de la cartola' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_malos FROM (
    SELECT m.saldo, v_anterior + sum(m.monto) OVER (ORDER BY o) AS esperado
    FROM ROWS FROM (jsonb_to_recordset(p_movimientos) AS (monto numeric, saldo numeric)) WITH ORDINALITY AS m(monto, saldo, o)
  ) t WHERE t.saldo IS NOT NULL AND t.saldo <> t.esperado;
  IF v_malos > 0 THEN
    RAISE EXCEPTION '% movimiento(s) no cuadran con el saldo diario de la cartola', v_malos USING ERRCODE = 'check_violation';
  END IF;

  -- Continuidad con la cartola anterior de la cuenta.
  SELECT * INTO v_previa FROM cartolas WHERE cuenta_id = p_cuenta AND hasta < v_desde ORDER BY hasta DESC LIMIT 1;
  IF v_previa.id IS NOT NULL AND (v_previa.hasta + 1 < v_desde OR v_previa.saldo_final <> v_anterior) THEN
    v_adv := v_adv || jsonb_build_array(jsonb_build_object('tipo', 'CARTOLAS_DISCONTINUAS',
      'mensaje', format('Entre la cartola anterior (hasta %s, saldo $%s) y esta (desde %s, saldo anterior $%s) faltan movimientos: importe la cartola intermedia.',
                        to_char(v_previa.hasta, 'DD-MM-YYYY'), v_previa.saldo_final, to_char(v_desde, 'DD-MM-YYYY'), v_anterior)));
  END IF;

  INSERT INTO cartolas (id, empresa_id, cuenta_id, numero_estado, desde, hasta, saldo_anterior, total_abonos, total_cargos,
    saldo_final, formato, archivo_nombre, archivo_sha256, movimientos, importado_por)
  VALUES (v_id, p_empresa, p_cuenta, (p_cabecera ->> 'numero_estado')::int, v_desde, v_hasta, v_anterior, v_abonos, v_cargos,
    v_final, p_formato, left(trim(p_archivo_nombre), 200), p_archivo_sha256, v_n, v_usuario);

  WITH entrada AS (
    SELECT m.*, row_number() OVER (PARTITION BY m.fecha, trim(m.descripcion), m.monto ORDER BY o) AS ocurrencia
    FROM ROWS FROM (jsonb_to_recordset(p_movimientos) AS (fecha date, descripcion text, numero_documento text,
      monto numeric, saldo numeric, rut_contraparte text))
      WITH ORDINALITY AS m(fecha, descripcion, numero_documento, monto, saldo, rut_contraparte, o)
  ), insertados AS (
    INSERT INTO movimientos_bancarios (empresa_id, cuenta_id, cartola_id, fecha, descripcion, numero_documento, monto, saldo,
      rut_contraparte, ocurrencia)
    SELECT p_empresa, p_cuenta, v_id, e.fecha, trim(e.descripcion), nullif(left(trim(coalesce(e.numero_documento, '')), 50), ''),
      e.monto, e.saldo, e.rut_contraparte, e.ocurrencia
    FROM entrada e ORDER BY e.o
    ON CONFLICT (cuenta_id, fecha, descripcion, monto, ocurrencia) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_nuevos FROM insertados;

  PERFORM contabilidad_auditar('CARTOLA_IMPORTADA', 'cartolas', v_id::text,
    jsonb_build_object('cuenta', p_cuenta, 'desde', v_desde, 'hasta', v_hasta, 'movimientos', v_n, 'nuevos', v_nuevos,
                       'saldo_final', v_final, 'sha256', p_archivo_sha256), p_empresa);
  RETURN jsonb_build_object('cartola_id', v_id, 'movimientos', v_n, 'nuevos', v_nuevos, 'ya_importada', false, 'advertencias', v_adv);
END;
$$;

-- ---------------------------------------------------------------------------
-- Conciliación
-- ---------------------------------------------------------------------------
CREATE TABLE conciliaciones (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        uuid NOT NULL REFERENCES empresas(id),
  cuenta_id         uuid NOT NULL REFERENCES cuentas_bancarias(id),
  estado            text NOT NULL DEFAULT 'VIGENTE' CHECK (estado IN ('VIGENTE', 'ANULADA')),
  origen            text NOT NULL CHECK (origen IN ('MANUAL', 'AGENTE', 'AGENTE_APROBADO')),
  monto             numeric(18, 0) NOT NULL,
  creado_por        uuid NOT NULL REFERENCES usuarios(id),
  creado_en         timestamptz NOT NULL DEFAULT now(),
  anulado_por       uuid REFERENCES usuarios(id),
  anulado_en        timestamptz,
  motivo_anulacion  text,
  CHECK ((estado = 'ANULADA') = (motivo_anulacion IS NOT NULL))
);

CREATE TABLE conciliacion_movimientos (
  conciliacion_id  uuid NOT NULL REFERENCES conciliaciones(id),
  movimiento_id    bigint NOT NULL REFERENCES movimientos_bancarios(id),
  empresa_id       uuid NOT NULL REFERENCES empresas(id),
  vigente          boolean NOT NULL DEFAULT true,
  PRIMARY KEY (conciliacion_id, movimiento_id)
);
CREATE UNIQUE INDEX conciliacion_movimientos_vigente_uq ON conciliacion_movimientos (movimiento_id) WHERE vigente;

CREATE TABLE conciliacion_lineas (
  conciliacion_id   uuid NOT NULL REFERENCES conciliaciones(id),
  asiento_linea_id  bigint NOT NULL REFERENCES asiento_lineas(id),
  empresa_id        uuid NOT NULL REFERENCES empresas(id),
  vigente           boolean NOT NULL DEFAULT true,
  PRIMARY KEY (conciliacion_id, asiento_linea_id)
);
CREATE UNIQUE INDEX conciliacion_lineas_vigente_uq ON conciliacion_lineas (asiento_linea_id) WHERE vigente;

-- Una conciliación solo pasa de VIGENTE a ANULADA; sus partes solo dejan de estar vigentes.
CREATE FUNCTION conciliacion_transicion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Las conciliaciones no se borran: se anulan' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'conciliaciones' THEN
    IF OLD.estado <> 'VIGENTE' OR NEW.estado <> 'ANULADA'
       OR (to_jsonb(NEW) - ARRAY['estado', 'anulado_por', 'anulado_en', 'motivo_anulacion'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['estado', 'anulado_por', 'anulado_en', 'motivo_anulacion']) THEN
      RAISE EXCEPTION 'Una conciliación solo se anula' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NOT OLD.vigente OR NEW.vigente OR (to_jsonb(NEW) - 'vigente') IS DISTINCT FROM (to_jsonb(OLD) - 'vigente') THEN
    RAISE EXCEPTION 'Una conciliación solo se anula' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER conciliaciones_transicion BEFORE UPDATE OR DELETE ON conciliaciones
  FOR EACH ROW EXECUTE FUNCTION conciliacion_transicion();
CREATE TRIGGER conciliacion_movimientos_transicion BEFORE UPDATE OR DELETE ON conciliacion_movimientos
  FOR EACH ROW EXECUTE FUNCTION conciliacion_transicion();
CREATE TRIGGER conciliacion_lineas_transicion BEFORE UPDATE OR DELETE ON conciliacion_lineas
  FOR EACH ROW EXECUTE FUNCTION conciliacion_transicion();
CREATE TRIGGER conciliaciones_sin_truncate BEFORE TRUNCATE ON conciliaciones
  FOR EACH STATEMENT EXECUTE FUNCTION tributario_rechazar_cambios();
CREATE TRIGGER conciliacion_movimientos_sin_truncate BEFORE TRUNCATE ON conciliacion_movimientos
  FOR EACH STATEMENT EXECUTE FUNCTION tributario_rechazar_cambios();
CREATE TRIGGER conciliacion_lineas_sin_truncate BEFORE TRUNCATE ON conciliacion_lineas
  FOR EACH STATEMENT EXECUTE FUNCTION tributario_rechazar_cambios();

-- Línea contable "anulada": su asiento fue reversado, o es la reversa de otro asiento.
CREATE FUNCTION tesoreria_linea_anulada(p_asiento uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM asientos a WHERE a.id = p_asiento AND a.tipo = 'REVERSA')
      OR EXISTS (SELECT 1 FROM asientos r WHERE r.reversa_de = p_asiento)
$$;

CREATE FUNCTION tesoreria_conciliar(p_empresa uuid, p_movimientos bigint[], p_lineas bigint[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario uuid := tesoreria_exigir(p_empresa, 'tesoreria.conciliar');
  v_cuenta uuid;
  v_cuenta_contable uuid;
  v_n int;
  v_suma_mov numeric;
  v_suma_lin numeric;
  v_id uuid := gen_random_uuid();
  v_propuesta text := nullif(current_setting('app.propuesta_agente', true), '');
  v_origen text;
BEGIN
  IF p_movimientos IS NULL OR p_lineas IS NULL OR cardinality(p_movimientos) = 0 OR cardinality(p_lineas) = 0
     OR cardinality(p_movimientos) > 500 OR cardinality(p_lineas) > 500
     OR array_position(p_movimientos, NULL) IS NOT NULL OR array_position(p_lineas, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Indique al menos un movimiento del banco y una línea contable' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(p_movimientos) x) <> cardinality(p_movimientos)
     OR (SELECT count(DISTINCT x) FROM unnest(p_lineas) x) <> cardinality(p_lineas) THEN
    RAISE EXCEPTION 'Hay movimientos o líneas repetidos' USING ERRCODE = 'check_violation';
  END IF;

  -- Movimientos: de la empresa, de una sola cuenta y sin conciliar.
  SELECT count(*), min(m.cuenta_id::text)::uuid, count(DISTINCT m.cuenta_id), sum(m.monto)
  INTO v_n, v_cuenta, v_n, v_suma_mov
  FROM movimientos_bancarios m WHERE m.id = ANY (p_movimientos) AND m.empresa_id = p_empresa;
  IF (SELECT count(*) FROM movimientos_bancarios m WHERE m.id = ANY (p_movimientos) AND m.empresa_id = p_empresa) <> cardinality(p_movimientos)
     OR v_n <> 1 THEN
    RAISE EXCEPTION 'Los movimientos deben existir y ser de una misma cuenta de la empresa' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('conciliar:' || v_cuenta::text, 0));
  IF EXISTS (SELECT 1 FROM conciliacion_movimientos WHERE movimiento_id = ANY (p_movimientos) AND vigente) THEN
    RAISE EXCEPTION 'Algún movimiento ya está conciliado' USING ERRCODE = 'check_violation';
  END IF;
  SELECT cuenta_contable_id INTO v_cuenta_contable FROM cuentas_bancarias WHERE id = v_cuenta;

  -- Líneas: de la cuenta contable del banco, de asientos vigentes y sin conciliar.
  IF (SELECT count(*) FROM asiento_lineas l
      WHERE l.id = ANY (p_lineas) AND l.empresa_id = p_empresa AND l.cuenta_id = v_cuenta_contable) <> cardinality(p_lineas) THEN
    RAISE EXCEPTION 'Las líneas deben ser de la cuenta contable de este banco' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM asiento_lineas l JOIN asientos a ON a.id = l.asiento_id
             WHERE l.id = ANY (p_lineas) AND (a.tipo IN ('APERTURA', 'CIERRE') OR tesoreria_linea_anulada(a.id))) THEN
    RAISE EXCEPTION 'No se concilian líneas de apertura, de cierre ni de asientos reversados' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM conciliacion_lineas WHERE asiento_linea_id = ANY (p_lineas) AND vigente) THEN
    RAISE EXCEPTION 'Alguna línea contable ya está conciliada' USING ERRCODE = 'check_violation';
  END IF;
  SELECT sum(l.debe - l.haber) INTO v_suma_lin FROM asiento_lineas l WHERE l.id = ANY (p_lineas);
  IF v_suma_mov <> v_suma_lin THEN
    RAISE EXCEPTION 'No cuadra: los movimientos del banco suman $% y las líneas contables $%', v_suma_mov, v_suma_lin
      USING ERRCODE = 'check_violation';
  END IF;

  IF tributario_es_agente() THEN
    v_origen := 'AGENTE';
  ELSIF v_propuesta IS NOT NULL AND EXISTS (SELECT 1 FROM propuestas_agente WHERE id::text = v_propuesta
        AND empresa_id = p_empresa AND estado = 'PENDIENTE') THEN
    v_origen := 'AGENTE_APROBADO';
  ELSE
    v_origen := 'MANUAL';
  END IF;

  INSERT INTO conciliaciones (id, empresa_id, cuenta_id, origen, monto, creado_por)
  VALUES (v_id, p_empresa, v_cuenta, v_origen, v_suma_mov, v_usuario);
  INSERT INTO conciliacion_movimientos (conciliacion_id, movimiento_id, empresa_id)
  SELECT v_id, x, p_empresa FROM unnest(p_movimientos) x;
  INSERT INTO conciliacion_lineas (conciliacion_id, asiento_linea_id, empresa_id)
  SELECT v_id, x, p_empresa FROM unnest(p_lineas) x;
  PERFORM contabilidad_auditar('CONCILIACION_CREADA', 'conciliaciones', v_id::text,
    jsonb_build_object('cuenta', v_cuenta, 'movimientos', p_movimientos, 'lineas', p_lineas, 'monto', v_suma_mov, 'origen', v_origen),
    p_empresa);
  RETURN v_id;
END;
$$;

CREATE FUNCTION tesoreria_anular_conciliacion(p_id uuid, p_motivo text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v conciliaciones;
BEGIN
  SELECT * INTO v FROM conciliaciones WHERE id = p_id FOR UPDATE;
  IF v.id IS NULL OR v.empresa_id IS DISTINCT FROM app_empresa_id() THEN
    RAISE EXCEPTION 'Conciliación no encontrada' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM tesoreria_exigir(v.empresa_id, 'tesoreria.conciliar');
  IF v.estado <> 'VIGENTE' THEN
    RAISE EXCEPTION 'La conciliación ya está anulada' USING ERRCODE = 'check_violation';
  END IF;
  IF length(trim(coalesce(p_motivo, ''))) < 10 THEN
    RAISE EXCEPTION 'Indique el motivo de la anulación (al menos 10 caracteres)' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE conciliaciones SET estado = 'ANULADA', anulado_por = app_usuario_id(), anulado_en = now(), motivo_anulacion = trim(p_motivo)
  WHERE id = p_id;
  UPDATE conciliacion_movimientos SET vigente = false WHERE conciliacion_id = p_id;
  UPDATE conciliacion_lineas SET vigente = false WHERE conciliacion_id = p_id;
  PERFORM contabilidad_auditar('CONCILIACION_ANULADA', 'conciliaciones', p_id::text,
    jsonb_build_object('motivo', trim(p_motivo), 'monto', v.monto), v.empresa_id);
END;
$$;

-- Líneas de la cuenta contable del banco (para conciliar y para el informe), sin exigir
-- el permiso de ver todo el libro: muestra solo la cuenta del banco.
CREATE FUNCTION tesoreria_lineas_banco(p_empresa uuid, p_cuenta uuid, p_hasta date)
RETURNS TABLE (linea_id bigint, asiento_id uuid, numero int, fecha date, tipo text, glosa text, monto numeric,
               tercero text, anulada boolean, conciliacion_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_cuenta_contable uuid;
BEGIN
  PERFORM tesoreria_exigir(p_empresa, 'tesoreria.saldos.ver');
  SELECT cuenta_contable_id INTO v_cuenta_contable FROM cuentas_bancarias WHERE id = p_cuenta AND empresa_id = p_empresa;
  IF v_cuenta_contable IS NULL THEN
    RAISE EXCEPTION 'Cuenta bancaria no encontrada' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT l.id, a.id, a.numero, a.fecha, a.tipo, coalesce(l.glosa, a.glosa), l.debe - l.haber,
         t.rut, tesoreria_linea_anulada(a.id), cl.conciliacion_id
  FROM asiento_lineas l
  JOIN asientos a ON a.id = l.asiento_id
  LEFT JOIN terceros t ON t.id = l.tercero_id
  LEFT JOIN conciliacion_lineas cl ON cl.asiento_linea_id = l.id AND cl.vigente
  WHERE l.empresa_id = p_empresa AND l.cuenta_id = v_cuenta_contable AND a.fecha <= p_hasta
  ORDER BY a.fecha, a.numero, l.linea;
END;
$$;

-- ---------------------------------------------------------------------------
-- Reglas de clasificación (sugieren cómo contabilizar un movimiento)
-- ---------------------------------------------------------------------------
CREATE TABLE reglas_conciliacion (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid NOT NULL REFERENCES empresas(id),
  cuenta_id           uuid REFERENCES cuentas_bancarias(id),
  nombre              text NOT NULL CHECK (length(trim(nombre)) >= 3),
  rut_contraparte     text CHECK (rut_contraparte IS NULL OR rut_es_valido(rut_contraparte)),
  texto               text CHECK (texto IS NULL OR length(trim(texto)) >= 3),
  sentido             text NOT NULL CHECK (sentido IN ('ABONO', 'CARGO', 'AMBOS')),
  cuenta_contable_id  uuid NOT NULL REFERENCES plan_cuentas(id),
  tercero_id          uuid REFERENCES terceros(id),
  glosa               text NOT NULL CHECK (length(trim(glosa)) >= 3),
  activa              boolean NOT NULL DEFAULT true,
  creado_por          uuid NOT NULL REFERENCES usuarios(id),
  creado_en           timestamptz NOT NULL DEFAULT now(),
  CHECK (rut_contraparte IS NOT NULL OR texto IS NOT NULL)
);

CREATE FUNCTION tesoreria_crear_regla(p_empresa uuid, p_cuenta uuid, p_nombre text, p_rut text, p_texto text, p_sentido text,
  p_cuenta_contable text, p_tercero_rut text, p_glosa text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario uuid := tesoreria_exigir(p_empresa, 'tesoreria.cuentas.administrar');
  v_cuenta plan_cuentas;
  v_tercero uuid;
  v_id uuid := gen_random_uuid();
BEGIN
  IF tributario_es_agente() THEN
    RAISE EXCEPTION 'Las reglas de clasificación las crea una persona' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_cuenta IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cuentas_bancarias WHERE id = p_cuenta AND empresa_id = p_empresa) THEN
    RAISE EXCEPTION 'Cuenta bancaria no encontrada' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_cuenta FROM plan_cuentas WHERE empresa_id = p_empresa AND codigo = p_cuenta_contable;
  IF v_cuenta.id IS NULL OR NOT v_cuenta.imputable OR NOT v_cuenta.activa THEN
    RAISE EXCEPTION 'La cuenta contable % debe existir, ser imputable y estar activa', p_cuenta_contable USING ERRCODE = 'check_violation';
  END IF;
  IF p_tercero_rut IS NOT NULL THEN
    SELECT id INTO v_tercero FROM terceros WHERE empresa_id = p_empresa AND rut = p_tercero_rut;
    IF v_tercero IS NULL THEN
      RAISE EXCEPTION 'El tercero % no existe en la empresa', p_tercero_rut USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  INSERT INTO reglas_conciliacion (id, empresa_id, cuenta_id, nombre, rut_contraparte, texto, sentido, cuenta_contable_id,
    tercero_id, glosa, creado_por)
  VALUES (v_id, p_empresa, p_cuenta, trim(p_nombre), p_rut, nullif(trim(coalesce(p_texto, '')), ''), p_sentido, v_cuenta.id,
    v_tercero, trim(p_glosa), v_usuario);
  PERFORM contabilidad_auditar('REGLA_CONCILIACION_CREADA', 'reglas_conciliacion', v_id::text,
    jsonb_build_object('nombre', p_nombre, 'rut', p_rut, 'texto', p_texto, 'sentido', p_sentido,
                       'cuenta_contable', p_cuenta_contable, 'tercero', p_tercero_rut), p_empresa);
  RETURN v_id;
END;
$$;

CREATE FUNCTION tesoreria_desactivar_regla(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v reglas_conciliacion;
BEGIN
  SELECT * INTO v FROM reglas_conciliacion WHERE id = p_id FOR UPDATE;
  IF v.id IS NULL OR v.empresa_id IS DISTINCT FROM app_empresa_id() THEN
    RAISE EXCEPTION 'Regla no encontrada' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM tesoreria_exigir(v.empresa_id, 'tesoreria.cuentas.administrar');
  UPDATE reglas_conciliacion SET activa = false WHERE id = p_id;
  PERFORM contabilidad_auditar('REGLA_CONCILIACION_DESACTIVADA', 'reglas_conciliacion', p_id::text, '{}'::jsonb, v.empresa_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Lectura (seguridad por fila) y permisos de ejecución
-- ---------------------------------------------------------------------------
ALTER TABLE cuentas_bancarias ENABLE ROW LEVEL SECURITY;
ALTER TABLE cartolas ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimientos_bancarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE conciliaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE conciliacion_movimientos ENABLE ROW LEVEL SECURITY;
ALTER TABLE conciliacion_lineas ENABLE ROW LEVEL SECURITY;
ALTER TABLE reglas_conciliacion ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON cuentas_bancarias, cartolas, movimientos_bancarios, conciliaciones, conciliacion_movimientos,
  conciliacion_lineas, reglas_conciliacion TO erp_app;

CREATE POLICY cuentas_bancarias_ver ON cuentas_bancarias FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'tesoreria.saldos.ver'));
CREATE POLICY cartolas_ver ON cartolas FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'tesoreria.saldos.ver'));
CREATE POLICY movimientos_bancarios_ver ON movimientos_bancarios FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'tesoreria.saldos.ver'));
CREATE POLICY conciliaciones_ver ON conciliaciones FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'tesoreria.saldos.ver'));
CREATE POLICY conciliacion_movimientos_ver ON conciliacion_movimientos FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'tesoreria.saldos.ver'));
CREATE POLICY conciliacion_lineas_ver ON conciliacion_lineas FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'tesoreria.saldos.ver'));
CREATE POLICY reglas_conciliacion_ver ON reglas_conciliacion FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'tesoreria.saldos.ver'));

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  tesoreria_crear_cuenta(uuid, text, text, text),
  tesoreria_registrar_cartola(uuid, uuid, text, text, text, jsonb, jsonb),
  tesoreria_conciliar(uuid, bigint[], bigint[]),
  tesoreria_anular_conciliacion(uuid, text),
  tesoreria_lineas_banco(uuid, uuid, date),
  tesoreria_crear_regla(uuid, uuid, text, text, text, text, text, text, text),
  tesoreria_desactivar_regla(uuid)
TO erp_app;
