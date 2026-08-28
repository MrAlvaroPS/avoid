import { DatePipe, NgTemplateOutlet } from '@angular/common';
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
import { formatDuration, formatPct } from '../../shared/format.util';
import type { NightFullReport, NightReportTrend } from '../../shared/models/night-full-report';
import { bilingualName } from './night-full-report-markdown';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { errorMessage } from '../../shared/error-message.util';

// §"dejar preparada una capa para interactuar en discord para enviar la
// infografía directamente a discord" (feedback real, 2026-08-27): reutiliza
// renderPng() (ya existía para copiar/descargar) — la infografía en sí no
// cambia nada, solo se añade un tercer destino para la misma imagen.
type ExportStatus = 'idle' | 'rendering' | 'copied' | 'downloaded' | 'sendingDiscord' | 'sentDiscord' | 'error';
// §"IRIS siempre escribirá en el canal ID X, que es el que he creado para
// ella" (feedback real, 2026-08-27): fijo — no es secreto (un ID de canal
// no da acceso a nada por sí solo, el bot token sigue solo en Supabase),
// así que vive aquí igual que cualquier otra constante de config del
// frontend en vez de pedirlo cada vez o guardarlo en localStorage.
const DEFAULT_DISCORD_CHANNEL_ID = '1542517353525284984';

interface InfographicPriority {
  title: string;
  detail: string;
  note: string | null;
  spellId: number | null;
  category: string | null;
}

const SHEET_WIDTH = 2560;
const MIN_SHEET_HEIGHT = 1500;
// 2560 × 1.8 = 4608 px de ancho. El lienzo base más panorámico permite
// aumentar la tipografía y reducir la altura sin sacrificar información;
// la exportación 4.6K conserva detalle tras la recompresión de Discord.
const EXPORT_PIXEL_RATIO = 1.8;
// §"Discord devolvió HTTP 413: Request entity too large" (feedback real,
// 2026-08-27): el PNG sin pérdida a 4.6K de ancho podía superar los ~10MB
// que Discord acepta de subida en un guild sin boost. La recompresión
// generosa de su CDN (el motivo original del ancho 4.6K, ver el comentario
// de EXPORT_PIXEL_RATIO) pasa DESPUÉS de aceptar la subida — este 413
// ocurre antes, en la propia ingesta, y no hay recompresión que valga si
// ni siquiera la acepta. Solo para el envío a Discord: JPEG en vez de PNG
// (mucho más pequeño para este tipo de contenido, con calidad de sobra
// para una vista previa de chat) + reintento a menos resolución si aun
// así no cupiera. Copiar portapapeles/descargar siguen en PNG sin pérdida
// vía renderPng() — ahí no hay límite de tamaño que cumplir.
const DISCORD_MAX_BYTES = 8 * 1024 * 1024; // margen bajo los ~10MB base de Discord (guilds con boost admiten más, pero no hay forma de saber el nivel desde aquí)
const DISCORD_JPEG_QUALITY = 0.9;
const DISCORD_RENDER_ATTEMPTS = 4;
const FALLBACK_ICON_URL =
  'https://wow.zamimg.com/images/wow/icons/large/inv_misc_questionmark.jpg';
const BOSS_ARTWORKS: Record<string, string> = {
  'nekzali the soulcoiler': 'https://wow.zamimg.com/optimized/guide-header-revamp/uploads/guide/header/f2ae26185b3e0558f0a4e650b0c27d30380c9f99.jpg',
  'entombed sentinels': 'https://wow.zamimg.com/optimized/guide-header-revamp/uploads/guide/header/efcce5e7e8f3b1804d19121260df8411338144ce.jpg',
  'vashnik the malignant': 'https://wow.zamimg.com/optimized/guide-header-revamp/uploads/guide/header/f9f43b4f5abb79d2c6cf8e0d885b95ac59fbd3b0.jpg',
  'the lost explorers': 'https://wow.zamimg.com/optimized/guide-header-revamp/uploads/guide/header/19bd46c0a77441577821e056dbd5cc5c09ae87b5.jpg',
  sszorak: 'https://wow.zamimg.com/optimized/guide-header-revamp/uploads/guide/header/127fb15e24c99767521d3697f97ef6e98181357e.jpg',
  'the twin fangs': 'https://wow.zamimg.com/optimized/guide-header-revamp/uploads/guide/header/52e498e3108b56f88a49f5fe5afa33eb6578a713.jpg',
  'the coiled altar': 'https://wow.zamimg.com/optimized/guide-header-revamp/uploads/guide/header/0b550745443dcd767f6cb4e4f8e23e14089dcd88.jpg',
  ulatek: 'https://wow.zamimg.com/optimized/guide-header-revamp/uploads/guide/header/20ff0eaaeb6117c9a8fcbb76792789b3e01341ce.jpg',
};

@Component({
  selector: 'app-night-report-infographic',
  standalone: true,
  imports: [DatePipe, NgTemplateOutlet],
  templateUrl: './night-report-infographic.component.html',
  encapsulation: ViewEncapsulation.None,
})
export class NightReportInfographicComponent implements OnInit, AfterViewInit, OnDestroy {
  private edgeFunctions = inject(EdgeFunctionsService);

  report = input.required<NightFullReport>();
  generatedAt = input.required<string>();
  closed = output<void>();

  @ViewChild('sheet') private sheet?: ElementRef<HTMLElement>;
  @ViewChild('closeButton') private closeButton?: ElementRef<HTMLButtonElement>;

  readonly sheetWidth = SHEET_WIDTH;
  readonly sheetHeight = signal(MIN_SHEET_HEIGHT);
  readonly exportWidth = Math.round(SHEET_WIDTH * EXPORT_PIXEL_RATIO);
  readonly exportHeight = computed(() => Math.round(this.sheetHeight() * EXPORT_PIXEL_RATIO));
  readonly exportStatus = signal<ExportStatus>('idle');
  readonly previewScale = signal(0.6);
  readonly discordError = signal<string | null>(null);
  readonly fitToScreen = signal(true);
  readonly iconUrls = signal<Record<number, string>>({});
  readonly bossArtworkFailed = signal(false);
  readonly priorityCards = computed<InfographicPriority[]>(() =>
    this.report()
      .priorities.slice(0, 3)
      .map((priority) => {
        const mechanic = this.findMechanic(priority.title);
        return {
          title: priority.title,
          detail: priority.detail,
          note: priority.note,
          spellId: mechanic?.wowheadSpellId ?? null,
          category: mechanic && 'category' in mechanic ? mechanic.category : null,
        };
      }),
  );
  readonly progressPercent = computed(() => {
    const remaining = this.report().summary.progressBoss?.bestWipePct;
    return remaining == null ? 0 : Math.max(0, Math.min(100, 100 - remaining));
  });
  readonly progressBossName = computed(() => {
    const progress = this.report().summary.progressBoss;
    return progress
      ? bilingualName(progress.bossName, progress.bossNameEs)
      : 'Noche completada';
  });
  readonly topLethal = computed(() => this.report().deaths.topFinalBlows[0] ?? null);
  readonly timelinePatterns = computed(() => this.report().timelinePatterns);
  readonly featuredMechanics = computed(() =>
    [...this.report().mechanics]
      .sort((left, right) =>
        Number(right.isProgressBoss) - Number(left.isProgressBoss)
        || right.lethalFinalBlows - left.lethalFinalBlows
        || right.totalFails - left.totalFails,
      )
      .slice(0, 5),
  );
  readonly roleMechanicHighlights = computed(() => {
    const mechanics = this.report().mechanics;
    return Object.fromEntries(
      (['tank', 'healer', 'dps'] as const).map((responsibility) => [
        responsibility,
        mechanics
          .filter((mechanic) =>
            mechanic.responsibility === responsibility
            && (mechanic.totalFails > 0 || mechanic.lethalFinalBlows > 0),
          )
          .sort((left, right) =>
            Number(right.isProgressBoss) - Number(left.isProgressBoss)
            || right.lethalFinalBlows - left.lethalFinalBlows
            || right.totalFails - left.totalFails,
          )
          .slice(0, 2),
      ]),
    ) as Record<'tank' | 'healer' | 'dps', NightFullReport['mechanics']>;
  });
  readonly sharedMechanicHighlights = computed(() => {
    const mechanics = this.report().mechanics;
    return Object.fromEntries(
      (['raid', 'personal'] as const).map((responsibility) => [
        responsibility,
        mechanics
          .filter((mechanic) =>
            mechanic.responsibility === responsibility
            && (mechanic.totalFails > 0 || mechanic.lethalFinalBlows > 0),
          )
          .sort((left, right) =>
            Number(right.isProgressBoss) - Number(left.isProgressBoss)
            || right.lethalFinalBlows - left.lethalFinalBlows
            || right.totalFails - left.totalFails,
          )
          .slice(0, 2),
      ]),
    ) as Record<'raid' | 'personal', NightFullReport['mechanics']>;
  });
  readonly bossArtworkUrl = computed(() => {
    const bossName = this.report().summary.progressBoss?.bossName ?? this.report().summary.bestPull?.bossName;
    return bossName ? BOSS_ARTWORKS[this.normalize(bossName).replace(/[^a-z0-9 ]/g, '')] ?? null : null;
  });

  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;

  formatDuration = formatDuration;
  formatPct = formatPct;
  bilingualName = bilingualName;

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
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.closed.emit();
    }
  }

  toggleZoom(): void {
    this.fitToScreen.update((value) => !value);
    this.previewScale.set(this.fitToScreen() ? this.calculateFitScale() : 1);
  }

  iconUrl(spellId: number | null): string | null {
    if (!spellId) return null;
    return this.iconUrls()[spellId] ?? null;
  }

  onIconError(event: Event): void {
    const image = event.currentTarget as HTMLImageElement;
    if (!image.src.endsWith('inv_misc_questionmark.jpg')) image.src = FALLBACK_ICON_URL;
  }

  onBossArtworkError(): void {
    this.bossArtworkFailed.set(true);
    queueMicrotask(() => this.updateSheetSize());
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
    this.discordError.set(null);
    try {
      const blob = await this.renderDiscordImage();
      const base64 = await this.blobToBase64(blob);
      this.exportStatus.set('sendingDiscord');
      await this.edgeFunctions.sendDiscordMessage({
        channelId: DEFAULT_DISCORD_CHANNEL_ID,
        imageBase64: base64,
        imageFilename: `iris-informe-combate-${this.report().reportCode}.jpg`,
      });
      this.setStatus('sentDiscord');
    } catch (err) {
      this.discordError.set(errorMessage(err));
      this.setStatus('error');
    }
  }

  // §"Discord devolvió HTTP 413" (feedback real, 2026-08-27): ver el
  // comentario de DISCORD_MAX_BYTES arriba — JPEG en vez del PNG de
  // renderPng(), con reintentos a menos resolución si aun así no cupiera
  // (un informe con muchos bosses da una imagen más alta de partida).
  // toCanvas (no toBlob) porque el propio wrapper toBlob de html-to-image
  // no deja elegir formato/calidad, solo canvas.toBlob nativo lo permite.
  private async renderDiscordImage(): Promise<Blob> {
    if (!this.sheet) throw new Error('No se pudo generar la imagen: la infografía no está lista todavía.');
    this.exportStatus.set('rendering');
    await this.waitForVisuals();
    const height = Math.max(MIN_SHEET_HEIGHT, Math.ceil(this.sheet.nativeElement.scrollHeight));
    let pixelRatio = Math.max(1, Math.min(EXPORT_PIXEL_RATIO, 14_000 / height));
    let lastBlob: Blob | null = null;
    for (let attempt = 0; attempt < DISCORD_RENDER_ATTEMPTS; attempt++) {
      const canvas = await toCanvas(this.sheet.nativeElement, {
        width: SHEET_WIDTH,
        height,
        pixelRatio,
        backgroundColor: '#080711',
        cacheBust: true,
        skipFonts: true,
      });
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', DISCORD_JPEG_QUALITY));
      if (!blob) throw new Error('No se pudo crear la imagen para Discord.');
      lastBlob = blob;
      if (blob.size <= DISCORD_MAX_BYTES) return blob;
      pixelRatio *= 0.7;
    }
    const sizeMb = lastBlob ? (lastBlob.size / 1024 / 1024).toFixed(1) : '?';
    throw new Error(`La infografía sigue pesando ${sizeMb} MB incluso reducida — supera el límite de subida de Discord. Prueba "Descargar PNG" y súbela a mano al canal.`);
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.onerror = () => reject(reader.error ?? new Error('No se pudo leer la imagen generada.'));
      reader.readAsDataURL(blob);
    });
  }

  statValue(value: number): string {
    return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(value);
  }

  bossProgressLabel(boss: NightFullReport['summary']['bosses'][number]): string {
    return boss.kills > 0 ? 'KILL' : `${formatPct(boss.bestWipePct)} vida`;
  }

  trendLabel(trend: NightReportTrend): string {
    return {
      improving: 'MEJORA',
      worsening: 'A VIGILAR',
      flat: 'ESTABLE',
      insufficient_data: 'SIN MUESTRA',
    }[trend];
  }

  deltaLabel(value: number | null): string {
    if (value == null) return 'sin dato';
    return `${value > 0 ? '+' : ''}${formatPct(value)}`;
  }

  compactNumber(value: number | null): string {
    if (value == null) return '—';
    return new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }

  timelinePosition(offsetMs: number): number {
    const patterns = this.timelinePatterns();
    const before = patterns?.windowBeforeMs ?? 12_000;
    const after = patterns?.windowAfterMs ?? 12_000;
    return Math.max(3, Math.min(97, ((offsetMs + before) / (before + after)) * 100));
  }

  timelineOffsetLabel(offsetMs: number): string {
    if (offsetMs === 0) return 'EVENTO CENTRAL';
    const seconds = Math.max(1, Math.round(Math.abs(offsetMs) / 1_000));
    return `${offsetMs < 0 ? '−' : '+'}${seconds} s`;
  }

  timelineOutcomeLabel(outcome: 'clean' | 'partial_fail' | 'fail' | null): string {
    return outcome === 'fail' ? 'FALLO' : outcome === 'partial_fail' ? 'FALLO PARCIAL' : 'OBSERVADO';
  }

  pullList(pulls: number[]): string {
    return pulls.map((pull) => `#${pull}`).join(', ');
  }

  responsibilityMetric(responsibility: string): NightFullReport['responsibilities']['byResponsibility'][number] | null {
    return this.report().responsibilities.byResponsibility.find((entry) => entry.responsibility === responsibility) ?? null;
  }

  private async renderPng(): Promise<Blob | null> {
    if (!this.sheet || this.exportStatus() === 'rendering') return null;
    this.exportStatus.set('rendering');

    try {
      await this.waitForVisuals();
      const height = Math.max(MIN_SHEET_HEIGHT, Math.ceil(this.sheet.nativeElement.scrollHeight));
      const pixelRatio = Math.max(1, Math.min(EXPORT_PIXEL_RATIO, 14_000 / height));
      const blob = await toBlob(this.sheet.nativeElement, {
        width: SHEET_WIDTH,
        height,
        pixelRatio,
        backgroundColor: '#080711',
        cacheBust: true,
        skipFonts: true,
      });
      if (!blob) throw new Error('No se pudo crear el PNG');
      return blob;
    } catch (error) {
      console.error('No se pudo exportar la infografía', error);
      this.setStatus('error');
      return null;
    }
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
          // El fallback visual mantiene la lámina exportable si un icono remoto falla.
        }
      }),
    );
  }

  private downloadBlob(blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `iris-informe-combate-${this.report().reportCode}.png`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  private setStatus(status: Exclude<ExportStatus, 'idle' | 'rendering'>): void {
    this.exportStatus.set(status);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.exportStatus.set('idle'), 3_000);
  }

  private updatePreviewScale(): void {
    this.previewScale.set(this.calculateFitScale());
  }

  private calculateFitScale(): number {
    const widthScale = (window.innerWidth - 40) / SHEET_WIDTH;
    const heightScale = (window.innerHeight - 116) / this.sheetHeight();
    return Math.max(0.22, Math.min(1, widthScale, heightScale));
  }

  private updateSheetSize(): void {
    const height = Math.max(MIN_SHEET_HEIGHT, Math.ceil(this.sheet?.nativeElement.scrollHeight ?? 0));
    if (height !== this.sheetHeight()) this.sheetHeight.set(height);
    if (this.fitToScreen()) this.updatePreviewScale();
  }

  private findMechanic(title: string):
    | NightFullReport['mechanics'][number]
    | NightFullReport['deaths']['topFinalBlows'][number]
    | null {
    const normalizedTitle = this.normalize(title);
    const candidates = [...this.report().mechanics, ...this.report().deaths.topFinalBlows];
    return (
      candidates.find((mechanic) =>
        [mechanic.mechanicName, mechanic.mechanicNameEs]
          .filter((name): name is string => Boolean(name))
          .some((name) => normalizedTitle.includes(this.normalize(name))),
      ) ?? null
    );
  }

  private normalize(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  private async loadSpellIcons(): Promise<void> {
    const spellIds = new Set<number>();
    for (const priority of this.priorityCards()) {
      if (priority.spellId) spellIds.add(priority.spellId);
    }
    const lethalSpellId = this.topLethal()?.wowheadSpellId;
    if (lethalSpellId) spellIds.add(lethalSpellId);
    for (const mechanic of this.featuredMechanics()) {
      if (mechanic.wowheadSpellId) spellIds.add(mechanic.wowheadSpellId);
    }
    for (const timeline of this.timelinePatterns()?.timelines ?? []) {
      if (timeline.anchorWowheadSpellId) spellIds.add(timeline.anchorWowheadSpellId);
      for (const marker of timeline.markers) {
        if (marker.wowheadSpellId) spellIds.add(marker.wowheadSpellId);
      }
    }

    const entries = await Promise.all(
      [...spellIds].map(async (spellId): Promise<[number, string] | null> => {
        try {
          const response = await fetch(`https://nether.wowhead.com/tooltip/spell/${spellId}`);
          if (!response.ok) return null;
          const payload = (await response.json()) as { icon?: string };
          if (!payload.icon) return null;
          return [spellId, `https://wow.zamimg.com/images/wow/icons/large/${payload.icon}.jpg`];
        } catch {
          return null;
        }
      }),
    );

    this.iconUrls.set(Object.fromEntries(entries.filter((entry): entry is [number, string] => entry !== null)));
    queueMicrotask(() => this.updateSheetSize());
  }
}
