# Gestión unificada de defensivos v2 — seguimiento de implementación

Este archivo es el registro común y acumulativo de la actualización descrita en
`AVOID_Especificacion_Tecnico_Funcional_Gestion_Defensivos_v1.0.docx`. Debe
actualizarse al comenzar y cerrar cada bloque. Una casilla cerrada significa que
el cambio está implementado, revisado y respaldado por las comprobaciones
indicadas aquí; no significa únicamente que exista código.

## Baseline y reglas de trabajo

- Rama: `fix/defensive-catalog-discovery-v5`.
- Commit auditado por la especificación y presente al iniciar: `08f6b01`.
- Inicio de la implementación: 2026-08-31.
- Estrategia: cambios aditivos, versionados, reversibles y compatibles con el
  flujo legacy.
- Orden obligatorio: datos/versionado → resolver → reanálisis → ocurrencias y
  perfiles → plan/solver → MRT → evaluator → infografía → Fiabilidad.
- Un dato `uncertain` puede mostrarse, pero no puede producir penalización.
- Un plan publicado y un pull histórico no se reinterpretan silenciosamente.
- La detección de pressure windows se conserva como sensor; `coverable` no será
  la autoridad de scoring v2.
- Los cambios ajenos ya presentes en la rama se preservan. Al iniciar solo se
  detectó `.claude/` sin seguimiento, que queda fuera de este trabajo.

## Estado global

| Bloque | Entrega                      | Estado    | Dependencias / notas                                                               |
| ------ | ---------------------------- | --------- | ---------------------------------------------------------------------------------- |
| A      | Datos base M1/M2             | Implementado y revisado | Migraciones listas; falta aplicarlas en el entorno de destino.                     |
| B      | Effective Defensive Resolver | Implementado y revisado | Resolver 2.1 único, incluida disponibilidad activa/pasiva por build.                |
| C      | Corrección histórica         | En curso | Motor y cola listos; el backfill debe revalidarse con resolver 2.1 y datos reales.     |
| D      | Ocurrencias de mecánica      | En curso | Schema y dual-write world listos; falta resync/contraste real de bosses.            |
| E      | Evidencia local              | Implementado y revisado | Reconstrucción separada lista; falta desplegar y contrastar con pulls reales.       |
| F      | Esquema de plan desplegado   | Implementado y revisado | Versiones/snapshots/binding listos; falta aplicar migración y prueba DB real.       |
| G      | Solver global                | Implementado y revisado | Solver/backend/timeline listos; falta ejecutar con roster y datos reales.           |
| H      | MRT v2                       | Implementado y revisado | Export por persona/slot/grupo listo; falta importación manual final en el addon.   |
| I      | Evaluator                    | Implementado y revisado | Replay/persistencia shadow listos; falta aplicar M8 y validar pulls reales.         |
| J      | Infografía / sección 04      | Implementado y revisado | UI v2 lista tras flag; fallback legacy atómico hasta backfill completo.             |
| K      | Fiabilidad v2                | Implementado y revisado | Fórmula central, columnas aditivas, shadow compare y flag seguro; falta calibración real. |
| L      | Limpieza legacy              | Bloqueado por consolidación | No borrar hasta superar los 25 escenarios E2E de `iris-defensivos-v2-consolidation-progress.md`. |

## Auditoría inicial completada

Fuente revisada íntegramente: especificación v1.0, secciones 0–36 y anexos A–E.

Hallazgos contrastados con el código de la rama:

- `defensive_spec_profiles` y `defensive_modifier_rules` fueron creadas por la
  migración v5, pero no versionan `game_build`, no tienen todavía policies de
  lectura para oficiales y no alimentan el runtime principal.
- `player_pull_records.talent_build` ya guarda `id`, `nodeID`, `rank` y el
  `spellId` resuelto cuando está disponible. No se creará un snapshot paralelo.
- `TalentGate` reduce el build a conjuntos de IDs; no puede aplicar efectos por
  rango.
- `defensiveStatusAt` usa `baseCooldownMs`; analyze/reanalyze, pressure windows
  y el estado de muerte heredan esa semántica legacy.
- Preparación y AUTO leen `base_cooldown_ms`; la cronología recalcula conflictos
  en el componente y el MRT actual exporta `players: []`.
- `mechanic_defensive_assignments` sí es una única persistencia compartida por
  AUTO y la tabla. Se conservará como template por spec.
- `reanalyze-defensive-pressure` ya procesa un pull por invocación y
  `pulls.updated_at` ya es el mecanismo de invalidación; ambos patrones se
  conservarán.

## Bloque A — Datos base M1/M2

### Objetivo

Preparar el esquema para que el resolver pueda distinguir versión del juego,
campo modificado, cargas/recharge, semántica de target y build exacto del
jugador sin cambiar aún el comportamiento visible ni el scoring.

### Implementado

- [x] M1: versionar perfiles por spec y reglas por `game_build`.
- [x] M1: añadir `recharge_ms`, `effect_field` y orden determinista de reglas.
- [x] M1: añadir `targeting_mode` conservador al catálogo.
- [x] M1: completar RLS de lectura para oficiales.
- [x] M2: añadir `talent_build_fingerprint`, `game_build` y
      `defensive_resolution_version` a `player_pull_records`.
- [x] M2: crear `player_latest_build` con fecha/report/pull de observación.
- [x] Añadir provenance de `game_build` y confianza para no confundir el
      identificador Retail/Classic de WCL con una patch real.
- [x] Evolucionar `classify-defensives` a prompt v6: captura build exacto,
      exige `effectField` y limita reemplazos al build investigado.
- [x] Añadir tipos de dominio necesarios sin hacer que Angular resuelva valores.
- [x] Validar build y revisar manualmente constraints/`onConflict`/RLS.

### Decisiones tomadas

- Los registros legacy usarán un scope explícito y distinguible, no fingirán
  pertenecer a un build real.
- `targeting_mode` empieza en `unknown` salvo evidencia inequívoca. El evaluator
  futuro excluirá de scoring propio cualquier external/hybrid sin target fiable.
- El fingerprint será determinista sobre clase, spec, game build y nodos
  normalizados; se implementará en la capa canónica, no mediante SQL dependiente
  del orden original del JSON.

### Revisión del bloque

- `npm run build`: correcto. Solo permanecen warnings de budgets SCSS ya
  existentes.
- `npm test -- --watch=false`: 83/84 pruebas pasan. El único fallo está en
  `src/app/app.spec.ts` (`.brand` no existe en ese montaje condicionado por
  autenticación); no toca datos ni lógica defensiva y queda registrado como
  incidencia de baseline, no como regresión del bloque.
- Las migraciones no se han aplicado a una base remota ni local desde este
  trabajo. Deben ejecutarse en orden `20260831200000` → `20260831210000`
  antes de desplegar `classify-defensives` v6.
- Revisión de inconsistencia cerrada: `masterData.gameVersion` de WCL solo
  distingue Retail/Classic. `game_build` exacto permanece nullable y con
  provenance/confianza; no se rellena con ese valor.
- Compatibilidad cerrada: respuestas v5 sin `effectField` se aceptan como
  `legacy-current`, nunca como reglas verificadas de una patch concreta.

## Bloque B — Effective Defensive Resolver

### Objetivo

Crear la única función de dominio que combina catálogo, perfil por spec,
talentos/rango, reglas por build y overrides, devolviendo cooldown, duración,
cargas, targeting, provenance y confidence. Angular solo consumirá la salida.

### En curso

- [x] Implementar normalización y fingerprint determinista del build.
- [x] Implementar precedencia y selección exacta/fallback de perfiles/reglas.
- [x] Aplicar rank, operaciones y reglas conditional sin convertirlas en hecho.
- [x] Validar conflictos, valores inválidos y eligibility de talentos.
- [x] Añadir tests unitarios, incluido Fade 30 s → 20 s a rango 2.
- [x] Crear endpoint de lectura para Preparación.
- [x] Integrar analyze/reanalyze en shadow sin cambiar scoring legacy.
- [x] Modelar disponibilidad activa/pasiva por build y conversiones por
      talento; una pasiva sigue visible para explicar el kit, pero queda fuera
      de solver, reminders y oportunidades punitivas.
- [x] Versionar targeting/categoría de recurso y permitir corregir
      personal/semi/external desde el catálogo sin guardar valores efectivos
      de un jugador en la fila base.

### Revisión del bloque

- Resolver puro `effective-defensives@2.1.0`: no importa Deno ni Supabase y
  conserva provenance por cada transformación.
- 23/23 tests específicos del resolver pasan. Cubren talentos ausentes, lookup incompleto,
  rank, regla conditional, perfil exacto y legacy, cambio de build, overrides,
  conflictos `set_ms`, valores negativos, recharge, adaptación de filas v5,
  inferencia temporal conservadora y fingerprint estable.
- `npm run build`: correcto; solo warnings de budgets ya presentes.
- Las cuatro Edge Functions afectadas compilan con esbuild, incluidos imports.
- Suite completa final: 113/114 pruebas pasan. Sigue fallando únicamente el test de
  baseline `src/app/app.spec.ts:24` por buscar `.brand` en un montaje sujeto a
  autenticación; no interviene en este bloque.
- Inconsistencia corregida durante la revisión: la versión de una regla se
  selecciona antes de filtrar por spec. Una fila exacta cuya spec cambió impide
  que reaparezca silenciosamente una regla legacy más permisiva.
- Inconsistencia corregida durante la revisión: un override de spec no se aplica
  si la spec del jugador es desconocida.
- Inconsistencia corregida durante la revisión: tampoco se aplica una regla de
  talento limitada por spec cuando la spec es desconocida.
- Inconsistencia corregida durante la revisión: los snapshots antiguos sin
  `spellId` se enriquecen mediante `TraitNodeEntry.ID` antes del fingerprint.
- Los snapshots sin `game_build` no aceptan `spellId` enriquecidos con el DB2
  actual, no reciben fingerprint y no pueden activar modifiers por accidente.
- Perfiles con varias cargas y sin `recharge_ms` explícito devuelven el cooldown
  efectivo final como recarga; ningún consumidor tiene que reinterpretar null.
- La respuesta de investigación IA queda ligada al `gameBuild` del prompt. Un
  JSON de otro prompt/build se rechaza antes de tocar perfiles o reglas.
- El endpoint carga catálogo/perfiles/reglas/overrides en batch. La selección
  de identidad queda en el resolver puro, evitando filtros de nombre
  interpolados y manteniendo la preferencia por `characterId`.
- `analyze-report` y `reanalyze-defensive-pressure` persisten
  `defensive_resolution_shadow` con kit, provenance y diff contra legacy. El
  cierre inicial de B no sustituía ningún campo de scoring legacy. El bloque C
  añade materializaciones v2 paralelas y las marca con versión sin cambiar los
  consumidores legacy.
- El build actual de Blizzard solo se asocia a pulls observados durante las 48 h
  anteriores y siempre con confidence `inferred`. Los demás históricos quedan
  `game_build=null`, `uncertain`; la reanalítica respeta cualquier build ya
  persistido y solo usa lookups cacheados de esa misma versión.
- Despliegue obligatorio: las cuatro migraciones `20260831200000` a
  `20260831230000` deben aplicarse en orden antes que las
  Edge Functions que escriben/leen las columnas v2.
- Consolidación adicional: `20260901180000` amplía el catálogo con
  `activation_mode`, `passive_conversion_spell_ids` y
  `activation_game_build`. Los defaults legacy no inventan conversiones; el
  prompt v8 por clase debe investigarlas para el build actual.

## Bloque C — Corrección histórica

### Objetivo

Recalcular por pull los estados en muerte y pressure windows usando el kit
efectivo, cargas y recharge del build histórico. Mantener el patrón de una
invocación por pull, trazabilidad y dual-read mientras Fiabilidad siga en v1.

### En curso

- [x] Crear state engine puro para cooldown efectivo y recarga secuencial de
      cargas.
- [x] Excluir external/utility sin target propio de las opciones personales.
- [x] Hacer que datos `fallback/uncertain` no produzcan `coverable=true`.
- [x] Detectar secuencias de casts incompatibles con el modelo garantizado y
      devolver `unknown` en vez de inventar CDR dinámico.
- [x] Crear materializaciones paralelas
      `death_defensive_options_v2`/`defensive_pressure_windows_v2` con
      `resolver_version` y `evaluated_at`.
- [x] Integrar nuevos imports y backfill en `reanalyze-defensive-pressure`, una
      sola invocación por pull y conservando `pulls.updated_at`.
- [x] Integrar la misma materialización en nuevos imports de `analyze-report`.
- [ ] Aplicar migraciones y ejecutar backfill controlado en datos reales.
- [ ] Validar Fade y varios casos representativos de cada clase contra WCL.
- [x] Añadir estado persistente de cola para backfills de 100+ pulls sin
      agrupar varios pulls dentro de una misma invocación Edge.
- [x] Hacer reclamación idempotente, lease recuperable, tres intentos y
      progreso por batch; conservar fallback visible si el alta de cola falla.
- [x] Reanudar automáticamente jobs pendientes/error al volver a abrir la
      gestión del catálogo y serializar ediciones concurrentes en el cliente.
- [x] Añadir backfill controlado de 5–10 pulls por boss/dificultad, reutilizando
      batch, mostrando progreso y auditando casos dirigidos antes de escalar.

### Revisión del bloque

- 7/7 tests del state engine y 4/4 de la cola pasan; junto al resolver son
  34/34 pruebas v2.
- Casos cubiertos: Fade 20 s, cooldown libre/en cooldown, dos cargas con recarga
  secuencial, efecto activo, CDR dinámico no modelado, external excluido y
  confidence incierta sin falsa oportunidad.
- El sensor y los JSON legacy se conservan sin cambios. Las columnas v2 copian
  timings/mecánica de la ventana, pero recalculan exclusivamente su estado de
  cobertura con el resolver/state engine.
- Inconsistencia corregida: el catálogo base ya no parte siempre de confidence
  `verified`; hereda la confianza del game build. Un histórico sin versión
  exacta queda `uncertain` aunque el valor base pueda mostrarse.
- No se ha ejecutado contra Supabase: falta validar constraints y rendimiento
  con datos reales antes de cerrar el bloque.
- La cola persiste `batch` y una fila por pull mediante una RPC transaccional.
  Los jobs se reclaman con compare-and-set, una respuesta de job ya `done` es
  idempotente y un `running` abandonado vuelve a `queued` tras 15 minutos.
- Edición manual, restablecimiento de clase y clasificación IA crean la misma
  cola. Si falla el descubrimiento de pulls o la persistencia, la respuesta lo
  expone y la UI avisa que solo queda disponible el fallback de la pestaña.
- La consolidación visual añade un sample explícito desde Preparación. Excluye
  ninja pulls, procesa una invocación por pull y clasifica Fade/base/cargas/
  external/build desconocido como passed, failed o not_observed.
- El sample local está implementado y probado, pero el checkbox de backfill
  real permanece abierto hasta desplegarlo y contrastar 5–10 pulls con WCL.
- Inconsistencia corregida durante la revisión: `save-defensive-edit` contenía
  dos bytes NUL literales como separador de arrays. Se sustituyeron por la
  secuencia fuente `\u0000`, evitando que herramientas Git/bundlers lo traten
  como fichero binario sin cambiar la comparación en runtime.
- `npm run build`: correcto; solo warnings de budgets ya presentes.
- Las siete Edge Functions afectadas compilan con esbuild, incluidos todos los
  imports nuevos. Los artefactos temporales de esa comprobación se eliminaron.
- Suite completa: 117/118. Sigue fallando solo el baseline
  `src/app/app.spec.ts:24` por buscar `.brand`; las 34 pruebas v2 pasan.
- Orden de despliegue del trabajo acumulado: aplicar las cinco migraciones
  `20260831200000`, `20260831210000`, `20260831220000`, `20260831230000` y
  `20260901080000` antes de desplegar las Edge Functions nuevas/modificadas.

## Bloque D — Ocurrencias de mecánica

### Objetivo

Dejar de mezclar todos los casts repetidos de una ability en una sola mediana:
ordenar los casts dentro de cada fight y agregar #1 con #1, #2 con #2, etc.
entre referencias world. El template actual por spec permanece intacto.

### En curso

- [x] Crear `boss_mechanic_occurrence_profile` con clave
      boss/dificultad/ability/occurrence, mediana, p10/p90, muestras y número
      de fights que observaron esa ocurrencia.
- [x] Implementar reconstrucción pura por fight, deduplicando aliases con el
      mismo timestamp y sin inventar muestras cuando una #N no aparece.
- [x] Hacer dual-write desde `sync-mechanic-defensive-profile`: conservar el
      array legacy y escribir perfiles por ocurrencia en paralelo.
- [x] Exponer tipo/servicio de lectura y mostrar en el resumen del sync cuántas
      filas de ocurrencia se actualizaron.
- [ ] Aplicar la migración y resincronizar bosses relevantes.
- [ ] Contrastar #1..#N, p10/p90 y fights de distinta duración contra WCL real.
- [ ] Investigar fase y solapes antes de rellenar `phase_id` o scores de
      overlap; permanecen nullable para no inventar semántica.

### Revisión del bloque

- 4/4 tests de ocurrencias pasan: orden/deduplicación en un fight, casts
  simultáneos de enemigos distintos, alineado de fights con distinta cantidad
  de casts y percentiles deterministas.
- Una occurrence #3 vista en un solo fight conserva `sample_fight_count=1`; no
  se rellena con el timing de #2 de fights más cortos.
- El perfil world nuevo no consume pulls propios y no toca la futura evidencia
  local. `mechanic_defensive_assignments` sigue sin `occurrence_index` porque
  continúa siendo un template reutilizable por spec.
- Compatibilidad de rollout: el frontend acepta temporalmente una respuesta del
  sync legacy sin `occurrenceProfilesUpdated` y muestra cero.
- `npm run build`: correcto. El Edge Function de sync compila con esbuild.
- Suite completa acumulada: 121/122; el único fallo sigue siendo el test de
  baseline `src/app/app.spec.ts:24` (`.brand`). Las 38 pruebas v2 pasan.
- Despliegue adicional: `20260901090000_mechanic_occurrence_profiles.sql` debe
  aplicarse después de las cinco migraciones de A–C y antes del sync modificado.

## Bloque E — Evidencia local separada

### Objetivo

Construir señal propia de la guild sin introducir muestras locales en el perfil
world. Exponer al planning impacto de raid, letalidad individual, muertes,
near-deaths, pressure windows, prioridad y provenance de ambas fuentes.

### Implementado

- [x] Crear `boss_mechanic_defensive_local_profile` con clave
      boss/dificultad/ability, contadores y muestras exclusivamente locales.
- [x] Reconstruir de forma idempotente desde pulls propios no ninja, respetando
      el cutoff del wipe call tanto para eventos como para muertes y ventanas.
- [x] Excluir del agregado las muertes del cluster de wipe y el melee de boss
      sobre no-tank ya marcado como exclusión estadística.
- [x] Incorporar `max_hit_points` a imports nuevos para poder expresar el daño
      como porcentaje de vida sin reinterpretar históricos que no lo tengan.
- [x] Calcular por separado `local_raid_impact_score` y
      `local_individual_lethality_score`, con ranking determinista 1–5.
- [x] Crear `boss_mechanic_defensive_planning_view`: conserva world/local en
      columnas distintas, añade prioridad combinada y explica su fuente.
- [x] Añadir contratos y servicios Angular, endpoint de sync y ejecución junto
      al sync world desde Preparación.
- [x] Extraer parsing/scoring a lógica pura y cubrirlo con pruebas unitarias.
- [ ] Aplicar la migración y contrastar resultados con pulls reales.

### Revisión del bloque

- 3/3 pruebas específicas pasan: nulos no se convierten en ability `0`, las
  señales de impacto/letalidad no se mezclan y los empates son deterministas.
- `npm run build`: correcto; solo warnings de budgets SCSS ya existentes.
- `sync-local-defensive-profile` empaqueta correctamente con esbuild.
- Inconsistencia corregida: `Number(null)` convertía un `mechanicId` ausente en
  cero y podía crear un perfil inválido. El parser ahora rechaza null, vacío,
  booleanos, no enteros y ability IDs no positivos.
- Inconsistencia corregida: Preparación llamaba una señal inexistente
  `selectedDifficulty()`; usa la fuente canónica `selectedDifficultyName()`.
- El estimado local sin mitigar usa hits sin defensivo detectado y queda
  explícitamente separado de las muestras world verificadas; no se presenta
  como un valor contrafactual perfecto.
- Despliegue adicional: `20260901100000_local_defensive_profiles.sql` debe
  aplicarse después del perfil de ocurrencias y antes del endpoint local.

## Bloque F — Esquema de plan desplegado

### Objetivo

Persistir la versión exacta de roster, kits y slots que se despliega; publicar
debe congelar el contenido y cada pull debe conservar el plan vigente cuando
ocurrió, no el más nuevo en la fecha de importación.

### Implementado

- [x] Crear `defensive_plan_versions`, `defensive_plan_members` y
      `defensive_plan_slots` con modos `full/partial/no_plan` y snapshot del
      kit efectivo de cada jugador.
- [x] Bloquear por trigger cualquier mutación o borrado de un plan publicado y
      cualquier cambio de miembros/slots cuando el padre ya no es draft.
- [x] Publicar mediante RPC con lock, validaciones semánticas y fingerprint del
      contenido completo.
- [x] Crear `pull_defensive_plan_binding` y una RPC idempotente que rechaza
      sustituir silenciosamente una versión ya ligada.
- [x] Materializar también el caso `no_plan` con `plan_version_id=null`; un
      override manual exige motivo y deja before/after en tabla de auditoría.
- [x] Añadir `pulls.observed_at`, backfill desde tiempo real de WCL y binding
      automático únicamente si `published_at <= observed_at`.
- [x] Integrar el binding best-effort en imports nuevos sin usar `closed_at`,
      que solo representa cuándo se importó el log.
- [x] Añadir endpoint único de crear draft/publicar/ligar, validación de
      contratos, tipos y servicios Angular de lectura/escritura.
- [x] Impedir publicar drafts que aceptaron kits efectivos del frontend: solo
      un draft re-resuelto por backend puede pasar a `published`.
- [x] Rechazar publicación si cambió la revisión de perfiles, catálogo, reglas
      u overrides desde que se generó el draft.
- [ ] Aplicar la migración y probar transiciones/locks/RLS contra PostgreSQL.

### Revisión del bloque

- 4/4 pruebas de contrato pasan: snapshot válido, jugador ajeno, slot duplicado
  y asignación escondida dentro de un slot `uncovered`.
- `npm run build`: correcto; `manage-defensive-plan` y `analyze-report`
  empaquetan con todos sus imports.
- Inconsistencia corregida: el primer diseño habría usado `closed_at`; un log
  antiguo importado hoy habría recibido el plan actual. `observed_at` se deriva
  de `reports.start_time + fight.startTime` y mantiene la historia estable.
- Inconsistencia corregida: publicar un plan `full` también rechaza slots
  `partial`, no solo los explícitamente `uncovered`.
- Los slots incluyen desde ahora player/target, occurrence, lock/manual,
  reserva de emergencia, confidence y datos de trigger. H/I no tendrán que
  reinterpretar el template legacy para reconstruir qué se desplegó.
- Despliegue adicional: `20260901110000_defensive_plan_deployments.sql` debe
  preceder a `manage-defensive-plan` y al `analyze-report` modificado.

## Bloque G — Solver global determinista

### Objetivo

Elegir una secuencia factible para todo el encounter, preservando reservas
anteriores y futuras, cooldown/recharge/cargas, locks, reglas de emergency,
roles/grupos, targets y margen temporal. La cascada greedy queda solo como
fallback explícito.

### Implementado

- [x] Crear `defensive-plan-solver@2.0.0` puro con búsqueda global acotada y
      desempates estables por tiempo/spell/player.
- [x] Precargar todas las reservas hard/locked antes de optimizar, de modo que
      un uso temprano solo entra si recupera antes de cualquier reserva futura.
- [x] Simular cargas y recharge secuencial con margen conservador p10/p90.
- [x] Aplicar objetivo lexicográfico: required, letalidad individual, impacto
      de raid ponderado, confianza, coste de oportunidad y extras seguros.
- [x] Respetar role/group, eligibility y semántica de target; external sin
      source/target fiable y utility no entran como personal.
- [x] Reservar survival type `emergency` salvo slot marcado emergency-eligible
      o reserva humana hard.
- [x] Al superar el presupuesto determinista, ejecutar greedy y persistir
      `planning_quality=fallback_greedy`, `source=fallback` y
      `strictScoringEligible=false`.
- [x] Crear `generate-defensive-plan`: carga roster/builds, vuelve a resolver
      kits en backend, expande occurrence profiles, incorpora templates como
      preferencias, ejecuta solver y persiste un draft autocontenido.
- [x] Hacer que la cronología de Preparación consuma slots/snapshots del plan
      más reciente cuando existe; el cálculo legacy queda solo como fallback.
- [x] Conectar la acción de Preparación al generador backend para todo el
      roster; antes la vista Jugador solo filtraba y nunca creaba el plan.
- [x] Añadir selección de recursos por jugador: personales elegibles por
      defecto, semi/external solo con opt-in y utility/pasivas nunca asignables.
- [x] Excluir semi/external de oportunidades automáticas en modo `no_plan`;
      un semi solo entra al evaluator si un slot publicado lo seleccionó.
- [x] Permitir que un external de raid cubra demanda raid sin fingir que es un
      personal; los externals de aliado siguen siendo target-aware.
- [x] Alimentar la tabla principal y el aviso de huecos con slots v2 cuando
      existe draft/plan, separando visualmente los templates legacy.
- [ ] Ejecutar un draft real con roster de raid seleccionado y revisar su
      resultado completo antes de publicar.

### Revisión del bloque

- 9/9 pruebas del solver pasan, incluidas literalmente las regresiones del
  documento: 120 s a 1:30 antes de reserva 4:00; 20 s no usable a 2:30 antes
  de 2:42; máximo 2 de 3 ventanas con CD 60 s; dos cargas; lock; emergency;
  incertidumbre; tie-break; fallback.
- Las 16 pruebas específicas E–G pasan juntas. Build Angular correcto y las
  tres Edge Functions implicadas empaquetan con todos sus imports.
- Inconsistencia corregida en F durante esta revisión: el binding original no
  representaba `no_plan` y el override manual no guardaba motivo. El schema
  ahora cubre ambos casos y registra auditoría.
- Inconsistencia corregida en F durante esta revisión: el binding se intentaba
  antes de persistir `game_build` de los miembros. Se movió después de
  `player_pull_records`, para que la compatibilidad del plan sea verificable.
- Inconsistencia corregida: penalizar el cooldown absoluto habría hecho que
  "no asignar" ganase a cualquier extra. El coste de oportunidad mide solo el
  exceso respecto al recurso más corto capaz de cubrir el mismo slot.
- Un draft con kits enviados directamente por cliente puede guardarse para
  inspección manual, pero `publish_defensive_plan` lo rechaza. El camino
  publicable es `generate-defensive-plan`, que resuelve en backend.
- Readiness sondea también `generate-defensive-plan`; la capacidad de plan no
  se marca lista si solo está el schema. La publicación y el export quedan
  visibles en Jugador, pero siguen sujetos a los guards de cobertura/stale.

## Bloque H — Export MRT v2

### Objetivo

Generar reminders desde la misma entidad que validó el solver: slots concretos
de una versión publicada, con jugador específico y trigger seguro por
ocurrencia. No reconstruir el plan desde templates al exportar.

### Implementado

- [x] Crear un exportador cuyo contrato solo acepta plan, miembros y slots
      desplegados; no recibe `mechanic_defensive_assignments`.
- [x] Exportar cada slot con `players: [playerName]` y UID estable derivado de
      `planVersionId + slotId`, evitando duplicados entre reexports.
- [x] Incluir occurrence index en nombre y ordenar de forma determinista por
      tiempo/ability/occurrence/slot.
- [x] Extender el codec MRT con el campo real `counter` del trigger BW_TIMER.
- [x] Emitir bossmod por ocurrencia solo si spell y counter están presentes y
      `bossmod_counter_verified=true`.
- [x] Degradar cualquier bossmod no verificado a trigger de tiempo de pull y
      mostrar los slots degradados en el modal.
- [x] Integrar Preparación: si hay versión publicada, el botón MRT usa
      exclusivamente sus slots; el template legacy solo existe sin deployed
      plan.
- [x] Conservar en el texto del reminder los grupos 1–8 del slot publicado;
      MRT no filtra por grupo, pero el dato informativo no se pierde.
- [x] Añadir `MRT del jugador`: filtra el miembro exacto del plan publicado y
      no exporta a todos los jugadores de la misma clase/spec.
- [x] Impedir que un draft nuevo conviva con una exportación silenciosa del
      plan publicado anterior; primero debe publicarse o descartarse el draft.
- [ ] Importar en el addon real un export v2 con counter y otro degradado a
      tiempo para cerrar la validación empírica.

### Revisión del bloque

- 5/5 pruebas nuevas de deployed MRT pasan: player exacto, UID versionado,
  counter verificado, fallback temporal, grupos y exclusión de slots uncovered.
- Junto con solver y evaluator pasan 25/25 pruebas; build Angular correcto.
- Inconsistencia corregida: el codec conocía la posición `counter` del payload
  pero la rellenaba siempre vacía y tampoco la decodificaba.
- Inconsistencia evitada: un slot marcado `bossmod` por el template no se toma
  como prueba de que `#N` funciona. Sin verificación explícita, el export usa la
  mediana occurrence-specific como tiempo de pull.
- Inconsistencia corregida al repasar H antes de I: el camino legacy añadía
  `[Grupo/s ...]` al mensaje, pero el export desplegado omitía
  `assigned_groups`. El contrato, el mapping y la prueba ya lo conservan.
- La falta de reminders observada en Sszorak no se da por cerrada con tests:
  el siguiente gate exige importar una nota v2 publicada en MRT real y probar
  al menos un trigger de tiempo y un bossmod/counter verificado. Hasta entonces
  cualquier counter no verificado se degrada a tiempo de pull.

## Bloque I — Evaluator post-pull

### Objetivo

Convertir plan desplegado, kit efectivo, casts target-aware, pressure windows y
muerte en decisiones explicables. El estado local `available_unused` sigue
siendo solo sensor: una oportunidad requiere un replay contrafactual que
preserve todas las reservas futuras superiores.

### Implementado

- [x] Crear `player_pull_defensive_evaluations` con una fila por pull/jugador,
      versión exacta de plan/build/resolver/solver/evaluator, agregados y
      `events` explicables.
- [x] Implementar `defensive-execution-evaluator@2.0.0` puro reutilizando el
      state engine de cargas/recharge y la factibilidad conservadora del solver.
- [x] Producir los diez estados semánticos requeridos con reason codes estables,
      separando `coverageOutcome` de `adherenceOutcome`.
- [x] Clasificar cast planificado, sustitución, hold correcto, extra seguro,
      oportunidad extra, reserva rota, reminder omitido, muerte con alternativa,
      ausencia de secuencia y datos inciertos.
- [x] Exigir contrafactual global para `missed_extra_opportunity`; un cooldown
      localmente libre que rompería una reserva superior es `correct_hold`.
- [x] Evolucionar `defensive_casts` de forma compatible: conserva
      `timestampsMs` y añade eventos con `timestampMs`, `targetActorId` y
      `targetName` en imports y reanálisis.
- [x] Excluir de self-coverage los external/hybrid lanzados a otro target; si
      falta target fiable el resultado es `uncertain_data`, nunca penalización.
- [x] Hacer que build/reglas inciertos y planes fallback/manual no produzcan
      estados punitivos estrictos.
- [x] Crear `evaluate-defensive-execution`, protegido por `requireOfficer`, y
      un orquestador idempotente que carga el binding/plan/snapshot original y
      hace upsert por pull+jugador.
- [x] Ejecutar la evaluación best-effort tras imports nuevos y tras cada
      reanálisis; el rollout aditivo no bloquea imports si M8 aún no existe.
- [x] Exponer contratos de dominio y llamada Angular para los consumidores de
      J/K sin hacer scoring en componentes.
- [ ] Aplicar M8 y contrastar evaluaciones contra pulls WCL con full, partial y
      no-plan, incluidos external defensives reales.

### Revisión del bloque

- 11/11 pruebas del evaluator pasan. Cubren literalmente los casos del
  documento: cast previsto, sustitución, hold a 10 s, cast temprano, reminder
  omitido, extra factible, no-feasible, target externo incorrecto, confidence
  incierta y solver fallback no punitivo.
- Solver + MRT desplegado + evaluator pasan juntos 25/25; `npm run build`
  correcto, con solo los warnings de budgets ya existentes.
- `evaluate-defensive-execution`, `analyze-report` y
  `reanalyze-defensive-pressure` empaquetan con esbuild y todos sus imports.
- Inconsistencia corregida: `targetPlayerKey=null` (target conocido fuera del
  roster) no se trata como target ausente; solo `undefined` legacy permite la
  semántica implícita de un personal propio.
- Inconsistencia corregida: un plan `fallback_greedy` o `manual` conserva
  diagnóstico visible, pero sus reservas no pueden convertirse en castigo
  estricto. Se materializa `uncertain_data` hasta disponer de plan óptimo.
- Inconsistencia corregida: M8 no obliga a que `mode=no_plan` tenga siempre
  `plan_version_id=null`; F permite publicar una versión explícita no-plan y el
  evaluator conserva ese binding exacto.
- `management_score` permanece deliberadamente null en I. La fórmula y los
  pesos centralizados se implementan en K; el replay ya persiste las decisiones
  compatibles que formarán numerador y denominador.
- No se ha ejecutado PostgreSQL/Supabase ni se han contrastado targets contra
  WCL real en este entorno. M8 debe preceder a las tres funciones afectadas.
- Inconsistencia corregida al preparar J: los slots, ventanas, casts y muertes
  posteriores al wipe call quedan fuera del replay; un ninja pull elimina su
  materialización derivada en vez de contaminar KPIs.

## Bloque J — Infografía / sección 04

### Objetivo

Cambiar la misión visual de “cobertura local” a gestión defensiva respecto al
plan o, sin plan, al uso óptimo factible. Mantener el sensor legacy disponible,
pero no mezclar sus `coverable` con decisiones v2.

### Implementado

- [x] Leer `player_pull_defensive_evaluations` en el resumen nocturno mediante
      dual-read: tabla ausente, fila ausente o confidence no fiable conservan
      el resumen legacy sin romper el dosier.
- [x] Exigir backfill completo de todos los pulls evaluables de la noche y una
      única versión de evaluator; no se mezclan KPIs v1/v2 dentro de la vista.
- [x] Agregar plan ejecutado, cobertura crítica factible, holds correctos,
      reservas rotas, extras seguros y muertes con CD viable.
- [x] Priorizar un máximo de cinco decisiones explicables, enriquecidas con
      pull/boss/hora, mecánica y nombres de defensivos.
- [x] Rediseñar la tarjeta hero como `GESTIÓN DEFENSIVA`; durante calibración
      muestra el ratio principal y KPIs sin fingir un `management_score` único.
- [x] Rediseñar `04 · GESTIÓN DE DEFENSIVOS` con el copy específico de plan y
      el modo `uso óptimo factible` cuando no había nota publicada.
- [x] Mantener toda la presentación legacy detrás del fallback, etiquetándola
      explícitamente como `LEGACY · COBERTURA DEFENSIVA` y aclarando que
      `coverable` no es un veredicto v2.
- [x] Añadir los cinco feature flags del rollout. `defensiveInfographicV2`
      queda apagado por defecto hasta backfill/contraste; un tester puede
      sobreescribirlo localmente sin cambiar el entorno.
- [x] Subir el caché de dosier a v10 para que resúmenes v9 no oculten el nuevo
      campo `defensiveManagementV2`.
- [ ] Activar el flag en un entorno con M8 aplicada, revisar el layout con
      capturas reales y validar el PNG/Discord completo.

### Revisión del bloque

- 3/3 pruebas del agregador pasan: fallback si falta un pull, rechazo de
  confidence/versiones incompatibles y agregación/prioridad determinista.
- Evaluator + agregador pasan juntos 14/14; el build Angular sigue correcto.
- Inconsistencia evitada: una noche parcialmente backfilled no combina ratios
  v2 con tarjetas legacy. Todo el bloque usa v2 o todo el bloque cae a legacy.
- Inconsistencia corregida: el cache fingerprint global no cambia solo porque
  aparezca una columna de summary; el bump v10 evita servir la forma v9.
- El flag visual permanece desactivado: J está listo para R5, pero no se activa
  de forma punitiva antes de aplicar M8 y revisar una muestra real.

## Bloque K — Fiabilidad v2

### Objetivo

Incorporar la gestión defensiva semántica al eje Defensiva sin modificar de
inicio `AXIS_WEIGHTS`, conservando la fórmula legacy como comparación y fallback
por pull hasta disponer de evaluación fiable y backfill.

### Implementado

- [x] Centralizar los pesos de decisión: required 4, reserva rota 5, muerte con
      cooldown viable 5 y recommended/extra 1; optional, hold correcto,
      no-feasible y uncertain no entran en el denominador.
- [x] Persistir `management_score` desde el evaluator y versionarlo como
      `defensive-execution-evaluator@2.2.0`.
- [x] Añadir a `player_pull_reliability_inputs` las ocho columnas v2 pedidas,
      manteniendo todas las columnas legacy y la seguridad `security_invoker`.
- [x] Exigir por fila score, conteos coherentes, confidence `verified/inferred`
      y versión de evaluator antes de considerar v2 backfilled.
- [x] Exigir también `effective-defensives@2.1.0`: un evaluator vigente no
      vuelve válida una fila calculada con semántica antigua de disponibilidad.
- [x] Seleccionar la fuente de forma atómica por pull: v2 fiable o la fórmula
      legacy completa, nunca componentes de ambas en la misma fila.
- [x] Calcular un shadow compare v1/v2 sobre exactamente los mismos pulls,
      incluyendo delta, tamaño de muestra y versiones observadas.
- [x] Aplicar `defensiveReliabilityV2` en roster, dosier, tendencias semanales y
      evolución por boss/dificultad. Permanece apagado por defecto.
- [x] Mantener `AXIS_WEIGHTS` sin cambios; Defensiva continúa pesando 0.3.
- [ ] Calibrar pesos/umbrales con pulls oficiales backfilled y activar el flag
      únicamente después de aceptar sus deltas v1/v2.

### Revisión del bloque

- 40/40 pruebas focalizadas pasan: fórmula central, evaluator completo y suite
  histórica de Fiabilidad, incluidos flag apagado, v2 fiable y fallback por
  fila incompleta/uncertain.
- Build Angular correcto y las tres Edge Functions afectadas empaquetan con
  esbuild sin errores.
- Inconsistencia evitada: una evaluación parcial no convierte nulls en ceros ni
  combina la muerte legacy con el score v2 del mismo pull.
- Inconsistencia corregida: `management_score` ya no es un placeholder null; se
  deriva de los reason codes persistidos y la misma fórmula testeada.
- La migración es aditiva para consumidores: la vista pública conserva el
  contrato anterior y agrega las columnas v2 al final. La subvista legacy queda
  interna y protegida para permitir la retirada gradual de L.
- Tras desplegar 2.1, readiness puede mostrar temporalmente un backfill menor
  (incluso 0) aunque las filas 2.0 sigan físicamente presentes. Es intencionado:
  solo vuelven a contar cuando se reanalizan con el resolver actual.

## Registro cronológico

### 2026-08-31 — Inicio

- Leído el documento completo y convertido a un orden de entrega trazable.
- Verificada la rama y el commit de baseline.
- Auditadas las fuentes principales de catálogo, talentos, análisis,
  reanálisis, pressure windows, Preparación, MRT y Fiabilidad.
- Implementado y revisado el Bloque A. No cambia todavía el scoring ni la UI.
- Implementado y revisado el Bloque B completo: resolver, adaptador único de
  filas, endpoint, contrato Angular, shadow en analyze/reanalyze y pruebas.
- Iniciado el Bloque C: state engine y materialización v2 paralela implementados;
  pendiente backfill y contraste real multiclase.

### 2026-09-01 — Continuación del bloque C

- Añadida la migración de cola durable con batches, jobs, RLS de oficiales y
  RPC transaccional para no perder un backfill al cerrar el navegador.
- Integrados el alta de jobs en los tres caminos que invalidan históricos y el
  procesamiento de un solo pull por invocación con claim idempotente.
- Añadida recuperación de leases de 15 minutos, máximo de tres intentos,
  progreso/fallo por batch y reanudación desde la pantalla de catálogo.
- Revisadas carreras entre pestañas y ediciones simultáneas: el claim SQL
  decide un único ejecutor y el cliente evita programar dos veces el mismo job.
- Los errores al descubrir pulls ya no se convierten silenciosamente en una
  lista vacía; llegan a la UI como advertencia después de guardar el cambio.
- Corregido el byte NUL preexistente detectado al revisar el diff de
  `save-defensive-edit`.
- La consolidación visual añadió un health contract a la cola (`healthy`,
  `running`, `failed`; `unreachable` en cliente), detalle persistente y retry
  manual sobre el mismo batch, sin recrear jobs ya completados.
- Inconsistencia corregida durante la consolidación: una lease expirada
  reencolaba el job pero dejaba el batch con status anterior. Ambos vuelven
  ahora coherentemente a `queued`.
- Inconsistencia corregida durante la consolidación: un reanálisis exitoso con
  cero player rows no tocaba `pulls.updated_at`. La invalidación es ahora
  obligatoria antes de marcar el job como `done`.
- Validación local: build correcto, 34/34 tests A–C, siete Edge Functions
  empaquetadas y suite completa 117/118 con el único fallo de baseline conocido.
- Pendiente para cerrar C: aplicar migraciones en el entorno de destino, lanzar
  un backfill controlado y contrastar Fade + casos multiclase contra WCL.
- Iniciado el bloque D con schema de ocurrencias, reconstrucción #1..#N por
  fight y dual-write desde el sync world; falta resync/contraste en datos reales.
- La revisión de D separa aliases del mismo caster de dos enemigos que lanzan
  simultáneamente; el segundo caso conserva dos ocurrencias reales.

### 2026-09-01 — Bloques E–I

- Completados evidencia local, plan desplegado, solver global, export MRT v2 y
  evaluator post-pull, manteniendo dual-read y rollout aditivo.
- Repasado H: recuperado el prefijo de grupos también desde slots publicados.
- Añadida M8 y el replay post-pull target-aware, invocado por import,
  reanálisis y endpoint dedicado.
- Validación local del cierre I: build correcto, tres Edge Functions
  empaquetadas y 25/25 pruebas conjuntas de solver/MRT/evaluator.
- El bloque J añadió la sección visual 04 y el bloque K conectó la puntuación y
  el shadow de Fiabilidad. La nueva especificación visual pausa L: antes hay
  que consolidar los pasos 1–12 y superar su gate E2E sin borrar compatibilidad.

### 2026-09-01 — Bloques J–K

- Completada la agregación nocturna v2 y la sección visual 04 con fallback
  atómico y feature flag apagado hasta revisión real.
- Añadida la fórmula central de management score, las columnas v2 de la vista,
  el dual-read por fila y el shadow compare v1/v2.
- Verificación local de K: 40/40 pruebas focalizadas, build Angular y bundles de
  evaluate/analyze/reanalyze correctos.
- Pendiente externo: aplicar M8/M9, backfill, calibrar deltas oficiales y solo
  entonces activar `defensiveInfographicV2`/`defensiveReliabilityV2`.

### 2026-09-01 — Inicio de consolidación técnico-visual

- Leída íntegramente `IRIS_Defensivos_v2_Especificacion_Visual.docx`.
- Creado `iris-defensivos-v2-consolidation-progress.md` como registro común de
  los 12 pasos, sus fuentes de verdad y los 25 escenarios de aceptación.
- L queda bloqueado antes de cualquier borrado. Los ajustes preparatorios no
  destructivos ya presentes se auditarán dentro de la consolidación y los
  flags deben seguir permitiendo volver al flujo legacy íntegro.
- Iniciado el paso 1: la cola durable existente cumple persistencia y una
  invocación por pull, pero aún necesita health contract, estados explícitos,
  detalle y reintento visibles.
- Cerrado localmente el paso 1: banner persistente, health/detail/retry, polling
  de ejecuciones activas y recuperación de leases coherente. Validación: 7/7
  pruebas focalizadas, build Angular y bundles de queue/reanalyze correctos.
- Cerrado localmente el paso 2: endpoint de readiness para resolver, planes
  M7, evaluator M8, vista M9 y cobertura de backfill; panel compacto en
  Preparación y gate explícito de capacidades.
- La lectura de `defensive_plan_versions` queda deshabilitada si el diagnóstico
  no confirma M7. El template legacy por spec continúa operativo y visible,
  pero no se representa un plan v2 inexistente como una lista vacía válida.
- El backfill se considera materializado incluso si una evaluación no tiene
  decisiones puntuables; `management_score=null` ya no se confunde con schema
  o evaluator ausente. Validación: 3/3 tests específicos, build y dos bundles.
- Preparado el paso 3: muestra de 5–10 pulls, progreso/reintento durable e
  informe de cinco casos sensibles. 3/3 tests del auditor y bundle correctos;
  no se cierra C porque aún falta ejecutarlo contra Supabase/WCL real.
- Consolidado localmente el selector de Preparación Spec/Jugador. Spec queda
  como template base explícito; Jugador usa `player_latest_build` + resolver
  backend y solo filtra visualmente los slots del plan global.
- Añadidos estados de build y detección de fingerprint cambiado tras borrador.
  Sin plan v2, Jugador no ejecuta la cascada local basada en cooldown base.
- Revisión del selector: 2/2 tests de frescura, protección contra respuestas
  tardías entre jugadores y build Angular correcto.
- Implementado el núcleo visual del paso 5 de consolidación: tarjetas del kit
  efectivo, comparación base/automático, cargas/recharge/target e inspector de
  provenance sin cálculos de talentos en Angular.
- Añadida M10 y `manage-player-defensive-override`: el override exige scope
  exacto jugador + hechizo + `game_build` + fingerprint, motivo y doble
  confirmación; guarda historial before/after y nunca reanaliza el histórico
  automáticamente. Restablecer lo desactiva sin borrar.
- Corregida una incompatibilidad con la nueva especificación: los overrides
  legacy con fingerprint null permanecen para auditoría/rollback, pero el
  resolver v2 ya no los aplica.
- Readiness comprueba también M10 y el endpoint de override, pero aísla esa
  capacidad para no bloquear plan/evaluator/muestra si sus propias dependencias
  están listas. Los errores de schema y el motivo del botón de muestra
  deshabilitado quedan visibles.
- Validación del bloque: build Angular, 29/29 pruebas focalizadas y bundles de
  resolver/readiness/override correctos. Sigue pendiente la corrección solo de
  snapshot cuando no hay fingerprint fiable y la validación contra Supabase.
- Prueba remota de readiness: corregido el uso de `HEAD`, que ocultaba el cuerpo
  de los errores PostgREST y producía "Error de schema sin detalle". Las sondas
  usan ahora `GET limit 1`, y la de reglas valida el nombre real
  `target_spell_id` en vez de `spell_id`. Requiere redesplegar únicamente
  `defensive-v2-readiness` para obtener el diagnóstico corregido.
- El historial remoto marcaba M1 como aplicada aunque faltaba
  `cooldown_catalog.targeting_mode`, señal de que el archivo local evolucionó
  después de registrar ese timestamp. Se corrige sin reescribir historial con
  `20260901160000_repair_cooldown_catalog_targeting_mode.sql`: DDL aditivo,
  backfill conservador y reload de PostgREST; no borra datos ni inicia L.

### 2026-09-01 — Consolidación de disponibilidad y flujo Preparación → MRT

- El prompt defensivo pasa a v8 y se limita por clase con JSON compacto. Pide
  categoría/target coherentes, perfiles por spec, modifiers por build y
  conversiones de activa a pasiva.
- Añadida migración `20260901180000_defensive_activation_semantics.sql` y
  resolver `effective-defensives@2.1.0`; una habilidad pasiva o cuya conversión
  no puede resolverse con certeza queda fuera del plan por seguridad.
- Añadida edición manual de categoría/target y metadatos compactos en las
  cards. Los recursos personales parten seleccionados y semi/external son
  opt-in excepcionales.
- Conectados el generador global, publicación y MRT exacto por jugador. La
  tabla de mecánicas consume slots v2 cuando existen y deja los templates
  legacy identificados como tales.
- La auditoría Fade distingue presencia base y modifier 30→20; deja de afirmar
  falsamente que el jugador no conoce Fade.
- Fiabilidad y readiness exigen evaluator 2.2 + resolver 2.1, por lo que el
  backfill anterior debe revalidarse antes de activar scoring.
- Comprobaciones: build Angular correcto, diez Edge Functions empaquetadas y
  180/181 tests; el único fallo es el baseline conocido de `.brand` en
  `src/app/app.spec.ts:24`, ajeno a defensivos.

### 2026-09-02 — Generación individual desde Preparación

- La vista Por jugador mantiene el generador global y añade `Generar borrador
  individual` para el jugador seleccionado.
- El borrador individual envía únicamente ese member y sus recursos opt-in al
  solver, se guarda como `plan_mode = partial` y conserva snapshots/provenance
  backend igual que el global.
- Los slots que el kit individual no cubre siguen visibles y diagnosticados,
  pero no activan la restricción de publicación de un plan `full`. El botón de
  publicación identifica claramente si el draft activo es parcial o global.
- La UI muestra nombre y modo del plan activo en la tabla y la cronología.
  Validación local: build correcto y suite completa 38 archivos/236 pruebas,
  incluyendo regresiones de draft parcial con ventanas obligatorias sin cubrir.

## Pendientes transversales

- Determinar y persistir el `game_build` real de WCL sin inferirlo a partir del
  build actual durante un reanálisis histórico.
- Aplicar M8 y reanalizar históricos para poblar los eventos target-aware; los
  timestamps legacy siguen disponibles, pero external sin target queda incierto.
- Validar empíricamente el counter de MRT antes de emitir triggers bossmod por
  ocurrencia; mientras tanto se deberá degradar a tiempo de pull.
- Calibrar y activar los flags visual/de Fiabilidad tras el backfill oficial;
  los cinco flags ya están definidos y ambos consumidores punitivos siguen off.
