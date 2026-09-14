import {
  EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
} from './effective-defensives.ts';

export {
  mergeObservedCastEvidenceV6,
  defensiveSemanticClosureViolationsV6,
  defensiveScoreabilityViolationsV6,
  observedSelfCastAcquisitionViolationsV6,
  type ObservedCastEvidenceV6,
  type DefensiveSemanticClosureViolation,
  type DefensiveScoreabilityViolation,
} from './defensive-evidence-v6.ts';

/**
 * v10 (2026-09-10, §pressure-detection-recalibration — hallazgo empírico
 * real: detectDamageWindows() usaba un factor de 2.5x la mediana propia,
 * validado en su día solo contra un perfil de tank. Con daño de raid casi
 * continuo en este contenido, dejaba ~50% de los pulls de DPS/healer en 0
 * "oportunidades" evaluables — un jugador podía lanzar su defensivo 30 veces
 * en una noche y el sistema solo detectaba 10 episodios en total. Contrastado
 * con canonical_defensive_pressure_diagnostics contra 2 noches reales (34
 * pulls, 753 filas jugador×pull, 4 roles): a 1.7 la brecha tank/resto
 * desaparece sin introducir ruido — el tank resulta ser el rol con MENOS
 * varianza, no el que necesitaba el margen extra. DEFAULT_FACTOR baja de 2.5
 * a 1.7 en damage-pressure-windows.ts. Esto SÍ cambia qué picos de daño se
 * detectan como episodio (más episodios evaluables por jugador×pull,
 * especialmente en roles no-tank), a diferencia de v9 (que solo tocaba cómo
 * se reconstruye la disponibilidad causal de un episodio ya detectado).
 * resolver de timing no cambia.
 *
 * §rogue-defensive-semantics-12-1 (2026-09-14): el algoritmo puro del
 * resolver semántico tampoco cambia, pero SÍ cambia el contrato semántico
 * canónico que consume v10: Evasion baseline y Crimson Vial pasan a
 * credit_only; Elusiveness/Bait and Switch promocionan Evasion a normal
 * cuando aportan mitigación directa. Versionamos este cambio de DATOS como
 * 1.8.0 en el contrato canónico para impedir que una generación 1.7.0
 * reutilice snapshots calculados con la clasificación anterior.
 */
export const EFFECTIVE_DEFENSIVE_RESOLVER_VERSION_V10 = EFFECTIVE_DEFENSIVE_RESOLVER_VERSION;
export const EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION_V10 = 'effective-defensive-semantics@1.8.0';
export const DEFENSIVE_EPISODE_EVALUATOR_VERSION_V10 = 'episode-evaluator@10';