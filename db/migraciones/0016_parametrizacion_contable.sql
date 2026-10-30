-- =============================================================================
-- 0016 · Parametrización contable: plan de cuentas base e imputaciones por concepto
-- =============================================================================
-- Pedido de la gerencia: las cuentas se configuran "según lógica", pero en una pantalla
-- de parametrización se puede cambiar la imputación.
--   * plan_cuentas_base: plan de cuentas tipo para una pyme chilena; se carga en una
--     empresa sin tocar las cuentas que ya tiene.
--   * conceptos_imputacion: catálogo de conceptos (clientes, retiros de socios, préstamos
--     por pagar, comisiones bancarias, IVA, PPM...) con las clasificaciones permitidas.
--   * imputaciones: cuenta contable de cada concepto en cada empresa, versionada con
--     motivo (no se borra). Las reglas de conciliación pueden apuntar a un concepto: si
--     cambia la imputación, la regla usa la cuenta nueva.
-- =============================================================================

CREATE TABLE plan_cuentas_base (
  codigo            text PRIMARY KEY CHECK (codigo ~ '^[0-9]+(\.[0-9]+)*$'),
  nombre            text NOT NULL,
  clasificacion     text NOT NULL CHECK (clasificacion IN ('ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'GASTO', 'ORDEN')),
  naturaleza        text NOT NULL CHECK (naturaleza IN ('DEUDORA', 'ACREEDORA')),
  imputable         boolean NOT NULL,
  requiere_tercero  boolean NOT NULL DEFAULT false,
  padre             text REFERENCES plan_cuentas_base(codigo)
);

INSERT INTO plan_cuentas_base (codigo, nombre, clasificacion, naturaleza, imputable, requiere_tercero, padre) VALUES
  ('1',      'Activo',                                   'ACTIVO',     'DEUDORA',   false, false, NULL),
  ('1.1',    'Activo corriente',                         'ACTIVO',     'DEUDORA',   false, false, '1'),
  ('1.1.01', 'Caja',                                     'ACTIVO',     'DEUDORA',   true,  false, '1.1'),
  ('1.1.02', 'Banco cuenta corriente',                   'ACTIVO',     'DEUDORA',   true,  false, '1.1'),
  ('1.1.03', 'Clientes',                                 'ACTIVO',     'DEUDORA',   true,  true,  '1.1'),
  ('1.1.04', 'Documentos por cobrar',                    'ACTIVO',     'DEUDORA',   true,  true,  '1.1'),
  ('1.1.05', 'IVA crédito fiscal',                       'ACTIVO',     'DEUDORA',   true,  false, '1.1'),
  ('1.1.06', 'Remanente de crédito fiscal',              'ACTIVO',     'DEUDORA',   true,  false, '1.1'),
  ('1.1.07', 'PPM por recuperar',                        'ACTIVO',     'DEUDORA',   true,  false, '1.1'),
  ('1.1.08', 'Préstamos por cobrar',                     'ACTIVO',     'DEUDORA',   true,  true,  '1.1'),
  ('1.1.09', 'Anticipos a proveedores',                  'ACTIVO',     'DEUDORA',   true,  true,  '1.1'),
  ('1.2',    'Activo no corriente',                      'ACTIVO',     'DEUDORA',   false, false, '1'),
  ('1.2.01', 'Muebles y equipos',                        'ACTIVO',     'DEUDORA',   true,  false, '1.2'),
  ('1.2.02', 'Equipos computacionales',                  'ACTIVO',     'DEUDORA',   true,  false, '1.2'),
  ('1.2.03', 'Depreciación acumulada',                   'ACTIVO',     'ACREEDORA', true,  false, '1.2'),
  ('2',      'Pasivo',                                   'PASIVO',     'ACREEDORA', false, false, NULL),
  ('2.1',    'Pasivo corriente',                         'PASIVO',     'ACREEDORA', false, false, '2'),
  ('2.1.01', 'Proveedores',                              'PASIVO',     'ACREEDORA', true,  true,  '2.1'),
  ('2.1.02', 'Honorarios por pagar',                     'PASIVO',     'ACREEDORA', true,  true,  '2.1'),
  ('2.1.03', 'Remuneraciones por pagar',                 'PASIVO',     'ACREEDORA', true,  true,  '2.1'),
  ('2.1.04', 'IVA débito fiscal',                        'PASIVO',     'ACREEDORA', true,  false, '2.1'),
  ('2.1.05', 'Retenciones por pagar',                    'PASIVO',     'ACREEDORA', true,  false, '2.1'),
  ('2.1.06', 'PPM por pagar',                            'PASIVO',     'ACREEDORA', true,  false, '2.1'),
  ('2.1.07', 'Cotizaciones previsionales por pagar',     'PASIVO',     'ACREEDORA', true,  false, '2.1'),
  ('2.1.08', 'Préstamos por pagar',                      'PASIVO',     'ACREEDORA', true,  true,  '2.1'),
  ('2.1.09', 'Cuenta corriente socios',                  'PASIVO',     'ACREEDORA', true,  true,  '2.1'),
  ('2.1.10', 'Préstamos bancarios de corto plazo',       'PASIVO',     'ACREEDORA', true,  true,  '2.1'),
  ('2.1.11', 'Impuesto a la renta por pagar',            'PASIVO',     'ACREEDORA', true,  false, '2.1'),
  ('2.1.12', 'Provisión de vacaciones',                  'PASIVO',     'ACREEDORA', true,  false, '2.1'),
  ('2.2',    'Pasivo no corriente',                      'PASIVO',     'ACREEDORA', false, false, '2'),
  ('2.2.01', 'Préstamos bancarios de largo plazo',       'PASIVO',     'ACREEDORA', true,  true,  '2.2'),
  ('3',      'Patrimonio',                               'PATRIMONIO', 'ACREEDORA', false, false, NULL),
  ('3.1',    'Patrimonio',                               'PATRIMONIO', 'ACREEDORA', false, false, '3'),
  ('3.1.01', 'Capital pagado',                           'PATRIMONIO', 'ACREEDORA', true,  false, '3.1'),
  ('3.1.02', 'Retiros de socios',                        'PATRIMONIO', 'DEUDORA',   true,  true,  '3.1'),
  ('3.1.03', 'Resultados acumulados',                    'PATRIMONIO', 'ACREEDORA', true,  false, '3.1'),
  ('3.1.04', 'Resultado del ejercicio',                  'PATRIMONIO', 'ACREEDORA', true,  false, '3.1'),
  ('4',      'Ingresos',                                 'INGRESO',    'ACREEDORA', false, false, NULL),
  ('4.1',    'Ingresos de explotación',                  'INGRESO',    'ACREEDORA', false, false, '4'),
  ('4.1.01', 'Ventas y servicios afectos',               'INGRESO',    'ACREEDORA', true,  false, '4.1'),
  ('4.1.02', 'Ventas y servicios exentos',               'INGRESO',    'ACREEDORA', true,  false, '4.1'),
  ('4.2',    'Otros ingresos',                           'INGRESO',    'ACREEDORA', false, false, '4'),
  ('4.2.01', 'Ingresos financieros',                     'INGRESO',    'ACREEDORA', true,  false, '4.2'),
  ('5',      'Gastos',                                   'GASTO',      'DEUDORA',   false, false, NULL),
  ('5.1',    'Gastos de operación',                      'GASTO',      'DEUDORA',   false, false, '5'),
  ('5.1.01', 'Remuneraciones',                           'GASTO',      'DEUDORA',   true,  false, '5.1'),
  ('5.1.02', 'Honorarios',                               'GASTO',      'DEUDORA',   true,  false, '5.1'),
  ('5.1.03', 'Arriendos',                                'GASTO',      'DEUDORA',   true,  false, '5.1'),
  ('5.1.04', 'Servicios básicos',                        'GASTO',      'DEUDORA',   true,  false, '5.1'),
  ('5.1.05', 'Gastos generales',                         'GASTO',      'DEUDORA',   true,  false, '5.1'),
  ('5.1.06', 'IVA no recuperable',                       'GASTO',      'DEUDORA',   true,  false, '5.1'),
  ('5.2',    'Gastos financieros',                       'GASTO',      'DEUDORA',   false, false, '5'),
  ('5.2.01', 'Gastos y comisiones bancarias',            'GASTO',      'DEUDORA',   true,  false, '5.2'),
  ('5.2.02', 'Intereses',                                'GASTO',      'DEUDORA',   true,  false, '5.2'),
  ('5.3',    'Otros gastos',                             'GASTO',      'DEUDORA',   false, false, '5'),
  ('5.3.01', 'Depreciación del ejercicio',               'GASTO',      'DEUDORA',   true,  false, '5.3'),
  ('5.3.02', 'Impuesto a la renta',                      'GASTO',      'DEUDORA',   true,  false, '5.3');

CREATE TABLE conceptos_imputacion (
  codigo          text PRIMARY KEY CHECK (codigo ~ '^[A-Z_]+$'),
  nombre          text NOT NULL,
  descripcion     text NOT NULL,
  clasificaciones text[] NOT NULL,
  -- Combinaciones "CLASIFICACION:NATURALEZA" admitidas (p. ej. una cuenta de clientes debe
  -- ser de activo y deudora; la depreciación acumulada, activo acreedora, no sirve).
  tipos           text[] NOT NULL,
  -- La cuenta debe exigir tercero (clientes, proveedores, préstamos, socios).
  exige_tercero   boolean NOT NULL,
  cuenta_base     text NOT NULL REFERENCES plan_cuentas_base(codigo),
  orden           int NOT NULL
);

INSERT INTO conceptos_imputacion (codigo, nombre, descripcion, clasificaciones, tipos, exige_tercero, cuenta_base, orden) VALUES
  ('CAJA',                     'Caja',                         'Efectivo de la empresa.',                                                   '{ACTIVO}',             '{ACTIVO:DEUDORA}',                                     false, '1.1.01', 10),
  ('CLIENTES',                 'Clientes',                     'Facturas de venta por cobrar; los cobros del banco se abonan aquí.',        '{ACTIVO}',             '{ACTIVO:DEUDORA}',                                     true,  '1.1.03', 20),
  ('IVA_CREDITO_FISCAL',       'IVA crédito fiscal',           'IVA de compras con derecho a crédito.',                                     '{ACTIVO}',             '{ACTIVO:DEUDORA}',                                     false, '1.1.05', 30),
  ('REMANENTE_CREDITO_FISCAL', 'Remanente de crédito fiscal',  'Crédito fiscal que pasa al mes siguiente (código 77 del F29).',              '{ACTIVO}',             '{ACTIVO:DEUDORA}',                                     false, '1.1.06', 40),
  ('PPM_POR_RECUPERAR',        'PPM por recuperar',            'Pagos provisionales mensuales, a imputar contra el impuesto anual.',         '{ACTIVO}',             '{ACTIVO:DEUDORA}',                                     false, '1.1.07', 50),
  ('PRESTAMOS_POR_COBRAR',     'Préstamos por cobrar',         'Préstamos que la empresa otorga a socios o terceros.',                      '{ACTIVO}',             '{ACTIVO:DEUDORA}',                                     true,  '1.1.08', 60),
  ('PROVEEDORES',              'Proveedores',                  'Facturas de compra por pagar; los pagos del banco se cargan aquí.',         '{PASIVO}',             '{PASIVO:ACREEDORA}',                                   true,  '2.1.01', 70),
  ('HONORARIOS_POR_PAGAR',     'Honorarios por pagar',         'Boletas de honorarios recibidas por pagar.',                                '{PASIVO}',             '{PASIVO:ACREEDORA}',                                   true,  '2.1.02', 80),
  ('IVA_DEBITO_FISCAL',        'IVA débito fiscal',            'IVA de las ventas afectas.',                                                '{PASIVO}',             '{PASIVO:ACREEDORA}',                                   false, '2.1.04', 90),
  ('RETENCIONES_POR_PAGAR',    'Retenciones por pagar',        'Retención de honorarios e impuesto único por enterar en el F29.',           '{PASIVO}',             '{PASIVO:ACREEDORA}',                                   false, '2.1.05', 100),
  ('PPM_POR_PAGAR',            'PPM por pagar',                'PPM del mes por enterar en el F29.',                                        '{PASIVO}',             '{PASIVO:ACREEDORA}',                                   false, '2.1.06', 110),
  ('PRESTAMOS_POR_PAGAR',      'Préstamos por pagar',          'Préstamos recibidos de socios o terceros; sus reintegros se cargan aquí.',  '{PASIVO}',             '{PASIVO:ACREEDORA}',                                   true,  '2.1.08', 120),
  ('CUENTA_CORRIENTE_SOCIOS',  'Cuenta corriente de socios',   'Movimientos de la cuenta corriente con los socios.',                        '{PASIVO,ACTIVO}',      '{PASIVO:ACREEDORA,ACTIVO:DEUDORA}',                    true,  '2.1.09', 130),
  ('RETIROS_SOCIOS',           'Retiros de socios',            'Retiros de utilidades de los socios (Pro Pyme Transparente). Se acumulan en el ejercicio: al cierre se traspasan contra resultados acumulados.',
                                                                                                                                             '{PATRIMONIO,PASIVO,ACTIVO}', '{PATRIMONIO:DEUDORA,PASIVO:ACREEDORA,ACTIVO:DEUDORA}', true, '3.1.02', 140),
  ('CAPITAL',                  'Capital',                      'Capital pagado.',                                                           '{PATRIMONIO}',         '{PATRIMONIO:ACREEDORA}',                               false, '3.1.01', 150),
  ('RESULTADOS_ACUMULADOS',    'Resultados acumulados',        'Utilidades o pérdidas de ejercicios anteriores.',                           '{PATRIMONIO}',         '{PATRIMONIO:ACREEDORA}',                               false, '3.1.03', 160),
  ('RESULTADO_EJERCICIO',      'Resultado del ejercicio',      'Utilidad o pérdida del ejercicio (cierre anual).',                          '{PATRIMONIO}',         '{PATRIMONIO:ACREEDORA}',                               false, '3.1.04', 170),
  ('VENTAS_AFECTAS',           'Ventas afectas',               'Ingresos por ventas y servicios afectos a IVA.',                            '{INGRESO}',            '{INGRESO:ACREEDORA}',                                  false, '4.1.01', 180),
  ('VENTAS_EXENTAS',           'Ventas exentas',               'Ingresos por ventas y servicios exentos.',                                  '{INGRESO}',            '{INGRESO:ACREEDORA}',                                  false, '4.1.02', 190),
  ('HONORARIOS',               'Honorarios (gasto)',           'Gasto por servicios de profesionales independientes.',                      '{GASTO}',              '{GASTO:DEUDORA}',                                      false, '5.1.02', 200),
  ('GASTOS_GENERALES',         'Gastos generales',             'Gastos de operación sin una cuenta específica.',                            '{GASTO}',              '{GASTO:DEUDORA}',                                      false, '5.1.05', 210),
  ('IVA_NO_RECUPERABLE',       'IVA no recuperable',           'IVA de compras sin derecho a crédito, que se lleva a gasto.',               '{GASTO}',              '{GASTO:DEUDORA}',                                      false, '5.1.06', 220),
  ('GASTOS_BANCARIOS',         'Gastos bancarios',             'Comisiones y gastos de las cuentas bancarias.',                             '{GASTO}',              '{GASTO:DEUDORA}',                                      false, '5.2.01', 230);

-- Una cuenta sirve para un concepto si su clasificación y naturaleza están admitidas y, si
-- el concepto lo exige, la cuenta pide tercero.
CREATE FUNCTION contabilidad_cuenta_sirve(c conceptos_imputacion, p plan_cuentas) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p.imputable AND p.activa
     AND (p.clasificacion || ':' || p.naturaleza) = ANY (c.tipos)
     AND (NOT c.exige_tercero OR p.requiere_tercero)
$$;

-- ---------------------------------------------------------------------------
-- Imputaciones por empresa
-- ---------------------------------------------------------------------------
CREATE TABLE imputaciones (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id          uuid NOT NULL REFERENCES empresas(id),
  concepto            text NOT NULL REFERENCES conceptos_imputacion(codigo),
  cuenta_contable_id  uuid NOT NULL REFERENCES plan_cuentas(id),
  estado              text NOT NULL DEFAULT 'VIGENTE' CHECK (estado IN ('VIGENTE', 'REEMPLAZADA')),
  motivo              text NOT NULL CHECK (length(trim(motivo)) >= 5),
  registrado_por      uuid NOT NULL REFERENCES usuarios(id),
  registrado_en       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX imputaciones_vigente_uq ON imputaciones (empresa_id, concepto) WHERE estado = 'VIGENTE';

CREATE FUNCTION imputacion_transicion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.estado <> 'VIGENTE' OR NEW.estado <> 'REEMPLAZADA'
     OR (to_jsonb(NEW) - 'estado') IS DISTINCT FROM (to_jsonb(OLD) - 'estado') THEN
    RAISE EXCEPTION 'Una imputación no se modifica ni se borra: se reemplaza con motivo' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER imputaciones_transicion BEFORE UPDATE OR DELETE ON imputaciones
  FOR EACH ROW EXECUTE FUNCTION imputacion_transicion();
CREATE TRIGGER imputaciones_sin_truncate BEFORE TRUNCATE ON imputaciones
  FOR EACH STATEMENT EXECUTE FUNCTION tributario_rechazar_cambios();

-- Cuenta vigente de un concepto (NULL si no está configurado).
CREATE FUNCTION contabilidad_cuenta_imputacion(p_empresa uuid, p_concepto text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT cuenta_contable_id FROM imputaciones WHERE empresa_id = p_empresa AND concepto = p_concepto AND estado = 'VIGENTE'
$$;

CREATE FUNCTION contabilidad_configurar_imputacion(p_empresa uuid, p_concepto text, p_cuenta text, p_motivo text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario uuid := contabilidad_exigir(p_empresa, 'contabilidad.plan_cuentas.editar');
  v_concepto conceptos_imputacion;
  v_cuenta plan_cuentas;
  v_anterior imputaciones;
  v_id bigint;
BEGIN
  IF tributario_es_agente() THEN
    RAISE EXCEPTION 'La parametrización contable la cambia una persona' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_concepto FROM conceptos_imputacion WHERE codigo = p_concepto;
  IF v_concepto.codigo IS NULL THEN
    RAISE EXCEPTION 'Concepto de imputación desconocido: %', p_concepto USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_cuenta FROM plan_cuentas WHERE empresa_id = p_empresa AND codigo = p_cuenta;
  IF v_cuenta.id IS NULL OR NOT v_cuenta.imputable OR NOT v_cuenta.activa THEN
    RAISE EXCEPTION 'La cuenta % debe existir, ser imputable y estar activa', p_cuenta USING ERRCODE = 'check_violation';
  END IF;
  IF NOT contabilidad_cuenta_sirve(v_concepto, v_cuenta) THEN
    RAISE EXCEPTION 'El concepto % debe imputarse a una cuenta de % (%)%', v_concepto.nombre,
      array_to_string(v_concepto.clasificaciones, ' o '), lower(replace(array_to_string(v_concepto.tipos, ', '), ':', ' ')),
      CASE WHEN v_concepto.exige_tercero THEN ' que exija tercero' ELSE '' END
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_cuenta.requiere_tercero AND EXISTS (SELECT 1 FROM reglas_conciliacion r WHERE r.empresa_id = p_empresa
       AND r.concepto = p_concepto AND r.activa AND r.tercero_id IS NULL) THEN
    RAISE EXCEPTION 'La cuenta % exige tercero y hay reglas de conciliación de este concepto sin tercero: %', p_cuenta,
      (SELECT string_agg(r.nombre, ', ' ORDER BY r.nombre) FROM reglas_conciliacion r WHERE r.empresa_id = p_empresa
         AND r.concepto = p_concepto AND r.activa AND r.tercero_id IS NULL)
      USING ERRCODE = 'check_violation';
  END IF;
  IF length(trim(coalesce(p_motivo, ''))) < 5 THEN
    RAISE EXCEPTION 'Indique el motivo del cambio' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('imputacion:' || p_empresa::text || ':' || p_concepto, 0));
  SELECT * INTO v_anterior FROM imputaciones WHERE empresa_id = p_empresa AND concepto = p_concepto AND estado = 'VIGENTE' FOR UPDATE;
  IF v_anterior.cuenta_contable_id = v_cuenta.id THEN
    RETURN v_anterior.id;
  END IF;
  IF v_anterior.id IS NOT NULL THEN
    UPDATE imputaciones SET estado = 'REEMPLAZADA' WHERE id = v_anterior.id;
  END IF;
  INSERT INTO imputaciones (empresa_id, concepto, cuenta_contable_id, motivo, registrado_por)
  VALUES (p_empresa, p_concepto, v_cuenta.id, trim(p_motivo), v_usuario)
  RETURNING id INTO v_id;
  PERFORM contabilidad_auditar('IMPUTACION_CONFIGURADA', 'imputaciones', v_id::text,
    jsonb_build_object('concepto', p_concepto, 'cuenta', p_cuenta,
                       'cuenta_anterior', (SELECT codigo FROM plan_cuentas WHERE id = v_anterior.cuenta_contable_id),
                       'motivo', trim(p_motivo)), p_empresa);
  RETURN v_id;
END;
$$;

-- Carga el plan base en la empresa: crea las cuentas que faltan (respeta las existentes)
-- y las imputaciones de los conceptos que no estén configurados.
CREATE FUNCTION contabilidad_cargar_plan_base(p_empresa uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario uuid := contabilidad_exigir(p_empresa, 'contabilidad.plan_cuentas.editar');
  v_base plan_cuentas_base;
  v_cuentas int := 0;
  v_imputaciones int := 0;
  v_omitidos jsonb := '[]';
  v_concepto conceptos_imputacion;
  v_cuenta plan_cuentas;
  v_creadas text[] := '{}';
BEGIN
  IF tributario_es_agente() THEN
    RAISE EXCEPTION 'El plan de cuentas lo carga una persona' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('plan-base:' || p_empresa::text, 0));
  -- Padres antes que hijos.
  FOR v_base IN SELECT * FROM plan_cuentas_base ORDER BY array_length(string_to_array(codigo, '.'), 1), codigo LOOP
    IF NOT EXISTS (SELECT 1 FROM plan_cuentas WHERE empresa_id = p_empresa AND codigo = v_base.codigo) THEN
      INSERT INTO plan_cuentas (empresa_id, codigo, nombre, clasificacion, naturaleza, imputable, requiere_tercero, padre_id)
      VALUES (p_empresa, v_base.codigo, v_base.nombre, v_base.clasificacion, v_base.naturaleza, v_base.imputable,
              v_base.requiere_tercero,
              (SELECT id FROM plan_cuentas WHERE empresa_id = p_empresa AND codigo = v_base.padre));
      v_cuentas := v_cuentas + 1;
      v_creadas := v_creadas || v_base.codigo;
    END IF;
  END LOOP;

  FOR v_concepto IN SELECT * FROM conceptos_imputacion ORDER BY orden LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM imputaciones WHERE empresa_id = p_empresa AND concepto = v_concepto.codigo AND estado = 'VIGENTE');
    SELECT * INTO v_cuenta FROM plan_cuentas WHERE empresa_id = p_empresa AND codigo = v_concepto.cuenta_base;
    -- Solo se imputa automáticamente a una cuenta recién creada desde el plan base, o a una
    -- que ya existía con el mismo nombre. Si la empresa usa ese código para otra cosa, el
    -- concepto se deja para configurar a mano.
    IF v_cuenta.id IS NULL OR NOT contabilidad_cuenta_sirve(v_concepto, v_cuenta)
       OR NOT (v_cuenta.codigo = ANY (v_creadas)
               OR lower(trim(v_cuenta.nombre)) = lower((SELECT b.nombre FROM plan_cuentas_base b WHERE b.codigo = v_concepto.cuenta_base))) THEN
      v_omitidos := v_omitidos || to_jsonb(v_concepto.codigo);
      CONTINUE;
    END IF;
    INSERT INTO imputaciones (empresa_id, concepto, cuenta_contable_id, motivo, registrado_por)
    VALUES (p_empresa, v_concepto.codigo, v_cuenta.id, 'Imputación inicial del plan base', v_usuario);
    v_imputaciones := v_imputaciones + 1;
  END LOOP;

  PERFORM contabilidad_auditar('PLAN_BASE_CARGADO', 'plan_cuentas', p_empresa::text,
    jsonb_build_object('cuentas_creadas', v_cuentas, 'imputaciones_creadas', v_imputaciones, 'conceptos_sin_configurar', v_omitidos),
    p_empresa);
  RETURN jsonb_build_object('cuentas_creadas', v_cuentas, 'imputaciones_creadas', v_imputaciones, 'conceptos_sin_configurar', v_omitidos);
END;
$$;

-- Una cuenta con una imputación vigente no se desactiva: primero se cambia la imputación.
CREATE FUNCTION plan_cuentas_proteger_imputada() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_conceptos text;
BEGIN
  IF OLD.activa AND NOT NEW.activa THEN
    SELECT string_agg(c.nombre, ', ' ORDER BY c.orden) INTO v_conceptos
    FROM imputaciones i JOIN conceptos_imputacion c ON c.codigo = i.concepto
    WHERE i.cuenta_contable_id = OLD.id AND i.estado = 'VIGENTE';
    IF v_conceptos IS NOT NULL THEN
      RAISE EXCEPTION 'La cuenta % está asignada a: %. Cambie esas imputaciones antes de desactivarla', OLD.codigo, v_conceptos
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER plan_cuentas_proteger_imputada BEFORE UPDATE OF activa ON plan_cuentas
  FOR EACH ROW EXECUTE FUNCTION plan_cuentas_proteger_imputada();

-- ---------------------------------------------------------------------------
-- Reglas de conciliación por concepto
-- ---------------------------------------------------------------------------
ALTER TABLE reglas_conciliacion
  ADD COLUMN concepto text REFERENCES conceptos_imputacion(codigo),
  ALTER COLUMN cuenta_contable_id DROP NOT NULL,
  ADD CONSTRAINT reglas_conciliacion_destino_check CHECK ((cuenta_contable_id IS NULL) <> (concepto IS NULL));

DROP FUNCTION tesoreria_crear_regla(uuid, uuid, text, text, text, text, text, text, text);

-- p_destino: código de una cuenta contable ("2.1.08") o de un concepto ("PRESTAMOS_POR_PAGAR").
CREATE FUNCTION tesoreria_crear_regla(p_empresa uuid, p_cuenta uuid, p_nombre text, p_rut text, p_texto text, p_sentido text,
  p_destino text, p_tercero_rut text, p_glosa text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_usuario uuid := tesoreria_exigir(p_empresa, 'tesoreria.cuentas.administrar');
  v_cuenta plan_cuentas;
  v_concepto text;
  v_tercero uuid;
  v_id uuid := gen_random_uuid();
BEGIN
  IF tributario_es_agente() THEN
    RAISE EXCEPTION 'Las reglas de clasificación las crea una persona' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_cuenta IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cuentas_bancarias WHERE id = p_cuenta AND empresa_id = p_empresa) THEN
    RAISE EXCEPTION 'Cuenta bancaria no encontrada' USING ERRCODE = 'check_violation';
  END IF;
  IF p_destino ~ '^[A-Z_]+$' THEN
    IF NOT EXISTS (SELECT 1 FROM conceptos_imputacion WHERE codigo = p_destino) THEN
      RAISE EXCEPTION 'Concepto de imputación desconocido: %', p_destino USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_cuenta FROM plan_cuentas WHERE id = contabilidad_cuenta_imputacion(p_empresa, p_destino);
    IF v_cuenta.id IS NULL THEN
      RAISE EXCEPTION 'El concepto % no tiene cuenta contable configurada', p_destino USING ERRCODE = 'check_violation';
    END IF;
    v_concepto := p_destino;
  ELSE
    SELECT * INTO v_cuenta FROM plan_cuentas WHERE empresa_id = p_empresa AND codigo = p_destino;
  END IF;
  IF v_cuenta.id IS NULL OR NOT v_cuenta.imputable OR NOT v_cuenta.activa THEN
    RAISE EXCEPTION 'La cuenta contable % debe existir, ser imputable y estar activa', p_destino USING ERRCODE = 'check_violation';
  END IF;
  IF p_tercero_rut IS NOT NULL THEN
    SELECT id INTO v_tercero FROM terceros WHERE empresa_id = p_empresa AND rut = p_tercero_rut;
    IF v_tercero IS NULL THEN
      RAISE EXCEPTION 'El tercero % no existe en la empresa', p_tercero_rut USING ERRCODE = 'check_violation';
    END IF;
  ELSIF v_cuenta.requiere_tercero THEN
    RAISE EXCEPTION 'La cuenta % exige un tercero: indíquelo en la regla', v_cuenta.codigo USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO reglas_conciliacion (id, empresa_id, cuenta_id, nombre, rut_contraparte, texto, sentido, cuenta_contable_id,
    concepto, tercero_id, glosa, creado_por)
  VALUES (v_id, p_empresa, p_cuenta, trim(p_nombre), p_rut, nullif(trim(coalesce(p_texto, '')), ''), p_sentido,
    CASE WHEN v_concepto IS NULL THEN v_cuenta.id END, v_concepto, v_tercero, trim(p_glosa), v_usuario);
  PERFORM contabilidad_auditar('REGLA_CONCILIACION_CREADA', 'reglas_conciliacion', v_id::text,
    jsonb_build_object('nombre', p_nombre, 'rut', p_rut, 'texto', p_texto, 'sentido', p_sentido,
                       'destino', p_destino, 'tercero', p_tercero_rut), p_empresa);
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Lectura y permisos
-- ---------------------------------------------------------------------------
ALTER TABLE imputaciones ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON plan_cuentas_base, conceptos_imputacion, imputaciones TO erp_app;
CREATE POLICY imputaciones_ver ON imputaciones FOR SELECT TO erp_app
  USING (app_fila_visible(empresa_id) AND app_tiene_permiso(empresa_id, 'contabilidad.plan_cuentas.ver'));

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  contabilidad_cuenta_sirve(conceptos_imputacion, plan_cuentas),
  contabilidad_configurar_imputacion(uuid, text, text, text),
  contabilidad_cargar_plan_base(uuid),
  tesoreria_crear_regla(uuid, uuid, text, text, text, text, text, text, text)
TO erp_app;
