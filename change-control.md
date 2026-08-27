# Control de cambios técnico

## 1. Objetivo y alcance

Este documento describe las modificaciones realizadas durante este bloque de trabajo para que puedan revisarse funcional y técnicamente antes de desplegarlas. El alcance comprende:

- detección y tratamiento estadístico de wipe calls;
- exclusión de muertes no accionables por `Melee` del boss sobre no-tanks;
- medición de defensivos, healthstones y pociones durante todo el try;
- nueva fórmula de fiabilidad y métrica de consistencia;
- corrección de los slots de enchants y gemas de la season;
- filtrado de mecánicas por boss y dificultad usando evidencia contrastable;
- mejora de la detección de oneshots;
- cambios en dossier de jugador, roster, informe nocturno y análisis IA;
- consistencia de los cálculos históricos y agregados;
- compatibilidad temporal entre un frontend nuevo y un esquema de Supabase aún no migrado;
- corrección de los errores visuales `[object Object]` y recuperación de las pestañas de «A quién dirigir».

La solución mantiene como principio que un dato sin evidencia no debe convertirse silenciosamente en un cero ni en una acusación al jugador. Las muertes y eventos no evaluables se conservan como contexto, pero se excluyen de las métricas que atribuyen responsabilidad.

## 2. Resumen de arquitectura

El flujo de datos afectado queda así:

1. `analyze-report` obtiene eventos de Warcraft Logs y construye `pulls`, `player_pull_records` y `pull_mechanic_events`.
2. Las migraciones reconstruyen datos históricos posibles y exponen vistas estadísticas derivadas.
3. Las vistas `applicable_boss_mechanics_candidates` y `applicable_pull_mechanic_events` filtran mecánicas por dificultad sin borrar la evidencia original.
4. `player_pull_reliability_inputs` produce una fila evaluable por jugador y pull.
5. Los servicios Angular agregan esos datos por pull, boss, noche, jugador y ventana de 60 días.
6. Los contextos de IA consumen las mismas exclusiones y semántica que la interfaz.

La fuente de verdad se reparte de la siguiente manera:

| Decisión | Fuente de verdad |
| --- | --- |
| Inicio de wipe call | `pulls.wipe_call_signals.wipeCallStartMs` |
| Activación manual de la exclusión | `pulls.wipe_call_excluded` |
| Muerte perteneciente al cierre del wipe | `player_pull_records.wipe_call_cluster` |
| Muerte no atribuible por melee del boss | `death_cause.statisticalExclusionReason` |
| Uso de defensivos durante el try | `player_pull_records.defensive_casts` |
| Piedra/poción durante el try | `player_pull_records.consumables` |
| Mecánica aplicable a una dificultad | vistas `applicable_*` y evidencia en `boss_mechanics_candidates` |
| Perfil oneshot/sostenido | `death_cause.damageProfile` y campos de burst |
| Fiabilidad | vista `player_pull_reliability_inputs` + `ReliabilityService` |

## 3. Wipe calls

### 3.1. Problema corregido

El tratamiento anterior podía excluir el pull completo o solamente el grupo compacto usado para detectar el wipe. Esto producía dos errores opuestos:

- desaparecían fallos reales ocurridos antes de que se diese el wipe call;
- algunas muertes tardías, posteriores al cluster detector, reaparecían como errores mecánicos del jugador.

Ahora el wipe call se modela como un límite temporal explícito. Los eventos anteriores al límite siguen siendo evaluables y los posteriores quedan fuera de las estadísticas cuando `wipe_call_excluded` está activo.

### 3.2. Algoritmo de detección

La detección vive en `supabase/functions/analyze-report/index.ts` y sólo se ejecuta en wipes, nunca en kills.

Parámetros actuales:

- ventana deslizante de cluster: `8.000 ms`;
- mínimo de muertes simultáneas: `60%` de los jugadores vivos al inicio del cluster;
- el cluster debe terminar como máximo `15.000 ms` antes del final del pull;
- umbral de autoexclusión: confianza `>= 55`;
- muerte masiva temprana: al menos `60%` de la raid durante los primeros `10.000 ms`.

En vez de elegir el mayor cluster de todo el combate y comprobar después si era terminal, se busca directamente el mayor cluster terminal. Así un pico de muertes recuperado a mitad de combate no oculta un wipe call real al final.

Las señales empleadas son:

- fracción de jugadores vivos que mueren en el cluster;
- diversidad de habilidades letales;
- fracción de causas desconocidas;
- caída de sanación de raid después del límite, comparada con el ritmo anterior;
- caída de daño de raid después del límite;
- proporción de muertes por daño sostenido o desconocido;
- proximidad al final del pull.

Para evitar confundir una mecánica letal de raid con un wipe call, se aplica una contraseñal: si al menos el `70%` del cluster muere a la misma habilidad y predominan perfiles burst, no se clasifica como wipe call. Para un wipe ordinario hacen falta al menos dos evidencias entre diversidad/causa desconocida, colapso de healing, colapso de daño y muertes sostenidas.

La confianza se calcula con esta ponderación:

```text
20% simultaneidad
20% diversidad de habilidades
10% causas desconocidas
20% colapso de healing
10% colapso de daño
10% daño sostenido
10% proximidad al final
```

Una muerte masiva temprana fuerza una confianza mínima de `85`, fija el inicio del wipe en `0 ms` y no conserva una fase previa como evaluable.

### 3.3. Conservación de las muertes desencadenantes

En un wipe call normal, las primeras muertes pueden ser la causa real del wipe. Por eso se conservan como evaluables entre una y tres muertes iniciales:

```text
triggerDeathCount = min(3, max(1, floor(clusterSize * 0,2)))
```

`wipeCallStartMs` se fija en la primera muerte posterior a esas muertes desencadenantes. A partir de ese instante, todas las muertes restantes del pull se marcan como `wipe_call_cluster`, aunque ocurran más de ocho segundos después. El cluster corto sólo sirve para detectar el call; no limita el alcance posterior de la exclusión.

Las señales persistidas en `pulls.wipe_call_signals` son:

- `simultaneityFraction`;
- `abilityDiversity`;
- `nearEndMs`;
- `healingCollapseRatio`;
- `damageCollapseRatio`;
- `sustainedDeathFraction`;
- `unknownDeathFraction`;
- `triggerDeathsKept`;
- `wipeCallStartMs`;
- `earlyMassDeath`.

### 3.4. Aplicación estadística

Se añadió `src/app/shared/death-statistics.util.ts` para evitar que cada pantalla aplique criterios diferentes:

- `wipeCallStartMs()` devuelve límite sólo si `wipe_call_excluded` está activo;
- `isMechanicExcludedByWipeCall()` excluye únicamente eventos con `trigger_time_ms >= wipeCallStartMs`;
- `isDeathExcludedFromStatistics()` combina wipe call e exclusiones intrínsecas.

Este criterio se utiliza en pull actual, histórico de boss, dossier nocturno, informe nocturno, patrones repetidos, contexto IA y fiabilidad. Una mecánica fallada antes del call sigue apareciendo; una mecánica posterior no incrementa fallos ni patrones.

### 3.5. Datos históricos

La migración `20260825200000_wipe_call_boundaries_and_non_actionable_deaths.sql`:

1. reconstruye `wipeCallStartMs` con la primera muerte histórica ya marcada como `wipe_call_cluster`;
2. marca como cluster todas las muertes posteriores al límite;
3. reconstruye `player_pull_reliability_inputs` para neutralizar sólo las señales no evaluables;
4. reconstruye `player_mechanic_offenses` excluyendo exclusivamente los eventos posteriores al límite.

No se elimina la fila jugador/pull. Esto es importante porque borrarla también perdería preparación, defensivos o daño evitable real ocurrido antes del wipe call.

## 4. Melee del boss sobre jugadores no-tank

### 4.1. Nueva clasificación

Se añadió el motivo de exclusión:

```text
death_cause.statisticalExclusionReason = "boss_melee_on_non_tank"
```

Para análisis nuevos, la clasificación es deliberadamente estricta. Deben cumplirse todas estas condiciones:

- el jugador no es tank según clase/spec resuelta;
- el killing ability normalizado es `Melee`;
- existe un actor de boss identificado;
- todo el daño de los últimos `2.000 ms` procede de ese boss;
- todos esos eventos usan la misma habilidad `Melee`;
- no hay otra fuente o habilidad de daño mezclada en esa ventana.

Así se evita convertir cualquier muerte que termina con un autoataque en una muerte no evaluable. El caso representado es que el boss ha dejado de estar controlado por los tanks.

### 4.2. Efecto funcional

La muerte se sigue mostrando como contexto con la etiqueta `TANKS CAÍDOS · NO EVALUABLE`, pero:

- no cuenta como muerte estadística del jugador;
- no afecta a fiabilidad;
- no se considera fallo mecánico personal;
- no evalúa disponibilidad o falta de uso de defensivos;
- no evalúa healthstone o poción como error del objetivo;
- no alimenta patrones repetidos ni coaching negativo.

`preventableWithDefensive` pasa a `null` y `defensiveOptions` se guarda vacío para esta causa.

### 4.3. Backfill histórico

La misma migración realiza un backfill conservador para datos ya procesados: marca `Melee` de no-tanks en wipes después de la primera muerte de un tank. Este backfill no dispone de la fuente detallada y exclusividad de los últimos dos segundos con la misma precisión que el analizador nuevo. Para obtener la clasificación estricta en pulls antiguos se recomienda reanalizar el report.

## 5. Defensivos durante todo el try

### 5.1. Cambio de modelo de evaluación

Antes la disciplina defensiva se basaba casi exclusivamente en el estado del jugador al morir. Ahora hay dos señales independientes:

- `used_defensive_when_died`: respuesta directa en una muerte evaluable;
- `used_defensive_in_pull`: al menos un cast defensivo registrado antes del límite del wipe call.

También se añadió `defensive_use_opportunity`, que evita castigar a un jugador por no gastar defensivos en un pull limpio y sin presión observable.

Existe una oportunidad defensiva si se cumple al menos una condición:

- el jugador usó un defensivo, lo que crea una muestra positiva;
- murió de forma evaluable y tenía un catálogo defensivo valorable;
- recibió daño evitable verificable antes del wipe call.

Los casts posteriores al límite del wipe call no cuentan como evidencia positiva.

### 5.2. Ponderación

La respuesta al morir es la señal más accionable y pesa el doble:

```text
respuesta en muerte evaluable = peso 2
uso general durante el try    = peso 1
```

Por ejemplo, si en un pull hubo una muerte evaluable y una oportunidad general, el eje defensivo del pull se calcula sobre tres unidades de peso. Un pull limpio sin oportunidad no introduce ni un cero ni un cien artificial.

### 5.3. Propagación a informes e IA

El uso general se incorporó a:

- fiabilidad de 60 días;
- fiabilidad de una noche;
- consistencia;
- dossier del jugador;
- informe completo de noche;
- comparación entre primera y segunda mitad de una noche;
- contextos de IA de pull y jugador/noche.

El informe nocturno calcula cobertura defensiva con la misma relación `2:1` y usa eventos de presión realmente evaluables, no el agregado bruto anterior.

## 6. Healthstone y poción durante el try

La evaluación dejó de limitarse a los `15 s` anteriores a la muerte. Ahora se considera uso si `consumables.healthstone.used`, `consumables.healthPotion.used` o sus `timestampsMs` registran cualquier uso durante el pull.

Se renombraron los contratos para hacer explícita la semántica:

- `usedHealthstoneBeforeDeath` → `usedHealthstoneInPull`;
- `usedHealthPotionBeforeDeath` → `usedHealthPotionInPull`;
- `deathsWithObservedAccessNoRecentUse` → `deathsWithObservedAccessNoUseInPull`;
- `pctDeathsWithNoRecentEmergencyConsumable` → `pctDeathsWithNoEmergencyConsumableInPull`.

El cambio se propagó a dossier, modal de informe, Markdown/Discord, modelo `NightFullReport`, contexto IA y tests. El esquema lógico del informe completo subió a `schemaVersion: 11`, por lo que los informes cacheados con una versión anterior se consideran obsoletos y se regeneran.

En muertes no evaluables el uso puede seguir mostrándose como hecho factual, pero no se usa para penalizar al jugador.

## 7. Fiabilidad y consistencia

### 7.1. Fórmula global de fiabilidad

La ventana general sigue siendo de `60 días`, con una semivida de `10 días`:

```text
peso_recencia = 0,5 ^ (días_desde_pull / 10)
```

Los ejes son:

| Eje | Peso | Cálculo |
| --- | ---: | --- |
| Mecánica | 40% | Pull limpio si no hubo daño evitable ni muerte por posicionamiento propio |
| Defensiva | 30% | Uso general del try más respuesta en muerte, esta última con peso doble |
| Preparación | 20% | Cobertura conjunta de slots elegibles de enchant y gema |
| Asistencia | 10% | Reports realmente importados en Avoid desde el inicio de season |

Si falta un eje, no se rellena con cero: se excluye y se renormalizan los pesos disponibles. La asistencia no se usa para una única noche porque no representa una ventana temporal válida en ese ámbito.

La asistencia deja de depender del porcentaje del calendario de Wowaudit y se calcula con raids reales importadas en Avoid.

### 7.2. Nueva métrica de consistencia

Se añadió `PlayerConsistency`, separada del score global. Para cada pull se calcula una ejecución:

```text
si existe muestra defensiva:
    ejecución_pull = 70% mecánica + 30% defensiva
si no existe muestra defensiva:
    ejecución_pull = mecánica
```

Después se obtiene media y desviación estándar ponderadas por recencia:

```text
consistencia = clamp(media_ejecución - 0,5 * desviación, 0, 100)
```

La métrica no se publica con menos de cinco pulls. Esto evita presentar una falsa estabilidad a partir de una muestra insuficiente. También se exponen:

- `averageExecution`;
- `volatility`;
- `cleanPullRate`, considerando limpio un valor por pull `>= 80`;
- `sampleSize`.

La fórmula no premia ser constantemente malo porque parte del nivel medio y después penaliza la variabilidad.

### 7.3. Presentación

Se añadió:

- columna `Consistencia` en el roster;
- tooltip con media, variabilidad y tasa de pulls limpios;
- gráfica semanal de consistencia en el perfil del jugador;
- consistencia general y nocturna en los tooltips del dossier;
- explicación de muestra mínima de cinco pulls.

El perfil semanal reutiliza exactamente `computeReliabilityBreakdown`; no existe una fórmula paralela para el dossier.

### 7.4. Compatibilidad con vistas antiguas

`ReliabilityService` prueba tres niveles de columnas:

1. esquema actual completo;
2. esquema con defensivos pero sin slots de gema;
3. esquema legado.

Sólo entra en fallback para errores de transición de columna (`42703`, `PGRST204` o nombres conocidos). Esto impide que un despliegue del frontend anterior a la migración deje el roster vacío. Al aplicar la migración, se usa automáticamente el contrato completo.

## 8. Enchants y gemas de la season

### 8.1. Slots corregidos

Se centralizó el cálculo en `src/app/shared/gear-preparation.util.ts` usando índices del array `CombatantInfo` de WCL, no IDs de inventario de Blizzard.

Slots encantables:

```text
[0, 2, 4, 6, 7, 10, 11]
cabeza, hombros, pecho, piernas, botas y dos anillos
```

Slots con gema exigible:

```text
[1, 10, 11]
cuello y dos anillos
```

Muñecas y capa ya no se consideran encantables. Un enchant sólo cuenta si `permanentEnchant > 0` y el ítem existe.

### 8.2. Criterio de gemas

No se intenta inventar el máximo teórico de sockets de cada objeto. Se exige al menos una gema en cada slot elegible equipado:

```text
preparación =
  (slots_encantados + slots_elegibles_con_al_menos_una_gema)
  / (slots_encantables_equipados + slots_gemables_equipados)
```

`gemCount` se conserva como dato informativo, pero el score usa `gemmedSlotCount/gemmableSlotCount` para que varias gemas en un único objeto no oculten un anillo vacío.

La vista SQL de fiabilidad y el helper TypeScript del dossier usan los mismos índices y el mismo criterio. El roster consume el resultado SQL; el snapshot nocturno usa `gearPreparationCounts()`. Los tests del helper documentan el contrato para evitar que ambas implementaciones vuelvan a divergir.

## 9. Filtrado de mecánicas por dificultad

### 9.1. Evidencia persistida

La migración `20260826100000_preparation_slots_and_difficulty_evidence.sql` añade a `boss_mechanics_candidates`:

- `observed_in_reference_logs`: vista en casts, daño o interrupts de logs públicos de esa dificultad;
- `official_difficulty_applicable`: resultado oficial DB2 (`true`, `false` o `null` si no se pudo resolver).

También se mantienen las señales existentes:

- `observed_in_logs` para logs de la guild;
- `observed_as_interrupt`;
- `reference_occurrences`;
- `reference_source_report`.

`sync-boss-mechanics` marca como `official_difficulty_applicable = false` las habilidades excluidas explícitamente por DB2, pero no borra la fila. Las clasificaciones y notas manuales se conservan para auditoría. Las fuentes pasan a registrar `blizzard-journal`, `wcl-reference` y/o `guild-log` según corresponda.

### 9.2. Vistas aplicables

`applicable_boss_mechanics_candidates` conserva una candidata cuando:

- hay evidencia positiva en la dificultad exacta;
- no se ha podido contrastar todavía;
- no existe contradicción positiva en otra dificultad;
- DB2 no la excluye expresamente.

Sólo se excluye de las estadísticas cuando la dificultad actual se contrastó sin encontrarla y otra dificultad sí aporta evidencia, o cuando DB2 la excluye. Si hay una observación real de la guild que contradice DB2, prevalece la observación para no borrar un hecho registrado.

`applicable_pull_mechanic_events` cruza cada evento histórico con boss y dificultad. Los eventos sin candidata asociada se conservan de forma conservadora; los eventos asociados a una candidata descartada se excluyen.

La tabla base nunca se borra. Esto permite auditar y cambiar el criterio sin perder datos históricos.

### 9.3. Consumidores actualizados

Las vistas filtradas se usan en:

- `analyze-report`;
- clasificación de mecánicas;
- pull actual y pulls previos;
- dossier e informe de noche;
- histórico de boss;
- patrones de ofensores repetidos;
- fiabilidad;
- estadísticas observadas de Ajustes;
- contextos de IA e informe completo.

En Ajustes se muestra la fuente de evidencia y el número de mecánicas ocultadas para la dificultad seleccionada. La función `isContradictedByOtherDifficulty()` evita asumir exclusividad cuando la dificultad actual ni siquiera llegó a contrastarse.

## 10. Detección de oneshot

### 10.1. Recursos de WCL

`getFightEvents()` acepta ahora `includeResources`. Sólo se activa para `DamageTaken`, porque aumenta el payload. Esto permite leer `hitPoints` y `maxHitPoints` del objetivo.

### 10.2. Algoritmo

La nueva función compartida `computeDamageProfile()` analiza los últimos `5.000 ms`, separando esa ventana de contexto de la ventana burst de `1.000 ms`.

Se clasifica como `burst`/oneshot cuando:

- la suma del daño del último segundo es al menos el `80%` de la vida máxima; o
- no existe vida máxima en un log antiguo y al menos el `80%` del daño de los últimos cinco segundos se concentra en el último segundo; o
- se cumple la heurística heredada conservada por compatibilidad: hasta tres impactos y uno concentra al menos el `60%` del daño de la ventana.

La regla usa la suma de impactos del mismo segundo, no únicamente el killing blow. Por tanto, dos golpes de `45% + 35%` dentro del último segundo son un oneshot aunque el jugador ya tuviera daño anterior.

Se guardan:

- `damageProfile`;
- `killingBlowAmount`;
- `damageWindowTotal`;
- `damageWindowHits`;
- `terminalBurstDamage`;
- `burstWindowMs`;
- `maxHitPoints`;
- `burstHealthPct`;
- `damageWindowEvents`.

Los contextos IA reciben `oneshot` y `burstHealthPct` y tienen una instrucción explícita: si `oneshot=true`, no atribuir la muerte a falta de healing reactivo.

### 10.3. Histórico

La migración `20260826110000_oneshot_burst_window.sql` recalcula perfiles que ya tengan `damageWindowEvents`. Como esos JSON históricos no guardan vida máxima, utiliza concentración temporal y nunca rebaja un burst ya existente. Para aplicar la regla exacta del `80%` de vida máxima a pulls antiguos es necesario reanalizar el report con `includeResources`.

## 11. Dossier de jugador y roster de raid

### 11.1. Tabla de muertes

En el dossier nocturno, las muertes se ordenan por el orden de aparición del boss en la noche, después por número de pull y finalmente por instante dentro del pull. La tabla identifica cada fila mediante `Boss + #pull`, en lugar de ser una lista global ordenada sólo por minuto.

Los wipe calls siguen visibles con su etiqueta, pero no incrementan `totalDeaths`. Las muertes por melee no evaluable también permanecen visibles con su causa específica.

La columna de consumibles se renombró a `¿Poción/piedra en el try?` y usa todo el pull. La información de defensivos continúa mostrando únicamente opciones `available_unused` en muertes evaluables.

### 11.2. Equipo y fiabilidad

El snapshot final muestra:

- enchants cubiertos/elegibles;
- slots de gema cubiertos/elegibles;
- cantidad total de gemas;
- equipo y talentos del último pull del jugador esa noche.

Los tooltips diferencian fiabilidad de 60 días y fiabilidad de la noche y añaden consistencia.

### 11.3. Iconos de clase

`ReportsService.listNightPlayers()` pasó de devolver `string[]` a devolver:

```ts
interface NightPlayerListItem {
  name: string;
  className: string | null;
}
```

La clase se obtiene de `player_pull_records`, conservando el primer valor no nulo por jugador. La sección «Dosier de jugador esta noche» muestra `ClassIconComponent` junto al nombre.

## 12. «A quién dirigir»

El componente conserva dos pestañas:

- `Mecánicas`: fallos de responsabilidad individual sin muerte;
- `Muertes`: muertes, estados defensivos, healing, oneshot y contexto de wipe.

Las pestañas no se habían eliminado del template. Desaparecieron funcionalmente porque `applicable_pull_mechanic_events` aún no existía en el Supabase remoto y la consulta devolvía cero eventos. La compatibilidad de esquema descrita en la sección 14 restaura los datos desde `pull_mechanic_events` hasta que la migración esté aplicada.

Los contadores excluyen wipe calls y muertes no evaluables de las métricas negativas, aunque las filas sigan visibles para el raid lead.

## 13. Análisis IA e informes

### 13.1. Diseño visual

La tarjeta de análisis dejó de distribuir `Bien`, `Mal` y `Próximo intento` en columnas. Ahora son filas de ancho completo, separadas visualmente, para que textos largos se lean sin columnas estrechas ni bloques huérfanos.

### 13.2. Contexto técnico

Los contextos de IA se actualizaron para incluir:

- mecánicas aplicables a la dificultad;
- eventos anteriores al límite del wipe call;
- oneshot y porcentaje de vida concentrado en burst;
- uso de defensivo durante el try;
- respuesta defensiva al morir;
- oportunidades defensivas;
- piedra/poción durante todo el try;
- cobertura real de enchants y gemas;
- exclusión de melee no atribuible.

El daño evitable de los informes se reconstruye desde `player_hit_details` de eventos aplicables y evaluables, en lugar de sumar el agregado bruto de `player_pull_records`, que podía incluir daño posterior a un wipe call o mecánicas de otra dificultad.

El informe completo usa `schemaVersion: 11`; tanto el generador como el cliente rechazan cachés antiguas.

## 14. Compatibilidad de esquema y corrección de `[object Object]`

### 14.1. Causa raíz

El frontend se ejecutó contra un Supabase remoto que todavía no tenía:

- `applicable_pull_mechanic_events`;
- `applicable_boss_mechanics_candidates`;
- columnas nuevas de `player_pull_reliability_inputs`.

PostgREST devolvía objetos planos con códigos como `PGRST205` o `42703`. Los componentes aplicaban `String(err)`, cuyo resultado para un objeto plano es literalmente `[object Object]`. Algunas pantallas relanzaban el error y otras quedaban sin datos, como «A quién dirigir».

### 14.2. Normalización de errores

Se añadió `src/app/shared/error-message.util.ts`:

- usa `Error.message` para errores nativos;
- extrae `message`, `details` y `hint` de Supabase;
- usa el campo `error` si existe;
- serializa un objeto desconocido como JSON;
- evita siempre `[object Object]`;
- detecta relaciones ausentes mediante `PGRST205` o `42P01` y el nombre exacto de la relación.

Los componentes principales de roster, histórico, raid, pull, boss, dossier, informe, Ajustes y acciones IA usan este helper.

### 14.3. Fallback de relaciones

Se añadió `src/app/shared/supabase-query.util.ts`. `withSupabaseRelationFallback()`:

1. ejecuta la consulta sobre la vista nueva;
2. sólo si PostgREST confirma que falta esa relación, repite sobre la tabla antigua;
3. no oculta errores de permisos, datos ni sintaxis.

Fallbacks actuales:

| Vista preferida | Fallback temporal |
| --- | --- |
| `applicable_pull_mechanic_events` | `pull_mechanic_events` |
| `applicable_boss_mechanics_candidates` | `boss_mechanics_candidates` |

Se aplica en pull actual, pulls anteriores, dossier, informe nocturno, histórico de boss, notas de mecánicas y estadísticas de Ajustes.

Este fallback mantiene la aplicación operativa durante un despliegue escalonado, pero el filtrado refinado por dificultad sólo es efectivo cuando las vistas nuevas están desplegadas. No sustituye la migración.

## 15. Consistencia entre superficies

Los mismos filtros se propagaron para evitar que una cifra cambie según la pantalla:

| Superficie | Wipe call | Melee no evaluable | Dificultad | Defensivo en try | Consumible en try |
| --- | --- | --- | --- | --- | --- |
| Pull actual | Sí | Sí | Sí | Sí | Sí |
| Histórico de boss | Sí | Sí | Sí | N/A agregado | N/A |
| Dossier nocturno | Sí | Sí | Sí | Sí | Sí |
| Perfil de jugador | Sí | Sí | Notas aplicables | Vía fiabilidad | N/A |
| Roster/fiabilidad | Sí | Sí | Sí | Sí | N/A |
| Ofensores repetidos | Sí | N/A | Sí | N/A | N/A |
| Informe nocturno | Sí | Sí | Sí | Sí | Sí |
| Contextos IA | Sí | Sí | Sí | Sí | Sí |

Las medias y tendencias no leen directamente los agregados antiguos cuando existe una fuente de eventos más precisa. La vista de fiabilidad y el informe completo recalculan la parte evaluable a partir de eventos pre-wipe y aplicables a la dificultad.

## 16. Migraciones y orden de despliegue

### 16.1. Migraciones implicadas

- `20260825200000_wipe_call_boundaries_and_non_actionable_deaths.sql`:
  - backfill de `wipeCallStartMs`;
  - ampliación histórica del cluster posterior;
  - backfill conservador de melee no-tank;
  - reconstrucción de fiabilidad y ofensores repetidos.
- `20260826100000_preparation_slots_and_difficulty_evidence.sql`:
  - evidencia por dificultad;
  - vistas `applicable_*`;
  - slots correctos de enchant/gema;
  - reconstrucción de fiabilidad y ofensores.
- `20260826110000_oneshot_burst_window.sql`:
  - reclasificación histórica no destructiva de burst.

### 16.2. Orden recomendado

1. Realizar backup o snapshot de la base.
2. Aplicar migraciones SQL en orden de timestamp.
3. Verificar que PostgREST expone las vistas y columnas nuevas.
4. Desplegar las Edge Functions modificadas.
5. Desplegar el frontend.
6. Regenerar informes completos cacheados.
7. Reanalizar una muestra de reports para validar oneshot exacto y melee estricto.

Las Edge Functions nuevas sí dependen de las vistas nuevas, por lo que la base debe desplegarse antes que `analyze-report`, `classify-mechanics`, `sync-boss-mechanics` y los generadores de contexto.

Advertencia: si `20260825200000_wipe_call_boundaries_and_non_actionable_deaths.sql` ya fue marcado como aplicado en un entorno antes de estas modificaciones, Supabase no lo volverá a ejecutar. En ese caso se debe crear una migración forward adicional con el contenido correctivo pendiente; no basta con editar el archivo ya aplicado.

## 17. Impacto sobre datos anteriores

| Cambio | ¿Se actualiza sin reanalizar? | Observación |
| --- | --- | --- |
| Límite de wipe calls existentes | Parcialmente, por backfill | Necesita que ya existan muertes marcadas como cluster |
| Eventos posteriores al wipe | Sí, mediante vistas/límite | Se recalculan al leer |
| Defensivos durante el try | Sí si `defensive_casts` ya existe | La vista deriva el dato |
| Consumibles durante el try | Sí si `consumables` ya existe | Se usan todos los timestamps |
| Slots de enchants/gemas | Sí si `equipped_items` ya existe | La vista recalcula índices |
| Dificultad de mecánicas | Sí tras sincronizar evidencia | Las tablas base se conservan |
| Oneshot temporal | Sí si existe `damageWindowEvents` | Sin vida máxima histórica |
| Oneshot exacto por 80% de HP | No | Requiere reanalizar con `includeResources` |
| Melee estricto por fuente exclusiva | No | El backfill histórico es más conservador |
| Informes completos | No se reutiliza caché antigua | `schemaVersion: 11` fuerza regeneración |

## 18. Pruebas automatizadas añadidas o ampliadas

La suite cubre específicamente:

### `death-statistics.util.spec.ts`

- conserva mecánicas anteriores al wipe call;
- excluye eventos desde el límite;
- no aplica límite si el toggle está desactivado;
- excluye siempre `boss_melee_on_non_tank`.

### `damage-profile.spec.ts`

- suma varios golpes del mismo segundo hasta el 80% de vida;
- impide que daño anterior diluya un burst real;
- mantiene como sostenido el daño repartido;
- aplica fallback temporal a logs sin vida máxima.

### `reliability.service.spec.ts`

- valora defensivos usados durante el try sin muerte;
- no castiga pulls limpios sin oportunidad;
- pondera la respuesta al morir al doble;
- penaliza una oportunidad verificable sin uso;
- combina enchants y slots de gema;
- penaliza altibajos;
- exige cinco pulls para publicar consistencia.

### `gear-preparation.util.spec.ts`

- valida los siete slots encantables;
- valida cuello y anillos para gemas;
- confirma que muñecas y capa no cuentan.

### `difficulty-evidence.util.spec.ts`

- conserva evidencia en la dificultad exacta;
- excluye una candidata contrastada sólo en otra dificultad;
- no adivina exclusividad sin contraste;
- permite que una observación real contradiga una exclusión oficial.

### `error-message.util.spec.ts`

- presenta errores nativos y de Supabase;
- nunca produce `[object Object]`;
- reconoce únicamente relaciones realmente ausentes;
- no oculta errores de permisos ni relaciones distintas.

También se actualizaron los tests de Markdown del informe nocturno para la semántica de consumibles durante el try y `schemaVersion: 11`.

Resultado de la última ejecución:

```text
Test Files: 8 passed
Tests:      33 passed
Build:      correcto
```

El build mantiene avisos previos de presupuesto CSS en varios componentes; son warnings, no errores de compilación.

## 19. Verificación manual realizada

Se reprodujo el fallo real contra el Supabase configurado en el proyecto. La respuesta observada fue:

```text
PGRST205: Could not find the table
public.applicable_pull_mechanic_events in the schema cache
```

Después del fallback se verificó el recorrido `404 vista nueva → 200 tabla base` y se abrieron mediante navegador automatizado estas rutas:

- raid con report real;
- informe completo de noche;
- histórico de boss;
- dossier nocturno de Gusmï;
- perfil global de Gusmï;
- roster;
- histórico de reports.

En ninguna apareció `[object Object]`. En «A quién dirigir» se verificaron las pestañas `Mecánicas` y `Muertes`, sus contadores, el cambio de pestaña y la carga de filas reales.

## 20. Checklist de aceptación

### Wipe calls

- [ ] Una mecánica fallada antes de `wipeCallStartMs` sigue apareciendo y contando.
- [ ] Una muerte posterior al límite aparece como `WIPE CALL` y no cuenta en fiabilidad.
- [ ] Una muerte tardía posterior al cluster inicial también queda dentro del cierre del wipe.
- [ ] Una mecánica de raid que mata a todos con la misma habilidad burst no se marca como wipe call.
- [ ] Una muerte masiva de al menos el 60% en los primeros 10 s se marca como reset temprano.
- [ ] Desactivar manualmente la exclusión restaura las estadísticas del pull.

### Melee no-tank

- [ ] `Melee` exclusivo del boss sobre no-tank se muestra como no evaluable.
- [ ] No incrementa muertes reales, fallos, defensivos omitidos ni consumibles omitidos.
- [ ] Una muerte con daño adicional mezclado no se excluye automáticamente.
- [ ] Un tank muerto por `Melee` sigue siendo evaluado normalmente.

### Defensivos y consumibles

- [ ] Un defensivo usado lejos de la muerte cuenta como uso durante el try.
- [ ] Un pull limpio sin oportunidad no genera un cero defensivo.
- [ ] La respuesta en muerte pesa el doble que el uso general.
- [ ] Piedra o poción usada en cualquier instante del try aparece como usada.
- [ ] Los informes y la IA usan la misma semántica.

### Preparación y consistencia

- [ ] Pandokie u otro jugador full enchant/full gem obtiene cobertura completa si equipa los slots elegibles.
- [ ] Capa y muñecas no generan falsos enchants faltantes.
- [ ] Cuello y ambos anillos se evalúan individualmente para gemas.
- [ ] La consistencia no aparece con menos de cinco pulls.
- [ ] Dos muestras con la misma media pero diferente variabilidad obtienen distinta consistencia.

### Dificultad

- [ ] Normal no muestra mecánicas demostradas sólo en Heroic/Mythic.
- [ ] Una mecánica vista en un log real de Normal se conserva aunque DB2 sea contradictorio.
- [ ] Una dificultad sin muestreo no pierde candidatas por ausencia de datos.
- [ ] Ajustes explica la evidencia y el número de filas ocultadas.

### UI y compatibilidad

- [ ] El dossier ordena muertes por boss y pull.
- [ ] La lista de jugadores de raid muestra icono de clase.
- [ ] El análisis IA presenta Bien/Mal/Próximo en filas.
- [ ] «A quién dirigir» muestra y permite cambiar sus dos pestañas.
- [ ] Ninguna pantalla muestra `[object Object]`.
- [ ] Con migraciones aplicadas no se usa el fallback legado.

## 21. Archivos principales afectados

### Base de datos

- `supabase/migrations/20260825200000_wipe_call_boundaries_and_non_actionable_deaths.sql`
- `supabase/migrations/20260826100000_preparation_slots_and_difficulty_evidence.sql`
- `supabase/migrations/20260826110000_oneshot_burst_window.sql`
- `supabase/schema.sql`

### Ingesta y análisis

- `supabase/functions/analyze-report/index.ts`
- `supabase/functions/_shared/wcl-client.ts`
- `supabase/functions/_shared/damage-profile.ts`
- `supabase/functions/sync-boss-mechanics/index.ts`
- `supabase/functions/classify-mechanics/index.ts`

### Informes e IA

- `supabase/functions/_shared/pull-brief-context.ts`
- `supabase/functions/_shared/night-player-brief-context.ts`
- `supabase/functions/_shared/night-full-report.ts`
- `supabase/functions/_shared/llm-brief.ts`
- `supabase/functions/generate-night-full-report/index.ts`

### Agregación Angular

- `src/app/core/reliability.service.ts`
- `src/app/core/pull-analysis.service.ts`
- `src/app/core/night-player-summary.service.ts`
- `src/app/core/night-report.service.ts`
- `src/app/core/player-detail.service.ts`
- `src/app/core/boss-history.service.ts`
- `src/app/core/manifest.service.ts`
- `src/app/core/reports.service.ts`

### Helpers compartidos

- `src/app/shared/death-statistics.util.ts`
- `src/app/shared/gear-preparation.util.ts`
- `src/app/shared/difficulty-evidence.util.ts`
- `src/app/shared/error-message.util.ts`
- `src/app/shared/supabase-query.util.ts`

### Interfaz

- roster y perfil de jugador;
- raid session y lista de dossiers;
- dossier nocturno;
- pull actual y «A quién dirigir»;
- histórico de boss;
- informe nocturno;
- Ajustes/manifiesto;
- tarjeta de análisis IA.

## 22. Riesgos y seguimiento

- El fallback frontend mantiene disponibilidad, pero temporalmente usa eventos sin el nuevo filtro de dificultad. Debe considerarse una protección de despliegue, no el estado final.
- `includeResources` aumenta el payload de `DamageTaken`; conviene vigilar duración, memoria y cuotas de WCL en reports grandes.
- El backfill histórico de melee es menos preciso que el análisis nuevo. Debe validarse sobre una muestra antes de usarlo para decisiones retrospectivas sensibles.
- La calidad del filtro por dificultad depende de ejecutar `sync-boss-mechanics` y disponer de logs públicos de referencia válidos.
- Un cambio en los slots elegibles de una season futura requerirá actualizar tanto el helper TypeScript como la vista SQL y sus tests.
- Los informes IA ya guardados no cambian su texto por actualizar el contexto; deben regenerarse si se quiere que reflejen las nuevas reglas.
- Deben revisarse los avisos de presupuesto CSS de forma separada; no bloquean este cambio funcional.

---

# Anexo A. Informe colectivo, clasificación enriquecida e infografía

## A.1. Alcance de este anexo

Este anexo documenta el bloque de trabajo realizado en este chat alrededor del informe nocturno destinado a los raiders. No sustituye las secciones 1–22: las complementa con la trazabilidad técnica del informe completo, la salida para Discord, la clasificación de mecánicas, las responsabilidades por función, las líneas temporales y la exportación de la infografía.

El objetivo funcional fue separar dos productos distintos:

1. las superficies operativas que usa el RL dentro de IRIS para investigar jugadores, pulls y causas;
2. un informe colectivo, legible y compartible, que explica a la raid qué ocurrió, cuál es el boss de progreso, qué patrones están decidiendo los pulls y cómo resolverlos sin convertir asociaciones estadísticas en acusaciones individuales.

La implementación se distribuyó principalmente en los siguientes hitos de Git:

| Commit | Bloque funcional | Resultado principal |
|---|---|---|
| `321e74b` | Base Raid Ops v1.0 | Servicios, pantallas, análisis de pulls, catálogo de mecánicas y modelo sobre el que se construye el informe. |
| `58c4b7a` | Informe e infografía inicial | Informe nocturno determinista, modal, Markdown/Discord, PNG completo e infografía dinámica. |
| `c4593f9` | Patrones temporales | Ventanas de peligro alrededor de mecánicas falladas y enriquecimiento de la lectura colectiva. |
| `7f88298` | Infografía apaisada y contrato de mecánicas v4 | Mayor resolución, dos columnas, iconos de rol, `resolution`, `responsibility` y `avoidable`. |

Los cambios posteriores descritos en el cuerpo principal de este documento refinan estos mismos datos —por ejemplo, exclusión de wipe calls, evidencia por dificultad y oneshots—. Por eso, al validar el estado actual debe comprobarse el comportamiento combinado y no aislar este anexo del resto del control de cambios.

## A.2. Base técnica sobre la que se construyó el informe

El primer bloque consolidó una arquitectura de aplicación con responsabilidades separadas:

- Angular presenta y agrega datos para las vistas de sesión, historial, roster, manifiesto, dossier e informe nocturno.
- Las Edge Functions de Supabase sincronizan fuentes externas, analizan el report, clasifican mecánicas y materializan informes.
- PostgreSQL conserva tanto evidencia bruta/normalizada como snapshots derivados para que un informe histórico no dependa de volver a consultar Warcraft Logs en cada apertura.
- Las integraciones con Warcraft Logs, Blizzard, WowAudit y el proveedor LLM se encapsulan en clientes o funciones específicas; los componentes visuales no llaman directamente a esos proveedores.

Entre los elementos de base incorporados durante este trabajo están:

- rutas y vistas para raid actual, roster, historial, boss history, informe nocturno y detalle/dossier de jugador;
- servicios Angular para asistencia, progreso, fiabilidad, ofensores, notas de mecánicas, resumen nocturno y detalle de jugador;
- análisis de pulls y eventos con categorías de mecánica, muertes, defensivos, consumibles e interrupciones;
- sincronización del catálogo de bosses y mecánicas;
- generación de briefs manuales/automáticos y contextos para IA;
- componentes reutilizables para clase, rol, procedencia del dato, estados vacíos, gráficos y comparativas;
- migraciones de normalización de muertes, perfiles de daño, talentos, cooldowns, roster, preparación, progreso de temporada, categorías de mecánicas, notas de IA y exclusiones estadísticas.

La decisión arquitectónica importante es que el informe colectivo no se genera leyendo el DOM ni recomponiendo tarjetas de otras pantallas. Se construye a partir de un contrato de datos propio y determinista. Esto permite que el modal, Discord, Markdown y la infografía consuman la misma semántica.

## A.3. Persistencia y ciclo de vida del informe completo

### A.3.1. Tabla de cache

La migración `supabase/migrations/20260824140000_night_full_reports.sql` crea `night_full_reports` con:

- `report_code` como clave primaria y clave foránea a `reports(code)` con borrado en cascada;
- `report jsonb` con el documento completo ya calculado;
- `generated_at timestamptz` para distinguir la fecha de la raid de la fecha de actualización del informe;
- RLS activado y una política de lectura coherente con el acceso público ya utilizado por la aplicación.

La tabla evita recalcular todas las agregaciones cada vez que se abre el modal. El JSON persistido incluye `schemaVersion`; si la versión guardada ya no coincide con la que espera la función, se considera obsoleto y se regenera.

### A.3.2. Generación en backend

`supabase/functions/generate-night-full-report/index.ts` actúa como endpoint y delega el cálculo en `supabase/functions/_shared/night-full-report.ts`.

Flujo:

1. recibe `reportCode` y opcionalmente `force`;
2. valida el report solicitado;
3. consulta `night_full_reports`;
4. si existe un documento compatible y `force !== true`, devuelve el cache;
5. si no existe, está obsoleto o se solicita actualización, ejecuta `buildNightFullReport`;
6. guarda el resultado con `upsert` y devuelve el nuevo documento.

El despliegue conserva la validación JWT de la Edge Function. No se dejó una variante pública con `--no-verify-jwt`.

### A.3.3. Integración Angular

La cadena frontend queda separada así:

- `EdgeFunctionsService.generateNightFullReport(...)` invoca la función remota.
- `NightReportService.loadFullReport(...)` centraliza carga, cache y tipado.
- `NightReportComponent` mantiene `fullReport`, `fullReportOpen`, `generatingFullReport` y `fullReportError`.
- `NightFullReportModalComponent` representa, copia y exporta el documento ya generado.
- `NightReportInfographicComponent` transforma el mismo contrato en una composición visual, sin recalcular métricas de negocio desde texto Markdown.

La acción principal se adapta al estado:

- sin informe: «Generar informe»;
- con informe almacenado: «Ver informe»;
- desde el modal: «Actualizar» fuerza la regeneración.

Esto evita que abrir un informe antiguo provoque por sorpresa llamadas externas o cambie cifras mientras se está revisando.

## A.4. Contrato de datos del informe

El modelo compartido `NightFullReport` se amplió por versiones. Durante este bloque evolucionó desde los primeros esquemas del informe hasta las versiones 6, 7 y 9; el estado actual del repositorio usa una versión posterior por los refinamientos documentados en las secciones principales. La versión es parte del control de compatibilidad, no un número decorativo.

El contrato contiene, como mínimo, los siguientes grupos:

| Grupo | Contenido técnico | Uso principal |
|---|---|---|
| `summary` | pulls, bosses, kills, wipes, tiempo total/medio, wipes tempranos, mejor pull y evolución del boss actual | cabecera, tabla de recorrido y hero de la infografía |
| `mechanics` | nombre bilingüe, spell ID, Wowhead, categoría, responsabilidad, nota, fallos, tendencia, letalidad y daño evitable | prioridades, ejecución y cards explicativas |
| `timelinePatterns` | ancla, ventana temporal, marcadores, pulls afectados, muertes y `resolution` | «Ventanas de peligro» |
| `deaths` | muertes reales, exclusiones de wipe call, cobertura de causa raíz, golpes finales y contexto desconocido | diagnóstico colectivo y golpe final más repetido |
| `responsibilities` | agregados `tank`, `healer`, `dps`, `raid` y `personal` | atribución por responsabilidad sin señalar individuos |
| `roleInsights` | jugadores, muertes/pull, señales específicas y defensivos por tank/healer/DPS | «Claves por función» |
| `defensives`, `interrupts`, `survival` | cobertura de herramientas, casts verificados, cadena de muertes y supervivencia | señales y puntos positivos |
| `wipePatterns`, `recovery` | patrones recurrentes y evolución tras fallos | lectura de aprendizaje de la noche |
| `priorities`, `goodPoints` | reglas deterministas de foco y elementos que funcionaron | comunicación accionable para la próxima raid |
| `notAvailable` | limitaciones explícitas del dataset | transparencia dentro de la app; se excluye de la imagen compartible |

Los modelos se encuentran en `src/app/shared/models/domain.ts` y sus equivalentes de backend. Los consumidores deben respetar `null`/ausencia como «dato no disponible»; no deben convertirlo automáticamente en cero porque cero significa que la medición existe y no ocurrió ningún caso.

## A.5. Fuentes y agregación determinista

`buildNightFullReport` compone el informe principalmente desde:

- `reports` y `report_encounters` para metadatos y bosses;
- `pulls` para duración, orden, kill/wipe y porcentaje final;
- `player_pull_records` para participación, muertes, roles y recursos;
- las vistas aplicables de eventos y manifiesto de mecánicas para respetar boss, dificultad y evidencia;
- `known_raid_bosses` y la API de Blizzard `es_ES` para nombres localizados cuando están disponibles.

Las mecánicas se normalizan por boss, dificultad y nombre normalizado. No se usa solamente `abilityId`, porque el identificador observado por WCL y el candidato sincronizado no siempre coinciden, y algunos nombres/IDs se reutilizan en contextos diferentes.

Reglas de consistencia relevantes:

- un evento sólo contribuye al boss y dificultad a los que pertenece;
- el snapshot guardado en el evento tiene prioridad histórica cuando existe;
- el manifiesto actual completa registros antiguos que todavía no contienen el nuevo campo;
- las exclusiones de wipe call se aplican antes de sumar causas, roles o señales;
- las cifras mostradas en distintas superficies proceden del mismo agregado, no de fórmulas visuales distintas.

## A.6. Selección correcta del boss de progreso

Se corrigió la lógica para que «Foco para la próxima raid» no seleccione habilidades de un boss ya derrotado.

El boss de progreso se determina sobre los grupos de encuentros de la noche y se elige el último grupo no resuelto. A partir de ese punto:

- las prioridades se filtran al boss de progreso;
- las líneas temporales se construyen únicamente con sus pulls;
- las claves por función usan sus muertes y eventos;
- la evolución muestra primer/mejor/último porcentaje de ese boss;
- los kills anteriores permanecen en el recorrido y en «Lo que funcionó», pero no dominan la preparación de la próxima raid.

Para no perder una causa realmente letal, el generador también admite como candidato prioritario un golpe final del boss de progreso aunque no tenga un `pull_mechanic_event` perfectamente enlazado. Esta ruta de respaldo fue necesaria para que `Elemental Explosion` apareciera como principal causa observada cuando concentraba el mayor número de muertes.

## A.7. Correcciones de clasificación y lectura de las muertes

### A.7.1. Interrupciones verificadas

Una mecánica clasificada textualmente como `interrupt` no se contabiliza automáticamente como una interrupción estándar. Se considera cast interrumpible fiable cuando:

- la categoría está confirmada o inferida con evidencia suficiente; y
- existe `observed_as_interrupt` o un evento real de interrupción en el report.

Con ello, habilidades como `Final Ascension`, que se resuelven mediante la mecánica especial del encuentro, no contaminan el porcentaje de kicks ni aparecen como «interrupt fallado» sólo por contener lenguaje parecido en una guía.

El informe conserva el número de casts excluidos/no verificados para que el porcentaje de éxito no parezca más exhaustivo de lo que es.

### A.7.2. Golpe final, causa raíz y asociación temporal

Se separan tres conceptos:

- `finalBlow`: último impacto registrado antes de morir;
- `rootCause`: mecánica o decisión que explica con evidencia suficiente el origen de la muerte;
- asociación temporal: evento cercano a la muerte que ayuda a buscar un patrón, pero no demuestra causalidad.

El informe muestra cobertura de causa raíz como fracción y porcentaje. Las muertes sin clasificación permanecen visibles como desconocidas; no se fuerzan a una categoría para completar el gráfico.

También se evitó generar la señal «daño sostenido sin sanación» cuando la ventana de daño no contiene daño positivo medible. De ese modo, ausencia de datos no se interpreta como fallo de healers.

### A.7.3. Notas informativas de habilidad

Cada prioridad puede incluir:

- nombre inglés y traducción `es_ES`;
- enlace directo a Wowhead usando el spell ID;
- `notes` como explicación de qué hace la habilidad;
- categoría, responsabilidad y evitabilidad cuando están confirmadas.

`resolution` se consume específicamente en las ventanas de peligro como «Cómo resolverlo». Se mantiene separado de `notes`: la nota explica qué hace la habilidad y la resolución indica la ejecución esperada.

Las notas dejaron de truncarse con elipsis en el informe para Discord y en los bloques donde la explicación completa es necesaria. El límite de 2.000 caracteres de Discord no se aplica dentro del generador: el usuario puede dividir el informe en varios mensajes sin perder el final de una instrucción.

## A.8. Informe de Discord y Markdown

`src/app/features/night-report/night-full-report-markdown.ts` genera dos salidas distintas:

- `buildNightDiscordSummary(...)`: resumen colectivo pensado para publicar en el canal de raid;
- `buildNightFullReportMarkdown(...)`: versión extensa y auditable.

El resumen de Discord comienza con `Informe de combate de IRIS` y la fecha. Incluye:

1. resumen de pulls/kills/wipes/tiempo;
2. tabla boss a boss dentro de un bloque cercado `text`;
3. progreso actual;
4. golpe final más repetido;
5. prioridades para la siguiente raid;
6. información por función y responsabilidad;
7. señales y elementos que funcionaron;
8. aviso de que el resultado describe patrones y no asigna culpables.

Discord no interpreta tablas Markdown de forma consistente, pero sí conserva una fuente monoespaciada dentro de bloques de código. Por eso la tabla pequeña se construye como ASCII con columnas alineadas y no como una tabla Markdown convencional.

El generador escapa caracteres Markdown de contenido externo y compone enlaces de Wowhead sin aceptar HTML del proveedor. Los nombres bilingües y las descripciones completas se conservan en texto.

### A.8.1. Corrección de `TS2339: copyReport`

El error se debía a un contrato desalineado entre plantilla y componente: la plantilla de `NightReportComponent` conservaba una llamada `(click)="copyReport()"`, pero el método ya no formaba parte de esa clase tras mover las acciones de copia al modal.

La corrección consistió en:

- retirar/reemplazar la llamada obsoleta por `onFullReportPrimaryAction()` en la vista principal;
- mantener `copyDiscordSummary()` y `copyFullMarkdown()` en `NightFullReportModalComponent`, que es quien dispone del informe completo;
- hacer que cada botón ejecute una función existente y tipada, evitando métodos fantasma en el template Angular.

No se añadió un método vacío sólo para silenciar TypeScript: se corrigió la propiedad responsable y se dejó una única ruta de copia por formato.

## A.9. Modal de informe y exportación del informe completo a PNG

`NightFullReportModalComponent` se implementó como diálogo accesible y como superficie de exportación. Gestiona:

- apertura/cierre y restauración del foco previo;
- cierre con `Escape`;
- focus trap para que el teclado no salga del modal;
- bloqueo temporal del scroll del `body`;
- estados de copia, descarga, actualización y error;
- acceso a la infografía desde el mismo informe.

La exportación del informe largo se realiza en `downloadFullReportPng()` mediante `html-to-image`:

1. se clona el nodo del diálogo fuera del viewport;
2. se eliminan del clon los controles interactivos (`.dialog-footer`, botones de cierre y elementos equivalentes);
3. se elimina `.limitations`, que corresponde a «TRANSPARENCIA / Datos que este informe no tiene» y no debe formar parte de la pieza compartible;
4. se anulan `max-height`, scroll interno y recortes del modal;
5. se espera a `document.fonts.ready` y a la carga de todas las imágenes;
6. se mide `scrollHeight` real del clon;
7. se rasteriza con fondo explícito y una relación de píxel limitada para evitar exceder memoria/canvas;
8. se descarga `iris-informe-completo-<reportCode>.png`.

El alto no se fija al viewport. Es dinámico y puede producir una imagen vertical larga, que era el comportamiento solicitado para conservar todo el contenido. Se limita a 14.000 píxeles de alto de salida como protección frente a navegadores que no pueden rasterizar canvases arbitrariamente grandes.

La dependencia `html-to-image` quedó registrada en `package.json` y `package-lock.json`; no se utiliza una captura de pantalla del navegador ni una conversión de Markdown externa.

## A.10. Ventanas de peligro y líneas temporales

### A.10.1. Objetivo

Las líneas temporales no intentan reproducir todo el pull. Su finalidad es situar la mecánica problemática dentro de una ventana pequeña: qué ocurre inmediatamente antes, cuál es el evento central y qué daños, fallos o muertes se concentran después.

El bloque se titula «Ventanas de peligro» en una sola línea en la composición apaisada. El diseño se redujo para que sea reconocible y útil sin convertirse en el elemento visual dominante.

### A.10.2. Algoritmo

El cálculo de `timelinePatterns` se realiza en backend y sólo usa pulls del boss de progreso.

Parámetros relevantes:

- ventana alrededor del ancla: `-12 s` a `+12 s`;
- agrupación de instancias del mismo patrón: diferencia máxima aproximada de `18 s` respecto a la mediana;
- deduplicación de ticks repetidos de una misma habilidad dentro del pull: ventana de `15 s`;
- agrupación de muertes simultáneas: aproximadamente `2 s`;
- buckets de eventos representativos: aproximadamente `1,5 s`;
- bucket de marcadores contextuales en la visualización: `3 s`.

Proceso:

1. se agrupan eventos por habilidad normalizada y bucket temporal;
2. se elige un representante con tiempo mediano, peor resultado y máximo de jugadores afectados;
3. las muertes cercanas se agrupan como oleadas para evitar veinte iconos superpuestos;
4. se generan candidatos de ancla a partir de golpes letales y mecánicas falladas;
5. los interrupt casts quedan excluidos como ancla si no representan una ventana de peligro real;
6. se puntúa cada candidato dando más peso a letalidad, fallos y pulls afectados;
7. se exige evidencia repetida: al menos dos pulls, dos fallos o dos golpes letales;
8. se seleccionan como máximo tres timelines y como máximo dos ventanas de una misma habilidad;
9. por ventana se muestran hasta tres marcadores contextuales además del ancla, priorizando fallos y oleadas de muerte;
10. el resultado final se ordena cronológicamente.

El texto «Cómo resolverlo» procede de `resolution` en el manifiesto. Se eliminó el consejo genérico «Cómo prepararlo» porque producía recomendaciones vagas que no estaban verificadas contra la mecánica concreta.

La interfaz mantiene un aviso metodológico: proximidad temporal describe un patrón observado, pero no prueba por sí sola una relación causal.

## A.11. Ampliación del contrato de clasificación de mecánicas

### A.11.1. Preservación del prompt anterior

La clasificación existente de categorías funcionaba correctamente y no se reescribió. En `supabase/functions/classify-mechanics/index.ts` el cuerpo anterior se conserva en `buildSystemPrompt(...)`; las nuevas instrucciones se añaden mediante un bloque independiente, `buildResolutionPromptAddendum(...)`, y un recordatorio final del contrato JSON.

Esto reduce el riesgo de regresión en las reglas de categoría, confianza, notas y fuentes. La versión del contrato se elevó a `promptVersion: 4` para poder auditar qué estructura produjo cada respuesta.

### A.11.2. Salida JSON exacta

Cada elemento devuelto por la IA debe contener exactamente:

```json
{
  "abilityId": 0,
  "category": "...",
  "confidence": "high|medium|low",
  "sources": ["https://..."],
  "notes": "...",
  "resolution": "... o null",
  "responsibility": "tank|dps|healer|raid|personal",
  "avoidable": true
}
```

`avoidable` también admite `false` o `null` cuando el caso es mixto/no demostrable.

`resolutionSources` se retiró del contrato porque duplicaba información y no aportaba una ruta de validación distinta. Las fuentes que justifican la categoría y la resolución permanecen en el array general `sources`. La columna histórica `resolution_sources` puede seguir existiendo en la base de datos por compatibilidad, pero está obsoleta y no se debe volver a poblar desde el prompt.

### A.11.3. `resolution`: cómo resolver la mecánica

La resolución debe:

- ocupar entre una y cuatro frases accionables;
- describir la dificultad actual del encuentro;
- explicar qué debe hacer la raid o el rol, no repetir únicamente qué daño causa la spell;
- separar un hecho del encuentro de una estrategia recomendada por una guía;
- quedar en `null` si no puede confirmarse de forma fiable;
- estar respaldada por al menos dos URLs públicas directas de dos dominios independientes.

El backend normaliza URLs, extrae la URL cuando el modelo la envuelve accidentalmente en sintaxis Markdown, rechaza hosts locales, páginas de resultados de búsqueda y duplicados de un mismo dominio efectivo. También valida una longitud razonable de texto antes de aceptar la resolución.

La exigencia de dos fuentes se aplica a la investigación de la resolución, pero no se creó un segundo array que pudiera divergir de `sources`.

### A.11.4. `responsibility`: responsable operativo

Se definió un único responsable principal por mecánica:

| Valor | Criterio técnico |
|---|---|
| `tank` | swap, aggro, orientación, posicionamiento del boss o mitigación específica del tank |
| `healer` | dispel, absorb, cooldown o throughput que corresponde realmente a healers ante daño inevitable |
| `dps` | prioridad de objetivo, check de daño o acción exclusiva del rol DPS |
| `raid` | asignación compartida, soak de grupo, mecánica que puede tocar a cualquiera o coordinación colectiva |
| `personal` | cada jugador afectado puede resolver por sí solo su movimiento, defensivo o reacción individual |

Reglas de desambiguación incorporadas al prompt:

- un target aleatorio se clasifica como `raid`, no como `personal`, cuando requiere respuesta del grupo o puede asignarse a cualquier rol;
- un kick genérico no convierte la mecánica en responsabilidad DPS, porque tanks y healers también pueden interrumpir;
- curar las consecuencias de daño evitable no convierte el error original en responsabilidad healer;
- siempre debe elegirse un responsable principal cuando la confianza de la clasificación lo permita.

### A.11.5. `avoidable`: daño completamente evitable

`avoidable = true` significa que ejecutar correctamente la mecánica puede reducir a cero ese daño concreto. No significa simplemente que el daño pueda mitigarse.

Por tanto:

- daño de raid inevitable: `false`;
- tankbuster correctamente recibido: `false`;
- impacto inicial inevitable sobre un target válido: `false`;
- daño correcto de un soak: `false`;
- suelo, frontal o cast que puede impedirse por completo: normalmente `true`;
- mecánicas con componentes inevitables y evitables mezclados: `null` si no puede representarse honestamente con un booleano.

Categoría, resolución, responsabilidad y evitabilidad se validan de forma independiente. Un campo inválido no debe descartar automáticamente una categoría válida del mismo resultado.

## A.12. Persistencia y propagación de resolución, responsabilidad y evitabilidad

### A.12.1. Migraciones

`supabase/migrations/20260825160000_mechanic_resolution.sql` añade a `boss_mechanics_candidates`:

- `resolution text`;
- `resolution_sources jsonb` con valor inicial `[]`;
- `resolution_verified_at timestamptz`.

Como se explicó antes, `resolution_sources` quedó obsoleta después de simplificar el contrato; se conserva para no hacer una migración destructiva innecesaria.

`supabase/migrations/20260825180000_mechanic_responsibility.sql` añade `responsibility` tanto a:

- `boss_mechanics_candidates`;
- `pull_mechanic_events`.

Ambas columnas se protegen con un `CHECK` que sólo admite `tank`, `dps`, `healer`, `raid` o `personal`. La migración y `supabase/schema.sql` documentan que `sources` es el respaldo de la resolución.

La propiedad `avoidable`, ya presente en el flujo de candidatos/eventos, se incorporó explícitamente al contrato de IA y a la aplicación masiva de resultados para que la columna «Evitable» deje de permanecer en «Sin decidir» cuando la evidencia permite resolverla.

### A.12.2. Aplicación desde Ajustes

La tabla de mecánicas del manifiesto se amplió con:

- «Cómo resolverlo», representado por `MechanicResolutionIconComponent` y su detalle;
- selector «Responsable»;
- selector «Evitable» con `true`, `false` y estado no decidido;
- resumen de campos aplicados, omitidos y ausentes del contrato al procesar una clasificación IA.

La Edge Function de clasificación devuelve el resultado, pero no lo escribe silenciosamente. El usuario puede revisar y ejecutar «Aplicar clasificación». El guardado pasa por `save-mechanic-edit`, que vuelve a validar los enums/booleanos antes de persistir.

### A.12.3. Resincronización de históricos

Al cambiar responsabilidad o evitabilidad no basta con actualizar el candidato actual: los informes leen eventos históricos ya materializados. Por eso se implementaron:

- `resyncMechanicResponsibility(...)`;
- `resyncMechanicAvoidable(...)`.

Ambos recorren eventos que coinciden por boss, dificultad y nombre normalizado y actualizan:

- la columna directa del evento;
- el snapshot anidado en `death_cause` cuando existe.

La coincidencia por nombre es deliberada. Los IDs del catálogo, de DB2 y de WCL pueden no ser idénticos para una misma mecánica observada. Boss y dificultad evitan que una coincidencia nominal contamine otro encuentro.

En nuevos análisis, `analyze-report` carga el manifiesto vigente y deja `responsibility`/`avoidable` en el snapshot de cada evento y causa de muerte. Así se obtiene:

- estabilidad histórica cuando el manifiesto cambia;
- capacidad de completar eventos antiguos mediante resincronización;
- agregados nocturnos sin una llamada adicional al LLM.

## A.13. Métricas por responsabilidad y claves por función

### A.13.1. Agregado de responsabilidad

El informe agrega por `tank`, `healer`, `dps`, `raid` y `personal`:

- número de mecánicas clasificadas;
- eventos fallados;
- pulls afectados;
- muertes asociadas;
- jugadores alcanzados;
- daño recibido cuando la fuente lo permite.

Esto permite frases como «Raid: 51 fallos / 87 muertes» sin inferir que cada muerte fue culpa individual de quien murió.

### A.13.2. Tarjetas por función

Las métricas base de las cards de tanks, healers y DPS se calculan sobre el boss de progreso e incluyen:

- jugadores detectados en esa función;
- muertes por pull;
- cobertura de defensivos;
- señales específicas, como tankbusters, daño sostenido o posicionamiento/soaks;
- hasta dos mecánicas concretas cuya `responsibility` corresponde al rol, priorizando las del boss de progreso antes de usar cualquier fallback de la noche.

Se corrigió la redacción genérica «Su responsabilidad: N fallos» porque no ayudaba a actuar. Ahora la card puede nombrar las mecánicas responsables y sus fallos/pulls o muertes. Las responsabilidades `raid` y `personal`, que afectan transversalmente a las tres funciones, se muestran en un bloque compartido y no se duplican artificialmente en cada rol.

La categoría DPS se representa visualmente con iconos melee y ranged, pero sigue siendo un agregado único en el contrato porque `responsibility` no distingue todavía esos dos subroles.

Estas métricas son descriptivas. Por ejemplo, una mecánica `healer` con daño sostenido y muertes asociadas indica una ventana que debe revisar el equipo de sanación; no demuestra por sí sola qué healer cometió un error ni descarta una ejecución previa incorrecta de la raid.

## A.14. Infografía dinámica

### A.14.1. Arquitectura

La infografía se implementó como componente Angular nativo:

- `night-report-infographic.component.ts` prepara datos y exportación;
- `night-report-infographic.component.html` define la estructura semántica;
- `night-report-infographic.component.scss` compone la pieza apaisada;
- no depende de una imagen pre-generada ni de IA generativa para cada report.

Esto permite que nombres, números, iconos, boss, mecánicas, timelines y bloques se adapten a cada raid manteniendo un diseño reproducible.

### A.14.2. Formato apaisado y dos columnas

La hoja base se amplió a `2560 px` de ancho con altura mínima de `1500 px`. El cuerpo principal usa dos columnas grandes e independientes:

- izquierda: foco, mecánicas determinantes y responsabilidades compartidas;
- derecha: ventanas de peligro, claves por función, impulso y señales.

No se utiliza una cuadrícula en la que cada fila tenga la altura del bloque más alto de la columna contraria. Las columnas fluyen de forma independiente mediante `.iris-report-columns`, evitando los huecos verticales que aparecían cuando «Ventanas de peligro» era mucho más alta que «Foco».

El título de «Ventanas de peligro» se mantiene en una sola línea y los elementos se ordenan por prioridad semántica, no únicamente para rellenar espacio.

### A.14.3. Legibilidad

Se aumentaron:

- tamaño base y tamaños mínimos de descripciones;
- interlineado;
- contraste de texto secundario;
- contraste de bordes y fondos de cards;
- separación entre etiqueta, dato y explicación.

El texto gris de baja opacidad se sustituyó por tonos más claros. La exportación no escala hacia abajo una hoja vertical estrecha, que era la principal causa de que Discord mostrara tipografía borrosa.

### A.14.4. Recursos visuales

La cabecera incorpora el logo de la guild Avoid y el lema correcto de IRIS:

> MAKE EVERY PULL COUNT

El arte del boss se selecciona desde una allowlist estática por nombre normalizado y utiliza recursos de Wowhead/CDN cuando existe una correspondencia conocida. Si la carga falla, se muestra un fallback local; el report nunca queda bloqueado por una imagen externa.

Los iconos de spells se resuelven desde la información de tooltip de Wowhead y su CDN de iconos, también con fallback local.

Los cuatro assets entregados para roles —tank, heal, melee y ranged— sustituyen los iconos provisionales. La sustitución se llevó al `RoleIconComponent` compartido, por lo que mejora no sólo la infografía, sino también roster, historial y demás tablas que consumen el componente. DPS utiliza la pareja melee/ranged cuando el contexto representa el rol agregado.

### A.14.5. Exportación de alta resolución

La hoja usa:

- `SHEET_WIDTH = 2560`;
- `EXPORT_PIXEL_RATIO = 1.8`;
- altura dinámica medida con `ResizeObserver`;
- límite de seguridad de 14.000 píxeles de salida.

Una exportación típica resulta en `4608 px` de ancho (`2560 × 1,8`). En la muestra de validación del report `W9AfGbRhmPkXMapx`, el PNG generado fue aproximadamente `4608 × 5940`, unos `27,4 MP` y `18,9 MB`. Es un ejemplo medido, no una dimensión contractual: la altura depende de los datos del informe.

Antes de rasterizar se espera a:

- `document.fonts.ready`;
- resolución o error de todas las imágenes;
- actualización de la altura observada.

El componente ofrece:

- vista ajustada a pantalla;
- alternancia de zoom para revisar el tamaño real;
- descarga PNG;
- copia al portapapeles mediante `ClipboardItem` cuando el navegador lo admite;
- descarga como fallback cuando la API de clipboard no está disponible.

## A.15. Contenido de la infografía

La composición final incluye:

1. cabecera Avoid/IRIS, fecha y report code;
2. boss de progreso con arte, dificultad, porcentaje y evolución;
3. pulls, kills, wipes, tiempo y media por pull;
4. recorrido boss a boss;
5. foco priorizado para la siguiente raid;
6. ventanas temporales con «Cómo resolverlo»;
7. mecánicas que están decidiendo los pulls;
8. claves concretas para tanks, healers y DPS;
9. responsabilidades compartidas `raid`/`personal`;
10. señales de mejora y elementos que funcionaron;
11. golpe final más repetido;
12. pie con marca IRIS y el lema.

La sección de transparencia permanece disponible en el modal interno, pero se excluye de la infografía y del PNG largo destinado a compartir, tal como se solicitó.

## A.16. Despliegue realizado

Durante este bloque se aplicaron/desplegaron:

- migración `20260825160000_mechanic_resolution.sql`;
- migración `20260825180000_mechanic_responsibility.sql`;
- Edge Function `classify-mechanics`;
- Edge Function `save-mechanic-edit`;
- Edge Function `analyze-report`;
- Edge Function `generate-night-full-report`.

La función de informe se volvió a desplegar después de retirar un recorte prematuro de mecánicas que impedía calcular correctamente todas las responsabilidades. Los límites se aplican al presentar cards, no antes de construir el agregado.

Orden recomendado para reproducir el despliegue:

1. aplicar migraciones;
2. desplegar `classify-mechanics` y `save-mechanic-edit`;
3. desplegar `analyze-report` para que los nuevos reports creen snapshots enriquecidos;
4. desplegar `generate-night-full-report`;
5. publicar el frontend;
6. reclasificar/aplicar mecánicas existentes;
7. regenerar informes cacheados con `force`.

Publicar frontend antes de migraciones puede dejar selectores visibles que el backend todavía no puede persistir. Desplegar el generador antes de enriquecer datos no rompe el informe, pero produce más campos desconocidos.

## A.17. Validaciones realizadas

### A.17.1. Contrato remoto de clasificación

La auditoría del prompt sobre The Lost Explorers Heroic confirmó:

- `promptVersion: 4`;
- 33 mecánicas incluidas en la solicitud de prueba;
- claves de salida exactas;
- ausencia de `resolutionSources`;
- reutilización del array general `sources`;
- presencia de instrucciones explícitas para `resolution`, `responsibility` y `avoidable`.

### A.17.2. Informe regenerado

Se regeneró el report `W9AfGbRhmPkXMapx` para validar el contrato desplegado. En ese momento se materializó con `schemaVersion: 9`; el código actual puede generar una versión posterior debido a los cambios de wipe calls, dificultad y oneshot descritos en el cuerpo principal.

Se verificó que:

- el boss de foco era The Lost Explorers;
- `Elemental Explosion` aparecía como golpe final más repetido;
- `Final Ascension` no se presentaba como kick estándar;
- las notas y resoluciones no terminaban en elipsis;
- los roles mostraban mecánicas concretas;
- el bloque compartido separaba `raid` y `personal`;
- el PNG alcanzaba la resolución esperada.

### A.17.3. Build, tests y navegador

En el cierre de este bloque:

- el build de Angular finalizó correctamente;
- la suite específica del informe/Markdown finalizó con 7 pruebas superadas;
- la aplicación se abrió en navegador sin errores de consola en el flujo revisado;
- se comprobaron carga de logo, arte, iconos de spells e iconos de rol;
- se verificó visualmente la separación en dos columnas, la ausencia de huecos de grid y el título del timeline en una línea.

Los avisos existentes de presupuesto CSS no impidieron la compilación y se mantienen como deuda separada.

## A.18. Pruebas automatizadas relevantes

`night-full-report-markdown.spec.ts` cubre, entre otros casos:

- título de IRIS y fecha;
- tabla ASCII dentro de bloque `text`;
- selección del boss de progreso;
- inclusión de notas completas;
- ausencia de truncado por el límite de Discord;
- semántica de campos opcionales y compatibilidad de schema;
- construcción de enlaces y secciones por función.

Las pruebas de utilidades y agregados indicadas en la sección 18 de este documento complementan estos casos para wipe calls, perfiles de daño, fiabilidad, dificultad, preparación y errores de Supabase.

## A.19. Checklist de aceptación específico

### Informe y Discord

- [ ] El título contiene «Informe de combate de IRIS» y la fecha correcta.
- [ ] La tabla ASCII queda alineada dentro de un bloque `text` en Discord.
- [ ] El informe no corta notas ni resoluciones con `…`.
- [ ] Dividir manualmente el contenido en varios mensajes no modifica sus cifras.
- [ ] El foco sólo utiliza el boss de progreso, aunque haya kills anteriores.
- [ ] El golpe final más repetido aparece aunque su enlace con eventos sea incompleto.
- [ ] Una habilidad especial no cuenta como interrupt salvo evidencia real de interrupción.

### Clasificación de mecánicas

- [ ] La respuesta de IA usa las ocho claves exactas del contrato v4.
- [ ] No aparece `resolutionSources` en prompt, respuesta ni UI.
- [ ] Una resolución sin dos dominios independientes queda sin aplicar.
- [ ] `responsibility` sólo acepta `tank|dps|healer|raid|personal`.
- [ ] `avoidable` distingue daño eliminable de daño únicamente mitigable.
- [ ] Aplicar una clasificación actualiza la tabla sin recargar manualmente.
- [ ] La resincronización actualiza evento y `death_cause` del mismo boss/dificultad.

### Responsabilidades y roles

- [ ] Cada card de rol nombra mecánicas concretas y no sólo un contador genérico.
- [ ] Tanks, healers y DPS se calculan sobre el boss de progreso.
- [ ] Raid/personal aparecen como responsabilidades compartidas.
- [ ] No se atribuye a healers una ventana sin daño medible.
- [ ] Los iconos tank, heal, melee y ranged cargan desde assets locales.

### Timeline

- [ ] Cada ventana abarca aproximadamente ±12 segundos.
- [ ] No se muestran ticks repetidos como eventos independientes sin valor.
- [ ] Una ventana requiere evidencia repetida o letal suficiente.
- [ ] «Cómo resolverlo» procede del manifiesto y no de un consejo genérico inventado.
- [ ] La nota metodológica no presenta proximidad como causalidad.

### Infografía y PNG

- [ ] La hoja se compone en 2560 px lógicos y dos columnas independientes.
- [ ] «Ventanas de peligro» permanece en una línea.
- [ ] No quedan huecos verticales provocados por igualación de filas entre columnas.
- [ ] El texto secundario mantiene contraste y tamaño legibles tras subirlo a Discord.
- [ ] La exportación normal tiene 4608 px de ancho con ratio 1,8.
- [ ] Ninguna sección queda cortada por el viewport del modal.
- [ ] «Transparencia / Datos que este informe no tiene» no aparece en el PNG compartible.
- [ ] El logo de Avoid y «MAKE EVERY PULL COUNT» aparecen en la composición.
- [ ] Si falla Wowhead, el fallback evita una imagen rota.

## A.20. Inventario principal de archivos del bloque

### Base de datos

- `supabase/migrations/20260824140000_night_full_reports.sql`
- `supabase/migrations/20260825160000_mechanic_resolution.sql`
- `supabase/migrations/20260825180000_mechanic_responsibility.sql`
- `supabase/schema.sql`

### Backend

- `supabase/functions/_shared/night-full-report.ts`
- `supabase/functions/generate-night-full-report/index.ts`
- `supabase/functions/classify-mechanics/index.ts`
- `supabase/functions/save-mechanic-edit/index.ts`
- `supabase/functions/analyze-report/index.ts`
- `supabase/functions/_shared/wcl-client.ts`
- `supabase/functions/_shared/llm-brief.ts`

### Angular y modelos

- `src/app/shared/models/domain.ts`
- `src/app/shared/models/night-full-report.ts`
- `src/app/core/night-report.service.ts`
- `src/app/core/edge-functions.service.ts`
- `src/app/features/night-report/night-report.component.ts`
- `src/app/features/night-report/night-report.component.html`
- `src/app/features/night-report/night-full-report-modal.component.ts`
- `src/app/features/night-report/night-full-report-modal.component.html`
- `src/app/features/night-report/night-full-report-modal.component.scss`
- `src/app/features/night-report/night-full-report-markdown.ts`
- `src/app/features/night-report/night-full-report-markdown.spec.ts`
- `src/app/features/night-report/night-report-infographic.component.ts`
- `src/app/features/night-report/night-report-infographic.component.html`
- `src/app/features/night-report/night-report-infographic.component.scss`
- `src/app/features/manifest/manifest.component.ts`
- `src/app/features/manifest/manifest.component.html`
- `src/app/features/manifest/manifest.component.scss`
- `src/app/shared/role-icon.component.ts`
- `src/app/shared/mechanic-resolution-icon.component.ts`

### Assets y dependencias

- `public/assets/avoid-guild-logo.svg`;
- `public/assets/tank.png`;
- `public/assets/heal.png`;
- `public/assets/melee.png`;
- `public/assets/ranged.png`;
- `package.json` y `package-lock.json` por `html-to-image`.

## A.21. Riesgos y límites conocidos

- Las imágenes remotas de Wowhead pueden cambiar políticas CORS o disponibilidad. Los fallbacks evitan roturas visuales, pero no garantizan conservar el arte concreto del boss.
- Un PNG de alta resolución puede superar los límites de tamaño de Discord aunque mejore la lectura. La app conserva descarga/copia; la compresión final depende de Discord.
- El límite de 14.000 píxeles protege al navegador, pero un informe excepcionalmente largo puede requerir paginación futura.
- `resolution` depende de la calidad y actualidad de fuentes externas. Dos dominios reducen el riesgo, pero no sustituyen la revisión del RL.
- `responsibility` representa al responsable principal, no todas las contribuciones posibles a una mecánica.
- Las asociaciones entre evento, daño y muerte no son automáticamente causalidad; el informe mantiene esta advertencia de forma deliberada.
- Los informes cacheados anteriores a una subida de `schemaVersion` deben regenerarse para mostrar campos nuevos.
- La columna obsoleta `resolution_sources` puede retirarse en una migración futura, pero no es necesario hacerlo para el funcionamiento actual.
