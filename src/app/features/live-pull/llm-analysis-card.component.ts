// Colocar en: src/app/features/live-pull/llm-analysis-card.component.ts
// §"un botón para copiar el prompt completo... y un botón para pegar el
// resultado... procesarlo como si fuese a través de la API" (feedback
// real): vía manual para conseguir el análisis SIN gastar la
// ANTHROPIC_API_KEY propia de la app — copia el prompt exacto, se pega en
// cualquier chat de LLM (o el mismo Claude), se pega la respuesta de
// vuelta aquí, y se guarda exactamente igual que si hubiera venido de la
// API real (manual-pull-brief hace el mismo parseo, mismo pull_briefs).
//
// §"meter en el dosier de un jugador y en el resumen de toda la noche
// completa también la consulta de IA... como hemos hecho en otras partes
// de la aplicación" (feedback real, 2026-08-24): generalizado con `scope`
// para los tres ámbitos que ya existen en el resto de la app — un pull
// concreto, un jugador×noche (dosier) y una raid×noche (informe) —
// reutilizando la MISMA tarjeta en vez de triplicar ~140 líneas de plantilla.
import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { mapBrief } from '../../core/pull-analysis.service';
import { BriefTextComponent, EMPTY_BRIEF_ENTITIES, annotateBriefTextForCopy, collectBriefNotes, type BriefEntities } from '../../shared/brief-text.component';
import type { LlmPullAnalysis } from '../../shared/models/ui';
import { errorMessage } from '../../shared/error-message.util';

export type LlmAnalysisScope = 'pull' | 'night-player' | 'night';

@Component({
  selector: 'app-llm-analysis-card',
  standalone: true,
  imports: [BriefTextComponent],
  templateUrl: './llm-analysis-card.component.html',
  styleUrl: './llm-analysis-card.component.scss',
})
export class LlmAnalysisCardComponent {
  private edgeFunctions = inject(EdgeFunctionsService);

  scope = input<LlmAnalysisScope>('pull');
  /** Obligatorio solo para scope:'pull'. */
  pullId = input<string | null>(null);
  /** Obligatorio para scope:'night-player' y scope:'night'. */
  reportCode = input<string | null>(null);
  /** Obligatorio solo para scope:'night-player'. */
  playerName = input<string | null>(null);

  /** §"pintar cada jugador de su clase, mecánicas con tooltip+nota, categorías con distintivo" (feedback real): entidades conocidas de ESTE ámbito, para que app-brief-text las reconozca dentro de la prosa que devuelve el LLM. */
  entities = input<BriefEntities>(EMPTY_BRIEF_ENTITIES);

  analysis = input.required<LlmPullAnalysis | null>();
  generating = input(false);
  error = input<string | null>(null);
  generateRequested = output<void>();
  /** El padre solo necesita saber "esto es el nuevo análisis" — el propio guardado ya lo hizo el endpoint manual correspondiente, esto es para refrescar la vista sin recargar todo lo demás. */
  manualBriefSaved = output<LlmPullAnalysis>();

  manualPanelOpen = signal(false);
  loadingPrompt = signal(false);
  promptError = signal<string | null>(null);
  systemPrompt = signal<string | null>(null);
  userMessage = signal<string | null>(null);
  copied = signal(false);

  pasteText = signal('');
  submitting = signal(false);
  submitError = signal<string | null>(null);

  // §"recap copiable para Discord... poder copiar ese informe de IA para
  // pasarlo": el análisis IA ya es el resumen más legible que existe —
  // copiarlo tal cual en texto plano (sin JSON, sin markup) es la vía
  // natural de pegarlo en el Discord de la guild, sin un mecanismo de
  // export nuevo por ámbito.
  copyBriefStatus = signal<'idle' | 'copied' | 'error'>('idle');

  nextActionsLabel = computed(() => {
    switch (this.scope()) {
      case 'night-player':
        return 'Próximo enfoque con este jugador';
      case 'night':
        return 'Prioridades próxima noche';
      default:
        return 'Próximo intento';
    }
  });

  private subjectKey(): string {
    switch (this.scope()) {
      case 'night-player':
        return `${this.reportCode() ?? ''}|${this.playerName() ?? ''}`;
      case 'night':
        return this.reportCode() ?? '';
      default:
        return this.pullId() ?? '';
    }
  }

  // §bug real (feedback: "si uso el análisis de IA en un boss y luego me voy
  // a otro boss y lo vuelvo a usar, el prompt está persistiendo y no
  // reanaliza"): este componente se reutiliza entre pulls/jugadores/noches
  // sin destruirse (mismo selector en el árbol, solo cambian los inputs) —
  // sin este reset, systemPrompt()/userMessage() seguían siendo los del
  // sujeto anterior, y el guard de openManualPanel() ("ya traído, no
  // repetir la llamada") ni siquiera volvía a pedirlos para el nuevo.
  constructor() {
    let prevKey: string | null = null;
    effect(() => {
      const key = this.subjectKey();
      if (prevKey !== null && key !== prevKey) {
        this.manualPanelOpen.set(false);
        this.systemPrompt.set(null);
        this.userMessage.set(null);
        this.pasteText.set('');
        this.copied.set(false);
        this.promptError.set(null);
        this.submitError.set(null);
        this.copyBriefStatus.set('idle');
      }
      prevKey = key;
    });
  }

  async copyBriefForDiscord(): Promise<void> {
    const a = this.analysis();
    if (!a) return;
    // §"incluir en el propio informe que se copia a discord también lo que
    // viene en la información de mecánica" → refinado: "en lugar de
    // acompañar [nota: ...] en cada habilidad... una nueva sección NOTAS...
    // una sola vez por habilidad, así no ensuciamos tanto el informe"
    // (feedback real): el cuerpo queda limpio (solo nombres + categorías/
    // causas traducidas), las notas se centralizan al final, una vez por mecánica.
    const ents = this.entities();
    const annotate = (text: string) => annotateBriefTextForCopy(text, ents);
    const lines = [`🎯 ${annotate(a.headline)}`, ''];
    if (a.improved.length) lines.push('✅ Bien', ...a.improved.map((i) => `- ${annotate(i)}`), '');
    if (a.regressed.length) lines.push('⚠️ Mal', ...a.regressed.map((i) => `- ${annotate(i)}`), '');
    if (a.nextPullActions.length) lines.push(`➡️ ${this.nextActionsLabel()}`, ...a.nextPullActions.map((i) => `- ${annotate(i)}`));

    const notes = collectBriefNotes([a.headline, ...a.improved, ...a.regressed, ...a.nextPullActions], ents);
    if (notes.length) lines.push('', '📝 Notas', ...notes.map((n) => `- ${n.name}: ${n.note}`));

    try {
      await navigator.clipboard.writeText(lines.join('\n').trim());
      this.copyBriefStatus.set('copied');
      setTimeout(() => this.copyBriefStatus.set('idle'), 2000);
    } catch {
      this.copyBriefStatus.set('error');
      setTimeout(() => this.copyBriefStatus.set('idle'), 2000);
    }
  }

  async openManualPanel(): Promise<void> {
    this.manualPanelOpen.set(true);
    if (this.systemPrompt() != null) return; // ya traído, no repetir la llamada
    this.loadingPrompt.set(true);
    this.promptError.set(null);
    try {
      let res: { systemPrompt: string; userMessage: string };
      switch (this.scope()) {
        case 'night-player':
          res = await this.edgeFunctions.getManualNightPlayerBriefPrompt(this.reportCode()!, this.playerName()!);
          break;
        case 'night':
          res = await this.edgeFunctions.getManualNightBriefPrompt(this.reportCode()!);
          break;
        default:
          res = await this.edgeFunctions.getManualPullBriefPrompt(this.pullId()!);
      }
      this.systemPrompt.set(res.systemPrompt);
      this.userMessage.set(res.userMessage);
    } catch (err) {
      this.promptError.set(errorMessage(err));
    } finally {
      this.loadingPrompt.set(false);
    }
  }

  closeManualPanel(): void {
    this.manualPanelOpen.set(false);
    this.pasteText.set('');
    this.submitError.set(null);
  }

  get fullPromptText(): string {
    return `${this.systemPrompt() ?? ''}\n\n---\n\n${this.userMessage() ?? ''}`;
  }

  async copyPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.fullPromptText);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch (err) {
      this.promptError.set('No se pudo copiar automáticamente — selecciona el texto a mano. (' + errorMessage(err) + ')');
    }
  }

  async submitPastedResult(): Promise<void> {
    if (!this.pasteText().trim()) return;
    this.submitting.set(true);
    this.submitError.set(null);
    try {
      let brief: LlmPullAnalysis;
      switch (this.scope()) {
        case 'night-player': {
          const res = await this.edgeFunctions.submitManualNightPlayerBrief(this.reportCode()!, this.playerName()!, this.pasteText());
          brief = mapBrief(res.brief);
          break;
        }
        case 'night': {
          const res = await this.edgeFunctions.submitManualNightBrief(this.reportCode()!, this.pasteText());
          brief = mapBrief(res.brief);
          break;
        }
        default: {
          const res = await this.edgeFunctions.submitManualPullBrief(this.pullId()!, this.pasteText());
          brief = mapBrief(res.brief);
        }
      }
      this.manualBriefSaved.emit(brief);
      this.closeManualPanel();
    } catch (err) {
      this.submitError.set(errorMessage(err));
    } finally {
      this.submitting.set(false);
    }
  }
}
