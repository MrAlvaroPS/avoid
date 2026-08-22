# Colocar en: supabase/wowanalyzer-extractor/Dockerfile
# §12.1 de la hoja de ruta: clona el repo real de WoWAnalyzer y ejecuta el
# extractor (extract.mjs) que sincroniza cooldown_catalog en Supabase.
#
# A propósito NO construye la SPA completa de WoWAnalyzer (pnpm install del
# monorepo entero + build de Vite con Sentry/Lingui/Vega) — el extractor es
# texto plano sobre los ficheros fuente (ver cabecera de extract.mjs), no
# necesita el árbol de dependencias de la app para nada. Si más adelante
# quieres además la app de WoWAnalyzer desplegada como app aparte para
# análisis de rotación individual (el "segundo papel" que menciona §12.1),
# eso es una segunda stage con `pnpm install && pnpm build` + nginx — no
# afecta a esta imagen, que se queda ligera y rápida de reconstruir cada
# semana.

FROM node:20-alpine

RUN apk add --no-cache git

WORKDIR /app
# --depth 1: no hace falta el historial completo, solo el commit actual
# (extract.mjs usa `git rev-parse HEAD` para saber cuál es exactamente).
RUN git clone --depth 1 https://github.com/WoWAnalyzer/WoWAnalyzer.git wowanalyzer

COPY extract.mjs /app/extract.mjs

ENV WOWANALYZER_SRC=/app/wowanalyzer
ENTRYPOINT ["node", "/app/extract.mjs"]
