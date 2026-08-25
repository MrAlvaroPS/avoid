import { DatePipe } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ViewEncapsulation,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  input,
  output,
  signal,
} from '@angular/core';
import { toBlob } from 'html-to-image';
import { formatDuration, formatPct } from '../../shared/format.util';
import type { NightFullReport, NightReportTrend } from '../../shared/models/night-full-report';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import { bilingualName, buildNightDiscordSummary, buildNightFullReportMarkdown } from './night-full-report-markdown';
import { NightReportInfographicComponent } from './night-report-infographic.component';

@Component({
  selector: 'app-night-full-report-modal',
  standalone: true,
  imports: [DatePipe, WowheadLinkComponent, NightReportInfographicComponent],
  templateUrl: './night-full-report-modal.component.html',
  encapsulation: ViewEncapsulation.None,
})
export class NightFullReportModalComponent implements AfterViewInit, OnDestroy {
  report = input.required<NightFullReport>();
  generatedAt = input.required<string>();
  closed = output<void>();

  @ViewChild('dialog') private dialog?: ElementRef<HTMLElement>;
  @ViewChild('closeButton') private closeButton?: ElementRef<HTMLButtonElement>;

  copyStatus = signal<'idle' | 'discord' | 'full' | 'error'>('idle');
  imageStatus = signal<'idle' | 'rendering' | 'downloaded' | 'error'>('idle');
  infographicOpen = signal(false);
  private previousActiveElement: HTMLElement | null = null;
  private previousBodyOverflow = '';
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  formatDuration = formatDuration;
  formatPct = formatPct;
  bilingualName = bilingualName;

  ngAfterViewInit(): void {
    this.previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    queueMicrotask(() => this.closeButton?.nativeElement.focus());
  }

  ngOnDestroy(): void {
    document.body.style.overflow = this.previousBodyOverflow;
    this.previousActiveElement?.focus();
    if (this.copyTimer) clearTimeout(this.copyTimer);
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (this.infographicOpen()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closed.emit();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = this.dialog?.nativeElement.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closed.emit();
  }

  async copyDiscordSummary(): Promise<void> {
    try {
      await navigator.clipboard.writeText(buildNightDiscordSummary(this.report()));
      this.setCopyStatus('discord');
    } catch {
      this.setCopyStatus('error');
    }
  }

  async copyFullMarkdown(): Promise<void> {
    try {
      await navigator.clipboard.writeText(buildNightFullReportMarkdown(this.report(), this.generatedAt()));
      this.setCopyStatus('full');
    } catch {
      this.setCopyStatus('error');
    }
  }

  async downloadFullReportPng(): Promise<void> {
    const source = this.dialog?.nativeElement;
    if (!source || this.imageStatus() === 'rendering') return;
    this.imageStatus.set('rendering');

    const clone = source.cloneNode(true) as HTMLElement;
    clone.setAttribute('aria-hidden', 'true');
    clone.classList.add('report-dialog-export');
    clone.querySelector('.dialog-footer')?.remove();
    clone.querySelector('.limitations')?.remove();
    clone.querySelector('.icon-button')?.remove();

    const width = Math.max(960, Math.round(source.getBoundingClientRect().width));
    Object.assign(clone.style, {
      position: 'fixed',
      inset: 'auto',
      left: '-20000px',
      top: '0',
      width: `${width}px`,
      maxHeight: 'none',
      height: 'auto',
      overflow: 'visible',
    });
    const body = clone.querySelector<HTMLElement>('.dialog-body');
    if (body) Object.assign(body.style, { overflow: 'visible', maxHeight: 'none', height: 'auto' });
    (source.parentElement ?? document.body).appendChild(clone);

    try {
      await document.fonts?.ready;
      await this.waitForImages(clone);
      const height = clone.scrollHeight;
      const pixelRatio = Math.max(1, Math.min(1.6, 14_000 / Math.max(1, height)));
      const blob = await toBlob(clone, {
        width,
        height,
        pixelRatio,
        backgroundColor: '#080810',
        cacheBust: true,
        skipFonts: true,
        style: {
          position: 'static',
          inset: 'auto',
          left: 'auto',
          top: 'auto',
          margin: '0',
          transform: 'none',
        },
      });
      if (!blob) throw new Error('No se pudo crear el PNG');
      this.downloadBlob(blob, `iris-informe-completo-${this.report().reportCode}.png`);
      this.setImageStatus('downloaded');
    } catch (error) {
      console.error('No se pudo exportar el informe completo', error);
      this.setImageStatus('error');
    } finally {
      clone.remove();
    }
  }

  compactNumber(value: number | null): string {
    if (value == null) return '—';
    return new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }

  trendLabel(trend: NightReportTrend): string {
    return {
      improving: 'Mejora',
      worsening: 'Empeora',
      flat: 'Estable',
      insufficient_data: 'Muestra insuficiente',
    }[trend];
  }

  deltaLabel(value: number | null): string {
    if (value == null) return 'Sin dato comparable';
    return `${value > 0 ? '+' : ''}${formatPct(value)}`;
  }

  private setCopyStatus(status: 'discord' | 'full' | 'error'): void {
    this.copyStatus.set(status);
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.copyStatus.set('idle'), 2_500);
  }

  private async waitForImages(root: HTMLElement): Promise<void> {
    const images = Array.from(root.querySelectorAll('img'));
    await Promise.all(
      images.map(async (image) => {
        if (image.complete) return;
        try {
          await image.decode();
        } catch {
          // Un recurso externo que falle no debe bloquear el resto del informe.
        }
      }),
    );
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  private setImageStatus(status: 'downloaded' | 'error'): void {
    this.imageStatus.set(status);
    setTimeout(() => this.imageStatus.set('idle'), 3_000);
  }
}
