# Colocar en: supabase/wowanalyzer-app/rebuild-wowanalyzer-app.ps1
# Reconstruye la imagen desde cero (git clone fresco del WoWAnalyzer real
# dentro del Dockerfile) y reinicia el contenedor con la versión nueva.
# Mismo criterio que supabase/wowanalyzer-extractor/rebuild-wowanalyzer.ps1:
# programar semanalmente con el Programador de tareas de Windows es de
# sobra — los rebalanceos de clase no llegan a diario.
#   Acción: powershell.exe
#   Argumentos: -NoProfile -ExecutionPolicy Bypass -File "C:\ruta\a\rebuild-wowanalyzer-app.ps1"

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "Reconstruyendo wowanalyzer-app (git clone fresco + pnpm build)..."
docker compose build --pull --no-cache wowanalyzer-app
if ($LASTEXITCODE -ne 0) {
    Write-Error "El build falló — el contenedor en marcha (si lo hay) NO se toca, sigue sirviendo la última versión buena. Revisa si WoWAnalyzer cambió su proceso de build (pnpm/vite)."
    exit 1
}

Write-Host "Arrancando la versión nueva..."
docker compose up -d wowanalyzer-app
if ($LASTEXITCODE -ne 0) {
    Write-Error "docker compose up falló tras un build correcto — revisa el log de arriba."
    exit 1
}

Write-Host "Listo — http://localhost:4321"
