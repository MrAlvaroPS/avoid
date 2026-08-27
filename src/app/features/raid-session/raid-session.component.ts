// Colocar en: src/app/features/raid-session/raid-session.component.ts
// La pantalla única (§1, §15): pegas el report, eliges el pull, ves la vista
// Live Pull. Un botón "Importar"/"Actualizar" cubre tanto un log histórico
// cerrado como uno en vivo — analyze-report se comporta igual en los dos
// casos (§10/§11), así que no hace falta un flujo separado para "en vivo".
//
// Persistencia (§11 exige que "en vivo" sobreviva a navegar por la app):
// el código del report activo se guarda en localStorage, así que ir a
// Ajustes y volver a Raid no obliga a pegar la URL otra vez. session_state
// (tabla en Supabase) queda reservada para cuando el propio backend necesite
// saber qué report vigilar (un poller server-side, Fase D) — esto de aquí es
// puramente "qué estaba mirando este navegador", un problema distinto.
import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { ReportsService, type NightPlayerListItem, type PullListItem } from '../../core/reports.service';
import { BossPhaseService } from '../../core/boss-phase.service';
import type { BossEncounterPhaseRow, ReportRow } from '../../shared/models/domain';
import { extractReportCode } from '../../shared/wcl-code.util';
import { formatDuration, formatPct, formatPhaseReached } from '../../shared/format.util';
import { LivePullComponent } from '../live-pull/live-pull.component';
import { EmptyPanelComponent } from '../../shared/empty-panel.component';
import { ClassIconComponent } from '../../shared/class-icon.component';
import { errorMessage } from '../../shared/error-message.util';

export interface PullGroup {
  key: string;
  bossName: string;
  difficulty: string;
  pulls: PullListItem[];
  attemptCount: number;
  killCount: number;
  bestWipePct: number | null;
}

// §"un resumen de la noche completa, no boss a boss" (feedback real): agrega
// TODOS los pulls del report activo — no una llamada nueva, `pulls()` y
// `pullGroups()` ya están cargados para el picker, esto es agregación pura
// sobre lo mismo.
export interface NightSummary {
  totalPulls: number;
  totalKills: number;
  totalWipes: number;
  totalDurationMs: number;
  bossesAttempted: number;
  /** El grupo con más wipes (no el de más intentos a secas — un boss con 5 intentos y 4 kills no es "el que más cuesta") — null solo si no hay grupos, imposible en la práctica si hay pulls. */
  hardestGroup: PullGroup | null;
}

const STORAGE_KEY = 'avoid.currentReportCode';
// §"el polling cada 25-30s parece mucho... podríamos reducirlo a 15-20s"
// (feedback real, 2026-08-24): antes 25s, ahora en el punto medio de lo que pidió.
const AUTO_REFRESH_MS = 18_000;
// §"si vuelvo a la pestaña de raid se ha perdido el live pull y tengo que
// ponerlo de nuevo en marcha, eso debería guardar más consistencia hasta
// que... no haya cambios en 10 minutos... y ahí ya se pueda dar por cerrado
// el log" (feedback real): el report_code YA se persistía (comentario de
// arriba), lo que NO sobrevivía a navegar fuera y volver era el estado del
// checkbox "En vivo" — `autoRefresh` es un signal en memoria, se resetea a
// false cada vez que este componente se destruye/recrea (cualquier
// navegación fuera de "/"). Ahora se persiste junto al código, y se
// autorreanuda al volver SOLO si hubo actividad real (una nueva pull vista,
// o una comprobación manual) hace menos de 10 minutos — pasado eso, se
// considera el log cerrado y no se reanuda solo.
const LIVE_STALE_MS = 10 * 60 * 1000;
const RECENT_REPORTS_LIMIT = 10;

interface StoredSession {
  reportCode: string;
  autoRefreshOn: boolean;
  /** epoch ms de la última vez que se vio actividad real (pull nueva, o una comprobación manual) — no cada tick del polling en sí, que no siempre trae nada nuevo. */
  lastActivityAt: number;
}

function readStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    // Compat con el formato viejo (un string plano con solo el código,
    // de antes de que existiera autoRefreshOn/lastActivityAt) — se sigue
    // pudiendo leer, solo que sin estado "en vivo" que reanudar.
    if (!raw.trim().startsWith('{')) return { reportCode: raw, autoRefreshOn: false, lastActivityAt: 0 };
    const parsed = JSON.parse(raw);
    if (!parsed?.reportCode) return null;
    return { reportCode: String(parsed.reportCode), autoRefreshOn: !!parsed.autoRefreshOn, lastActivityAt: Number(parsed.lastActivityAt) || 0 };
  } catch {
    return null; // navegación privada / storage bloqueado / JSON corrupto: se degrada a "sin persistencia", no rompe nada
  }
}

function writeStoredSession(session: StoredSession | null): void {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // idem — si no se puede persistir, la sesión sigue funcionando en memoria
  }
}

@Component({
  selector: 'app-raid-session',
  standalone: true,
  imports: [LivePullComponent, EmptyPanelComponent, ClassIconComponent, RouterLink],
  templateUrl: './raid-session.component.html',
  styleUrl: './raid-session.component.scss',
})
export class RaidSessionComponent {
  private edgeFunctions = inject(EdgeFunctionsService);
  private reportsService = inject(ReportsService);
  private bossPhase = inject(BossPhaseService);
  private destroyRef = inject(DestroyRef);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  reportCodeInput = signal('');
  importing = signal(false);
  importProgress = signal<string | null>(null);
  error = signal<string | null>(null);

  currentReportCode = signal<string | null>(null);
  // §"la noche duplicada... dos personas subieron el mismo log" (bug real,
  // arreglado a mano el 2026-08-23): analyze-report ya avisa si este report
  // parece la misma sesión que otro ya importado — se enseña como aviso, no
  // bloquea nada (podría ser una segunda sesión real el mismo día).
  duplicateWarning = signal<string | null>(null);
  pulls = signal<PullListItem[]>([]);
  // §"WCL tiene fases de encuentro, implementarlas en todos los sitios
  // donde corresponda" (feedback real): nombres de fase por boss, para
  // resolver "Fase X/N — Nombre" en el picker sin una llamada por pull.
  phasesByBoss = signal<Map<string, BossEncounterPhaseRow[]>>(new Map());
  // §"un dosier de personaje de una noche concreta... para dirigir a uno o
  // varios raiders" (feedback real): entrada al dosier por jugador desde
  // el resumen de la noche — quién participó en algún pull de este report.
  nightPlayers = signal<NightPlayerListItem[]>([]);
  selectedPullId = signal<string | null>(null);
  autoRefresh = signal(false);
  lastCheckedAt = signal<string | null>(null);
  /** epoch ms de la última actividad real (nueva pull vista o comprobación manual) — base para el auto-cierre a los 10 min. */
  private lastActivityAt = 0;

  // §"poder cargar un log desde un historial (con fecha) si ya lo he
  // cargado previamente, así no tengo que buscar logs y con acordarme del
  // día es suficiente" (feedback real): un picker rápido aquí mismo, sin
  // salir a Histórico — carga instantánea (loadExisting, sin llamar a WCL,
  // ya está todo en Supabase de una importación anterior).
  recentReports = signal<{ report: ReportRow; bossesAttempted: string[] }[]>([]);
  showRecentPicker = signal(false);

  hasPulls = computed(() => this.pulls().length > 0);
  hasReportLoaded = computed(() => this.currentReportCode() !== null);

  // §"esa Zona de la cabecera donde vienen los bosses y los pulls sigue
  // ocupando muchísimo espacio" (feedback repetido incluso tras la primera
  // pasada de compactación, que seguía dibujando una CARD entera por boss
  // apilada verticalmente — con gradiente/borde/sombra/padding propios cada
  // una, eso no escala con el número de bosses). Ahora todos los bosses son
  // una sola fila de pills diminutas que envuelve (wrap) en vez de apilarse,
  // y solo el boss ACTIVO (como mucho uno) enseña su fila de pulls debajo —
  // el picker entero pasa a ocupar una altura casi constante sin importar
  // cuántos bosses tenga el report.
  //
  // undefined = "sin tocar todavía" -> sigue el pull seleccionado. Una vez
  // el usuario clica cualquier pill pasa a ser explícito de verdad (una key
  // concreta, o null = "ninguno abierto") y ya no vuelve a seguir la
  // selección automáticamente — un clic manual siempre gana.
  private manualActiveKey = signal<string | null | undefined>(undefined);

  activeGroupKey = computed<string | null>(() => {
    const manual = this.manualActiveKey();
    if (manual !== undefined) return manual;
    const selected = this.selectedPullId();
    return this.pullGroups().find((g) => g.pulls.some((p) => p.id === selected))?.key ?? null;
  });

  activeGroup = computed<PullGroup | null>(() => this.pullGroups().find((g) => g.key === this.activeGroupKey()) ?? null);

  toggleGroup(group: PullGroup): void {
    this.manualActiveKey.set(this.activeGroupKey() === group.key ? null : group.key);
  }

  // §"agrupar los pulls de un boss": una tira plana con TODOS los pulls de
  // TODOS los bosses mezclados no da con qué comparar de un vistazo (para
  // eso ya sirve la comparación "vs anterior" que hace pull-analysis.service
  // por boss+dificultad — el problema real es que la tira no lo enseñaba
  // agrupado). orden = primera aparición de cada boss+dificultad (Map
  // preserva orden de inserción), pulls dentro del grupo en su orden real.
  //
  // §"un ninja pull... también cuenta en la estadística de wipes" (feedback
  // real): el pull sigue viviendo en group.pulls (contexto, pull_number,
  // duración — nunca se oculta), pero no suma a attemptCount/killCount/
  // bestWipePct porque nunca fue un intento real. Mismo criterio en todo
  // este componente: is_ninja_pull nunca filtra listas, ninja_pull_excluded
  // sí filtra conteos.
  pullGroups = computed<PullGroup[]>(() => {
    const groups = new Map<string, PullGroup>();
    for (const pull of this.pulls()) {
      const key = `${pull.boss_id}|${pull.difficulty}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, bossName: pull.bossName, difficulty: pull.difficulty, pulls: [], attemptCount: 0, killCount: 0, bestWipePct: null };
        groups.set(key, group);
      }
      group.pulls.push(pull);
      if (pull.ninja_pull_excluded) continue;
      group.attemptCount++;
      if (pull.kill) group.killCount++;
      const pct = pull.wipe_pct ?? 100;
      if (group.bestWipePct == null || pct < group.bestWipePct) group.bestWipePct = pct;
    }
    return [...groups.values()];
  });

  nightSummary = computed<NightSummary | null>(() => {
    const allPulls = this.pulls();
    if (!allPulls.length) return null;
    const pulls = allPulls.filter((p) => !p.ninja_pull_excluded);
    if (!pulls.length) return null; // toda la noche fue ninja pulls — no hay intentos reales que resumir
    const totalKills = pulls.filter((p) => p.kill).length;
    const totalDurationMs = pulls.reduce((sum, p) => sum + (p.duration_ms ?? 0), 0);
    const groups = this.pullGroups().filter((g) => g.attemptCount > 0);
    const hardestGroup = groups.reduce<PullGroup | null>((worst, g) => {
      const wipes = g.attemptCount - g.killCount;
      const worstWipes = worst ? worst.attemptCount - worst.killCount : -1;
      return wipes > worstWipes ? g : worst;
    }, null);
    return { totalPulls: pulls.length, totalKills, totalWipes: pulls.length - totalKills, totalDurationMs, bossesAttempted: groups.length, hardestGroup };
  });

  // §"recap copiable para Discord": mismo patrón que llm-analysis-card.component.ts (copyPrompt) — navigator.clipboard.writeText + feedback de 2s, no un tercer mecanismo.
  copyStatus = signal<'idle' | 'copied' | 'error'>('idle');

  async copyNightSummary(): Promise<void> {
    const s = this.nightSummary();
    if (!s) return;
    const today = new Date().toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
    const lines = [
      `📋 Resumen de la noche — ${today}`,
      `Bosses intentados: ${s.bossesAttempted} · Kills: ${s.totalKills} · Wipes: ${s.totalWipes} · Tiempo en pulls: ${formatDuration(s.totalDurationMs)}`,
      '',
      'Por boss:',
      ...this.pullGroups().map(
        (g) =>
          `- ${g.bossName} (${g.difficulty}): ${g.attemptCount} intento${g.attemptCount === 1 ? '' : 's'}` +
          (g.killCount > 0 ? `, ${g.killCount} kill${g.killCount === 1 ? '' : 's'}` : `, mejor intento ${formatPct(g.bestWipePct)} HP restante`),
      ),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      this.copyStatus.set('copied');
      setTimeout(() => this.copyStatus.set('idle'), 2000);
    } catch {
      this.copyStatus.set('error');
      setTimeout(() => this.copyStatus.set('idle'), 2000);
    }
  }

  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Prioridad: ?report= (venir del Histórico, un report que puede que
    // todavía no tenga pulls clasificados) > localStorage (volver de Ajustes
    // en medio de la misma sesión, ya con pulls seguro).
    const fromQueryParam = this.route.snapshot.queryParamMap.get('report');
    const stored = readStoredSession();
    const code = fromQueryParam ?? stored?.reportCode ?? null;
    if (code) {
      this.reportCodeInput.set(code);
      // §"si vuelvo a la pestaña de raid se ha perdido el live pull... hasta
      // que no haya cambios en 10 minutos" (feedback real): solo reanuda
      // "En vivo" solo si viene de localStorage (no de un ?report= nuevo,
      // que es otra sesión distinta) Y hubo actividad real hace <10min —
      // pasado eso se considera el log cerrado, no se reanuda solo.
      const resumeLive = !fromQueryParam && !!stored?.autoRefreshOn && Date.now() - (stored?.lastActivityAt ?? 0) < LIVE_STALE_MS;
      if (resumeLive) this.lastActivityAt = stored!.lastActivityAt;
      void this.loadExisting(code, /* analyzeIfEmpty */ !!fromQueryParam).then(() => {
        if (resumeLive && this.currentReportCode() === code) {
          this.autoRefresh.set(true);
          this.startAutoRefresh();
        }
      });
    }
    if (fromQueryParam) {
      // Limpia el query param de la URL tras consumirlo — así un refresh no
      // vuelve a forzar la ruta "vino del histórico" innecesariamente.
      void this.router.navigate([], { queryParams: {}, replaceUrl: true });
    }
    this.destroyRef.onDestroy(() => this.stopAutoRefresh());
    // §"fases de encuentro... en todos los sitios donde corresponda":
    // recarga los nombres de fase cada vez que cambian los bosses presentes
    // en pulls() — best-effort, un boss sin fases (o un fallo de red) no
    // impide ver el picker, solo se queda sin la etiqueta de fase.
    effect(() => {
      const bossIds = [...new Set(this.pulls().map((p) => p.boss_id))];
      if (!bossIds.length) return;
      void this.bossPhase
        .listPhasesForBosses(bossIds)
        .then((map) => this.phasesByBoss.set(map))
        .catch(() => {});
    });
    this.reportsService
      .listAllReports()
      .then((rows) => this.recentReports.set(rows.slice(0, RECENT_REPORTS_LIMIT)))
      .catch(() => {}); // best-effort, no bloquea el resto de la pantalla
  }

  toggleRecentPicker(): void {
    this.showRecentPicker.update((v) => !v);
  }

  /** Carga un report ya importado antes, elegido por fecha — instantáneo, sin llamar a WCL (loadExisting solo lee lo que ya hay en Supabase). */
  async loadFromHistory(code: string): Promise<void> {
    this.showRecentPicker.set(false);
    this.reportCodeInput.set(code);
    this.error.set(null);
    await this.loadExisting(code, /* analyzeIfEmpty */ true); // por si el histórico solo tenía metadata (sync-reports) y nunca se llegó a analizar
  }

  reportDateLabel(startTime: number): string {
    return new Date(startTime).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** Guarda el código activo + si "En vivo" está encendido + cuándo hubo la última actividad real — todo lo que hace falta para reanudar al volver a esta pestaña. */
  private persistSession(): void {
    const code = this.currentReportCode();
    if (!code) {
      writeStoredSession(null);
      return;
    }
    writeStoredSession({ reportCode: code, autoRefreshOn: this.autoRefresh(), lastActivityAt: this.lastActivityAt });
  }

  /** Recarga desde Supabase lo que ya hay guardado, sin llamar a WCL — instantáneo al volver de otra pantalla. */
  private async loadExisting(code: string, analyzeIfEmpty = false): Promise<void> {
    try {
      const pulls = await this.reportsService.listPulls(code);
      if (!pulls.length) {
        // Venimos del Histórico (sync-reports solo trae metadata, nunca
        // pulls) o el código guardado ya no tiene datos — en ambos casos,
        // analizarlo de verdad es lo que el usuario espera al abrirlo.
        if (analyzeIfEmpty) await this.runAnalyze(code, true);
        return;
      }
      this.currentReportCode.set(code);
      this.pulls.set(pulls);
      this.selectedPullId.set(pulls.at(-1)?.id ?? null);
      this.manualActiveKey.set(undefined); // sigue al pull recién cargado, no a un pin manual de una sesión anterior
      this.reportsService.listNightPlayers(code).then((p) => this.nightPlayers.set(p)).catch(() => {}); // best-effort, no bloquea la carga principal
    } catch {
      // si falla (ej. Supabase no disponible un instante), no bloquea: el usuario puede pulsar Importar
    }
  }

  async onImport(): Promise<void> {
    const code = extractReportCode(this.reportCodeInput());
    if (!code) return;
    await this.runAnalyze(code, true);
  }

  private async runAnalyze(code: string, isManual: boolean): Promise<void> {
    if (isManual) {
      this.importing.set(true);
      this.error.set(null);
      this.importProgress.set('Consultando WCL…');
    }
    try {
      let processedTotal = 0;
      const newestPullId = await this.edgeFunctions.analyzeReportFully(code, (r) => {
        processedTotal += r.processed;
        if (isManual) {
          this.importProgress.set(
            r.remaining > 0 ? `Procesados ${processedTotal} pulls, quedan ${r.remaining}…` : `Procesados ${processedTotal} pulls.`,
          );
        }
        this.duplicateWarning.set(r.possibleDuplicateOf);
      });
      this.currentReportCode.set(code);
      // §"actividad real" = se encontró una pull nueva de verdad, o el
      // propio RL pulsó "Actualizar" a mano — un tick de auto-refresh vacío
      // (sin novedades) NO cuenta, o el reloj de los 10 min nunca vencería
      // mientras la pestaña siga abierta sin que pase nada de verdad.
      if (newestPullId || isManual) this.lastActivityAt = Date.now();
      this.persistSession();
      this.lastCheckedAt.set(new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }));
      const pulls = await this.reportsService.listPulls(code);
      this.pulls.set(pulls);
      this.reportsService.listNightPlayers(code).then((p) => this.nightPlayers.set(p)).catch(() => {}); // best-effort, no bloquea la carga principal
      // Solo saltamos al pull recién procesado si de verdad hay uno nuevo — un
      // ciclo de auto-refresh sin novedades no debe robarte la selección actual.
      // Si el nuevo pull es de OTRO boss (la raid avanzó), el picker tiene que
      // seguirle la pista en vez de dejar el pin manual de un boss ya viejo.
      if (newestPullId) {
        this.selectedPullId.set(newestPullId);
        this.manualActiveKey.set(undefined);
      } else if (!this.selectedPullId()) {
        this.selectedPullId.set(pulls.at(-1)?.id ?? null);
      }
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      if (isManual) {
        this.importing.set(false);
        this.importProgress.set(null);
      }
    }
  }

  toggleAutoRefresh(): void {
    this.autoRefresh.update((v) => !v);
    if (this.autoRefresh()) {
      this.lastActivityAt = Date.now(); // encenderlo a mano también cuenta como actividad — no se autocierra a los 10min de haberlo prendido
      this.startAutoRefresh();
    } else {
      this.stopAutoRefresh();
    }
    this.persistSession();
  }

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.autoRefreshTimer = setInterval(() => {
      // §"hasta que no haya cambios en 10 minutos... ahí ya se puede dar por
      // cerrado el log" (feedback real): el auto-cierre no depende solo de
      // volver a la pestaña — si se queda abierta sin novedades, también se
      // apaga sola en vez de seguir sondeando un log que ya terminó.
      if (Date.now() - this.lastActivityAt >= LIVE_STALE_MS) {
        this.autoRefresh.set(false);
        this.stopAutoRefresh();
        this.persistSession();
        return;
      }
      const code = this.currentReportCode();
      if (code && !this.importing()) void this.runAnalyze(code, false);
    }, AUTO_REFRESH_MS);
  }

  private stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  selectPull(pull: PullListItem): void {
    this.selectedPullId.set(pull.id);
  }

  pullLabel(pull: PullListItem): string {
    return `#${pull.pull_number}`;
  }

  pullSubLabel(pull: PullListItem): string {
    if (pull.ninja_pull_excluded) return `Ninja pull · ${formatDuration(pull.duration_ms)} · no cuenta como intento`;
    if (pull.kill) return `Kill · ${formatDuration(pull.duration_ms)}`;
    // §"fases de encuentro... en todos los sitios donde corresponda"
    // (feedback real): en un wipe, "45% restante" no dice si fue pronto o
    // muy lejos en bosses con varias fases — se añade la fase alcanzada
    // cuando WCL la trae, sin sustituir el % (sigue siendo la fuente para
    // "mejor intento" hasta que se decida lo contrario, ver riesgos).
    const phase = formatPhaseReached(pull.phase_transitions, pull.last_phase_is_intermission, this.phasesByBoss().get(pull.boss_id) ?? null);
    const base = `Wipe ${formatPct(pull.wipe_pct)} · ${formatDuration(pull.duration_ms)}`;
    return phase ? `${base} · ${phase}` : base;
  }

  groupSummary(group: PullGroup): string {
    const attempts = `${group.attemptCount} intento${group.attemptCount === 1 ? '' : 's'}`;
    if (group.killCount > 0) return `${attempts} · ${group.killCount} kill${group.killCount === 1 ? '' : 's'}`;
    return `${attempts} · mejor ${formatPct(group.bestWipePct)}`;
  }
}
