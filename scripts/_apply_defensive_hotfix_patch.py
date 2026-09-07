from pathlib import Path

ORIGINAL_WORKFLOW = '''name: E7 READY validation
on:
  push:
    branches: [feature/mechanics, fix/defensive-evidence-claims-shadow-v5]
  workflow_dispatch:
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - run: npm ci
      - run: deno install --allow-scripts
      - run: npx vitest run supabase/functions/_shared/defensive-episode-verdict.e7-low-confidence.spec.ts src/app/shared/defensive-evidence-v5.spec.ts src/app/shared/defensive-evidence-v6.spec.ts src/app/shared/defensive-temporal-coverage.spec.ts src/app/shared/defensive-version-identity.spec.ts src/app/shared/protection-divine-shield-final-stand.spec.ts
      - run: npm run verify:defensive-contract
      - run: npm run verify:causal-schema
      - run: npm run verify:causal-runtime
      - run: npm run build
      - run: deno check supabase/functions/_shared/defensive-episode-verdict.ts supabase/functions/_shared/defensive-episode-ledger-events.ts supabase/functions/_shared/defensive-episode-evaluator.ts supabase/functions/_shared/defensive-temporal-coverage.ts supabase/functions/_shared/defensive-evidence-v6.ts supabase/functions/_shared/defensive-evidence-v7.ts supabase/functions/shadow-defensive-v6/index.ts supabase/functions/shadow-defensive-v7/index.ts
'''

edge_path = Path('src/app/core/edge-functions.service.ts')
edge = edge_path.read_text()
edge_anchor = "  /** Genera (o devuelve cacheado) el brief LLM de un pull. Idempotente por pull_id salvo force:true. */"
assert edge.count(edge_anchor) == 1, f'edge insertion anchor count={edge.count(edge_anchor)}'
method = '''  /**
   * Reconstruye la generación defensiva canónica publicada después de
   * reanalizar un report. El worker procesa UN pull por invocación para no
   * reintroducir WORKER_RESOURCE_LIMIT y publica de forma atómica/fail-closed.
   */
  async refreshCanonicalDefensiveReport(
    reportCode: string,
    onProgress?: (processedPulls: number) => void,
  ): Promise<{ skipped: boolean; generationId: string | null; processedPulls: number }> {
    type StartResult = {
      ok: true;
      skipped: boolean;
      generationId?: string | null;
      coverage?: { expectedPulls?: number } | null;
    };
    type ProcessResult = {
      ok: true;
      done: boolean;
      generationId: string;
      pullId?: string | null;
    };

    const callWithRetry = async <T>(body: Record<string, unknown>): Promise<T> => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await this.invoke<T>('canonical-defensive-refresh', body);
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
    };

    const started = await callWithRetry<StartResult>({ action: 'start', reportCode });
    if (started.skipped) return { skipped: true, generationId: null, processedPulls: 0 };
    const generationId = started.generationId ?? null;
    if (!generationId) {
      throw new Error('canonical-defensive-refresh no devolvió generationId al iniciar el recálculo.');
    }

    let processedPulls = 0;
    const expectedPulls = started.coverage?.expectedPulls;
    const maxSteps = typeof expectedPulls === 'number' && Number.isFinite(expectedPulls)
      ? Math.max(25, Math.min(2_000, Math.ceil(expectedPulls) + 25))
      : 500;

    for (let guard = 0; guard < maxSteps; guard++) {
      const step = await callWithRetry<ProcessResult>({ action: 'process', generationId });
      if (step.done) return { skipped: false, generationId, processedPulls };
      processedPulls++;
      onProgress?.(processedPulls);
    }
    throw new Error(
      `canonical-defensive-refresh no convergió tras ${maxSteps} pulls; la generación ${generationId} no se considera publicable.`,
    );
  }

'''
edge_path.write_text(edge.replace(edge_anchor, method + edge_anchor))

night_path = Path('src/app/features/night-report/night-report.component.ts')
night = night_path.read_text()
progress_old = 'this.recalculateAllProgress.set({ done, total: pullIds.length });'
assert night.count(progress_old) == 2, f'night progress anchor count={night.count(progress_old)}'
night = night.replace(progress_old, 'this.recalculateAllProgress.set({ done, total: pullIds.length + 1 });')
night_anchor = '''      }

      // Invalida también el estado EN MEMORIA de la evolución: su Set de'''
assert night.count(night_anchor) == 1, f'night canonical anchor count={night.count(night_anchor)}'
night_insert = '''      }

      // Usage/Response de la infografía v3 salen de la generación canónica,
      // no de player_pull_records. Sin este paso, un recálculo podía dejar
      // casts nuevos con episodios defensivos publicados antiguos.
      try {
        await this.edgeFunctions.refreshCanonicalDefensiveReport(code);
      } catch (err) {
        failures.push(`generación defensiva canónica: ${errorMessage(err)}`);
      }
      done++;
      this.recalculateAllProgress.set({ done, total: pullIds.length + 1 });

      // Invalida también el estado EN MEMORIA de la evolución: su Set de'''
night_path.write_text(night.replace(night_anchor, night_insert))

dossier_path = Path('src/app/features/night-player-dossier/night-player-dossier.component.ts')
dossier = dossier_path.read_text()
dossier_progress_old = 'this.recalculateProgress.set({ done, total: pullIds.length });'
assert dossier.count(dossier_progress_old) == 2, f'dossier progress anchor count={dossier.count(dossier_progress_old)}'
dossier = dossier.replace(dossier_progress_old, 'this.recalculateProgress.set({ done, total: pullIds.length + 1 });')
dossier_anchor = '''      }
      this.data.set(await this.summaryService.load(this.reportCode(), this.playerName(), true, true));'''
assert dossier.count(dossier_anchor) == 1, f'dossier canonical anchor count={dossier.count(dossier_anchor)}'
dossier_insert = '''      }
      // La infografía defensiva consume la generación canónica: releer el
      // dosier después de reanalizar player_pull_records no basta.
      await this.edgeFunctions.refreshCanonicalDefensiveReport(this.reportCode());
      done++;
      this.recalculateProgress.set({ done, total: pullIds.length + 1 });
      this.data.set(await this.summaryService.load(this.reportCode(), this.playerName(), true, true));'''
dossier_path.write_text(dossier.replace(dossier_anchor, dossier_insert))

Path('.github/workflows/e7-ready-validation.yml').write_text(ORIGINAL_WORKFLOW)
Path(__file__).unlink()
