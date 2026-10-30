import { useCallback, useEffect, useState } from 'react';
import { api, ErrorApi, type Empresa } from '../api';

interface Hallazgo {
  nivel: 'BLOQUEANTE' | 'OBSERVACION';
  codigo: string;
  mensaje: string;
}
interface Propuesta {
  id: string;
  agente_codigo: string;
  herramienta: string;
  resumen: string;
  estado: string;
  creado_en: string;
  vence_en: string;
  motivo: string | null;
  dictamen_contralor: 'CONFORME' | 'OBSERVADA' | null;
  hallazgos_contralor: Hallazgo[];
}

const ESTADOS: Record<string, string> = {
  PENDIENTE: 'Pendientes',
  EJECUTADA: 'Aprobadas',
  RECHAZADA: 'Rechazadas',
  FALLIDA: 'Fallidas',
  VENCIDA: 'Vencidas',
};
const fecha = (iso: string) => new Date(iso).toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short' });

/** Propuestas de los agentes, con el dictamen del Contralor; quien tiene el permiso las aprueba o rechaza. */
export function Propuestas({ empresa, puedeAprobar }: { empresa: Empresa; puedeAprobar: boolean }) {
  const [estado, setEstado] = useState('PENDIENTE');
  const [propuestas, setPropuestas] = useState<Propuesta[] | null>(null);
  const [motivos, setMotivos] = useState<Record<string, string>>({});
  const [mensaje, setMensaje] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);
  const [ocupada, setOcupada] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      setPropuestas(await api.get<Propuesta[]>(`/empresas/${empresa.id}/propuestas?estado=${estado}`));
    } catch (e) {
      setPropuestas([]);
      setMensaje({ tipo: 'error', texto: e instanceof ErrorApi ? e.message : 'No se pudieron cargar las propuestas.' });
    }
  }, [empresa.id, estado]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const resolver = async (p: Propuesta, decision: 'APROBAR' | 'RECHAZAR') => {
    setOcupada(p.id);
    setMensaje(null);
    try {
      const motivo = motivos[p.id]?.trim();
      const r = await api.post<{ estado: string; resultado?: { error?: string } }>(`/empresas/${empresa.id}/propuestas/${p.id}/resolver`, {
        decision,
        ...(motivo ? { motivo } : {}),
      });
      setMensaje(
        r.estado === 'FALLIDA'
          ? { tipo: 'error', texto: `No se pudo ejecutar: ${r.resultado?.error ?? 'error'}` }
          : { tipo: 'ok', texto: r.estado === 'EJECUTADA' ? 'Propuesta aprobada y ejecutada.' : r.estado === 'RECHAZADA' ? 'Propuesta rechazada.' : `Estado: ${r.estado}` },
      );
      await cargar();
    } catch (e) {
      setMensaje({ tipo: 'error', texto: e instanceof ErrorApi ? e.message : 'No se pudo resolver la propuesta.' });
    } finally {
      setOcupada(null);
    }
  };

  return (
    <section>
      <div className="encabezado">
        <div>
          <h2>Propuestas de los agentes</h2>
          <p className="pequeno">El Contralor revisa cada propuesta antes de que llegue aquí. Las que tienen observaciones se aprueban solo con un motivo.</p>
        </div>
        <select aria-label="Estado" value={estado} onChange={(e) => setEstado(e.target.value)}>
          {Object.entries(ESTADOS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {mensaje && (
        <p className={mensaje.tipo === 'ok' ? 'exito' : 'error'} role={mensaje.tipo === 'ok' ? 'status' : 'alert'}>
          {mensaje.texto}
        </p>
      )}
      {propuestas?.length === 0 && <p className="pequeno">No hay propuestas en este estado.</p>}
      {propuestas?.map((p) => (
        <article key={p.id} className="tarjeta">
          <p>
            <strong>{p.resumen}</strong>
          </p>
          <p className="pequeno">
            {p.agente_codigo} · {fecha(p.creado_en)}
            {p.estado === 'PENDIENTE' && ` · vence ${fecha(p.vence_en)}`}
          </p>
          {p.dictamen_contralor && (
            <div className={p.dictamen_contralor === 'CONFORME' ? 'exito' : 'aviso'}>
              <p>Contralor: {p.dictamen_contralor === 'CONFORME' ? 'conforme, sin observaciones' : 'con observaciones'}</p>
              {p.hallazgos_contralor.length > 0 && (
                <ul>
                  {p.hallazgos_contralor.map((h) => (
                    <li key={h.codigo}>{h.mensaje}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {p.motivo && <p className="pequeno">Motivo: {p.motivo}</p>}
          {p.estado === 'PENDIENTE' && puedeAprobar && (
            <div className="fila">
              <input
                aria-label="Motivo"
                placeholder={p.dictamen_contralor === 'OBSERVADA' ? 'Motivo (obligatorio para aprobar)' : 'Motivo (opcional)'}
                value={motivos[p.id] ?? ''}
                onChange={(e) => setMotivos({ ...motivos, [p.id]: e.target.value })}
                maxLength={500}
              />
              <button
                onClick={() => void resolver(p, 'APROBAR')}
                disabled={ocupada === p.id || (p.dictamen_contralor === 'OBSERVADA' && (motivos[p.id] ?? '').trim().length < 5)}
              >
                Aprobar
              </button>
              <button className="secundario" onClick={() => void resolver(p, 'RECHAZAR')} disabled={ocupada === p.id}>
                Rechazar
              </button>
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
