# IRIS — Defensive Canonicalization v1

Plan único (catálogo/semántica defensiva + Fiabilidad) para terminar con las
múltiples definiciones de "defensivo" que coexisten hoy en IRIS
(`player_pull_records.defensive_casts`, `defensive_pressure_windows`,
`player_pull_defensive_evaluations`, la fiabilidad legacy y el fallback
silencioso `managementScore ?? nightReliability.breakdown.defensiva`).

Origen: propuesta completa del usuario (catálogo/semántica, 46 secciones) +
adenda sobre Fiabilidad (33 secciones), ambas revisadas dos veces contra el
código real de `feature/mechanics` antes de escribir nada. Las correcciones
encontradas en esa revisión ya están integradas en este documento (ver §4);
no se repiten las dos propuestas originales palabra por palabra.

Este documento sustituye, como plan a seguir, cualquier mención anterior de
"Defensivos: plan v2" en `iris-mechanics-audit-remediation-progress.md`.

## 0. Objetivo

Que un porcentaje mostrado al raider (dossier, roster, night report,
fiabilidad) tenga siempre numerador y denominador reconstruibles, una única
definición de "defensivo personal", y ninguna ruta de fallback silenciosa
entre generaciones/algoritmos bajo la misma etiqueta.

Aplica a **todos** los raiders/clases/specs — los siete jugadores citados en
la propuesta original (Gusmï, Magzil, Pitpally, Rivax, Wargreymon, Txerokee,
Linkedara) son solo el corpus de validación empírica y de fixtures (§7).

**Filosofía de entrega (fijada 2026-09-04, tras revisión completa):** no se
persigue un MVP. El objetivo es una primera baseline canónica
suficientemente completa para que, al hacer el cutover, la infografía del
raider, Night Report, Roster y Fiabilidad sean **utilizables, reales,
auditables, normalizadas entre clases/specs y sin ningún fallback legacy**
— no una versión provisional llena de `uncertain` que se arregle después
de publicar. Se termina bien la fuente única de verdad y se publica solo
cuando puede sustituir por completo al sistema antiguo. Después se
enriquece; no se vuelve a crear una generación V2/V3/V4 paralela.

**Criterio final de éxito** — no se considera terminado este documento
porque el pipeline nuevo funcione técnicamente. Se considera terminado
cuando se pueden apagar las fuentes defensivas legacy y seguir produciendo
una infografía/Night Report/Roster/Fiabilidad que sean veraces,
reproducibles, auditables, normalizadas entre clases/specs, build-aware,
causalmente coherentes, sin penalizaciones basadas en incertidumbre y sin
fallbacks entre algoritmos. Ante cualquier porcentaje mostrado a un raider
debe poder responderse: qué eventos forman su numerador, qué eventos
forman su denominador, por qué cada episodio entró o quedó fuera, y qué
evidencia respalda cada fallo.

## 1. Modelo semántico: qué es un defensivo personal

> Un defensivo personal es una habilidad activada deliberadamente por el
> jugador cuya decisión defensiva está anclada sobre sí mismo y que le
> proporciona directamente mitigación, absorción, sustain/autocuración,
> inmunidad, avoidance o salud efectiva. No debe poder utilizarse
> voluntariamente sobre otro jugador como destinatario principal. Un efecto
> secundario automático sobre terceros no invalida su carácter de defensivo
> personal (caso Anti-Magic Shell: propaga automáticamente a un aliado, pero
> el jugador no lo elige como objetivo — sigue siendo personal).

Dimensiones independientes por habilidad:

- **`usageRole`**: `personal_survival` · `survival_state` · `active_mitigation`
  · `rotational_survival` · `healer_throughput` · `external` ·
  `raid_defensive` · `utility` · `unknown`.
- **`activationScope`**: `self` · `ally_selectable` · `enemy` · `ground` ·
  `raid` · `unknown`. (Sustituye a la pareja `activationScope`+`allySelectable`
  booleana de la propuesta original — ver §4.1, eran redundantes.)
- **`secondaryPropagation`**: `none` · `automatic_ally` · `automatic_party` ·
  `automatic_raid`.
- **`mechanisms[]`**: `mitigation` · `absorption` · `sustain` · `immunity` ·
  `avoidance` · `effective_health`.
- **`opportunityMode`**: `normal` · `credit_only` · `none`.

### Quedan fuera del KPI general (pero no del contexto de supervivencia)

- **Active mitigation** de tank (SotR, Ironfur, Shield Block, Demon Spikes...)
  → `usageRole = active_mitigation`. Mantenimiento rotacional, no cooldown
  estratégico; vive en un módulo de tank aparte, no en el Response general.
- **Rotational survival** (Death Strike) → `activationScope = enemy`,
  `usageRole = rotational_survival`. Cura, pero se lanza contra un enemigo y
  es parte de la rotación/recursos, no una decisión defensiva discreta.
- **Healing/throughput libremente targeteable** (Riptide, Flash Heal, Word
  of Glory...) → `usageRole = healer_throughput`. Criterio: si el jugador
  puede elegir a otro como destinatario, no es parte del kit personal.
- **Externals** (Guardian Spirit, BoP, BoSac) → `usageRole = external`.
- **Raid CDs** (Spirit Link, Anti-Magic Zone, Healing Tide) →
  `usageRole = raid_defensive`.
- **Pasivos** → nunca generan `missed_ready`; como mucho alimentan contexto
  de letalidad.

### Survival states (Bear Form y equivalentes)

`usageRole = survival_state`, `opportunityMode = credit_only`: su mera
disponibilidad no crea oportunidades perdidas (casi siempre está
disponible), pero un uso correcto durante un episodio de presión sí puede
resolverlo. `credit_only` nunca fabrica un denominador nuevo por sí solo.

## 2. Arquitectura técnica

No se crea un "sistema V4" paralelo: se transforma el resolver +
`execution-ledger` existentes en la única verdad. Reutiliza lo ya construido
(`effective-defensives@2.1.0`, build fingerprints, spec profiles, modifier
rules, causal groups, ledger con verdict/reasonCode/evidence/confidence).

```text
RAW WCL FACTS → CANONICAL PULL SCOPE → ABILITY CATALOG + IRIS SEMANTIC
POLICY + PLAYER BUILD → EFFECTIVE PERSONAL DEFENSIVE KIT → MECHANIC/DAMAGE
APPLICABILITY → DEFENSIVE EPISODES → AVAILABILITY + EFFECT EVIDENCE →
CANONICAL VERDICTS → EXECUTION LEDGER → RESPONSE / USAGE / PLAN →
NIGHT PLAYER SUMMARY → FRONT
```

### 2.1. DB — tabla compañera, no editar `cooldown_catalog` fila a fila

`cooldown_catalog` se queda como *facts* (sincronización externa). Nueva
`defensive_ability_semantics` (1:1 con `cooldown_catalog`, ver §4.2 para el
esquema exacto ya aplicado) guarda la *semántica IRIS*. Una sincronización
externa puede volver a decir "Barkskin ahora dura X"; nunca puede volver a
decidir "Riptide ahora es personal defensive" — la separación física de
tablas hace esa frontera difícil de romper por accidente.

`defensive_semantic_rules`: modificadores por build/talento sobre la
semántica (ej. Refractive Images convierte Mirror Image de `utility` a
`personal_survival` + `mitigation`; Ice Cold reemplaza/suprime Ice Block).

Membership **derivada**, nunca un booleano editable directamente — ver la
vista `defensive_ability_semantic_catalog` en §4.2, con dos predicados (no
uno, ver §4.1):

- `is_defensive_kit_member` → alimenta "Uso observado" y puede resolver un
  episodio ya evaluable. Incluye `personal_survival` y `survival_state`.
- `creates_missable_opportunity` → el único que puede generar `missed_ready`.
  Excluye `survival_state` (Bear Form no fabrica fallos).

Una habilidad nueva nace **pendiente**, nunca defensiva por defecto (se
elimina el `default 'personal_defensive'` de `cooldown_catalog.category`,
ver §4.2 — ya no era editable como verdad de producto de todas formas, la
verdad vive ahora en `semantic_status`).

### 2.2. `resolveEffectiveDefensiveKit()` como puerta canónica única

Amplía su contrato actual (spec/talentos/build/modifiers/cooldown/duración/
charges/activación/targeting/eligibility) para resolver también
`effectiveUsageRole`, `effectiveMechanisms`, `effectiveActivationScope`,
`effectiveSecondaryPropagation`, `effectiveOpportunityMode`. Ningún
consumer (`analyze-report`, `reanalyze-defensive-pressure`, death evaluator,
pressure evaluator, Preparación, infografía) vuelve a leer
`cooldown_catalog.category` directamente para decidir si algo es defensivo.

### 2.3. Población de pulls única

`canonical_scored_pulls` (view/función): `ingestion_status = complete`,
sin ninja pulls, sin exclusiones ad-hoc por consumer. Ningún evaluator
defensivo construye su propio `WHERE` de pulls (bug real ya encontrado: un
consumer veía 16 pulls, otro 13, con pulls `ingestion_status = failed` que
sin embargo ya tenían evaluación defensiva).

### 2.4. `DefensiveEpisode` sustituye a "pressure window puntuable"

El detector actual de pressure windows (baseline propia del jugador × 2.5)
se conserva **pero deja de puntuar directamente** — pasa a ser generador de
*candidatos*. Se agrupan por mechanic occurrence/habilidad/fase/target/
causal group (no una regla mágica de "6 segundos") en un `DefensiveEpisode`:
una decisión del jugador, aunque contenga varios ticks/buckets.

Cada episodio termina en un estado canónico:

| Estado | Significado | ¿Entra en score? |
|---|---|---:|
| `covered_verified` | respondió correctamente | ✅ éxito |
| `missed_ready` | opción aplicable y lista, no respondió | ✅ fallo |
| `missed_due_to_mistime` | la gastó mal antes y por eso no llegó | ✅ fallo |
| `unavailable_legitimate` | en CD por un uso razonable previo | ❌ |
| `no_applicable_resource` | su build no tenía herramienta adecuada | ❌ |
| `uncertain` | no se puede demostrar qué ocurrió | ❌ |
| `excluded` | no puntuable por política/contexto | ❌ |

Regla fundamental: **la ausencia de evidencia no se convierte en culpa.**
`pending`/`uncertain` nunca penaliza.

Aplicabilidad daño↔defensivo (`canDefensiveCover(defensive, episode)` →
yes/no/unknown + reason) evita que, p. ej., una ventana de daño físico
exija AMS, o que Evasion penalice contra algo no dodgeable. `unknown` nunca
crea `missed_ready`.

Evidencia jerarquizada para decidir cobertura: Nivel 1 aura/absorb real
observado > Nivel 2 cast + naturaleza del spell garantiza protección >
Nivel 3 cast + duración teórica. Se tolera más inferencia para dar crédito
que para penalizar.

Disponibilidad reconstruida causalmente: si un recurso estaba en CD, hay
que enlazar con el cast anterior — si cubrió una amenaza real (otro
episodio anterior demostrable), `unavailable_legitimate`. **`missed_due_to_mistime`
exige evidencia POSITIVA de mal uso** (reserva rota, asignación de plan
incumplida, gasto demostrable sin amenaza) — la mera ausencia de un
episodio anterior que lo explique NO es esa evidencia (caso real: daño
sostenido o mecánicas, sobre todo en Mythic, que el detector de candidatos
nunca llega a convertir en `DefensiveEpisode`); sin esa fuente, degrada a
`uncertain`. `missed_due_to_mistime` queda definido en el contrato pero
solo lo puede producir un evaluator con acceso a esa evidencia positiva
(el de Plan, o una fuente futura) — la reconstrucción causal puramente
temporal nunca lo emite por su cuenta.

El veredicto pertenece al **episodio completo**, no a un spell aislado: si
Barkskin estaba legítimamente en CD pero Frenzied Regeneration seguía
listo, el episodio es `missed_ready` (había alternativa), no
`unavailable_legitimate` — la comprobación de "¿hay algo ready?" se hace
sobre todo el kit antes de intentar explicar por qué lo que sí está en CD
lo está.

**Fail-closed de cargas** (`charges > 1`): el modelo de disponibilidad
actual (`defensiveStatusAt`, reutilizado tal cual) no reconstruye cuántas
cargas quedan, solo el último cast — con más de una carga, un
"on_cooldown" puede ser falso (podría quedar una carga libre). En vez de
arreglar un sistema de cargas completo ahora, `charges > 1` +
"aparentemente on_cooldown" degrada explícitamente a `unknown`: nunca
puede producir `missed_ready` ni entrar en la reconstrucción causal como si
supiéramos que estaba indisponible. Esto satisface el gate de READY sobre
cargas (§2.7) por construcción — no es deuda oculta, es la resolución
correcta mientras no exista reconstrucción real de cargas.

#### 2.4.1. `DamageDescriptor` real — requisito de cutover, no deuda estructural

`canDefensiveCover()` (`defensive-applicability.ts`) ya está construido y
testeado, pero sin una fuente real de `DamageDescriptor` degrada casi todo
a `unknown` — lo cual es seguro (nunca fabrica un `missed_ready` falso)
pero **no basta para el cutover**: no se busca una enciclopedia perfecta
de todas las mecánicas de WoW, pero sí lo suficiente para que la
aplicabilidad deje de ser sistemáticamente `unknown` en los mecanismos que
el catálogo semántico ya reconoce.

**Facts mínimos a extraer/derivar de WCL antes del cutover** (prioridad:
datos reales WCL + mechanic policies/metadata ya verificadas; nunca
inferir un `no` por simple ausencia de observación — eso sería fabricar
certeza donde no la hay):

- ability/spell ID causante del daño;
- school (physical vs magic, y la school concreta cuando el mecanismo lo
  exija — ver AMS);
- alcance AoE/single cuando pueda demostrarse;
- direct/periodic;
- source actor, cuando el mecanismo lo requiera (ver Fiery Brand-style,
  `requiresSourceAffectedBySpell`);
- dodge/parry/block, para los mecanismos de `avoidance` (ver Evasion);
- compatibilidad con inmunidad, cuando sea necesaria para decidir una
  penalización.

**Criterios de aceptación concretos** (los mismos casos que ya sirven de
fixture en §7, ahora con datos reales en vez de asumidos):

- AMS nunca genera un miss contra daño físico demostrado.
- Evasion nunca genera un miss si la dodgeability no está demostrada.
- Feint solo se valora donde su efecto sea realmente aplicable.

**Gate explícito**: si al terminar esta pieza una clase/spec del corpus
real queda sistemáticamente `uncertain` porque falta un descriptor
CONOCIDO que se podría implementar (no porque el caso sea genuinamente
ambiguo), el plan no está terminado — ver el gate 5/informe de coverage
en §2.7. `uncertain` es para incertidumbre real, no para trabajo pendiente
disfrazado de incertidumbre.

### 2.5. Los tres KPI defensivos (revisión 2026-09-04)

**Corrección de fondo respecto a una decisión anterior de este documento**:
Uso defensivo dejó de ser "solo información descriptiva" — pasa a ser un
KPI real, independiente, calculado sobre el mismo `DefensiveEpisode` que
Respuesta. Los dos preguntan cosas distintas y un raider necesita ver
ambas por separado:

| KPI | Pregunta | Importancia |
|---|---|---|
| **Uso defensivo** | ¿Está utilizando sus herramientas cuando tiene una oportunidad real? | Secundario |
| **Respuesta defensiva** | ¿Lo que usó (o no usó) resolvió la presión evaluable? | **Principal** |
| **Gestión defensiva** | ¿Cumple sus asignaciones y preserva las reservas del plan? | Secundario / N/D sin plan |

Los tres se derivan del **mismo** `DefensiveEpisode`/ledger — nunca de tres
evaluators independientes que puedan divergir entre sí (exactamente el
problema que abrió este documento, §1).

Ejemplos que demuestran por qué Uso y Respuesta deben ser independientes:

- Barkskin correcto → Uso ✅ · Respuesta ✅.
- Barkskin demasiado pronto, no cubre → Uso ✅ · Respuesta ❌.
- Tenía Barkskin listo y no pulsa nada → Uso ❌ · Respuesta ❌.
- Usa un defensivo pero es el equivocado (aplicabilidad confirmada `no`) →
  Uso ✅ · Respuesta ❌.
- No tenía ninguna herramienta aplicable → no entra en ninguno de los dos.
- Todo estaba legítimamente gastado antes → no entra.
- Evidencia insuficiente → no entra.

Con esto, un raider puede leer **"Uso 92% · Respuesta 61%"** y entender de
inmediato: *sí estoy pulsando defensivos; mi problema es elegir/temporizar
el correcto* — un diagnóstico que un único número nunca podría dar.

#### 2.5.1. Uso defensivo

$$
Uso = \frac{episodios\ con\ engagement\ defensivo\ (usageEngaged)}{episodios\ donde\ realmente\ podía\ actuar}
$$

`usageEngaged` es una propiedad del episodio, **no** se infiere del
veredicto de Respuesta: es simplemente "¿usó algún miembro de su kit
(`isDefensiveKitMember`) durante la ventana relevante del episodio?",
verdadero incluso si esa herramienta resultó ser la equivocada
(`applicability` confirmada `no`) o si no se puede demostrar que sirviera
(`unknown`).

#### 2.5.2. Respuesta defensiva (principal)

$$
Respuesta = \frac{covered\_verified}{covered\_verified + missed\_ready + missed\_due\_to\_mistime}
$$

Sin pesos ocultos. La asimetría correcta entre crédito y penalización:

| Situación | `usageEngaged` | `responseVerdict` |
|---|---:|---|
| Cast real + aplicabilidad demostrada (`yes`) | ✅ | `covered_verified` |
| Cast real + aplicabilidad **no demostrada** (`unknown`) | ✅ | `uncertain` — nunca certifica cobertura sin evidencia, pero Uso ya lo acredita |
| Cast real + aplicabilidad confirmada `no` | ✅ | evalúa el resto del kit como si no hubiera cobertura |
| Sin cast, algo aplicable (`yes`) y disponible | ❌ | `missed_ready` |
| Sin cast, solo aplicabilidad `unknown` | — | `uncertain` — **nunca** `missed_ready` |

**Bug real corregido en `defensive-episode-verdict.ts` (2026-09-04)**: la
primera versión dejaba que `applicability==='unknown'` + disponible + sin
cast produjera `missed_ready` (el filtro usaba `!== 'no'`, que incluye
`unknown`) — contradecía la propia invariante 5 del documento. `missed_ready`
exige ahora `applicability === 'yes'` estrictamente.

#### 2.5.3. Gestión defensiva (antes "Plan"; solo cuando hay plan)

$$
Gestión = \frac{asignaciones\ cumplidas}{asignaciones\ evaluables}
$$

Si `plan_required_count = 0`: **"Sin plan defensivo asignado"**, nunca 0%.
Gestión es un evaluator distinto de Respuesta que nunca comparte
porcentaje con ella (pueden vivir en el mismo edge function). Dos reglas
de no-doble-conteo: `reservation_broken` no suma una segunda penalización
además del fallo de la asignación que rompe; `safe_extra_use` puede
mostrarse como señal positiva de coaching pero nunca sube Gestión por
encima de 100% (4/4 asignaciones cumplidas es 100%, no 120%).

#### 2.5.4. Forma objetivo del contrato de front (Paso F, no se construye todavía)

Única proyección que consume la generación **publicada** — el front no
hace scoring, toda cifra visible se deriva de aquí:

```ts
interface CanonicalDefensiveSummary {
  usage: {
    status: 'available' | 'insufficient_evidence';
    score: number | null;
    engaged: number;
    evaluable: number;
    totalObservedUses: number;
    abilities: DefensiveUsageAbility[];
  };
  response: {
    status: 'available' | 'insufficient_evidence';
    score: number | null;
    covered: number;
    evaluable: number;
    missedReady: number;
    missedMistimed: number;
  };
  management: {
    status: 'available' | 'no_plan' | 'insufficient_evidence';
    score: number | null;
    fulfilled: number;
    evaluable: number;
    reservationBroken: number;
  };
  episodes: DefensiveEpisodeSummary[];
  deaths: DefensiveDeathContext[];
  evidence: { confidence: EvaluationConfidence; notes?: string };
  generation: {
    id: string;
    publishedAt: string | null;
    semanticVersion: string;
    resolverVersion: string;
    episodeEvaluatorVersion: string;
  };
}
```

**Jerarquía visual del hero defensivo** (mantiene la identidad visual
actual, no se rediseña desde cero):

- Ejecución de la noche (ya existe).
- ANÁLISIS DEFENSIVO con tres círculos parcialmente solapados: Uso
  (pequeño) — Respuesta (grande/central, siempre el KPI principal) —
  Gestión (pequeño; `N/D · Sin plan` cuando no aplica).
- "Ventanas de presión" (nombre y concepto legacy) se sustituye
  visualmente por episodios/fallos de Respuesta.
- Página de detalle: usos personales reales, respuestas correctas/
  evaluables, fallos `missed_ready`/`missed_due_to_mistime`, plan (cuando
  exista), muertes con oportunidad defensiva verificada.
- Las cards de mecánicas muestran solo episodios canónicos y defensivos
  realmente aplicables/utilizados — nunca el catálogo completo de la clase.

No se implementa nada de esto hasta Paso F.

### 2.6. Execution Ledger como destino único

Nuevos `eventType` sobre los `domain`/`causalGroupId`/`verdict`/
`reasonCode`/`creditEligible`/`penaltyEligible` ya existentes en
`player_execution_events` (`domain='defensive'` ya existe en el contrato
real, con 0 filas materializadas hoy — confirmado, el momento correcto para
diseñarlo bien antes de poblarlo):

- `defensive_episode_<responseVerdict>` (7 estados → 7 `eventType`,
  incluido `excluded` para trazabilidad — no se descarta sin dejar rastro).
  `evidence` incluye `usageEngaged`/`usedSpellIds` para que Uso se pueda
  reconstruir desde el mismo evento, sin una tabla aparte.
- `defensive_plan_covered` / `_missed`... (Gestión).
- `domain=active_mitigation` (tank, fase posterior, no bloquea esta migración).

**Reason codes nuevos** (aditivo sobre `EXECUTION_REASON_CODES` en
`combat-evaluation-contract.ts`, hoy 27): `DEFENSIVE_EPISODE_COVERED`,
`DEFENSIVE_READY_NOT_USED`, `DEFENSIVE_MISTIMED`,
`DEFENSIVE_UNAVAILABLE_LEGITIMATE`, `DEFENSIVE_NO_APPLICABLE_RESOURCE`,
`DEFENSIVE_EPISODE_UNCERTAIN`, `DEFENSIVE_EPISODE_EXCLUDED` — nunca se
reutilizan `PLAN_COVERED`/`REMINDER_MISSED`/`SAFE_EXTRA_USE` (son del
evaluator de Gestión/Plan legacy) para Respuesta: mezclarían otra vez dos
conceptos distintos bajo el mismo código, exactamente el problema que abrió
este documento.

**Mapeo a `ExecutionVerdict`** (el enum genérico ya compartido por todos
los dominios — no se inventa uno nuevo):

| `responseVerdict` | `ExecutionVerdict` | `creditEligible` | `penaltyEligible` |
|---|---|---:|---:|
| `covered_verified` | `success` | ✓ | |
| `missed_ready` | `missed` | | ✓ |
| `missed_due_to_mistime` | `missed` | | ✓ |
| `unavailable_legitimate` | `correct_hold` | | |
| `no_applicable_resource` | `not_applicable` | | |
| `uncertain` | `uncertain` | | |
| `excluded` | `context` | | |

**Correcciones de infraestructura, obligatorias ANTES de materializar la
primera fila** (encontradas en revisión, verificadas contra Supabase real):

1. **`player_execution_events` no tiene ninguna columna de generación
   hoy** (confirmado). Añadir `defensive_generation_id uuid null
   references defensive_generations(id)` — `null` en los eventos legacy
   existentes, poblado en los nuevos. Sin esto, `defensive_generation_pointer`
   no puede seleccionar qué eventos están realmente publicados: sería una
   relación conceptual, no real.
2. **La idempotencia real hoy es `pull_id + ledger_evaluator_version +
   deduplication_key`, y `deduplication_key` incluye un hash de `evidence`**
   (confirmado en `materialize-execution-ledger/index.ts`). Eso significa
   que si la evidencia cambia (nueva generación, mismo episodio) se
   inserta una fila nueva en vez de actualizar la existente. Para el
   pipeline de episodios, la identidad debe ser estable y NO depender del
   veredicto/evidencia: `<generationId>:<episodeId>:<playerName>:response`
   — así una reevaluación dentro de la misma generación actualiza la
   misma fila en vez de duplicarla. `episodeId` en sí prioriza
   `occurrenceId` cuando existe; si es heurístico,
   `hash(pullId + player + índices de ventana ordenados + dominantAbility + start/end)`
   — identifica QUÉ episodio es, no solo cuándo ocurrió (dos mecánicas
   distintas pueden compartir milisegundo).
3. **Las views agregadas actuales no son namespace-aware.**
   `player_pull_execution_summary_v3` cuenta
   `domain IN ('defensive','external') AND penalty_eligible` sin
   distinguir `defensive_plan_broken` (legacy V2) de
   `defensive_episode_missed_ready` (nuevo) — mientras coexistan ambos
   `eventType` bajo el mismo `domain`, una view genérica los sumaría dos
   veces para "el mismo fallo". Hay que revisar `player_pull_execution_summary_v3`/
   `night_player_execution_summary_v3` para que filtren por generación
   publicada (o por prefijo de `eventType`) antes de que exista una sola
   fila real que contar.

**Tabla de staging** (patrón evaluate→persist→materialize ya usado por V2 —
se reutiliza, no se inventa uno nuevo): `player_pull_defensive_episode_evaluations`,
aditiva, al lado de `player_pull_defensive_evaluations` (V2, sin tocar).

```text
UNIQUE (defensive_generation_id, pull_id, player_name)  -- NO (pull_id, player_name) solo:
                                                          -- una corrida shadow nueva no debe
                                                          -- pisar la anterior dentro de otra generación
defensive_generation_id, pull_id, player_name
episode_evaluator_version, semantic_version, semantic_resolver_version,
resolver_version, build_fingerprint
data_confidence
episodes jsonb   -- [{ episodeId, causalGroupId, startMs, peakMs, endMs,
                 --    usageEngaged, usedSpellIds[], applicableCandidates[],
                 --    responseVerdict, responseReason,
                 --    planAssignmentId?, planVerdict?, evidence, confidence }]
evaluated_at
```

Con esto los tres KPI se reconstruyen desde la misma fila — Uso y
Respuesta desde `episodes[]` directamente, Gestión desde
`planAssignmentId`/`planVerdict` cuando existan.

### 2.7. Generación publicada (cutover atómico)

```text
BUILDING → READY → PUBLISHED
```

Cada derivado lleva `generation_id`/`semantic_version`/`resolver_version`/
`episode_version`/`evaluator_version`. El puntero singleton
`defensive_generation_pointer` (Paso A-2) apunta a la generación publicada;
la reanalización tarda lo que tarda, el front sigue viendo la generación
anterior (o `N/D` si todavía no existe ninguna) hasta un único
`UPDATE defensive_generation_pointer SET published_generation_id = new_generation`.

**Condición real de `READY`** (no "la función terminó" — ampliado
2026-09-04 tras revisión completa). Todos estos gates deben cumplirse
antes de que una generación pueda pasar a `ready`:

1. Cobertura completa de `canonical_scored_pulls` del alcance esperado —
   nunca un report suelto (ver ejemplo del 31 de agosto más abajo).
2. Todos los jugadores evaluables de ese alcance procesados, sin huecos.
3. Versiones homogéneas: misma `semantic_version`/`episode_evaluator_version`/
   `resolver_version`/`build_fingerprint` en cada fila de la generación.
4. Cero jobs pendientes o fallidos en la cola de reanálisis de esta
   generación.
5. Catálogo semántico suficiente para TODAS las clases/specs presentes en
   el corpus — no basta con que las 7 fixtures pasen si otra clase del
   roster real sigue mayoritariamente `pending`.
6. Ningún `missed_ready` sin membership + build + applicability +
   availability + confidence demostrados — no se acepta un `missed_ready`
   apoyado en un eslabón `unknown` en cualquier punto de esa cadena.
7. Ningún `missed_due_to_mistime` sin causalidad positiva demostrada (ver
   invariante 14 — sigue siendo, hoy, un estado inalcanzable desde
   `reconstructCausalAvailability`; si en algún momento se activa una
   fuente de evidencia positiva, este gate se vuelve real y no solo
   estructural).
8. Cargas (`charges > 1`) correctamente reconstruidas cuando afecten a una
   penalización — hoy se cumple por diseño fail-closed
   (`summarizeCandidateForEpisode`: `charges>1` + `on_cooldown` degrada a
   `unknown`, nunca contribuye a `missed_ready`), así que este gate está
   satisfecho por construcción mientras esa regla exista; si se
   implementa reconstrucción real de cargas en el futuro, este gate pasa
   a validar esa reconstrucción en vez de la degradación.
9. Sin doble contabilización entre eventos legacy V2 (`defensive_${state}`)
   y eventos canónicos (`defensive_episode_${verdict}`) en las views
   agregadas del ledger (ver §2.6, corrección 3).
10. El `CanonicalDefensiveSummary` de cada jugador/pull es reconstruible
    100% desde el ledger — sin datos "de más" que no vengan de una fila
    real.

El puntero es singleton/global (§A-2): **no se puede publicar una
generación que solo contenga, por ejemplo, el report del 31 de agosto** —
ese report es perfecto como fixture/shadow de validación, pero publicarlo
dejaría huecos reales en dosier/night report/roster/Fiabilidad 60d que
tentarían a reintroducir un fallback legacy, exactamente lo que esta
migración existe para eliminar.

**Informe de coverage previo al cutover** (nuevo requisito, no solo los 7
fixtures): antes de proponer una generación como `ready`, generar un
desglose `class × spec × defensive role × boss` con recuentos de
`evaluable / covered / missed / unavailable_legitimate / no_applicable /
uncertain / excluded`. No se fija de antemano un porcentaje máximo
arbitrario de `uncertain` — se analiza empíricamente. Pero **si una
clase/spec queda sistemáticamente no evaluable por una pieza conocida que
todavía no está implementada** (el caso típico: `DamageDescriptor` real
ausente para esa clase, ver §2.4.1), la generación NO se considera `ready`
— `uncertain` es para casos genuinamente ambiguos, no para funcionalidad
pendiente conocida.

## 3. Fiabilidad: proyector longitudinal, no un evaluator más

Decisión (ver conversación previa, verificada contra código real de
`reliability.service.ts`): **sustituir el eje `defensiva` de Fiabilidad por
la misma `Response` canónica, con distinto scope temporal** — no
"Reliability lee el dossier" (crearía un ownership UI→UI raro), sino que
dossier/roster/night-report/Fiabilidad leen todos la misma evidencia
canónica (`DefensiveEpisode` / ledger) y solo cambia la ventana de
agregación:

```text
CANONICAL DEFENSIVE EPISODES
    ├─ scope=report → Response noche
    ├─ scope=60d     → Response 60 días
    ├─ scope=boss    → Response boss
    └─ scope=week    → Response semanal
```

### 3.1. Qué se retira de `reliability.service.ts`

Deja de conocer: pressure windows propias, `defensive_casts`, `deathOptions`
heurísticos, Management V2, `DEFENSIVE_MISTIMED_CREDIT=0.3`, categorías de
defensive, peso doble por muerte. Eso pertenece a los resolvers upstream.
`player_pull_reliability_inputs`/`..._legacy_v1` dejan de ampliarse — no se
sigue invirtiendo en esa arquitectura.

### 3.2. Fórmula nueva

$$
M = \frac{\sum w_i\,successes_i}{\sum w_i\,evaluable_i}\times100 \qquad
R = \frac{\sum w_i\,[covered\_verified]}{\sum w_i\,[covered\_verified+missed\_ready+missed\_due\_to\_mistime]}\times100
$$

con `w_i = 0.5^{daysAgo_i/10}` (se conserva la semivida de 10 días / ventana
de 60 días ya validada). Base conductual, conservando la proporción 4:3 ya
usada hoy:

$$
B = \frac{4M+3R}{7}
$$

Mecánica se **capa a 100 dentro de este composite únicamente** — el bonus
por tareas voluntarias (`mechanicScoreFor` puede superar 100%, decisión de
producto deliberada del 2026-08-29, "nunca mayor que lo que cuesta un
fallo normal") **se conserva intacto en la tarjeta de pull**; solo se
recorta al entrar en `M` para que un extra en una dimensión no compre un
fallo defensivo real.

Si no hay ≥3 episodios defensivos evaluables en la ventana (mismo umbral
que ya usa la señal de roster): `R = N/D` y `B = M` (una sola dimensión
observada, se indica así).

Preparación de personaje deja de promediarse como eje — pasa a ser
penalización pura:

$$
Penalty_P = (100-P)\times0.20 \qquad
Reliability = clamp(B - Penalty_P,\ 0,\ 100)
$$

Esto corrige el caso general que el parche del 2026-08-30 (línea 547 de
`reliability.service.ts`, "excluir preparación=100 del blend") solo
resolvió en el límite: una preparación incompleta pero alta (ej. 98%)
seguía promediándose con signo positivo y podía **subir** el overall por
encima de la ejecución conductual real, contradiciendo la intención ya
documentada en el propio código ("preparación incompleta solo debe
penalizar"). La resta explícita cierra el caso general, no solo el borde.

Preparación se muestrea una vez por **noche real**, no por `report_code`
(hoy `isFirstPullOfNight()` agrupa por `report_code`/`pull_number` — dos
reports del mismo día por un log reiniciado duplican la muestra de esa
noche). Se introduce un `night_key` canónico.

### 3.3. Cierre del flag huérfano `reliabilityExecutionV3`

Confirmado en código: `reliabilityExecutionV3 = true` en `environment.ts`
pero ninguna rama de `reliability.service.ts` (ni del resto de `src/`) lo
lee para decidir nada — solo aparece en un doc-comment y en el test que
verifica que está en `true`. `ExecutionLedgerService` sigue siendo shadow
puro. Esta migración lo activa de verdad (scoring consume
`v_player_ledger_summary_v3`/la proyección nueva) o lo retira — no se deja
un flag que miente sobre el estado real.

### 3.4. Roster / Night Report / Consistencia / Tendencia

Roster: señal `response60d.score < 60 AND response60d.evaluableEpisodes >= 3`
en vez de `breakdown.defensiva < 60`; detalle en las mismas categorías que
ve el raider en su dossier (`missed_ready`, `missed_due_to_mistime`...).

Night Report conserva sus cuatro números (ejecución noche, Response
defensiva noche, Fiabilidad noche, Fiabilidad 60d) pero todos derivados del
mismo composite — solo cambia el scope temporal, nunca la fórmula.

Consistencia y Tendencia se conservan tal cual (mismo umbral de 5 pulls,
mismo ±4 puntos de tendencia mitad-antigua/mitad-reciente) pero operan
sobre `Reliability` ya canónica — nunca se compara una generación semántica
antigua contra una nueva (agosto legacy vs. septiembre canonical): tras
reanalizar, todo queda en `semantic_version@1` antes de calcular tendencia.

**Confirmado explícitamente (revisión 2026-09-04): Fiabilidad NUNCA
incorpora Uso ni Gestión, solo Response.** Reliability no recalcula
defensivos — solo cambia el scope temporal de la misma Response canónica
(`report` → noche, `60d` → 60 días, `boss`/`week` → análogos). Meter Uso o
Gestión ahí contaría dos veces conceptos correlacionados con Response, y
Gestión puede ser `N/D` sin plan — no es una dimensión que Fiabilidad
pueda promediar de forma consistente entre raiders.

## 4. Correcciones aplicadas durante la revisión (antes de escribir código)

1. **`activationScope`/`allySelectable` redundantes.** La propuesta
   original tenía `ally_selectable` como valor del enum `activationScope` Y
   como columna booleana aparte, con el predicado de membership exigiendo
   `activationScope === 'self' && allySelectable === false` — redundante
   por construcción (un valor no puede ser simultáneamente `'self'` y
   ally-selectable). Se elimina la columna booleana; `activation_scope`
   por sí solo decide.
2. **Predicado único de membership excluía Bear Form.** La propuesta
   original definía `countsAsPersonalDefensive` exigiendo
   `usageRole === 'personal_survival'` exactamente, lo que excluiría
   `survival_state` (Bear Form) — contradiciendo que la propia propuesta
   trata Bear Form como parte del kit personal (solo con
   `opportunityMode = credit_only`). Se separan dos predicados (§2.1):
   `is_defensive_kit_member` (incluye `survival_state`) y
   `creates_missable_opportunity` (no lo incluye).
3. **Fallback duplicado en dos sitios, no uno.** El patrón
   `v2?.managementScore ?? nightReliability?.breakdown.defensiva ?? null`
   existe tanto en `raider-infographic-view-model.ts:599` como, de forma
   independiente, en `night-player-infographic.component.ts:247` (signal
   local). Ambos deben eliminarse — no solo el del view-model.
4. **El toggle "automático / recuento directo" se retira**, no se
   reconecta a la nueva definición. Su premisa (alternar generación bajo
   la misma etiqueta a demanda del oficial) es exactamente el antipatrón
   que prohíbe la invariante 9 (§6).
5. **Eje `defensiva` de Fiabilidad no estaba cubierto por la propuesta
   original del catálogo** — es un quinto sistema independiente
   (`reliability.service.ts`, 30% del peso, pesos y crédito propios). Sin
   resolverlo, Roster y Night Report seguirían mostrando una sexta
   definición después de terminar el resto de la migración. Cubierto en
   §3.
6. **"Preparación=100 no sube el score" ya estaba parcheado en parte**
   (2026-08-30) — el parche existente excluye el caso límite exacto (100)
   pero no el caso general (incompleta y aún así alta). Documentado en
   §3.2 para no tratarlo como regresión de ese parche.

## 5. Plan de ejecución por pasos

### 5.0. Reconciliación (2026-09-04): qué sigue válido, qué cambia, qué falta

Pedido explícito tras la revisión completa — antes de seguir
implementando, el estado real de todo lo construido hasta hoy:

**Sigue válido tal cual, no se toca:**

- La arquitectura completa
  `cooldown_catalog → defensive_ability_semantics → defensive_semantic_rules
  → resolveEffectiveDefensiveKit() → pressure candidates → DefensiveEpisode
  → applicability → causal availability → canonical verdict → execution
  ledger → CanonicalDefensiveSummary → front/Fiabilidad` (§1-§3).
- `resolveEffectiveDefensiveKit()` ampliado: build-aware, contempla
  mitigation/absorption/sustain/immunity/avoidance/effective_health/
  lethal_prevention, `primaryBeneficiary` por encima de `activationScope`
  (AMS, Death Strike), propagación automática sin invalidar membership,
  reglas augment/replace/suppress/convert_to_passive por talento
  seleccionado (Mirror Image + Refractive Images, Ice Cold). 36 tests.
- Los 10 `usageRole` separados (`personal_survival`, `survival_state`,
  `hybrid_survival`, `active_mitigation`, `rotational_survival`,
  `healer_throughput`, `external`, `raid_defensive`, `passive_survival`,
  `utility`) con `active_mitigation`/`rotational_survival` fuera del KPI
  general y `survival_state`/`hybrid_survival` como `credit_only`.
- `canonical_scored_pulls`, `defensive_generations`,
  `defensive_generation_pointer` (Paso A-2).
- `groupDamageWindowsIntoEpisodes()` (9 tests), `canDefensiveCover()`
  (11 tests) — construidos y correctos, solo les falta una fuente real de
  `DamageDescriptor` (ver Paso C-1 más abajo).
- `resolveEpisodeVerdict()`/`reconstructCausalAvailability()`/
  `resolveEpisodeVerdictWithCausalAvailability()` (22 tests): 3 KPI
  (`usageEngaged` independiente de `responseVerdict`), `missed_ready`
  exige `applicability==='yes'` estricto (bug verificado como YA
  corregido, no localizado de nuevo en el código actual — ver respuesta
  de esta misma conversación), `missed_due_to_mistime` inalcanzable sin
  evidencia positiva, fail-closed de cargas, precedencia de kit completo.
- El diseño de la tabla de staging, la extensión del ledger (columna de
  generación, dedupe por identidad, 7 reason codes, views
  namespace-aware) — diseñado en §2.6, coincide con lo pedido, no
  implementado todavía.

**Cambia/se amplía respecto a lo escrito hasta ayer:**

- Uso defensivo deja de ser "solo descriptivo" — ya era así desde la
  revisión anterior (§2.5), esta ronda lo confirma como definitivo.
- La condición de `READY` pasa de un párrafo a 10 gates explícitos +
  informe de coverage obligatorio (§2.7).
- `DamageDescriptor` deja de ser "trabajo aparte, fuera de este corte" y
  pasa a ser un requisito de cutover con criterios de aceptación
  concretos (§2.4.1) — el cambio de alcance más grande de esta revisión.
- `CanonicalDefensiveSummary` gana `deaths`/`evidence`/metadata de
  versión completa (§2.5.4).

**Sigue pendiente, sin cambios de diseño desde la última ronda:**

- Terminar la clasificación IA del catálogo (Paso B, clase por clase).
- Tabla de staging + extensión del materializer (Paso C, siguiente pieza
  real de código).
- `DamageDescriptor` real (Paso C-1, nuevo, ver abajo).
- Reanálisis masivo con el pipeline nuevo (Paso D).
- Fixtures + matriz cross-class (Paso E, §7.1).
- Cutover (Paso F), Fiabilidad (Paso G), de-legacy.

### 5.1. Pasos

1. **Paso A-1 — Migración SQL aditiva del catálogo** (`defensive_ability_semantics`,
   `defensive_semantic_rules`, vista `defensive_ability_semantic_catalog`,
   trigger de pendiente automático, retirada del default peligroso de
   `category`). **Hecho — ver §8.**
2. **Paso A-2** — `canonical_scored_pulls` + esquema de generación
   (`defensive_generations`/`defensive_generation_pointer`). **Hecho — ver §8.**
3. **Paso B** — Backfill masivo. **B-1 (reglas deterministas: semi/external
   → no-self, pasivo → opportunity_mode=none, fixtures Bear Form/Death
   Strike) hecho.** **B-2 (`classify-defensives` extendido a v10 con el
   contrato semántico completo, incluida derivación legacy automática)
   desplegado.** Falta que un officer termine la investigación IA
   clase por clase (JWT real, no ejecutable desde aquí — ver §8). Ambiguos
   siguen `pending` — nunca penalizan.
4. **Paso C** — Backend en shadow. Piezas de construcción hechas y
   testeadas (funciones puras, sin consumer todavía — ver §8):
   `resolveEffectiveDefensiveKit()` ampliado (usageRole/mechanisms/
   membership), `groupDamageWindowsIntoEpisodes()`, `canDefensiveCover()`,
   `resolveEpisodeVerdict()`/`reconstructCausalAvailability()` (3 KPI,
   corregido tras revisión — ver §2.5/§2.6/registro 2026-09-04). **Falta**:
   tabla de staging `player_pull_defensive_episode_evaluations` (§2.6),
   extensión de `materialize-execution-ledger` (columna `defensive_generation_id`
   en `player_execution_events`, dedupe por identidad de episodio,
   generation-aware en las views agregadas — todo ya diseñado en §2.6, no
   implementado). `effective-defensive-semantics@1.0.0` ya versionado por
   separado del resolver de timing; `episode-evaluator@1` pendiente de
   asignar cuando se construya el materializer.
5. **Paso C-1 — `DamageDescriptor` real** (§2.4.1, requisito de cutover,
   no deuda estructural): investigar e implementar la fuente real desde
   WCL para los facts mínimos (school, AoE/single, direct/periodic,
   source actor, dodge/parry/block, source-affected-by-spell, compatibilidad
   de inmunidad). Sin esto, Paso E/F no pueden pasar el gate de coverage.
6. **Paso D** — Reanálisis masivo con el pipeline NUEVO (tabla de staging +
   materializer de Paso C — distinto de la cola de WCL/`reanalyze-defensive-pressure`
   actual, que sigue siendo el pipeline legacy) de los pulls a conservar.
7. **Paso E** — Fixtures de aceptación obligatorios (§7) + matriz
   cross-class (§7.1) + informe de coverage (§2.7).
8. **Paso F** — Cutover atómico: `published_generation` + ViewModel/front
   nuevo (§2.5.4/§2.7), sin pantalla mixta V2/V3.
9. **Paso G — Fiabilidad**: sustitución del eje `defensiva`, penalización
   de preparación, cap de mecánica en el composite, cierre de
   `reliabilityExecutionV3`, Roster/Night Report.
10. **De-legacy** (después del cutover, no antes): dejar de escribir
   derivados legacy → retirar flags → retirar fallbacks del front →
   retirar queries legacy → grep de referencias → eliminar
   columnas/vistas/tablas cuando no quede ningún consumer.

## 6. Invariantes de aceptación (bloquean PR si fallan)

1. Un único resolver decide qué defensivos tiene un jugador.
2. Una única población de pulls decide qué entra en una noche.
3. Una única generación publicada alimenta toda la infografía (incluida
   Fiabilidad).
4. Un defensivo `pending`/`uncertain` nunca genera penalización.
5. Un defensivo no aplicable nunca genera `missed_ready`.
6. On cooldown no implica automáticamente fallo ni exclusión: hay que
   resolver la causa (`unavailable_legitimate` vs `missed_due_to_mistime`).
7. Una mecánica causal genera como máximo una oportunidad por decisión.
8. No existe `plan_broken` sin plan publicado/asignación real.
9. No existe fallback entre algoritmos bajo la misma etiqueta (incluye:
   ningún flag puede decir "activo" sin que el código lo lea de verdad).
10. Todo porcentaje mostrado al raider lleva numerador y denominador
    reconstruibles.
11. Una sincronización externa no puede modificar una semántica IRIS
    `verified`.
12. El front no hace scoring.
13. Uso, Respuesta y Gestión son KPI independientes derivados del mismo
    episodio/ledger — ninguno se infiere de otro ni comparten porcentaje
    (un cast real acredita Uso aunque Respuesta no pueda certificarlo).
14. `missed_due_to_mistime` exige evidencia POSITIVA de mal uso (reserva
    rota, gasto demostrable sin amenaza) — la ausencia de un episodio
    anterior que justifique un cast nunca es esa evidencia por sí sola;
    degrada a `uncertain`.

## 7. Fixtures de aceptación (7 raiders)

| Caso | Invariante a probar |
|---|---|
| Gusmï | Barkskin + Frenzied Regeneration válidos; Bear Form `credit_only` (cuenta uso, nunca fabrica `missed_ready`) |
| Magzil | Mirror Image depende de Refractive Images seleccionado; reglas de reemplazo correctas |
| Pitpally | Blessed Hammer/SotR (`active_mitigation`) no contaminan el Response general |
| Rivax | Evasion pertenece al kit pero no penaliza si no es aplicable al daño del episodio |
| Wargreymon | AMS entra al kit aunque propague automáticamente a un aliado (`secondaryPropagation=automatic_ally`) |
| Txerokee | Riptide/Healing Stream/raid CDs fuera del kit personal |
| Linkedara | Fade cuenta solo cuando el build le da mitigación; Desperate Prayer válido; Flash Heal/Serenity/Guardian Spirit fuera |

Aplica igual a cualquier otro raider/clase/spec — estos siete son el corpus
de validación, no una lista cerrada de excepciones.

### 7.1. Matriz de normalización cross-class (después de los 7 fixtures)

Los 7 fixtures verifican invariantes concretos. Una vez pasan, la
aceptación se amplía a una **matriz de todas las class/spec presentes en
el corpus real** (no solo las de los 7 raiders) — mismo informe de
coverage que exige el gate de READY (§2.7).

"Normalizado entre clases/specs" **no significa** que todos tengan el
mismo número de oportunidades — un CD de 15s genera más episodios que uno
de 2 minutos, y eso es correcto, no un defecto a corregir. Significa que
**todos responden a la misma pregunta**:

> De los episodios en los que este build tenía realmente una respuesta
> personal aplicable y evaluable, ¿cuántos resolvió correctamente?

Esa es la comparación justa entre clases — no el recuento crudo de casts,
que es exactamente el problema que este documento existe para eliminar
(ver §1, Pitpally 1.719→102).

## 8. Registro de avance

### 2026-09-03 — Paso A-1: migración SQL aditiva del catálogo

- Creada `defensive_ability_semantics` (1:1 con `cooldown_catalog`,
  `semantic_status` por defecto `pending`, RLS `is_officer()` igual que
  `defensive_spec_profiles`/`defensive_modifier_rules`).
- Creada `defensive_semantic_rules` (modificadores por build/talento).
- Vista `defensive_ability_semantic_catalog` con los dos predicados de
  membership derivados (`is_defensive_kit_member`,
  `creates_missable_opportunity`) — única fuente para el resolver del
  Paso C, nada debe reimplementar el predicado por su cuenta.
- Trigger `trg_cooldown_catalog_semantics_pending`: cualquier fila nueva de
  `cooldown_catalog` (venga de `classify-defensives`, sync o seed manual)
  recibe automáticamente una fila `pending` — nace pendiente, no
  defensiva, sin depender de que cada writer se actualice.
- Backfill: fila `pending` para cada entrada ya existente de
  `cooldown_catalog` (no clasifica nada todavía — eso es Paso B).
- Retirado el `default 'personal_defensive'` de `cooldown_catalog.category`
  (verificado: el único writer que inserta filas nuevas,
  `classify-defensives`, siempre fija `category` explícitamente y la valida
  antes del insert — no dependía del default).
- Migración `20260903140000_defensive_ability_semantics.sql`.

### 2026-09-03 — Paso B-1: backfill determinista

Auditoría real de las 216 filas (`category` × `targeting_mode` × `activation_mode`
× `survival_type`, ya curado por research passes previos) antes de escribir
ninguna regla. Confirmado un riesgo real: `category='personal_defensive' AND
targeting_mode='self'` (146 filas) mezcla CDs personales reales con lo que en
varios casos son talentos/pasivas modificadores de otra habilidad (ej.
Refractive Images, Ice Cold — ya citados en §24 del plan como modificadores,
no defensivos independientes) y con build-dependientes (Mirror Image, Fade).
Clasificar eso a mano por SQL habría recreado el mismo problema que esta
migración existe para arreglar — se dejó pending a propósito.

Aplicado solo lo estructuralmente seguro (migración
`20260903150000_defensive_semantics_deterministic_backfill.sql`):

- 70 filas `semi_defensive`/`external_defensive` → `activation_scope`
  no-self (por definición el jugador puede elegir a otro destinatario, las
  descalifica del KPI personal sin importar el `usage_role` exacto),
  `opportunity_mode='none'`, `semantic_status='verified'`,
  `confidence='inferred'`.
- Pre-fill de `opportunity_mode='none'` en toda fila `activation_mode='passive'`
  todavía `pending` (no cambia `semantic_status` — un pasivo nunca fabrica
  oportunidad sin importar cuál acabe siendo su `usage_role`).
- 2 fixtures nombradas del plan (§7): Bear Form → `survival_state` +
  `credit_only`; Death Strike → `rotational_survival` + `activation_scope='enemy'`
  (corrige la conflación beneficiario/objetivo de `targeting_mode`).

Verificado en producción tras aplicar: 72 filas `verified` / 144 `pending`
(0 huérfanas). Bear Form → `is_defensive_kit_member=true`,
`creates_missable_opportunity=false`. Death Strike → ambas `false`. Probado
también que el trigger de Paso A-1 sigue funcionando (insert de prueba →
fila `pending` automática) y que `category` sin valor explícito sigue
fallando el insert — datos de prueba limpiados después. `verify:defensive-contract`
y `verify:causal-schema`: PASS.

### 2026-09-03 — Paso B-2: `classify-defensives` extendido (v9)

`_shared/defensive-classification-semantics.ts` gana el contrato nuevo
(`DEFENSIVE_USAGE_ROLES`/`DEFENSIVE_ACTIVATION_SCOPES`/
`DEFENSIVE_SECONDARY_PROPAGATIONS`/`DEFENSIVE_MECHANISMS`/
`DEFENSIVE_OPPORTUNITY_MODES`), `defensiveSemanticError()` (mismo patrón que
`defensiveTargetingError()`) y `isDefensiveKitMember()`/
`createsMissableOpportunity()` en TypeScript — MISMA fórmula que la vista SQL
`defensive_ability_semantic_catalog`, para que el resolver del Paso C no
tenga que reimplementarla. 11 tests nuevos en
`defensive-classification-semantics.spec.ts` (incluye los casos AMS/Bear
Form/Death Strike del plan).

`classify-defensives` sube a `promptVersion=9`: el prompt de investigación
ahora incluye el glosario completo del contrato semántico (usageRole/
activationScope/secondaryPropagation/mechanisms/opportunityMode, con Death
Strike y Anti-Magic Shell como ejemplos explícitos en el propio prompt) y
`action=submit` valida y escribe esos campos en `defensive_ability_semantics`
(upsert por `catalog_id`, respetando `locked` — una fila bloqueada por un
officer nunca la pisa la IA) además de lo que ya escribía en
`cooldown_catalog`. Una respuesta v8 legacy sigue siendo válida por
compatibilidad, pero deja esas filas en `pending` — nunca se infiere la
semántica nueva a partir de `category` sola.

Desplegado (`npx supabase functions deploy classify-defensives`, bundle
754 kB, sin errores). Smoke test: `POST` sin JWT de officer → `401` (función
viva, guard intacto). `vitest run src/app/shared/defensive-classification-semantics.spec.ts`:
11/11. `verify:defensive-contract`/`verify:causal-schema`: PASS.

**Pendiente de acción del usuario**: disparar la clasificación real de las
144 filas `personal_defensive`/`self` restantes — como con
`reanalyze-defensive-pressure`, `classify-defensives` exige JWT de officer
real (`requireOfficer`), no se pudo ejecutar desde aquí. Flujo: Ajustes →
Defensivos → generar prompt por clase → pegarlo en un chat de investigación
→ pegar la respuesta JSON de vuelta en `action=submit`. El prompt v9 ya
incluye el contrato nuevo, así que ese mismo pase de investigación deja las
filas de `defensive_ability_semantics` resueltas (o `unknown`/pending si no
hay confianza suficiente — nunca penaliza).

### 2026-09-03 — Paso B-2 (continuación): prompt v10 aportado por el usuario

El usuario mejoró sustancialmente el prompt de investigación y pidió
adoptarlo como v10 tal cual (contenido/estructura/arquitectura del prompt
sin tocar, solo sustituir sus 4 placeholders por los valores reales que ya
calculaba `action==='prompt'`). Revisado dos veces contra el contrato v9 ya
desplegado antes de tocar código — v10 introduce una corrección
arquitectónica real, no solo más detalle:

- **`primaryBeneficiary`** (quién recibe la protección) se separa de
  `activationScope` (a quién se dirige el cast). v9 exigía
  `activationScope='self'` para contar como kit personal — incorrecto en
  general (caso Fiery Brand: `activationScope=enemy`,
  `primaryBeneficiary=self`, sigue siendo `personal_survival`).
  `primary_beneficiary='self'` pasa a ser la condición real de membership.
- `usageRole` gana `hybrid_survival` (dualidad ofensiva/defensiva real,
  mismo tratamiento credit_only que `survival_state`) y `passive_survival`
  (cheat death/procs, ya excluido por `activation_mode='active'`).
- `mechanisms` gana `lethal_prevention`, distinto de `effective_health`.
- `activationScope` gana `none` (pasivos sin target).
- Nuevos campos capturados: `defensiveIntent`, `applicability`
  (school/delivery/dodgeable/parryable/blockable/timingRelation — insumo
  directo para Paso C, "aplicabilidad daño↔defensivo"),
  `specSemanticProfiles`, `semanticStatus` explícito por habilidad (antes
  se forzaba `verified` para todo lo aplicado; v10 puede pedir
  `pending`/`rejected` aunque el resto del contrato sea válido — regla
  fail-closed propia del prompt).
- `semanticModifiers`/`replacementRules` (antes solo documentados en texto)
  ahora son machine-readable y se escriben en `defensive_semantic_rules`
  (misma tabla de research v5, `rule_type` ampliado con
  `convert_to_passive`).

**DB** (`20260903160000_defensive_semantics_v10_contract.sql`): nuevas
columnas `primary_beneficiary`, `defensive_intent`, `applicability` (jsonb),
`applicability_confidence`, `spec_semantic_profiles` (jsonb) en
`defensive_ability_semantics`; enums `usage_role`/`activation_scope`/
`mechanisms` ampliados; `defensive_semantic_rules.rule_type` ampliado;
vista `defensive_ability_semantic_catalog` recreada (`primary_beneficiary`
decide "self", no `activation_scope`; `hybrid_survival` se une a
`survival_state` en `is_defensive_kit_member`). Backfill de
`primary_beneficiary`/`defensive_intent` para las 72 filas ya `verified` de
Paso B-1 (sin esto Bear Form habría perdido membership bajo el predicado
nuevo). Aplicada y verificada: Bear Form
(`is_defensive_kit_member=true`/`creates_missable_opportunity=false`) y
Death Strike (ambas `false`) se mantienen correctos tras el cambio de
predicado.

**`_shared/defensive-classification-semantics.ts`**: `DefensiveSemanticInput`
gana `primaryBeneficiary`; `defensiveSemanticError`/`isDefensiveKitMember`/
`createsMissableOpportunity` reescritos sobre `primary_beneficiary` en vez
de `activation_scope`; reglas de coherencia ampliadas (roles
`credit_only`/`none` exactos, `opportunityMode=normal` reservado solo para
`personal_survival`). 18 tests (antes 11), incluyendo el caso Fiery Brand
explícito. Todos en verde.

**`classify-defensives`**: prompt v10 pegado literal (solo 4 placeholders
sustituidos: `{{CURRENT_DATE}}`→`todayIso()`, `{{GAME_BUILD}}`→`gameBuild`,
`{{CLASS_NAME}}`→`body.class` ya no-nulo por el guard existente,
`{{KNOWN_DEFENSIVES_JSON}}`→`JSON.stringify(list)`) — v10 es autocontenido
(su propia sección 30 ya embebe knownDefensives), así que `userMessage` deja
de repetir la lista. `PROMPT_VERSION=10`. `validateSemanticEntry` ahora
valida los 6 campos centrales + lee `semanticStatus`/`defensiveIntent`/
`applicability`/`applicabilityConfidence`/`specSemanticProfiles` (estos
últimos cuatro informativos: se guardan tal cual, Paso C decide cómo
consumirlos). `semanticModifiers`/`replacementRules` se validan de forma
laxa a propósito (un objeto individual mal formado se descarta, no invalida
la habilidad completa) y se escriben en `defensive_semantic_rules`.

Desplegado (`npx supabase functions deploy classify-defensives`, 768 kB).
Smoke test: `401` sin JWT de officer (función viva, guard intacto).
`vitest run` del fichero de contrato: 18/18. `verify:defensive-contract`:
PASS.

**Alcance deliberadamente NO cubierto en este corte** (para no exceder lo
pedido — "solo añadimos nuestros datos que necesitamos encima"): la UI de
officer (`defensive-catalog.component`) no muestra todavía los campos v10
nuevos (usageRole/primaryBeneficiary/applicability/...) — sigue mostrando
solo category/targetingMode/survivalType legacy. El resolver de Paso C
tampoco consume aún `applicability`/`specSemanticProfiles`/
`defensive_semantic_rules` — quedan capturados como evidencia para cuando
ese paso se construya.

**Pendiente de acción del usuario**: pegar la respuesta del prompt v10 vía
`action=submit` (igual que antes, JWT de officer real).

### 2026-09-04 — Paso B-2 (continuación): uso real en producción destapa 3 bugs

Primer intento real con Druid: `reviewedDefensives`/`missingDefensives`
vacíos, sin error visible. Diagnóstico contra DB (cero filas tocadas desde
Paso B-1) antes de mirar el JSON: no era un bug de aplicación, la propia IA
devolvió `contractViolations: ["INCOMPLETE_EXECUTION: ..."]` — se negó a
rellenar filas a medio investigar (FASE 1 + FASE 2 juntas es demasiado para
un turno con el rigor que pide v10) en vez de adivinar. Comportamiento
fail-closed correcto, solo que en el sitio equivocado del JSON. Solución:
pedir FASE 1 y FASE 2 por separado en el mismo chat, no tocar código.

**Bug 1 — UI sin motivo, solo contador.** "✕ N filas inválidas" no mostraba
por qué. Arreglado (`defensive-catalog.component.html`): lista spellId +
reason por fila, mismo patrón visual que `suggestedExclusions`. `ng build`
limpio.

**Bug 2 — el hallazgo importante: la IA confunde targetingMode (legacy)
con activationScope/primaryBeneficiary (nuevos)**, vocabularios parecidos
pero distintos enums. Con las razones ya visibles gracias al Bug 1, el
patrón fue inequívoco en DH/Evoker/Hunter: decenas de
`semi_defensive exige targetingMode both` /
`external_defensive exige targetingMode ally, raid o unknown` (la IA metía
`ally_selectable`/`self_or_ally_selectable` — valores de los enums nuevos —
donde `targetingMode` solo admite `self/ally/both/raid/unknown`) y
`missingDefensive necesita un survivalType válido` (la IA usaba
`lethal_prevention`, mecanismo nuevo, donde el campo legacy exige
mitigation/absorption/sustain/emergency).

Arreglo de raíz, no parche: `category`/`targetingMode`/`survivalType`
(legacy) ya no son la fuente de verdad (§19-20 del plan) — así que en vez
de seguir exigiéndole a la IA que rellene bien DOS vocabularios redundantes
para el mismo hecho, se DERIVAN determinísticamente del contrato nuevo
cuando este está presente y es válido, e ignoran lo que la IA haya escrito
en los campos legacy:

- `deriveLegacyClassification(input)` → `{category, targetingMode}`.
  `personal_survival`/`survival_state`/`hybrid_survival` → personal_defensive
  self; `healer_throughput` → semi_defensive both; `external` → external_defensive
  ally; `raid_defensive` → external_defensive raid; el resto
  (`active_mitigation`/`rotational_survival`/`passive_survival`/`utility`/`unknown`)
  → `utility` (nunca `personal_defensive` — forzarlo ahí resucitaría la
  contaminación SotR/Death Strike que esta migración corrige).
- `deriveLegacySurvivalType(mechanisms[])` → mitigation/absorption/sustain/
  emergency/null, con `lethal_prevention`/`immunity`/`effective_health` →
  `emergency` (mismo cajón histórico que ya documenta §18 del prompt v10).

Ambas en `_shared/defensive-classification-semantics.ts`, con test que
recorre los 11 `usageRole` y comprueba que `deriveLegacyClassification`
siempre produce un par que `defensiveTargetingError` acepta (23/23 tests
verdes). Conectadas en `classify-defensives` (reviewed y missing loops):
cuando `semanticResult.input` existe, se usa la derivación y se salta la
validación de los campos legacy de la IA por completo. Redesplegado.

**Bug 3 — `save-defensive-edit` llevaba semanas sin redesplegarse** pese a
varias ediciones del fichero compartido hoy — "confirmar exclusión" de
Rage of the Sleeper daba `"personal_defensive requiere target self."`, un
texto que ya no existe en el código fuente (la versión desplegada era de
antes de un refactor de wording). Además, causa real independiente del
texto: esa validación se ejecutaba siempre que category/targetingMode YA
guardados en la fila fueran inconsistentes, aunque la edición actual
(`excluded: true`) no tocara ninguno de los dos — bloqueando ediciones
totalmente ajenas sobre filas con datos legacy ya inconsistentes de antes.
Arreglado: solo valida si `'category' in body || 'targetingMode' in body`
(la edición en curso los toca de verdad). Redesplegado — único otro
consumer de `_shared/defensive-classification-semantics.ts` además de
`classify-defensives`.

Validación: `vitest` 23/23, `verify:defensive-contract` PASS, `ng build`
limpio, las tres funciones (`classify-defensives`, `save-defensive-edit`)
desplegadas y verificadas vivas (401 sin JWT de officer).

### 2026-09-04 — Cola de reanálisis: botón "Cancelar cola"

Pedido explícito del usuario: la cola de reanálisis (`defensive_reanalysis_jobs`/
`_batches`, independiente de todo este refactor — existía desde antes)
tenía 437 jobs bloqueados/reintentables acumulados de antes del cambio de
catálogo (rate limit de WCL expirado, filas ya reemplazadas) sin forma de
descartarlos — "Reintentar" solo reencola errores, nunca los descarta.

- Migración `20260904090000_defensive_reanalysis_queue_cancel.sql`: nuevo
  estado terminal `cancelled` en `defensive_reanalysis_jobs.status` y
  `defensive_reanalysis_batches.status` (aditivo, amplía los CHECK
  existentes). `cancelled` nunca se reencola ni cuenta para
  queued/running/retryableErrors/blockedErrors (las queries de `status`
  solo miran queued/running/error).
- `defensive-reanalysis-queue` (edge function): nueva `action: 'cancel'`
  (con `batchId` opcional — sin él, cancela TODA la cola). Dos `UPDATE`
  masivos (uno por tabla, `.in('status', [...])`), no un bucle job a job —
  "de forma real y eficiente" tal como se pidió.
- Front-end (`defensive-catalog.component`): botón "Cancelar cola" en rojo
  (`--danger`, mismo tono que `.delete-btn`) junto a "Ver/Ocultar detalle" y
  "Reintentar", visible siempre que la cola no esté `healthy`/`checking`.
  Doble clic en 5s (mismo patrón que `requestResetClassDefensives`) porque
  es destructivo y afecta a toda la cola, no a un batch. Al confirmar,
  también detiene la reanudación local en curso para no volver a traer
  jobs que el servidor acaba de descartar.

Desplegado (`defensive-reanalysis-queue`, `defensive-catalog.component`),
`ng build` limpio, smoke test 401 sin JWT.

**Pendiente de acción del usuario**: pulsar "Cancelar cola" (doble clic)
para limpiar el backlog real — no ejecutable desde aquí (JWT de officer).

### 2026-09-04 — Paso A-2 y arranque de Paso C

**Paso A-2** (`20260904100000_defensive_canonicalization_paso_a2.sql`),
aditiva, aplicada y verificada contra datos reales:

- Vista `canonical_scored_pulls` (`ingestion_status='complete'` +
  `ninja_pull_excluded=false`, `security_invoker=true` heredando la misma
  postura de RLS que `pulls` ya tiene hoy — confirmado que `pulls` solo
  tiene la policy `"read complete - pulls"`, sin `is_officer()`; no se
  inventa una más estricta aquí, eso sería un cambio de seguridad aparte).
  `wipe_call_*` se conserva sin filtrar — recorta eventos dentro del pull,
  nunca lo excluye entero. Verificado: 101 pulls totales → 91 canónicos (4
  incompletos + 6 ninja, sin solape).
- `defensive_generations` (ciclo `building/ready/published/superseded/failed`)
  + `defensive_generation_pointer` (tabla singleton, una fila con
  `published_generation_id`) en vez de una columna en `reports`: una noche
  puede abarcar varios reports que deben ver la MISMA generación a la vez
  — el cutover de Paso F es un único `UPDATE` de esa fila, no un `UPDATE`
  masivo de reports. Ambas vacías/`null` a propósito — nada que publicar
  hasta que Paso C produzca una generación real.

**Paso C — primera pieza: `resolveEffectiveDefensiveKit()` ampliado**
(`_shared/effective-defensives.ts`). Decisión de versionado importante:
**no se tocó `EFFECTIVE_DEFENSIVE_RESOLVER_VERSION`** (el bump de esa
versión concreta ya tiene un radio de impacto amplio y pendiente de
decisión explícita del usuario por otro motivo — specApplies()/spec
desconocida, ver registro de auditoría; no se quería colar un segundo motivo
de bump sin discutirlo). La resolución semántica nueva lleva su propio
marcador independiente, `EFFECTIVE_DEFENSIVE_SEMANTIC_RESOLVER_VERSION =
'effective-defensive-semantics@1.0.0'` — cuando el evaluator de episodios
necesite su propio gate de homogeneidad, se construye sobre esta versión,
no sobre la de timing.

El resolver ahora, además de cooldown/duración/cargas/elegibilidad
(sin tocar), también resuelve por entrada:
`usageRole/activationScope/primaryBeneficiary/secondaryPropagation/
mechanisms/opportunityMode/defensiveIntent/semanticStatus` desde
`defensive_ability_semantics` (vía la vista `defensive_ability_semantic_catalog`),
aplica `defensive_semantic_rules` (augment/replace/suppress/
convert_to_passive) sobre los talentos realmente seleccionados en el build
del jugador — un augment sin `verified=true` nunca se aplica solo — y
expone `isDefensiveKitMember`/`createsMissableOpportunity` ya cruzados con
`eligible` de ESTE build concreto (invariante 1 del plan: una semántica
perfecta en abstracto no cuenta si el talento no está seleccionado).
Reutiliza directamente `isDefensiveKitMember()`/`createsMissableOpportunity()`
de `defensive-classification-semantics.ts` — ni una copia ni una
reimplementación.

100% retrocompatible por diseño: `data.semantics`/`data.semanticRules` son
opcionales — un caller que no los pasa (todo el pipeline actual: analyze-report,
reanalyze-defensive-pressure, generate-defensive-plan, resolve-player-defensive-kit,
manage-player-defensive-override) sigue recibiendo exactamente el mismo
`ResolvedDefensive` de siempre, con los campos semánticos nuevos en su valor
neutro (`semanticResolved:false`, `usageRole:'unknown'`,
`isDefensiveKitMember:false`). Confirmado con los 25 tests preexistentes en
verde sin tocarlos, más 11 tests nuevos (36/36) cubriendo exactamente los
casos de aceptación del plan: Bear Form (`survival_state`/`credit_only`,
cuenta pero nunca falla), AMS (propagación automática no rompe membership),
Death Strike (nunca cuenta pese a `primaryBeneficiary=self`), Mirror Image +
Refractive Images (augment verificado activa `personal_survival` solo con
el talento seleccionado; sin el talento la fila base `utility` no
sobreclasifica), regla sin verificar (nunca se aplica sola), suppress/replace
(marcan `eligible=false`), y el cruce con `eligible` del build.

Desplegado un consumer real (`defensive-v2-readiness`, de solo lectura, el
de menor riesgo de los 6 que importan este fichero) para verificar que el
bundler de Deno compila limpio la cadena completa. **Deliberadamente NO
redesplegados** los otros 5 (`analyze-report`, `reanalyze-defensive-pressure`,
`generate-defensive-plan`, `resolve-player-defensive-kit`,
`manage-player-defensive-override`): ninguno usa todavía los campos nuevos
(son inertes para ellos), y son rutas de escritura/producción de mayor
tráfico — redesplegarlos hoy no cambia su comportamiento y añade riesgo
sin beneficio. Se redesplegarán cuando de verdad empiecen a pasar
`data.semantics`.

Validación: `vitest` 36/36 (effective-defensives) + 21/21
(defensive-classification-semantics), `verify:defensive-contract` y
`verify:causal-schema`: PASS.

**Lo que queda de Paso C** (no cubierto en este corte, siguiente sesión):
disponibilidad causal (`unavailable_legitimate` vs `missed_due_to_mistime`)
y el ledger materializer nuevo. El resolver ampliado de hoy es la base
sobre la que se construye todo eso — sin él, nada de lo siguiente tenía
datos semánticos reales de los que partir.

### 2026-09-04 (continuación) — Paso C: agrupación causal + aplicabilidad

Dos piezas más, ambas funciones puras (mismo estilo que el resolver:
sin Supabase/Deno, testeables desde Angular) — deliberadamente NO
conectadas todavía a ningún edge function ni a datos reales de WCL; son
piezas de construcción a la espera del evaluator de episodios que las una
con casts/daño reales.

**`_shared/defensive-episode-grouping.ts` — `groupDamageWindowsIntoEpisodes()`.**
Sustituye "pressure window = oportunidad" por "pressure window = candidato"
(§9 del plan). Agrupa candidatos por: mismo `occurrenceId` real (manda
siempre, sin importar el gap — pero la causalidad v3 sigue en `shadow`, no
autoritativa, así que hoy esto es una vía preparada, no el camino habitual)
o, en su ausencia, misma habilidad dominante (`attributeWindowAbility()`,
ya existente) + continuidad temporal (6 s por defecto, el mismo valor ya
validado empíricamente durante la auditoría — nunca fusiona por heurística
si la habilidad dominante es `null` en cualquiera de los dos lados: más
episodios de la cuenta es más seguro que fusionar dos decisiones reales
distintas). Un grupo solo se etiqueta `groupingBasis:'occurrence'` si
TODOS sus miembros comparten el mismo occurrenceId — una fusión mixta
(parte con occurrence, parte sin) degrada a `'heuristic'`, nunca finge más
certeza de la que hay. 9 tests, incluido el caso Gusmï explícito (varios
picos consecutivos de la misma habilidad → un solo episodio).

**`_shared/defensive-applicability.ts` — `canDefensiveCover()`.** Consume
directamente el `applicability`/`applicability_confidence` que el prompt
v10 ya escribe en `defensive_ability_semantics` (antes capturado pero sin
ningún consumer — ver registro de Paso B-2). `applicabilityConfidence`
`low`/ausente degrada TODO a `unknown` de entrada, sin mirar el resto de
campos. Cubre exactamente los casos del plan: AMS no cubre físico
(Wargreymon), Evasion no cubre daño no esquivable (Rivax), Fiery Brand
exige que el origen esté afectado por el spell. Invariante 5 por
construcción: cualquier dato no determinado (`null`) produce `unknown`,
nunca `no`/`yes` por omisión. 11 tests.

Importante: `DamageDescriptor` (school/deliveryScope/dodgeable/...) todavía
no tiene una fuente real — WCL no expone esto en los eventos que ya se
extraen hoy (`raid_damage_taken_series`, casts). Extraerlo es trabajo
aparte de ingesta (tocar qué se pide a WCL), no una función pura — se deja
explícitamente fuera de este corte. Mientras no exista esa fuente,
`canDefensiveCover()` con un `DamageDescriptor` todo-`null` ya degrada
correctamente a `unknown` en cuanto el defensivo tenga alguna restricción
real (schoolScope físico/mágico/specific, requiresDodgeable/Parryable/
Blockable/SourceAffectedBySpell) — es seguro dejarlo así de "inerte" hasta
decidir esa extracción.

Validación: `vitest` 77/77 (los cuatro ficheros de Paso B/C juntos —
episode-grouping, applicability, effective-defensives, classification-semantics),
`verify:defensive-contract` y `verify:causal-schema`: PASS. Nada desplegado
en este tramo — son módulos nuevos sin consumer todavía, no hay edge
function que redeployar.

**Pendiente real antes de seguir con disponibilidad causal/ledger**: decidir
cómo se extrae `DamageDescriptor` de WCL (qué pedir, dónde persistirlo) —
es la pieza que falta para que `canDefensiveCover()` deje de estar inerte,
y probablemente merece su propia conversación antes de tocar ingesta.

### 2026-09-04 (continuación) — Paso C: decisión de asimetría + veredicto de episodio (Fase A)

**Decisión explícita del usuario**: mientras no exista `DamageDescriptor`
real, marcar esa pieza como pendiente y **asumir que un defensivo
realmente usado durante un episodio es correcto para esa mecánica** — no
bloquear el resto de la construcción por su ausencia.

Esto ya encajaba con el diseño existente sin tocar `canDefensiveCover()`
(que se queda honesto: sigue devolviendo `unknown` sin datos reales, nunca
inventa un `sí`). Lo que hacía falta era la mitad que faltaba: **quién
consume ese `unknown` y cómo**. Nueva pieza,
`_shared/defensive-episode-verdict.ts`:

- `summarizeCandidateForEpisode()` — calcula si un candidato se usó
  dentro de la ventana relevante de un episodio (reutiliza
  `defensiveStatusAt()` de `defensive-cooldowns.ts` tal cual, no se
  reinventa cast+cooldown) y su estado en el pico. Regla de timing por
  mecanismo (§30 del plan): `sustain` tolera un cast en una ventana de
  gracia INMEDIATAMENTE DESPUÉS del episodio (3 s por defecto);
  mitigation/absorption/immunity/avoidance exigen que el cast caiga dentro
  del propio tramo, nunca después.
- `resolveEpisodeVerdict()` — la función de decisión pura. Aplica
  exactamente la asimetría pedida: `applicability !== 'no'` (que incluye
  `'unknown'`) es suficiente para `covered_verified` si hubo un cast real;
  pero solo `createsMissableOpportunity` + aplicabilidad no descartada
  puede llegar a `missed_ready` — un `'no'` real (cuando algún día exista
  esa fuente) sigue bloqueando ambos lados por igual.

Produce ya 4 de los 7 estados canónicos correctamente
(`covered_verified`, `missed_ready`, `no_applicable_resource`,
`uncertain`). Deliberadamente NO resuelve todavía `unavailable_legitimate`
vs `missed_due_to_mistime` — "todo en cooldown" degrada honestamente a
`uncertain` (nunca penaliza) hasta reconstruir la cadena causal completa
de episodios anteriores de la misma habilidad, que es un algoritmo
secuencial distinto (necesita la lista completa de episodios de un
jugador×habilidad, no uno aislado) — la siguiente pieza real pendiente.
`excluded` no lo produce esta función: lo decide el caller antes de llamar
(wipe call, cutoff) sin evaluar el episodio en absoluto.

15 tests nuevos, incluido el caso explícito "aplicabilidad unknown +
cast real → covered_verified" con el motivo en el reason
("asumida correcta — DamageDescriptor pendiente") para que sea trivial de
encontrar y endurecer el día que exista esa fuente real.

Validación: `vitest` 92/92 (los cinco ficheros de Paso B/C juntos).
`verify:defensive-contract`/`verify:causal-schema`: PASS. Nada desplegado
— sigue siendo un módulo sin consumer todavía.

**Lo que queda de verdad para cerrar Paso C**: reconstrucción causal
secuencial (`unavailable_legitimate`/`missed_due_to_mistime`, necesita la
cadena completa de episodios por jugador×habilidad) y el ledger
materializer que une resolver + agrupación + aplicabilidad + veredicto y
escribe en `defensive_generations`/execution ledger. Ahí es donde por fin
se puede materializar una generación real y probar los 7 fixtures del
plan (§7) de principio a fin.

### 2026-09-04 (continuación) — Revisión completa del plan: mini-paso "C-0"

El usuario hizo una revisión de fondo de todo lo construido hasta ahora
(no solo de la pieza más reciente) y encontró un bug real de invariante
más varias correcciones de diseño necesarias ANTES de seguir con la
reconstrucción causal — exactamente en el punto en que este documento
proponía pararse a revisar. Tres afirmaciones concretas verificadas contra
Supabase/código real antes de aceptarlas: 0 filas `domain='defensive'`
materializadas hoy (confirmado), idempotencia real del materializer =
`pull_id + ledger_evaluator_version + deduplication_key` con hash de
`evidence` dentro (confirmado en `materialize-execution-ledger/index.ts`),
`player_execution_events` sin ninguna columna de generación (confirmado).
Las tres, correctas.

**Bug real corregido**: `resolveEpisodeVerdict()` (versión de esta misma
tarde) dejaba que `applicability==='unknown'` + disponible + sin cast
produjera `missed_ready` — el filtro usaba `!== 'no'` (incluye `'unknown'`)
en vez de exigir `=== 'yes'`. El propio comentario del fichero decía que
`unknown` "nunca" podía generar `missed_ready`; el código no lo cumplía.
Corregido y con test explícito de regresión (`BUG FIX (2026-09-04):
applicability unknown + available + not used must NEVER produce
missed_ready`).

**Modelo de 3 KPI formalizado** (§2.5 de este documento, reescrito):
Uso defensivo deja de ser "información descriptiva" y pasa a ser un KPI
independiente (`usageEngaged`, propiedad del episodio, no inferida del
veredicto de Respuesta). `defensive-episode-verdict.ts` reescrito para
devolver `{ usageEngaged, usedSpellIds, responseVerdict, ... }` en vez de
un único `verdict` plano — un cast real con aplicabilidad `unknown` ahora
acredita Uso sin certificar Respuesta (antes no existía ese estado
intermedio; o certificaba de más, o no acreditaba nada).

**Reconstrucción causal corregida antes de escribirse mal**: la primera
versión de `reconstructCausalAvailability` (construida en esta misma
sesión, todavía sin desplegar) habría convertido "cast anterior sin
episodio que lo explique" directamente en `missed_due_to_mistime`. Se
corrigió antes de que llegara a usarse: `missed_due_to_mistime` exige
evidencia POSITIVA (reserva rota, plan incumplido) que este módulo
plan-agnóstico no tiene — sin ella, degrada a `uncertain`. La función
ahora solo puede producir `unavailable_legitimate` o `uncertain`;
`missed_due_to_mistime` queda definido en el contrato pero inalcanzable
desde aquí hasta que exista esa fuente de evidencia (evaluator de Gestión
u otra). Nuevo wrapper `resolveEpisodeVerdictWithCausalAvailability()` que
solo promueve el `uncertain` base a `unavailable_legitimate` cuando TODOS
los candidatos en cooldown tienen esa causa demostrada — cualquier mezcla
se queda `uncertain`.

**Fail-closed de cargas**: `summarizeCandidateForEpisode()` gana un
parámetro `charges` — con `charges > 1` y un `on_cooldown` calculado por
el modelo actual (que no reconstruye cuántas cargas quedan), degrada
explícitamente a `unknown` en vez de arriesgar una indisponibilidad falsa.

**Precedencia de kit completo confirmada, no corregida**: el punto de la
revisión sobre "el veredicto pertenece al episodio, no a un spell suelto"
(Barkskin en CD legítimo + Frenzied Regeneration listo → `missed_ready`,
no `unavailable_legitimate`) ya estaba satisfecho por la estructura
existente de `resolveEpisodeVerdict()` (evalúa "¿algo del kit está ready?"
sobre TODOS los candidatos antes de intentar explicar por qué lo que está
en CD lo está) — verificado con un test explícito nuevo, no hizo falta
cambiar la estructura.

Correcciones de infraestructura para cuando se construya la capa de
persistencia/ledger (documentadas en §2.6, no implementadas todavía —
"después" del resto, tal como se acordó): `defensive_generation_id` en
`player_execution_events`, identidad de deduplicación estable
(`generationId:episodeId:player:response`, no un hash de evidence),
7 `reason_code` nuevos sin reutilizar los del evaluator V2 legacy, tabla
de staging con `UNIQUE(generation_id, pull_id, player_name)`, condición
real de `READY` (cobertura completa de `canonical_scored_pulls`, no un
report suelto), y revisión de las views agregadas del ledger para que
sean namespace/generation-aware antes de que exista una sola fila real
que puedan contar dos veces.

Validación: `vitest` 99/99 (los cinco ficheros de Paso B/C juntos, con el
fichero de veredicto reescrito). `verify:defensive-contract`/
`verify:causal-schema`: PASS. Nada desplegado — siguen siendo módulos sin
consumer.

**Siguiente paso real** (acordado, no ejecutado todavía): construir la
tabla de staging + la extensión del materializer con este diseño ya
corregido, y correr el pipeline completo contra el report del 31 de
agosto para obtener la Respuesta/Uso reales de los 7 raiders — cerrando
el círculo que abrió este documento el primer día.

### 2026-09-04 (continuación) — Revisión de gobierno completa: filosofía de entrega + reconciliación

El usuario fijó explícitamente la filosofía de entrega del documento
completo (§0): no MVP, baseline canónica completa antes de cutover, cero
fallback legacy al publicar. Pidió actualizar el plan con esa filosofía y
con un conjunto extenso de decisiones ya cerradas, comparar contra lo
implementado y enumerar qué sigue válido/qué cambia/qué falta ANTES de
seguir escribiendo código — hecho en §5.0.

Verificación puntual solicitada: si `defensive-episode-verdict.ts`
todavía dejaba que `applicability='unknown'` entrara en el conjunto
`missable`. Comprobado línea por línea contra el fichero real:
**ya no** — `missable` exige `applicability === 'yes'` estricto (línea
159) desde la corrección del turno anterior; `unknown + cast` ya
resuelve a `usageEngaged:true, responseVerdict:'uncertain'` (línea 142),
no a `covered_verified`. La revisión del usuario probablemente se redactó
contra la versión anterior a ese fix — confirmado explícitamente en la
respuesta para no dejar la duda abierta.

Cambios reales de alcance incorporados al documento (no solo
confirmaciones):

1. **§0**: filosofía de entrega + criterio final de éxito como texto
   explícito, no implícito en la suma de invariantes.
2. **§2.4.1 (nuevo)**: `DamageDescriptor` pasa de "trabajo aparte, fuera
   de este corte" a requisito de cutover con facts mínimos y criterios de
   aceptación concretos (AMS/Evasion/Feint). Cambio de alcance más grande
   de esta ronda — antes era deuda aceptada, ahora es un Paso C-1 propio
   en §5.1.
3. **§2.5.4**: `CanonicalDefensiveSummary` gana `deaths`/`evidence`/
   metadata de versión completa; se documenta la jerarquía visual de tres
   círculos solapados (Uso/Respuesta/Gestión) para Paso F.
4. **§2.7**: la condición de `READY` pasa de un párrafo a 10 gates
   explícitos (cobertura completa, versiones homogéneas, cero jobs
   pendientes, catálogo suficiente para todas las clases/specs, cadena de
   evidencia completa para `missed_ready`, causalidad positiva para
   `missed_due_to_mistime`, cargas, sin doble contabilización, summary
   reconstruible) + informe de coverage `class×spec×role×boss` obligatorio
   antes de proponer cutover.
5. **§3.4**: confirmación explícita de que Fiabilidad nunca incorpora Uso
   ni Gestión, solo Response con distinto scope temporal.
6. **§7.1 (nuevo)**: matriz de normalización cross-class tras los 7
   fixtures, con la definición exacta de "normalizado" (misma pregunta,
   no mismo número de oportunidades).

No se tocó ni se reescribió nada de la arquitectura ya construida — el
propio usuario pidió explícitamente no reiniciarla, y la revisión de §5.0
confirma que todo lo hecho hasta hoy encaja sin cambios en el modelo
ampliado.

Validación: solo cambios de documentación en este corte — no se tocó
código. `vitest`/`verify:*` no aplica (sin cambios de código); se dejan
para la siguiente pieza real (Paso C-1 `DamageDescriptor` o la tabla de
staging, a decidir).

**Pendiente de decisión del usuario**: por cuál de las dos piezas grandes
seguir — Paso C-1 (`DamageDescriptor` real, ahora bloqueante de cutover)
o la tabla de staging + extensión del ledger (arquitectura ya diseñada al
detalle en §2.6, sin incógnitas de datos). Son independientes entre sí.

### 2026-09-04 (continuación) — §2.6 completo: tabla de staging + ledger generation-aware

Decisión del usuario: la tabla de staging + extensión del ledger primero,
`DamageDescriptor` (Paso C-1) inmediatamente después. Implementado tal
cual se diseñó en §2.6, shadow puro — no se tocó `defensive_generation_pointer`,
ninguna generación pasa a `ready`, ningún número visible del front cambia
(confirmado: `player_execution_events` seguía en 0 filas antes de empezar).

**Migraciones** (`20260904110000_defensive_episode_staging_and_ledger.sql`,
`20260904120000_defensive_episode_ledger_namespace_fix.sql`, ambas
aplicadas y verificadas contra Supabase real):

- `player_pull_defensive_episode_evaluations` — staging v3, esquema
  exacto de §2.6 (`defensive_generation_id, pull_id, player_name,
  episode_evaluator_version, semantic_version, semantic_resolver_version,
  resolver_version, build_fingerprint, data_confidence, episodes jsonb,
  evaluated_at`), `PRIMARY KEY (defensive_generation_id, pull_id,
  player_name)` — no `(pull_id, player_name)` solo, tal como pedía el plan.
  Mismo patrón RLS/grants que `player_pull_defensive_evaluations` V2
  (officers-only vía `is_officer()`).
- `player_execution_events.defensive_generation_id uuid references
  defensive_generations(id)` — `NULL` en todo evento legacy, poblado solo
  en los canónicos nuevos.
- 7 reason codes nuevos añadidos al `CHECK` de `reason_code`
  (`DEFENSIVE_EPISODE_COVERED`, `DEFENSIVE_READY_NOT_USED`,
  `DEFENSIVE_MISTIMED`, `DEFENSIVE_UNAVAILABLE_LEGITIMATE`,
  `DEFENSIVE_NO_APPLICABLE_RESOURCE`, `DEFENSIVE_EPISODE_UNCERTAIN`,
  `DEFENSIVE_EPISODE_EXCLUDED`) — verificado en vivo que el nombre real del
  constraint es `player_execution_events_reason_code_check` antes de
  tocarlo.
- `player_pull_execution_summary_v3`/`night_player_execution_summary_v3`
  recreadas: `defensive_generation_id` añadido al `GROUP BY`/`SELECT`
  (separa físicamente cualquier fila canónica de la legacy, que siempre
  tiene `generation_id NULL`) + 7 columnas nuevas namespace-scoped
  (`defensive_episode_event_count`/`_success_count`/`_failure_count`/
  `_uncertain_count`, `defensive_plan_event_count`/`_success_count`/
  `_failure_count`). `CREATE OR REPLACE VIEW` no admite reordenar columnas
  ya existentes (error real encontrado: "cannot change name of view column
  event_count") — las columnas nuevas van todas al final, orden original
  intacto.
- **Bug real encontrado y corregido en la propia verificación en vivo**
  (de ahí la segunda migración): el legacy V2 YA produce eventType
  `defensive_plan_broken`/`defensive_plan_covered` (`defensive_${state}`
  con `state='plan_broken'|'plan_covered'`) — coincide por accidente de
  string con el filtro `event_type like 'defensive_plan_%'` pensado solo
  para la Gestión canónica nueva. Corregido exigiendo además
  `defensive_generation_id is not null` en esas 7 columnas — nunca pueden
  contar una fila legacy, sin importar el nombre de su `event_type`.

**Materializer** (`materialize-execution-ledger/index.ts`): nuevo
`Body.defensiveGenerationId` opcional. Sin él, comportamiento idéntico al
de antes (confirmado). Con él, además de todo lo que ya hacía, lee
`player_pull_defensive_episode_evaluations` para `(pullId,
defensiveGenerationId)` y materializa los eventos canónicos vía las
funciones puras nuevas — mismo endpoint único ("Execution Ledger como
destino único"), sin bifurcar el pipeline.

**Módulos puros nuevos** (`_shared/`, mismo estilo sin Deno/Supabase que el
resto de Paso B/C, testeados desde `src/app/shared/*.spec.ts`):

- `defensive-episode-identity.ts` — `resolveDefensiveEpisodeId()`
  (prioriza `occurrenceId`; si no, `heuristic:` + hash estable de
  `pullId+player+índices ordenados+dominantAbility+start/end`) y
  `deriveEpisodeCausalGroupId()` (proyección UUID-shaped determinista para
  la columna `causal_group_id`).
- `defensive-episode-persistence.ts` — `PersistedDefensiveEpisode` (forma
  completa: episodio + candidatos + veredicto + plan linkage + evidence +
  confidence) y `deriveUsageEvaluable()` (denominador de Uso: no
  `excluded` + al menos un `isDefensiveKitMember`).
- `defensive-episode-staging.ts` — forma de la fila de staging,
  `rollupDataConfidence()` (el más débil entre episodios) y conversión
  ↔ snake_case (`episodeEvaluationRowToDbRecord`/`dbRecordToEpisodeEvaluationRow`).
- `defensive-episode-ledger-events.ts` — `DEFENSIVE_EPISODE_EVALUATOR_VERSION
  = 'episode-evaluator@1'`, mapeo íntegro de la tabla de §2.6
  (`RESPONSE_VERDICT_TO_EXECUTION_VERDICT`/`_TO_REASON_CODE`),
  `buildDefensiveEpisodeResponseLedgerEvent()` (namespace
  `defensive_episode_*`) y `buildDefensiveEpisodePlanLedgerEvent()`
  (namespace `defensive_plan_*`, solo cuando el episodio trae
  `planAssignmentId`/`planVerdict` — ningún evaluator de Gestión los puebla
  todavía, queda listo y testeado para cuando exista).

**Identidad/idempotencia** (tal cual §2.6, corrección de infraestructura
#2): `deduplicationKey = \`${generationId}:${episodeId}:${playerName}:response\`` —
nunca depende de evidence/reason/confidence. Reevaluar el mismo episodio
dentro de la misma generación siempre pisa la misma fila vía `UPSERT`
(`onConflict: pull_id,ledger_evaluator_version,deduplication_key`, sin
tocar esa constraint). Verificado en vivo: insertar el mismo evento dos
veces con evidencia distinta deja 1 fila, no 2, y la evidencia queda la
del último `UPSERT`.

**Tests**: 6 ficheros nuevos, 53 tests (`defensive-episode-identity.spec.ts`,
`defensive-episode-persistence.spec.ts`, `defensive-episode-staging.spec.ts`,
`defensive-episode-ledger-events.spec.ts`, `defensive-episode-ledger-round-trip.spec.ts`),
cubriendo idempotencia, aislamiento entre generaciones, coexistencia
V2/canonical (formas de key estructuralmente incompatibles) y
reconstrucción staging→ledger de ida y vuelta. `vitest run`: 152/152 en los
ficheros de Paso B/C (99 previos + 53 nuevos), 0 regresiones en el resto de
la suite (los 15 ficheros que ya fallaban antes de esta sesión —
`TestBed.initTestEnvironment()`/`localStorage` en specs de componentes
Angular, entorno cruzado macOS→Windows — siguen fallando exactamente
igual, confirmado comparando contra HEAD limpio antes de tocar nada).
`ng build`: limpio (mismos warnings de presupuesto SCSS preexistentes).

**Verificación en vivo, con limpieza posterior** (más allá de vitest —
contra el esquema real ya migrado, no solo contra el razonamiento sobre el
SQL): generación shadow `building` + fila de staging con 2 episodios reales
(uno `covered_verified`, uno `missed_ready`, JSON tomado literalmente de
las funciones puras) + evento legacy V2 real (`defensive_plan_broken`,
`generation_id NULL`) para el mismo pull+jugador, todo insertado, verificado
y borrado en la misma sesión. Confirmado: (a) el `UPSERT` idempotente pisa
la fila en vez de duplicarla; (b) las views separan la fila legacy de la(s)
canónica(s) sin sumar nunca sus contadores entre sí; (c) dos generaciones
distintas del mismo episodio producen filas aisladas; (d) la DB rechaza de
verdad `penalty_eligible=true` con `confidence='uncertain'`
(`player_execution_events_check2`, constraint preexistente, no tocada).
Cero filas quedaron en la base al terminar.

**Desplegado**: `materialize-execution-ledger` (bundle 719 kB), smoke test
401 sin JWT de officer.

**Lo que queda exactamente para Paso C-1** (`DamageDescriptor` real, §2.4.1
— siguiente pieza, bloqueante de cutover): hoy `canDefensiveCover()` sigue
recibiendo un `DamageDescriptor` todo-`null` (ninguna fuente real de WCL lo
rellena), así que la aplicabilidad degrada sistemáticamente a `unknown` en
cuanto un defensivo tiene alguna restricción real (school/AoE/dodgeable/
parryable/blockable/sourceAffectedBySpell). Falta: decidir qué pedir a WCL
y dónde persistirlo (school del evento de daño, alcance AoE/single,
direct/periodic, source actor, dodge/parry/block, compatibilidad de
inmunidad — lista exacta en §2.4.1), implementar esa extracción, conectar
`canDefensiveCover()` a datos reales, y solo entonces correr el informe de
coverage `class×spec×role×boss` (§2.7) para confirmar que ninguna clase/spec
del corpus real queda `uncertain` por una pieza conocida sin implementar.
Nada de esto se ha empezado todavía — es la pieza siguiente, no un ajuste
sobre lo de hoy.

### 2026-09-04 (continuación) — Paso C-1: `DamageDescriptor` real, verificado empíricamente contra WCL

Investigación empírica en vivo (OAuth client credentials, GraphQL directo
contra `www.warcraftlogs.com/api/v2/client`, report real de la guild
`7GbANtw1J2pjZzH9`, ~28500 eventos DamageTaken/DamageDone + 15037
Debuffs(Enemies) + 2220 abilities de masterData, cruzados contra 300 filas
reales ya clasificadas por `classify-defensives` v10) **antes** de escribir
ningún contrato — nada de lo siguiente se asumió de documentación, todo se
verificó contra payloads reales.

**Hechos WCL confirmados (con evidencia, no memoria de la IA):**

- **School**: `masterData.abilities[].type` (ya se pedía, sin interpretar)
  es un bitmask de 7 bits — verificado contra 2220 abilities reales
  (1=Physical 2=Holy 4=Fire 8=Nature 16=Frost 32=Shadow 64=Arcane; combos
  reales confirmados: "Wake of Ashes"→6=Holy+Fire, "Eye Beam"/
  "Metamorphosis"→124=Fire+Nature+Frost+Shadow+Arcane). **Cero ingesta
  nueva** — el campo ya se pedía, solo faltaba decodificarlo.
- **AoE/single, direct/periodic**: campos `isAoE`/`tick`, ya presentes en
  cada evento crudo.
- **Block**: campo `blocked` (numérico, inequívoco).
- **hitType**: decodificado con certeza cruzando el `filterExpression` real
  de WCL (`missType = "dodge"/"parry"/"miss"/"immune"`, vocabulario propio
  del motor de queries de WCL, confirmado con introspección del argumento
  `filterExpression` de `events()`) contra el `hitType` numérico de eventos
  reales en 5 fights distintos del mismo report — **0=Miss 1=Hit 2=Crit
  4=Block 7=Dodge 8=Parry 10=Immune**. Cualquier otro valor no visto se
  deja sin interpretar.
- **Método de entrega (melee/ranged/spell/environmental)**: **carencia
  estructural real, no resuelta** — WCL no expone ningún campo (ni en
  `events` ni en `Casts`) que distinga ranged/spell/environmental; el único
  hecho demostrable es `abilityGameID===1`, sentinel reservado de WCL para
  "Melee" (autoataque básico, verificado). Cuantificado contra las 300
  filas reales: 251 (86%) no restringen esta dimensión (`deliveryScopes`
  incluye `'all'`), 20 no listan tags de este grupo, y **21 filas (~7%)**
  sí restringen a un subconjunto real (ej. `[melee,direct]`) — esas 21 se
  quedan `unknown` en este grupo salvo que el hit sea el sentinel Melee.
- **sourceAffectedBySpell** (Fiery Brand-style): `Debuffs(hostilityType:
  Enemies)` da eventos reales `applydebuff`/`removedebuff` sobre el boss —
  reconstruido con el mismo patrón de intervalos que `defensiveStatusAt`.
  Volumen real ~15000 eventos/6min (comparable a DamageTaken) — fetch
  condicional, decidido por el caller según si el kit efectivo del jugador
  tiene algún candidato con `requiresSourceAffectedBySpell=true` (18/300
  filas reales lo exigen).

**Decisiones del usuario tras revisar el hallazgo inicial** (2026-09-04):

1. Dodge y Parry **nunca se fusionan** — dimensiones independientes. Antes
   de dejarlas en `unknown` por imposibilidad de mapping, se probó
   empíricamente si WCL exponía el vocabulario textual `missType` — **sí lo
   expone** (confirmado con `filterExpression`), así que ambas quedaron
   **resueltas con evidencia real**, no en `unknown` permanente.
2. Cache cross-pull de facts por ability: **sí**, justificado (dodge/parry/
   block son propiedades estáticas de la ability; block solo aparece en
   ~0.4% de los hits reales, un solo pull rara vez lo demuestra). Tabla
   `ability_combat_table_facts`, versionada por `ability_game_id +
   game_build`, contadores aditivos + provenance (primer/último pull y
   boss), nunca tres booleanos eternos. Solo alimenta `DamageDescriptor` —
   `canDefensiveCover()` sigue siendo la única puerta de applicability.
3. `deliveryScopes` **no** se trata como un array plano con OR global —
   son tres dimensiones ortogonales (target scope: aoe/single_target ·
   delivery method: melee/ranged/spell/environmental · timing: direct/
   periodic), OR dentro del grupo, **AND entre grupos presentes**.
4. `school` **nunca se reduce a un solo valor** — `schools: WowSchool[]` +
   `schoolMask` crudo. Trichotomía yes/no/unknown por solape (total/cero/
   parcial) contra lo que cubre el defensivo — un hit híbrido
   Physical+Shadow contra un AMS (solo magia) degrada a `unknown`, no se
   inventa cuál school "gana".
5. `sourceAffectedBySpell` con fetch lazy/condicional (ver arriba).

**Contrato final** (`defensive-applicability.ts`, reescrito):
`DamageDescriptor { schools: WowSchool[] | null; schoolMask: number | null;
deliveryScopes: string[] | null; dodgeable/parryable/blockable: boolean |
null; sourceAffectedBySpell: boolean | null; rawHitType: number | null }`.
`canDefensiveCover()` reescrito con la trichotomía de schools y el
matching agrupado de deliveryScopes descritos arriba — **conectado
directamente**, no se crea un evaluator paralelo.

**Módulos nuevos** (`_shared/`, puros, sin Deno/Supabase):
`damage-descriptor-wcl.ts` (`decodeSchoolMask`, `describeHitType`/
`WCL_HIT_TYPE_MEANING`, `tallyAbilityCombatTableObservations`/
`mergeAbilityCombatTableObservations`/`combatTableVerdictFor`,
`deliveryTagsForHit`, `buildDebuffIntervals`/`isSourceAffectedBySpellAt`
— nunca devuelve `false`, solo `true`/`null`, `buildDamageDescriptor`);
`ability-combat-table-cache.ts` (forma de fila + `mergeObservationIntoCacheRow`,
puramente aditivo).

**Migración** (`20260904130000_ability_combat_table_facts.sql`): tabla
`ability_combat_table_facts` (PK `ability_game_id + game_build`,
contadores `dodge_count`/`parry_count`/`block_count`, provenance
`first/last_observed_at/pull_id/boss_id`), RLS officers-only, aplicada y
verificada en Supabase real.

**Tests**: 67 nuevos (`damage-descriptor-wcl.spec.ts` 26,
`ability-combat-table-cache.spec.ts` 8, `defensive-applicability.spec.ts`
reescrito 11→22 con la nueva trichotomía/agrupación) — todos con valores de
referencia reales verificados (school combos, hitType), no inventados.
`vitest run`: 321 tests pasan (15 ficheros fallan por infraestructura
Angular preexistente/no relacionada, mismos exactos que en HEAD antes de
esta sesión — confirmado por comparación). `ng build`: limpio.

**Informe de cobertura empírico** (300 defensivos reales × 399 "shapes" de
daño únicos reales del report, 119700 combinaciones — sin
`sourceAffectedBySpell` en este pase para aislar el resto de dimensiones):

| | % |
|---|---:|
| `yes` | 79.0% |
| `no` | 12.1% |
| `unknown` | 8.9% |

Desglose del 8.9% `unknown` — **ninguno es "funcionalidad pendiente
disfrazada de incertidumbre"**, los tres motivos son incertidumbre real:

1. **~55% de los unknown**: grupo "método de entrega" no demostrable (la
   carencia estructural ya documentada arriba — 21/300 defensivos reales
   afectados, cero relación con clase/spec, es un límite de datos de WCL).
2. **~7% de los unknown**: schools combinadas con solape parcial (ej. un
   hit "Chaos"-like de 5-7 schools a la vez contra un defensivo de school
   específica) — ambigüedad real, exactamente el caso que la trichotomía
   está diseñada para no fingir resuelto.
3. Resto: `requiresDodgeable`/`requiresParryable` sin evidencia todavía en
   este fight concreto (el propio fight 34 tuvo 0 dodges reales — sí los
   tuvo el fight 39 del mismo report, ver validación cruzada abajo).

**Validación cruzada de los 3 fixtures de interacción + Fiery-Brand-style,
con datos 100% reales:**

- AMS vs hit físico real → `no` (school mismatch, correcto).
- Feint vs hit AoE real → `yes`; Feint vs hit single-target real → `no`.
- Evasion vs un hit real sin evidencia de dodge en su fight → `unknown`
  (fail-closed correcto). Fusionando evidencia de OTRO fight del mismo
  report (fight 39, que sí tuvo dodges reales) — **exactamente el
  escenario que justifica el cache cross-pull** — `dodgeable` pasa a
  `true` con evidencia real; el veredicto final da `no` por una dimensión
  distinta (el hit es `periodic`, Evasion solo cubre `direct`) — la
  demostración de que el matching agrupado AND-entre-grupos funciona de
  extremo a extremo con datos reales, no solo en el test unitario.
- `sourceAffectedBySpell` con intervalos reales de `Debuffs(Enemies)`:
  dentro de un intervalo real observado → `yes`; en un instante
  genuinamente anterior a cualquier aplicación del debuff (1h antes del
  fight) → `unknown` (nunca `false` fabricado). Primer intento de este
  check tenía un bug real (probar "+60s tras el remove" caía dentro de
  OTRA reaplicación posterior del mismo debuff en el mismo fight,
  produciendo un falso `yes`) — corregido antes de reportarlo.

**Cambios de ingesta/reanálisis**: **ninguno todavía**, deliberado — mismo
patrón que el resto de Paso C (funciones puras sin consumer). El hecho
clave de la investigación de ingesta: ni `analyze-report` ni ningún otro
consumer persiste eventos WCL crudos hoy; el patrón ya establecido
(`reanalyze-defensive-pressure`) es volver a pedirlos a WCL en cada
reanálisis — el futuro evaluator de episodios (Paso D) debe seguir ese
mismo patrón, no crear una tabla de eventos crudos nueva. `masterData.abilities`
(con `type`) ya se pide hoy sin cambios; `Debuffs(Enemies)` sería la única
llamada genuinamente nueva, y solo condicional.

**Carencia estructural que queda documentada, no oculta**: método de
entrega (melee/ranged/spell/environmental) más allá del sentinel Melee.
Afecta a ~7% de los defensivos reales ya clasificados. No es un `uncertain`
que sustituya trabajo pendiente — es un límite real de qué expone la API
de WCL hoy; si en el futuro aparece una fuente (ej. cruce con SimC/talent
data, o un campo nuevo de WCL), este es el punto exacto a revisar.

**Pendiente de decisión del usuario**: con esta distribución real
(79/12/9, causas ya desglosadas), decidir si `applicability` tiene
cobertura suficiente para seguir con disponibilidad causal/charges y
generar la primera generación shadow completa, o si conviene cerrar antes
la carencia de método de entrega.
