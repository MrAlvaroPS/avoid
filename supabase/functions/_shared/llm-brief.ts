import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { checkLlmBudget, recordLlmCall } from './llm-guard.ts';

// Nota: purpose por defecto sigue siendo 'pull-brief'; el que llama puede
// pasar otro (ej. 'pull-brief-regenerated') para distinguir en llm_calls.

const MODEL = 'claude-haiku-4-5-20251001'; // barato y rápido: encaja con "solo redacta, JSON fijo"
const ANTHROPIC_VERSION = '2023-06-01';

// Exportado a propósito — §"un botón para copiar el prompt completo... y
// pegar el resultado... procesarlo como si fuese a través de la API": el
// camino manual (manual-pull-brief) necesita ESTE MISMO texto para que lo
// que se copia sea de verdad lo que se le pasaría al LLM, no una
// aproximación que pueda desincronizarse con el tiempo.
// §"que pasarle un prompt a la IA y que me diga eso, no aporta nada" (feedback
// real): con solo wipePct/deaths(número)/duración el LLM no tenía ningún
// nombre propio (ni jugador ni mecánica) que citar, así que el resultado
// salía genérico casi por definición — no era un problema de instrucciones,
// era un problema de datos de entrada. pull-brief-context.ts ahora manda
// QUIÉN murió, A QUÉ mecánica, si tenía un defensivo sin usar, qué otras
// mecánicas se fallaron sin matar a nadie, y qué mecánicas llevan varios
// pulls repitiéndose — el prompt solo necesita pedirle que USE esos nombres.
// §"claro alguna de esas muertes son wipecall o tirarse al vacío así que
// contemplarlas ahí de esa manera es un poco alarmante" (feedback real,
// 2026-08-24, sobre el headline "7 de 8 muertes tuvieron defensivo
// disponible sin usar"): "Causa desconocida (posible wipe call / entorno)"
// es el fallback literal cuando WCL no da spellId en el golpe de muerte
// (mechanicId=0) — típico de saltos voluntarios al vacío tras un wipe call
// ya cantado, o daño de entorno sin registrar. hadDefensiveAvailableUnused
// sigue siendo un dato REAL en esos casos, pero "no lo usó" no implica lo
// mismo que en una mecánica identificada (nadie se guarda un defensivo
// personal para un salto al vacío intencionado) — mezclarlas sin matiz en
// un headline de "X de Y con defensivo sin usar" exagera el problema real.
const UNKNOWN_CAUSE_CAVEAT = `Cuando una muerte tenga mecánica "Causa desconocida (posible wipe call / entorno)", trátala con cautela:
WCL no pudo identificar qué mató a ese jugador (puede ser un salto voluntario al vacío tras un wipe ya
cantado, o daño de entorno sin registrar) — hadDefensiveAvailableUnused sigue siendo un dato real, pero
NO la cuentes junto con las muertes de mecánica identificada en un mismo headline o cifra agregada tipo
"X de Y muertes con defensivo sin usar" (eso exagera el problema). Menciónala aparte si aporta, con esa
matización explícita, nunca como si fuera una mecánica fallada de la misma forma que las demás.`;

// §"creo que en ese análisis que hace debería ser más detallado" (feedback
// real, 2026-08-24): antes de esto los items venían capados a 3 de máx 15
// palabras — un límite de REDACCIÓN, no de datos (pull-brief-context.ts ya
// manda quién/qué/cuándo/con qué defensivo desde antes). Se amplían los
// topes y se pide explícitamente causa raíz + nombres + timestamp, no solo
// listar hechos sueltos más largos por alargar.
export const SYSTEM_PROMPT = `Eres el asistente de un Raid Leader de World of Warcraft en progresión Mythic.
Recibirás un JSON con datos ya calculados de un pull:
- deaths: quién murió, a qué mecánica, a qué hora (timeLabel), la causa raíz (rootCause), si fue
  oneshot y si tenía un defensivo disponible SIN usar (hadDefensiveAvailableUnused).
- mechanicFails: mecánicas falladas (partial_fail/fail) que NO mataron a nadie, con cuánta gente golpearon.
- repeatedIssues: mecánicas que llevan >=2 de los últimos pulls fallando — no solo este intento aislado.
- avoidableDamageTotal, previousPulls: comparación contra intentos anteriores propios.
NUNCA inventes datos que no estén en el JSON de entrada.

${UNKNOWN_CAUSE_CAVEAT}

Cuando oneshot=true, el daño letal se concentró en un segundo sin ventana razonable para recibir
sanación. No lo presentes como un fallo reactivo de los healers; sí puedes mencionar una prevención
anterior a la mecánica si los datos muestran un defensivo disponible o una ejecución evitable.

Sé detallado y concreto, no telegráfico. Cada item debe explicar el QUÉ y el PORQUÉ (usa rootCause/
category para razonar la causa, no solo repetir el nombre de la mecánica), y nombrar a la persona y el
timeLabel exacto cuando el dato lo permita — "Nanis murió a Malevolent Presence a 1:42 sin usar su
defensivo (rootCause: no recibió sanación a tiempo)" aporta mucho más que "hubo una muerte evitable" o
que solo "Nanis murió a Malevolent Presence". Un raid leader ya sabe los números; necesita nombres,
momentos del pull y el motivo real para poder dirigir a esa persona después.
Si repeatedIssues no está vacío, trátalo como la señal más importante para nextPullActions — un
problema que se repite pesa más que uno nuevo — y explica cuántos pulls lleva repitiéndose.
Cuando varias muertes compartan mecánica o causa raíz, agrúpalas en un único item con todos los nombres
en vez de un item por persona.

Responde ÚNICAMENTE con JSON válido (sin texto, sin markdown, sin backticks), con esta forma exacta:
{
  "headline": string,            // máx 25 palabras, el resumen del pull con el dato más importante
  "improved": string[],          // 0 a 5 items, cada uno máx 30 palabras, con nombres/momentos/porqué cuando aplique
  "regressed": string[],         // 0 a 5 items, cada uno máx 30 palabras, con nombres/momentos/porqué cuando aplique
  "nextPullActions": string[]    // 1 a 5 acciones concretas y accionables, cada una máx 30 palabras — di quién debe hacer qué y cuándo del pull
}`;

// §"meter en el dosier de un jugador y en el resumen de toda la noche
// completa también la consulta de IA... a nivel más detalle... si es de un
// jugador tendrá en cuenta el dossier y ese jugador concreto, si es de una
// noche de raid lo hará a nivel de raid con algo menos de detalle
// particular de jugadores" (feedback real, 2026-08-24). Dos prompts nuevos,
// mismo MODEL/JSON de salida que el de pull (headline/improved/regressed/
// nextPullActions) — así el frontend reutiliza el mismo componente de
// tarjeta y el mismo parseo, solo cambia qué se le manda al LLM y qué
// instrucciones recibe.

// §"hay que ampliar los detalles en general para que le sea útil a él...
// también en el informe de la noche" (feedback real, 2026-08-24): topes de
// redacción ampliados otra vez (8 items de 45 palabras, antes 5 de 30) y
// exigencia explícita de NO comprimir en exceso — cubrir cada muerte real,
// no solo un resumen de las 2-3 más gordas, agrupando por mecánica cuando
// se repita (eso SÍ es resumir bien, perder una muerte real no lo es).
export const NIGHT_PLAYER_SYSTEM_PROMPT = `Eres el asistente de un Raid Leader de World of Warcraft en progresión Mythic.
Recibirás un JSON con TODO lo que le pasó a UN jugador concreto a lo largo de una noche entera de raid
(varios pulls, varios bosses):
- pulls: cada intento en el que participó (boss, kill/wipe, wipePct).
- deaths: cada muerte de la noche — mecánica, boss, minuto, causa raíz, oneshot sí/no, y si tenía un defensivo
  disponible SIN usar. usedEmergencyConsumableInPull indica si usó piedra de brujo/poción en algún momento de ese try.
- mechanicFails: mecánicas de su responsabilidad individual que falló SIN morir.
- repeatedPatterns: mecánicas que le fallaron/mataron más de una vez esta noche, en cuántos bosses distintos.
- gear: clase/spec y cobertura de enchants (cabeza/hombros/pecho/piernas/botas/anillos) y gemas (cuello/anillos) al final de la noche.
- reliabilitySignal: cuántos pulls tuvieron daño evitable, uso defensivo durante el try y uso defensivo al morir.
NUNCA inventes datos que no estén en el JSON de entrada.

${UNKNOWN_CAUSE_CAVEAT}

Cuando oneshot=true, no culpes a una falta de sanación reactiva: el daño se concentró en un segundo.
Separa esa imposibilidad de curarlo de la posible prevención previa (mecánica evitable o defensivo disponible).

Este es un informe DETALLADO Y NORMALIZADO para dirigir a ESTE jugador en concreto — más profundo que el
análisis de un solo pull, y debe ser ÚTIL DE VERDAD, no un resumen genérico. Cubre CADA muerte real del
JSON, no solo las 2-3 más repetidas — agrupa por mecánica/causa raíz cuando varias instancias comparten
la misma (eso sí ahorra espacio sin perder información), pero no omitas una muerte real solo por
acortar. Para cada grupo, cita boss+pull+minuto y si tenía defensivo disponible sin usar o no usó
piedra/poción durante el try — esos son los datos que hacen el informe accionable. repeatedPatterns es la señal más
importante para nextPullActions (un problema que se repite en varios bosses de la misma noche es un
patrón de juego, no mala suerte puntual). Cubre también el gear: si faltan encantamientos o gemas,
dilo como acción concreta con el número exacto de slots. Si reliabilitySignal muestra varios pulls con
daño evitable, pocas oportunidades con defensivo durante el try o sin usarlo al morir, interprétalo
explícitamente como un patrón de disciplina, no solo cites el número. El uso al morir es la señal más
directa, pero no ignores el uso general durante la pelea.

Responde ÚNICAMENTE con JSON válido (sin texto, sin markdown, sin backticks), con esta forma exacta:
{
  "headline": string,            // máx 25 palabras: cómo le fue a este jugador esta noche, el dato más importante
  "improved": string[],          // 0 a 8 items, cada uno máx 45 palabras — qué hizo bien o mejoró frente a lo esperable
  "regressed": string[],         // 0 a 8 items, cada uno máx 45 palabras — CADA problema real agrupado por mecánica, con boss+minuto+causa
  "nextPullActions": string[]    // 1 a 8 acciones concretas para hablar con este jugador antes de la próxima noche, cada una máx 45 palabras
}`;

export const NIGHT_SYSTEM_PROMPT = `Eres el asistente de un Raid Leader de World of Warcraft en progresión Mythic.
Recibirás un JSON con el resumen de TODA una noche de raid (varios bosses, toda la raid):
- bosses: intentos/kills/mejor wipePct por boss+dificultad.
- totalPulls/totalKills/totalWipes/totalDeaths, wipeCallCount (pulls con wipe call detectado).
- attendingMainCount/attendingTrialCount/absentMainNames: asistencia frente al roster oficial.
- topDeathCauses: mecánicas que más mataron esta noche, con cuánta gente distinta.
- topOffenders: jugadores con 2+ muertes esta noche — SOLO nombre y recuento, sin detalle por persona
  (ese detalle vive en el dosier individual de cada jugador, no aquí).
NUNCA inventes datos que no estén en el JSON de entrada.

${UNKNOWN_CAUSE_CAVEAT}

Este es el informe a NIVEL DE RAID de la noche — patrones de grupo, progreso por boss, asistencia y
mecánicas que más costaron, con MENOS detalle particular de un jugador concreto que un dosier individual
(nombra topOffenders si aporta, pero no profundices en la causa de cada uno). Sé exhaustivo con lo que
SÍ es de tu ámbito: repasa CADA boss de la lista (no solo el más costoso) con su progreso, cubre TODAS
las topDeathCauses relevantes (no solo la primera), y explica el ausentismo si absentMainNames no está
vacío. Prioriza qué boss costó más caro y por qué (mira su bestWipePct y attempts), si hubo muchos wipe
calls (indicio de mecánicas mal entendidas por el grupo, no solo mala suerte — dilo explícitamente), y
qué mecánica de topDeathCauses conviene repasar con toda la raid antes de la próxima noche, con el
número real de muertes que causó.

Responde ÚNICAMENTE con JSON válido (sin texto, sin markdown, sin backticks), con esta forma exacta:
{
  "headline": string,            // máx 25 palabras: cómo fue la noche en conjunto, el dato más importante
  "improved": string[],          // 0 a 8 items, cada uno máx 45 palabras — qué fue bien a nivel de raid
  "regressed": string[],         // 0 a 8 items, cada uno máx 45 palabras — qué costó, con boss/mecánica/número real cuando aplique
  "nextPullActions": string[]    // 1 a 8 prioridades concretas para la próxima noche de raid, cada una máx 45 palabras
}`;

export interface PullBriefResult {
  headline: string;
  improved: string[];
  regressed: string[];
  nextPullActions: string[];
}

/**
 * Mismo parseo que la respuesta real de Anthropic, factorizado para que
 * manual-pull-brief lo reutilice tal cual sobre texto pegado a mano — "como
 * si hubiese sido a través de la API" solo es cierto si el parseo es
 * literalmente el mismo código, no una reimplementación aparte. Mismo
 * contrato de campos para los tres ámbitos (pull/jugador-noche/raid-noche).
 */
export function parsePullBriefResponse(text: string): PullBriefResult {
  const parsed = JSON.parse(text);
  return {
    headline: parsed.headline ?? '',
    improved: Array.isArray(parsed.improved) ? parsed.improved : [],
    regressed: Array.isArray(parsed.regressed) ? parsed.regressed : [],
    nextPullActions: Array.isArray(parsed.nextPullActions) ? parsed.nextPullActions : [],
  };
}

/**
 * Llamada real a Anthropic, factorizada de generatePullBrief para que los
 * tres ámbitos (pull/jugador-noche/raid-noche) compartan el mismo guard de
 * presupuesto, mismo registro en llm_calls y mismo parseo — solo cambian el
 * system prompt y el contexto que se le manda. SIEMPRE pasa por
 * checkLlmBudget() primero: si el guard bloquea, lanza un error y NO se
 * gasta ninguna llamada real a la API.
 */
async function callBriefLlm(supabase: SupabaseClient, systemPrompt: string, context: unknown, purpose: string): Promise<PullBriefResult> {
  const guard = await checkLlmBudget(supabase);
  if (!guard.allowed) {
    await recordLlmCall(supabase, {
      purpose,
      model: MODEL,
      inputTokens: 0,
      outputTokens: 0,
      status: 'blocked',
      blockReason: guard.reason,
    });
    throw new Error(`Llamada al LLM bloqueada por el guard: ${guard.reason}`);
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('Falta ANTHROPIC_API_KEY en las variables de entorno de la función.');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2200, // antes 1200/500: los ámbitos night-player/night ahora piden hasta 8 items de 45 palabras por bloque
        system: systemPrompt,
        messages: [{ role: 'user', content: JSON.stringify(context) }],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
    }

    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    await recordLlmCall(supabase, { purpose, model: MODEL, inputTokens, outputTokens, status: 'ok' });

    const textBlock = data.content?.find((block: { type: string }) => block.type === 'text');
    return parsePullBriefResponse(textBlock?.text ?? '{}');
  } catch (err) {
    await recordLlmCall(supabase, {
      purpose,
      model: MODEL,
      inputTokens: 0,
      outputTokens: 0,
      status: 'error',
      blockReason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function generatePullBrief(supabase: SupabaseClient, pullContext: unknown, purpose = 'pull-brief'): Promise<PullBriefResult> {
  return callBriefLlm(supabase, SYSTEM_PROMPT, pullContext, purpose);
}

export async function generateNightPlayerBrief(supabase: SupabaseClient, context: unknown, purpose = 'night-player-brief'): Promise<PullBriefResult> {
  return callBriefLlm(supabase, NIGHT_PLAYER_SYSTEM_PROMPT, context, purpose);
}

export async function generateNightBrief(supabase: SupabaseClient, context: unknown, purpose = 'night-brief'): Promise<PullBriefResult> {
  return callBriefLlm(supabase, NIGHT_SYSTEM_PROMPT, context, purpose);
}
