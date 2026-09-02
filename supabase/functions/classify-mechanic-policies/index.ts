import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';
import {
  applyPolicyConfidenceGuard,
  responsibilityModeFromClassification,
  validateCausalPolicy,
  type CausalPolicyInput,
  type PolicyResearchConfidence,
} from '../_shared/mechanic-policy-classification.ts';
import {
  partitionReadyMechanicPolicyDifficulties,
  type SkippedMechanicPolicyDifficulty,
} from '../_shared/mechanic-policy-scope.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

const PROMPT_VERSION = 2;
const MAX_POLICY_BATCH_SIZE = 20;
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

interface Body {
  bossId?: unknown;
  difficulty?: unknown;
  action?: unknown;
  rawResponseText?: unknown;
}

interface CandidateRow {
  ability_id: number;
  mechanic_key: string | null;
  name: string;
  difficulty: string;
  category: string | null;
  resolution: string | null;
  responsibility: string | null;
  avoidable: boolean | null;
  ai_classification: Record<string, unknown> | null;
}

interface CurrentPolicyRow {
  mechanic_key: string;
  difficulty: string;
  policy_version: number;
  targeting_mode: string;
  responsibility_mode: string;
  damage_semantics: string;
  failure_propagation: string;
  assignment_mode: string;
  defensive_expectation: string;
  credit_scope: string;
  penalty_scope: string;
  confidence: 'verified' | 'inferred' | 'fallback' | 'uncertain';
}

interface PolicyClassificationEntry {
  abilityId?: unknown;
  mechanicKey?: unknown;
  difficulty?: unknown;
  confidence?: unknown;
  sources?: unknown;
  notes?: unknown;
  causalPolicy?: unknown;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function independentSourceDomain(hostname: string): string {
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length <= 2) return hostname;
  const commonSecondLevelLabels = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org']);
  const countryCodeSuffix = parts.at(-1)?.length === 2 && commonSecondLevelLabels.has(parts.at(-2) ?? '');
  return parts.slice(countryCodeSuffix ? -3 : -2).join('.');
}

function normalizedPublicSources(value: unknown): { ok: true; sources: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) return { ok: false, reason: 'sources debe ser un array' };
  const unique = new Map<string, string>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    try {
      const directUrl = raw.trim().match(/https?:\/\/[^\s\])]+/)?.[0];
      if (!directUrl) continue;
      const parsed = new URL(directUrl);
      const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
      if (!hostname.includes('.') || hostname === 'localhost') continue;
      if (['google.com', 'bing.com', 'duckduckgo.com', 'search.yahoo.com'].some((host) => hostname === host || hostname.endsWith(`.${host}`))) continue;
      parsed.hash = '';
      unique.set(parsed.toString(), independentSourceDomain(hostname));
    } catch {
      // La fila se rechaza abajo si no quedan dos fuentes verificables.
    }
  }
  if (unique.size < 2) return { ok: false, reason: 'faltan dos URLs públicas válidas' };
  if (new Set(unique.values()).size < 2) return { ok: false, reason: 'las fuentes deben proceder de dos dominios distintos' };
  return { ok: true, sources: [...unique.keys()] };
}

function buildSystemPrompt(bossName: string, difficulties: string[], rowCount: number): string {
  return `Eres un investigador experto en causalidad de encuentros de raid de World of Warcraft. HOY es ${todayIso()}. Vas a definir MechanicPolicy evaluables para TODAS las mecánicas disponibles de ${bossName} en estas dificultades: ${difficulties.join(', ')}. Usa el catálogo ya clasificado como entrada autoritativa. Este prompt contiene ${rowCount} filas: no reclasifiques category, resolution, responsibility ni avoidable.

La misma habilidad puede aparecer en varias dificultades. Trata cada fila abilityId+mechanicKey+difficulty como una investigación independiente: una policy puede coincidir entre dificultades, pero no la copies sin comprobar que targeting, resolución, asignación y atribución siguen siendo iguales. El officer pegará una única respuesta; la aplicación la dividirá internamente por dificultad y en lotes de ${MAX_POLICY_BATCH_SIZE} para proteger los workers.

Contrasta CADA policy con al menos dos fuentes públicas, actuales e independientes (dos dominios distintos). Prioriza Dungeon Journal/guías vigentes de Wowhead, Icy Veins, Method, Mythic Trap, Liquid, Warcraft Logs o documentación equivalente. Las fuentes deben respaldar la selección real de objetivos, el resultado de ejecutar o fallar y la atribución posible; una tooltip aislada no basta. Si las fuentes discrepan, no identifican esta dificultad o WCL no permite atribuir responsable, usa confidence:"low" y scopes no punitivos.

Devuelve ÚNICAMENTE un array JSON válido, sin markdown, con exactamente un objeto por fila:
{
  "abilityId": number,
  "mechanicKey": string,
  "difficulty": string,
  "confidence": "high" | "medium" | "low",
  "sources": string[],
  "notes": string,
  "causalPolicy": {
    "targetingMode": "tank" | "selected_player" | "group" | "raid" | "ground" | "object" | "none" | "mixed",
    "damageSemantics": "mandatory" | "avoidable" | "partly_avoidable" | "failure_consequence" | "none",
    "failurePropagation": "self" | "nearby_players" | "group" | "raid" | "chained" | "none",
    "assignmentMode": "none" | "target_derived" | "role_derived" | "plan_optional" | "plan_required",
    "defensiveExpectation": "none" | "optional" | "recommended" | "required" | "contingency_only",
    "creditScope": "resolver" | "target" | "group" | "raid" | "none",
    "penaltyScope": "owner" | "assignee" | "role" | "raid_only" | "none"
  }
}

Reglas causales:
- targetingMode describe cómo el encuentro elige el objetivo, no quién acaba recibiendo daño colateral.
- damageSemantics describe el daño observado al ejecutar bien: mandatory, avoidable, partly_avoidable, failure_consequence o none.
- failurePropagation describe el alcance del perjuicio causado por el fallo del owner.
- assignmentMode solo es plan_required cuando el encuentro exige inequívocamente una asignación previa. Una estrategia de guía opcional es plan_optional.
- defensiveExpectation solo es required si la ejecución correcta exige ese defensivo; que ayude a sobrevivir no basta.
- creditScope y penaltyScope expresan atribución demostrable. Víctimas colaterales no son owners. Si WCL no identifica al responsable, usa none.
- confidence high exige evidencia convergente y atribución inequívoca; medium conserva incertidumbre y nunca debe proponer una penalización arriesgada; low se usa cuando falta evidencia causal.

El backend aplicará guards adicionales: low se publicará como uncertain sin crédito ni penalización; medium como inferred sin penalización; high como inferred y solo entonces podrá conservar penaltyScope. No intentes eludirlos. Copia literalmente abilityId, mechanicKey y difficulty de cada fila.`;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (typeof body.bossId !== 'string' || !body.bossId.trim()) {
    return jsonResponse({ ok: false, error: 'bossId es obligatorio' }, 400);
  }
  if (body.action !== 'prompt' && body.action !== 'submit') {
    return jsonResponse({ ok: false, error: `action inválida: ${String(body.action)}` }, 400);
  }

  const bossId = body.bossId;
  const difficulty = typeof body.difficulty === 'string' && body.difficulty.trim()
    ? body.difficulty.trim()
    : null;
  if (difficulty === 'LFR') return jsonResponse({ ok: false, error: 'LFR está fuera del alcance causal' }, 400);
  if (body.action === 'submit' && !difficulty) {
    return jsonResponse({ ok: false, error: 'difficulty es obligatoria en cada lote interno de publicación' }, 400);
  }
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    let candidatesQuery = supabase
      .from('applicable_boss_mechanics_candidates')
      .select('ability_id,mechanic_key,name,difficulty,category,resolution,responsibility,avoidable,ai_classification')
      .eq('boss_id', bossId)
      .neq('difficulty', 'LFR')
      .order('difficulty', { ascending: true })
      .order('name', { ascending: true });
    let policiesQuery = supabase
      .from('boss_mechanic_policy')
      .select('mechanic_key,policy_version,targeting_mode,responsibility_mode,damage_semantics,failure_propagation,assignment_mode,defensive_expectation,credit_scope,penalty_scope,confidence,difficulty')
      .eq('boss_id', bossId)
      .neq('difficulty', 'LFR');
    if (difficulty) {
      candidatesQuery = candidatesQuery.eq('difficulty', difficulty);
      policiesQuery = policiesQuery.eq('difficulty', difficulty);
    }
    const [bossResult, candidatesResult, policiesResult] = await Promise.all([
      supabase.from('known_raid_bosses').select('boss_name').eq('encounter_id', Number(bossId)).maybeSingle(),
      candidatesQuery,
      policiesQuery,
    ]);
    if (candidatesResult.error) throw candidatesResult.error;
    if (policiesResult.error) throw policiesResult.error;

    const candidates = (candidatesResult.data ?? []) as CandidateRow[];
    if (!candidates.length) {
      return jsonResponse({ ok: false, error: `No hay mecánicas aplicables${difficulty ? ` para ${difficulty}` : ''}; sincroniza y clasifica el catálogo primero.` }, 400);
    }
    const missingIdentity = candidates.filter((candidate) => !candidate.mechanic_key?.trim());
    let candidatesInScope = candidates;
    let skippedDifficulties: SkippedMechanicPolicyDifficulty[] = [];
    if (body.action === 'prompt' && !difficulty) {
      const partition = partitionReadyMechanicPolicyDifficulties(candidates);
      candidatesInScope = partition.readyCandidates;
      skippedDifficulties = partition.skippedDifficulties;
      if (!candidatesInScope.length) {
        const detail = skippedDifficulties
          .map((entry) => `${entry.difficulty}: ${entry.missingIdentities}/${entry.totalCandidates} sin identity`)
          .join(' · ');
        return jsonResponse({
          ok: false,
          error: `Ninguna dificultad está completa para generar semántica causal. ${detail}. Ejecuta "Crear identities y policies base" cuando esas mecánicas estén disponibles.`,
          skippedDifficulties,
        }, 409);
      }
    } else if (missingIdentity.length) {
      return jsonResponse({
        ok: false,
        error: `${missingIdentity.length} mecánicas${difficulty ? ` de ${difficulty}` : ''} aún no tienen mechanic_key. Ejecuta "Crear identities y policies base" antes de generar semántica causal.`,
      }, 409);
    }

    const currentPolicies = (policiesResult.data ?? []) as CurrentPolicyRow[];
    const scopedKey = (mechanicKey: string, rowDifficulty: string): string => `${rowDifficulty}::${mechanicKey}`;
    const currentByKey = new Map(currentPolicies.map((policy) => [scopedKey(policy.mechanic_key, policy.difficulty), policy]));
    const knownByKey = new Map(candidatesInScope.map((candidate) => [scopedKey(candidate.mechanic_key!.trim(), candidate.difficulty), candidate]));
    const bossName = (bossResult.data as { boss_name: string } | null)?.boss_name ?? `Boss ${bossId}`;

    if (body.action === 'prompt') {
      const list = candidatesInScope.map((candidate) => {
        const current = currentByKey.get(scopedKey(candidate.mechanic_key!.trim(), candidate.difficulty));
        return {
          abilityId: candidate.ability_id,
          mechanicKey: candidate.mechanic_key,
          difficulty: candidate.difficulty,
          name: candidate.name,
          catalog: {
            category: candidate.category,
            resolution: candidate.resolution,
            responsibility: candidate.responsibility,
            avoidable: candidate.avoidable,
            research: candidate.ai_classification,
          },
          currentPolicy: current ?? null,
        };
      });
      const difficultiesInScope = [...new Set(list.map((entry) => entry.difficulty))];
      return jsonResponse({
        ok: true,
        promptVersion: PROMPT_VERSION,
        systemPrompt: buildSystemPrompt(bossName, difficultiesInScope, list.length),
        userMessage: `Boss: ${bossName}\nDificultades: ${difficultiesInScope.join(', ')}\nTodas las policies a investigar (${list.length} filas, una por mecánica+dificultad):\n${JSON.stringify(list, null, 2)}\n\nDevuelve exactamente ${list.length} objetos. Conserva literalmente abilityId, mechanicKey y difficulty en cada fila.`,
        policyCount: list.length,
        difficulties: difficultiesInScope,
        policyIdentities: list.map((entry) => ({
          abilityId: entry.abilityId,
          mechanicKey: entry.mechanicKey,
          difficulty: entry.difficulty,
        })),
        skippedDifficulties,
        maxBatchSize: MAX_POLICY_BATCH_SIZE,
      });
    }

    if (typeof body.rawResponseText !== 'string' || !body.rawResponseText.trim()) {
      return jsonResponse({ ok: false, error: 'rawResponseText es obligatorio para action=submit' }, 400);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.rawResponseText);
    } catch {
      return jsonResponse({ ok: false, error: 'La respuesta pegada no es JSON válido.' }, 400);
    }
    if (!Array.isArray(parsed)) return jsonResponse({ ok: false, error: 'Se esperaba un array JSON de policies.' }, 400);
    if (parsed.length > MAX_POLICY_BATCH_SIZE) {
      return jsonResponse({ ok: false, error: `El lote supera el máximo de ${MAX_POLICY_BATCH_SIZE} policies para proteger el worker.` }, 400);
    }

    const invalid: { abilityId: unknown; mechanicKey: unknown; reason: string }[] = [];
    const entries: Record<string, unknown>[] = [];
    const metadata: {
      abilityId: number;
      mechanicKey: string;
      difficulty: string;
      name: string;
      confidence: 'inferred' | 'uncertain';
    }[] = [];
    const submittedKeys = new Set<string>();
    const submittedAt = new Date().toISOString();

    for (const raw of parsed) {
      const entry = (raw ?? {}) as PolicyClassificationEntry;
      if (typeof entry.abilityId !== 'number' || typeof entry.mechanicKey !== 'string' || typeof entry.difficulty !== 'string') {
        invalid.push({ abilityId: entry.abilityId, mechanicKey: entry.mechanicKey, reason: 'abilityId, mechanicKey y difficulty son obligatorios' });
        continue;
      }
      if (entry.difficulty !== difficulty) {
        invalid.push({ abilityId: entry.abilityId, mechanicKey: entry.mechanicKey, reason: `difficulty fuera del lote: se esperaba ${difficulty}` });
        continue;
      }
      const candidate = knownByKey.get(scopedKey(entry.mechanicKey, entry.difficulty));
      if (!candidate || candidate.ability_id !== entry.abilityId) {
        invalid.push({ abilityId: entry.abilityId, mechanicKey: entry.mechanicKey, reason: 'abilityId+mechanicKey no pertenecen a este boss+dificultad' });
        continue;
      }
      if (submittedKeys.has(entry.mechanicKey)) {
        invalid.push({ abilityId: entry.abilityId, mechanicKey: entry.mechanicKey, reason: 'policy duplicada; solo se procesa la primera' });
        continue;
      }
      submittedKeys.add(entry.mechanicKey);
      if (entry.confidence !== 'high' && entry.confidence !== 'medium' && entry.confidence !== 'low') {
        invalid.push({ abilityId: entry.abilityId, mechanicKey: entry.mechanicKey, reason: 'confidence inválida' });
        continue;
      }
      if (!validateCausalPolicy(entry.causalPolicy)) {
        invalid.push({ abilityId: entry.abilityId, mechanicKey: entry.mechanicKey, reason: 'causalPolicy ausente, incompleta o con enums inválidos' });
        continue;
      }
      const sources = normalizedPublicSources(entry.sources);
      if (!sources.ok) {
        invalid.push({ abilityId: entry.abilityId, mechanicKey: entry.mechanicKey, reason: sources.reason });
        continue;
      }
      const notes = typeof entry.notes === 'string' ? entry.notes.trim().slice(0, 3_000) : '';
      const researchConfidence = entry.confidence as PolicyResearchConfidence;
      const policy = entry.causalPolicy as CausalPolicyInput;
      const guarded = applyPolicyConfidenceGuard(researchConfidence, policy);
      const displayCategory = candidate.category && VALID_CATEGORIES.has(candidate.category) ? candidate.category : null;
      entries.push({
        mechanic_key: entry.mechanicKey,
        display_name: candidate.name,
        display_category: displayCategory,
        targeting_mode: policy.targetingMode,
        required_response: candidate.resolution,
        responsibility_mode: responsibilityModeFromClassification(candidate.responsibility),
        damage_semantics: policy.damageSemantics,
        failure_propagation: policy.failurePropagation,
        assignment_mode: policy.assignmentMode,
        defensive_expectation: policy.defensiveExpectation,
        credit_scope: guarded.creditScope,
        penalty_scope: guarded.penaltyScope,
        causal_rule: {
          source: 'classify_mechanic_policies',
          promptVersion: PROMPT_VERSION,
          researchConfidence,
          proposedCreditScope: policy.creditScope,
          proposedPenaltyScope: policy.penaltyScope,
          sources: sources.sources,
          notes,
        },
        confidence: guarded.confidence,
        provenance: {
          source: 'classify_mechanic_policies',
          prompt_version: PROMPT_VERSION,
          submitted_at: submittedAt,
          batch_scope: `${bossId}:${difficulty}`,
        },
      });
      metadata.push({
        abilityId: candidate.ability_id,
        mechanicKey: entry.mechanicKey,
        difficulty,
        name: candidate.name,
        confidence: guarded.confidence,
      });
    }

    if (!entries.length) {
      return jsonResponse({ ok: true, submittedCount: parsed.length, applied: [], invalid });
    }
    const { data: publishedRows, error: publishError } = await supabase.rpc('publish_mechanic_policy_batch', {
      p_boss_id: bossId,
      p_difficulty: difficulty,
      p_entries: entries,
      p_changed_by: guard.userId,
      p_reason: `Clasificación causal automática · prompt policies v${PROMPT_VERSION}`,
    });
    if (publishError) throw publishError;
    const versionByKey = new Map(
      ((publishedRows ?? []) as { mechanic_key: string; policy_version: number }[])
        .map((row) => [row.mechanic_key, row.policy_version]),
    );
    const applied = metadata.map((item) => ({
      ...item,
      policyVersion: versionByKey.get(item.mechanicKey) ?? 0,
    }));
    return jsonResponse({
      ok: true,
      submittedCount: parsed.length,
      applied,
      invalid,
      maxBatchSize: MAX_POLICY_BATCH_SIZE,
    });
  } catch (error) {
    const message = errorMessage(error);
    console.error('classify-mechanic-policies error:', error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
