-- =============================================================================
-- 0020 — Contralor: revisión independiente de cada propuesta de un agente antes de
-- que llegue a una persona, y control de las cifras de cada respuesta.
--
-- El Contralor es determinista (núcleo, no un modelo de IA): ensaya la acción con las
-- mismas validaciones que tendrá al aprobarse y la deshace, y aplica revisiones propias
-- de cada herramienta. Si encuentra un error bloqueante, la propuesta no llega a nadie:
-- el agente recibe los hallazgos para corregirla. Si solo hay observaciones, la propuesta
-- queda pendiente y quien la apruebe debe dar un motivo.
-- =============================================================================

ALTER TABLE propuestas_agente
  ADD COLUMN dictamen_contralor text CHECK (dictamen_contralor IN ('CONFORME', 'OBSERVADA')),
  ADD COLUMN hallazgos_contralor jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Un dictamen OBSERVADO solo se aprueba con motivo.
CREATE FUNCTION propuesta_observada_exige_motivo() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.estado IN ('EJECUTADA', 'FALLIDA', 'APROBADA') AND OLD.estado = 'PENDIENTE'
     AND NEW.dictamen_contralor = 'OBSERVADA' AND length(trim(coalesce(NEW.motivo, ''))) < 5 THEN
    RAISE EXCEPTION 'La propuesta tiene observaciones del Contralor: para aprobarla indique un motivo'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.dictamen_contralor IS DISTINCT FROM OLD.dictamen_contralor
     OR NEW.hallazgos_contralor IS DISTINCT FROM OLD.hallazgos_contralor THEN
    RAISE EXCEPTION 'El dictamen del Contralor no se modifica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER propuestas_agente_dictamen BEFORE UPDATE ON propuestas_agente
  FOR EACH ROW EXECUTE FUNCTION propuesta_observada_exige_motivo();

-- Registro de cada revisión, también de las que no llegaron a ser propuesta.
CREATE TABLE revisiones_contralor (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id       uuid NOT NULL REFERENCES empresas(id),
  agente_codigo    text NOT NULL,
  herramienta      text NOT NULL,
  solicitado_por   uuid NOT NULL REFERENCES usuarios(id),
  conversacion_id  uuid,
  propuesta_id     uuid REFERENCES propuestas_agente(id),
  dictamen         text NOT NULL CHECK (dictamen IN ('CONFORME', 'OBSERVADA', 'RECHAZADA')),
  hallazgos        jsonb NOT NULL,
  resumen          text NOT NULL,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  CHECK ((dictamen = 'RECHAZADA') = (propuesta_id IS NULL))
);
CREATE INDEX revisiones_contralor_empresa_idx ON revisiones_contralor (empresa_id, creado_en);
CREATE TRIGGER revisiones_contralor_inmutable BEFORE UPDATE OR DELETE ON revisiones_contralor
  FOR EACH ROW EXECUTE FUNCTION tributario_rechazar_cambios();
CREATE TRIGGER revisiones_contralor_sin_truncate BEFORE TRUNCATE ON revisiones_contralor
  FOR EACH STATEMENT EXECUTE FUNCTION tributario_rechazar_cambios();

ALTER TABLE revisiones_contralor ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON revisiones_contralor TO erp_app;
-- Las ve quien las originó y quien aprueba propuestas en la empresa.
CREATE POLICY revisiones_contralor_ver ON revisiones_contralor FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id)
         AND (solicitado_por = app_usuario_id() OR app_tiene_permiso(empresa_id, 'agentes.aprobar')));
CREATE POLICY revisiones_contralor_crear ON revisiones_contralor FOR INSERT TO erp_app
  WITH CHECK (app_fila_visible(empresa_id) AND solicitado_por = app_usuario_id());

-- Nuevos tipos de traza: revisión del Contralor y control de cifras de la respuesta.
ALTER TABLE trazas_agente DROP CONSTRAINT trazas_agente_tipo_check;
ALTER TABLE trazas_agente ADD CONSTRAINT trazas_agente_tipo_check CHECK (tipo IN (
  'MENSAJE_USUARIO', 'LLAMADA_HERRAMIENTA', 'RESULTADO_HERRAMIENTA', 'DENEGADO', 'PROPUESTA_CREADA',
  'RESPUESTA', 'ERROR', 'REVISION_CONTRALOR', 'CONTROL_CIFRAS'));
