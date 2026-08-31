// Tipos 1:1 con las tablas reales de Supabase (schema.sql / migraciones).
// snake_case tal cual sale de postgrest — el mapeo a camelCase para la UI
// vive en mappers.ts, igual que en la versión anterior de este archivo.

// Mismo enum que el check constraint de boss_mechanics_candidates.category
// (ver migraciones 20260822000000 y 20260822080000).
export type MechanicCategory = 'tankbuster' | 'raid-damage' | 'avoidable-ground' | 'debuff-stack' | 'interrupt' | 'soak' | 'spread' | 'healing-absorb' | 'personal-target' | 'enrage';
export type MechanicResponsibility = 'tank' | 'dps' | 'healer' | 'raid' | 'personal';

export interface ReportRow {
  code: string;
  title: string;
  zone_id: number | null;
  zone_name: string | null;
  is_raid: boolean;
  start_time: number;
  end_time: number | null;
  last_processed_fight_id: number | null;
}

export interface ReportEncounterRow {
  report_code: string;
  fight_id: number;
  encounter_id: number;
  boss_name: string;
  wcl_difficulty_id: number | null;
  kill: boolean | null;
  start_time: number;
  end_time: number;
}

export interface PullRow {
  id: string;
  report_code: string;
  fight_id: number;
  boss_id: string;
  difficulty: string; // 'LFR' | 'Normal' | 'Heroic' | 'Mythic' (texto WCL, ver WCL_DIFFICULTY_NAME_BY_ID)
  pull_number: number;
  wipe_pct: number | null;
  duration_ms: number | null;
  closed_at: string;
  created_at: string;
  /** Daño recibido por TODA la raid en el tiempo (WCL graph(dataType:DamageTaken)), sumado por bucket — para el timeline visual. Null si WCL no respondió al analizar (best-effort). */
  raid_damage_taken_series: { pointIntervalMs: number; points: number[] } | null;
  /** §"cuándo se determina un wipe global... vamos a wipear" — null = no se detectó ningún cluster de muertes casi simultáneas (o el pull fue kill). Ver detectWipeCall en analyze-report. */
  wipe_call_confidence: number | null;
  /** Desglose de señales (simultaneityFraction, abilityDiversity, healingCollapseRatio, damageCollapseRatio, sustainedDeathFraction, nearEndMs) — evidencia legible del porqué, mismo espíritu que inferred_category_reasons. */
  wipe_call_signals: Record<string, number | boolean | null> | null;
  /** La decisión real que consumen fiabilidad/métricas/tendencias — auto-inicializada por analyze-report, editable por el RL vía set-wipe-call-status. */
  wipe_call_excluded: boolean;
  /** §"un ninja pull... también cuenta en la estadística de wipes" (feedback real): heurística de analyze-report — pull muy corto donde casi nadie de la raid llegó a entrar en combate. Ver detectNinjaPull en analyze-report. */
  is_ninja_pull: boolean;
  /** La puerta real que consumen intentos/wipes/fiabilidad — auto-inicializada igual que is_ninja_pull, editable por el RL vía set-ninja-pull-status. */
  ninja_pull_excluded: boolean;
  /** Señales del veredicto: durationMs, raidSize, engagedPlayerCount, engagedFraction. */
  ninja_pull_signals: Record<string, number | boolean | null> | null;
  /** §"fases de encuentro": transiciones cronológicas [{id, startTime}] EN ESTE pull, mismo espacio temporal absoluto que trigger_time_ms + fight.startTime. Null = boss sin fases definidas en WCL. */
  phase_transitions: { id: number; startTime: number }[] | null;
  /** Índice absoluto (0-based) de la fase en la que terminó el pull — mejor proxy de progreso que wipe_pct cuando boss_encounter_phases.separates_wipes es true. */
  last_phase_absolute_index: number | null;
  /** true = el pull terminó durante un intermedio, no una fase de daño normal. */
  last_phase_is_intermission: boolean | null;
  /** §"la raid debe hacerlo... no marca a nadie a propósito" (feedback real, 2026-08-29): array de {catalogId, mechanicName, actorId, actorName, timestampMs} — quién resolvió cada mecánica sin asignar de este pull (ver unassigned_mechanic_catalog). null = boss+dificultad sin ninguna fila con has_confirmed_detection=true (nunca evaluado), array vacío = evaluado y nadie la resolvió — dos cosas distintas, no colapsar. */
  unassigned_mechanic_occurrences: { catalogId: string; mechanicName: string; actorId: number; actorName: string; timestampMs: number }[] | null;
}

/** Nombre legible + metadata de cada fase de un boss — sincronizado desde WCL en analyze-report, referencia de solo lectura. */
export interface BossEncounterPhaseRow {
  boss_id: string;
  phase_id: number;
  name: string;
  is_intermission: boolean | null;
  separates_wipes: boolean | null;
}

export type DefensiveStatus = 'active' | 'available_unused' | 'on_cooldown' | 'unknown';

export interface DefensiveOption {
  spellId: number;
  name: string;
  status: DefensiveStatus;
  /** Presente solo cuando status === 'on_cooldown'. */
  cooldownRemainingMs?: number;
}

export interface DeathCause {
  mechanicId: number;
  mechanicName: string | null;
  /** Qué hace la mecánica (Blizzard Journal), no solo cómo se llama. */
  mechanicDescription?: string | null;
  /** tankbuster/raid-damage/avoidable-ground/debuff-stack/interrupt/soak/spread/healing-absorb/personal-target. Confirmada a mano si existe, si no la sugerencia de sync-boss-mechanics. */
  category?: MechanicCategory | null;
  /** Quién debe resolver principalmente la mecánica; no es el rol del jugador que murió. */
  responsibility?: MechanicResponsibility | null;
  /** true = `category` es una sugerencia automática sin confirmar todavía (ver categoryIsInferred en analyze-report). */
  categoryIsInferred?: boolean;
  avoidable: boolean | null;
  preventableWithDefensive: boolean | null;
  /** Se muestra como contexto, pero no cuenta como muerte/error/uso defensivo del jugador. */
  statisticalExclusionReason?: 'boss_melee_on_non_tank' | null;
  /** §10: por qué murió, en términos accionables — no solo "qué le mató". Se decide en analyze-report a partir de la categoría de la mecánica + el perfil de daño + si recibió sanación reciente. 'undispelled_debuff' (§"Dispels — sin ingestión de eventos de dispel", feedback real) se afirma solo con un evento Dispels real ausente para esa habilidad sobre ese jugador — antes quedaba en 'unclassified' a falta de esa evidencia. tank_swap_missed (hoja de ruta) sigue sin poder distinguirse: haría falta amenaza/stacks, que hoy no se traen — mejor "no lo sé" que una causa inventada. */
  rootCause: 'self_positioning' | 'unsoaked_mechanic' | 'no_healing_received' | 'undispelled_debuff' | 'unclassified';
  timeMs: number;
  /** §"fases de encuentro": fase activa en el momento de morir — ver boss_encounter_phases para el nombre legible. Null si el boss no tiene fases. */
  phaseId?: number | null;
  /** Estado de CADA defensivo de su clase en el momento exacto de morir — activo / en cooldown (+ cuánto faltaba) / disponible y sin usar / sin dato. */
  defensiveOptions?: DefensiveOption[];
  /** 'burst' = un golpe o varios impactos del último segundo suman >=80% de la vida máxima (o fallback temporal en logs antiguos); 'sustained' = hubo una ventana real para sanar/reaccionar; 'unknown' = sin eventos de daño. */
  damageProfile: 'burst' | 'sustained' | 'unknown';
  /** Daño del golpe más grande en los últimos 5s antes de morir (post-mitigación/absorción, tal cual `amount` de WCL). */
  killingBlowAmount: number | null;
  damageWindowTotal: number;
  damageWindowHits: number;
  /** Daño agregado dentro del último segundo antes de morir. */
  terminalBurstDamage?: number;
  burstWindowMs?: number;
  /** Recursos WCL; null/ausente en pulls analizados antes de pedir includeResources. */
  maxHitPoints?: number | null;
  burstHealthPct?: number | null;
  /** §13.4: la secuencia real de golpes en los 5s antes de morir, no solo el agregado — orden cronológico. */
  damageWindowEvents?: { time_ms: number; amount: number; ability_id: number | null; ability_name: string | null }[];
  /** Sanación real recibida en los 6s previos a morir (0 = de verdad nadie le curó nada; puede ser >0 y aun así insuficiente, historia de coaching distinta). */
  healingWindowTotal: number;
  healingWindowHits: number;
}

export interface MechanicDamageEntry {
  mechanicId: number;
  mechanicName: string | null;
  amount: number;
}

export interface DefensiveEvent {
  spellId: number;
  name: string;
}

/** Ver supabase/functions/_shared/damage-pressure-windows.ts para el diseño completo. */
export interface DefensivePressureWindowOption {
  spellId: number;
  name: string;
  survivalType: string | null;
  status: 'active' | 'available_unused' | 'on_cooldown' | 'unknown' | 'used_during_window';
  cooldownRemainingMs?: number;
}

export interface DefensivePressureWindow {
  /** Ms desde el inicio del pull — mismo espacio de tiempo que trigger_time_ms/timeMs en el resto de la app. */
  startMs: number;
  endMs: number;
  peakMs: number;
  peakValue: number;
  covered: boolean;
  /** Solo tiene sentido cuando !covered — había algo disponible (excluyendo 'emergency' sin usar) y no se cubrió. */
  coverable: boolean;
  options: DefensivePressureWindowOption[];
  /** §"relacionar 'pico de daño recibido' con una habilidad del boss, de
   * forma veraz" (feedback real, 2026-08-29): abilityGameID con más daño
   * real dentro de la ventana (±2s de margen) — nombre curado si es una
   * mecánica clasificada del manifiesto, nombre real de WCL si no. null si
   * no hubo ningún evento de daño en el rango (rarísimo). */
  mechanicId: number | null;
  mechanicName: string | null;
}

export interface DefensivePressureWindows {
  /** Mediana de los buckets de daño>0 de este jugador en este pull — línea base propia usada para el umbral. */
  baselineValue: number;
  windows: DefensivePressureWindow[];
}

export interface PlayerPullRecordRow {
  id: string;
  pull_id: string;
  player_name: string;
  died: boolean;
  /** true = esta muerte formó parte de un cluster de "posible wipe call" detectado en este pull — ver pulls.wipe_call_excluded para si de verdad está excluida de las estadísticas. */
  wipe_call_cluster: boolean;
  death_cause: DeathCause | null;
  defensive_events: DefensiveEvent[];
  avoidable_damage_taken: number;
  mechanic_damage: MechanicDamageEntry[];
  dps: number | null;
  hps: number | null;
  absorbed_damage_taken: number;
  // `spellId` viene resuelto desde analyze-report cruzando TraitNodeEntry+
  // TraitDefinition de Wago DB2 contra el `id` de nodo que da WCL — puede
  // faltar (nodo sin definición de hechizo directa, p.ej. algunos nodos de
  // elección) y entonces se pinta sin tooltip en vez de inventar un ID.
  talent_build: { id: number; rank: number; nodeID: number; spellId?: number }[] | null;
  equipped_items: WclGearItem[] | null;
  /** actor.subType de WCL: "Mage", "DeathKnight"... */
  class: string | null;
  /** Resuelto vía Blizzard Game Data desde combatantInfo.specID: "Frost", "Destruction"... */
  spec: string | null;
  /** §3.1/§7.1: percentil real de WCL (Report.rankings) para este jugador en este pull — comparado contra el mundo con su misma clase/spec en este boss+dificultad. Null si WCL no pudo rankear el pull (best-effort). */
  world_rank_percent: number | null;
  /** Tamaño de la muestra sobre la que se calculó world_rank_percent. */
  world_total_parses: number | null;
  /** TODOS los casts de cada defensivo de su clase durante el pull completo (no solo el estado al morir). */
  defensive_casts: { spellId: number; name: string; timestampsMs: number[] }[];
  /** §"picos de daño... juntando ventanas de daño sufrido + defensivos" (feedback real, 2026-08-29): null solo en pulls procesados antes de este campo y aún sin backfill (ver reanalyze-defensive-pressure). */
  defensive_pressure_windows: DefensivePressureWindows | null;
  // Los dos campos internos son opcionales de verdad, no solo por si acaso:
  // los pulls procesados con una versión de analyze-report anterior a que
  // existiera esta columna tienen consumables:{} tal cual en la base de
  // datos (bug real encontrado en real: "Cannot read properties of
  // undefined (reading 'used')" al abrir uno de esos pulls antiguos).
  consumables: {
    // §"si tras sufrir daño uso la piedra es un uso correcto, usarla por
    // usarla no es correcto" (feedback real, 2026-08-30): usedReactively es
    // opcional a propósito — filas de antes de este cambio no lo tienen
    // hasta pasar por el backfill (ver migración 2026-08-30_backfill), igual
    // criterio que el resto de este comentario para consumables:{} vacío.
    healthstone?: { available: boolean; used: boolean; usedReactively?: boolean; count: number; timestampsMs: number[] };
    healthPotion?: { used: boolean; usedReactively?: boolean; count: number; timestampsMs: number[] };
  };
  created_at: string;
}

export interface WclGearItem {
  id: number;
  itemLevel?: number;
  quality?: number;
  icon?: string;
  bonusIDs?: number[];
  permanentEnchant?: number;
  gems?: unknown[];
  /** Solo presente en los slots de trinket (12/13) — resuelto vía Blizzard Item API en analyze-report. */
  name?: string | null;
}

export interface PullMechanicEventRow {
  id: string;
  pull_id: string;
  ability_id: number;
  mechanic_name: string;
  description: string | null;
  category: MechanicCategory | null;
  responsibility: MechanicResponsibility | null;
  trigger_time_ms: number;
  outcome: 'clean' | 'partial_fail' | 'fail';
  players_hit: number;
  /**
   * Igual que players_hit pero con nombres. En category='interrupt', players_hit
   * es "¿se resolvió?" (no un conteo de golpes) y este array es distinto:
   * o bien vacío (fail — no sabemos quién tenía la asignación de kick) o
   * bien EXACTAMENTE 1 nombre, quien lo interrumpió (outcome='clean').
   */
  players_hit_names: string[];
  avoidable: boolean | null;
  /** Uno por nombre en players_hit_names — vacío en category='interrupt'. */
  player_hit_details: PlayerMechanicHitDetail[];
  /** §"fases de encuentro": fase activa en trigger_time_ms — ver boss_encounter_phases para el nombre legible. Null si el boss no tiene fases. */
  phase_id: number | null;
  /** §"variable como wipefest" (feedback real, 2026-08-27): de dónde salió el umbral usado para este outcome — ver resolveSeverity en _shared/mechanic-severity.ts. null en category='interrupt' (no pasa por comparación de ratio). */
  comparison_source: 'own_history' | 'world_reference' | 'fixed_threshold' | null;
  /** Percentil (0-100) del ratio dentro de la muestra de comparison_source. null si comparison_source es 'fixed_threshold' o null. */
  comparison_percentile: number | null;
}

export interface PlayerMechanicHitDetail {
  name: string;
  damage_taken: number;
  damage_hits: number;
  healing_received: number;
  used_defensive_spell_id: number | null;
}

export interface BossReferenceStatsRow {
  boss_id: string;
  difficulty: string;
  reference_kill_duration_ms: number;
  reference_report_code: string;
  reference_fight_id: number;
  /** Cuántas kills públicas se usaron para la mediana/percentil (hasta 50). */
  reference_sample_size: number | null;
  reference_median_duration_ms: number | null;
  /** Percentil 25 (cuartil más rápido) — "el ritmo de las guilds realmente rápidas", no el máximo absoluto. */
  reference_p25_duration_ms: number | null;
  /** Fracción (0-1) de esas kills públicas con 0 muertes registradas. */
  reference_zero_death_rate: number | null;
  updated_at: string;
}

export interface PullBriefRow {
  id: string;
  pull_id: string;
  headline: string;
  improved: string[];
  regressed: string[];
  next_pull_actions: string[];
  model: string;
  created_at: string;
}

export interface BossMechanicCandidateRow {
  id: string;
  boss_id: string;
  difficulty: string;
  ability_id: number;
  name: string;
  /** Nombre en castellano (Blizzard Journal, locale=es_ES) — para localizar la habilidad en el juego/logs, no una traducción de la descripción. Null si Blizzard no lo tiene traducido todavía. */
  name_es: string | null;
  description: string | null;
  icon_url: string | null;
  sources: string[];
  observed_in_logs: boolean;
  /** Evidencia en logs públicos de referencia de esta dificultad exacta. */
  observed_in_reference_logs: boolean;
  /** Resultado oficial DB2 para esta dificultad; null si no pudo resolverse. */
  official_difficulty_applicable: boolean | null;
  /** true si esta habilidad aparece como interrumpida (extraAbilityGameID) en un log público de referencia — evidencia real, no heurística. Ver sync-boss-mechanics. */
  observed_as_interrupt: boolean;
  journal_encounter_id: number | null;
  db2_difficulty_id: number | null;
  difficulty_mapping_status: string | null;
  category: MechanicCategory | null;
  /** Acción principal: rol específico, ejecución colectiva o chequeo personal. */
  responsibility: MechanicResponsibility | null;
  /** Sugerencia automática de sync-boss-mechanics (texto del Journal + comportamiento en un log público de referencia) — nunca pisa `category` una vez confirmada a mano. */
  inferred_category: MechanicCategory | null;
  /** Evidencia legible de por qué se sugirió inferred_category — para el botón de provenance. */
  inferred_category_reasons: string[];
  /** Media de jugadores golpeados por cast de esta mecánica en el log público de referencia usado para el benchmark. */
  reference_avg_players_hit: number | null;
  reference_occurrences: number | null;
  reference_source_report: string | null;
  /** §"muestra el percentil + fuente" (feedback real, 2026-08-27): array de ratios (jugadores_golpeados/raidSize) de los logs de referencia — la muestra cruda para resolveSeverity (nivel 2, world_reference). null/vacío hasta el próximo (re)sync tras la migración que añadió esta columna. */
  reference_hit_ratio_samples: number[] | null;
  avoidable: boolean | null;
  expected_response: { type: string; scope: string } | null;
  severity_threshold: number | null;
  reviewed: boolean;
  updated_at: string;
  /** §"un botón de información con lo que dice 'notas' al preguntarle a una IA" (feedback real): solo presente en mecánicas clasificadas vía el flujo de prompt de IA — null = clasificada a mano o sin clasificar. */
  ai_classification: { confidence: 'high' | 'medium'; sources: string[]; notes: string; classifiedAt: string } | null;
  /** Instrucción práctica para ejecutar esta mecánica en este boss+dificultad. Independiente de la categoría y de la nota descriptiva. */
  resolution: string | null;
  resolution_verified_at: string | null;
}

/** §"pantalla nueva para clasificar defensivos... qué le hace al daño entrante durante una mecánica de raid" (feedback real): mitigation = lo reduce antes de que llegue, absorption = lo intercepta con un pool aparte, sustain = repara HP ya perdido, emergency = evita la muerte / dispara el margen de supervivencia. */
export type DefensiveSurvivalType = 'mitigation' | 'absorption' | 'sustain' | 'emergency';

/**
 * Fila de cooldown_catalog (§12.1) — catálogo de defensivos sincronizado
 * desde el repo real de WoWAnalyzer, no tecleado a mano. Que una fila
 * exista para una `class` no significa que TODAS sus specs la tengan: si
 * `spec` no es null, solo aplica a esa spec (o combo "Feral/Guardian" — ver
 * defensive-cooldowns.ts), y aunque sea null (toda la clase) puede seguir
 * siendo un nodo de talento que el jugador no tenga elegido — la
 * disponibilidad real por jugador la decide defensivesForClass() en
 * analyze-report cruzando spec + árbol de talentos, esta tabla es solo el
 * catálogo de lo que PUEDE llegar a existir.
 */
export interface CooldownCatalogRow {
  id: string;
  class: string;
  spec: string | null;
  /** Corrección manual por encima de `spec` — null = sin corregir, se deriva de `spec` tal cual (ver migración 20260831090000). Gana siempre que no sea null. */
  spec_override: string[] | null;
  spell_id: number;
  name: string;
  /** A quién protege: personal (uno mismo), semi (uno mismo con matices), external (se lanza sobre otro) o utility. Eje distinto de survival_type. */
  category: 'personal_defensive' | 'semi_defensive' | 'external_defensive' | 'utility';
  base_cooldown_ms: number | null;
  base_duration_ms: number | null;
  synced_from_commit: string | null;
  synced_at: string | null;
  created_at: string;
  /** §"si actualiza un defensivo... aviso de que se recomienda sincronizar" (feedback real, 2026-08-31) — para saber si una auto-asignación en "Preparación" quedó vieja frente a una edición posterior del catálogo. */
  updated_at: string;
  /** Confirmado a mano o aplicado desde una clasificación IA. */
  survival_type: DefensiveSurvivalType | null;
  /** Sugerencia IA sin confirmar — nunca pisa survival_type una vez fijado a mano. */
  inferred_survival_type: DefensiveSurvivalType | null;
  ai_classification: { confidence: 'high' | 'medium'; sources: string[]; notes: string; classifiedAt: string } | null;
  reviewed: boolean;
  /** §"el greater invisibility del mago ya no es un defensivo... no tengo opción de quitarlo" (feedback real, 2026-08-31): true = ya no cuenta como defensivo real (rediseñado en un parche posterior) — corrección manual, nunca la toca el extractor de WoWAnalyzer ni un resync. defensivesForSpec/DefensiveCatalogService.listAll() lo filtran. */
  excluded: boolean;
}

/**
 * Fila de boss_mechanic_defensive_profile (§"Preparación" — ver plan
 * guardado, conversación real 2026-08-30): peligrosidad/timing por mecánica,
 * separado de BossMechanicCandidateRow (otro consumidor: severidad de
 * mecánica evitable) aunque comparten clave (boss_id, difficulty,
 * ability_id). Los campos reference_* y requires_defensive(_source) SOLO los
 * escribe sync-mechanic-defensive-profile; requires_group_split/
 * group_split_notes/reviewed SOLO la edición manual — mismo contrato que
 * BossMechanicCandidateRow.
 */
export interface BossMechanicDefensiveProfileRow {
  id: string;
  boss_id: string;
  difficulty: string;
  ability_id: number;
  /** Daño (amount+absorbed) en hits SIN un defensivo de %-reducción activo en el objetivo — la señal cruda, no amortiguada por logs de referencia ya bien jugados. */
  reference_unmitigated_damage_samples: number[];
  /** Mismos hits pero CON un defensivo activo — delta real de mitigación observado. */
  reference_mitigated_damage_samples: number[];
  /** Contadores CRUDOS acumulados entre sincronizaciones (no fracciones — no se pueden fusionar entre tandas sin perder precisión) — divide por la suma de los tres para el %. */
  reference_role_hit_breakdown: { tank: number; healer: number; dps: number } | null;
  /** Ms desde pull-start de cada ocurrencia observada — solo timeline/preview, nunca el trigger real (ver MrtBossmodTrigger). */
  reference_cast_offset_ms_samples: number[];
  reference_sample_fight_count: number;
  /** 1-5, relativo a las demás mecánicas de este boss+dificultad (quintil por impacto) — null = sin evidencia todavía. */
  priority: number | null;
  requires_defensive: boolean | null;
  /** Mismo vocabulario que SeveritySource (_shared/mechanic-severity.ts) + 'manual_override'. */
  requires_defensive_source: 'own_history' | 'world_reference' | 'fixed_threshold' | 'manual_override' | null;
  requires_group_split: boolean;
  group_split_notes: string | null;
  reviewed: boolean;
  updated_at: string;
}

/** Fila de mechanic_defensive_assignments — asignación curada a mano de qué defensivo de qué spec cubre qué mecánica, para el generador de reminders MRT. */
export interface MechanicDefensiveAssignmentRow {
  id: string;
  boss_id: string;
  difficulty: string;
  ability_id: number;
  class: string;
  spec: string;
  /** Referencia lógica a cooldown_catalog.spell_id para esta class+spec (sin FK, ver migración). */
  defensive_spell_id: number;
  prewarn_seconds: number;
  trigger_type: 'bossmod' | 'time';
  /** Normalmente = ability_id; distinto solo si el timer real de BigWigs/DBM usa otro spellID. */
  bossmod_spell_id: number | null;
  notes: string | null;
  /** Grupos de raid (1-6) a los que aplica — null = todos/sin restringir. Solo informativo (se refleja en el texto del reminder), MRT no filtra por esto — ver migración 20260831130000. */
  assigned_groups: number[] | null;
  updated_at: string;
}

/** §"la raid debe hacerlo... no marca a nadie a propósito" (feedback real,
 * 2026-08-29): mecánicas de un boss donde cualquier jugador elegible puede
 * actuar sin asignación fija (huevos, orbes, ítems) — ver unassigned_mechanic_catalog
 * en supabase/migrations/20260829030000_unassigned_mechanics.sql. Catálogo
 * aparte de BossMechanicCandidateRow (esa es 100% Journal — peligros a
 * evitar/responder; esta es acciones de utilidad que SUMAN, nunca restan). */
export interface UnassignedMechanicCatalogRow {
  id: string;
  boss_id: string;
  difficulty: string;
  name: string;
  detection_type: 'cast' | 'debuff_applied' | 'buff_applied' | 'npc_interaction';
  /** Exactamente uno de estos dos según detection_type — ver constraint unassigned_mechanic_has_target. */
  ability_id: number | null;
  actor_name_pattern: string | null;
  applied_by: 'npc' | 'self' | null;
  eligible_roles: string[] | null;
  consequence_ability_id: number | null;
  /** §verificado 2026-08-29: gate real — solo entra en analyze-report/reanalyze-unassigned-mechanics cuando esto es true. Una fila puede estar `reviewed` (clasificación correcta) sin tener detección confirmada todavía (investigada, sin señal real en WCL). */
  has_confirmed_detection: boolean;
  reviewed: boolean;
  ai_confidence: string | null;
  ai_notes: string | null;
  created_at: string;
  updated_at: string;
}
