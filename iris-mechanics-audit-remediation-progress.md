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

### 2026-09-03 — Recuperación segura del pull 22 y frontera de evidencia

- Confirmado el fallo exacto del report `7GbANtw1J2pjZzH9`: el pull 22 se insertó
  en una petición anterior, pero el cursor quedó en el fight previo. No era un
  duplicado real de WCL, sino una ingesta parcial no distinguible por el esquema.
- M22 trata `processing`, `complete` y `failed` como estados excluyentes. El
  dry-run remoto confirmó que esta migración base ya estaba aplicada y que el
  pull huérfano quedó identificable como `failed`.
- El endurecimiento de lectura se separó correctamente en una nueva M23, sin
  reescribir el historial ya aplicado: los lectores autenticados solo podrán ver
  pulls `complete`; la vista de Fiabilidad v2 añade el mismo filtro explícito
  porque su sonda privilegiada usa `service_role` y no queda protegida por RLS.
- La recuperación no borra un pull que otra petición esté procesando. Un estado
  `processing` reciente espera; solo se reemplaza si lleva al menos 15 minutos
  abandonado. Un estado `failed` sí se reconstruye. El borrado queda acotado a la
  fila incompleta y sus hijos derivados mediante las FK `on delete cascade`.
- El pull se confirma antes de avanzar `last_processed_fight_id`. Ambas operaciones
  comprueban que actualizaron una fila real. Si el cursor falla después de completar
  el pull, el siguiente intento reutiliza la evidencia íntegra sin recalcularla.
- Ya no se permite cerrar una ingesta si falló el alta del report, el conteo base de
  pulls o la persistencia de metadata esencial del pull. El error estructurado se
  conserva en `ingestion_error` en vez de degradarse a `[object Object]`.
- Corregido un test de rollout obsoleto: `environment.ts` ya tenía los seis flags
  causales/V3 activados en el commit actual, mientras el verificador seguía exigiendo
  `false`. No se cambió su valor funcional; se hizo explícito el estado esperado.
  Las cinco flags de Defensivos v2 continúan apagadas.
- Validación local hasta este punto:
  - `verify:causal-schema`: **PASS** antes de separar M23; se repetirá contra las
    13 migraciones verificadas antes del despliegue.
  - `verify:causal-runtime`: **PASS**, 14 Edge Functions y 8/8 tests Deno.
  - `npm run build`: **PASS**. Persisten los warnings de tamaño ya inventariados;
    V3 sigue en 19,96 kB de SCSS y se compactará con el report real visible.
  - `git diff --check`: **PASS** salvo avisos informativos LF/CRLF.
- Acción del usuario: **ninguna todavía**. No reintroducir defensivos, mecánicas ni
  policies. Falta aplicar M22, desplegar `analyze-report`, completar este report y
  verificar que su generación defensiva sea homogénea antes de activar Defensivos v2.

### 2026-09-03 — Despliegue de recuperación y apertura atómica de Sección 04

- El primer dry-run indicó correctamente que M22 ya estaba aplicada en remoto. Las
  protecciones de lectura nuevas se movieron a M23 en vez de modificar una migración
  histórica ya ejecutada. El segundo dry-run propuso solo M23, cero seeds y cero roles.
- M23 (`20260903070000_harden_pull_ingestion_recovery`) aplicada; el dry-run posterior
  confirma que la base remota está al día.
- `analyze-report` desplegada como versión **75 ACTIVE**. Recupera el pull 22 marcado
  `failed`, evita borrar una petición concurrente y confirma cada fight antes de
  avanzar el cursor.
- Separado el gate de la infografía del de Fiabilidad:
  - Sección 04 puede usar V2 por jugador×noche cuando todas sus evaluaciones son
    completas y homogéneas.
  - Si falta una, hay confianza incierta o cambia evaluator/resolver/solver/build/
    fingerprint, el constructor devuelve `null` y la vista usa el bloque legacy
    completo; nunca mezcla ambas generaciones.
  - Se añadió el requisito explícito `effective-defensives@2.1.0`, además de
    `defensive-execution-evaluator@2.3.0`.
  - `defensiveInfographicV2` queda activada; `defensiveReliabilityV2` sigue apagada
    hasta el backfill global. El `192/2078` ya no bloquea una noche individual.
- `defensive-v2-readiness` desplegada como versión **9 ACTIVE**. El panel distingue
  ahora `Sección 04 (gate por noche)` de `Fiabilidad` global.
- Corregidos dos fixtures que usaban el modo inexistente `plan`; el evaluator real
  publica `full`, `degraded` o `no_plan`.
- Validación final de este corte:
  - suite Angular completa: **42 archivos / 264 tests PASS**;
  - tests focalizados de readiness, resumen defensivo y flags: **4 / 13 PASS**;
  - `verify:defensive-contract`: **PASS**;
  - `verify:causal-schema`: **PASS**, 13 migraciones;
  - Deno check del readiness y build de producción: **PASS**;
  - warnings de tamaño sin cambio: V3 sigue en 19,96 kB de SCSS.
- Acción del usuario ahora: reintentar una vez la importación de
  `7GbANtw1J2pjZzH9`. No recargar defensivos, mecánicas ni policies. Si aparece un
  fallo distinto, copiar el mensaje completo; ya debe conservar el diagnóstico real.

### 2026-09-03 — Rediseño de recordatorios MRT: paso 1 (consolidación cross-pull) y paso 2 (solver)

Contexto: feedback real — "las pruebas que hicimos de las notas del MRT... no
saltan. Lo he pasado a 4-5 raiders distintos y ninguna salta donde debe." Causa
raíz de fondo (ya corregida en un corte anterior, no de esta sesión): se mandaba
el `encounter_id` de Warcraft Logs como `bossID` de MRT en vez del
`journal_encounter_id` de Blizzard. Este corte ataca la calidad/coherencia del
plan en sí, plan de 4 pasos acordado; aquí solo pasos 1 y 2.

**Paso 1 — alineación de occurrences por proximidad temporal, no por posición.**
- Causa raíz confirmada en `mechanic-occurrences.ts`:
  `groupMechanicOccurrenceOffsets` alineaba la ocurrencia #N de un pull con la #N
  de otro puramente por índice de array. Un wipe temprano o un cast condicional
  que no siempre dispara desplaza esa numeración para el resto del pull, mezclando
  ocurrencias reales distintas y fragmentando la misma ocurrencia real en dos.
- Reemplazado por clustering greedy por proximidad temporal sobre todas las
  muestras de todos los pulls a la vez. La tolerancia de fusión nunca supera la
  mitad del hueco real más corto observado *dentro de un mismo pull* entre dos
  casts distintos — esa prueba empírica garantiza que nunca se fusionan dos
  ocurrencias que ya demostraron ser distintas en un pull real.
- Tests nuevos en `mechanic-occurrences.spec.ts`, incluyendo una reproducción
  exacta del bug (un pull se salta la ocurrencia real #2 → bajo alineación
  posicional se mezclaba con la #2 de los demás pulls; con clustering queda
  correctamente agrupada en la #3).
- Desplegada `sync-mechanic-defensive-profile` (único consumidor real de la
  función; `evaluate-mechanic-occurrences` y `process-combat-evaluation-queue`
  no la importan pese a compartir texto en el nombre).

**Paso 2 — el solver ahora sabe cuándo un cast ya cubre la ocurrencia siguiente.**
- Gap confirmado en `defensive-plan-solver.ts`: `isConservativeScheduleFeasible`
  modelaba cooldown/cargas pero no duración — dos ocurrencias del mismo
  jugador+defensivo separadas solo unos segundos, ambas dentro de la duración de
  un único cast, se evaluaban como dos usos independientes. Si el cooldown no
  daba para un segundo uso, el solver marcaba la segunda ocurrencia `uncovered`
  aunque el jugador siguiera protegido por el primer cast; si daba, generaba un
  segundo recordatorio MRT pidiendo pulsar el mismo botón otra vez sin necesidad.
- `isConservativeScheduleFeasible` acepta ahora `occurrenceAtMs`/`durationMs`
  opcionales por uso: si el peor caso (p90) de una ocurrencia ya cae dentro de la
  ventana activa `[cast, cast+duración]` de un uso anterior del mismo recurso, no
  consume carga ni entra en la cola de recarga — queda cubierta gratis. Ausentes,
  el comportamiento es idéntico al histórico (compatibilidad verificada: los 13
  tests previos del solver siguen en verde sin modificarlos).
- Nuevo paso `markDurationCoverage()` tras finalizar las asignaciones: marca
  `needsFreshCast: false` en la ocurrencia posterior que ya queda protegida por
  duración, con `coveredByPriorCastAtMs` apuntando al cast real. Reservas
  manuales/lock nunca se reinterpretan como redundantes.
- Encadenado end-to-end para que el ahorro llegue de verdad a MRT, no solo al
  solver: `defensive-plan-contract.ts` (`DraftSlot` + validación), migración
  `20260903100000_defensive_plan_slots_duration_coverage` (columnas
  `needs_fresh_cast`/`covered_by_prior_cast_at_ms` en `defensive_plan_slots`),
  `defensive-plan-persistence.ts`, `generate-defensive-plan/index.ts`,
  `domain.ts` (`DefensivePlanSlotRow`), `boss-prep.component.ts` y
  `deployed-plan-mrt.ts` (`exportDeployedPlanToMrt` omite el recordatorio
  redundante y reporta qué slots quedaron cubiertos por duración en el modal de
  export, igual que ya hacía con los fallbacks de trigger bossmod→tiempo).
- Tests nuevos: 3 en `defensive-plan-solver.spec.ts` (cubre por duración, exige
  cast fresco cuando la duración ya expiró, nunca reinterpreta un lock/manual
  como redundante) y 1 en `deployed-plan-mrt.spec.ts` (un solo recordatorio para
  dos slots cubiertos por el mismo cast, con el segundo reportado aparte).
- Validación de este corte: `tsc --noEmit` limpio; `vitest run` en los 4 spec
  afectados = 35/35; suite completa = 161/176 (los 15 fallos son
  pre-existentes — `localStorage`/`TestBed.initTestEnvironment` fuera de este
  alcance, no tocados); `ng build` sin errores (mismos warnings de tamaño
  ya inventariados). Migración aplicada a remoto; `sync-mechanic-defensive-profile`
  y `generate-defensive-plan` desplegadas.
- Pendiente (pasos 3 y 4, no empezados en este corte): UI de Preparación
  (pestaña Jugador por defecto, chips de clase en vez de dropdown), segundo
  trigger AND de disponibilidad de defensivo en `mrt-reminder-codec.ts`, y
  anclar el timing automático a triggers reales de bossmod/BigWigs (hoy solo
  las reservas manuales/publicadas llevan `bossmodSpellId`/`bossmodCounter`).

### 2026-09-03 — Pasos 3 y 4, y dos bugs reales encontrados con datos en vivo (Magzil/Gusmï, The Twin Fangs HC)

**Paso 3 (UI de Preparación)**:
- `assignmentView` por defecto pasa a `'player'` ("Jugador"); `loadV2Readiness()`
  ya hacía fallback a `'spec'` si `playerMode` no está disponible, sin cambios ahí.
- El `<select>` de jugador se sustituye por chips clicables con
  `[style.color]="classColor(...)"` + `<app-class-icon>`, mismo patrón visual que
  `.player-chip` en night-report/raid-session (fondo neutro, borde/texto teñidos
  por clase, estado `.selected` con `box-shadow` de currentColor).
- `planningResourceSelected`/`togglePlanningResource` ya no preseleccionan todo
  `category === 'personal_defensive'` — ahora exigen además
  `survivalType in (mitigation, absorption)` vía `defaultsToPersonalMitigation()`.
  Sustain/emergency dentro de personal_defensive ya no se marca por defecto;
  elegirlos a mano sigue permitido igual (`planningResourceSelectable` sin cambios).
  Deliberadamente NO se tocó `autoAssignCascade` (auto-assign de la spec/plantilla
  legacy): ya excluye emergency y despriorriza sustain con razonamiento propio
  documentado, es un algoritmo distinto y ya probado.

**Bug real #1 (encontrado por el usuario en vivo, timeline de Magzil)**: la
Cronología mostraba una fila por CADA ocurrencia cubierta por duración, aunque
`needs_fresh_cast: false` ya estuviera correctamente calculado por el solver
(verificado con SQL directo sobre el draft real — el dato estaba bien, el bug
era solo de visualización). `openTimeline()` ahora filtra
`needs_fresh_cast !== false` y anota cuántas ocurrencias cuelgan de cada press
real (`"... (cubre N ocurrencias)"`), en vez de repetir 18 filas del mismo cast.

**Bug real #2 (encontrado por el usuario en vivo, mismo timeline, 1:48 con
Ice Cold/Alter Time/Ice Block los tres a la vez)**: `groupMechanicOccurrenceOffsets`
(el clustering de paso 1) encadenaba solo contra la muestra anterior — un
cluster podía derivar sin límite (A-B cerca, B-C cerca... con A y la última a
70+ segundos). Confirmado con SQL real: la ocurrencia #76 de Eternal Venom para
Magzil tenía `window_start_ms=72607, window_end_ms=143843` (71s de ancho) por
una sola "ocurrencia". Esa ventana artificialmente ancha hacía que el solver
tratase timings de ráfagas de pulls distintos como si fueran la misma
ocurrencia real, y al no caber todas en el cooldown/duración de un único
defensivo, tiraba de todo el kit — incluyendo Ice Block (emergency, 240s/150s
efectivo) y Alter Time (emergency, 60s) para lo que en realidad eran picos
normales y recurrentes, no emergencias. Fix: además del hueco a la muestra
anterior, ahora se exige que el cluster ENTERO (última − primera muestra)
quepa dentro de `clusterToleranceMs` — ninguna ocurrencia puede ya combinar
dos muestras reales separadas más que la tolerancia, sin importar cuántos
pasos intermedios las conectaban. Test nuevo que reproduce el patrón exacto
(7 muestras de pulls distintos separadas 900ms encadenadas, tolerancia
1000ms — antes colapsaban en 1 cluster de 5.4s, ahora nunca superan 1s de
ancho). `sync-mechanic-defensive-profile` redesplegada.
- **Pendiente de acción del usuario**: los perfiles de ocurrencia de
  `boss_mechanic_occurrence_profile` para The Twin Fangs Heroic ya están
  calculados con el clustering ANTIGUO (con la ventana ancha) — el fix solo
  afecta a sincronizaciones nuevas. Hace falta pulsar "Sincronizar" en
  Preparación para ese boss+dificultad y regenerar el borrador antes de que
  la Cronología/exportación reflejen el arreglo. No se pudo disparar desde
  aquí: `sync-mechanic-defensive-profile` exige un JWT de oficial real
  (`requireOfficer`), no la service role key de este entorno.

**Paso 4**:
- **Wiring de bossmod/counter a asignaciones automáticas — COMPLETO**.
  Migración `20260903110000_mechanic_defensive_assignments_bossmod_counter`
  añade `bossmod_counter`/`bossmod_counter_verified` a
  `mechanic_defensive_assignments` (mismo patrón/constraint que
  `defensive_plan_slots`, migración 20260901110000). `save-mechanic-defensive-
  assignment` los acepta y normaliza (nunca marca verified sin trigger
  bossmod + counter no vacío, igual que hace la constraint). UI de captura
  añadida al modal de asignación manual (input de counter + checkbox
  "Counter verificado en juego", deshabilitado sin counter). `generate-
  defensive-plan/index.ts` ya los lee al construir `templateReservations` en
  vez de mandar siempre `bossmodCounterVerified: false` — antes de esto, una
  asignación automática con `bossmod_spell_id` puesto degradaba en SILENCIO a
  trigger de tiempo fijo en la exportación MRT, sin ningún aviso. Desplegadas
  `save-mechanic-defensive-assignment` y `generate-defensive-plan`.
- **"Posible defensivo" en mecánicas soak — COMPLETO**. `exportDeployedPlanToMrt`
  acepta un `soakAbilityIds: ReadonlySet<number>` opcional; antepone
  `"Posible defensivo: "` al mensaje del reminder para esa ability, sin tocar
  `coverageStatus` ni el resto del contrato (solo texto, tal y como se
  confirmó). `boss-prep.component.ts` lo construye desde
  `candidates().filter(c => c.category === 'soak')` (clasificación real ya
  existente en `mechanic-category-inference.ts`). Test nuevo verificando
  presencia/ausencia del prefijo.
- **2ª trigger AND de disponibilidad de defensivo — NO iniciado**. Necesita
  el event/campo real de MRT para un chequeo de cooldown/spell-ready, que no
  está verificado en ningún research previo de esta sesión (solo tenemos
  PULL_EVENT=3 y BOSSMOD_EVENT=7 confirmados contra el juego real). Fabricar
  un event ID sin verificar repetiría exactamente el error original de este
  hilo (bossID equivocado que nunca disparaba en silencio) — pendiente de
  que el usuario confirme el mecanismo real antes de implementarlo.

Validación final de este corte: `tsc --noEmit` limpio, `ng build` sin errores
(mismos warnings de tamaño), suite completa 163/178 (163 passed vs. 161 del
corte anterior — 2 tests nuevos de soak; los 15 fallos son los mismos
pre-existentes de siempre, no tocados). Migraciones aplicadas a remoto;
`sync-mechanic-defensive-profile`, `generate-defensive-plan` y
`save-mechanic-defensive-assignment` redesplegadas.

### 2026-09-03 — Tanda de bugs reportados en vivo: Preparación (flujo, nombres,
pasivas, persistencia) e Infografía V3 (report `7GbANtw1J2pjZzH9`, Gusmï)

Lista de ~20 problemas reportados por el usuario tras probar Preparación y la
infografía de jugador V3 en vivo. Investigados uno a uno contra el código real
y, para el caso de Teqi, contra la base de datos en producción (solo lectura)
antes de decidir cualquier fix. Un agente Plan revisó las hipótesis contra los
archivos completos antes de implementar.

**Preparación — nombres, pasivas, flujo, aviso de stale:**
- `safeSpellName()` (format.util.ts, ya existente) se aplicaba en boss-prep
  pero no en `defensive-catalog.component.html` — regresión confirmada
  ("se estaba mostrando bien, pero lo hemos perdido"). Corregido.
- Pasivas: `activationMode==='passive'` ya se marcaba `eligible=false` en
  `effective-defensives.ts`, pero seguían renderizándose como card deshabilitada
  en el grid de Preparación. Nuevo `selectedPlayerVisibleKit` las excluye del
  `@for`; el contador y el kit completo no cambian.
- Flujo reordenado: el botón real de sync de mecánicas (`runSync()`) vivía
  enterrado bajo toda la grid de kit efectivo, y por delante del selector de
  boss había un panel de QA interno ("Backfill controlado") que audita 5 casos
  fijos de resolución de spellmods — uno de ellos usa literalmente Fade
  (Priest) como caso de referencia, de ahí que apareciera esa palabra sin
  sentido con cualquier clase. No es un bug de datos: es una herramienta de
  validación de spellmods, no de preparación. Reordenado a boss → dificultad →
  Sincronizar (con texto explícito de qué sincroniza: solo ese boss+dificultad)
  → vista/jugador; el panel de QA + readiness técnico se movieron a un bloque
  "Diagnóstico técnico" colapsado al final de la página.
- Nuevo aviso `draftPredatesLastSync`: un sync corregido (p.ej. el fix de
  clustering de Twin Fangs HC del corte anterior) no invalidaba un borrador ya
  generado antes — closing the loop del "Pendiente de acción del usuario" de
  esa entrada. Ahora se avisa explícitamente si el borrador activo es anterior
  al último sync conocido.
- Persistencia real de "Usar en el plan": `planningResourceSelections` vivía
  solo en memoria (se perdía en cada recarga — "cada vez que entre en Gusmï
  tenga que quitarle el check..."). Nueva tabla aditiva
  `player_planning_resource_selections` (migración `20260903120000`, RLS
  igual que el resto del schema v2, sin tabla de auditoría — no es una
  corrección numérica auditada, es un checkbox de planificación) + función
  `save_planning_resource_selection` (SQL, mismo patrón que
  `save_exact_player_defensive_override`) + Edge Function
  `save-planning-resource-selection` (desplegada). Clave por `character_id`
  (estable), no por nombre.

**Investigación Teqi (Brewmaster en un Mistweaver) — root cause real:**
- Consulta de solo lectura confirmó: `Teqi` (Monk, rol Heal, roster) tiene
  CERO filas en `player_pull_records` con class/spec en toda la historia —
  nunca se le resolvió spec. En el report más reciente hay un monje sanador
  jugando Mistweaver bajo el nombre `Colakao`, mismas noches — indicio fuerte
  de un cambio de nombre en el juego que WoWAudit no ha sincronizado (no se
  tocó `wowaudit_roster` ni se fuerza ninguna corrección de dato: eso le
  corresponde comprobar/corregir al usuario, vía WoWAudit o el botón de sync
  de roster ya existente).
- Causa de que esto produzca el catálogo COMPLETO de la clase en vez de
  restringir por spec: `specApplies()` en `effective-defensives.ts` devuelve
  `true` para cualquier entrada cuando `playerSpec == null` — spec desconocida
  hoy equivale a "sin filtro", no a "solo lo no-exclusivo de spec". Confirmado
  pero **no corregido en este corte**: arreglarlo de raíz exige subir
  `EFFECTIVE_DEFENSIVE_RESOLVER_VERSION` (2.1.0→2.2.0), que es un gate de
  homogeneidad consumido por `analyze-report`, `reanalyze-defensive-pressure`,
  `defensive-v2-readiness` y la generación de planes — un cambio de mayor
  radio de impacto que el bug puntual, pendiente de decisión explícita del
  usuario antes de tocarlo.
- **Limpieza de datos real ejecutada** (esta sí, en producción): consulta de
  solo lectura encontró 15 filas de `cooldown_catalog` con el nombre corrupto
  — un envío manual de `classify-defensives` dejó pegado un fragmento de cita
  markdown/JSON sin terminar de parsear (`"Bear](https://.../%22:%22Bear) Form"`
  en vez de `"Bear Form"`, mismo patrón en Druid/Monk/Paladin). Todas
  identificadas sin ambigüedad por spellId (nombres de habilidad conocidos).
  Migración `20260903130000` con verificación explícita (falla si alguna fila
  sigue corrupta tras el UPDATE) — aplicada, cero filas corruptas confirmado
  después con la misma consulta de solo lectura.

**Infografía de jugador V3 (report `7GbANtw1J2pjZzH9`, Gusmï):**
- Cards de coaching: tope editorial subido de 3 a 4
  (`raider-evidence-projection.ts`), con `layout.coachingDensity` nuevo
  (mismo patrón que `pullDensity`/`defensiveDensity` ya existentes) para que
  la 4ª card no recorte el resto de la página fija (`overflow: hidden`).
  Pendiente de una comprobación visual real contra un dosier generado — no
  se pudo verificar en vivo desde aquí.
- "GESTIÓN DEFENSIVA V2" en 0 y DEFENSIVOS/PREVENCIÓN vacíos: confirmado por
  diseño para muertes de causa no verificable (`Unknown Ability`) — un 0 así
  puede ser un resultado legítimo, no un bug de denominador. Además del toggle
  de abajo, no se tocó nada aquí sin una revisión con datos reales de la card
  concreta.
- Nuevo toggle "Defensivos: plan v2 / uso real observado" en la barra de
  herramientas de la infografía (solo visible si existe una generación v2 de
  la que alejarse). No inventa una fórmula nueva: fuerza
  `defensiveManagementV2()` a `null`, y TODO lo que ya dependía de
  `v2 ?? legacy` en este componente, `evidenceProjection()` y `v3ViewModel()`
  cae automáticamente al mismo cálculo legacy que ya existía (casts reales
  observados) — a demanda del oficial, no solo cuando el flag está apagado.
- 3 muertes "Causa no identificada" en The Coiled Altar: confirmado que es el
  comportamiento correcto y deliberado (no se inventa una causa que WCL no
  dio) — no es un bug.
- Retirada la frase global "Algunas cards se basan en menos datos..." de la
  card "Calidad de evidencia" (ya reescrita una vez el mismo día citando la
  misma queja, seguía sin ser útil) — cada card ya lleva su propio
  `confidenceLabel`. El hueco pasa a describir la métrica en sí, igual que
  sus dos hermanas.
- Rosco de las métricas hero: antes un `conic-gradient` de 2 tonos planos: sin
  degradado real por porcentaje. Ahora interpola verde→rojo por `%` real
  (`metricRingColor()`, hue 120→0) solo para las métricas con `%` genuino
  (ejecución/gestión defensiva); "calidad de evidencia" (categórica) sigue con
  su tono fijo. Aro más grueso (hueco interior 79%→62%) + inset-shadow para
  dar relieve — pendiente también de una comprobación visual real.
- Cabecera con degradado de color de clase: `--class-accent` ya lo calculaba
  correctamente el componente anfitrión a partir de la clase cruda de WCL
  (no de un nombre ya traducido) — solo hacía falta usarlo también en el
  fondo de `.iris-v3-identity`, reutilizando la misma variable que
  `.iris-v3-player-copy` ya consumía.
- Contraste: se encontraron media docena de grises casi-duplicados sueltos
  por todo el archivo (`#8b98a3`, `#85929d`, `#8997a2`...), varios más
  oscuros que el propio token `--iris-muted` y usados en el texto más pequeño
  (9-10px, descripciones/subtítulos). Consolidados todos en `--iris-muted`,
  que además subió de `#9ca8af` a `#b6c1c8`.
- Piedra de brujo/poción de vida: `usedHealthstoneInPull`/
  `usedHealthPotionInPull` ya existían en `NightDeathRow` (usados en texto
  narrativo de `pull-analysis.service.ts`) pero no aparecían en ningún sitio
  de la infografía. Añadido como nota factual en la observación de las cards
  de muerte legacy — solo se afirma el caso positivo ("usó piedra de
  brujo/poción"), nunca se interpreta `false` como una omisión, porque estos
  dos booleanos no distinguen "no tenía" de "no la usó". El seguimiento de
  pociones de combate/prepot (ofensivas) no existe en ningún sitio del código
  — necesita ingesta nueva de casts de WCL, queda fuera de este corte.

Validación de este corte: `ng build` sin errores (mismos warnings de tamaño
ya inventariados); `vitest run` completo 163/178 (mismo baseline exacto que
el corte anterior — 1 test de `raider-infographic-view-model.spec.ts` se
actualizó para incluir el nuevo campo `coachingDensity`, sin cambiar su
intención); `verify:causal-schema` y `verify:defensive-contract`: PASS.
Migración `20260903120000` (tabla nueva, aditiva) y `20260903130000`
(limpieza de datos, con verificación) aplicadas a remoto; Edge Function
`save-planning-resource-selection` desplegada.

**Pendiente de acción/decisión del usuario:**
- Confirmar o corregir en WoWAudit el nombre `Teqi`/`Colakao` (o resincronizar
  el roster) — sin esto, Preparación seguirá sin poder resolver su spec.
- Decidir si se quiere el fix de fondo de `specApplies()` para spec
  desconocida (sube el resolver a 2.2.0, dispara el mismo mecanismo de
  "fuera de v2 hasta reanálisis" que ya se vio con el evaluator) — no
  implementado en este corte a la espera de esa decisión.
- Verificar visualmente (dosier real) las cards de coaching a 4 y el nuevo
  rosco con degradado — no se pudo confirmar el resultado visual desde aquí.

### 2026-09-03 — Layout dinámico de la infografía V3 y "0% de gestión
defensiva" irreal (evaluator@2.4.0)

Dos reportes en vivo sobre la infografía V3: (1) hueco en blanco grande
encima del pie en ambas páginas, dependiente de cuántas cards hay; (2) el
hero "Gestión defensiva V2" de Gusmï marcaba 0%, cuando el cálculo legacy da
~30% esa misma noche — contradicción que el propio usuario señaló como
prueba de que el número nuevo es irreal, pidiendo explícitamente "buscarle la
lógica" con los datos de mecánica/daño ya disponibles y "al margen de la
nota de MRT", más una exigencia explícita: *"cuando decimos que es un 0
tiene que ser una comprobación 100% real de que no ha usado ningún
defensivo ante ningún daño."*

**Layout dinámico** — `.iris-v3-spread`/`.iris-v3-page`
(raider-infographic-v3-canvas.component.scss) tenían altura fija
(2160px/2140px) + `overflow:hidden`; una noche con pocas cards dejaba un
hueco muerto fijo encima del footer (`margin-top:auto`). Pasan a
`min-height` únicamente — el grid (`align-items:stretch`, por defecto) iguala
las dos páginas a la más alta, la más corta gana el margen extra vía el
mismo `margin-top:auto` que ya tenía el footer, sin JS de por medio.
`night-player-infographic.component.ts` `calculateFitScale()` usaba una
constante fija `V3_SPREAD_HEIGHT=2160` para el zoom de vista previa; ahora
usa `sheetHeight()` (medición real por `ResizeObserver`, la misma que ya
usaba el lienzo legacy) — constante eliminada.

**Causa raíz real del "0%"** (confirmada contra producción, no hipótesis):
consulta a `player_pull_defensive_evaluations` para Gusmï/`7GbANtw1J2pjZzH9`
mostró las 13 pulls en `mode:'no_plan'` con cada evento no vacío
`missed_extra_opportunity`, nunca `safe_extra_use` → score exacto 0%. Pero
`player_pull_records.defensive_casts` para esas mismas pulls muestra Barkskin
real 2-3 veces por pull y Frenzied Regeneration — coincide con el ~30%
legacy. Encontrado el bug exacto en `observedCasts()`
(`defensive-execution-persistence.ts`): WCL registra `targetName:
"Environment"`, `targetActorId: -1` en autolanzamientos — el sentinel de
"sin objetivo real", no un jugador ajeno. El código lo trataba como "objetivo
real confirmado que NO es este jugador" (`targetPlayerKey: null`), así que
`castAppliesToSelfOrSlot()` (`defensive-execution-evaluator.ts`) descartaba
el cast entero para cualquier defensivo de objetivo `'self'` — Barkskin real
quedaba invisible para el evaluador. Comparte código con `evaluateSlot()`
(camino CON plan), así que también puede haber restado `plan_covered` reales
a jugadores con plan publicado.

**Corregido en `defensive-execution-evaluator@2.4.0`** (evaluator +
persistencia, subida y reanálisis pendiente igual que el salto 2.2.0→2.3.0):
1. Sentinel "Environment"/`targetActorId -1` → `targetPlayerKey: undefined`
   (no `null`) en `observedCasts()`.
2. `requirementLevel` real para ventanas sin plan: antes fijo en
   `'recommended'` para toda ventana; ahora sale de
   `boss_mechanic_defensive_planning_view` con la MISMA fórmula que ya usa
   el solver (`generate-defensive-plan/index.ts`). **Verificado contra
   producción y corregido un efecto colateral real**: "The Coiled Altar"
   Normal no tiene ninguna fila curada todavía — sin fila, el código
   degradaba a `'optional'` (peso 0, excluido), lo que habría borrado del
   todo el uso real que el fix del sentinel acababa de recuperar. Corregido:
   sin fila curada → `'recommended'` (mismo comportamiento que había antes
   de este cambio); solo sube a `'required'` o baja a `'optional'` cuando SÍ
   hay una fila que lo respalde.
3. `peakValue` de la ventana de presión ahora viaja hasta
   `RaiderEvidenceItem.damageTotal` (antes fijo a `0` para `kind:'defensive'`)
   — hace posible identificar la mecánica de más daño sin defensivo.
4. Salvaguarda "0 verificado": en `evaluateUnplannedWindow()`/`evaluateDeath()`,
   si existe un cast propio real dentro de la ventana/secuencia letal que no
   quedó ya explicado como cobertura, se degrada a `uncertain_data` en vez de
   afirmar `missed_extra_opportunity`/`death_with_viable_cd` — cubre el bug
   del sentinel como caso concreto y cualquier otro motivo de no-match futuro.
- No hizo falta tocar `raider-evidence-projection.ts` ni el lienzo V3 para
  las cards: `missed_extra_opportunity`/`safe_extra_use`/`correct_hold` ya
  estaban completamente soportados (`KNOWN_DEFENSIVE_REASONS`,
  `decisionTitle`/`decisionAction`/`decisionPreventionKey`/`defensiveNames`)
  — las cards salían vacías solo porque el evaluador nunca producía esos
  estados; arreglado ahí, se propaga solo.

**Quitados los literales "V2"/"legacy" de la infografía** (feedback:
*"no debería existir el literal de defensivos V2... todo tiene que
adaptarse al nuevo"*) — `raider-infographic-view-model.ts` y
`night-player-infographic.component.html`: una sola etiqueta ("Gestión
defensiva") y textos que describen la métrica, nunca su procedencia interna.
El toggle (sesión anterior) pasa de "plan v2 / uso real observado" a
"automático / recuento directo" — mismo mecanismo, sin exponer versionado.

**Wipe calls en Pitpally** — el usuario no estaba seguro ("no sé si...").
Verificado el mecanismo: `evaluateDefensivePull` ya calcula
`evaluationCutoffMs` desde `wipe_call_signals.wipeCallStartMs` y lo aplica a
ventanas y muerte; un wipe call nunca invalida el pull entero a propósito
(solo recorta lo posterior). Muestreo exploratorio sobre pulls recientes de
Pitpally no encontró ningún evento evaluado posterior a su propio
`wipeCallStartMs`. **No verificado contra la noche exacta que el usuario
tenía abierta** (report code desconocido desde aquí) — pendiente de repetir
el chequeo evento a evento en cuanto se identifique.

Validación: `ng build` limpio (tras purgar `.angular/cache`, un fallo de
caché no relacionado); `vitest run` 163/178, mismo baseline exacto que el
corte anterior (0 regresiones); `verify:causal-schema` y
`verify:defensive-contract`: PASS. Migraciones no aplica (sin cambio de
esquema, todo lógica + una vista ya existente). Desplegadas
`analyze-report`, `evaluate-defensive-execution`,
`reanalyze-defensive-pressure` y `defensive-v2-readiness` (dos veces la
primera tanda de tres, tras la corrección del punto 2 encontrada durante la
propia verificación contra producción).

**Pendiente de acción del usuario**: disparar el reanálisis de
`7GbANtw1J2pjZzH9` (y del resto de reports que se quiera comparar) —
`evaluate-defensive-execution`/`reanalyze-defensive-pressure` exigen JWT de
oficial real, no se pudo disparar desde aquí. Tras reanalizar: confirmar que
Gusmï ya no marca 0% y que las cards de "Qué pasó y cómo corregirlo" traen
DEFENSIVOS/PREVENCIÓN CLAVE reales; repetir para Pitpally y de paso localizar
su noche exacta para el chequeo de wipe calls pendiente.

### 2026-09-03 — Defensivos: plan v3 (sustituye a "plan v2" de arriba)

El toggle "automático / recuento directo" (línea de arriba, sesión
2026-09-02/03) y el fallback `v2?.managementScore ?? nightReliability
?.breakdown.defensiva` que fuerza quedan **superados**: el catálogo de
defensivos tenía varias definiciones de "defensivo" coexistiendo (casts
observados, pressure windows, management V2, reliability legacy) que un
mismo raider podía cruzar con números completamente distintos sin cambiar
un solo cast — casos reales medidos: Pitpally 1.719→102 usos limpios,
Txerokee 836→22, Linkedara 1.734→150 tras aplicar solo la definición
correcta de "defensivo personal".

Plan integral (catálogo/semántica + Fiabilidad) consolidado en
[iris-defensive-canonicalization-v1-plan.md](iris-defensive-canonicalization-v1-plan.md).
El toggle y el fallback de arriba se retiran en el Paso F de ese plan
(cutover atómico) — no antes, para no dejar la infografía sin fallback
mientras la nueva generación todavía no está `PUBLISHED`.

Arrancado el Paso A-1 (migración SQL aditiva del catálogo) — ver el
registro de avance en el propio documento de plan, §8.
