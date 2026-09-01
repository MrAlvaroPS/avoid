import { describe, expect, it } from 'vitest';
import { parseCombatLogLine, parseCsv } from './parser.mjs';

const common = [
  'Player-1-AAAA', '"Caster,One"', '0x511', '0x0',
  'Player-1-BBBB', '"Target"', '0x512', '0x0',
];
const modernAdvanced = [
  'Player-1-BBBB', '0000000000000000', '800', '1000', '100', '200', '300', '40', '0', '0',
  '0', '500', '1000', '20', '12.5', '44.25', '2601', '1.57', '639',
];
const legacyAdvanced = [
  'Player-1-BBBB', '0000000000000000', '800', '1000', '100', '200', '300', '40',
  '0', '500', '1000', '20', '12.5', '44.25', '2601', '1.57', '639',
];

function line(fields) {
  return `9/1/2026 20:10:11.123  ${fields.join(',')}`;
}

describe('parseCsv', () => {
  it('preserves quoted commas and doubled quotes', () => {
    expect(parseCsv('SPELL_CAST_SUCCESS,"Name, Realm","A ""quoted"" spell",nil')).toEqual([
      'SPELL_CAST_SUCCESS', 'Name, Realm', 'A "quoted" spell', 'nil',
    ]);
  });
});

describe('parseCombatLogLine', () => {
  it('parses the modern 19-field advanced block and modern damage suffix', () => {
    const parsed = parseCombatLogLine(line([
      'SPELL_DAMAGE', ...common, '12345', '"Meteor"', '4', ...modernAdvanced,
      '250', '300', '-1', '4', '0', '0', '50', '1', '0', '0', '0',
    ]));
    expect(parsed.event).toBe('SPELL_DAMAGE');
    expect(parsed.common.sourceName).toBe('Caster,One');
    expect(parsed.advanced.layout).toBe('modern-19');
    expect(parsed.advanced.currentHp).toBe(800);
    expect(parsed.suffix.layout).toBe('modern');
    expect(parsed.suffix.amount).toBe(250);
    expect(parsed.suffix.rawAmount).toBe(300);
    expect(parsed.suffix.absorbed).toBe(50);
  });

  it('parses the legacy 17-field advanced block without shifting damage', () => {
    const parsed = parseCombatLogLine(line([
      'SPELL_DAMAGE', ...common, '12345', '"Meteor"', '4', ...legacyAdvanced,
      '250', '-1', '4', '0', '0', '50', '1', '0', '0', '0',
    ]));
    expect(parsed.advanced.layout).toBe('legacy-17');
    expect(parsed.advanced.absorb).toBe(40);
    expect(parsed.advanced.powerType).toBe(0);
    expect(parsed.suffix.layout).toBe('legacy');
    expect(parsed.suffix.amount).toBe(250);
    expect(parsed.suffix.overkill).toBe(-1);
  });

  it('parses the modern heal suffix independently from damage', () => {
    const parsed = parseCombatLogLine(line([
      'SPELL_HEAL', ...common, '777', '"Big Heal"', '2', ...modernAdvanced,
      '900', '350', '120', '40', '1',
    ]));
    expect(parsed.advanced.layout).toBe('modern-19');
    expect(parsed.suffix.layout).toBe('modern');
    expect(parsed.suffix.healedToHp).toBe(900);
    expect(parsed.suffix.amount).toBe(350);
    expect(parsed.suffix.overheal).toBe(120);
    expect(parsed.suffix.absorbedToShield).toBe(40);
  });

  it('parses SPELL_ABSORBED spell-attack and swing-attack variants', () => {
    const spell = parseCombatLogLine(line([
      'SPELL_ABSORBED', ...common,
      '12345', '"Meteor"', '4',
      'Player-1-CCCC', '"ShieldCaster"', '0x511', '0x0',
      '67890', '"Barrier"', '2', '125', '300', '0',
    ]));
    expect(spell.suffix.layout).toBe('spell-attack');
    expect(spell.suffix.damageSpell.id).toBe(12345);
    expect(spell.suffix.absorbSpell.id).toBe(67890);
    expect(spell.suffix.amount).toBe(125);

    const swing = parseCombatLogLine(line([
      'SPELL_ABSORBED', ...common,
      'Player-1-CCCC', '"ShieldCaster"', '0x511', '0x0',
      '67890', '"Barrier"', '2', '80', '180', '1',
    ]));
    expect(swing.suffix.layout).toBe('swing-attack');
    expect(swing.suffix.damageSpell).toBeNull();
    expect(swing.suffix.amount).toBe(80);
  });

  it('preserves unknown event payloads instead of inventing semantics', () => {
    const parsed = parseCombatLogLine(line(['SOME_FUTURE_EVENT', ...common, 'alpha', 'beta']));
    expect(parsed.kind).toBe('event');
    expect(parsed.suffix.layout).toBe('raw');
    expect(parsed.suffix.raw).toEqual(['alpha', 'beta']);
  });

  it('preserves COMBAT_LOG_VERSION metadata', () => {
    const parsed = parseCombatLogLine('9/1/2026 20:10:11.123  COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,12.0.0,PROJECT_ID,1');
    expect(parsed.kind).toBe('metadata');
    expect(parsed.version).toBe(22);
    expect(parsed.metadata.BUILD_VERSION).toBe('12.0.0');
  });
});
