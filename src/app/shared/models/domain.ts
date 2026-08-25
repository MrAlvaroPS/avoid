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
  /** §10: por qué murió, en términos accionables — no solo "qué le mató". Se decide en analyze-report a partir de la categoría de la mecánica + el perfil de daño + si recibió sanación reciente. 'unclassified' es honesto a propósito: undispelled_debuff/tank_swap_missed (hoja de ruta) todavía no se pueden distinguir con los datos que se traen hoy (haría falta events(dataType: Debuffs) y datos de amenaza) — mejor "no lo sé" que una causa inventada. */
  rootCause: 'self_positioning' | 'unsoaked_mechanic' | 'no_healing_received' | 'unclassified';
  timeMs: number;
  /** Estado de CADA defensivo de su clase en el momento exacto de morir — activo / en cooldown (+ cuánto faltaba) / disponible y sin usar / sin dato. */
  defensiveOptions?: DefensiveOption[];
  /** 'burst' = pocos golpes (<=3) en los últimos 5s y uno concentra >=60% del daño de la ventana ("le explotó"); 'sustained' = daño repartido en más golpes/tiempo; 'unknown' = sin eventos de daño en la ventana. WCL no da `overkill`, así que esto es lo más honesto que se puede afirmar con los datos reales. */
  damageProfile: 'burst' | 'sustained' | 'unknown';
  /** Daño del golpe más grande en los últimos 5s antes de morir (post-mitigación/absorción, tal cual `amount` de WCL). */
  killingBlowAmount: number | null;
  damageWindowTotal: number;
  damageWindowHits: number;
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
  /** Igual que players_hit pero con nombres — vacío en category='interrupt' (ahí players_hit es "¿se resolvió?", no un conteo de golpes). */
  players_hit_names: string[];
  avoidable: boolean | null;
  /** Uno por nombre en players_hit_names — vacío en category='interrupt'. */
  player_hit_details: PlayerMechanicHitDetail[];
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
