-- =============================================================================
-- 0006 · Capa agéntica: configuración por empresa, propuestas y trazas
-- =============================================================================
-- Un agente nunca escribe directamente en los libros. Lo que no es una consulta
-- queda como propuesta que una persona con el permiso agentes.aprobar acepta o
-- rechaza. Cada paso de cada conversación queda trazado.
-- =============================================================================

CREATE TABLE agentes_config_empresa (
  empresa_id         uuid NOT NULL REFERENCES empresas(id),
  agente_codigo      text NOT NULL CHECK (agente_codigo ~ '^[A-Z_]+$'),
  activo             boolean NOT NULL DEFAULT true,
  -- Nivel máximo que la empresa permite a este agente sin aprobación humana.
  autonomia_maxima   text NOT NULL DEFAULT 'CONSULTAR'
                     CHECK (autonomia_maxima IN ('CONSULTAR', 'PROPONER', 'EJECUTAR_CON_AVISO')),
  parametros         jsonb NOT NULL DEFAULT '{}'::jsonb,
  actualizado_en     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, agente_codigo)
);

ALTER TABLE agentes_config_empresa ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON agentes_config_empresa TO erp_app;
CREATE POLICY agentes_config_ver ON agentes_config_empresa FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id));

CREATE TABLE propuestas_agente (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL REFERENCES empresas(id),
  agente_codigo    text NOT NULL,
  herramienta      text NOT NULL,
  autonomia        text NOT NULL CHECK (autonomia IN ('PROPONER', 'EJECUTAR_CON_APROBACION')),
  solicitado_por   uuid NOT NULL REFERENCES usuarios(id),
  entrada          jsonb NOT NULL,
  resumen          text NOT NULL,
  estado           text NOT NULL DEFAULT 'PENDIENTE'
                   CHECK (estado IN ('PENDIENTE', 'APROBADA', 'RECHAZADA', 'EJECUTADA', 'FALLIDA', 'VENCIDA')),
  resultado        jsonb,
  revisado_por     uuid REFERENCES usuarios(id),
  revisado_en      timestamptz,
  motivo           text,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  vence_en         timestamptz NOT NULL DEFAULT now() + interval '7 days',
  CHECK (estado = 'PENDIENTE' OR estado = 'VENCIDA' OR revisado_por IS NOT NULL)
);
CREATE INDEX propuestas_agente_empresa_estado_idx ON propuestas_agente (empresa_id, estado);

CREATE TRIGGER propuestas_agente_auditoria AFTER INSERT OR UPDATE ON propuestas_agente
  FOR EACH ROW EXECUTE FUNCTION auditar_cambio();

ALTER TABLE propuestas_agente ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON propuestas_agente TO erp_app;
GRANT UPDATE (estado, resultado, revisado_por, revisado_en, motivo) ON propuestas_agente TO erp_app;
CREATE POLICY propuestas_ver ON propuestas_agente FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id)
         AND (solicitado_por = app_usuario_id() OR app_tiene_permiso(empresa_id, 'agentes.aprobar')));
CREATE POLICY propuestas_crear ON propuestas_agente FOR INSERT TO erp_app
  WITH CHECK (app_fila_visible(empresa_id) AND solicitado_por = app_usuario_id() AND estado = 'PENDIENTE');
-- Solo quien tiene agentes.aprobar revisa, y queda registrado como revisor.
CREATE POLICY propuestas_revisar ON propuestas_agente FOR UPDATE TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'agentes.aprobar'))
  WITH CHECK (app_fila_visible(empresa_id) AND revisado_por = app_usuario_id());

CREATE TABLE trazas_agente (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id       uuid NOT NULL REFERENCES empresas(id),
  conversacion_id  uuid NOT NULL,
  usuario_id       uuid NOT NULL REFERENCES usuarios(id),
  agente_codigo    text NOT NULL,
  paso             int NOT NULL,
  tipo             text NOT NULL CHECK (tipo IN ('MENSAJE_USUARIO', 'LLAMADA_HERRAMIENTA', 'RESULTADO_HERRAMIENTA',
                                                 'DENEGADO', 'PROPUESTA_CREADA', 'RESPUESTA', 'ERROR')),
  contenido        jsonb NOT NULL,
  creado_en        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trazas_agente_conversacion_idx ON trazas_agente (conversacion_id, paso);

ALTER TABLE trazas_agente ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON trazas_agente TO erp_app;
CREATE POLICY trazas_ver ON trazas_agente FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id)
         AND (usuario_id = app_usuario_id() OR app_tiene_permiso(empresa_id, 'bitacora.ver')));
CREATE POLICY trazas_crear ON trazas_agente FOR INSERT TO erp_app
  WITH CHECK (app_fila_visible(empresa_id) AND usuario_id = app_usuario_id());
