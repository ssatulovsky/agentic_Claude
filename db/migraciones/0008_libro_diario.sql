-- =============================================================================
-- 0008 · Libro diario: ejercicios, períodos, asientos inmutables, cierre y reapertura
-- =============================================================================
-- Reglas (todas aplicadas por la base de datos):
--   * Un asiento solo se registra con contabilidad_registrar_asiento(): partida
--     doble exacta, al menos dos líneas, cuentas imputables y activas de la
--     empresa, tercero y centro de costo cuando la cuenta los exige, período y
--     ejercicio abiertos, numeración correlativa sin saltos por ejercicio.
--   * Asientos y líneas no se modifican ni se borran: se corrigen con una reversa.
--   * Los meses se cierran en orden. Un mes del ejercicio en curso se reabre con
--     el permiso de períodos y un motivo. Un ejercicio cerrado solo se reabre con
--     dos aprobaciones del Directorio (personas distintas de quien lo solicita),
--     con referencia al acta y por un plazo limitado.
--   * Todo queda en la bitácora.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permisos y rol de Director
-- ---------------------------------------------------------------------------
INSERT INTO permisos (codigo, descripcion) VALUES
  ('contabilidad.asientos.ver',                     'Ver asientos, libro mayor y balances'),
  ('contabilidad.asientos.registrar',               'Registrar y reversar asientos'),
  ('contabilidad.periodos.administrar',             'Crear ejercicios, cerrar y reabrir meses del ejercicio en curso'),
  ('contabilidad.ejercicio.cerrar',                 'Cerrar el ejercicio y solicitar su reapertura'),
  ('contabilidad.ejercicio.autorizar_reapertura',   'Autorizar la reapertura de un ejercicio cerrado (Directorio)');

INSERT INTO roles (codigo, nombre, descripcion) VALUES
  ('DIRECTOR', 'Director', 'Miembro del Directorio: ve la información y autoriza reaperturas de ejercicios cerrados');

INSERT INTO rol_permisos (rol_codigo, permiso_codigo) VALUES
  ('ADMIN_CLIENTE_ERP', 'contabilidad.asientos.ver'),
  ('CONTADOR',          'contabilidad.asientos.ver'),
  ('CONTADOR',          'contabilidad.asientos.registrar'),
  ('CONTADOR',          'contabilidad.periodos.administrar'),
  ('CONTADOR',          'contabilidad.ejercicio.cerrar'),
  ('GERENTE_GENERAL',   'contabilidad.asientos.ver'),
  ('AUDITOR',           'contabilidad.asientos.ver'),
  ('DIRECTOR',          'empresas.ver'),
  ('DIRECTOR',          'agentes.consultar'),
  ('DIRECTOR',          'contabilidad.asientos.ver'),
  ('DIRECTOR',          'contabilidad.plan_cuentas.ver'),
  ('DIRECTOR',          'contabilidad.ejercicio.autorizar_reapertura');

-- ---------------------------------------------------------------------------
-- Ejercicios y períodos
-- ---------------------------------------------------------------------------
CREATE TABLE ejercicios_contables (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL REFERENCES empresas(id),
  anio             int NOT NULL CHECK (anio BETWEEN 2000 AND 2100),
  fecha_inicio     date NOT NULL,
  fecha_termino    date NOT NULL,
  estado           text NOT NULL DEFAULT 'ABIERTO' CHECK (estado IN ('ABIERTO', 'CERRADO')),
  cerrado_en       timestamptz,
  cerrado_por      uuid REFERENCES usuarios(id),
  -- Reapertura excepcional autorizada por el Directorio, vigente hasta esta fecha (inclusive).
  reabierto_hasta  date,
  ultimo_numero    int NOT NULL DEFAULT 0,   -- correlativo de asientos
  creado_en        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, anio),
  CHECK (fecha_termino > fecha_inicio),
  CHECK (extract(year FROM fecha_inicio) = anio AND extract(year FROM fecha_termino) = anio)
);

CREATE TABLE periodos_contables (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid NOT NULL REFERENCES empresas(id),
  ejercicio_id   uuid NOT NULL REFERENCES ejercicios_contables(id),
  anio           int NOT NULL,
  mes            int NOT NULL CHECK (mes BETWEEN 1 AND 12),
  fecha_inicio   date NOT NULL,
  fecha_termino  date NOT NULL,
  estado         text NOT NULL DEFAULT 'ABIERTO' CHECK (estado IN ('ABIERTO', 'CERRADO')),
  cerrado_en     timestamptz,
  cerrado_por    uuid REFERENCES usuarios(id),
  UNIQUE (empresa_id, anio, mes)
);
CREATE INDEX periodos_contables_fechas_idx ON periodos_contables (empresa_id, fecha_inicio, fecha_termino);

-- ¿El ejercicio admite movimientos hoy? (abierto, o con reapertura vigente)
CREATE FUNCTION contabilidad_ejercicio_admite_movimientos(e ejercicios_contables) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT e.estado = 'ABIERTO' OR (e.reabierto_hasta IS NOT NULL AND e.reabierto_hasta >= current_date)
$$;

-- ---------------------------------------------------------------------------
-- Asientos y líneas
-- ---------------------------------------------------------------------------
CREATE TABLE asientos (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id            uuid NOT NULL REFERENCES empresas(id),
  ejercicio_id          uuid NOT NULL REFERENCES ejercicios_contables(id),
  periodo_id            uuid NOT NULL REFERENCES periodos_contables(id),
  numero                int NOT NULL CHECK (numero > 0),
  fecha                 date NOT NULL,
  tipo                  text NOT NULL CHECK (tipo IN ('NORMAL', 'APERTURA', 'AJUSTE', 'CIERRE', 'REVERSA')),
  origen                text NOT NULL CHECK (origen IN ('MANUAL', 'AGENTE', 'MODULO')),
  glosa                 text NOT NULL CHECK (length(trim(glosa)) > 0),
  documento_referencia  text,
  reversa_de            uuid UNIQUE REFERENCES asientos(id),
  propuesta_id          uuid REFERENCES propuestas_agente(id),
  total                 numeric(18, 2) NOT NULL CHECK (total > 0),
  registrado_por        uuid NOT NULL REFERENCES usuarios(id),
  registrado_en         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ejercicio_id, numero),
  CHECK ((tipo = 'REVERSA') = (reversa_de IS NOT NULL))
);
CREATE INDEX asientos_empresa_fecha_idx ON asientos (empresa_id, fecha, numero);

CREATE TABLE asiento_lineas (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asiento_id       uuid NOT NULL REFERENCES asientos(id),
  empresa_id       uuid NOT NULL REFERENCES empresas(id),
  linea            int NOT NULL CHECK (linea > 0),
  cuenta_id        uuid NOT NULL REFERENCES plan_cuentas(id),
  debe             numeric(18, 2) NOT NULL DEFAULT 0 CHECK (debe >= 0),
  haber            numeric(18, 2) NOT NULL DEFAULT 0 CHECK (haber >= 0),
  tercero_id       uuid REFERENCES terceros(id),
  centro_costo_id  uuid REFERENCES centros_costo(id),
  glosa            text,
  UNIQUE (asiento_id, linea),
  CHECK ((debe > 0) <> (haber > 0))
);
CREATE INDEX asiento_lineas_cuenta_idx ON asiento_lineas (empresa_id, cuenta_id);

-- Inmutabilidad (también para el dueño de las tablas).
CREATE FUNCTION contabilidad_rechazar_cambios() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Los asientos contabilizados no se modifican ni se borran: registre una reversa (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER asientos_inmutables BEFORE UPDATE OR DELETE ON asientos
  FOR EACH ROW EXECUTE FUNCTION contabilidad_rechazar_cambios();
CREATE TRIGGER asientos_sin_truncate BEFORE TRUNCATE ON asientos
  FOR EACH STATEMENT EXECUTE FUNCTION contabilidad_rechazar_cambios();
CREATE TRIGGER asiento_lineas_inmutables BEFORE UPDATE OR DELETE ON asiento_lineas
  FOR EACH ROW EXECUTE FUNCTION contabilidad_rechazar_cambios();
CREATE TRIGGER asiento_lineas_sin_truncate BEFORE TRUNCATE ON asiento_lineas
  FOR EACH STATEMENT EXECUTE FUNCTION contabilidad_rechazar_cambios();

-- Defensa en profundidad: al confirmar la transacción, todo asiento debe tener al
-- menos dos líneas y cuadrar exactamente con su total.
CREATE FUNCTION contabilidad_verificar_cuadratura() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id    uuid;
  v_total numeric;
  v_debe  numeric;
  v_haber numeric;
  v_n     int;
BEGIN
  IF TG_TABLE_NAME = 'asientos' THEN
    v_id := NEW.id;
  ELSE
    v_id := NEW.asiento_id;
  END IF;
  SELECT total INTO v_total FROM asientos WHERE id = v_id;
  SELECT coalesce(sum(debe), 0), coalesce(sum(haber), 0), count(*)
    INTO v_debe, v_haber, v_n
  FROM asiento_lineas WHERE asiento_id = v_id;
  IF v_n < 2 OR v_debe <> v_haber OR v_debe <> v_total THEN
    RAISE EXCEPTION 'Asiento descuadrado: debe %, haber %, total %, líneas %', v_debe, v_haber, v_total, v_n
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER asientos_cuadratura AFTER INSERT ON asientos
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION contabilidad_verificar_cuadratura();
CREATE CONSTRAINT TRIGGER asiento_lineas_cuadratura AFTER INSERT ON asiento_lineas
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION contabilidad_verificar_cuadratura();

-- ---------------------------------------------------------------------------
-- Reapertura excepcional de ejercicios
-- ---------------------------------------------------------------------------
CREATE TABLE solicitudes_reapertura_ejercicio (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL REFERENCES empresas(id),
  ejercicio_id     uuid NOT NULL REFERENCES ejercicios_contables(id),
  motivo           text NOT NULL CHECK (length(trim(motivo)) >= 20),
  acta_referencia  text NOT NULL CHECK (length(trim(acta_referencia)) >= 3),
  plazo_dias       int NOT NULL CHECK (plazo_dias BETWEEN 1 AND 90),
  solicitado_por   uuid NOT NULL REFERENCES usuarios(id),
  estado           text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'APROBADA', 'RECHAZADA', 'VENCIDA')),
  creado_en        timestamptz NOT NULL DEFAULT now(),
  vence_en         timestamptz NOT NULL DEFAULT now() + interval '30 days',
  resuelta_en      timestamptz
);
CREATE UNIQUE INDEX solicitudes_reapertura_una_pendiente
  ON solicitudes_reapertura_ejercicio (ejercicio_id) WHERE estado = 'PENDIENTE';

CREATE TABLE aprobaciones_reapertura_ejercicio (
  solicitud_id  uuid NOT NULL REFERENCES solicitudes_reapertura_ejercicio(id),
  director_id   uuid NOT NULL REFERENCES usuarios(id),
  decision      text NOT NULL CHECK (decision IN ('APROBAR', 'RECHAZAR')),
  comentario    text,
  decidido_en   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (solicitud_id, director_id)
);

-- ---------------------------------------------------------------------------
-- Funciones de operación (única puerta de escritura)
-- ---------------------------------------------------------------------------

-- Verifica usuario, empresa de la transacción y permiso. Devuelve el usuario.
CREATE FUNCTION contabilidad_exigir(p_empresa uuid, p_permiso text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario uuid := app_usuario_id();
BEGIN
  IF v_usuario IS NULL OR p_empresa IS DISTINCT FROM app_empresa_id() OR NOT app_tiene_permiso(p_empresa, p_permiso) THEN
    RAISE EXCEPTION 'Sin permiso %', p_permiso USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_usuario;
END;
$$;

-- Registra un evento con la identidad declarada en la transacción.
CREATE FUNCTION contabilidad_auditar(p_accion text, p_entidad text, p_entidad_id text, p_datos jsonb, p_empresa uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tipo text := coalesce(nullif(current_setting('app.actor_tipo', true), ''), 'USUARIO');
  v_id   text := coalesce(nullif(current_setting('app.actor_id', true), ''), app_usuario_id()::text);
BEGIN
  PERFORM bitacora_registrar(v_tipo, v_id, p_accion, p_entidad, p_entidad_id, p_datos, p_empresa, app_usuario_id());
END;
$$;

CREATE FUNCTION contabilidad_crear_ejercicio(p_empresa uuid, p_anio int, p_fecha_inicio date DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario uuid := contabilidad_exigir(p_empresa, 'contabilidad.periodos.administrar');
  v_inicio  date := coalesce(p_fecha_inicio, make_date(p_anio, 1, 1));
  v_termino date := make_date(p_anio, 12, 31);
  v_id      uuid;
  v_mes     int;
BEGIN
  IF extract(year FROM v_inicio) <> p_anio THEN
    RAISE EXCEPTION 'La fecha de inicio debe pertenecer al año %', p_anio USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO ejercicios_contables (empresa_id, anio, fecha_inicio, fecha_termino)
  VALUES (p_empresa, p_anio, v_inicio, v_termino)
  RETURNING id INTO v_id;
  FOR v_mes IN extract(month FROM v_inicio)::int .. 12 LOOP
    INSERT INTO periodos_contables (empresa_id, ejercicio_id, anio, mes, fecha_inicio, fecha_termino)
    VALUES (
      p_empresa, v_id, p_anio, v_mes,
      greatest(make_date(p_anio, v_mes, 1), v_inicio),
      (make_date(p_anio, v_mes, 1) + interval '1 month - 1 day')::date
    );
  END LOOP;
  PERFORM contabilidad_auditar('ejercicio.creado', 'ejercicios_contables', v_id::text,
    jsonb_build_object('anio', p_anio, 'inicio', v_inicio), p_empresa);
  RETURN v_id;
END;
$$;

-- Registro de un asiento. p_lineas es un arreglo JSON de objetos:
--   {"cuenta": "1.1.01", "debe": 1000, "haber": 0, "tercero": "76123456-7", "centro_costo": "ADM", "glosa": "..."}
CREATE FUNCTION contabilidad_registrar_asiento(
  p_empresa     uuid,
  p_fecha       date,
  p_glosa       text,
  p_lineas      jsonb,
  p_tipo        text DEFAULT 'NORMAL',
  p_documento   text DEFAULT NULL,
  p_origen      text DEFAULT 'MANUAL',
  p_propuesta   uuid DEFAULT NULL,
  p_reversa_de  uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario   uuid := contabilidad_exigir(p_empresa, 'contabilidad.asientos.registrar');
  v_periodo   periodos_contables;
  v_ejercicio ejercicios_contables;
  v_cuenta    plan_cuentas;
  v_linea     jsonb;
  v_n         int := 0;
  v_debe      numeric;
  v_haber     numeric;
  v_total_d   numeric := 0;
  v_total_h   numeric := 0;
  v_tercero   uuid;
  v_cc        uuid;
  v_numero    int;
  v_id        uuid := gen_random_uuid();
  v_cuentas   uuid[] := '{}';
  v_debes     numeric[] := '{}';
  v_haberes   numeric[] := '{}';
  v_terceros  uuid[] := '{}';
  v_centros   uuid[] := '{}';
  v_glosas    text[] := '{}';
BEGIN
  IF p_tipo NOT IN ('NORMAL', 'APERTURA', 'AJUSTE', 'REVERSA') THEN
    RAISE EXCEPTION 'Tipo de asiento no permitido: %', p_tipo USING ERRCODE = 'check_violation';
  END IF;
  IF (p_tipo = 'REVERSA') <> (p_reversa_de IS NOT NULL) THEN
    RAISE EXCEPTION 'Las reversas se registran con contabilidad_reversar_asiento' USING ERRCODE = 'check_violation';
  END IF;
  IF p_origen NOT IN ('MANUAL', 'AGENTE', 'MODULO') THEN
    RAISE EXCEPTION 'Origen no permitido: %', p_origen USING ERRCODE = 'check_violation';
  END IF;
  IF p_glosa IS NULL OR length(trim(p_glosa)) = 0 THEN
    RAISE EXCEPTION 'El asiento necesita una glosa' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_lineas) <> 'array' OR jsonb_array_length(p_lineas) < 2 THEN
    RAISE EXCEPTION 'Un asiento necesita al menos dos líneas' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_array_length(p_lineas) > 500 THEN
    RAISE EXCEPTION 'Un asiento no puede tener más de 500 líneas' USING ERRCODE = 'check_violation';
  END IF;

  -- Bloqueos: el período en modo compartido (nadie lo cierra mientras se registra)
  -- y el ejercicio en modo exclusivo desde el inicio, porque su contador se
  -- actualiza: así los registros del mismo ejercicio se ordenan uno tras otro y
  -- nunca se bloquean mutuamente.
  SELECT * INTO v_periodo FROM periodos_contables
  WHERE empresa_id = p_empresa AND p_fecha BETWEEN fecha_inicio AND fecha_termino
  FOR SHARE;
  IF v_periodo.id IS NULL THEN
    RAISE EXCEPTION 'No existe un período contable para el %', p_fecha USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_ejercicio FROM ejercicios_contables WHERE id = v_periodo.ejercicio_id FOR UPDATE;
  IF NOT contabilidad_ejercicio_admite_movimientos(v_ejercicio) THEN
    RAISE EXCEPTION 'El ejercicio % está cerrado', v_ejercicio.anio USING ERRCODE = 'check_violation';
  END IF;
  IF v_periodo.estado <> 'ABIERTO' THEN
    RAISE EXCEPTION 'El período %-% está cerrado', v_periodo.anio, lpad(v_periodo.mes::text, 2, '0')
      USING ERRCODE = 'check_violation';
  END IF;

  -- 1) Validar todas las líneas y calcular totales ANTES de escribir nada.
  FOR v_linea IN SELECT * FROM jsonb_array_elements(p_lineas) LOOP
    v_n := v_n + 1;
    BEGIN
      v_debe  := coalesce((v_linea->>'debe')::numeric, 0);
      v_haber := coalesce((v_linea->>'haber')::numeric, 0);
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Línea %: monto inválido', v_n USING ERRCODE = 'check_violation';
    END;
    IF v_debe < 0 OR v_haber < 0 OR v_debe <> round(v_debe, 2) OR v_haber <> round(v_haber, 2)
       OR (v_debe > 0) = (v_haber > 0) THEN
      RAISE EXCEPTION 'Línea %: debe indicar un monto positivo en el debe o en el haber (no en ambos), con hasta 2 decimales', v_n
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO v_cuenta FROM plan_cuentas WHERE empresa_id = p_empresa AND codigo = v_linea->>'cuenta';
    IF v_cuenta.id IS NULL THEN
      RAISE EXCEPTION 'Línea %: la cuenta % no existe', v_n, v_linea->>'cuenta' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT v_cuenta.imputable OR NOT v_cuenta.activa THEN
      RAISE EXCEPTION 'Línea %: la cuenta % no es imputable o está inactiva', v_n, v_cuenta.codigo
        USING ERRCODE = 'check_violation';
    END IF;

    v_tercero := NULL;
    IF nullif(v_linea->>'tercero', '') IS NOT NULL THEN
      SELECT id INTO v_tercero FROM terceros
      WHERE empresa_id = p_empresa AND rut = upper(replace(v_linea->>'tercero', '.', '')) AND activo;
      IF v_tercero IS NULL THEN
        RAISE EXCEPTION 'Línea %: el tercero % no existe', v_n, v_linea->>'tercero' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF v_cuenta.requiere_tercero THEN
      RAISE EXCEPTION 'Línea %: la cuenta % exige indicar un tercero', v_n, v_cuenta.codigo USING ERRCODE = 'check_violation';
    END IF;

    v_cc := NULL;
    IF nullif(v_linea->>'centro_costo', '') IS NOT NULL THEN
      SELECT id INTO v_cc FROM centros_costo
      WHERE empresa_id = p_empresa AND codigo = upper(v_linea->>'centro_costo') AND activo;
      IF v_cc IS NULL THEN
        RAISE EXCEPTION 'Línea %: el centro de costo % no existe', v_n, v_linea->>'centro_costo' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF v_cuenta.requiere_centro_costo THEN
      RAISE EXCEPTION 'Línea %: la cuenta % exige un centro de costo', v_n, v_cuenta.codigo USING ERRCODE = 'check_violation';
    END IF;

    v_cuentas   := v_cuentas || v_cuenta.id;
    v_debes     := v_debes || v_debe;
    v_haberes   := v_haberes || v_haber;
    v_terceros  := v_terceros || v_tercero;
    v_centros   := v_centros || v_cc;
    v_glosas    := v_glosas || nullif(trim(v_linea->>'glosa'), '');
    v_total_d := v_total_d + v_debe;
    v_total_h := v_total_h + v_haber;
  END LOOP;

  IF v_total_d <> v_total_h THEN
    RAISE EXCEPTION 'Asiento descuadrado: debe %, haber %', v_total_d, v_total_h USING ERRCODE = 'check_violation';
  END IF;

  -- 2) Correlativo sin saltos: el contador se actualiza en la misma transacción.
  UPDATE ejercicios_contables SET ultimo_numero = ultimo_numero + 1
  WHERE id = v_ejercicio.id RETURNING ultimo_numero INTO v_numero;

  -- 3) Escribir el asiento con su total definitivo y sus líneas (nunca se modifican después).
  INSERT INTO asientos (id, empresa_id, ejercicio_id, periodo_id, numero, fecha, tipo, origen, glosa,
                        documento_referencia, reversa_de, propuesta_id, total, registrado_por)
  VALUES (v_id, p_empresa, v_ejercicio.id, v_periodo.id, v_numero, p_fecha, p_tipo, p_origen, trim(p_glosa),
          nullif(trim(p_documento), ''), p_reversa_de, p_propuesta, v_total_d, v_usuario);

  INSERT INTO asiento_lineas (asiento_id, empresa_id, linea, cuenta_id, debe, haber, tercero_id, centro_costo_id, glosa)
  SELECT v_id, p_empresa, l.n, l.cuenta, l.debe, l.haber, l.tercero, l.cc, l.glosa
  FROM unnest(v_cuentas, v_debes, v_haberes, v_terceros, v_centros, v_glosas)
       WITH ORDINALITY AS l(cuenta, debe, haber, tercero, cc, glosa, n);

  PERFORM contabilidad_auditar('asiento.registrado', 'asientos', v_id::text,
    jsonb_build_object('numero', v_numero, 'fecha', p_fecha, 'tipo', p_tipo, 'origen', p_origen,
                       'total', v_total_d, 'glosa', trim(p_glosa), 'lineas', p_lineas,
                       'reversa_de', p_reversa_de, 'propuesta', p_propuesta),
    p_empresa);
  RETURN v_id;
END;
$$;

-- Reversa: asiento espejo que anula al original. Un asiento se reversa una sola
-- vez (restricción única) y una reversa no se reversa: se registra un asiento nuevo.
CREATE FUNCTION contabilidad_reversar_asiento(p_asiento uuid, p_fecha date, p_motivo text)
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
  IF EXISTS (SELECT 1 FROM asientos WHERE reversa_de = p_asiento) THEN
    RAISE EXCEPTION 'El asiento N° % ya fue reversado', v_original.numero USING ERRCODE = 'check_violation';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 10 THEN
    RAISE EXCEPTION 'Indique el motivo de la reversa (al menos 10 caracteres)' USING ERRCODE = 'check_violation';
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

-- Cierre de un mes. Los meses se cierran en orden.
CREATE FUNCTION contabilidad_cerrar_periodo(p_periodo uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_periodo   periodos_contables;
  v_ejercicio ejercicios_contables;
  v_usuario   uuid;
BEGIN
  SELECT * INTO v_periodo FROM periodos_contables WHERE id = p_periodo FOR UPDATE;
  IF v_periodo.id IS NULL OR v_periodo.empresa_id IS DISTINCT FROM app_empresa_id() THEN
    RAISE EXCEPTION 'El período no existe' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_usuario := contabilidad_exigir(v_periodo.empresa_id, 'contabilidad.periodos.administrar');
  SELECT * INTO v_ejercicio FROM ejercicios_contables WHERE id = v_periodo.ejercicio_id;
  IF NOT contabilidad_ejercicio_admite_movimientos(v_ejercicio) THEN
    RAISE EXCEPTION 'El ejercicio % está cerrado', v_ejercicio.anio USING ERRCODE = 'check_violation';
  END IF;
  IF v_periodo.estado = 'CERRADO' THEN
    RAISE EXCEPTION 'El período ya está cerrado' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM periodos_contables
             WHERE ejercicio_id = v_periodo.ejercicio_id AND mes < v_periodo.mes AND estado = 'ABIERTO') THEN
    RAISE EXCEPTION 'Primero deben cerrarse los meses anteriores' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE periodos_contables SET estado = 'CERRADO', cerrado_en = now(), cerrado_por = v_usuario WHERE id = p_periodo;
  PERFORM contabilidad_auditar('periodo.cerrado', 'periodos_contables', p_periodo::text,
    jsonb_build_object('anio', v_periodo.anio, 'mes', v_periodo.mes), v_periodo.empresa_id);
END;
$$;

-- Reapertura de un mes: solo dentro de un ejercicio que admite movimientos, con motivo.
CREATE FUNCTION contabilidad_reabrir_periodo(p_periodo uuid, p_motivo text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_periodo   periodos_contables;
  v_ejercicio ejercicios_contables;
BEGIN
  SELECT * INTO v_periodo FROM periodos_contables WHERE id = p_periodo FOR UPDATE;
  IF v_periodo.id IS NULL OR v_periodo.empresa_id IS DISTINCT FROM app_empresa_id() THEN
    RAISE EXCEPTION 'El período no existe' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM contabilidad_exigir(v_periodo.empresa_id, 'contabilidad.periodos.administrar');
  SELECT * INTO v_ejercicio FROM ejercicios_contables WHERE id = v_periodo.ejercicio_id FOR SHARE;
  IF NOT contabilidad_ejercicio_admite_movimientos(v_ejercicio) THEN
    RAISE EXCEPTION 'El ejercicio % está cerrado: su reapertura requiere autorización del Directorio', v_ejercicio.anio
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_periodo.estado = 'ABIERTO' THEN
    RAISE EXCEPTION 'El período ya está abierto' USING ERRCODE = 'check_violation';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 10 THEN
    RAISE EXCEPTION 'Indique el motivo de la reapertura (al menos 10 caracteres)' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE periodos_contables SET estado = 'ABIERTO', cerrado_en = NULL, cerrado_por = NULL WHERE id = p_periodo;
  PERFORM contabilidad_auditar('periodo.reabierto', 'periodos_contables', p_periodo::text,
    jsonb_build_object('anio', v_periodo.anio, 'mes', v_periodo.mes, 'motivo', trim(p_motivo),
                       'cerrado_antes_por', v_periodo.cerrado_por, 'cerrado_antes_en', v_periodo.cerrado_en),
    v_periodo.empresa_id);
END;
$$;

-- Cierre del ejercicio: todos sus meses deben estar cerrados.
CREATE FUNCTION contabilidad_cerrar_ejercicio(p_ejercicio uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ejercicio ejercicios_contables;
  v_usuario   uuid;
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
  UPDATE ejercicios_contables
  SET estado = 'CERRADO', cerrado_en = now(), cerrado_por = v_usuario, reabierto_hasta = NULL
  WHERE id = p_ejercicio;
  PERFORM contabilidad_auditar('ejercicio.cerrado', 'ejercicios_contables', p_ejercicio::text,
    jsonb_build_object('anio', v_ejercicio.anio), v_ejercicio.empresa_id);
END;
$$;

-- Solicitud de reapertura de un ejercicio cerrado (la presenta quien puede cerrarlo).
CREATE FUNCTION contabilidad_solicitar_reapertura_ejercicio(
  p_ejercicio uuid, p_motivo text, p_acta text, p_plazo_dias int
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ejercicio ejercicios_contables;
  v_usuario   uuid;
  v_id        uuid;
BEGIN
  SELECT * INTO v_ejercicio FROM ejercicios_contables WHERE id = p_ejercicio FOR UPDATE;
  IF v_ejercicio.id IS NULL OR v_ejercicio.empresa_id IS DISTINCT FROM app_empresa_id() THEN
    RAISE EXCEPTION 'El ejercicio no existe' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_usuario := contabilidad_exigir(v_ejercicio.empresa_id, 'contabilidad.ejercicio.cerrar');
  IF v_ejercicio.estado <> 'CERRADO' OR contabilidad_ejercicio_admite_movimientos(v_ejercicio) THEN
    RAISE EXCEPTION 'Solo se solicita la reapertura de un ejercicio cerrado' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO solicitudes_reapertura_ejercicio (empresa_id, ejercicio_id, motivo, acta_referencia, plazo_dias, solicitado_por)
  VALUES (v_ejercicio.empresa_id, p_ejercicio, trim(p_motivo), trim(p_acta), p_plazo_dias, v_usuario)
  RETURNING id INTO v_id;
  PERFORM contabilidad_auditar('ejercicio.reapertura_solicitada', 'solicitudes_reapertura_ejercicio', v_id::text,
    jsonb_build_object('anio', v_ejercicio.anio, 'motivo', trim(p_motivo), 'acta', trim(p_acta), 'plazo_dias', p_plazo_dias),
    v_ejercicio.empresa_id);
  RETURN v_id;
END;
$$;

-- Decisión de un director. Con dos aprobaciones de directores distintos (y distintos
-- de quien solicitó), el ejercicio queda reabierto por el plazo indicado.
-- Un solo rechazo cierra la solicitud.
CREATE FUNCTION contabilidad_resolver_reapertura_ejercicio(p_solicitud uuid, p_decision text, p_comentario text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_sol        solicitudes_reapertura_ejercicio;
  v_usuario    uuid;
  v_aprobadas  int;
  v_requeridas constant int := 2;
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
    RETURN 'VENCIDA';
  END IF;
  IF v_usuario = v_sol.solicitado_por THEN
    RAISE EXCEPTION 'Quien solicita la reapertura no puede autorizarla' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- La clave primaria impide que un mismo director vote dos veces.
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

  UPDATE solicitudes_reapertura_ejercicio SET estado = 'APROBADA', resuelta_en = now() WHERE id = p_solicitud;
  UPDATE ejercicios_contables SET reabierto_hasta = current_date + v_sol.plazo_dias WHERE id = v_sol.ejercicio_id;
  PERFORM contabilidad_auditar('ejercicio.reabierto', 'ejercicios_contables', v_sol.ejercicio_id::text,
    jsonb_build_object('solicitud', p_solicitud, 'acta', v_sol.acta_referencia,
                       'vigente_hasta', current_date + v_sol.plazo_dias, 'aprobaciones', v_aprobadas),
    v_sol.empresa_id);
  RETURN 'APROBADA';
END;
$$;

-- ---------------------------------------------------------------------------
-- Lectura (seguridad por fila) y permisos de ejecución
-- ---------------------------------------------------------------------------
ALTER TABLE ejercicios_contables ENABLE ROW LEVEL SECURITY;
ALTER TABLE periodos_contables ENABLE ROW LEVEL SECURITY;
ALTER TABLE asientos ENABLE ROW LEVEL SECURITY;
ALTER TABLE asiento_lineas ENABLE ROW LEVEL SECURITY;
ALTER TABLE solicitudes_reapertura_ejercicio ENABLE ROW LEVEL SECURITY;
ALTER TABLE aprobaciones_reapertura_ejercicio ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON ejercicios_contables, periodos_contables, asientos, asiento_lineas,
  solicitudes_reapertura_ejercicio, aprobaciones_reapertura_ejercicio TO erp_app;

CREATE POLICY ejercicios_ver ON ejercicios_contables FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id));
CREATE POLICY periodos_ver ON periodos_contables FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id));
CREATE POLICY asientos_ver ON asientos FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'contabilidad.asientos.ver'));
CREATE POLICY asiento_lineas_ver ON asiento_lineas FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'contabilidad.asientos.ver'));
CREATE POLICY solicitudes_reapertura_ver ON solicitudes_reapertura_ejercicio FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id)
         AND (app_tiene_permiso(empresa_id, 'contabilidad.ejercicio.cerrar')
              OR app_tiene_permiso(empresa_id, 'contabilidad.ejercicio.autorizar_reapertura')));
CREATE POLICY aprobaciones_reapertura_ver ON aprobaciones_reapertura_ejercicio FOR SELECT TO erp_app
  USING (EXISTS (SELECT 1 FROM solicitudes_reapertura_ejercicio s WHERE s.id = solicitud_id));

REVOKE EXECUTE ON FUNCTION contabilidad_rechazar_cambios(), contabilidad_verificar_cuadratura(),
  contabilidad_auditar(text, text, text, jsonb, uuid), contabilidad_exigir(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  contabilidad_ejercicio_admite_movimientos(ejercicios_contables),
  contabilidad_crear_ejercicio(uuid, int, date),
  contabilidad_registrar_asiento(uuid, date, text, jsonb, text, text, text, uuid, uuid),
  contabilidad_reversar_asiento(uuid, date, text),
  contabilidad_cerrar_periodo(uuid),
  contabilidad_reabrir_periodo(uuid, text),
  contabilidad_cerrar_ejercicio(uuid),
  contabilidad_solicitar_reapertura_ejercicio(uuid, text, text, int),
  contabilidad_resolver_reapertura_ejercicio(uuid, text, text)
TO erp_app;
