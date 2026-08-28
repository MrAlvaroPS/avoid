import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ReliabilityService, type PlayerReliability } from '../../core/reliability.service';
import { OffendersService, type RepeatOffenderRow } from '../../core/offenders.service';
import { EmptyPanelComponent } from '../../shared/empty-panel.component';
import { RoleIconComponent } from '../../shared/role-icon.component';
import { errorMessage } from '../../shared/error-message.util';
import {
  buildRosterPlayerView,
  filterRosterViews,
  groupRosterViews,
  sortAttentionViews,
  summarizeRosterPatterns,
  type RosterFilter,
  type RosterPlayerView,
} from './roster-view.util';
import { RosterPlayerDrawerComponent } from './roster-player-drawer.component';
import {
  RosterSnapshotCacheService,
  type RosterSnapshot,
} from '../../core/roster-snapshot-cache.service';

@Component({
  selector: 'app-roster',
  standalone: true,
  imports: [DatePipe, EmptyPanelComponent, RoleIconComponent, RosterPlayerDrawerComponent],
  templateUrl: './roster.component.html',
  styleUrl: './roster.component.scss',
})
export class RosterComponent {
  private reliabilityService = inject(ReliabilityService);
  private offendersService = inject(OffendersService);
  private snapshotCache = inject(RosterSnapshotCacheService);

  players = signal<PlayerReliability[]>([]);
  offenders = signal<RepeatOffenderRow[]>([]);
  loading = signal(true);
  offendersLoading = signal(true);
  error = signal<string | null>(null);
  search = signal('');
  filter = signal<RosterFilter>('all');
  selectedPlayerName = signal<string | null>(null);

  hasAnyData = computed(() => this.players().length > 0);
  playerViews = computed(() => {
    const patternsByPlayer = new Map<string, RepeatOffenderRow[]>();
    for (const pattern of this.offenders()) {
      const patterns = patternsByPlayer.get(pattern.playerName) ?? [];
      patterns.push(pattern);
      patternsByPlayer.set(pattern.playerName, patterns);
    }
    return this.players().map((player) =>
      buildRosterPlayerView(player, patternsByPlayer.get(player.playerName) ?? []),
    );
  });
  attentionPlayers = computed(() => sortAttentionViews(this.playerViews()));
  priorityPlayers = computed(() => this.attentionPlayers().slice(0, 5));
  remainingAttentionCount = computed(() =>
    Math.max(0, this.attentionPlayers().length - this.priorityPlayers().length),
  );
  patternSummaries = computed(() => summarizeRosterPatterns(this.offenders()));
  filteredGroups = computed(() =>
    groupRosterViews(filterRosterViews(this.playerViews(), this.filter(), this.search())),
  );
  filteredCount = computed(() =>
    this.filteredGroups().reduce((total, group) => total + group.players.length, 0),
  );
  noDataCount = computed(
    () => this.playerViews().filter((view) => view.status === 'no-data').length,
  );
  playersWithEvidence = computed(() => this.players().length - this.noDataCount());
  trialCount = computed(() => this.players().filter((player) => player.rank === 'Trial').length);
  composition = computed(() => ({
    tanks: this.players().filter((player) => player.role === 'Tank').length,
    healers: this.players().filter((player) => player.role === 'Heal').length,
    dps: this.players().filter((player) => player.role === 'Melee' || player.role === 'Ranged')
      .length,
  }));
  lastObservedAt = computed(() =>
    this.players().reduce<string | null>(
      (latest, player) =>
        player.lastObservedAt && (!latest || player.lastObservedAt > latest)
          ? player.lastObservedAt
          : latest,
      null,
    ),
  );
  selectedPlayer = computed(() => {
    const name = this.selectedPlayerName();
    return name
      ? (this.playerViews().find((view) => view.player.playerName === name) ?? null)
      : null;
  });

  constructor() {
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    const cached = this.snapshotCache.read();
    if (cached) {
      this.applySnapshot(cached);
      this.loading.set(false);
      this.offendersLoading.set(false);
    }

    try {
      const fingerprint = await this.snapshotCache.fingerprint();
      if (cached?.fingerprint === fingerprint) return;
      await this.loadFresh(fingerprint, cached != null);
    } catch {
      if (!cached) {
        // Si falla solo la comprobación ligera, el primer acceso todavía
        // debe intentar la carga normal y cerrar el spinner al terminar.
        await this.loadFresh('unverified:' + Date.now(), false);
      }
    }
  }

  private async loadFresh(fingerprint: string, keepVisible: boolean): Promise<void> {
    if (!keepVisible) this.loading.set(true);
    if (!keepVisible) this.offendersLoading.set(true);
    this.error.set(null);
    try {
      const [players, offenders] = await Promise.all([
        this.reliabilityService.listPlayerReliability(),
        this.offendersService.listRepeatOffenders().catch(() => []),
      ]);
      const snapshot: RosterSnapshot = {
        fingerprint,
        savedAt: new Date().toISOString(),
        players,
        offenders,
      };
      this.applySnapshot(snapshot);
      this.snapshotCache.write(snapshot);
    } catch (err) {
      if (!keepVisible) this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
      this.offendersLoading.set(false);
    }
  }

  private applySnapshot(snapshot: RosterSnapshot): void {
    this.players.set(snapshot.players);
    this.offenders.set(snapshot.offenders);
  }

  setFilter(filter: RosterFilter): void {
    this.filter.set(filter);
  }

  showAllAttention(): void {
    this.filter.set('attention');
    setTimeout(() =>
      document
        .getElementById('roster-list')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  }

  openPlayer(view: RosterPlayerView): void {
    this.selectedPlayerName.set(view.player.playerName);
  }

  closePlayer(): void {
    this.selectedPlayerName.set(null);
  }
}
