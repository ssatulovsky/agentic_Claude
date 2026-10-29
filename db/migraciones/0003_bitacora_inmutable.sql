-- =============================================================================
-- 0003 · Bitácora de auditoría inmutable y encadenada
-- =============================================================================
-- Cada evento guarda el hash SHA-256 de su contenido más el hash del evento
-- anterior. Modificar, borrar o insertar un evento fuera de lugar rompe la
-- cadena y se detecta con bitacora_verificar(). Además:
--   * la tabla rechaza UPDATE, DELETE y TRUNCATE incluso para su dueño;
--   * la aplicación solo puede insertar mediante bitacora_registrar();
--   * el último eslabón vive en bitacora_cabeza, con bloqueo de fila: dos
--     transacciones nunca pueden encadenarse al mismo eslabón (en aislamiento
--     REPEATABLE READ o SERIALIZABLE, la segunda falla en vez de bifurcar);
--   * un actor no puede registrar eventos a nombre de otro.
-- =============================================================================

CREATE TABLE bitacora (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ocurrido_en     timestamptz NOT NULL DEFAULT clock_timestamp(),
  cliente_erp_id  uuid,
  empresa_id      uuid,
  actor_tipo      text NOT NULL CHECK (actor_tipo IN ('USUARIO', 'AGENTE', 'SISTEMA')),
  actor_id        text NOT NULL,
  en_nombre_de    uuid,           -- usuario por quien actuó un agente
  accion          text NOT NULL,
  entidad         text,
  entidad_id      text,
  datos           jsonb NOT NULL DEFAULT '{}'::jsonb,
  hash_anterior   bytea NOT NULL,
  hash            bytea NOT NULL UNIQUE
);
CREATE INDEX bitacora_empresa_idx ON bitacora (empresa_id, id);
CREATE INDEX bitacora_cliente_idx ON bitacora (cliente_erp_id, id);

-- Último eslabón de la cadena (una sola fila).
CREATE TABLE bitacora_cabeza (
  unica        boolean PRIMARY KEY DEFAULT true CHECK (unica),
  ultimo_id    bigint,
  ultimo_hash  bytea NOT NULL
);
INSERT INTO bitacora_cabeza (ultimo_id, ultimo_hash) VALUES (NULL, digest('ERP-AGENTICO-GENESIS', 'sha256'));

-- Representación canónica sin ambigüedad: un arreglo JSON (cada campo queda
-- delimitado y escapado; la hora va en UTC con microsegundos).
CREATE FUNCTION bitacora_contenido_canonico(b bitacora) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_array(
    b.id,
    to_char(b.ocurrido_en AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    b.cliente_erp_id,
    b.empresa_id,
    b.actor_tipo,
    b.actor_id,
    b.en_nombre_de,
    b.accion,
    b.entidad,
    b.entidad_id,
    b.datos,
    encode(b.hash_anterior, 'hex')
  )::text
$$;

CREATE FUNCTION bitacora_rechazar_cambios() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'La bitácora es inmutable: % no está permitido', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER bitacora_sin_update_delete
  BEFORE UPDATE OR DELETE ON bitacora
  FOR EACH ROW EXECUTE FUNCTION bitacora_rechazar_cambios();

CREATE TRIGGER bitacora_sin_truncate
  BEFORE TRUNCATE ON bitacora
  FOR EACH STATEMENT EXECUTE FUNCTION bitacora_rechazar_cambios();

-- Registra un evento.
-- Reglas de identidad (para los roles de aplicación):
--   USUARIO: actor_id debe ser el usuario de la transacción.
--   AGENTE : debe haber usuario en la transacción, y se registra en_nombre_de él.
--   SISTEMA: solo los roles de plataforma (erp_owner) y de autenticación (erp_auth).
-- Si se indica una empresa, el usuario de la transacción debe tener acceso a ella.
CREATE FUNCTION bitacora_registrar(
  p_actor_tipo   text,
  p_actor_id     text,
  p_accion       text,
  p_entidad      text DEFAULT NULL,
  p_entidad_id   text DEFAULT NULL,
  p_datos        jsonb DEFAULT '{}'::jsonb,
  p_empresa_id   uuid DEFAULT NULL,
  p_en_nombre_de uuid DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_rol      text := session_user;
  v_usuario  uuid := app_usuario_id();
  v_plataforma boolean := session_user IN ('erp_owner', 'erp_auth');
  v_anterior bytea;
  v_fila     bitacora;
  v_cliente  uuid;
BEGIN
  IF NOT v_plataforma THEN
    IF p_actor_tipo = 'SISTEMA' THEN
      RAISE EXCEPTION 'El rol % no puede registrar eventos de sistema', v_rol USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_usuario IS NULL THEN
      RAISE EXCEPTION 'No hay usuario en la transacción' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_actor_tipo = 'USUARIO' AND p_actor_id IS DISTINCT FROM v_usuario::text THEN
      RAISE EXCEPTION 'Un usuario no puede registrar eventos a nombre de otro' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_actor_tipo = 'AGENTE' THEN
      p_en_nombre_de := v_usuario;
    END IF;
    IF p_empresa_id IS NOT NULL AND NOT app_tiene_acceso_empresa(p_empresa_id) THEN
      RAISE EXCEPTION 'Sin acceso a la empresa % para registrar en la bitácora', p_empresa_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  v_cliente := coalesce(
    (SELECT cliente_erp_id FROM empresas WHERE id = p_empresa_id),
    app_cliente_erp_id()
  );

  -- Bloqueo de fila sobre la cabeza: serializa la cadena. En REPEATABLE READ o
  -- SERIALIZABLE, una cabeza modificada por otra transacción produce un error
  -- de serialización en vez de un eslabón duplicado.
  SELECT ultimo_hash INTO v_anterior FROM bitacora_cabeza FOR UPDATE;

  v_fila.id             := nextval(pg_get_serial_sequence('bitacora', 'id'));
  v_fila.ocurrido_en    := date_trunc('microseconds', clock_timestamp());
  v_fila.cliente_erp_id := v_cliente;
  v_fila.empresa_id     := p_empresa_id;
  v_fila.actor_tipo     := p_actor_tipo;
  v_fila.actor_id       := p_actor_id;
  v_fila.en_nombre_de   := p_en_nombre_de;
  v_fila.accion         := p_accion;
  v_fila.entidad        := p_entidad;
  v_fila.entidad_id     := p_entidad_id;
  v_fila.datos          := coalesce(p_datos, '{}'::jsonb);
  v_fila.hash_anterior  := v_anterior;
  v_fila.hash           := digest(bitacora_contenido_canonico(v_fila), 'sha256');

  INSERT INTO bitacora OVERRIDING SYSTEM VALUE
  SELECT v_fila.*;

  UPDATE bitacora_cabeza SET ultimo_id = v_fila.id, ultimo_hash = v_fila.hash;

  RETURN v_fila.id;
END;
$$;

-- Verifica la cadena completa y que la cabeza apunte al último evento (detecta
-- eventos alterados, insertados, borrados del medio o recortados del final).
-- Es una operación de plataforma: recorre todos los clientes, así que no se
-- expone a la aplicación. Devuelve el id del primer problema, o NULL si está íntegra.
CREATE FUNCTION bitacora_verificar() RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r          bitacora;
  v_esperado bytea := digest('ERP-AGENTICO-GENESIS', 'sha256');
  v_ultimo   bigint := 0;
  v_cabeza   bitacora_cabeza;
BEGIN
  FOR r IN SELECT * FROM bitacora ORDER BY id LOOP
    IF r.hash_anterior <> v_esperado
       OR r.hash <> digest(bitacora_contenido_canonico(r), 'sha256') THEN
      RETURN r.id;
    END IF;
    v_esperado := r.hash;
    v_ultimo := r.id;
  END LOOP;
  SELECT * INTO v_cabeza FROM bitacora_cabeza;
  IF v_cabeza.ultimo_hash <> v_esperado THEN
    RETURN coalesce(v_cabeza.ultimo_id, 0);
  END IF;
  RETURN NULL;
END;
$$;

ALTER TABLE bitacora ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON bitacora TO erp_app;
CREATE POLICY bitacora_ver ON bitacora FOR SELECT TO erp_app
  USING (
    (empresa_id IS NOT NULL AND app_fila_visible(empresa_id)
      AND empresa_id = app_empresa_id()
      AND EXISTS (SELECT 1 FROM app_permisos_en_empresa(empresa_id) p WHERE p = 'bitacora.ver'))
    OR (empresa_id IS NULL AND cliente_erp_id = app_cliente_erp_id()
        AND app_tiene_permiso_cliente('bitacora.ver'))
  );

REVOKE EXECUTE ON FUNCTION bitacora_contenido_canonico(bitacora), bitacora_rechazar_cambios(), bitacora_verificar()
  FROM PUBLIC, erp_app;
GRANT EXECUTE ON FUNCTION bitacora_registrar(text, text, text, text, text, jsonb, uuid, uuid) TO erp_app, erp_auth;
