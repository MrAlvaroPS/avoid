// §Codec puro (sin Angular) para el formato de export "MRTREMD1..." del
// addon MRT (Method Raid Tools) — Reminders. Sale de investigación externa
// del propio formato interno de Reminder.lua (protocolo senderVersion=4 /
// addonVersion=71, verificado por el usuario contra MRT v5325, retail
// 12.1.0) — NO verificado contra el código fuente real de MRT desde este
// repo, ni contra el propio juego. NO dar por bueno sin la validación real
// descrita en el plan: decodeMrtExport() de un export hecho de verdad desde
// el juego (pegar el resultado aquí), y encodeMrtExport() de un reminder
// propio importado de verdad en MRT en juego, antes de repartir nada a un
// raider. Mientras tanto, roundtrip.spec.ts solo prueba que encode/decode
// son inversos ENTRE SÍ — no que sean compatibles con el MRT real.
//
// Formato, de fuera a dentro:
//   "MRTREMD1" + EncodeForPrint(DeflateRaw(payload + "##F##"))
//   "MRTREMD0" = igual pero SIN comprimir (EncodeForPrint directo sobre
//   payload+"##F##") — se soporta en decode por completitud, encode siempre
//   emite "1".
// payload  = header + "\n" + reminders.join("\n")
// header   = senderVersion<D1>addonVersion<D1>profileName<D1>options
// reminder = 20 campos separados por D1 (ver REMINDER_FIELD_COUNT), el
//   último (triggersNum) seguido de N triggers — cada trigger es un D1-campo
//   más, con sus propios subcampos separados por D2 y los subcampos vacíos
//   del FINAL de cada trigger eliminados (no así en los 20 campos fijos).
// D1 = 0xAC, D2 = 0xA4, escape de 0x11/D1/D2 con prefijo 0x11 (0x11→0x1112,
//   D1→0x1113, D2→0x1114) — nunca aparecen "sueltos" dentro de un valor real,
//   así que separar por el byte crudo D1/D2 es seguro sin trackear estado de
//   escape durante el split.

import { deflateRaw, inflateRaw } from 'pako';

export const MRT_PROTOCOL = { senderVersion: 4, addonVersion: 71 } as const;

const D1 = 0xac;
const D2 = 0xa4;
const ESC = 0x11;
const PRINT64 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()';
const PRINT64_INDEX = new Map(Array.from(PRINT64).map((c, i) => [c, i]));
const FOOTER = '##F##';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

// --- bytes: helpers genéricos -----------------------------------------

function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const length = arrays.reduce((n, a) => n + a.length, 0);
  const result = new Uint8Array(length);
  let pos = 0;
  for (const a of arrays) {
    result.set(a, pos);
    pos += a.length;
  }
  return result;
}

function joinBytes(arrays: Uint8Array[], separator: number): Uint8Array {
  if (!arrays.length) return new Uint8Array();
  const parts: Uint8Array[] = [];
  arrays.forEach((a, index) => {
    if (index) parts.push(Uint8Array.of(separator));
    parts.push(a);
  });
  return concatBytes(parts);
}

/** Inverso de joinBytes — split por un byte separador crudo. Seguro sin mirar escapes: ver cabecera del fichero. */
function splitBytes(bytes: Uint8Array, separator: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === separator) {
      parts.push(bytes.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(bytes.slice(start));
  return parts;
}

// --- escapado de valores -------------------------------------------------

/** MRT elimina saltos de línea de cada campo antes de escapar — un valor real nunca contiene 0x0A crudo, por eso separar líneas por 0x0A es seguro. */
function escapeMrtValue(value: unknown): Uint8Array {
  const text = String(value ?? '').replace(/\r/g, '').replace(/\n/g, '');
  const source = utf8Encoder.encode(text);
  const out: number[] = [];
  for (const b of source) {
    if (b === ESC) out.push(0x11, 0x12);
    else if (b === D1) out.push(0x11, 0x13);
    else if (b === D2) out.push(0x11, 0x14);
    else out.push(b);
  }
  return Uint8Array.from(out);
}

function unescapeMrtValue(bytes: Uint8Array): string {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === ESC) {
      const next = bytes[i + 1];
      if (next === 0x12) out.push(ESC);
      else if (next === 0x13) out.push(D1);
      else if (next === 0x14) out.push(D2);
      else throw new Error(`mrt-reminder-codec: secuencia de escape 0x11 inválida (siguiente byte ${next?.toString(16)}) — export corrupto o formato no reconocido.`);
      i++;
    } else {
      out.push(b);
    }
  }
  return utf8Decoder.decode(Uint8Array.from(out));
}

// --- EncodeForPrint / DecodeForPrint (alfabeto propio de LibDeflate, NO base64) ---

function encodeForPrint(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  while (i + 2 < bytes.length) {
    let cache = bytes[i] + bytes[i + 1] * 256 + bytes[i + 2] * 65536;
    result += PRINT64[cache % 64]; cache = Math.floor(cache / 64);
    result += PRINT64[cache % 64]; cache = Math.floor(cache / 64);
    result += PRINT64[cache % 64]; cache = Math.floor(cache / 64);
    result += PRINT64[cache % 64];
    i += 3;
  }
  let cache = 0;
  let bitLength = 0;
  while (i < bytes.length) {
    cache += bytes[i] * Math.pow(2, bitLength);
    bitLength += 8;
    i++;
  }
  while (bitLength > 0) {
    result += PRINT64[cache % 64];
    cache = Math.floor(cache / 64);
    bitLength -= 6;
  }
  return result;
}

function decodeForPrint(text: string): Uint8Array {
  const idx = (ch: string, pos: number): number => {
    const v = PRINT64_INDEX.get(ch);
    if (v === undefined) throw new Error(`mrt-reminder-codec: carácter "${ch}" (posición ${pos}) no pertenece al alfabeto de EncodeForPrint — no es un export MRT válido.`);
    return v;
  };
  const out: number[] = [];
  let i = 0;
  while (i + 3 < text.length) {
    let cache = idx(text[i], i) + idx(text[i + 1], i + 1) * 64 + idx(text[i + 2], i + 2) * 4096 + idx(text[i + 3], i + 3) * 262144;
    out.push(cache & 0xff); cache = Math.floor(cache / 256);
    out.push(cache & 0xff); cache = Math.floor(cache / 256);
    out.push(cache & 0xff);
    i += 4;
  }
  const tailLen = text.length - i;
  if (tailLen === 0) return Uint8Array.from(out);
  if (tailLen !== 2 && tailLen !== 3) {
    throw new Error(`mrt-reminder-codec: cola de EncodeForPrint de longitud ${tailLen} imposible (solo 2 o 3 son válidas) — export corrupto o truncado.`);
  }
  let cache = 0;
  for (let k = 0; k < tailLen; k++) cache += idx(text[i + k], i + k) * Math.pow(64, k);
  const tailBytes = Math.floor((tailLen * 6) / 8); // 2 símbolos -> 1 byte, 3 símbolos -> 2 bytes
  for (let b = 0; b < tailBytes; b++) {
    out.push(cache & 0xff);
    cache = Math.floor(cache / 256);
  }
  return Uint8Array.from(out);
}

// --- triggers --------------------------------------------------------------

export interface MrtPullTrigger {
  type: 'pull';
  /** Segundos desde el inicio del pull en los que ocurre la mecánica REAL (no el aviso) — MRT resta `prewarnSeconds` sola vía el flag durrev. */
  delayTimeSeconds: number;
}

export interface MrtBossmodTrigger {
  type: 'bossmod';
  /** Segundos restantes del timer de BigWigs/DBM en los que se dispara el aviso — ya incluye el margen, MRT no le resta nada más. Preferido sobre 'pull': sigue al timer real de la addon de turno, no a un tiempo medio fijo. */
  timeLeftSeconds: number;
  spellId?: number;
  pattern?: string;
}

export type MrtTrigger = MrtPullTrigger | MrtBossmodTrigger;

const PULL_EVENT = 3; // BOSS_START
const BOSSMOD_EVENT = 7; // BW_TIMER (MRT escucha tanto BigWigs como DBM)

function serializeTrigger(trigger: MrtTrigger): Uint8Array {
  const fields: unknown[] =
    trigger.type === 'pull'
      ? [PULL_EVENT, '', trigger.delayTimeSeconds, '', ''] // event, andor, delayTime, activeTime, invert
      : [BOSSMOD_EVENT, '', trigger.timeLeftSeconds, trigger.spellId ?? '', trigger.pattern ?? '', '', '', '', '', '']; // event, andor, bwtimeleft, spellID, pattFind, counter, cbehavior, delayTime, activeTime, invert
  while (fields.length && (fields[fields.length - 1] === '' || fields[fields.length - 1] == null)) fields.pop();
  return joinBytes(fields.map(escapeMrtValue), D2);
}

function deserializeTrigger(bytes: Uint8Array): MrtTrigger {
  const raw = splitBytes(bytes, D2).map(unescapeMrtValue);
  const event = Number(raw[0]);
  const num = (s: string | undefined): number | undefined => (s === undefined || s === '' ? undefined : Number(s));
  if (event === PULL_EVENT) {
    return { type: 'pull', delayTimeSeconds: num(raw[2]) ?? 0 };
  }
  if (event === BOSSMOD_EVENT) {
    return { type: 'bossmod', timeLeftSeconds: num(raw[2]) ?? 0, spellId: num(raw[3]), pattern: raw[4] || undefined };
  }
  throw new Error(`mrt-reminder-codec: evento de trigger ${raw[0]} no soportado (solo 3=BOSS_START y 7=BW_TIMER) — export de un tipo de reminder que este codec no cubre todavía.`);
}

// --- reminder ----------------------------------------------------------

export interface MrtReminderInput {
  /** Estable entre exports (mismo reminder reeditado en vuestra pantalla debe reusar el mismo uid) — MRT indexa por uid al importar y así reemplaza en vez de duplicar. ASCII simple recomendado. */
  uid: string;
  name: string;
  /** Ej. "{spell:48792} Escudo de fuego" */
  message: string;
  bossId: number;
  difficultyId: number;
  /** Nombres de personaje. Vacío = sin restricción (lo recibe cualquiera que importe la nota) — el uso previsto en esta app es repartir el export ya filtrado por spec/persona a mano, así que normalmente vacío. */
  players: string[];
  /** Segundos de aviso previo (countdown) antes del momento real de la mecánica. */
  prewarnSeconds: number;
  trigger: MrtTrigger;
}

export interface MrtDecodedReminder {
  uid: string;
  name: string;
  message: string;
  bossId: number | null;
  difficultyId: number | null;
  players: string[];
  prewarnSeconds: number;
  countdown: boolean;
  durRev: boolean;
  triggers: MrtTrigger[];
}

const CHECK_COUNTDOWN = 1;
const CHECK_DURREV = 128;

const REMINDER_FIELD_COUNT = 20; // uid..triggersNum, ver cabecera del fichero

function serializeReminder(r: MrtReminderInput): Uint8Array {
  const durRev = r.trigger.type === 'pull'; // ver comentario en MrtPullTrigger/MrtBossmodTrigger
  const checks = CHECK_COUNTDOWN | (durRev ? CHECK_DURREV : 0);
  const fields: Uint8Array[] = [
    escapeMrtValue(r.uid), // 1 uid
    escapeMrtValue(r.name), // 2 name
    escapeMrtValue(r.message), // 3 msg
    escapeMrtValue(''), // 4 msgSize
    escapeMrtValue(r.prewarnSeconds), // 5 dur
    escapeMrtValue(checks), // 6 checks
    escapeMrtValue(''), // 7 countdownType
    escapeMrtValue(''), // 8 sound
    escapeMrtValue(''), // 9 extraOptions
    escapeMrtValue(''), // 10 glowOptions
    escapeMrtValue(''), // 11 countdownVoice
    escapeMrtValue(''), // 12 extraCheck
    escapeMrtValue(r.bossId), // 13 bossID
    escapeMrtValue(r.difficultyId), // 14 diffID
    escapeMrtValue(''), // 15 zoneID
    escapeMrtValue(r.players.join(':')), // 16 players
    escapeMrtValue(''), // 17 notePattern
    escapeMrtValue(0), // 18 roles
    escapeMrtValue(0), // 19 classes
    escapeMrtValue(1), // 20 triggersNum — esta app siempre genera 1 trigger por reminder
    serializeTrigger(r.trigger), // 21 trigger #1
  ];
  return joinBytes(fields, D1);
}

function deserializeReminder(bytes: Uint8Array): MrtDecodedReminder {
  const parts = splitBytes(bytes, D1);
  if (parts.length < REMINDER_FIELD_COUNT) {
    throw new Error(`mrt-reminder-codec: línea de reminder con ${parts.length} campos, se esperaban al menos ${REMINDER_FIELD_COUNT} — export corrupto o de un formato/versión no soportada.`);
  }
  const raw = parts.map(unescapeMrtValue);
  const checks = Number(raw[5]) || 0;
  const triggersNum = Number(raw[19]) || 0;
  const triggerParts = parts.slice(REMINDER_FIELD_COUNT, REMINDER_FIELD_COUNT + triggersNum);
  return {
    uid: raw[0],
    name: raw[1],
    message: raw[2],
    bossId: raw[12] === '' ? null : Number(raw[12]),
    difficultyId: raw[13] === '' ? null : Number(raw[13]),
    players: raw[15] ? raw[15].split(':').filter(Boolean) : [],
    prewarnSeconds: Number(raw[4]) || 0,
    countdown: (checks & CHECK_COUNTDOWN) !== 0,
    durRev: (checks & CHECK_DURREV) !== 0,
    triggers: triggerParts.map(deserializeTrigger),
  };
}

// --- export completo ------------------------------------------------------

export interface MrtDecodedExport {
  compressed: boolean;
  senderVersion: number;
  addonVersion: number;
  profileName: string;
  reminders: MrtDecodedReminder[];
}

/** Construye el string "MRTREMD1..." completo, listo para pegar en el importador de MRT Reminder. */
export function encodeMrtExport(profileName: string, reminders: MrtReminderInput[]): string {
  const header = joinBytes(
    [escapeMrtValue(MRT_PROTOCOL.senderVersion), escapeMrtValue(MRT_PROTOCOL.addonVersion), escapeMrtValue(profileName), escapeMrtValue('')],
    D1,
  );
  const lines = [header, ...reminders.map(serializeReminder)];
  const plain = joinBytes(lines, 0x0a);
  const withFooter = concatBytes([plain, utf8Encoder.encode(FOOTER)]);
  const compressed = deflateRaw(withFooter, { level: 5 });
  return 'MRTREMD1' + encodeForPrint(compressed);
}

/**
 * Inverso de encodeMrtExport — para la validación real descrita en la
 * cabecera del fichero (decodificar un export hecho de verdad desde MRT en
 * juego) y para el test de ida y vuelta. Acepta también "MRTREMD0"
 * (sin comprimir) por completitud del formato, aunque encodeMrtExport nunca
 * lo produce.
 */
export function decodeMrtExport(exported: string): MrtDecodedExport {
  const prefix = exported.slice(0, 8);
  if (prefix !== 'MRTREMD1' && prefix !== 'MRTREMD0') {
    throw new Error('mrt-reminder-codec: el texto no empieza por "MRTREMD1"/"MRTREMD0" — no es un export de MRT Reminder.');
  }
  const compressed = prefix === 'MRTREMD1';
  const rawBytes = decodeForPrint(exported.slice(8));
  const withFooter = compressed ? inflateRaw(rawBytes) : rawBytes;
  const footerBytes = utf8Encoder.encode(FOOTER);
  const hasFooter = withFooter.length >= footerBytes.length && footerBytes.every((b, i) => withFooter[withFooter.length - footerBytes.length + i] === b);
  if (!hasFooter) throw new Error('mrt-reminder-codec: falta el marcador "##F##" al final del payload descomprimido — export corrupto o truncado.');
  const payload = withFooter.slice(0, withFooter.length - footerBytes.length);
  const lines = splitBytes(payload, 0x0a);
  const [headerBytes, ...reminderBytes] = lines;
  const headerFields = splitBytes(headerBytes, D1).map(unescapeMrtValue);
  return {
    compressed,
    senderVersion: Number(headerFields[0]) || 0,
    addonVersion: Number(headerFields[1]) || 0,
    profileName: headerFields[2] ?? '',
    reminders: reminderBytes.filter((b) => b.length > 0).map(deserializeReminder),
  };
}

/** Pequeño helper de conveniencia para construir el `message` de un reminder — no forma parte del formato en sí. */
export function spellTag(spellId: number): string {
  return `{spell:${spellId}}`;
}
