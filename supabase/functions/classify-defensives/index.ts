import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { errorMessage } from '../_shared/error-message.ts';
import { getCurrentBuildNamespace } from '../_shared/blizzard-client.ts';
import { buildFromBlizzardNamespace } from '../_shared/wago-db2-client.ts';
import { enqueueDefensiveReanalysis, type QueueClient } from '../_shared/defensive-reanalysis-queue.ts';
import { defensiveTargetingError } from '../_shared/defensive-classification-semantics.ts';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const SURVIVAL_TYPES = new Set(['mitigation', 'absorption', 'sustain', 'emergency']);
const CATEGORIES = new Set(['personal_defensive', 'semi_defensive', 'external_defensive', 'utility']);
const ACTIVATION_MODES = new Set(['active', 'passive']);
const CONFIDENCES = new Set<unknown>(['high', 'medium', 'low']);
const MODIFIER_OPERATIONS = new Set(['subtract_seconds', 'add_seconds', 'multiply', 'set_seconds', 'charges_add']);
const MODIFIER_CONDITIONS = new Set(['always', 'conditional']);
const MODIFIER_EFFECT_FIELDS = new Set(['cooldown_ms', 'duration_ms', 'charges', 'recharge_ms']);
const PROMPT_VERSION = 8;

const SURVIVAL_TYPE_GLOSSARY = `- mitigation ("Mitigación"): reduce el daño que finalmente recibes ANTES de que te reste vida — DR%, armadura, reducción física/mágica específica, dodge/parry si es un defensivo activo, damage smoothing/stagger.
- absorption ("Absorción"): añade una capa/pool de vida aparte que el daño tiene que consumir antes de afectar tu HP — escudos, barriers, absorbs, efectos tipo Ignore Pain. Se separa de mitigation porque se agota, se acumula o se rompe de una vez, no reduce un porcentaje continuo.
- sustain ("Sustain"): repara vida ya perdida o mantiene tu HP estable con el tiempo — self-heals, HoTs, regeneración activa, leech/life drain activables. El daño ya ocurrió; esto lo repara después.
- emergency ("Emergencia"): herramienta para sobrevivir a una situación crítica o daño potencialmente letal — inmunidades, cheat death, "no puedes bajar de X% HP", aumento grande temporal de vida máxima o una curación instantánea tipo panic button.

Regla de desambiguación: mitigation evita PARTE del daño antes de que llegue; absorption intercepta daño con un pool; sustain repara HP ya perdido; emergency aumenta drásticamente el margen ante daño letal. Si mezcla mecanismos, usa el que define su uso principal y explica la mezcla en notes.`;

const CATEGORY_GLOSSARY = `- personal_defensive: recurso personal; protege al caster y su targetingMode debe ser self.
- semi_defensive: recurso personal compartible; puede proteger al caster o a un aliado de forma equivalente y su targetingMode debe ser both. Power Word: Shield entra aquí si el Priest puede lanzárselo a sí mismo.
- external_defensive: recurso de raid, NO un defensivo personal del caster. Su targetingMode debe ser ally si se lanza sobre una persona (ejemplo: Pain Suppression) o raid si crea una cobertura de grupo/área (ejemplo: Anti-Magic Zone). Aunque el caster pueda beneficiarse al estar dentro del área, no lo reclasifiques como personal o semi.
- utility: no aporta por sí mismo mitigación/absorción/sustain/emergencia relevante para sobrevivir una mecánica de raid.

targetingMode y category son obligatorios y no son sinónimos: targetingMode describe a quién puede proteger realmente el spell; category decide si el sistema puede contarlo como recurso personal. Nunca contabilices external_defensive como cobertura personal del caster.`;

function buildSystemPrompt(className: string | null, gameBuild: string): string {
  const scope = className
    ? `la clase "${className}"`
    : 'TODAS las clases de World of Warcraft retail; cada entrada conocida trae su propia class';

  return `Eres un investigador experto en World of Warcraft retail. HOY es ${todayIso()}. Investiga el PARCHE RETAIL VIGENTE HOY; no uses datos de Classic ni de expansiones/parches antiguos salvo para descartarlos explícitamente.

GAME BUILD OBJETIVO: ${gameBuild}. Debes copiar este valor literalmente en gameBuild del objeto JSON raíz. Si vale legacy-current, la aplicación no pudo verificar el build exacto y conservará las reglas con confidence de fallback.

Tu trabajo tiene DOS FASES OBLIGATORIAS e independientes para ${scope}:

FASE 1 — AUDITAR el catálogo existente.
Revisa CADA habilidad de knownDefensives. No des por buenos class/spec/category/cooldown/duration solo porque vengan en la entrada: son precisamente datos que pueden estar mal. Para cada habilidad verifica:
1) si sigue siendo un defensivo real hoy;
2) TODAS las specs que pueden tenerla hoy (baseline, árbol de clase o árbol de spec);
3) category y survivalType;
4) cooldown BASE sin talentos/pasivas modificadoras y duración BASE del efecto;
5) diferencias base reales por spec, si existen;
6) TODOS los talentos/pasivas actuales que cambian cooldown, duración o cargas.

FASE 2 — DESCUBRIR defensivos que FALTAN.
NO te limites a knownDefensives. Haz una auditoría independiente del toolkit actual de cada clase/spec dentro del alcance y busca habilidades de supervivencia ausentes del listado: DR activos, inmunidades, absorbs/barriers/shields, aumentos temporales de vida, self-heals/HoTs relevantes y habilidades targeteables que también puedan lanzarse sobre uno mismo. El hecho de que WoWAnalyzer no modele una habilidad como "cooldown" NO es motivo para omitirla. Ejemplo de criterio: Power Word: Shield debe considerarse porque un Priest puede lanzárselo a sí mismo y usar el absorb antes de daño entrante.

No incluyas como missingDefensive una pasiva siempre activa sin botón/ventana planificable salvo que tenga un proc defensivo con cooldown/ICD claramente utilizable por el sistema. No incluyas throughput de healer puro que no constituya una herramienta de supervivencia propia razonable.

FUENTES: para CADA habilidad conocida y CADA descubrimiento contrasta al menos DOS fuentes reales y recientes. Prioriza Wowhead retail (tooltip actual), Warcraft Wiki con cambios del parche actual, documentación oficial de Blizzard, Icy Veins y fuentes técnicas actuales de clase. Busca por NOMBRE + class; usa spellId para identificar, no para asumir comportamiento.

SPECS: availableSpecs es una lista explícita con los nombres exactos de TODAS las especializaciones que pueden disponer de la habilidad. Distingue "la spec puede elegirla" de "todos los jugadores de esa spec la llevan": un talento del árbol de CLASE puede estar disponible para las tres specs aunque el build concreto no lo haya seleccionado. No confundas "está en una carpeta Holy de una librería" con "solo Holy la tiene".

COOLDOWNS: baseCooldownSeconds SIEMPRE es el cooldown base del hechizo sin talentos/pasivas que lo modifiquen. Nunca metas el valor ya reducido por un talento en el campo base. Ejemplo conceptual: si una habilidad tiene 90 s base y un talento resta 20 s, devuelve baseCooldownSeconds:90 y una regla modifiers subtract_seconds:20; NO devuelvas 70 como base. Lo mismo para duración/cargas. Usa null solo cuando realmente no exista un valor base resoluble. Un cooldown real de 0 se representa como 0, no null.

SPEC PROFILES: specProfiles solo se usa cuando una spec tiene de verdad cooldown/duración/cargas BASE distintos. NO lo uses simplemente para repetir availableSpecs.

MODIFIERS: investiga talentos/pasivas actuales que cambien timing o cargas tanto para habilidades YA conocidas como para habilidades DESCUBIERTAS. modifierSpellId debe ser el spellId real del talento/pasiva; targetSpellId el del defensivo. effectField es OBLIGATORIO y declara el campo afectado: cooldown_ms, duration_ms, charges o recharge_ms. condition:"always" si llevar el talento basta para garantizar el cambio; "conditional" si depende de casts, procs, daño recibido, recursos o ejecución durante el combate. value usa SEGUNDOS para subtract_seconds/add_seconds/set_seconds, factor para multiply y número de cargas para charges_add. charges_add exige effectField:"charges"; las demás operaciones no pueden apuntar a charges. No incluyas modificadores que solo cambian el porcentaje de DR/absorb/heal si no cambian cooldown, duración o cargas.

CATEGORÍAS:
${CATEGORY_GLOSSARY}

DISPONIBILIDAD ACTIVA/PASIVA:
- activationMode:"active" significa que existe un botón planificable en la configuración base investigada; "passive" nunca puede asignarse ni generar reminder.
- passiveConversionSpellIds contiene los spellId de talentos seleccionables que convierten ese botón en pasiva o eliminan su versión activa. Ejemplo conceptual: si Healing Elixir deja de ser botón al elegir un talento concreto, conserva activationMode:"active" y añade el spellId de ese talento conversor.
- availableSpecs sigue siendo obligatorio: no declares una habilidad para una spec que no pueda disponer de su versión activa.

TIPOS DE SUPERVIVENCIA:
${SURVIVAL_TYPE_GLOSSARY}

Si una habilidad existente ya no es defensiva, stillDefensive:false. Nunca inventes un survivalType para conservarla. Si hay ambigüedad material, confidence:"low"; el backend no aplicará automáticamente datos low.

Responde ÚNICAMENTE con JSON válido y compacto, sin explicaciones. Se acepta JSON crudo (preferido) o un único bloque markdown \`\`\`json. No repitas tooltips largos: notes y description deben ser breves. Usa ESTE objeto raíz exacto:
{
  "promptVersion": 8,
  "gameBuild": "${gameBuild}",
  "reviewedDefensives": [
    {
      "spellId": number,
      "stillDefensive": boolean,
      "availableSpecs": string[],
      "category": "personal_defensive" | "semi_defensive" | "external_defensive" | "utility",
      "targetingMode": "self" | "ally" | "both" | "raid" | "unknown",
      "activationMode": "active" | "passive",
      "passiveConversionSpellIds": number[],
      "survivalType": "mitigation" | "absorption" | "sustain" | "emergency" | null,
      "confidence": "high" | "medium" | "low",
      "sources": string[],
      "notes": "explicación breve y concreta",
      "baseCooldownSeconds": number | null,
      "baseDurationSeconds": number | null,
      "specProfiles": [
        { "spec": "spec exacta", "baseCooldownSeconds": number | null, "baseDurationSeconds": number | null, "charges": number, "source": "URL o referencia" }
      ],
      "modifiers": [
        { "modifierSpellId": number, "modifierName": "string", "targetSpellId": number, "specs": string[] | null, "effectField": "cooldown_ms" | "duration_ms" | "charges" | "recharge_ms", "operation": "subtract_seconds" | "add_seconds" | "multiply" | "set_seconds" | "charges_add", "value": number, "perRank": boolean, "condition": "always" | "conditional", "description": "string", "source": "URL o referencia" }
      ]
    }
  ],
  "missingDefensives": [
    {
      "spellId": number,
      "name": "nombre exacto",
      "class": "class exacta como en knownDefensives",
      "stillDefensive": true,
      "availableSpecs": string[],
      "category": "personal_defensive" | "semi_defensive" | "external_defensive" | "utility",
      "targetingMode": "self" | "ally" | "both" | "raid" | "unknown",
      "activationMode": "active" | "passive",
      "passiveConversionSpellIds": number[],
      "survivalType": "mitigation" | "absorption" | "sustain" | "emergency",
      "confidence": "high" | "medium" | "low",
      "sources": string[],
      "notes": "por qué falta y cómo sirve para sobrevivir",
      "baseCooldownSeconds": number | null,
      "baseDurationSeconds": number | null,
      "specProfiles": [
        { "spec": "spec exacta", "baseCooldownSeconds": number | null, "baseDurationSeconds": number | null, "charges": number, "source": "URL o referencia" }
      ],
      "modifiers": [
        { "modifierSpellId": number, "modifierName": "string", "targetSpellId": number, "specs": string[] | null, "effectField": "cooldown_ms" | "duration_ms" | "charges" | "recharge_ms", "operation": "subtract_seconds" | "add_seconds" | "multiply" | "set_seconds" | "charges_add", "value": number, "perRank": boolean, "condition": "always" | "conditional", "description": "string", "source": "URL o referencia" }
      ]
    }
  ]
}

reviewedDefensives DEBE contener exactamente un objeto por cada spellId de knownDefensives, sin omitir ninguno. missingDefensives puede estar vacío, pero debes haber hecho la fase de descubrimiento antes de decidirlo. Todos los objetos deben incluir todas sus claves. Devuelve el JSON minificado si tu interfaz tiene un límite de salida.`;
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
  effectField: 'cooldown_ms' | 'duration_ms' | 'charges' | 'recharge_ms';
  /** Respuestas v5 ya copiadas no traían effectField; nunca se guardan como regla exacta. */
  effectFieldWasExplicit: boolean;
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
  availableSpecs?: string[];
  category?: string;
  targetingMode?: string;
  activationMode?: string;
  passiveConversionSpellIds?: number[];
  survivalType: string | null;
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
  notes: string;
  baseCooldownSeconds: number | null;
  baseDurationSeconds: number | null;
  specProfiles?: SpecProfileEntry[];
  modifiers?: ModifierEntry[];
}

interface MissingDefensiveEntry extends ClassificationEntry {
  name: string;
  class: string;
}

interface CatalogRow {
  spell_id: number;
  name: string;
  class: string;
  spec: string | null;
  spec_override: string[] | null;
  category: string;
  targeting_mode: string;
  activation_mode: string;
  passive_conversion_spell_ids: number[];
  activation_game_build: string;
  survival_type: string | null;
  inferred_survival_type: string | null;
  base_cooldown_ms: number | null;
  base_duration_ms: number | null;
}

function secondsToMs(value: number | null | undefined): number | null {
  return value == null ? null : Math.round(value * 1000);
}

function validNullableNonNegative(value: unknown): boolean {
  return value == null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function normalizeSpecs(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const specs = [...new Set(value.filter((spec): spec is string => typeof spec === 'string').map((spec) => spec.trim()).filter(Boolean))];
  return specs.length ? specs : null;
}

function normalizeSpellIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((spellId) => typeof spellId !== 'number' || !Number.isInteger(spellId) || spellId <= 0)) return null;
  return [...new Set(value)].sort((left, right) => left - right);
}

function specsToCatalogValue(specs: string[] | null, fallback: string | null): string | null {
  if (!specs?.length) return fallback;
  return specs.join('/');
}

function parseResponse(parsed: unknown): { reviewed: unknown[]; missing: unknown[]; gameBuild: string | null; promptVersion: number | null } | null {
  // Backward compatibility with a v3/v4 answer that may already be copied in
  // a browser while this deploy happens. Legacy entries do NOT reconcile the
  // new profile/modifier tables unless those arrays are actually present.
  if (Array.isArray(parsed)) return { reviewed: parsed, missing: [], gameBuild: null, promptVersion: null };
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { promptVersion?: unknown; gameBuild?: unknown; reviewedDefensives?: unknown; missingDefensives?: unknown };
  if (!Array.isArray(obj.reviewedDefensives) || !Array.isArray(obj.missingDefensives)) return null;
  return {
    reviewed: obj.reviewedDefensives,
    missing: obj.missingDefensives,
    gameBuild: typeof obj.gameBuild === 'string' && obj.gameBuild.trim() ? obj.gameBuild.trim() : null,
    promptVersion: typeof obj.promptVersion === 'number' && Number.isInteger(obj.promptVersion) ? obj.promptVersion : null,
  };
}

function jsonPayload(raw: string): string {
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function validateProfiles(entry: Partial<ClassificationEntry>): { rows: SpecProfileEntry[]; error?: string } {
  const raw = Array.isArray(entry.specProfiles) ? entry.specProfiles : [];
  const rows: SpecProfileEntry[] = [];
  for (const profile of raw) {
    if (!profile || typeof profile.spec !== 'string' || !profile.spec.trim()) return { rows: [], error: 'specProfiles contiene una spec inválida' };
    if (!validNullableNonNegative(profile.baseCooldownSeconds) || !validNullableNonNegative(profile.baseDurationSeconds)) {
      return { rows: [], error: 'specProfiles contiene cooldown/duración inválidos' };
    }
    if (typeof profile.charges !== 'number' || !Number.isInteger(profile.charges) || profile.charges <= 0) {
      return { rows: [], error: 'specProfiles contiene charges inválidas' };
    }
    rows.push({
      spec: profile.spec.trim(),
      baseCooldownSeconds: profile.baseCooldownSeconds ?? null,
      baseDurationSeconds: profile.baseDurationSeconds ?? null,
      charges: profile.charges,
      source: typeof profile.source === 'string' ? profile.source : '',
    });
  }
  return { rows };
}

function validateModifiers(
  entry: Partial<ClassificationEntry>,
  spellId: number,
  requireExplicitEffectField: boolean,
): { rows: ModifierEntry[]; error?: string } {
  const raw = Array.isArray(entry.modifiers) ? entry.modifiers : [];
  const rows: ModifierEntry[] = [];
  for (const modifier of raw) {
    if (!modifier || typeof modifier.modifierSpellId !== 'number' || !Number.isInteger(modifier.modifierSpellId) || modifier.modifierSpellId <= 0) {
      return { rows: [], error: 'modifiers contiene modifierSpellId inválido' };
    }
    if (modifier.targetSpellId !== spellId) return { rows: [], error: 'modifier targetSpellId no coincide con el defensivo' };
    if (!MODIFIER_OPERATIONS.has(modifier.operation)) return { rows: [], error: `operation inválida: ${modifier.operation}` };
    if (!MODIFIER_CONDITIONS.has(modifier.condition)) return { rows: [], error: `condition inválida: ${modifier.condition}` };
    const effectFieldWasExplicit = typeof modifier.effectField === 'string' && MODIFIER_EFFECT_FIELDS.has(modifier.effectField);
    if (requireExplicitEffectField && !effectFieldWasExplicit) {
      return { rows: [], error: `effectField es obligatorio en respuestas v${PROMPT_VERSION} versionadas` };
    }
    const effectField = effectFieldWasExplicit
      ? modifier.effectField as ModifierEntry['effectField']
      : modifier.operation === 'charges_add'
        ? 'charges'
        : 'cooldown_ms';
    if (modifier.effectField != null && !effectFieldWasExplicit) return { rows: [], error: `effectField inválido: ${modifier.effectField}` };
    if ((modifier.operation === 'charges_add') !== (effectField === 'charges')) {
      return { rows: [], error: `operation ${modifier.operation} incompatible con effectField ${effectField}` };
    }
    if (typeof modifier.value !== 'number' || !Number.isFinite(modifier.value) || modifier.value < 0) return { rows: [], error: 'modifier value inválido' };
    if (typeof modifier.perRank !== 'boolean') return { rows: [], error: 'modifier perRank inválido' };
    const specs = modifier.specs == null ? null : normalizeSpecs(modifier.specs);
    if (modifier.specs != null && !specs) return { rows: [], error: 'modifier specs inválido' };
    rows.push({
      modifierSpellId: modifier.modifierSpellId,
      modifierName: typeof modifier.modifierName === 'string' ? modifier.modifierName : `#${modifier.modifierSpellId}`,
      targetSpellId: spellId,
      specs,
      effectField,
      effectFieldWasExplicit,
      operation: modifier.operation,
      value: modifier.value,
      perRank: modifier.perRank,
      condition: modifier.condition,
      description: typeof modifier.description === 'string' ? modifier.description : '',
      source: typeof modifier.source === 'string' ? modifier.source : '',
    });
  }
  return { rows };
}

function modifierDbOperation(operation: ModifierEntry['operation']): 'subtract_ms' | 'add_ms' | 'multiply' | 'set_ms' | 'charges_add' {
  if (operation === 'subtract_seconds') return 'subtract_ms';
  if (operation === 'add_seconds') return 'add_ms';
  if (operation === 'set_seconds') return 'set_ms';
  return operation;
}

function modifierDbValue(modifier: ModifierEntry): number {
  return modifier.operation === 'subtract_seconds' || modifier.operation === 'add_seconds' || modifier.operation === 'set_seconds'
    ? Math.round(modifier.value * 1000)
    : modifier.value;
}

async function resolveCurrentGameBuild(): Promise<string> {
  try {
    const namespace = await getCurrentBuildNamespace();
    return namespace ? buildFromBlizzardNamespace(namespace) : 'legacy-current';
  } catch (err) {
    console.error('classify-defensives: no se pudo verificar el game build actual; se usará legacy-current:', err);
    return 'legacy-current';
  }
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  let body: { class?: string | null; action?: string; rawResponseText?: string; expectedGameBuild?: string | null };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.action) return jsonResponse({ ok: false, error: 'action es obligatoria' }, 400);
  if ((body.action === 'prompt' || body.action === 'submit') && !body.class?.trim()) {
    return jsonResponse(
      {
        ok: false,
        error: 'La auditoría se procesa por clase para evitar respuestas truncadas. Selecciona una clase concreta.',
      },
      400,
    );
  }

  const scopeLabel = body.class ?? 'todas las clases';
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    let query = supabase
      .from('cooldown_catalog')
      .select('spell_id,name,class,spec,spec_override,category,targeting_mode,activation_mode,passive_conversion_spell_ids,activation_game_build,survival_type,inferred_survival_type,base_cooldown_ms,base_duration_ms')
      .order('class', { ascending: true })
      .order('name', { ascending: true });
    if (body.class) query = query.eq('class', body.class);
    const { data: rows, error: rowsError } = await query;
    if (rowsError) throw rowsError;
    const defensives = (rows ?? []) as CatalogRow[];

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
      const gameBuild = await resolveCurrentGameBuild();
      const list = defensives.map((d) => ({
        spellId: d.spell_id,
        name: d.name,
        class: d.class,
        currentSpec: d.spec,
        manualSpecOverride: d.spec_override,
        currentCategory: d.category,
        currentTargetingMode: d.targeting_mode,
        currentActivationMode: d.activation_mode,
        currentPassiveConversionSpellIds: d.passive_conversion_spell_ids,
        currentActivationGameBuild: d.activation_game_build,
        currentSurvivalType: d.survival_type,
        currentInferredSurvivalType: d.inferred_survival_type,
        currentBaseCooldownMs: d.base_cooldown_ms,
        currentBaseDurationMs: d.base_duration_ms,
        currentSpecProfiles: (currentProfiles ?? []).filter((profile) => profile.spell_id === d.spell_id),
        currentModifiers: (currentModifiers ?? []).filter((modifier) => modifier.target_spell_id === d.spell_id),
      }));
      const systemPrompt = buildSystemPrompt(body.class ?? null, gameBuild);
      const userMessage = `Alcance: ${scopeLabel}\nknownDefensives (${list.length} filas actuales; NO es una lista exhaustiva):\n${JSON.stringify(list)}\n\nAudita estas ${list.length} filas y después busca de forma INDEPENDIENTE las habilidades defensivas que falten. manualSpecOverride es una corrección humana, no evidencia del juego. Devuelve el objeto JSON v${PROMPT_VERSION} completo y compacto.`;
      return jsonResponse({ ok: true, promptVersion: PROMPT_VERSION, gameBuild, systemPrompt, userMessage, defensiveCount: list.length });
    }

    if (body.action === 'submit') {
      if (!body.rawResponseText) return jsonResponse({ ok: false, error: 'rawResponseText es obligatorio para action=submit' }, 400);

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonPayload(body.rawResponseText));
      } catch {
        return jsonResponse({ ok: false, error: 'La respuesta pegada no es JSON válido. Pega JSON crudo o un único bloque ```json completo.' }, 400);
      }
      const response = parseResponse(parsed);
      if (!response) return jsonResponse({ ok: false, error: 'Se esperaba el objeto JSON {promptVersion, gameBuild, reviewedDefensives, missingDefensives} (o una respuesta legacy compatible).' }, 400);
      const researchGameBuild = response.gameBuild ?? 'legacy-current';
      if (researchGameBuild !== 'legacy-current' && !/^\d+\.\d+\.\d+\.\d+$/.test(researchGameBuild)) {
        return jsonResponse({ ok: false, error: `gameBuild inválido: ${researchGameBuild}` }, 400);
      }
      if (response.gameBuild && body.expectedGameBuild !== response.gameBuild) {
        return jsonResponse(
          {
            ok: false,
            error: `La respuesta pertenece a ${response.gameBuild}, pero el prompt abierto pertenece a ${body.expectedGameBuild ?? 'un build desconocido'}. Genera un prompt nuevo.`,
          },
          409,
        );
      }

      const knownSpellIds = new Set(defensives.map((d) => d.spell_id));
      const knownClasses = new Set(defensives.map((d) => d.class));
      if (body.class) knownClasses.add(body.class);

      const applied: {
        spellId: number;
        name: string;
        class: string;
        survivalType: string;
        category: string;
        targetingMode: string;
        confidence: 'high' | 'medium';
        sources: string[];
        notes: string;
        baseCooldownMs: number | null;
        baseDurationMs: number | null;
        materialChanged: boolean;
      }[] = [];
      const added: { spellId: number; name: string; class: string; specs: string[]; category: string; survivalType: string }[] = [];
      const skippedLowConfidence: { spellId: number; name: string; survivalType: string | null; notes: string }[] = [];
      const skippedUndetermined: { spellId: number; name: string }[] = [];
      const suggestedExclusions: { spellId: number; name: string; class: string; notes: string }[] = [];
      const invalid: { spellId: unknown; reason: string }[] = [];
      const submittedAt = new Date().toISOString();
      const affectedClasses = new Set<string>();
      let appliedSpecProfiles = 0;
      let appliedModifiers = 0;

      const applyReferenceRows = async (
        className: string,
        spellId: number,
        profiles: SpecProfileEntry[],
        modifiers: ModifierEntry[],
      ): Promise<void> => {
        // A v5 rerun is authoritative for the researched timing layer. It
        // replaces stale spec profiles and deactivates modifier rules that no
        // longer appear, instead of the old "only ever append" behaviour.
        const { error: deleteProfilesError } = await supabase
          .from('defensive_spec_profiles')
          .delete()
          .eq('class', className)
          .eq('spell_id', spellId)
          .eq('game_build', researchGameBuild);
        if (deleteProfilesError) throw deleteProfilesError;

        const { error: disableModifiersError } = await supabase
          .from('defensive_modifier_rules')
          .update({ active: false, updated_at: submittedAt })
          .eq('class', className)
          .eq('target_spell_id', spellId)
          .eq('game_build', researchGameBuild)
          .eq('active', true);
        if (disableModifiersError) throw disableModifiersError;

        for (const profile of profiles) {
          const { error } = await supabase.from('defensive_spec_profiles').upsert(
            {
              class: className,
              spec: profile.spec,
              spell_id: spellId,
              base_cooldown_ms: secondsToMs(profile.baseCooldownSeconds),
              base_duration_ms: secondsToMs(profile.baseDurationSeconds),
              charges: profile.charges,
              recharge_ms: null,
              game_build: researchGameBuild,
              source: profile.source || `classify-defensives v${PROMPT_VERSION}`,
              source_note: `Investigado por prompt v${PROMPT_VERSION}; valor base específico de spec.`,
              verified_at: submittedAt,
              updated_at: submittedAt,
            },
            { onConflict: 'class,spec,spell_id,game_build' },
          );
          if (error) throw error;
          appliedSpecProfiles++;
        }

        for (const modifier of modifiers) {
          const { error } = await supabase.from('defensive_modifier_rules').upsert(
            {
              class: className,
              specs: modifier.specs,
              modifier_spell_id: modifier.modifierSpellId,
              target_spell_id: spellId,
              operation: modifierDbOperation(modifier.operation),
              effect_field: modifier.effectField,
              value: modifierDbValue(modifier),
              per_rank: modifier.perRank,
              condition: modifier.condition,
              description: modifier.description || modifier.modifierName,
              source: modifier.source,
              game_build: modifier.effectFieldWasExplicit ? researchGameBuild : 'legacy-current',
              application_order: 100,
              verified_at: submittedAt,
              active: true,
              updated_at: submittedAt,
            },
            { onConflict: 'class,modifier_spell_id,target_spell_id,operation,effect_field,game_build' },
          );
          if (error) throw error;
          appliedModifiers++;
        }
      };

      for (const raw of response.reviewed) {
        const entry = raw as Partial<ClassificationEntry>;
        if (typeof entry.spellId !== 'number' || !knownSpellIds.has(entry.spellId)) {
          invalid.push({ spellId: entry.spellId, reason: 'spellId no reconocido entre knownDefensives' });
          continue;
        }
        const matched = defensives.find((d) => d.spell_id === entry.spellId)!;
        const name = matched.name;

        if (entry.stillDefensive === false) {
          suggestedExclusions.push({ spellId: entry.spellId, name, class: matched.class, notes: entry.notes ?? '' });
          continue;
        }
        if (!CONFIDENCES.has(entry.confidence)) {
          invalid.push({ spellId: entry.spellId, reason: `confidence inválida: ${entry.confidence}` });
          continue;
        }
        if (entry.confidence === 'low') {
          skippedLowConfidence.push({ spellId: entry.spellId, name, survivalType: entry.survivalType ?? null, notes: entry.notes ?? '' });
          continue;
        }
        if (!validNullableNonNegative(entry.baseCooldownSeconds) || !validNullableNonNegative(entry.baseDurationSeconds)) {
          invalid.push({ spellId: entry.spellId, reason: 'baseCooldownSeconds/baseDurationSeconds deben ser números >= 0 o null' });
          continue;
        }
        if (entry.category != null && !CATEGORIES.has(entry.category)) {
          invalid.push({ spellId: entry.spellId, reason: `category inválida: ${entry.category}` });
          continue;
        }
        if (response.promptVersion != null && response.promptVersion >= PROMPT_VERSION && entry.targetingMode == null) {
          invalid.push({ spellId: entry.spellId, reason: `targetingMode es obligatorio en respuestas v${PROMPT_VERSION}` });
          continue;
        }
        if (response.promptVersion != null && response.promptVersion >= PROMPT_VERSION && (entry.activationMode == null || entry.passiveConversionSpellIds == null)) {
          invalid.push({ spellId: entry.spellId, reason: `activationMode y passiveConversionSpellIds son obligatorios en respuestas v${PROMPT_VERSION}` });
          continue;
        }
        if (entry.activationMode != null && !ACTIVATION_MODES.has(entry.activationMode)) {
          invalid.push({ spellId: entry.spellId, reason: `activationMode inválido: ${entry.activationMode}` });
          continue;
        }
        const passiveConversionSpellIds = entry.passiveConversionSpellIds == null
          ? matched.passive_conversion_spell_ids
          : normalizeSpellIds(entry.passiveConversionSpellIds);
        if (passiveConversionSpellIds == null) {
          invalid.push({ spellId: entry.spellId, reason: 'passiveConversionSpellIds debe ser un array de spellId positivos' });
          continue;
        }
        if (entry.survivalType != null && !SURVIVAL_TYPES.has(entry.survivalType)) {
          invalid.push({ spellId: entry.spellId, reason: `survivalType inválido: ${entry.survivalType}` });
          continue;
        }
        const profilesResult = validateProfiles(entry);
        if (profilesResult.error) {
          invalid.push({ spellId: entry.spellId, reason: profilesResult.error });
          continue;
        }
        const modifiersResult = validateModifiers(entry, entry.spellId, response.gameBuild != null);
        if (modifiersResult.error) {
          invalid.push({ spellId: entry.spellId, reason: modifiersResult.error });
          continue;
        }

        const availableSpecs = normalizeSpecs(entry.availableSpecs);
        if (entry.availableSpecs !== undefined && !availableSpecs) {
          invalid.push({ spellId: entry.spellId, reason: 'availableSpecs debe contener al menos una spec' });
          continue;
        }
        const researchedSpec = specsToCatalogValue(availableSpecs, matched.spec);
        // Null from the AI means "could not resolve", not "erase a verified
        // number". A literal zero remains a real value and is preserved.
        const baseCooldownMs = entry.baseCooldownSeconds == null ? matched.base_cooldown_ms : secondsToMs(entry.baseCooldownSeconds);
        const baseDurationMs = entry.baseDurationSeconds == null ? matched.base_duration_ms : secondsToMs(entry.baseDurationSeconds);
        const survivalType = entry.survivalType ?? matched.survival_type;
        if (entry.survivalType == null) skippedUndetermined.push({ spellId: entry.spellId, name });
        const category = entry.category ?? matched.category;
        const activationMode = entry.activationMode ?? matched.activation_mode;
        const activationGameBuild = entry.activationMode != null || entry.passiveConversionSpellIds != null
          ? researchGameBuild
          : matched.activation_game_build;
        const targetingMode = entry.targetingMode ?? (
          category !== matched.category
            ? category === 'personal_defensive'
              ? 'self'
              : category === 'semi_defensive'
                ? 'both'
                : 'unknown'
            : matched.targeting_mode
        );
        if (entry.targetingMode != null || (response.promptVersion != null && response.promptVersion >= PROMPT_VERSION)) {
          const categoryTargetingError = defensiveTargetingError(category, targetingMode);
          if (categoryTargetingError) {
            invalid.push({ spellId: entry.spellId, reason: categoryTargetingError });
            continue;
          }
        }
        const materialChanged =
          matched.spec !== researchedSpec ||
          matched.category !== category ||
          matched.targeting_mode !== targetingMode ||
          matched.activation_mode !== activationMode ||
          matched.activation_game_build !== activationGameBuild ||
          JSON.stringify(matched.passive_conversion_spell_ids) !== JSON.stringify(passiveConversionSpellIds) ||
          matched.survival_type !== survivalType ||
          matched.base_cooldown_ms !== baseCooldownMs ||
          matched.base_duration_ms !== baseDurationMs;

        const patch: Record<string, unknown> = {
          spec: researchedSpec,
          category,
          targeting_mode: targetingMode,
          activation_mode: activationMode,
          passive_conversion_spell_ids: passiveConversionSpellIds,
          activation_game_build: activationGameBuild,
          base_cooldown_ms: baseCooldownMs,
          base_duration_ms: baseDurationMs,
          ai_classification: {
            confidence: entry.confidence,
            sources: Array.isArray(entry.sources) ? entry.sources : [],
            notes: entry.notes ?? '',
            availableSpecs,
            targetingMode,
            activationMode,
            passiveConversionSpellIds,
            promptVersion: PROMPT_VERSION,
            classifiedAt: submittedAt,
          },
        };
        if (survivalType != null) {
          patch['survival_type'] = survivalType;
          patch['inferred_survival_type'] = survivalType;
        }
        if (materialChanged) patch['updated_at'] = submittedAt;

        let updateQuery = supabase.from('cooldown_catalog').update(patch).eq('spell_id', entry.spellId).eq('class', matched.class);
        if (body.class) updateQuery = updateQuery.eq('class', body.class);
        const { error } = await updateQuery;
        if (error) throw error;

        // v3 had no timing-reference arrays. Do not erase new v5 data if a
        // stale v3 prompt was already copied before deployment. v4/v5 both
        // carry these arrays, including [] when they intentionally mean none.
        const hasReferencePayload = Array.isArray(entry.specProfiles) || Array.isArray(entry.modifiers);
        if (hasReferencePayload) await applyReferenceRows(matched.class, entry.spellId, profilesResult.rows, modifiersResult.rows);
        if (materialChanged) affectedClasses.add(matched.class);

        applied.push({
          spellId: entry.spellId,
          name,
          class: matched.class,
          survivalType: survivalType ?? 'sin clasificar',
          category,
          targetingMode,
          confidence: entry.confidence === 'high' ? 'high' : 'medium',
          sources: Array.isArray(entry.sources) ? entry.sources : [],
          notes: entry.notes ?? '',
          baseCooldownMs,
          baseDurationMs,
          materialChanged,
        });
      }

      for (const raw of response.missing) {
        const entry = raw as Partial<MissingDefensiveEntry>;
        const sources = Array.isArray(entry.sources) ? entry.sources.filter((source): source is string => typeof source === 'string' && !!source.trim()) : [];
        if (typeof entry.spellId !== 'number' || !Number.isInteger(entry.spellId) || entry.spellId <= 0) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive con spellId inválido' });
          continue;
        }
        if (knownSpellIds.has(entry.spellId)) continue;
        if (typeof entry.name !== 'string' || !entry.name.trim() || typeof entry.class !== 'string' || !entry.class.trim()) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive sin name/class válidos' });
          continue;
        }
        if (body.class && entry.class !== body.class) {
          invalid.push({ spellId: entry.spellId, reason: `missingDefensive fuera del alcance ${body.class}: ${entry.class}` });
          continue;
        }
        if (!body.class && !knownClasses.has(entry.class)) {
          invalid.push({ spellId: entry.spellId, reason: `class no reconocida en el catálogo: ${entry.class}` });
          continue;
        }
        if (entry.stillDefensive === false) continue;
        if (entry.confidence !== 'high' && entry.confidence !== 'medium') {
          skippedLowConfidence.push({ spellId: entry.spellId, name: entry.name, survivalType: entry.survivalType ?? null, notes: entry.notes ?? '' });
          continue;
        }
        // Missing rows expand the source of truth, so require the two
        // independent references promised by the prompt before auto-insert.
        if (sources.length < 2) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive necesita al menos 2 fuentes antes de añadirse automáticamente' });
          continue;
        }
        if (!entry.survivalType || !SURVIVAL_TYPES.has(entry.survivalType)) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive necesita un survivalType válido' });
          continue;
        }
        if (!entry.category || !CATEGORIES.has(entry.category)) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive necesita una category válida' });
          continue;
        }
        const targetingMode = entry.targetingMode ?? (
          entry.category === 'personal_defensive' ? 'self' : entry.category === 'semi_defensive' ? 'both' : 'unknown'
        );
        if (response.promptVersion != null && response.promptVersion >= PROMPT_VERSION && entry.targetingMode == null) {
          invalid.push({ spellId: entry.spellId, reason: `missingDefensive necesita targetingMode explícito en respuestas v${PROMPT_VERSION}` });
          continue;
        }
        if (entry.targetingMode != null || (response.promptVersion != null && response.promptVersion >= PROMPT_VERSION)) {
          const categoryTargetingError = defensiveTargetingError(entry.category, targetingMode);
          if (categoryTargetingError) {
            invalid.push({ spellId: entry.spellId, reason: categoryTargetingError });
            continue;
          }
        }
        if (!validNullableNonNegative(entry.baseCooldownSeconds) || !validNullableNonNegative(entry.baseDurationSeconds)) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive con cooldown/duración inválidos' });
          continue;
        }
        const activationMode = entry.activationMode ?? 'active';
        const passiveConversionSpellIds = entry.passiveConversionSpellIds == null ? [] : normalizeSpellIds(entry.passiveConversionSpellIds);
        if (response.promptVersion != null && response.promptVersion >= PROMPT_VERSION && (entry.activationMode == null || entry.passiveConversionSpellIds == null)) {
          invalid.push({ spellId: entry.spellId, reason: `missingDefensive necesita activationMode y passiveConversionSpellIds en respuestas v${PROMPT_VERSION}` });
          continue;
        }
        if (!ACTIVATION_MODES.has(activationMode) || passiveConversionSpellIds == null) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive tiene semántica activa/pasiva inválida' });
          continue;
        }
        const availableSpecs = normalizeSpecs(entry.availableSpecs);
        if (!availableSpecs) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive necesita availableSpecs explícitas' });
          continue;
        }
        const profilesResult = validateProfiles(entry);
        if (profilesResult.error) {
          invalid.push({ spellId: entry.spellId, reason: profilesResult.error });
          continue;
        }
        const modifiersResult = validateModifiers(entry, entry.spellId, response.gameBuild != null);
        if (modifiersResult.error) {
          invalid.push({ spellId: entry.spellId, reason: modifiersResult.error });
          continue;
        }

        const baseCooldownMs = secondsToMs(entry.baseCooldownSeconds);
        const baseDurationMs = secondsToMs(entry.baseDurationSeconds);
        const { error: insertError } = await supabase.from('cooldown_catalog').insert({
          class: entry.class,
          spec: availableSpecs.join('/'),
          spell_id: entry.spellId,
          name: entry.name.trim(),
          category: entry.category,
          targeting_mode: targetingMode,
          activation_mode: activationMode,
          passive_conversion_spell_ids: passiveConversionSpellIds,
          activation_game_build: researchGameBuild,
          survival_type: entry.survivalType,
          inferred_survival_type: entry.survivalType,
          base_cooldown_ms: baseCooldownMs,
          base_duration_ms: baseDurationMs,
          reviewed: false,
          ai_classification: {
            confidence: entry.confidence,
            sources,
            notes: entry.notes ?? '',
            availableSpecs,
            targetingMode,
            activationMode,
            passiveConversionSpellIds,
            discovered: true,
            promptVersion: PROMPT_VERSION,
            classifiedAt: submittedAt,
          },
          synced_from_commit: null,
          updated_at: submittedAt,
        });
        if (insertError) throw insertError;

        await applyReferenceRows(entry.class, entry.spellId, profilesResult.rows, modifiersResult.rows);
        knownSpellIds.add(entry.spellId);
        affectedClasses.add(entry.class);
        added.push({
          spellId: entry.spellId,
          name: entry.name.trim(),
          class: entry.class,
          specs: availableSpecs,
          category: entry.category,
          survivalType: entry.survivalType,
        });
        // Keep the existing Angular result UI useful without requiring a UI
        // migration: discoveries also appear in the normal "applied" banner.
        applied.push({
          spellId: entry.spellId,
          name: entry.name.trim(),
          class: entry.class,
          survivalType: entry.survivalType,
          category: entry.category,
          targetingMode,
          confidence: entry.confidence,
          sources,
          notes: entry.notes ?? '',
          baseCooldownMs,
          baseDurationMs,
          materialChanged: true,
        });
      }

      let pullIds: string[] = [];
      let pullDiscoveryError: string | null = null;
      if (affectedClasses.size) {
        const { data: affectedRecords, error: affectedError } = await supabase
          .from('player_pull_records')
          .select('pull_id')
          .in('class', [...affectedClasses]);
        if (affectedError) {
          pullDiscoveryError = `No se pudieron descubrir los pulls afectados: ${affectedError.message}`;
        } else {
          pullIds = [...new Set((affectedRecords ?? []).map((record) => (record as { pull_id: string }).pull_id))];
        }
      }

      let reanalysisBatchId: string | null = null;
      let reanalysisJobs: { id: string; pullId: string }[] = [];
      let reanalysisQueueError: string | null = pullDiscoveryError;
      if (pullIds.length) {
        try {
          // Evita que Deno expanda recursivamente todos los genéricos del
          // cliente Supabase al comprobar este adaptador estructural mínimo.
          const queued = await enqueueDefensiveReanalysis(supabase as unknown as QueueClient, {
            pullIds,
            reason: `classify_defensives:${[...affectedClasses].sort().join(',')}`,
            scope: {
              kind: 'classification',
              classes: [...affectedClasses].sort(),
              gameBuild: researchGameBuild,
              promptVersion: PROMPT_VERSION,
            },
            requestedBy: guard.userId,
          });
          reanalysisBatchId = queued.batchId;
          reanalysisJobs = queued.jobs;
        } catch (queueError) {
          reanalysisQueueError = queueError instanceof Error ? queueError.message : String(queueError);
          console.error('No se pudo persistir la cola de reanálisis:', queueError);
        }
      }

      return jsonResponse({
        ok: true,
        applied,
        added,
        appliedSpecProfiles,
        appliedModifiers,
        gameBuild: researchGameBuild,
        skippedLowConfidence,
        skippedUndetermined,
        suggestedExclusions,
        invalid,
        pullIds,
        reanalysisBatchId,
        reanalysisJobs,
        reanalysisQueueError,
      });
    }

    return jsonResponse({ ok: false, error: `action inválida: ${body.action}` }, 400);
  } catch (err) {
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});
