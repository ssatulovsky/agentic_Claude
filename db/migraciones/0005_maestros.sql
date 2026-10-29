-- =============================================================================
-- 0005 · Maestros por empresa: plan de cuentas, terceros y centros de costo
-- =============================================================================
-- Reglas:
--   * Cada fila pertenece a una empresa y solo la ve quien tiene acceso y permiso.
--   * Los maestros no se borran: se desactivan (activa/activo = false).
--   * Todo cambio queda en la bitácora mediante un trigger, sin depender de que
--     la aplicación se acuerde de registrarlo.
-- =============================================================================

-- ¿El usuario de la transacción tiene este permiso en esta empresa?
CREATE FUNCTION app_tiene_permiso(p_empresa uuid, p_permiso text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_empresa = app_empresa_id()
     AND EXISTS (SELECT 1 FROM app_permisos_en_empresa(p_empresa) p WHERE p = p_permiso)
$$;
REVOKE EXECUTE ON FUNCTION app_tiene_permiso(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_tiene_permiso(uuid, text) TO erp_app;

-- Auditoría automática: registra antes y después de cada cambio.
CREATE FUNCTION auditar_cambio() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor_tipo text := coalesce(nullif(current_setting('app.actor_tipo', true), ''), 'SISTEMA');
  v_actor_id   text := coalesce(nullif(current_setting('app.actor_id', true), ''), session_user);
  v_en_nombre  uuid := CASE WHEN v_actor_tipo = 'AGENTE' THEN app_usuario_id() END;
BEGIN
  PERFORM bitacora_registrar(
    v_actor_tipo,
    v_actor_id,
    lower(TG_OP),
    TG_TABLE_NAME,
    NEW.id::text,
    jsonb_build_object(
      'antes',   CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END,
      'despues', to_jsonb(NEW)
    ),
    NEW.empresa_id,
    v_en_nombre
  );
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION auditar_cambio() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auditar_cambio() TO erp_app;

-- ---------------------------------------------------------------------------
-- Plan de cuentas
-- ---------------------------------------------------------------------------
CREATE TABLE plan_cuentas (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id             uuid NOT NULL REFERENCES empresas(id),
  codigo                 text NOT NULL CHECK (codigo ~ '^[0-9]+(\.[0-9]+)*$'),
  nombre                 text NOT NULL CHECK (length(trim(nombre)) > 0),
  clasificacion          text NOT NULL CHECK (clasificacion IN ('ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'GASTO', 'ORDEN')),
  naturaleza             text NOT NULL CHECK (naturaleza IN ('DEUDORA', 'ACREEDORA')),
  imputable              boolean NOT NULL,
  padre_id               uuid REFERENCES plan_cuentas(id),
  requiere_tercero       boolean NOT NULL DEFAULT false,
  requiere_centro_costo  boolean NOT NULL DEFAULT false,
  activa                 boolean NOT NULL DEFAULT true,
  creado_en              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, codigo)
);

-- La cuenta padre debe ser de la misma empresa y no imputable.
CREATE FUNCTION validar_cuenta_padre() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_padre plan_cuentas;
BEGIN
  IF NEW.padre_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_padre FROM plan_cuentas WHERE id = NEW.padre_id;
  IF v_padre.id IS NULL OR v_padre.empresa_id <> NEW.empresa_id THEN
    RAISE EXCEPTION 'La cuenta padre no existe en esta empresa' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_padre.imputable THEN
    RAISE EXCEPTION 'La cuenta padre % es imputable; solo una cuenta de agrupación puede tener hijas', v_padre.codigo
      USING ERRCODE = 'check_violation';
  END IF;
  -- Ni ella misma ni ninguno de sus ancestros puede ser la cuenta modificada (evita ciclos).
  IF EXISTS (
    WITH RECURSIVE ancestros(id, padre_id) AS (
      SELECT id, padre_id FROM plan_cuentas WHERE id = NEW.padre_id
      UNION
      SELECT p.id, p.padre_id FROM plan_cuentas p JOIN ancestros a ON p.id = a.padre_id
    )
    SELECT 1 FROM ancestros WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'La jerarquía de cuentas no puede tener ciclos' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER plan_cuentas_padre BEFORE INSERT OR UPDATE ON plan_cuentas
  FOR EACH ROW EXECUTE FUNCTION validar_cuenta_padre();
CREATE TRIGGER plan_cuentas_auditoria AFTER INSERT OR UPDATE ON plan_cuentas
  FOR EACH ROW EXECUTE FUNCTION auditar_cambio();

ALTER TABLE plan_cuentas ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON plan_cuentas TO erp_app;
GRANT UPDATE (nombre, padre_id, requiere_tercero, requiere_centro_costo, activa) ON plan_cuentas TO erp_app;
CREATE POLICY plan_cuentas_ver ON plan_cuentas FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'contabilidad.plan_cuentas.ver'));
CREATE POLICY plan_cuentas_crear ON plan_cuentas FOR INSERT TO erp_app
  WITH CHECK (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'contabilidad.plan_cuentas.editar'));
CREATE POLICY plan_cuentas_modificar ON plan_cuentas FOR UPDATE TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'contabilidad.plan_cuentas.editar'))
  WITH CHECK (app_fila_visible(empresa_id));

-- ---------------------------------------------------------------------------
-- Terceros (clientes, proveedores, trabajadores, prestadores a honorarios)
-- ---------------------------------------------------------------------------
CREATE TABLE terceros (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid NOT NULL REFERENCES empresas(id),
  rut            text NOT NULL CHECK (rut_es_valido(rut)),
  razon_social   text NOT NULL CHECK (length(trim(razon_social)) > 0),
  es_cliente     boolean NOT NULL DEFAULT false,
  es_proveedor   boolean NOT NULL DEFAULT false,
  es_trabajador  boolean NOT NULL DEFAULT false,
  es_honorarios  boolean NOT NULL DEFAULT false,
  email          text,
  telefono       text,
  activo         boolean NOT NULL DEFAULT true,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, rut)
);

CREATE TRIGGER terceros_auditoria AFTER INSERT OR UPDATE ON terceros
  FOR EACH ROW EXECUTE FUNCTION auditar_cambio();

ALTER TABLE terceros ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON terceros TO erp_app;
GRANT UPDATE (razon_social, es_cliente, es_proveedor, es_trabajador, es_honorarios, email, telefono, activo)
  ON terceros TO erp_app;
CREATE POLICY terceros_ver ON terceros FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'maestros.terceros.ver'));
CREATE POLICY terceros_crear ON terceros FOR INSERT TO erp_app
  WITH CHECK (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'maestros.terceros.editar'));
CREATE POLICY terceros_modificar ON terceros FOR UPDATE TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'maestros.terceros.editar'))
  WITH CHECK (app_fila_visible(empresa_id));

-- ---------------------------------------------------------------------------
-- Centros de costo
-- ---------------------------------------------------------------------------
CREATE TABLE centros_costo (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES empresas(id),
  codigo      text NOT NULL CHECK (codigo ~ '^[A-Z0-9_-]{1,20}$'),
  nombre      text NOT NULL CHECK (length(trim(nombre)) > 0),
  activo      boolean NOT NULL DEFAULT true,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, codigo)
);

CREATE TRIGGER centros_costo_auditoria AFTER INSERT OR UPDATE ON centros_costo
  FOR EACH ROW EXECUTE FUNCTION auditar_cambio();

ALTER TABLE centros_costo ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON centros_costo TO erp_app;
GRANT UPDATE (nombre, activo) ON centros_costo TO erp_app;
CREATE POLICY centros_costo_ver ON centros_costo FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'maestros.centros_costo.ver'));
CREATE POLICY centros_costo_crear ON centros_costo FOR INSERT TO erp_app
  WITH CHECK (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'maestros.centros_costo.editar'));
CREATE POLICY centros_costo_modificar ON centros_costo FOR UPDATE TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'maestros.centros_costo.editar'))
  WITH CHECK (app_fila_visible(empresa_id));
