import { Component, HostListener, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  NIGHT_PLAYER_CLAIM_REGISTRY,
  type NightPlayerClaimId,
} from '../../shared/night-player-claim-registry';
import type { AuditSourceKind } from '../../shared/models/night-player-audit';
import { NightPlayerPullLedgerComponent } from './night-player-pull-ledger.component';

interface ProvenanceRow {
  id: NightPlayerClaimId;
  owner: string;
  source: AuditSourceKind;
  note: string | null;
}

interface SourceMeta {
  label: string;
  description: string;
  tone: 'direct' | 'canonical' | 'derived' | 'catalog' | 'ai';
}

const SOURCE_META: Record<AuditSourceKind, SourceMeta> = {
  wcl: {
    label: 'WCL directo',
    description: 'Hecho observado o proyectado directamente desde Warcraft Logs.',
    tone: 'direct',
  },
  iris_canonical: {
    label: 'IRIS canónico',
    description: 'Read-model o evaluación canónica propietaria del dato.',
    tone: 'canonical',
  },
  iris_derived: {
    label: 'IRIS derivado',
    description: 'Proyección derivada de una fuente IRIS; puede ser transitoria hasta su cutover.',
    tone: 'derived',
  },
  catalog: {
    label: 'Catálogo',
    description: 'Hecho semántico o de configuración mantenido por un catálogo IRIS.',
    tone: 'catalog',
  },
  ai_interpretation: {
    label: 'Interpretación IA',
    description: 'Interpretación narrativa; nunca sustituye a la evidencia estructurada.',
    tone: 'ai',
  },
};

@Component({
  selector: 'app-night-player-audit-shell',
  standalone: true,
  imports: [RouterLink, NightPlayerPullLedgerComponent],
  templateUrl: './night-player-audit-shell.component.html',
  styleUrl: './night-player-audit-shell.component.scss',
})
export class NightPlayerAuditShellComponent {
  reportCode = input.required<string>();
  playerName = input.required<string>();

  provenanceOpen = signal(false);

  protected readonly sourceKinds: readonly AuditSourceKind[] = [
    'wcl',
    'iris_canonical',
    'iris_derived',
    'catalog',
    'ai_interpretation',
  ];

  protected readonly provenanceRows: readonly ProvenanceRow[] = (
    Object.entries(NIGHT_PLAYER_CLAIM_REGISTRY) as [
      NightPlayerClaimId,
      (typeof NIGHT_PLAYER_CLAIM_REGISTRY)[NightPlayerClaimId],
    ][]
  ).map(([id, owner]) => ({
    id,
    owner: owner.owner,
    source: owner.source,
    note: 'note' in owner ? owner.note ?? null : null,
  }));

  protected readonly sourceMeta = SOURCE_META;

  openProvenance(): void {
    this.provenanceOpen.set(true);
  }

  closeProvenance(): void {
    this.provenanceOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.provenanceOpen()) this.closeProvenance();
  }
}
