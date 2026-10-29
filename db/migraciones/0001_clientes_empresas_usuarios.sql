-- =============================================================================
-- 0001 · Modelo de clientes del SaaS, usuarios, roles y suscripciones
-- =============================================================================
-- Jerarquía:
--   Cliente ERP (quien contrata la plataforma, p. ej. un estudio contable)
--     └── Empresas (la propia del cliente ERP y sus clientes ancla)
-- Cada empresa tiene su propia suscripción de módulos, que puede pagar el
-- Cliente ERP o la propia empresa.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Validación de RUT chileno (formato normalizado sin puntos: 12345678-K)
-- ---------------------------------------------------------------------------
CREATE FUNCTION rut_es_valido(p_rut text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  cuerpo text;
  dv     text;
  suma   int := 0;
  factor int := 2;
  resto  int;
  esperado text;
BEGIN
  IF p_rut !~ '^[0-9]{1,8}-[0-9K]$' THEN
    RETURN false;
  END IF;
  cuerpo := split_part(p_rut, '-', 1);
  dv     := split_part(p_rut, '-', 2);
  FOR i IN REVERSE length(cuerpo)..1 LOOP
    suma := suma + substr(cuerpo, i, 1)::int * factor;
    factor := CASE WHEN factor = 7 THEN 2 ELSE factor + 1 END;
  END LOOP;
  resto := 11 - (suma % 11);
  esperado := CASE resto WHEN 11 THEN '0' WHEN 10 THEN 'K' ELSE resto::text END;
  RETURN esperado = dv;
END;
$$;

-- ---------------------------------------------------------------------------
-- Clientes ERP y empresas
-- ---------------------------------------------------------------------------
CREATE TABLE clientes_erp (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rut           text NOT NULL UNIQUE CHECK (rut_es_valido(rut)),
  razon_social  text NOT NULL CHECK (length(trim(razon_social)) > 0),
  estado        text NOT NULL DEFAULT 'ACTIVO' CHECK (estado IN ('ACTIVO', 'SUSPENDIDO', 'BAJA')),
  creado_en     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE empresas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_erp_id  uuid NOT NULL REFERENCES clientes_erp(id),
  rut             text NOT NULL CHECK (rut_es_valido(rut)),
  razon_social    text NOT NULL CHECK (length(trim(razon_social)) > 0),
  giro            text,
  -- PROPIA: la empresa del propio Cliente ERP. ANCLA: cliente atendido por él.
  tipo            text NOT NULL CHECK (tipo IN ('PROPIA', 'ANCLA')),
  estado          text NOT NULL DEFAULT 'ACTIVA' CHECK (estado IN ('ACTIVA', 'SUSPENDIDA', 'BAJA')),
  creado_en       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cliente_erp_id, rut)
);
CREATE INDEX empresas_cliente_erp_idx ON empresas (cliente_erp_id);

-- ---------------------------------------------------------------------------
-- Módulos y suscripciones
-- ---------------------------------------------------------------------------
CREATE TABLE modulos (
  codigo       text PRIMARY KEY,
  nombre       text NOT NULL,
  descripcion  text NOT NULL
);

INSERT INTO modulos (codigo, nombre, descripcion) VALUES
  ('CONTABILIDAD',    'Contabilidad general',       'Plan de cuentas, asientos, mayor, balance, cierres y estados financieros'),
  ('TRIBUTARIO',      'Tributario',                 'RCV, F29, PPM, retenciones y declaraciones'),
  ('TESORERIA',       'Tesorería y bancos',         'Cuentas bancarias, cartolas y conciliación'),
  ('FLUJO_CAJA',      'Flujo de caja',              'Proyección de caja y escenarios'),
  ('VENTAS_COBRANZA', 'Ventas, facturación y cobranza', 'DTE, notas de crédito y débito, cartera y cobranza'),
  ('COMPRAS',         'Compras y cuentas por pagar', 'Solicitudes, cotizaciones, órdenes de compra y cuadratura'),
  ('INVENTARIO',      'Inventario y bodegas',       'Existencias, movimientos y valorización'),
  ('PRODUCCION',      'Producción y costos',        'Órdenes de producción y costeo NIC 2'),
  ('REMUNERACIONES',  'Remuneraciones y personas',  'Contratos, liquidaciones, Previred y LRE'),
  ('RENDICIONES',     'Rendiciones de gastos',      'Rendiciones, fondos por rendir y reembolsos'),
  ('ACTIVO_FIJO',     'Activo fijo',                'Altas, bajas y depreciación financiera y tributaria'),
  ('CANAL_WHATSAPP',  'Canal WhatsApp y voz',       'Consultas y aprobaciones por WhatsApp, texto y voz');

CREATE TABLE suscripciones_modulo (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid NOT NULL REFERENCES empresas(id),
  modulo_codigo  text NOT NULL REFERENCES modulos(codigo),
  pagador        text NOT NULL CHECK (pagador IN ('CLIENTE_ERP', 'EMPRESA')),
  vigente_desde  date NOT NULL,
  vigente_hasta  date,  -- exclusivo; NULL = sin término
  creado_en      timestamptz NOT NULL DEFAULT now(),
  CHECK (vigente_hasta IS NULL OR vigente_hasta > vigente_desde),
  -- Una empresa no puede tener dos suscripciones superpuestas del mismo módulo.
  EXCLUDE USING gist (
    empresa_id WITH =,
    modulo_codigo WITH =,
    daterange(vigente_desde, vigente_hasta, '[)') WITH &&
  )
);

-- ---------------------------------------------------------------------------
-- Roles y permisos (catálogo del sistema)
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  codigo       text PRIMARY KEY,
  nombre       text NOT NULL,
  descripcion  text NOT NULL
);

CREATE TABLE permisos (
  codigo       text PRIMARY KEY,
  descripcion  text NOT NULL
);

CREATE TABLE rol_permisos (
  rol_codigo      text NOT NULL REFERENCES roles(codigo) ON DELETE CASCADE,
  permiso_codigo  text NOT NULL REFERENCES permisos(codigo) ON DELETE CASCADE,
  PRIMARY KEY (rol_codigo, permiso_codigo)
);

-- ---------------------------------------------------------------------------
-- Usuarios, membresías y sesiones
-- ---------------------------------------------------------------------------
CREATE TABLE usuarios (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Cliente ERP bajo el cual existe la cuenta (también para usuarios de clientes ancla).
  cliente_erp_id        uuid NOT NULL REFERENCES clientes_erp(id),
  email                 text NOT NULL UNIQUE CHECK (email = lower(email) AND email LIKE '%_@_%'),
  nombre                text NOT NULL,
  password_hash         text NOT NULL,
  totp_secreto_cifrado  text,
  totp_activo           boolean NOT NULL DEFAULT false,
  totp_ultimo_paso      bigint,   -- último intervalo TOTP aceptado (impide reutilizar un código)
  telefono_whatsapp     text UNIQUE CHECK (telefono_whatsapp IS NULL OR telefono_whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  estado                text NOT NULL DEFAULT 'ACTIVO' CHECK (estado IN ('ACTIVO', 'INACTIVO')),
  intentos_fallidos     int NOT NULL DEFAULT 0,
  bloqueado_hasta       timestamptz,
  ultimo_login          timestamptz,
  creado_en             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usuarios_cliente_erp_idx ON usuarios (cliente_erp_id);

-- Acceso a una empresa específica con un rol.
CREATE TABLE membresias_empresa (
  usuario_id  uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  empresa_id  uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  rol_codigo  text NOT NULL REFERENCES roles(codigo),
  creado_en   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, empresa_id)
);

-- Acceso a TODAS las empresas de un Cliente ERP (personal del estudio contable).
CREATE TABLE membresias_cliente_erp (
  usuario_id      uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  cliente_erp_id  uuid NOT NULL REFERENCES clientes_erp(id) ON DELETE CASCADE,
  rol_codigo      text NOT NULL REFERENCES roles(codigo),
  creado_en       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, cliente_erp_id)
);

-- Un usuario solo puede tener acceso a empresas de su propio Cliente ERP.
CREATE FUNCTION validar_membresia_mismo_cliente() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cliente_usuario uuid;
  cliente_destino uuid;
BEGIN
  SELECT cliente_erp_id INTO cliente_usuario FROM usuarios WHERE id = NEW.usuario_id;
  IF TG_TABLE_NAME = 'membresias_empresa' THEN
    SELECT cliente_erp_id INTO cliente_destino FROM empresas WHERE id = NEW.empresa_id;
  ELSE
    cliente_destino := NEW.cliente_erp_id;
  END IF;
  IF cliente_usuario IS DISTINCT FROM cliente_destino THEN
    RAISE EXCEPTION 'El usuario % no pertenece al Cliente ERP de destino', NEW.usuario_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER membresias_empresa_mismo_cliente
  BEFORE INSERT OR UPDATE ON membresias_empresa
  FOR EACH ROW EXECUTE FUNCTION validar_membresia_mismo_cliente();

CREATE TRIGGER membresias_cliente_erp_mismo_cliente
  BEFORE INSERT OR UPDATE ON membresias_cliente_erp
  FOR EACH ROW EXECUTE FUNCTION validar_membresia_mismo_cliente();

CREATE TABLE sesiones (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash       bytea NOT NULL UNIQUE,   -- SHA-256 del token; el token nunca se guarda
  usuario_id       uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  mfa_verificada   boolean NOT NULL DEFAULT false,
  creada_en        timestamptz NOT NULL DEFAULT now(),
  ultimo_uso       timestamptz NOT NULL DEFAULT now(),
  expira_en        timestamptz NOT NULL,
  revocada_en      timestamptz,
  ip               inet,
  user_agent       text
);
CREATE INDEX sesiones_usuario_idx ON sesiones (usuario_id);
