#!/usr/bin/env node
// Colocar en: supabase/wowanalyzer-extractor/extract.mjs
// §12.1 de la hoja de ruta. Se ejecuta DENTRO del contenedor Docker, sobre
// el checkout real de github.com/WoWAnalyzer/WoWAnalyzer que ya está en
// /app (ver Dockerfile de este mismo directorio).
//
// Decisión de diseño importante, distinta de lo que planteaba la primera
// versión de §12.1: NO ejecuta Abilities.tsx con un `combatant` de mentira
// en ts-node. Verificado en real (2026-08-22) que `cooldown` es a menudo una
// función dependiente de haste/talentos — pero esta app nunca necesita ese
// número (analyze-report solo comprueba "¿se lanzó esta spell alguna vez?",
// no "¿estaba disponible su cooldown?"). Lo único que hace falta es
// spellId + nombre + categoría, y ESO vive como texto plano en los propios
// ficheros fuente (Abilities.tsx/.ts y los índices SPELLS/TALENTS) — se
// puede leer con una regex de bloques con balanceo de llaves, sin pnpm
// install de la app completa ni evaluar una sola línea de TSX. Es más
// robusto (cero riesgo de que falle la resolución de módulos de un stub) y
// más rápido. Verificado contra la API real de Blizzard: 53/57 nombres
// coincidieron exactos en la primera pasada real, 0 discrepancias — los que
// no resolvieron se descartan, nunca se sube un dato sin verificar.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = process.env.WOWANALYZER_SRC ?? '/app/wowanalyzer';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BLIZZARD_CLIENT_ID = process.env.BLIZZARD_CLIENT_ID;
const BLIZZARD_CLIENT_SECRET = process.env.BLIZZARD_CLIENT_SECRET;
const BLIZZARD_REGION = process.env.BLIZZARD_REGION ?? 'eu';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.');
  process.exit(1);
}

const CLASS_MAP = {
  deathknight: 'DeathKnight',
  demonhunter: 'DemonHunter',
  druid: 'Druid',
  evoker: 'Evoker',
  hunter: 'Hunter',
  mage: 'Mage',
  monk: 'Monk',
  paladin: 'Paladin',
  priest: 'Priest',
  rogue: 'Rogue',
  shaman: 'Shaman',
  warlock: 'Warlock',
  warrior: 'Warrior',
};

// ---------- 1) Recorrer el repo y extraer bloques "category: SPELL_CATEGORY.DEFENSIVE" ----------

function walk(dir, matchFile, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, matchFile, out);
    else if (matchFile(entry)) out.push(full);
  }
  return out;
}

function findEnclosingObject(text, matchIndex) {
  let depth = 0;
  let start = -1;
  for (let i = matchIndex; i >= 0; i--) {
    if (text[i] === '}') depth++;
    else if (text[i] === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start === -1) return null;
  depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extractDefensiveBlocks(fileText) {
  const blocks = [];
  const re = /category:\s*SPELL_CATEGORY\.(DEFENSIVE|SEMI_DEFENSIVE)\b/g;
  let m;
  while ((m = re.exec(fileText))) {
    const block = findEnclosingObject(fileText, m.index);
    if (block) blocks.push({ block, subCategory: m[1] });
  }
  return blocks;
}

function extractSpellRef(block) {
  const m = block.match(/spell:\s*(SPELLS|TALENTS)\.([A-Z0-9_]+)\.id/);
  return m ? { source: m[1], key: m[2] } : null;
}

// Solo resuelve los dos casos simples y frecuentes: un número plano o
// hastedCooldown(N) con haste=0 (el "peor caso" antes de reducciones). Una
// expresión condicional por talentos (con `?`/`combatant.getTalentRank`/
// operadores aritméticos) se deja en null a propósito — mejor "no lo sé" que
// un número inventado; la disponibilidad de esa spell queda 'unknown' en vez
// de fallar en falso. cooldown está en segundos en el código fuente, se
// guarda en ms.
function extractBaseCooldownMs(block) {
  const m = block.match(/cooldown:\s*([^,\n]+?)\s*,/);
  if (!m) return null;
  const expr = m[1].trim();
  const plain = expr.match(/^(\d+(?:\.\d+)?)$/);
  if (plain) return Math.round(Number(plain[1]) * 1000);
  const hasted = expr.match(/^hastedCooldown\(\s*(\d+(?:\.\d+)?)\s*\)$/);
  if (hasted) return Math.round(Number(hasted[1]) * 1000);
  return null;
}

function buildConstantIndex(root) {
  const index = new Map();
  function scanFile(path) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return;
    }
    const re = /\b([A-Z][A-Z0-9_]*)\s*:\s*\{\s*id:\s*(\d+)\s*,\s*name:\s*'((?:[^'\\]|\\.)*)'/g;
    let m;
    while ((m = re.exec(text))) {
      const id = Number(m[2]);
      const name = m[3].replace(/\\'/g, "'");
      for (const prefix of ['SPELLS', 'TALENTS']) {
        const fullKey = `${prefix}.${m[1]}`;
        if (!index.has(fullKey)) index.set(fullKey, { id, name });
      }
    }
  }
  const files = walk(root, (name) => /\.tsx?$/.test(name)).filter((f) => !/classic/i.test(f));
  for (const f of files) scanFile(f);
  return index;
}

function extractCatalog(repoRoot) {
  const retailDir = join(repoRoot, 'src/analysis/retail');
  const files = walk(retailDir, (name) => name === 'Abilities.tsx' || name === 'Abilities.ts');
  console.error(`Abilities.tsx/.ts encontrados: ${files.length}`);
  const constantIndex = buildConstantIndex(repoRoot);
  console.error(`Identificadores SPELLS/TALENTS indexados: ${constantIndex.size}`);

  const byClassAndId = new Map();
  for (const file of files) {
    const m = file.replace(/\\/g, '/').match(/analysis\/retail\/([a-z]+)\//);
    if (!m) continue;
    const wclClass = CLASS_MAP[m[1]];
    if (!wclClass) continue;

    const text = readFileSync(file, 'utf8');
    for (const { block, subCategory } of extractDefensiveBlocks(text)) {
      const ref = extractSpellRef(block);
      if (!ref) continue;
      const resolved = constantIndex.get(`${ref.source}.${ref.key}`);
      if (!resolved) continue;
      const key = `${wclClass}|${resolved.id}`;
      if (!byClassAndId.has(key)) {
        byClassAndId.set(key, {
          class: wclClass,
          spec: null,
          spell_id: resolved.id,
          name: resolved.name,
          category: subCategory === 'DEFENSIVE' ? 'personal_defensive' : 'semi_defensive',
          base_cooldown_ms: extractBaseCooldownMs(block),
        });
      }
    }
  }
  return [...byClassAndId.values()];
}

// ---------- 2) Verificar cada entrada contra Blizzard Game Data antes de subir nada ----------

async function getBlizzardToken() {
  const basic = Buffer.from(`${BLIZZARD_CLIENT_ID}:${BLIZZARD_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Blizzard OAuth falló: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

async function verifyAgainstBlizzard(catalog, token) {
  const verified = [];
  for (const row of catalog) {
    const res = await fetch(`https://${BLIZZARD_REGION}.api.blizzard.com/data/wow/spell/${row.spell_id}?namespace=static-${BLIZZARD_REGION}&locale=en_US`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error(`  descartado (HTTP ${res.status}): ${row.class} #${row.spell_id} "${row.name}"`);
      continue;
    }
    const data = await res.json();
    if (data.name !== row.name) {
      console.error(`  descartado (nombre no coincide: catálogo="${row.name}" blizzard="${data.name}"): ${row.class} #${row.spell_id}`);
      continue;
    }
    verified.push(row);
  }
  return verified;
}

// ---------- 3) Upsert en Supabase vía PostgREST (service role, salta RLS) ----------

async function upsertCatalog(rows, commitSha) {
  if (!rows.length) return;
  const payload = rows.map((r) => ({ ...r, synced_from_commit: commitSha, synced_at: new Date().toISOString() }));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cooldown_catalog?on_conflict=class,spell_id`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Upsert a cooldown_catalog falló: HTTP ${res.status} — ${await res.text()}`);
  }
}

// ---------- main ----------

try {
  const commitSha = execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim();
  console.error(`Extrayendo del commit ${commitSha}...`);

  const extracted = extractCatalog(REPO_ROOT);
  console.error(`\n${extracted.length} candidatas extraídas del código fuente. Verificando contra Blizzard Game Data...`);

  const token = await getBlizzardToken();
  const verified = await verifyAgainstBlizzard(extracted, token);
  console.error(`\n${verified.length}/${extracted.length} verificadas 1:1 (nombre exacto) — solo estas se suben.`);

  await upsertCatalog(verified, commitSha);
  console.error(`\nHecho. cooldown_catalog actualizado con ${verified.length} entradas del commit ${commitSha.slice(0, 8)}.`);
} catch (err) {
  // Fallo limpio y explícito en vez de un stack trace de undici: cooldown_catalog
  // no se toca hasta que el upsert completo funcione (el script no borra nada
  // por su cuenta), así que un fallo aquí deja el catálogo tal como estaba.
  console.error(`\nEl extractor falló: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
