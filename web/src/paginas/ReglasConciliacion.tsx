import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ErrorApi, type Empresa, type Imputacion, type Regla, type Tercero } from '../api';

const SENTIDOS = { CARGO: 'Cargo (sale dinero)', ABONO: 'Abono (entra dinero)', AMBOS: 'Ambos' } as const;

/**
 * Reglas de clasificación de movimientos bancarios: por RUT de la contraparte o por texto
 * de la descripción, indican el concepto contable. El sistema las usa para proponer los
 * asientos; si cambia la imputación del concepto, la regla usa la cuenta nueva.
 */
export function ReglasConciliacion({ empresa, puedeEditar }: { empresa: Empresa; puedeEditar: boolean }) {
  const [reglas, setReglas] = useState<Regla[] | null>(null);
  const [conceptos, setConceptos] = useState<Imputacion[]>([]);
  const [terceros, setTerceros] = useState<Tercero[]>([]);
  const [mensaje, setMensaje] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);
  const [form, setForm] = useState({ nombre: '', rut: '', texto: '', sentido: 'CARGO', destino: '', tercero: '', glosa: '' });

  const cargar = useCallback(async () => {
    try {
      const [r, c, t] = await Promise.all([
        api.get<Regla[]>(`/empresas/${empresa.id}/reglas-conciliacion`),
        api.get<Imputacion[]>(`/empresas/${empresa.id}/imputaciones`).catch(() => null),
        api.get<Tercero[]>(`/empresas/${empresa.id}/terceros`).catch(() => [] as Tercero[]),
      ]);
      setReglas(r);
      setConceptos((c ?? []).filter((x) => x.cuenta));
      if (c === null) {
        setMensaje({
          tipo: 'error',
          texto: 'No tiene acceso a la parametrización contable: puede ver las reglas, pero para crearlas necesita el permiso de ver el plan de cuentas.',
        });
      }
      setTerceros(t);
    } catch (e) {
      setMensaje({ tipo: 'error', texto: e instanceof ErrorApi ? e.message : 'No se pudieron cargar las reglas.' });
      setReglas([]);
    }
  }, [empresa.id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const nombreConcepto = (codigo: string | null) => conceptos.find((c) => c.concepto === codigo)?.nombre ?? codigo;
  const nombreTercero = (rut: string | null) => (rut ? (terceros.find((t) => t.rut === rut)?.razon_social ?? rut) : '');
  const destinoElegido = conceptos.find((c) => c.concepto === form.destino);
  const exigeTercero = destinoElegido?.opciones.find((o) => o.codigo === destinoElegido.cuenta?.codigo)?.requiere_tercero ?? false;

  const crear = async (ev: FormEvent) => {
    ev.preventDefault();
    setMensaje(null);
    try {
      await api.post(`/empresas/${empresa.id}/reglas-conciliacion`, {
        nombre: form.nombre,
        rut: form.rut || undefined,
        texto: form.texto || undefined,
        sentido: form.sentido,
        destino: form.destino,
        tercero: form.tercero || undefined,
        glosa: form.glosa,
      });
      setForm({ nombre: '', rut: '', texto: '', sentido: 'CARGO', destino: '', tercero: '', glosa: '' });
      setMensaje({ tipo: 'ok', texto: 'Regla creada.' });
      await cargar();
    } catch (e) {
      setMensaje({ tipo: 'error', texto: e instanceof ErrorApi ? e.message : 'No se pudo crear la regla.' });
    }
  };

  const desactivar = async (id: string) => {
    try {
      await api.post(`/empresas/${empresa.id}/reglas-conciliacion/${id}/desactivar`);
      await cargar();
    } catch (e) {
      setMensaje({ tipo: 'error', texto: e instanceof ErrorApi ? e.message : 'No se pudo desactivar.' });
    }
  };

  if (!reglas) return <p>Cargando…</p>;

  return (
    <section>
      <h2>Reglas de conciliación</h2>
      <p className="pequeno">Indican cómo contabilizar los movimientos del banco. El sistema propone el asiento; una persona lo aprueba.</p>
      {mensaje && (
        <p className={mensaje.tipo === 'ok' ? 'exito' : 'error'} role={mensaje.tipo === 'ok' ? 'status' : 'alert'}>
          {mensaje.texto}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Regla</th>
            <th>Cuando</th>
            <th>Se imputa a</th>
            <th>Tercero</th>
            <th>Glosa</th>
            <th>
              <span className="oculto">Acciones</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {reglas.length === 0 && (
            <tr>
              <td colSpan={6}>
                <em>No hay reglas.</em>
              </td>
            </tr>
          )}
          {reglas.map((r) => (
            <tr key={r.id}>
              <td>{r.nombre}</td>
              <td>
                {SENTIDOS[r.sentido]}
                {r.rut_contraparte && <div className="pequeno">RUT {r.rut_contraparte} {nombreTercero(r.rut_contraparte)}</div>}
                {r.texto && <div className="pequeno">Descripción contiene “{r.texto}”</div>}
              </td>
              <td>
                {r.concepto ? nombreConcepto(r.concepto) : 'Cuenta fija'}
                <div className="pequeno">Cuenta {r.cuenta_contable}</div>
              </td>
              <td>{nombreTercero(r.tercero)}</td>
              <td>{r.glosa}</td>
              <td className="acciones">
                {puedeEditar && (
                  <button className="secundario" onClick={() => void desactivar(r.id)}>
                    Desactivar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {puedeEditar && (
        <form className="tarjeta" onSubmit={(ev) => void crear(ev)}>
          <h3>Nueva regla</h3>
          <div className="grilla">
            <label>
              Nombre
              <input value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} required minLength={3} />
            </label>
            <label>
              RUT de la contraparte
              <input
                list="terceros"
                placeholder="12345678-9"
                value={form.rut}
                onChange={(e) => {
                  const rut = e.target.value.trim();
                  // Si el RUT completo es de un tercero registrado, se propone como tercero del asiento.
                  const tercero = !form.tercero && terceros.some((t) => t.rut === rut) ? rut : form.tercero;
                  setForm({ ...form, rut, tercero });
                }}
              />
              <datalist id="terceros">
                {terceros.map((t) => (
                  <option key={t.id} value={t.rut}>
                    {t.razon_social}
                  </option>
                ))}
              </datalist>
            </label>
            <label>
              o texto de la descripción
              <input value={form.texto} onChange={(e) => setForm({ ...form, texto: e.target.value })} />
            </label>
            <label>
              Sentido
              <select value={form.sentido} onChange={(e) => setForm({ ...form, sentido: e.target.value })}>
                {Object.entries(SENTIDOS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Concepto contable
              <select value={form.destino} onChange={(e) => setForm({ ...form, destino: e.target.value })} required>
                <option value="">Elija…</option>
                {conceptos.map((c) => (
                  <option key={c.concepto} value={c.concepto}>
                    {c.nombre} ({c.cuenta?.codigo})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tercero {exigeTercero ? '(obligatorio)' : '(opcional)'}
              <select value={form.tercero} onChange={(e) => setForm({ ...form, tercero: e.target.value })} required={exigeTercero}>
                <option value="">Ninguno</option>
                {terceros.map((t) => (
                  <option key={t.id} value={t.rut}>
                    {t.razon_social} ({t.rut})
                  </option>
                ))}
              </select>
            </label>
            <label className="ancho">
              Glosa del asiento
              <input value={form.glosa} onChange={(e) => setForm({ ...form, glosa: e.target.value })} required minLength={3} />
            </label>
          </div>
          <button type="submit" disabled={!form.rut && !form.texto}>
            Crear regla
          </button>
        </form>
      )}
    </section>
  );
}
