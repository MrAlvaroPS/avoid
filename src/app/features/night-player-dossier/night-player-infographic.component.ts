import { DatePipe } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
  ViewEncapsulation,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { toBlob, toCanvas } from 'html-to-image';
import {
  type NightDefensiveCast,
  type NightDefensiveDecision,
  type NightDeathRow,
  type NightMechanicDefensiveStat,
  type NightMechanicPressureSummary,
  type NightPlayerSummary,
  type NightPressurePullSummary,
} from '../../core/night-player-summary.service';
import {
  buildRaiderEvidenceProjection,
  type RaiderEvidenceItem,
  type RaiderPullTimelineCell,
} from '../../core/raider-evidence-projection';
import { buildRaiderInfographicViewModel } from '../../core/raider-infographic-view-model';
import { CombatEvaluationFeatureFlagsService } from '../../core/combat-evaluation-feature-flags.service';
import { DefensiveFeatureFlagsService } from '../../core/defensive-feature-flags.service';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { errorMessage } from '../../shared/error-message.util';
import {
  classColor,
  classDisplayName,
  formatDuration,
  formatPct,
  mechanicCategoryMeta,
  rootCauseMeta,
} from '../../shared/format.util';
import { RaiderInfographicV3CanvasComponent } from './raider-infographic-v3-canvas.component';

type ExportStatus =
  | 'idle'
  | 'rendering'
  | 'copied'
  | 'downloaded'
  | 'sendingDiscord'
  | 'sentDiscord'
  | 'refreshing'
  | 'error';

interface PositiveSignal {
  label: string;
  value: string;
  detail: string;
  kind: 'avoidance' | 'interrupt' | 'defensive' | 'credit';
}

// §"el hecho de no usar un defensivo debería ser penalización grande —
// siempre hay un motivo para usarlo" (feedback real, 2026-08-29): sustituye
// a la antigua "PlayerEvidenceWindow" (fallos + muertes mezclados en una
// tabla cronológica de 8 filas) — eso mezclaba información de valor muy
// distinto. Esto es solo el subconjunto que de verdad importa: muertes con
// un defensivo real de su catálogo libre y sin usar (mismo
// status==='available_unused' que ya usa Fiabilidad), la evidencia más
// accionable que hay en todo el informe.
interface DefensiveMissDeath {
  key: string;
  pullId: string;
  pullNumber: number;
  bossId: string;
  bossName: string;
  difficulty: string;
  timeMs: number;
  mechanicId: number;
  mechanicName: string;
  rootCauseLabel: string;
  damageTaken: number | null;
  nearestDefensive: (NightDefensiveCast & { offsetMs: number }) | null;
  defensivesAvailable: { spellId: number; name: string }[];
  usedHealthstoneInPull: boolean;
  usedHealthPotionInPull: boolean;
}

const SHEET_WIDTH = 2880;
const MIN_SHEET_HEIGHT = 1890;
// 2880 × 1.6 = 4608 px de ancho: igual que la infografía general. Una
// resolución mayor no se lee mejor en Discord (se reescala igual al ancho
// de pantalla) y solo penaliza la nitidez del texto al comprimir a JPEG.
const EXPORT_PIXEL_RATIO = 1.6;
// §"a mano en discord si me permite meter imagenes de 16mb, lo de los 8mb
// que comentas es una limitacion de la API?" (feedback real, 2026-08-29):
// doblemente verificado — (1) GET /guilds/{id} contra la API real →
// premium_tier: 0, CERO boosts en el guild de Avoid; (2) la documentación
// OFICIAL y actual de Discord (docs.discord.com/developers/reference,
// leída en vivo, no de memoria) dice textualmente: "The default limit is
// 10 MiB for all users, but may be higher [...] depending on their Nitro
// status or by the server's Boost Tier". El bot no tiene Nitro propio y el
// guild no tiene boosts, así que 10 MiB es el número correcto para ESTE
// bot en ESTE servidor — los 16MB que el usuario ve A MANO son su propia
// cuota personal de Nitro, un perk por usuario que no se hereda al bot. El
// 413 real que motivó el 8MB original (2026-08-27) era conservador de más.
const DISCORD_MAX_BYTES = 10 * 1024 * 1024;
const DISCORD_JPEG_QUALITY = 0.92;
const DISCORD_RENDER_ATTEMPTS = 5;
const FALLBACK_ICON_URL = 'https://wow.zamimg.com/images/wow/icons/large/inv_misc_questionmark.jpg';

// §"a 3 columnas y, si no caben y desbordan de una de las cards, bajar a 2
// columnas... contempla el mecanismo" (feedback real, 2026-08-29): el sheet
// es de ancho FIJO (exportable, no responsive) — 2880px menos la cadena de
// paddings hasta .iris-mechanic-list (.iris-player-sheet 78px +
// .iris-player-macro-group 26px + .iris-player-section 30px, a cada lado) es
// un cálculo determinista, no hace falta medir el DOM con ResizeObserver ni
// arriesgarse a que html-to-image capture un layout a medio calcular.
const MECH_CELL_WIDTH = 22;
const MECH_CARD_PADDING_X = 44 * 2;
const MECH_LIST_GAP = 24;
const MECH_CONTENT_WIDTH = SHEET_WIDTH - 2 * (78 + 26 + 30);

@Component({
  selector: 'app-night-player-infographic',
  standalone: true,
  imports: [DatePipe, RaiderInfographicV3CanvasComponent],
  templateUrl: './night-player-infographic.component.html',
  encapsulation: ViewEncapsulation.None,
})
export class NightPlayerInfographicComponent implements OnInit, AfterViewInit, OnDestroy {
  private edgeFunctions = inject(EdgeFunctionsService);
  private combatFlags = inject(CombatEvaluationFeatureFlagsService);
  private defensiveFlags = inject(DefensiveFeatureFlagsService);
  private cdr = inject(ChangeDetectorRef);

  summary = input.required<NightPlayerSummary>();
  refreshing = input(false);
  // §"actualizar TODAS las infografias... enviar TODAS las infografias
  // individuales" (feedback real, 2026-08-29): el envío masivo crea esta
  // MISMA instancia una vez por raider (ver night-report.component.ts,
  // sendAllInfographics) para reutilizar tal cual el pipeline de render+
  // envío ya probado, en vez de duplicarlo — headless evita que 24
  // aperturas seguidas se vean en pantalla (fuera del viewport, ver CSS) y
  // que cada una robe el foco o intercepte la tecla Escape de la página
  // real que el usuario sí está usando.
  headless = input(false);
  closed = output<void>();
  refreshRequested = output<void>();

  @ViewChild('sheet') private sheet?: ElementRef<HTMLElement>;
  @ViewChild('pageTwoStart') private pageTwoStart?: ElementRef<HTMLElement>;
  @ViewChild('closeButton') private closeButton?: ElementRef<HTMLButtonElement>;

  readonly sheetWidth = SHEET_WIDTH;
  readonly sheetHeight = signal(MIN_SHEET_HEIGHT);
  readonly exportWidth = Math.round(SHEET_WIDTH * EXPORT_PIXEL_RATIO);
  readonly exportHeight = computed(() => Math.round(this.sheetHeight() * EXPORT_PIXEL_RATIO));
  readonly exportStatus = signal<ExportStatus>('idle');
  readonly previewScale = signal(0.5);
  readonly fitToScreen = signal(true);
  readonly exportError = signal<string | null>(null);
  readonly iconUrls = signal<Record<number, string>>({});

  readonly classAccent = computed(
    () =>
      classColor(this.summary().gearSnapshot?.class ?? this.summary().roster?.class) ?? '#b98bd0',
  );
  readonly classLabel = computed(() => {
    const className = this.summary().gearSnapshot?.class ?? this.summary().roster?.class;
    return className ? classDisplayName(className) : null;
  });
  readonly specLabel = computed(() => this.summary().gearSnapshot?.spec ?? null);
  readonly executionScore = computed(() =>
    this.summary().nightScore == null ? null : this.summary().nightScore! * 100,
  );
  readonly executionTone = computed(() => {
    const score = this.executionScore();
    return score == null ? 'neutral' : score < 50 ? 'danger' : score < 75 ? 'warning' : 'success';
  });

  // §"otro nuevo de defensivos más en detalle... hay que montar un sistema
  // de puntuación de defensivo no usado, usado fuera de tiempo, bien usado,
  // para normalizar los datos" (feedback real, 2026-08-29): NO se inventa
  // una fórmula nueva — nightReliability.breakdown.defensiva YA es
  // exactamente eso (computeReliabilityBreakdown, reliability.service.ts):
  // ratio real cubiertas/cubribles con el mismo never_touched=0/mistimed=
  // crédito parcial/covered=ratio que ya vimos y arreglamos hoy. Reutilizarlo
  // aquí evita una segunda fórmula que pudiera divergir de la de Fiabilidad.
  // §"si no está listo el plan del MRT para mostrar podemos poner un toggle
  // en su dosier para calcularlo en base al plan o... en base al uso real
  // que haya hecho el jugador en los pulls como calculábamos antes...
  // (pero mismo concepto)" (feedback real, 2026-09-03): v2 puede dar un
  // managementScore=0 legítimo (p.ej. una noche con solo muertes de causa no
  // verificable como única oportunidad puntuable) y las cards de coaching se
  // quedan sin defensivos recomendados por diseño (ver raider-evidence-
  // projection.ts). El fallback legacy (nightReliability.breakdown.defensiva,
  // casts reales por defensivo) ya existe y ya se usa como `??` cuando v2 es
  // null — este toggle simplemente fuerza esa rama a mano, sin inventar una
  // fórmula nueva: cuando está activo, defensiveManagementV2() devuelve null
  // y TODO lo que ya depende de "v2 ?? legacy" en este componente y en
  // evidenceProjection()/v3ViewModel() cae automáticamente al mismo cálculo
  // legacy que ya existía, solo que a demanda del oficial en vez de solo
  // cuando el flag está apagado.
  readonly preferObservedDefensives = signal(false);
  readonly defensiveManagementV2 = computed(() => {
    if (this.preferObservedDefensives()) return null;
    return this.defensiveFlags.enabled('defensiveInfographicV2') ? this.summary().defensiveManagementV2 : null;
  });
  toggleDefensiveDataSource(): void {
    this.preferObservedDefensives.update((prefer) => !prefer);
  }
  /** Solo tiene sentido ofrecer el toggle si de verdad hay una generación v2 de la que alejarse — si nunca la hubo, ambas ramas ya muestran lo mismo. */
  readonly hasV2DefensiveData = computed(() => this.summary().defensiveManagementV2 != null);
  readonly evidenceProjection = computed(() =>
    buildRaiderEvidenceProjection(this.summary(), {
      defensiveManagementV2: this.defensiveManagementV2(),
    }),
  );
  readonly useV3Layout = computed(() => this.combatFlags.enabled('playerInfographicV3'));
  readonly v3ViewModel = computed(() =>
    buildRaiderInfographicViewModel(
      this.summary(),
      this.evidenceProjection(),
      this.defensiveManagementV2(),
    ),
  );
  readonly evidenceQualityTone = computed(() => {
    const quality = this.evidenceProjection().quality;
    return quality === 'high' ? 'success' : quality === 'partial' ? 'warning' : 'neutral';
  });
  readonly evidenceQualityLabel = computed(() => {
    const quality = this.evidenceProjection().quality;
    return quality === 'high' ? 'ALTA' : quality === 'partial' ? 'PARCIAL' : 'LIMITADA';
  });
  readonly evaluatedBossCount = computed(
    () =>
      new Set(
        this.summary()
          .pulls.filter((pull) => pull.pullScore != null)
          .map((pull) => `${pull.bossId}|${pull.difficulty}`),
      ).size,
  );
  readonly defensiveScore = computed(() =>
    this.defensiveManagementV2()?.managementScore ?? this.summary().nightReliability?.breakdown.defensiva ?? null,
  );
  readonly defensiveHeroProgress = computed(() => {
    const v2 = this.defensiveManagementV2();
    if (!v2) return this.defensiveScore();
    return v2.managementScore;
  });
  readonly defensiveTone = computed(() => {
    const v2 = this.defensiveManagementV2();
    if (v2?.brokenReservationCount || v2?.deathViableCdCount) return 'danger';
    if (v2?.reminderMissedCount) return 'warning';
    const score = this.defensiveHeroProgress();
    return score == null ? 'neutral' : score < 50 ? 'danger' : score < 75 ? 'warning' : 'success';
  });

  // §"explicame en Gusmï en esta tabla que salga SSZORAK limpio en verde y
  // luego 31% en rojo" (feedback real, 2026-08-29, verificado contra datos
  // reales — la aritmética cuadra exacto: 0.7×1 × 0.894(murió al 89% del
  // intento) × 0.5(defensivo+piedra libres sin usar al morir) = 31%): el
  // "limpio" venía de verifiableDeaths, que EXIGE mechanicId>0 y nombre
  // real — una muerte por inanición/falta de sanación ("Unknown Ability",
  // mechanicId 0, sin un solo golpe de mecánica al que culpar) no pasa ese
  // filtro aunque SÍ cuenta para el marcador (computePullScore usa un
  // filtro más amplio: cualquier muerte real que no sea wipe call/ninja
  // pull/excluida estadísticamente, sin exigir mecánica identificada). Dos
  // definiciones de "murió" distintas alimentando la misma fila — dos
  // filtros para dos propósitos genuinamente distintos (verifiableDeaths
  // necesita nombre real para poder enseñar evidencia con icono/mecánica en
  // "Muertes con defensivo libre y sin usar"; el marcador de la tabla solo
  // necesita saber SI murió, igual que la puntuación). scoredDeaths replica
  // el filtro exacto de evaluatedDeaths en night-player-summary.service.ts
  // para que la etiqueta de esta tabla nunca pueda volver a divergir del
  // número que enseña al lado.
  readonly scoredDeaths = computed(() =>
    this.summary().deaths.filter(
      (death) => !death.isWipeCall && !death.isNinjaPull && !death.statisticalExclusionReason,
    ),
  );

  readonly verifiableDeaths = computed(() =>
    this.summary().deaths.filter(
      (death) =>
        !death.isWipeCall &&
        !death.isNinjaPull &&
        !death.statisticalExclusionReason &&
        death.mechanicId != null &&
        death.mechanicId > 0 &&
        this.isVerifiableName(death.mechanicName),
    ),
  );

  readonly priorities = computed(() => this.evidenceProjection().coaching);

  readonly positiveSignals = computed<PositiveSignal[]>(() => {
    const result: PositiveSignal[] = [];
    const execution = this.summary().execution;
    if (execution.avoidableEligible > 0) {
      result.push({
        label: 'Esquivas verificadas',
        value: `${execution.avoidableSucceeded}/${execution.avoidableEligible}`,
        detail: `${formatPct(execution.avoidableSuccessRate)} de zonas/spread evitados mientras seguía vivo.`,
        kind: 'avoidance',
      });
    }
    if (this.summary().interrupts.length) {
      result.push({
        label: 'Interrupciones atribuidas',
        value: String(this.summary().interrupts.length),
        detail: this.summary()
          .interrupts.slice(0, 3)
          .map((cut) => `${cut.mechanicName} #${cut.pullNumber} ${formatDuration(cut.timeMs)}`)
          .join(' · '),
        kind: 'interrupt',
      });
    }
    const defensiveV2 = this.defensiveManagementV2();
    const safeDefensiveDecisions =
      defensiveV2?.decisions.filter(
        (decision) => decision.state === 'correct_hold' || decision.state === 'safe_extra_use',
      ) ?? [];
    if (safeDefensiveDecisions.length) {
      result.push({
        label: 'Decisiones defensivas correctas',
        value: String(safeDefensiveDecisions.length),
        detail: `${defensiveV2!.correctHoldCount} reservas respetadas · ${safeDefensiveDecisions.filter((decision) => decision.state === 'safe_extra_use').length} usos extra seguros.`,
        kind: 'defensive',
      });
    }
    // §"la raid debe hacerlo... no marca a nadie a propósito" (feedback real,
    // 2026-08-29): mecánicas sin asignación fija (huevos, orbes, ítems) que
    // este jugador resolvió — SUMA, nunca aparece como fallo si nadie la
    // hace (solo hay "quién sí la hizo", no "quién debía haberla hecho").
    if (this.summary().unassignedMechanicCredits.length) {
      // §"si ha resuelto algo de otros bosses no sale... podriamos poner
      // los nombres de las mecánicas voluntarias que ha resuelto y el boss
      // entre paréntesis" (feedback real, 2026-08-29): antes enseñaba las 3
      // primeras OCURRENCIAS cronológicas (pull+hora) — con 17 resueltas en
      // 2 bosses distintos, las 3 primeras podían ser las 3 del mismo boss
      // (Nanis: orbe del Altar) y los huevos de Ula'tek quedaban invisibles
      // aunque el "17" sí los contara. Ahora: un nombre por MECÁNICA
      // distinta (deduplicado por mecánica+boss, no por ocurrencia), con el
      // boss entre paréntesis — así ningún boss resuelto queda fuera del
      // texto por mucho que se repita otro, sin agrandar la card (sigue
      // siendo una sola línea de texto plano).
      const uniqueMechanics = new Map<string, string>();
      for (const c of this.summary().unassignedMechanicCredits) {
        const key = `${c.mechanicName}|${c.bossName}`;
        if (!uniqueMechanics.has(key)) uniqueMechanics.set(key, `${c.mechanicName} (${c.bossName})`);
      }
      result.push({
        label: 'Mecánicas resueltas',
        value: String(this.summary().unassignedMechanicCredits.length),
        detail: [...uniqueMechanics.values()].join(', '),
        kind: 'credit',
      });
    }
    return result;
  });

  readonly pullTimelineGroups = computed(() => {
    const groups = new Map<
      string,
      {
        key: string;
        bossName: string;
        difficulty: string;
        cells: RaiderPullTimelineCell[];
      }
    >();
    for (const cell of this.evidenceProjection().timeline) {
      const key = `${cell.bossId}|${cell.difficulty}`;
      const group = groups.get(key) ?? {
        key,
        bossName: cell.bossName,
        difficulty: cell.difficulty,
        cells: [],
      };
      group.cells.push(cell);
      groups.set(key, group);
    }
    return [...groups.values()];
  });

  /** §"siempre hay un motivo para usarlo" (feedback real, 2026-08-29): antes
   * mezclaba fallos no letales y muertes en una tabla cronológica de 8 filas
   * — ahora es exclusivamente la evidencia que de verdad mueve la aguja:
   * cada muerte evaluable en la que tenía un defensivo de su catálogo real
   * libre (sin cooldown, sin estar ya activo) y no lo lanzó. Sin cap
   * artificial de 8 — si hay más de una es exactamente lo que hay que
   * enseñar de un vistazo, no recortar la evidencia por estética.
   */
  readonly defensiveMissDeaths = computed<DefensiveMissDeath[]>(() => {
    const pulls = new Map(this.summary().pulls.map((pull, index) => [pull.pullId, index]));
    return this.verifiableDeaths()
      .filter((death) => death.defensivesAvailable.length > 0)
      .map((death) => ({
        key: `death|${death.pullId}|${death.mechanicId}|${death.timeMs}`,
        pullId: death.pullId,
        pullNumber: death.pullNumber,
        bossId: death.bossId,
        bossName: death.bossName,
        difficulty: death.difficulty,
        timeMs: death.timeMs,
        mechanicId: death.mechanicId!,
        mechanicName: death.mechanicName!,
        rootCauseLabel: this.rootCauseLabel(death),
        damageTaken: death.damageWindowTotal,
        nearestDefensive: this.nearestDefensiveCast(death.pullId, death.timeMs),
        defensivesAvailable: death.defensivesAvailable,
        usedHealthstoneInPull: death.usedHealthstoneInPull,
        usedHealthPotionInPull: death.usedHealthPotionInPull,
      }))
      .sort(
        (a, b) =>
          (pulls.get(a.pullId) ?? Number.MAX_SAFE_INTEGER) -
            (pulls.get(b.pullId) ?? Number.MAX_SAFE_INTEGER) || a.timeMs - b.timeMs,
      );
  });

  // §"debe mezclarse el punto 4 y 5 que hablan de defensivos... poner los
  // casts del pull y los pulls (que no sean wipecall o ninja pull) donde no
  // se ha usado nada. Además de guiar en el buen uso y por qué" (feedback
  // real, 2026-08-29): pressurePullBreakdown ya excluye ninja pulls y el
  // tramo posterior al wipe call (ver night-player-summary.service.ts) —
  // aquí solo se separan las dos categorías que hay que enseñar distinto.
  // §bug real encontrado en auditoría (2026-08-29): `?? []` como red de
  // seguridad — el caché de localStorage ya se versionó (ver
  // night-player-summary-cache.service.ts) para que esto no vuelva a pasar,
  // pero un objeto sin este campo no debe volver a tumbar TODA la carga de
  // iconos de la infografía solo por leerlo sin guardia.
  readonly neverTouchedPulls = computed<NightPressurePullSummary[]>(() =>
    (this.summary().defensiveSummary.pressurePullBreakdown ?? []).filter(
      (p) => p.classification === 'never_touched',
    ),
  );
  // §"agrupar por mecánica... que se lea fácil... nada por el camino"
  // (feedback real, 2026-08-29): sustituye a la vieja lista de tarjetas por
  // ventana fallada (mistimedPulls) — una fila por mecánica real, agregada
  // de toda la noche, con TODAS sus ocurrencias (cubiertas y falladas).
  readonly mechanicPressureBreakdown = computed<NightMechanicPressureSummary[]>(
    () => this.summary().defensiveSummary.mechanicPressureBreakdown ?? [],
  );

  // §"a 3 columnas y, si no caben y desbordan de una de las cards, bajar a 2
  // columnas... contempla el mecanismo de bajar a 2 columnas cuando por nº
  // de trys se desborde" (feedback real, 2026-08-29): 3 por defecto — cae a
  // 2 y luego a 1 (nunca por debajo: el scroll horizontal de la propia
  // timeline, ya soportado, es el último recurso) según la mecánica MÁS
  // ancha de todas, no card por card — así toda la sección respira igual en
  // vez de una cuadrícula con columnas de anchos dispares.
  readonly mechanicColumns = computed<number>(() => {
    const mechanics = this.mechanicPressureBreakdown();
    if (!mechanics.length) return 3;
    const maxOccurrences = Math.max(...mechanics.map((m) => m.totalCount));
    const maxTimelineWidth = maxOccurrences * MECH_CELL_WIDTH;
    const timelineAreaFor = (columns: number): number =>
      (MECH_CONTENT_WIDTH - (columns - 1) * MECH_LIST_GAP) / columns - MECH_CARD_PADDING_X;
    if (maxTimelineWidth <= timelineAreaFor(3)) return 3;
    if (maxTimelineWidth <= timelineAreaFor(2)) return 2;
    return 1;
  });
  readonly windowCoverageTotals = computed(() => {
    // La cifra superior y las cards deben contar exactamente el mismo
    // universo. pressurePullBreakdown excluye pulls con muerte para no
    // penalizarlos dos veces en la puntuación; este bloque, en cambio, es
    // descriptivo y enseña toda la noche, incluidas esas ocurrencias.
    const mechanics = this.mechanicPressureBreakdown();
    return {
      coverable: mechanics.reduce((sum, mechanic) => sum + mechanic.totalCount, 0),
      covered: mechanics.reduce((sum, mechanic) => sum + mechanic.coveredCount, 0),
    };
  });

  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;

  formatDuration = formatDuration;
  formatPct = formatPct;
  categoryMeta = mechanicCategoryMeta;
  rootCauseLabel = (death: NightDeathRow): string =>
    rootCauseMeta(death.rootCause)?.label ??
    mechanicCategoryMeta(death.category)?.label ??
    'Causa no clasificada';

  defensiveDecisionLabel(decision: NightDefensiveDecision): string {
    const labels: Record<NightDefensiveDecision['state'], string> = {
      plan_covered: 'Plan cubierto',
      covered_with_substitution:
        decision.managementOutcome === 'failure' ? 'Sustitución con coste' : 'Sustitución válida',
      correct_hold: 'Hold correcto',
      safe_extra_use: 'Uso extra seguro',
      missed_extra_opportunity: 'Oportunidad factible',
      plan_broken: 'Reserva rota',
      reminder_missed: 'Reminder omitido',
      death_with_viable_cd: 'Muerte con alternativa',
      death_with_ready_cd: 'CD disponible al morir',
      no_feasible_alternative: 'Sin alternativa factible',
      uncertain_data: 'Dato incierto',
    };
    return labels[decision.state];
  }

  defensiveDecisionTone(decision: NightDefensiveDecision): 'success' | 'warning' | 'danger' | 'neutral' {
    if (decision.state === 'plan_broken' || decision.state === 'reminder_missed' || decision.state === 'death_with_viable_cd') return 'danger';
    if (decision.state === 'missed_extra_opportunity' || decision.state === 'death_with_ready_cd') return 'warning';
    if (decision.state === 'covered_with_substitution') return decision.managementOutcome === 'failure' ? 'danger' : 'warning';
    if (decision.state === 'correct_hold' || decision.state === 'safe_extra_use' || decision.state === 'plan_covered') return 'success';
    return 'neutral';
  }

  defensiveDecisionCopy(decision: NightDefensiveDecision): string {
    const planned = decision.plannedSpellName ?? (decision.plannedSpellId ? `#${decision.plannedSpellId}` : 'el defensivo asignado');
    const actual = decision.actualSpellName ?? (decision.actualSpellId ? `#${decision.actualSpellId}` : 'el cooldown');
    const mechanic = decision.mechanicName ?? (decision.abilityId ? `mecánica #${decision.abilityId}` : 'esta presión');
    const untilFuture = decision.relatedFutureAtMs == null ? null : Math.max(0, decision.relatedFutureAtMs - decision.atMs);
    switch (decision.state) {
      case 'plan_broken':
        if (decision.reason === 'TARGET_MISMATCH') return `${actual} se lanzó sobre otro target y no cubrió ${mechanic}.`;
        return `${actual} se usó${decision.actualCastAtMs == null ? '' : ` ${formatDuration(Math.max(0, decision.atMs - decision.actualCastAtMs))} antes`}; faltaban ${formatDuration(decision.cooldownRemainingMs ?? 0)} al llegar ${mechanic}.`;
      case 'reminder_missed':
        return `${planned} estaba realmente listo en la ventana de ${mechanic}, pero no se lanzó.`;
      case 'covered_with_substitution':
        return `${actual} cubrió el slot de ${planned}. La cobertura fue correcta${decision.reason === 'SUBSTITUTE_CAUSED_FUTURE_CONFLICT' ? ', pero consumió una reserva posterior' : ' sin coste futuro detectado'}.`;
      case 'correct_hold':
        return `${decision.candidateSpellNames.join(' / ') || 'El cooldown'} estaba listo, pero usarlo habría roto la reserva${untilFuture == null ? ' posterior' : ` ${formatDuration(untilFuture)} después`}.`;
      case 'safe_extra_use':
        return `${actual} aportó cobertura adicional y recuperó sin romper una reserva superior.`;
      case 'missed_extra_opportunity':
        return `Había una secuencia segura con ${decision.candidateSpellNames.join(' / ') || 'un defensivo disponible'} para cubrir ${mechanic}.`;
      case 'death_with_viable_cd':
        return `${decision.candidateSpellNames.join(' / ') || 'Un defensivo propio'} estuvo disponible durante la secuencia letal observada. Había una respuesta factible; no se afirma cuánto daño habría prevenido.`;
      case 'death_with_ready_cd':
        return `${decision.candidateSpellNames.join(' / ') || 'Un defensivo propio'} estaba disponible al morir, pero la evidencia no demuestra que hubiera podido prevenir la secuencia previa.`;
      case 'no_feasible_alternative':
        return `No había una secuencia defensiva mejor sin sacrificar la siguiente mecánica crítica.`;
      case 'plan_covered':
        return `${planned} cubrió correctamente ${mechanic}.`;
      case 'uncertain_data':
        return 'Build, target o timing insuficiente para afirmar una decisión.';
    }
  }

  // §"cuando le doy al boton de actualizar y enviar todas las infografias
  // se estan perdiendo iconos de mecanicas y habilidades" (feedback real,
  // 2026-08-30): bug real — loadSpellIcons() hace fetch a wowhead (red) y
  // no se esperaba en ningún sitio. Al enviar en bulk
  // (night-report.component.ts: sendAllInfographics) la instancia headless
  // se crea y sendToDiscord() se llama casi inmediatamente después — mucho
  // más rápido que el round-trip de red, así que iconUrls() seguía vacío,
  // el template caía a @else (SVG de escudo) y waitForVisuals() ni
  // siquiera encontraba un <img> que esperar (el fallback no es una
  // imagen). En el dosier individual "colaba" porque el usuario tarda
  // segundos en pulsar enviar tras abrir el modal — tiempo de sobra para
  // que la red respondiera. Guardar la promesa para que renderPng/
  // renderFullCanvas la esperen ANTES de rasterizar (ver waitForVisuals).
  private spellIconsLoaded: Promise<void> = Promise.resolve();

  ngOnInit(): void {
    this.spellIconsLoaded = this.loadSpellIcons();
  }

  ngAfterViewInit(): void {
    const element = this.sheet?.nativeElement;
    if (element && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.updateSheetSize());
      this.resizeObserver.observe(element);
    }
    queueMicrotask(() => {
      this.updateSheetSize();
      if (!this.headless()) this.closeButton?.nativeElement.focus();
    });
  }

  ngOnDestroy(): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.resizeObserver?.disconnect();
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    if (this.fitToScreen()) this.updatePreviewScale();
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (this.headless()) return; // no debe interceptar el teclado de la página real que el usuario sí está usando
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.closed.emit();
  }

  toggleZoom(): void {
    this.fitToScreen.update((value) => !value);
    this.previewScale.set(this.fitToScreen() ? this.calculateFitScale() : 1);
  }

  requestRefresh(): void {
    if (this.refreshing()) return;
    this.refreshRequested.emit();
  }

  iconUrl(spellId: number | null): string | null {
    return spellId ? (this.iconUrls()[spellId] ?? null) : null;
  }

  onIconError(event: Event): void {
    const image = event.currentTarget as HTMLImageElement;
    if (!image.src.endsWith('inv_misc_questionmark.jpg')) image.src = FALLBACK_ICON_URL;
  }

  // §"ya que tenemos o podemos obtener las imágenes de los bosses..." (feedback
  // real, 2026-08-29): boss_id en toda la app YA es el encounter id de WCL
  // (ver known_raid_bosses, comentario de esa migración) — mismo id que WCL
  // usa para sus propios iconos de boss, sin fetch adicional ni columna nueva.
  bossIconUrl(bossId: string): string {
    return `https://assets.rpglogs.com/img/warcraft/bosses/${bossId}-icon.jpg`;
  }

  // §"no sale o sale raro" (feedback real, 2026-08-29): assets.rpglogs.com
  // no es una API documentada — no hay contrato de disponibilidad, así que
  // un fallo aislado (CDN frío, blip de red) es esperable. Un reintento con
  // cache-buster antes de rendirse; si falla dos veces, oculta la imagen del
  // todo (en vez de sustituirla por el icono de objeto "signo de
  // interrogación" de WoW, que no pega nada con un retrato de boss y se veía
  // más roto que la propia ausencia de imagen) — el SVG de fondo ya definido
  // en el contenedor queda visible por debajo.
  onBossIconError(event: Event): void {
    const image = event.currentTarget as HTMLImageElement;
    if (image.dataset['retried']) {
      image.style.display = 'none';
      return;
    }
    image.dataset['retried'] = '1';
    image.src = `${image.src.split('?')[0]}?retry=${Date.now()}`;
  }

  async copyPng(): Promise<void> {
    const blob = await this.renderPng();
    if (!blob) return;
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        this.downloadBlob(blob);
        this.setStatus('downloaded');
        return;
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      this.setStatus('copied');
    } catch {
      this.downloadBlob(blob);
      this.setStatus('downloaded');
    }
  }

  async downloadPng(): Promise<void> {
    const blob = await this.renderPng();
    if (!blob) return;
    this.downloadBlob(blob);
    this.setStatus('downloaded');
  }

  // §"aunque la infografia en pantalla la veamos bien, cuando la enviemos a
  // discord [...] se manden dos mensajes para poder leerlo mejor [...] la
  // parte de mecanicas [...] hasta el final de la infografia [...] el corte
  // tiene que ser limpio: cuando acaba la card de mecanicas" (feedback real,
  // 2026-08-29): SOLO afecta al envío a Discord — en pantalla y en
  // "Descargar"/"Copiar" sigue siendo una única lámina continua (renderPng,
  // sin tocar). El punto de corte se mide ANTES de renderizar, contra el DOM
  // real (offsetTop no se ve afectado por el transform:scale() del preview,
  // a diferencia de getBoundingClientRect — no hace falta dividir por
  // previewScale()). La especificación mixta v3 exige un anchor explícito:
  // Página 2 empieza en su cabecera repetida, sin inferir semántica por las
  // clases del bloque anterior/siguiente.
  async sendToDiscord(): Promise<void> {
    const channelId = this.summary().discordChannel?.discordChannelId;
    if (!channelId) return;
    this.exportError.set(null);
    try {
      const { canvas, pixelRatio } = await this.renderFullCanvas();
      const v3Pages = this.findV3ExportPages();
      const splitYCss = v3Pages.length ? null : this.findPageSplitY();
      const date = this.summary().reportDate
        ? new Date(this.summary().reportDate).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })
        : this.summary().reportTitle;
      const baseContent = `Informe de combate de ${this.summary().playerName} · ${date}`;
      this.exportStatus.set('sendingDiscord');

      if (v3Pages.length) {
        for (const [index, page] of v3Pages.entries()) {
          const top = Math.max(0, Math.round(page.top * pixelRatio));
          const height = Math.min(canvas.height - top, Math.round(page.height * pixelRatio));
          const pageCanvas = this.cropCanvas(canvas, 0, top, canvas.width, height);
          const fitted = await this.fitCanvasToDiscordLimit(pageCanvas);
          const suffix = v3Pages.length > 1 ? `-${index + 1}-v3` : '-v3';
          await this.edgeFunctions.sendDiscordMessage({
            channelId,
            content:
              v3Pages.length > 1
                ? `${baseContent} · ${index + 1}/${v3Pages.length}${index ? ' — continuación de mecánicas' : ' — diagnóstico, coaching y defensivos'}`
                : `${baseContent} · diagnóstico, coaching y defensivos`,
            imageBase64: await this.blobToBase64(fitted.blob),
            imageFilename: this.filename(fitted.extension, suffix),
          });
          if (index < v3Pages.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      } else if (splitYCss != null) {
        const splitYPx = Math.min(canvas.height - 1, Math.max(1, Math.round(splitYCss * pixelRatio)));
        const topCanvas = this.cropCanvas(canvas, 0, 0, canvas.width, splitYPx);
        const bottomCanvas = this.cropCanvas(canvas, 0, splitYPx, canvas.width, canvas.height - splitYPx);
        const part1 = await this.fitCanvasToDiscordLimit(topCanvas);
        await this.edgeFunctions.sendDiscordMessage({
          channelId,
          content: `${baseContent} · 1/2 — diagnóstico y coaching`,
          imageBase64: await this.blobToBase64(part1.blob),
          imageFilename: this.filename(part1.extension, '-1-diagnostico-coaching'),
        });
        // Pausa corta para que lleguen en orden y separados, no como un burst.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const part2 = await this.fitCanvasToDiscordLimit(bottomCanvas);
        await this.edgeFunctions.sendDiscordMessage({
          channelId,
          content: `${baseContent} · 2/2 — mecánicas y defensivos`,
          imageBase64: await this.blobToBase64(part2.blob),
          imageFilename: this.filename(part2.extension, '-2-mecanicas-defensivos'),
        });
      } else {
        // Fallback defensivo: si algún día cambian esas clases y el corte ya
        // no se puede localizar, se manda entera en un único mensaje en vez
        // de fallar el envío por completo.
        const whole = await this.fitCanvasToDiscordLimit(canvas);
        await this.edgeFunctions.sendDiscordMessage({
          channelId,
          content: baseContent,
          imageBase64: await this.blobToBase64(whole.blob),
          imageFilename: this.filename(whole.extension),
        });
      }
      this.setStatus('sentDiscord');
    } catch (err) {
      this.exportError.set(errorMessage(err));
      this.setStatus('error');
    }
  }

  /** Inicio explícito de Página 2 en CSS px del sheet, sin escalar. */
  private findPageSplitY(): number | null {
    const pageTwoStart = this.pageTwoStart?.nativeElement;
    const sheet = this.sheet?.nativeElement;
    if (!pageTwoStart || !sheet || !sheet.contains(pageTwoStart)) return null;
    return pageTwoStart.offsetTop > 0 ? pageTwoStart.offsetTop : null;
  }

  /**
   * La V3 pagina por spreads 4:3 completos. Cada bloque declara su frontera
   * en el DOM para que Discord reciba una imagen legible por lámina, incluso
   * cuando una noche con muchas mecánicas necesita continuación.
   */
  private findV3ExportPages(): { top: number; height: number }[] {
    const sheet = this.sheet?.nativeElement;
    if (!sheet || !this.useV3Layout()) return [];
    return Array.from(sheet.querySelectorAll<HTMLElement>('[data-export-page]'))
      .map((page) => {
        let top = 0;
        let current: HTMLElement | null = page;
        while (current && current !== sheet) {
          top += current.offsetTop;
          current = current.offsetParent as HTMLElement | null;
        }
        return current === sheet && page.offsetHeight > 0
          ? { top, height: page.offsetHeight }
          : null;
      })
      .filter((page): page is { top: number; height: number } => page != null);
  }

  metricValue(value: number, unit: 'percent' | 'per10'): string {
    return unit === 'percent' ? formatPct(value) : value.toFixed(1).replace('.0', '');
  }

  signedMetric(value: number, unit: 'percent' | 'per10'): string {
    const formatted = this.metricValue(Math.abs(value), unit);
    return `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatted}`;
  }

  compactNumber(value: number): string {
    return new Intl.NumberFormat('es-ES', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  }

  defensiveTimingList(casts: { pullNumber: number; timeMs: number }[], limit = 8): string {
    const visible = casts
      .slice(0, limit)
      .map((cast) => `#${cast.pullNumber} ${formatDuration(cast.timeMs)}`)
      .join(' · ');
    return casts.length > limit ? `${visible} · +${casts.length - limit}` : visible;
  }

  defensiveOffsetLabel(offsetMs: number): string {
    if (Math.abs(offsetMs) < 500) return 'en el mismo instante';
    const seconds = (Math.abs(offsetMs) / 1000).toFixed(1).replace('.', ',');
    return `${seconds} s ${offsetMs < 0 ? 'antes' : 'después'}`;
  }

  // §"guiar en el buen uso y por qué" (feedback real, 2026-08-29): etiqueta
  // legible del survival_type ya clasificado en el catálogo (cooldown-
  // catalog.ts). §"esta diciendo que el barkskin es mitigacion pero no dice
  // nada del frenzied" (feedback real, 2026-08-29): se llama una vez POR
  // OPCIÓN ahora (antes una sola vez para toda la lista) — compacta a
  // propósito para caber en una lista de 1 línea por habilidad.
  survivalTypeLabel(survivalType: string | null): string {
    switch (survivalType) {
      case 'emergency':
        return 'emergencia';
      case 'mitigation':
        return 'mitigación';
      case 'absorption':
        return 'absorción';
      case 'sustain':
        return 'autocuración';
      default:
        return 'defensivo';
    }
  }

  // §"si el boss lanza la habilidad siempre en el mismo momento... o cada X
  // tiempo podemos ponerlo también ahí para preparar el defensivo" (feedback
  // real, 2026-08-29): night-player-summary.service.ts ya decide SI hay
  // patrón fiable (validado empíricamente, umbral de variación real) — este
  // método solo da forma de texto a lo que ya viene calculado, null cuando
  // no hay nada que enseñar (no se inventa un patrón sin evidencia).
  timingPatternLabel(mechanic: NightMechanicPressureSummary): string | null {
    const pattern = mechanic.timingPattern;
    if (!pattern) return null;
    const time = this.formatDuration(pattern.ms);
    return pattern.kind === 'fixed'
      ? `Suele ocurrir sobre los ${time} (${pattern.sampleSize} pulls históricos)`
      : `Se repite cada ~${time} (${pattern.sampleSize} repeticiones históricas)`;
  }

  timingPatternCompactLabel(mechanic: NightMechanicPressureSummary): string | null {
    const pattern = mechanic.timingPattern;
    if (!pattern) return null;
    const seconds = Math.round(pattern.ms / 1000);
    const time = seconds < 60 ? `${seconds}s` : this.formatDuration(pattern.ms);
    return pattern.kind === 'fixed' ? `sobre ${time}` : `cada ~${time}`;
  }

  // §"usa el icono del boss o de la mecánica que ha fallado (si la tenemos
  // relacionada, si no, el del boss), no el icono de la habilidad defensiva
  // disponible" (feedback real, 2026-08-29): null cuando no hay mecánica
  // verificable (isVerifiableName descarta "Unknown Ability"/null) — el
  // llamador cae al icono del boss en ese caso.
  mechanicIconUrl(mechanic: NightMechanicPressureSummary): string | null {
    if (!this.isVerifiableName(mechanic.mechanicName)) return null;
    return this.iconUrl(mechanic.mechanicId);
  }

  mechanicRatioPct(mechanic: NightMechanicPressureSummary): number {
    return mechanic.totalCount > 0
      ? Math.round((mechanic.coveredCount / mechanic.totalCount) * 100)
      : 0;
  }

  mechanicPullCount(mechanic: NightMechanicPressureSummary): number {
    return new Set(mechanic.occurrences.map((occurrence) => occurrence.pullId)).size;
  }

  // §"timeline de cuadrados... agrupada visualmente por pull... el bracket
  // debe comenzar exactamente sobre el primer cuadrado de ese pull [...]
  // terminar exactamente sobre el último" (spec visual real, 2026-08-29,
  // "validada"): las ocurrencias ya llegan ordenadas por pull/hora (ver
  // buildMechanicPressureBreakdown) — agrupar es un simple corte por cambio
  // de pullNumber, sin reordenar nada. Anidar los cuadrados DENTRO de cada
  // grupo (en vez de una capa de brackets superpuesta con matemática de
  // píxeles) deja que flexbox calcule el ancho de cada bracket solo — un
  // grupo de 5 cuadrados de 20px mide 100px porque son 5 elementos de 20px,
  // no porque se le haya dicho que mida 100px.
  // §"el numero de pull... debe ser el numero de pull DEL BOSS... la
  // numeracion no es global de toda la noche" (feedback real, 2026-08-29,
  // corrección de un hallazgo previo de esta misma sesión): confirmado — la
  // columna `pull_number` es la numeración global de todo el report (no se
  // reinicia por boss), y por eso esta card llegó a enseñar un "3" con solo
  // 1 pull. La corrección real vive en night-player-summary.service.ts
  // (bossPullNumber/validAttemptOrdinal, mismo criterio que ya usaba
  // raid-session.component.ts) — `occurrence.pullNumber` que llega aquí YA
  // es el ordinal 1..N relativo a los intentos válidos de ESTE boss, no hay
  // nada que corregir en este componente.
  mechanicPullGroups(mechanic: NightMechanicPressureSummary): { pullNumber: number; occurrences: NightMechanicPressureSummary['occurrences'] }[] {
    const groups: { pullNumber: number; occurrences: NightMechanicPressureSummary['occurrences'] }[] = [];
    for (const occ of mechanic.occurrences) {
      const last = groups[groups.length - 1];
      if (last && last.pullNumber === occ.pullNumber) last.occurrences.push(occ);
      else groups.push({ pullNumber: occ.pullNumber, occurrences: [occ] });
    }
    return groups;
  }

  mechanicGridAriaLabel(mechanic: NightMechanicPressureSummary): string {
    const missed = Math.max(0, mechanic.totalCount - mechanic.coveredCount);
    return `${mechanic.totalCount} oportunidades en orden cronológico: ${mechanic.coveredCount} cubiertas con celda rellena y ${missed} falladas con celda hueca.`;
  }

  mechanicOccurrenceTitle(occurrence: NightMechanicPressureSummary['occurrences'][number]): string {
    const position = `#${occurrence.pullNumber} ${this.formatDuration(occurrence.timeMs)}`;
    if (!occurrence.covered) return `${position} — fallo`;
    return `${position} — cubierta${occurrence.coveredBySpellName ? ` con ${occurrence.coveredBySpellName}` : ''}`;
  }

  // §"cubrió / sin usar / en cooldown" (feedback real, 2026-08-29): total
  // real de ocasiones donde ESTE defensivo en concreto fue una opción
  // evaluable — no siempre es mechanic.totalCount entero (un talento
  // cambiado a media noche, por ejemplo, dejaría a este spellId fuera del
  // catálogo del jugador en algunas ocasiones) — se calcula el total propio
  // en vez de asumir que coincide, para que la mini-barra siempre sume 100%.
  private defensiveStatTotal(defensive: NightMechanicDefensiveStat): number {
    return defensive.timesCovered + defensive.timesAvailableUnused + defensive.timesOnCooldown + defensive.timesUnknown;
  }

  defensiveStatPct(count: number, defensive: NightMechanicDefensiveStat): number {
    const total = this.defensiveStatTotal(defensive);
    return total > 0 ? Math.round((count / total) * 100) : 0;
  }

  // §"si tras sufrir daño uso la poción es un uso correcto, usarla por
  // usarla no es correcto" (feedback real, 2026-08-30): usedHealthstoneInPull/
  // usedHealthPotionInPull ya exigen que el cast caiga dentro de una ventana
  // de presión real (ver isReactiveConsumableUse) — el texto lo deja
  // explícito para que no se lea como "en algún momento del intento".
  consumableResponseLabel(death: DefensiveMissDeath): string {
    if (death.usedHealthstoneInPull && death.usedHealthPotionInPull) {
      return 'Piedra + poción, ambas en respuesta a daño real';
    }
    if (death.usedHealthstoneInPull) return 'Piedra usada en respuesta a daño real';
    if (death.usedHealthPotionInPull) return 'Poción usada en respuesta a daño real';
    return 'Sin piedra ni poción en respuesta a daño real en el try';
  }

  prioritySpellId(item: RaiderEvidenceItem): number | null {
    return item.mechanicId ?? item.defensives[0]?.spellId ?? null;
  }

  priorityWhen(item: RaiderEvidenceItem): string {
    const where = [item.bossName, item.difficulty].filter(Boolean).join(' · ');
    const when =
      item.pullNumber == null
        ? ''
        : `Pull #${item.pullNumber}${item.atMs == null ? '' : ` · ${formatDuration(item.atMs)}`}`;
    return [where, when].filter(Boolean).join(' · ');
  }

  verdictLabel(item: RaiderEvidenceItem): string {
    const labels: Record<RaiderEvidenceItem['verdict'], string> = {
      success: 'Éxito',
      confirmed_error: 'Error confirmado',
      coaching: 'Coaching',
      correct_hold: 'Correct hold',
      context: 'Contexto',
      no_verdict: 'Sin veredicto',
    };
    return labels[item.verdict];
  }

  private isVerifiableName(name: string | null | undefined): name is string {
    if (!name) return false;
    const normalized = name.toLocaleLowerCase('es-ES');
    return !(
      normalized.includes('unknown') ||
      normalized.includes('sin identificar') ||
      normalized.includes('causa desconocida')
    );
  }

  /** Cast defensivo real más cercano a un instante dado, en la ventana −12s/+8s ya usada en el resto del informe. */
  private nearestDefensiveCast(
    pullId: string,
    timeMs: number,
  ): (NightDefensiveCast & { offsetMs: number }) | null {
    return (
      this.summary()
        .defensiveSummary.spells.flatMap((spell) => spell.casts)
        .filter((cast) => cast.pullId === pullId)
        .map((cast) => ({ ...cast, offsetMs: cast.timeMs - timeMs }))
        .filter((cast) => cast.offsetMs >= -12_000 && cast.offsetMs <= 8_000)
        .sort((a, b) => Math.abs(a.offsetMs) - Math.abs(b.offsetMs))[0] ?? null
    );
  }

  private async renderPng(): Promise<Blob | null> {
    if (!this.sheet || this.exportStatus() === 'rendering') return null;
    this.exportStatus.set('rendering');
    this.exportError.set(null);
    try {
      await this.waitForVisuals();
      const height = Math.max(MIN_SHEET_HEIGHT, Math.ceil(this.sheet.nativeElement.scrollHeight));
      const pixelRatio = Math.max(1, Math.min(EXPORT_PIXEL_RATIO, 16_000 / height));
      const blob = await toBlob(this.sheet.nativeElement, {
        width: SHEET_WIDTH,
        height,
        pixelRatio,
        backgroundColor: '#07070d',
        cacheBust: true,
        skipFonts: true,
      });
      if (!blob) throw new Error('No se pudo crear el PNG.');
      return blob;
    } catch (err) {
      this.exportError.set(errorMessage(err));
      this.setStatus('error');
      return null;
    }
  }

  /** Rasteriza el sheet completo UNA vez a la resolución de exportación — tanto el envío entero como el partido en dos parten de este mismo canvas (recortar/reencodar en memoria es barato; volver a rasterizar el DOM no lo es). */
  private async renderFullCanvas(): Promise<{ canvas: HTMLCanvasElement; height: number; pixelRatio: number }> {
    if (!this.sheet) throw new Error('La infografía aún no está lista.');
    this.exportStatus.set('rendering');
    await this.waitForVisuals();
    const height = Math.max(MIN_SHEET_HEIGHT, Math.ceil(this.sheet.nativeElement.scrollHeight));
    const pixelRatio = Math.max(1, Math.min(EXPORT_PIXEL_RATIO, 16_000 / height));
    const canvas = await toCanvas(this.sheet.nativeElement, {
      width: SHEET_WIDTH,
      height,
      pixelRatio,
      backgroundColor: '#07070d',
      cacheBust: true,
      skipFonts: true,
    });
    return { canvas, height, pixelRatio };
  }

  private cropCanvas(source: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number): HTMLCanvasElement {
    const target = document.createElement('canvas');
    target.width = sw;
    target.height = sh;
    target.getContext('2d')!.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    return target;
  }

  private downscaleCanvas(source: HTMLCanvasElement, factor: number): HTMLCanvasElement {
    const target = document.createElement('canvas');
    target.width = Math.max(1, Math.round(source.width * factor));
    target.height = Math.max(1, Math.round(source.height * factor));
    target.getContext('2d')!.drawImage(source, 0, 0, target.width, target.height);
    return target;
  }

  // §"se puede enviar como imagen pero también como adjunto... para no
  // perder calidad" + "se manda duplicada, se ve incluso peor que antes"
  // (feedback real, 2026-08-29 — dos mensajes del mismo hilo): UN solo
  // archivo por mensaje, nunca dos a la vez. Se intenta primero PNG sin
  // pérdida al tamaño que llega (igual que "Descargar 4.6K") — si cabe
  // entero bajo el límite de Discord, esa es la mejor calidad posible.
  // Solo si NO cabe se recurre a JPEG probando varias calidades ANTES de
  // reducir tamaño (recomendación externa contrastada, 2026-08-29: para
  // texto/UI perjudica más perder resolución que un jpeg algo más agresivo)
  // — la reducción de tamaño ahora es un downscale en memoria del mismo
  // canvas, no volver a rasterizar el DOM a un pixelRatio menor.
  private async fitCanvasToDiscordLimit(sourceCanvas: HTMLCanvasElement): Promise<{ blob: Blob; extension: 'png' | 'jpg' }> {
    const pngBlob = await new Promise<Blob | null>((resolve) => sourceCanvas.toBlob(resolve, 'image/png'));
    if (pngBlob && pngBlob.size <= DISCORD_MAX_BYTES) return { blob: pngBlob, extension: 'png' };

    const JPEG_QUALITY_STEPS = [DISCORD_JPEG_QUALITY, 0.88, 0.8];
    let canvas = sourceCanvas;
    let lastBlob: Blob | null = null;
    for (let attempt = 0; attempt < DISCORD_RENDER_ATTEMPTS; attempt++) {
      for (const quality of JPEG_QUALITY_STEPS) {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (!blob) continue;
        lastBlob = blob;
        if (blob.size <= DISCORD_MAX_BYTES) return { blob, extension: 'jpg' };
      }
      canvas = this.downscaleCanvas(canvas, 0.72);
    }
    const sizeMb = lastBlob ? (lastBlob.size / 1024 / 1024).toFixed(1) : '?';
    throw new Error(`La imagen sigue pesando ${sizeMb} MB incluso reducida.`);
  }

  private async waitForVisuals(): Promise<void> {
    // Primero los iconos (fetch a wowhead, ver el comentario junto a
    // spellIconsLoaded) — si no se espera aquí, el @if de la plantilla
    // puede seguir cayendo al SVG de escudo (no un <img>) y el bucle de
    // abajo nunca se entera de que faltaba algo por cargar.
    await this.spellIconsLoaded;
    this.cdr.detectChanges();
    await document.fonts?.ready;
    const images = Array.from(this.sheet?.nativeElement.querySelectorAll('img') ?? []);
    await Promise.all(
      images.map(async (image) => {
        if (image.complete) return;
        try {
          await image.decode();
        } catch {
          // El fallback visual mantiene exportable la lámina.
        }
      }),
    );
  }

  private async loadSpellIcons(): Promise<void> {
    const ids = new Set<number>();
    for (const evidence of this.evidenceProjection().items) {
      if (evidence.mechanicId) ids.add(evidence.mechanicId);
      for (const defensive of evidence.defensives) ids.add(defensive.spellId);
    }
    for (const cut of this.summary().interrupts) ids.add(cut.mechanicId);
    for (const spell of this.summary().defensiveSummary.spells) ids.add(spell.spellId);
    for (const death of this.verifiableDeaths())
      for (const defensive of death.defensivesAvailable) ids.add(defensive.spellId);
    for (const mechanic of this.summary().evolution?.mechanics ?? []) ids.add(mechanic.mechanicId);
    for (const mechanic of this.mechanicPressureBreakdown()) {
      ids.add(mechanic.mechanicId);
      for (const defensive of mechanic.defensives) ids.add(defensive.spellId);
    }

    const entries = await Promise.all(
      [...ids].map(async (spellId): Promise<[number, string] | null> => {
        try {
          const response = await fetch(`https://nether.wowhead.com/tooltip/spell/${spellId}`);
          if (!response.ok) return null;
          const payload = (await response.json()) as { icon?: string };
          return payload.icon
            ? [spellId, `https://wow.zamimg.com/images/wow/icons/large/${payload.icon}.jpg`]
            : null;
        } catch {
          return null;
        }
      }),
    );
    this.iconUrls.set(
      Object.fromEntries(entries.filter((entry): entry is [number, string] => entry != null)),
    );
    queueMicrotask(() => this.updateSheetSize());
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.onerror = () => reject(reader.error ?? new Error('No se pudo leer la imagen.'));
      reader.readAsDataURL(blob);
    });
  }

  private filename(extension: 'png' | 'jpg', suffix = ''): string {
    const player = this.summary()
      .playerName.toLocaleLowerCase('es-ES')
      .replace(/[^a-z0-9]+/g, '-');
    return `iris-${player}-${this.summary().reportCode}${suffix}.${extension}`;
  }

  private downloadBlob(blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = this.filename('png');
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  private setStatus(status: Exclude<ExportStatus, 'idle' | 'rendering' | 'refreshing'>): void {
    this.exportStatus.set(status);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.exportStatus.set('idle'), 3_000);
  }

  private calculateFitScale(): number {
    const widthScale = (window.innerWidth - 36) / SHEET_WIDTH;
    // §"debe ser dinámico... para que pueda haberlo si se necesita crecer"
    // (feedback real, 2026-09-03): la altura de página V3 dejó de ser fija
    // (2160px) — hoy solo hay un pliego por dosier (sin continuaciones
    // reales todavía, ver raider-infographic-v3-canvas.component.ts), así
    // que la misma altura medida (sheetHeight/scrollHeight, ya actualizada
    // por el mismo ResizeObserver para ambos layouts) sirve también aquí.
    const heightScale = (window.innerHeight - 112) / this.sheetHeight();
    return Math.max(0.18, Math.min(1, widthScale, heightScale));
  }

  private updatePreviewScale(): void {
    this.previewScale.set(this.calculateFitScale());
  }

  private updateSheetSize(): void {
    const height = Math.max(
      MIN_SHEET_HEIGHT,
      Math.ceil(this.sheet?.nativeElement.scrollHeight ?? 0),
    );
    if (height !== this.sheetHeight()) this.sheetHeight.set(height);
    if (this.fitToScreen()) this.updatePreviewScale();
  }
}
