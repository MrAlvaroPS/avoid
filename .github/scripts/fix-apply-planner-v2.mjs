import { readFileSync, writeFileSync } from 'node:fs';
const path = '.github/scripts/apply-planner-v2.mjs';
let text = readFileSync(path, 'utf8');
const bad = '\\\\${player.name}';
const good = '\\${player.name}';
if (!text.includes(bad)) throw new Error('No se encontró el escape defectuoso esperado');
text = text.replace(bad, good);
writeFileSync(path, text);
console.log('Escape corregido.');
