export type DocTone = 'info' | 'warning' | 'important';

export interface DocTable {
  headers: string[];
  rows: string[][];
}

export interface DocBlock {
  title?: string;
  paragraphs?: string[];
  items?: string[];
  formula?: string;
  table?: DocTable;
  tone?: DocTone;
}

export interface DocSection {
  id: string;
  title: string;
  summary: string;
  keywords?: string[];
  blocks: DocBlock[];
  technicalRefs?: string[];
}

export interface DocChapter {
  id: string;
  title: string;
  route?: string;
  intro: string;
  sections: DocSection[];
}

const noCertainty =
  'No se puede determinar con certeza a partir del código actual.';

export const DOCUMENTATION_CHAPTERS: DocChapter[] = [
  {
    id: 'introduccion',
    title: 'Introducción y mapa de la aplicación',
    intro:
      'IRIS convierte reports de Warcraft Logs en una vista operativa del pull, históricos, señales de roster e informes por noche. La documentación distingue siempre dato fuente, cálculo derivado y presentación.',
    sections: [
      {
        id: 'mapa-rutas',
        title: 'Rutas reales',
        summary: 'Inventario de las pantallas enlazables que declara el router.',
        blocks: [
          {
            table: {
              headers: ['URL', 'Pantalla', 'Identidad'],
              rows: [
                ['/', 'Raid', 'Report activo y pull seleccionado'],
                ['/roster', 'Roster', 'Estado del equipo en una ventana móvil de 60 días'],
                ['/historial', 'Histórico', 'Reports sincronizados o importados'],
                ['/ajustes', 'Ajustes', 'Mecánicas, sin asignar, defensivos y Discord'],
                ['/boss/:bossId/:difficulty', 'Histórico de boss', 'Boss y dificultad'],
                ['/player/:name', 'Histórico de jugador', 'Jugador a lo largo del tiempo'],
                ['/report/:reportCode', 'Informe de noche', 'Raid completa y report'],
                ['/report/:reportCode/player/:playerName', 'Dosier de jugador', 'Jugador y noche concreta'],
                ['/documentacion', 'Documentación', 'Este manual; admite anchors compartibles'],
              ],
            },
          },
          {
            title: 'Relaciones entre pantallas',
            items: [
              'Histórico abre un report en Raid mediante ?report= y, si solo hay metadata, dispara su análisis.',
              'Cada boss del selector de Raid enlaza a su histórico por boss+dificultad.',
              'El resumen de una noche enlaza al informe de raid y a los dosieres de quienes participaron.',
              'Roster abre primero un drawer y permite continuar al histórico completo del jugador.',
              'Informe de noche y histórico de jugador enlazan a los dosieres jugador×noche.',
            ],
          },
        ],
        technicalRefs: ['src/app/app.routes.ts', 'src/app/app.html'],
      },
      {
        id: 'reglas-transversales',
        title: 'Reglas transversales de lectura',
        summary: 'Convenciones que cambian cómo deben interpretarse casi todas las métricas.',
        blocks: [
          {
            items: [
              'HP restante procede de WCL; progreso visual = 100 − HP restante. Una kill tiene wipe_pct=0.',
              'El número visible de intento es 1…N dentro del mismo boss+dificultad y omite ninja pulls. pull_number persiste la numeración técnica global del report.',
              'Un ninja pull se conserva para auditoría pero se excluye como intento completo de las estadísticas.',
              'Un wipe call no invalida el pull: solo excluye las muertes del cluster y los eventos ocurridos desde wipeCallStartMs.',
              'Melee del boss sobre un no-tank cuando los tanks han caído se muestra, pero no se atribuye como fallo estadístico del jugador.',
              'Los valores ausentes no se sustituyen por cero salvo fallbacks de compatibilidad expresamente descritos.',
            ],
          },
          {
            tone: 'important',
            paragraphs: [
              'Las notas y briefs de IA son una capa interpretativa. Las cifras del pull, del roster y del informe determinista se calculan desde tablas y eventos; el texto de IA no modifica esas cifras.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/shared/death-statistics.util.ts',
          'src/app/shared/pull-consistency.util.ts',
        ],
      },
    ],
  },
  {
    id: 'fuentes',
    title: 'Fuentes de datos e integraciones',
    intro:
      'La base operativa es Supabase. Las Edge Functions importan o enriquecen datos externos y el frontend hace agregaciones de lectura sobre las tablas resultantes.',
    sections: [
      {
        id: 'warcraft-logs',
        title: 'Warcraft Logs (WCL)',
        summary:
          'Fuente principal de reports, fights, actores, daño, sanación, casts, buffs, debuffs, dispels, equipo, talentos, fases y rankings.',
        blocks: [
          {
            items: [
              'sync-reports descubre metadata del histórico de la guild; analyze-report ingiere los fights de un report en lotes de hasta 5.',
              'Report.rankings aporta rankPercent y totalParses para el percentil mundial del jugador en ese pull, boss, dificultad y spec.',
              'fightRankings aporta hasta páginas de 50 kills públicas para mediana de duración, percentil 25 y tasa de kills sin muertes.',
              'DamageTaken se reutiliza para DPS/HPS agregados, perfil de muerte, serie de raid y ventanas de presión defensiva.',
              'La UI enlaza de vuelta a WCL con report_code y fight_id para verificar evidencia.',
            ],
          },
          {
            title: 'Actualización y fallo',
            paragraphs: [
              'La importación es manual o se repite cada 18 segundos en modo En vivo. Si WCL limita o falla, la función devuelve error y lo ya persistido sigue disponible. La frecuencia de actualización interna de WCL no está definida en el repositorio. ' +
                noCertainty,
            ],
          },
        ],
        technicalRefs: [
          'supabase/functions/_shared/wcl-client.ts',
          'supabase/functions/analyze-report/index.ts',
          'supabase/functions/sync-reports/index.ts',
        ],
      },
      {
        id: 'blizzard-wago',
        title: 'Blizzard API y Wago DB2',
        summary:
          'Blizzard aporta Journal, perfiles y medios; Wago DB2 aporta metadatos tabulares de dificultad y hechizos que la API no expone de forma suficiente.',
        blocks: [
          {
            items: [
              'Journal Encounter y sus secciones crean el catálogo de habilidades por boss.',
              'Character Media resuelve el avatar del roster cuando el perfil es accesible.',
              'Wago DB2 resuelve Difficulty, JournalEncounter, JournalEncounterSection y definiciones relacionadas.',
              'El mapeo de dificultad puntúa coincidencia de nombre, restricciones del encuentro/sección y tamaño de raid; un empate queda como ambiguous y no se inventa un ID.',
              'Si falta metadata de dificultad, las habilidades no se eliminan: se incluyen por prudencia y la UI muestra el estado no resuelto.',
            ],
          },
        ],
        technicalRefs: [
          'supabase/functions/_shared/blizzard-client.ts',
          'supabase/functions/_shared/wago-db2-client.ts',
          'supabase/functions/_shared/difficulty-mapping.ts',
        ],
      },
      {
        id: 'wowaudit-supabase',
        title: 'WoWAudit y base de datos propia',
        summary:
          'WoWAudit define el roster canónico; Supabase conserva la evidencia y todos los derivados consultables.',
        blocks: [
          {
            items: [
              'wowaudit_roster aporta identidad, reino, clase, rango Main/Trial, rol configurado y su asistencia propia.',
              'Si la spec más reciente observada en WCL implica otro rol, el rol observado gana sobre WoWAudit; si la spec no se reconoce se conserva WoWAudit.',
              'El porcentaje de asistencia que enseña IRIS no es attended_percentage de WoWAudit: se calcula con noches reales importadas desde el inicio de temporada.',
              'Supabase guarda reports, encuentros, pulls, registros por jugador, eventos de mecánica, catálogos, briefs, informes y vínculos de Discord.',
              'Las lecturas se hacen con anon key y RLS pública; las escrituras sensibles pasan por Edge Functions con credenciales de servidor.',
            ],
          },
          {
            tone: 'warning',
            paragraphs: [
              'El código no programa una sincronización automática de WoWAudit: existe un botón manual. Por tanto, la cadencia real depende de cuándo se pulse. ' +
                noCertainty,
            ],
          },
        ],
        technicalRefs: [
          'src/app/core/wowaudit-roster.service.ts',
          'src/app/core/supabase.service.ts',
          'supabase/functions/sync-wowaudit-roster/index.ts',
        ],
      },
      {
        id: 'integraciones-secundarias',
        title: 'IA, Discord, Wowhead, WoWAnalyzer y enlaces externos',
        summary: 'Integraciones que enriquecen, publican o permiten verificar; no todas son fuentes de métricas.',
        blocks: [
          {
            table: {
              headers: ['Integración', 'Uso real', '¿Fuente de puntuación?'],
              rows: [
                ['Anthropic / flujo manual LLM', 'Briefs de pull, noche y jugador; clasificación asistida', 'No'],
                ['Discord REST', 'Canales privados, envío de resúmenes e infografías', 'No'],
                ['Wowhead', 'Iconos, tooltips y enlaces de spells/items', 'No'],
                ['WoWAnalyzer local', 'Enlace/proxy para análisis de rotación', 'No'],
                ['Raider.IO', 'Enlace al perfil construido desde nombre/reino', 'No; no se consulta su API'],
                ['Battle.net web', 'Enlace al perfil del personaje', 'No'],
                ['localStorage', 'Report activo, modo vivo y cachés de roster/dosier', 'No'],
              ],
            },
          },
          {
            tone: 'info',
            paragraphs: [
              'Los briefs generados se cachean por ámbito. El flujo manual entrega exactamente el prompt, acepta una respuesta pegada, la valida y la persiste con model="manual".',
            ],
          },
        ],
        technicalRefs: [
          'src/app/core/edge-functions.service.ts',
          'src/app/features/live-pull/llm-analysis-card.component.ts',
          'supabase/functions/send-discord-message/index.ts',
        ],
      },
    ],
  },
  {
    id: 'raid',
    title: 'Raid: sesión y selector de pulls',
    route: '/',
    intro:
      'La portada carga un report de WCL, conserva la sesión del navegador y permite revisar o seguir el último pull sin separar el flujo histórico del flujo en vivo.',
    sections: [
      {
        id: 'importar-report',
        title: 'Importar, actualizar y modo En vivo',
        summary: 'Cómo entra un report y qué cambia al activar el seguimiento.',
        blocks: [
          {
            items: [
              'Acepta URL o código de WCL; extractReportCode normaliza la entrada.',
              'analyze-report procesa como máximo 5 fights por llamada y el cliente repite hasta remaining=0, con guardia de 50 iteraciones.',
              'En vivo repite la importación cada 18 s y selecciona el pull más reciente.',
              'Report, estado En vivo y última actividad se guardan en localStorage. Se reanuda solo si la actividad tiene menos de 10 minutos.',
              'Un report sospechosamente duplicado se avisa si comparte al menos dos bosses y su inicio está dentro de ±6 h; no se bloquea.',
              'Los 10 reports más recientes se pueden cargar desde el selector sin volver a buscar su URL.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/features/raid-session/raid-session.component.ts',
          'src/app/core/edge-functions.service.ts',
        ],
      },
      {
        id: 'selector-boss-pull',
        title: 'Selector de boss, dificultad y pull',
        summary: 'Agrupa el report por boss+dificultad y abre una sola fila de intentos.',
        blocks: [
          {
            items: [
              'attemptCount y killCount excluyen ninja_pull_excluded; el pull excluido sigue visible y suma excludedCount.',
              'bestWipePct es el menor wipe_pct de los intentos válidos. Una kill puede producir 0.',
              'Las fases se muestran como Fase X/N — Nombre y añaden “intermedio” si WCL marcó la última fase así.',
              'El ordinal visible se calcula entre intentos válidos del grupo, no con el pull_number global del report.',
              'Cambiar de pull recarga detalle, comparativas, timeline, callouts y diagnósticos para ese pull.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/features/raid-session/raid-session.component.ts',
          'src/app/shared/pull-consistency.util.ts',
        ],
      },
      {
        id: 'resumen-noche-portada',
        title: 'Resumen de la noche y progreso de temporada',
        summary: 'Agregados ligeros del report activo y badge global de progreso.',
        blocks: [
          {
            formula:
              'wipes = intentos válidos − kills; tiempo = Σ duration_ms; boss más difícil = grupo con más wipes',
          },
          {
            items: [
              'Bosses intentados cuenta grupos boss+dificultad con al menos un intento válido.',
              'El recap para Discord enumera intentos, kills o mejor HP restante por grupo.',
              'El progreso de temporada usa known_raid_bosses como denominador y bosses distintos con wipe_pct=0 como numerador, separado por dificultad.',
              'Solo aparecen dificultades con algún pull real; que no aparezca Mythic/LFR significa “sin intentos observados”, no 0 bosses matados.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/core/reports.service.ts',
          'src/app/features/raid-session/season-progress.component.ts',
        ],
      },
    ],
  },
  {
    id: 'live-pull',
    title: 'Detalle de un pull',
    intro:
      'La vista operativa compara el intento con el anterior válido del mismo report, boss y dificultad. Todos los datos de auditoría quedan accesibles aunque el resumen priorice decisiones.',
    sections: [
      {
        id: 'cabecera-pull',
        title: 'Cabecera, resultado, duración, HP y fase',
        summary: 'Identidad y resultado del intento seleccionado.',
        blocks: [
          {
            items: [
              'Resultado es kill cuando encounter.kill es verdadero o wipe_pct=0.',
              'Duración se redondea al segundo y se presenta como m:ss.',
              'HP restante es bossPercentage/fightPercentage persistido como wipe_pct; progreso = 100 − wipe_pct.',
              'La fase es informativa porque algunos bosses reinician o cambian su barra y el porcentaje puede no ser comparable entre fases.',
              'La comparativa contra el intento anterior conserva tres unidades: puntos de progreso, muertes e incidentes. El veredicto es improved, regressed, mixed o unchanged; no fabrica un score compuesto.',
            ],
          },
        ],
        technicalRefs: ['src/app/core/pull-analysis.service.ts'],
      },
      {
        id: 'metricas-pull',
        title: 'Cards: resultado/HP, muertes, incidentes y racha',
        summary: 'Cada card abre el drawer de procedencia con fuente y método.',
        blocks: [
          {
            table: {
              headers: ['Card', 'Cálculo', 'Casos especiales'],
              rows: [
                ['Resultado / HP', 'Kill si wipe_pct=0; si no, HP restante y gauge 100−wipe_pct', 'En kill muestra ritmo vs mediana pública si existe'],
                ['Muertes', 'count(died=true) tras exclusiones estadísticas', 'No cuenta cluster de wipe call confirmado ni Melee no evaluable'],
                ['Incidentes', 'Eventos fail/partial_fail + grupos de muertes sin cast correlacionado', 'Una instancia cuenta una vez aunque golpee a varios'],
                ['Racha del problema', 'Mismo jugador y mechanicId muriendo en intentos válidos consecutivos', 'Solo aparece desde 2 intentos'],
              ],
            },
          },
          {
            paragraphs: [
              'Las muertes sin cast correlacionado se agrupan por habilidad en ventanas de 2 s. Una muerte se asocia a un evento si su timestamp está a ±4 s del trigger de la habilidad.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/core/pull-analysis.service.ts',
          'src/app/shared/pull-consistency.util.ts',
        ],
      },
      {
        id: 'wipe-call-ninja',
        title: 'Wipe call y ninja pull',
        summary: 'Dos exclusiones distintas y editables, con alcance estadístico diferente.',
        blocks: [
          {
            title: 'Wipe call',
            items: [
              'Solo se evalúa en wipes. Busca una cadena terminal con huecos de hasta 4 s, al menos 60% de quienes seguían vivos y final a ≤15 s del cierre.',
              'Exige dos señales entre diversidad/desconocidos, desplome de healing, desplome de daño y muertes sostenidas, salvo wipe masivo en los primeros 10 s.',
              'Confianza = 20% simultaneidad + 20% diversidad + 10% desconocidas + 20% caída de healing + 10% caída de daño + 10% muertes sostenidas + 10% cercanía al final.',
              'Se autoexcluye desde 55/100. Un wipe masivo temprano tiene como mínimo 85.',
              'Hasta las primeras 3 muertes causales se mantienen evaluables; la frontera exacta depende de si la raid ya estaba colapsada.',
            ],
          },
          {
            title: 'Ninja pull',
            formula:
              'wipe, duración < 45 s y (engagedFraction ≤ 0,30 o HP del boss ≥ 90%)',
            paragraphs: [
              'Engaged significa que el jugador murió o recibió daño. El backfill histórico fue más estricto (<15 s), porque ya no conservaba todos los eventos crudos. El usuario puede restaurar o excluir manualmente.',
            ],
          },
        ],
        technicalRefs: [
          'supabase/functions/_shared/wipe-call-detection.ts',
          'supabase/functions/analyze-report/index.ts',
          'supabase/migrations/20260827090000_ninja_pull_detection.sql',
        ],
      },
      {
        id: 'direccion-coaching',
        title: 'A quién dirigir: muertes y mecánicas',
        summary: 'Separa la muerte de un fallo individual no letal y conserva la evidencia temporal.',
        blocks: [
          {
            items: [
              'Muertes: causa final de WCL, categoría, perfil burst/sustained, daño de los últimos 5 s, healing de los últimos 6 s y estado defensivo exacto.',
              'Mecánicas: eventos fallidos personales (zona, spread, soak, objetivo personal o sin clasificar) por jugador; una fila de muerte correlacionada no se duplica aquí.',
              'Daño y sanación de una mecánica se limitan a su ventana; “defensivo usado” busca un cast propio alrededor del evento.',
              'Las filas críticas se ordenan cronológicamente. Una racha rota de al menos 2 aparece como callout positivo sin timestamp del pull actual.',
              'Las notas “i” salen de la clasificación del catálogo cruzada por nombre de mecánica, no de una inferencia nueva en la UI.',
            ],
          },
        ],
        technicalRefs: ['src/app/core/pull-analysis.service.ts'],
      },
      {
        id: 'diagnostico-pull',
        title: 'Diagnóstico: IA, jugadores, timeline, datos y benchmarks',
        summary: 'Cuatro tabs cerradas por defecto que sirven para verificar el resumen.',
        blocks: [
          {
            table: {
              headers: ['Tab', 'Contenido'],
              rows: [
                ['Análisis IA', 'Headline, mejoras, regresiones y acciones; API o prompt manual; cache por pull'],
                ['Jugadores', 'Rol, clase/spec, percentil, DPS, HPS, absorbido, consumibles y detalle expandible'],
                ['Timeline', 'Primer cast limpio, todos los fallos/muertes y resumen de repeticiones limpias'],
                ['Datos y benchmarks', 'Ritmo de kill, donut de casts por categoría y opciones defensivas al morir'],
              ],
            },
          },
          {
            title: 'Columnas de jugadores',
            items: [
              'DPS/HPS = total de daño/sanación dividido por la duración del fight, mínimo 1 s; las mini-barras usan el máximo del pull como escala.',
              'Percentil = rankPercent de WCL contra misma clase/spec, boss y dificultad. Color: <25 rojo, 25–<75 ámbar, ≥75 verde; — si WCL no lo rankea.',
              'Absorbido procede del daño absorbido registrado para el jugador.',
              'Talentos solo enlazan nodos resueltos a spellId; los no resueltos se cuentan en vez de ocultarse.',
              'Equipo muestra itemId, slot e itemLevel; consumibles distinguen piedra disponible/usada y poción usada.',
              'Estado defensivo al morir: activo, disponible sin usar, en cooldown o desconocido.',
            ],
          },
          {
            title: 'Benchmark de ritmo',
            paragraphs: [
              'Solo compara kills. Usa la mediana de kills públicas, no el récord mundial. Igual o más rápido es verde; más de 15% más lento es ámbar; entre ambos es neutral. También muestra qué fracción de la muestra terminó con cero muertes.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/features/live-pull/player-stats-table.component.ts',
          'src/app/core/pull-analysis.service.ts',
        ],
      },
    ],
  },
  {
    id: 'roster',
    title: 'Roster',
    route: '/roster',
    intro:
      'Combina el roster oficial con evidencia de los últimos 60 días. La prioridad no es ordenar por una cifra: exige una acción verificable.',
    sections: [
      {
        id: 'resumen-roster',
        title: 'Resumen, composición, filtros y buscador',
        summary: 'Qué cuenta cada card y cómo se forma el listado.',
        blocks: [
          {
            items: [
              'Roster oficial = todas las filas Main/Trial de WoWAudit.',
              'Con evidencia = sampleSize>0 en los últimos 60 días; Sin evidencia nunca aparece como 0 negativo.',
              'Composición agrupa Tank, Heal y DPS (Melee+Ranged); rol desconocido queda en grupo separado.',
              'Filtros: Todos, Atención (action o review), Sin datos y Trials. El buscador compara el nombre sin distinguir mayúsculas.',
              'Prioridades muestra como máximo 5 y ordena action antes que review, después más señales y finalmente nombre.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/features/roster/roster.component.ts',
          'src/app/features/roster/roster-view.util.ts',
        ],
      },
      {
        id: 'estados-roster',
        title: 'Estados y señales accionables',
        summary: 'Por qué un jugador aparece como Antes de raid, Revisar, Correcto o Sin datos.',
        blocks: [
          {
            table: {
              headers: ['Señal', 'Condición real', 'Severidad'],
              rows: [
                ['Preparación incompleta', 'Falta al menos un enchant o slot de gema en el primer pull de la última noche', 'action'],
                ['Patrón repetido', 'Zona evitable, ≥3 impactos y ≥2 bosses distintos en 60 días', 'review'],
                ['Defensivos', 'Eje defensivo <60 y al menos 3 pulls con oportunidad', 'review'],
                ['Tendencia', 'trend=down y al menos 2 noches de muestra', 'review'],
              ],
            },
          },
          {
            items: [
              'Antes de raid: existe cualquier señal action.',
              'Revisar: no hay action pero existe alguna señal review.',
              'Correcto: hay muestra y ninguna señal accionable.',
              'Sin datos: sampleSize=0; pertenece al roster pero no aparece en pulls evaluables.',
            ],
          },
        ],
        technicalRefs: ['src/app/features/roster/roster-view.util.ts'],
      },
      {
        id: 'fiabilidad',
        title: 'Fiabilidad 60 días',
        summary: 'Score renormalizado de Mecánica, Defensivos y Preparación; Asistencia no puntúa.',
        blocks: [
          {
            formula:
              'w = 0,5^(díasDesdePull/10); overall = round(Σ(eje × peso) / Σ(pesos de ejes con dato))',
          },
          {
            table: {
              headers: ['Eje', 'Peso base', 'Dato'],
              rows: [
                ['Mecánica', '0,40 (44,44% si están los 3 ejes)', 'mechanicScoreFor por pull, ponderado por recencia'],
                ['Defensivos', '0,30 (33,33%)', 'Respuesta al morir (peso doble) y ventanas cubiertas/cubribles'],
                ['Preparación', '0,20 (22,22%)', 'Enchants+slots con gema del primer pull de cada noche'],
              ],
            },
          },
          {
            items: [
              'Semivida 10 días: un pull de hace 10 días pesa la mitad que uno actual.',
              'Si falta un eje, sus puntos no se convierten en 0: el denominador usa solo pesos observados.',
              'La respuesta defensiva en una muerte evaluable pesa 2; una ventana normal pesa 1.',
              'Si cubre C de N ventanas, la muestra vale C/N. Si cubre 0 pero lanzó algo fuera de tiempo, obtiene crédito 0,30; si no lanzó nada, 0.',
              'Preparación solo evalúa el primer pull por report para no castigar loot equipado durante la raid.',
              'La UI redondea overall al entero; los ejes se conservan como decimales y se muestran redondeados.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/core/reliability.service.ts',
          'supabase/migrations/20260829070000_unassigned_mechanic_success_count.sql',
        ],
      },
      {
        id: 'mecanica-score',
        title: 'Eje Mecánica y bonus de tareas sin asignar',
        summary: 'Fórmula compartida por Fiabilidad y la puntuación de cada pull del dosier.',
        blocks: [
          {
            formula:
              'ratioScore = (elegibles − fallosZonaSpread) / elegibles; countScore = max(0, 1 − 0,25 × fallosSoakTarget); base = ratioScore × countScore; score = base + min(0,15, 0,05 × éxitosSinAsignar)',
          },
          {
            items: [
              'Zona evitable y spread usan ratio porque se conoce si el jugador seguía vivo y si recibió el impacto.',
              'Soak y objetivo personal usan penalización fija: recibir el golpe puede ser lo correcto y el código no conoce la asignación.',
              'Los éxitos de huevos/orbes/ítems sin asignación suman 5 puntos porcentuales cada uno, máximo 15 por pull.',
              'El resultado puede superar 100% de forma deliberada: el bonus recompensa una tarea adicional incluso en un pull limpio.',
              'Fallback antiguo: sin columnas de ratio, cada fallo personal resta 25%; sin conteo, se usa hadAvoidableDamage/selfPositioningDeath como binario.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/core/pull-analysis.service.ts',
          'src/app/core/reliability.service.ts',
        ],
      },
      {
        id: 'consistencia-tendencia',
        title: 'Consistencia, tendencia y confianza de muestra',
        summary: 'Medidas complementarias al overall que explican estabilidad y cantidad de evidencia.',
        blocks: [
          {
            formula:
              'ejecuciónPull = mecánica si no hay defensiva; si la hay, mecánica×0,70 + defensiva×0,30; consistencia = clamp(mediaPonderada − 0,5×desviación, 0, 100)',
          },
          {
            items: [
              'Consistencia requiere al menos 5 pulls. cleanPullRate cuenta ejecuciónPull≥80.',
              'Tendencia compara la primera y segunda mitad temporal de la ventana con la misma fórmula overall: cambio ≥4 = mejorando; ≤−4 = a la baja; en otro caso estable.',
              'Evidencia alta: ≥4 noches y ≥20 pulls. Media: ≥2 noches y ≥10 pulls. El resto con muestra es baja.',
              'El drawer enseña noches, pulls, última evidencia, ejes, preparación exacta, consistencia y tendencia; permite abrir el histórico completo.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/core/reliability.service.ts',
          'src/app/features/roster/roster-view.util.ts',
        ],
      },
      {
        id: 'asistencia',
        title: 'Asistencia real',
        summary: 'Noches distintas en las que aparece el jugador, no eventos programados de WoWAudit.',
        blocks: [
          {
            formula:
              'attendance = nochesUTCDistintasConRegistro / nochesUTCDistintasImportadasDesdeInicioDeSeason × 100',
          },
          {
            items: [
              'Dos uploads del mismo día cuentan como una sola noche, aunque tengan report_code distinto.',
              'Una noche cuenta para el jugador si tiene cualquier fila player_pull_records en un report de esa fecha.',
              'Se redondea a una decimal.',
              'Sin wowaudit_season.start_date no se puede acotar la season y el valor queda sin cruce suficiente.',
              'Es informativo y no entra en Fiabilidad para no penalizar rotaciones de composición.',
            ],
          },
        ],
        technicalRefs: ['src/app/core/attendance.service.ts'],
      },
    ],
  },
  {
    id: 'historicos',
    title: 'Histórico, boss y jugador',
    intro: 'Tres superficies de navegación temporal: reports completos, boss+dificultad y jugador por semanas.',
    sections: [
      {
        id: 'historico-reports',
        title: 'Histórico de reports',
        summary: 'Lista metadata ya conocida y permite sincronizar más reports desde WCL.',
        blocks: [
          {
            items: [
              'Ordena reports por start_time descendente y muestra bosses distintos de report_encounters.',
              'Sincronizar usa guild, servidor y región, pagina resultados y señala cuántos quedan.',
              'Abrir navega a Raid con ?report=. Si faltan pulls, Raid ejecuta analyze-reportFully.',
              'Un report sin bosses se etiqueta “sin bosses de raid detectados”; no se inventa contenido.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/features/history/history.component.ts',
          'src/app/core/reports.service.ts',
        ],
      },
      {
        id: 'historico-boss',
        title: 'Histórico de boss y dificultad',
        summary: 'Agrega todos los intentos válidos de ese ámbito, incluso entre noches.',
        blocks: [
          {
            items: [
              'Intentos, kills, primera kill y mejor duración excluyen ninja pulls.',
              'Progresión pinta 100−wipe_pct en orden cronológico e incorpora la fase alcanzada.',
              'Benchmark compara la mejor kill propia con la mediana pública.',
              'Tendencia mecánica divide pulls en dos mitades; requiere ≥3 instancias en cada mitad. Cambio de tasa ≤−8 pp = mejorando; ≥8 pp = empeorando; entre ambos = estable.',
              'Solo lista mecánicas con al menos un fallo. Ordena por fallos totales.',
              'Causas de muerte agrupa por nombre legible, cuenta muertes y jugadores distintos tras exclusiones.',
              'Fiabilidad aplica la misma fórmula de roster, pero filtra boss+dificultad.',
            ],
          },
        ],
        technicalRefs: ['src/app/core/boss-history.service.ts'],
      },
      {
        id: 'historico-jugador',
        title: 'Histórico de jugador',
        summary: 'Diez cubos móviles de 7 días y las últimas 15 muertes registradas.',
        blocks: [
          {
            items: [
              'Cada semana reutiliza computeReliabilityBreakdown; no es una fórmula distinta. Los cubos cuentan hacia atrás desde el momento actual, no semanas naturales.',
              'Semana sin filas = sin pulls y score null. Consistencia semanal requiere ≥5 pulls.',
              'Las 8 noches recientes enlazan al dosier de esa noche.',
              'Muertes recientes muestran boss, fecha, habilidad, causa raíz y disponibilidad defensiva; las excluidas siguen visibles con su badge.',
              '“Defensivo disponible: Sí” significa que había al menos una opción catalogada disponible y sin usar, no que el código pruebe que habría evitado la muerte.',
            ],
          },
        ],
        technicalRefs: ['src/app/core/player-detail.service.ts'],
      },
    ],
  },
  {
    id: 'dosier',
    title: 'Dosier de jugador por noche',
    route: '/report/:reportCode/player/:playerName',
    intro:
      'Reúne todos los pulls en los que participó un jugador, su ejecución, defensivos, preparación, patrones y comparación con su noche anterior.',
    sections: [
      {
        id: 'puntuacion-pull',
        title: 'Puntuación de cada pull',
        summary: 'Score 0–1 auditable desde un modal; un ninja pull devuelve null.',
        blocks: [
          {
            formula:
              'pullScore = round(((mechanicScore×0,70 + consumableScore×0,30) × deathMultiplier × defensiveMultiplier), 3)',
          },
          {
            table: {
              headers: ['Ingrediente', 'Valor'],
              rows: [
                ['mechanicScore', 'La fórmula compartida de Mecánica; puede superar 1 por bonus sin asignar'],
                ['consumableScore', '1 si vive; si muere, 1 si usó piedra o poción en el pull, si no 0'],
                ['deathMultiplier', 'timeMs de muerte / durationMs, limitado a 0…1; 1 si no hay muerte evaluable'],
                ['defensiveMultiplier', '0,50 muerte con opción libre; 0,75 presión y cero casts; 0,90 usado a destiempo; si no 1'],
              ],
            },
          },
          {
            items: [
              'Una muerte de wipe call o no evaluable no activa deathMultiplier ni la penalización de consumible.',
              'En pulls sin muerte, las ventanas de presión se detectan desde DamageTaken y distinguen no tocar nada de usar a destiempo.',
              'El modal nombra las mecánicas concretas, las ventanas falladas, su pico y las opciones disponibles.',
              'La fila conserva boss, ordinal del intento, resultado, duración, muerte, score y badges de exclusión/defensivos.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/core/night-player-summary.service.ts',
          'src/app/features/night-player-dossier/night-player-dossier.component.ts',
        ],
      },
      {
        id: 'puntuacion-noche',
        title: 'Puntuación de la noche',
        summary: 'Media ponderada por duración y penalización adicional por consistencia defensiva.',
        blocks: [
          {
            formula:
              'raw = Σ(pullScore×duration) / Σduration; factor = max(0,50, 1 − 0,08×pullsConFalloDefensivoGrave); nightScore = round(raw×factor, 3)',
          },
          {
            items: [
              'Si todas las duraciones suman 0, usa media aritmética en vez de ignorar silenciosamente los pulls.',
              'Solo ninja pulls quedan fuera del promedio completo. El wipe call recorta muerte/eventos posteriores, no el intento entero.',
              'El factor nocturno cuenta pulls con muerte y defensivo libre o presión sin tocar ningún defensivo; “mistimed” no escala la noche.',
              'Los tonos convierten el score a 0–100: <50 rojo, 50–<75 ámbar, ≥75 verde.',
            ],
          },
          {
            tone: 'warning',
            paragraphs: [
              'El texto del modal actualmente menciona “wipe call temprano” entre las exclusiones completas, pero la implementación vigente excluye completamente solo ninja_pull_excluded. El wipe call aplica exclusión fina. Esta es una inconsistencia de copy detectada; la documentación sigue el cálculo ejecutado.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/core/night-player-summary.service.ts',
          'src/app/features/night-player-dossier/night-player-dossier.component.ts',
        ],
      },
      {
        id: 'detalle-dosier',
        title: 'Muertes, fallos, aciertos, equipo y defensivos',
        summary: 'Inventario de la evidencia secundaria del dosier.',
        blocks: [
          {
            items: [
              'Patrones repetidos: misma mecánica con al menos 2 instancias durante la noche.',
              'Muertes: perfil burst/sustained, daño/healing de ventana, causa raíz, consumibles y opciones defensivas.',
              'Fallos mecánicos: daño, healing, categoría, fuente del umbral, percentil comparativo y resolución revisada.',
              'Interrupciones: solo category=interrupt, outcome=clean y nombre del jugador como ejecutor. Se conserva el acierto aunque el pull acabe en wipe; se excluye ninja pull.',
              'Mecánicas sin asignar: ocurrencias confirmadas que resolvió el jugador; alimentan también el bonus Mecánica.',
              'Preparación inicial y snapshot final: enchants, gemas, item level, talentos, equipo y ranuras concretas pendientes.',
              'Defensivos: casts con tiempo, pull y distancia a muerte; cobertura por ventana y por mecánica; opciones de emergencia no convierten una ventana en fallo por sí solas.',
            ],
          },
          {
            title: 'Ventanas de presión',
            formula:
              'baseline = mediana de buckets DamageTaken > 0; threshold = baseline×2,5; ventana = tramo contiguo con bucket ≥ threshold',
            items: [
              'Con menos de 3 buckets no cero no se crea una línea base ni ventanas.',
              'Una ventana queda cubierta si un defensivo estaba activo o se lanzó dentro del tramo.',
              'Queda cubrible si no estaba cubierta y había una opción available_unused que no fuese survivalType=emergency.',
              'La habilidad asociada es la que más daño real aportó en el rango con ±2 s de margen.',
            ],
          },
        ],
        technicalRefs: [
          'supabase/functions/_shared/damage-pressure-windows.ts',
          'src/app/core/night-player-summary.service.ts',
        ],
      },
      {
        id: 'evolucion-dosier',
        title: 'Evolución contra la noche anterior',
        summary: 'Comparación solo cuando ambos periodos tienen ámbitos comparables.',
        blocks: [
          {
            items: [
              'Compara ejecución, pulls limpios, éxito en zona/spread, incidentes/10, muertes/10, respuesta defensiva y consumibles.',
              'Para porcentajes, cambios menores de 3 pp son estables; para ratios por 10, menores de 0,5.',
              'Una mecánica solo se compara si boss+dificultad tuvo pulls en ambas noches; omite diferencias de tasa <0,05 por pull.',
              'Los enlaces Battle.net y Raider.IO se construyen desde nombre y realm; no aportan datos al score.',
              'La infografía es una representación exportable de los mismos datos. Actualizar fuerza recálculo y refresca la caché local.',
            ],
          },
        ],
        technicalRefs: ['src/app/core/night-player-summary.service.ts'],
      },
    ],
  },
  {
    id: 'informe-noche',
    title: 'Informe de raid por noche',
    route: '/report/:reportCode',
    intro:
      'Combina una vista ligera en cliente con un informe completo determinista schemaVersion 15 generado en backend. El brief de IA es la única pieza libre.',
    sections: [
      {
        id: 'acciones-informe',
        title: 'Actualizar, exportar y enviar',
        summary: 'Acciones de la cabecera y su efecto real.',
        blocks: [
          {
            items: [
              'Actualizar regenera el informe determinista con force=true y persiste night_full_reports.',
              'Ver infografía abre un modal; Descargar PNG renderiza el informe; Copiar informe completo genera Markdown; Copiar para Discord usa un resumen.',
              'Actualizar infografías fuerza el recálculo de todos los asistentes de la noche.',
              'Enviar todas requiere doble confirmación, omite quienes no tienen canal y publica imágenes reales en Discord.',
              'El informe almacenado se ignora si schemaVersion no es 15, para no presentar un contrato antiguo como actual.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/features/night-report/night-report.component.ts',
          'src/app/core/night-report.service.ts',
        ],
      },
      {
        id: 'resumen-asistencia-informe',
        title: 'Resumen ejecutivo, asistencia y bosses',
        summary: 'Totales de intentos válidos y presencia cruzada con el roster oficial.',
        blocks: [
          {
            items: [
              'Total pulls, kills, wipes, tiempo y duración media excluyen ninja pulls. Wipe temprano = wipe válido con duración <90 s.',
              'Mejor pull es el menor HP restante; progress boss se elige entre grupos sin kill y con al menos 2 pulls.',
              'Asistentes son nombres presentes en player_pull_records cruzados con Main/Trial de WoWAudit. Ausentes Main son filas oficiales sin aparición esa noche.',
              'Cada boss muestra pulls, kills o mejor HP, progreso por intento y detalle expandible.',
              'Cobertura de mecánica sin asignar = pulls válidos con al menos una ocurrencia / pulls válidos del boss+dificultad; solo catálogo con detección confirmada.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/core/night-report.service.ts',
          'supabase/functions/_shared/night-full-report.ts',
        ],
      },
      {
        id: 'metricas-informe-completo',
        title: 'Métricas del informe completo',
        summary: 'Qué significa cada bloque determinista de la pantalla.',
        blocks: [
          {
            table: {
              headers: ['Bloque', 'Definición'],
              rows: [
                ['Mecánicas', 'Fallos, pulls afectados, % de pulls, golpes letales, daño evitable y tendencia por boss+dificultad'],
                ['Timeline patterns', 'Hasta 3 secuencias recurrentes alrededor de un anchor, ventana ±12 s y clustering 18 s'],
                ['Daño evitable', 'Suma player_hit_details de candidatas avoidable; por minuto y % del daño de raid solo en scopes medidos'],
                ['Muertes', 'Reales, excluidas por wipe call, cobertura de causa/categoría, golpes finales y contexto previo si era desconocido'],
                ['Responsabilidad', 'Mecánicas clasificadas y agregados por individual, raid, tank, healer u otra etiqueta persistida'],
                ['Supervivencia', 'Uso al menos una vez de piedra/poción y muertes sin consumible de emergencia'],
                ['Defensivos', 'Jugadores que usaron, casts/minuto y opciones available_unused entre muertes evaluables'],
                ['Interrupciones', 'Interrumpidas / casts confiables; descarta casts cuya detección no está verificada'],
                ['Fases', 'Muertes y fallos asignados a fases del boss de progreso'],
                ['Wipe patterns', 'Categorías presentes en wipes y cascadas de ≥3 muertes en 10 s desde la primera'],
                ['Roles', 'Muertes/pull, uso defensivo y señales específicas de tank, healer y DPS'],
                ['Comparación de progreso', 'Primera vs segunda mitad solo con ≥6 pulls de un único boss'],
              ],
            },
          },
          {
            title: 'Tendencia de mecánica en el informe',
            paragraphs: [
              'Divide pulls en dos mitades y requiere al menos 3 pulls en cada mitad y presencia en ≥2 pulls. Una diferencia de tasa de fallo de al menos 15 puntos clasifica mejorando/empeorando; por debajo queda estable.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/shared/models/night-full-report.ts',
          'supabase/functions/_shared/night-full-report.ts',
        ],
      },
      {
        id: 'prioridades-informe',
        title: 'Prioridades, puntos positivos y limitaciones',
        summary: 'Reglas de selección y ausencias explícitas del informe.',
        blocks: [
          {
            items: [
              'Prioriza mecánicas del boss de progreso, causas letales, interrupciones del progreso <80% con ≥3 casts y consumibles <50% con ≥10 jugadores, hasta el límite del informe.',
              'Puntos positivos: interrupciones ≥80% con ≥5 casts; todos los jugadores rastreados usaron defensivo con muestra ≥10; mecánicas mejorando; o bajada de daño evitable.',
              'notAvailable enumera coberturas insuficientes. Un null no se convierte en una conclusión negativa.',
              'Los porcentajes de defensivo disponible describen disponibilidad del catálogo; no prueban causalidad contrafactual.',
            ],
          },
        ],
        technicalRefs: ['supabase/functions/_shared/night-full-report.ts'],
      },
    ],
  },
  {
    id: 'ajustes',
    title: 'Ajustes',
    route: '/ajustes',
    intro:
      'Centraliza catálogos que determinan qué eventos se evalúan y cómo se presentan. Editar un catálogo no reescribe fórmulas: cambia la evidencia que entra en ellas.',
    sections: [
      {
        id: 'ajustes-mecanicas',
        title: 'Mecánicas de boss',
        summary: 'Catálogo por boss+dificultad con evidencia oficial, pública, propia y revisión humana.',
        blocks: [
          {
            items: [
              'Sincronizar season carga todos los bosses aunque la guild no los haya pulleado.',
              'Sync rápido usa 3 logs públicos por dificultad; profundo, hasta 20. Se ofrecen Normal, Heroic y Mythic; LFR se conserva para lectura histórica pero no para sync activo.',
              'El selector de dificultad cambia candidatas, evidencia, clasificación y umbrales del ámbito exacto.',
              'Columnas: habilidad, razonamiento IA, resolución, responsable, fuentes observadas, categoría, evitable, umbral y revisada.',
              'La sugerencia automática nunca pisa una edición humana. La clasificación IA puede aplicarse a un boss completo o una dificultad y omite baja confianza/indeterminado.',
              'Una candidata contradicha por evidencia oficial se excluye; la ausencia en una dificultad más dura no basta para ocultar una mecánica vista en una fácil.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/features/manifest/manifest.component.ts',
          'src/app/shared/difficulty-evidence.util.ts',
          'supabase/functions/sync-boss-mechanics/index.ts',
        ],
      },
      {
        id: 'severidad-mecanica',
        title: 'Umbral y percentil de severidad',
        summary: 'Orden de fuentes que decide fail frente a partial_fail/clean.',
        blocks: [
          {
            items: [
              '1) Historial propio de kills del mismo boss+dificultad+mecánica, si hay ≥5 muestras.',
              '2) Ratios de logs públicos de referencia, si hay ≥5 muestras.',
              '3) severity_threshold fijo, por defecto 0,35 y editable.',
              'PercentileRank = muestras ≤ ratio actual / total ×100. Con muestra, es severo si percentile>50; con fijo, si ratio≥threshold.',
              'El ratio de una instancia es players_hit / raidSize. “Peor que…” se etiqueta con la fuente para no mezclar historial propio con mejores kills públicas.',
            ],
          },
        ],
        technicalRefs: ['supabase/functions/_shared/mechanic-severity.ts'],
      },
      {
        id: 'ajustes-sin-asignar',
        title: 'Mecánicas sin asignar',
        summary: 'Tareas voluntarias o no fijadas a una persona: huevos, orbes, objetos o interacciones.',
        blocks: [
          {
            items: [
              'Se gestionan por boss+dificultad con nombre, tipo de detección, spell/NPC, appliedBy, roles elegibles, consecuencia, confirmación, revisión y notas.',
              'Tipos reales: cast, debuff_applied, buff_applied y npc_interaction.',
              'eligible_roles es informativo y no filtra quién recibe el crédito.',
              'Solo has_confirmed_detection=true entra en analyze-report y reanálisis; una clasificación correcta sin señal confirmada todavía no produce ocurrencias.',
              'Guardar campos de detección devuelve pullIds afectados y el cliente los reanaliza secuencialmente. Borrar requiere confirmación.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/features/unassigned-mechanics-catalog/unassigned-mechanics-catalog.component.ts',
          'supabase/functions/_shared/unassigned-mechanics.ts',
        ],
      },
      {
        id: 'ajustes-defensivos',
        title: 'Catálogo de defensivos',
        summary: 'Define disponibilidad temporal y función defensiva por clase/spec.',
        blocks: [
          {
            table: {
              headers: ['Campo', 'Significado'],
              rows: [
                ['Spec', 'Restricción de especialización; vacío significa toda la clase'],
                ['Categoría', 'personal, semi, external o utility: a quién protege'],
                ['Tipo supervivencia', 'mitigation, absorption, sustain o emergency: cómo protege'],
                ['Cooldown / duración', 'Base en segundos, persistida en milisegundos'],
                ['Revisado', 'Confirmación humana'],
              ],
            },
          },
          {
            items: [
              'Editar cooldown/duración invalida las ventanas de los pulls de esa clase; el cliente reanaliza cada pull secuencialmente para no agotar CPU del Edge Function.',
              'Una opción emergency usada cubre una ventana, pero disponible sin usar no convierte por sí sola esa ventana en fallo.',
              'Clasificación IA se puede hacer para todas las clases o una sola; una edición humana sigue siendo la confirmación final.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/features/defensive-catalog/defensive-catalog.component.ts',
          'supabase/functions/_shared/defensive-cooldowns.ts',
        ],
      },
      {
        id: 'ajustes-discord',
        title: 'Discord',
        summary: 'Configura categoría, rol de oficiales y relación personaje↔usuario↔canal.',
        blocks: [
          {
            items: [
              'La configuración elige la categoría de canales privados y el rol que debe tener acceso.',
              'Solo raiders Main aparecen en la tabla de vinculación.',
              'Guardar un Discord User ID crea o actualiza el vínculo. Sincronizar crea/ajusta canales y permisos; Trials/oficiales pueden quedar con tratamiento específico de backend.',
              'Desvincular usa doble clic de confirmación. Enviar mensajes valida en servidor que el canal pertenece al guild autorizado.',
              'Un vínculo puede existir con discord_channel_id null: todavía no se ha sincronizado el canal o no corresponde crearlo.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/features/discord-settings/discord-settings.component.ts',
          'supabase/functions/discord-roster-channels/index.ts',
        ],
      },
    ],
  },
  {
    id: 'baremos',
    title: 'Baremos, estados y colores',
    intro: 'Inventario de umbrales visuales y operativos ejecutados actualmente.',
    sections: [
      {
        id: 'baremos-numericos',
        title: 'Scores, percentiles, muestra y tendencias',
        summary: 'Rangos globales y umbrales de decisión.',
        blocks: [
          {
            table: {
              headers: ['Indicador', 'Rojo / acción', 'Ámbar / revisión', 'Verde / correcto'],
              rows: [
                ['Fiabilidad, score de noche y pull', '<50', '50–<75', '≥75'],
                ['Percentil WCL', '<25', '25–<75', '≥75'],
                ['Eje en drawer', '<50', '50–<75', '≥75'],
                ['Ritmo vs mediana', 'No usa rojo', '>15% más lento', 'Igual o más rápido'],
              ],
            },
          },
          {
            table: {
              headers: ['Regla', 'Umbral'],
              rows: [
                ['Defensivo a revisar en roster', 'score<60 y ≥3 oportunidades'],
                ['Patrón cross-boss', '60 días, ≥3 impactos y ≥2 bosses'],
                ['Patrón de pull repetido', '≥2 fallos en ≥2 pulls'],
                ['Racha de muerte', '≥2 intentos consecutivos'],
                ['Consistencia', '≥5 pulls'],
                ['Confianza media/alta', '≥2 noches+10 pulls / ≥4 noches+20 pulls'],
                ['Tendencia fiabilidad', '±4 puntos'],
                ['Tendencia boss', '≥3 instancias/mitad y ±8 pp'],
                ['Tendencia informe', '≥3 pulls/mitad y ±15 pp'],
                ['Patrón temporal', '≥5 muestras, CV≤0,15; fijo además ≤1,3 ocurrencias/pull'],
              ],
            },
          },
        ],
        technicalRefs: [
          'src/app/core/reliability.service.ts',
          'src/app/features/roster/roster-view.util.ts',
          'src/app/core/boss-history.service.ts',
        ],
      },
      {
        id: 'colores-semanticos',
        title: 'Colores semánticos y categóricos',
        summary: 'El color de estado no debe confundirse con el color de categoría.',
        blocks: [
          {
            table: {
              headers: ['Uso', 'Variable / color'],
              rows: [
                ['Correcto, mejora, kill', '--success #5fbf82'],
                ['Revisión, parcial, advertencia', '--warning #e3ad4f'],
                ['Fallo, muerte, empeora', '--danger #e2596f'],
                ['Sin dirección o sin dato', '--neutral #aaa1b4 / text-faint'],
                ['Hito / racha', '--gold #c9a96b'],
                ['Marca y selección', '--accent #ba91ce'],
              ],
            },
          },
          {
            table: {
              headers: ['Categoría', 'Etiqueta', 'Color fijo'],
              rows: [
                ['raid-damage', 'RAID', '#3987e5'],
                ['avoidable-ground', 'SUELO', '#d95926'],
                ['soak', 'SOAK', '#199e70'],
                ['spread', 'SPREAD', '#c98500'],
                ['tankbuster', 'TB', '#d55181'],
                ['debuff-stack', 'STACK', '#008300'],
                ['interrupt', 'INT', '#9085e9'],
                ['healing-absorb', 'ABSORB', '#e66767'],
                ['personal-target', 'TARGET', '#1aa6b5'],
                ['enrage', 'ENRAGE', '#a3568a'],
              ],
            },
          },
          {
            paragraphs: [
              'Los nombres de jugador usan colores de clase Blizzard. Los tipos defensivos reutilizan colores categóricos: mitigation azul, absorption coral, sustain verde y emergency naranja.',
            ],
          },
        ],
        technicalRefs: ['src/app/shared/format.util.ts', 'src/styles.scss'],
      },
      {
        id: 'causas-estados',
        title: 'Causas de muerte y estados defensivos',
        summary: 'Clasificaciones que la UI traduce a etiquetas legibles.',
        blocks: [
          {
            table: {
              headers: ['Código', 'Regla real'],
              rows: [
                ['self_positioning', 'Categoría avoidable-ground o spread'],
                ['unsoaked_mechanic', 'Categoría soak'],
                ['undispelled_debuff', 'debuff-stack sin dispel de esa habilidad al jugador en los 15 s previos'],
                ['no_healing_received', 'Daño sustained y cero ticks de healing en los 6 s previos'],
                ['unclassified', 'Ninguna regla anterior tiene evidencia suficiente'],
              ],
            },
          },
          {
            items: [
              'Perfil burst: último segundo suma ≥80% de vida máxima; fallback sin vida máxima: ≥80% del daño de los últimos 5 s; compatibilidad legacy: ≤3 golpes y el mayor ≥60%.',
              'active: ya estaba activo al instante evaluado. available_unused: cooldown libre y no activo. on_cooldown: aún faltaba tiempo. unknown: falta cooldown o snapshot fiable.',
              'preventableWithDefensive=true significa “había una opción disponible y sin usar”; no demuestra que el resultado contrafactual fuese supervivencia.',
            ],
          },
        ],
        technicalRefs: [
          'supabase/functions/_shared/damage-profile.ts',
          'supabase/functions/analyze-report/index.ts',
        ],
      },
    ],
  },
  {
    id: 'sin-datos',
    title: 'Casos especiales, fallbacks y límites',
    intro: 'Cómo se representa la ausencia de evidencia y qué afirmaciones no permite hacer el sistema.',
    sections: [
      {
        id: 'estados-sin-datos',
        title: 'Estados sin datos',
        summary: 'Comportamiento visible para null, arrays vacíos, APIs fallidas y esquemas en transición.',
        blocks: [
          {
            table: {
              headers: ['Situación', 'Resultado visible / cálculo'],
              rows: [
                ['Sin report', 'Loader para pegar URL/código; puede elegir histórico reciente'],
                ['Report sin pulls', 'Se analiza si llegó desde Histórico; en otro caso queda vacío sin inventar pulls'],
                ['Sin benchmark', 'No aparece comparación; la kill sigue siendo válida'],
                ['Sin percentil WCL', '— y tono neutral'],
                ['Sin eje de Fiabilidad', 'null; se renormalizan los demás ejes'],
                ['Sin pulls de jugador', 'Sin datos; no score 0 negativo'],
                ['Sin 5 pulls', 'Consistencia null'],
                ['Sin categoría/causa', 'Sin clasificar y evidencia cruda visible'],
                ['Sin snapshot defensivo', 'unknown/null; no se afirma disponibilidad'],
                ['Sin roster sincronizado', 'Rol/rango/avatar pueden ser null; la evidencia WCL sigue visible'],
                ['Fallo de IA', 'Error contenido en la card; no borra el resto de la pantalla'],
                ['Fallo de widget de progreso', 'Silencioso; no bloquea navegación'],
              ],
            },
          },
          {
            paragraphs: [
              'Durante despliegues escalonados, Fiabilidad prueba sucesivamente el esquema más nuevo y columnas legacy. Las columnas métricas nuevas ausentes se convierten en null para activar el fallback antiguo, no en “cero fallos”.',
            ],
          },
        ],
        technicalRefs: [
          'src/app/core/reliability.service.ts',
          'src/app/shared/empty-panel.component.ts',
        ],
      },
      {
        id: 'incertidumbres',
        title: 'Lo que no puede afirmarse con certeza',
        summary: 'Límites explícitos encontrados durante la trazabilidad.',
        blocks: [
          {
            tone: 'warning',
            items: [
              'Que un defensivo disponible habría evitado una muerte. El código verifica disponibilidad, no simula el daño mitigado.',
              'La asignación personal de soak/objetivo. Por eso esas categorías no usan ratio de acierto.',
              'Una causa raíz cuando no encaja en reglas basadas en categoría, dispel o healing. Se conserva unclassified.',
              'La disponibilidad teórica de Healthstone sin Warlock: si no se usó, se marca available=false aunque pudiera traer una fabricada.',
              'La frecuencia externa de actualización de WCL, Blizzard, Wago DB2 o WoWAudit.',
              'Que una clasificación IA sea correcta por sí sola: la UI conserva confianza, fuentes y revisión humana.',
              'El significado de un report privado/no rankeable para percentiles: solo se sabe que WCL no devolvió ranking.',
            ],
          },
        ],
        technicalRefs: [
          'supabase/functions/_shared/consumables.ts',
          'supabase/functions/analyze-report/index.ts',
        ],
      },
    ],
  },
  {
    id: 'glosario',
    title: 'Glosario',
    intro: 'Términos según el uso concreto que hace IRIS.',
    sections: [
      {
        id: 'glosario-terminos',
        title: 'Términos funcionales y técnicos',
        summary: 'Definiciones compactas para leer cualquier pantalla.',
        keywords: ['parse', 'percentile', 'median', 'average', 'ilvl', 'DPS', 'HPS'],
        blocks: [
          {
            table: {
              headers: ['Término', 'En IRIS significa'],
              rows: [
                ['Report', 'Código/sesión de Warcraft Logs que contiene fights'],
                ['Fight / pull', 'Un intento de boss; pull válido excluye ninja pulls'],
                ['Kill', 'Intento con wipe_pct=0 o encounter.kill=true'],
                ['Wipe', 'Intento válido sin kill; no es sinónimo de wipe call'],
                ['Wipe call', 'Frontera detectada donde la raid abandona un wipe; excluye solo el tramo final'],
                ['Ninja pull', 'Enganche accidental; se conserva pero se excluye como intento entero'],
                ['Progress', '100−HP restante; en algunos bosses debe leerse junto a la fase'],
                ['Parse / percentil', 'rankPercent devuelto por WCL contra misma clase/spec, boss y dificultad'],
                ['Mediana', 'Valor central ordenado; benchmark de duración pública'],
                ['DPS / HPS', 'Daño o sanación total del fight dividido por su duración'],
                ['Absorbido', 'Daño absorbido registrado para el jugador'],
                ['ilvl', 'itemLevel del equipo observado por WCL; no forma parte directa de las fórmulas de score'],
                ['Roster', 'Miembros canónicos sincronizados desde WoWAudit'],
                ['Main / Trial', 'Rango del personaje en WoWAudit'],
                ['Spec / rol', 'Especialización observada en WCL y rol derivado; puede corregir el rol configurado'],
                ['Fiabilidad', 'Compuesto por recencia de Mecánica, Defensivos y Preparación'],
                ['Consistencia', 'Media de ejecución menos media desviación estándar'],
                ['Incidente', 'Instancia temporal fallida, no número de jugadores golpeados'],
                ['Cubrible', 'Ventana no cubierta con al menos un defensivo no-emergency disponible'],
                ['Provenance', 'Fuente, método, detalle y enlace de verificación del dato'],
                ['Baremo', 'Umbral que transforma una cifra en estado/color o activa una señal'],
              ],
            },
          },
        ],
        technicalRefs: [
          'src/app/shared/models/domain.ts',
          'src/app/shared/models/ui.ts',
          'src/app/shared/format.util.ts',
        ],
      },
    ],
  },
];

