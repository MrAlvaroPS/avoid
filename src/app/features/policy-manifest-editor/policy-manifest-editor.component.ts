import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { SupabaseService } from '../../core/supabase.service';
import { errorMessage } from '../../shared/error-message.util';
import type {
  MechanicAliasContract,
  MechanicPolicyContract,
} from '../../../../supabase/functions/_shared/combat-evaluation-contract';

type PolicyDraft = Omit<MechanicPolicyContract, 'policyVersion'>;

const TARGETING_MODES: PolicyDraft['targetingMode'][] = ['tank', 'selected_player', 'group', 'raid', 'ground', 'object', 'none', 'mixed'];
const RESPONSIBILITY_MODES: PolicyDraft['responsibilityMode'][] = ['target', 'tank_role', 'healer_role', 'dps_role', 'assigned_player', 'assigned_group', 'volunteer', 'raid', 'none'];
const DAMAGE_SEMANTICS: PolicyDraft['damageSemantics'][] = ['mandatory', 'avoidable', 'partly_avoidable', 'failure_consequence', 'none'];
const FAILURE_PROPAGATIONS: PolicyDraft['failurePropagation'][] = ['self', 'nearby_players', 'group', 'raid', 'chained', 'none'];
const ASSIGNMENT_MODES: PolicyDraft['assignmentMode'][] = ['none', 'target_derived', 'role_derived', 'plan_optional', 'plan_required'];
const DEFENSIVE_EXPECTATIONS: PolicyDraft['defensiveExpectation'][] = ['none', 'optional', 'recommended', 'required', 'contingency_only'];
const CREDIT_SCOPES: PolicyDraft['creditScope'][] = ['resolver', 'target', 'group', 'raid', 'none'];
const PENALTY_SCOPES: PolicyDraft['penaltyScope'][] = ['owner', 'assignee', 'role', 'raid_only', 'none'];
const CONFIDENCES: PolicyDraft['confidence'][] = ['verified', 'inferred', 'fallback', 'uncertain'];
const CATEGORIES = ['tankbuster', 'raid-damage', 'avoidable-ground', 'debuff-stack', 'interrupt', 'soak', 'spread', 'healing-absorb', 'personal-target', 'enrage'] as const;

@Component({
  selector: 'app-policy-manifest-editor',
  imports: [FormsModule],
  templateUrl: './policy-manifest-editor.component.html',
  styleUrl: './policy-manifest-editor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PolicyManifestEditorComponent {
  private supabase = inject(SupabaseService);
  private edgeFunctions = inject(EdgeFunctionsService);

  bossId = input.required<string>();
  difficulty = input.required<string>();
  mechanicKey = input.required<string>();
  refreshVersion = input(0);

  readonly targetingModes = TARGETING_MODES;
  readonly responsibilityModes = RESPONSIBILITY_MODES;
  readonly damageSemantics = DAMAGE_SEMANTICS;
  readonly failurePropagations = FAILURE_PROPAGATIONS;
  readonly assignmentModes = ASSIGNMENT_MODES;
  readonly defensiveExpectations = DEFENSIVE_EXPECTATIONS;
  readonly creditScopes = CREDIT_SCOPES;
  readonly penaltyScopes = PENALTY_SCOPES;
  readonly confidences = CONFIDENCES;
  readonly categories = CATEGORIES;

  currentPolicy = signal<MechanicPolicyContract | null>(null);
  draft = signal<PolicyDraft | null>(null);
  aliases = signal<MechanicAliasContract[]>([]);
  aliasAbilityId = signal<number | null>(null);
  aliasNormalizedName = signal('');
  reason = signal('');
  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);

  constructor() {
    effect(() => void this.load(
      this.bossId(),
      this.difficulty(),
      this.mechanicKey(),
      this.refreshVersion(),
    ));
  }

  async load(bossId: string, difficulty: string, mechanicKey: string, _refreshVersion: number): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const { data, error } = await this.supabase.client
        .from('boss_mechanic_policy')
        .select('*')
        .eq('boss_id', bossId)
        .eq('difficulty', difficulty)
        .eq('mechanic_key', mechanicKey)
        .maybeSingle();
      if (error) throw error;
      const policy = data ? this.toContract(data as Record<string, unknown>) : null;
      this.currentPolicy.set(policy);
      this.draft.set(policy ? this.toDraft(policy) : null);
      this.aliases.set([]);
      if (policy) await this.loadAliases(policy);
    } catch (caught) {
      this.currentPolicy.set(null);
      this.draft.set(null);
      this.error.set(errorMessage(caught));
    } finally {
      this.loading.set(false);
    }
  }

  private toDraft(policy: MechanicPolicyContract): PolicyDraft {
    const { policyVersion: _policyVersion, ...draft } = policy;
    return { ...draft, causalRule: { ...draft.causalRule } };
  }

  async addAlias(): Promise<void> {
    const policy = this.currentPolicy();
    const abilityId = this.aliasAbilityId();
    const normalizedName = this.aliasNormalizedName().trim().toLocaleLowerCase('en-US');
    if (!policy || (abilityId == null && !normalizedName)) {
      this.error.set('Indica un ID de habilidad o un nombre normalizado para el alias.');
      return;
    }
    if (abilityId != null && (!Number.isInteger(abilityId) || abilityId <= 0)) {
      this.error.set('El ID de habilidad debe ser un entero positivo.');
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      const result = await this.edgeFunctions.syncMechanicAliases({
        bossId: policy.bossId,
        difficulty: policy.difficulty,
        mechanicKey: policy.mechanicKey,
        aliases: [{
          ...(abilityId != null ? { ability_id: abilityId } : {}),
          ...(normalizedName ? { normalized_name: normalizedName } : {}),
          source: 'manual',
          confidence: 'verified',
          active: true,
        }],
      });
      this.aliases.update((aliases) => {
        const byId = new Map(aliases.map((alias) => [alias.id, alias]));
        for (const alias of result.aliases) byId.set(alias.id, alias);
        return [...byId.values()];
      });
      this.aliasAbilityId.set(null);
      this.aliasNormalizedName.set('');
    } catch (caught) {
      this.error.set(errorMessage(caught));
    } finally {
      this.saving.set(false);
    }
  }

  update<K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]): void {
    this.draft.update((draft) => (draft ? { ...draft, [key]: value } : draft));
  }

  async save(): Promise<void> {
    const draft = this.draft();
    const reason = this.reason().trim();
    if (!draft || !reason) {
      this.error.set('Describe el motivo de la revisión antes de publicar.');
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      const result = await this.edgeFunctions.publishMechanicPolicy(draft, reason);
      this.currentPolicy.set(result.policy);
      this.draft.set(this.toDraft(result.policy));
      this.reason.set('');
    } catch (caught) {
      this.error.set(errorMessage(caught));
    } finally {
      this.saving.set(false);
    }
  }

  private async loadAliases(policy: MechanicPolicyContract): Promise<void> {
    try {
      const { data, error } = await this.supabase.client
        .from('boss_mechanic_aliases')
        .select('*')
        .eq('boss_id', policy.bossId)
        .eq('difficulty', policy.difficulty)
        .eq('mechanic_key', policy.mechanicKey)
        .order('created_at');
      if (error) throw error;
      this.aliases.set((data ?? []).map((row) => this.toAlias(row as Record<string, unknown>)));
    } catch (caught) {
      this.aliases.set([]);
      this.error.set(errorMessage(caught));
    }
  }

  private toContract(row: Record<string, unknown>): MechanicPolicyContract {
    return {
      bossId: String(row['boss_id']),
      difficulty: String(row['difficulty']),
      mechanicKey: String(row['mechanic_key']),
      policyVersion: Number(row['policy_version']),
      displayCategory: typeof row['display_category'] === 'string' ? row['display_category'] : null,
      targetingMode: row['targeting_mode'] as PolicyDraft['targetingMode'],
      requiredResponse: typeof row['required_response'] === 'string' ? row['required_response'] : null,
      responsibilityMode: row['responsibility_mode'] as PolicyDraft['responsibilityMode'],
      damageSemantics: row['damage_semantics'] as PolicyDraft['damageSemantics'],
      failurePropagation: row['failure_propagation'] as PolicyDraft['failurePropagation'],
      assignmentMode: row['assignment_mode'] as PolicyDraft['assignmentMode'],
      defensiveExpectation: row['defensive_expectation'] as PolicyDraft['defensiveExpectation'],
      creditScope: row['credit_scope'] as PolicyDraft['creditScope'],
      penaltyScope: row['penalty_scope'] as PolicyDraft['penaltyScope'],
      causalRule: (row['causal_rule'] as Record<string, unknown> | null) ?? {},
      confidence: row['confidence'] as PolicyDraft['confidence'],
    };
  }

  private toAlias(row: Record<string, unknown>): MechanicAliasContract {
    return {
      id: String(row['id']),
      bossId: String(row['boss_id']),
      difficulty: String(row['difficulty']),
      mechanicKey: String(row['mechanic_key']),
      abilityId: typeof row['ability_id'] === 'number' ? row['ability_id'] : null,
      normalizedName: typeof row['normalized_name'] === 'string' ? row['normalized_name'] : null,
      source: row['source'] as MechanicAliasContract['source'],
      confidence: row['confidence'] as MechanicAliasContract['confidence'],
      active: row['active'] === true,
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };
  }
}
