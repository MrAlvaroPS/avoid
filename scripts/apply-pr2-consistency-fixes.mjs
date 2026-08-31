import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = (path) => fs.readFileSync(path, 'utf8');
const write = (path, content) => fs.writeFileSync(path, content);
const gitShow = (ref, path) => execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8' });

function replaceRegex(content, regex, replacement, label) {
  if (!regex.test(content)) throw new Error(`No se encontró el bloque esperado: ${label}`);
  regex.lastIndex = 0;
  const next = content.replace(regex, replacement);
  if (next === content) throw new Error(`El reemplazo no cambió nada: ${label}`);
  return next;
}

function replaceText(content, from, to, label) {
  const first = content.indexOf(from);
  if (first < 0) throw new Error(`No se encontró el texto esperado: ${label}`);
  if (content.indexOf(from, first + from.length) >= 0) throw new Error(`Texto ambiguo (más de una coincidencia): ${label}`);
  return content.slice(0, first) + to + content.slice(first + from.length);
}

// ---------------------------------------------------------------------------
// 1) night-report: MAIN es la base semántica. Conserva las 4 métricas de
// asistencia + evolución boss/dificultad y añade encima el force refresh de
// la feature. Nunca se resuelve el conflicto escogiendo una rama completa.
// ---------------------------------------------------------------------------
const nightTsPath = 'src/app/features/night-report/night-report.component.ts';
let nightTs = gitShow('origin/main', nightTsPath);

nightTs = replaceRegex(
  nightTs,
  /  async onUpdateFullReport\(\): Promise<void> \{\n    await this\.generateFullReport\(true\);\n  \}\n/,
  `  async onUpdateFullReport(): Promise<void> {\n    await this.generateFullReport(true);\n  }\n\n  // Recalcula las fuentes materializadas y TODOS sus consumidores. A\n  // diferencia de \"Actualizar\", no se limita al informe determinista.\n  recalculatingAll = signal(false);\n  recalculateAllError = signal<string | null>(null);\n  recalculateAllProgress = signal<{ done: number; total: number } | null>(null);\n\n  async onRecalculateAll(): Promise<void> {\n    if (this.recalculatingAll()) return;\n    this.recalculatingAll.set(true);\n    this.recalculateAllError.set(null);\n    this.recalculateAllProgress.set(null);\n    try {\n      const code = this.reportCode();\n      const pullIds = await this.nightReportService.listPullIds(code);\n      const failures: string[] = [];\n      let done = 0;\n      this.recalculateAllProgress.set({ done, total: pullIds.length });\n\n      // Cada pull es una invocación independiente: evita WORKER_RESOURCE_LIMIT\n      // y, con un reintento, reduce el riesgo de dejar una noche a medias por\n      // un fallo transitorio de red/WCL. Los fallos persistentes nunca se\n      // silencian: se muestran al final.\n      for (const pullId of pullIds) {\n        for (const [label, operation] of [\n          ['defensivos', () => this.edgeFunctions.reanalyzeDefensivePressure(pullId)],\n          ['mecánicas', () => this.edgeFunctions.reanalyzeUnassignedMechanics(pullId)],\n        ] as const) {\n          let lastError: unknown = null;\n          for (let attempt = 0; attempt < 2; attempt++) {\n            try {\n              await operation();\n              lastError = null;\n              break;\n            } catch (err) {\n              lastError = err;\n            }\n          }\n          if (lastError != null) failures.push(\\`${'${pullId}'} · ${'${label}'}: ${'${errorMessage(lastError)}'}\\`);\n        }\n        done++;\n        this.recalculateAllProgress.set({ done, total: pullIds.length });\n      }\n\n      // Invalida también el estado EN MEMORIA de la evolución: su Set de\n      // \"ya solicitado\" impediría volver a entrar aunque el fingerprint\n      // persistido hubiese cambiado.\n      this.bossEvolutionRequested.clear();\n      this.bossEvolution.set(new Map());\n\n      await Promise.all([\n        this.loadRosterSnapshot(true),\n        this.loadNightAttendanceStats(code, this.attendingPlayers(), true),\n        this.prefetchBossEvolution(true),\n      ]);\n      await this.generateFullReport(true);\n\n      if (failures.length) {\n        this.recalculateAllError.set(\n          \\`El recálculo terminó con ${'${failures.length}'} operación(es) que siguieron fallando tras reintentar. Los datos visibles se han recargado desde el estado persistido actual, pero la noche no debe considerarse completamente reanalizada. ${'${failures.slice(0, 3).join(" | ")}'}${'${failures.length > 3 ? " …" : ""}'}\\`,\n        );\n      }\n    } catch (err) {\n      this.recalculateAllError.set(errorMessage(err));\n    } finally {\n      this.recalculatingAll.set(false);\n    }\n  }\n`,
  'night-report onRecalculateAll',
);

nightTs = replaceRegex(
  nightTs,
  /  private async loadRosterSnapshot\(\): Promise<void> \{[\s\S]*?\n  \}\n\n  private async loadNightAttendanceStats/,
  `  private async loadRosterSnapshot(force = false): Promise<void> {\n    const cached = force ? null : this.rosterSnapshotCache.read();\n    if (cached) {\n      this.rosterPlayers.set(cached.players);\n      this.rosterOffenders.set(cached.offenders);\n    }\n    try {\n      const fingerprint = await this.rosterSnapshotCache.fingerprint();\n      if (!force && cached?.fingerprint === fingerprint) return;\n      const [players, offenders] = await Promise.all([\n        this.reliabilityService.listPlayerReliability(),\n        this.offendersService.listRepeatOffenders().catch(() => []),\n      ]);\n      this.rosterPlayers.set(players);\n      this.rosterOffenders.set(offenders);\n      const snapshot: RosterSnapshot = { fingerprint, savedAt: new Date().toISOString(), players, offenders };\n      this.rosterSnapshotCache.write(snapshot);\n    } catch {\n      // best-effort: el fallo de esta optimización nunca bloquea el informe.\n    }\n  }\n\n  private async loadNightAttendanceStats`,
  'night-report loadRosterSnapshot',
);

nightTs = replaceText(
  nightTs,
  '  private async loadNightAttendanceStats(code: string, players: NightAttendee[]): Promise<void> {',
  '  private async loadNightAttendanceStats(code: string, players: NightAttendee[], force = false): Promise<void> {',
  'night-report loadNightAttendanceStats signature',
);

nightTs = replaceRegex(
  nightTs,
  /    let fingerprint: string \| null = null;\n    try \{\n      fingerprint = await this\.nightScoreCache\.fingerprint\(code\);\n      const cached = this\.nightScoreCache\.read\(code\);\n      if \(cached && cached\.fingerprint === fingerprint\) \{\n        this\.nightAttendanceStats\.set\(new Map\(Object\.entries\(cached\.scores\)\)\);\n        return;\n      \}\n    \} catch \{\n      \/\/ sigue al cálculo completo si el fingerprint ligero falla — nunca deja la tabla sin números por esto\.\n    \}/,
  `    let fingerprint: string | null = null;\n    if (!force) {\n      try {\n        fingerprint = await this.nightScoreCache.fingerprint(code);\n        const cached = this.nightScoreCache.read(code);\n        if (cached && cached.fingerprint === fingerprint) {\n          this.nightAttendanceStats.set(new Map(Object.entries(cached.scores)));\n          return;\n        }\n      } catch {\n        // sigue al cálculo completo si el fingerprint ligero falla.\n      }\n    }`,
  'night-report attendance cache bypass',
);

nightTs = replaceText(
  nightTs,
  '          const summary = await this.nightPlayerSummaryService.load(code, p.name, false);',
  '          const summary = await this.nightPlayerSummaryService.load(code, p.name, false, force);',
  'night-report inner summary force refresh',
);

nightTs = replaceText(
  nightTs,
  '    this.nightAttendanceStats.set(new Map(entries));\n    if (fingerprint) this.nightScoreCache.write(code, fingerprint, Object.fromEntries(entries));',
  '    this.nightAttendanceStats.set(new Map(entries));\n    fingerprint ??= await this.nightScoreCache.fingerprint(code).catch(() => null);\n    if (fingerprint) this.nightScoreCache.write(code, fingerprint, Object.fromEntries(entries));',
  'night-report refreshed attendance fingerprint',
);

nightTs = replaceText(
  nightTs,
  '  private async prefetchBossEvolution(): Promise<void> {\n    await Promise.all(this.tonightBossKeys().map((b) => this.loadBossEvolution(b.bossId, b.difficulty, b.key)));\n  }\n\n  private async loadBossEvolution(bossId: string, difficulty: string, key: string): Promise<void> {\n    if (this.bossEvolutionRequested.has(key)) return;',
  '  private async prefetchBossEvolution(force = false): Promise<void> {\n    await Promise.all(this.tonightBossKeys().map((b) => this.loadBossEvolution(b.bossId, b.difficulty, b.key, force)));\n  }\n\n  private async loadBossEvolution(bossId: string, difficulty: string, key: string, force = false): Promise<void> {\n    if (!force && this.bossEvolutionRequested.has(key)) return;',
  'night-report boss evolution force signatures',
);

nightTs = replaceText(
  nightTs,
  '      const fingerprint = await this.bossEvolutionCache.fingerprint();\n      const cached = this.bossEvolutionCache.read(bossId, difficulty);\n      if (cached && cached.fingerprint === fingerprint) {',
  '      const fingerprint = await this.bossEvolutionCache.fingerprint();\n      const cached = force ? null : this.bossEvolutionCache.read(bossId, difficulty);\n      if (!force && cached && cached.fingerprint === fingerprint) {',
  'night-report boss evolution cache bypass',
);
write(nightTsPath, nightTs);

const nightHtmlPath = 'src/app/features/night-report/night-report.component.html';
let nightHtml = gitShow('origin/main', nightHtmlPath);
nightHtml = replaceText(
  nightHtml,
  `        <button type="button" class="update-report-btn" [disabled]="generatingFullReport()" (click)="onUpdateFullReport()">\n          @if (generatingFullReport()) { <span class="button-spinner" aria-hidden="true"></span> Actualizando… } @else { ↻ Actualizar }\n        </button>`,
  `        <button type="button" class="update-report-btn" [disabled]="generatingFullReport()" (click)="onUpdateFullReport()">\n          @if (generatingFullReport()) { <span class="button-spinner" aria-hidden="true"></span> Actualizando… } @else { ↻ Actualizar }\n        </button>\n        <button\n          type="button"\n          class="secondary-button"\n          [disabled]="recalculatingAll()"\n          (click)="onRecalculateAll()"\n          title="Reanaliza los pulls y reconstruye ejecución, parse, defensivos, fiabilidad, evolución e informe usando los datos actuales."\n        >\n          @if (recalculatingAll()) {\n            <span class="button-spinner" aria-hidden="true"></span>\n            @if (recalculateAllProgress(); as p) { Reanalizando pulls… {{ p.done }}/{{ p.total }} } @else { Recalculando todo… }\n          } @else {\n            🔄 Recalcular todo\n          }\n        </button>`,
  'night-report recalculate button',
);
nightHtml = replaceText(
  nightHtml,
  `    @if (fullReportError(); as fe) {\n      <p class="full-report-error" role="alert">No se pudo preparar el informe: {{ fe }}</p>\n    }`,
  `    @if (fullReportError(); as fe) {\n      <p class="full-report-error" role="alert">No se pudo preparar el informe: {{ fe }}</p>\n    }\n    @if (recalculateAllError(); as re) {\n      <p class="full-report-error" role="alert">{{ re }}</p>\n    }`,
  'night-report recalculate error',
);
write(nightHtmlPath, nightHtml);

// ---------------------------------------------------------------------------
// 2) Preparación: solo autoasigna mecánicas que EXIGEN defensivo y nunca
// sobrescribe una asignación existente. Esas asignaciones existentes se
// convierten en reservas reales para el algoritmo de cooldown.
// ---------------------------------------------------------------------------
const prepPath = 'src/app/features/boss-prep/boss-prep.component.ts';
let prep = read(prepPath);
prep = replaceText(
  prep,
  '      .filter((c) => mechanicAppliesToRole(c.responsibility, role))\n      .map((c) => {\n        const profile = this.profiles().find((p) => p.ability_id === c.ability_id) ?? null;',
  '      .filter((c) => {\n        const profile = this.profiles().find((p) => p.ability_id === c.ability_id) ?? null;\n        return profile?.requires_defensive === true && mechanicAppliesToRole(c.responsibility, role);\n      })\n      .map((c) => {\n        const profile = this.profiles().find((p) => p.ability_id === c.ability_id) ?? null;',
  'prep timeline requires_defensive',
);
prep = replaceRegex(
  prep,
  /  \/\*\* Motor de la cascada para UNA spec[\s\S]*?\n  private async runCascadeForSpec\(bossId: string, difficulty: string, cls: string, spec: string\): Promise<\{ assigned: number; candidates: number \}> \{[\s\S]*?\n  \}\n\n  async onAutoAssign\(\): Promise<void> \{/,
  `  /** Motor de la cascada para UNA spec. Solo rellena huecos; las asignaciones humanas existentes son inmutables y reservan su cooldown. */\n  private async runCascadeForSpec(bossId: string, difficulty: string, cls: string, spec: string): Promise<{ assigned: number; candidates: number }> {\n    const role = roleFromSpec(cls, spec);\n    const profilesByAbilityId = new Map(this.profiles().map((p) => [p.ability_id, p]));\n    const timeByAbilityId = new Map(\n      this.candidates().map((candidate) => [\n        candidate.ability_id,\n        median(profilesByAbilityId.get(candidate.ability_id)?.reference_cast_offset_ms_samples ?? []),\n      ]),\n    );\n\n    const existingForSpec = this.assignments().filter((a) => a.class === cls && a.spec === spec);\n    const alreadyAssignedAbilityIds = new Set(existingForSpec.map((a) => a.ability_id));\n\n    const mechanicInputs = this.candidates()\n      .filter((candidate) => {\n        const profile = profilesByAbilityId.get(candidate.ability_id) ?? null;\n        return (\n          profile?.requires_defensive === true &&\n          mechanicAppliesToRole(candidate.responsibility, role) &&\n          !alreadyAssignedAbilityIds.has(candidate.ability_id)\n        );\n      })\n      .map((candidate) => ({\n        abilityId: candidate.ability_id,\n        name: candidate.name,\n        timeMs: timeByAbilityId.get(candidate.ability_id) ?? null,\n        impactScore: this.impactScore(candidate, profilesByAbilityId.get(candidate.ability_id) ?? null),\n      }));\n\n    const reservationsBySpellId = new Map<number, number[]>();\n    const blockedBecauseTimingUnknown = new Set<number>();\n    for (const assignment of existingForSpec) {\n      const timeMs = timeByAbilityId.get(assignment.ability_id) ?? null;\n      if (timeMs == null) {\n        // Si ya hay un uso manual cuyo momento no podemos situar, ese spell\n        // no es seguro para nuevas asignaciones automáticas.\n        blockedBecauseTimingUnknown.add(assignment.defensive_spell_id);\n        continue;\n      }\n      const reservations = reservationsBySpellId.get(assignment.defensive_spell_id) ?? [];\n      reservations.push(timeMs);\n      reservationsBySpellId.set(assignment.defensive_spell_id, reservations);\n    }\n\n    const defensiveInputs = defensivesForSpec(this.cooldownCatalog(), cls, spec)\n      .filter((cd) => !blockedBecauseTimingUnknown.has(cd.spell_id))\n      .map((cd) => ({\n        spellId: cd.spell_id,\n        survivalType: cd.survival_type,\n        baseCooldownMs: cd.base_cooldown_ms,\n        reservedTimesMs: reservationsBySpellId.get(cd.spell_id) ?? [],\n      }));\n\n    const result = autoAssignCascade(mechanicInputs, defensiveInputs);\n    for (const assignment of result) {\n      await this.edgeFunctions.saveMechanicDefensiveAssignment({\n        bossId,\n        difficulty,\n        abilityId: assignment.abilityId,\n        class: cls,\n        spec,\n        defensiveSpellId: assignment.defensiveSpellId,\n        prewarnSeconds: 5,\n        triggerType: 'bossmod',\n      });\n    }\n    return { assigned: result.length, candidates: mechanicInputs.filter((m) => m.timeMs != null).length };\n  }\n\n  async onAutoAssign(): Promise<void> {`,
  'prep safe runCascadeForSpec',
);
write(prepPath, prep);

// ---------------------------------------------------------------------------
// 3) Clasificación IA de defensivos: lo que pide el prompt se persiste de
// verdad (survival type + CD + duración), updated_at se mueve solo ante un
// cambio material y se devuelven los pulls afectados para reanalizarlos por
// el mismo camino que una edición manual.
// ---------------------------------------------------------------------------
const classifyPath = 'supabase/functions/classify-defensives/index.ts';
let classify = read(classifyPath);
classify = replaceText(
  classify,
  `interface DefensiveForPrompt {\n  spellId: number;\n  name: string;\n  class: string;\n  spec: string | null;\n  category: string;\n  currentSurvivalType: string | null;\n  currentInferredSurvivalType: string | null;\n}\n\ninterface ClassificationEntry {\n  spellId: number;\n  stillDefensive?: boolean;\n  survivalType: string | null;\n  confidence: 'high' | 'medium' | 'low';\n  sources: string[];\n  notes: string;\n}`,
  `interface DefensiveForPrompt {\n  spellId: number;\n  name: string;\n  class: string;\n  spec: string | null;\n  category: string;\n  currentSurvivalType: string | null;\n  currentInferredSurvivalType: string | null;\n  currentBaseCooldownMs: number | null;\n  currentBaseDurationMs: number | null;\n}\n\ninterface ClassificationEntry {\n  spellId: number;\n  stillDefensive?: boolean;\n  survivalType: string | null;\n  confidence: 'high' | 'medium' | 'low';\n  sources: string[];\n  notes: string;\n  baseCooldownSeconds: number | null;\n  baseDurationSeconds: number | null;\n}`,
  'classify interfaces',
);
classify = replaceText(
  classify,
  ".select('spell_id,name,class,spec,category,survival_type,inferred_survival_type')",
  ".select('spell_id,name,class,spec,category,survival_type,inferred_survival_type,base_cooldown_ms,base_duration_ms')",
  'classify query fields',
);
classify = replaceText(
  classify,
  `      inferred_survival_type: string | null;\n    }[];`,
  `      inferred_survival_type: string | null;\n      base_cooldown_ms: number | null;\n      base_duration_ms: number | null;\n    }[];`,
  'classify row type',
);
classify = replaceText(
  classify,
  `        currentSurvivalType: d.survival_type,\n        currentInferredSurvivalType: d.inferred_survival_type,`,
  `        currentSurvivalType: d.survival_type,\n        currentInferredSurvivalType: d.inferred_survival_type,\n        currentBaseCooldownMs: d.base_cooldown_ms,\n        currentBaseDurationMs: d.base_duration_ms,`,
  'classify prompt current timing',
);
classify = replaceText(
  classify,
  `      const applied: { spellId: number; name: string; survivalType: string; confidence: 'high' | 'medium'; sources: string[]; notes: string }[] = [];`,
  `      const applied: { spellId: number; name: string; class: string; survivalType: string; confidence: 'high' | 'medium'; sources: string[]; notes: string; baseCooldownMs: number | null; baseDurationMs: number | null; materialChanged: boolean }[] = [];`,
  'classify applied shape',
);
classify = replaceText(
  classify,
  `        applied.push({\n          spellId: entry.spellId,\n          name,\n          survivalType: entry.survivalType,\n          confidence: entry.confidence === 'high' ? 'high' : 'medium',\n          sources: Array.isArray(entry.sources) ? entry.sources : [],\n          notes: entry.notes ?? '',\n        });`,
  `        const timingValues = [entry.baseCooldownSeconds, entry.baseDurationSeconds];\n        if (timingValues.some((value) => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))) {\n          invalid.push({ spellId: entry.spellId, reason: 'baseCooldownSeconds/baseDurationSeconds deben ser números >= 0 o null' });\n          continue;\n        }\n        const baseCooldownMs = entry.baseCooldownSeconds == null ? null : Math.round(entry.baseCooldownSeconds * 1000);\n        const baseDurationMs = entry.baseDurationSeconds == null ? null : Math.round(entry.baseDurationSeconds * 1000);\n        const materialChanged =\n          (matched?.survival_type ?? null) !== entry.survivalType ||\n          (matched?.base_cooldown_ms ?? null) !== baseCooldownMs ||\n          (matched?.base_duration_ms ?? null) !== baseDurationMs;\n        applied.push({\n          spellId: entry.spellId,\n          name,\n          class: matched?.class ?? '',\n          survivalType: entry.survivalType,\n          confidence: entry.confidence === 'high' ? 'high' : 'medium',\n          sources: Array.isArray(entry.sources) ? entry.sources : [],\n          notes: entry.notes ?? '',\n          baseCooldownMs,\n          baseDurationMs,\n          materialChanged,\n        });`,
  'classify applied timing',
);
classify = replaceRegex(
  classify,
  /      const submittedAt = new Date\(\)\.toISOString\(\);[\s\S]*?      return jsonResponse\(\{ ok: true, applied, skippedLowConfidence, skippedUndetermined, suggestedExclusions, invalid \}\);/,
  `      const submittedAt = new Date().toISOString();\n      const affectedClasses = new Set<string>();\n      for (const a of applied) {\n        const patch: Record<string, unknown> = {\n          survival_type: a.survivalType,\n          inferred_survival_type: a.survivalType,\n          base_cooldown_ms: a.baseCooldownMs,\n          base_duration_ms: a.baseDurationMs,\n          ai_classification: { confidence: a.confidence, sources: a.sources, notes: a.notes, classifiedAt: submittedAt },\n        };\n        if (a.materialChanged) {\n          patch['updated_at'] = submittedAt;\n          if (a.class) affectedClasses.add(a.class);\n        }\n        let updateQuery = supabase.from('cooldown_catalog').update(patch).eq('spell_id', a.spellId);\n        if (body.class) updateQuery = updateQuery.eq('class', body.class);\n        const { error } = await updateQuery;\n        if (error) throw error;\n      }\n\n      let pullIds: string[] = [];\n      if (affectedClasses.size) {\n        const { data: affectedRecords, error: affectedError } = await supabase\n          .from('player_pull_records')\n          .select('pull_id')\n          .in('class', [...affectedClasses]);\n        if (affectedError) throw affectedError;\n        pullIds = [...new Set((affectedRecords ?? []).map((r) => (r as { pull_id: string }).pull_id))];\n      }\n\n      return jsonResponse({ ok: true, applied, skippedLowConfidence, skippedUndetermined, suggestedExclusions, invalid, pullIds });`,
  'classify persist + affected pulls',
);
write(classifyPath, classify);

const edgePath = 'src/app/core/edge-functions.service.ts';
let edge = read(edgePath);
edge = replaceText(
  edge,
  `    invalid: { spellId: unknown; reason: string }[];\n  }> {`,
  `    invalid: { spellId: unknown; reason: string }[];\n    /** Pulls cuyo snapshot defensivo quedó materialmente obsoleto por survival type/CD/duración aplicados por la IA. */\n    pullIds: string[];\n  }> {`,
  'edge classify pullIds type',
);
write(edgePath, edge);

const catalogPath = 'src/app/features/defensive-catalog/defensive-catalog.component.ts';
let catalog = read(catalogPath);
catalog = replaceText(
  catalog,
  `      await this.loadDefensives();\n      this.classifyResult.set({`,
  `      await this.loadDefensives();\n      // La clasificación IA modifica los mismos campos materiales que la\n      // edición manual; por tanto usa exactamente la misma cola secuencial\n      // de reanálisis antes de dar la operación por terminada.\n      if (res.pullIds.length) {\n        await this.runReanalysisQueue(scope === 'all' ? 'clasificación IA (catálogo completo)' : \\`clasificación IA (${'${classDisplayName(scope)}'})\\`, res.pullIds);\n      }\n      this.classifyResult.set({`,
  'catalog classify reanalysis',
);
write(catalogPath, catalog);

// ---------------------------------------------------------------------------
// 4) Documentación de schema: reference_role_hit_breakdown son CONTADORES
// acumulables, no fracciones. El consumidor calcula la fracción al mostrar.
// ---------------------------------------------------------------------------
const migrationPath = 'supabase/migrations/20260830130000_boss_mechanic_defensive_profile.sql';
let migration = read(migrationPath);
migration = replaceText(
  migration,
  `  -- { tank: 0.1, healer: 0.05, dps: 0.85 } — fracción de hits por rol.\n  reference_role_hit_breakdown jsonb,`,
  `  -- { tank: 12, healer: 4, dps: 84 } — CONTADORES CRUDOS acumulables de\n  -- hits por rol. La UI divide por la suma para obtener fracciones; guardar\n  -- fracciones aquí impediría fusionar tandas posteriores sin perder peso.\n  reference_role_hit_breakdown jsonb,`,
  'migration role breakdown semantics',
);
write(migrationPath, migration);

// Los dos ficheros temporales se borran antes del commit final. El workflow
// que ya está ejecutándose continúa aunque su YAML desaparezca del working tree.
for (const temporary of ['scripts/apply-pr2-consistency-fixes.mjs', '.github/workflows/pr2-consistency-fix.yml']) {
  if (fs.existsSync(temporary)) fs.rmSync(temporary);
}

console.log('PR2 consistency fixes applied successfully.');
