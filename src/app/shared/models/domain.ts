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
    healthstone?: { available: boolean; used: boolean; count: number; timestampsMs: number[] };
    healthPotion?: { used: boolean; count: number; timestampsMs: number[] };
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
  spell_id: number;
  name: string;
  /** A quién protege: personal (uno mismo), semi (uno mismo con matices), external (se lanza sobre otro) o utility. Eje distinto de survival_type. */
  category: 'personal_defensive' | 'semi_defensive' | 'external_defensive' | 'utility';
  base_cooldown_ms: number | null;
  base_duration_ms: number | null;
  synced_from_commit: string | null;
  synced_at: string | null;
  created_at: string;
  /** Confirmado a mano o aplicado desde una clasificación IA. */
  survival_type: DefensiveSurvivalType | null;
  /** Sugerencia IA sin confirmar — nunca pisa survival_type una vez fijado a mano. */
  inferred_survival_type: DefensiveSurvivalType | null;
  ai_classification: { confidence: 'high' | 'medium'; sources: string[]; notes: string; classifiedAt: string } | null;
  reviewed: boolean;
}
