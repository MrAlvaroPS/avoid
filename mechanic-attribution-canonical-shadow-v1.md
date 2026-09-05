# Mechanic Attribution Canonical Shadow v1

## Estado

Shadow no punitivo. No alimenta infografía, `nightScore`, Fiabilidad ni `player_execution_events`.

Depende de Attribution Safety v1 (`fix/mechanic-attribution-safety-v1`, PR #17). Safety v1 sigue siendo la fuente visible/punitiva durante este rollout.

## Objetivo

Construir una cadena auditable por occurrence que pueda responder, sin inventar autoría:

1. qué occurrence real ocurrió;
2. qué `category` y `responsibility` tenía;
3. qué policy/version la interpreta;
4. hasta qué nivel podemos atribuir ownership hoy;
5. qué evidencia falta cuando no podemos hacerlo.

El shadow no intenta aumentar el número de fallos. La invariant principal de v1 es:

> `new_accusation_players = []` siempre.

Está protegida tanto en el evaluator como mediante `CHECK (cardinality(new_accusation_players) = 0)` en base de datos.

## Pipeline

```text
applicable_pull_mechanic_events
        ↓
PullEvaluationContext
        ↓
active ability alias → mechanic_key
        ↓
boss_mechanic_policy + policy_version
        ↓
mechanic-occurrence-resolver@2.0.0
        ↓
mechanic_occurrence_evaluations
        ↓
mechanic-attribution-shadow@1.0.0
        ↓
mechanic_attribution_shadow_evaluations
        ↓
mechanic_attribution_shadow_report_v1
```

## Occurrences v2

`mechanic-occurrence-resolver@1.0.0` era un placeholder: una fila `not_evaluable` por policy y pull, sin occurrence real.

`mechanic-occurrence-resolver@2.0.0` crea una occurrence por evento real aplicable:

- usa `trigger_time_ms` como resolución;
- respeta el cutoff canónico de `pull_evaluation_context`;
- conserva `source_event_id`, `ability_id`, category, responsibility, hit names/details y comparación WCL en evidence;
- indexa de forma determinista cada `mechanic_key` dentro del pull;
- `clean → success`, `partial_fail → partial_fail`, `fail → fail`;
- no inventa `target_actor_ids`;
- si no existe identidad o policy, el evento se reporta como unmapped/missing-policy y no se convierte en otra mecánica.

Los aliases legacy/fallback activos se aceptan únicamente como transporte determinista `boss+difficulty+ability_id → mechanic_key`. Su provenance sigue almacenada en evidence y no constituye prueba de culpa. La confidence semántica procede de la policy y el occurrence event-backed nunca supera `inferred`.

## Estados de attribution

### `verified`

Existe actor defendible con la evidencia disponible y ese actor ya era como máximo candidato de Safety v1. Shadow v1 no puede añadir nuevos nombres.

Actualmente sólo se permite de forma genérica para `avoidable-ground` personal con receptor observado, o para una asignación explícita ya materializada que no expanda Safety v1.

### `role_only`

La mecánica pertenece a Tank/Heal/DPS, pero no hay evidencia del actor concreto.

Nunca se expande el roster del rol a `primary_owner`.

### `raid_only`

La resolución es colectiva. No hay actor individual.

### `unresolved`

Sabemos que hubo un fallo, pero no existe evidencia suficiente para defender ownership individual.

Es un resultado válido, no un error.

Incluye expresamente:

- spread sin carrier/collision ownership;
- soak sin expected-vs-actual participants;
- personal-target sin evidencia de la respuesta requerida;
- assignment no materializada;
- semantic contradiction entre event responsibility y policy;
- policy no confiable;
- familia personal todavía no soportada.

### `not_applicable`

No existe fallo atribuible en esta occurrence o la policy declara `penalty_scope=none`.

## Role responsibility != actor ownership

`responsibility=tank` no significa que ambos tanks sean responsables.

La capa genérica de ownership ya no convierte `tank_role`, `healer_role`, `dps_role` o `raid` en `primaryOwners` del roster. Sólo targets/assignments explícitos pueden producir owner identity en esta fase.

## Producción auditada en read-only

Report de referencia: `7GbANtw1J2pjZzH9`.

- 13 pulls completos, válidos y con `pull_evaluation_context` evaluable;
- 2992 mechanic events aplicables;
- 678 failed/partial-fail events;
- 109 failed events tienen mapping actual hacia alias+policy;
- 569 siguen sin mapping canónico suficiente y permanecerán fuera de attribution canónico;
- los aliases activos actuales son mappings legacy/fallback exactos de ability id; se conservan como identity transport, no como semantic proof.

La lectura previa al rollout muestra que incluso dentro de los eventos mapeados abundan `raid_only`, `role_only`, `penalty_scope=none` y casos sin actor observado. Por diseño, el primer shadow puede producir muy pocos o incluso cero actores `verified`; esto es preferible a fabricar precisión.

## Gates v1

Antes de cualquier promoción visible:

- `new_accusation_count = 0`;
- ningún role/raid event puede generar un player owner por membership;
- spread/soak no pueden verificarse genéricamente;
- personal-target no puede verificarse sólo por ser target;
- identity/policy incompatibles fallan cerrado;
- versions quedan persistidas;
- mismo input produce misma occurrence identity/order;
- UI/scoring no consume las tablas shadow.

## Validación de implementación

Gate ejecutado durante desarrollo:

- tests focalizados de Safety + shadow + occurrence resolver + ownership;
- `verify:causal-schema`;
- `verify:causal-runtime` con Deno sobre las Edge Functions causales;
- Angular production build.

El workflow temporal usado para ejecutar el gate fue eliminado de la rama después de pasar.

## Próximas familias, no incluidas en v1

La promoción de ownership se hará por familias, no con una heurística global:

1. interrupts/stops con actor/asignación explícita;
2. dispels explícitos;
3. personal-target con required-response evidence;
4. tank swaps/stacks/aggro/frontal ownership;
5. soak expected participants vs actual participants;
6. spread carrier/collision/position ownership.

Cada familia deberá demostrar actor correcto en shadow antes de poder alimentar `Tus fallos` o scoring.
