import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { resyncMechanicCategory } from '../_shared/resync-mechanic-category.ts';

// §"un prompt para pasar a la IA y que investigue... los nombres de las
// habilidades, con instrucciones muy claras de que averigüe en todas las
// fuentes que pueda... y luego una casilla para pegar lo obtenido y que se
// autoclasifiquen" (feedback real): mismo patrón que manual-pull-brief —
// SIN llamada propia a un LLM (no gasta el presupuesto de la app), el RL
// pega el prompt en cualquier chat con acceso a internet de verdad
// (Wowhead, Icy Veins, guías...) y pega la respuesta de vuelta aquí. Acotado
// SIEMPRE a un boss+dificultad concreto — "en ocasiones muy contadas una
// habilidad se llama igual pero tiene una mecánica ligeramente distinta
// entre dificultades" ya queda cubierto porque nunca se mezclan candidatas
// de dos dificultades en la misma pasada.

const VALID_CATEGORIES = new Set([
  'tankbuster',
  'raid-damage',
  'avoidable-ground',
  'debuff-stack',
  'interrupt',
  'soak',
  'spread',
  'healing-absorb',
  'personal-target',
  'enrage',
]);

const CATEGORY_GLOSSARY = `- tankbuster: golpe grande dirigido específicamente al tank que tiene aggro (rol, no jugador concreto).
- raid-damage: daño repartido a toda la raid, no exige moverte ni reaccionar de forma especial.
- avoidable-ground: crea una zona en el suelo que hay que evitar o abandonar.
- debuff-stack: aplica un debuff acumulativo (stacks) que hay que gestionar (dispersar, purgar, limitar).
- interrupt: un cast que se debe interrumpir.
- soak: exige que varios jugadores se agrupen para repartir/absorber el golpe entre todos.
- spread: exige que los jugadores se separen entre sí.
- healing-absorb: aplica un escudo que absorbe la curación entrante sobre el objetivo.
- personal-target: elige a un jugador concreto individualmente (no por rol de tank ni por posición en el suelo) que tiene que resolver algo en solitario.
- enrage: el boss (o un add) se enfurece — golpea más fuerte, castea más rápido, o entra en fase de berserk tras un tiempo límite o una condición (ej. "add sin morir a tiempo").`;

function buildSystemPrompt(bossName: string, difficulty: string): string {
  return `Eres un investigador experto en encuentros de raid de World of Warcraft. Tu tarea es clasificar habilidades del boss "${bossName}" en dificultad ${difficulty} en una de 9 categorías, investigando en TODAS las fuentes reales que tengas disponibles (Wowhead —tooltip, comentarios y Dungeon Journal—, Icy Veins, guías de Method/Wowhead, Warcraft Logs, vídeos de guía si puedes acceder a su contenido, foros, etc.). Busca por el NOMBRE de la habilidad (en español o en inglés, lo que te dé mejores resultados) — el ability_id solo sirve para identificarla en tu respuesta, no suele ser buscable.

Para CADA habilidad, contrasta la información en AL MENOS DOS fuentes distintas antes de decidir. Si no consigues confirmarlo en más de una fuente, o las fuentes se contradicen entre sí, es mejor marcar confidence:"low" (o category:null si de verdad no tienes ninguna pista) que arriesgarte a un falso positivo — un RL humano revisará a mano cualquier respuesta con confidence "low".

Categorías válidas (usa EXACTAMENTE uno de estos valores, o null si no puedes determinarlo ni con baja confianza):
${CATEGORY_GLOSSARY}

Esta lista es específicamente para la dificultad ${difficulty} de este boss. En muy pocos casos la misma habilidad se comporta ligeramente distinto entre dificultades (p.ej. se vuelve evitable solo en Mythic, o suelta más adds en Heroic) — si detectas o sospechas eso, prioriza el comportamiento de ESTA dificultad concreta y dilo en "notes".

Responde ÚNICAMENTE con JSON válido (sin texto, sin markdown, sin backticks): un array con un objeto por CADA habilidad de la lista recibida, sin omitir ninguna, en esta forma exacta:
[
  {
    "abilityId": number,
    "category": "tankbuster" | "raid-damage" | "avoidable-ground" | "debuff-stack" | "interrupt" | "soak" | "spread" | "healing-absorb" | "personal-target" | null,
    "confidence": "high" | "medium" | "low",
    "sources": string[],
    "notes": string
  }
]`;
}

interface CandidateForPrompt {
  abilityId: number;
  name: string;
  currentCategory: string | null;
  currentInferredCategory: string | null;
}

interface ClassificationEntry {
  abilityId: number;
  category: string | null;
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
  notes: string;
}

interface Body {
  bossId: string;
  difficulty: string;
  action: 'prompt' | 'submit';
  rawResponseText?: string;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.bossId || !body.difficulty || !body.action) {
    return jsonResponse({ ok: false, error: 'bossId, difficulty y action son obligatorios' }, 400);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const [{ data: bossRow }, { data: candidateRows, error: candidatesError }] = await Promise.all([
      supabase.from('known_raid_bosses').select('boss_name').eq('encounter_id', Number(body.bossId)).maybeSingle(),
      supabase
        .from('boss_mechanics_candidates')
        .select('ability_id,name,category,inferred_category')
        .eq('boss_id', body.bossId)
        .eq('difficulty', body.difficulty)
        .order('name', { ascending: true }),
    ]);
    if (candidatesError) throw candidatesError;
    const bossName = (bossRow as { boss_name: string } | null)?.boss_name ?? `Boss ${body.bossId}`;
    const candidates = (candidateRows ?? []) as { ability_id: number; name: string; category: string | null; inferred_category: string | null }[];
    if (!candidates.length) return jsonResponse({ ok: false, error: 'Este boss+dificultad no tiene mecánicas en el manifiesto todavía — sincroniza primero.' }, 400);

    if (body.action === 'prompt') {
      const list: CandidateForPrompt[] = candidates.map((c) => ({
        abilityId: c.ability_id,
        name: c.name,
        currentCategory: c.category,
        currentInferredCategory: c.inferred_category,
      }));
      const systemPrompt = buildSystemPrompt(bossName, body.difficulty);
      const userMessage = `Boss: ${bossName}\nDificultad: ${body.difficulty}\nHabilidades a clasificar (${list.length}):\n${JSON.stringify(list, null, 2)}`;
      return jsonResponse({ ok: true, systemPrompt, userMessage, mechanicCount: list.length });
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

      const knownAbilityIds = new Set(candidates.map((c) => c.ability_id));
      const applied: { abilityId: number; name: string; category: string; confidence: 'high' | 'medium'; sources: string[]; notes: string }[] = [];
      const skippedLowConfidence: { abilityId: number; name: string; category: string | null; notes: string }[] = [];
      const skippedUndetermined: { abilityId: number; name: string }[] = [];
      const invalid: { abilityId: unknown; reason: string }[] = [];

      for (const raw of parsed) {
        const entry = raw as Partial<ClassificationEntry>;
        if (typeof entry.abilityId !== 'number' || !knownAbilityIds.has(entry.abilityId)) {
          invalid.push({ abilityId: entry.abilityId, reason: 'abilityId no reconocido en este boss+dificultad' });
          continue;
        }
        const name = candidates.find((c) => c.ability_id === entry.abilityId)?.name ?? `#${entry.abilityId}`;
        if (entry.category == null) {
          skippedUndetermined.push({ abilityId: entry.abilityId, name });
          continue;
        }
        if (!VALID_CATEGORIES.has(entry.category)) {
          invalid.push({ abilityId: entry.abilityId, reason: `category inválida: ${entry.category}` });
          continue;
        }
        // §"que lo investigue en varias fuentes y siempre lo contraste para
        // que no sea un falso positivo": confidence "low" NUNCA se aplica
        // sola — queda para revisión manual, el mismo criterio que ya usa
        // el resto de la app (mejor no señalar que señalar de más).
        if (entry.confidence === 'low') {
          skippedLowConfidence.push({ abilityId: entry.abilityId, name, category: entry.category, notes: entry.notes ?? '' });
          continue;
        }
        applied.push({
          abilityId: entry.abilityId,
          name,
          category: entry.category,
          confidence: entry.confidence === 'high' ? 'high' : 'medium',
          sources: Array.isArray(entry.sources) ? entry.sources : [],
          notes: entry.notes ?? '',
        });
      }

      for (const a of applied) {
        // §"un botón de información que te venga lo que dice en 'notas'...
        // parece bastante útil" (feedback real): antes se descartaba
        // confidence/sources/notes en cuanto se aplicaba la categoría — se
        // guardan para que Ajustes pueda mostrarlos junto a la mecánica.
        const { error } = await supabase
          .from('boss_mechanics_candidates')
          .update({
            category: a.category,
            ai_classification: { confidence: a.confidence, sources: a.sources, notes: a.notes, classifiedAt: new Date().toISOString() },
            updated_at: new Date().toISOString(),
          })
          .eq('boss_id', body.bossId)
          .eq('difficulty', body.difficulty)
          .eq('ability_id', a.abilityId);
        if (error) throw error;
        // §"falta ahí cruce de datos... arruinando varias partes de la
        // app": ver resync-mechanic-category.ts — sin esto, la categoría
        // recién aplicada aquí nunca llega a los pulls ya analizados. Por
        // NOMBRE, no por ability_id (el del manifiesto casi nunca coincide
        // con el real que guardó WCL en los eventos).
        await resyncMechanicCategory(supabase, body.bossId, body.difficulty, a.name, a.category);
      }

      return jsonResponse({ ok: true, applied, skippedLowConfidence, skippedUndetermined, invalid });
    }

    return jsonResponse({ ok: false, error: `action inválida: ${body.action}` }, 400);
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
