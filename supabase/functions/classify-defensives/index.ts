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
// §corrección (2026-08-31): el comentario que había aquí decía "survival_type
// nunca se copia... no hay snapshot que quede desactualizado" — FALSO,
// verificado en real (Ardent Defender, tank de Paladin): defensive_pressure_
// windows.options SÍ copia survivalType al analizar/reanalizar un pull (ver
// evaluateWindowCoverage en damage-pressure-windows.ts), y de ahí sale si una
// ventana sin usar cuenta como fallo. save-defensive-edit ya dispara
// reanálisis al cambiar survival_type (no solo cooldown/duración) — ver ese
// fichero para el porqué. reset-class-defensives (botón "restablecer
// clasificación" en esta pantalla) también lo dispara, mismo motivo.

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  return `Eres un investigador experto en World of Warcraft retail. HOY es ${todayIso()} — contrasta cada dato contra el PARCHE VIGENTE HOY, nunca contra un parche/expansión anterior que puedas recordar de tu entrenamiento: cooldowns, duraciones y hasta el propio mecanismo de una habilidad cambian entre parches, y una respuesta desactualizada falsea los datos tanto como una inventada (§"hay varios que son viejos y están falseando datos", feedback real). Si una fuente que consultas no deja claro de qué parche es, prioriza la más reciente y dilo en "sources". Tu tarea es, para cada defensivo/cooldown de supervivencia ${scope}: (1) clasificar qué le hace al daño entrante durante una mecánica de raid, y (2) resolver su cooldown base y duración del efecto en segundos — investigando en fuentes reales, A DÍA DE HOY (Wowhead —tooltip, que trae "Cooldown" y "Lasts X sec" como números concretos—, Icy Veins, Warcraft Logs, la documentación oficial de Blizzard). Busca por el NOMBRE de la habilidad (y su "class") — el spellId solo sirve para identificarla en tu respuesta.

Para CADA habilidad, contrasta al menos DOS fuentes reales (idealmente el tooltip de Wowhead, que ya trae el cooldown y la duración como números literales cuando existen). Si el efecto de supervivencia es ambiguo o mezcla varios mecanismos sin que ninguno domine, marca confidence:"low" (o survivalType:null si de verdad no puedes decidir) — un humano revisará cualquier respuesta con confidence "low".

Antes de clasificar, comprueba primero si la habilidad SIGUE siendo un defensivo de verdad HOY: algunas se han rediseñado entre parches y perdieron por completo el efecto de mitigación/absorción/curación/emergencia que tenían antes (ej. pasaron a ser puramente utilidad, movilidad, o se quitaron del juego). Si es el caso, pon "stillDefensive": false y explica en "notes" qué es ahora en su lugar (o que ya no existe) — no fuerces un survivalType solo por mantenerla clasificada como si nada. Si sigue siendo un defensivo real (la inmensa mayoría de los casos), pon "stillDefensive": true y clasifícala normalmente.

Sobre baseCooldownSeconds/baseDurationSeconds: usa el número BASE genérico del tooltip, sin talentos. Además, specProfiles DEBE recoger cualquier valor base distinto por especialización: el mismo spellId puede tener 6 min genéricos y 2 min para una spec. No fuerces un único número si las specs se comportan distinto.

Sobre modifiers: investiga los talentos/pasivas actuales que cambien cooldown, duración o cargas de ESTE defensivo. Cada regla debe apuntar al spellId real del talento modificador y al targetSpellId defensivo. Usa condition:"always" solo si elegir el talento basta para que el cambio sea garantizado; usa "conditional" si depende de casts, procs, golpes, recursos o ejecución durante el combate. value usa SEGUNDOS para subtract_seconds/add_seconds/set_seconds, un factor para multiply y número de cargas para charges_add. No incluyas modificadores de daño/porcentaje que no cambien timing o cargas.

Categorías válidas para survivalType (usa EXACTAMENTE uno de estos cuatro valores, o null si no puedes determinarlo ni con baja confianza):
${SURVIVAL_TYPE_GLOSSARY}

Responde ÚNICAMENTE con JSON válido (sin texto, sin markdown, sin backticks): un array con un objeto por CADA habilidad de la lista recibida, sin omitir ninguna, en esta forma exacta:
[
  {
    "spellId": number,
    "stillDefensive": boolean,
    "survivalType": "mitigation" | "absorption" | "sustain" | "emergency" | null,
    "confidence": "high" | "medium" | "low",
    "sources": string[],
    "notes": "string breve explicando el mecanismo concreto (qué le hace al daño, no solo qué hace la habilidad) — si stillDefensive es false, explica aquí qué es la habilidad ahora en su lugar",
    "baseCooldownSeconds": number | null,
    "baseDurationSeconds": number | null,
    "specProfiles": [
      { "spec": "nombre exacto de spec", "baseCooldownSeconds": number | null, "baseDurationSeconds": number | null, "charges": number, "source": "URL o referencia" }
    ],
    "modifiers": [
      { "modifierSpellId": number, "modifierName": "string", "targetSpellId": number, "specs": string[] | null, "operation": "subtract_seconds" | "add_seconds" | "multiply" | "set_seconds" | "charges_add", "value": number, "perRank": boolean, "condition": "always" | "conditional", "description": "string", "source": "URL o referencia" }
    ]
  }
]

specProfiles y modifiers pueden ser arrays vacíos, pero deben existir literalmente en todos los objetos. Antes de responder, comprueba habilidad por habilidad que cada objeto contiene las diez claves. Responde solo con el array JSON.`;
}

interface DefensiveForPrompt {
  spellId: number;
  name: string;
  class: string;
  spec: string | null;
  category: string;
  currentSurvivalType: string | null;
  currentInferredSurvivalType: string | null;
  currentBaseCooldownMs: number | null;
  currentBaseDurationMs: number | null;
  currentSpecProfiles: unknown[];
  currentModifiers: unknown[];
}

interface SpecProfileEntry {
  spec: string;
  baseCooldownSeconds: number | null;
  baseDurationSeconds: number | null;
  charges: number;
  source: string;
}

interface ModifierEntry {
  modifierSpellId: number;
  modifierName: string;
  targetSpellId: number;
  specs: string[] | null;
  operation: 'subtract_seconds' | 'add_seconds' | 'multiply' | 'set_seconds' | 'charges_add';
  value: number;
  perRank: boolean;
  condition: 'always' | 'conditional';
  description: string;
  source: string;
}

interface ClassificationEntry {
  spellId: number;
  stillDefensive?: boolean;
  survivalType: string | null;
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
  notes: string;
  baseCooldownSeconds: number | null;
  baseDurationSeconds: number | null;
  specProfiles?: SpecProfileEntry[];
  modifiers?: ModifierEntry[];
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
      .select('spell_id,name,class,spec,category,survival_type,inferred_survival_type,base_cooldown_ms,base_duration_ms')
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
      base_cooldown_ms: number | null;
      base_duration_ms: number | null;
    }[];
    if (!defensives.length) return jsonResponse({ ok: false, error: `${scopeLabel} todavía no tiene ningún defensivo en el catálogo — sincroniza cooldown_catalog primero (extractor de WoWAnalyzer).` }, 400);

    let profileQuery = supabase.from('defensive_spec_profiles').select('*');
    let modifierQuery = supabase.from('defensive_modifier_rules').select('*').eq('active', true);
    if (body.class) {
      profileQuery = profileQuery.eq('class', body.class);
      modifierQuery = modifierQuery.eq('class', body.class);
    }
    const [{ data: currentProfiles, error: profilesError }, { data: currentModifiers, error: modifiersError }] = await Promise.all([
      profileQuery,
      modifierQuery,
    ]);
    if (profilesError) throw profilesError;
    if (modifiersError) throw modifiersError;

    if (body.action === 'prompt') {
      const list: DefensiveForPrompt[] = defensives.map((d) => ({
        spellId: d.spell_id,
        name: d.name,
        class: d.class,
        spec: d.spec,
        category: d.category,
        currentSurvivalType: d.survival_type,
        currentInferredSurvivalType: d.inferred_survival_type,
        currentBaseCooldownMs: d.base_cooldown_ms,
        currentBaseDurationMs: d.base_duration_ms,
        currentSpecProfiles: (currentProfiles ?? []).filter((profile) => profile.spell_id === d.spell_id),
        currentModifiers: (currentModifiers ?? []).filter((modifier) => modifier.target_spell_id === d.spell_id),
      }));
      const systemPrompt = buildSystemPrompt(body.class ?? null);
      const userMessage = `Alcance: ${scopeLabel}\nDefensivos a clasificar (${list.length}):\n${JSON.stringify(list, null, 2)}\n\nRECORDATORIO FINAL: devuelve exactamente ${list.length} objetos, uno por cada spellId de la lista, con las diez claves spellId/stillDefensive/survivalType/confidence/sources/notes/baseCooldownSeconds/baseDurationSeconds/specProfiles/modifiers en todos. No omitas ninguno.`;
      return jsonResponse({ ok: true, promptVersion: 4, systemPrompt, userMessage, defensiveCount: list.length });
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
      const applied: { spellId: number; name: string; class: string; survivalType: string; confidence: 'high' | 'medium'; sources: string[]; notes: string; baseCooldownMs: number | null; baseDurationMs: number | null; materialChanged: boolean }[] = [];
      const skippedLowConfidence: { spellId: number; name: string; survivalType: string | null; notes: string }[] = [];
      const skippedUndetermined: { spellId: number; name: string }[] = [];
      const invalid: { spellId: unknown; reason: string }[] = [];
      const specProfilesToApply: (SpecProfileEntry & { class: string; spellId: number })[] = [];
      const modifiersToApply: (ModifierEntry & { class: string })[] = [];
      // §"ojo que el borrar del prompt que venga de defensivos no sea
      // automático, que lo sugiera, vaya a ser que ahora perdamos
      // consistencia por un mal análisis de IA" (feedback real, 2026-08-31):
      // a diferencia de survivalType (que SÍ se aplica solo con confidence
      // alta/media, ya asumido para esta pantalla), excluir un defensivo del
      // catálogo entero es más irreversible en la práctica — nunca se toca
      // `excluded` aquí, solo se junta la sugerencia para que un humano la
      // confirme fila por fila (mismo botón "excluir" manual).
      const suggestedExclusions: { spellId: number; name: string; class: string; notes: string }[] = [];

      for (const raw of parsed) {
        const entry = raw as Partial<ClassificationEntry>;
        if (typeof entry.spellId !== 'number' || !knownSpellIds.has(entry.spellId)) {
          invalid.push({ spellId: entry.spellId, reason: 'spellId no reconocido en esta clase' });
          continue;
        }
        const matched = defensives.find((d) => d.spell_id === entry.spellId);
        const name = matched?.name ?? `#${entry.spellId}`;
        if (!['high', 'medium', 'low'].includes(String(entry.confidence))) {
          invalid.push({ spellId: entry.spellId, reason: `confidence inválida: ${String(entry.confidence)}` });
          continue;
        }
        if (entry.stillDefensive === false) {
          suggestedExclusions.push({ spellId: entry.spellId, name, class: matched?.class ?? '', notes: entry.notes ?? '' });
          continue;
        }
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
        const timingValues = [entry.baseCooldownSeconds, entry.baseDurationSeconds];
        if (timingValues.some((value) => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))) {
          invalid.push({ spellId: entry.spellId, reason: 'baseCooldownSeconds/baseDurationSeconds deben ser números >= 0 o null' });
          continue;
        }
        const baseCooldownMs = entry.baseCooldownSeconds == null ? null : Math.round(entry.baseCooldownSeconds * 1000);
        const baseDurationMs = entry.baseDurationSeconds == null ? null : Math.round(entry.baseDurationSeconds * 1000);
        const materialChanged =
          (matched?.survival_type ?? null) !== entry.survivalType ||
          (matched?.base_cooldown_ms ?? null) !== baseCooldownMs ||
          (matched?.base_duration_ms ?? null) !== baseDurationMs;
        applied.push({
          spellId: entry.spellId,
          name,
          class: matched?.class ?? '',
          survivalType: entry.survivalType,
          confidence: entry.confidence === 'high' ? 'high' : 'medium',
          sources: Array.isArray(entry.sources) ? entry.sources : [],
          notes: entry.notes ?? '',
          baseCooldownMs,
          baseDurationMs,
          materialChanged,
        });

        const specProfiles = Array.isArray(entry.specProfiles) ? entry.specProfiles : [];
        for (const profile of specProfiles) {
          const timing = [profile?.baseCooldownSeconds, profile?.baseDurationSeconds];
          if (
            !profile ||
            typeof profile.spec !== 'string' ||
            !profile.spec.trim() ||
            !Number.isInteger(profile.charges) ||
            profile.charges < 1 ||
            timing.some((value) => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))
          ) {
            invalid.push({ spellId: entry.spellId, reason: 'specProfiles contiene una base de spec inválida' });
            continue;
          }
          specProfilesToApply.push({ ...profile, spec: profile.spec.trim(), class: matched?.class ?? '', spellId: entry.spellId });
        }

        const modifiers = Array.isArray(entry.modifiers) ? entry.modifiers : [];
        for (const modifier of modifiers) {
          const validOperation = ['subtract_seconds', 'add_seconds', 'multiply', 'set_seconds', 'charges_add'].includes(modifier?.operation);
          if (
            !modifier ||
            !Number.isInteger(modifier.modifierSpellId) ||
            modifier.modifierSpellId <= 0 ||
            modifier.targetSpellId !== entry.spellId ||
            !validOperation ||
            typeof modifier.value !== 'number' ||
            !Number.isFinite(modifier.value) ||
            modifier.value < 0 ||
            (modifier.operation === 'multiply' && modifier.value <= 0) ||
            !['always', 'conditional'].includes(modifier.condition) ||
            typeof modifier.description !== 'string' ||
            (modifier.specs != null && (!Array.isArray(modifier.specs) || modifier.specs.some((spec) => typeof spec !== 'string' || !spec.trim())))
          ) {
            invalid.push({ spellId: entry.spellId, reason: 'modifiers contiene una regla inválida' });
            continue;
          }
          modifiersToApply.push({ ...modifier, class: matched?.class ?? '' });
        }
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
      const affectedClasses = new Set<string>();
      for (const a of applied) {
        const patch: Record<string, unknown> = {
          survival_type: a.survivalType,
          inferred_survival_type: a.survivalType,
          base_cooldown_ms: a.baseCooldownMs,
          base_duration_ms: a.baseDurationMs,
          ai_classification: { confidence: a.confidence, sources: a.sources, notes: a.notes, classifiedAt: submittedAt },
        };
        if (a.materialChanged) {
          patch['updated_at'] = submittedAt;
          if (a.class) affectedClasses.add(a.class);
        }
        let updateQuery = supabase.from('cooldown_catalog').update(patch).eq('spell_id', a.spellId);
        if (body.class) updateQuery = updateQuery.eq('class', body.class);
        const { error } = await updateQuery;
        if (error) throw error;
      }

      for (const profile of specProfilesToApply) {
        const { error } = await supabase.from('defensive_spec_profiles').upsert(
          {
            class: profile.class,
            spec: profile.spec,
            spell_id: profile.spellId,
            base_cooldown_ms: profile.baseCooldownSeconds == null ? null : Math.round(profile.baseCooldownSeconds * 1000),
            base_duration_ms: profile.baseDurationSeconds == null ? null : Math.round(profile.baseDurationSeconds * 1000),
            charges: profile.charges,
            source: 'defensive_prompt_v4',
            source_note: profile.source || null,
            verified_at: submittedAt,
            updated_at: submittedAt,
          },
          { onConflict: 'class,spec,spell_id' },
        );
        if (error) throw error;
      }

      const operationMap: Record<ModifierEntry['operation'], string> = {
        subtract_seconds: 'subtract_ms',
        add_seconds: 'add_ms',
        multiply: 'multiply',
        set_seconds: 'set_ms',
        charges_add: 'charges_add',
      };
      for (const modifier of modifiersToApply) {
        const operation = operationMap[modifier.operation];
        const value = ['subtract_seconds', 'add_seconds', 'set_seconds'].includes(modifier.operation)
          ? Math.round(modifier.value * 1000)
          : modifier.value;
        const { error } = await supabase.from('defensive_modifier_rules').upsert(
          {
            class: modifier.class,
            specs: modifier.specs?.map((spec) => spec.trim()) ?? null,
            modifier_spell_id: modifier.modifierSpellId,
            target_spell_id: modifier.targetSpellId,
            operation,
            value,
            per_rank: modifier.perRank === true,
            condition: modifier.condition,
            description: modifier.description,
            source: modifier.source || modifier.modifierName || 'defensive_prompt_v4',
            verified_at: submittedAt,
            active: true,
            updated_at: submittedAt,
          },
          { onConflict: 'class,modifier_spell_id,target_spell_id,operation' },
        );
        if (error) throw error;
      }

      let pullIds: string[] = [];
      if (affectedClasses.size) {
        const { data: affectedRecords, error: affectedError } = await supabase
          .from('player_pull_records')
          .select('pull_id')
          .in('class', [...affectedClasses]);
        if (affectedError) throw affectedError;
        pullIds = [...new Set((affectedRecords ?? []).map((r) => (r as { pull_id: string }).pull_id))];
      }

      return jsonResponse({
        ok: true,
        applied,
        appliedSpecProfiles: specProfilesToApply.length,
        appliedModifiers: modifiersToApply.length,
        skippedLowConfidence,
        skippedUndetermined,
        suggestedExclusions,
        invalid,
        pullIds,
      });
    }

    return jsonResponse({ ok: false, error: `action inválida: ${body.action}` }, 400);
  } catch (err) {
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});
