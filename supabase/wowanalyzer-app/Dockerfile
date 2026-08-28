# Colocar en: supabase/wowanalyzer-app/Dockerfile
# §"gestionarlo en local, no depender de links externos" (feedback real,
# 2026-08-27) — segunda stage anticipada por supabase/wowanalyzer-extractor/
# README.md: "si más adelante quieres además la app de WoWAnalyzer
# desplegada aparte para análisis de rotación individual... es una segunda
# stage de Docker independiente". A diferencia del extractor (solo lee
# texto de los ficheros fuente, no compila nada), aquí SÍ hace falta la SPA
# real compilada: pnpm install del monorepo completo + vite build.
#
# El backend real de wowanalyzer.com NO es parte de su repo open source —
# su frontend solo sabe hablar con ÉL (contrato REST de 3 endpoints, ver
# src/common/fetchWclApi.ts del repo real). En vez de depender de ese
# backend externo, VITE_SERVER_BASE apunta a nuestro propio proxy
# (supabase/functions/wowanalyzer-proxy/), que reimplementa ese mismo
# contrato encima de nuestro cliente WCL v2 ya existente.
#
# Verificado en real contra el repo de WoWAnalyzer (2026-08-27, clon
# superficial + lectura directa de package.json/env files, no adivinado):
# - packageManager: pnpm@9.5.0 (corepack lo resuelve solo).
# - "build": "vite build" — sin stage de build previa no hay pnpm-lock.yaml
#   resuelto, así que el propio Dockerfile real de WoWAnalyzer (nginx puro,
#   copiado tal cual en la stage de abajo) asume un `dist/` ya construido
#   fuera — aquí se construye DENTRO, en una stage previa.
# - makeWclApiUrl.ts antepone "v1/" al endpoint SIEMPRE, hardcodeado en
#   fuente (no depende de VITE_API_BASE) — de ahí que el proxy acepte con o
#   sin ese prefijo.
# - "prepare": "is-ci || husky" en package.json — sin CI=true, `pnpm
#   install` intentaría instalar git hooks de husky dentro de un contenedor
#   sin la configuración de git de un desarrollador real; is-ci lee la
#   variable CI para saltárselo.

FROM node:22-slim AS build
RUN corepack enable

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# --depth 1: mismo criterio que el extractor — no hace falta el historial,
# solo el commit más reciente en cada rebuild.
RUN git clone --depth 1 https://github.com/WoWAnalyzer/WoWAnalyzer.git .

ARG WOWANALYZER_PROXY_BASE_URL
ENV VITE_SERVER_BASE=${WOWANALYZER_PROXY_BASE_URL}
ENV VITE_API_BASE=""
# §"que fuesen desplegables... login/premium bypasseado" (verificado en real
# leyendo interface/reducers/user.ts y interface/selectors/user.ts del repo
# real): con esto en 'true' la app nunca intenta el flujo de login/Patreon,
# y su fetch de /user falla en silencio (mismo archivo, try/catch a
# propósito) — no hace falta implementar login/user/logout en el proxy.
ENV VITE_FORCE_PREMIUM=true
ENV VITE_ENVIRONMENT_NAME=self-hosted
ENV VITE_VERSION=self-hosted
# Sin VITE_SENTRY_DSN a propósito: no se manda telemetría de esta guild al
# proyecto de Sentry de WoWAnalyzer — instrumentation.ts real lo comprueba
# antes de inicializar Sentry, así que omitirlo lo desactiva limpiamente.
ENV CI=true

RUN pnpm install --frozen-lockfile
RUN pnpm build

# Stage final: MISMO Dockerfile que trae el repo real de WoWAnalyzer en su
# raíz (nginx puro sirviendo dist/) — ver default.conf, copia exacta del
# suyo.
FROM nginx:stable-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY default.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
