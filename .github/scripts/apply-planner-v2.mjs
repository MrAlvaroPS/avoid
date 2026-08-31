import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(text, from, to, label) {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`No se encontró bloque: ${label}`);
  if (text.indexOf(from, first + from.length) >= 0) throw new Error(`Bloque ambiguo: ${label}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
}

// ---- Boss Prep TS ----
const tsPath = 'src/app/features/boss-prep/boss-prep.component.ts';
let ts = readFileSync(tsPath, 'utf8');
ts = replaceOnce(
  ts,
  "import { DefensiveCatalogService } from '../../core/defensive-catalog.service';\n",
  "import { DefensiveCatalogService } from '../../core/defensive-catalog.service';\nimport { DefensivePlannerService, type PlannerRosterPlayer } from '../../core/defensive-planner.service';\n",
  'planner service import',
);
ts = replaceOnce(
  ts,
  "import { autoAssignCascade } from '../../shared/mrt/auto-assign-cascade.util';\n",
  "import { autoAssignCascade } from '../../shared/mrt/auto-assign-cascade.util';\nimport { reconstructMechanicOccurrences, combineOccurrencesIntoDamageWindows, type DamagePlanningWindow } from '../../shared/mrt/mechanic-occurrences.util';\nimport { buildRosterDefensivePlan, type RosterDefensivePlan } from '../../shared/mrt/roster-defensive-planner.util';\nimport type { EffectiveDefensive } from '../../shared/mrt/effective-defensive.util';\n",
  'planner util imports',
);
ts = replaceOnce(
  ts,
  "interface TimelineEntry {\n  abilityId: number;\n  name: string;\n  timeMs: number;\n  priority: number | null;\n  assignment: MechanicDefensiveAssignmentRow | null;\n  defensiveName: string | null;\n  cooldownMs: number | null;\n  /** El mismo defensivo ya se habría usado antes en esta cronología y su cooldown no le habría dado tiempo a estar libre de nuevo aquí. */\n  conflict: boolean;\n}\n",
  "interface TimelineEntry {\n  abilityId: number;\n  name: string;\n  timeMs: number;\n  priority: number | null;\n  assignment: MechanicDefensiveAssignmentRow | null;\n  defensiveName: string | null;\n  cooldownMs: number | null;\n  /** El mismo defensivo ya se habría usado antes en esta cronología y su cooldown no le habría dado tiempo a estar libre de nuevo aquí. */\n  conflict: boolean;\n}\n\ninterface PlannerV2View {\n  player: PlannerRosterPlayer;\n  kit: EffectiveDefensive[];\n  windows: DamagePlanningWindow[];\n  plan: RosterDefensivePlan;\n}\n",
  'planner view interface',
);
ts = replaceOnce(
  ts,
  "  private defensiveCatalogService = inject(DefensiveCatalogService);\n  private reportsService = inject(ReportsService);\n",
  "  private defensiveCatalogService = inject(DefensiveCatalogService);\n  private defensivePlannerService = inject(DefensivePlannerService);\n  private reportsService = inject(ReportsService);\n",
  'planner service injection',
);
ts = replaceOnce(
  ts,
  "  exportModalOpen = signal(false);\n",
  "  exportModalOpen = signal(false);\n\n  // Planner v2: PREVIEW roster-aware en paralelo a las asignaciones v1. No\n  // escribe mechanic_defensive_assignments, para poder validar el modelo\n  // nuevo sin tocar una sola asignación existente.\n  plannerV2Open = signal(false);\n  plannerV2Loading = signal(false);\n  plannerV2Players = signal<PlannerRosterPlayer[]>([]);\n  plannerV2SelectedName = signal('');\n  plannerV2Result = signal<PlannerV2View | null>(null);\n  plannerV2Error = signal<string | null>(null);\n",
  'planner signals',
);

const plannerMethods = `  // --- Planner v2 roster-aware (preview no destructiva) ---\n  plannerV2PlayersForSelectedClass(): PlannerRosterPlayer[] {\n    return this.plannerV2Players().filter((p) => p.className === this.autoAssignClass());\n  }\n\n  plannerV2SelectedPlayer(): PlannerRosterPlayer | null {\n    return this.plannerV2Players().find((p) => p.name === this.plannerV2SelectedName()) ?? null;\n  }\n\n  plannerV2AssignmentFor(windowId: string) {\n    return this.plannerV2Result()?.plan.assignments.find((a) => a.windowId === windowId) ?? null;\n  }\n\n  async openPlannerV2(): Promise<void> {\n    this.plannerV2Open.set(true);\n    this.plannerV2Loading.set(true);\n    this.plannerV2Error.set(null);\n    this.plannerV2Result.set(null);\n    try {\n      await this.loadCooldownCatalog();\n      await this.defensivePlannerService.refreshRules();\n      const players = await this.defensivePlannerService.listRosterPlayersWithLatestBuild();\n      this.plannerV2Players.set(players);\n      const candidates = players.filter((p) => p.className === this.autoAssignClass());\n      const preferred = candidates.find((p) => p.spec === this.autoAssignSpec() && p.talentBuild != null) ?? candidates.find((p) => p.talentBuild != null) ?? candidates[0] ?? null;\n      this.plannerV2SelectedName.set(preferred?.name ?? '');\n      if (preferred) await this.rebuildPlannerV2();\n    } catch (err) {\n      this.plannerV2Error.set(errorMessage(err));\n    } finally {\n      this.plannerV2Loading.set(false);\n    }\n  }\n\n  closePlannerV2(): void {\n    this.plannerV2Open.set(false);\n  }\n\n  async onPlannerV2PlayerChange(name: string): Promise<void> {\n    this.plannerV2SelectedName.set(name);\n    this.plannerV2Loading.set(true);\n    this.plannerV2Error.set(null);\n    try {\n      await this.rebuildPlannerV2();\n    } catch (err) {\n      this.plannerV2Error.set(errorMessage(err));\n    } finally {\n      this.plannerV2Loading.set(false);\n    }\n  }\n\n  private async rebuildPlannerV2(): Promise<void> {\n    const player = this.plannerV2SelectedPlayer();\n    if (!player?.spec || player.talentBuild == null) {\n      this.plannerV2Result.set(null);\n      if (player) this.plannerV2Error.set(\`No hay un build de talentos observado todavía para \\${player.name}. Importa/analiza un pull reciente antes de planificar.\`);\n      return;\n    }\n\n    const role = roleFromSpec(player.className, player.spec);\n    const profilesByAbilityId = new Map(this.profiles().map((p) => [p.ability_id, p]));\n    const occurrences = this.candidates().flatMap((candidate) => {\n      const profile = profilesByAbilityId.get(candidate.ability_id) ?? null;\n      if (profile?.requires_defensive !== true || !mechanicAppliesToRole(candidate.responsibility, role)) return [];\n      return reconstructMechanicOccurrences({\n        abilityId: candidate.ability_id,\n        name: candidate.name,\n        castOffsetSamplesMs: profile.reference_cast_offset_ms_samples ?? [],\n        sampleFightCount: profile.reference_sample_fight_count ?? 0,\n        impactScore: this.impactScore(candidate, profile),\n        priority: profile.priority,\n      });\n    });\n    const windows = combineOccurrencesIntoDamageWindows(occurrences);\n    const kit = await this.defensivePlannerService.resolvePlayerKit(this.cooldownCatalog(), player);\n    const plannerDefensives = kit\n      .filter((d): d is EffectiveDefensive & { survivalType: NonNullable<EffectiveDefensive['survivalType']>; effectiveCooldownMs: number } => d.planningEligible && d.survivalType != null && d.effectiveCooldownMs != null)\n      .map((d) => ({ spellId: d.spellId, name: d.name, survivalType: d.survivalType, effectiveCooldownMs: d.effectiveCooldownMs }));\n    const plan = buildRosterDefensivePlan(windows, plannerDefensives);\n    this.plannerV2Result.set({ player, kit, windows, plan });\n  }\n\n`;
ts = replaceOnce(ts, '  // --- auto-asignación en cascada ---\n', plannerMethods + '  // --- auto-asignación en cascada ---\n', 'planner methods insertion');
writeFileSync(tsPath, ts);

// ---- Boss Prep HTML ----
const htmlPath = 'src/app/features/boss-prep/boss-prep.component.html';
let html = readFileSync(htmlPath, 'utf8');
html = replaceOnce(
  html,
  '            <button type="button" class="sync-btn" title="Orden cronológico real del fight para esta spec: qué cubre, con qué, y si el mismo defensivo ya se habría usado antes sin tiempo de cooldown de sobra." (click)="openTimeline()">🕐 Cronología</button>\n',
  '            <button type="button" class="sync-btn" title="Orden cronológico real del fight para esta spec: qué cubre, con qué, y si el mismo defensivo ya se habría usado antes sin tiempo de cooldown de sobra." (click)="openTimeline()">🕐 Cronología</button>\n            <button type="button" class="sync-btn planner-v2-trigger" title="Preview v2: usa el roster real, el último build observado, cooldown efectivo por spec/talentos y TODAS las ocurrencias del combate. No modifica las asignaciones actuales." (click)="openPlannerV2()">🧠 Plan v2 roster</button>\n',
  'planner v2 button',
);
const modal = `\n\n  @if (plannerV2Open()) {\n    <div class="export-modal-backdrop" (click)="closePlannerV2()">\n      <div class="export-modal planner-v2-modal" (click)="$event.stopPropagation()">\n        <div class="export-modal-header">\n          <div>\n            <h3>Planificador v2 — {{ autoAssignClass() }}</h3>\n            <p class="meta">Preview no destructiva: roster + build real + CD efectivo + ocurrencias repetidas. No escribe las asignaciones v1.</p>\n          </div>\n          <button type="button" class="classify-toggle" (click)="closePlannerV2()">✕ cerrar</button>\n        </div>\n\n        <div class="planner-v2-player-row">\n          <label>Jugador real del roster\n            <select [value]="plannerV2SelectedName()" (change)="onPlannerV2PlayerChange($any($event.target).value)">\n              @for (p of plannerV2PlayersForSelectedClass(); track p.name) {\n                <option [value]="p.name">{{ p.name }} — {{ p.spec ?? 'spec sin observar' }}</option>\n              }\n            </select>\n          </label>\n          @if (plannerV2SelectedPlayer(); as p) {\n            <span class="meta">Build observado: {{ p.observedAt ? (p.observedAt | date: 'd MMM, HH:mm') : 'sin datos' }}</span>\n          }\n        </div>\n\n        @if (plannerV2Error()) { <p class="result-line result-warn">{{ plannerV2Error() }}</p> }\n        @if (plannerV2Loading()) {\n          <p class="muted">Calculando plan…</p>\n        } @else if (plannerV2Result(); as r) {\n          <div class="planner-v2-summary">\n            <strong>{{ r.player.name }} · {{ r.player.spec }}</strong>\n            <span>{{ r.plan.assignments.length }}/{{ r.windows.length }} ventanas cubiertas</span>\n            <span>{{ r.plan.uncoveredWindowIds.length }} sin hueco compatible</span>\n          </div>\n\n          <h4>Cooldowns efectivos del jugador</h4>\n          <table class="assignments planner-v2-kit">\n            <thead><tr><th>Defensivo</th><th>Base catálogo</th><th>Base spec</th><th>CD efectivo</th><th>Por qué</th><th>AUTO</th></tr></thead>\n            <tbody>\n              @for (d of r.kit; track d.spellId) {\n                <tr>\n                  <td><app-wowhead-link type="spell" [id]="d.spellId">{{ d.name }}</app-wowhead-link></td>\n                  <td>{{ d.catalogBaseCooldownMs != null ? (d.catalogBaseCooldownMs / 1000 | number: '1.0-0') + 's' : '—' }}</td>\n                  <td>{{ d.specBaseCooldownMs != null ? (d.specBaseCooldownMs / 1000 | number: '1.0-0') + 's' : '—' }}</td>\n                  <td><strong>{{ d.effectiveCooldownMs != null ? (d.effectiveCooldownMs / 1000 | number: '1.0-0') + 's' : 'desconocido' }}</strong></td>\n                  <td class="meta">{{ d.provenance.join(' · ') }}</td>\n                  <td>{{ d.planningEligible ? '✓' : '—' }} @if (!d.planningEligible) { <span class="meta">{{ d.category }}</span> }</td>\n                </tr>\n              }\n            </tbody>\n          </table>\n\n          <h4>Plan de todo el combate</h4>\n          <p class="meta">Primero fija el pico de mayor impacto; tras cada reserva vuelve a recorrer todo el combate y reutiliza el CD antes/después siempre que llegue a recuperarse.</p>\n          <table class="assignments timeline-table">\n            <thead><tr><th>Momento</th><th>Ventana / mecánicas</th><th>Prioridad</th><th>Impacto relativo</th><th>Defensivo</th><th>CD efectivo</th><th>Estado</th></tr></thead>\n            <tbody>\n              @for (w of r.windows; track w.windowId) {\n                @if (plannerV2AssignmentFor(w.windowId); as a) {\n                  <tr>\n                    <td>{{ formatFightTime(w.timeMs) }}</td>\n                    <td>{{ w.occurrences.map(o => o.name).join(' + ') }}</td>\n                    <td>{{ w.priority ?? '—' }}</td>\n                    <td>{{ w.impactScore | number: '1.0-0' }}</td>\n                    <td><strong>{{ a.defensiveName }}</strong></td>\n                    <td>{{ a.effectiveCooldownMs / 1000 | number: '1.0-0' }}s</td>\n                    <td><span class="result-ok">✓ cubierto</span></td>\n                  </tr>\n                } @else {\n                  <tr class="timeline-gap">\n                    <td>{{ formatFightTime(w.timeMs) }}</td>\n                    <td>{{ w.occurrences.map(o => o.name).join(' + ') }}</td>\n                    <td>{{ w.priority ?? '—' }}</td>\n                    <td>{{ w.impactScore | number: '1.0-0' }}</td>\n                    <td>—</td><td>—</td><td><span class="result-warn">sin hueco compatible</span></td>\n                  </tr>\n                }\n              }\n            </tbody>\n          </table>\n        } @else if (!plannerV2PlayersForSelectedClass().length) {\n          <p class="muted">No hay jugadores de {{ autoAssignClass() }} en el roster sincronizado.</p>\n        }\n      </div>\n    </div>\n  }\n`;
const end = html.lastIndexOf('\n</section>');
if (end < 0) throw new Error('No se encontró cierre de boss-prep HTML');
html = html.slice(0, end) + modal + html.slice(end);
writeFileSync(htmlPath, html);

// ---- SCSS ----
const scssPath = 'src/app/features/boss-prep/boss-prep.component.scss';
let scss = readFileSync(scssPath, 'utf8');
scss += `\n\n/* Planner v2: modal de validación roster-aware; reutiliza la estética del export/timeline. */\n.planner-v2-modal { width: min(1180px, 96vw); max-height: 92vh; overflow: auto; }\n.planner-v2-player-row { display: flex; align-items: end; gap: 16px; flex-wrap: wrap; margin: 12px 0 18px; }\n.planner-v2-player-row label { display: grid; gap: 5px; font-size: 12px; }\n.planner-v2-summary { display: flex; gap: 18px; flex-wrap: wrap; align-items: center; padding: 10px 12px; border: 1px solid var(--border, #34303f); border-radius: 8px; margin-bottom: 16px; }\n.planner-v2-kit { margin-bottom: 22px; }\n.planner-v2-kit td:nth-child(5) { max-width: 420px; white-space: normal; }\n`;
writeFileSync(scssPath, scss);

// ---- WoWAnalyzer extractor: preserve per-spec cooldowns for ALL classes ----
const exPath = 'supabase/wowanalyzer-extractor/extract.mjs';
let ex = readFileSync(exPath, 'utf8');
ex = replaceOnce(ex, '  const byClassAndId = new Map();\n', '  const byClassAndId = new Map();\n  // Planner v2: no colapsar el cooldown específico de una spec dentro de la fila class+spell del catálogo.\n  const specCooldownOverrides = new Map();\n', 'extractor spec map');
ex = replaceOnce(
  ex,
  '      // La clave YA NO es solo clase+id: la misma spell puede vivir en dos\n',
  "      const baseCooldownMs = extractBaseCooldownMs(block);\n      if (spec && baseCooldownMs != null) {\n        specCooldownOverrides.set(`${wclClass}|${spec}|${resolved.id}`, {\n          class: wclClass, spec, spell_id: resolved.id, base_cooldown_ms: baseCooldownMs,\n          source: 'wowanalyzer_spec', source_note: `Extraído de ${file.replace(/\\\\/g, '/')} en ${resolved.name}.`,\n        });\n      }\n      // La clave YA NO es solo clase+id: la misma spell puede vivir en dos\n",
  'extractor capture spec base',
);
ex = replaceOnce(ex, '          base_cooldown_ms: extractBaseCooldownMs(block),\n', '          base_cooldown_ms: baseCooldownMs,\n', 'extractor reuse cooldown');
ex = replaceOnce(ex, '  return [...byClassAndId.values()];\n}\n', '  return { catalog: [...byClassAndId.values()], specCooldownOverrides: [...specCooldownOverrides.values()] };\n}\n', 'extractor return shape');
ex = replaceOnce(
  ex,
  "async function upsertCatalog(rows, commitSha) {\n",
  "async function upsertSpecCooldownOverrides(rows, commitSha) {\n  if (!rows.length) return;\n  const payload = rows.map((r) => ({ ...r, synced_from_commit: commitSha, verified_at: new Date().toISOString(), updated_at: new Date().toISOString() }));\n  const res = await fetch(`${SUPABASE_URL}/rest/v1/defensive_cooldown_spec_overrides?on_conflict=class,spec,spell_id`, {\n    method: 'POST',\n    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },\n    body: JSON.stringify(payload),\n  });\n  if (!res.ok) throw new Error(`Upsert a defensive_cooldown_spec_overrides falló: HTTP ${res.status} — ${await res.text()}`);\n}\n\nasync function upsertCatalog(rows, commitSha) {\n",
  'extractor override upsert',
);
ex = replaceOnce(
  ex,
  "  const extracted = extractCatalog(REPO_ROOT);\n  console.error(`\\n${extracted.length} candidatas extraídas del código fuente. Verificando contra Blizzard Game Data...`);\n\n  const token = await getBlizzardToken();\n  const verified = await verifyAgainstBlizzard(extracted, token);\n  console.error(`\\n${verified.length}/${extracted.length} verificadas 1:1 (nombre exacto) — solo estas se suben.`);\n\n  await upsertCatalog(verified, commitSha);\n  console.error(`\\nHecho. cooldown_catalog actualizado con ${verified.length} entradas del commit ${commitSha.slice(0, 8)}.`);\n",
  "  const { catalog: extracted, specCooldownOverrides } = extractCatalog(REPO_ROOT);\n  console.error(`\\n${extracted.length} candidatas extraídas del código fuente. Verificando contra Blizzard Game Data...`);\n\n  const token = await getBlizzardToken();\n  const verified = await verifyAgainstBlizzard(extracted, token);\n  console.error(`\\n${verified.length}/${extracted.length} verificadas 1:1 (nombre exacto) — solo estas se suben.`);\n\n  const verifiedKeys = new Set(verified.map((row) => `${row.class}|${row.spell_id}`));\n  const verifiedSpecOverrides = specCooldownOverrides.filter((row) => verifiedKeys.has(`${row.class}|${row.spell_id}`));\n  await upsertCatalog(verified, commitSha);\n  await upsertSpecCooldownOverrides(verifiedSpecOverrides, commitSha);\n  console.error(`\\nHecho. cooldown_catalog actualizado con ${verified.length} entradas y ${verifiedSpecOverrides.length} bases específicas de spec del commit ${commitSha.slice(0, 8)}.`);\n",
  'extractor main',
);
writeFileSync(exPath, ex);

console.log('Planner v2 integrado.');
