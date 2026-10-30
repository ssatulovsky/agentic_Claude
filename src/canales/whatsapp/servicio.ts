import { createHmac, randomInt } from 'node:crypto';
import { sql } from 'kysely';
import type { RegistroAgentes } from '../../agentes/catalogo.js';
import { conversar } from '../../agentes/conversacion.js';
import { historialConversacion } from '../../agentes/historial.js';
import type { MensajeConversacion } from '../../agentes/tipos.js';
import { ocuparConsulta } from '../../agentes/limites.js';
import { contextoDeUsuario, enContexto, sinContexto, type Db } from '../../db/conexion.js';
import { ErrorNegocio } from '../../errores.js';
import { ModeloEnrutado, type FabricaModelos } from '../../ia/enrutador.js';
import { contieneCredenciales } from '../../ia/sensibles.js';
import { permisosEnEmpresa } from '../../seguridad/permisos.js';
import type { CanalMensajeria } from './puente.js';
import { mimeAudioAceptado, type Transcriptor } from './transcripcion.js';

export interface MensajeEntrante {
  /** Identificador del mensaje en WhatsApp (para no procesarlo dos veces). */
  id: string;
  /** Teléfono de quien escribe, en formato internacional (+56912345678). */
  de: string;
  tipo: 'TEXTO' | 'AUDIO';
  texto?: string;
  audio?: { base64: string; mime: string };
}

interface Registro {
  warn(datos: Record<string, unknown>, mensaje: string): void;
  error(datos: Record<string, unknown>, mensaje: string): void;
}

interface Identidad {
  usuario_id: string;
  empresa_actual_id: string | null;
  agente_actual: string | null;
  conversacion_id: string | null;
  ultima_actividad: Date | null;
}

const AGENTE_POR_DEFECTO = 'GERENTE_VIRTUAL';
/** Una conversación sin actividad por más de este tiempo se da por terminada. */
const INACTIVIDAD_CONVERSACION_MS = 2 * 60 * 60 * 1000;
const AUDIO_MAXIMO_BYTES = 8 * 1024 * 1024;

const AYUDA = [
  '*Comandos*',
  '• *empresas*: lista sus empresas; *empresa 2* elige la segunda.',
  '• *agentes*: lista los agentes; *agente tesorero* elige uno.',
  '• *nueva*: empieza una conversación nueva.',
  '• *desvincular*: desconecta este WhatsApp de su cuenta.',
  '',
  'Cualquier otro mensaje (texto o nota de voz) va al agente elegido. Las aprobaciones se hacen en la web.',
].join('\n');

/** Texto sin tildes, en minúsculas y con espacios simples, para comparar comandos y nombres. */
function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * Hash del código de vinculación, con una clave derivada de la clave maestra (no del secreto
 * del puente: cambiar ese secreto no debe afectar otras cosas).
 */
export function hashCodigo(claveMaestraHex: string, codigo: string): Buffer {
  const clave = createHmac('sha256', Buffer.from(claveMaestraHex, 'hex')).update('whatsapp:codigos-de-vinculacion').digest();
  return createHmac('sha256', clave).update(codigo).digest();
}

/**
 * Límite de mensajes no solicitados (a números sin vínculo o a intentos de vinculación
 * fallidos): responder en masa es lo que hace que WhatsApp bloquee un número.
 */
class LimiteAvisos {
  private readonly porNumero = new Map<string, number[]>();
  private global: number[] = [];

  constructor(
    private readonly maxPorNumeroHora: number,
    private readonly maxGlobalMinuto: number,
  ) {}

  permitir(telefono: string, ahora = Date.now()): boolean {
    this.global = this.global.filter((t) => ahora - t < 60_000);
    const propios = (this.porNumero.get(telefono) ?? []).filter((t) => ahora - t < 3_600_000);
    if (propios.length >= this.maxPorNumeroHora || this.global.length >= this.maxGlobalMinuto) return false;
    if (this.porNumero.size > 10_000) this.porNumero.clear();
    propios.push(ahora);
    this.porNumero.set(telefono, propios);
    this.global.push(ahora);
    return true;
  }
}

export function generarCodigo(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Canal WhatsApp: identifica a la persona por su teléfono vinculado y verificado,
 * y la atiende con los mismos agentes y permisos que en la web. Por este canal
 * ninguna acción se ejecuta sin aprobación en la web.
 */
export class ServicioWhatsapp {
  private readonly pendientes = new Set<Promise<void>>();
  private readonly avisosSinVinculo = new LimiteAvisos(1, 30);
  private readonly avisosVinculacion = new LimiteAvisos(3, 30);

  constructor(
    private readonly deps: {
      db: Db;
      dbAuth: Db;
      registro: RegistroAgentes;
      fabricaModelos: FabricaModelos;
      canal: CanalMensajeria;
      transcriptor: Transcriptor | null;
      /** Clave maestra (hex): de ella se deriva la clave de los códigos de vinculación. */
      claveMaestra: string;
      plazoConversacionMs: number;
      registrar: Registro;
    },
  ) {}

  /**
   * Recibe un mensaje del puente. Devuelve false si ya se había recibido. El procesamiento
   * (que puede tardar) sigue en segundo plano: el puente no espera la respuesta del agente.
   */
  async recibir(m: MensajeEntrante): Promise<boolean> {
    const id = await sinContexto(this.deps.dbAuth, async (trx) => {
      const { rows } = await sql<{ id: string | null }>`
        SELECT whatsapp_registrar_entrada(${m.id}, ${m.de}, ${m.tipo}) AS id`.execute(trx);
      return rows[0]?.id ?? null;
    });
    if (id === null) return false;
    const tarea = this.procesar(Number(id), m).catch(async (e: unknown) => {
      this.deps.registrar.error({ err: e, mensaje: id }, 'Error al procesar un mensaje de WhatsApp');
      await this.marcar(Number(id), 'ERROR', null, 'ERROR_INTERNO').catch(() => undefined);
    });
    this.pendientes.add(tarea);
    void tarea.finally(() => this.pendientes.delete(tarea));
    return true;
  }

  /**
   * Espera a que terminen los mensajes en proceso (pruebas y cierre ordenado), con un plazo
   * máximo. Lo que quede a medias, el conector lo puede reenviar y se reprocesa.
   */
  async esperarPendientes(plazoMs = Infinity): Promise<void> {
    const vence = Date.now() + plazoMs;
    while (this.pendientes.size > 0 && Date.now() < vence) {
      const restante = vence - Date.now();
      await Promise.race([
        Promise.allSettled([...this.pendientes]),
        ...(Number.isFinite(restante) ? [new Promise((r) => setTimeout(r, restante))] : []),
      ]);
    }
  }

  async latido(estado: 'CONECTADO' | 'DESCONECTADO', detalle: string | null): Promise<void> {
    await sinContexto(this.deps.dbAuth, async (trx) => {
      await sql`SELECT whatsapp_latido(${estado}, ${detalle})`.execute(trx);
      await sql`SELECT whatsapp_purgar_mensajes()`.execute(trx);
    });
  }

  private async marcar(id: number, estado: 'RESPONDIDO' | 'IGNORADO' | 'ERROR', usuarioId: string | null, detalle: string | null) {
    await sinContexto(this.deps.dbAuth, (trx) =>
      sql`SELECT whatsapp_marcar_mensaje(${id}::bigint, ${estado}, ${usuarioId}::uuid, ${detalle})`.execute(trx),
    );
  }

  private async responder(id: number, telefono: string, texto: string, usuarioId: string | null, detalle: string | null = null) {
    await this.deps.canal.enviar(telefono, texto);
    await this.marcar(id, 'RESPONDIDO', usuarioId, detalle);
  }

  private async procesar(id: number, m: MensajeEntrante): Promise<void> {
    const textoOriginal = m.tipo === 'TEXTO' ? (m.texto ?? '').trim() : '';

    // Vinculación: "VINCULAR 123456" desde el teléfono registrado en la cuenta.
    const vincular = /^vincular\s+(\d{6})$/iu.exec(textoOriginal);
    if (vincular) {
      const resultado = await sinContexto(this.deps.dbAuth, async (trx) => {
        const { rows } = await sql<{ r: string }>`
          SELECT whatsapp_confirmar_vinculo(${m.de}, ${hashCodigo(this.deps.claveMaestra, vincular[1]!)}) AS r`.execute(trx);
        return rows[0]!.r;
      });
      const textos: Record<string, string> = {
        VINCULADO: `Listo: este WhatsApp quedó vinculado a su cuenta por 90 días.\n\n${AYUDA}`,
        CODIGO_INCORRECTO: 'El código no es correcto. Revíselo en la web e intente de nuevo.',
        CODIGO_VENCIDO: 'El código venció o tuvo demasiados intentos. Genere uno nuevo en la web.',
        SIN_VINCULACION_PENDIENTE: 'No hay una vinculación pendiente para este número. Iníciela en la web, en "WhatsApp".',
      };
      // Los intentos fallidos reciben respuesta a lo más 3 veces por hora y número.
      if (resultado === 'VINCULADO' || this.avisosVinculacion.permitir(m.de)) {
        await this.responder(id, m.de, textos[resultado] ?? 'No se pudo vincular.', null, `VINCULAR:${resultado}`);
      } else {
        await this.marcar(id, 'IGNORADO', null, `VINCULAR:${resultado}`);
      }
      return;
    }

    const identidad = await sinContexto(this.deps.dbAuth, async (trx) => {
      const { rows } = await sql<Identidad>`SELECT * FROM whatsapp_identificar(${m.de})`.execute(trx);
      return rows[0] ?? null;
    });
    if (!identidad) {
      // A un número desconocido se le avisa a lo más una vez por hora (sin revelar cuentas).
      if (this.avisosSinVinculo.permitir(m.de)) {
        await this.responder(id, m.de, 'Este número no está vinculado. Ingrese a la web del ERP, opción "WhatsApp", para vincularlo.', null, 'SIN_VINCULO');
      } else {
        await this.marcar(id, 'IGNORADO', null, 'SIN_VINCULO');
      }
      return;
    }
    const usuarioId = identidad.usuario_id;

    try {
      let texto = textoOriginal;
      let eco = '';
      if (m.tipo === 'AUDIO') {
        texto = await this.transcribir(m);
        if (!texto) {
          await this.responder(id, m.de, 'No logré entender el audio. ¿Puede repetirlo o escribirlo?', usuarioId, 'AUDIO_VACIO');
          return;
        }
        eco = `🎙️ Entendí: «${texto}»\n\n`;
      }
      if (!texto) {
        await this.marcar(id, 'IGNORADO', usuarioId, 'VACIO');
        return;
      }
      // Ninguna clave va a un modelo ni se guarda (tampoco se repite en el eco).
      if (contieneCredenciales(texto)) {
        await this.responder(
          id,
          m.de,
          'Su mensaje parece incluir una contraseña, clave o código de acceso, y no lo procesé. Los agentes nunca necesitan sus claves: escriba la consulta sin ellas.',
          usuarioId,
          'CREDENCIALES',
        );
        return;
      }
      const respuesta = await this.atender(identidad, texto);
      await this.responder(id, m.de, eco + respuesta, usuarioId);
    } catch (e) {
      const mensaje =
        e instanceof ErrorNegocio ? e.message : 'Ocurrió un error al atender su mensaje. Intente de nuevo en unos minutos o use la web.';
      if (!(e instanceof ErrorNegocio)) this.deps.registrar.error({ err: e }, 'Error en el canal WhatsApp');
      await this.deps.canal.enviar(m.de, mensaje).catch(() => undefined);
      await this.marcar(id, 'ERROR', usuarioId, e instanceof ErrorNegocio ? e.codigo : 'ERROR_INTERNO');
    }
  }

  private async transcribir(m: MensajeEntrante): Promise<string> {
    if (!this.deps.transcriptor) {
      throw new ErrorNegocio('AUDIO_NO_DISPONIBLE', 'Todavía no puedo escuchar notas de voz. Por favor, escriba su consulta.', 503);
    }
    if (!m.audio || !mimeAudioAceptado(m.audio.mime)) {
      throw new ErrorNegocio('AUDIO_INVALIDO', 'No pude leer ese audio. Envíe una nota de voz o escriba su consulta.', 422);
    }
    const audio = Buffer.from(m.audio.base64, 'base64');
    if (audio.length === 0 || audio.length > AUDIO_MAXIMO_BYTES) {
      throw new ErrorNegocio('AUDIO_INVALIDO', 'El audio es demasiado largo. Envíe uno más corto o escriba su consulta.', 422);
    }
    try {
      return (await this.deps.transcriptor.transcribir(audio, m.audio.mime)).slice(0, 4000);
    } catch (e) {
      this.deps.registrar.warn({ err: (e as Error).message }, 'Falló la transcripción de una nota de voz');
      throw new ErrorNegocio('AUDIO_NO_DISPONIBLE', 'No pude transcribir el audio en este momento. Por favor, escriba su consulta.', 503);
    }
  }

  /** Comandos del chat o consulta al agente elegido. */
  private async atender(identidad: Identidad, texto: string): Promise<string> {
    const usuarioId = identidad.usuario_id;
    const comando = normalizar(texto);
    const empresas = await enContexto(this.deps.db, contextoDeUsuario(usuarioId), async (trx) => {
      const { rows } = await sql<{ id: string; razon_social: string; rut: string }>`
        SELECT id, razon_social, rut FROM app_empresas_accesibles() WHERE estado = 'ACTIVA'`.execute(trx);
      return rows;
    });
    let empresaId = empresas.some((x) => x.id === identidad.empresa_actual_id) ? identidad.empresa_actual_id : null;
    if (!empresaId && empresas.length === 1) empresaId = empresas[0]!.id;
    let agente = identidad.agente_actual && this.deps.registro.agente(identidad.agente_actual) ? identidad.agente_actual : AGENTE_POR_DEFECTO;
    const guardar = (empresa: string | null, agenteCodigo: string, conversacion: string | null) =>
      enContexto(this.deps.db, contextoDeUsuario(usuarioId, empresa), (trx) =>
        sql`SELECT whatsapp_guardar_sesion(${empresa}::uuid, ${agenteCodigo}, ${conversacion}::uuid)`.execute(trx),
      );
    const listaEmpresas = () =>
      empresas.length === 0
        ? 'No tiene empresas asignadas.'
        : `*Sus empresas*\n${empresas.map((x, i) => `${i + 1}. ${x.razon_social}${x.id === empresaId ? ' ✅' : ''}`).join('\n')}\n\nResponda *empresa N* para elegir.`;

    if (comando === 'ayuda' || comando === 'menu' || comando === 'hola') {
      const actual = empresas.find((x) => x.id === empresaId);
      return `${actual ? `Empresa: *${actual.razon_social}*. ` : ''}Agente: *${this.deps.registro.agente(agente)!.cargo}*.\n\n${AYUDA}`;
    }
    if (comando === 'empresas') return listaEmpresas();
    const eleccionEmpresa = /^empresa (\d{1,3})$/u.exec(comando);
    if (eleccionEmpresa) {
      const elegida = empresas[Number(eleccionEmpresa[1]) - 1];
      if (!elegida) return `No existe esa opción.\n\n${listaEmpresas()}`;
      await guardar(elegida.id, agente, null);
      return `Empresa elegida: *${elegida.razon_social}*. Conversación nueva con ${this.deps.registro.agente(agente)!.cargo}.`;
    }
    const agentes = this.deps.registro.agentes();
    if (comando === 'agentes') {
      return `*Agentes*\n${agentes.map((a) => `• *${a.cargo}*${a.codigo === agente ? ' ✅' : ''}: ${a.descripcion}`).join('\n')}\n\nResponda *agente <nombre>* para elegir.`;
    }
    const eleccionAgente = /^agente (.+)$/u.exec(comando);
    if (eleccionAgente) {
      const buscado = eleccionAgente[1]!.replace(/_/gu, ' ');
      const elegido = agentes.find((a) => normalizar(a.cargo) === buscado || normalizar(a.codigo.replace(/_/gu, ' ')) === buscado)
        ?? agentes.find((a) => normalizar(a.cargo).includes(buscado));
      if (!elegido) return `No encontré ese agente. Responda *agentes* para ver la lista.`;
      await guardar(empresaId, elegido.codigo, null);
      return `Ahora conversa con *${elegido.cargo}*. ${elegido.descripcion}`;
    }
    if (comando === 'nueva') {
      await guardar(empresaId, agente, null);
      return 'Listo, empezamos una conversación nueva.';
    }
    if (comando === 'desvincular') {
      await enContexto(this.deps.db, contextoDeUsuario(usuarioId), (trx) => sql`SELECT whatsapp_desvincular()`.execute(trx));
      return 'Este WhatsApp quedó desvinculado de su cuenta. Puede volver a vincularlo desde la web.';
    }

    if (!empresaId) {
      await guardar(null, agente, null);
      return `Primero elija con qué empresa trabajar.\n\n${listaEmpresas()}`;
    }
    agente = this.deps.registro.agente(agente) ? agente : AGENTE_POR_DEFECTO;

    // Consulta al agente, con los permisos de la persona.
    const vigente =
      identidad.conversacion_id &&
      identidad.empresa_actual_id === empresaId &&
      identidad.agente_actual === agente &&
      identidad.ultima_actividad &&
      Date.now() - new Date(identidad.ultima_actividad).getTime() < INACTIVIDAD_CONVERSACION_MS;
    const conversacionId = vigente ? identidad.conversacion_id! : crypto.randomUUID();
    const historial = await enContexto(this.deps.db, contextoDeUsuario(usuarioId, empresaId), async (trx) => {
      if (!(await permisosEnEmpresa(trx, empresaId)).has('agentes.consultar')) {
        throw new ErrorNegocio('SIN_PERMISO', 'Su perfil no permite consultar a los agentes en esta empresa.', 403);
      }
      return vigente ? historialConversacion(trx, empresaId, conversacionId) : ([] as MensajeConversacion[]);
    });
    const liberar = ocuparConsulta(usuarioId, empresaId);
    try {
      const modelo = new ModeloEnrutado(this.deps.db, this.deps.fabricaModelos, {
        usuarioId,
        empresaId,
        agenteCodigo: agente,
        conversacionId,
        plazoMs: this.deps.plazoConversacionMs,
        registrar: (mensaje, datos) => this.deps.registrar.warn(datos, mensaje),
      });
      const r = await conversar(this.deps.db, this.deps.registro, modelo, {
        agenteCodigo: agente,
        solicitante: { usuarioId, empresaId, canal: 'WHATSAPP' },
        mensaje: texto,
        historial,
        conversacionId,
      });
      await guardar(empresaId, agente, conversacionId);
      return r.respuesta;
    } finally {
      liberar();
    }
  }
}
