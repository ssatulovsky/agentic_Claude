/** Error de negocio con código estable, mensaje para el usuario y estado HTTP. */
export class ErrorNegocio extends Error {
  constructor(
    readonly codigo: string,
    mensaje: string,
    readonly estadoHttp = 400,
    readonly detalle?: unknown,
  ) {
    super(mensaje);
    this.name = 'ErrorNegocio';
  }
}

export const noAutenticado = () => new ErrorNegocio('NO_AUTENTICADO', 'Debe iniciar sesión.', 401);
export const sinPermiso = (permiso?: string) =>
  new ErrorNegocio('SIN_PERMISO', 'No tiene permiso para realizar esta acción.', 403, permiso ? { permiso } : undefined);
export const noEncontrado = (que: string) => new ErrorNegocio('NO_ENCONTRADO', `${que} no existe o no tiene acceso.`, 404);

/**
 * Traduce errores de PostgreSQL a errores de negocio. Las violaciones de la
 * seguridad por fila se informan como falta de permiso, sin detalles internos.
 */
export function traducirErrorBaseDatos(error: unknown): ErrorNegocio | null {
  const e = error as { code?: string; message?: string; constraint?: string };
  switch (e?.code) {
    case '42501':
      return sinPermiso();
    case '23505':
      return new ErrorNegocio('DUPLICADO', 'Ya existe un registro con esos datos.', 409);
    case '23P01':
      return new ErrorNegocio('SUPERPOSICION', 'El período se superpone con uno existente.', 409);
    case '23514':
      return new ErrorNegocio('DATO_INVALIDO', e.message ?? 'Dato inválido.', 422);
    case '23503':
      return new ErrorNegocio('REFERENCIA_INVALIDA', e.message ?? 'Referencia inválida.', 422);
    case '22P02':
      return new ErrorNegocio('FORMATO_INVALIDO', 'Formato de dato inválido.', 422);
    default:
      return null;
  }
}
