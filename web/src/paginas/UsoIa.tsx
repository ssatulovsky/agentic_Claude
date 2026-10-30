import { useCallback, useEffect, useState } from 'react';
import { api, ErrorApi, type Empresa } from '../api';

interface Modelo {
  codigo: string;
  proveedor: string;
  local: boolean;
  descripcion: string;
  usd_por_millon_entrada: number | null;
  usd_por_millon_salida: number | null;
}
interface Politica {
  agente: string;
  nivel: string;
  especifica: boolean;
  cadena: string[];
}
interface Fila {
  empresa: string;
  agente: string;
  modelo: string;
  local: boolean;
  llamadas: number;
  fallidas: number;
  tokens_entrada: number;
  tokens_salida: number;
  costo_usd: number;
  costo_clp: number | null;
}
interface Reporte {
  filas: Fila[];
  total: { llamadas: number; tokens_entrada: number; tokens_salida: number; costo_usd: number; costo_clp: number | null };
  advertencias: string[];
  cupo: { usdMensual: number; alExceder: string; usadoUsd: number; excedido: boolean } | null;
}

const NIVELES: Record<string, string> = { PLATAFORMA: 'Plataforma', CLIENTE_ERP: 'Estudio (todas las empresas)', EMPRESA: 'Esta empresa' };
const hoy = () => new Date().toISOString().slice(0, 10);
const inicioMes = () => `${hoy().slice(0, 8)}01`;
const usd = (n: number) => `US$ ${n.toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const clp = (n: number | null) => (n === null ? '—' : `$ ${n.toLocaleString('es-CL')}`);

/** Modelos de IA por agente (con respaldo) y consumo de tokens y costo. */
export function UsoIa({ empresa }: { empresa: Empresa }) {
  const [modelos, setModelos] = useState<Modelo[]>([]);
  const [politicas, setPoliticas] = useState<{ politicas: Politica[]; puedeEditar: boolean } | null>(null);
  const [reporte, setReporte] = useState<Reporte | null>(null);
  const [rango, setRango] = useState({ desde: inicioMes(), hasta: hoy() });
  const [mensaje, setMensaje] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);
  const [edicion, setEdicion] = useState<{ agente: string; primario: string; respaldo: string; alcance: 'EMPRESA' | 'CLIENTE'; motivo: string } | null>(null);

  const cargar = useCallback(async () => {
    try {
      const [m, p] = await Promise.all([api.get<Modelo[]>('/ia/modelos'), api.get<{ politicas: Politica[]; puedeEditar: boolean }>(`/empresas/${empresa.id}/ia/politicas`)]);
      setModelos(m);
      setPoliticas(p);
    } catch (e) {
      setMensaje({ tipo: 'error', texto: e instanceof ErrorApi ? e.message : 'No se pudo cargar la configuración.' });
    }
    try {
      setReporte(await api.get<Reporte>(`/ia/uso?desde=${rango.desde}&hasta=${rango.hasta}&empresaId=${empresa.id}`));
    } catch (e) {
      setReporte(null);
      if (!(e instanceof ErrorApi && e.estado === 403)) setMensaje({ tipo: 'error', texto: e instanceof ErrorApi ? e.message : 'No se pudo cargar el consumo.' });
    }
  }, [empresa.id, rango]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const nombre = (codigo: string) => {
    const m = modelos.find((x) => x.codigo === codigo);
    return m ? `${codigo}${m.local ? ' (local)' : ''}` : codigo;
  };

  const guardar = async () => {
    if (!edicion) return;
    try {
      await api.put('/ia/politicas', {
        empresaId: edicion.alcance === 'EMPRESA' ? empresa.id : null,
        agente: edicion.agente,
        cadena: [edicion.primario, ...(edicion.respaldo && edicion.respaldo !== edicion.primario ? [edicion.respaldo] : [])],
        motivo: edicion.motivo,
      });
      setEdicion(null);
      setMensaje({ tipo: 'ok', texto: 'Configuración guardada.' });
      await cargar();
    } catch (e) {
      setMensaje({ tipo: 'error', texto: e instanceof ErrorApi ? e.message : 'No se pudo guardar.' });
    }
  };

  return (
    <section>
      <h2>Inteligencia artificial</h2>
      {mensaje && (
        <p className={mensaje.tipo === 'ok' ? 'exito' : 'error'} role={mensaje.tipo === 'ok' ? 'status' : 'alert'}>
          {mensaje.texto}
        </p>
      )}
      <h3>Modelos por agente</h3>
      <p className="pequeno">Cada agente usa el primer modelo; si no responde, pasa al de respaldo. Los modelos locales no envían datos fuera del servidor.</p>
      <table>
        <thead>
          <tr>
            <th>Agente</th>
            <th>Modelos (en orden)</th>
            <th>Definido para</th>
            <th>
              <span className="oculto">Acciones</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {politicas?.politicas.map((p) => (
            <tr key={p.agente}>
              <td>{p.agente}</td>
              <td>
                {edicion?.agente === p.agente ? (
                  <div className="grilla">
                    <label>
                      Principal
                      <select value={edicion.primario} onChange={(e) => setEdicion({ ...edicion, primario: e.target.value })}>
                        {modelos.map((m) => (
                          <option key={m.codigo} value={m.codigo}>
                            {nombre(m.codigo)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Respaldo
                      <select value={edicion.respaldo} onChange={(e) => setEdicion({ ...edicion, respaldo: e.target.value })}>
                        <option value="">Sin respaldo</option>
                        {modelos.map((m) => (
                          <option key={m.codigo} value={m.codigo}>
                            {nombre(m.codigo)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Aplicar a
                      <select value={edicion.alcance} onChange={(e) => setEdicion({ ...edicion, alcance: e.target.value as 'EMPRESA' | 'CLIENTE' })}>
                        <option value="EMPRESA">Solo {empresa.razon_social}</option>
                        <option value="CLIENTE">Todas las empresas del estudio</option>
                      </select>
                    </label>
                    <label>
                      Motivo
                      <input value={edicion.motivo} onChange={(e) => setEdicion({ ...edicion, motivo: e.target.value })} />
                    </label>
                  </div>
                ) : (
                  p.cadena.map(nombre).join(' → ')
                )}
              </td>
              <td>{NIVELES[p.nivel] ?? p.nivel}</td>
              <td className="acciones">
                {politicas.puedeEditar &&
                  (edicion?.agente === p.agente ? (
                    <>
                      <button onClick={() => void guardar()} disabled={edicion.motivo.trim().length < 5}>
                        Guardar
                      </button>
                      <button className="secundario" onClick={() => setEdicion(null)}>
                        Cancelar
                      </button>
                    </>
                  ) : (
                    <button
                      className="secundario"
                      onClick={() => setEdicion({ agente: p.agente, primario: p.cadena[0]!, respaldo: p.cadena[1] ?? '', alcance: 'EMPRESA', motivo: '' })}
                    >
                      Cambiar
                    </button>
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {reporte && (
        <>
          <div className="encabezado">
            <h3>Consumo de {empresa.razon_social}</h3>
            <div className="fila">
              <label>
                Desde
                <input type="date" value={rango.desde} onChange={(e) => setRango({ ...rango, desde: e.target.value })} />
              </label>
              <label>
                Hasta
                <input type="date" value={rango.hasta} onChange={(e) => setRango({ ...rango, hasta: e.target.value })} />
              </label>
            </div>
          </div>
          {reporte.cupo && (
            <p className={reporte.cupo.excedido ? 'error' : 'pequeno'}>
              Cupo mensual del estudio: {usd(reporte.cupo.usadoUsd)} de {usd(reporte.cupo.usdMensual)}
              {reporte.cupo.excedido && (reporte.cupo.alExceder === 'SOLO_LOCAL' ? '. Agotado: solo se usan modelos locales.' : '. Agotado: el exceso se factura aparte.')}
            </p>
          )}
          {reporte.advertencias.map((a) => (
            <p key={a} className="pequeno">
              {a}
            </p>
          ))}
          <table>
            <thead>
              <tr>
                <th>Agente</th>
                <th>Modelo</th>
                <th>Consultas</th>
                <th>Tokens (entrada / salida)</th>
                <th>Costo US$</th>
                <th>Costo $</th>
              </tr>
            </thead>
            <tbody>
              {reporte.filas.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <em>Sin consumo en el período.</em>
                  </td>
                </tr>
              )}
              {reporte.filas.map((f) => (
                <tr key={`${f.agente}-${f.modelo}`}>
                  <td>{f.agente}</td>
                  <td>{nombre(f.modelo)}</td>
                  <td>
                    {f.llamadas}
                    {f.fallidas > 0 && <span className="pequeno"> ({f.fallidas} sin respuesta)</span>}
                  </td>
                  <td>
                    {f.tokens_entrada.toLocaleString('es-CL')} / {f.tokens_salida.toLocaleString('es-CL')}
                  </td>
                  <td>{usd(f.costo_usd)}</td>
                  <td>{clp(f.costo_clp)}</td>
                </tr>
              ))}
              <tr className="total">
                <td colSpan={2}>Total</td>
                <td>{reporte.total.llamadas}</td>
                <td>
                  {reporte.total.tokens_entrada.toLocaleString('es-CL')} / {reporte.total.tokens_salida.toLocaleString('es-CL')}
                </td>
                <td>{usd(reporte.total.costo_usd)}</td>
                <td>{clp(reporte.total.costo_clp)}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
