-- =============================================================================
-- 0018 — Canal WhatsApp: vínculo verificado del teléfono, sesión de chat,
-- mensajes recibidos (sin su contenido) y estado de la conexión del conector.
--
-- El conector (puente) no es un usuario: se autentica con firma HMAC ante el
-- servidor. La identificación de la persona por su teléfono la hace el rol de
-- autenticación (erp_auth); desde ahí, todo corre con la identidad y los
-- permisos de esa persona (erp_app + RLS), igual que en la web.
-- =============================================================================

-- Vínculo de una persona con su WhatsApp. Se activa con un código que la persona
-- obtiene en la web (con doble factor) y envía desde el teléfono registrado.
CREATE TABLE vinculos_whatsapp (
  usuario_id          uuid PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  telefono            text NOT NULL CHECK (telefono ~ '^\+[1-9][0-9]{7,14}$'),
  estado              text NOT NULL CHECK (estado IN ('PENDIENTE', 'VERIFICADO', 'REVOCADO')),
  codigo_hash         bytea,
  codigo_vence_en     timestamptz,
  intentos            int NOT NULL DEFAULT 0,
  verificado_en       timestamptz,
  -- Un vínculo verificado vence: la persona lo renueva desde la web.
  vence_en            timestamptz,
  -- Sesión del chat.
  empresa_actual_id   uuid REFERENCES empresas(id),
  agente_actual       text CHECK (agente_actual IS NULL OR agente_actual ~ '^[A-Z_]{3,40}$'),
  conversacion_id     uuid,
  ultima_actividad    timestamptz,
  actualizado_en      timestamptz NOT NULL DEFAULT now(),
  CHECK (estado <> 'PENDIENTE' OR (codigo_hash IS NOT NULL AND codigo_vence_en IS NOT NULL)),
  CHECK (estado <> 'VERIFICADO' OR (verificado_en IS NOT NULL AND vence_en IS NOT NULL AND codigo_hash IS NULL))
);
-- Un teléfono, un vínculo verificado. (Las vinculaciones pendientes no bloquean: al confirmar
-- solo cuenta la de la cuenta que hoy tiene ese teléfono.)
CREATE UNIQUE INDEX vinculos_whatsapp_telefono_uq ON vinculos_whatsapp (telefono) WHERE estado = 'VERIFICADO';

-- Mensajes recibidos por el canal: solo metadatos. El texto queda en las trazas
-- del agente (con las mismas reglas de acceso); los audios no se guardan.
CREATE TABLE mensajes_whatsapp (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_externo    text NOT NULL UNIQUE CHECK (length(id_externo) BETWEEN 1 AND 200),
  telefono      text NOT NULL,
  usuario_id    uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  tipo          text NOT NULL CHECK (tipo IN ('TEXTO', 'AUDIO')),
  estado        text NOT NULL DEFAULT 'RECIBIDO' CHECK (estado IN ('RECIBIDO', 'RESPONDIDO', 'IGNORADO', 'ERROR')),
  reintentos    int NOT NULL DEFAULT 0,
  detalle       text,
  recibido_en   timestamptz NOT NULL DEFAULT now(),
  procesado_en  timestamptz
);
CREATE INDEX mensajes_whatsapp_recibido_idx ON mensajes_whatsapp (recibido_en);

-- Estado de la conexión del conector (una fila: el número de la plataforma).
CREATE TABLE estado_canal_whatsapp (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  estado           text NOT NULL CHECK (estado IN ('CONECTADO', 'DESCONECTADO', 'SIN_DATOS')),
  detalle          text,
  ultimo_latido    timestamptz,
  cambiado_en      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO estado_canal_whatsapp (estado) VALUES ('SIN_DATOS');

-- Si cambia el teléfono, la contraseña o el doble factor de una persona, o se desactiva su
-- cuenta, el vínculo se revoca (una cuenta comprometida y recuperada no conserva el WhatsApp).
CREATE FUNCTION whatsapp_revocar_por_cambio_usuario() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.telefono_whatsapp IS DISTINCT FROM OLD.telefono_whatsapp OR NEW.estado <> 'ACTIVO'
     OR NEW.password_hash IS DISTINCT FROM OLD.password_hash
     OR NEW.totp_secreto_cifrado IS DISTINCT FROM OLD.totp_secreto_cifrado
     OR NEW.totp_activo IS DISTINCT FROM OLD.totp_activo THEN
    UPDATE vinculos_whatsapp SET estado = 'REVOCADO', codigo_hash = NULL, codigo_vence_en = NULL,
      conversacion_id = NULL, actualizado_en = now()
    WHERE usuario_id = NEW.id AND estado <> 'REVOCADO';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER usuarios_revocar_whatsapp AFTER UPDATE OF telefono_whatsapp, estado, password_hash, totp_secreto_cifrado, totp_activo ON usuarios
  FOR EACH ROW EXECUTE FUNCTION whatsapp_revocar_por_cambio_usuario();

-- ---------------------------------------------------------------------------
-- Funciones para la persona (web, erp_app, con su sesión)
-- ---------------------------------------------------------------------------

-- Inicia (o reinicia) la vinculación: guarda el hash del código, válido 10 minutos.
CREATE FUNCTION whatsapp_iniciar_vinculo(p_codigo_hash bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_telefono text;
BEGIN
  IF app_usuario_id() IS NULL OR tributario_es_agente() THEN
    RAISE EXCEPTION 'Solo la persona puede vincular su WhatsApp' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_codigo_hash IS NULL OR length(p_codigo_hash) <> 32 THEN
    RAISE EXCEPTION 'Código inválido' USING ERRCODE = 'check_violation';
  END IF;
  -- FOR SHARE: un cambio simultáneo del teléfono espera a que esta vinculación termine (y la revoca).
  SELECT telefono_whatsapp INTO v_telefono FROM usuarios WHERE id = app_usuario_id() AND estado = 'ACTIVO' FOR SHARE;
  IF v_telefono IS NULL THEN
    RAISE EXCEPTION 'Su cuenta no tiene un teléfono de WhatsApp registrado; pídalo al administrador'
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO vinculos_whatsapp (usuario_id, telefono, estado, codigo_hash, codigo_vence_en, intentos)
  VALUES (app_usuario_id(), v_telefono, 'PENDIENTE', p_codigo_hash, now() + interval '10 minutes', 0)
  ON CONFLICT (usuario_id) DO UPDATE SET telefono = EXCLUDED.telefono, estado = 'PENDIENTE',
    codigo_hash = EXCLUDED.codigo_hash, codigo_vence_en = EXCLUDED.codigo_vence_en, intentos = 0,
    verificado_en = NULL, vence_en = NULL, conversacion_id = NULL, actualizado_en = now();
  PERFORM bitacora_registrar('USUARIO', app_usuario_id()::text, 'WHATSAPP_VINCULACION_INICIADA', 'vinculos_whatsapp',
    app_usuario_id()::text, jsonb_build_object('telefono', v_telefono), NULL, app_usuario_id());
  RETURN v_telefono;
END;
$$;

CREATE FUNCTION whatsapp_desvincular() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_usuario_id() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE vinculos_whatsapp SET estado = 'REVOCADO', codigo_hash = NULL, codigo_vence_en = NULL,
    conversacion_id = NULL, actualizado_en = now()
  WHERE usuario_id = app_usuario_id() AND estado <> 'REVOCADO';
  IF FOUND THEN
    PERFORM bitacora_registrar('USUARIO', app_usuario_id()::text, 'WHATSAPP_DESVINCULADO', 'vinculos_whatsapp',
      app_usuario_id()::text, '{}'::jsonb, NULL, app_usuario_id());
  END IF;
END;
$$;

-- Estado del vínculo de la propia persona.
CREATE FUNCTION whatsapp_mi_vinculo()
RETURNS TABLE (telefono text, estado text, verificado_en timestamptz, vence_en timestamptz, codigo_vence_en timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.telefono,
         CASE WHEN v.estado = 'VERIFICADO' AND v.vence_en <= now() THEN 'VENCIDO'
              WHEN v.estado = 'PENDIENTE' AND v.codigo_vence_en <= now() THEN 'CODIGO_VENCIDO'
              ELSE v.estado END,
         v.verificado_en, v.vence_en, v.codigo_vence_en
  FROM vinculos_whatsapp v WHERE v.usuario_id = app_usuario_id()
$$;

-- Sesión del chat: empresa, agente y conversación actuales. Solo la propia persona,
-- con un vínculo verificado, y solo empresas a las que tiene acceso.
CREATE FUNCTION whatsapp_guardar_sesion(p_empresa uuid, p_agente text, p_conversacion uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_usuario_id() IS NULL OR (p_empresa IS NOT NULL AND NOT app_tiene_acceso_empresa(p_empresa)) THEN
    RAISE EXCEPTION 'Sin acceso a la empresa' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE vinculos_whatsapp SET empresa_actual_id = p_empresa, agente_actual = p_agente, conversacion_id = p_conversacion,
    ultima_actividad = now(), actualizado_en = now()
  WHERE usuario_id = app_usuario_id() AND estado = 'VERIFICADO';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El WhatsApp no está vinculado' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- Estado de la conexión, para administradores de un Cliente ERP.
CREATE FUNCTION whatsapp_estado_canal()
RETURNS TABLE (estado text, detalle text, ultimo_latido timestamptz, cambiado_en timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN c.ultimo_latido IS NULL THEN 'SIN_DATOS'
              WHEN c.ultimo_latido < now() - interval '3 minutes' THEN 'DESCONECTADO'
              ELSE c.estado END,
         -- El detalle técnico del conector es de la plataforma; los clientes ven solo el estado.
         CASE WHEN c.ultimo_latido < now() - interval '3 minutes' THEN 'El conector no informa su estado hace más de 3 minutos'
              ELSE NULL END,
         c.ultimo_latido, c.cambiado_en
  FROM estado_canal_whatsapp c
  WHERE app_usuario_id() IS NOT NULL AND app_tiene_permiso_cliente('usuarios.administrar')
$$;

-- ---------------------------------------------------------------------------
-- Funciones del canal (rol erp_auth: antes de saber quién escribe)
-- ---------------------------------------------------------------------------

-- Registra un mensaje entrante; NULL si ya se recibió (el conector puede reenviar).
CREATE FUNCTION whatsapp_registrar_entrada(p_id_externo text, p_telefono text, p_tipo text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id bigint;
BEGIN
  -- Un mensaje que quedó sin procesar (el servidor se reinició a mitad) se puede reprocesar
  -- cuando el conector lo reenvía, pasado el plazo máximo de una consulta, hasta 3 veces.
  INSERT INTO mensajes_whatsapp (id_externo, telefono, tipo) VALUES (p_id_externo, p_telefono, p_tipo)
  ON CONFLICT (id_externo) DO UPDATE SET reintentos = mensajes_whatsapp.reintentos + 1, recibido_en = now()
    WHERE mensajes_whatsapp.estado = 'RECIBIDO' AND mensajes_whatsapp.recibido_en < now() - interval '15 minutes'
      AND mensajes_whatsapp.reintentos < 3 AND mensajes_whatsapp.telefono = EXCLUDED.telefono
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- El usuario solo se anota si es quien tiene vinculado ese teléfono.
CREATE FUNCTION whatsapp_marcar_mensaje(p_id bigint, p_estado text, p_usuario uuid, p_detalle text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE mensajes_whatsapp m SET estado = p_estado,
    usuario_id = CASE WHEN EXISTS (SELECT 1 FROM vinculos_whatsapp v WHERE v.usuario_id = p_usuario AND v.telefono = m.telefono)
                      THEN p_usuario ELSE m.usuario_id END,
    detalle = left(p_detalle, 300), procesado_en = now()
  WHERE m.id = p_id AND m.estado = 'RECIBIDO' AND p_estado IN ('RESPONDIDO', 'IGNORADO', 'ERROR')
$$;

-- Retención: los metadatos de números desconocidos se borran a los 30 días; el resto, al año.
CREATE FUNCTION whatsapp_purgar_mensajes() RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH b AS (
    DELETE FROM mensajes_whatsapp
    WHERE (usuario_id IS NULL AND recibido_en < now() - interval '30 days')
       OR recibido_en < now() - interval '365 days'
    RETURNING 1)
  SELECT count(*)::int FROM b
$$;

-- Quién escribe: la persona con vínculo verificado y vigente para ese teléfono,
-- con su cuenta activa y doble factor configurado.
CREATE FUNCTION whatsapp_identificar(p_telefono text)
RETURNS TABLE (usuario_id uuid, empresa_actual_id uuid, agente_actual text, conversacion_id uuid, ultima_actividad timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.usuario_id, v.empresa_actual_id, v.agente_actual, v.conversacion_id, v.ultima_actividad
  FROM vinculos_whatsapp v JOIN usuarios u ON u.id = v.usuario_id
  WHERE v.telefono = p_telefono AND v.estado = 'VERIFICADO' AND v.vence_en > now()
    AND u.estado = 'ACTIVO' AND u.totp_activo AND u.telefono_whatsapp = p_telefono
$$;

-- Confirma la vinculación con el código enviado desde el teléfono registrado.
-- Máximo 5 intentos por código. Devuelve el resultado (sin revelar a quién pertenece).
CREATE FUNCTION whatsapp_confirmar_vinculo(p_telefono text, p_codigo_hash bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v vinculos_whatsapp;
BEGIN
  -- Solo cuenta la vinculación de la cuenta que hoy tiene ese teléfono (único en usuarios).
  SELECT vw.* INTO v FROM vinculos_whatsapp vw JOIN usuarios u ON u.id = vw.usuario_id
  WHERE vw.telefono = p_telefono AND vw.estado = 'PENDIENTE' AND u.telefono_whatsapp = p_telefono AND u.estado = 'ACTIVO'
  FOR UPDATE OF vw;
  IF v.usuario_id IS NULL THEN
    RETURN 'SIN_VINCULACION_PENDIENTE';
  END IF;
  IF v.codigo_vence_en <= now() OR v.intentos >= 5 THEN
    RETURN 'CODIGO_VENCIDO';
  END IF;
  IF v.codigo_hash IS DISTINCT FROM p_codigo_hash THEN
    UPDATE vinculos_whatsapp SET intentos = intentos + 1, actualizado_en = now() WHERE usuario_id = v.usuario_id;
    RETURN 'CODIGO_INCORRECTO';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = v.usuario_id AND u.telefono_whatsapp = p_telefono AND u.estado = 'ACTIVO') THEN
    RETURN 'SIN_VINCULACION_PENDIENTE';
  END IF;
  -- Si el mismo teléfono tenía otro vínculo (otra cuenta), queda revocado.
  UPDATE vinculos_whatsapp SET estado = 'REVOCADO', codigo_hash = NULL, codigo_vence_en = NULL, conversacion_id = NULL,
    actualizado_en = now()
  WHERE telefono = p_telefono AND usuario_id <> v.usuario_id AND estado <> 'REVOCADO';
  UPDATE vinculos_whatsapp SET estado = 'VERIFICADO', codigo_hash = NULL, codigo_vence_en = NULL, intentos = 0,
    verificado_en = now(), vence_en = now() + interval '90 days', conversacion_id = NULL, actualizado_en = now()
  WHERE usuario_id = v.usuario_id;
  PERFORM bitacora_registrar('SISTEMA', 'canal_whatsapp', 'WHATSAPP_VINCULADO', 'vinculos_whatsapp',
    v.usuario_id::text, jsonb_build_object('telefono', p_telefono), NULL, v.usuario_id);
  RETURN 'VINCULADO';
END;
$$;

-- Latido del conector. Un cambio de estado queda en la bitácora.
CREATE FUNCTION whatsapp_latido(p_estado text, p_detalle text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_anterior text;
BEGIN
  IF p_estado NOT IN ('CONECTADO', 'DESCONECTADO') THEN
    RAISE EXCEPTION 'Estado inválido' USING ERRCODE = 'check_violation';
  END IF;
  SELECT CASE WHEN ultimo_latido < now() - interval '3 minutes' THEN 'DESCONECTADO' ELSE estado END
    INTO v_anterior FROM estado_canal_whatsapp FOR UPDATE;
  UPDATE estado_canal_whatsapp SET estado = p_estado, detalle = left(p_detalle, 300), ultimo_latido = now(),
    cambiado_en = CASE WHEN v_anterior IS DISTINCT FROM p_estado THEN now() ELSE cambiado_en END;
  IF v_anterior IS DISTINCT FROM p_estado THEN
    PERFORM bitacora_registrar('SISTEMA', 'canal_whatsapp', 'WHATSAPP_' || p_estado, 'estado_canal_whatsapp', 'whatsapp',
      jsonb_build_object('anterior', v_anterior, 'detalle', left(p_detalle, 300)), NULL, NULL);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
ALTER TABLE vinculos_whatsapp ENABLE ROW LEVEL SECURITY;
ALTER TABLE mensajes_whatsapp ENABLE ROW LEVEL SECURITY;
ALTER TABLE estado_canal_whatsapp ENABLE ROW LEVEL SECURITY;
-- Sin acceso directo a las tablas: solo por las funciones.

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  whatsapp_iniciar_vinculo(bytea),
  whatsapp_desvincular(),
  whatsapp_mi_vinculo(),
  whatsapp_guardar_sesion(uuid, text, uuid),
  whatsapp_estado_canal()
TO erp_app;
GRANT EXECUTE ON FUNCTION
  whatsapp_registrar_entrada(text, text, text),
  whatsapp_marcar_mensaje(bigint, text, uuid, text),
  whatsapp_identificar(text),
  whatsapp_confirmar_vinculo(text, bytea),
  whatsapp_latido(text, text),
  whatsapp_purgar_mensajes()
TO erp_auth;
