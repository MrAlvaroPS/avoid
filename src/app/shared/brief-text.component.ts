// Colocar en: src/app/shared/brief-text.component.ts
// §"cuando la IA trae informes que hablan de personajes concretos,
// habilidades, mecánicas o categorías... podemos aprovechar para pintar
// cada jugador de su clase, las mecánicas tener tooltip de Wowhead + la 'I'
// de información con la nota, la categoría con otro distintivo para leerlo
// bien, y un icono pequeño junto al nombre de la habilidad... todos estos
// cambios deben aplicar a TODAS las consultas de IA" (feedback real,
// 2026-08-24). Los textos que devuelve el LLM son prosa libre (headline/
// improved/regressed/nextPullActions), no JSON estructurado por entidad —
// este componente reconoce, DENTRO de esa prosa, los nombres de jugador,
// nombres de mecánica y códigos de categoría/rootCause que YA conocemos
// (porque son justo los mismos que se le mandaron en el contexto) y los
// enriquece; el resto del texto se pinta tal cual.
import { Component, computed, input } from '@angular/core';
import { WowheadLinkComponent } from './wowhead-link.component';
import { ClassIconComponent } from './class-icon.component';
import { MechanicInfoIconComponent } from './mechanic-info-icon.component';
import { CATEGORY_KEYS, ROOT_CAUSE_META, classColor, mechanicCategoryMeta } from './format.util';
import type { MechanicCategory } from './models/domain';

export interface BriefMechanicMeta {
  spellId: number | null;
  note: string | null;
}

export interface BriefEntities {
  /** nombre de jugador (tal cual aparece en player_pull_records.player_name) -> clase WCL. */
  players: Map<string, string>;
  /** nombre de mecánica -> spellId real (para Wowhead) + nota de IA (para el icono ⓘ). */
  mechanics: Map<string, BriefMechanicMeta>;
}

export const EMPTY_BRIEF_ENTITIES: BriefEntities = { players: new Map(), mechanics: new Map() };

export type BriefSegment = { type: 'text'; value: string } | { type: 'player'; value: string } | { type: 'mechanic'; value: string } | { type: 'token'; value: string };

/**
 * Lógica pura de reconocimiento, factorizada del componente para poder
 * reutilizarla también en texto plano (copiar para Discord) — no todos los
 * consumidores quieren HTML.
 */
export function splitBriefText(text: string, entities: BriefEntities): BriefSegment[] {
  const keys: { key: string; kind: 'player' | 'mechanic' | 'token' }[] = [];
  for (const name of entities.players.keys()) if (name) keys.push({ key: name, kind: 'player' });
  for (const name of entities.mechanics.keys()) if (name) keys.push({ key: name, kind: 'mechanic' });
  for (const code of CATEGORY_KEYS) keys.push({ key: code, kind: 'token' });
  for (const code of Object.keys(ROOT_CAUSE_META)) keys.push({ key: code, kind: 'token' });
  if (!keys.length) return [{ type: 'text', value: text }];

  // Más largo primero: evita que un nombre corto "coma" parte de uno más
  // largo que lo contiene (ej. una mecánica cuyo nombre incluye otra).
  keys.sort((a, b) => b.key.length - a.key.length);
  const escaped = keys.map((k) => k.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'g');
  const kindByKey = new Map(keys.map((k) => [k.key, k.kind]));

  return text
    .split(re)
    .filter((part) => part !== '')
    .map((part) => ({ type: kindByKey.get(part) ?? 'text', value: part }) as BriefSegment);
}

function tokenLabelFor(code: string): string {
  const catMeta = mechanicCategoryMeta(code as MechanicCategory);
  if (catMeta) return catMeta.label;
  return ROOT_CAUSE_META[code]?.label ?? code;
}

/**
 * §"incluir en el propio informe que se copia a discord también lo que
 * viene en la información de mecánica" (feedback real, 2026-08-24) →
 * refinado en el mismo hilo: "en lugar de acompañar [nota: ...] en cada
 * habilidad, podemos poner solo el nombre... y al final del todo una
 * nueva sección NOTAS... una sola vez por habilidad, así no ensuciamos
 * tanto el informe". Esta función deja el texto LIMPIO (solo nombres,
 * categorías/causas traducidas a texto legible) — collectBriefNotes()
 * de aquí abajo recopila las notas aparte, una vez, para una sección final.
 */
export function annotateBriefTextForCopy(text: string, entities: BriefEntities): string {
  return splitBriefText(text, entities)
    .map((seg) => {
      if (seg.type === 'token') return tokenLabelFor(seg.value);
      return seg.value;
    })
    .join('');
}

/**
 * Recorre TODOS los textos de un informe (headline + improved + regressed +
 * nextPullActions) y devuelve, en orden de primera aparición, cada mecánica
 * distinta que tenga nota de IA — una sola entrada por mecánica aunque se
 * mencione varias veces a lo largo del informe.
 */
export function collectBriefNotes(texts: string[], entities: BriefEntities): { name: string; note: string }[] {
  const seen = new Set<string>();
  const notes: { name: string; note: string }[] = [];
  for (const text of texts) {
    for (const seg of splitBriefText(text, entities)) {
      if (seg.type !== 'mechanic' || seen.has(seg.value)) continue;
      const note = entities.mechanics.get(seg.value)?.note;
      if (!note) continue;
      seen.add(seg.value);
      notes.push({ name: seg.value, note });
    }
  }
  return notes;
}

@Component({
  selector: 'app-brief-text',
  standalone: true,
  imports: [WowheadLinkComponent, ClassIconComponent, MechanicInfoIconComponent],
  template: `
    @for (seg of segments(); track $index) {
      @switch (seg.type) {
        @case ('player') {
          <span class="brief-player" [style.color]="playerColor(seg.value)">
            <app-class-icon [wclClass]="entities().players.get(seg.value)!" />{{ seg.value }}
          </span>
        }
        @case ('mechanic') {
          <span class="brief-mechanic">
            @if (mechanicMeta(seg.value); as m) {
              @if (m.spellId) {
                <!-- §bug real (feedback: "los iconos de las habilidades... se
                     están duplicando"): el propio script de Wowhead ya
                     antepone su icono a CUALQUIER data-wowhead con texto
                     dentro (mismo comportamiento que night-player-dossier,
                     player-detail...) — un app-wowhead-link icon-only APARTE
                     aquí al lado duplicaba el icono. Un solo enlace, con el
                     texto dentro, basta. -->
                <app-wowhead-link type="spell" [id]="m.spellId">{{ seg.value }}</app-wowhead-link>
              } @else {
                <strong>{{ seg.value }}</strong>
              }
              <app-mechanic-info-icon [note]="m.note" />
            }
          </span>
        }
        @case ('token') {
          <span class="brief-token" [style.background]="tokenColor(seg.value)">{{ tokenLabel(seg.value) }}</span>
        }
        @default {
          {{ seg.value }}
        }
      }
    }
  `,
  styles: [
    `
      :host {
        display: inline;
      }
      .brief-player {
        font-weight: 700;
        white-space: nowrap;

        ::ng-deep .class-icon {
          margin-right: 2px;
          margin-bottom: -2px;
        }
      }
      .brief-mechanic {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        white-space: nowrap;
      }
      .brief-token {
        display: inline-block;
        padding: 1px 7px;
        border-radius: 20px;
        font-size: 10px;
        font-weight: 700;
        color: #fff;
        white-space: nowrap;
      }
    `,
  ],
})
export class BriefTextComponent {
  text = input.required<string>();
  entities = input<BriefEntities>(EMPTY_BRIEF_ENTITIES);

  segments = computed<BriefSegment[]>(() => splitBriefText(this.text(), this.entities()));

  playerColor(name: string): string | null {
    return classColor(this.entities().players.get(name) ?? null);
  }

  mechanicMeta(name: string): BriefMechanicMeta | null {
    return this.entities().mechanics.get(name) ?? null;
  }

  tokenLabel(code: string): string {
    return tokenLabelFor(code);
  }

  tokenColor(code: string): string {
    const catMeta = mechanicCategoryMeta(code as MechanicCategory);
    if (catMeta) return catMeta.color;
    return 'var(--neutral, #6b7280)';
  }
}
