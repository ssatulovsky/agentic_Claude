import { z } from 'zod';
import { HERRAMIENTAS_CONTABILIDAD } from './herramientas/contabilidad.js';
import { HERRAMIENTAS_FASE_0 } from './herramientas/maestros.js';
import { HERRAMIENTAS_TRIBUTARIO } from './herramientas/tributario.js';
import type { DefinicionAgente, DefinicionHerramienta, EspecificacionHerramienta } from './tipos.js';

/**
 * Organigrama de agentes. En la Fase 0 se definen los dos primeros con
 * herramientas reales; el resto se incorpora en su fase según el plan maestro.
 */

const REGLAS_COMUNES = `
Reglas obligatorias:
1. Nunca calcules ni inventes una cifra. Toda cifra debe salir de una herramienta, y debes indicar de cuál.
2. Si una herramienta es denegada, explica al usuario qué falta (permiso o módulo) sin intentar rodearlo.
3. Las acciones que modifican datos quedan como propuestas pendientes de aprobación humana; dilo así.
4. Responde en español de Chile, breve y con las cifras en pesos ($) con separador de miles.
5. Si falta información para responder, pregunta en vez de suponer.`;

export const AGENTES: DefinicionAgente[] = [
  {
    codigo: 'GERENTE_VIRTUAL',
    cargo: 'Gerente Virtual',
    descripcion: 'Recibe toda consulta, la resuelve con sus herramientas o la deriva al agente de área.',
    instrucciones: `Eres el Gerente Virtual de administración y finanzas de la empresa. Atiendes consultas de personas con distintos perfiles; solo ves lo que la persona que pregunta puede ver.${REGLAS_COMUNES}`,
    herramientas: [
      'consultar_parametro_legal',
      'consultar_indicador',
      'buscar_tercero',
      'consultar_plan_cuentas',
      'consultar_balance',
      'consultar_f29',
    ],
  },
  {
    codigo: 'CONTADOR_GENERAL',
    cargo: 'Contador General',
    descripcion: 'Plan de cuentas, asientos, cierres y estados financieros.',
    instrucciones: `Eres el Contador General de la empresa. Conoces IFRS y la normativa tributaria chilena.${REGLAS_COMUNES}`,
    herramientas: [
      'consultar_plan_cuentas',
      'buscar_tercero',
      'consultar_parametro_legal',
      'consultar_indicador',
      'calcular_impuesto_unico',
      'proponer_cuenta_contable',
      'consultar_balance',
      'consultar_mayor',
      'proponer_asiento',
    ],
  },
  {
    codigo: 'ANALISTA_TRIBUTARIO',
    cargo: 'Analista Tributario',
    descripcion: 'Registro de Compras y Ventas, propuesta de F29, PPM y retenciones.',
    instrucciones: `Eres el Analista Tributario de la empresa. Revisas el Registro de Compras y Ventas del SII y preparas la propuesta de F29; nunca la declaras ni la apruebas: eso lo hace el contador. Explica las advertencias de cada propuesta y qué debe revisar la persona.${REGLAS_COMUNES}`,
    herramientas: [
      'consultar_rcv',
      'consultar_f29',
      'preparar_f29',
      'consultar_parametro_legal',
      'consultar_indicador',
    ],
  },
];

export class RegistroAgentes {
  readonly #herramientas = new Map<string, DefinicionHerramienta>();
  readonly #agentes = new Map<string, DefinicionAgente>();

  constructor(
    herramientas: DefinicionHerramienta[] = [...HERRAMIENTAS_FASE_0, ...HERRAMIENTAS_CONTABILIDAD, ...HERRAMIENTAS_TRIBUTARIO],
    agentes: DefinicionAgente[] = AGENTES,
  ) {
    for (const h of herramientas) {
      if (this.#herramientas.has(h.nombre)) throw new Error(`Herramienta duplicada: ${h.nombre}`);
      this.#herramientas.set(h.nombre, h);
    }
    for (const a of agentes) {
      for (const nombre of a.herramientas) {
        if (!this.#herramientas.has(nombre)) {
          throw new Error(`El agente ${a.codigo} declara una herramienta inexistente: ${nombre}`);
        }
      }
      this.#agentes.set(a.codigo, a);
    }
  }

  agente(codigo: string): DefinicionAgente | undefined {
    return this.#agentes.get(codigo);
  }

  herramienta(nombre: string): DefinicionHerramienta | undefined {
    return this.#herramientas.get(nombre);
  }

  agentes(): DefinicionAgente[] {
    return [...this.#agentes.values()];
  }

  /** Especificaciones que se entregan al modelo de lenguaje para un agente. */
  especificaciones(codigoAgente: string): EspecificacionHerramienta[] {
    const agente = this.#agentes.get(codigoAgente);
    if (!agente) return [];
    return agente.herramientas.map((nombre) => {
      const h = this.#herramientas.get(nombre)!;
      const { $schema: _omitido, ...esquema } = z.toJSONSchema(h.entrada) as Record<string, unknown>;
      return { nombre: h.nombre, descripcion: h.descripcion, esquemaEntrada: esquema };
    });
  }
}
