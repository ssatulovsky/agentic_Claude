-- =============================================================================
-- 0017 · Capa de IA: modelos, precios, políticas por nivel, cupos y uso por cliente
-- =============================================================================
-- Decisiones de la gerencia:
--   * Cada agente tiene una configuración de IA por niveles: modelos locales (Ollama)
--     cuando conviene para la tarea, la nube como respaldo, o directamente Gemini o Claude.
--   * Reporte de tokens y costo por cliente; el precio por módulo incluye un tramo de IA.
-- Reglas:
--   * Política = cadena ordenada de modelos (el primero responde; si falla, el siguiente).
--     Se resuelve del nivel más específico al más general: empresa + agente, empresa,
--     Cliente ERP + agente, Cliente ERP, plataforma + agente, plataforma.
--   * Los precios son datos con vigencia y fuente (como la normativa). Sin precio cargado
--     el costo no se supone: el uso queda registrado y el reporte lo marca.
--   * Cada llamada a un modelo queda registrada (tokens, costo, latencia, éxito o error).
--   * Cupo mensual incluido por Cliente ERP; al agotarse, según la regla del cupo, se
--     sigue (y se informa) o se usan solo modelos locales.
-- =============================================================================

-- Dólar observado, para expresar en pesos los costos que los proveedores cobran en dólares.
ALTER TABLE indicadores_economicos DROP CONSTRAINT indicadores_economicos_tipo_check;
ALTER TABLE indicadores_economicos ADD CONSTRAINT indicadores_economicos_tipo_check CHECK (tipo IN ('UF', 'UTM', 'UTA', 'DOLAR'));
-- La UF y el dólar son diarios; UTM y UTA, mensuales.
ALTER TABLE indicadores_economicos DROP CONSTRAINT indicadores_economicos_check;
ALTER TABLE indicadores_economicos ADD CONSTRAINT indicadores_economicos_check CHECK (tipo IN ('UF', 'DOLAR') OR extract(day FROM fecha) = 1);

INSERT INTO permisos (codigo, descripcion) VALUES
  ('ia.uso.ver',          'Ver el consumo de IA (tokens y costo) del Cliente ERP y sus empresas'),
  ('ia.politicas.editar', 'Configurar qué modelos de IA usa cada agente');
INSERT INTO rol_permisos (rol_codigo, permiso_codigo) VALUES
  ('ADMIN_CLIENTE_ERP', 'ia.uso.ver'),
  ('ADMIN_CLIENTE_ERP', 'ia.politicas.editar'),
  ('GERENTE_GENERAL',   'ia.uso.ver');

-- ---------------------------------------------------------------------------
-- Catálogo de modelos y precios (los administra la plataforma)
-- ---------------------------------------------------------------------------
CREATE TABLE modelos_ia (
  codigo       text PRIMARY KEY CHECK (codigo ~ '^[a-z0-9][a-z0-9.:_-]{1,60}$'),
  proveedor    text NOT NULL CHECK (proveedor IN ('ANTHROPIC', 'GEMINI', 'OLLAMA')),
  -- Nombre del modelo en la API del proveedor. Para OLLAMA, NULL = el que indique OLLAMA_MODELO.
  nombre_api   text,
  local        boolean NOT NULL,
  descripcion  text NOT NULL,
  activo       boolean NOT NULL DEFAULT true,
  CHECK (local = (proveedor = 'OLLAMA')),
  CHECK (proveedor = 'OLLAMA' OR nombre_api IS NOT NULL)
);

INSERT INTO modelos_ia (codigo, proveedor, nombre_api, local, descripcion) VALUES
  ('ollama-local',      'OLLAMA',    NULL,                true,  'Modelo local en el servidor (Ollama): sin costo por token y los datos no salen del servidor.'),
  ('claude-haiku-5-5',  'ANTHROPIC', 'claude-haiku-5-5',  false, 'Claude Haiku 5.5: rápido y económico, para consultas simples.'),
  ('claude-sonnet-5-5', 'ANTHROPIC', 'claude-sonnet-5-5', false, 'Claude Sonnet 5.5: equilibrio entre calidad y costo, para análisis contable y tributario.'),
  ('claude-opus-5-5',   'ANTHROPIC', 'claude-opus-5-5',   false, 'Claude Opus 5.5: para los casos más complejos.');

CREATE TABLE precios_modelos_ia (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  modelo                   text NOT NULL REFERENCES modelos_ia(codigo),
  vigente_desde            date NOT NULL,
  vigente_hasta            date,
  usd_por_millon_entrada   numeric(12, 4) NOT NULL CHECK (usd_por_millon_entrada >= 0),
  usd_por_millon_salida    numeric(12, 4) NOT NULL CHECK (usd_por_millon_salida >= 0),
  fuente                   text NOT NULL,
  url_fuente               text NOT NULL CHECK (url_fuente ~ '^https://'),
  cargado_en               timestamptz NOT NULL DEFAULT now(),
  CHECK (vigente_hasta IS NULL OR vigente_hasta > vigente_desde),
  EXCLUDE USING gist (modelo WITH =, daterange(vigente_desde, vigente_hasta, '[)') WITH &&)
);
-- El modelo local no tiene costo por token (el costo del servidor se mide aparte).
INSERT INTO precios_modelos_ia (modelo, vigente_desde, usd_por_millon_entrada, usd_por_millon_salida, fuente, url_fuente)
VALUES ('ollama-local', '2020-01-01', 0, 0, 'Modelo local: sin cobro por token', 'https://ollama.com/');

-- ---------------------------------------------------------------------------
-- Políticas por nivel
-- ---------------------------------------------------------------------------
CREATE TABLE politicas_ia (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nivel           text NOT NULL CHECK (nivel IN ('PLATAFORMA', 'CLIENTE_ERP', 'EMPRESA')),
  cliente_erp_id  uuid REFERENCES clientes_erp(id),
  empresa_id      uuid REFERENCES empresas(id),
  -- NULL = todos los agentes.
  agente_codigo   text CHECK (agente_codigo IS NULL OR agente_codigo ~ '^[A-Z_]+$'),
  cadena          text[] NOT NULL CHECK (cardinality(cadena) BETWEEN 1 AND 5),
  estado          text NOT NULL DEFAULT 'VIGENTE' CHECK (estado IN ('VIGENTE', 'REEMPLAZADA')),
  motivo          text NOT NULL CHECK (length(trim(motivo)) >= 5),
  registrado_por  uuid REFERENCES usuarios(id),
  registrado_en   timestamptz NOT NULL DEFAULT now(),
  CHECK ((nivel = 'PLATAFORMA') = (cliente_erp_id IS NULL AND empresa_id IS NULL)),
  CHECK (nivel <> 'CLIENTE_ERP' OR (cliente_erp_id IS NOT NULL AND empresa_id IS NULL)),
  CHECK (nivel <> 'EMPRESA' OR (cliente_erp_id IS NOT NULL AND empresa_id IS NOT NULL)),
  CHECK (nivel = 'PLATAFORMA' OR registrado_por IS NOT NULL)
);
CREATE UNIQUE INDEX politicas_ia_vigente_uq ON politicas_ia
  (nivel, coalesce(cliente_erp_id::text, ''), coalesce(empresa_id::text, ''), coalesce(agente_codigo, ''))
  WHERE estado = 'VIGENTE';

CREATE FUNCTION politica_ia_validar() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Las políticas de IA no se borran: se reemplazan' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.estado <> 'VIGENTE' OR NEW.estado <> 'REEMPLAZADA'
     OR (to_jsonb(NEW) - 'estado') IS DISTINCT FROM (to_jsonb(OLD) - 'estado')) THEN
    RAISE EXCEPTION 'Una política de IA solo se reemplaza' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM unnest(NEW.cadena) m WHERE NOT EXISTS (SELECT 1 FROM modelos_ia x WHERE x.codigo = m AND x.activo)) THEN
      RAISE EXCEPTION 'La cadena tiene modelos inexistentes o inactivos' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT count(DISTINCT m) FROM unnest(NEW.cadena) m) <> cardinality(NEW.cadena) THEN
      RAISE EXCEPTION 'La cadena repite modelos' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.empresa_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM empresas e WHERE e.id = NEW.empresa_id AND e.cliente_erp_id = NEW.cliente_erp_id) THEN
      RAISE EXCEPTION 'La empresa no pertenece al Cliente ERP' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER politicas_ia_validar BEFORE INSERT OR UPDATE OR DELETE ON politicas_ia
  FOR EACH ROW EXECUTE FUNCTION politica_ia_validar();

-- Políticas de la plataforma: local primero donde la tarea es simple (consultas y
-- tesorería), la nube para el análisis contable y tributario.
INSERT INTO politicas_ia (nivel, agente_codigo, cadena, motivo) VALUES
  ('PLATAFORMA', NULL,                  '{claude-sonnet-5-5,claude-haiku-5-5}', 'Política general de la plataforma'),
  ('PLATAFORMA', 'GERENTE_VIRTUAL',     '{ollama-local,claude-haiku-5-5}',      'Consultas y derivación: local primero, Haiku de respaldo'),
  ('PLATAFORMA', 'TESORERO',            '{ollama-local,claude-haiku-5-5}',      'Conciliación con reglas: local primero, Haiku de respaldo'),
  ('PLATAFORMA', 'CONTADOR_GENERAL',    '{claude-sonnet-5-5,claude-haiku-5-5}', 'Asientos y análisis contable: Sonnet, Haiku de respaldo'),
  ('PLATAFORMA', 'ANALISTA_TRIBUTARIO', '{claude-sonnet-5-5,claude-opus-5-5}',  'F29 y RCV: Sonnet, Opus de respaldo');

-- Política vigente para una empresa y un agente, del nivel más específico al más general.
CREATE FUNCTION ia_politica_vigente(p_empresa uuid, p_agente text)
RETURNS TABLE (politica_id bigint, nivel text, agente_codigo text, cadena text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id, p.nivel, p.agente_codigo, p.cadena
  FROM politicas_ia p
  JOIN empresas e ON e.id = p_empresa
  WHERE p.estado = 'VIGENTE'
    AND (p.agente_codigo IS NULL OR p.agente_codigo = p_agente)
    AND (p.nivel = 'PLATAFORMA'
         OR (p.nivel = 'CLIENTE_ERP' AND p.cliente_erp_id = e.cliente_erp_id)
         OR (p.nivel = 'EMPRESA' AND p.empresa_id = p_empresa))
    AND app_tiene_acceso_empresa(p_empresa)
  ORDER BY CASE p.nivel WHEN 'EMPRESA' THEN 0 WHEN 'CLIENTE_ERP' THEN 1 ELSE 2 END,
           (p.agente_codigo IS NULL)
  LIMIT 1
$$;

-- Configura la política de un Cliente ERP o de una empresa (todos los agentes o uno).
CREATE FUNCTION ia_configurar_politica(p_empresa uuid, p_agente text, p_cadena text[], p_motivo text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_cliente uuid := app_cliente_erp_id();
  v_nivel text := CASE WHEN p_empresa IS NULL THEN 'CLIENTE_ERP' ELSE 'EMPRESA' END;
  v_id bigint;
BEGIN
  IF app_usuario_id() IS NULL OR NOT app_tiene_permiso_cliente('ia.politicas.editar') THEN
    RAISE EXCEPTION 'Sin permiso ia.politicas.editar' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF tributario_es_agente() THEN
    RAISE EXCEPTION 'La política de IA la configura una persona' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_empresa IS NOT NULL AND NOT EXISTS (SELECT 1 FROM empresas WHERE id = p_empresa AND cliente_erp_id = v_cliente) THEN
    RAISE EXCEPTION 'Empresa no encontrada' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('politica-ia:' || v_cliente::text, 0));
  UPDATE politicas_ia SET estado = 'REEMPLAZADA'
  WHERE estado = 'VIGENTE' AND nivel = v_nivel AND cliente_erp_id = v_cliente
    AND empresa_id IS NOT DISTINCT FROM p_empresa AND agente_codigo IS NOT DISTINCT FROM p_agente;
  INSERT INTO politicas_ia (nivel, cliente_erp_id, empresa_id, agente_codigo, cadena, motivo, registrado_por)
  VALUES (v_nivel, v_cliente, p_empresa, p_agente, p_cadena, trim(p_motivo), app_usuario_id())
  RETURNING id INTO v_id;
  PERFORM bitacora_registrar('USUARIO', app_usuario_id()::text, 'POLITICA_IA_CONFIGURADA', 'politicas_ia', v_id::text,
    jsonb_build_object('nivel', v_nivel, 'empresa', p_empresa, 'agente', p_agente, 'cadena', p_cadena, 'motivo', p_motivo),
    p_empresa, app_usuario_id());
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Cupos incluidos (los fija la plataforma según el plan contratado)
-- ---------------------------------------------------------------------------
CREATE TABLE cupos_ia (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cliente_erp_id     uuid NOT NULL REFERENCES clientes_erp(id),
  vigente_desde      date NOT NULL CHECK (extract(day FROM vigente_desde) = 1),
  usd_mensual        numeric(12, 2) NOT NULL CHECK (usd_mensual >= 0),
  al_exceder         text NOT NULL CHECK (al_exceder IN ('CONTINUAR', 'SOLO_LOCAL')),
  UNIQUE (cliente_erp_id, vigente_desde)
);

-- ---------------------------------------------------------------------------
-- Uso
-- ---------------------------------------------------------------------------
CREATE TABLE uso_ia (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cliente_erp_id    uuid NOT NULL REFERENCES clientes_erp(id),
  empresa_id        uuid NOT NULL REFERENCES empresas(id),
  usuario_id        uuid NOT NULL REFERENCES usuarios(id),
  agente_codigo     text NOT NULL,
  conversacion_id   uuid,
  modelo            text NOT NULL REFERENCES modelos_ia(codigo),
  politica_id       bigint REFERENCES politicas_ia(id),
  tokens_entrada    int NOT NULL CHECK (tokens_entrada >= 0),
  tokens_salida     int NOT NULL CHECK (tokens_salida >= 0),
  -- NULL si no había precio vigente: el costo no se supone.
  costo_usd         numeric(14, 6),
  exito             boolean NOT NULL,
  error             text,
  latencia_ms       int NOT NULL CHECK (latencia_ms >= 0),
  creado_en         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uso_ia_cliente_fecha_idx ON uso_ia (cliente_erp_id, creado_en);
CREATE TRIGGER uso_ia_inmutable BEFORE UPDATE OR DELETE ON uso_ia
  FOR EACH ROW EXECUTE FUNCTION tributario_rechazar_cambios();

CREATE FUNCTION ia_registrar_uso(p_empresa uuid, p_agente text, p_conversacion uuid, p_modelo text, p_politica bigint,
  p_tokens_entrada int, p_tokens_salida int, p_exito boolean, p_error text, p_latencia_ms int)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_cliente uuid;
  v_precio precios_modelos_ia;
  v_id bigint;
BEGIN
  IF app_usuario_id() IS NULL OR p_empresa IS DISTINCT FROM app_empresa_id() OR NOT app_tiene_acceso_empresa(p_empresa) THEN
    RAISE EXCEPTION 'Sin acceso a la empresa' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT cliente_erp_id INTO v_cliente FROM empresas WHERE id = p_empresa;
  SELECT * INTO v_precio FROM precios_modelos_ia
  WHERE modelo = p_modelo AND daterange(vigente_desde, vigente_hasta, '[)') @> contabilidad_hoy();
  INSERT INTO uso_ia (cliente_erp_id, empresa_id, usuario_id, agente_codigo, conversacion_id, modelo, politica_id,
    tokens_entrada, tokens_salida, costo_usd, exito, error, latencia_ms)
  VALUES (v_cliente, p_empresa, app_usuario_id(), p_agente, p_conversacion, p_modelo, p_politica,
    greatest(coalesce(p_tokens_entrada, 0), 0), greatest(coalesce(p_tokens_salida, 0), 0),
    CASE WHEN v_precio.id IS NOT NULL THEN
      (greatest(coalesce(p_tokens_entrada, 0), 0) * v_precio.usd_por_millon_entrada
       + greatest(coalesce(p_tokens_salida, 0), 0) * v_precio.usd_por_millon_salida) / 1000000 END,
    coalesce(p_exito, false), left(p_error, 300), greatest(coalesce(p_latencia_ms, 0), 0))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Consumo del mes en curso del Cliente ERP frente a su cupo.
CREATE FUNCTION ia_estado_cupo(p_empresa uuid)
RETURNS TABLE (usd_mensual numeric, al_exceder text, usado_usd numeric, excedido boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH e AS (SELECT cliente_erp_id FROM empresas WHERE id = p_empresa AND app_tiene_acceso_empresa(p_empresa)),
  c AS (
    SELECT k.* FROM cupos_ia k, e
    WHERE k.cliente_erp_id = e.cliente_erp_id AND k.vigente_desde <= contabilidad_hoy()
    ORDER BY k.vigente_desde DESC LIMIT 1
  ),
  u AS (
    SELECT coalesce(sum(x.costo_usd), 0) AS usado FROM uso_ia x, e
    WHERE x.cliente_erp_id = e.cliente_erp_id
      AND x.creado_en >= (date_trunc('month', contabilidad_hoy()::timestamp) AT TIME ZONE 'America/Santiago')
  )
  SELECT c.usd_mensual, c.al_exceder, u.usado, u.usado >= c.usd_mensual FROM c, u
$$;

-- ---------------------------------------------------------------------------
-- Lectura y permisos
-- ---------------------------------------------------------------------------
ALTER TABLE uso_ia ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicas_ia ENABLE ROW LEVEL SECURITY;
ALTER TABLE cupos_ia ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON modelos_ia, precios_modelos_ia, uso_ia, politicas_ia, cupos_ia TO erp_app;

-- El uso lo ve quien tiene ia.uso.ver en el Cliente ERP (todas sus empresas), o la persona
-- con ese permiso en la empresa.
CREATE POLICY uso_ia_ver ON uso_ia FOR SELECT TO erp_app
  USING (cliente_erp_id = app_cliente_erp_id()
         AND (app_tiene_permiso_cliente('ia.uso.ver')
              OR (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'ia.uso.ver'))));
CREATE POLICY politicas_ia_ver ON politicas_ia FOR SELECT TO erp_app
  USING (nivel = 'PLATAFORMA' OR cliente_erp_id = app_cliente_erp_id());
CREATE POLICY cupos_ia_ver ON cupos_ia FOR SELECT TO erp_app
  USING (cliente_erp_id = app_cliente_erp_id() AND app_tiene_permiso_cliente('ia.uso.ver'));

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  ia_politica_vigente(uuid, text),
  ia_configurar_politica(uuid, text, text[], text),
  ia_registrar_uso(uuid, text, uuid, text, bigint, int, int, boolean, text, int),
  ia_estado_cupo(uuid)
TO erp_app;
