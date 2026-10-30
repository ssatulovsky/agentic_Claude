-- =============================================================================
-- 0019 — Respuesta con nota de voz por WhatsApp (preferencia de cada persona).
--   NUNCA:        solo texto.
--   SI_ENVIA_VOZ: con voz cuando la persona preguntó con una nota de voz (por omisión).
--   SIEMPRE:      con voz siempre.
-- El texto se envía siempre: las cifras quedan por escrito.
-- =============================================================================

ALTER TABLE vinculos_whatsapp
  ADD COLUMN voz text NOT NULL DEFAULT 'SI_ENVIA_VOZ' CHECK (voz IN ('NUNCA', 'SI_ENVIA_VOZ', 'SIEMPRE'));

-- Cambia el tipo de resultado: se reemplazan (con sus permisos).
DROP FUNCTION whatsapp_identificar(text);
CREATE FUNCTION whatsapp_identificar(p_telefono text)
RETURNS TABLE (usuario_id uuid, empresa_actual_id uuid, agente_actual text, conversacion_id uuid, ultima_actividad timestamptz, voz text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.usuario_id, v.empresa_actual_id, v.agente_actual, v.conversacion_id, v.ultima_actividad, v.voz
  FROM vinculos_whatsapp v JOIN usuarios u ON u.id = v.usuario_id
  WHERE v.telefono = p_telefono AND v.estado = 'VERIFICADO' AND v.vence_en > now()
    AND u.estado = 'ACTIVO' AND u.totp_activo AND u.telefono_whatsapp = p_telefono
$$;

DROP FUNCTION whatsapp_mi_vinculo();
CREATE FUNCTION whatsapp_mi_vinculo()
RETURNS TABLE (telefono text, estado text, verificado_en timestamptz, vence_en timestamptz, codigo_vence_en timestamptz, voz text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.telefono,
         CASE WHEN v.estado = 'VERIFICADO' AND v.vence_en <= now() THEN 'VENCIDO'
              WHEN v.estado = 'PENDIENTE' AND v.codigo_vence_en <= now() THEN 'CODIGO_VENCIDO'
              ELSE v.estado END,
         v.verificado_en, v.vence_en, v.codigo_vence_en, v.voz
  FROM vinculos_whatsapp v WHERE v.usuario_id = app_usuario_id()
$$;

-- La persona elige cómo recibir las respuestas (web o comando del chat).
CREATE FUNCTION whatsapp_preferir_voz(p_voz text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_usuario_id() IS NULL OR tributario_es_agente() THEN
    RAISE EXCEPTION 'Solo la persona puede cambiar su preferencia' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_voz NOT IN ('NUNCA', 'SI_ENVIA_VOZ', 'SIEMPRE') THEN
    RAISE EXCEPTION 'Preferencia de voz inválida' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE vinculos_whatsapp SET voz = p_voz, actualizado_en = now()
  WHERE usuario_id = app_usuario_id() AND estado <> 'REVOCADO';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Primero vincule su WhatsApp' USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION whatsapp_mi_vinculo(), whatsapp_preferir_voz(text) TO erp_app;
GRANT EXECUTE ON FUNCTION whatsapp_identificar(text) TO erp_auth;
