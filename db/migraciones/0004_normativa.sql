-- =============================================================================
-- 0004 · Motor de normativa: parámetros legales, tablas legales e indicadores
-- =============================================================================
-- Ningún valor legal se escribe en el código. Cada parámetro tiene vigencia
-- (desde inclusive, hasta exclusive), fuente oficial con URL, quién lo cargó y
-- quién lo aprobó. Solo los parámetros APROBADOS se usan en cálculos, y dos
-- valores aprobados de la misma clave no pueden superponerse en el tiempo.
-- =============================================================================

CREATE TABLE parametros_legales (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clave          text NOT NULL CHECK (clave ~ '^[A-Z0-9_.]+$'),
  valor          numeric NOT NULL,
  unidad         text NOT NULL CHECK (unidad IN ('PORCENTAJE', 'UF', 'UTM', 'CLP', 'FACTOR')),
  vigente_desde  date NOT NULL,
  vigente_hasta  date,
  fuente         text NOT NULL,
  url_fuente     text NOT NULL CHECK (url_fuente ~ '^https://'),
  nota           text,
  estado         text NOT NULL DEFAULT 'PROPUESTO' CHECK (estado IN ('PROPUESTO', 'APROBADO', 'RECHAZADO')),
  cargado_por    text NOT NULL,
  aprobado_por   text,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  CHECK (vigente_hasta IS NULL OR vigente_hasta > vigente_desde),
  CHECK (estado <> 'APROBADO' OR aprobado_por IS NOT NULL),
  EXCLUDE USING gist (
    clave WITH =,
    daterange(vigente_desde, vigente_hasta, '[)') WITH &&
  ) WHERE (estado = 'APROBADO')
);

-- Tablas con estructura (por ejemplo, tramos del impuesto único).
CREATE TABLE tablas_legales (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clave          text NOT NULL CHECK (clave ~ '^[A-Z0-9_.]+$'),
  contenido      jsonb NOT NULL,
  vigente_desde  date NOT NULL,
  vigente_hasta  date,
  fuente         text NOT NULL,
  url_fuente     text NOT NULL CHECK (url_fuente ~ '^https://'),
  nota           text,
  estado         text NOT NULL DEFAULT 'PROPUESTO' CHECK (estado IN ('PROPUESTO', 'APROBADO', 'RECHAZADO')),
  cargado_por    text NOT NULL,
  aprobado_por   text,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  CHECK (vigente_hasta IS NULL OR vigente_hasta > vigente_desde),
  CHECK (estado <> 'APROBADO' OR aprobado_por IS NOT NULL),
  EXCLUDE USING gist (
    clave WITH =,
    daterange(vigente_desde, vigente_hasta, '[)') WITH &&
  ) WHERE (estado = 'APROBADO')
);

-- UF (diaria), UTM y UTA (mensuales; se registran con el primer día del mes).
CREATE TABLE indicadores_economicos (
  tipo        text NOT NULL CHECK (tipo IN ('UF', 'UTM', 'UTA')),
  fecha       date NOT NULL,
  valor       numeric(14, 2) NOT NULL CHECK (valor > 0),
  fuente      text NOT NULL,
  url_fuente  text NOT NULL CHECK (url_fuente ~ '^https://'),
  cargado_en  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tipo, fecha),
  CHECK (tipo = 'UF' OR extract(day FROM fecha) = 1)
);

-- La aplicación solo lee. La carga y aprobación se hacen con el rol de
-- administración (migraciones o herramienta de normativa), y quedan en la bitácora.
GRANT SELECT ON parametros_legales, tablas_legales, indicadores_economicos TO erp_app;

-- Parámetro aprobado vigente en una fecha.
CREATE FUNCTION normativa_parametro(p_clave text, p_fecha date)
RETURNS parametros_legales
LANGUAGE sql STABLE AS $$
  SELECT * FROM parametros_legales
  WHERE clave = p_clave AND estado = 'APROBADO'
    AND daterange(vigente_desde, vigente_hasta, '[)') @> p_fecha
$$;

CREATE FUNCTION normativa_tabla(p_clave text, p_fecha date)
RETURNS tablas_legales
LANGUAGE sql STABLE AS $$
  SELECT * FROM tablas_legales
  WHERE clave = p_clave AND estado = 'APROBADO'
    AND daterange(vigente_desde, vigente_hasta, '[)') @> p_fecha
$$;

GRANT EXECUTE ON FUNCTION normativa_parametro(text, date), normativa_tabla(text, date) TO erp_app;
