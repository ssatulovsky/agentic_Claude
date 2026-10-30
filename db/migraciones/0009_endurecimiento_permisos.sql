-- =============================================================================
-- 0009 · Endurecimiento de permisos (revisión independiente de la Fase 1.1)
-- =============================================================================

-- 1) PostgreSQL concede EXECUTE a PUBLIC en toda función nueva. Se retira para
--    las existentes y para las futuras: cada rol recibe solo lo que se le concede
--    en forma explícita (erp_auth, por ejemplo, no puede usar funciones contables).
ALTER DEFAULT PRIVILEGES FOR ROLE erp_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION contabilidad_hoy() TO erp_app;

-- 2) El cargo de Director se asigna empresa por empresa, nunca a nivel de todo un
--    Cliente ERP (un director de un estudio no es director de sus clientes).
CREATE FUNCTION validar_rol_cliente_erp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rol_codigo = 'DIRECTOR' THEN
    RAISE EXCEPTION 'El cargo de Director se asigna por empresa, no a nivel del Cliente ERP'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER membresias_cliente_erp_sin_director
  BEFORE INSERT OR UPDATE ON membresias_cliente_erp
  FOR EACH ROW EXECUTE FUNCTION validar_rol_cliente_erp();

-- 3) Nadie se asigna roles a sí mismo: siempre lo hace otra persona.
ALTER POLICY membresias_empresa_crear ON membresias_empresa
  WITH CHECK (app_tiene_acceso_empresa(empresa_id)
              AND app_tiene_permiso_cliente('usuarios.administrar')
              AND usuario_id <> app_usuario_id());
ALTER POLICY membresias_cliente_crear ON membresias_cliente_erp
  WITH CHECK (cliente_erp_id = app_cliente_erp_id()
              AND app_tiene_permiso_cliente('usuarios.administrar')
              AND usuario_id <> app_usuario_id());
