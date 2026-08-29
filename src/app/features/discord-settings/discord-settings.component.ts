// Colocar en: src/app/features/discord-settings/discord-settings.component.ts
// §"un bot que crea canales privados dentro de una categoría... solo para
// rango Raider... la primera vez tiene que crearlos, luego si cambia el
// roster tiene que actualizarlos" + "debe estar en la pestaña de ajustes,
// crear un nuevo submenu llamado Discord" (feedback real, 2026-08-28): mismo
// patrón que DefensiveCatalogComponent — vive embebido dentro de
// ManifestComponent (pestaña "Discord" de Ajustes). WoWAudit no expone
// Discord ID (comprobado empíricamente contra la API real), así que la
// vinculación personaje↔Discord es manual aquí; el resto
// (crear/actualizar/borrar canales) lo hace discord-roster-channels
// (action=sync), idempotente.
//
// §"quitar que no se creen canales para los oficiales, tambien se tienen que
// crear" (feedback real, 2026-08-29): ser oficial ya NO excluye de tener
// canal — solo se sigue mostrando como badge informativo (is_officer, ver
// discord-roster-channels/index.ts).
import { Component, computed, inject, signal } from '@angular/core';
import { EdgeFunctionsService, type DiscordRosterLink } from '../../core/edge-functions.service';
import { errorMessage } from '../../shared/error-message.util';

interface DiscordOption {
  id: string;
  name: string;
}
interface RosterRow {
  character_id: number;
  name: string;
  rank: string;
}
interface SyncResult {
  created: string[];
  updated: string[];
  deleted: string[];
  unlinked: string[];
  skippedNoDiscordMember: string[];
}

@Component({
  selector: 'app-discord-settings',
  standalone: true,
  imports: [],
  templateUrl: './discord-settings.component.html',
  styleUrl: './discord-settings.component.scss',
})
export class DiscordSettingsComponent {
  private edgeFunctions = inject(EdgeFunctionsService);

  loading = signal(true);
  error = signal<string | null>(null);

  guildId = signal<string | null>(null);
  settings = signal<{ category_id: string | null; officers_role_id: string | null }>({ category_id: null, officers_role_id: null });
  links = signal<DiscordRosterLink[]>([]);
  roster = signal<RosterRow[]>([]);

  categories = signal<DiscordOption[]>([]);
  roles = signal<DiscordOption[]>([]);
  loadingDiscordOptions = signal(true);
  discordOptionsError = signal<string | null>(null);

  selectedCategoryId = signal('');
  selectedOfficersRoleId = signal('');
  savingConfig = signal(false);
  configSaved = signal(false);

  linkDrafts = signal<Map<number, string>>(new Map());
  savingLinkFor = signal<number | null>(null);
  linkErrorFor = signal<{ characterId: number; message: string } | null>(null);
  confirmingRemoveId = signal<number | null>(null);
  removingId = signal<number | null>(null);

  syncing = signal(false);
  lastSyncResult = signal<SyncResult | null>(null);

  // §"solo para rango Raider": Main es el único rank de WoWAudit que
  // corresponde a raider de verdad (el otro es Trial) — un oficial que
  // también es Main raider entra igual, ya no hay exclusión por rol de
  // Discord (ver discord-roster-channels/index.ts).
  mainRoster = computed(() => this.roster().filter((r) => r.rank === 'Main'));
  linkByCharacterId = computed(() => new Map(this.links().map((l) => [l.character_id, l])));
  configReady = computed(() => !!this.settings().category_id && !!this.settings().officers_role_id);

  constructor() {
    void this.loadAll();
  }

  async loadAll(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const config = await this.edgeFunctions.getDiscordRosterConfig();
      this.guildId.set(config.guildId);
      this.settings.set(config.settings);
      this.links.set(config.links);
      this.roster.set(config.roster);
      this.selectedCategoryId.set(config.settings.category_id ?? '');
      this.selectedOfficersRoleId.set(config.settings.officers_role_id ?? '');
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
    void this.loadDiscordOptions();
  }

  async loadDiscordOptions(): Promise<void> {
    this.loadingDiscordOptions.set(true);
    this.discordOptionsError.set(null);
    try {
      const [cats, roles] = await Promise.all([this.edgeFunctions.listDiscordCategories(), this.edgeFunctions.listDiscordRoles()]);
      this.categories.set(cats.categories);
      this.roles.set(roles.roles);
    } catch (err) {
      this.discordOptionsError.set(errorMessage(err));
    } finally {
      this.loadingDiscordOptions.set(false);
    }
  }

  async onSaveConfig(): Promise<void> {
    const categoryId = this.selectedCategoryId();
    const officersRoleId = this.selectedOfficersRoleId();
    if (!categoryId || !officersRoleId) return;
    this.savingConfig.set(true);
    this.error.set(null);
    this.configSaved.set(false);
    try {
      await this.edgeFunctions.saveDiscordRosterConfig(categoryId, officersRoleId);
      this.settings.set({ category_id: categoryId, officers_role_id: officersRoleId });
      this.configSaved.set(true);
      setTimeout(() => this.configSaved.set(false), 2500);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.savingConfig.set(false);
    }
  }

  linkFor(characterId: number): DiscordRosterLink | null {
    return this.linkByCharacterId().get(characterId) ?? null;
  }

  draftFor(characterId: number): string {
    return this.linkDrafts().get(characterId) ?? '';
  }

  setDraft(characterId: number, value: string): void {
    this.linkDrafts.update((map) => new Map(map).set(characterId, value));
  }

  async onSaveLink(characterId: number, characterName: string): Promise<void> {
    const discordUserId = this.draftFor(characterId).trim();
    if (!discordUserId) return;
    this.savingLinkFor.set(characterId);
    this.linkErrorFor.set(null);
    try {
      const result = await this.edgeFunctions.saveDiscordRosterLink(characterId, characterName, discordUserId);
      this.links.update((list) => [
        ...list.filter((l) => l.character_id !== characterId),
        {
          character_id: characterId,
          character_name: characterName,
          discord_user_id: discordUserId,
          discord_display_name: result.displayName,
          discord_channel_id: null,
          is_officer: result.isOfficer,
          linked_at: new Date().toISOString(),
          channel_synced_at: null,
        },
      ]);
      this.setDraft(characterId, '');
    } catch (err) {
      this.linkErrorFor.set({ characterId, message: errorMessage(err) });
    } finally {
      this.savingLinkFor.set(null);
    }
  }

  /** Primer clic = pide confirmación; segundo clic (o el mismo botón ya en modo confirmación) = borra ya el canal de Discord y desvincula. */
  onRequestRemoveLink(characterId: number): void {
    if (this.confirmingRemoveId() === characterId) {
      void this.doRemoveLink(characterId);
      return;
    }
    this.confirmingRemoveId.set(characterId);
    setTimeout(() => {
      if (this.confirmingRemoveId() === characterId) this.confirmingRemoveId.set(null);
    }, 4000);
  }

  private async doRemoveLink(characterId: number): Promise<void> {
    this.confirmingRemoveId.set(null);
    this.removingId.set(characterId);
    this.error.set(null);
    try {
      await this.edgeFunctions.removeDiscordRosterLink(characterId);
      this.links.update((list) => list.filter((l) => l.character_id !== characterId));
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.removingId.set(null);
    }
  }

  async onSync(): Promise<void> {
    this.syncing.set(true);
    this.error.set(null);
    this.lastSyncResult.set(null);
    try {
      const result = await this.edgeFunctions.syncDiscordRosterChannels();
      this.lastSyncResult.set(result);
      await this.loadAll();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.syncing.set(false);
    }
  }

  discordChannelUrl(channelId: string): string {
    return `https://discord.com/channels/${this.guildId()}/${channelId}`;
  }
}
