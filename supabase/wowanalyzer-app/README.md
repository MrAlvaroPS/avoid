# WoWAnalyzer autoalojado (segunda stage de §12.1)

Ejecuta la SPA **real** de [WoWAnalyzer/WoWAnalyzer](https://github.com/WoWAnalyzer/WoWAnalyzer)
(sus mismos módulos de análisis por spec, sin reimplementar nada) apuntando
a nuestro propio proxy en vez de a wowanalyzer.com — sin enlaces externos,
gestionado en local.

## Por qué hace falta un proxy propio

El frontend de WoWAnalyzer NUNCA llama a la API de Warcraft Logs
directamente — llama a **su propio backend** (`src/common/fetchWclApi.ts` /
`makeApiUrl.ts` / `makeWclApiUrl.ts` del repo real), que no es parte de su
código abierto. Ese backend expone 3 endpoints con forma de la vieja API
REST v1 de WCL:

- `GET v1/report/fights/:code`
- `GET v1/report/events/:code?start&end&actorid&filter&translate`
- `GET v1/report/tables/:table/:code?start&end&actorid`

`supabase/functions/wowanalyzer-proxy/index.ts` reimplementa exactamente
ese contrato sobre nuestro propio cliente de WCL v2 (mismas credenciales
`WCL_CLIENT_ID`/`WCL_CLIENT_SECRET` que ya usa el resto de la app), así que
el WoWAnalyzer que corre en este contenedor lee logs reales sin depender de
wowanalyzer.com para nada.

Verificado en real contra la API de WCL (2026-08-27, no solo leyendo docs):
`report.events(startTime, endTime, ...)` no exige `fightIDs` — con solo la
ventana de un fight ya acota correctamente a ese fight — y `dataType: All`
trae el stream completo intercalado (casts + daño + heals + buffs +
combatantinfo...) que necesitan los analizadores de WoWAnalyzer.

## Qué NO hace falta implementar

Login/Patreon/premium: la imagen se compila con `VITE_FORCE_PREMIUM=true`
(verificado leyendo `interface/reducers/user.ts` y
`interface/selectors/user.ts` del repo real) — la app nunca intenta el
flujo de login, y si igualmente hace `fetch(.../user)` falla en silencio
(try/catch a propósito en su propio código). El proxy devuelve 404 para
cualquier ruta que no sea una de las 3 de arriba.

## Uso

```powershell
docker compose build
docker compose up -d
```

Abre `http://localhost:4321/report/<CÓDIGO_DE_REPORT>/<FIGHT_ID>/<NOMBRE_O_ID>/standard`
(mismo esquema de rutas que wowanalyzer.com, porque es literalmente su
mismo router). El botón "Ver rotación en WoWAnalyzer" del dosier de IRIS
construye esa URL con el `wcl_fight_id` que ya guardamos por pull.

## Auto-actualización semanal

`rebuild-wowanalyzer-app.ps1` reconstruye la imagen desde cero (`git clone`
fresco, así se recompila con el commit más reciente de WoWAnalyzer) y
reinicia el contenedor con la versión nueva — mismo criterio que
`wowanalyzer-extractor/rebuild-wowanalyzer.ps1`. Prográmalo semanalmente
con el Programador de tareas de Windows. Si el build falla, el contenedor
en marcha (si lo hay) no se toca — te quedas con la última versión buena.

## Puerto

`4321` en el host por defecto (editable en `docker-compose.yml`) — evita el
4200 de `ng serve` y los puertos locales de Supabase.
