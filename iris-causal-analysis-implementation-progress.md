# IRIS · Causal Analysis & Player Responsibility — Implementation Progress

> Documento vivo y único de seguimiento para la implementación de causalidad, responsabilidad mecánica, validez de pulls y dossier verificable.
>
> **Regla de trabajo:** código y este documento forman una sola entrega. Ningún bloque se considera cerrado si este archivo no refleja exactamente qué se cambió, por qué, cómo se valida, qué queda pendiente y qué inconsistencias se encontraron.

## 0. Baseline y control de cambios

- **Rama de trabajo:** `fix/causal-analysis-v1`
- **Rama base:** `fix/defensive-catalog-discovery-v5`
- **Commit base exacto:** `4aad209930a72c5150e57e2b10456a51999e2cbd` (`new defensives`)
- **Inicio:** 2026-09-01
- **Modelo de entrega:** aditivo, reversible y compatible con el comportamiento existente hasta que cada consumidor sea migrado de forma explícita.
- **Principio de seguridad:** una señal incierta puede mostrarse como evidencia, pero no debe convertirse silenciosamente en una penalización individual.
- **Principio histórico:** una mejora de detector no debe reinterpretar silenciosamente una decisión humana previa; los overrides autoritativos deben sobrevivir a reanálisis.
- **Principio de fuente única:** una pantalla no vuelve a decidir qué significa un wipe/ninja/fallo; consume una decisión ya resuelta por la capa autoritativa correspondiente.

### Estados de bloque

`PENDING → AUDITING → DESIGNED → IMPLEMENTING → TESTING → REVIEWING → ACCEPTED`

Estado alternativo: `BLOCKED`.

`ACCEPTED` exige, como mínimo: persistencia, contrato, propagación, invalidación, compatibilidad, tests aplicables, revisión de consumidores y segunda pasada adversarial.

---

## 1. Roadmap global

| Bloque | Objetivo | Estado |
|---|---|---|
| **A** | `PullEvaluationContext`: fuente única para validez del pull, intervalo evaluable, wipe-call boundary y ninja-pull | **AUDITING** |
| **B** | `MechanicPolicy v2`: identidad y semántica multidimensional de mecánicas | PENDING |
| **C** | Resolver por occurrence: objetivo, responsable, resolución y daño colateral | PENDING |
| **D** | `player_execution_events`: ledger canónico de decisiones evaluables | PENDING |
| **E** | Integración causal con defensivos v2, externals y supervivencia | PENDING |
| **F** | Consumibles/prepot y oportunidades verificables | PENDING |
| **G** | Dossier/infografía v2: visual, verificable y escalable | PENDING |
| **H** | Backfill controlado, corpus real, calibración, activación y retirada de legacy | PENDING |

> Los bloques posteriores pueden subdividirse si durante la auditoría aparecen dependencias que hagan inseguro un cambio grande. No se adelanta lógica de scoring de un bloque posterior dentro de uno anterior salvo que sea imprescindible para preservar coherencia.

---

# BLOQUE A — PullEvaluationContext

## A.1 Objetivo funcional

Crear una frontera autoritativa común que responda, para cualquier pull:

1. si el pull es un intento real y por tanto elegible para estadísticas;
2. desde qué instante hasta qué instante existe ejecución competitiva/evaluable;
3. si existe wipe call, cuál es su boundary efectivo;
4. de dónde procede ese boundary (`auto`, `manual`, etc.), con qué confianza y si fue verificado;
5. si el pull es ninja, si la decisión es automática o manual y por qué;
6. si un evento con timestamp concreto puede puntuar o solo conservarse como evidencia/contexto.

La meta no es borrar datos. La meta es que **todos los consumidores puedan formular la misma pregunta a la misma fuente** en lugar de replicar filtros de `wipe_call_excluded`, `wipe_call_signals->wipeCallStartMs` y `ninja_pull_excluded` en cada vista/servicio.

## A.2 Problemas reales que corrige

### A-BUG-001 — El detector de wipe infiere colapso, no una llamada humana

**Estado:** confirmado en auditoría.

`_shared/wipe-call-detection.ts` detecta una cadena terminal de muertes y fija `wipeCallStartMs` a partir de una heurística (`triggerDeathsKept`). Es útil como inferencia de colapso, pero no demuestra el instante real en que el RL dijo “wipe”.

**Riesgo:** si el RL aguanta ocho muertes antes de llamar wipe, la heurística puede cortar antes y perdonar muertes que sí pertenecían a ejecución normal; si llama antes de la siguiente muerte, puede cortar tarde.

**Resolución prevista en A:** conservar el detector como evidencia automática, pero separar la **decisión/boundary efectivo** del detector y permitir boundary manual autoritativo.

### A-BUG-002 — El override de wipe no puede crear un wipe que el detector no vio

**Estado:** confirmado en `set-wipe-call-status/index.ts`.

El endpoint rechaza cualquier pull sin `wipe_call_signals` y solo acepta `excluded:boolean`.

**Riesgo:** el RL no puede corregir un falso negativo ni indicar el timestamp exacto.

**Resolución prevista en A:** contrato retrocompatible que acepte override manual explícito y boundary, sin exigir señales automáticas previas.

### A-BUG-003 — El override de ninja contradice su propio propósito

**Estado:** confirmado en `set-ninja-pull-status/index.ts`.

El comentario indica que debe permitir marcar ninjas reales no cazados por la heurística, pero el endpoint exige `ninja_pull_signals` existentes. Si el detector devolvió `null` (por ejemplo, pull >45s), precisamente no existen esas señales.

**Resolución prevista en A:** override manual independiente de que exista candidato automático.

### A-BUG-004 — La heurística ninja actual puede excluir intentos reales cortos

**Estado:** confirmado en `analyze-report/index.ts`.

En pulls <45s, el detector usa `engagedFraction <= 0.30 OR bossHealthPct >= 90`. Un intento legítimo con toda la raid comprometida, primera mecánica letal a ~25s y boss al 94% puede quedar excluido por el segundo término aunque claramente hubo intención de combate.

**Alcance A:** no se rediseña todavía todo el clasificador probabilístico, pero se elimina la contradicción de override y se deja el contexto preparado para separar señal automática de decisión efectiva. El ajuste de heurística solo se hará en A si puede demostrarse sin introducir una segunda fuente de verdad.

### A-BUG-005 — Filtros de intervalo duplicados

**Estado:** confirmado en migraciones y consumidores.

Varias views repiten directamente la expresión:

`wipe_call_excluded && wipe_call_signals.wipeCallStartMs && event_time >= boundary`

mientras otras usan `wipe_call_cluster`, y ninja se filtra por `ninja_pull_excluded` de forma independiente.

**Riesgo:** un consumidor puede considerar evaluable un evento que otro excluye.

**Resolución prevista en A:** crear un contrato/view canónico de contexto y helpers de lectura; los consumidores se migrarán gradualmente, manteniendo columnas legacy durante la transición.

### A-BUG-006 — Un reanálisis puede pisar una decisión humana si cambia la confianza

**Estado:** confirmado en `reanalyze-wipe-call/index.ts`.

El reanálisis preserva `wipe_call_excluded` solo mientras `newConfidence === oldConfidence`. Si cambia la confianza, vuelve a imponer la decisión automática aunque el RL hubiese editado manualmente el pull.

**Riesgo:** una corrección humana autoritativa puede desaparecer tras cambiar/mejorar el detector.

**Resolución prevista en A:** persistir procedencia/override explícito; un reanálisis actualiza evidencia automática pero no pisa un override manual.

## A.3 Baseline técnico confirmado

### Datos actuales en `pulls`

- `wipe_call_confidence`
- `wipe_call_signals` (incluye `wipeCallStartMs`)
- `wipe_call_excluded`
- `is_ninja_pull`
- `ninja_pull_excluded`
- `ninja_pull_signals`
- `updated_at` como señal de invalidación retroactiva de caché

### Datos actuales en `player_pull_records`

- `wipe_call_cluster`
- `death_cause.statisticalExclusionReason` para algunas exclusiones históricas específicas

### Código actual relevante

- `supabase/functions/_shared/wipe-call-detection.ts`
- `supabase/functions/analyze-report/index.ts`
- `supabase/functions/reanalyze-wipe-call/index.ts`
- `supabase/functions/set-wipe-call-status/index.ts`
- `supabase/functions/set-ninja-pull-status/index.ts`
- migrations de wipe/ninja y las views de fiabilidad/ofensores
- consumidor defensivo v2 con cutoff temporal propio
- UI de banners de wipe/ninja y servicios de resumen/caché

## A.4 Invariantes de diseño

1. **La evidencia automática y la decisión efectiva no son el mismo dato.**
2. **Manual > automático** hasta que el override se retire explícitamente.
3. **Ninja confirmado** excluye el pull completo; un wipe call recorta un intervalo, no borra el pull.
4. `evaluation_start_ms = 0` para el modelo actual; se deja preparado el contrato para cambiarlo en el futuro sin alterar consumidores.
5. `evaluation_end_ms` debe ser un boundary relativo al inicio del fight y estar dentro de `[0, duration_ms]`.
6. Un evento exactamente en el boundary de wipe se considera post-call/no puntuable (`event_ms < evaluation_end_ms` es evaluable).
7. Datos post-wipe pueden conservarse y mostrarse como contexto, pero no deben sumar ni restar scoring competitivo.
8. Toda corrección manual bumpea `pulls.updated_at` para invalidar consumidores cacheados existentes.
9. Reanálisis automático actualiza detector/evidencia, pero nunca elimina ni reinterpreta silenciosamente un override manual activo.
10. La migración es aditiva: no se eliminan todavía `wipe_call_*`, `ninja_pull_*` ni `wipe_call_cluster`.

## A.5 Diseño de fuente única

Se implementará un contexto canónico derivado/persistido que exponga al menos:

- `pull_id`
- `pull_eligible`
- `evaluation_start_ms`
- `evaluation_end_ms`
- `exclusion_reason`
- wipe automático: detectado, confidence, suggested boundary y signals
- wipe efectivo: activo, boundary, source, confidence/verified cuando aplique
- ninja automático: veredicto/signals
- ninja efectivo: excluded, source/override

La view/contrato debe ser la única interpretación compleja. Las columnas legacy continúan como compatibilidad durante la migración.

## A.6 Dependencias y consumidores identificados

Cambiar el contexto puede afectar a:

`pulls → player_pull_records / pull_mechanic_events / defensive_pressure_windows → reliability / dossier / night summaries / local defensive evidence / preparation`

Además, cualquier edición retroactiva debe propagar invalidación mediante `pulls.updated_at`.

No se migrarán en A todas las semánticas de responsabilidad mecánica; eso pertenece a B/C/D. Sí se evita que esos bloques nazcan leyendo directamente flags legacy.

## A.7 Plan de implementación del bloque

- [x] Crear rama aislada desde el commit exacto de `fix/defensive-catalog-discovery-v5`.
- [x] Auditar progress docs existentes y adoptar su patrón de trazabilidad.
- [x] Auditar esquema y endpoints actuales de wipe/ninja.
- [ ] Añadir persistencia aditiva de procedencia/override y contexto canónico.
- [ ] Crear helper backend común para resolver el contexto efectivo y comprobar timestamps.
- [ ] Hacer que overrides manuales funcionen aunque el detector no haya generado señales.
- [ ] Permitir boundary manual exacto de wipe con validación de rango.
- [ ] Impedir que `reanalyze-wipe-call` pise overrides humanos.
- [ ] Sincronizar `player_pull_records.wipe_call_cluster` con el boundary efectivo cuando se edite manualmente.
- [ ] Mantener `updated_at` como invalidación retroactiva.
- [ ] Migrar al menos los consumidores de backend directamente afectados por el cutoff a la fuente canónica o dejar adaptador de compatibilidad explícito.
- [ ] Añadir pruebas de contrato/regresión aplicables.
- [ ] Revisión 1: especificación + propagación.
- [ ] Revisión 2: adversarial (nulls, límites, override/reanálisis, ninja+wipe, legacy, caches, histórico).

## A.8 Casos de aceptación mínimos

- Wipe automático, sin override → boundary sugerido se convierte en efectivo si el call está activo.
- Falso positivo automático → RL lo desactiva; reanálisis posterior no vuelve a activarlo silenciosamente.
- Falso negativo → RL puede crear wipe call manual aunque `wipe_call_signals IS NULL`.
- RL mueve boundary → muertes/eventos anteriores siguen evaluables; posteriores dejan de puntuar.
- Boundary `0ms` es válido.
- Boundary negativo o > duración se rechaza.
- Ninja automático → pull no elegible.
- Falso positivo ninja → override manual restaura el pull.
- Ninja no detectado → override manual puede excluirlo aunque `ninja_pull_signals IS NULL`.
- Reanálisis automático no elimina un override manual ninja/wipe.
- Modificar contexto cambia `pulls.updated_at`.
- Ninguna migración borra filas ni altera planes defensivos históricos.

## A.9 Registro de revisión

### Primera pasada — pendiente

Se ejecutará al finalizar implementación funcional.

### Segunda pasada adversarial — pendiente

Buscar explícitamente:

- manual override pisado por reanálisis;
- boundary fuera de rango;
- `0` confundido con falsy/null;
- `wipe_call_excluded=true` sin boundary;
- ninja y wipe simultáneos;
- discrepancia `wipe_call_cluster` vs boundary;
- consumers que siguen leyendo `wipe_call_signals` como decisión;
- invalidación de caché olvidada;
- actualización histórica destructiva;
- doble interpretación frontend/backend.

---

## 2. Registro global de bugs e inconsistencias

| ID | Bloque | Severidad | Estado | Descripción |
|---|---|---:|---|---|
| A-BUG-001 | A | Alta | OPEN | Detector de wipe infiere colapso, no llamada RL real |
| A-BUG-002 | A | Alta | OPEN | Override wipe no crea falsos negativos ni fija boundary |
| A-BUG-003 | A | Alta | OPEN | Override ninja exige signals y contradice su caso de uso |
| A-BUG-004 | A | Alta | OPEN | Heurística ninja usa OR y puede excluir early wipes legítimos |
| A-BUG-005 | A | Alta | OPEN | Interpretación de cutoff duplicada en múltiples consumidores |
| A-BUG-006 | A | Alta | OPEN | Reanálisis puede pisar override humano si cambia confidence |

---

## 3. Commits del proyecto causal

| Commit | Bloque | Contenido |
|---|---|---|
| _se irá rellenando_ | A | — |

---

## 4. Pendientes que NO deben olvidarse al cambiar de hilo

1. Leer siempre este archivo antes de tocar código.
2. Contrastar su estado contra el código/commits reales de la rama.
3. No asumir que un checkbox equivale a runtime validado; registrar claramente qué fue estático y qué fue probado con DB/WCL real.
4. No activar scoring o dossier autoritativo sobre una fuente nueva hasta que su backfill/corpus real esté validado.
5. Todo bug encontrado durante un bloque se registra aquí aunque su solución pertenezca a un bloque posterior.
