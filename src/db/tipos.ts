import type { ColumnType, Generated } from 'kysely';

/** Tipos de las tablas que la aplicación lee o escribe directamente. */

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type FechaSql = ColumnType<string, string, string>;
type Numerico = ColumnType<string, number | string, number | string>;

export interface TablaEmpresas {
  id: Generated<string>;
  cliente_erp_id: string;
  rut: string;
  razon_social: string;
  giro: string | null;
  tipo: 'PROPIA' | 'ANCLA';
  estado: Generated<'ACTIVA' | 'SUSPENDIDA' | 'BAJA'>;
  creado_en: Timestamp;
}

export interface TablaSuscripcionesModulo {
  id: Generated<string>;
  empresa_id: string;
  modulo_codigo: string;
  pagador: 'CLIENTE_ERP' | 'EMPRESA';
  vigente_desde: FechaSql;
  vigente_hasta: FechaSql | null;
  creado_en: Timestamp;
}

export interface TablaUsuarios {
  id: Generated<string>;
  cliente_erp_id: string;
  email: string;
  nombre: string;
  password_hash: ColumnType<never, string, never>;
  telefono_whatsapp: string | null;
  estado: Generated<'ACTIVO' | 'INACTIVO'>;
  totp_activo: ColumnType<boolean, never, never>;
  ultimo_login: ColumnType<Date | null, never, never>;
  creado_en: Timestamp;
}

export interface TablaMembresiasEmpresa {
  usuario_id: string;
  empresa_id: string;
  rol_codigo: string;
  creado_en: Timestamp;
}

export interface TablaMembresiasClienteErp {
  usuario_id: string;
  cliente_erp_id: string;
  rol_codigo: string;
  creado_en: Timestamp;
}

export interface TablaPlanCuentas {
  id: Generated<string>;
  empresa_id: string;
  codigo: string;
  nombre: string;
  clasificacion: 'ACTIVO' | 'PASIVO' | 'PATRIMONIO' | 'INGRESO' | 'GASTO' | 'ORDEN';
  naturaleza: 'DEUDORA' | 'ACREEDORA';
  imputable: boolean;
  padre_id: string | null;
  requiere_tercero: Generated<boolean>;
  requiere_centro_costo: Generated<boolean>;
  activa: Generated<boolean>;
  creado_en: Timestamp;
}

export interface TablaTerceros {
  id: Generated<string>;
  empresa_id: string;
  rut: string;
  razon_social: string;
  es_cliente: Generated<boolean>;
  es_proveedor: Generated<boolean>;
  es_trabajador: Generated<boolean>;
  es_honorarios: Generated<boolean>;
  email: string | null;
  telefono: string | null;
  activo: Generated<boolean>;
  creado_en: Timestamp;
}

export interface TablaCentrosCosto {
  id: Generated<string>;
  empresa_id: string;
  codigo: string;
  nombre: string;
  activo: Generated<boolean>;
  creado_en: Timestamp;
}

export interface TablaBitacora {
  id: ColumnType<string, never, never>;
  ocurrido_en: ColumnType<Date, never, never>;
  cliente_erp_id: string | null;
  empresa_id: string | null;
  actor_tipo: 'USUARIO' | 'AGENTE' | 'SISTEMA';
  actor_id: string;
  en_nombre_de: string | null;
  accion: string;
  entidad: string | null;
  entidad_id: string | null;
  datos: unknown;
  hash_anterior: Buffer;
  hash: Buffer;
}

export interface TablaParametrosLegales {
  id: ColumnType<string, never, never>;
  clave: string;
  valor: Numerico;
  unidad: 'PORCENTAJE' | 'UF' | 'UTM' | 'CLP' | 'FACTOR';
  vigente_desde: FechaSql;
  vigente_hasta: FechaSql | null;
  fuente: string;
  url_fuente: string;
  nota: string | null;
  estado: 'PROPUESTO' | 'APROBADO' | 'RECHAZADO';
  cargado_por: string;
  aprobado_por: string | null;
  creado_en: Timestamp;
}

export interface TablaTablasLegales {
  id: ColumnType<string, never, never>;
  clave: string;
  contenido: unknown;
  vigente_desde: FechaSql;
  vigente_hasta: FechaSql | null;
  fuente: string;
  url_fuente: string;
  nota: string | null;
  estado: 'PROPUESTO' | 'APROBADO' | 'RECHAZADO';
  cargado_por: string;
  aprobado_por: string | null;
  creado_en: Timestamp;
}

export interface TablaIndicadoresEconomicos {
  tipo: 'UF' | 'UTM' | 'UTA';
  fecha: FechaSql;
  valor: Numerico;
  fuente: string;
  url_fuente: string;
  cargado_en: Timestamp;
}

export interface TablaAgentesConfigEmpresa {
  empresa_id: string;
  agente_codigo: string;
  activo: boolean;
  autonomia_maxima: 'CONSULTAR' | 'PROPONER' | 'EJECUTAR_CON_AVISO';
  parametros: unknown;
  actualizado_en: Timestamp;
}

export type EstadoPropuesta = 'PENDIENTE' | 'APROBADA' | 'RECHAZADA' | 'EJECUTADA' | 'FALLIDA' | 'VENCIDA';

export interface TablaPropuestasAgente {
  id: Generated<string>;
  empresa_id: string;
  agente_codigo: string;
  herramienta: string;
  autonomia: 'PROPONER' | 'EJECUTAR_CON_APROBACION';
  solicitado_por: string;
  entrada: ColumnType<unknown, string, string>;
  resumen: string;
  estado: ColumnType<EstadoPropuesta, EstadoPropuesta | undefined, EstadoPropuesta>;
  resultado: ColumnType<unknown, string | null | undefined, string | null>;
  revisado_por: string | null;
  revisado_en: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  motivo: string | null;
  creado_en: Timestamp;
  vence_en: Timestamp;
}

export interface TablaTrazasAgente {
  id: ColumnType<string, never, never>;
  empresa_id: string;
  conversacion_id: string;
  usuario_id: string;
  agente_codigo: string;
  paso: number;
  tipo:
    | 'MENSAJE_USUARIO'
    | 'LLAMADA_HERRAMIENTA'
    | 'RESULTADO_HERRAMIENTA'
    | 'DENEGADO'
    | 'PROPUESTA_CREADA'
    | 'RESPUESTA'
    | 'ERROR';
  contenido: ColumnType<unknown, string, string>;
  creado_en: Timestamp;
}

export interface TablaEjerciciosContables {
  id: Generated<string>;
  empresa_id: string;
  anio: number;
  fecha_inicio: FechaSql;
  fecha_termino: FechaSql;
  estado: 'ABIERTO' | 'CERRADO';
  cerrado_en: Date | null;
  cerrado_por: string | null;
  reabierto_hasta: FechaSql | null;
  ultimo_numero: number;
  creado_en: Timestamp;
}

export interface TablaPeriodosContables {
  id: Generated<string>;
  empresa_id: string;
  ejercicio_id: string;
  anio: number;
  mes: number;
  fecha_inicio: FechaSql;
  fecha_termino: FechaSql;
  estado: 'ABIERTO' | 'CERRADO';
  cerrado_en: Date | null;
  cerrado_por: string | null;
}

export interface TablaAsientos {
  id: Generated<string>;
  empresa_id: string;
  ejercicio_id: string;
  periodo_id: string;
  numero: number;
  fecha: FechaSql;
  tipo: 'NORMAL' | 'APERTURA' | 'AJUSTE' | 'CIERRE' | 'REVERSA';
  origen: 'MANUAL' | 'AGENTE' | 'MODULO';
  glosa: string;
  documento_referencia: string | null;
  reversa_de: string | null;
  propuesta_id: string | null;
  total: Numerico;
  registrado_por: string;
  registrado_en: Timestamp;
}

export interface TablaAsientoLineas {
  id: ColumnType<string, never, never>;
  asiento_id: string;
  empresa_id: string;
  linea: number;
  cuenta_id: string;
  debe: Numerico;
  haber: Numerico;
  tercero_id: string | null;
  centro_costo_id: string | null;
  glosa: string | null;
}

export interface TablaSolicitudesReapertura {
  id: Generated<string>;
  empresa_id: string;
  ejercicio_id: string;
  motivo: string;
  acta_referencia: string;
  plazo_dias: number;
  solicitado_por: string;
  estado: 'PENDIENTE' | 'APROBADA' | 'RECHAZADA' | 'VENCIDA';
  creado_en: Timestamp;
  vence_en: Timestamp;
  resuelta_en: Date | null;
}

export interface BaseDatos {
  empresas: TablaEmpresas;
  suscripciones_modulo: TablaSuscripcionesModulo;
  usuarios: TablaUsuarios;
  membresias_empresa: TablaMembresiasEmpresa;
  membresias_cliente_erp: TablaMembresiasClienteErp;
  plan_cuentas: TablaPlanCuentas;
  terceros: TablaTerceros;
  centros_costo: TablaCentrosCosto;
  bitacora: TablaBitacora;
  parametros_legales: TablaParametrosLegales;
  tablas_legales: TablaTablasLegales;
  indicadores_economicos: TablaIndicadoresEconomicos;
  agentes_config_empresa: TablaAgentesConfigEmpresa;
  propuestas_agente: TablaPropuestasAgente;
  trazas_agente: TablaTrazasAgente;
  ejercicios_contables: TablaEjerciciosContables;
  periodos_contables: TablaPeriodosContables;
  asientos: TablaAsientos;
  asiento_lineas: TablaAsientoLineas;
  solicitudes_reapertura_ejercicio: TablaSolicitudesReapertura;
}
