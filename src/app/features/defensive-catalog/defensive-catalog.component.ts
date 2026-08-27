// Colocar en: src/app/features/defensive-catalog/defensive-catalog.component.ts
// §"pantalla nueva para clasificar defensivos (sustain, defensivo, absorb,
// etc)... parecida a la de mecánicas de bosses pero para defensivos... se
// clasifican por clase" (feedback real): mismo patrón EXACTO que
// manifest.component.ts (mecánicas), pero el eje de navegación es la clase
// en vez de boss+dificultad, y el catálogo base (nombre, spec, cooldown,
// duración) ya llega solo desde cooldown_catalog — aquí solo se confirma
// survival_type.
import { Component, computed, inject, signal } from '@angular/core';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { DefensiveCatalogService } from '../../core/defensive-catalog.service';
import { ClassIconComponent } from '../../shared/class-icon.component';
import { CLASS_DISPLAY_NAME, SURVIVAL_TYPE_KEYS, classDisplayName, survivalTypeMeta } from '../../shared/format.util';
import { MechanicInfoIconComponent } from '../../shared/mechanic-info-icon.component';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import type { CooldownCatalogRow } from '../../shared/models/domain';
import { errorMessage } from '../../shared/error-message.util';

// Mismo orden que CLASS_COLORS/CLASS_DISPLAY_NAME (format.util.ts) — las 13
// clases del juego siempre visibles como pestañas, tenga o no el catálogo
// filas suyas todavía (mismo criterio que standardDifficultyIds en
// manifest.component.ts: no ocultar una clase solo porque el extractor de
// WoWAnalyzer no le haya encontrado nada aún).
const CLASSES = Object.keys(CLASS_DISPLAY_NAME);

@Component({
  selector: 'app-defensive-catalog',
  standalone: true,
  imports: [ClassIconComponent, MechanicInfoIconComponent, WowheadLinkComponent],
  templateUrl: './defensive-catalog.component.html',
  styleUrl: './defensive-catalog.component.scss',
})
export class DefensiveCatalogComponent {
  private edgeFunctions = inject(EdgeFunctionsService);
  private defensiveCatalogService = inject(DefensiveCatalogService);

  readonly classes = CLASSES;
  readonly survivalTypes = SURVIVAL_TYPE_KEYS;
  readonly classDisplayName = classDisplayName;
  readonly survivalTypeMeta = survivalTypeMeta;

  selectedClass = signal<string | null>(null);
  defensives = signal<CooldownCatalogRow[]>([]);
  loadingDefensives = signal(false);
  savingSpellId = signal<number | null>(null);
  error = signal<string | null>(null);

  // §"un desplegable para poner el tipo de defensivo que es (que también
  // deberá rellenarse solo o a través de un prompt)" (feedback real): mismo
  // patrón de dos pasos que el panel de IA de manifest.component.ts —
  // copiar prompt / pegar respuesta.
  //
  // §"la cantidad de habilidades defensivas no es desorbitante, ¿no podemos
  // hacer un único prompt que clasifique todas las specs a la vez y rellene
  // toda la tabla de golpe?" (feedback real, contrastado: 60 filas en total
  // en las 13 clases — cabe de sobra en un solo prompt): classifyScope
  // decide si el prompt actual cubre solo la clase seleccionada o el
  // catálogo entero. 'all' se manda al backend como class:null.
  classifyScope = signal<string | 'all' | null>(null);
  classifyPanelOpen = signal(false);
  loadingClassifyPrompt = signal(false);
  classifyPromptError = signal<string | null>(null);
  classifySystemPrompt = signal<string | null>(null);
  classifyUserMessage = signal<string | null>(null);
  classifyDefensiveCount = signal(0);
  classifyPromptVersion = signal<number | null>(null);
  classifyCopied = signal(false);
  classifyPasteText = signal('');
  classifySubmitting = signal(false);
  classifySubmitError = signal<string | null>(null);
  classifyResult = signal<{
    applied: { spellId: number; name: string; survivalType: string }[];
    skippedLowConfidence: { spellId: number; name: string; survivalType: string | null; notes: string }[];
    skippedUndetermined: { spellId: number; name: string }[];
    invalid: { spellId: unknown; reason: string }[];
  } | null>(null);

  classCounts = computed(() => {
    // Contador rápido "N sin clasificar" por si en el futuro se quiere
    // pintar en la pestaña — hoy solo se usa para la clase seleccionada,
    // pero se deja como computed único en vez de recalcularlo en el template.
    const list = this.defensives();
    return { total: list.length, unclassified: list.filter((d) => !d.survival_type).length };
  });

  selectClass(className: string): void {
    this.selectedClass.set(className);
    this.closeClassifyPanel();
    void this.loadDefensives();
  }

  async loadDefensives(): Promise<void> {
    const className = this.selectedClass();
    if (!className) return;
    this.loadingDefensives.set(true);
    this.error.set(null);
    try {
      this.defensives.set(await this.defensiveCatalogService.listByClass(className));
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loadingDefensives.set(false);
    }
  }

  async onEdit(row: CooldownCatalogRow, patch: Partial<Pick<CooldownCatalogRow, 'survival_type' | 'reviewed'>>): Promise<void> {
    const className = this.selectedClass();
    if (!className) return;
    this.savingSpellId.set(row.spell_id);
    try {
      await this.edgeFunctions.saveDefensiveEdit({
        class: className,
        spellId: row.spell_id,
        survivalType: 'survival_type' in patch ? patch.survival_type : row.survival_type,
        reviewed: patch.reviewed ?? true,
      });
      this.defensives.update((list) => list.map((d) => (d.spell_id === row.spell_id ? { ...d, ...patch, reviewed: patch.reviewed ?? true } : d)));
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.savingSpellId.set(null);
    }
  }

  /** Confirma tal cual la sugerencia IA (inferred_survival_type) — mismo botón que confirmInferredCategory en manifest.component.ts. */
  confirmInferredSurvivalType(row: CooldownCatalogRow): void {
    if (!row.inferred_survival_type) return;
    void this.onEdit(row, { survival_type: row.inferred_survival_type });
  }

  /** scope: nombre de clase concreta, o 'all' para el catálogo entero (todas las clases en un único prompt). */
  async openClassifyPanel(scope: string | 'all'): Promise<void> {
    this.classifyPanelOpen.set(true);
    this.classifyResult.set(null);
    if (this.classifySystemPrompt() != null && this.classifyScope() === scope) return; // ya traído para este alcance, no repetir la llamada
    this.classifyScope.set(scope);
    this.loadingClassifyPrompt.set(true);
    this.classifyPromptError.set(null);
    try {
      const res = await this.edgeFunctions.getDefensiveClassificationPrompt(scope === 'all' ? null : scope);
      this.classifySystemPrompt.set(res.systemPrompt);
      this.classifyUserMessage.set(res.userMessage);
      this.classifyDefensiveCount.set(res.defensiveCount);
      this.classifyPromptVersion.set(res.promptVersion);
    } catch (err) {
      this.classifyPromptError.set(errorMessage(err));
    } finally {
      this.loadingClassifyPrompt.set(false);
    }
  }

  closeClassifyPanel(): void {
    this.classifyPanelOpen.set(false);
    this.classifyScope.set(null);
    this.classifySystemPrompt.set(null);
    this.classifyUserMessage.set(null);
    this.classifyPromptVersion.set(null);
    this.classifyPasteText.set('');
    this.classifySubmitError.set(null);
    this.classifyResult.set(null);
  }

  get classifyFullPrompt(): string {
    return `${this.classifySystemPrompt() ?? ''}\n\n---\n\n${this.classifyUserMessage() ?? ''}`;
  }

  async copyClassifyPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.classifyFullPrompt);
      this.classifyCopied.set(true);
      setTimeout(() => this.classifyCopied.set(false), 2000);
    } catch (err) {
      this.classifyPromptError.set('No se pudo copiar automáticamente — selecciona el texto a mano. (' + errorMessage(err) + ')');
    }
  }

  async submitClassification(): Promise<void> {
    const scope = this.classifyScope();
    if (!scope || !this.classifyPasteText().trim()) return;
    this.classifySubmitting.set(true);
    this.classifySubmitError.set(null);
    try {
      const res = await this.edgeFunctions.submitDefensiveClassification(scope === 'all' ? null : scope, this.classifyPasteText());
      this.classifyPasteText.set('');
      // Mismo orden que manifest.component.ts (bug real ya resuelto ahí):
      // se espera a tener la tabla fresca antes de anunciar éxito, para que
      // el desplegable ya muestre el valor nuevo cuando aparece el banner.
      // Nota: en scope 'all' esto solo refresca la clase visible ahora
      // mismo — el resto se recarga solas al cambiar de pestaña (selectClass
      // siempre vuelve a pedir la lista, nunca sirve caché).
      await this.loadDefensives();
      this.classifyResult.set({
        applied: res.applied,
        skippedLowConfidence: res.skippedLowConfidence,
        skippedUndetermined: res.skippedUndetermined,
        invalid: res.invalid,
      });
    } catch (err) {
      this.classifySubmitError.set(errorMessage(err));
    } finally {
      this.classifySubmitting.set(false);
    }
  }
}
