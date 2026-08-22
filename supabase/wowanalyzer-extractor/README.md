# WoWAnalyzer extractor (§12.1)

Sincroniza `cooldown_catalog` en Supabase desde el código fuente real de
[WoWAnalyzer/WoWAnalyzer](https://github.com/WoWAnalyzer/WoWAnalyzer), en vez
de mantener a mano la lista de defensivos por clase/spec.

## Cómo funciona (y por qué no es lo que decía la primera versión de §12.1)

La hoja de ruta original planteaba ejecutar cada `Abilities.tsx` en un
contexto Node/ts-node con un `combatant` de mentira, porque `cooldown` suele
ser una función dependiente de haste/talentos. Verificado en real: es cierto,
pero **esta app nunca necesita ese número** — `analyze-report` solo comprueba
si una spell se lanzó alguna vez o si estaba activa como buff, nunca si su
cooldown "estaba disponible". Lo único que hace falta es `spellId + nombre +
categoría`, y eso vive como texto plano en los propios ficheros fuente. El
extractor (`extract.mjs`) lee esos ficheros con una regex de bloques con
balanceo de llaves — sin `pnpm install` del monorepo completo, sin evaluar
una sola línea de TSX, sin riesgo de que falle la resolución de módulos de un
combatant stub.

Cada entrada extraída se **verifica 1:1 contra la API de Blizzard Game Data**
(`/data/wow/spell/{id}`, nombre exacto) antes de subirse — si no coincide o
Blizzard no la tiene indexada todavía, se descarta en vez de subir un dato
sin confirmar. En la primera pasada real (2026-08-22): 57 candidatas
extraídas, 53 verificadas, 0 discrepancias.

## Uso

```powershell
copy .env.example .env
# rellena .env con las claves reales (ver comentarios dentro del archivo)

docker compose build
docker compose run --rm wowanalyzer-extractor
```

## Auto-actualización semanal

`rebuild-wowanalyzer.ps1` reconstruye la imagen desde cero (`git clone`
fresco) y ejecuta el extractor. Prográmalo semanalmente con el Programador de
tareas de Windows — es de sobra, los rebalanceos de clase no llegan a diario.
Si el build falla (WoWAnalyzer cambia su estructura de repo, por ejemplo), el
script para en seco y no toca `cooldown_catalog` — te quedas con la última
sincronización buena, nunca con un catálogo a medias.

## Qué NO hace esta imagen

No construye la SPA completa de WoWAnalyzer (eso exigiría `pnpm install` del
monorepo entero + build de Vite con Sentry/Lingui/Vega, mucho más pesado). Si
más adelante quieres además la app de WoWAnalyzer desplegada aparte para
análisis de rotación individual de un jugador concreto (el "segundo papel"
que menciona la hoja de ruta), es una segunda stage de Docker independiente
— pídemelo y la añado sin tocar esta.

## Alcance real (para que quede explícito)

Este extractor cubre **defensivos de jugador** (`SPELL_CATEGORY.DEFENSIVE` /
`SEMI_DEFENSIVE`), que es lo que `analyze-report` ya consume. WoWAnalyzer
**no** cataloga mecánicas de boss (eso sigue siendo Blizzard Journal + Wago
DB2, §12) ni efectos de trinkets (eso exigiría cruzar la API de items de
Blizzard + parseo de efectos al estilo Wowhead, no está resuelto todavía).
