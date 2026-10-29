-- =============================================================================
-- 0002 · Roles de negocio, permisos, aislamiento por empresa (RLS) y autenticación
-- =============================================================================
-- Regla central: la aplicación corre con el rol erp_app, que no es dueño de las
-- tablas y no puede saltarse la seguridad por fila. En cada transacción la
-- aplicación declara quién es el usuario (app.usuario_id) y en qué empresa
-- trabaja (app.empresa_id). Las políticas verifican, además, que ese usuario
-- tenga realmente acceso a esa empresa: declarar otra empresa no sirve de nada.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Catálogo de permisos y roles
-- ---------------------------------------------------------------------------
INSERT INTO permisos (codigo, descripcion) VALUES
  ('empresas.ver',                      'Ver datos generales de la empresa'),
  ('empresas.administrar',              'Crear empresas y administrar suscripciones de módulos'),
  ('usuarios.ver',                      'Ver usuarios del Cliente ERP'),
  ('usuarios.administrar',              'Crear usuarios y asignar roles'),
  ('contabilidad.plan_cuentas.ver',     'Ver el plan de cuentas'),
  ('contabilidad.plan_cuentas.editar',  'Crear y modificar cuentas contables'),
  ('maestros.terceros.ver',             'Ver clientes, proveedores y otros terceros'),
  ('maestros.terceros.editar',          'Crear y modificar terceros'),
  ('maestros.centros_costo.ver',        'Ver centros de costo'),
  ('maestros.centros_costo.editar',     'Crear y modificar centros de costo'),
  ('normativa.ver',                     'Ver parámetros legales e indicadores'),
  ('bitacora.ver',                      'Ver la bitácora de auditoría de la empresa'),
  ('agentes.consultar',                 'Hacer consultas a los agentes'),
  ('agentes.aprobar',                   'Aprobar o rechazar acciones propuestas por los agentes'),
  ('tesoreria.saldos.ver',              'Ver saldos bancarios'),
  ('remuneraciones.ver_individual',     'Ver remuneraciones individuales de otras personas');

INSERT INTO roles (codigo, nombre, descripcion) VALUES
  ('ADMIN_CLIENTE_ERP', 'Administrador del Cliente ERP', 'Administra empresas, usuarios y suscripciones'),
  ('CONTADOR',          'Contador',                      'Gestiona contabilidad y maestros de las empresas asignadas'),
  ('GERENTE_GENERAL',   'Gerente General',               'Ve la empresa completa en forma consolidada'),
  ('GERENTE_AREA',      'Gerente de área',               'Ve su área en detalle y los indicadores generales'),
  ('JEFATURA',          'Jefatura',                      'Ve la información de su equipo'),
  ('COLABORADOR',       'Colaborador',                   'Ve solo sus propios datos'),
  ('AUDITOR',           'Auditor',                       'Lectura de libros, maestros y bitácora');

INSERT INTO rol_permisos (rol_codigo, permiso_codigo)
SELECT 'ADMIN_CLIENTE_ERP', codigo FROM permisos;

INSERT INTO rol_permisos (rol_codigo, permiso_codigo) VALUES
  ('CONTADOR', 'empresas.ver'),
  ('CONTADOR', 'contabilidad.plan_cuentas.ver'),
  ('CONTADOR', 'contabilidad.plan_cuentas.editar'),
  ('CONTADOR', 'maestros.terceros.ver'),
  ('CONTADOR', 'maestros.terceros.editar'),
  ('CONTADOR', 'maestros.centros_costo.ver'),
  ('CONTADOR', 'maestros.centros_costo.editar'),
  ('CONTADOR', 'normativa.ver'),
  ('CONTADOR', 'bitacora.ver'),
  ('CONTADOR', 'agentes.consultar'),
  ('CONTADOR', 'agentes.aprobar'),
  ('CONTADOR', 'tesoreria.saldos.ver'),
  ('GERENTE_GENERAL', 'empresas.ver'),
  ('GERENTE_GENERAL', 'contabilidad.plan_cuentas.ver'),
  ('GERENTE_GENERAL', 'maestros.terceros.ver'),
  ('GERENTE_GENERAL', 'maestros.centros_costo.ver'),
  ('GERENTE_GENERAL', 'normativa.ver'),
  ('GERENTE_GENERAL', 'bitacora.ver'),
  ('GERENTE_GENERAL', 'agentes.consultar'),
  ('GERENTE_GENERAL', 'agentes.aprobar'),
  ('GERENTE_GENERAL', 'tesoreria.saldos.ver'),
  ('GERENTE_AREA', 'empresas.ver'),
  ('GERENTE_AREA', 'contabilidad.plan_cuentas.ver'),
  ('GERENTE_AREA', 'maestros.centros_costo.ver'),
  ('GERENTE_AREA', 'agentes.consultar'),
  ('JEFATURA', 'empresas.ver'),
  ('JEFATURA', 'agentes.consultar'),
  ('COLABORADOR', 'agentes.consultar'),
  ('AUDITOR', 'empresas.ver'),
  ('AUDITOR', 'contabilidad.plan_cuentas.ver'),
  ('AUDITOR', 'maestros.terceros.ver'),
  ('AUDITOR', 'maestros.centros_costo.ver'),
  ('AUDITOR', 'normativa.ver'),
  ('AUDITOR', 'bitacora.ver');

-- ---------------------------------------------------------------------------
-- Contexto de la transacción
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_usuario_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.usuario_id', true), '')::uuid
$$;

CREATE FUNCTION app_empresa_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.empresa_id', true), '')::uuid
$$;

CREATE FUNCTION app_cliente_erp_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.cliente_erp_id
  FROM usuarios u
  JOIN clientes_erp c ON c.id = u.cliente_erp_id
  WHERE u.id = app_usuario_id() AND u.estado = 'ACTIVO' AND c.estado = 'ACTIVO'
$$;

-- ¿El usuario de la transacción tiene acceso a esta empresa?
CREATE FUNCTION app_tiene_acceso_empresa(p_empresa uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM empresas e
    WHERE e.id = p_empresa
      AND e.estado <> 'BAJA'
      AND e.cliente_erp_id = app_cliente_erp_id()
      AND (
        EXISTS (SELECT 1 FROM membresias_empresa m
                WHERE m.usuario_id = app_usuario_id() AND m.empresa_id = e.id)
        OR EXISTS (SELECT 1 FROM membresias_cliente_erp mc
                   WHERE mc.usuario_id = app_usuario_id() AND mc.cliente_erp_id = e.cliente_erp_id)
      )
  )
$$;

-- Regla para tablas de una empresa: la fila es de la empresa declarada y el
-- usuario tiene acceso a ella.
CREATE FUNCTION app_fila_visible(p_empresa uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_empresa = app_empresa_id() AND app_tiene_acceso_empresa(p_empresa)
$$;

-- Permisos del usuario en una empresa (unión de su rol directo y su rol de Cliente ERP).
CREATE FUNCTION app_permisos_en_empresa(p_empresa uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT rp.permiso_codigo
  FROM rol_permisos rp
  WHERE app_tiene_acceso_empresa(p_empresa)
    AND rp.rol_codigo IN (
      SELECT m.rol_codigo FROM membresias_empresa m
      WHERE m.usuario_id = app_usuario_id() AND m.empresa_id = p_empresa
      UNION
      SELECT mc.rol_codigo FROM membresias_cliente_erp mc
      JOIN empresas e ON e.cliente_erp_id = mc.cliente_erp_id
      WHERE mc.usuario_id = app_usuario_id() AND e.id = p_empresa
    )
$$;

-- Permisos a nivel de Cliente ERP (para crear empresas, usuarios, etc.).
CREATE FUNCTION app_tiene_permiso_cliente(p_permiso text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM membresias_cliente_erp mc
    JOIN rol_permisos rp ON rp.rol_codigo = mc.rol_codigo
    WHERE mc.usuario_id = app_usuario_id()
      AND mc.cliente_erp_id = app_cliente_erp_id()
      AND rp.permiso_codigo = p_permiso
  )
$$;

-- Empresas que el usuario puede elegir como contexto de trabajo.
CREATE FUNCTION app_empresas_accesibles()
RETURNS TABLE (id uuid, rut text, razon_social text, tipo text, estado text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.rut, e.razon_social, e.tipo, e.estado
  FROM empresas e
  WHERE app_tiene_acceso_empresa(e.id)
  ORDER BY e.tipo DESC, e.razon_social
$$;

-- ---------------------------------------------------------------------------
-- Funciones de autenticación (las únicas puertas a contraseñas y sesiones)
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth_credenciales(p_email text)
RETURNS TABLE (
  usuario_id uuid, cliente_erp_id uuid, password_hash text, totp_activo boolean,
  totp_secreto_cifrado text, estado text, bloqueado_hasta timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.cliente_erp_id, u.password_hash, u.totp_activo, u.totp_secreto_cifrado,
         CASE WHEN c.estado = 'ACTIVO' THEN u.estado ELSE 'INACTIVO' END,
         u.bloqueado_hasta
  FROM usuarios u
  JOIN clientes_erp c ON c.id = u.cliente_erp_id
  WHERE u.email = lower(trim(p_email))
$$;

-- Control de intentos. Cada intento (contraseña o código) RESERVA un cupo antes de
-- verificarse, con bloqueo de fila: así, aunque lleguen cien intentos en paralelo,
-- solo 5 se verifican; el resto encuentra la cuenta bloqueada. El contador solo se
-- reinicia con un ingreso COMPLETO (contraseña y doble factor) o al vencer el bloqueo.
CREATE FUNCTION auth_reservar_intento(p_usuario uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_intentos int;
  v_bloqueo  timestamptz;
BEGIN
  SELECT intentos_fallidos, bloqueado_hasta INTO v_intentos, v_bloqueo
  FROM usuarios WHERE id = p_usuario FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_bloqueo IS NOT NULL AND v_bloqueo > now() THEN
    RETURN false;
  END IF;
  IF v_bloqueo IS NOT NULL THEN
    -- El bloqueo anterior venció: se parte de cero.
    v_intentos := 0;
  END IF;
  IF v_intentos >= 5 THEN
    UPDATE usuarios SET bloqueado_hasta = now() + interval '15 minutes', intentos_fallidos = 0
    WHERE id = p_usuario;
    RETURN false;
  END IF;
  UPDATE usuarios SET intentos_fallidos = v_intentos + 1, bloqueado_hasta = NULL WHERE id = p_usuario;
  RETURN true;
END;
$$;

-- Devuelve el cupo de un intento de contraseña correcto (no cuenta como fallo).
CREATE FUNCTION auth_liberar_intento(p_usuario uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE usuarios SET intentos_fallidos = greatest(intentos_fallidos - 1, 0) WHERE id = p_usuario
$$;

CREATE FUNCTION auth_ingreso_completo(p_usuario uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_login = now() WHERE id = p_usuario
$$;

CREATE FUNCTION auth_crear_sesion(
  p_usuario uuid, p_token_hash bytea, p_expira timestamptz, p_ip inet, p_user_agent text
) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO sesiones (usuario_id, token_hash, expira_en, ip, user_agent)
  VALUES (p_usuario, p_token_hash, p_expira, p_ip, left(p_user_agent, 500))
  RETURNING id
$$;

-- Resuelve una sesión válida y renueva su último uso.
-- Inválida si: revocada, vencida, inactiva por más de p_inactividad, o usuario inactivo.
CREATE FUNCTION auth_resolver_sesion(p_token_hash bytea, p_inactividad interval)
RETURNS TABLE (sesion_id uuid, usuario_id uuid, cliente_erp_id uuid, mfa_verificada boolean, totp_activo boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  UPDATE sesiones s SET ultimo_uso = now()
  FROM usuarios u, clientes_erp c
  WHERE s.token_hash = p_token_hash
    AND s.revocada_en IS NULL
    AND s.expira_en > now()
    AND s.ultimo_uso > now() - p_inactividad
    AND u.id = s.usuario_id AND u.estado = 'ACTIVO'
    AND c.id = u.cliente_erp_id AND c.estado = 'ACTIVO'
  RETURNING s.id, s.usuario_id, u.cliente_erp_id, s.mfa_verificada, u.totp_activo;
END;
$$;

CREATE FUNCTION auth_marcar_mfa(p_sesion uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE sesiones SET mfa_verificada = true WHERE id = p_sesion AND revocada_en IS NULL
$$;

CREATE FUNCTION auth_revocar_sesion(p_sesion uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE sesiones SET revocada_en = now() WHERE id = p_sesion AND revocada_en IS NULL
$$;

CREATE FUNCTION auth_obtener_totp(p_usuario uuid)
RETURNS TABLE (totp_secreto_cifrado text, totp_activo boolean, bloqueado_hasta timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT totp_secreto_cifrado, totp_activo, bloqueado_hasta FROM usuarios WHERE id = p_usuario
$$;

-- Guarda un secreto TOTP pendiente (no activo) para enrolar. No reemplaza uno activo.
CREATE FUNCTION auth_guardar_totp_pendiente(p_usuario uuid, p_secreto_cifrado text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE usuarios SET totp_secreto_cifrado = p_secreto_cifrado
  WHERE id = p_usuario AND totp_activo = false
  RETURNING true
$$;

-- Acepta un código solo si su intervalo es posterior al último aceptado (anti-repetición).
CREATE FUNCTION auth_consumir_paso_totp(p_usuario uuid, p_paso bigint) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH actualizado AS (
    UPDATE usuarios SET totp_ultimo_paso = p_paso
    WHERE id = p_usuario AND (totp_ultimo_paso IS NULL OR totp_ultimo_paso < p_paso)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM actualizado)
$$;

-- Activa el doble factor solo si el secreto pendiente sigue siendo exactamente el
-- que se verificó (impide que otra sesión lo cambie entre la verificación y la activación).
CREATE FUNCTION auth_activar_totp(p_usuario uuid, p_secreto_verificado text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH activado AS (
    UPDATE usuarios SET totp_activo = true
    WHERE id = p_usuario AND totp_activo = false AND totp_secreto_cifrado = p_secreto_verificado
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM activado)
$$;

-- ---------------------------------------------------------------------------
-- Permisos del rol de la aplicación y políticas por fila
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO erp_app;

-- Las funciones de autenticación solo las puede usar el rol erp_auth, con su propia
-- conexión. Si la aplicación general fuera comprometida, no podría fabricar sesiones
-- ni leer hashes de contraseñas.
REVOKE EXECUTE ON FUNCTION
  auth_credenciales(text), auth_reservar_intento(uuid), auth_liberar_intento(uuid),
  auth_ingreso_completo(uuid), auth_crear_sesion(uuid, bytea, timestamptz, inet, text),
  auth_marcar_mfa(uuid), auth_revocar_sesion(uuid), auth_obtener_totp(uuid),
  auth_guardar_totp_pendiente(uuid, text), auth_consumir_paso_totp(uuid, bigint),
  auth_activar_totp(uuid, text), auth_resolver_sesion(bytea, interval)
FROM erp_app;
GRANT EXECUTE ON FUNCTION
  auth_credenciales(text), auth_reservar_intento(uuid), auth_liberar_intento(uuid),
  auth_ingreso_completo(uuid), auth_crear_sesion(uuid, bytea, timestamptz, inet, text),
  auth_marcar_mfa(uuid), auth_revocar_sesion(uuid), auth_obtener_totp(uuid),
  auth_guardar_totp_pendiente(uuid, text), auth_consumir_paso_totp(uuid, bigint),
  auth_activar_totp(uuid, text), auth_resolver_sesion(bytea, interval),
  app_usuario_id(), app_empresa_id(), app_cliente_erp_id(), app_tiene_acceso_empresa(uuid)
TO erp_auth;
GRANT USAGE ON SCHEMA public TO erp_auth;

-- Catálogos: lectura libre.
GRANT SELECT ON modulos, roles, permisos, rol_permisos TO erp_app;

-- Clientes ERP: cada usuario ve solo el suyo.
ALTER TABLE clientes_erp ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON clientes_erp TO erp_app;
CREATE POLICY clientes_erp_propio ON clientes_erp FOR SELECT TO erp_app
  USING (id = app_cliente_erp_id());

-- Empresas: se ven las que el usuario tiene asignadas. Solo el administrador
-- del Cliente ERP crea o modifica empresas, y siempre dentro de su Cliente ERP.
ALTER TABLE empresas ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON empresas TO erp_app;
GRANT UPDATE (razon_social, giro, estado) ON empresas TO erp_app;
CREATE POLICY empresas_ver ON empresas FOR SELECT TO erp_app
  USING (app_tiene_acceso_empresa(id));
CREATE POLICY empresas_crear ON empresas FOR INSERT TO erp_app
  WITH CHECK (cliente_erp_id = app_cliente_erp_id() AND app_tiene_permiso_cliente('empresas.administrar'));
CREATE POLICY empresas_modificar ON empresas FOR UPDATE TO erp_app
  USING (cliente_erp_id = app_cliente_erp_id() AND app_tiene_permiso_cliente('empresas.administrar'))
  WITH CHECK (cliente_erp_id = app_cliente_erp_id());

-- Suscripciones: visibles para quien accede a la empresa; las administra el Cliente ERP.
ALTER TABLE suscripciones_modulo ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON suscripciones_modulo TO erp_app;
GRANT UPDATE (vigente_hasta) ON suscripciones_modulo TO erp_app;
CREATE POLICY suscripciones_ver ON suscripciones_modulo FOR SELECT TO erp_app
  USING (app_tiene_acceso_empresa(empresa_id));
CREATE POLICY suscripciones_crear ON suscripciones_modulo FOR INSERT TO erp_app
  WITH CHECK (app_tiene_acceso_empresa(empresa_id) AND app_tiene_permiso_cliente('empresas.administrar'));
CREATE POLICY suscripciones_modificar ON suscripciones_modulo FOR UPDATE TO erp_app
  USING (app_tiene_acceso_empresa(empresa_id) AND app_tiene_permiso_cliente('empresas.administrar'));

-- Usuarios: nunca se exponen contraseñas ni secretos (permisos por columna).
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
GRANT SELECT (id, cliente_erp_id, email, nombre, telefono_whatsapp, estado, totp_activo, ultimo_login, creado_en)
  ON usuarios TO erp_app;
GRANT INSERT (cliente_erp_id, email, nombre, password_hash, telefono_whatsapp) ON usuarios TO erp_app;
GRANT UPDATE (nombre, telefono_whatsapp, estado) ON usuarios TO erp_app;
CREATE POLICY usuarios_ver ON usuarios FOR SELECT TO erp_app
  USING (id = app_usuario_id()
         OR (cliente_erp_id = app_cliente_erp_id() AND app_tiene_permiso_cliente('usuarios.ver')));
CREATE POLICY usuarios_crear ON usuarios FOR INSERT TO erp_app
  WITH CHECK (cliente_erp_id = app_cliente_erp_id() AND app_tiene_permiso_cliente('usuarios.administrar'));
CREATE POLICY usuarios_modificar ON usuarios FOR UPDATE TO erp_app
  USING (cliente_erp_id = app_cliente_erp_id() AND app_tiene_permiso_cliente('usuarios.administrar'))
  WITH CHECK (cliente_erp_id = app_cliente_erp_id());

ALTER TABLE membresias_empresa ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON membresias_empresa TO erp_app;
CREATE POLICY membresias_empresa_ver ON membresias_empresa FOR SELECT TO erp_app
  USING (usuario_id = app_usuario_id()
         OR (app_tiene_acceso_empresa(empresa_id) AND app_tiene_permiso_cliente('usuarios.ver')));
CREATE POLICY membresias_empresa_crear ON membresias_empresa FOR INSERT TO erp_app
  WITH CHECK (app_tiene_acceso_empresa(empresa_id) AND app_tiene_permiso_cliente('usuarios.administrar'));
CREATE POLICY membresias_empresa_borrar ON membresias_empresa FOR DELETE TO erp_app
  USING (app_tiene_acceso_empresa(empresa_id) AND app_tiene_permiso_cliente('usuarios.administrar'));

ALTER TABLE membresias_cliente_erp ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON membresias_cliente_erp TO erp_app;
CREATE POLICY membresias_cliente_ver ON membresias_cliente_erp FOR SELECT TO erp_app
  USING (usuario_id = app_usuario_id()
         OR (cliente_erp_id = app_cliente_erp_id() AND app_tiene_permiso_cliente('usuarios.ver')));
CREATE POLICY membresias_cliente_crear ON membresias_cliente_erp FOR INSERT TO erp_app
  WITH CHECK (cliente_erp_id = app_cliente_erp_id() AND app_tiene_permiso_cliente('usuarios.administrar'));
CREATE POLICY membresias_cliente_borrar ON membresias_cliente_erp FOR DELETE TO erp_app
  USING (cliente_erp_id = app_cliente_erp_id() AND app_tiene_permiso_cliente('usuarios.administrar')
         AND usuario_id <> app_usuario_id());

-- Sesiones: sin acceso directo; solo mediante las funciones auth_*.
ALTER TABLE sesiones ENABLE ROW LEVEL SECURITY;
