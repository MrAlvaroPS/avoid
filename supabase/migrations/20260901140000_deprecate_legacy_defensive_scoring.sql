-- Gestión defensiva v2 · Bloque L · frontera de deprecación legacy.
-- No se eliminan columnas durante el rollout: siguen siendo necesarias para
-- registros sin backfill y para comparar v1/v2. Esta migración documenta en el
-- propio contrato SQL que ya no son fuentes autorizadas de scoring v2.

comment on view player_pull_reliability_inputs_legacy_v1 is
  'Compatibilidad temporal v1. No añadir consumidores nuevos; retirar después de backfill completo, calibración y activación estable de defensiveReliabilityV2.';
comment on column player_pull_reliability_inputs.defensive_window_coverable_count is
  'DEPRECATED para scoring: sensor v1 conservado solo para fallback/shadow de pulls sin evaluación v2 fiable.';
comment on column player_pull_reliability_inputs.used_defensive_when_died is
  'DEPRECATED para scoring v2: evidencia legacy conservada para fallback/shadow y UI histórica.';
comment on column player_pull_reliability_inputs.used_defensive_in_pull is
  'DEPRECATED para scoring v2: booleano legacy; usar defensive_management_score_v2 cuando la fila sea fiable.';
comment on column player_pull_reliability_inputs.defensive_use_opportunity is
  'DEPRECATED para scoring v2: oportunidad legacy; usar eventos semánticos de player_pull_defensive_evaluations.';
comment on column player_pull_records.defensive_pressure_windows is
  'DEPRECATED como autoridad: contrato v1 de compatibilidad. Nuevos cálculos se proyectan desde defensive_pressure_windows_v2; coverable no puntúa.';
comment on column player_pull_records.defensive_pressure_windows_v2 is
  'Sensor v2 resuelto por build/talentos/cargas. availableOpportunity es diagnóstico; solo player_pull_defensive_evaluations decide y puntúa.';
comment on column player_pull_records.death_defensive_options_v2 is
  'Estado defensivo autoritativo por resolver/state engine v2; death_cause.defensiveOptions es solo proyección legacy.';
