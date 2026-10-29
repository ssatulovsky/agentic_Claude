-- =============================================================================
-- Preparación única del servidor PostgreSQL (la ejecuta un DBA con superusuario)
-- =============================================================================
-- Crea dos roles con responsabilidades separadas:
--   erp_owner : dueño del esquema. Solo lo usan las migraciones.
--   erp_auth  : rol exclusivo del servicio de autenticación (contraseñas y sesiones).
--   erp_app   : rol con el que corre la aplicación. NO es dueño de las tablas y
--               NO puede saltarse la seguridad por fila (NOBYPASSRLS), por lo que
--               el aislamiento entre empresas lo garantiza la base de datos aunque
--               la aplicación tenga un error.
--
-- Uso:
--   psql -U postgres -v owner_pass=... -v app_pass=... -v auth_pass=... -v db=erp -f db/bootstrap.sql
-- =============================================================================

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE erp_owner LOGIN PASSWORD %L', :'owner_pass')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_owner') \gexec

SELECT format('CREATE ROLE erp_app LOGIN NOBYPASSRLS PASSWORD %L', :'app_pass')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') \gexec

SELECT format('CREATE ROLE erp_auth LOGIN NOBYPASSRLS PASSWORD %L', :'auth_pass')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_auth') \gexec

SELECT format('CREATE DATABASE %I OWNER erp_owner ENCODING ''UTF8''', :'db')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec

\connect :db
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO erp_owner;
GRANT USAGE ON SCHEMA public TO erp_app, erp_auth;
