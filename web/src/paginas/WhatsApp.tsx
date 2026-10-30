import { useCallback, useEffect, useState } from 'react';
import { api, ErrorApi } from '../api';

interface Estado {
  canalConfigurado: boolean;
  numeroErp: string | null;
  telefonoRegistrado: string | null;
  vinculo: { telefono: string; estado: string; verificado_en: string | null; vence_en: string | null } | null;
}
interface Canal {
  configurado: boolean;
  estado: 'CONECTADO' | 'DESCONECTADO' | 'SIN_DATOS';
  detalle: string | null;
  ultimo_latido: string | null;
}

const ESTADOS: Record<string, string> = {
  VERIFICADO: 'Vinculado',
  PENDIENTE: 'Esperando el código desde su teléfono',
  CODIGO_VENCIDO: 'El código venció: genere uno nuevo',
  VENCIDO: 'El vínculo venció: vincule de nuevo',
  REVOCADO: 'Desvinculado',
};
const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** Vincular el WhatsApp propio y, para administradores, ver el estado de la conexión. */
export function WhatsApp() {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [canal, setCanal] = useState<Canal | null>(null);
  const [codigo, setCodigo] = useState<{ codigo: string; instruccion: string; numeroErp: string | null } | null>(null);
  const [mensaje, setMensaje] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);

  const cargar = useCallback(async () => {
    try {
      setEstado(await api.get<Estado>('/yo/whatsapp'));
    } catch (e) {
      setMensaje({ tipo: 'error', texto: e instanceof ErrorApi ? e.message : 'No se pudo cargar.' });
    }
    try {
      setCanal(await api.get<Canal>('/canales/whatsapp/estado'));
    } catch {
      setCanal(null); // Solo administradores.
    }
  }, []);
  useEffect(() => {
    void cargar();
  }, [cargar]);

  const vincular = async () => {
    setMensaje(null);
    try {
      setCodigo(await api.post('/yo/whatsapp/vincular'));
      await cargar();
    } catch (e) {
      setMensaje({ tipo: 'error', texto: e instanceof ErrorApi ? e.message : 'No se pudo generar el código.' });
    }
  };
  const desvincular = async () => {
    try {
      await api.post('/yo/whatsapp/desvincular');
      setCodigo(null);
      setMensaje({ tipo: 'ok', texto: 'Su WhatsApp quedó desvinculado.' });
      await cargar();
    } catch (e) {
      setMensaje({ tipo: 'error', texto: e instanceof ErrorApi ? e.message : 'No se pudo desvincular.' });
    }
  };

  const vinculado = estado?.vinculo?.estado === 'VERIFICADO';
  return (
    <section>
      <h2>WhatsApp</h2>
      <p className="pequeno">
        Converse con los agentes desde WhatsApp, por texto o nota de voz, con los mismos permisos que en la web. Las aprobaciones se hacen siempre en la web.
      </p>
      {mensaje && (
        <p className={mensaje.tipo === 'ok' ? 'exito' : 'error'} role={mensaje.tipo === 'ok' ? 'status' : 'alert'}>
          {mensaje.texto}
        </p>
      )}
      {estado && (
        <div className="tarjeta">
          <p>
            Teléfono registrado en su cuenta: <strong>{estado.telefonoRegistrado ?? 'ninguno (pídalo al administrador)'}</strong>
          </p>
          <p>
            Estado: <strong>{estado.vinculo ? (ESTADOS[estado.vinculo.estado] ?? estado.vinculo.estado) : 'Sin vincular'}</strong>
            {vinculado && <span className="pequeno"> · vence el {fecha(estado.vinculo!.vence_en)}</span>}
          </p>
          {!estado.canalConfigurado && <p className="pequeno">El canal WhatsApp todavía no está configurado en este servidor.</p>}
          <div className="fila">
            {estado.canalConfigurado && estado.telefonoRegistrado && (
              <button onClick={() => void vincular()}>{vinculado ? 'Renovar vínculo' : 'Vincular WhatsApp'}</button>
            )}
            {estado.vinculo && estado.vinculo.estado !== 'REVOCADO' && (
              <button className="secundario" onClick={() => void desvincular()}>
                Desvincular
              </button>
            )}
          </div>
          {codigo && (
            <div className="codigo-vinculo" role="status">
              <p>
                {codigo.numeroErp && codigo.numeroErp === estado.telefonoRegistrado ? (
                  'Su teléfono es también el número del ERP: envíese el mensaje a sí mismo, en el chat «Tú» (Mensajes a ti mismo):'
                ) : codigo.numeroErp ? (
                  <>
                    Desde su teléfono, escriba al <strong>{codigo.numeroErp}</strong>:
                  </>
                ) : (
                  'Desde su teléfono, escriba al número de WhatsApp del ERP:'
                )}
              </p>
              <p className="codigo">VINCULAR {codigo.codigo}</p>
              <p className="pequeno">El código vence en 10 minutos. Después de enviarlo, presione “Actualizar”.</p>
              <button className="secundario" onClick={() => void cargar()}>
                Actualizar
              </button>
            </div>
          )}
        </div>
      )}
      {canal && (
        <>
          <h3>Conexión del canal</h3>
          <p className={canal.estado === 'CONECTADO' ? 'exito' : 'error'}>
            {canal.estado === 'CONECTADO' ? 'Conectado' : canal.estado === 'SIN_DATOS' ? 'Sin datos del conector' : 'Desconectado'}
            {canal.detalle ? ` · ${canal.detalle}` : ''}
          </p>
          <p className="pequeno">Último aviso del conector: {fecha(canal.ultimo_latido)}</p>
        </>
      )}
    </section>
  );
}
