// Colocar en: src/app/core/night-player-summary-cache.service.ts
// §"esos valores no se pueden almacenar de alguna manera aunque se
// actualicen... no todos los días tenemos raid... tiene sentido que
// actualice una única vez cuando termina la raid" (feedback real,
// 2026-08-29): el dosier de un jugador (night-player-summary.service.ts) es
// caro de calcular — fiabilidad de 60 días, mecánicas/muertes/interrupts de
// la noche, y la "Evolución" que además recalcula TODO lo anterior para la
// noche previa — pero determinista: mientras nadie suba un pull nuevo NI
// corrija algo retroactivamente (wipe call reanalizado, ninja pull,
// resolución en Ajustes), el resultado es exactamente el mismo. Mismo
// patrón que ya usa Roster (RosterSnapshotCacheService, §12): snapshot en
// localStorage + una comprobación barata (fingerprint) para saber si sigue
// siendo válido, en vez de recalcularlo en cada visita.
//
// Reutiliza el MISMO fingerprint que ya usa Roster en vez de inventar uno
// nuevo — es una foto del estado global (último pull, último pull corregido
// vía pulls.updated_at, último report, roster de wowaudit) que ya cubre
// exactamente las señales de invalidación que hacen falta aquí también: si
// no cambió nada de eso desde que se guardó este dosier, ningún dato que
// pudiera afectar a esta noche o a la ventana de 60 días de fiabilidad
// cambió tampoco.
import { Injectable, inject } from '@angular/core';
import { RosterSnapshotCacheService } from './roster-snapshot-cache.service';
import type { NightPlayerSummary } from './night-player-summary.service';

// §bug real encontrado en auditoría (2026-08-29): "hemos perdido todos los
// iconos" — el caché no tenía versión de FORMA, solo de estado (fingerprint
// de último pull/roster). Un dosier ya cacheado antes de que
// defensiveSummary.pressurePullBreakdown existiera seguía sirviéndose tal
// cual (el fingerprint no cambió), y `.filter()` sobre ese campo `undefined`
// reventaba loadSpellIcons() ANTES de llegar a pedir ningún icono — no solo
// los nuevos, todos. v1 -> v2 invalida de golpe cualquier entrada con la
// forma antigua; sube este número cada vez que NightPlayerSummary cambie de
// forma de un modo que un objeto viejo no pueda satisfacer en tiempo de
// ejecución (campos nuevos leídos sin `?.`, nunca solo por añadir un campo
// opcional).
// §bug real REPETIDO (2026-08-29, mismo turno): "al final no hay nada de
// eso" — añadí mechanicPressureBreakdown a NightDefensiveSummary DESPUÉS de
// subir a v2, sin volver a subir la versión. Un caché guardado entre esa v2
// y este cambio no tiene el campo nuevo — con `?? []` de seguridad la
// sección entera de "Mecánicas que exigían respuesta" se queda vacía en
// silencio, sin error visible, y lo único que se veía era la lista vieja de
// "Pulls sin ningún defensivo usado" (que si acumula muchos pulls, sí puede
// leerse como "una lista muy larga"). Lección: cada cambio de forma de
// NightPlayerSummary necesita su propio bump, no solo el primero.
// v4 corrige también la semántica del grid defensivo: una ventana sin
// ninguna respuesta utilizable ya no se cachea como si fuera un fallo. El
// shape no cambia, pero mantener v3 serviría ratios antiguos hasta que
// cambiara el fingerprint global.
// v5 (2026-08-29): campo nuevo unassignedMechanicCredits — mismo motivo que
// el bump de v4, un caché v4 servido tal cual no tendría este campo.
// v6 (2026-08-29): mismo shape, pero pullScore/nightScore/mecanica cambian
// de VALOR (mechanicScoreFor ahora suma un bonus por mecánica sin asignar
// resuelta con éxito — ver pull-analysis.service.ts) — un caché v5 seguiría
// sirviendo el número de antes del bonus hasta que algo más lo invalidara,
// mismo motivo exacto que el bump de v4.
// v7 (2026-08-30): mismo shape otra vez, pero reliability/nightReliability
// (el `overall` de Fiabilidad) cambia de VALOR — preparación al 100% ya no
// suma al blend (§"se da por supuesto que si lo tienes que hacer no cuenta
// para sumar", feedback real — ver effectiveAxisWeights en
// reliability.service.ts). Mismo motivo exacto que el bump de v6: sin esto,
// un dosier ya cacheado sigue enseñando el overall de la fórmula vieja
// hasta que algo más invalide el fingerprint.
// v8 (2026-08-30): mismo shape, pero mechanicFails[].resolution/note y
// deaths[].resolution/note cambian de VALOR — 245 filas de
// boss_mechanics_candidates (resolution + ai_classification.notes) tenían
// un artefacto de markdown-link+JSON pegado delante del texto real (§"se ha
// colado algo en la descripcion", feedback real — ver las migraciones
// 20260830090000/20260830100000). Ya corregido en Supabase, pero un dosier
// cacheado ANTES de esa corrección seguiría sirviendo el texto corrupto
// hasta que algo más invalide el fingerprint — mismo motivo que v6/v7.
// v9 (2026-08-30): bug real encontrado ("por un lado hay gente que no le
// sale el parse" — feedback real, verificado): pulls[].worldRankPercent es
// un campo NUEVO en NightPullSummary (para la columna "Parse" de la tabla
// de asistencia) — un resumen ya cacheado bajo v8 simplemente no lo tiene,
// así que night-report.component.ts lo leía como `undefined` y lo trataba
// como "sin dato" (`!= null` es false para undefined también) — no fallaba,
// pero mentía "—" para cualquier jugador cuyo dosier ya estuviera en caché
// desde antes de este cambio, exactamente el mismo síntoma que v4/v5/v6/v7
// ya arreglaron cada vez que se añadía un campo al shape cacheado sin mover
// la versión.
// v10 (2026-09-01): añade defensiveManagementV2. Sin bump, una entrada v9
// ocultaría la sección 04 nueva aunque el backfill de evaluations ya exista.
// v11 (2026-09-02): separa adherencia/cobertura, admite modo mixed y usa el
// score nocturno central. El fingerprint delegado ya incluye evaluated_at.
// v12 (2026-09-05): campo nuevo canonicalDefensive (cutover frontend hacia la
// generación defensiva v7 publicada — ver canonical-defensive-summary.service.ts).
// Un caché v11 no tiene este campo; sin el bump, el hero/estrip/mecánicas
// defensivas de la infografía v3 leerían `undefined` en vez de la generación
// canónica hasta que algo más invalidara el fingerprint — mismo motivo que
// todos los bumps anteriores.
const STORAGE_PREFIX = 'avoid:night-player-summary:v12:';
// No acumular sin límite en localStorage — solo los dosiers consultados más
// recientemente (un RL mirando varios raiders seguidos en la misma sesión).
const MAX_ENTRIES = 12;

interface CachedEntry {
  fingerprint: string;
  savedAt: string;
  summary: NightPlayerSummary;
}

function cacheKey(reportCode: string, playerName: string): string {
  return `${STORAGE_PREFIX}${reportCode}|${playerName}`;
}

@Injectable({ providedIn: 'root' })
export class NightPlayerSummaryCacheService {
  private rosterCache = inject(RosterSnapshotCacheService);

  /** Delegado tal cual — ver comentario de arriba sobre por qué se reutiliza el de Roster. */
  fingerprint(): Promise<string> {
    return this.rosterCache.fingerprint();
  }

  read(reportCode: string, playerName: string): CachedEntry | null {
    try {
      const raw = localStorage.getItem(cacheKey(reportCode, playerName));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<CachedEntry>;
      if (typeof parsed.fingerprint !== 'string' || !parsed.summary) return null;
      return parsed as CachedEntry;
    } catch {
      return null;
    }
  }

  write(reportCode: string, playerName: string, fingerprint: string, summary: NightPlayerSummary): void {
    try {
      this.evictOldestBeyondLimit();
      localStorage.setItem(
        cacheKey(reportCode, playerName),
        JSON.stringify({ fingerprint, savedAt: new Date().toISOString(), summary } satisfies CachedEntry),
      );
    } catch {
      // La vista sigue funcionando en memoria si el navegador bloquea o
      // agota localStorage; la persistencia es una optimización, no la fuente.
    }
  }

  private evictOldestBeyondLimit(): void {
    const entries: { key: string; savedAt: string }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key) ?? '') as Partial<CachedEntry>;
        entries.push({ key, savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '' });
      } catch {
        entries.push({ key, savedAt: '' });
      }
    }
    if (entries.length < MAX_ENTRIES) return;
    entries.sort((a, b) => a.savedAt.localeCompare(b.savedAt));
    for (const entry of entries.slice(0, entries.length - MAX_ENTRIES + 1)) {
      localStorage.removeItem(entry.key);
    }
  }
}
