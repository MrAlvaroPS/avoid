// Colocar en: src/app/features/documentation/documentation.component.ts
// Manual de la aplicación: lee DOCUMENTATION_CHAPTERS (contenido puro, sin
// lógica) y añade búsqueda, tabla de contenidos y anchors compartibles
// (#capitulo-seccion) tal y como promete la propia documentación.
import { Component, computed, ElementRef, inject, signal, ViewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DOCUMENTATION_CHAPTERS, type DocChapter, type DocSection } from './documentation-content';

interface FilteredChapter {
  chapter: DocChapter;
  sections: DocSection[];
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function sectionText(section: DocSection): string {
  const parts: string[] = [section.title, section.summary, ...(section.keywords ?? [])];
  for (const block of section.blocks) {
    if (block.title) parts.push(block.title);
    if (block.paragraphs) parts.push(...block.paragraphs);
    if (block.items) parts.push(...block.items);
    if (block.formula) parts.push(block.formula);
    if (block.table) {
      parts.push(...block.table.headers);
      for (const row of block.table.rows) parts.push(...row);
    }
  }
  return normalize(parts.join(' \n '));
}

@Component({
  selector: 'app-documentation',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './documentation.component.html',
  styleUrl: './documentation.component.scss',
})
export class DocumentationComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  @ViewChild('content') private contentEl?: ElementRef<HTMLElement>;

  chapters = DOCUMENTATION_CHAPTERS;
  searchTerm = signal('');
  copiedAnchor = signal<string | null>(null);

  private searchIndex = this.chapters.map((chapter) => ({
    chapter,
    sections: chapter.sections.map((section) => ({ section, text: sectionText(section) })),
  }));

  filteredChapters = computed<FilteredChapter[]>(() => {
    const query = normalize(this.searchTerm().trim());
    if (!query) {
      return this.searchIndex.map(({ chapter }) => ({ chapter, sections: chapter.sections }));
    }
    const result: FilteredChapter[] = [];
    for (const { chapter, sections } of this.searchIndex) {
      const matches = sections.filter(({ text }) => text.includes(query)).map(({ section }) => section);
      if (matches.length > 0) {
        result.push({ chapter, sections: matches });
      }
    }
    return result;
  });

  resultCount = computed(() => this.filteredChapters().reduce((acc, c) => acc + c.sections.length, 0));

  constructor() {
    const fragment = this.route.snapshot.fragment;
    if (fragment) {
      // Espera a que el contenido esté en el DOM antes de intentar el scroll.
      setTimeout(() => this.scrollToAnchor(fragment), 0);
    }
  }

  anchorId(chapterId: string, sectionId: string): string {
    return `${chapterId}--${sectionId}`;
  }

  scrollToAnchor(anchorId: string): void {
    const container = this.contentEl?.nativeElement;
    const target = container?.querySelector(`#${CSS.escape(anchorId)}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  goToSection(chapterId: string, sectionId: string): void {
    const anchor = this.anchorId(chapterId, sectionId);
    if (this.searchTerm()) {
      this.searchTerm.set('');
    }
    void this.router.navigate([], { fragment: anchor, relativeTo: this.route }).then(() => {
      setTimeout(() => this.scrollToAnchor(anchor), 0);
    });
  }

  async copyLink(chapterId: string, sectionId: string): Promise<void> {
    const anchor = this.anchorId(chapterId, sectionId);
    const url = `${location.origin}${location.pathname}#${anchor}`;
    try {
      await navigator.clipboard.writeText(url);
      this.copiedAnchor.set(anchor);
      setTimeout(() => {
        if (this.copiedAnchor() === anchor) this.copiedAnchor.set(null);
      }, 1500);
    } catch {
      // Portapapeles no disponible (permiso denegado, contexto no seguro…):
      // el enlace ya está en la URL de todos modos, así que no hay fallback.
    }
  }

  toneLabel(tone: 'info' | 'warning' | 'important'): string {
    switch (tone) {
      case 'warning':
        return 'Aviso';
      case 'important':
        return 'Importante';
      default:
        return 'Nota';
    }
  }
}
