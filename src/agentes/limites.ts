import { ErrorNegocio } from '../errores.js';

/**
 * Límites de uso de los agentes por persona y por empresa (en memoria de este proceso): cada
 * consulta puede encadenar varios pasos y modelos, con costo en la nube.
 */
const LIMITES = { porMinutoUsuario: 10, simultaneasUsuario: 2, simultaneasEmpresa: 6 };
const minutoUsuario = new Map<string, number[]>();
const activasUsuario = new Map<string, number>();
const activasEmpresa = new Map<string, number>();

export function ocuparConsulta(usuarioId: string, empresaId: string): () => void {
  const ahora = Date.now();
  const recientes = (minutoUsuario.get(usuarioId) ?? []).filter((t) => ahora - t < 60_000);
  if (recientes.length >= LIMITES.porMinutoUsuario) {
    throw new ErrorNegocio('DEMASIADAS_CONSULTAS', 'Hizo muchas consultas seguidas. Espere un minuto e intente de nuevo.', 429);
  }
  if ((activasUsuario.get(usuarioId) ?? 0) >= LIMITES.simultaneasUsuario) {
    throw new ErrorNegocio('DEMASIADAS_CONSULTAS', 'Ya tiene consultas en curso. Espere a que terminen.', 429);
  }
  if ((activasEmpresa.get(empresaId) ?? 0) >= LIMITES.simultaneasEmpresa) {
    throw new ErrorNegocio('DEMASIADAS_CONSULTAS', 'La empresa tiene muchas consultas en curso. Intente en unos segundos.', 429);
  }
  recientes.push(ahora);
  minutoUsuario.set(usuarioId, recientes);
  activasUsuario.set(usuarioId, (activasUsuario.get(usuarioId) ?? 0) + 1);
  activasEmpresa.set(empresaId, (activasEmpresa.get(empresaId) ?? 0) + 1);
  let liberado = false;
  return () => {
    if (liberado) return;
    liberado = true;
    const u = (activasUsuario.get(usuarioId) ?? 1) - 1;
    if (u > 0) activasUsuario.set(usuarioId, u);
    else activasUsuario.delete(usuarioId);
    const e = (activasEmpresa.get(empresaId) ?? 1) - 1;
    if (e > 0) activasEmpresa.set(empresaId, e);
    else activasEmpresa.delete(empresaId);
  };
}
