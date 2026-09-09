# Auditoría defensiva narrativa por jugador

Estado: análisis previo completo; implementación local pendiente en
`feature/player-defensive-audit-narrative`.

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

| Jugador | Divine Protection (403876) | Divine Shield (642) |
| --- | ---: | ---: |
| Ssquall | 57 | 8 |
| Helssipanki | 55 | 6 |

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

