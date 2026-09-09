import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const requireText = (source, value, label) => {
  if (!source.includes(value)) throw new Error(`${label}: falta ${value}`);
};
const forbid = (source, pattern, label) => {
  if (pattern.test(source)) throw new Error(label);
};

const projection = read('supabase/functions/_shared/player-defensive-audit.ts');
const narrative = read('supabase/functions/_shared/player-defensive-audit-narrative.ts');
const contract = read('supabase/functions/_shared/player-defensive-audit-contract.ts');
const evaluator = read('supabase/functions/_shared/defensive-episode-evaluator.ts');
const persistence = read('supabase/functions/_shared/defensive-episode-persistence.ts');
const refresh = read('supabase/functions/canonical-defensive-refresh/index.ts');
const endpoint = read('supabase/functions/player-defensive-audit/index.ts');
const discord = read('supabase/functions/send-discord-message/index.ts');
const component = read('src/app/features/night-player-dossier/player-defensive-audit.component.ts');
const template = read('src/app/features/night-player-dossier/player-defensive-audit.component.html');
const migration = read('supabase/migrations/20260908230000_defensive_audit_evidence_v8.sql');

for (const source of [projection, narrative, contract, evaluator, persistence, refresh, endpoint, discord, component, template]) {
  forbid(source, /Paladin|Divine Protection|Divine Shield|403876|\b642\b/i, 'La implementación genérica contiene un fixture de clase/spell hardcodeado.');
}

forbid(projection, /defensive_pressure_windows|defensiveManagementV2|legacy/i, 'La proyección de auditoría importa o menciona una fuente legacy.');
forbid(projection, /responseReason/, 'La auditoría intenta depender de responseReason.');
forbid(template, /innerHTML|bypassSecurityTrustHtml/, 'El renderer Angular usa HTML no seguro.');
forbid(narrative, /pullNumber[^\n]{0,80}reports\//, 'Una URL WCL parece construirse con pullNumber.');

for (const value of [
  "DEFENSIVE_NIGHT_AUDIT_VERSION = 'defensive-night-audit@1'",
  "'effective'",
  "'relevant_ineffective'",
  "'relevant_uncertain'",
  "'outside_evaluable_pressure'",
  "'excluded'",
]) requireText(contract, value, 'Contrato de clasificación primaria');

for (const value of [
  'candidate.isDefensiveKitMember',
  'candidate.createsMissableOpportunity',
  "candidate.damageApplicability !== 'yes'",
  "candidate.temporalOpportunity !== 'yes'",
  "candidate.statusAtPeak !== 'available_unused'",
  'candidate.membershipConfidence',
  'candidate.applicabilityClaimConfidence',
  'candidate.availabilityConfidence',
]) requireText(projection, value, 'Guard fuerte de alternativa');

for (const value of [
  'aggregateDefensiveEpisodeKpis',
  'deltaFromPeakMs: cast.castMs - episode.peakMs',
  'core_cast_partition_mismatch',
  'covered_spell_not_candidate',
  "audit.state !== 'available'",
]) requireText(projection + contract, value, 'Invariante de auditoría');

for (const value of [
  'peakValue: episode.peakValue',
  'availabilityAtPeak',
  'castsForSpellMs',
  'effectiveKit: buildEffectiveDefensiveAuditFacts',
  'DEFENSIVE_EPISODE_EVALUATOR_VERSION_V8',
]) requireText(evaluator + persistence + refresh, value, 'Persistencia v8');

for (const value of [
  'add column if not exists effective_kit',
  's.effective_kit',
  'copy-on-write',
]) requireText(migration, value, 'Migración audit evidence v8');

for (const value of [
  'DISCORD_MESSAGE_LIMIT = 2000',
  'protectedLinks',
  'part.length > 2000',
]) requireText(narrative + discord, value, 'Chunking Discord');

for (const value of [
  'allowed_mentions: { parse: [] }',
  "from('discord_roster_channels')",
  "if (isBoundPlayerSend && body.channelId)",
  'character_name,discord_channel_id',
  'requestedPlayerName',
  'failedPartIndex',
]) requireText(discord, value, 'Envío Discord ligado y seguro');

requireText(template, 'target="_blank" rel="noopener"', 'Enlaces web WCL');
requireText(component, 'defensiveAuditDiscordSendDisabled', 'Gate de envío UI');

console.log('Contrato de auditoría defensiva narrativa: OK');
