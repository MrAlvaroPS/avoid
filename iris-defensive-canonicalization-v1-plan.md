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
que enlazar con el cast anterior — si cubrió una amenaza real,
`unavailable_legitimate`; si no tenía justificación y dejó vendido al
jugador después, `missed_due_to_mistime`; si no se puede demostrar,
`uncertain`.

### 2.5. Métrica principal: Respuesta defensiva

$$
Respuesta = \frac{covered\_verified}{covered\_verified + missed\_ready + missed\_due\_to\_mistime}
$$

Sin pesos ocultos. Sustituye a "Gestión defensiva" como KPI. "Uso
defensivo" (casts por habilidad) queda como información descriptiva, nunca
como KPI en sí — no hay denominador universal justo entre clases con CDs de
15s y otras de 2min.

### 2.6. Plan, solo cuando hay plan

$$
Plan = \frac{asignaciones\ cubiertas}{asignaciones\ evaluables}
$$

Si `plan_required_count = 0`: **"Sin plan defensivo asignado"**, nunca 0%.
Response y Plan son dos evaluators distintos que nunca comparten
porcentaje (pueden vivir en el mismo edge function).

### 2.7. Execution Ledger como destino único

Nuevos `eventType` sobre los `domain`/`causalGroupId`/`verdict`/
`reasonCode`/`creditEligible`/`penaltyEligible` ya existentes:

- `domain=defensive`: `personal_defensive_cast` (uso).
- `defensive_episode_covered` / `_missed_ready` / `_mistimed`... (Response).
- `defensive_plan_covered` / `_missed`... (Plan).
- `domain=active_mitigation` (tank, fase posterior, no bloquea esta migración).

El front no vuelve a leer pressure windows/evaluation JSONs/reliability
legacy por separado: lee una proyección del ledger publicado.

### 2.8. Generación publicada (cutover atómico)

```text
BUILDING → READY → PUBLISHED
```

Cada derivado lleva `generation_id`/`semantic_version`/`resolver_version`/
`episode_version`/`evaluator_version`. El report apunta a
`published_generation_id`. La reanalización tarda lo que tarda; el front
sigue viendo la generación anterior hasta que se hace un único
`UPDATE ... SET published_defensive_generation_id = new_generation`.

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
4. **Paso C** — Backend en shadow. **Primera pieza hecha:
   `resolveEffectiveDefensiveKit()` ampliado con usageRole/mechanisms/
   membership derivado, retrocompatible, 36/36 tests (ver §8).** Falta
   `DefensiveEpisode`/aplicabilidad/disponibilidad causal/ledger
   materializer. `semantic-version@1`/`effective-defensive-semantics@1.0.0`
   ya versionados por separado del resolver de timing; `episode-evaluator@1`
   pendiente.
5. **Paso D** — Reanálisis masivo (cola ya existente) de los pulls a
   conservar.
6. **Paso E** — Fixtures de aceptación obligatorios (§7).
7. **Paso F** — Cutover atómico: `published_generation` + ViewModel/front
   nuevo (§2.8), sin pantalla mixta V2/V3.
8. **Paso G — Fiabilidad**: sustitución del eje `defensiva`, penalización
   de preparación, cap de mecánica en el composite, cierre de
   `reliabilityExecutionV3`, Roster/Night Report.
9. **De-legacy** (después del cutover, no antes): dejar de escribir
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
