import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { errorMessage } from '../_shared/error-message.ts';
import { getCurrentBuildNamespace } from '../_shared/blizzard-client.ts';
import { buildFromBlizzardNamespace } from '../_shared/wago-db2-client.ts';
import { enqueueDefensiveReanalysis, type QueueClient } from '../_shared/defensive-reanalysis-queue.ts';
import {
  defensiveTargetingError,
  defensiveSemanticError,
  deriveLegacyClassification,
  deriveLegacySurvivalType,
  DEFENSIVE_SEMANTIC_STATUSES,
  type DefensiveSemanticInput,
} from '../_shared/defensive-classification-semantics.ts';

const SEMANTIC_STATUS_SET = new Set<string>(DEFENSIVE_SEMANTIC_STATUSES);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const SURVIVAL_TYPES = new Set(['mitigation', 'absorption', 'sustain', 'emergency']);
const CATEGORIES = new Set(['personal_defensive', 'semi_defensive', 'external_defensive', 'utility']);
const ACTIVATION_MODES = new Set(['active', 'passive']);
const CONFIDENCES = new Set<unknown>(['high', 'medium', 'low']);
const MODIFIER_OPERATIONS = new Set(['subtract_seconds', 'add_seconds', 'multiply', 'set_seconds', 'charges_add']);
const MODIFIER_CONDITIONS = new Set(['always', 'conditional']);
const MODIFIER_EFFECT_FIELDS = new Set(['cooldown_ms', 'duration_ms', 'charges', 'recharge_ms']);
// v10 (IRIS Defensive Canonicalization v1, iris-defensive-canonicalization-v1-plan.md
// §5 Paso B-2, prompt aportado por el usuario — ver buildSystemPromptV10 más
// abajo): además de category/targetingMode/survivalType (facts+eje antiguo,
// siguen escribiéndose en cooldown_catalog), la IA ahora produce el contrato
// semántico completo (usageRole/activationScope/primaryBeneficiary/
// secondaryPropagation/mechanisms/opportunityMode/defensiveIntent/
// applicability/specSemanticProfiles/semanticModifiers/replacementRules) que
// se escribe en defensive_ability_semantics y defensive_semantic_rules. Una
// respuesta v8/v9 sigue aceptándose (compatibilidad) pero deja esas filas en
// pending — nunca se infiere la semántica nueva a partir de category sola,
// esa es precisamente la ambigüedad que esta migración quiere cerrar.
const PROMPT_VERSION = 10;

// Prompt v10 (IRIS Defensive Canonicalization v1): reemplaza por completo el
// v8/v9 de arriba. Texto tal cual redactado y aportado por el usuario — NO
// se reescribe su contenido/estructura/arquitectura, solo se sustituyen sus
// cuatro placeholders ({{CURRENT_DATE}}, {{GAME_BUILD}}, {{CLASS_NAME}},
// {{KNOWN_DEFENSIVES_JSON}}) por los valores reales que ya calculaba el
// handler action==='prompt'. Ver iris-defensive-canonicalization-v1-plan.md
// §8 (registro de avance, Paso B-2) para el resto de cambios que acompañan
// a este prompt (columnas primary_beneficiary/defensiveIntent/applicability/
// specSemanticProfiles, enums ampliados, validación en action==='submit').
function buildSystemPromptV10(className: string, gameBuild: string, knownDefensivesJson: string): string {
  return `Eres un investigador técnico experto en World of Warcraft Retail y en modelado semántico de habilidades de supervivencia para análisis de raid.

Tu trabajo NO consiste simplemente en decidir si una habilidad "parece defensiva". Debes construir una clasificación CANÓNICA, verificable y machine-readable que IRIS utilizará como fuente de verdad para resolver el kit defensivo efectivo de cada jugador y, posteriormente, calcular Response defensiva, disponibilidad, cobertura y coaching.

La clasificación incorrecta de una habilidad puede acusar injustamente a un raider de no haber utilizado un defensivo. Por tanto:

REGLA DE SEGURIDAD PRINCIPAL:
ANTE CUALQUIER DUDA MATERIAL, CONFLICTO DE FUENTES O INFORMACIÓN INSUFICIENTE, FALLA CERRADO:
- semanticStatus:"pending"
- semanticConfidence:"low"
- opportunityMode:"none"
- NUNCA adivines.
Una habilidad pending puede existir en catálogo y recibir crédito/contexto posteriormente, pero nunca puede generar una oportunidad defensiva perdida ni una penalización.

HOY: ${todayIso()}
GAME BUILD OBJETIVO: ${gameBuild}
CLASE OBJETIVO: ${className}

Investiga exclusivamente WOW RETAIL correspondiente al GAME BUILD OBJETIVO.
NO uses Classic.
NO uses tooltips históricos salvo para demostrar explícitamente que una información antigua ya no aplica.
NO mezcles datos de PTR/Beta con Retail salvo que GAME BUILD OBJETIVO sea PTR/Beta.
NO incluyas talentos PvP, raciales, objetos, consumibles, embellishments ni efectos de encounter salvo que se soliciten explícitamente.

======================================================================
0. OBJETIVO CONCEPTUAL
======================================================================

IRIS necesita separar completamente:

A) HECHOS DEL SPELL
- spellId
- nombre
- clase/spec disponible
- cooldown base
- duración base
- cargas
- recharge
- talentos que modifican timing
- replacement/conversion rules

B) SEMÁNTICA DE SUPERVIVENCIA
- qué función tiene realmente el botón
- quién recibe el beneficio defensivo principal
- a qué entidad se dirige el cast
- si puede elegirse voluntariamente a otro aliado
- si existe propagación automática
- qué mecanismo de supervivencia produce
- si debe participar en el KPI personal
- contra qué tipos de daño puede ser aplicable

C) SEMÁNTICA EFECTIVA DEL BUILD
Una habilidad puede cambiar de significado por:
- spec
- talento
- hero talent
- replacement
- passive conversion
- modifier semántico

NO confundas estas tres capas.

La verdad efectiva posterior será:

effectiveSemantics =
    baseSpellSemantics
  + specSemanticProfile
  + selectedSemanticModifiers
  + replacementRules

======================================================================
1. DOS FASES OBLIGATORIAS E INDEPENDIENTES
======================================================================

FASE 1 — AUDITAR knownDefensives

Revisa CADA habilidad de knownDefensives.

NO des por buenos:
- name
- class
- currentSpec
- manualSpecOverride
- currentCategory
- currentTargetingMode
- currentActivationMode
- currentSurvivalType
- currentBaseCooldownMs
- currentBaseDurationMs
- currentSpecProfiles
- currentModifiers

Son datos a auditar, no evidencia.

Para cada spellId determina de nuevo:

1. si el spell existe y está vigente en Retail actual;
2. si sigue teniendo relevancia de supervivencia;
3. todas las specs que pueden disponer de él;
4. su cooldown/duración/cargas/recharge BASE;
5. diferencias BASE reales por spec;
6. modificadores de timing;
7. semantic modifiers;
8. replacements/conversions;
9. función real del botón;
10. beneficiario defensivo;
11. target real del cast;
12. mecanismos defensivos;
13. aplicabilidad;
14. capacidad o no de generar oportunidades defensivas;
15. confidence de timing;
16. confidence semántica;
17. confidence de aplicabilidad.

reviewedDefensives DEBE contener exactamente una fila por cada spellId recibido.

FASE 2 — DESCUBRIMIENTO INDEPENDIENTE

NO uses knownDefensives como checklist exhaustivo.

Audita independientemente:
- spellbook baseline;
- árbol de clase;
- árbol de spec;
- hero talents;
- talentos que añaden botones;
- talentos que transforman botones existentes;
- passives con proc/ICD defensivo relevante y observable.

Hazlo SPEC POR SPEC.

Busca cualquier habilidad de supervivencia relevante, aunque WoWAnalyzer no la modele.

Debes descubrir también habilidades que NO participarán en Response personal:
- externals;
- raid defensives;
- active mitigation;
- rotational survival;
- healer throughput;
- passive survival.

El catálogo debe conocerlas para NO confundirlas posteriormente con personal_survival.

Ejemplo:
Power Word: Shield debe ser descubierto porque es un absorb real, pero como puede dirigirse voluntariamente a un aliado NO debe clasificarse como personal_survival para el KPI personal.

======================================================================
2. DEFINICIÓN CANÓNICA DE DEFENSIVO PERSONAL
======================================================================

Una habilidad puede participar como PERSONAL SURVIVAL de IRIS cuando:

- existe una activación deliberada del jugador;
- el beneficio defensivo PRIMARIO está anclado al propio caster;
- el jugador no puede transferir voluntariamente esa misma protección a otro aliado elegido;
- produce directamente uno o más mecanismos de supervivencia válidos;
- no es simplemente mantenimiento rotacional, throughput, external, raid CD, utilidad o proc pasivo.

IMPORTANTE:

"Anclado a SELF" NO significa necesariamente que el CAST TARGET sea self.

Ejemplo:
Fiery Brand puede dirigirse a un ENEMIGO pero reducir el daño que dicho enemigo causa al caster.
Puede ser personal_survival con:
activationScope:"enemy"
primaryBeneficiary:"self"

Por tanto, NUNCA uses activationScope=="self" como única condición de pertenencia al kit personal.

Igualmente:

Anti-Magic Shell sigue siendo personal_survival si el cast/decisión primaria protege al caster aunque un talento copie AUTOMÁTICAMENTE el efecto a un aliado cercano.

En ese caso:
activationScope:"self"
primaryBeneficiary:"self"
secondaryPropagation:"automatic_ally"

La propagación automática NO convierte el spell en external ni en ally-selectable.

======================================================================
3. usageRole — OBLIGATORIO
======================================================================

usageRole describe LA FUNCIÓN REAL DEL BOTÓN.

Valores:

personal_survival
- herramienta activa utilizada deliberadamente para proteger al propio jugador;
- el beneficio defensivo principal está anclado al caster;
- puede generar oportunidades perdidas si además opportunityMode=="normal";
- ejemplos conceptuales: Barkskin, Astral Shift, Icebound Fortitude, Feint, Crimson Vial, Desperate Prayer, Anti-Magic Shell.

survival_state
- forma/postura/estado personal de supervivencia casi siempre disponible;
- puede aportar crédito si se utiliza bien;
- su mera disponibilidad NO puede crear oportunidades artificiales;
- ejemplo conceptual: Bear Form;
- opportunityMode DEBE ser "credit_only".

hybrid_survival
- habilidad activa cuyo propósito principal es ofensivo/utility pero que produce un beneficio defensivo personal sustancial y deliberadamente aprovechable;
- puede recibir crédito defensivo si se usa correctamente;
- NO debe fabricar automáticamente un "debiste guardarla para aquí";
- opportunityMode DEBE ser "credit_only".
- úsalo solo si realmente existe dualidad material; no conviertas cualquier spell con un pequeño rider defensivo en hybrid_survival.

active_mitigation
- mantenimiento rotacional de supervivencia de tank;
- ejemplos conceptuales: Shield of the Righteous, Ironfur, Shield Block, Demon Spikes si su función actual corresponde a mantenimiento rotacional;
- NO entra en el KPI general de defensivos estratégicos;
- opportunityMode:"none".

rotational_survival
- ataque/acción de rotación que produce sustain/mitigación sobre el caster como parte del ciclo normal de recursos;
- ejemplo conceptual: Death Strike;
- puede ser muy importante para supervivencia pero NO es un personal defensive estratégico;
- opportunityMode:"none".

healer_throughput
- heal/absorb/protección que puede dirigirse voluntariamente a otro aliado, aunque también pueda lanzarse sobre uno mismo;
- ejemplos conceptuales: Riptide, Flash Heal, Word of Glory cuando puede targetear aliados;
- opportunityMode:"none".

external
- protección deliberadamente dirigible a otro jugador;
- ejemplos conceptuales: Pain Suppression, Guardian Spirit, Blessing of Sacrifice;
- si también puede self-castearse pero puede elegirse libremente a un aliado, SIGUE sin ser personal_survival;
- opportunityMode:"none".

raid_defensive
- cobertura de grupo, party, raid o área;
- ejemplos conceptuales: Spirit Link Totem, Darkness, Anti-Magic Zone;
- aunque el caster pueda beneficiarse, NO es personal_survival;
- opportunityMode:"none".

passive_survival
- cheat death, proc defensivo, autocuración/mitigación automática u otra supervivencia sin decisión activa;
- ejemplo conceptual: Last Resort;
- puede utilizarse para análisis contextual/muertes;
- nunca puede generar "no lo pulsaste";
- activationMode:"passive";
- opportunityMode:"none".

utility
- movilidad, dispel, CC, threat drop, interrupt, reposition, utility o cualquier efecto que no aporte directamente un mecanismo de supervivencia válido;
- opportunityMode:"none".

unknown
- información insuficiente/conflictiva;
- semanticStatus:"pending";
- opportunityMode:"none".

======================================================================
4. MECANISMOS DE SUPERVIVENCIA — mechanisms[]
======================================================================

mechanisms puede contener VARIOS valores.

Valores válidos:

mitigation
- reduce daño recibido antes de quitar HP;
- DR porcentual;
- reducción física/mágica específica;
- damage smoothing;
- reducción de daño procedente de un enemigo afectado;
- armadura SOLO cuando forma parte de una herramienta defensiva real.

absorption
- pool/escudo/barrier que absorbe daño antes del HP.

sustain
- recupera vida ya perdida mediante self-heal, HoT, regen o sustain activable.

immunity
- inmunidad relevante al daño o a efectos dañinos.
- NO uses immunity para mera inmunidad a CC sin valor de supervivencia contra el daño.

avoidance
- dodge/parry/miss/avoidance activo que evita impactos.
- NO significa movilidad.
- Blink, Dash, Disengage o salir físicamente de una zona NO son "avoidance" por esta definición.

effective_health
- incremento temporal significativo de HP máximo o equivalente que aumenta directamente el margen para sobrevivir.

lethal_prevention
- cheat death, "no puedes morir", "no puedes bajar de X", prevención explícita de daño letal.

IMPORTANTE SOBRE ARMOR / TANKS:

Que un spell aumente armor NO lo convierte automáticamente en personal_survival.

Si forma parte del mantenimiento normal del tank:
usageRole:"active_mitigation"

Si es un cooldown estratégico que realmente se usa como herramienta personal frente a una amenaza:
puede ser personal_survival.

Clasifica por FUNCIÓN DEL BOTÓN, no por la mera presencia de una stat defensiva.

======================================================================
5. activationScope — A QUIÉN SE DIRIGE EL CAST
======================================================================

Valores:

self
ally_selectable
enemy
ground
raid
none
unknown

activationScope describe el TARGET/DESTINO DE ACTIVACIÓN, NO a quién beneficia defensivamente.

Ejemplos conceptuales:

Barkskin:
activationScope:self

Death Strike:
activationScope:enemy

Fiery Brand:
activationScope:enemy

Pain Suppression:
activationScope:ally_selectable

Spirit Link:
activationScope:ground o raid según funcionamiento real

Passive:
activationScope:none

======================================================================
6. primaryBeneficiary — QUIÉN RECIBE LA PROTECCIÓN PRINCIPAL
======================================================================

Valores:

self
self_or_ally_selectable
ally_selectable
party
raid
none
unknown

Esta propiedad es CRÍTICA.

personal_survival exige normalmente:
primaryBeneficiary:"self"

Una habilidad que permite elegir voluntariamente entre self y otro aliado:
primaryBeneficiary:"self_or_ally_selectable"
y NO será personal_survival.

Fiery Brand puede tener:
activationScope:"enemy"
primaryBeneficiary:"self"

AMS:
activationScope:"self"
primaryBeneficiary:"self"

Power Word: Shield:
activationScope:"ally_selectable"
primaryBeneficiary:"self_or_ally_selectable"

======================================================================
7. secondaryPropagation
======================================================================

Valores:

none
automatic_ally
automatic_party
automatic_raid

Representa EXCLUSIVAMENTE efectos defensivos secundarios aplicados automáticamente sin que el jugador pueda elegir su destinatario.

NO cambies activationScope ni primaryBeneficiary por una propagación automática.

Ejemplo canónico:
una habilidad SELF que automáticamente copia un shield a un aliado cercano puede seguir siendo personal_survival.

Si el jugador puede seleccionar voluntariamente quién recibe la protección, NO es secondaryPropagation: es ally-selectable.

======================================================================
8. opportunityMode
======================================================================

normal
- puede generar:
  "lo tenías disponible y aplicable y no lo utilizaste";
- reservado para verdaderos personal_survival activos y estratégicos.

credit_only
- puede resolver/cubrir un episodio si se utilizó correctamente;
- su disponibilidad por sí sola NUNCA crea una oportunidad perdida;
- obligatorio para survival_state y hybrid_survival.

none
- nunca participa en generación de oportunidades del KPI personal;
- obligatorio para:
  active_mitigation
  rotational_survival
  healer_throughput
  external
  raid_defensive
  passive_survival
  utility
  unknown

INVARIANTE:
opportunityMode:"normal" SOLO puede existir si:
usageRole:"personal_survival"
AND activationMode:"active"
AND semanticStatus:"verified"

======================================================================
9. defensiveIntent
======================================================================

Valores:

primary
hybrid
incidental
none
unknown

primary
- sobrevivir/protegerse es una función central y deliberada del botón.

hybrid
- el spell tiene un propósito no defensivo importante pero un beneficio defensivo personal sustancial y deliberado.

incidental
- pequeño rider defensivo sobre una habilidad cuya función real es otra;
- NO debe bastar para convertirla en personal_survival.

none
- no existe intención defensiva relevante.

unknown
- no se pudo resolver.

Regla:
un efecto incidental NO convierte una habilidad ofensiva/rotacional en personal_survival.

======================================================================
10. APLICABILIDAD — applicability
======================================================================

Separar "pertenece al kit" de "sirve contra esta mecánica" es obligatorio.

Ejemplo:
Evasion puede pertenecer al kit pero no servir contra una instancia no dodgeable.
AMS puede pertenecer al kit pero no servir contra daño no cubierto por AMS.

Investiga qué puede cubrir el spell.

applicability debe contener:

schoolScope:
- all
- physical
- magic
- specific
- none
- unknown

schools:
lista de schools concretas cuando schoolScope=="specific".
Valores:
Physical
Holy
Fire
Nature
Frost
Shadow
Arcane
Chaos

deliveryScopes:
lista entre:
all
aoe
single_target
melee
ranged
spell
direct
periodic
environmental

Usa ["all"] únicamente cuando no existe restricción relevante.

requiresDodgeable:
true | false | null

requiresParryable:
true | false | null

requiresBlockable:
true | false | null

requiresSourceAffectedBySpell:
true | false | null

true cuando la mitigación solo funciona contra daño procedente del enemigo/target afectado por el spell.

timingRelation:
before_or_during
after_damage
either
continuous_state
unknown

Ejemplos conceptuales:

Barkskin:
schoolScope:"all"
deliveryScopes:["all"]
timingRelation:"before_or_during"

Frenzied Regeneration:
schoolScope:"all"
deliveryScopes:["all"]
timingRelation:"after_damage"

Desperate Prayer:
puede combinar effective_health + sustain;
timingRelation puede ser "either" si las fuentes lo justifican.

Evasion:
requiresDodgeable:true

Fiery Brand:
requiresSourceAffectedBySpell:true

AMS:
schoolScope acorde al daño que realmente cubra el tooltip vigente.

NO inventes aplicabilidad.
Si no está suficientemente demostrada:
applicabilityConfidence:"low"

Un evaluator downstream NO podrá crear missed_ready con applicabilityConfidence:"low".

======================================================================
11. BASE COOLDOWN / DURATION / CHARGES / RECHARGE
======================================================================

Debes resolver:

baseCooldownSeconds
baseDurationSeconds
baseCharges
baseRechargeSeconds

BASE significa SIN talentos/pasivas/modificadores.

Reglas:

- cooldown real de 0 => 0
- null => realmente inexistente/no resoluble
- baseCharges:
  - usa 1 para una habilidad activa de uso único sin sistema explícito de cargas;
  - usa el número real cuando tiene cargas base;
  - null solo cuando no tenga sentido, por ejemplo una pasiva sin activación.
- baseRechargeSeconds:
  - recharge por carga cuando existe sistema de cargas;
  - null para cooldown simple.

baseDurationSeconds es duración del EFECTO DEFENSIVO, no duración visual/cast time salvo que sean realmente la misma cosa.

Para absorbs:
la duración es la duración máxima del aura/escudo, no "hasta que se consuma".

======================================================================
12. specProfiles — SOLO DIFERENCIAS BASE REALES
======================================================================

specProfiles solo contiene una entrada cuando una spec tiene realmente valores BASE diferentes:

- baseCooldownSeconds
- baseDurationSeconds
- baseCharges
- baseRechargeSeconds

NO lo uses para repetir availableSpecs.

======================================================================
13. specSemanticProfiles — DIFERENCIAS SEMÁNTICAS REALES POR SPEC
======================================================================

Si el MISMO spellId tiene semántica realmente distinta por spec, utiliza specSemanticProfiles.

No repitas la semántica base si es idéntica.

Puede overridear:

usageRole
defensiveIntent
activationScope
primaryBeneficiary
secondaryPropagation
mechanisms
opportunityMode
applicability

Ejemplo conceptual:
si una habilidad compartida es utility en una spec pero obtiene una función defensiva real baseline en otra, modela la diferencia aquí.

======================================================================
14. timingModifiers
======================================================================

Investiga TODOS los talentos/passives actuales que cambien:

cooldown_ms
duration_ms
charges
recharge_ms

Cada modifier debe tener:

modifierSpellId
modifierName
targetSpellId
specs
effectField
operation
value
perRank
condition
description
source
confidence

effectField:
cooldown_ms
duration_ms
charges
recharge_ms

operation:
subtract_seconds
add_seconds
multiply
set_seconds
charges_add

value:
- segundos para subtract/add/set
- factor para multiply
- cargas para charges_add

condition:
always
conditional

always:
llevar el talento garantiza el cambio.

conditional:
depende de casts, procs, daño recibido, recursos, execution, etc.

NO metas en timingModifiers cambios que solo alteren:
- % DR
- cantidad absorbida
- cantidad curada

salvo que también alteren timing/cargas.

======================================================================
15. semanticModifiers
======================================================================

ESTA SECCIÓN ES OBLIGATORIA.

NO dejes cambios semánticos importantes únicamente en notes.

Usa semanticModifiers cuando un talento/passive/hero talent cambie la FUNCIÓN defensiva efectiva de una habilidad.

Ejemplos conceptuales:
- un talento añade mitigation real a una habilidad que base era utility;
- un talento añade auto-propagación a un aliado;
- un talento cambia el tipo de mecanismo;
- un talento cambia aplicabilidad;
- un talento convierte una habilidad híbrida en una herramienta defensiva real.

Cada semanticModifier debe contener TODAS estas claves:

modifierSpellId
modifierName
specs
condition
setUsageRole
setDefensiveIntent
setOpportunityMode
setPrimaryBeneficiary
setSecondaryPropagation
addMechanisms
removeMechanisms
applicabilityPatch
source
confidence
notes

condition:
talent_selected
hero_talent_selected
passive_selected
runtime_state
other

Los campos set* pueden ser null si no cambian.

addMechanisms/removeMechanisms pueden ser [].

applicabilityPatch puede ser null o:
{
  "schoolScope": value|null,
  "schools": [],
  "deliveryScopes": [],
  "requiresDodgeable": boolean|null,
  "requiresParryable": boolean|null,
  "requiresBlockable": boolean|null,
  "requiresSourceAffectedBySpell": boolean|null,
  "timingRelation": value|null
}

Ejemplo conceptual:
Mirror Image base puede seguir siendo utility, pero un talento como Refractive Images puede añadir mitigation y cambiar su semántica efectiva.

NO sobreclasifiques el spell base por la existencia de un talento opcional.

======================================================================
16. replacementRules
======================================================================

Toda sustitución/supresión/conversión debe ser machine-readable.

NO la dejes solo en notes.

Cada regla:

triggerSpellId
triggerName
specs
action
targetSpellId
replacementSpellId
condition
source
confidence
notes

action:
replace
suppress
convert_to_passive

condition:
talent_selected
hero_talent_selected
passive_selected
other

Ejemplo conceptual:
si Ice Cold reemplaza Ice Block, el kit efectivo NO puede contener ambos simultáneamente.

======================================================================
17. activationMode Y CONVERSIONES PASIVAS
======================================================================

activationMode:
active
passive

active:
existe un botón deliberadamente activable en la configuración base.

passive:
no existe decisión de pulsación.

passiveConversionSpellIds:
talentos que convierten/eliminan la versión activa.

Si existe conversión:
- conserva la semántica base de la habilidad activa;
- documenta el conversor;
- añade replacementRule/convert_to_passive cuando corresponda.

======================================================================
18. COMPATIBILIDAD LEGACY: category / targetingMode / survivalType
======================================================================

Estos tres campos se mantienen TEMPORALMENTE para compatibilidad con IRIS legacy.

NO son la fuente de verdad del nuevo KPI.

Ningún consumer nuevo podrá decidir Response usando exclusivamente estos campos.

category:
personal_defensive
semi_defensive
external_defensive
utility

targetingMode describe BENEFICIARIO PROTECTIVO DIRECTO LEGACY, NO cast target:

self
- protección anclada al caster y no deliberadamente transferible.

both
- puede aplicarse voluntariamente a self o a otro aliado.

ally
- protección dirigida a otro aliado.

raid
- grupo/área.

unknown

IMPORTANTE:
un spell activationScope:"enemy" puede seguir teniendo targetingMode:"self" si la protección resultante es exclusivamente para el caster.

survivalType es también legacy/presentación:

mitigation
absorption
sustain
emergency
null

mechanisms[] es la fuente semántica nueva.

"emergency" puede representar históricamente:
- immunity
- lethal_prevention
- effective_health
- panic sustain

pero consumers nuevos DEBEN consultar mechanisms, no survivalType.

======================================================================
19. stillDefensive
======================================================================

Se conserva únicamente por compatibilidad.

Su significado será:

"¿Sigue siendo esta habilidad relevante para el dominio amplio de supervivencia?"

Puede ser true para:
- personal_survival
- survival_state
- hybrid_survival
- active_mitigation
- rotational_survival
- healer_throughput defensivo
- external
- raid_defensive
- passive_survival

Puede ser false para:
- utility puro
- spell eliminado
- spell que ya no aporta supervivencia.

PROHIBIDO:
usar stillDefensive como condición del KPI Response.

La pertenencia al KPI se deriva posteriormente del contrato semántico.

======================================================================
20. CONFIDENCE Y STATUS
======================================================================

NO uses una única confidence para todo.

Debes devolver:

timingConfidence:
high | medium | low

semanticConfidence:
high | medium | low

applicabilityConfidence:
high | medium | low

confidence:
high | medium | low

confidence global debe ser el PEOR de los tres anteriores, por compatibilidad.

semanticStatus:
verified
pending
rejected

verified:
semántica actual suficientemente demostrada.

pending:
existe relevancia posible pero falta evidencia o hay conflicto material.

rejected:
la habilidad conocida ya no corresponde a la realidad actual o no tiene relevancia de supervivencia.

REGLA FAIL-CLOSED:

semanticConfidence:"low"
O
semanticStatus:"pending"
O
applicabilityConfidence:"low"

=> NUNCA puede generar oportunidad defensiva negativa.

Si las fuentes discrepan:
- explica el conflicto brevemente en notes;
- reduce confidence;
- no inventes resolución.

======================================================================
21. FUENTES
======================================================================

Para CADA habilidad conocida y descubierta:

- intenta obtener al menos DOS fuentes reales, independientes y actuales;
- prioriza:
  1. Blizzard/tooltip actual;
  2. Wowhead Retail actual;
  3. Warcraft Wiki actual con historial de cambios;
  4. Icy Veins / guías técnicas de clase actuales;
  5. otras fuentes técnicas fiables.

Busca por:
NOMBRE + CLASS + RETAIL

El spellId identifica, pero NO demuestra comportamiento.

NO inventes URLs.

NO inventes una segunda fuente para cumplir el requisito.

Si tras investigación exhaustiva solo existe una fuente suficientemente fiable para una propiedad material:
- conserva la fuente real;
- baja confidence;
- semanticStatus:"pending" si afecta pertenencia/aplicabilidad para penalizar.

No uses:
- snippets viejos;
- páginas Classic;
- páginas de expansiones anteriores;
- builds distintos
como evidencia vigente.

Cada objeto debe incluir:

sources: string[]

evidence:
{
  "timingSources": string[],
  "semanticSources": string[],
  "applicabilitySources": string[]
}

Las mismas URLs pueden aparecer en varios subgrupos si realmente sostienen esos claims.

======================================================================
22. REGLAS DE EXCLUSIÓN IMPORTANTES
======================================================================

NO personal_survival por el mero hecho de:

- curar;
- dar armor;
- aumentar una stat;
- dar leech;
- reducir threat;
- aportar movilidad;
- ser casteable sobre self;
- dar dodge pasivamente;
- producir un pequeño rider defensivo;
- beneficiar al caster dentro de un raid CD;
- curar al caster como consecuencia de una habilidad ofensiva.

Ejemplos conceptuales:

Riptide:
puede self-castearse, pero puede elegir aliado
=> healer_throughput

Word of Glory:
si puede elegirse libremente un aliado
=> healer_throughput, no personal_survival

Death Strike:
cura al DK pero se usa contra enemigo como parte de rotación
=> rotational_survival

Blessed Hammer:
si es rotacional con rider defensivo
=> active_mitigation o rotational_survival según investigación

Shield of the Righteous:
mantenimiento de tank
=> active_mitigation

Bear Form:
survival_state
=> credit_only

Guardian Spirit:
ally selectable
=> external

Spirit Link:
raid/group
=> raid_defensive

Anti-Magic Shell con copia automática:
si la decisión primaria sigue anclada al caster y el aliado NO es seleccionable
=> personal_survival

Fiery Brand:
si reduce de forma estratégica el daño que un enemigo hace al caster
=> puede ser personal_survival aunque activationScope sea enemy

======================================================================
23. REGLAS DE OPORTUNIDAD NEGATIVA
======================================================================

La clasificación del catálogo NO determina por sí sola un miss.

Solo define si una habilidad PODRÍA participar.

Para que downstream pueda crear missed_ready serán necesarios además:
- semanticStatus verified;
- semanticConfidence suficiente;
- usageRole personal_survival;
- opportunityMode normal;
- ability presente en el build;
- applicability demostrada;
- cooldown/charges realmente disponibles;
- episodio evaluable;
- ausencia de reserva/uso previo legítimo;
- confidence suficiente.

Por tanto NO intentes codificar en el catálogo:
"el jugador debería usar X en todas las ventanas".

El catálogo solo dice:
"X es una herramienta personal válida y estas son sus restricciones".

======================================================================
24. INVARIANTES OBLIGATORIOS
======================================================================

Antes de responder verifica TODOS:

- reviewedDefensives tiene exactamente un objeto por cada spellId de knownDefensives.
- no hay spellId duplicados dentro de reviewedDefensives.
- missingDefensives no repite un spellId ya conocido.
- usageRole survival_state => opportunityMode credit_only.
- usageRole hybrid_survival => opportunityMode credit_only.
- usageRole active_mitigation => opportunityMode none.
- usageRole rotational_survival => opportunityMode none.
- usageRole healer_throughput => opportunityMode none.
- usageRole external => opportunityMode none.
- usageRole raid_defensive => opportunityMode none.
- usageRole passive_survival => activationMode passive AND opportunityMode none.
- usageRole utility => opportunityMode none.
- usageRole unknown => semanticStatus pending AND opportunityMode none.
- opportunityMode normal => usageRole personal_survival AND activationMode active AND semanticStatus verified.
- personal_survival => primaryBeneficiary self.
- personal_survival NO exige activationScope self.
- secondaryPropagation != none NO modifica por sí sola primaryBeneficiary.
- ally-selectable voluntario NO puede ser personal_survival.
- mechanisms vacío + personal_survival => inválido.
- mechanisms vacío + survival_state => inválido.
- semanticConfidence low => semanticStatus pending.
- semanticStatus pending => opportunityMode none.
- passive => nunca opportunityMode normal.
- active_mitigation => nunca cuenta como defensive personal estratégico.
- healer throughput => nunca cuenta como defensive personal aunque se self-castee.
- mobility no es avoidance.
- CC immunity sin protección relevante de daño no es immunity defensiva.
- specProfiles solo contiene overrides de timing reales.
- specSemanticProfiles solo contiene overrides semánticos reales.
- semantic changes por talento NO se guardan únicamente en notes.
- replacements NO se guardan únicamente en notes.
- no existen dos abilities efectivas simultáneas cuando una replacementRule demuestra que una reemplaza a la otra.
- baseCooldownSeconds nunca contiene un cooldown ya modificado por talento.
- baseDurationSeconds nunca contiene una duración ya modificada por talento.
- baseCharges nunca contiene cargas añadidas por talento.
- URLs de sources son reales, no inventadas.

Si detectas una contradicción que no puedes resolver:
NO fuerces el objeto para cumplir invariantes.
Marca semanticStatus pending, opportunityMode none y explica brevemente en notes.

======================================================================
25. OUTPUT
======================================================================

Responde ÚNICAMENTE con JSON válido.

No añadas:
- explicación antes;
- explicación después;
- markdown salvo un único bloque \`\`\`json si tu interfaz lo exige;
- tooltips largos.

Usa JSON compacto.

Objeto raíz EXACTO:

{
  "promptVersion": 10,
  "gameBuild": "${gameBuild}",
  "class": "${className}",
  "reviewedDefensives": [],
  "missingDefensives": [],
  "validation": {
    "knownInputCount": 0,
    "reviewedCount": 0,
    "missingCount": 0,
    "verifiedCount": 0,
    "pendingCount": 0,
    "rejectedCount": 0,
    "contractViolations": []
  }
}

======================================================================
26. SCHEMA EXACTO DE CADA ABILITY
======================================================================

Cada objeto de reviewedDefensives y missingDefensives DEBE contener TODAS estas claves:

{
  "spellId": number,
  "name": "string",
  "class": "string",

  "stillDefensive": boolean,
  "semanticStatus": "verified" | "pending" | "rejected",

  "availableSpecs": ["string"],

  "category": "personal_defensive" | "semi_defensive" | "external_defensive" | "utility",
  "targetingMode": "self" | "ally" | "both" | "raid" | "unknown",

  "activationMode": "active" | "passive",
  "passiveConversionSpellIds": [number],

  "survivalType": "mitigation" | "absorption" | "sustain" | "emergency" | null,

  "usageRole":
    "personal_survival"
    | "survival_state"
    | "hybrid_survival"
    | "active_mitigation"
    | "rotational_survival"
    | "healer_throughput"
    | "external"
    | "raid_defensive"
    | "passive_survival"
    | "utility"
    | "unknown",

  "defensiveIntent": "primary" | "hybrid" | "incidental" | "none" | "unknown",

  "activationScope": "self" | "ally_selectable" | "enemy" | "ground" | "raid" | "none" | "unknown",

  "primaryBeneficiary":
    "self"
    | "self_or_ally_selectable"
    | "ally_selectable"
    | "party"
    | "raid"
    | "none"
    | "unknown",

  "secondaryPropagation":
    "none"
    | "automatic_ally"
    | "automatic_party"
    | "automatic_raid",

  "mechanisms": [
    "mitigation"
    | "absorption"
    | "sustain"
    | "immunity"
    | "avoidance"
    | "effective_health"
    | "lethal_prevention"
  ],

  "opportunityMode": "normal" | "credit_only" | "none",

  "applicability": {
    "schoolScope": "all" | "physical" | "magic" | "specific" | "none" | "unknown",
    "schools": [
      "Physical"
      | "Holy"
      | "Fire"
      | "Nature"
      | "Frost"
      | "Shadow"
      | "Arcane"
      | "Chaos"
    ],
    "deliveryScopes": [
      "all"
      | "aoe"
      | "single_target"
      | "melee"
      | "ranged"
      | "spell"
      | "direct"
      | "periodic"
      | "environmental"
    ],
    "requiresDodgeable": boolean | null,
    "requiresParryable": boolean | null,
    "requiresBlockable": boolean | null,
    "requiresSourceAffectedBySpell": boolean | null,
    "timingRelation": "before_or_during" | "after_damage" | "either" | "continuous_state" | "unknown",
    "notes": "string"
  },

  "baseCooldownSeconds": number | null,
  "baseDurationSeconds": number | null,
  "baseCharges": number | null,
  "baseRechargeSeconds": number | null,

  "specProfiles": [
    {
      "spec": "string",
      "baseCooldownSeconds": number | null,
      "baseDurationSeconds": number | null,
      "baseCharges": number | null,
      "baseRechargeSeconds": number | null,
      "source": "string"
    }
  ],

  "specSemanticProfiles": [
    {
      "spec": "string",
      "usageRole":
        "personal_survival"
        | "survival_state"
        | "hybrid_survival"
        | "active_mitigation"
        | "rotational_survival"
        | "healer_throughput"
        | "external"
        | "raid_defensive"
        | "passive_survival"
        | "utility"
        | "unknown",
      "defensiveIntent": "primary" | "hybrid" | "incidental" | "none" | "unknown",
      "activationScope": "self" | "ally_selectable" | "enemy" | "ground" | "raid" | "none" | "unknown",
      "primaryBeneficiary":
        "self"
        | "self_or_ally_selectable"
        | "ally_selectable"
        | "party"
        | "raid"
        | "none"
        | "unknown",
      "secondaryPropagation":
        "none"
        | "automatic_ally"
        | "automatic_party"
        | "automatic_raid",
      "mechanisms": [
        "mitigation"
        | "absorption"
        | "sustain"
        | "immunity"
        | "avoidance"
        | "effective_health"
        | "lethal_prevention"
      ],
      "opportunityMode": "normal" | "credit_only" | "none",
      "applicability": {
        "schoolScope": "all" | "physical" | "magic" | "specific" | "none" | "unknown",
        "schools": [
          "Physical"
          | "Holy"
          | "Fire"
          | "Nature"
          | "Frost"
          | "Shadow"
          | "Arcane"
          | "Chaos"
        ],
        "deliveryScopes": [
          "all"
          | "aoe"
          | "single_target"
          | "melee"
          | "ranged"
          | "spell"
          | "direct"
          | "periodic"
          | "environmental"
        ],
        "requiresDodgeable": boolean | null,
        "requiresParryable": boolean | null,
        "requiresBlockable": boolean | null,
        "requiresSourceAffectedBySpell": boolean | null,
        "timingRelation": "before_or_during" | "after_damage" | "either" | "continuous_state" | "unknown",
        "notes": "string"
      },
      "source": "string",
      "confidence": "high" | "medium" | "low"
    }
  ],

  "timingModifiers": [
    {
      "modifierSpellId": number,
      "modifierName": "string",
      "targetSpellId": number,
      "specs": ["string"] | null,
      "effectField": "cooldown_ms" | "duration_ms" | "charges" | "recharge_ms",
      "operation": "subtract_seconds" | "add_seconds" | "multiply" | "set_seconds" | "charges_add",
      "value": number,
      "perRank": boolean,
      "condition": "always" | "conditional",
      "description": "string",
      "source": "string",
      "confidence": "high" | "medium" | "low"
    }
  ],

  "semanticModifiers": [
    {
      "modifierSpellId": number,
      "modifierName": "string",
      "specs": ["string"] | null,
      "condition": "talent_selected" | "hero_talent_selected" | "passive_selected" | "runtime_state" | "other",

      "setUsageRole":
        "personal_survival"
        | "survival_state"
        | "hybrid_survival"
        | "active_mitigation"
        | "rotational_survival"
        | "healer_throughput"
        | "external"
        | "raid_defensive"
        | "passive_survival"
        | "utility"
        | "unknown"
        | null,

      "setDefensiveIntent": "primary" | "hybrid" | "incidental" | "none" | "unknown" | null,
      "setOpportunityMode": "normal" | "credit_only" | "none" | null,

      "setPrimaryBeneficiary":
        "self"
        | "self_or_ally_selectable"
        | "ally_selectable"
        | "party"
        | "raid"
        | "none"
        | "unknown"
        | null,

      "setSecondaryPropagation":
        "none"
        | "automatic_ally"
        | "automatic_party"
        | "automatic_raid"
        | null,

      "addMechanisms": [
        "mitigation"
        | "absorption"
        | "sustain"
        | "immunity"
        | "avoidance"
        | "effective_health"
        | "lethal_prevention"
      ],

      "removeMechanisms": [
        "mitigation"
        | "absorption"
        | "sustain"
        | "immunity"
        | "avoidance"
        | "effective_health"
        | "lethal_prevention"
      ],

      "applicabilityPatch": {
        "schoolScope": "all" | "physical" | "magic" | "specific" | "none" | "unknown" | null,
        "schools": [
          "Physical"
          | "Holy"
          | "Fire"
          | "Nature"
          | "Frost"
          | "Shadow"
          | "Arcane"
          | "Chaos"
        ],
        "deliveryScopes": [
          "all"
          | "aoe"
          | "single_target"
          | "melee"
          | "ranged"
          | "spell"
          | "direct"
          | "periodic"
          | "environmental"
        ],
        "requiresDodgeable": boolean | null,
        "requiresParryable": boolean | null,
        "requiresBlockable": boolean | null,
        "requiresSourceAffectedBySpell": boolean | null,
        "timingRelation": "before_or_during" | "after_damage" | "either" | "continuous_state" | "unknown" | null
      } | null,

      "source": "string",
      "confidence": "high" | "medium" | "low",
      "notes": "string"
    }
  ],

  "replacementRules": [
    {
      "triggerSpellId": number,
      "triggerName": "string",
      "specs": ["string"] | null,
      "action": "replace" | "suppress" | "convert_to_passive",
      "targetSpellId": number,
      "replacementSpellId": number | null,
      "condition": "talent_selected" | "hero_talent_selected" | "passive_selected" | "other",
      "source": "string",
      "confidence": "high" | "medium" | "low",
      "notes": "string"
    }
  ],

  "timingConfidence": "high" | "medium" | "low",
  "semanticConfidence": "high" | "medium" | "low",
  "applicabilityConfidence": "high" | "medium" | "low",
  "confidence": "high" | "medium" | "low",

  "sources": ["string"],

  "evidence": {
    "timingSources": ["string"],
    "semanticSources": ["string"],
    "applicabilitySources": ["string"]
  },

  "notes": "explicación breve, factual y concreta"
}

======================================================================
27. REGLAS PARA missingDefensives
======================================================================

missingDefensives utiliza EXACTAMENTE el mismo schema.

Además:

- debe tener stillDefensive:true;
- no debe repetir knownDefensives;
- debes haber verificado que realmente existe hoy;
- si la semántica es insuficiente, puede entrar como:
  semanticStatus:"pending"
  opportunityMode:"none"

Es preferible descubrir una habilidad como pending a ignorarla completamente.

NO conviertas una habilidad en personal_survival solo para justificar que aparezca en missingDefensives.

======================================================================
28. VALIDATION ROOT
======================================================================

validation.knownInputCount = número de spellIds recibidos.

validation.reviewedCount DEBE ser idéntico.

validation.verifiedCount / pendingCount / rejectedCount deben cuadrar con reviewedDefensives + missingDefensives.

validation.contractViolations DEBE ser [].

Si no puedes producir un JSON que cumpla el contrato:
NO inventes datos para vaciar contractViolations.
Incluye la violación concreta y marca las filas implicadas pending.

======================================================================
29. CRITERIO FINAL DE SEGURIDAD
======================================================================

Recuerda el propósito:

Una clasificación falsa puede provocar que IRIS diga a un jugador:

"Tenías este defensivo disponible y no lo usaste."

Eso SOLO será aceptable si downstream puede demostrar posteriormente:
- que esa habilidad pertenecía realmente a su build;
- que era personal_survival;
- que opportunityMode era normal;
- que su efecto era aplicable a esa mecánica;
- que estaba disponible;
- que no estaba legítimamente gastada/reservada;
- y que existe evidencia suficiente.

TU TRABAJO AQUÍ NO ES DECIDIR QUE EL JUGADOR FALLÓ.

TU TRABAJO ES CREAR UN CATÁLOGO CANÓNICO LO SUFICIENTEMENTE PRECISO PARA QUE ESA DECISIÓN PUEDA TOMARSE DE FORMA SEGURA MÁS ADELANTE.

Si no puedes demostrar una propiedad:
unknown / pending / low.

LA PRIORIDAD ES:
VERACIDAD > COBERTURA > CONFIDENCE APARENTE.

======================================================================
30. INPUT
======================================================================

ALCANCE:
${className}

knownDefensives:
${knownDefensivesJson}

Audita TODOS los conocidos y después realiza la fase de descubrimiento independiente para TODAS las specs actuales de ${className}.

Devuelve exclusivamente el JSON promptVersion 10.`;
}

interface SpecProfileEntry {
  spec: string;
  baseCooldownSeconds: number | null;
  baseDurationSeconds: number | null;
  charges: number;
  source: string;
}

interface ModifierEntry {
  modifierSpellId: number;
  modifierName: string;
  targetSpellId: number;
  specs: string[] | null;
  effectField: 'cooldown_ms' | 'duration_ms' | 'charges' | 'recharge_ms';
  /** Respuestas v5 ya copiadas no traían effectField; nunca se guardan como regla exacta. */
  effectFieldWasExplicit: boolean;
  operation: 'subtract_seconds' | 'add_seconds' | 'multiply' | 'set_seconds' | 'charges_add';
  value: number;
  perRank: boolean;
  condition: 'always' | 'conditional';
  description: string;
  source: string;
}

interface SemanticModifierEntry {
  modifierSpellId: number;
  modifierName?: string;
  specs?: string[] | null;
  condition: string;
  setUsageRole?: string | null;
  setDefensiveIntent?: string | null;
  setOpportunityMode?: string | null;
  setPrimaryBeneficiary?: string | null;
  setSecondaryPropagation?: string | null;
  addMechanisms?: string[];
  removeMechanisms?: string[];
  applicabilityPatch?: unknown;
  source?: string;
  confidence?: 'high' | 'medium' | 'low';
  notes?: string;
}

interface ReplacementRuleEntry {
  triggerSpellId: number;
  triggerName?: string;
  specs?: string[] | null;
  action: 'replace' | 'suppress' | 'convert_to_passive';
  targetSpellId: number;
  replacementSpellId?: number | null;
  condition?: string;
  source?: string;
  confidence?: 'high' | 'medium' | 'low';
  notes?: string;
}

interface ClassificationEntry {
  spellId: number;
  stillDefensive?: boolean;
  availableSpecs?: string[];
  category?: string;
  targetingMode?: string;
  activationMode?: string;
  passiveConversionSpellIds?: number[];
  survivalType: string | null;
  // Contrato semántico v10 — ver validateSemanticEntry.
  semanticStatus?: string;
  usageRole?: string;
  activationScope?: string;
  primaryBeneficiary?: string;
  secondaryPropagation?: string;
  mechanisms?: string[];
  opportunityMode?: string;
  defensiveIntent?: string;
  applicability?: unknown;
  applicabilityConfidence?: string;
  specSemanticProfiles?: unknown[];
  semanticModifiers?: SemanticModifierEntry[];
  replacementRules?: ReplacementRuleEntry[];
  timingConfidence?: string;
  semanticConfidence?: string;
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
  notes: string;
  baseCooldownSeconds: number | null;
  baseDurationSeconds: number | null;
  specProfiles?: SpecProfileEntry[];
  modifiers?: ModifierEntry[];
}

interface MissingDefensiveEntry extends ClassificationEntry {
  name: string;
  class: string;
}

interface CatalogRow {
  id: string;
  spell_id: number;
  name: string;
  class: string;
  spec: string | null;
  spec_override: string[] | null;
  category: string;
  targeting_mode: string;
  activation_mode: string;
  passive_conversion_spell_ids: number[];
  activation_game_build: string;
  survival_type: string | null;
  inferred_survival_type: string | null;
  base_cooldown_ms: number | null;
  base_duration_ms: number | null;
}

function secondsToMs(value: number | null | undefined): number | null {
  return value == null ? null : Math.round(value * 1000);
}

function validNullableNonNegative(value: unknown): boolean {
  return value == null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function normalizeSpecs(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const specs = [...new Set(value.filter((spec): spec is string => typeof spec === 'string').map((spec) => spec.trim()).filter(Boolean))];
  return specs.length ? specs : null;
}

function normalizeSpellIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((spellId) => typeof spellId !== 'number' || !Number.isInteger(spellId) || spellId <= 0)) return null;
  return [...new Set(value)].sort((left, right) => left - right);
}

function specsToCatalogValue(specs: string[] | null, fallback: string | null): string | null {
  if (!specs?.length) return fallback;
  return specs.join('/');
}

function parseResponse(parsed: unknown): { reviewed: unknown[]; missing: unknown[]; gameBuild: string | null; promptVersion: number | null } | null {
  // Backward compatibility with a v3/v4 answer that may already be copied in
  // a browser while this deploy happens. Legacy entries do NOT reconcile the
  // new profile/modifier tables unless those arrays are actually present.
  if (Array.isArray(parsed)) return { reviewed: parsed, missing: [], gameBuild: null, promptVersion: null };
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { promptVersion?: unknown; gameBuild?: unknown; reviewedDefensives?: unknown; missingDefensives?: unknown };
  if (!Array.isArray(obj.reviewedDefensives) || !Array.isArray(obj.missingDefensives)) return null;
  return {
    reviewed: obj.reviewedDefensives,
    missing: obj.missingDefensives,
    gameBuild: typeof obj.gameBuild === 'string' && obj.gameBuild.trim() ? obj.gameBuild.trim() : null,
    promptVersion: typeof obj.promptVersion === 'number' && Number.isInteger(obj.promptVersion) ? obj.promptVersion : null,
  };
}

function jsonPayload(raw: string): string {
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function validateProfiles(entry: Partial<ClassificationEntry>): { rows: SpecProfileEntry[]; error?: string } {
  const raw = Array.isArray(entry.specProfiles) ? entry.specProfiles : [];
  const rows: SpecProfileEntry[] = [];
  for (const profile of raw) {
    if (!profile || typeof profile.spec !== 'string' || !profile.spec.trim()) return { rows: [], error: 'specProfiles contiene una spec inválida' };
    if (!validNullableNonNegative(profile.baseCooldownSeconds) || !validNullableNonNegative(profile.baseDurationSeconds)) {
      return { rows: [], error: 'specProfiles contiene cooldown/duración inválidos' };
    }
    if (typeof profile.charges !== 'number' || !Number.isInteger(profile.charges) || profile.charges <= 0) {
      return { rows: [], error: 'specProfiles contiene charges inválidas' };
    }
    rows.push({
      spec: profile.spec.trim(),
      baseCooldownSeconds: profile.baseCooldownSeconds ?? null,
      baseDurationSeconds: profile.baseDurationSeconds ?? null,
      charges: profile.charges,
      source: typeof profile.source === 'string' ? profile.source : '',
    });
  }
  return { rows };
}

function validateModifiers(
  entry: Partial<ClassificationEntry>,
  spellId: number,
  requireExplicitEffectField: boolean,
): { rows: ModifierEntry[]; error?: string } {
  const raw = Array.isArray(entry.modifiers) ? entry.modifiers : [];
  const rows: ModifierEntry[] = [];
  for (const modifier of raw) {
    if (!modifier || typeof modifier.modifierSpellId !== 'number' || !Number.isInteger(modifier.modifierSpellId) || modifier.modifierSpellId <= 0) {
      return { rows: [], error: 'modifiers contiene modifierSpellId inválido' };
    }
    if (modifier.targetSpellId !== spellId) return { rows: [], error: 'modifier targetSpellId no coincide con el defensivo' };
    if (!MODIFIER_OPERATIONS.has(modifier.operation)) return { rows: [], error: `operation inválida: ${modifier.operation}` };
    if (!MODIFIER_CONDITIONS.has(modifier.condition)) return { rows: [], error: `condition inválida: ${modifier.condition}` };
    const effectFieldWasExplicit = typeof modifier.effectField === 'string' && MODIFIER_EFFECT_FIELDS.has(modifier.effectField);
    if (requireExplicitEffectField && !effectFieldWasExplicit) {
      return { rows: [], error: `effectField es obligatorio en respuestas v${PROMPT_VERSION} versionadas` };
    }
    const effectField = effectFieldWasExplicit
      ? modifier.effectField as ModifierEntry['effectField']
      : modifier.operation === 'charges_add'
        ? 'charges'
        : 'cooldown_ms';
    if (modifier.effectField != null && !effectFieldWasExplicit) return { rows: [], error: `effectField inválido: ${modifier.effectField}` };
    if ((modifier.operation === 'charges_add') !== (effectField === 'charges')) {
      return { rows: [], error: `operation ${modifier.operation} incompatible con effectField ${effectField}` };
    }
    if (typeof modifier.value !== 'number' || !Number.isFinite(modifier.value) || modifier.value < 0) return { rows: [], error: 'modifier value inválido' };
    if (typeof modifier.perRank !== 'boolean') return { rows: [], error: 'modifier perRank inválido' };
    const specs = modifier.specs == null ? null : normalizeSpecs(modifier.specs);
    if (modifier.specs != null && !specs) return { rows: [], error: 'modifier specs inválido' };
    rows.push({
      modifierSpellId: modifier.modifierSpellId,
      modifierName: typeof modifier.modifierName === 'string' ? modifier.modifierName : `#${modifier.modifierSpellId}`,
      targetSpellId: spellId,
      specs,
      effectField,
      effectFieldWasExplicit,
      operation: modifier.operation,
      value: modifier.value,
      perRank: modifier.perRank,
      condition: modifier.condition,
      description: typeof modifier.description === 'string' ? modifier.description : '',
      source: typeof modifier.source === 'string' ? modifier.source : '',
    });
  }
  return { rows };
}

interface SemanticEntryResult {
  input: DefensiveSemanticInput | null;
  semanticStatus: 'verified' | 'pending' | 'rejected';
  defensiveIntent: string | null;
  applicability: unknown;
  applicabilityConfidence: string | null;
  specSemanticProfiles: unknown[];
  error?: string;
}

/**
 * Contrato semántico nuevo (iris-defensive-canonicalization-v1-plan.md §22,
 * prompt v10 §3-§10): los seis campos centrales (usageRole/activationScope/
 * primaryBeneficiary/secondaryPropagation/mechanisms/opportunityMode) viajan
 * juntos o no viajan — no se acepta un contrato a medias. Una respuesta
 * v8/v9 legacy (sin ninguno de los seis) es válida y simplemente deja la
 * fila de defensive_ability_semantics en pending, tal como nace por el
 * trigger de la migración de Paso A-1: NUNCA se infiere la semántica nueva a
 * partir de category/survivalType — es exactamente la ambigüedad que esta
 * migración existe para cerrar.
 *
 * defensiveIntent/applicability/applicabilityConfidence/specSemanticProfiles
 * (§9/§10/§13 del prompt v10) son informativos — se guardan tal cual (jsonb)
 * pero no participan todavía en ningún predicado de membership (eso es
 * trabajo de Paso C, aplicabilidad daño↔defensivo).
 */
function validateSemanticEntry(entry: Partial<ClassificationEntry>, requireExplicit: boolean): SemanticEntryResult {
  const empty = {
    semanticStatus: 'pending' as const,
    defensiveIntent: null,
    applicability: null,
    applicabilityConfidence: null,
    specSemanticProfiles: [],
  };
  const provided = [
    entry.usageRole,
    entry.activationScope,
    entry.primaryBeneficiary,
    entry.secondaryPropagation,
    entry.mechanisms,
    entry.opportunityMode,
  ];
  const anyProvided = provided.some((value) => value != null);
  if (!anyProvided) {
    if (requireExplicit) {
      return {
        input: null,
        ...empty,
        error: `usageRole/activationScope/primaryBeneficiary/secondaryPropagation/mechanisms/opportunityMode son obligatorios en respuestas v${PROMPT_VERSION}`,
      };
    }
    return { input: null, ...empty };
  }
  if (
    typeof entry.usageRole !== 'string' ||
    typeof entry.activationScope !== 'string' ||
    typeof entry.primaryBeneficiary !== 'string' ||
    typeof entry.secondaryPropagation !== 'string' ||
    !Array.isArray(entry.mechanisms) ||
    typeof entry.opportunityMode !== 'string'
  ) {
    return {
      input: null,
      ...empty,
      error: 'contrato semántico incompleto: usageRole/activationScope/primaryBeneficiary/secondaryPropagation/mechanisms/opportunityMode deben venir todos juntos',
    };
  }
  if (entry.mechanisms.some((mechanism) => typeof mechanism !== 'string')) {
    return { input: null, ...empty, error: 'mechanisms debe ser un array de strings' };
  }
  const input: DefensiveSemanticInput = {
    usageRole: entry.usageRole,
    activationScope: entry.activationScope,
    primaryBeneficiary: entry.primaryBeneficiary,
    secondaryPropagation: entry.secondaryPropagation,
    mechanisms: [...new Set(entry.mechanisms as string[])],
    opportunityMode: entry.opportunityMode,
  };
  const contractError = defensiveSemanticError(input);
  if (contractError) return { input: null, ...empty, error: contractError };

  // semanticStatus es first-class en v10 (regla fail-closed del propio
  // prompt): la IA puede pedir explícitamente pending/rejected incluso
  // cuando el resto del contrato es sintácticamente válido. v8/v9 no traían
  // este campo — ausente equivale a 'verified' (comportamiento previo).
  let semanticStatus: 'verified' | 'pending' | 'rejected' = 'verified';
  if (entry.semanticStatus != null) {
    if (typeof entry.semanticStatus !== 'string' || !SEMANTIC_STATUS_SET.has(entry.semanticStatus)) {
      return { input: null, ...empty, error: `semanticStatus inválido: ${entry.semanticStatus}` };
    }
    semanticStatus = entry.semanticStatus as 'verified' | 'pending' | 'rejected';
  }
  const defensiveIntent = typeof entry.defensiveIntent === 'string' ? entry.defensiveIntent : null;
  const applicability = entry.applicability != null && typeof entry.applicability === 'object' ? entry.applicability : null;
  const applicabilityConfidence = typeof entry.applicabilityConfidence === 'string' ? entry.applicabilityConfidence : null;
  const specSemanticProfiles = Array.isArray(entry.specSemanticProfiles) ? entry.specSemanticProfiles : [];

  return { input, semanticStatus, defensiveIntent, applicability, applicabilityConfidence, specSemanticProfiles };
}

/**
 * semanticModifiers/replacementRules (prompt v10 §15/§16) se validan de
 * forma laxa a propósito: son enriquecimiento, no la condición de membership
 * (esa ya se validó arriba). Un objeto individual mal formado se descarta en
 * silencio en vez de invalidar la clasificación completa de la habilidad —
 * distinto del resto de validators de este fichero, que sí abortan la fila
 * entera; aquí el coste de perder un modifier es mucho menor que el de
 * bloquear una clasificación semántica correcta por un campo secundario.
 */
function collectSemanticRuleWrites(entry: Partial<ClassificationEntry>, ownSpellId: number, gameBuild: string) {
  const writes: {
    modifier_spell_id: number;
    target_spell_id: number;
    specs: string[];
    game_build: string;
    rule_type: 'augment' | 'replace' | 'suppress' | 'convert_to_passive';
    payload: Record<string, unknown>;
    source: string;
    verified: boolean;
  }[] = [];

  for (const raw of Array.isArray(entry.semanticModifiers) ? entry.semanticModifiers : []) {
    const modifier = raw as Partial<SemanticModifierEntry>;
    if (typeof modifier?.modifierSpellId !== 'number' || !Number.isInteger(modifier.modifierSpellId) || modifier.modifierSpellId <= 0) continue;
    if (typeof modifier.condition !== 'string' || !modifier.condition.trim()) continue;
    writes.push({
      modifier_spell_id: modifier.modifierSpellId,
      target_spell_id: ownSpellId,
      specs: Array.isArray(modifier.specs) ? modifier.specs.filter((spec): spec is string => typeof spec === 'string') : [],
      game_build: gameBuild,
      rule_type: 'augment',
      payload: {
        modifierName: modifier.modifierName ?? null,
        condition: modifier.condition,
        setUsageRole: modifier.setUsageRole ?? null,
        setDefensiveIntent: modifier.setDefensiveIntent ?? null,
        setOpportunityMode: modifier.setOpportunityMode ?? null,
        setPrimaryBeneficiary: modifier.setPrimaryBeneficiary ?? null,
        setSecondaryPropagation: modifier.setSecondaryPropagation ?? null,
        addMechanisms: Array.isArray(modifier.addMechanisms) ? modifier.addMechanisms : [],
        removeMechanisms: Array.isArray(modifier.removeMechanisms) ? modifier.removeMechanisms : [],
        applicabilityPatch: modifier.applicabilityPatch ?? null,
        notes: modifier.notes ?? '',
      },
      source: typeof modifier.source === 'string' ? modifier.source : '',
      verified: modifier.confidence === 'high',
    });
  }

  for (const raw of Array.isArray(entry.replacementRules) ? entry.replacementRules : []) {
    const rule = raw as Partial<ReplacementRuleEntry>;
    if (typeof rule?.triggerSpellId !== 'number' || !Number.isInteger(rule.triggerSpellId) || rule.triggerSpellId <= 0) continue;
    if (typeof rule.targetSpellId !== 'number' || !Number.isInteger(rule.targetSpellId) || rule.targetSpellId <= 0) continue;
    if (rule.action !== 'replace' && rule.action !== 'suppress' && rule.action !== 'convert_to_passive') continue;
    writes.push({
      modifier_spell_id: rule.triggerSpellId,
      target_spell_id: rule.targetSpellId,
      specs: Array.isArray(rule.specs) ? rule.specs.filter((spec): spec is string => typeof spec === 'string') : [],
      game_build: gameBuild,
      rule_type: rule.action,
      payload: {
        triggerName: rule.triggerName ?? null,
        replacementSpellId: rule.replacementSpellId ?? null,
        condition: rule.condition ?? null,
        notes: rule.notes ?? '',
      },
      source: typeof rule.source === 'string' ? rule.source : '',
      verified: rule.confidence === 'high',
    });
  }

  return writes;
}

function modifierDbOperation(operation: ModifierEntry['operation']): 'subtract_ms' | 'add_ms' | 'multiply' | 'set_ms' | 'charges_add' {
  if (operation === 'subtract_seconds') return 'subtract_ms';
  if (operation === 'add_seconds') return 'add_ms';
  if (operation === 'set_seconds') return 'set_ms';
  return operation;
}

function modifierDbValue(modifier: ModifierEntry): number {
  return modifier.operation === 'subtract_seconds' || modifier.operation === 'add_seconds' || modifier.operation === 'set_seconds'
    ? Math.round(modifier.value * 1000)
    : modifier.value;
}

async function resolveCurrentGameBuild(): Promise<string> {
  try {
    const namespace = await getCurrentBuildNamespace();
    return namespace ? buildFromBlizzardNamespace(namespace) : 'legacy-current';
  } catch (err) {
    console.error('classify-defensives: no se pudo verificar el game build actual; se usará legacy-current:', err);
    return 'legacy-current';
  }
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  let body: { class?: string | null; action?: string; rawResponseText?: string; expectedGameBuild?: string | null };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.action) return jsonResponse({ ok: false, error: 'action es obligatoria' }, 400);
  if ((body.action === 'prompt' || body.action === 'submit') && !body.class?.trim()) {
    return jsonResponse(
      {
        ok: false,
        error: 'La auditoría se procesa por clase para evitar respuestas truncadas. Selecciona una clase concreta.',
      },
      400,
    );
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    let query = supabase
      .from('cooldown_catalog')
      .select('id,spell_id,name,class,spec,spec_override,category,targeting_mode,activation_mode,passive_conversion_spell_ids,activation_game_build,survival_type,inferred_survival_type,base_cooldown_ms,base_duration_ms')
      .order('class', { ascending: true })
      .order('name', { ascending: true });
    if (body.class) query = query.eq('class', body.class);
    const { data: rows, error: rowsError } = await query;
    if (rowsError) throw rowsError;
    const defensives = (rows ?? []) as CatalogRow[];

    let profileQuery = supabase.from('defensive_spec_profiles').select('*');
    let modifierQuery = supabase.from('defensive_modifier_rules').select('*').eq('active', true);
    if (body.class) {
      profileQuery = profileQuery.eq('class', body.class);
      modifierQuery = modifierQuery.eq('class', body.class);
    }
    const [{ data: currentProfiles, error: profilesError }, { data: currentModifiers, error: modifiersError }] = await Promise.all([
      profileQuery,
      modifierQuery,
    ]);
    if (profilesError) throw profilesError;
    if (modifiersError) throw modifiersError;

    if (body.action === 'prompt') {
      const gameBuild = await resolveCurrentGameBuild();
      const list = defensives.map((d) => ({
        spellId: d.spell_id,
        name: d.name,
        class: d.class,
        currentSpec: d.spec,
        manualSpecOverride: d.spec_override,
        currentCategory: d.category,
        currentTargetingMode: d.targeting_mode,
        currentActivationMode: d.activation_mode,
        currentPassiveConversionSpellIds: d.passive_conversion_spell_ids,
        currentActivationGameBuild: d.activation_game_build,
        currentSurvivalType: d.survival_type,
        currentInferredSurvivalType: d.inferred_survival_type,
        currentBaseCooldownMs: d.base_cooldown_ms,
        currentBaseDurationMs: d.base_duration_ms,
        currentSpecProfiles: (currentProfiles ?? []).filter((profile) => profile.spell_id === d.spell_id),
        currentModifiers: (currentModifiers ?? []).filter((modifier) => modifier.target_spell_id === d.spell_id),
      }));
      // body.class está garantizado no vacío por el guard de arriba (línea
      // ~1887) para action==='prompt'|'submit'. El prompt v10 es
      // autocontenido (su propia sección 30 INPUT ya embebe knownDefensives)
      // — a diferencia de v8/v9, userMessage ya no necesita repetir la lista.
      const systemPrompt = buildSystemPromptV10(body.class!, gameBuild, JSON.stringify(list));
      const userMessage = `Genera y devuelve exclusivamente el JSON promptVersion ${PROMPT_VERSION} completo, siguiendo el prompt anterior. manualSpecOverride (dentro de knownDefensives) es una corrección humana, no evidencia del juego.`;
      return jsonResponse({ ok: true, promptVersion: PROMPT_VERSION, gameBuild, systemPrompt, userMessage, defensiveCount: list.length });
    }

    if (body.action === 'submit') {
      if (!body.rawResponseText) return jsonResponse({ ok: false, error: 'rawResponseText es obligatorio para action=submit' }, 400);

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonPayload(body.rawResponseText));
      } catch {
        return jsonResponse({ ok: false, error: 'La respuesta pegada no es JSON válido. Pega JSON crudo o un único bloque ```json completo.' }, 400);
      }
      const response = parseResponse(parsed);
      if (!response) return jsonResponse({ ok: false, error: 'Se esperaba el objeto JSON {promptVersion, gameBuild, reviewedDefensives, missingDefensives} (o una respuesta legacy compatible).' }, 400);
      const researchGameBuild = response.gameBuild ?? 'legacy-current';
      if (researchGameBuild !== 'legacy-current' && !/^\d+\.\d+\.\d+\.\d+$/.test(researchGameBuild)) {
        return jsonResponse({ ok: false, error: `gameBuild inválido: ${researchGameBuild}` }, 400);
      }
      if (response.gameBuild && body.expectedGameBuild !== response.gameBuild) {
        return jsonResponse(
          {
            ok: false,
            error: `La respuesta pertenece a ${response.gameBuild}, pero el prompt abierto pertenece a ${body.expectedGameBuild ?? 'un build desconocido'}. Genera un prompt nuevo.`,
          },
          409,
        );
      }

      const knownSpellIds = new Set(defensives.map((d) => d.spell_id));
      const knownClasses = new Set(defensives.map((d) => d.class));
      if (body.class) knownClasses.add(body.class);

      const applied: {
        spellId: number;
        name: string;
        class: string;
        survivalType: string;
        category: string;
        targetingMode: string;
        confidence: 'high' | 'medium';
        sources: string[];
        notes: string;
        baseCooldownMs: number | null;
        baseDurationMs: number | null;
        materialChanged: boolean;
      }[] = [];
      const added: { spellId: number; name: string; class: string; specs: string[]; category: string; survivalType: string }[] = [];
      const skippedLowConfidence: { spellId: number; name: string; survivalType: string | null; notes: string }[] = [];
      const skippedUndetermined: { spellId: number; name: string }[] = [];
      const suggestedExclusions: { spellId: number; name: string; class: string; notes: string }[] = [];
      const invalid: { spellId: unknown; reason: string }[] = [];
      const submittedAt = new Date().toISOString();
      const affectedClasses = new Set<string>();
      let appliedSpecProfiles = 0;
      let appliedModifiers = 0;
      let appliedSemantics = 0;
      let appliedSemanticRules = 0;

      const applyReferenceRows = async (
        className: string,
        spellId: number,
        profiles: SpecProfileEntry[],
        modifiers: ModifierEntry[],
      ): Promise<void> => {
        // A v5 rerun is authoritative for the researched timing layer. It
        // replaces stale spec profiles and deactivates modifier rules that no
        // longer appear, instead of the old "only ever append" behaviour.
        const { error: deleteProfilesError } = await supabase
          .from('defensive_spec_profiles')
          .delete()
          .eq('class', className)
          .eq('spell_id', spellId)
          .eq('game_build', researchGameBuild);
        if (deleteProfilesError) throw deleteProfilesError;

        const { error: disableModifiersError } = await supabase
          .from('defensive_modifier_rules')
          .update({ active: false, updated_at: submittedAt })
          .eq('class', className)
          .eq('target_spell_id', spellId)
          .eq('game_build', researchGameBuild)
          .eq('active', true);
        if (disableModifiersError) throw disableModifiersError;

        for (const profile of profiles) {
          const { error } = await supabase.from('defensive_spec_profiles').upsert(
            {
              class: className,
              spec: profile.spec,
              spell_id: spellId,
              base_cooldown_ms: secondsToMs(profile.baseCooldownSeconds),
              base_duration_ms: secondsToMs(profile.baseDurationSeconds),
              charges: profile.charges,
              recharge_ms: null,
              game_build: researchGameBuild,
              source: profile.source || `classify-defensives v${PROMPT_VERSION}`,
              source_note: `Investigado por prompt v${PROMPT_VERSION}; valor base específico de spec.`,
              verified_at: submittedAt,
              updated_at: submittedAt,
            },
            { onConflict: 'class,spec,spell_id,game_build' },
          );
          if (error) throw error;
          appliedSpecProfiles++;
        }

        for (const modifier of modifiers) {
          const { error } = await supabase.from('defensive_modifier_rules').upsert(
            {
              class: className,
              specs: modifier.specs,
              modifier_spell_id: modifier.modifierSpellId,
              target_spell_id: spellId,
              operation: modifierDbOperation(modifier.operation),
              effect_field: modifier.effectField,
              value: modifierDbValue(modifier),
              per_rank: modifier.perRank,
              condition: modifier.condition,
              description: modifier.description || modifier.modifierName,
              source: modifier.source,
              game_build: modifier.effectFieldWasExplicit ? researchGameBuild : 'legacy-current',
              application_order: 100,
              verified_at: submittedAt,
              active: true,
              updated_at: submittedAt,
            },
            { onConflict: 'class,modifier_spell_id,target_spell_id,operation,effect_field,game_build' },
          );
          if (error) throw error;
          appliedModifiers++;
        }
      };

      // §Paso B-2 (iris-defensive-canonicalization-v1-plan.md §5/§22, prompt
      // v10 §20): semantic_status ya NO se fuerza a 'verified' — v10 tiene su
      // propia regla fail-closed y puede pedir explícitamente pending/
      // rejected aunque el resto del contrato sea sintácticamente válido
      // (ver validateSemanticEntry). 'locked' nunca se toca: una fila que un
      // officer ya bloqueó a mano no puede ser pisada por esta ruta
      // (invariante 11 del plan).
      const applySemantics = async (catalogId: string, semantic: SemanticEntryResult): Promise<void> => {
        if (!semantic.input) return;
        const { data: existing, error: existingError } = await supabase
          .from('defensive_ability_semantics')
          .select('locked')
          .eq('catalog_id', catalogId)
          .maybeSingle();
        if (existingError) throw existingError;
        if (existing?.locked) return; // edición de officer protegida — la IA no la pisa.
        const { error } = await supabase.from('defensive_ability_semantics').upsert(
          {
            catalog_id: catalogId,
            usage_role: semantic.input.usageRole,
            activation_scope: semantic.input.activationScope,
            primary_beneficiary: semantic.input.primaryBeneficiary,
            secondary_propagation: semantic.input.secondaryPropagation,
            mechanisms: semantic.input.mechanisms,
            opportunity_mode: semantic.input.opportunityMode,
            defensive_intent: semantic.defensiveIntent ?? 'unknown',
            applicability: semantic.applicability,
            applicability_confidence: semantic.applicabilityConfidence,
            spec_semantic_profiles: semantic.specSemanticProfiles,
            semantic_status: semantic.semanticStatus,
            semantic_version: 'defensive-semantics@1.0.0',
            confidence: 'inferred', // investigación IA, no verificación empírica contra combate real
            source: `classify-defensives v${PROMPT_VERSION}`,
            reviewed_at: submittedAt,
            updated_at: submittedAt,
          },
          { onConflict: 'catalog_id' },
        );
        if (error) throw error;
        appliedSemantics++;
      };

      // semanticModifiers/replacementRules → defensive_semantic_rules (misma
      // tabla que ya usa el research v5 para modifiers de timing, con
      // rule_type ampliado en la migración v10 para incluir
      // convert_to_passive). Se aplican con independencia de si la propia
      // fila terminó verified/pending/rejected: un modifier bien investigado
      // sigue siendo información real aunque la fila base necesite revisión.
      const applySemanticRules = async (ownSpellId: number, entry: Partial<ClassificationEntry>): Promise<void> => {
        const writes = collectSemanticRuleWrites(entry, ownSpellId, researchGameBuild);
        for (const write of writes) {
          const { error } = await supabase.from('defensive_semantic_rules').upsert(write, {
            onConflict: 'modifier_spell_id,target_spell_id,game_build,rule_type',
          });
          if (error) throw error;
          appliedSemanticRules++;
        }
      };

      for (const raw of response.reviewed) {
        const entry = raw as Partial<ClassificationEntry>;
        if (typeof entry.spellId !== 'number' || !knownSpellIds.has(entry.spellId)) {
          invalid.push({ spellId: entry.spellId, reason: 'spellId no reconocido entre knownDefensives' });
          continue;
        }
        const matched = defensives.find((d) => d.spell_id === entry.spellId)!;
        const name = matched.name;

        if (entry.stillDefensive === false) {
          suggestedExclusions.push({ spellId: entry.spellId, name, class: matched.class, notes: entry.notes ?? '' });
          continue;
        }
        if (!CONFIDENCES.has(entry.confidence)) {
          invalid.push({ spellId: entry.spellId, reason: `confidence inválida: ${entry.confidence}` });
          continue;
        }
        if (entry.confidence === 'low') {
          skippedLowConfidence.push({ spellId: entry.spellId, name, survivalType: entry.survivalType ?? null, notes: entry.notes ?? '' });
          continue;
        }
        if (!validNullableNonNegative(entry.baseCooldownSeconds) || !validNullableNonNegative(entry.baseDurationSeconds)) {
          invalid.push({ spellId: entry.spellId, reason: 'baseCooldownSeconds/baseDurationSeconds deben ser números >= 0 o null' });
          continue;
        }
        if (entry.category != null && !CATEGORIES.has(entry.category)) {
          invalid.push({ spellId: entry.spellId, reason: `category inválida: ${entry.category}` });
          continue;
        }
        if (response.promptVersion != null && response.promptVersion >= PROMPT_VERSION && entry.targetingMode == null) {
          invalid.push({ spellId: entry.spellId, reason: `targetingMode es obligatorio en respuestas v${PROMPT_VERSION}` });
          continue;
        }
        if (response.promptVersion != null && response.promptVersion >= PROMPT_VERSION && (entry.activationMode == null || entry.passiveConversionSpellIds == null)) {
          invalid.push({ spellId: entry.spellId, reason: `activationMode y passiveConversionSpellIds son obligatorios en respuestas v${PROMPT_VERSION}` });
          continue;
        }
        if (entry.activationMode != null && !ACTIVATION_MODES.has(entry.activationMode)) {
          invalid.push({ spellId: entry.spellId, reason: `activationMode inválido: ${entry.activationMode}` });
          continue;
        }
        const passiveConversionSpellIds = entry.passiveConversionSpellIds == null
          ? matched.passive_conversion_spell_ids
          : normalizeSpellIds(entry.passiveConversionSpellIds);
        if (passiveConversionSpellIds == null) {
          invalid.push({ spellId: entry.spellId, reason: 'passiveConversionSpellIds debe ser un array de spellId positivos' });
          continue;
        }
        const profilesResult = validateProfiles(entry);
        if (profilesResult.error) {
          invalid.push({ spellId: entry.spellId, reason: profilesResult.error });
          continue;
        }
        const modifiersResult = validateModifiers(entry, entry.spellId, response.gameBuild != null);
        if (modifiersResult.error) {
          invalid.push({ spellId: entry.spellId, reason: modifiersResult.error });
          continue;
        }
        const semanticResult = validateSemanticEntry(entry, response.promptVersion != null && response.promptVersion >= PROMPT_VERSION);
        if (semanticResult.error) {
          invalid.push({ spellId: entry.spellId, reason: semanticResult.error });
          continue;
        }
        // survivalType (legacy) es opcional aquí: si viene y es inválido pero
        // el contrato nuevo trae mechanisms, se deriva de ahí en vez de tirar
        // la fila entera (mismo criterio que en missingDefensives — ver
        // deriveLegacySurvivalType).
        if (entry.survivalType != null && !SURVIVAL_TYPES.has(entry.survivalType)) {
          const derived = semanticResult.input ? deriveLegacySurvivalType(semanticResult.input.mechanisms) : null;
          if (!derived) {
            invalid.push({ spellId: entry.spellId, reason: `survivalType inválido: ${entry.survivalType}` });
            continue;
          }
          entry.survivalType = derived;
        }

        const availableSpecs = normalizeSpecs(entry.availableSpecs);
        if (entry.availableSpecs !== undefined && !availableSpecs) {
          invalid.push({ spellId: entry.spellId, reason: 'availableSpecs debe contener al menos una spec' });
          continue;
        }
        const researchedSpec = specsToCatalogValue(availableSpecs, matched.spec);
        // Null from the AI means "could not resolve", not "erase a verified
        // number". A literal zero remains a real value and is preserved.
        const baseCooldownMs = entry.baseCooldownSeconds == null ? matched.base_cooldown_ms : secondsToMs(entry.baseCooldownSeconds);
        const baseDurationMs = entry.baseDurationSeconds == null ? matched.base_duration_ms : secondsToMs(entry.baseDurationSeconds);
        const survivalType = entry.survivalType ?? matched.survival_type;
        if (entry.survivalType == null) skippedUndetermined.push({ spellId: entry.spellId, name });
        // §Hallazgo real de uso (2026-09-03): con el contrato nuevo presente
        // y válido, category/targetingMode se DERIVAN de él en vez de
        // validar lo que la IA haya escrito ahí — decenas de filas caían por
        // targetingMode confundido con activationScope/primaryBeneficiary
        // (valores parecidos, otro enum). Ver deriveLegacyClassification.
        const legacyDerivation = semanticResult.input ? deriveLegacyClassification(semanticResult.input) : null;
        const category = legacyDerivation?.category ?? entry.category ?? matched.category;
        const activationMode = entry.activationMode ?? matched.activation_mode;
        const activationGameBuild = entry.activationMode != null || entry.passiveConversionSpellIds != null
          ? researchGameBuild
          : matched.activation_game_build;
        const targetingMode = legacyDerivation?.targetingMode ?? entry.targetingMode ?? (
          category !== matched.category
            ? category === 'personal_defensive'
              ? 'self'
              : category === 'semi_defensive'
                ? 'both'
                : 'unknown'
            : matched.targeting_mode
        );
        if (!legacyDerivation && (entry.targetingMode != null || (response.promptVersion != null && response.promptVersion >= PROMPT_VERSION))) {
          const categoryTargetingError = defensiveTargetingError(category, targetingMode);
          if (categoryTargetingError) {
            invalid.push({ spellId: entry.spellId, reason: categoryTargetingError });
            continue;
          }
        }
        const materialChanged =
          matched.spec !== researchedSpec ||
          matched.category !== category ||
          matched.targeting_mode !== targetingMode ||
          matched.activation_mode !== activationMode ||
          matched.activation_game_build !== activationGameBuild ||
          JSON.stringify(matched.passive_conversion_spell_ids) !== JSON.stringify(passiveConversionSpellIds) ||
          matched.survival_type !== survivalType ||
          matched.base_cooldown_ms !== baseCooldownMs ||
          matched.base_duration_ms !== baseDurationMs;

        const patch: Record<string, unknown> = {
          spec: researchedSpec,
          category,
          targeting_mode: targetingMode,
          activation_mode: activationMode,
          passive_conversion_spell_ids: passiveConversionSpellIds,
          activation_game_build: activationGameBuild,
          base_cooldown_ms: baseCooldownMs,
          base_duration_ms: baseDurationMs,
          ai_classification: {
            confidence: entry.confidence,
            sources: Array.isArray(entry.sources) ? entry.sources : [],
            notes: entry.notes ?? '',
            availableSpecs,
            targetingMode,
            activationMode,
            passiveConversionSpellIds,
            promptVersion: PROMPT_VERSION,
            classifiedAt: submittedAt,
          },
        };
        if (survivalType != null) {
          patch['survival_type'] = survivalType;
          patch['inferred_survival_type'] = survivalType;
        }
        if (materialChanged) patch['updated_at'] = submittedAt;

        let updateQuery = supabase.from('cooldown_catalog').update(patch).eq('spell_id', entry.spellId).eq('class', matched.class);
        if (body.class) updateQuery = updateQuery.eq('class', body.class);
        const { error } = await updateQuery;
        if (error) throw error;

        // v3 had no timing-reference arrays. Do not erase new v5 data if a
        // stale v3 prompt was already copied before deployment. v4/v5 both
        // carry these arrays, including [] when they intentionally mean none.
        const hasReferencePayload = Array.isArray(entry.specProfiles) || Array.isArray(entry.modifiers);
        if (hasReferencePayload) await applyReferenceRows(matched.class, entry.spellId, profilesResult.rows, modifiersResult.rows);
        await applySemantics(matched.id, semanticResult);
        await applySemanticRules(entry.spellId, entry);
        if (materialChanged) affectedClasses.add(matched.class);

        applied.push({
          spellId: entry.spellId,
          name,
          class: matched.class,
          survivalType: survivalType ?? 'sin clasificar',
          category,
          targetingMode,
          confidence: entry.confidence === 'high' ? 'high' : 'medium',
          sources: Array.isArray(entry.sources) ? entry.sources : [],
          notes: entry.notes ?? '',
          baseCooldownMs,
          baseDurationMs,
          materialChanged,
        });
      }

      for (const raw of response.missing) {
        const entry = raw as Partial<MissingDefensiveEntry>;
        const sources = Array.isArray(entry.sources) ? entry.sources.filter((source): source is string => typeof source === 'string' && !!source.trim()) : [];
        if (typeof entry.spellId !== 'number' || !Number.isInteger(entry.spellId) || entry.spellId <= 0) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive con spellId inválido' });
          continue;
        }
        if (knownSpellIds.has(entry.spellId)) continue;
        if (typeof entry.name !== 'string' || !entry.name.trim() || typeof entry.class !== 'string' || !entry.class.trim()) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive sin name/class válidos' });
          continue;
        }
        if (body.class && entry.class !== body.class) {
          invalid.push({ spellId: entry.spellId, reason: `missingDefensive fuera del alcance ${body.class}: ${entry.class}` });
          continue;
        }
        if (!body.class && !knownClasses.has(entry.class)) {
          invalid.push({ spellId: entry.spellId, reason: `class no reconocida en el catálogo: ${entry.class}` });
          continue;
        }
        if (entry.stillDefensive === false) continue;
        if (entry.confidence !== 'high' && entry.confidence !== 'medium') {
          skippedLowConfidence.push({ spellId: entry.spellId, name: entry.name, survivalType: entry.survivalType ?? null, notes: entry.notes ?? '' });
          continue;
        }
        // Missing rows expand the source of truth, so require the two
        // independent references promised by the prompt before auto-insert.
        if (sources.length < 2) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive necesita al menos 2 fuentes antes de añadirse automáticamente' });
          continue;
        }
        const semanticResult = validateSemanticEntry(entry, response.promptVersion != null && response.promptVersion >= PROMPT_VERSION);
        if (semanticResult.error) {
          invalid.push({ spellId: entry.spellId, reason: semanticResult.error });
          continue;
        }
        // §Hallazgo real de uso (2026-09-03): con el contrato nuevo presente
        // y válido, category/targetingMode/survivalType (legacy) se DERIVAN
        // de él en vez de exigirle a la IA que rellene bien dos vocabularios
        // redundantes — "missingDefensive necesita un survivalType válido"
        // saltaba en Evoker porque la IA usaba lethal_prevention (nuevo)
        // donde el campo legacy solo admite mitigation/absorption/sustain/
        // emergency. Ver deriveLegacyClassification/deriveLegacySurvivalType.
        const legacyDerivation = semanticResult.input ? deriveLegacyClassification(semanticResult.input) : null;
        const derivedSurvivalType = semanticResult.input ? deriveLegacySurvivalType(semanticResult.input.mechanisms) : null;
        const survivalTypeForInsert = entry.survivalType && SURVIVAL_TYPES.has(entry.survivalType) ? entry.survivalType : derivedSurvivalType;
        if (!survivalTypeForInsert) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive necesita un survivalType válido (directo o derivable de mechanisms)' });
          continue;
        }
        entry.survivalType = survivalTypeForInsert;
        if (!legacyDerivation && (!entry.category || !CATEGORIES.has(entry.category))) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive necesita una category válida' });
          continue;
        }
        const category = legacyDerivation?.category ?? entry.category!;
        const targetingMode = legacyDerivation?.targetingMode ?? entry.targetingMode ?? (
          category === 'personal_defensive' ? 'self' : category === 'semi_defensive' ? 'both' : 'unknown'
        );
        entry.category = category;
        if (!legacyDerivation) {
          if (response.promptVersion != null && response.promptVersion >= PROMPT_VERSION && entry.targetingMode == null) {
            invalid.push({ spellId: entry.spellId, reason: `missingDefensive necesita targetingMode explícito en respuestas v${PROMPT_VERSION}` });
            continue;
          }
          if (entry.targetingMode != null || (response.promptVersion != null && response.promptVersion >= PROMPT_VERSION)) {
            const categoryTargetingError = defensiveTargetingError(category, targetingMode);
            if (categoryTargetingError) {
              invalid.push({ spellId: entry.spellId, reason: categoryTargetingError });
              continue;
            }
          }
        }
        if (!validNullableNonNegative(entry.baseCooldownSeconds) || !validNullableNonNegative(entry.baseDurationSeconds)) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive con cooldown/duración inválidos' });
          continue;
        }
        const activationMode = entry.activationMode ?? 'active';
        const passiveConversionSpellIds = entry.passiveConversionSpellIds == null ? [] : normalizeSpellIds(entry.passiveConversionSpellIds);
        if (response.promptVersion != null && response.promptVersion >= PROMPT_VERSION && (entry.activationMode == null || entry.passiveConversionSpellIds == null)) {
          invalid.push({ spellId: entry.spellId, reason: `missingDefensive necesita activationMode y passiveConversionSpellIds en respuestas v${PROMPT_VERSION}` });
          continue;
        }
        if (!ACTIVATION_MODES.has(activationMode) || passiveConversionSpellIds == null) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive tiene semántica activa/pasiva inválida' });
          continue;
        }
        const availableSpecs = normalizeSpecs(entry.availableSpecs);
        if (!availableSpecs) {
          invalid.push({ spellId: entry.spellId, reason: 'missingDefensive necesita availableSpecs explícitas' });
          continue;
        }
        const profilesResult = validateProfiles(entry);
        if (profilesResult.error) {
          invalid.push({ spellId: entry.spellId, reason: profilesResult.error });
          continue;
        }
        const modifiersResult = validateModifiers(entry, entry.spellId, response.gameBuild != null);
        if (modifiersResult.error) {
          invalid.push({ spellId: entry.spellId, reason: modifiersResult.error });
          continue;
        }
        // semanticResult/legacyDerivation ya se calcularon arriba (antes de
        // resolver survivalType/category) — no se recalculan aquí.

        const baseCooldownMs = secondsToMs(entry.baseCooldownSeconds);
        const baseDurationMs = secondsToMs(entry.baseDurationSeconds);
        const { data: insertedRow, error: insertError } = await supabase.from('cooldown_catalog').insert({
          class: entry.class,
          spec: availableSpecs.join('/'),
          spell_id: entry.spellId,
          name: entry.name.trim(),
          category: entry.category,
          targeting_mode: targetingMode,
          activation_mode: activationMode,
          passive_conversion_spell_ids: passiveConversionSpellIds,
          activation_game_build: researchGameBuild,
          survival_type: entry.survivalType,
          inferred_survival_type: entry.survivalType,
          base_cooldown_ms: baseCooldownMs,
          base_duration_ms: baseDurationMs,
          reviewed: false,
          ai_classification: {
            confidence: entry.confidence,
            sources,
            notes: entry.notes ?? '',
            availableSpecs,
            targetingMode,
            activationMode,
            passiveConversionSpellIds,
            discovered: true,
            promptVersion: PROMPT_VERSION,
            classifiedAt: submittedAt,
          },
          synced_from_commit: null,
          updated_at: submittedAt,
        }).select('id').single();
        if (insertError) throw insertError;

        await applyReferenceRows(entry.class, entry.spellId, profilesResult.rows, modifiersResult.rows);
        // trg_cooldown_catalog_semantics_pending (Paso A-1) ya creó la fila
        // pending al insertar arriba; esto solo la promueve si la IA trajo
        // el contrato completo.
        await applySemantics((insertedRow as { id: string }).id, semanticResult);
        await applySemanticRules(entry.spellId, entry);
        knownSpellIds.add(entry.spellId);
        affectedClasses.add(entry.class);
        added.push({
          spellId: entry.spellId,
          name: entry.name.trim(),
          class: entry.class,
          specs: availableSpecs,
          category: entry.category,
          survivalType: entry.survivalType,
        });
        // Keep the existing Angular result UI useful without requiring a UI
        // migration: discoveries also appear in the normal "applied" banner.
        applied.push({
          spellId: entry.spellId,
          name: entry.name.trim(),
          class: entry.class,
          survivalType: entry.survivalType,
          category: entry.category,
          targetingMode,
          confidence: entry.confidence,
          sources,
          notes: entry.notes ?? '',
          baseCooldownMs,
          baseDurationMs,
          materialChanged: true,
        });
      }

      let pullIds: string[] = [];
      let pullDiscoveryError: string | null = null;
      if (affectedClasses.size) {
        const { data: affectedRecords, error: affectedError } = await supabase
          .from('player_pull_records')
          .select('pull_id')
          .in('class', [...affectedClasses]);
        if (affectedError) {
          pullDiscoveryError = `No se pudieron descubrir los pulls afectados: ${affectedError.message}`;
        } else {
          pullIds = [...new Set((affectedRecords ?? []).map((record) => (record as { pull_id: string }).pull_id))];
        }
      }

      let reanalysisBatchId: string | null = null;
      let reanalysisJobs: { id: string; pullId: string }[] = [];
      let reanalysisQueueError: string | null = pullDiscoveryError;
      if (pullIds.length) {
        try {
          // Evita que Deno expanda recursivamente todos los genéricos del
          // cliente Supabase al comprobar este adaptador estructural mínimo.
          const queued = await enqueueDefensiveReanalysis(supabase as unknown as QueueClient, {
            pullIds,
            reason: `classify_defensives:${[...affectedClasses].sort().join(',')}`,
            scope: {
              kind: 'classification',
              classes: [...affectedClasses].sort(),
              gameBuild: researchGameBuild,
              promptVersion: PROMPT_VERSION,
            },
            requestedBy: guard.userId,
          });
          reanalysisBatchId = queued.batchId;
          reanalysisJobs = queued.jobs;
        } catch (queueError) {
          reanalysisQueueError = queueError instanceof Error ? queueError.message : String(queueError);
          console.error('No se pudo persistir la cola de reanálisis:', queueError);
        }
      }

      return jsonResponse({
        ok: true,
        applied,
        added,
        appliedSpecProfiles,
        appliedModifiers,
        appliedSemantics,
        appliedSemanticRules,
        gameBuild: researchGameBuild,
        skippedLowConfidence,
        skippedUndetermined,
        suggestedExclusions,
        invalid,
        pullIds,
        reanalysisBatchId,
        reanalysisJobs,
        reanalysisQueueError,
      });
    }

    return jsonResponse({ ok: false, error: `action inválida: ${body.action}` }, 400);
  } catch (err) {
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});
