-- =============================================================================
-- 0007 · Carga inicial de normativa 2026
-- =============================================================================
-- Valores verificados el 29-10-2026 contra las fuentes indicadas en cada fila.
-- Criterios:
--   * Cuando se conoce la fecha legal de inicio, se usa esa fecha.
--   * Cuando solo se verificó el valor vigente en octubre de 2026, la vigencia
--     parte el 2026-10-01 y la nota lo dice. Un cálculo para una fecha anterior
--     falla en forma explícita en vez de usar un valor supuesto.
--   * Los parámetros que la ley ya fija con fecha de término (reforma
--     previsional) llevan esa fecha: pasado ese día, el sistema exige el valor nuevo.
--   * La aprobación inicial queda a nombre de la verificación documental y debe
--     ser ratificada por el contador responsable antes de la Fase 4.
-- =============================================================================

INSERT INTO parametros_legales
  (clave, valor, unidad, vigente_desde, vigente_hasta, fuente, url_fuente, nota, estado, cargado_por, aprobado_por)
VALUES
  -- Ingreso mínimo mensual
  ('IMM.GENERAL', 539000, 'CLP', '2026-01-01', '2026-05-01',
   'Ley 21.751', 'https://www.cnnchile.com/pais/sueldo-minimo-subira-a-539-mil-desde-enero-de-2026-sera-el-ultimo-reajuste-del-actual-gobierno/',
   'Trabajadores de 18 a 65 años. Fuente secundaria: reemplazar URL por la publicación en BCN.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('IMM.MENORES_18_MAYORES_65', 402082, 'CLP', '2026-01-01', '2026-05-01',
   'Ley 21.751', 'https://www.cnnchile.com/pais/sueldo-minimo-subira-a-539-mil-desde-enero-de-2026-sera-el-ultimo-reajuste-del-actual-gobierno/',
   'Fuente secundaria: reemplazar URL por la publicación en BCN.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('IMM.GENERAL', 553553, 'CLP', '2026-05-01', NULL,
   'Ley 21.830 (D.O. 22-06-2026, retroactiva al 01-05-2026); Indicadores Previred', 'https://www.previred.com/indicadores-previsionales/',
   'Trabajadores de 18 a 65 años.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('IMM.MENORES_18_MAYORES_65', 412938, 'CLP', '2026-05-01', NULL,
   'Ley 21.830; Indicadores Previred', 'https://www.previred.com/indicadores-previsionales/',
   NULL, 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('IMM.FINES_NO_REMUNERACIONALES', 356815, 'CLP', '2026-05-01', NULL,
   'Ley 21.830; Indicadores Previred', 'https://www.previred.com/indicadores-previsionales/',
   NULL, 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),

  -- Topes imponibles
  ('TOPE_IMPONIBLE.AFP_SALUD', 90, 'UF', '2026-02-01', NULL,
   'Superintendencia de Pensiones (vía Asociación de AFP)', 'https://www.aafp.cl/noticias/alza-topes-imponibles-2026-90-uf/',
   'Rige desde las remuneraciones de febrero 2026. También aplica a accidentes del trabajo.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('TOPE_IMPONIBLE.SEGURO_CESANTIA', 135.2, 'UF', '2026-02-01', NULL,
   'Superintendencia de Pensiones (vía Asociación de AFP)', 'https://www.aafp.cl/noticias/alza-topes-imponibles-2026-90-uf/',
   'Rige desde las remuneraciones de febrero 2026.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('TOPE_IMPONIBLE.IPS', 60, 'UF', '2026-10-01', NULL,
   'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/',
   'Valor verificado para octubre 2026; fecha de inicio por confirmar.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),

  -- Cotización obligatoria AFP de cargo del trabajador (10% + comisión)
  ('AFP.TASA_TRABAJADOR.CAPITAL',   11.44, 'PORCENTAJE', '2026-10-01', NULL, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/', 'Comisión revisable por la AFP; fecha de inicio por confirmar.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('AFP.TASA_TRABAJADOR.CUPRUM',    11.44, 'PORCENTAJE', '2026-10-01', NULL, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/', 'Comisión revisable por la AFP; fecha de inicio por confirmar.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('AFP.TASA_TRABAJADOR.HABITAT',   11.27, 'PORCENTAJE', '2026-10-01', NULL, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/', 'Comisión revisable por la AFP; fecha de inicio por confirmar.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('AFP.TASA_TRABAJADOR.PLANVITAL', 11.16, 'PORCENTAJE', '2026-10-01', NULL, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/', 'Comisión revisable por la AFP; fecha de inicio por confirmar.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('AFP.TASA_TRABAJADOR.PROVIDA',   11.45, 'PORCENTAJE', '2026-10-01', NULL, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/', 'Comisión revisable por la AFP; fecha de inicio por confirmar.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('AFP.TASA_TRABAJADOR.MODELO',    10.58, 'PORCENTAJE', '2026-10-01', NULL, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/', 'Comisión revisable por la AFP; fecha de inicio por confirmar.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('AFP.TASA_TRABAJADOR.UNO',       10.46, 'PORCENTAJE', '2026-10-01', NULL, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/', 'Comisión revisable por la AFP; fecha de inicio por confirmar.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),

  -- Cotización del empleador, Ley 21.735 (reforma de pensiones). Total ago-2026 a jul-2027: 3,5%.
  ('EMPLEADOR.CUENTA_INDIVIDUAL', 0.1, 'PORCENTAJE', '2025-08-01', '2027-08-01',
   'Ley 21.735; ChileAtiende', 'https://www.chileatiende.gob.cl/fichas/130987-aportes-del-empleador-al-sistema-de-pensiones',
   'Sube a 0,25% desde las remuneraciones de agosto 2027.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('EMPLEADOR.RENTABILIDAD_PROTEGIDA', 0.9, 'PORCENTAJE', '2026-08-01', '2027-08-01',
   'Ley 21.735; ChileAtiende', 'https://www.chileatiende.gob.cl/fichas/130987-aportes-del-empleador-al-sistema-de-pensiones',
   'Cotización con Rentabilidad Protegida. Sube a 1,5% desde agosto 2027.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('EMPLEADOR.EXPECTATIVA_VIDA', 0.72, 'PORCENTAJE', '2026-08-01', NULL,
   'Ley 21.735; Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/',
   'Compensación por expectativa de vida. Junto con el SIS suma 2,5%; revisar si cambia la tasa del SIS.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('EMPLEADOR.SIS', 1.78, 'PORCENTAJE', '2026-08-01', NULL,
   'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/',
   'Seguro de Invalidez y Sobrevivencia, financiado dentro del 3,5% desde agosto 2026. Revisar en cada licitación.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),

  -- Seguro de cesantía (sobre renta imponible)
  ('AFC.INDEFINIDO.TRABAJADOR', 0.6, 'PORCENTAJE', '2026-10-01', NULL, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/', 'Ley 19.728. Fecha de inicio por confirmar.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('AFC.INDEFINIDO.EMPLEADOR',  2.4, 'PORCENTAJE', '2026-10-01', NULL, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/', 'Ley 19.728. Fecha de inicio por confirmar.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('AFC.PLAZO_FIJO.EMPLEADOR',  3.0, 'PORCENTAJE', '2026-10-01', NULL, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/', 'Sin cotización del trabajador. Fecha de inicio por confirmar.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('AFC.INDEFINIDO_11_ANOS.EMPLEADOR', 0.8, 'PORCENTAJE', '2026-10-01', NULL, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/', 'Contrato indefinido de 11 años o más. Fecha de inicio por confirmar.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('AFC.CASA_PARTICULAR.EMPLEADOR', 3.0, 'PORCENTAJE', '2026-10-01', NULL, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/', 'Todo tipo de contrato. Fecha de inicio por confirmar.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),

  -- Salud
  ('SALUD.COTIZACION_OBLIGATORIA', 7, 'PORCENTAJE', '2026-10-01', NULL, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/', 'Fecha de inicio por confirmar.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('SALUD.DISTRIBUCION_CCAF', 4.2, 'PORCENTAJE', '2026-10-01', NULL, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/', 'Solo empleadores afiliados a CCAF; el resto (2,8%) va a FONASA.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('SALUD.DISTRIBUCION_FONASA_CON_CCAF', 2.8, 'PORCENTAJE', '2026-10-01', NULL, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/', 'Solo empleadores afiliados a CCAF.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),

  -- Gratificación legal, artículo 50 del Código del Trabajo
  ('GRATIFICACION.ART50.PORCENTAJE', 25, 'PORCENTAJE', '2026-01-01', NULL,
   'Código del Trabajo art. 50; Dirección del Trabajo Ord. 5020', 'https://www.dt.gob.cl/legislacion/1624/w3-article-113802.html',
   '25% de lo devengado en el período.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29'),
  ('GRATIFICACION.ART50.TOPE_IMM', 4.75, 'FACTOR', '2026-01-01', NULL,
   'Código del Trabajo art. 50; Dirección del Trabajo Ord. 5020', 'https://www.dt.gob.cl/legislacion/1624/w3-article-113802.html',
   'Tope anual de 4,75 ingresos mínimos, con el IMM vigente al 31 de diciembre; si el IMM se reajusta en el año, se recalcula la diferencia.', 'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29');

-- Impuesto único de segunda categoría, tabla mensual expresada en UTM.
INSERT INTO tablas_legales
  (clave, contenido, vigente_desde, vigente_hasta, fuente, url_fuente, nota, estado, cargado_por, aprobado_por)
VALUES
  ('IMPUESTO_UNICO.MENSUAL',
   '{"unidad": "UTM", "tramos": [
      {"desde": 0,    "hasta": 13.5, "factor": 0,     "rebaja": 0},
      {"desde": 13.5, "hasta": 30,   "factor": 0.04,  "rebaja": 0.54},
      {"desde": 30,   "hasta": 50,   "factor": 0.08,  "rebaja": 1.74},
      {"desde": 50,   "hasta": 70,   "factor": 0.135, "rebaja": 4.49},
      {"desde": 70,   "hasta": 90,   "factor": 0.23,  "rebaja": 11.14},
      {"desde": 90,   "hasta": 120,  "factor": 0.304, "rebaja": 17.8},
      {"desde": 120,  "hasta": 310,  "factor": 0.35,  "rebaja": 23.32},
      {"desde": 310,  "hasta": null, "factor": 0.40,  "rebaja": 38.82}
   ]}'::jsonb,
   '2026-10-01', NULL,
   'SII, tabla de impuesto único de segunda categoría (art. 43 LIR)', 'https://www.sii.cl/valores_y_fechas/impuesto_2da_categoria/impuesto2026.htm',
   'Cotejada contra la tabla en pesos de octubre 2026 con UTM $72.151 (todos los límites y rebajas coinciden). Extender hacia atrás tras verificar cada mes.',
   'APROBADO', 'migracion-0007', 'verificacion-documental-2026-10-29');

INSERT INTO indicadores_economicos (tipo, fecha, valor, fuente, url_fuente) VALUES
  ('UF',  '2026-09-30', 41057.20, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/'),
  ('UF',  '2026-10-31', 41247.63, 'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/'),
  ('UTM', '2026-10-01', 72151,    'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/'),
  ('UTA', '2026-10-01', 865812,   'Indicadores Previred octubre 2026', 'https://www.previred.com/indicadores-previsionales/');

SELECT bitacora_registrar(
  'SISTEMA', 'migracion-0007', 'normativa.carga_inicial', 'parametros_legales', NULL,
  jsonb_build_object(
    'parametros', (SELECT count(*) FROM parametros_legales),
    'tablas', (SELECT count(*) FROM tablas_legales),
    'indicadores', (SELECT count(*) FROM indicadores_economicos),
    'verificado_el', '2026-10-29'
  )
);
