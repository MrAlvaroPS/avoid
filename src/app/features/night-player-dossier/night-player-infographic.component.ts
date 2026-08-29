import { DatePipe } from '@angular/common';
import {
  AfterViewInit,
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
  type NightDeathRow,
  type NightMechanicFailRow,
  type NightMechanicPressureSummary,
  type NightPlayerSummary,
  type NightPressurePullSummary,
} from '../../core/night-player-summary.service';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { errorMessage } from '../../shared/error-message.util';
import type { MechanicCategory } from '../../shared/models/domain';
import {
  classColor,
  classDisplayName,
  formatDuration,
  formatPct,
  mechanicCategoryMeta,
  rootCauseMeta,
} from '../../shared/format.util';

type ExportStatus =
  | 'idle'
  | 'rendering'
  | 'copied'
  | 'downloaded'
  | 'sendingDiscord'
  | 'sentDiscord'
  | 'refreshing'
  | 'error';

interface PlayerIssue {
  key: string;
  mechanicId: number;
  mechanicName: string;
  bossName: string;
  difficulty: string;
  category: MechanicCategory | null;
  failCount: number;
  deathCount: number;
  totalDamage: number;
  occurrences: { pullNumber: number; timeMs: number; kind: 'fallo' | 'muerte' }[];
  resolution: string | null;
  note: string | null;
  availableDefensives: { spellId: number; name: string }[];
}

interface PlayerPriority {
  title: string;
  evidence: string;
  action: string;
  spellId: number | null;
  kind: 'mechanic' | 'defensive' | 'consumable' | 'preparation';
}

interface PositiveSignal {
  label: string;
  value: string;
  detail: string;
  kind: 'avoidance' | 'interrupt' | 'clean' | 'defensive';
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
const DISCORD_MAX_BYTES = 8 * 1024 * 1024;
const DISCORD_JPEG_QUALITY = 0.92;
const DISCORD_RENDER_ATTEMPTS = 5;
const FALLBACK_ICON_URL =
  'https://wow.zamimg.com/images/wow/icons/large/inv_misc_questionmark.jpg';

@Component({
  selector: 'app-night-player-infographic',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './night-player-infographic.component.html',
  encapsulation: ViewEncapsulation.None,
})
export class NightPlayerInfographicComponent
  implements OnInit, AfterViewInit, OnDestroy
{
  private edgeFunctions = inject(EdgeFunctionsService);

  summary = input.required<NightPlayerSummary>();
  refreshing = input(false);
  closed = output<void>();
  refreshRequested = output<void>();

  @ViewChild('sheet') private sheet?: ElementRef<HTMLElement>;
  @ViewChild('closeButton') private closeButton?: ElementRef<HTMLButtonElement>;

  readonly sheetWidth = SHEET_WIDTH;
  readonly sheetHeight = signal(MIN_SHEET_HEIGHT);
  readonly exportWidth = Math.round(SHEET_WIDTH * EXPORT_PIXEL_RATIO);
  readonly exportHeight = computed(() =>
    Math.round(this.sheetHeight() * EXPORT_PIXEL_RATIO),
  );
  readonly exportStatus = signal<ExportStatus>('idle');
  readonly previewScale = signal(0.5);
  readonly fitToScreen = signal(true);
  readonly exportError = signal<string | null>(null);
  readonly iconUrls = signal<Record<number, string>>({});

  readonly classAccent = computed(
    () => classColor(this.summary().gearSnapshot?.class ?? this.summary().roster?.class) ?? '#b98bd0',
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
  readonly defensiveScore = computed(() => this.summary().nightReliability?.breakdown.defensiva ?? null);
  readonly defensiveTone = computed(() => {
    const score = this.defensiveScore();
    return score == null ? 'neutral' : score < 50 ? 'danger' : score < 75 ? 'warning' : 'success';
  });

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

  readonly issues = computed<PlayerIssue[]>(() => {
    const grouped = new Map<string, PlayerIssue>();
    const addFail = (fail: NightMechanicFailRow): void => {
      if (fail.mechanicId <= 0 || !this.isVerifiableName(fail.mechanicName)) return;
      const key = `${fail.bossId}|${fail.difficulty}|${fail.mechanicId}`;
      const issue = grouped.get(key) ?? this.newIssueFromFail(key, fail);
      issue.failCount++;
      issue.totalDamage += Math.max(0, fail.damageTaken);
      issue.occurrences.push({ pullNumber: fail.pullNumber, timeMs: fail.timeMs, kind: 'fallo' });
      grouped.set(key, issue);
    };
    const addDeath = (death: NightDeathRow): void => {
      if (death.mechanicId == null || !this.isVerifiableName(death.mechanicName)) return;
      const key = `${death.bossId}|${death.difficulty}|${death.mechanicId}`;
      const issue = grouped.get(key) ?? this.newIssueFromDeath(key, death);
      issue.deathCount++;
      issue.occurrences.push({ pullNumber: death.pullNumber, timeMs: death.timeMs, kind: 'muerte' });
      issue.availableDefensives.push(...death.defensivesAvailable);
      grouped.set(key, issue);
    };
    for (const fail of this.summary().mechanicFails) addFail(fail);
    for (const death of this.verifiableDeaths()) addDeath(death);
    return [...grouped.values()]
      .map((issue) => ({
        ...issue,
        availableDefensives: [...new Map(issue.availableDefensives.map((d) => [d.spellId, d])).values()],
        occurrences: issue.occurrences.sort(
          (a, b) => a.pullNumber - b.pullNumber || a.timeMs - b.timeMs,
        ),
      }))
      .sort(
        (a, b) =>
          b.deathCount - a.deathCount ||
          b.failCount - a.failCount ||
          b.totalDamage - a.totalDamage,
      );
  });

  readonly priorities = computed<PlayerPriority[]>(() => {
    const priorities: PlayerPriority[] = [];
    for (const issue of this.issues()) {
      const occurrences = issue.occurrences
        .slice(0, 4)
        .map((row) => `#${row.pullNumber} ${formatDuration(row.timeMs)}`)
        .join(' · ');
      let action: string | null = issue.resolution;
      if (!action && issue.availableDefensives.length) {
        action = `En esa ventana tenías ${issue.availableDefensives.map((d) => d.name).join(' / ')} disponible sin usar: deja uno preasignado para la próxima exposición.`;
      }
      if (!action && issue.failCount + issue.deathCount >= 2) {
        action = `Objetivo medible: cero repeticiones. Revisa en WCL ${occurrences} y fija la respuesta antes del siguiente pull.`;
      }
      if (!action) continue;
      priorities.push({
        title: issue.mechanicName,
        evidence: `${issue.failCount} fallo${issue.failCount === 1 ? '' : 's'} · ${issue.deathCount} muerte${issue.deathCount === 1 ? '' : 's'} · ${issue.bossName} ${occurrences}`,
        action,
        spellId: issue.mechanicId,
        kind: issue.availableDefensives.length ? 'defensive' : 'mechanic',
      });
      if (priorities.length === 3) break;
    }

    const execution = this.summary().execution;
    if (
      priorities.length < 4 &&
      execution.emergencyConsumableOpportunities > execution.emergencyConsumableUses
    ) {
      priorities.push({
        title: 'Piedra / poción de vida',
        evidence: `${execution.emergencyConsumableUses}/${execution.emergencyConsumableOpportunities} muertes evaluables con consumible de emergencia registrado en el try.`,
        action: 'Reserva piedra o poción para la siguiente ventana letal identificada; el objetivo es registrar respuesta en cada muerte con tiempo de reacción.',
        spellId: null,
        kind: 'consumable',
      });
    }

    const prep = this.summary().startingPreparation;
    const missingEnchants = prep
      ? Math.max(0, prep.enchantableSlotCount - prep.enchantedSlotCount)
      : 0;
    const missingGems = prep ? Math.max(0, prep.gemmableSlotCount - prep.gemmedSlotCount) : 0;
    if (priorities.length < 4 && (missingEnchants || missingGems)) {
      priorities.push({
        title: 'Preparación antes de entrar',
        evidence: `${missingEnchants} enchant${missingEnchants === 1 ? '' : 's'} y ${missingGems} slot${missingGems === 1 ? '' : 's'} de gema sin cubrir en el primer pull.`,
        action: 'Completa esos huecos antes de la próxima raid; la medición usa el primer pull y no penaliza equipo obtenido durante la noche.',
        spellId: null,
        kind: 'preparation',
      });
    }
    return priorities.slice(0, 4);
  });

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
        detail: this.summary().interrupts
          .slice(0, 3)
          .map((cut) => `${cut.mechanicName} #${cut.pullNumber} ${formatDuration(cut.timeMs)}`)
          .join(' · '),
        kind: 'interrupt',
      });
    }
    if (execution.evaluatedPulls > 0) {
      result.push({
        label: 'Pulls limpios personales',
        value: `${execution.cleanPulls}/${execution.evaluatedPulls}`,
        detail: 'Sin fallo de responsabilidad individual ni muerte evaluable.',
        kind: 'clean',
      });
    }
    const defensive = this.summary().defensiveSummary;
    if (defensive.pressurePulls > 0) {
      result.push({
        label: 'Respuesta defensiva',
        value: `${defensive.pressurePullsWithCast}/${defensive.pressurePulls}`,
        detail: 'Pulls con presión verificable y un defensivo registrado antes del wipe call.',
        kind: 'defensive',
      });
    }
    return result;
  });

  readonly pullRows = computed(() =>
    this.summary().pulls
      .filter((pull) => pull.pullScore != null)
      .map((pull) => ({
        ...pull,
        failCount: this.summary().mechanicFails.filter((fail) => fail.pullId === pull.pullId).length,
        evaluatedDeath: this.verifiableDeaths().find((death) => death.pullId === pull.pullId) ?? null,
      })),
  );

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
            (pulls.get(b.pullId) ?? Number.MAX_SAFE_INTEGER) ||
          a.timeMs - b.timeMs,
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
    (this.summary().defensiveSummary.pressurePullBreakdown ?? []).filter((p) => p.classification === 'never_touched'),
  );
  // §"agrupar por mecánica... que se lea fácil... nada por el camino"
  // (feedback real, 2026-08-29): sustituye a la vieja lista de tarjetas por
  // ventana fallada (mistimedPulls) — una fila por mecánica real, agregada
  // de toda la noche, con TODAS sus ocurrencias (cubiertas y falladas).
  readonly mechanicPressureBreakdown = computed<NightMechanicPressureSummary[]>(
    () => this.summary().defensiveSummary.mechanicPressureBreakdown ?? [],
  );
  readonly windowCoverageTotals = computed(() => {
    const rows = this.summary().defensiveSummary.pressurePullBreakdown ?? [];
    const missed = rows.reduce((sum, p) => sum + p.missedCount, 0);
    const covered = rows.reduce((sum, p) => sum + p.coveredCount, 0);
    // `coverable` aquí SÍ es el total (cubiertas + falladas) — distinto de
    // missedCount (solo las falladas) en NightPressurePullSummary. Nombres
    // distintos a propósito para no repetir la ambigüedad que tenía antes.
    return { coverable: missed + covered, covered };
  });

  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;

  formatDuration = formatDuration;
  formatPct = formatPct;
  categoryMeta = mechanicCategoryMeta;
  rootCauseLabel = (death: NightDeathRow): string =>
    rootCauseMeta(death.rootCause)?.label ?? mechanicCategoryMeta(death.category)?.label ?? 'Causa no clasificada';

  ngOnInit(): void {
    void this.loadSpellIcons();
  }

  ngAfterViewInit(): void {
    const element = this.sheet?.nativeElement;
    if (element && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.updateSheetSize());
      this.resizeObserver.observe(element);
    }
    queueMicrotask(() => {
      this.updateSheetSize();
      this.closeButton?.nativeElement.focus();
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

  async sendToDiscord(): Promise<void> {
    const channelId = this.summary().discordChannel?.discordChannelId;
    if (!channelId) return;
    this.exportError.set(null);
    try {
      const blob = await this.renderDiscordImage();
      const base64 = await this.blobToBase64(blob);
      this.exportStatus.set('sendingDiscord');
      const date = this.summary().reportDate
        ? new Date(this.summary().reportDate).toLocaleDateString('es-ES', {
            day: 'numeric',
            month: 'long',
          })
        : this.summary().reportTitle;
      await this.edgeFunctions.sendDiscordMessage({
        channelId,
        content: `Informe de combate de ${this.summary().playerName} · ${date}`,
        imageBase64: base64,
        imageFilename: this.filename('jpg'),
      });
      this.setStatus('sentDiscord');
    } catch (err) {
      this.exportError.set(errorMessage(err));
      this.setStatus('error');
    }
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

  pullScoreWidth(score: number | null): number {
    return Math.max(2, Math.min(100, (score ?? 0) * 100));
  }

  pullTone(score: number | null): string {
    if (score == null) return 'neutral';
    return score < 0.5 ? 'danger' : score < 0.75 ? 'warning' : 'success';
  }

  occurrenceList(issue: PlayerIssue, limit = 5): string {
    return issue.occurrences
      .slice(0, limit)
      .map((row) => `#${row.pullNumber} ${formatDuration(row.timeMs)}`)
      .join(' · ');
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
    return mechanic.totalCount > 0 ? Math.round((mechanic.coveredCount / mechanic.totalCount) * 100) : 0;
  }

  mechanicTone(mechanic: NightMechanicPressureSummary): 'danger' | 'warning' | 'success' {
    const pct = this.mechanicRatioPct(mechanic);
    return pct < 40 ? 'danger' : pct < 75 ? 'warning' : 'success';
  }

  consumableResponseLabel(death: DefensiveMissDeath): string {
    if (death.usedHealthstoneInPull && death.usedHealthPotionInPull) {
      return 'Piedra + poción registradas en el try';
    }
    if (death.usedHealthstoneInPull) return 'Piedra registrada en el try';
    if (death.usedHealthPotionInPull) return 'Poción registrada en el try';
    return 'Sin piedra ni poción registradas en el try';
  }

  private newIssueFromFail(key: string, fail: NightMechanicFailRow): PlayerIssue {
    return {
      key,
      mechanicId: fail.mechanicId,
      mechanicName: fail.mechanicName,
      bossName: fail.bossName,
      difficulty: fail.difficulty,
      category: fail.category,
      failCount: 0,
      deathCount: 0,
      totalDamage: 0,
      occurrences: [],
      resolution: fail.resolution,
      note: fail.aiNote,
      availableDefensives: [],
    };
  }

  private newIssueFromDeath(key: string, death: NightDeathRow): PlayerIssue {
    return {
      key,
      mechanicId: death.mechanicId!,
      mechanicName: death.mechanicName!,
      bossName: death.bossName,
      difficulty: death.difficulty,
      category: death.category,
      failCount: 0,
      deathCount: 0,
      totalDamage: 0,
      occurrences: [],
      resolution: death.resolution,
      note: death.aiNote,
      availableDefensives: [],
    };
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
  private nearestDefensiveCast(pullId: string, timeMs: number): (NightDefensiveCast & { offsetMs: number }) | null {
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

  private async renderDiscordImage(): Promise<Blob> {
    if (!this.sheet) throw new Error('La infografía aún no está lista.');
    this.exportStatus.set('rendering');
    await this.waitForVisuals();
    const height = Math.max(MIN_SHEET_HEIGHT, Math.ceil(this.sheet.nativeElement.scrollHeight));
    let pixelRatio = Math.max(1, Math.min(EXPORT_PIXEL_RATIO, 16_000 / height));
    let lastBlob: Blob | null = null;
    for (let attempt = 0; attempt < DISCORD_RENDER_ATTEMPTS; attempt++) {
      const canvas = await toCanvas(this.sheet.nativeElement, {
        width: SHEET_WIDTH,
        height,
        pixelRatio,
        backgroundColor: '#07070d',
        cacheBust: true,
        skipFonts: true,
      });
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', DISCORD_JPEG_QUALITY),
      );
      if (!blob) throw new Error('No se pudo crear la imagen para Discord.');
      lastBlob = blob;
      if (blob.size <= DISCORD_MAX_BYTES) return blob;
      pixelRatio *= 0.72;
    }
    const sizeMb = lastBlob ? (lastBlob.size / 1024 / 1024).toFixed(1) : '?';
    throw new Error(`La imagen sigue pesando ${sizeMb} MB incluso reducida.`);
  }

  private async waitForVisuals(): Promise<void> {
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
    for (const issue of this.issues()) ids.add(issue.mechanicId);
    for (const priority of this.priorities()) if (priority.spellId) ids.add(priority.spellId);
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

  private filename(extension: 'png' | 'jpg'): string {
    const player = this.summary().playerName.toLocaleLowerCase('es-ES').replace(/[^a-z0-9]+/g, '-');
    return `iris-${player}-${this.summary().reportCode}.${extension}`;
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
