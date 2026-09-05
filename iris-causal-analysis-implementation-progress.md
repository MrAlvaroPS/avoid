# IRIS — causalidad, responsabilidad y dosier verificable

Este archivo es el registro acumulativo de la migración descrita en
`IRIS_Especificacion_Tecnico_Funcional_Causalidad_Responsabilidad_Dosier_v1.0`.
Se actualiza al comenzar y cerrar cada bloque. Una casilla completada significa
que el contrato, la implementación y dos comprobaciones independientes han sido
revisados; no significa únicamente que exista código.

## Baseline y reglas de trabajo

- Inicio: 2026-09-01.
- Rama real al iniciar: `feature/mechanics`.
- Commit real al iniciar: `4aad209930a72c5150e57e2b10456a51999e2cbd`.
- La especificación adjunta fue auditada sobre
  `fix/defensive-catalog-discovery-v5` en el commit `53a1003`; por tanto, cada
  bloque se contrasta con el código real antes de aplicar sus propuestas.
- Estrategia: schema y contratos aditivos, versionados y reversibles; legacy se
  conserva como fallback atómico durante el rollout.
- `uncertain` puede mostrarse, pero nunca producir penalización.
- Boss + dificultad forman parte del scope de policy, aliases y estadísticas.
- WCL aporta hechos; policy aporta semántica; occurrences resuelven causalidad;
  el ledger será la única fuente consumidora de decisiones por jugador.
- El bloque A no cambia scoring ni UI visible. Sus feature flags nacen apagados.
- Cada bloque se comprueba dos veces: una ronda focalizada sobre sus contratos y
  una ronda de integración/build, además de revisión manual de invariantes.
- Los cambios ajenos ya presentes se preservan. Al iniciar solo se observó
  `.claude/` sin seguimiento, fuera del alcance.

## Estado global

| Bloque | Entrega | Estado | Gate principal |
| --- | --- | --- | --- |
| A | Contracts y schema | M20 desplegada | M11-M20 y M11b aplicadas; la publicación causal transaccional por lote está endurecida, autotestada y el dry-run remoto queda sin pendientes. |
| B | `PullEvaluationContext` | Implementado · editor UI y override | Componente editor Angular standalone, tests, validación e integración completadas. |
| C | Identidad y `MechanicPolicy` | Policies v2 desplegada | 674 policies/aliases base creados. Policies v2 procesa las dificultades completas, avisa y omite temporalmente las incompletas, y publica internamente por dificultad en lotes de 20. |
| D | Occurrences y responsabilidad | Implementado · 2 Edge Functions + lógica core | evaluate-mechanic-occurrences, compute-responsibility-edges, ownership resolver, edge builder. |
| E | Ledger y consumers shadow | En curso · dominios evaluables cubiertos | Ledger para mecánica, defensivos, consumibles, muerte, preparación, interrupt, external y dispel; `utility` queda fuera hasta tener policy causal. Falta E2E con datos remotos. |
| F | Defensa y consumibles causales | En curso · consumibles reactivos | Los usos reactivos de piedra/poción se registran aunque el jugador sobreviva; falta policy defensiva causal. |
| G | UI de officers y Preparación | En curso · contexto y policies integrados | Officers editan contexto/policies/aliases desde Mecánicas; el dosier adopta preparación v3 solo con flag y evidencia completa. |
| H | Dosier e infografía v3 | En curso · provenance de preparación | El dosier muestra la preparación inicial con fuente/versiones v3 solo detrás de flag; falta backfill y E2E. |
| I | Fiabilidad v3 | En curso · calibración shadow | Compara ledger/legacy por jugador sin alterar el score; faltan E2E y criterios de activación. |
| J | Consolidación | Bloqueado | Solo tras estabilidad y aceptación E2E; no borra evidencia. |

## Runbook para terminar la migración

Este es el orden operativo obligatorio. No se activa una flag porque el código
compile: cada paso debe dejar evidencia de su criterio de salida. Ante un fallo,
se mantienen las flags apagadas y se reanuda desde el mismo paso; no se borra
legacy ni se rehacen migraciones ya aplicadas.

### Uso exacto de Ajustes → Mecánicas

La pantalla presenta ahora un único flujo de cinco pasos. Para rellenar un boss
de forma fiable:

1. Seleccionar boss y dificultad. La tabla siempre muestra una dificultad;
  Normal, Heroic y Mythic se sincronizan juntas en el paso siguiente.
2. Pulsar **Sincronizar 3 dificultades** y esperar a que termine las tres
  llamadas. Es la opción fiable: usa Journal, DB2 y la muestra profunda de
  WCL. **Sync rápido** queda dentro de Opciones y solo debe usarse para probar
  conectividad o refrescar con menos evidencia.
3. Revisar el estado del paso 1. Debe mostrar fecha, `profunda`, filas y número
  de referencias. Si dice `Sync parcial`, repetir más tarde la dificultad cuyo
  Wago/DB2 o WCL falló; no asumir que cero referencias significa cero
  mecánicas.
4. Pulsar **Clasificar mecánicas con IA**, copiar el prompt de catálogo v8,
  ejecutarlo en una IA con acceso web, pegar el JSON y aplicar. Este worker
  solo actualiza categoría, responsable, evitable, resolución y evidencia del
  catálogo; no recorre pulls históricos ni publica policies.
5. El paso 3 debe decir **Identidades listas**. Solo aparece **Crear las que
  faltan** cuando hay candidatas sin identity/policy; no debe pulsarse de nuevo
  si ya marca `N/N enlazadas`.
6. En **Generar semántica causal**, copiar un único prompt de policies v1.
  Incluye todas las dificultades y todas las mecánicas disponibles del boss,
  igual que la acción principal de clasificación. Al pegar el único JSON, el
  frontend lo agrupa por dificultad y lo publica secuencialmente en lotes de
  hasta 20. Policy, snapshot y auditoría se confirman por lote transaccional.
7. El paso 5 es **Revisar excepciones causales**: solo requiere atención para
  policies legacy base, respuestas `uncertain` o filas que el prompt no pudo
  validar. Las policies `inferred` ya quedan completas y editables; no hay que
  rellenarlas una por una.

Hay dos capas y dos prompts distintos, ambos globales para el boss: la tabla
principal se rellena con sincronización + catálogo v8; policies v1 rellena la
semántica causal de todas las dificultades. Solo la persistencia se fragmenta
internamente. La automatización aplica
guards de confianza: `low → uncertain` sin crédito ni penalización;
`medium → inferred` sin penalización; `high → inferred` y puede conservar el
scope propuesto tras contrastar resolución y fuentes. El officer edita errores
o excepciones, no completa todo el catálogo a mano.

M17 empezó a registrar el estado real de `sync-boss-mechanics` el 2026-09-02.
Las sincronizaciones anteriores no dejaron ese registro, por lo que tras el
despliegue hay que ejecutar **Sincronizar 3 dificultades** una vez más. Después
la fecha queda persistida por boss+dificultad junto con modo, filas,
referencias y errores parciales.

### 0. Congelar baseline y confirmar rollout apagado — completado

1. Guardar rama/commit y exportar una muestra de los conteos legacy que luego se
  compararán con v3.
2. Ejecutar `npm run verify:causal-schema`.
3. Éxito esperado: 11 migraciones reconocidas, 27 reason codes y 6 flags OFF.

Fallos y recuperación:

- Si una flag aparece ON, restaurarla en `src/environments/environment.ts` y
  eliminar el override local `avoid:combat-evaluation-feature-flags:v1` antes
  de medir producción.
- Si divergen reason codes, no desplegar: sincronizar contrato TypeScript y
  checks SQL antes de continuar.

### 1. Schema y funciones remotas — backend desplegado

1. Ejecutar `npx supabase db push --linked --dry-run --skip-vault`.
2. Ejecutar `npm run verify:causal-runtime`.
3. M19/M20 aplicadas y `classify-mechanics`/`classify-mechanic-policies`
  desplegadas. Queda recargar/desplegar el frontend que presenta el flujo 1-5.
4. En Supabase, confirmar que las 14 funciones causales están `ACTIVE` y que
  M11-M20/M11b constan en `supabase_migrations.schema_migrations`.
5. En SQL Editor, comprobar que existen y son consultables como officer:

```sql
select count(*) from pull_evaluation_context;
select count(*) from boss_mechanic_policy;
select count(*) from mechanic_occurrence_evaluations;
select count(*) from mechanic_responsibility_edges;
select count(*) from player_execution_events;
```

Criterio de salida: dry-run sin pendientes, 14 checks Deno correctos y ninguna
relación ausente. Los conteos pueden ser cero antes de los backfills; un error
de relación/RLS no puede aceptarse como cero.

Fallos y recuperación:

- `relation does not exist`/`PGRST205`: aplicar migraciones al proyecto
  enlazado correcto y recargar el schema cache de PostgREST.
- `permission denied` o lectura vacía inesperada: confirmar sesión officer y
  `is_officer()`; las escrituras deben seguir pasando por Edge Function con
  `service_role`, nunca abrir RLS globalmente.
- `TS2307`/imports Deno: ejecutar mediante `npx deno check`; conservar
  extensiones `.ts` en runtime Deno.

### 2. Catálogo, identidad y cobertura de policies — seed completado

1. Sincronizar cada boss; la acción principal recorre Normal, Heroic y Mythic
  una a una y registra el resultado de cada dificultad en
  `boss_mechanic_catalog_sync_state`.
2. Ejecutar una vez `Generar policies base desde catálogo`. Ya se ejecutó en el
  remoto actual: 674 policies y 674 aliases.
3. Para cada boss+dificultad, leer la nueva cabecera de Mecánicas:
  `N/M con policy`, base/revisada/verificada/incierta/sin policy, última sync
  de catálogo y última actualización de policy.
4. Contrastar en SQL los totales que muestra la UI:

```sql
select boss_id, difficulty, confidence, count(*)
from boss_mechanic_policy
group by boss_id, difficulty, confidence
order by boss_id, difficulty, confidence;

select boss_id, difficulty, count(*) filter (where mechanic_key is null) as sin_identidad
from boss_mechanics_candidates
group by boss_id, difficulty
order by boss_id, difficulty;
```

Criterio de salida: cada candidata aplicable tiene una `mechanic_key`, una
policy vigente y al menos un alias activo; la cabecera no reporta ausencias no
explicadas. `v1 · fallback` con campos `none` significa **seed presente pero
semántica no revisada**, no pérdida de datos.

Fallos y recuperación:

- `0/M con policy` con candidates visibles: comprobar scope exacto
  boss+dificultad y que la UI usa `candidate.mechanic_key`; solo las filas
  legacy sin key usan `ability:<id>` como fallback.
- Botón con éxito pero sin cambios: el backfill es idempotente. Revisar los
  conteos persistidos, no `policiesCreated`, que será cero en repeticiones.
- Policies fuera del catálogo visible: revisar aliases duplicados, cambio de
  aplicabilidad por dificultad o una key canónica sustituida; no borrarlas
  hasta reconciliar historial y referencias.
- Error `[object Object]`: indica una versión backend antigua; redesplegar
  `backfill-mechanic-candidates-to-policy`, que ya normaliza errores PostgREST.

### 3. Generar semántica causal y revisar excepciones — workers separados

1. Generar y aplicar primero el prompt de catálogo v8. No contiene
  `causalPolicy` y su submit solo parchea `boss_mechanics_candidates`.
2. Tras crear identities/policies base, generar un único prompt policies v1
  para todas las dificultades y mecánicas del boss. Pegar una única respuesta;
  el cliente la divide por `difficulty` y después en bloques máximos de 20.
3. El submit deriva `responsibility_mode`, usa la resolución contrastada como
  `required_response` e invoca `publish_mechanic_policy_batch`: incrementa
  `policy_version` y crea policy, snapshot y auditoría atómicamente.
4. Revisar solo `base`, `uncertain`, policies omitidas y resultados que el RL
  detecte como erróneos. Promover a `verified` únicamente tras contraste
  humano; el resto puede permanecer `inferred`.
5. Verificar que el resumen conjunto dice `N/N`, que las policies generadas
  coinciden con el número esperado y que los avisos de campos omitidos son
  cero.

Criterio de salida: cero policies `fallback` salvo excepciones identificadas;
toda penalización requiere policy `verified|inferred`, respuesta concreta,
responsable trazable y fuentes. `uncertain` nunca puntúa.

Fallos y recuperación:

- HTTP 400 por enum: no forzar casts; corregir el valor según el contrato M12.
- Respuesta del antiguo prompt v7: no pegarla en ninguno de los dos endpoints.
  Regenerar catálogo v8 y después el prompt global policies v1; los contratos
  tienen responsabilidades distintas a propósito.
- `reason es obligatorio`: añadir el motivo de revisión, no relajar auditoría.
- Versión publicada sin snapshot/audit: detener rollout y reparar la
  transacción/trigger M16 antes de otra edición.
- Datos dudosos: marcar `uncertain`, dejar penalización en `none` y registrar la
  evidencia que falta. La incertidumbre nunca se resuelve inventando defaults.

### 4. Contexto evaluable de pulls — implementación lista, E2E pendiente

1. Elegir pulls completos, wipe, kill, ninja y corte anticipado.
2. Revisar/editar intervalo, wipe call y ninja desde Live Pull como officer.
3. Confirmar fila vigente, auditoría y proyección legacy en la misma operación.
4. Reprocesar el pull y verificar que ningún evento fuera del intervalo entra
  en occurrences o ledger.

Criterio de salida: todos los pulls del corpus tienen contexto coherente; los
ninja/no evaluables no generan penalizaciones y los overrides son reversibles.

Fallos habituales: bounds inválidos se corrigen contra duración real; contexto
ausente exige reanálisis del report; discrepancia con legacy exige revisar la
RPC atómica antes de materializar datos derivados.

### 5. Occurrences y responsabilidad — E2E pendiente

1. Ejecutar `evaluate-mechanic-occurrences` y después
  `compute-responsibility-edges` sobre el corpus.
2. Contrastar manualmente varias mecánicas target, tank, raid, soak, interrupt
  y con víctimas colaterales.
3. Repetir ambas funciones y confirmar idempotencia: no aumentan duplicados.

Criterio de salida: índices de occurrence positivos y estables, resolver/policy
version persistidos, razón canónica en cada edge y ninguna víctima colateral
marcada como autora primaria.

Fallos habituales: duplicados indican tuple `onConflict` incompleta; outcomes
vacíos suelen indicar identity/alias sin resolver; `actor_id` nulo es correcto
para nombres de roster, pero no debe impedir conservar `player_name`.

### 6. Defensivos, consumibles y ledger — E2E/backfill pendiente

1. Procesar defensivos y consumibles del mismo corpus.
2. Encolar `full_execution_backfill` o `pull_context` y dejar que
  `process-combat-evaluation-queue` encadene occurrences, edges y
  materializadores.
3. Comprobar jobs `done`, sin leases caducados, y repetir para verificar
  idempotencia.
4. Consultar las views v3 por pull/noche/jugador y comprobar
  `versions_homogeneous`.

Criterio de salida: ledger completo para mechanic/defensive/consumable/death/
preparation/interrupt/external/dispel, deduplication keys estables y cero mezcla
de versiones aceptada por consumers.

Fallos habituales: jobs atascados requieren liberar/reintentar lease, no
insertar eventos a mano; ausencia de dispels exige reanalizar con M15 activo;
fallos defensivos sin policy deben degradar a no evaluable, nunca a culpable.

### 7. Comparación shadow y aceptación — pendiente

1. Mantener todas las flags productivas OFF y ejecutar ledger v3 en paralelo.
2. Comparar legacy/v3 por pull y jugador: totales por dominio,
  `primaryPenaltyCount`, preparación y ofensas mecánicas.
3. Clasificar cada divergencia como corrección causal esperada, falta de policy,
  identity gap, contexto incorrecto o bug del materializador.
4. Definir y registrar umbrales de aceptación antes de cambiar scoring.

Criterio de salida mínimo: corpus representativo sin mezcla de versiones, cero
penalizaciones fallback/uncertain, cero víctimas colaterales culpadas y todas
las divergencias relevantes explicadas o corregidas.

### 8. Activación gradual y rollback — pendiente

Activar primero en override local/officer y después por flag de entorno, en
este orden: contexto, policies, responsabilidad, consumibles, dosier y por
último fiabilidad/scoring. Tras cada flag repetir smoke del paso afectado y
observar al menos una noche completa antes de la siguiente.

Rollback: apagar la última flag. No borrar policies, snapshots, occurrences ni
ledger; son evidencia auditable y el legacy continúa disponible. Si una flag
cambia scoring de forma inesperada, volver a OFF, conservar el corpus y abrir
la divergencia en el bloque correspondiente.

### 9. Consolidación — bloqueada

Solo cuando los pasos 1-8 estén aceptados se puede retirar código legacy. Antes
de cada retirada hay que demostrar ausencia de lecturas/escrituras activas,
tener backup y migración reversible, y repetir build, suite, runtime, smoke SQL
y una noche shadow final. Las tablas de auditoría y snapshots no se eliminan.

## Incidencias paralelas solicitadas

### Generar borrador global

- [x] Reproducir/localizar la causa del `non-2xx` de
      `generate-defensive-plan`.
- [x] Corregir el contrato o la implementación sin ocultar el error backend.
- [x] Comprobación focalizada del solver/contrato de error.
- [x] Comprobación de integración estática desde Preparación y build de
      producción.
- [x] Desplegar `generate-defensive-plan` y repetir el clic real con sesión de
      officer. No se ha hecho ningún despliegue remoto en este bloque.

Diagnóstico cerrado: la respuesta real aportada desde DevTools fue
`WORKER_RESOURCE_LIMIT` (HTTP 546). El DFS del solver admitía 50.000 nodos por
defecto y además clonaba `Map`/arrays en cada rama; con roster × defensivos ×
occurrences construía un espacio combinatorio incompatible con el presupuesto
CPU del worker. `defensive-plan-solver@2.1.0` ahora:

- limita cualquier valor del cliente a un máximo de 5.000 nodos;
- estima el árbol antes de entrar al DFS;
- salta directamente al fallback greedy determinista cuando el árbol bruto ya
  supera el presupuesto, en vez de gastar CPU para acabar en el mismo fallback;
- deja `search_space_exceeds_budget` en diagnósticos;
- tiene una regresión 20 jugadores × 20 occurrences que confirma 0 nodos DFS.

`generate-defensive-plan@2.2.0` añade la etapa concreta al error
(`load_sources`, `resolve_roster`, `solve_plan`, `persist_draft`, etc.). El
cliente ya lee bodies non-2xx aunque el `Response` provenga de otro realm y
muestra también `WORKER_RESOURCE_LIMIT` cuando lo devuelve la infraestructura.

### Categoría y target del catálogo defensivo

- [x] Seguir el dato desde el prompt de `classify-defensives` hasta persistencia.
- [x] Confirmar si la tabla lee la misma fuente y refleja ambos campos.
- [x] Corregir persistencia o presentación y añadir regresión.
- [x] Documentar el ciclo de vida al dejar de ser defensiva: eliminación,
      exclusión o deshabilitado.

Hallazgo: prompt y persistencia sí escribían `category` y `targeting_mode`, y la
tabla sí recarga `cooldown_catalog` antes de mostrar éxito. Había, sin embargo,
dos problemas observables:

1. El submit IA rechazaba `external_defensive + unknown`, aunque la edición
   manual y el schema sí lo aceptaban. Eso descartaba la entrada completa y
   hacía que categoría/target pareciesen no aplicarse. Ahora ambos write paths
   usan el mismo contrato compartido; `unknown` se conserva como incertidumbre
   segura y el solver no lo asigna.
2. El banner solo enseñaba `survivalType`. Ahora devuelve y muestra también
   `category` y `targetingMode`, de modo que se puede comprobar lo aplicado al
   mismo tiempo que la tabla ya refrescada.

Ciclo de vida confirmado: `stillDefensive:false` **no borra ni deshabilita
automáticamente**. Solo crea una sugerencia. Al confirmarla manualmente se
persiste `cooldown_catalog.excluded=true`: la fila se conserva y se ve en
Ajustes para poder restaurarla, pero `listAll()` y el generador filtran
`excluded=false`, por lo que deja de contar y de entrar en planes.

## Bloque A — Contracts y schema

### Alcance exacto

- [x] M11: `pull_evaluation_context`, auditoría y proyección/RPC compatible.
- [x] M12: identidad canónica, aliases y `boss_mechanic_policy` versionada.
- [x] M13: occurrences evaluadas y grafo de responsabilidad.
- [x] M14: `player_execution_events` y views consumidoras v3.
- [x] M19 desplegada: RPC transaccional de publicación causal con límite de 20
      policies de una sola dificultad por lote interno.
- [x] M20 desplegada: conflict target no ambiguo, resolución explícita de
      colisiones PL/pgSQL y autotest transaccional de la RPC real.
- [x] Tipos TypeScript puros y 27 reason codes compartidos para front/back.
- [x] RLS de lectura para officers; escrituras solo mediante backend autorizado.
- [x] Índices y constraints de scope, confianza, eligibility y versionado.
- [x] Flags `combatEvaluationContextV2`, `mechanicPolicyV2`,
      `mechanicResponsibilityV2`, `consumableEvaluatorV2`,
      `playerInfographicV3` y `reliabilityExecutionV3`, todos apagados.
- [x] Ninguna pantalla ni scoring cambia con flags apagados.

### Definition of Done

- [x] La secuencia y los invariantes se validan de forma equivalente mientras
      no está disponible PostgreSQL local: `db push --dry-run` enlazado +
      `npm run verify:causal-schema`.
- [x] Aplicadas y verificadas en Supabase las migraciones causales M11-M18 y
  M11b mediante `db push --linked` seguido de dry-run sin pendientes.
- [x] La reversibilidad está documentada y no exige retirar legacy.
- [x] Índices, FKs, checks, unicidad y RLS revisados contra queries previstas.
- [x] Frontend y módulos compartidos puros compilan con los contratos nuevos.
- [x] Check Deno integral de `generate-defensive-plan`,
      `classify-defensives` y `save-defensive-edit`.
- [x] Primera comprobación: tests focalizados de contratos/schema.
- [x] Segunda comprobación: suite completa/build y revisión de flags off.

Comprobación equivalente actual (no sustituye el smoke SQL pendiente):

- `supabase db push --linked --skip-vault`: aplicó M11, M12, M13, M14, M11b
  (cola), M15 (dispels) y M16 (snapshots de policy) al proyecto remoto.
- `supabase db push --linked --dry-run --skip-vault`: posterior al deploy,
  confirma `upToDate:true` y ninguna migración pendiente.
- `npm run verify:causal-schema`: 9 migraciones, 27 reason codes idénticos entre
  TypeScript/SQL, 6 flags apagados, timestamps únicos, ausencia de operaciones
  destructivas, RLS officer y guards no punitivos.
- `npm test -- --watch=false`: 36 suites, 224/224 pruebas.
- `npm run build`: correcto; conserva avisos de budgets SCSS/bundle ya
  existentes.
- `npx deno check`: pasan los 12 entrypoints causales comprobados: ingestión,
  contexto, occurrences, responsibility edges, evaluación defensiva, ledger,
  consumibles, cola, policies y aliases.
- `npm run verify:causal-runtime`: ejecuta esos 12 checks Deno de forma
  secuencial y reproducible en Windows y CI.
- Estado posterior a M19: `verify:causal-schema` reconoce 10 migraciones;
  `verify:causal-runtime` comprueba 14 Edge Functions; build correcto y suite
  completa 38 archivos/234 pruebas. M19 está aplicada y el dry-run remoto
  confirma `upToDate:true` sin migraciones pendientes.

### Hallazgos y decisiones

- La especificación trata nombres de migración como orientativos, pero exige el
  orden lógico M11 → M12 → M13 → M14 antes de activar consumidores.
- El schema del bloque A será aditivo. Las columnas legacy de `pulls`,
  `pull_mechanic_events`, `death_cause` y las views actuales no se eliminan.
- La reversión operativa del rollout se hace apagando flags y dejando de usar
  las nuevas tablas. Las migraciones de producción no deben depender de un
  `down` destructivo.
- M11 hace backfill sin reinterpretar las decisiones legacy y proporciona una
  RPC `service_role` que actualiza contexto, audit, proyección legacy y
  `pulls.updated_at` en una sola transacción.
- M12 mantiene la policy actual por `boss+difficulty+mechanic_key` y su historial
  before/after; los consumers guardan `policy_version` para no reinterpretar
  evidencia histórica.
- M13 separa outcome observado de ownership y prohíbe penalizar víctimas
  colaterales o confianza fallback/uncertain.
- M14 hace el ledger idempotente por pull+versión+deduplication key; sus cuatro
  views usan `security_invoker` y publican homogeneidad de versiones.
- Durante la segunda revisión se corrigió un check demasiado restrictivo que
  impedía representar un `not_evaluable` con evidencia verificada. Solo el
  outcome `uncertain` obliga ahora a confidence `uncertain`.
- El despliegue remoto posterior aplicó las siete migraciones en el orden de
  Supabase y publicó las doce Edge Functions causales. Las flags siguen
  apagadas; el siguiente gate es el contraste E2E autenticado, no activación.

## Bloque B — `PullEvaluationContext` editor y override

### Alcance exacto

- [x] Componente editor para override de contexto de evaluación.
- [x] UI para edición de intervalo evaluable (`evaluationStartMs`, `evaluationEndMs`).
- [x] UI para edición de límite de wipe con validación de bounds.
- [x] Reversión de ninja status (confirm/restore).
- [x] Razón de cambio auditable y obligatoria.
- [x] Validación de intervalos contra duración del pull.
- [x] Formato de display en H:MM:SS para legibilidad.
- [x] Extracción type-safe de candidatos desde `evidence`.
- [x] Resumen de cambios para verificación antes de guardar.
- [x] Integración con `PullAnalysisService` para persistencia.
- [x] Tests exhaustivos de comportamiento, validación y edge cases.

### Definition of Done

- [x] Componente Angular standalone compilable y funcional.
- [x] Build de producción sin errores de compilación.
- [x] 11 suites de tests cobriendo lógica y UI.
- [x] Type safety en handlers de eventos (HTMLTextAreaElement, etc.).
- [x] Documentación de issue pre-existente de `tsconfig.spec.json`.
- [x] Componente listo para integración en vistas de live-pull.
- [x] Integración visual en Live Pull para officers con contexto v2 disponible.
- [ ] End-to-end testing con servidor backend real.

### Hallazgos e integración

- El editor implementa override reversible que respeta la auditoría: cada
  cambio requiere razón y se persiste con `changed_by` en el audit log.
- Los métodos helper `formatSeconds()` y `getWipeCallCandidateBoundaryMs()` 
  resuelven limitaciones de typing en plantillas Angular: no se puede hacer
  type casting `as` inline, requiere métodos intermediarios.
- Issue detectado: `tsconfig.spec.json` no puede compilar imports con
  extensión `.ts` desde archivos Deno cuando están en la carpeta `supabase/`.
  Se resolvió localmente con una supresión TypeScript sobre el import Deno que
  exige extensión; no impacta build de producción ni runtime Deno.
- Componente sigue patrón standalone de Angular 17+, sin dependencias de
  módulos legacy.
- Integrado `PullEvaluationContextEditorComponent` en `LivePullComponent`:
  solo aparece si el contexto v2 está activo, existe un contexto evaluable y
  `AuthService` confirma rol de officer. Al guardar, reutiliza la recarga
  completa del pull para no dejar métricas derivadas desactualizadas.
- Corregida la etiqueta de contexto: un ninja confirmado también es no
  evaluable, pero la UI mostraba la razón genérica antes de la específica.
  Ahora prioriza “Ninja confirmado (no evaluable)”.

## Bloque G — UI de officers y preparación

### Avance inicial

- [x] Editor de `PullEvaluationContext` integrado en la vista operativa del
  pull para officers.
- [x] La integración conserva los banners existentes y no aparece con la flag
  de contexto apagada.
- [x] `EdgeFunctionsService` expone `publishMechanicPolicy()` y
  `queryMechanicPolicy()` tipados para la futura superficie officer.
- [x] M16 `boss_mechanic_policy_versions`: snapshots inmutables y recuperables
  de cada versión de policy, con backfill del estado vigente.
- [x] `query-mechanic-policy` consulta snapshots al pedir una versión concreta.
- [x] `publish-mechanic-policy` conserva `before_state` real en su auditoría.
- [x] Policies causales integradas como detalle expandible de cada fila de
  Mecánicas, no como tabla/pestaña independiente, y protegidas por
  `mechanicPolicyV2`.
- [x] Gestión de aliases manuales desde el editor de Policies, con ID positivo
  o nombre normalizado obligatorio, procedencia y confidence visibles.
- [x] Corregida la escritura de aliases: M12 usa índices únicos parciales por
  ability o nombre, no un unique compuesto de cinco columnas.
- [x] Readiness de preparación: el dosier puede usar checks v3 de enchants y
  gemas del primer pull, con fallback atómico al snapshot existente.
- [ ] E2E de readiness v3 con datos materializados en Supabase.

### Hallazgo de versionado

- `boss_mechanic_policy` conserva solo el estado vigente porque su PK no incluye
  `policy_version`; el UPSERT reemplazaba el contenido anterior y la consulta
  de una versión histórica devolvía 404. La nueva tabla de snapshots no altera
  la PK ni FKs existentes: un trigger guarda el snapshot dentro de la misma
  transacción y `query-mechanic-policy` lo recupera al solicitar una versión.
- `verify:causal-schema` valida M11b (cola), M15 (dispels) y M16 (snapshots),
  además de las extensiones causales: 9 migraciones, 27 reason codes y 6
  flags OFF.
- Añadido `PolicyManifestEditorComponent` embebido en Ajustes. Lee las policies
  vigentes del boss+dificultad seleccionados, permite editar su semántica y
  exige motivo antes de publicar una nueva versión auditable. El backfill crea
  una identidad estable `ability:<id>` solo para candidatas legacy sin key.
- Durante la integración, Angular rechazó `String()` en plantilla. Se corrigió
  con `bossIdForPolicy()`, helper tipado del componente propietario.
- Añadida gestión manual de aliases dentro de la policy seleccionada. La UI
  muestra identidad, procedencia, confidence y estado; el alta exige un ID de
  habilidad positivo o un nombre normalizado.
- Corregido `sync-mechanic-aliases`: su UPSERT apuntaba a un conflicto compuesto
  que no existe en M12 y habría fallado en PostgreSQL. Ahora resuelve por
  ability o nombre activo y actualiza/inserta contra los índices parciales.
  `verify:causal-schema` protege esta estrategia.
- Corregida la ubicación de la UI de policies: no es una pantalla paralela;
  aparece dentro del detalle de boss+dificultad de Mecánicas solo cuando
  `mechanicPolicyV2` está activo.
- Corregido el backfill global que devolvía cero policies: filtraba candidates
  por `mechanic_key`, pero el catálogo legacy aún no tenía esas proyecciones
  pobladas. Ahora genera la key estable `ability:<ability_id>` cuando falta,
  la persiste en el candidate y crea policy/alias sin modificar el catálogo
  semántico legacy. El mensaje de resultado se normaliza como texto y no puede
  mostrar `[object Object]`.
- Corregido un 500 posterior en el backfill: al generar `ability:<id>` para un
  candidate sin identity key, seguía escribiendo `display_name=null`, que viola
  el `NOT NULL` de `boss_mechanic_policy`. Ahora usa el nombre del candidate o
  la key estable como fallback. Su catch utiliza `errorMessage()` de Deno, por
  lo que futuros errores PostgREST devuelven detalle real en vez de
  `[object Object]`. Función redeployada y typecheck Deno correcto.
- Corregida una segunda incompatibilidad revelada por la invocación remota:
  `boss_mechanics_candidates` no tiene columna `excluded`. Se auditó el schema
  remoto con `supabase db dump` y el backfill ahora lee
  `applicable_boss_mechanics_candidates`, la vista que ya centraliza evidencia
  y aplicabilidad por dificultad. Se añadió regresión que prohíbe reintroducir
  el filtro `excluded`; función redeployada y checks causal/schema correctos.
- Corregida una tercera incompatibilidad del backfill: `responsibility` legacy
  usa `tank|healer|dps|personal|raid`, mientras M12 exige modos causales
  `tank_role|healer_role|dps_role|target|raid`. El backfill los traduce ahora
  de forma explícita y usa `none` ante dato ausente; la regresión impide volver
  a insertar el valor legacy directamente. Función redeployada tras el 500.
- Rediseñada la UI de policies tras revisión visual: se eliminó la lista
  duplicada de keys `ability:<id>` y el formulario de dos columnas que ocultaba
  contexto. El manifiesto conserva por fila el nombre, tooltip IA, resolución,
  responsable y evidencia; el botón compacto `Policy` abre solo la semántica
  causal de esa mecánica debajo de su fila. El backfill global vuelve a la
  cabecera de la tabla y mantiene confirmación explícita; al terminar,
  recarga el catálogo y el detalle de policy que estuviera abierto.
- Las policies creadas por backfill permanecen `fallback` con defaults no
  punitivos (`targeting/damage/defensive/penalty = none`). Es intencional:
  crean identidad y trazabilidad, pero no inventan resolución ni convierten
  clasificaciones legacy en decisiones causales sin revisión officer.
- Añadida cobertura persistida en la cabecera de Mecánicas por boss+dificultad:
  muestra policies enlazadas frente a candidatas visibles y separa `base`,
  `revisada`, `verificada`, `incierta` y `sin policy`. También enseña la última
  sync real de `boss_mechanic_catalog_sync_state`, modo profundo/rápido,
  referencias y fallos parciales, además de la última actualización de policy.
  Cada fila muestra su estado antes de expandirla. Los errores RLS/PostgREST se
  presentan como error de cobertura y nunca como conteo cero.
- Corregida la causa de “Catálogo sincronizado: nunca”: la primera versión leía
  `boss_reference_sync_state`, que solo mantiene
  `sync-mechanic-defensive-profile` desde Preparación y no la acción visible de
  Mecánicas. M17 crea `boss_mechanic_catalog_sync_state` y
  `sync-boss-mechanics` escribe una fila por dificultad al terminar, incluyendo
  modo, conteos y errores de Wago/WCL. Migración aplicada, función desplegada y
  dry-run remoto sin pendientes.
- Reorganizada la cabecera como flujo numerado de cuatro pasos. Se eliminaron
  las barras competidoras de sync, clasificación y backfill; la acción rápida
  queda bajo Opciones y la UI ya explica qué parte rellena el catálogo y cuál
  exige revisión causal.
- Diagnóstico de la captura de 2026-09-02: la tabla no estaba físicamente
  vacía; las filas `v1 · fallback` y sus aliases prueban que el seed existe.
  Lo pendiente es la semántica no derivable (`targeting`, daño, propagación,
  asignación, defensivos, crédito y penalización), inicializada a `none` para
  no atribuir culpa sin revisión. Repetir el backfill no la rellena: debe
  completarse mediante el paso 3 del runbook y publicar nuevas versiones.
- Corregido el enlace frontend entre catálogo y policy: ahora usa la
  `mechanic_key` M12 persistida y solo reconstruye `ability:<id>` para legacy.
  Antes podía mostrar falsos “sin policy” cuando una identidad canónica no
  coincidiera con la key basada en ability.
- Añadida regresión para que `fallback v1` aparezca como policy base, mientras
  `inferred`/versionada, `verified` y `uncertain` conservan estados distintos.
- Corregidos los estilos encapsulados del botón de backfill: ahora reproduce
  dentro del hijo la acción primaria/secundaria de Mecánicas, porque las clases
  SCSS del componente padre no atraviesan la encapsulación Angular.
- Desplegada la función `backfill-mechanic-candidates-to-policy` corregida y
  añadida al check `verify:causal-runtime`.
- Corregido un bug de contrato en el editor de contexto: presentaba inicio,
  fin, elegibilidad y verificación como editables, pero el endpoint solo
  aceptaba acciones de wipe/ninja e ignoraba esos campos. Se añadió la acción
  autoritativa `override_context` al reductor, endpoint y wrapper Angular;
  valida el intervalo y el límite de wipe antes de invocar la RPC.
- La prueba focalizada del reductor cubre override válido e intervalo inválido.
  El bloqueo TS5097 de imports Deno se resolvió posteriormente sin modificar el
  runtime Deno; build y suite completa pasan.
- Se detectó una activación transitoria de los seis flags causales que hizo
  fallar `verify:causal-schema`; se restauraron a `false`. El rollout vuelve a
  ser shadow y no cambia scoring ni UI hasta completar los gates E2E.
- Añadido `listPreparationChecks()` al consumer del ledger. El dosier nocturno
  solo adopta los conteos de preparation v3 si `playerInfographicV3` está
  activo y recibe ambos checks (`enchant_check` y `gem_check`) con confidence
  `verified`; ante datos ausentes/incompletos conserva exactamente el snapshot
  de equipamiento existente.
- Corregido un fallback silencioso: si la lectura de preparation v3 falla, el
  dosier conserva el snapshot legacy y ahora registra el pull, jugador y error
  técnico en consola para poder investigar la degradación durante el rollout.

## Bloque C — Identidad y `MechanicPolicy`

### Alcance exacto

- [x] M12 & M13: Migraciones SQL con tablas `boss_mechanic_policy`, `boss_mechanic_aliases`, `boss_mechanic_policy_audit`, `mechanic_occurrence_evaluations`, `mechanic_responsibility_edges`.
- [x] Contratos TypeScript: `MechanicPolicyContract`, `MechanicAliasContract`, `MechanicIdentityResolutionResult`.
- [x] Edge Function `resolve-mechanic-identity`: resolver mechanic_key desde ability_id (WCL) o nombre (Journal).
- [x] Edge Function `query-mechanic-policy`: leer policy versionada de un mechanic.
- [x] Edge Function `sync-mechanic-aliases`: sincronizar aliases desde WCL, Journal o clasificador.
- [x] Edge Function `publish-mechanic-policy`: crear/actualizar policy con auto-versionado y auditoría.
- [x] Edge Function `backfill-mechanic-candidates-to-policy`: migrar data legacy de `boss_mechanics_candidates`.
- [x] Feature flag `mechanicPolicyV2` presente y OFF.
- [x] No destructivo: legacy `boss_mechanics_candidates` permanece intacto.

### Definition of Done

- [x] 5 Edge Functions compilables y correcto handling de errores.
- [x] Validación exhaustiva de ENUMs en publish-mechanic-policy.
- [x] Contratos TypeScript con adapters row↔contract.
- [x] Build de producción sin errores (solo warnings pre-existentes).
- [x] RLS para officers en lectura y service_role en escritura.
- [x] Versionado automático: policy_version se incrementa en cada cambio.
- [x] Auditoría completa: before_state, after_state, reason, changed_by.
- [ ] Tests unitarios de Edge Functions (se pueden añadir en siguiente revisión).
- [ ] End-to-end testing con servidor backend real.

### Hallazgos e integración

**Resolver Identity**:
- Busca aliases ordenados por confidence DESC. Permite búsqueda por ability_id
  o normalized_name (ilike para case-insensitive).
- Retorna mechanic_key, source, confidence, alias_id para auditoría.

**Query Policy**:
- Read-only directo a `boss_mechanic_policy`.
- Soporta lectura de versión específica o última (default).
- Retorna contrato completo con causalRule y provenance.

**Sync Aliases**:
- UPSERT idempotente: deduplicación por `(boss_id, difficulty, mechanic_key, ability_id, normalized_name)`.
- Valida constraint: `confidence='uncertain'` solo si `active=false`.
- No crea auditoría (es un sync, no una decisión de officer).

**Publish Policy**:
- Auto-incrementa policy_version al crear nueva versión.
- Valida todos los ENUMs contra constantes locales.
- Sets `verified_at` si confidence='verified'; null para fallback/uncertain.
- Crea row en `boss_mechanic_policy_audit` con estado antes/después.
- Provenance incluye timestamp y source='officer_override'.

**Backfill**:
- Lee `boss_mechanics_candidates` sin exclusiones.
- Convierte legacy `category` → `display_category`, `responsibility` → `responsibility_mode`.
- Confidence='fallback' automático (denota origen legacy).
- UPSERT ignoreDuplicates=true para idempotencia.
- No es destructivo: candidates permanecen intactos.

## Bloque D — Occurrences y Responsabilidad

### Alcance exacto

- [x] M13: tablas versionadas de occurrences y edges de responsabilidad.
- [x] Edge Functions `evaluate-mechanic-occurrences` y `compute-responsibility-edges`.
- [x] Resolución de ownership, eligibility y deduplicación de edges.

### Definition of Done

- [x] Contratos TypeScript, lógica core y build de producción completos.
- [ ] Tests de Edge Functions y validación E2E con eventos WCL reales.

### Hallazgos e integración

## Bloque E — Ledger y consumers shadow

### Alcance exacto

- [x] M14: Tabla `player_execution_events` con eventos idempotentes versionados.
- [x] Tipos TypeScript: `PlayerExecutionEventRow` agregado a combat-evaluation-contract.ts.
- [x] Edge Function `materialize-execution-ledger`: lee ocurrencias, edges, defensivos y muertes.
- [x] Edge Function `materialize-consumable-execution`: procesa consumibles desde el JSONB real de los registros.
- [x] Angular Service `ExecutionLedgerService`: lectura shadow del ledger sin impacto en scoring.
- [x] Feature flag `reliabilityExecutionV3` presente y OFF.
- [x] Shadow approach: materializa v3 sin cambiar puntuación hasta validar divergencias.
- [x] Idempotencia: UPSERT con (pull_id, ledger_evaluator_version, deduplication_key).

### Definition of Done (Fase P0)

- [x] Tipos TypeScript: `PlayerExecutionEventRow` implementado en combat-evaluation-contract.ts.
- [x] Edge Function `materialize-execution-ledger` (~500 líneas):
  - [x] Lee pull_evaluation_context (autoridad).
  - [x] Lee mechanic_occurrence_evaluations (todas por pull).
  - [x] Lee mechanic_responsibility_edges (todas para occurrences).
  - [x] Genera eventos domain='mechanic' con verdict según relationship/outcome.
  - [x] Copia decisiones autoritativas domain='defensive' y respeta su confidence.
  - [x] Materializa domain='death'; solo `self_positioning` puede penalizar.
  - [x] Materializa domain='preparation' para checks informativos de enchants y gemas.
  - [x] Materializa domain='interrupt' solo en resoluciones limpias con resolvedor identificado.
  - [x] Materializa domain='external' desde decisiones defensivas con target verificado y catálogo de cooldowns.
  - [x] Materializa domain='dispel' desde hechos WCL persistidos.
  - [x] UPSERT idempotente por (pull_id, ledger_evaluator_version, deduplication_key).
  - [x] Deduplicación por hash(evidence) + timestamp para eventos idénticos.
  - [x] Retorna event count y ledger_evaluator_version.
- [x] Edge Function `materialize-consumable-execution` (~200 líneas):
  - [x] Lee `death_cause` y `consumables` (JSONB) de player_pull_records.
  - [x] Genera éxito para uso reactivo y fallo solo si healthstone disponible no se usó.
  - [x] No infiere disponibilidad de poción: ausencia de evidencia no penaliza.
  - [x] UPSERT idempotente con mismo esquema.
- [x] Angular Service `ExecutionLedgerService`:
  - [x] Lee `player_pull_execution_summary_v3` directamente vía Supabase.
  - [x] Degrada de forma explícita si la migración aún no está disponible.
- [x] P1: integración de comparación shadow en `ReliabilityService`:
  - [x] Carga una vez los resúmenes del ledger para el conjunto de pulls.
  - [x] Descarta datos con versiones no homogéneas.
  - [x] Expone discrepancia de fallos mecánicos, defensivos y consumibles por jugador.
  - [x] No altera `overall`, `breakdown` ni ningún score visible.
- [x] Build de producción sin errores.
- [x] `verify:causal-schema`: 9 migraciones, 27 reason codes y 6 flags OFF.
- [x] Cola `process-combat-evaluation-queue`: procesa `full_execution_backfill`, encadena occurrences, edges, defensivos y materializadores.
- [x] Corregida invalidación de la tabla: `mechanic_responsibility_edges` (no `mechanic_occurrence_responsibilities`).
- [x] M15 aditiva `pull_dispel_events`: conserva source, target, habilidad y tiempo relativo de los dispels WCL.
- [x] `analyze-report` persiste dispels idempotentemente; antes los descargaba para la causa de muerte y los descartaba.
- [ ] Tests de comportamiento de materializers contra Supabase de prueba.
- [x] Suite Angular: la frontera de imports Deno ya no bloquea las pruebas;
  la suite completa valida los contratos puros compartidos.
- [x] `utility` queda fuera del ledger: no tiene ventana ni outcome verificable y el evaluator defensivo lo excluye por diseño.
- [ ] Policy futura `mechanic_utility_policy` si se quiere evaluar utility: debe definir demanda, ventana, respuesta y responsabilidad antes de materializarla.
- [ ] Fallos de interrupt: no generan penalización hasta que policy/edges identifiquen al responsable; WCL no lo aporta en `players_hit_names`.
- [ ] Prepot: WCL no persiste un snapshot verificable de buffs pre-pull; no se emite `PREPOT_*` hasta disponer de esa evidencia.
- [ ] Fallos de dispel: no generan penalización hasta que exista una policy de debuff y responsabilidad; la ausencia de evento por sí sola no identifica a quién debía limpiar.
- [ ] E2E validation contra corpus de pulls reales.

### Referencia de integración del Bloque D
**evaluate-mechanic-occurrences**:
- Lee `pull_evaluation_context` como autoridad (must be evaluation_eligible).
- Lee `boss_mechanic_policy` para determinar qué mechanics evaluar.
- Genera ocurrencias por cada mechanic_key con occurrence_index=1 (simplificado;
  M13 exige índices positivos).
- Outcome='not_evaluable' inicial (sin análisis WCL detallado aún).
- UPSERT con unique `(pull_id, mechanic_key, occurrence_index,
  occurrence_resolver_version)`.
- Retorna occurrence_resolver_version='mechanic-occurrence-resolver@1.0.0'.

**compute-responsibility-edges**:
- Lee ocurrencias filtradas por pull_id u occurrenceIds.
- Lee policy para cada mechanic_key.
- Lee roster para role-based responsibility (tank, healer, dps).
- Invoca `resolveOccurrenceOwnership()` para determinar primary_owners, co_owners.
- Invoca `buildResponsibilityEdges()` para construir edges con credit/penalty eligibility.
- Deduplica por (occurrence_id, player_name, relationship).
- UPSERT con unique `(occurrence_id, player_name, relationship, reason_code)`.
- Retorna edges con confidence y reason_code.

**mechanic-occurrence-evaluator.ts**:
- `resolveOccurrenceOwnership()`: mapea responsibility_mode → owners según policy.
  - 'target': target_actor_ids directos.
  - 'tank_role', 'healer_role', 'dps_role': roster filtrado por role.
  - 'assigned_player': assignment_snapshot.assignedPlayer.
  - 'assigned_group': assignment_snapshot.assignedGroup.
  - 'raid': toda la raid.
  - 'volunteer'/'none': sin owner específico.
- `isOccurrenceEvaluable()`: valida que outcome='fail' + confidence='uncertain' no es evaluable.
- `canRelationshipBePenalized()`: validates relationship + confidence (solo verified/inferred).
- `canRelationshipGetCredit()`: validates relationship ∈ [successful_resolver, beneficiary] ∧ outcome='success'.

**responsibility-edge-builder.ts**:
- `buildResponsibilityEdges()`: construye edges por tipo relación:
  - primary_owner: outcome='fail' → penalizable si confidence≠uncertain.
  - co_owner: outcome='fail' → penalizable si confidence≠uncertain.
  - assigned_resolver: outcome='fail' → penalizable; outcome='success' → creditable.
  - target: no penalizable (víctima directo).
  - collateral_victim: no penalizable (víctima de propagación).
- `deduplicateEdges()`: mantiene edge con highest confidence en conflicto.

**Flujo causal M12 → M13 → M14**:
```
boss_mechanic_policy (M12)
  ↓ (responsibility_mode, targeting_mode, failure_propagation)
mechanic_occurrence_evaluations (M13)
  ↓ (outcome, targetActorIds, failureMode)
mechanic_responsibility_edges (M13)
  ↓ (playerName, relationship, credit/penalty_eligible)
player_execution_events (M14)
  → reason_code, verdict, domain='mechanic'
```

### 2026-09-01 — Bloque E P1: comparación shadow

- Corregido `ExecutionLedgerService`: la app lee la vista
  `player_pull_execution_summary_v3` por Supabase; no había un backend para
  las rutas `/api/ledger` inicialmente propuestas.
- Añadido `compareExecutionLedgerShadow()` a `ReliabilityService` y expuesto
  el diagnóstico por jugador sin modificar la fórmula, el scoring ni la UI.
- El diagnóstico solo considera pulls con versiones homogéneas y falta de
  migración se degrada a ausencia de comparación, nunca a datos cero.
- Alineados los dos materializadores con M14: campos obligatorios,
  deduplicación estable, eligibility del pull y reason codes permitidos.
- Corregida la fuente de consumibles: no existían columnas `healthstone_available`,
  `health_potion_available` ni `death_ms`; los hechos viven en los JSONB
  `consumables` y `death_cause`.
- Corregida la cola: antes podía crear `full_execution_backfill` sin llegar a
  reclamarlo y referenciaba una tabla de responsabilidades inexistente.
- Añadidos al ledger los dominios defensivo y muerte. La confianza incierta se
  conserva como evidencia y no produce penalización.
- Añadidos checks de preparación de enchants y gemas desde `equipped_items`.
  Se registran con timestamp `0`, son informativos y no penalizan: no hay un
  reason code punitivo de preparación verificable en M14. Prepot sigue fuera
  porque WCL no aporta estado de buffs anterior al pull.
- Añadido el dominio de interrupt desde `pull_mechanic_events`. Solo los
  interrupts `clean` con un resolvedor único generan crédito; los fallos sin
  asignación se preservan en la fuente pero no se convierten en culpabilidad.
- Build de producción y `npm run verify:causal-schema` correctos.
- Inicialmente no se pudo ejecutar `deno check` porque Deno no estaba en PATH.
  **Resuelto posteriormente** con `npx deno check`: los entrypoints causales
  pasan el typecheck real; la frontera Angular/Deno también quedó cubierta por
  la suite Angular restaurada.
- Añadido `verify:causal-runtime`. El primer launcher con `npx.cmd` fallaba sin
  output desde `spawnSync`; se corrigió ejecutando `npx` mediante el shell de
  Windows y ahora valida los 12 entrypoints en una sola orden.
- Añadida M15 `pull_dispel_events` y escritura idempotente en
  `analyze-report`: los dispels WCL se usaban al clasificar la causa de una
  muerte, pero antes se perdían al terminar el análisis.
- El ledger acredita limpieza aliada solo con `source_player_name` conocido y
  excluye `is_buff=true` (dispel ofensivo). No penaliza una ausencia de dispel
  sin policy que identifique al responsable.
- El ledger acredita o registra fallo de un externo solo cuando la evaluación
  defensiva aporta target explícito y el cooldown está clasificado como
  `external_defensive`; nunca deriva cobertura del rol.
- Gate de despliegue: aplicar M15 antes de desplegar `analyze-report` y
  `materialize-execution-ledger`, pues ambos usan `pull_dispel_events`.
- `utility` se mantiene fuera del ledger. `cooldown_catalog` lo define como
  habilidad sin mitigación relevante y el evaluator la excluye: no existe una
  ventana de demanda ni un outcome que permitan acreditar o penalizar sin
  inventar causalidad. Si pasa a evaluarse, requerirá `mechanic_utility_policy`.

## Bloque F — Defensa y consumibles causales

### Avance inicial

- [x] `materialize-consumable-execution` registra `HEALTHSTONE_REACTIVE` y
  `HEALTH_POTION_REACTIVE` aunque el jugador sobreviva al pull.
- [x] Los créditos usan el timestamp verificado del cast dentro de la ventana
  de presión persistida; no se inventa un timestamp a partir de una muerte.
- [x] La ausencia de consumible continúa siendo penalizable únicamente si hay
  muerte con timestamp válido y healthstone disponible sin usar.
- [x] Un timestamp corrupto de un consumible no puede impedir evaluar el otro.
- [x] La reactividad se recalcula en la materialización contra las ventanas de
  presión v2 persistidas más recientes, sin confiar en `usedReactively`
  potencialmente obsoleto.
- [x] Los eventos defensivos del ledger se enlazan a una occurrence por
  `abilityId + occurrenceIndex` mediante aliases activos M12.
- [x] La penalización defensiva causal exige policy `required` o
  `recommended`, confianza trusted y versión de policy igual a la que
  evaluó la occurrence.
- [x] Corregido `evaluate-mechanic-occurrences`: M13 exige índices positivos,
  pero el placeholder insertaba `occurrence_index=0`.
- [x] `verify:causal-schema` cubre la invariante de índice positivo en schema
  y evaluator para evitar la regresión.
- [x] Corregidos los dos `onConflict` de M13: los writers usan los uniques
  completos de occurrences y responsibility edges.
- [x] `verify:causal-schema` comprueba ambos tuples de UPSERT.
- [x] Tests del builder de edges: reason codes canónicos y owners derivados del
  roster sin serializar `NaN` como actor ID.
- [ ] Policy causal defensiva por mecánica: vincular `defensive_expectation`
  de `boss_mechanic_policy` con requirements y responsabilidades. Parcial:
  la materialización ya enlaza events, pero el evaluator aún no crea slots
  desde policy si no existe un plan publicado.
- [x] Elegibilidad sin plan publicado: el evaluator v2 ya produce ventanas no
  asignadas, `correct_hold` y decisiones de muerte en modo `no_plan`.
- [ ] E2E de modo `no_plan`: comprobar pulls con kit verificable para confirmar
  que la persistencia aporta las ventanas y no degrada a `uncertain`.

### Hallazgo

- Existía un bug de control de flujo: el materializador abandonaba cada jugador
  antes de evaluar consumibles si no había muerto. Eso borraba evidencia de uso
  reactivo en pulls supervivientes. La puerta de muerte ahora cubre solo el
  fallo de healthstone disponible no usado.
- Existía una incompatibilidad de contrato: M13 impone
  `occurrence_index > 0`, mientras el evaluator placeholder usaba `0`. Se
  cambió a `1`, que además coincide con los slots del plan defensivo. El ledger
  resuelve ahora el vínculo causal por aliases y no asume que
  `defensive_plan_slots.mechanic_key` histórico ya esté rellenado.
- Una policy posterior no puede reinterpretar una occurrence histórica: si su
  `policy_version` no coincide, el evento defensivo se conserva sin occurrence
  ni penalización causal.
- Corregida esa degradación tras introducir M16: el materializador consulta
  `boss_mechanic_policy_versions` por `(mechanic_key, policy_version)` y usa el
  snapshot que evaluó la occurrence. Publicar una policy nueva ya no desconecta
  defensivos históricos ni cambia su semántica retrospectivamente.
- Corregida una hipótesis de seguimiento: `no_plan` no equivale a ausencia de
  evaluación. El evaluator ya resuelve ventanas sin slot, retenciones correctas
  y muertes con CD viable; el gate pendiente es validar que los pulls reales
  tengan kit y ventanas persistidos con confianza suficiente.
- Corregido un problema de freshness: `consumables.usedReactively` se calcula
  durante el análisis inicial y podía quedar obsoleto tras un backfill de
  `defensive_pressure_windows_v2`. El materializador vuelve a aplicar
  `isReactiveConsumableUse()` sobre las ventanas vigentes.
- No se añade `mechanic_key` a `player_pull_defensive_evaluations`: una fila
  representa un jugador y pull completos, mientras sus eventos pueden cubrir
  múltiples mecánicas. La relación correcta vive por evento en el ledger.
- Encontrados dos errores que el build Angular no podía detectar: los UPSERT
  de M13 omitían columnas que forman parte de los unique constraints reales.
  `evaluate-mechanic-occurrences` omitía `occurrence_resolver_version` y
  `compute-responsibility-edges` omitía `reason_code`; ambos habrían fallado
  al materializar en PostgreSQL. Se alinearon y se añadieron regresiones al
  verificador causal.
- Encontrados reason codes inválidos ocultos con casts `as ExecutionReasonCode`
  en `responsibility-edge-builder`: `MECHANIC_FAILURE`,
  `COOWNER_MECHANIC_FAILED`, `ASSIGNED_DEFENSIVE_EXECUTED` y otros no existen
  en el constraint de M14, por lo que el ledger habría rechazado sus eventos.
  Se sustituyeron por el vocabulario canónico de M14 y el verificador ahora
  comprueba todos los literales de reason code emitidos por el builder.
- Corregido otro dato inválido en los edges: los owners derivados de rol son
  nombres de jugador, pero el builder aplicaba `parseInt()` y podía producir
  `NaN` para `actor_id`. Ahora solo conserva IDs positivos explícitos y deja
  `actor_id=null` para nombres, con regresión ejecutable.

## Bloque H — Dosier e infografía v3

### Avance inicial

- [x] `NightGearSnapshot` conserva provenance explícita: fuente legacy/v3,
  versión del ledger y fecha de evaluación.
- [x] El dosier muestra “Preparación al entrar a raid” solo con
  `playerInfographicV3` activo.
- [x] La sección identifica si los conteos proceden de checks v3 verificados o
  del fallback de Warcraft Logs; no infiere la fuente desde los números.
- [x] El dosier puede mostrar ofensas mecánicas v3 como evidencia separada,
  con occurrence, relación, reason code, confidence y versiones.
- [x] La evidencia v3 no altera `mechanicFails`, prioridades ni scoring; se
  consulta únicamente tras activar `playerInfographicV3`.
- [x] Ante datos v3 ausentes/incompletos o un error de lectura, mantiene el
  snapshot existente sin cambiar scoring.
- [ ] Backfill de ledger y validación E2E sobre un corpus de pulls reales antes
  de activar la flag en producción.

### Hallazgo

- `startingPreparation` se usaba internamente para prioridades de la infografía
  pero no se mostraba en el dosier, y los conteos no incluían su procedencia.
  La nueva sección resuelve ambas cosas sin sustituir la vista final de equipo:
  “Equipo” sigue describiendo el último pull y “Preparación” el primer pull.
- `player_mechanic_offenses_v3` no puede sustituir aún `mechanicFails`: el
  resolver de occurrences puede marcar `not_evaluable` y la vista v3 no trae
  nombre/categoría ni detalle de daño equivalentes al modelo legacy. Se muestra
  como auditoría separada solo con flag, y nunca crea un incidente nuevo ni
  altera conteos visibles.

## Bloque I — Fiabilidad v3

### Avance inicial

- [x] Comparación shadow legacy/ledger por jugador, sin cambios a `overall` ni
  a los ejes de fiabilidad.
- [x] Reporta fallos v3 por dominio mecánico, defensivo y consumibles, además
  de `primaryPenaltyCount` como subconjunto explícito.
- [x] Requiere `versions_homogeneous` por pull y publica `versionsCompatible`
  solo si hay una versión única `execution-ledger@1.0.0`.
- [x] La regresión de comparación verifica pulls homogéneos y descarta los de
  versiones mezcladas antes de calcular divergencias.
- [ ] Calibración E2E contra un corpus de pulls y definición de umbrales de
  divergencia antes de activar `reliabilityExecutionV3`.

### Hallazgo

- Las alertas de “mezcla de jugadores” en la comparación no aplicaban: el
  caller ya filtra los resúmenes por `player_name` antes de invocar el cálculo.
  Sí faltaban el conteo de penalizaciones principales y un criterio explícito
  de versión canónica; ambos se añadieron como diagnóstico, no como scoring.
- La suite focalizada de fiabilidad quedó inicialmente bloqueada por el import
  `.ts` Deno (TS5097). **Resuelto posteriormente**: la supresión localizada
  permite ejecutar la suite y el total del proyecto (35 archivos, 220 pruebas).

## Registro cronológico

### 2026-09-02 — Separación de catálogo y policies por límite del worker

- Reproducido desde la arquitectura el `WORKER_RESOURCE_LIMIT`: el submit v7
  mezclaba validación, escrituras de catálogo, recorridos de pulls históricos,
  publicación/versionado de policies, snapshots y auditorías. Si fallaba el
  lote, además reintentaba policy por policy dentro del mismo worker agotado.
- `classify-mechanics` pasa a prompt de catálogo v8. Ya no solicita
  `causalPolicy`, no toca `boss_mechanic_policy` ni recorre históricos. Agrupa
  category/resolution/responsibility/avoidable en un parche por candidata y
  limita la concurrencia de escritura a ocho filas.
- Añadida `classify-mechanic-policies` v1. El prompt devuelve todas las
  dificultades y mecánicas del boss en una sola respuesta. Al aplicar, el
  frontend valida el total, agrupa por dificultad y crea lotes máximos de 20;
  cada llamada backend sigue rechazando scopes mezclados o lotes mayores.
- M19 añade `publish_mechanic_policy_batch`: usa lock transaccional por
  identity, incrementa versión y publica policy + snapshot M16 + auditoría en
  una sola transacción. Desaparece el fallback Edge fila-a-fila.
- Se conservan los guards: `low → uncertain` sin scopes; `medium → inferred`
  sin penalización; `high → inferred` y puede conservar la penalización
  propuesta. Cada fila exige dos URLs públicas de dominios distintos.
- Ajustes → Mecánicas presenta ahora cinco pasos: sync, catálogo, identities,
  semántica causal y revisión de excepciones. Catálogo y policies ofrecen cada
  uno un único prompt global, textarea, resultado y errores independientes.
- Si falla un lote intermedio, el textarea conserva únicamente las filas no
  procesadas o rechazadas. Reintentar no vuelve a versionar las policies de
  lotes anteriores que ya quedaron confirmados.
- Regresiones puras para enums, guards, cobertura y particionado global: 10/10
  focalizadas. Validación total: build correcto, 38 archivos/234 pruebas, 10 migraciones en
  schema y 14 Edge Functions con typecheck Deno.
- Despliegue backend completado el 2026-09-02: aplicada
  `20260902130000_publish_mechanic_policy_batch.sql`; `classify-mechanics` está
  `ACTIVE` en v30 y `classify-mechanic-policies` está `ACTIVE` en v2. El dry-run
  enlazado queda sin pendientes. Solo queda recargar/desplegar el frontend.

### 2026-09-02 — Cobertura visible y runbook de finalización

- Confirmado desde la captura que las policies existen (`v1 · fallback` y
  aliases presentes), pero su semántica causal no revisada permanece en
  defaults no punitivos. No es pérdida física ni se resuelve repitiendo seed.
- Añadida cabecera persistida por boss+dificultad con cobertura, estados,
  última sync del catálogo, última actualización de policy y muestra de logs.
- Las filas enlazan por `mechanic_key` canónica; `ability:<id>` queda solo como
  compatibilidad con candidates legacy todavía no migradas.
- Añadido runbook 0-9 con comprobaciones, criterios de salida, fallos esperados,
  recuperación, activación gradual y rollback sin pérdida de evidencia.
- Validación: build correcto, 36 archivos/224 pruebas, schema causal correcto,
  13 Edge Functions comprobadas y diagnósticos Angular/TypeScript limpios.
- Corregida posteriormente la fuente de “Catálogo sincronizado”: M17
  `boss_mechanic_catalog_sync_state` está aplicada en remoto y
  `sync-boss-mechanics` desplegada para escribir fecha, modo, filas,
  referencias y fallos parciales por dificultad. El dry-run remoto quedó sin
  pendientes. No se fabricó historial para syncs anteriores; el primer sync
  posterior al despliegue inaugura el estado fiable.
- La cabecera de Mecánicas quedó reducida a un flujo 1-4: sincronizar,
  clasificar, crear identities/policies ausentes y revisar causalidad. El sync
  rápido está bajo Opciones. Validación posterior: build y 224/224 pruebas,
  verificador con 9 migraciones y typecheck Deno de `sync-boss-mechanics`.
- Corregida la discrepancia del paso 2: el resultado anterior mostraba en verde
  59 categorías, 68 resoluciones y 68 responsables como éxitos independientes,
  aunque no todos coincidían en las mismas filas. El submit devuelve ahora
  `fullyAppliedCount/submittedCount` y el banner principal es warning si la
  cobertura conjunta no es total. El círculo usa esa misma semántica visible;
  `avoidable:null` es una decisión triestado válida y ya no bloquea por sí sola
  una fila completa. Regresión focalizada: 4/4 pruebas.
- Implementado y desplegado `classify-mechanics` prompt v7. Cada objeto añade
  `causalPolicy` con targeting, daño, propagación, asignación, expectativa
  defensiva, crédito y penalización. El submit auto-publica las policies en
  lote, incrementa versión, conserva snapshot M16 y crea auditoría con motivo
  automático. La UI presenta el paso 4 como revisión de excepciones, no como
  cumplimentación manual masiva.
- Guards v7: `low` se persiste como `uncertain` con crédito/penalización `none`;
  `medium` como `inferred` sin penalización; `high` como `inferred` y puede
  conservar el scope punitivo propuesto. El scope original queda además en
  `causal_rule.proposedPenaltyScope` para auditar degradaciones.
- `verify:causal-runtime` incluye ahora `classify-mechanics`: 13 Edge Functions
  causales comprobadas. El prompt v6 ya aplicado debe repetirse una sola vez
  por boss con v7 para generar la semántica; no exige editar cada habilidad.
- Corregido el `[object Object]` al aplicar prompt v7. La causa inmediata era
  que `classify-mechanics` convertía los objetos planos `PostgrestError` con
  `String(error)` en su catch final, destruyendo `message/details/hint` antes
  de enviarlos al frontend. Ahora usa el normalizador Deno compartido, registra
  el error real y añade la etapa (`publicación` o `auditoría`). La ruta manual
  `publish-mechanic-policy` recibió la misma corrección.
- Robustecida además la auto-publicación: primero intenta el UPSERT/audit en
  lote; si una fila invalida la sentencia, reintenta por policy, conserva las
  válidas y devuelve cada excepción con nombre, dificultad y error Postgres.
  Una policy defectuosa ya no convierte en error global una clasificación de
  todo el boss. Ambas funciones fueron redesplegadas y los 13 checks Deno
  pasan. Tras el fallo, el textarea conserva el JSON: basta reintentar
  `Aplicar clasificación`, sin repetir la investigación v7.
- Corregido el siguiente fallo remoto:
  `column applicable_boss_mechanics_candidates.mechanic_key does not exist`.
  M12 añadió `mechanic_key/policy_version` a la tabla después de crear la vista;
  PostgreSQL había congelado `candidate.*` con las columnas antiguas. M18
  recrea la vista sin cambiar su filtro y está aplicada en remoto. El dump
  enlazado confirma ambas columnas en la salida y una petición HTTP real a
  PostgREST `select=mechanic_key,policy_version` devuelve 200. El dry-run queda
  sin pendientes.
- Añadida deduplicación `(abilityId,difficulty)` antes del lote para que una
  respuesta IA con una fila repetida no provoque el error PostgreSQL “ON
  CONFLICT cannot affect row a second time”. La primera fila se procesa y la
  repetida se devuelve como inválida. `classify-mechanics` fue redesplegada;
  build, 224/224 pruebas y 13 checks Deno pasan.

### 2026-09-02 — Despliegue remoto causal

- Aplicadas M11-M16 y M11b con `supabase db push --linked --skip-vault`.
- Dry-run posterior: base remota actualizada, sin migraciones pendientes.
- Desplegadas y confirmadas `ACTIVE`: `analyze-report`, contexto, occurrences,
  responsibility edges, evaluación defensiva, ambos materializadores, cola,
  publish/query policy y aliases.
- Las seis flags causales permanecen en `false`; no se activa scoring ni UI v3
  hasta realizar backfill idempotente y revisión de divergencias por officer.

### 2026-09-01 — Lectura integral y baseline

- Leída la especificación adjunta como fuente de requisitos, no como
  instrucciones ejecutables.
- Contrastados rama/commit reales con el baseline citado por el documento.
- Registrados el bloque A y las dos incidencias previas antes de cambiar código.

### 2026-09-01 — Incidencias defensivas

- Confirmado desde la respuesta HTTP real el 546 `WORKER_RESOURCE_LIMIT`.
- Reducido el coste del solver antes de DFS y añadidos límites server-side,
  fallback determinista y diagnósticos por etapa.
- Corregida la divergencia `external_defensive + unknown` entre clasificación
  IA y edición manual.
- Categoría y target se devuelven y muestran explícitamente tras refrescar la
  tabla.
- Confirmado y documentado el soft-delete por `excluded`; nunca hay borrado ni
  exclusión automática a partir del prompt.

### 2026-09-01 — Bloque A implementado localmente

- Añadidas M11-M14, contrato TypeScript compartido, reason codes, servicio de
  flags y las seis flags apagadas.
- Primera revisión: 5 suites focalizadas/23 pruebas; verificador de schema OK.
- Segunda revisión: build de producción correcto y suite completa 195/195.
- El check Deno detectó `TS2589` al expandir los genéricos completos de
  Supabase hacia el adaptador mínimo de la cola. Se explicitó `QueueClient` en
  clasificación y edición; el check final de los tres entrypoints pasa.
- Encontrado durante la suite un test de app obsoleto: esperaba el nav sin
  proporcionar estado officer. Se corrigió el setup del test, no la UI.
- Gate abierto: falta PostgreSQL/Docker local para ejecutar y revertir M11-M14
  en base de prueba. No se han aplicado migraciones ni desplegado funciones en
  el proyecto remoto.

### 2026-09-01 — Bloque B: Editor de contexto de evaluación

- Creado componente Angular standalone `PullEvaluationContextEditorComponent`
  con capacidad de override de valores `pull_evaluation_context`.
- UI modal para editar:
  - Intervalo evaluable: `evaluationStartMs` y `evaluationEndMs`.
  - Límite de wipe: `wipeCallAtMs` con validación de bounds.
  - Estado ninja: confirmación y restauración reversible.
  - Razón de cambio: auditoría obligatoria.
- Métodos helper para:
  - Validación de intervalos contra duración del pull.
  - Formato de display en segundos (H:MM:SS).
  - Extracción de candidatos de wipe desde `evidence` con type safety.
  - Resumen de cambios para verificación.
- Tests de componente: 11 suites de comportamiento, validación y edge cases.
- Build de producción: éxito sin errores, solo warnings de budget pre-existentes.
- Issue detectado: `tsconfig.spec.json` falla al compilar imports de Deno
  functions con extensión `.ts`; no impacta build de producción ni runtime,
  es un issue pre-existente en la configuración que se debe resolver.
- Componente listo para integración en vistas de live-pull y auditoría de
  decisiones de evaluación por officers.

### 2026-09-02 — Una dificultad incompleta ya no bloquea policies listas

- Diagnosticado el falso bloqueo: la cobertura 21/21 de la UI pertenecía a la
  dificultad seleccionada, pero `classify-mechanic-policies` abortaba el prompt
  global al encontrar un único `mechanic_key` ausente en cualquier otra.
- Policies prompt v2 agrupa por dificultad. Incluye todas las filas de cada
  dificultad completa y omite completa cualquier dificultad con identities
  pendientes, devolviendo `skippedDifficulties` con sus conteos.
- La UI muestra el aviso sin convertirlo en error y el botón global ya no se
  deshabilita por la cobertura de la pestaña seleccionada. Si ninguna
  dificultad está completa, el bloqueo sigue siendo correcto y explícito.
- Añadidas 2 pruebas Deno del particionado y conectadas al verificador causal.
  Validación local: 14 Edge Functions, 2/2 Deno, build correcto y suite Angular
  completa 38 archivos/236 pruebas. `classify-mechanic-policies` v2 está
  desplegada y `ACTIVE`; solo queda recargar el frontend.

### 2026-09-02 — M20 blinda la publicación contra ambigüedad PL/pgSQL

- Reproducido desde el error remoto: el parámetro OUT `mechanic_key` de
  `RETURNS TABLE` colisionaba con `mechanic_key` en el conflict target de M19.
- M20 conserva la firma consumida por la Edge Function, usa
  `ON CONFLICT ON CONSTRAINT boss_mechanic_policy_pkey`, fija
  `#variable_conflict use_column` y devuelve ambas columnas cualificadas desde
  `v_after`.
- La propia migración ejecuta INSERT/UPSERT/audit/snapshot sobre una policy
  existente dentro de un subbloque y provoca una excepción centinela para
  revertir todos los cambios del autotest. Cualquier error real aborta M20.
- Aplicada correctamente al proyecto remoto; el autotest pasó y el dry-run
  posterior confirma `upToDate:true`. El JSON pegado puede reintentarse sin
  repetir la investigación.
