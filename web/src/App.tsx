import { useCallback, useEffect, useState } from 'react';
import { api, ErrorApi, type Empresa, type Yo } from './api';
import { Ingreso } from './paginas/Ingreso';
import { Parametrizacion } from './paginas/Parametrizacion';
import { ReglasConciliacion } from './paginas/ReglasConciliacion';

type Pagina = 'parametrizacion' | 'reglas';

export function App() {
  const [yo, setYo] = useState<Yo | null>(null);
  const [cargando, setCargando] = useState(true);
  const [empresa, setEmpresa] = useState<Empresa | null>(null);
  const [permisos, setPermisos] = useState<Set<string>>(new Set());
  const [pagina, setPagina] = useState<Pagina>('parametrizacion');

  const cargarYo = useCallback(async () => {
    try {
      const datos = await api.get<Yo>('/yo');
      setYo(datos);
      // Se recuerda la última empresa elegida en este navegador (solo como comodidad).
      let recordada: string | null = null;
      try {
        recordada = localStorage.getItem('erp.empresa');
      } catch {
        recordada = null;
      }
      setEmpresa((actual) => actual ?? datos.empresas.find((x) => x.id === recordada) ?? datos.empresas[0] ?? null);
    } catch (e) {
      if (!(e instanceof ErrorApi && e.estado === 401)) throw e;
      setYo(null);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargarYo();
  }, [cargarYo]);

  useEffect(() => {
    if (!empresa) return;
    api
      .get<{ permisos: string[] }>(`/empresas/${empresa.id}/permisos`)
      .then((p) => setPermisos(new Set(p.permisos)))
      .catch(() => setPermisos(new Set()));
  }, [empresa]);

  if (cargando) return <p className="centro">Cargando…</p>;
  if (!yo) return <Ingreso alIngresar={cargarYo} />;

  const salir = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setYo(null);
    setEmpresa(null);
  };

  return (
    <div className="marco">
      <header className="barra">
        <strong className="marca">ERP Agéntico</strong>
        <nav>
          <button className={pagina === 'parametrizacion' ? 'activo' : ''} onClick={() => setPagina('parametrizacion')}>
            Parametrización contable
          </button>
          <button className={pagina === 'reglas' ? 'activo' : ''} onClick={() => setPagina('reglas')}>
            Reglas de conciliación
          </button>
        </nav>
        <div className="sesion">
          <select
            aria-label="Empresa"
            value={empresa?.id ?? ''}
            onChange={(e) => {
              setEmpresa(yo.empresas.find((x) => x.id === e.target.value) ?? null);
              try {
                localStorage.setItem('erp.empresa', e.target.value);
              } catch {
                // sin almacenamiento local: no se recuerda la elección
              }
            }}
          >
            {yo.empresas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.razon_social} ({e.rut})
              </option>
            ))}
          </select>
          <span className="usuario">{yo.usuario.nombre}</span>
          <button className="secundario" onClick={() => void salir()}>
            Salir
          </button>
        </div>
      </header>
      <main>
        {!empresa ? (
          <p>No tiene empresas asignadas.</p>
        ) : pagina === 'parametrizacion' ? (
          <Parametrizacion key={empresa.id} empresa={empresa} puedeEditar={permisos.has('contabilidad.plan_cuentas.editar')} />
        ) : (
          <ReglasConciliacion key={empresa.id} empresa={empresa} puedeEditar={permisos.has('tesoreria.cuentas.administrar')} />
        )}
      </main>
    </div>
  );
}
