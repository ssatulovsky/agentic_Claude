import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ErrorApi, type Empresa } from '../api';

interface Agente {
  codigo: string;
  cargo: string;
  descripcion: string;
}
interface Intento {
  modelo: string;
  resultado: string;
  datosProtegidos?: number;
}
interface Mensaje {
  autor: 'persona' | 'agente' | 'error';
  texto: string;
  intentos?: Intento[];
}

/**
 * Conversación con los agentes. Cada agente responde con los permisos de quien pregunta;
 * las acciones que modifican datos quedan como propuestas para aprobar.
 */
export function Asistentes({ empresa }: { empresa: Empresa }) {
  const [agentes, setAgentes] = useState<Agente[]>([]);
  const [agente, setAgente] = useState('GERENTE_VIRTUAL');
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [conversacionId, setConversacionId] = useState<string | null>(null);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const final = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<Agente[]>('/agentes').then(setAgentes).catch(() => setAgentes([]));
  }, []);
  useEffect(() => {
    final.current?.scrollIntoView?.({ block: 'end' });
  }, [mensajes]);

  const nueva = (codigo = agente) => {
    setAgente(codigo);
    setMensajes([]);
    setConversacionId(null);
  };

  const enviar = async (ev: FormEvent) => {
    ev.preventDefault();
    const pregunta = texto.trim();
    if (!pregunta) return;
    setTexto('');
    setMensajes((m) => [...m, { autor: 'persona', texto: pregunta }]);
    setEnviando(true);
    try {
      const r = await api.post<{ conversacionId: string; respuesta: string; modelos: Intento[] }>(
        `/empresas/${empresa.id}/agentes/${agente}/conversar`,
        { mensaje: pregunta, ...(conversacionId ? { conversacionId } : {}) },
      );
      setConversacionId(r.conversacionId);
      setMensajes((m) => [...m, { autor: 'agente', texto: r.respuesta, intentos: r.modelos }]);
    } catch (e) {
      setMensajes((m) => [...m, { autor: 'error', texto: e instanceof ErrorApi ? e.message : 'No se pudo conectar con el servidor.' }]);
    } finally {
      setEnviando(false);
    }
  };

  const actual = agentes.find((a) => a.codigo === agente);
  return (
    <section className="chat">
      <div className="encabezado">
        <div>
          <h2>Asistentes</h2>
          <p className="pequeno">{actual?.descripcion ?? 'Consultas a los agentes de la empresa.'}</p>
        </div>
        <div className="fila">
          <select aria-label="Agente" value={agente} onChange={(e) => nueva(e.target.value)}>
            {agentes.map((a) => (
              <option key={a.codigo} value={a.codigo}>
                {a.cargo}
              </option>
            ))}
          </select>
          <button className="secundario" onClick={() => nueva()} disabled={mensajes.length === 0}>
            Nueva conversación
          </button>
        </div>
      </div>
      <div className="mensajes" aria-live="polite">
        {mensajes.length === 0 && <p className="pequeno">Escriba su consulta. Ejemplo: “¿Cuánto IVA debo pagar en octubre?”</p>}
        {mensajes.map((m, i) => (
          <div key={i} className={`mensaje ${m.autor}`}>
            <p>{m.texto}</p>
            {m.intentos && (
              <p className="pequeno">
                Modelo: {m.intentos.find((x) => x.resultado === 'OK')?.modelo ?? '—'}
                {m.intentos.some((x) => x.datosProtegidos) && ' · se protegieron datos sensibles antes de enviarlos'}
              </p>
            )}
          </div>
        ))}
        {enviando && <p className="pequeno">El agente está trabajando…</p>}
        <div ref={final} />
      </div>
      <form className="fila" onSubmit={(ev) => void enviar(ev)}>
        <input aria-label="Su consulta" value={texto} onChange={(e) => setTexto(e.target.value)} maxLength={4000} placeholder="Escriba su consulta" />
        <button type="submit" disabled={enviando || !texto.trim()}>
          Enviar
        </button>
      </form>
      <p className="pequeno">No escriba contraseñas ni claves: los agentes nunca las necesitan y un mensaje que las incluya no se envía.</p>
    </section>
  );
}
