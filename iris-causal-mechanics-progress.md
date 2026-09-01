# IRIS Causal Mechanics v2 — Diario de implementación

Este documento es el registro acumulativo de implementación de `feature/iris-causal-mechanics`. Debe actualizarse al abrir y cerrar cada bloque y siempre que aparezca un hallazgo, bug, fix, cambio de contrato, deuda o desviación respecto a la especificación.

## Referencia y baseline

- Especificación: `IRIS_Especificacion_Tecnico_Funcional_Causal_Mechanics_v2.0.docx` (1 de septiembre de 2026).
- Rama objetivo: `feature/iris-causal-mechanics`.
- Commit baseline auditado: `4aad209930a72c5150e57e2b10456a51999e2cbd`.
- Estado al iniciar: la rama coincide exactamente con el commit de referencia de la especificación; no hay drift previo que reconciliar.
- Regla de rollout: todo lo nuevo permanece shadow/readiness-first. Este diario no autoriza scoring v3 por el hecho de que una capa técnica exista.

## Estado global

| Bloque | Estado | Nota |
|---|---|---|
| A — Collector y parser | **EN CURSO** | Foundation local implementada; 15/15 tests sintéticos. Falta corpus real/full-night y transporte shadow. |
| B — Sessionizer y snapshots | Pendiente | No iniciado. |
| C — PullEvaluationContext | Pendiente | No iniciado. |
| D — Policy v3 | Pendiente | No iniciado. |
| E — Spatial foundation | Pendiente | No iniciado. |
| F — Tank/soak/interrupt | Pendiente | No iniciado. |
| G — Responsibility + ledger | Pendiente | No iniciado. |
| H — Defensive/consumable causal | Pendiente | No iniciado. |
| I — Planning causal | Pendiente | No iniciado. |
| J — Dosier v3 | Pendiente | No iniciado. |
| K — Reliability v3 | Pendiente | No iniciado. |
| L — Legacy cleanup | Pendiente | No iniciado. |

---

# Bloque A — Collector y parser

## Objetivo del bloque

Construir la primera capa raw-first de IRIS sin causalidad ni scoring: lectura incremental de `WoWCombatLog.txt`, framing por bytes, parser versionado/tolerante, estado de formato, spool durable y fixtures/tests. La salida de este bloque solo puede alimentar diagnostics/facts shadow.

Definition of Done de la especificación: **una noche completa debe poder reproducirse sin duplicados y sin WCL**. Este DoD no se considera cerrado hasta probarlo con corpus real versionado.

## A.0 Auditoría inicial

### Confirmado

- [x] La rama está exactamente en el baseline `4aad209930a72c5150e57e2b10456a51999e2cbd` al abrir el bloque.
- [x] El root sigue siendo la app Angular/Supabase existente; no existían `apps/iris-collector` ni `packages/combat-log-*`.
- [x] Se mantiene el principio de la especificación: el collector no decide ownership, culpabilidad ni score.
- [x] Se verificó el formato actual documentado del Advanced Combat Log antes de fijar índices del parser.
- [x] `coiling-occurrence-1.txt`, citado por la especificación como fixture interno analizado, no está versionado en la rama/repositorio accesible. Se registra como pendiente de corpus y no se inventa su contenido.

## A.1 Estructura añadida

```text
apps/
  iris-collector/
    package.json
    src/
      cli.ts
      collector.ts
      file-tail/incremental-tail.ts
      spool/jsonl-spool.ts
      state/collector-state.ts
    test/
      file-tail.test.ts
      spool-and-collector.test.ts
packages/
  combat-log-contracts/
    package.json
    src/index.ts
  combat-log-parser/
    package.json
    src/index.ts
    test/parser.test.ts
```

La primera fase no convierte el root en npm workspace. Los paquetes son privados y exportan source TypeScript. Esta opción está permitida explícitamente por la especificación para evitar contaminar el root durante la validación del pipeline. Antes del empaquetado del collector habrá que decidir workspace/tipos generados y eliminar imports relativos de source si dejan de ser adecuados.

## A.2 Decisiones de contrato

### A-D001 — Offsets son bytes y usan rango semiabierto

`RawLineRef.byteStart` y `byteEndExclusive` representan `[start,end)` sobre el fichero original. `byteEndExclusive` incluye el newline consumido. Esto permite concatenar rangos sin ambigüedad y reabrir exactamente una raw slice.

### A-D002 — `bigint` en memoria; decimal string en persistencia/transporte

`sequence` es `bigint` dentro del parser para no perder precisión. En spool/wire se serializa como decimal string (`SequenceString`). Motivo: `JSON.stringify` no serializa `bigint` y convertirlo a `number` rompería secuencias por encima de `Number.MAX_SAFE_INTEGER`.

### A-D003 — El timestamp textual no se trata como UTC

El fichero contiene `MM/DD HH:mm:ss.SSS`, sin año ni zona. El resolver:

1. conserva `rawTimestamp` sin modificar;
2. resuelve el año desde una fecha de referencia del logger;
3. usa la zona local del logger (o un offset fijo solo para replay/tests);
4. conserva `clockContext` en el estado local (`timeZone`, `referenceYear`, provenance `logger_local_clock`).

Nunca se añade una `Z` ni se interpreta el texto como UTC por conveniencia.

### A-D004 — `infoGuid` manda sobre la identidad del AdvancedSnapshot

El snapshot avanzado conserva `infoGuid` y deriva `describesActor` comparando ese GUID con source/target. No se aplica HP/X/Y al source o target por posición del subevento. Esto cubre la diferencia documentada entre `SWING_DAMAGE` (info de source) y `SWING_DAMAGE_LANDED` (info de destination).

### A-D005 — Estado de formato desconocido degrada, no adivina

Antes de conocer `COMBAT_LOG_VERSION` (o recuperar su estado del spool), un evento de combate puede conservar actors/ability cuyo layout base sea estable, pero su payload queda `unknown: format_state_unknown`. No se intenta desplazar 17 campos advanced por heurística.

### A-D006 — Eventos no verificados quedan reparsables

Un evento desconocido conserva `tokenizedFields` y `RawLineRef`. `SPELL_ABSORBED`/`SPELL_HEAL_ABSORBED` se mantienen inicialmente como `schema_not_verified` porque existen layouts diferentes y todavía no hay fixtures gold reales de ambos. Se prefiere `unknown` reproducible a un parse incorrecto que contamine evidence.

### A-D007 — Commit local ocurre después del spool durable

`lastCommittedOffset` solo avanza después de serializar y `fsync` del spool. Si el proceso cae entre spool y state, el arranque reconcilia el último `SpoolRecord` durable antes de volver a leer el fichero.

## A.3 Implementado

### Contratos

- [x] `ActorRef`, `AbilityRef`, `AdvancedSnapshot`, `RawLineRef`.
- [x] `RawCombatLogEvent` canónico con parser/log/build provenance.
- [x] Payloads tipados iniciales para metadata, damage, heal, miss, energize, aura, cast, interrupt, dispel y unit death.
- [x] `UnknownPayload` con reason code + tokens.
- [x] Contrato wire JSON-safe y conversión explícita de bigint.
- [x] `CombatLogFormatState` y `CollectorClockContext`.
- [x] `SpoolRecord` versionado.

### Parser

- [x] Tokenizer CSV-like: respeta strings entrecomillados y no corta comas dentro de `()`, `[]` o `{}`.
- [x] Envelope `MM/DD HH:mm:ss.SSS  EVENT,...`.
- [x] `COMBAT_LOG_VERSION` y actualización de `advancedEnabled`, format version, build y project ID.
- [x] Metadata inicial: `ZONE_CHANGE`, `MAP_CHANGE`, `ENCOUNTER_START`, `ENCOUNTER_END`, `COMBATANT_INFO`.
- [x] Prefix base para SWING/RANGE/SPELL/SPELL_PERIODIC/SPELL_BUILDING/ENVIRONMENTAL y special damage events conocidos.
- [x] 17 campos `AdvancedSnapshot` sin null→0.
- [x] Payloads iniciales de damage/heal/missed/energize/aura/cast/interrupt/dispel/death.
- [x] Version gate: si advanced es desconocido no se fuerza parse.
- [x] Parser version `iris-combat-log-parser/0.1.0`.

### File tail

- [x] Lectura desde byte offset, nunca desde inicio por defecto.
- [x] Chunks acotados.
- [x] Línea parcial no avanza committed offset.
- [x] CRLF/LF.
- [x] `byteStart`/`byteEndExclusive` exactos.
- [x] hash SHA-256 corto por línea para auditoría/dedupe auxiliar.
- [x] truncate detectado.
- [x] file identity basada en `dev:ino:birthtime` para replacement/rotation.
- [x] límite de tamaño de línea para evitar crecimiento sin newline.

### Spool/state

- [x] Journal JSONL durable con `fsync`.
- [x] Retry local de una secuencia ya persistida no duplica registros.
- [x] Recuperación de escritura final truncada/torn.
- [x] Estado durable por stream: identity, committed/uploaded offset, sequence, format state y clock context.
- [x] Reconciliación spool→state tras crash.
- [x] Truncate/replacement abre un stream nuevo; no reutiliza offsets del stream viejo.
- [x] CLI mínima para validación local (`--log`, `--data-dir`, `--once`, `--poll-ms`).
- [x] Advanced disabled se hace visible en diagnostics local.

## A.4 Tests ejecutados

### Parser — 7/7 PASS

- [x] quoted comma + nested groups;
- [x] `COMBAT_LOG_VERSION`/build provenance;
- [x] `SWING_DAMAGE` advanced describe source;
- [x] `SWING_DAMAGE_LANDED` advanced describe target;
- [x] format state desconocido no desplaza advanced;
- [x] `COMBATANT_INFO` conserva grupos anidados;
- [x] bigint > `Number.MAX_SAFE_INTEGER` serializa como string y JSON válido.

### Collector/file-tail/spool — 8/8 PASS

- [x] línea partida entre reads;
- [x] truncate;
- [x] replacement/rotation por file identity;
- [x] fichero sparse >10 GB leído desde offset final sin rescan desde cero;
- [x] spool durable y retry local idempotente;
- [x] recuperación de torn write;
- [x] restart collector sin duplicar facts;
- [x] truncate crea stream nuevo y reinicia sequence dentro de ese stream.

**Total actual: 15/15 PASS.**

Los tests se ejecutaron con Node 22 usando type stripping nativo para no depender de instalar paquetes externos durante la auditoría. El runner definitivo puede migrarse a Vitest cuando se integre el package/workspace; la lógica testada es la misma.

## A.5 Hallazgos y mejoras respecto a la especificación

### A-F001 — El contrato canónico necesitaba una forma wire explícita

La especificación define `sequence: bigint`, pero el transporte previsto es JSON/compressed JSON. Sin adaptación, el primer batch fallaría en runtime. Se introduce `WireRawCombatLogEvent` y `SequenceString` sin cambiar el tipo canónico en memoria.

### A-F002 — Timestamp requiere provenance de reloj

La especificación exigía conservar timestamp textual y parseado, pero no cerraba año/zona. Se añade `CollectorClockContext` para que un replay no dependa silenciosamente de la timezone del servidor cloud.

### A-F003 — `COMBATANT_INFO` requiere tokenizer con nesting además de CSV quoting

No basta con soportar comas dentro de nombres entrecomillados. `COMBATANT_INFO` contiene listas/tuplas anidadas con comas. El tokenizer solo separa comas a profundidad 0.

### A-F004 — El parser no debe declarar “soportado” un subevento por compartir prefijo

`SPELL_ABSORBED` demuestra que un `startsWith('SPELL_')` no basta para fijar layout. Se crea un gate `schema_not_verified` que podrá reducirse según crezca el corpus gold.

### A-F005 — La recuperación crash-safe requiere que format state viaje en el spool

Si el proceso cae después del `fsync` del evento pero antes de guardar `state.json`, recuperar solo sequence/offset no basta: un reinicio podría olvidar `ADVANCED_LOG_ENABLED` y volver a parsear mal. Cada `SpoolRecord` conserva `formatState` posterior al evento y puede reparar el state.

### A-F006 — Fixture real citado pero no versionado

`coiling-occurrence-1.txt` aparece en la especificación/fuentes internas, pero no está presente en la rama accesible. No se recrea a mano. Hasta incorporar ese raw (sanitizado si procede) y una noche completa, el Block A permanece **EN CURSO**.

## A.6 Bugs encontrados y arreglos

### A-B001 — `bigint` rompe JSON

- **Síntoma:** `JSON.stringify` lanza con `bigint`.
- **Causa raíz:** contrato de dominio y contrato de transporte estaban implícitamente mezclados.
- **Fix:** decimal string exclusivamente en wire/spool; `bigint` en memoria.
- **Regresión:** test con `9007199254740993n`.

### A-B002 — Una línea incompleta podía perderse si se avanzaba hasta EOF leído

- **Riesgo:** el writer de WoW puede dejar un chunk sin newline.
- **Fix:** `nextCommittedOffset` solo avanza hasta el último newline completo. El fragmento se relee de forma acotada en el siguiente poll/restart.
- **Regresión:** fixture `partial` + append posterior.

### A-B003 — Crash entre spool y state podía provocar replay duplicado

- **Riesgo:** state rezagado respecto a facts ya durables.
- **Fix:** reconcile del último spool record al iniciar, con secuencia/offset/format state.
- **Regresión:** se recrea una instancia de collector sobre el mismo spool/state y se verifica 2 records, no 3.

### A-B004 — Escritura final del spool puede quedar cortada

- **Riesgo:** power loss/process kill durante append.
- **Fix:** `lastRecord()` detecta JSON final inválido, trunca solo el tail incompleto y recupera el record durable anterior.
- **Regresión:** se inyecta un JSON truncado al final.

### A-B005 — Node strip-only rechazaba parameter properties TypeScript

- **Síntoma durante QA:** el runner nativo de Node 22 rechazó `constructor(private readonly ...)`.
- **Fix:** propiedades explícitas en las clases ejecutadas directamente como TS.
- **Impacto producto:** ninguno; mejora la ejecutabilidad sin transpiler durante esta fase.

## A.7 Deuda/pending para cerrar Block A

- [ ] Incorporar fixtures reales sanitizados (incluido Coiling si está disponible) y corpus de 3–5 noches conforme a investigación prioritaria.
- [ ] Inventariar todos los event types reales; promover a typed solo los verificados.
- [ ] Resolver ambos layouts de `SPELL_ABSORBED` con fixtures gold.
- [ ] Validar visibilidad/semántica real de `SPELL_CAST_FAILED` entre loggers antes de usarlo aguas abajo.
- [ ] Probar Windows real con WoW escribiendo el fichero: locks, rotation y rename semantics.
- [ ] M11 cloud: devices/streams/sessions/fact batches.
- [ ] Pairing/device credential y endpoint `ingest-combat-log-batch`.
- [ ] Batch idempotency cloud por `(device_id, stream_id, batch_sequence)`/hash.
- [ ] Compresión gzip/deflate y retry/offline end-to-end.
- [ ] Convertir `pendingAfter()` en lectura indexada/batcheada; la implementación actual recorre solo el journal pendiente y no debe ser el mecanismo de producción para spools grandes.
- [ ] Feature flag `localCombatLogIngestV1` off + diagnostics/facts shadow en backend.
- [ ] Replay de una noche completa sin WCL y comprobación de cero duplicados.

## A.8 Gate de cierre

**NO CERRAR A** hasta demostrar con raw real:

1. una noche completa puede tail/parse/replay desde local;
2. restart y offline no pierden ni duplican facts;
3. unknown event rate está medido y explicado;
4. Advanced disabled produce degraded explícito;
5. cloud shadow ingest es idempotente;
6. no existe dependencia de WCL para el replay propio.

---

## Registro acumulativo de incidencias

| ID | Bloque | Tipo | Estado | Resumen |
|---|---|---|---|---|
| A-B001 | A | Bug de contrato | Resuelto | bigint no serializable en JSON. |
| A-B002 | A | Bug de tailing | Resuelto | Partial line no puede avanzar offset. |
| A-B003 | A | Bug de recovery | Resuelto | Crash spool/state podía duplicar replay. |
| A-B004 | A | Bug de durability | Resuelto | Torn final JSONL write. |
| A-B005 | A | Tooling | Resuelto | Parameter properties incompatibles con Node strip-only. |
| A-F006 | A | Corpus | Abierto | Fixture Coiling citado no está versionado. |

## Próximo incremento

Continuar dentro de **Bloque A** con el transporte shadow y M11, manteniendo flags off. Antes de declarar A terminado se incorporará raw real y se ejecutará el replay full-night.
