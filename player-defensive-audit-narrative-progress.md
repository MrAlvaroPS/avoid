# Auditoría defensiva narrativa por jugador

Estado: implementación v8 en `feature/player-defensive-audit-narrative`;
corrección local del bloqueo de publicación automática pendiente de desplegar.

Este documento registra las dos revisiones independientes exigidas antes de
implementar. La fuente normativa sigue siendo
`iris-defensive-canonicalization-v1-plan.md`; este documento no crea otro
evaluador ni otra fuente de verdad.

## Restricciones confirmadas

- La nueva sección vive en `/report/:reportCode/player/:playerName` y no
  sustituye ni modifica la infografía defensiva existente.
- La narrativa solo proyecta hechos estructurados de la generación publicada.
  El frontend no puntúa, no clasifica casts y no interpreta prosa persistida.
- `Usage`, `Response` y `Management` mantienen las fórmulas canónicas. La
  auditoría muestra sus numeradores y denominadores; no introduce pesos.
- Un dato ausente, incompatible, parcial o incierto no genera culpa. Un estado
  parcial puede mostrar cobertura y hechos provisionales, pero no una
  narrativa definitiva y no se puede enviar a Discord.
- La población es exclusivamente la población canónica. `fight_id` identifica
  el fight de WCL; `pull_number` no se utiliza para construir enlaces.
- No se toca `defensive_generation_pointer` manualmente. Los cambios de
  contrato se publican únicamente mediante el ciclo validado de generaciones.
- Las habilidades citadas en aceptación son fixtures. La arquitectura no
  contiene nombres de clase, spec, habilidad ni spell IDs especiales.

## Revisión A: de WCL a la generación publicada

1. `canonical-defensive-refresh` obtiene de WCL `DamageTaken`, `Casts`, buffs y
   debuffs del fight real y normaliza sus timestamps restando `fight.startTime`.
2. `player_pull_records.defensive_casts` conserva, por pull y jugador, el
   nombre, spell ID y timestamps normalizados de los miembros del kit resuelto.
   Es una fuente de hechos de cast, no una fuente de scoring.
3. `canonical_scored_pulls` fija la población de pulls completa, no ninja y no
   excluida. `canonical_defensive_eligible_player_pulls` añade la participación,
   build, spec y fingerprint que exige el evaluador.
4. `pull_evaluation_context.evaluation_end_ms` fija el cutoff. Un episodio cuyo
   pico cae en o después del cutoff se persiste como `excluded`; la ausencia de
   evidencia nunca se convierte en fallo.
5. `resolveEffectiveDefensiveKit` es el dueño de pertenencia al build,
   semántica, applicability, cooldown, duración, cargas y recarga efectivos.
6. `evaluateDefensiveEpisodesForPlayer` detecta ventanas, las agrupa en
   episodios, calcula candidatos, timing y disponibilidad, y delega el
   veredicto a `resolveEpisodeVerdictWithCausalAvailability`.
7. `buildPersistedDefensiveEpisode` materializa el episodio completo en
   `player_pull_defensive_episode_evaluations`. `coveredBySpellId`,
   `decisiveSpellIds`, `uncertaintyBlockers`, candidatos y evidencias son la
   procedencia estructurada de la decisión. `responseReason` es solo texto
   explicativo y ningún consumidor nuevo lo analiza.
8. `defensive_generation_pointer` selecciona una generación `published`. Sus
   versiones y su población esperada deben coincidir con cada fila staging.
9. `peakValue` nace en `DamageWindow` y sobrevive a la agrupación en
   `DefensiveEpisode`, pero actualmente se pierde en
   `buildPersistedDefensiveEpisode`. Por tanto, la generación publicada no
   permite ordenar de forma canónica los episodios de mayor presión.
10. El candidato runtime lleva `castsForSpellMs` y `timing`, pero el contrato
    persistido los acepta hoy solo por compatibilidad estructural accidental.
    Tampoco persiste explícitamente cooldown/duración/cargas/recarga efectivos
    ni el resultado completo de disponibilidad por cargas. Eso impide construir
    una ventana de acción auditada sin recalcular semántica aguas abajo.

Conclusión A: la identidad del episodio y el veredicto ya son reutilizables. La
proyección narrativa exige un cambio aditivo y versionado que persista
`peakValue` y un snapshot explícito de hechos temporales/de recurso por
candidato. No es válido reconstruirlos desde ventanas legacy ni en Angular.

## Revisión B: del dosier de vuelta a WCL

1. `NightPlayerDossierComponent` consume un único `NightPlayerSummary`.
2. `NightPlayerSummaryService` carga pulls, records, encuentros y la vinculación
   de Discord del personaje. Calcula el ordinal visual por boss con
   `validAttemptOrdinal`; cada pull conserva además el `fightId` real.
3. `CanonicalDefensiveSummaryService` resuelve
   pointer → generación publicada → población canónica → staging. Relee el
   pointer para detectar cambios concurrentes y falla cerrado ante contratos
   incompatibles.
4. El servicio agrega `Usage` y `Response` con
   `aggregateDefensiveEpisodeKpis`, la misma función pura del evaluador. El
   estado `partial` declara exactamente `evaluatedPulls/expectedPulls`.
5. `NightPlayerSummaryService` enriquece cada episodio solo para presentación:
   boss, dificultad, ordinal del pull y nombre/nota de mecánica. Actualmente no
   añade `fightId` al episodio, aunque el pull que lo origina sí lo conserva.
6. La infografía consume `canonicalDefensive`; no debe alterarse. La auditoría
   será una proyección hermana del mismo pointer/generación, no un scoring
   alternativo.
7. Para volver al hecho crudo se usa
   episodio → `pullId` → pull → `fightId` → URL WCL. Para volver al cast se usa
   candidato/relación temporal estructurada → `defensive_casts` del mismo
   player/pull → timestamp relativo. Nunca se cruza por nombre ni por prosa.
8. `discord_roster_channels` vincula el personaje con su canal. El endpoint
   existente valida guild pero acepta un `channelId` del cliente y un único
   mensaje. La nueva ruta debe resolver el canal del personaje en servidor,
   enviar partes ordenadas con `allowed_mentions: { parse: [] }` y conservar la
   API antigua para los consumidores existentes.

Conclusión B: la integración correcta es una proyección de lectura en backend
que devuelve un contrato narrativo/AST tipado al `NightPlayerSummary`. Angular
solo renderiza ese AST. El envío Discord usa el mismo AST con otro renderer y
el servidor comprueba la vinculación del personaje.

## Reconciliación empírica de casts

Informe `TvZnzN16tKPdVp2D`, población exacta de 20 pulls canónicos:

| Jugador     | Divine Protection (403876) | Divine Shield (642) |
| ----------- | -------------------------: | ------------------: |
| Ssquall     |                         57 |                   8 |
| Helssipanki |                         55 |                   6 |

La consulta de eventos WCL y la tabla visible de casts de WCL coinciden. No hay
timestamps duplicados para Divine Protection y el fight ninja no aporta casts
de esa habilidad. La cifra manual “52” no puede reconstruirse con este alcance:
es un recuento externo o de alcance distinto y no se utilizará en la narrativa.
Antes de publicar ejemplos finales se volverán a comparar estos totales con
`player_pull_records.defensive_casts` y con la proyección de auditoría.

## Diseño que se implementará

- Extensión aditiva del snapshot candidato/episodio y nuevo evaluator versionado.
- Proyector puro backend: casts → asociaciones → clasificación primaria exacta
  (`effective`, `relevant_ineffective`, `relevant_uncertain`,
  `outside_pressure`, `excluded`) más dimensión separada `core`/`credit_only`.
- `actionableTimingWindow` puro, basado solo en timing, duración, cutoff,
  cooldown/cargas y confianza persistidos. Evidencia débil devuelve `unknown`.
- Invariantes reconstruibles: partición exacta de casts; episodios/candidatos
  únicos; `coveredBySpellId` dueño exclusivo de cobertura; alternativa solo con
  membership, applicability y disponibilidad suficientemente fuertes.
- AST semántico único. Renderer Angular sin `innerHTML` y renderer Discord por
  bloques semánticos. El chunker nunca corta enlaces ni supera 2.000 caracteres.
- Estados explícitos `available`, `partial`, `unavailable`, `incompatible` y
  `error`; Discord deshabilitado salvo `available` y canal vinculado.
- Invalidación de caché por fingerprint/versiones de generación y auditoría.
- Verificador estático contra nombres/spell IDs/clases en el código genérico.

## Revisión de contradicciones

No se ha encontrado una contradicción entre la tarea y el plan canónico. Los
dos huecos descritos arriba son carencias de persistencia, no instrucciones
incompatibles. Se resolverán de forma aditiva; si la generación publicada no
contiene el nuevo contrato, el estado será `incompatible` y no se narrará.

## 2026-09-10 — incidente KPI N/D tras desplegar evaluator v8

### Evidencia observada en producción

- `defensive_generation_pointer` seguía apuntando a
  `44b0f9ff-afba-45f0-b900-73ceb9842a7c`, generación v7 publicada el
  2026-09-08 07:36:29 UTC.
- Existía una generación privada `building`
  `a4cfc6b9-58dc-4ce5-9f76-d18562f1657e`, también v7, con 78/91 pulls y
  1745/2057 filas jugador×pull seguras. Le faltaban exactamente 13 pulls y
  312 filas.
- El report nuevo `VNvX3MqWxZ9jhT6d` tenía 13 pulls canónicos, 25 jugadores
  y 312 filas elegibles. Su request automática agotó 5 intentos y quedó
  `blocked` con error de `canonical-defensive-refresh start`.
- Caso individual comprobado: `Gusmï` tenía 6 pulls esperados y 0/6 filas
  tanto en la generación publicada como en la `building`. El frontend debía
  devolver `incompatible` y `N/D`; no era correcto inventar un porcentaje.
- La función desplegada era `canonical-defensive-refresh@2`, evaluator v8,
  mientras la única `building` era evaluator v7. El RPC anterior rechazaba
  siempre esa combinación con una generación de contrato distinto. La cola no
  podía progresar y el pointer, correctamente, no se movía sin completitud.
- El fingerprint del dosier ya incluye `published_generation_id` y
  `defensive_generation_pointer.updated_at`; la caché se invalida cuando el
  pointer cambia. La causa primaria de este incidente no era la caché.

### Corrección implementada

- Migración
  `20260910001000_canonical_defensive_contract_upgrade_recovery.sql`:
  arranque version-aware, retiro auditable de una `building` privada
  incompatible, protección por lease, enlace atómico cola↔generación,
  reencolado de requests bloqueadas que todavía necesitan refresh y wake-up
  best-effort. No escribe `defensive_generation_pointer`; la publicación
  sigue pasando por `publish_complete_defensive_generation` y sus gates.
- `canonical-defensive-refresh`: el `start` devuelve la identidad de
  generación sin depender de una lectura accesoria de coverage y conserva los
  errores estructurados de PostgREST en vez de reducirlos a `[object Object]`.
- `canonical-defensive-auto-refresh`: pasa su lease al worker para permitir la
  transición atómica y conserva el bind antiguo como comprobación idempotente
  compatible con despliegues escalonados.
- `scripts/verify-canonical-defensive-auto-refresh.mjs` amplía el contrato
  estático con las invariantes de upgrade, lease, no-escritura del pointer y
  conservación del ID antes de coverage.

Durante la recuperación aparecieron otros bloqueos sistémicos que también se
corrigieron:

- el lease expirado tenía una referencia SQL ambigua a `lease_token`;
- una continuación fire-and-forget podía perderse después del último pull;
- el despacho `pg_net` agotaba sus 5 segundos cuando intentaba ejecutar todo
  el drain dentro de la petición;
- el gate de publicación repetía un cálculo de coverage costoso y podía agotar
  el statement timeout de PostgREST;
- un lease expirado podía volver a la cola sin respetar el presupuesto de
  reintentos;
- preparar el ledger de una noche podía resetear el lease vivo de otro worker;
- los flujos de importación y envío masivo no esperaban conjuntamente a
  ingesta, ledger y generación defensiva canónica.

Las siete migraciones `20260910001000` a `20260910112058` resuelven esos casos
de forma aditiva. `canonical-defensive-auto-refresh` deployment v6
(`canonical-defensive-auto-refresh@2` como versión de aplicación),
`canonical-defensive-refresh@12` y `process-combat-evaluation-queue@6` están
desplegadas con verificación JWT. El dispatcher de base de datos usa un JWT
anon cifrado en Vault para atravesar el gateway y conserva un segundo secreto
interno `x-iris-dispatch-token`; el endpoint de ejecución no es público.

La publicación no actualizó el pointer manualmente: el worker llamó al gate
canónico y éste publicó la generación únicamente después de verificar su
completitud. El backend y las migraciones están desplegados en producción. La
barrera Angular de importación/envío masivo permanece local hasta desplegar
esta rama; el repositorio no contiene un destino de hosting enlazado que
permita publicarla de forma segura desde este entorno.

### Barrera E2E para informes nuevos

- La importación manual ya no termina al descargar WCL: espera a que la ingesta
  quede completa, prepara/procesa el ledger específico del report y espera a
  la generación defensiva publicada.
- La preparación del ledger es atómica y service-only: reencola filas
  ausentes/antiguas sin tocar un job que tenga un lease vivo.
- El worker defensivo puede reanudarse aunque se pierda una continuación; el
  cliente sondea y vuelve a despertar el drain de forma acotada.
- El sondeo de readiness consulta la request exacta del report y sólo calcula
  el coverage exhaustivo cada diez segundos, evitando cargar la base de datos
  una vez por segundo mientras el worker sigue activo.
- Tanto `Actualizar infografías` como `Enviar todas` atraviesan la barrera. El
  envío materializa y valida todas las infografías enviables antes del primer
  mensaje a Discord; si una sola tiene cobertura parcial, generación distinta
  o error, no envía ninguna.
- Un KPI individual puede seguir siendo `N/D` de forma legítima cuando no hay
  oportunidad evaluable. La barrera comprueba cobertura e identidad de
  generación, no fabrica porcentajes.

### Verificación empírica en producción

- El worker publicó automáticamente la generación v8
  `5c7b8864-2d51-4a65-aea5-32756d7e04b8` el
  2026-09-10 11:18:01 UTC. La request terminó `completed` y
  `needs_refresh = false`.
- Cobertura global: 91/91 pulls, 2057/2057 filas jugador×pull y 3292/3292
  eventos de ledger; cero pulls/filas/eventos ausentes, huérfanos o con deriva
  de versión.
- Report `VNvX3MqWxZ9jhT6d`: 13/13 pulls y 312/312 filas elegibles, sin filas
  ausentes.
- `Gusmï`: 6/6 pulls, cuatro episodios canónicos; Usage 0/3 y Response 0/3
  (`missed_ready` ×3 y `uncertain` ×1). Ahora obtiene un 0 % reconstruible en
  ambos KPI, no `N/D`. Management permanece `N/D` porque no existe un plan
  defensivo publicado, que es el resultado correcto según contrato.

### Validación local ejecutada

- La migración se aplicó en un PostgreSQL desechable reproduciendo una
  generación v7 obsoleta y una petición bloqueada: retiró la `building` con
  auditoría, creó la v8, reencoló la petición y mantuvo el pointer intacto.
  También se comprobó el reemplazo v8 → v9 por el mismo propietario de un
  lease vivo y su enlace atómico a cola/runtime.
- El RPC atómico de readiness se probó contra PostgreSQL 17: reencoló dos jobs
  ausentes/antiguos, conservó intacto un job con lease vivo y sólo quedó
  ejecutable por `service_role`.
- La nueva implementación de coverage se comparó transaccionalmente en
  producción con la anterior: JSON exactamente idéntico; redujo los shared
  buffer hits de 144.346 a 41.501 y los bloques temporales de 37.212 a 12.404.
- Vitest dirigido: 10 archivos y 134/134 tests correctos.
- `node scripts/verify-canonical-defensive-auto-refresh.mjs`: correcto.
- `npm run verify:defensive-contract`: correcto.
- `npm run verify:causal-schema`: correcto.
- `npm run verify:causal-runtime`: correcto (17 Edge Functions y 3 suites
  Deno).
- `npm run build`: correcto; conserva únicamente los avisos de presupuesto de
  bundles/SCSS ya existentes.
