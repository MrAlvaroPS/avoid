# Colocar en: supabase/wowanalyzer-extractor/rebuild-wowanalyzer.ps1
# §12.1: reconstruye la imagen desde cero (así el `git clone` de dentro trae
# el commit más reciente de WoWAnalyzer) y ejecuta el extractor una vez.
# Programar semanalmente con el Programador de tareas de Windows:
#   Acción: powershell.exe
#   Argumentos: -NoProfile -ExecutionPolicy Bypass -File "C:\ruta\a\rebuild-wowanalyzer.ps1"
# Semanal es de sobra — los rebalanceos de clase no llegan a diario.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "Reconstruyendo la imagen (git clone fresco de WoWAnalyzer)..."
docker compose build --pull --no-cache wowanalyzer-extractor
if ($LASTEXITCODE -ne 0) {
    Write-Error "El build de la imagen falló — el catálogo NO se toca, se queda con la última sincronización buena. Revisa si WoWAnalyzer cambió su proceso de build (Node/pnpm)."
    exit 1
}

Write-Host "Ejecutando el extractor..."
docker compose run --rm wowanalyzer-extractor
if ($LASTEXITCODE -ne 0) {
    Write-Error "El extractor falló a mitad de ejecución — revisa el log de arriba. cooldown_catalog conserva lo que ya tenía (el upsert es incremental, no borra nada)."
    exit 1
}

Write-Host "Listo."
