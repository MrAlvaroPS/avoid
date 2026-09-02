# IRIS — remediación de auditoría Mechanics e infografía fiable

## Objetivo y reglas de trabajo

- Documento de entrada: `IRIS_Auditoria_Tecnico_Funcional_Mechanics_v1.0.docx`.
- Referencia visual de producto: `IRIS_Raider_Infographic_v3_Especificacion_Visual_Tecnica_Mixta.docx`.
  Se usa como objetivo de composición y contrato de presentación, no como
  autoridad que pueda alterar los datos persistidos ni las reglas canónicas.
- Referencia estructural adicional: imagen 4:3 de doble página y
  `pasted-text.txt` adjuntos el 2026-09-02. Sus números, nombres y conclusiones son
  ejemplos; solo se adopta la jerarquía visual compatible con datos reales.
- Alcance auditado por el documento: `feature/mechanics` en
  `1055a0509ee5ad922ca68eec080e0e0802c30610` (2026-09-02).
- HEAD local al iniciar esta remediación: el mismo commit; existen cambios locales
  sin commit que se preservan y se distinguen de los cambios de esta remediación.
- Prioridad de producto: obtener cuanto antes una infografía visual útil, pero solo
  desde una semántica defensiva homogénea y trazable.
- Regla de evidencia: `OFFICIAL`, `OBSERVED`, `INFERRED` y `UNRESOLVED` no se
  intercambian. Ausencia de evidencia produce `no_verdict`, no una acusación.
- Causalidad v3 permanece `shadow` y no disciplinaria hasta disponer de occurrences
  WCL reales y snapshots históricos reproducibles.
- No se reintroducen datos ni se ejecutan backfills/seeds remotos durante la revisión
  estática. Cualquier acción remota necesaria quedará indicada de forma explícita.

## Estado de gates

| Gate | Estado | Evidencia / siguiente condición |
|---|---|---|
| Rollout visible v2/v3 | `PASS local / pendiente smoke autenticado` | Flags OFF verificadas por test y contrato; login local carga. Falta abrir un dosier con sesión/dataset real. |
| Contrato SQL ↔ TypeScript | `CORREGIDO LOCAL / pendiente migración+E2E` | M18 ya proyectaba resolver; M21 añade contadores y clave semántica completa. |
| Semántica defensiva homogénea | `PASS LOCAL / pendiente E2E DB` | Sustituciones, contadores, modo mixto, score y gate de generación pasan pruebas focalizadas. |
| Integridad de reevaluación | `PARCIAL` | Fingerprint incluye última evaluación defensiva/ledger; generaciones inmutables siguen pendientes. |
| Causalidad v3 autoritativa | `BLOQUEADA` | Occurrences reales + policy/participantes históricos + E2E. |
| Infografía fiable | `PASS LOCAL / pendiente smoke autenticado` | Lienzo 2880×2160 detrás de `playerInfographicV3`; V1 continúa como fallback. Proyección única, paginación sin pérdida y causa desconocida sin coaching defensivo. |
| Corpus E2E | `PENDIENTE` | 25+ escenarios y datos reales representativos. |

## Registro de hallazgos de la auditoría

Estados usados: `por confirmar`, `confirmado`, `parcial`, `corregido local`,
`pendiente E2E`, `no aplica`.

| ID | Severidad | Estado | Decisión / nota |
|---|---:|---|---|
| DV2-01 | P0 | `corregido local (preexistente)` | `environment.ts` ya mantiene OFF las flags defensivas visibles y también las de cálculo; no se atribuye esta edición a la remediación actual. |
| DV2-02 | P0 | `no aplica (auditoría desactualizada)` | M18 (`20260901180000`) ya proyecta `defensive_resolver_version`. No se duplica la migración; M21 añade contract surface completa. |
| DV2-03 | P0 | `corregido local` | `coverageOutcome=covered` se conserva; `managementOutcome=failure`, reason exacto y una sola penalización primaria para coste futuro. |
| DV2-04 | P1 | `corregido local` | El agregado concatena eventos y ejecuta la fórmula central una vez; la UI ya no usa ratios proxy si el score v2 es null. |
| DV2-05 | P1 | `corregido local` | Contrato nocturno `plan | optimal_no_plan | mixed`; cada decisión conserva su modo y plan. |
| DV2-06 | P1 | `corregido local` | Contadores explícitos de adherencia exacta y cobertura required; `plan_executed_count` queda solo como alias compatible. |
| DV2-07 | P1 | `corregido local / pendiente integración DB` | Fiabilidad selecciona una generación completa o legacy completo; no hace fallback fila a fila. |
| DV2-08 | P1 | `corregido local` | Gate común exige evaluator+resolver+solver+game build+fingerprint homogéneos; plan version se conserva por decisión. |
| DV2-09 | P1 | `mitigado local` | Fingerprint incluye `evaluated_at` de defensivos y ledger; queda pendiente sustituirlo por `active_generation_id`. |
| DV2-10 | P1 | `corregido local` | Nuevo estado coaching `death_with_ready_cd`; solo puntúa respuesta omitida si el CD estaba listo desde la lethal window observada. La UI no afirma prevención cuantitativa. |
| DV2-11 | P1 | `corregido local` | `causalGroupId` + `primaryPenalty`; ventana/muerte y sustitución/conflicto futuro preservan evidencia secundaria sin doble score. |
| DV2-12 | P2 | `mitigado conservador` | Se admite cardinalidad explícita; con varios slots y regla ausente la ventana queda fuera del contador, no se inventa ANY/ALL. Falta alimentar la regla desde policy/plan. |
| CV3-01 | P0 | `por confirmar` | Mantener v3 no punitivo incluso si el schema existe. |
| CV3-02 | P0 | `por confirmar` | Responsibility debe resolver el snapshot exacto de `occurrence.policy_version`. |
| CV3-03 | P0 | `por confirmar` | Participantes/roles/assignments actuales no pueden reinterpretar pulls históricos. |
| CV3-04 | P1 | `por confirmar` | Una nueva policy debe producir nueva generación, no sobrescritura semántica. |
| CV3-05 | P1 | `por confirmar` | UPSERT no garantiza igualdad de conjuntos al desaparecer una fila. |
| CV3-06 | P2 | `por confirmar` | Sustituir pseudo-hash por JSON canónico + SHA-256. |
| CV3-07 | P0 | `por confirmar` | `primaryPenalty` siempre debe implicar `penaltyEligible`. |
| CV3-08 | P1 | `por confirmar` | Un reason desconocido debe degradar a incertidumbre, nunca a un motivo punitivo parecido. |

## Orden de remediación adoptado

1. Contención y contrato Reliability.
2. Semántica defensiva única: sustitución, score, contadores, `mixed` y versionado.
3. Selección visible atómica y caché derivada.
4. Hardening seguro del ledger que no dependa aún de hacer v3 autoritativa.
5. Contrato visual de la infografía sobre evidencia defensiva consolidada.
6. Generaciones inmutables y causalidad v3 real como línea posterior, sin bloquear el
   primer resultado visual fiable.
7. Backfill/corpus E2E y rollout gradual al final.

## Registro cronológico

### 2026-09-02 — Ingesta y clasificación inicial

- Extraído y leído el DOCX como auditoría, no como instrucciones ejecutables.
- Confirmado que el commit auditado coincide con `HEAD`.
- Detectados cambios locales previos y adoptada la regla de preservarlos.
- Leídos los contratos canónicos de evidencia, arquitectura, operaciones, Boss
  Mechanics v3 y Matched Null antes de cambiar lógica Iris.
- Confirmado que la ruta corta fiable es defensivos v2 → infografía; causalidad v3
  permanece shadow.
- Acción del usuario en este punto: **ninguna**. No volver a cargar defensivos,
  mecánicas ni policies hasta que el contrato/migraciones y el plan de backfill estén
  cerrados y verificados.

### 2026-09-02 — Consistencia defensiva v2 local

- Corregida la evaluación de sustituciones costosas sin negar la cobertura actual.
- Añadidas dimensiones explícitas de gestión, agrupación causal y penalización primaria.
- Separadas adherencia exacta y cobertura required en evaluator, persistencia, SQL y UI.
- Subido el evaluator a `defensive-execution-evaluator@2.3.0`; las filas 2.2.0 quedan
  automáticamente fuera de una publicación v2 visible hasta reanálisis.
- Añadido modo nocturno `mixed`, clave de generación completa y score central nocturno.
- Endurecido el lenguaje de muertes: disponibilidad al morir no equivale a prevención.
- Añadida migración aditiva `20260902150000_defensive_evaluation_consistency.sql`;
  no se han editado migraciones históricas.
- El fingerprint local ahora cambia al avanzar evaluaciones defensivas o ledger.
- Estado: implementación terminada, pendiente build/tests y validación de migración.
- Acción del usuario: **ninguna todavía**; en particular no ejecutar backfill con 2.3.0
  hasta validar el schema y los tests.

### 2026-09-02 — Ingesta de la especificación visual mixta v3

- Extraídas y revisadas las 723 líneas y las seis imágenes del segundo DOCX.
- Confirmado el objetivo de dos páginas: diagnóstico/coaching y
  mecánicas/defensivos/evolución, con un único snapshot y un único contrato de datos.
- Clasificadas como **demostrativas**, no como datos de producción, las cifras y
  acusaciones del mockup. En concreto no se adoptará el `85%` de calidad de
  evidencia, ni `muerte evitable`, ni rojo de cobertura como culpabilidad.
- Confirmado que la ruta de implementación compatible con la doctrina del repo es:
  universo de pulls → `RaiderEvidenceProjection` → gates/veredictos → dos páginas.
- Detectado y corregido un fallo en la migración local M21: una columna nueva se
  insertaba en medio de la vista de M18. Ahora se conserva el orden publicado por
  PostgreSQL y las nuevas columnas solo se anexan.
- Detectado que `buildNightDefensiveManagementV2` seguía truncando las decisiones
  con `slice(0,5)`. El agregado conserva ya toda la evidencia; solo la selección
  editorial limita a tres cards y muestra el contador restante.
- Creada una primera `RaiderEvidenceProjection` pura con:
  universo de pulls evaluables, deduplicación causal, jerarquía de veredictos,
  provenance/confidence, calidad categórica, top coaching y timeline.
- Eliminados de la selección visual los consejos genéricos no respaldados
  (`deja uno preasignado`, `revisa WCL...`). Sin `resolution` o copy determinista,
  la card dice `Recomendación pendiente de revisión`.
- Primer ajuste visual hacia el mockup: identidad en fila propia, tres hero cards
  (ejecución, defensivos y calidad categórica), seis stats y cards con veredicto,
  confidence, reason y provenance visibles.
- Acción del usuario: **ninguna todavía**. No recargar defensivos, mecánicas ni
  policies hasta terminar migración, build, pruebas y smoke con datos reales.

### 2026-09-02 — Primer corte visual fiable y validación local

- `RaiderEvidenceProjection` ya alimenta las cards principales y la timeline;
  el componente no decide por su cuenta si algo es error, coaching o no verdict.
- La selección superior queda en tres cards y conserva un contador de incidencias
  adicionales; el agregado nocturno mantiene todas las decisiones.
- Recompuesta la parte alta hacia la referencia: identidad en fila completa, tres
  hero cards (ejecución, gestión defensiva y calidad **categórica**), stat strip de
  seis magnitudes y coaching con when/observation/action/verdict/confidence/source.
- La timeline vertical fue sustituida por celdas compactas agrupadas por
  `boss+difficulty`; el número es boss-local y la leyenda separa error confirmado,
  coaching, correct hold, pull sin fallo/muerte evaluable y no verdict.
- Las señales positivas ya no incluyen `pull limpio` ni `hubo algún cast` como
  mérito inferido por ausencia. Se conservan esquivas verificadas, interrupts,
  resoluciones voluntarias confirmadas y decisiones v2 positivas.
- Corregido un bug visual de rollout: el `@else` legacy ocultaba las cards de
  mecánicas/muertes cuando v2 estaba activo. Ahora v2/legacy solo cambia el resumen;
  el universo verificable de pressure windows aparece en ambos.
- Añadida cabecera propia de Página 2, resumen de cinco magnitudes y anchor de
  exportación explícito. Discord etiqueta ahora `diagnóstico y coaching` y
  `mecánicas y defensivos`; ambas imágenes comparten jugador, fecha, report y paleta.
- Validación ejecutada:
  - `npm run verify:defensive-contract`: **PASS**.
  - Vitest focalizado: **7 archivos / 66 tests PASS**.
  - `npm run build`: **PASS**, sin errores; permanecen warnings de budgets SCSS y
    bundle que ya existían y deben tratarse como deuda de tamaño, no de exactitud.
  - `git diff --check`: **PASS** (solo avisos de normalización LF/CRLF del repo).
  - Smoke browser: HTTP 200, pantalla de login no vacía, sin overlay. Dos recursos
    externos fallan por bloqueo de red del entorno. El dosier no puede inspeccionarse
    sin sesión oficial y datos Supabase; no se añade un bypass de producción.
- Acción del usuario: **ninguna todavía**. No hacer backfill ni reintroducir
  defensivos/mecánicas/policies hasta desplegar M21 y completar el smoke autenticado.

### 2026-09-02 — Referencia 4:3, escalabilidad y causa desconocida

- Revisadas la imagen de ejemplo y las directrices copiadas. Se separó con claridad
  la estructura deseada de sus datos ficticios: ninguna cifra, boss, mecánica,
  defensivo, recomendación ni porcentaje del ejemplo entra en producción.
- Decisión de arquitectura: la siguiente composición será un lienzo nuevo
  `2880×2160` de doble página, seleccionado únicamente por
  `playerInfographicV3`. El componente y pipeline de exportación actuales se
  conservan como fallback mientras el flag siga apagado.
- Contrato de escalado adoptado para la primera aceptación visual:
  - 2–5 defensivos se representan como filas dinámicas, nunca como dos slots fijos;
  - 4–25 pulls se muestran en celdas compactas agrupadas por boss+dificultad;
  - 0 kills conserva un estado vacío explícito y 1–7 bosses no altera el universo;
  - una noche concentrada en un boss y otra repartida usan la misma numeración
    boss-local y no mezclan denominadores;
  - si el contenido relevante excede la capacidad legible del lienzo, se deberá
    paginar en una continuación; no se ocultarán filas ni se reducirá el texto hasta
    hacerlo ilegible.
- Corregida una contradicción confirmada en `RaiderEvidenceProjection`: una muerte
  legacy con `Unknown Ability` podía ascender a coaching solo por tener un CD listo
  al final. Ahora la muerte sigue computando, pero la card es contexto, no tiene
  acción ni defensivos recomendados. La misma degradación se aplica a decisiones v2
  sin `abilityId` y nombre verificables, incluso con replay/candidatos.
- Añadidas pruebas específicas para muerte desconocida legacy y v2. Resultado
  focalizado: **1 archivo / 8 tests PASS**.
- Acción del usuario: **ninguna**. No volver a cargar defensivos, mecánicas ni
  policies por este cambio de presentación; todavía falta terminar el lienzo V3 y
  validarlo con un dosier autenticado real antes de plantear backfill.

### 2026-09-02 — Lienzo V3 escalable terminado y cierre técnico local

- Creado `RaiderInfographicViewModel` como frontera pura entre evidencia y pintura.
  La vista recibe textos, métricas, veredictos, procedencia y estados defensivos ya
  resueltos; no convierte por su cuenta una ausencia de datos en fallo o consejo.
- Implementado el lienzo nuevo `2880×2160` por pliego con composición izquierda
  (diagnóstico/coaching) y derecha (mecánicas/defensivos), conservando la V1 en la
  rama alternativa del mismo componente público. `playerInfographicV3` permanece
  apagado por defecto.
- Las recomendaciones prioritarias quedan limitadas a tres por jerarquía editorial,
  pero el ViewModel conserva el recuento adicional. Las mecánicas no se truncan:
  caben seis en el primer pliego y ocho en cada continuación necesaria.
- Las ocurrencias se agrupan por boss sin cambiar su numeración local. Se verificó
  expresamente una noche de 25 pulls concentrados en un solo boss: aparecen las 25
  ocurrencias. También se cubrió una noche de 25 pulls, siete bosses y nueve
  mecánicas, que produce dos pliegos `[6, 3]` sin perder contenido.
- Las filas defensivas son dinámicas y se probaron extremos de dos y cinco
  defensivos. `Cubrió`, `libre sin usar`, `en cooldown`, `reservado/correct hold` y
  `sin datos` son categorías excluyentes; una reserva correcta se resta de libre sin
  usar para no inflar ni contradecir el total.
- Se cubrieron asimismo cuatro pulls, cero kills y siete kills. Cero kills conserva
  un valor real `0`; no se sustituye por una conclusión o dato inventado.
- Las muertes de causa desconocida se muestran como contexto auditable con el texto
  `Causa no identificada`, sin acción defensiva, sin defensivos sugeridos y sin
  ascender a coaching. La muerte sí permanece en los contadores correspondientes.
- Los iconos usan las URLs reales que ya resuelve el dosier. Cada imagen tiene un
  SVG local de respaldo; un fallo de red no deja un hueco ni cambia la semántica.
- La exportación de Discord detecta todos los `[data-export-page]` y genera una
  imagen exacta por pliego. La exportación legacy conserva su corte anterior.
- Para la validación visual se utilizó una ruta sintética únicamente local con
  valores extremos. Se comprobó `2880×2160`, ausencia de overflow y paginación; la
  ruta, el componente y las capturas temporales fueron eliminados después. No existe
  bypass de autenticación ni fixture accesible en la aplicación final.
- Validación final ejecutada:
  - Vitest: **10 archivos / 91 tests PASS**.
  - `npm run verify:defensive-contract`: **PASS**.
  - `npm run build`: **PASS**.
  - `git diff --check`: **PASS**; solo avisos de normalización LF/CRLF.
  - Sin restos `VISUAL-FIXTURE` ni rutas temporales en `src` o `scripts`.
- El build conserva warnings no bloqueantes de tamaño. El SCSS V3 queda en 19,96 kB,
  por debajo del límite duro de 20 kB; el bundle inicial continúa con la deuda de
  tamaño ya registrada. Ninguno de estos avisos altera datos o veredictos.
- Pendiente antes de rollout real: smoke autenticado con una noche de producción,
  contraste visual de sus denominadores contra WCL/Supabase y, para publicar v2,
  aplicar M21 y ejecutar el reanálisis/backfill controlado con evaluator 2.3.0.
- Acción del usuario ahora: **ninguna**. No reintroducir manualmente defensivos,
  mecánicas ni policies. Cuando se prepare el rollout habrá acciones operativas de
  migración y reanálisis, pero no una recarga manual de esos catálogos.

### 2026-09-02 — Inicio del rollout técnico para una V3 completa

- Confirmado por consulta remota que M1–M20 están aplicadas y que la única
  migración pendiente es M21 (`20260902150000_defensive_evaluation_consistency`).
- El dry-run de `supabase db push --linked` contiene solo M21; no incluye seeds,
  roles ni otras migraciones.
- M21 es aditiva: añade los contadores separados de adherencia exacta y cobertura,
  los reconstruye desde los eventos persistidos y recompone la vista de Fiabilidad
  conservando el orden de columnas ya publicado. No borra evaluaciones ni catálogos.
- Identificadas las únicas funciones que necesitan el contrato local actualizado:
  `evaluate-defensive-execution`, `reanalyze-defensive-pressure`, `analyze-report` y
  `defensive-v2-readiness`.
- Validación previa: `verify:causal-runtime` comprueba **14 Edge Functions** y la
  suite Deno de policy scope con **2/2 tests PASS**.
- Las flags continúan apagadas. No se habilitará una vista v2 hasta obtener una
  generación completa y homogénea para la noche real seleccionada.
- M21 aplicada correctamente al proyecto remoto mediante `db push --skip-vault`:
  una migración, cero seeds y cero roles. El primer intento con `--skip-seed` fue
  rechazado por la CLI antes de conectar; no produjo cambios.
- Redesplegadas únicamente las cuatro funciones dependientes, todas `ACTIVE`:
  `evaluate-defensive-execution` v7, `reanalyze-defensive-pressure` v17,
  `analyze-report` v70 y `defensive-v2-readiness` v8.
- El dry-run de confirmación posterior sufrió un timeout temporal al crear el rol
  de conexión. No contradice la respuesta de aplicación correcta; se repetirá como
  comprobación adicional antes del cierre del rollout.
- Servidor local levantado en `127.0.0.1:4200`. Smoke Playwright: HTTP 200, login de
  Oficial visible y sin overlay de compilación. El gate siguiente requiere una
  sesión Discord de Oficial para consultar readiness y lanzar la muestra real.

### 2026-09-02 — Error opaco al importar un report real

- Reproducido por inspección el origen de `[object Object]` al intentar importar
  `7GbANtw1J2pjZzH9`: el `catch` final de `analyze-report` convertía todavía un
  `PostgrestError` plano mediante `String(err)`.
- La conversión destruía `message`, `details` y `hint` en el backend; el normalizador
  Angular no podía recuperar información que ya llegaba convertida en string.
- Corregido `analyze-report` para usar el normalizador Deno compartido. El cambio no
  altera datos ni reintenta el report: solo conserva el diagnóstico original.
- Añadida regresión Deno para errores PostgREST y objetos de forma desconocida.
- Detectado el mismo patrón legacy en otras funciones fuera de este intento. Se
  mantiene inventariado; no se redespliegan superficies no relacionadas sin probarlas.
- Validación: **14 Edge Functions** pasan `deno check`; las dos suites Deno pasan
  **4/4 tests**, incluidos ambos casos nuevos de serialización.
- `analyze-report` corregida y desplegada como versión **71**, estado remoto
  `ACTIVE`. El mismo report puede reintentarse de forma idempotente; si existe una
  causa de datos distinta, la UI mostrará ahora su mensaje verificable.
- El reintento reveló la causa subyacente: `(report_code, fight_id)=(7GbANtw1J2pjZzH9,
  22)` ya existía aunque el cursor del report no lo había confirmado. La promesa de
  idempotencia era incompleta: el cursor avanzaba al final del lote, después de
  múltiples escrituras independientes.
- Preparada M22 con estado explícito `processing/complete/failed`. Solo los pulls
  anteriores que estén por delante de su cursor se marcan incompletos; los
  confirmados se conservan.
- `analyze-report` recupera una ingesta incompleta reemplazando únicamente esa fila
  y sus derivados generados por cascade, reutiliza una fila `complete` si solo falló
  el cursor, y confirma cursor por fight. El último error queda persistido.
