import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { errorMessage } from '../_shared/error-message.ts';

// §"pantalla nueva para clasificar defensivos... parecida a la de
// mecánicas de bosses pero para defensivos" (feedback real): mismo patrón
// EXACTO de dos pasos que classify-mechanics — prompt generado, el RL lo
// pega en un chat de IA con acceso a internet, y pega la respuesta de
// vuelta aquí. Acotado SIEMPRE a una clase concreta (nunca mezcla clases),
// igual que classify-mechanics nunca mezcla bosses+dificultad.
//
// No hay resync: a diferencia de category/responsibility/avoidable de
// mecánicas, survival_type NUNCA se copia dentro de player_pull_records ni
// pull_mechanic_events — defensive_casts/DefensiveOption solo guardan
// spellId/name/status. Cualquier pantalla que quiera mostrar el tipo lo
// cruza en el momento de leer contra cooldown_catalog por spell_id, así que
// no hay snapshot histórico que quede desactualizado.

const SURVIVAL_TYPES = new Set(['mitigation', 'absorption', 'sustain', 'emergency']);

// Definiciones tal cual las escribió el usuario (feedback real) — se
// mandan literalmente a la IA para que clasifique con el mismo criterio
// exacto, no una paráfrasis que pueda desviarse.
const SURVIVAL_TYPE_GLOSSARY = `- mitigation ("Mitigación"): reduce el daño que finalmente recibes ANTES de que te reste vida — DR%, armadura, reducción física/mágica específica, dodge/parry si es un defensivo activo, damage smoothing/stagger.
- absorption ("Absorción"): añade una capa/pool de vida aparte que el daño tiene que consumir antes de afectar tu HP — escudos, barriers, absorbs, efectos tipo Ignore Pain. Se separa de mitigation porque se agota, se acumula o se rompe de una vez, no reduce un porcentaje continuo.
- sustain ("Sustain"): repara vida ya perdida o mantiene tu HP estable con el tiempo — self-heals, HoTs, regeneración pasiva, leech, life drain, curación basada en daño infligido. El daño ya ocurrió; esto lo repara después.
- emergency ("Emergencia"): herramienta para sobrevivir a una situación crítica o daño potencialmente letal — inmunidades, cheat death, "no puedes bajar de X% HP", "no puedes morir durante X s", aumento grande de vida máxima, curación instantánea enorme tipo panic button.

Regla rápida para desambiguar: mitigation evita PARTE del daño antes de que llegue; absorption intercepta el daño con un pool adicional; sustain repara daño YA recibido; emergency evita una muerte o dispara drásticamente el margen de supervivencia. Cuando una habilidad mezcla varias (ej. un escudo que ADEMÁS cura), prioriza el efecto que define su USO principal en una mecánica de raid letal, y explica la mezcla en notes.`;

// §"viendo que la cantidad de habilidades defensivas tampoco es
// desorbitante, no podemos hacer un único prompt que clasifique todas las
// specs a la vez?" (feedback real, contrastado: 60 filas en total en las 13
// clases — cabe de sobra en un único prompt). className=null cubre el
// catálogo entero en una sola pasada; cada entrada de la lista lleva su
// propia "class" para que la IA investigue cada una en su clase real aunque
// vayan mezcladas.
// §"no poner el cd de un defensivo falsea muchísimo los datos, medias y
// baremos... eso debería automatizarse... cuando sincronizamos los
// defensivos o hacemos un prompt para traer los datos" (feedback real,
// 2026-08-29): verificado en real — Fortifying Brew (Monk) tenía
// base_cooldown_ms null pese a un cooldown de 3 min bien documentado en
// Wowhead (captura real aportada por el usuario, con el tooltip completo).
// El extractor de WoWAnalyzer deja null cuando el código fuente no trae un
// número fijo (talentos/haste variable) — pero el TOOLTIP de Wowhead sí lo
// da como número concreto para el caso base sin talentos, que es
// justo lo que necesita esta columna. Mismo prompt, mismo flujo de
// pegar/aplicar que ya existía para survival_type — no una pantalla nueva.
function buildSystemPrompt(className: string | null): string {
  const scope = className
    ? `de la clase "${className}"`
    : `de TODAS las clases de World of Warcraft retail (la lista trae defensivos de varias clases a la vez — cada entrada indica su "class"; investiga cada habilidad en el contexto de SU clase real, no asumas que todas comparten mecanismo)`;
  return `Eres un investigador experto en World of Warcraft retail. Tu tarea es, para cada defensivo/cooldown de supervivencia ${scope}: (1) clasificar qué le hace al daño entrante durante una mecánica de raid, y (2) resolver su cooldown base y duración del efecto en segundos — investigando en fuentes reales (Wowhead —tooltip, que trae "Cooldown" y "Lasts X sec" como números concretos—, Icy Veins, Warcraft Logs, la documentación oficial de Blizzard). Busca por el NOMBRE de la habilidad (y su "class") — el spellId solo sirve para identificarla en tu respuesta.

Para CADA habilidad, contrasta al menos una fuente real (idealmente el tooltip de Wowhead, que ya trae el cooldown y la duración como números literales cuando existen). Si el efecto de supervivencia es ambiguo o mezcla varios mecanismos sin que ninguno domine, marca confidence:"low" (o survivalType:null si de verdad no puedes decidir) — un humano revisará cualquier respuesta con confidence "low".

Sobre baseCooldownSeconds/baseDurationSeconds: usa el número BASE del tooltip (sin contar talentos que lo reduzcan/aumenten — ese ajuste ya se calcula aparte). null si la habilidad no tiene cooldown propio (ej. un recurso que se genera pasivamente) o si de verdad varía sin un valor base fijo (ej. depende 100% de haste sin ningún número de referencia). No inventes un número si no lo encontraste en una fuente real — currentBaseCooldownMs/currentBaseDurationMs en la lista de abajo ya te dicen qué campos siguen sin resolver (null) en nuestra base de datos, priorízalos, pero también corrige un valor existente si contrastando la fuente ves que está mal.

Categorías válidas para survivalType (usa EXACTAMENTE uno de estos cuatro valores, o null si no puedes determinarlo ni con baja confianza):
${SURVIVAL_TYPE_GLOSSARY}

Responde ÚNICAMENTE con JSON válido (sin texto, sin markdown, sin backticks): un array con un objeto por CADA habilidad de la lista recibida, sin omitir ninguna, en esta forma exacta:
[
  {
    "spellId": number,
    "survivalType": "mitigation" | "absorption" | "sustain" | "emergency" | null,
    "confidence": "high" | "medium" | "low",
    "sources": string[],
    "notes": "string breve explicando el mecanismo concreto (qué le hace al daño, no solo qué hace la habilidad)",
    "baseCooldownSeconds": number | null,
    "baseDurationSeconds": number | null
  }
]

Antes de responder, comprueba habilidad por habilidad que cada objeto contiene literalmente las siete claves. Responde solo con el array JSON.`;
}

interface DefensiveForPrompt {
  spellId: number;
  name: string;
  class: string;
  spec: string | null;
  category: string;
  currentSurvivalType: string | null;
  currentInferredSurvivalType: string | null;
}

interface ClassificationEntry {
  spellId: number;
  survivalType: string | null;
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
  notes: string;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  let body: { class?: string | null; action?: string; rawResponseText?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.action) {
    return jsonResponse({ ok: false, error: 'action es obligatoria' }, 400);
  }
  // class es opcional a propósito: ausente/null = catálogo entero (todas
  // las clases a la vez), ver buildSystemPrompt.
  const scopeLabel = body.class ?? 'todas las clases';

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    let query = supabase
      .from('cooldown_catalog')
      .select('spell_id,name,class,spec,category,survival_type,inferred_survival_type')
      .order('class', { ascending: true })
      .order('name', { ascending: true });
    if (body.class) query = query.eq('class', body.class);
    const { data: rows, error: rowsError } = await query;
    if (rowsError) throw rowsError;
    const defensives = (rows ?? []) as {
      spell_id: number;
      name: string;
      class: string;
      spec: string | null;
      category: string;
      survival_type: string | null;
      inferred_survival_type: string | null;
    }[];
    if (!defensives.length) return jsonResponse({ ok: false, error: `${scopeLabel} todavía no tiene ningún defensivo en el catálogo — sincroniza cooldown_catalog primero (extractor de WoWAnalyzer).` }, 400);

    if (body.action === 'prompt') {
      const list: DefensiveForPrompt[] = defensives.map((d) => ({
        spellId: d.spell_id,
        name: d.name,
        class: d.class,
        spec: d.spec,
        category: d.category,
        currentSurvivalType: d.survival_type,
        currentInferredSurvivalType: d.inferred_survival_type,
      }));
      const systemPrompt = buildSystemPrompt(body.class ?? null);
      const userMessage = `Alcance: ${scopeLabel}\nDefensivos a clasificar (${list.length}):\n${JSON.stringify(list, null, 2)}\n\nRECORDATORIO FINAL: devuelve exactamente ${list.length} objetos, uno por cada spellId de la lista, con las cinco claves spellId/survivalType/confidence/sources/notes en todos. No omitas ninguno.`;
      return jsonResponse({ ok: true, promptVersion: 2, systemPrompt, userMessage, defensiveCount: list.length });
    }

    if (body.action === 'submit') {
      if (!body.rawResponseText) return jsonResponse({ ok: false, error: 'rawResponseText es obligatorio para action=submit' }, 400);

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.rawResponseText);
      } catch {
        return jsonResponse({ ok: false, error: 'La respuesta pegada no es JSON válido. Revisa que sea el array completo que devolvió la IA, sin texto extra alrededor.' }, 400);
      }
      if (!Array.isArray(parsed)) return jsonResponse({ ok: false, error: 'Se esperaba un array JSON de clasificaciones.' }, 400);

      const knownSpellIds = new Set(defensives.map((d) => d.spell_id));
      const applied: { spellId: number; name: string; survivalType: string; confidence: 'high' | 'medium'; sources: string[]; notes: string }[] = [];
      const skippedLowConfidence: { spellId: number; name: string; survivalType: string | null; notes: string }[] = [];
      const skippedUndetermined: { spellId: number; name: string }[] = [];
      const invalid: { spellId: unknown; reason: string }[] = [];

      for (const raw of parsed) {
        const entry = raw as Partial<ClassificationEntry>;
        if (typeof entry.spellId !== 'number' || !knownSpellIds.has(entry.spellId)) {
          invalid.push({ spellId: entry.spellId, reason: 'spellId no reconocido en esta clase' });
          continue;
        }
        const name = defensives.find((d) => d.spell_id === entry.spellId)?.name ?? `#${entry.spellId}`;
        if (entry.survivalType == null) {
          skippedUndetermined.push({ spellId: entry.spellId, name });
          continue;
        }
        if (!SURVIVAL_TYPES.has(entry.survivalType)) {
          invalid.push({ spellId: entry.spellId, reason: `survivalType inválido: ${entry.survivalType}` });
          continue;
        }
        // Mismo criterio que classify-mechanics: confidence "low" nunca se
        // aplica sola, queda para revisión manual.
        if (entry.confidence === 'low') {
          skippedLowConfidence.push({ spellId: entry.spellId, name, survivalType: entry.survivalType, notes: entry.notes ?? '' });
          continue;
        }
        applied.push({
          spellId: entry.spellId,
          name,
          survivalType: entry.survivalType,
          confidence: entry.confidence === 'high' ? 'high' : 'medium',
          sources: Array.isArray(entry.sources) ? entry.sources : [],
          notes: entry.notes ?? '',
        });
      }

      // §bug real reportado (2026-08-27, feedback real: "no está clasificando
      // automáticamente el tipo de supervivencia"): la primera versión solo
      // escribía inferred_survival_type (sugerencia) y dejaba survival_type
      // (el que de verdad lee el desplegable) en "sin decidir" hasta un
      // segundo clic manual de "confirmar" — mecánicas SÍ funciona así
      // porque category/avoidable alimentan atribución de culpa, un umbral
      // de seguridad más alto tiene sentido ahí. Para defensivos no hay ese
      // riesgo — "rellenarse solo... a través de un prompt" significa que
      // el prompt YA deja el valor puesto, sin un clic extra. reviewed NO
      // se toca aquí a propósito: sigue distinguiendo "la IA ya lo rellenó"
      // de "un humano lo ha revisado de verdad".
      const submittedAt = new Date().toISOString();
      for (const a of applied) {
        // spell_id ya es único en toda la tabla (contrastado en real: 60/60
        // filas con spell_id distinto) — en alcance "todas las clases" no
        // hay body.class con el que filtrar, así que spell_id solo ya
        // identifica la fila sin ambigüedad.
        let updateQuery = supabase
          .from('cooldown_catalog')
          .update({
            survival_type: a.survivalType,
            inferred_survival_type: a.survivalType,
            ai_classification: { confidence: a.confidence, sources: a.sources, notes: a.notes, classifiedAt: submittedAt },
          })
          .eq('spell_id', a.spellId);
        if (body.class) updateQuery = updateQuery.eq('class', body.class);
        const { error } = await updateQuery;
        if (error) throw error;
      }

      return jsonResponse({ ok: true, applied, skippedLowConfidence, skippedUndetermined, invalid });
    }

    return jsonResponse({ ok: false, error: `action inválida: ${body.action}` }, 400);
  } catch (err) {
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});
