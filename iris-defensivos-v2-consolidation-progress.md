# IRIS Defensivos v2 — consolidación técnico-visual

Este archivo es el registro común y acumulativo de la consolidación solicitada
por `IRIS_Defensivos_v2_Especificacion_Visual.docx`. Se actualiza al comenzar y
cerrar cada paso. Un paso solo se marca como consolidado cuando su contrato
funcional, visual, de persistencia y de fallback está revisado; la mera
existencia de código parcial no lo cierra.

## Alcance y reglas de esta fase

- Rama de trabajo: `fix/defensive-catalog-discovery-v5`.
- Inicio de la consolidación: 2026-09-01.
- Se mantienen y consolidan los bloques A–K del plan técnico-funcional previo.
- El bloque L (limpieza legacy) queda bloqueado: no se eliminará ningún dato,
  función ni fallback hasta superar la aceptación E2E de esta especificación.
- Ajustes → Defensivos conserva exclusivamente el catálogo base canónico.
- Los modificadores conocidos viven como metadatos backend; Angular no aplica
  aritmética de talentos.
- La vista por spec muestra base/spec y variabilidad, nunca inventa el build de
  un jugador. La vista por jugador resuelve el build realmente observado.
- Un override de CD/duración efectiva es contextual, auditable y acotado a
  jugador + hechizo + `game_build` + fingerprint. Nunca modifica el catálogo.
- Un plan publicado y su snapshot histórico son inmutables.
- Los estados `uncertain`, fallback o sin datos se muestran y nunca penalizan.
- La sección visual 04 consume v2 de forma atómica o cae completa a legacy.

## Estado global de consolidación

| Paso | Entrega | Estado | Brecha principal al iniciar |
| --- | --- | --- | --- |
| 1 | Salud de Edge Functions y cola durable | Implementado y revisado localmente | Falta desplegar y contrastar la recuperación con una cola real. |
| 2 | Readiness de esquema y servicios | Implementado y revisado localmente | Falta desplegar y contrastar el diagnóstico contra el esquema remoto. |
| 3 | Backfill controlado y progreso | En curso · implementación local revisada | Falta ejecutar la muestra real y observar los cinco casos dirigidos. |
| 4 | Preparación: selector Spec/Jugador | Implementado y revisado localmente | Falta validación visual/datos reales tras desplegar readiness y resolver. |
| 5 | Kit efectivo e override contextual | En curso · núcleo local revisado | Tarjetas, inspector y override exacto listos; falta la corrección solo-snapshot cuando no hay fingerprint y validación remota. |
| 6 | Borrador real con solver global | Pendiente | Backend/contrato existen; la UI aún usa AUTO/cascada local en parte del flujo. |
| 7 | Publicación y congelación | Pendiente | Persistencia existe; falta experiencia completa y guards visibles. |
| 8 | MRT desde plan publicado | Parcial | Export v2 existe; falta consolidar el flujo visual y la degradación verificable. |
| 9 | Importación, binding y evaluator | Parcial | Backend v2 existe; falta validar con datos reales y exponer readiness/fallback. |
| 10 | Sección 04 | Parcial | Implementada detrás de flag; falta activación controlada y validación visual real. |
| 11 | Inspector del resolver | Parcial | El kit ya expone la cadena de provenance; falta integrarlo con el recorrido completo de borrador/evaluator. |
| 12 | Aceptación E2E y gate de L | Pendiente | Ningún borrado autorizado hasta completar los 25 escenarios. |

## Fuente de verdad por superficie

| Superficie | Autoridad permitida | No debe hacer |
| --- | --- | --- |
| Ajustes → Defensivos | Catálogo, perfiles por spec y reglas/modificadores | Resolver un jugador o guardar un CD efectivo personal. |
| Preparación · Spec | Catálogo/perfil y template reutilizable | Inferir talentos individuales o presentarse como plan desplegado. |
| Preparación · Jugador | Resolver backend + build observado + override contextual | Calcular modificadores en Angular o reducir el solver al jugador filtrado. |
| Borrador / cronología | Slots, snapshots y readiness devueltos por el plan | Recalcular disponibilidad desde `base_cooldown_ms` si es un draft v2 real. |
| Plan publicado | Snapshot inmutable versionado | Reinterpretarse tras cambios de catálogo/build. |
| MRT | Plan publicado y sus slots | Exportar el template como si fuera el plan final. |
| Evaluator | Binding temporal + snapshot + logs target-aware | Convertir `coverable` legacy en veredicto v2. |
| Dosier / sección 04 | Evaluaciones v2 completas y homogéneas | Mezclar pulls v1/v2 dentro de la misma sección. |
| Fiabilidad | Score/conteos del evaluator bajo flag | Mezclar componentes legacy y v2 en un mismo pull. |

## Gate previo al bloque L

L solo podrá reanudarse cuando se cumplan conjuntamente:

- [ ] Los 25 escenarios E2E de la especificación pasan con datos representativos.
- [ ] Spec, Jugador, dosier e inspector muestran valores coherentes.
- [ ] Borrador, publicación y MRT conservan el mismo plan versionado.
- [ ] Evaluator, sección 04 y Fiabilidad consumen la misma evaluación por pull.
- [ ] No quedan errores silenciosos de cola, endpoint o migración.
- [ ] Apagar los flags devuelve el flujo legacy íntegro y operativo.

## Matriz E2E obligatoria

- [ ] 01. Spec sin jugador muestra Fade base 30 s.
- [ ] 02. Jugador con Fade R2 muestra 20 s y solver/plan usan 20 s.
- [ ] 03. Override contextual a 22 s mantiene el catálogo en 30 s.
- [ ] 04. Un cambio de build invalida override y borrador anteriores.
- [ ] 05. Un hold correcto se reconoce sin penalización.
- [ ] 06. Un uso temprano que rompe reserva se clasifica `plan_broken`.
- [ ] 07. Una asignación no ejecutada se clasifica `reminder_missed`.
- [ ] 08. Una sustitución válida se reconoce como tal.
- [ ] 09. Un extra seguro suma evidencia sin romper el plan.
- [ ] 10. Un extra omitido solo entra como contrafactual cuando era evaluable.
- [ ] 11. Una ocurrencia no factible queda visible y no penaliza.
- [ ] 12. Una muerte con defensivo viable usa el kit histórico correcto.
- [ ] 13. Un external lanzado a otro objetivo no cuenta como personal propio.
- [ ] 14. Target desconocido produce `uncertain`, no veredicto punitivo.
- [ ] 15. Solver y evaluator coinciden con múltiples cargas/recharge.
- [ ] 16. Los solapes parciales respetan locks y reservas.
- [ ] 17. El modo sin plan usa “Uso óptimo factible”.
- [ ] 18. Un plan publicado después del pull no se enlaza retroactivamente.
- [ ] 19. Cambiar el catálogo no muta un plan ya publicado.
- [ ] 20. Un backfill parcial activa fallback legacy completo.
- [ ] 21. Los ninja pulls quedan excluidos.
- [ ] 22. El wipe cutoff excluye eventos posteriores.
- [ ] 23. MRT usa tiempo si el counter de ocurrencia no está verificado.
- [ ] 24. `pulls.updated_at` invalida cachés tras reanálisis.
- [ ] 25. Flags off/on respetan readiness y rollback.

## Paso 1 — Salud de Edge Functions y cola durable

### Objetivo

Hacer observable y recuperable el circuito que guarda cambios y programa un
reanálisis por pull, distinguiendo claramente persistencia, ejecución y fallo.

### Auditoría inicial

- [x] Existe un batch durable con jobs por pull, leases recuperables y máximo de
      tres intentos.
- [x] `reanalyze-defensive-pressure` procesa un único pull por invocación.
- [x] El cliente reanuda jobs `queued`/`error` al volver a la gestión del
      catálogo y serializa su ejecución.
- [x] Los cambios de catálogo distinguen “guardado” de “cola no persistida”.
- [x] Exponer un health/status estable: `healthy`, `running`, `failed` y
      `unreachable`, sin convertir una tabla/migración ausente en éxito.
- [x] Mostrar un banner persistente en Ajustes con progreso, último error,
      detalle y reintento sin recargar.
- [x] Conservar batch/progreso al reintentar y después de cerrar la pestaña.
- [x] Verificar que cada finalización de reanálisis actualiza `pulls.updated_at`.
- [x] Añadir pruebas de contrato y validar la plantilla de estados con el build.

### Implementado

- [x] Ampliado `defensive-reanalysis-queue` con `status` y `retry` además de
      `pending`, manteniendo el guard de oficial y la misma persistencia.
- [x] Definido un contrato único de salud: errores tienen prioridad, después
      trabajo queued/running y finalmente healthy. `unreachable` se decide en
      cliente cuando no puede verificarse el contrato.
- [x] El reintento reutiliza el batch original, conserva jobs completados y
      reencola únicamente los fallidos sin crear trabajo duplicado.
- [x] Una lease caducada reencola el job y devuelve también el batch a
      `queued`, conservando su progreso durable.
- [x] Añadido banner permanente en Ajustes → Defensivos con progreso, detalle
      de batches, último error, reintento y nueva comprobación sin reload.
- [x] La comprobación se ejecuta al abrir el componente; una cola pendiente se
      reanuda sin seleccionar antes una clase y una ejecución ajena se sondea
      hasta completar o recuperar su lease.
- [x] `reanalyze-defensive-pressure` toca `pulls.updated_at` tras todo éxito,
      incluso con cero player rows actualizadas. Si el touch falla, el job ya
      no se marca falsamente como `done`.

### Revisión

- 7/7 pruebas focalizadas pasan: cuatro de persistencia/alta de batch y tres
  del contrato healthy/running/failed, incluida prioridad de error.
- `npm run build`: correcto; solo permanecen warnings de budgets existentes.
- `defensive-reanalysis-queue` y `reanalyze-defensive-pressure` empaquetan con
  esbuild y resuelven todos sus imports.
- Inconsistencia corregida: el health no se deriva del status posiblemente
  atrasado del batch, sino de los jobs no terminados; así un error no parece
  sano y una lease recuperada aparece como trabajo activo.
- Inconsistencia corregida: el polling no intenta reclamar jobs que el mismo
  cliente ya tiene programados, evitando duplicados y bucles de páginas.
- Pendiente externo: desplegar la función y ejecutar cierre/reapertura,
  expiración de lease y reintento sobre un batch real.

## Paso 2 — Readiness de esquema y servicios

### Objetivo

Dar a oficiales/testers un diagnóstico compacto de endpoint, migraciones y
backfill. Una dependencia ausente debe bloquear su capacidad v2 concreta sin
romper ni disfrazar el template legacy por spec.

### Implementado

- [x] Creado `defensive-v2-readiness`, protegido para oficiales, con sondas
      independientes para schema del resolver, M7 planes, M8 evaluator y M9
      vista de Fiabilidad.
- [x] Añadido health real a `resolve-player-defensive-kit`; el cliente combina
      endpoint y schema, por lo que tener solo las tablas no produce un falso
      positivo.
- [x] Medido el backfill sobre la vista autoritativa: versión exacta del
      evaluator y conteos materializados para todas las filas.
- [x] Separada materialización de scoring: una fila con cero decisiones puede
      tener score null y seguir correctamente backfilled; `uncertain` tampoco
      se confunde con “migración ausente”.
- [x] Calculado el gate transitivo de capacidades: Jugador → Plan → Evaluator
      → sección 04/Fiabilidad. Una dependencia intermedia bloquea todo lo que
      realmente depende de ella.
- [x] Añadido panel compacto en Preparación con estado, detalle, migración
      requerida, progreso de backfill y botón de nueva comprobación.
- [x] Añadido health del endpoint de override y sonda M10 independiente. Si
      falta, se bloquea editar overrides, pero no el plan/evaluator ni la
      muestra cuando M1–M8 sí están preparados.
- [x] Los fallos de sonda muestran tabla, columnas esperadas, mensaje, hint y
      código PostgREST. El control de muestra explica visiblemente por qué
      está deshabilitado en lugar de depender solo del tooltip.
- [x] Si el diagnóstico o M7 no están disponibles, Preparación omite la lectura
      de versiones v2 y mantiene el template por spec operativo con un aviso
      explícito; no aparenta haber cargado un plan v2 vacío.

### Revisión

- 4/4 pruebas específicas de readiness pasan: backfill vacío/parcial/completo,
  gates transitivos, aislamiento de M10 y reporting bloqueado durante backfill
  parcial.
- Cola + readiness pasan conjuntamente 10/10.
- `npm run build`: correcto; solo warnings de budgets ya registrados.
- `defensive-v2-readiness` y `resolve-player-defensive-kit` empaquetan con
  esbuild y resuelven todos sus imports.
- Inconsistencia corregida durante el repaso: la primera sonda M7 usaba
  `slot_id`, `defensive_kit_snapshot`, `stale_at` y un nombre plural de binding
  que no forman parte del schema real. Ahora valida exactamente `id`,
  `effective_kit`, `content_fingerprint` y `pull_defensive_plan_binding`.
- Inconsistencia corregida durante el repaso: exigir `management_score` no
  nulo convertía para siempre los casos sin decisión factible en “backfill
  incompleto”. Readiness valida materialización; la puntuabilidad se decide
  después y sigue siendo no punitiva.
- Optimización: las sondas de columnas no solicitan `count=exact`; solo los dos
  conteos necesarios para progreso recorren la vista de Fiabilidad.
- Pendiente externo: desplegar ambos endpoints y comprobar los estados missing,
  partial y ready contra una base con M1–M9 aplicadas progresivamente.

## Paso 3 — Backfill controlado y progreso

### Objetivo

Ejecutar primero una muestra segura de 5–10 pulls conocidos, conservar su
progreso durable y validar casos representativos antes de ampliar el backfill.

### Implementado

- [x] Añadida acción `start_sample` a la cola: toma 5–10 pulls recientes del
      boss/dificultad, excluye `ninja_pull_excluded` y crea un batch durable.
- [x] Si ya existe un sample activo para el mismo contexto, reutiliza el batch
      y sus jobs; no pierde progreso ni duplica los completados.
- [x] Preparación ejecuta los jobs en secuencia, una Edge invocation por pull,
      y permite actualizar el informe o reintentar fallidos sobre el mismo
      batch.
- [x] Añadido progreso visible, identidad de batch y aviso de reanudación.
- [x] Creado un auditor puro y un informe backend para los cinco casos:
      Fade 30→20, base=efectivo, cargas/recharge, external y build desconocido.
- [x] Cada caso distingue `passed`, `failed` y `not_observed`. Una muestra que
      no contiene el caso pide ampliación dirigida; nunca lo da por aprobado.
- [x] Un batch incompleto o con fallos muestra el informe como provisional y
      no puede usarse como aceptación.

### Revisión

- 3/3 pruebas del auditor pasan con Fade, valor sin cambios, dos cargas,
  external indebidamente personal y build desconocido no punitivo.
- Backfill + readiness + cola pasan conjuntamente 13/13.
- `npm run build`: correcto; solo warnings de budgets ya existentes.
- `defensive-reanalysis-queue` empaqueta con esbuild incluyendo selección,
  reanudación e informe del sample.
- Inconsistencia corregida: el informe de external/unknown solo reconocía el
  booleano de ventana. Las opciones de muerte usan `status=available_unused`;
  ahora ambas formas se interpretan con su confidence y un external que se
  cuele como opción personal falla la auditoría.
- Inconsistencia evitada: backfill completo y scoring fiable son conceptos
  separados. Un caso incierto puede estar materializado y seguir siendo
  visible/no punitivo.

### Falta para cerrar el paso

- [ ] Desplegar queue/readiness/resolver y aplicar M1–M9.
- [ ] Ejecutar una muestra real de 5–10 pulls por un boss controlado.
- [ ] Conseguir observación real de los cinco casos; ampliar/escoger pulls si
      alguno aparece como `not_observed`.
- [ ] Contrastar manualmente el informe con WCL y revisar tiempos/targets.

## Paso 4 — Preparación: selector Spec/Jugador

### Objetivo

Separar inequívocamente el template canónico por spec de la vista basada en el
build observado de un jugador, sin reducir el alcance global del solver.

### Implementado

- [x] Añadido control superior `Vista de asignación · Por spec / Por jugador`.
- [x] Spec conserva clase/spec/template, no llama al resolver de jugador y
      explica que sus valores pueden variar por build.
- [x] Renombrado AUTO como `AUTO template`; se declara que no crea un plan
      desplegado ni entra en scoring.
- [x] Creado roster de Preparación combinando `wowaudit_roster` con
      `player_latest_build`; clase/spec observadas ganan sobre configuración.
- [x] Jugador muestra build, fuente, fecha y estado de frescura, y obtiene el
      kit exclusivamente desde `resolve-player-defensive-kit`.
- [x] Definidos estados `fresh_verified`, `inferred`, `stale`, `unknown` y
      `changed_after_draft`. El umbral operacional de stale queda centralizado
      en 14 días, no disperso por componentes.
- [x] Un fingerprint distinto al snapshot del borrador activo muestra
      “Cambió después del borrador”. La publicación se bloqueará en el paso 7.
- [x] En modo Jugador, la cronología filtra slots asignados/dirigidos a esa
      persona; no recalcula ni limita el plan global.
- [x] Sin plan v2, Jugador no cae a la cascada Angular de
      `base_cooldown_ms`; muestra explícitamente que falta un draft global.

### Revisión

- 2/2 pruebas de frescura pasan: requisitos de identidad, verified, inferred,
  stale y unknown para confidence fallback/uncertain.
- `npm run build`: correcto; solo warnings de budgets existentes.
- Inconsistencia corregida: una observación reciente `fallback/uncertain` se
  etiquetaba inicialmente como inferida. Ahora queda `unknown` y visible.
- Carrera corregida: al seleccionar dos jugadores rápidamente, una respuesta
  tardía del primero ya no puede sobrescribir el kit del segundo.
- Inconsistencia corregida: limpiar el selector durante una resolución cancela
  su efecto visual y también apaga el estado de carga anterior.
- Si readiness deja de autorizar Player, la UI vuelve a Spec y no conserva una
  superficie v2 que parezca operativa.
- Pendiente externo: contrastar roster/build/frescura y filtro de slots con un
  draft real; revisar layout responsive mediante navegador en la fase E2E.

## Paso 5 — Kit efectivo e override contextual

### Objetivo

Mostrar el kit que realmente usa el resolver para el jugador y permitir una
corrección humana segura sin mutar el catálogo, reinterpretar planes publicados
ni contaminar otros builds.

### Implementado

- [x] Añadidas tarjetas del kit efectivo con cooldown/duración principales,
      base, delta automático, cargas, recharge, target y confidence.
- [x] Añadido inspector `Ver cálculo` con la cadena completa de provenance y
      modificadores condicionales visibles, sin rehacer aritmética en Angular.
- [x] Endurecido el resolver: solo aplica un override cuando jugador,
      hechizo, `game_build` y fingerprint no nulo coinciden exactamente. Las
      filas legacy sin fingerprint se conservan, pero v2 las ignora.
- [x] Creada M10 con historial inmutable y RPC service-role para crear,
      actualizar o desactivar el override, registrando valor automático,
      before/after, autor, motivo y fecha.
- [x] Creado `manage-player-defensive-override`, protegido para oficiales. El
      backend vuelve a leer build/talentos, recalcula el fingerprint y el kit
      automático y rechaza un contexto stale antes de escribir.
- [x] La edición inline exige motivo y doble confirmación, muestra el scope
      exacto, invalida el borrador activo y declara que no programa reanálisis
      histórico automático.
- [x] Restablecer automático desactiva la fila sin borrarla. Un plan publicado
      continúa usando su snapshot congelado.
- [x] Readiness separa `playerOverride` del resto de capacidades: M10 o su
      endpoint ausentes no se disfrazan con un fallback ni bloquean por sí
      solos el backfill/evaluator.

### Revisión

- 25/25 pruebas de resolver y frescura pasaron antes de ampliar readiness; con
  la matriz final de capacidades, 29/29 pruebas focalizadas pasan.
- `npm run build`: correcto; solo warnings de budgets ya registrados.
- `resolve-player-defensive-kit`, `manage-player-defensive-override` y
  `defensive-v2-readiness` empaquetan con esbuild y resuelven sus imports.
- Inconsistencia corregida: M3 describía el fingerprint null como override
  reutilizable por `game_build`. Eso viola el scope exacto de la especificación;
  M10 conserva esas filas solo para auditoría/rollback y documenta que v2 no
  las consume.
- Inconsistencia evitada: guardar un override no reanaliza históricos ni muta
  un plan publicado; obliga a regenerar el borrador global que quiera usarlo.
- Inconsistencia corregida en readiness: la ausencia de M10 deshabilita solo
  la edición exacta, no capacidades independientes ya preparadas.
- Inconsistencia corregida durante la prueba remota: las sondas de schema
  usaban `HEAD`, que por definición no devuelve el cuerpo JSON de un error de
  PostgREST y dejaba el diagnóstico como `{}`. Ahora usan `GET` limitado a una
  fila, conservando mensaje/código/hint sin contar ni recorrer la tabla.
- Inconsistencia corregida en la siguiente sonda del resolver:
  `defensive_modifier_rules` se identifica por `target_spell_id`, no por una
  columna inexistente `spell_id`.
- Deriva remota confirmada: `20260831200000` aparecía en el historial como
  aplicada, pero `cooldown_catalog.targeting_mode` no existía. Se añadió la
  reparación forward `20260901160000`, aditiva e idempotente, en vez de alterar
  el historial con `migration repair`. Añade constraint, backfill conservador,
  comentario y recarga explícita del schema PostgREST.

### Falta para cerrar el paso

- [ ] Implementar la corrección efímera del snapshot del borrador cuando no
      existe fingerprint fiable; nunca debe persistirse como override reusable.
- [ ] Aplicar M10 y desplegar el endpoint para validar RPC, RLS, auditoría y
      carreras de build contra PostgreSQL/Supabase real.
- [ ] Validar visualmente tarjetas, editor, doble confirmación y estado stale
      con los escenarios E2E 01–04.

## Pasos 6–12

Cada paso tendrá aquí su objetivo, auditoría, implementación, revisión,
comprobaciones y pendientes reales antes de marcarlo como consolidado. El orden
de trabajo será 1 → 12; los pasos parcialmente existentes se revisarán contra
el contrato completo, no se aceptarán por equivalencia aproximada.

## Registro cronológico

### 2026-09-01 — Lectura integral y baseline

- Leído íntegramente `IRIS_Defensivos_v2_Especificacion_Visual.docx` y separado
  su contenido de la petición del usuario.
- Identificados los 12 pasos, las reglas no negociables, la jerarquía visual de
  Preparación, la matriz de fuentes de verdad, el rollout V0–V5 y los 25 casos
  E2E que bloquean la limpieza legacy.
- Pausado el bloque L antes de cualquier borrado. Los cambios preparatorios no
  destructivos ya presentes quedan sujetos a esta consolidación y no equivalen
  a haber iniciado la retirada de compatibilidad.
- Primera brecha confirmada: la cola durable existe, pero falta convertir su
  salud y sus fallos en un contrato operativo visible y reintentable.

### 2026-09-01 — Paso 1 consolidado localmente

- Añadidos health, progreso, detalle y retry sobre el batch durable existente.
- El banner de Ajustes ya no presenta como sano un endpoint o esquema
  inaccesible y distingue el cambio guardado del reanálisis programado.
- Corregidos durante el repaso la recuperación incoherente de leases y el
  `pulls.updated_at` opcional que podía dejar cachés obsoletos.
- Validación local: 7/7 tests, build Angular y dos Edge bundles correctos.

### 2026-09-01 — Paso 2 consolidado localmente

- Añadido diagnóstico visible de endpoint resolver, M1–M9 y cobertura de
  backfill con gates transitivos por capacidad.
- Preparación conserva el template si falta infraestructura, pero ya no
  consulta ni representa los planes v2 como si estuvieran disponibles.
- El repaso corrigió las sondas M7 contra los nombres reales y separó backfill
  completo de score punitivo/evaluable.
- Validación local: 3/3 tests de readiness (10/10 junto a cola), build Angular
  y bundles de readiness/resolver correctos.

### 2026-09-01 — Paso 3 preparado y revisado localmente

- Añadido backfill de muestra 5–10 por boss/dificultad con batch reutilizable,
  progreso persistente y reintento sin reload.
- Añadido informe dirigido para Fade, base sin cambios, cargas/recharge,
  external y build histórico desconocido.
- El repaso corrigió la lectura de oportunidades de muerte y dejó cualquier
  sample parcial explícitamente fuera del gate de aceptación.
- Validación local: 3/3 tests del auditor (13/13 acumulados focalizados), build
  Angular y bundle de cola correctos. Falta la ejecución real para cerrar.

### 2026-09-01 — Paso 4 consolidado localmente

- Separadas las vistas Spec y Jugador, con semántica y acciones explícitas.
- Añadida fuente roster + último build, estados de frescura y resolución
  backend; la persona elegida es solo un filtro visual del plan global.
- La revisión cerró etiquetado incierto, carreras entre resoluciones y el
  fallback local indebido en modo Jugador.
- Validación local: 2/2 tests de frescura y build Angular correcto.

### 2026-09-01 — Paso 5, núcleo local implementado y revisado

- Añadidas tarjetas de valores efectivos, base/delta, cargas/recharge/target e
  inspector de provenance en la vista Jugador.
- Añadidos override exacto auditable, desactivación no destructiva, endpoint
  con revalidación del build y migración M10 con historial before/after.
- El repaso eliminó la aplicación v2 de overrides legacy sin fingerprint y
  aisló la capacidad de override del resto del readiness.
- El aviso observado con `cooldown_catalog` es un despliegue parcial esperado:
  la muestra queda bloqueada hasta M1–M8. Se añadió el motivo visible y el
  detalle PostgREST exacto para que el botón no parezca averiado.
- Validación local: build, 29/29 tests focalizados y tres bundles Edge
  correctos. Falta el snapshot efímero sin fingerprint y validación real.

## Pendientes externos conocidos

- No hay en este entorno una instancia Supabase/PostgreSQL configurada donde
  aplicar migraciones o ejecutar el backfill real.
- Falta una muestra WCL controlada para validar los casos históricos y targets.
- La importación manual final del MRT requiere el addon/entorno real.
- La activación de flags seguirá apagada hasta completar readiness, backfill y
  validación visual/E2E.
