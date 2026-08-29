import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { invalidateNightFullReportsForBossDifficulty, resyncMechanicAvoidable, resyncMechanicCategory, resyncMechanicResponsibility } from '../_shared/resync-mechanic-category.ts';

// §"un prompt para pasar a la IA y que investigue... los nombres de las
// habilidades, con instrucciones muy claras de que averigüe en todas las
// fuentes que pueda... y luego una casilla para pegar lo obtenido y que se
// autoclasifiquen" (feedback real): mismo patrón que manual-pull-brief —
// SIN llamada propia a un LLM (no gasta el presupuesto de la app), el RL
// pega el prompt en cualquier chat con acceso a internet de verdad
// (Wowhead, Icy Veins, guías...) y pega la respuesta de vuelta aquí.
//
// §"el prompt de mecánicas de bosses no puede consultar las 4 dificultades
// a la vez... asegurando la calidad de datos obviamente" (feedback real,
// 2026-08-27): acotado a un boss, pero ya NO a una sola dificultad — cubre
// todas las dificultades que tengan candidatas para ese boss en una sola
// pasada (normalmente Normal/Heroic/Mythic, y LFR si también tiene). Cada
// fila de la lista lleva su propia "difficulty", y la IA responde con
// abilityId+difficulty en cada objeto — así una misma habilidad (mismo
// abilityId) que aparece en varias dificultades se identifica sin
// ambigüedad. La "calidad de datos" es justo lo que pide la instrucción de
// abajo: cada (habilidad, dificultad) es una pregunta de investigación
// independiente, nunca se copia la respuesta de una dificultad a otra sin
// comprobarlo — antes esto se garantizaba por construcción (nunca se
// mezclaban dos dificultades en la misma pasada); ahora se garantiza
// explicándoselo a la IA y validando que cada respuesta traiga su propia
// dificultad al guardar.

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
const VALID_RESPONSIBILITIES = new Set(['tank', 'dps', 'healer', 'raid', 'personal']);

const CATEGORY_GLOSSARY = `- tankbuster: golpe grande dirigido específicamente al tank que tiene aggro (rol, no jugador concreto).
- raid-damage: daño repartido a toda la raid, no exige moverte ni reaccionar de forma especial.
- avoidable-ground: crea una zona en el suelo que hay que evitar o abandonar.
- debuff-stack: aplica un debuff acumulativo (stacks) que hay que gestionar (dispersar, purgar, limitar).
- interrupt: un cast que admite una interrupción/kick estándar, confirmado por el Journal o por un evento Interrupt real. NO usar para casts que se detienen con objetos o mecánicas del encuentro (peces, orbes, botones especiales), ni para un hard enrage.
- soak: exige que varios jugadores se agrupen para repartir/absorber el golpe entre todos.
- spread: exige que los jugadores se separen entre sí.
- healing-absorb: aplica un escudo que absorbe la curación entrante sobre el objetivo.
- personal-target: elige a un jugador concreto individualmente (no por rol de tank ni por posición en el suelo) que tiene que resolver algo en solitario.
- enrage: el boss (o un add) se enfurece — golpea más fuerte, castea más rápido, o entra en fase de berserk tras un tiempo límite o una condición (ej. "add sin morir a tiempo").`;

function buildSystemPrompt(bossName: string, difficulties: string[]): string {
  const difficultyList = difficulties.join(', ');
  return `Eres un investigador experto en encuentros de raid de World of Warcraft. Tu tarea es clasificar habilidades del boss "${bossName}" en una de 10 categorías, investigando en TODAS las fuentes reales que tengas disponibles (Wowhead —tooltip, comentarios y Dungeon Journal—, Icy Veins, guías de Method/Wowhead, Warcraft Logs, vídeos de guía si puedes acceder a su contenido, foros, etc.). Busca por el NOMBRE de la habilidad (en español o en inglés, lo que te dé mejores resultados) — el ability_id solo sirve para identificarla en tu respuesta, no suele ser buscable.

La lista cubre varias dificultades a la vez de este mismo boss (${difficultyList}) — cada entrada trae su propio campo "difficulty". Cuando la MISMA habilidad (mismo abilityId) aparece en más de una dificultad, trátalas como preguntas de investigación INDEPENDIENTES: la categoría, resolución, responsable y si es evitable pueden ser IDÉNTICOS entre dificultades, o pueden diferir (más frecuente de lo que parece — un umbral de daño/DPS distinto, una fase o add extra en Heroic+, una mecánica que solo se vuelve evitable en Mythic, un tankbuster que pasa a exigir dos tanks). Puedes reutilizar la misma investigación de fuentes cuando de verdad apliquen igual a las dos dificultades, pero NO copies mecánicamente la respuesta de una dificultad a otra sin comprobar que sigue siendo cierta en esa dificultad concreta — si detectas o sospechas una diferencia entre dificultades, dilo explícitamente en "notes" de cada una.

Para CADA habilidad (en cada dificultad en la que aparezca), contrasta la información en AL MENOS DOS fuentes distintas antes de decidir. Si no consigues confirmarlo en más de una fuente, o las fuentes se contradicen entre sí, es mejor marcar confidence:"low" (o category:null si de verdad no tienes ninguna pista) que arriesgarte a un falso positivo — un RL humano revisará a mano cualquier respuesta con confidence "low".

Categorías válidas (usa EXACTAMENTE uno de estos valores, o null si no puedes determinarlo ni con baja confianza):
${CATEGORY_GLOSSARY}

Responde ÚNICAMENTE con JSON válido (sin texto, sin markdown, sin backticks): un array con un objeto por CADA fila de la lista recibida (una fila = una habilidad EN una dificultad concreta), sin omitir ninguna, en esta forma exacta:
[
  {
    "abilityId": number,
    "difficulty": string,
    "category": "tankbuster" | "raid-damage" | "avoidable-ground" | "debuff-stack" | "interrupt" | "soak" | "spread" | "healing-absorb" | "personal-target" | "enrage" | null,
    "confidence": "high" | "medium" | "low",
    "sources": string[],
    "notes": string
  }
]
"difficulty" debe ser EXACTAMENTE el mismo texto que traía la fila de entrada correspondiente (ej. "Normal", "Heroic", "Mythic") — se usa para identificar sin ambigüedad a qué dificultad pertenece cada respuesta.`;
}

// Ampliación estrictamente aditiva: buildSystemPrompt se conserva sin tocar
// porque su contrato de clasificación ya funciona bien. Este segundo bloque
// añade un resultado independiente que puede validarse/guardarse sin cambiar
// qué categorías se aceptan ni cuándo se aplican.
function buildResolutionPromptAddendum(difficulties: string[]): string {
  const difficultyList = difficulties.join(', ');
  return `AMPLIACIÓN ADITIVA — CÓMO RESOLVER Y QUIÉN ES RESPONSABLE

Mantén EXACTAMENTE todas las instrucciones y todos los campos de clasificación anteriores (incluido "difficulty"). La plantilla de campos mostrada antes queda EXTENDIDA por esta ampliación: NO devuelvas objetos que terminen en "notes". La respuesta final será incompleta si falta cualquiera de estos tres campos en cualquier objeto:
  "resolution": string | null,
  "responsibility": "tank" | "dps" | "healer" | "raid" | "personal",
  "avoidable": boolean | null

"resolution" debe explicar cómo ejecutan o resuelven los jugadores esa habilidad EN LA DIFICULTAD CONCRETA de esa fila (${difficultyList}), no limitarse a repetir qué hace, y no asumir que es la misma resolución que en otra dificultad sin comprobarlo. Escribe una instrucción breve pero accionable (normalmente 1-4 frases): posicionamiento, movimiento, asignaciones, orden, timing, uso de objetos o diferencias por rol cuando las fuentes lo sostengan. Distingue un hecho del encuentro de una estrategia recomendada por una guía; no inventes asignaciones que la mecánica no exija. La resolución no tiene por qué ser siempre "muévete"/"interrumpe": cuando la fuente lo indique, es igual de válido decir que hace falta más daño de raid antes de un límite de tiempo, reservar cooldowns de sanación para una ventana concreta, o que el tank oriente al boss en una dirección determinada para no golpear a la raid — no evites estas respuestas por parecer menos "de movimiento".

Investiga "resolution" de forma independiente de la categoría y confírmala en AL MENOS DOS fuentes públicas e independientes. Usa el campo general "sources" que ya existe para devolver SOLO sus URLs directas como strings (por ejemplo, "https://www.icy-veins.com/..."), sin nombre de la fuente, sin formato [texto](URL) y sin comentarios. Las fuentes deben respaldar tanto la clasificación como la resolución y proceder de al menos dos dominios distintos: no páginas de resultados de búsqueda, no dos enlaces del mismo sitio, no mirrors y no una simple tooltip salvo que realmente respalde la instrucción. Prioriza Dungeon Journal/guías actuales de Wowhead, Icy Veins, Method, Mythic Trap, Liquid, vídeos o documentación equivalente que corresponda a este boss y a la dificultad exacta de esa fila.

Si no encuentras dos fuentes independientes, si se contradicen, si no puedes comprobar la dificultad de esa fila o si solo sabes describir el efecto pero no cómo resolverlo, devuelve "resolution":null para esa fila. Esto NO cambia cómo debes completar category, confidence, sources ni notes: la clasificación anterior sigue siendo obligatoria e independiente.

"responsibility" identifica QUIÉN tiene la acción principal que evita el fallo, no quién recibe el daño ni quién podría compensarlo después. No asumas que "no evaluable con los datos actuales" significa "no clasificable": un wipe por daño de raid insuficientemente curado, por DPS insuficiente, o por mal posicionamiento del tank son causas tan válidas como una zona en el suelo — clasifícalas igual que cualquier otra cuando la evidencia lo sostenga. Usa exactamente:
- "tank": exige una acción específica de tanks (swap, aggro, orientación/posición del boss para no golpear a la raid con un cleave/frontal, mitigación exclusivamente de tank). Un wipe por "el tank no giró al boss" es "tank", no "raid-damage" sin más.
- "healer": exige una acción específica de healers (dispel de healer, levantar un absorb de curación, o una ventana de daño inevitable — incluido un burst grande que exige cooldowns de sanación coordinados — cuyo requisito real es cobertura de sanación suficiente, no solo curar reactivamente). No lo uses para daño evitable que un jugador debía esquivar.
- "dps": exige una acción individual y específica de un jugador o un pequeño grupo DPS (prioridad de objetivo, matar un add concreto asignado). No lo uses para un check de daño colectivo de TODA la raid (enrage/límite de tiempo del encuentro) — eso es "raid", porque tanks y healers también aportan daño y el resultado depende del conjunto, no de un rol.
- "raid": resolución compartida/colectiva, una asignación que puede recaer en cualquier rol, una mecánica que selecciona aleatoriamente a cualquier jugador, o un check de daño/curación agregado de toda la raid (p.ej. superar un enrage, o sobrevivir a un burst que exige la sanación combinada del equipo).
- "personal": todos los jugadores afectados deben superar individualmente su propio chequeo y nadie puede resolverlo por ellos. Si simplemente puede elegir a cualquier jugador al azar, usa "raid", no "personal".

Elige siempre un único valor de responsibility. Si intervienen varios roles, escoge quién controla principalmente el éxito; usa "raid" cuando sea realmente compartido o asignable sin depender de un rol concreto.

"avoidable" indica si el DAÑO registrado de esa habilidad debería poder reducirse a cero con una ejecución correcta; este valor se usa para sumar daño evitable, no para decir simplemente que una mecánica se puede hacer mejor. Devuelve true para zonas, impactos o casts cuyo daño se evita por completo moviéndose, posicionándose o cortando antes de que ocurra. Devuelve false cuando la ejecución correcta todavía exige recibir el daño (daño inevitable de raid, tankbuster, objetivo inicial inevitable o soak correcto), aunque sí pueda mitigarse, curarse o empeorar al fallar. Un soak no es automáticamente true: si la raid debe recibir y repartir su daño incluso haciéndolo bien, es false. Si la misma ability mezcla una parte inevitable con otra evitable y las fuentes no permiten separarlas con claridad, usa null. No marques true solo porque un defensivo reduzca el daño.

Éste es el contrato FINAL y completo de CADA objeto de salida; usa siempre sus nueve claves, incluso cuando sus valores sean null o []:
{
  "abilityId": number,
  "difficulty": string,
  "category": "tankbuster" | "raid-damage" | "avoidable-ground" | "debuff-stack" | "interrupt" | "soak" | "spread" | "healing-absorb" | "personal-target" | "enrage" | null,
  "confidence": "high" | "medium" | "low",
  "sources": string[],
  "notes": string,
  "resolution": string | null,
  "responsibility": "tank" | "dps" | "healer" | "raid" | "personal",
  "avoidable": boolean | null
}

Antes de responder, comprueba fila por fila (habilidad + dificultad) que cada objeto contiene literalmente las claves "difficulty", "resolution", "responsibility" y "avoidable", y que "difficulty" coincide exactamente con la fila de entrada que estás respondiendo. Responde solo con el array JSON, sin explicar la comprobación.`;
}

function buildResolutionFinalReminder(rowCount: number): string {
  return `RECORDATORIO FINAL OBLIGATORIO: devuelve exactamente ${rowCount} objetos (una fila = una habilidad EN una dificultad) y asegúrate de que TODOS contienen las nueve claves abilityId, difficulty, category, confidence, sources, notes, resolution, responsibility y avoidable. "difficulty" debe copiar exactamente el texto de la fila de entrada — es como se identifica cada respuesta sin ambigüedad cuando la misma habilidad aparece en varias dificultades. No omitas resolution ni avoidable: usa null cuando no puedas contrastarlos. No omitas responsibility y usa exactamente tank, dps, healer, raid o personal. En sources escribe al menos dos URLs puras de dominios distintos, sin etiquetas ni formato Markdown.`;
}

interface CandidateForPrompt {
  abilityId: number;
  difficulty: string;
  name: string;
  currentCategory: string | null;
  currentInferredCategory: string | null;
  currentResolution: string | null;
  currentResponsibility: string | null;
  currentAvoidable: boolean | null;
}

interface ClassificationEntry {
  abilityId: number;
  difficulty?: string;
  category: string | null;
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
  notes: string;
  resolution?: string | null;
  responsibility?: string;
  avoidable?: boolean | null;
}

function independentSourceDomain(hostname: string): string {
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length <= 2) return hostname;
  const commonSecondLevelLabels = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org']);
  const countryCodeSuffix = parts.at(-1)?.length === 2 && commonSecondLevelLabels.has(parts.at(-2) ?? '');
  return parts.slice(countryCodeSuffix ? -3 : -2).join('.');
}

function normalizedPublicSource(raw: unknown): { url: string; domain: string } | null {
  if (typeof raw !== 'string') return null;
  try {
    // Los modelos a veces desobedecen el formato y envuelven la URL en
    // "Fuente: [https://...](https://...)". La procedencia sigue siendo
    // verificable, así que extraemos la primera URL en lugar de obligar al RL
    // a repetir toda la investigación por una diferencia cosmética.
    const directUrl = raw.trim().match(/https?:\/\/[^\s\])]+/)?.[0];
    if (!directUrl) return null;
    const parsed = new URL(directUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!hostname.includes('.') || hostname === 'localhost') return null;
    const searchHosts = ['google.com', 'bing.com', 'duckduckgo.com', 'search.yahoo.com'];
    if (searchHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return null;
    parsed.hash = '';
    return { url: parsed.toString(), domain: independentSourceDomain(hostname) };
  } catch {
    return null;
  }
}

function validateResolution(entry: Partial<ClassificationEntry>):
  | { ok: true; resolution: string; sources: string[] }
  | { ok: false; reason: string } {
  if (typeof entry.resolution !== 'string' || !entry.resolution.trim()) {
    return { ok: false, reason: 'sin resolución propuesta' };
  }
  const resolution = entry.resolution.trim();
  if (resolution.length < 30) return { ok: false, reason: 'la resolución es demasiado breve para ser accionable' };
  if (resolution.length > 3_000) return { ok: false, reason: 'la resolución supera el máximo de 3000 caracteres' };

  const uniqueByUrl = new Map<string, { url: string; domain: string }>();
  for (const source of Array.isArray(entry.sources) ? entry.sources : []) {
    const normalized = normalizedPublicSource(source);
    if (normalized) uniqueByUrl.set(normalized.url, normalized);
  }
  const sources = [...uniqueByUrl.values()];
  if (sources.length < 2) return { ok: false, reason: 'faltan dos URLs públicas válidas' };
  if (new Set(sources.map((source) => source.domain)).size < 2) {
    return { ok: false, reason: 'las fuentes deben proceder de dos dominios distintos' };
  }
  return { ok: true, resolution, sources: sources.map((source) => source.url) };
}

interface Body {
  bossId: string;
  /** Opcional a propósito — ausente/vacío = todas las dificultades que tengan candidatas para este boss (ver comentario de cabecera). */
  difficulties?: string[];
  action: 'prompt' | 'submit';
  rawResponseText?: string;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.bossId || !body.action) {
    return jsonResponse({ ok: false, error: 'bossId y action son obligatorios' }, 400);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    let candidatesQuery = supabase
      .from('applicable_boss_mechanics_candidates')
      .select('ability_id,name,difficulty,category,inferred_category,resolution,responsibility,avoidable')
      .eq('boss_id', body.bossId)
      .order('name', { ascending: true })
      .order('difficulty', { ascending: true });
    if (body.difficulties?.length) candidatesQuery = candidatesQuery.in('difficulty', body.difficulties);
    // §"podemos quitar la dificultad LFR de ajustes, del prompt y de la
    // sincronización... no es relevante para nada" (feedback real,
    // 2026-08-27): excluida SIEMPRE, incluso si alguien la pide a mano o si
    // queda alguna fila vieja en la tabla — no solo "ya no se ofrece en el
    // desplegable", genuinamente no debe volver a aparecer en un prompt.
    candidatesQuery = candidatesQuery.neq('difficulty', 'LFR');

    const [{ data: bossRow }, { data: candidateRows, error: candidatesError }] = await Promise.all([
      supabase.from('known_raid_bosses').select('boss_name').eq('encounter_id', Number(body.bossId)).maybeSingle(),
      candidatesQuery,
    ]);
    if (candidatesError) throw candidatesError;
    const bossName = (bossRow as { boss_name: string } | null)?.boss_name ?? `Boss ${body.bossId}`;
    const candidates = (candidateRows ?? []) as {
      ability_id: number;
      name: string;
      difficulty: string;
      category: string | null;
      inferred_category: string | null;
      resolution: string | null;
      responsibility: string | null;
      avoidable: boolean | null;
    }[];
    if (!candidates.length) {
      return jsonResponse(
        { ok: false, error: body.difficulties?.length ? `Este boss no tiene mecánicas en el manifiesto todavía para ${body.difficulties.join('/')} — sincroniza primero.` : 'Este boss no tiene mecánicas en el manifiesto todavía en ninguna dificultad — sincroniza primero.' },
        400,
      );
    }
    // Dificultades REALMENTE presentes en los candidatos devueltos, no las
    // pedidas — si se pidió una que no tiene datos, no debe aparecer en el
    // prompt como si tuviera contenido.
    const difficultiesInScope = [...new Set(candidates.map((c) => c.difficulty))];

    if (body.action === 'prompt') {
      const list: CandidateForPrompt[] = candidates.map((c) => ({
        abilityId: c.ability_id,
        difficulty: c.difficulty,
        name: c.name,
        currentCategory: c.category,
        currentInferredCategory: c.inferred_category,
        currentResolution: c.resolution,
        currentResponsibility: c.responsibility,
        currentAvoidable: c.avoidable,
      }));
      const systemPrompt = `${buildSystemPrompt(bossName, difficultiesInScope)}\n\n${buildResolutionPromptAddendum(difficultiesInScope)}`;
      const userMessage = `Boss: ${bossName}\nDificultades: ${difficultiesInScope.join(', ')}\nHabilidades a clasificar (${list.length} filas, una por habilidad+dificultad):\n${JSON.stringify(list, null, 2)}\n\n${buildResolutionFinalReminder(list.length)}`;
      // promptVersion 6: cubre varias dificultades del mismo boss en un
      // único prompt (antes una llamada por dificultad) — añade "difficulty"
      // al contrato de entrada/salida para identificar cada fila sin
      // ambigüedad (feedback real, 2026-08-27).
      //
      // promptVersion 5: aclara que "falta DPS/curación de raid" y "mal
      // posicionamiento del tank" son responsabilidades tan válidas como
      // cualquier otra (antes el ejemplo de "dps" mezclaba un check
      // colectivo de enrage con una acción individual, sesgando hacia
      // "dps" un caso que casi siempre es "raid").
      return jsonResponse({ ok: true, promptVersion: 6, systemPrompt, userMessage, mechanicCount: list.length });
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

      // §"asegurando la calidad de datos obviamente" (feedback real): con
      // varias dificultades en la misma pasada, abilityId YA NO identifica
      // una fila sin ambigüedad (el mismo abilityId existe una vez por
      // dificultad) — se emparejan por (abilityId, difficulty), y una fila
      // sin difficulty reconocido se trata como no identificable, igual que
      // un abilityId desconocido.
      const knownPairs = new Map<string, (typeof candidates)[number]>();
      for (const c of candidates) knownPairs.set(`${c.ability_id}::${c.difficulty}`, c);
      const applied: { abilityId: number; difficulty: string; name: string; category: string; confidence: 'high' | 'medium'; sources: string[]; notes: string }[] = [];
      const skippedLowConfidence: { abilityId: number; difficulty: string; name: string; category: string | null; notes: string }[] = [];
      const skippedUndetermined: { abilityId: number; difficulty: string; name: string }[] = [];
      const invalid: { abilityId: unknown; difficulty: unknown; reason: string }[] = [];
      const resolutionsApplied: { abilityId: number; difficulty: string; name: string; resolution: string }[] = [];
      const resolutionsSkipped: { abilityId: number; difficulty: string; name: string; reason: string }[] = [];
      const responsibilitiesApplied: { abilityId: number; difficulty: string; name: string; responsibility: string }[] = [];
      const responsibilitiesSkipped: { abilityId: number; difficulty: string; name: string; reason: string }[] = [];
      const avoidablesApplied: { abilityId: number; difficulty: string; name: string; avoidable: boolean | null }[] = [];
      const avoidablesSkipped: { abilityId: number; difficulty: string; name: string; reason: string }[] = [];
      const resolutionContractMissing = parsed.length > 0 && parsed.some((raw) => {
        if (raw == null || typeof raw !== 'object') return true;
        return !Object.hasOwn(raw, 'resolution');
      });
      const responsibilityContractMissing = parsed.length > 0 && parsed.some((raw) => {
        if (raw == null || typeof raw !== 'object') return true;
        return !Object.hasOwn(raw, 'responsibility');
      });
      const avoidableContractMissing = parsed.length > 0 && parsed.some((raw) => {
        if (raw == null || typeof raw !== 'object') return true;
        return !Object.hasOwn(raw, 'avoidable');
      });

      for (const raw of parsed) {
        const entry = raw as Partial<ClassificationEntry>;
        if (typeof entry.abilityId !== 'number' || typeof entry.difficulty !== 'string') {
          invalid.push({ abilityId: entry.abilityId, difficulty: entry.difficulty, reason: 'faltan abilityId o difficulty, o tienen un tipo inválido' });
          continue;
        }
        const candidate = knownPairs.get(`${entry.abilityId}::${entry.difficulty}`);
        if (!candidate) {
          invalid.push({ abilityId: entry.abilityId, difficulty: entry.difficulty, reason: `abilityId+difficulty no reconocidos para este boss (¿difficulty mal escrita? se esperaba una de: ${difficultiesInScope.join('/')})` });
          continue;
        }
        const { name, difficulty } = candidate;
        const validatedResolution = validateResolution(entry);
        if (validatedResolution.ok) {
          resolutionsApplied.push({ abilityId: entry.abilityId, difficulty, name, resolution: validatedResolution.resolution });
        } else {
          resolutionsSkipped.push({ abilityId: entry.abilityId, difficulty, name, reason: validatedResolution.reason });
        }
        if (typeof entry.responsibility !== 'string' || !VALID_RESPONSIBILITIES.has(entry.responsibility)) {
          responsibilitiesSkipped.push({ abilityId: entry.abilityId, difficulty, name, reason: 'responsibility ausente o inválida' });
        } else if (entry.confidence === 'low') {
          responsibilitiesSkipped.push({ abilityId: entry.abilityId, difficulty, name, reason: 'confidence low: requiere revisión manual' });
        } else {
          responsibilitiesApplied.push({ abilityId: entry.abilityId, difficulty, name, responsibility: entry.responsibility });
        }
        // §bug real encontrado (2026-08-27): `avoidable` es tri-estado a
        // propósito (true/false/null = mezcla no demostrable, §A.11.5) —
        // `typeof entry.avoidable !== 'boolean'` trataba "la IA contestó
        // null a propósito" exactamente igual que "la IA no contestó nada"
        // y las mandaba juntas a avoidablesSkipped, así que un `null`
        // deliberado (p.ej. al reclasificar y corregir un true/false previo
        // mal puesto) nunca se aplicaba ni se resincronizaba — el valor
        // viejo se quedaba vivo en boss_mechanics_candidates y en el
        // histórico para siempre. Solo lo realmente ausente/con tipo
        // inválido (undefined, string, number...) cuenta como "sin
        // decisión fiable"; null es una decisión válida y se aplica igual
        // que true/false (con el mismo filtro de confidence low de abajo).
        if (entry.avoidable !== true && entry.avoidable !== false && entry.avoidable !== null) {
          avoidablesSkipped.push({ abilityId: entry.abilityId, difficulty, name, reason: 'sin decisión fiable (ausente o con un tipo inválido)' });
        } else if (entry.confidence === 'low') {
          avoidablesSkipped.push({ abilityId: entry.abilityId, difficulty, name, reason: 'confidence low: requiere revisión manual' });
        } else {
          avoidablesApplied.push({ abilityId: entry.abilityId, difficulty, name, avoidable: entry.avoidable });
        }
        if (entry.category == null) {
          skippedUndetermined.push({ abilityId: entry.abilityId, difficulty, name });
          continue;
        }
        if (!VALID_CATEGORIES.has(entry.category)) {
          invalid.push({ abilityId: entry.abilityId, difficulty, reason: `category inválida: ${entry.category}` });
          continue;
        }
        // §"que lo investigue en varias fuentes y siempre lo contraste para
        // que no sea un falso positivo": confidence "low" NUNCA se aplica
        // sola — queda para revisión manual, el mismo criterio que ya usa
        // el resto de la app (mejor no señalar que señalar de más).
        if (entry.confidence === 'low') {
          skippedLowConfidence.push({ abilityId: entry.abilityId, difficulty, name, category: entry.category, notes: entry.notes ?? '' });
          continue;
        }
        applied.push({
          abilityId: entry.abilityId,
          difficulty,
          name,
          category: entry.category,
          confidence: entry.confidence === 'high' ? 'high' : 'medium',
          sources: Array.isArray(entry.sources) ? entry.sources : [],
          notes: entry.notes ?? '',
        });
      }

      const submittedAt = new Date().toISOString();
      // Se guarda en un recorrido independiente: una resolución inválida no
      // bloquea la categoría, y una categoría low/null no impide conservar
      // una resolución que sí esté contrastada correctamente.
      // §"asegurando la calidad de datos obviamente": cada fila lleva su
      // PROPIA difficulty ahora (ya no hay un único body.difficulty común a
      // toda la tanda) — se filtra por ella explícitamente en cada update,
      // así una respuesta para "Heroic" nunca puede escribir por accidente
      // en la fila de "Normal" del mismo abilityId.
      for (const resolution of resolutionsApplied) {
        const { error } = await supabase
          .from('boss_mechanics_candidates')
          .update({
            resolution: resolution.resolution,
            resolution_verified_at: submittedAt,
            updated_at: submittedAt,
          })
          .eq('boss_id', body.bossId)
          .eq('difficulty', resolution.difficulty)
          .eq('ability_id', resolution.abilityId);
        if (error) throw error;
      }

      for (const responsibility of responsibilitiesApplied) {
        const { error } = await supabase
          .from('boss_mechanics_candidates')
          .update({ responsibility: responsibility.responsibility, updated_at: submittedAt })
          .eq('boss_id', body.bossId)
          .eq('difficulty', responsibility.difficulty)
          .eq('ability_id', responsibility.abilityId);
        if (error) throw error;
        await resyncMechanicResponsibility(
          supabase,
          body.bossId,
          responsibility.difficulty,
          responsibility.name,
          responsibility.responsibility,
        );
      }

      for (const avoidable of avoidablesApplied) {
        const { error } = await supabase
          .from('boss_mechanics_candidates')
          .update({ avoidable: avoidable.avoidable, updated_at: submittedAt })
          .eq('boss_id', body.bossId)
          .eq('difficulty', avoidable.difficulty)
          .eq('ability_id', avoidable.abilityId);
        if (error) throw error;
        await resyncMechanicAvoidable(supabase, body.bossId, avoidable.difficulty, avoidable.name, avoidable.avoidable);
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
            ai_classification: { confidence: a.confidence, sources: a.sources, notes: a.notes, classifiedAt: submittedAt },
            updated_at: submittedAt,
          })
          .eq('boss_id', body.bossId)
          .eq('difficulty', a.difficulty)
          .eq('ability_id', a.abilityId);
        if (error) throw error;
        // §"falta ahí cruce de datos... arruinando varias partes de la
        // app": ver resync-mechanic-category.ts — sin esto, la categoría
        // recién aplicada aquí nunca llega a los pulls ya analizados. Por
        // NOMBRE, no por ability_id (el del manifiesto casi nunca coincide
        // con el real que guardó WCL en los eventos).
        await resyncMechanicCategory(supabase, body.bossId, a.difficulty, a.name, a.category);
      }

      // §"Daño evitable de toda la noche — solo hay cobertura en 1 de 3
      // combinaciones boss/dificultad" (feedback real, investigado): el
      // informe de noche cacheado no se invalidaba al clasificar más
      // mecánicas después de generarlo — se quedaba con la cobertura de
      // aquel momento (verificado en real contra un caso concreto). Igual
      // de aplicable a resolution: también se guarda dentro del informe.
      // Ahora puede haber tocado varias dificultades a la vez — se invalida
      // una vez por cada dificultad realmente afectada, no solo una.
      const touchedDifficulties = new Set([
        ...applied.map((a) => a.difficulty),
        ...responsibilitiesApplied.map((r) => r.difficulty),
        ...avoidablesApplied.map((a) => a.difficulty),
        ...resolutionsApplied.map((r) => r.difficulty),
      ]);
      for (const difficulty of touchedDifficulties) {
        await invalidateNightFullReportsForBossDifficulty(supabase, body.bossId, difficulty);
      }

      return jsonResponse({
        ok: true,
        applied,
        skippedLowConfidence,
        skippedUndetermined,
        invalid,
        resolutionsApplied,
        resolutionsSkipped,
        resolutionContractMissing,
        responsibilitiesApplied,
        responsibilitiesSkipped,
        responsibilityContractMissing,
        avoidablesApplied,
        avoidablesSkipped,
        avoidableContractMissing,
      });
    }

    return jsonResponse({ ok: false, error: `action inválida: ${body.action}` }, 400);
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
