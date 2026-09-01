const SPELL_PREFIX_EVENTS = /^(SPELL|SPELL_PERIODIC|SPELL_BUILDING|RANGE)_/;
const DAMAGE_EVENTS = new Set([
  'SPELL_DAMAGE',
  'SPELL_PERIODIC_DAMAGE',
  'RANGE_DAMAGE',
  'SPELL_DAMAGE_SUPPORT',
  'SPELL_PERIODIC_DAMAGE_SUPPORT',
  'RANGE_DAMAGE_SUPPORT',
]);
const HEAL_EVENTS = new Set(['SPELL_HEAL', 'SPELL_PERIODIC_HEAL', 'SPELL_HEAL_SUPPORT']);

/** CSV parser for Blizzard combat-log payloads. */
export function parseCsv(input) {
  const out = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') {
        value += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      out.push(value);
      value = '';
    } else {
      value += ch;
    }
  }
  out.push(value);
  return out;
}

export function splitCombatLogLine(line) {
  const trimmed = line.replace(/[\r\n]+$/, '');
  const match = trimmed.match(/^(.*?)(?:\s{2,}|\t+)(.*)$/);
  if (!match) return { timestampText: null, payload: trimmed };
  return { timestampText: match[1].trim() || null, payload: match[2] };
}

function asNumber(value) {
  if (value == null || value === '' || value === 'nil') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asBoolean(value) {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return null;
}

function parseAdvanced(fields) {
  if (fields.length !== 17 && fields.length !== 19) return null;
  const common = {
    infoGuid: fields[0] || null,
    ownerGuid: fields[1] || null,
    currentHp: asNumber(fields[2]),
    maxHp: asNumber(fields[3]),
    attackPower: asNumber(fields[4]),
    spellPower: asNumber(fields[5]),
    armor: asNumber(fields[6]),
    absorb: asNumber(fields[7]),
  };
  if (fields.length === 19) {
    return {
      layout: 'modern-19',
      ...common,
      reserved1: asNumber(fields[8]),
      reserved2: asNumber(fields[9]),
      powerType: asNumber(fields[10]),
      currentPower: asNumber(fields[11]),
      maxPower: asNumber(fields[12]),
      powerCost: asNumber(fields[13]),
      positionX: asNumber(fields[14]),
      positionY: asNumber(fields[15]),
      uiMapId: asNumber(fields[16]),
      facing: asNumber(fields[17]),
      itemLevelOrLevel: asNumber(fields[18]),
      raw: fields,
    };
  }
  // Legacy advanced logging is the same semantic block without the two
  // reserved modern slots between absorb and powerType.
  return {
    layout: 'legacy-17',
    ...common,
    reserved1: null,
    reserved2: null,
    powerType: asNumber(fields[8]),
    currentPower: asNumber(fields[9]),
    maxPower: asNumber(fields[10]),
    powerCost: asNumber(fields[11]),
    positionX: asNumber(fields[12]),
    positionY: asNumber(fields[13]),
    uiMapId: asNumber(fields[14]),
    facing: asNumber(fields[15]),
    itemLevelOrLevel: asNumber(fields[16]),
    raw: fields,
  };
}

function parseDamageSuffix(fields) {
  if (fields.length >= 11) {
    return {
      layout: 'modern',
      amount: asNumber(fields[0]),
      rawAmount: asNumber(fields[1]),
      overkill: asNumber(fields[2]),
      school: asNumber(fields[3]),
      resisted: asNumber(fields[4]),
      blocked: asNumber(fields[5]),
      absorbed: asNumber(fields[6]),
      critical: asBoolean(fields[7]),
      glancing: asBoolean(fields[8]),
      crushing: asBoolean(fields[9]),
      offHand: asBoolean(fields[10]),
      trailing: fields.slice(11),
      raw: fields,
    };
  }
  if (fields.length >= 10) {
    return {
      layout: 'legacy',
      amount: asNumber(fields[0]),
      rawAmount: null,
      overkill: asNumber(fields[1]),
      school: asNumber(fields[2]),
      resisted: asNumber(fields[3]),
      blocked: asNumber(fields[4]),
      absorbed: asNumber(fields[5]),
      critical: asBoolean(fields[6]),
      glancing: asBoolean(fields[7]),
      crushing: asBoolean(fields[8]),
      offHand: asBoolean(fields[9]),
      trailing: fields.slice(10),
      raw: fields,
    };
  }
  return { layout: 'unknown', raw: fields };
}

function parseHealSuffix(fields) {
  if (fields.length >= 5) {
    return {
      layout: 'modern',
      healedToHp: asNumber(fields[0]),
      amount: asNumber(fields[1]),
      overheal: asNumber(fields[2]),
      absorbedToShield: asNumber(fields[3]),
      critical: asBoolean(fields[4]),
      trailing: fields.slice(5),
      raw: fields,
    };
  }
  if (fields.length >= 4) {
    return {
      layout: 'legacy',
      healedToHp: null,
      amount: asNumber(fields[0]),
      overheal: asNumber(fields[1]),
      absorbedToShield: asNumber(fields[2]),
      critical: asBoolean(fields[3]),
      trailing: fields.slice(4),
      raw: fields,
    };
  }
  return { layout: 'unknown', raw: fields };
}

function suffixMinimum(event) {
  if (DAMAGE_EVENTS.has(event)) return 10;
  if (HEAL_EVENTS.has(event)) return 4;
  if (event === 'SWING_DAMAGE' || event === 'SWING_DAMAGE_LANDED') return 10;
  if (event === 'ENVIRONMENTAL_DAMAGE') return 11;
  return null;
}

function resolveAdvancedAndSuffix(event, remainder) {
  const minimum = suffixMinimum(event);
  if (minimum == null) return { advanced: null, suffixFields: remainder, advancedFieldCount: 0 };
  for (const length of [19, 17]) {
    if (remainder.length - length < minimum) continue;
    const advanced = parseAdvanced(remainder.slice(0, length));
    if (!advanced) continue;
    if (advanced.infoGuid && !/^(Player|Creature|Pet|Vehicle|GameObject|0000000000000000|-)/.test(advanced.infoGuid)) continue;
    return { advanced, suffixFields: remainder.slice(length), advancedFieldCount: length };
  }
  return { advanced: null, suffixFields: remainder, advancedFieldCount: 0 };
}

function parseSpellAbsorbed(fields) {
  // This event is special: despite its SPELL_ name, the combat-log grammar
  // does not have the normal spell prefix. Its first optional three fields
  // describe the damage spell only for the spell-attack variant.
  if (fields.length >= 13 && asNumber(fields[0]) != null) {
    return {
      layout: 'spell-attack',
      damageSpell: { id: asNumber(fields[0]), name: fields[1] || null, school: asNumber(fields[2]) },
      absorber: { guid: fields[3] || null, name: fields[4] || null, flags: fields[5] || null, raidFlags: fields[6] || null },
      absorbSpell: { id: asNumber(fields[7]), name: fields[8] || null, school: asNumber(fields[9]) },
      amount: asNumber(fields[10]),
      totalAmount: asNumber(fields[11]),
      critical: asBoolean(fields[12]),
      trailing: fields.slice(13),
      raw: fields,
    };
  }
  if (fields.length >= 10) {
    return {
      layout: 'swing-attack',
      damageSpell: null,
      absorber: { guid: fields[0] || null, name: fields[1] || null, flags: fields[2] || null, raidFlags: fields[3] || null },
      absorbSpell: { id: asNumber(fields[4]), name: fields[5] || null, school: asNumber(fields[6]) },
      amount: asNumber(fields[7]),
      totalAmount: asNumber(fields[8]),
      critical: asBoolean(fields[9]),
      trailing: fields.slice(10),
      raw: fields,
    };
  }
  return { layout: 'unknown', raw: fields };
}

export function parseCombatLogLine(line) {
  const { timestampText, payload } = splitCombatLogLine(line);
  const fields = parseCsv(payload);
  const event = fields[0] || null;
  const base = { timestampText, event, rawLine: line.replace(/[\r\n]+$/, ''), rawFields: fields };
  if (!event) return { ...base, kind: 'invalid', reason: 'missing-event' };

  if (event === 'COMBAT_LOG_VERSION') {
    const metadata = {};
    for (let i = 2; i + 1 < fields.length; i += 2) metadata[fields[i]] = fields[i + 1];
    return { ...base, kind: 'metadata', version: asNumber(fields[1]), metadata };
  }
  if (fields.length < 9) return { ...base, kind: 'raw', payloadFields: fields.slice(1) };

  const common = {
    sourceGuid: fields[1] || null,
    sourceName: fields[2] || null,
    sourceFlags: fields[3] || null,
    sourceRaidFlags: fields[4] || null,
    destGuid: fields[5] || null,
    destName: fields[6] || null,
    destFlags: fields[7] || null,
    destRaidFlags: fields[8] || null,
  };

  if (event === 'SPELL_ABSORBED') {
    return { ...base, kind: 'event', common, spell: null, advanced: null, advancedFieldCount: 0, suffix: parseSpellAbsorbed(fields.slice(9)) };
  }

  let cursor = 9;
  let spell = null;
  if (SPELL_PREFIX_EVENTS.test(event) && fields.length >= cursor + 3) {
    spell = { id: asNumber(fields[cursor]), name: fields[cursor + 1] || null, school: asNumber(fields[cursor + 2]) };
    cursor += 3;
  }

  const resolved = resolveAdvancedAndSuffix(event, fields.slice(cursor));
  let suffix;
  if (DAMAGE_EVENTS.has(event) || event === 'SWING_DAMAGE' || event === 'SWING_DAMAGE_LANDED') {
    suffix = parseDamageSuffix(resolved.suffixFields);
  } else if (HEAL_EVENTS.has(event)) {
    suffix = parseHealSuffix(resolved.suffixFields);
  } else if (event === 'ENVIRONMENTAL_DAMAGE') {
    suffix = {
      environmentalType: resolved.suffixFields[0] || null,
      damage: parseDamageSuffix(resolved.suffixFields.slice(1)),
      raw: resolved.suffixFields,
    };
  } else {
    suffix = { layout: 'raw', raw: resolved.suffixFields };
  }

  return {
    ...base,
    kind: 'event',
    common,
    spell,
    advanced: resolved.advanced,
    advancedFieldCount: resolved.advancedFieldCount,
    suffix,
  };
}
