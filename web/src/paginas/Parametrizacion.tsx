import { useCallback, useEffect, useState } from 'react';
import { api, ErrorApi, type Empresa, type Imputacion } from '../api';

interface Historial {
  cuenta: string;
  nombre: string;
  estado: string;
  motivo: string;
  registrado_en: string;
  registrado_por: string | null;
}

/**
 * Pantalla de parametrización contable: la cuenta a la que se imputa cada concepto
 * (clientes, retiros de socios, préstamos, comisiones bancarias, IVA, PPM...).
 * Cada cambio exige un motivo y queda en el historial.
 */
export function Parametrizacion({ empresa, puedeEditar }: { empresa: Empresa; puedeEditar: boolean }) {
  const [filas, setFilas] = useState<Imputacion[] | null>(null);
  const [cambios, setCambios] = useState<Record<string, { cuenta: string; motivo: string }>>({});
  const [historial, setHistorial] = useState<Record<string, Historial[]>>({});
  const [mensaje, setMensaje] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const cargar = useCallback(async () => {
    try {
      setFilas(await api.get<Imputacion[]>(`/empresas/${empresa.id}/imputaciones`));
    } catch (e) {
      setMensaje({ tipo: 'error', texto: e instanceof ErrorApi ? e.message : 'No se pudo cargar la parametrización.' });
    }
  }, [empresa.id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const accion = async (fn: () => Promise<string>) => {
    setOcupado(true);
    setMensaje(null);
    try {
      setMensaje({ tipo: 'ok', texto: await fn() });
      await cargar();
    } catch (e) {
      setMensaje({ tipo: 'error', texto: e instanceof ErrorApi ? e.message : 'Ocurrió un error.' });
    } finally {
      setOcupado(false);
    }
  };

  const cargarBase = () =>
    accion(async () => {
      const r = await api.post<{ cuentas_creadas: number; imputaciones_creadas: number; conceptos_sin_configurar: string[] }>(
        `/empresas/${empresa.id}/plan-cuentas/cargar-base`,
      );
      const faltan = r.conceptos_sin_configurar.length ? ` Configure a mano: ${r.conceptos_sin_configurar.join(', ')}.` : '';
      return `Se crearon ${r.cuentas_creadas} cuentas y ${r.imputaciones_creadas} imputaciones.${faltan}`;
    });

  const guardar = (concepto: string) =>
    accion(async () => {
      const c = cambios[concepto]!;
      await api.put(`/empresas/${empresa.id}/imputaciones/${concepto}`, { cuenta: c.cuenta, motivo: c.motivo });
      setCambios(({ [concepto]: _, ...resto }) => resto);
      setHistorial(({ [concepto]: _, ...resto }) => resto);
      return 'Imputación actualizada.';
    });

  const verHistorial = async (concepto: string) => {
    if (historial[concepto]) {
      setHistorial(({ [concepto]: _, ...resto }) => resto);
      return;
    }
    const h = await api.get<Historial[]>(`/empresas/${empresa.id}/imputaciones/${concepto}/historial`);
    setHistorial((x) => ({ ...x, [concepto]: h }));
  };

  if (!filas) return <p>{mensaje?.texto ?? 'Cargando…'}</p>;
  const sinConfigurar = filas.filter((f) => !f.cuenta).length;

  return (
    <section>
      <div className="encabezado">
        <div>
          <h2>Parametrización contable</h2>
          <p className="pequeno">
            Cuenta contable de cada concepto. Las reglas de conciliación y los asientos automáticos usan la cuenta vigente.
          </p>
        </div>
        {puedeEditar && sinConfigurar > 0 && (
          <button onClick={() => void cargarBase()} disabled={ocupado}>
            Cargar plan de cuentas base
          </button>
        )}
      </div>
      {mensaje && <p className={mensaje.tipo === 'ok' ? 'exito' : 'error'}>{mensaje.texto}</p>}
      <table>
        <thead>
          <tr>
            <th>Concepto</th>
            <th>Cuenta contable</th>
            <th>Motivo del cambio</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {filas.map((f) => {
            const cambio = cambios[f.concepto];
            const seleccion = cambio?.cuenta ?? f.cuenta?.codigo ?? '';
            return (
              <FilaConcepto
                key={f.concepto}
                fila={f}
                seleccion={seleccion}
                cambio={cambio}
                puedeEditar={puedeEditar}
                ocupado={ocupado}
                historial={historial[f.concepto]}
                alCambiarCuenta={(cuenta) =>
                  setCambios((x) =>
                    cuenta === f.cuenta?.codigo
                      ? (({ [f.concepto]: _, ...resto }) => resto)(x)
                      : { ...x, [f.concepto]: { cuenta, motivo: x[f.concepto]?.motivo ?? '' } },
                  )
                }
                alCambiarMotivo={(motivo) => setCambios((x) => ({ ...x, [f.concepto]: { cuenta: x[f.concepto]!.cuenta, motivo } }))}
                alGuardar={() => void guardar(f.concepto)}
                alVerHistorial={() => void verHistorial(f.concepto)}
              />
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function FilaConcepto(p: {
  fila: Imputacion;
  seleccion: string;
  cambio: { cuenta: string; motivo: string } | undefined;
  puedeEditar: boolean;
  ocupado: boolean;
  historial: Historial[] | undefined;
  alCambiarCuenta: (cuenta: string) => void;
  alCambiarMotivo: (motivo: string) => void;
  alGuardar: () => void;
  alVerHistorial: () => void;
}) {
  const { fila: f, cambio } = p;
  return (
    <>
      <tr className={cambio ? 'modificada' : ''}>
        <td>
          <strong>{f.nombre}</strong>
          <div className="pequeno">{f.descripcion}</div>
        </td>
        <td>
          {p.puedeEditar ? (
            <select value={p.seleccion} onChange={(e) => p.alCambiarCuenta(e.target.value)} aria-label={`Cuenta para ${f.nombre}`}>
              {!f.cuenta && <option value="">Sin configurar</option>}
              {f.opciones.map((o) => (
                <option key={o.codigo} value={o.codigo}>
                  {o.codigo} {o.nombre}
                </option>
              ))}
            </select>
          ) : f.cuenta ? (
            `${f.cuenta.codigo} ${f.cuenta.nombre}`
          ) : (
            <em>Sin configurar</em>
          )}
        </td>
        <td>
          {cambio && (
            <input
              placeholder="Por qué se cambia (obligatorio)"
              value={cambio.motivo}
              onChange={(e) => p.alCambiarMotivo(e.target.value)}
              aria-label={`Motivo del cambio de ${f.nombre}`}
            />
          )}
        </td>
        <td className="acciones">
          {cambio && (
            <button onClick={p.alGuardar} disabled={p.ocupado || cambio.motivo.trim().length < 5 || !cambio.cuenta}>
              Guardar
            </button>
          )}
          {f.cuenta && (
            <button className="secundario" onClick={p.alVerHistorial}>
              {p.historial ? 'Ocultar' : 'Historial'}
            </button>
          )}
        </td>
      </tr>
      {p.historial && (
        <tr className="historial">
          <td colSpan={4}>
            <ul>
              {p.historial.map((h, i) => (
                <li key={i}>
                  {new Date(h.registrado_en).toLocaleString('es-CL')}: {h.cuenta} {h.nombre} ({h.estado.toLowerCase()}) por{' '}
                  {h.registrado_por ?? 'sistema'}. {h.motivo}
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}
