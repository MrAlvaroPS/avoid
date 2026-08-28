// Colocar en: supabase/functions/_shared/wipe-call-detection.ts
// §"Hay que ver la manera de centralizar esta información y, sobretodo, en
// hacerla fiable" (feedback real, 2026-08-28): antes esta función vivía
// SOLO dentro de analyze-report/index.ts — la única manera de corregir un
// pull ya analizado (p.ej. una muerte injustamente fuera del cluster, caso
// real Pandokie/Lvp1VCbzmwTRHdQ7#38) era volver a insertar el pull entero.
// Extraída aquí para que reanalyze-wipe-call/index.ts pueda recalcular SOLO
// el veredicto de wipe call de un pull ya existente con la MISMA lógica,
// sin duplicarla — dos implementaciones del mismo cálculo divergiendo con
// el tiempo es exactamente el tipo de inconsistencia que se quiere evitar.

export interface WipeCallDeath {
  actorId: number;
  timestamp: number;
  killingAbilityGameID: number;
}

export interface WipeCallFight {
  kill: boolean | null;
  startTime: number;
  endTime: number;
  friendlyPlayers: number[];
}

export interface WipeCallThroughputEvent {
  sourceID?: number;
  timestamp?: number;
  amount?: number;
}

export interface WipeCallSignals {
  simultaneityFraction: number;
  abilityDiversity: number;
  nearEndMs: number;
  healingCollapseRatio: number | null;
  damageCollapseRatio: number | null;
  sustainedDeathFraction: number;
  unknownDeathFraction: number;
  triggerDeathsKept: number;
  alreadyCollapsedBeforeCluster: boolean;
  wipeCallStartMs: number;
  earlyMassDeath: boolean;
}

export interface WipeCallDetection {
  clusterActorIds: Set<number>;
  confidence: number;
  signals: WipeCallSignals;
}

export interface WipeCallDetectionInput {
  fight: WipeCallFight;
  /** Una entrada por jugador muerto en el fight — deathByTarget.entries() ya aplanado. */
  deaths: WipeCallDeath[];
  /** healingEventsByTarget aplanado — timestamp+amount de cada tick de sanación recibido por cualquier jugador. */
  healingEvents: { timestamp: number; amount: number }[];
  /** damageDoneEvents crudo (DamageDone, sin filtrar por friendly) — el filtro por fight.friendlyPlayers se aplica aquí dentro. */
  damageDoneEvents: WipeCallThroughputEvent[];
  /** 'burst' (un golpe dominante) apoya mecánica real; 'sustained'/'unknown' (se fue apagando) apoya wipe call — mismo dato que ya calcula computeDeathDamageProfile para cada death_cause individual, pasado como función para no acoplar este módulo al resto del pipeline de daño. */
  damageProfileOf: (actorId: number, deathTimestamp: number) => 'burst' | 'sustained' | 'unknown';
}

// §"cuándo se determina un wipe global": un cluster de muertes casi
// simultáneas cerca del final de un wipe, con señales de sanación/daño de
// la raid desplomándose justo antes y causas de muerte heterogéneas (no
// todos a la misma habilidad, que sería una mecánica real y no un wipe
// call). Solo se evalúa en wipes — un kill nunca es un wipe call por definición.
export const WIPE_CALL_MAX_DEATH_GAP_MS = 4000; // §"si te vas a WCL puedes ver que es un wipecall y nadie se tiró defensivo" (caso real Pandokie, 2026-08-28): antes se probaba una ventana fija de 8s desde cada muerte candidata y se elegía la que cazase más gente — una ventana que arrancaba unos segundos más tarde podía cazar más muertes y dejar fuera a quien murió justo antes de que "ganase" esa ventana, aunque fuese la misma avalancha. Ahora se encadenan muertes consecutivas mientras el hueco con la anterior sea corto — sin ambigüedad de qué ventana gana.
export const WIPE_CALL_MIN_FRACTION = 0.6; // §"si somos 20 y mueren 16 en 6s" ≈ 0.8 de ejemplo — 0.6 de margen para no dejar escapar el caso real
export const WIPE_CALL_NEAR_END_MS = 15_000; // el cluster tiene que estar pegado al final del pull — un pico de muertes a mitad de pull que luego se recuperó no cuenta
export const EARLY_MASS_WIPE_MS = 10_000;
export const WIPE_CALL_CONFIDENCE_THRESHOLD = 55; // 0-100 — por debajo se guarda como "posible" visible en la UI, pero NO se auto-excluye
export const WIPE_CALL_COLLAPSE_RATIO_THRESHOLD = 0.35; // sanación/daño de la raid por debajo de esta fracción de su media previa = "ya se ha desplomado" — mismo umbral para la señal de confianza y para decidir si una muerte temprana de la cadena es la causa o ya una víctima del desplome (ver triggerDeathCount más abajo)
// §"aunque sea un wipe call los primeros 2-3-4 que mueren no suelen ser
// parte de ese wipe call... es mecánica fallida seguramente, lo que deriva
// en el wipe call" (feedback real): el cluster detecta BIEN el momento en
// que "la raid da la pelea por perdida", pero las primeras muertes DENTRO
// de esa ventana suelen ser la CAUSA (un fallo real que hace evidente que
// se ha perdido), no la consecuencia — esas SÍ deben seguir contando. Se
// excluyen del cluster solo las muertes a partir de la Nª (el "pile-on"
// real), nunca las primeras — como mucho 3, y nunca más de la mitad del
// cluster si es pequeño (un cluster de 4 no puede tener "las 3 primeras"
// como causa y solo 1 de pile-on real).
export const WIPE_CALL_TRIGGER_DEATHS = 3;

export function detectWipeCall(input: WipeCallDetectionInput): WipeCallDetection | null {
  const { fight, damageProfileOf } = input;
  if (fight.kill) return null;

  const deaths = [...input.deaths].sort((a, b) => a.timestamp - b.timestamp);
  if (deaths.length < 2) return null;

  // Mayor cadena TERMINAL de muertes consecutivas con hueco corto entre
  // ellas (ver WIPE_CALL_MAX_DEATH_GAP_MS). Antes se elegía el mayor
  // cluster de todo el pull y solo después se comprobaba si estaba al
  // final: un pico grande a mitad podía tapar un wipe call terminal algo
  // menor y hacer que no se detectara ninguno — ese criterio se conserva,
  // solo cambia cómo se agrupan las muertes candidatas.
  // §"pone que ha empeorado esta noche cuando la otra está casi al 80%...
  // parece una inconsistencia" (caso real investigado, 2026-08-28): el
  // hueco de WIPE_CALL_MAX_DEATH_GAP_MS solo detecta un pile-on COMPACTO.
  // Hay wipes que se alargan — la raid deja de sanar y el boss se va
  // comiendo uno a uno cada 2-20s durante más de un minuto (caso real:
  // 12 muertes seguidas 'no_healing_received', ninguna a la misma
  // habilidad, repartidas en 84s) — el hueco entre dos muertes consecutivas
  // puede superar los 4s aunque NADIE recibiera sanación de verdad durante
  // todo ese hueco. Segundo criterio de fusión: si la sanación o el daño de
  // la raid se mantuvieron desplomados TODO el hueco entre dos muertes, se
  // encadenan igual — no importa cuántos segundos separen las muertes si
  // nadie podía salvar a nadie durante ese tramo. baseline = ritmo normal
  // ANTES de la primera muerte (antes de que nada fuera mal); un hueco
  // temprano y sano entre dos muertes tempranas y no relacionadas (p.ej.
  // dos fallos de mecánica real, cada uno en un momento distinto de un pull
  // por lo demás normal) no cumple la condición y no se fusiona.
  const firstDeathMs = deaths[0].timestamp;
  const baselineSpanMs = Math.max(1, firstDeathMs - fight.startTime);
  const baselineHealingPer10s =
    (input.healingEvents.filter((h) => h.timestamp < firstDeathMs).reduce((s, h) => s + h.amount, 0) / baselineSpanMs) * 10_000;
  const friendlyIdsForBridge = new Set(fight.friendlyPlayers);
  const baselineDamagePer10s =
    (input.damageDoneEvents
      .filter((e) => typeof e.sourceID === 'number' && friendlyIdsForBridge.has(e.sourceID) && typeof e.timestamp === 'number' && e.timestamp < firstDeathMs)
      .reduce((s, e) => s + (e.amount ?? 0), 0) /
      baselineSpanMs) *
    10_000;
  function gapStayedCollapsed(fromMs: number, toMs: number): boolean {
    const spanMs = Math.max(1, toMs - fromMs);
    const healingInGap = input.healingEvents.filter((h) => h.timestamp >= fromMs && h.timestamp < toMs).reduce((s, h) => s + h.amount, 0);
    const healingRatio = baselineHealingPer10s > 0 ? ((healingInGap / spanMs) * 10_000) / baselineHealingPer10s : null;
    const damageInGap = input.damageDoneEvents
      .filter((e) => typeof e.sourceID === 'number' && friendlyIdsForBridge.has(e.sourceID) && typeof e.timestamp === 'number' && e.timestamp >= fromMs && e.timestamp < toMs)
      .reduce((s, e) => s + (e.amount ?? 0), 0);
    const damageRatio = baselineDamagePer10s > 0 ? ((damageInGap / spanMs) * 10_000) / baselineDamagePer10s : null;
    return (
      (healingRatio != null && healingRatio <= WIPE_CALL_COLLAPSE_RATIO_THRESHOLD) ||
      (damageRatio != null && damageRatio <= WIPE_CALL_COLLAPSE_RATIO_THRESHOLD)
    );
  }

  const chains: typeof deaths[] = [];
  for (const death of deaths) {
    const lastChain = chains.at(-1);
    const lastDeath = lastChain?.at(-1);
    if (lastChain && lastDeath && (death.timestamp - lastDeath.timestamp <= WIPE_CALL_MAX_DEATH_GAP_MS || gapStayedCollapsed(lastDeath.timestamp, death.timestamp))) {
      lastChain.push(death);
    } else {
      chains.push([death]);
    }
  }
  let bestCluster: typeof deaths = [];
  for (const chain of chains) {
    if (chain.length < 2 || fight.endTime - chain.at(-1)!.timestamp > WIPE_CALL_NEAR_END_MS) continue;
    if (chain.length > bestCluster.length) bestCluster = chain;
  }
  if (bestCluster.length < 2) return null;

  const localRaidSize = fight.friendlyPlayers.length || 1;
  const aliveAtClusterStart = localRaidSize - deaths.filter((d) => d.timestamp < bestCluster[0].timestamp).length;
  const simultaneityFraction = aliveAtClusterStart > 0 ? bestCluster.length / aliveAtClusterStart : 0;
  const clusterStart = bestCluster[0].timestamp;
  const clusterEnd = bestCluster.at(-1)!.timestamp;
  const nearEndMs = fight.endTime - clusterEnd;
  const earlyMassDeath = clusterEnd - fight.startTime <= EARLY_MASS_WIPE_MS && bestCluster.length / localRaidSize >= WIPE_CALL_MIN_FRACTION;
  if (simultaneityFraction < WIPE_CALL_MIN_FRACTION) return null;

  // Señal 1: diversidad de killing ability — 0 = todos murieron a la MISMA
  // habilidad (mecánica real), 1 = todos a algo distinto (cada uno se
  // murió a lo que tenía encima, típico de "ya nadie reacciona").
  const knownAbilities = bestCluster.map((d) => d.killingAbilityGameID).filter((id) => id > 0);
  const distinctAbilities = new Set(knownAbilities).size;
  const abilityDiversity = knownAbilities.length > 1 ? Math.min(1, (distinctAbilities - 1) / (knownAbilities.length - 1)) : 0;
  const unknownDeathFraction = bestCluster.filter((d) => d.killingAbilityGameID === 0).length / bestCluster.length;

  // §"solo si la muerte precede a la caída de sanación/daño" (criterio
  // elegido, 2026-08-28): las primeras muertes de la cadena solo se dan
  // por "causa real" si la raid todavía sanaba/hacía daño con normalidad
  // justo antes de morir la primera. Si sanación o daño YA estaban
  // desplomados en los 5s previos (p.ej. un healer que muere cuando la
  // sanación llevaba rato cayendo — caso real Pandokie, healing ya caído
  // desde antes de las 3:00 en WCL) esa primera muerte es una víctima más
  // del mismo desplome, no su causa: el recorte no se aplica y el límite
  // pasa a ser la propia primera muerte de la cadena.
  const PRE_COLLAPSE_WINDOW_MS = 5000;
  const preCollapseWindowStart = Math.max(fight.startTime, clusterStart - PRE_COLLAPSE_WINDOW_MS);
  const preCollapseBaselineMs = Math.max(1, preCollapseWindowStart - fight.startTime);
  const preCollapseSpanMs = Math.max(1, clusterStart - preCollapseWindowStart);
  const avgHealingBeforePreCheck =
    (input.healingEvents.filter((h) => h.timestamp < preCollapseWindowStart).reduce((s, h) => s + h.amount, 0) / preCollapseBaselineMs) * 10_000;
  const preCollapseHealingPer10s =
    (input.healingEvents.filter((h) => h.timestamp >= preCollapseWindowStart && h.timestamp < clusterStart).reduce((s, h) => s + h.amount, 0) / preCollapseSpanMs) * 10_000;
  const preCollapseHealingRatio = avgHealingBeforePreCheck > 0 ? preCollapseHealingPer10s / avgHealingBeforePreCheck : null;

  const friendlyIds = new Set(fight.friendlyPlayers);
  const priorFriendlyDamageForPreCheck = input.damageDoneEvents.filter(
    (e) => typeof e.sourceID === 'number' && friendlyIds.has(e.sourceID) && typeof e.timestamp === 'number' && e.timestamp < preCollapseWindowStart,
  );
  const avgDamageBeforePreCheck = (priorFriendlyDamageForPreCheck.reduce((s, e) => s + (e.amount ?? 0), 0) / preCollapseBaselineMs) * 10_000;
  const preCollapseDamagePer10s =
    (input.damageDoneEvents
      .filter((e) => typeof e.sourceID === 'number' && friendlyIds.has(e.sourceID) && typeof e.timestamp === 'number' && e.timestamp >= preCollapseWindowStart && e.timestamp < clusterStart)
      .reduce((s, e) => s + (e.amount ?? 0), 0) /
      preCollapseSpanMs) *
    10_000;
  const preCollapseDamageRatio = avgDamageBeforePreCheck > 0 ? preCollapseDamagePer10s / avgDamageBeforePreCheck : null;

  const alreadyCollapsedBeforeCluster =
    (preCollapseHealingRatio != null && preCollapseHealingRatio <= WIPE_CALL_COLLAPSE_RATIO_THRESHOLD) ||
    (preCollapseDamageRatio != null && preCollapseDamageRatio <= WIPE_CALL_COLLAPSE_RATIO_THRESHOLD);

  // Las primeras muertes suelen ser la causa real — salvo que el desplome
  // ya viniera de antes (ver arriba). El límite explícito permite
  // conservar toda mecánica anterior y excluir solo el pile-on. En una
  // muerte masiva durante los primeros 10s no hay fase previa evaluable:
  // se considera reset/wipe call desde el inicio.
  const triggerDeathCount =
    earlyMassDeath || alreadyCollapsedBeforeCluster ? 0 : Math.min(WIPE_CALL_TRIGGER_DEATHS, Math.max(1, Math.floor(bestCluster.length * 0.2)));
  const pileOnDeaths = bestCluster.slice(triggerDeathCount);
  const wipeCallStartTimestamp = earlyMassDeath ? fight.startTime : pileOnDeaths[0].timestamp;

  // Señal 2/3: sanación y daño de la RAID (no de un jugador) en la
  // actividad DESPUÉS de las muertes desencadenantes, comparada con la
  // media anterior. Medir antes del primer muerto evaluaba la ejecución
  // previa al fallo, no el momento en que la raid dio el pull por perdido.
  const fightSoFarMs = Math.max(1, wipeCallStartTimestamp - fight.startTime);
  const postWindowEnd = Math.min(fight.endTime, wipeCallStartTimestamp + 10_000);
  const postWindowMs = Math.max(1000, postWindowEnd - wipeCallStartTimestamp);
  const priorHealing = input.healingEvents.filter((h) => h.timestamp < wipeCallStartTimestamp);
  const postTriggerHealing = input.healingEvents.filter((h) => h.timestamp >= wipeCallStartTimestamp && h.timestamp <= postWindowEnd).reduce((s, h) => s + h.amount, 0);
  const avgHealingPer10s = (priorHealing.reduce((s, h) => s + h.amount, 0) / fightSoFarMs) * 10_000;
  const projectedHealingPer10s = (postTriggerHealing / postWindowMs) * 10_000;
  const healingCollapseRatio = avgHealingPer10s > 0 ? Math.min(1, projectedHealingPer10s / avgHealingPer10s) : null;

  const priorFriendlyDamage = input.damageDoneEvents.filter((e) => typeof e.sourceID === 'number' && friendlyIds.has(e.sourceID) && typeof e.timestamp === 'number' && e.timestamp < wipeCallStartTimestamp);
  const totalPriorDamage = priorFriendlyDamage.reduce((s, e) => s + (e.amount ?? 0), 0);
  const avgDamagePer10s = (totalPriorDamage / fightSoFarMs) * 10_000;
  const postTriggerDamage = input.damageDoneEvents
    .filter((e) => typeof e.sourceID === 'number' && friendlyIds.has(e.sourceID) && typeof e.timestamp === 'number' && e.timestamp >= wipeCallStartTimestamp && e.timestamp <= postWindowEnd)
    .reduce((s, e) => s + (e.amount ?? 0), 0);
  const projectedDamagePer10s = (postTriggerDamage / postWindowMs) * 10_000;
  const damageCollapseRatio = avgDamagePer10s > 0 ? Math.min(1, projectedDamagePer10s / avgDamagePer10s) : null;

  // Señal 4: perfil de daño de cada muerte del cluster. 'burst' (un golpe
  // dominante) apoya mecánica real; 'sustained'/'unknown' (nada nuevo la
  // mató, se fue apagando) apoya wipe call.
  const nonBurstCount = bestCluster.filter((d) => damageProfileOf(d.actorId, d.timestamp) !== 'burst').length;
  const sustainedDeathFraction = nonBurstCount / bestCluster.length;

  // Contraseñal fuerte: casi todos mueren a la misma habilidad y de burst.
  // Es una mecánica letal de raid, aunque el pull termine justo después y
  // la actividad caiga a cero por haberse muerto todos.
  const abilityCounts = new Map<number, number>();
  for (const abilityId of knownAbilities) abilityCounts.set(abilityId, (abilityCounts.get(abilityId) ?? 0) + 1);
  const dominantAbilityFraction = Math.max(0, ...abilityCounts.values()) / bestCluster.length;
  if (!earlyMassDeath && dominantAbilityFraction >= 0.7 && sustainedDeathFraction <= 0.4) return null;

  const evidenceCount = [
    abilityDiversity >= 0.2 || unknownDeathFraction >= 0.3,
    healingCollapseRatio != null && healingCollapseRatio <= WIPE_CALL_COLLAPSE_RATIO_THRESHOLD,
    damageCollapseRatio != null && damageCollapseRatio <= WIPE_CALL_COLLAPSE_RATIO_THRESHOLD,
    sustainedDeathFraction >= 0.5,
  ].filter(Boolean).length;
  if (!earlyMassDeath && evidenceCount < 2) return null;

  const healingSignal = healingCollapseRatio != null ? 1 - healingCollapseRatio : 0.5; // sin dato = neutral, no penaliza ni favorece
  const damageSignal = damageCollapseRatio != null ? 1 - damageCollapseRatio : 0.5;
  const calculatedConfidence = Math.round(
    (simultaneityFraction * 0.2 + abilityDiversity * 0.2 + unknownDeathFraction * 0.1 + healingSignal * 0.2 + damageSignal * 0.1 + sustainedDeathFraction * 0.1 + (1 - nearEndMs / WIPE_CALL_NEAR_END_MS) * 0.1) * 100,
  );
  const confidence = earlyMassDeath ? Math.max(85, calculatedConfidence) : calculatedConfidence;

  return {
    // La cadena corta sirve para DETECTAR el call; una vez fijado el
    // límite, cualquier muerte posterior pertenece al cierre del try. Así
    // un rezagado que cae varios segundos después no reaparece como fallo
    // mecánico, mientras todo lo anterior al límite sigue evaluándose.
    clusterActorIds: new Set(deaths.filter((d) => d.timestamp >= wipeCallStartTimestamp).map((d) => d.actorId)),
    confidence,
    signals: {
      simultaneityFraction: Math.round(simultaneityFraction * 100) / 100,
      abilityDiversity: Math.round(abilityDiversity * 100) / 100,
      nearEndMs,
      healingCollapseRatio: healingCollapseRatio != null ? Math.round(healingCollapseRatio * 100) / 100 : null,
      damageCollapseRatio: damageCollapseRatio != null ? Math.round(damageCollapseRatio * 100) / 100 : null,
      sustainedDeathFraction: Math.round(sustainedDeathFraction * 100) / 100,
      unknownDeathFraction: Math.round(unknownDeathFraction * 100) / 100,
      // §"los primeros 2-3-4 que mueren no suelen ser parte de ese wipe
      // call" (feedback real): cuántas de las bestCluster.length muertes
      // del cluster se dejaron FUERA de la exclusión por ser las primeras
      // (probable causa, no consecuencia) — visible en "ver evidencia" del
      // banner para que quede claro que no TODO el cluster se excluyó.
      triggerDeathsKept: triggerDeathCount,
      // true = la sanación o el daño de la raid YA estaban desplomados
      // antes de la primera muerte de la cadena, así que triggerDeathsKept
      // se forzó a 0 — visible en el banner para explicar por qué no hay
      // muertes "protegidas" en este caso.
      alreadyCollapsedBeforeCluster,
      wipeCallStartMs: Math.max(0, wipeCallStartTimestamp - fight.startTime),
      earlyMassDeath,
    },
  };
}
