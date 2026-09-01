import assert from 'node:assert/strict';
import test from 'node:test';
import { toWireEvent } from '../../combat-log-contracts/src/index.ts';
import { CombatLogParser, CombatLogTimestampResolver, tokenizeCombatLogCsv } from '../src/index.ts';

function context(sequence = 1n) {
  return { streamId: 'stream-test', sequence, byteStart: 0, byteEndExclusive: 100 };
}

test('tokenizer preserves quoted commas and nested COMBATANT_INFO groups', () => {
  assert.deepEqual(
    tokenizeCombatLogCsv('SPELL_CAST_SUCCESS,"Player, One",0x511,[1,2,3],(4,5),"A ""quoted"" value"'),
    ['SPELL_CAST_SUCCESS', 'Player, One', '0x511', '[1,2,3]', '(4,5)', 'A "quoted" value'],
  );
});

test('COMBAT_LOG_VERSION updates format state and preserves build provenance', () => {
  const parser = new CombatLogParser(new CombatLogTimestampResolver({ referenceDate: new Date('2026-11-21T00:00:00Z'), fixedOffsetMinutes: 60 }));
  const event = parser.parseLine(
    '11/21 12:01:34.071  COMBAT_LOG_VERSION,19,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,12.0.5,PROJECT_ID,1',
    context(),
  );
  assert.equal(event.payload.kind, 'combat_log_version');
  assert.deepEqual(parser.getFormatState(), { logFormatVersion: 19, advancedEnabled: true, gameBuild: '12.0.5', projectId: 1 });
  assert.equal(event.gameBuild, '12.0.5');
  assert.equal(event.timestamp, Date.UTC(2026, 10, 21, 11, 1, 34, 71));
});

test('advanced SWING_DAMAGE binds snapshot through explicit infoGuid', () => {
  const parser = new CombatLogParser(new CombatLogTimestampResolver({ referenceDate: new Date('2026-04-09T00:00:00Z'), fixedOffsetMinutes: 120 }));
  parser.hydrateFormatState({ logFormatVersion: 19, advancedEnabled: true, gameBuild: '12.0.5', projectId: 1 });
  const event = parser.parseLine(
    '4/9 05:05:07.807  SWING_DAMAGE,Player-1096-06DF65C1,"Xiaohuli-DefiasBrotherhood",0x511,0x0,Creature-0-4253-0-160-94-00006FB363,"Cutpurse",0x10a48,0x0,Player-1096-06DF65C1,0000000000000000,584,584,3,75,19,0,0,430,430,0,-9250.90,158.82,37,5.5502,13,1,0,-1,1,0,0,0,nil,nil,nil',
    context(),
  );
  assert.equal(event.advanced?.infoGuid, 'Player-1096-06DF65C1');
  assert.equal(event.advanced?.describesActor, 'source');
  assert.equal(event.advanced?.x, -9250.9);
  assert.equal(event.payload.kind, 'damage');
});

test('advanced SWING_DAMAGE_LANDED can describe the destination, never assumed source', () => {
  const parser = new CombatLogParser(new CombatLogTimestampResolver({ referenceDate: new Date('2026-04-09T00:00:00Z'), fixedOffsetMinutes: 120 }));
  parser.hydrateFormatState({ logFormatVersion: 19, advancedEnabled: true, gameBuild: '12.0.5', projectId: 1 });
  const event = parser.parseLine(
    '4/9 05:05:07.807  SWING_DAMAGE_LANDED,Player-1096-06DF65C1,"Xiaohuli-DefiasBrotherhood",0x511,0x0,Creature-0-4253-0-160-94-00006FB363,"Cutpurse",0x10a48,0x0,Creature-0-4253-0-160-94-00006FB363,0000000000000000,104,152,0,0,189,0,1,0,0,0,-9245.84,156.92,37,2.8016,30,1,0,-1,1,0,0,0,nil,nil,nil',
    context(),
  );
  assert.equal(event.advanced?.describesActor, 'target');
  assert.equal(event.advanced?.hp, 104);
});

test('unknown format state keeps combat fields but refuses to shift advanced payload', () => {
  const parser = new CombatLogParser(new CombatLogTimestampResolver({ referenceDate: new Date('2026-04-09T00:00:00Z'), fixedOffsetMinutes: 120 }));
  const event = parser.parseLine(
    '4/9 05:05:07.807  SPELL_CAST_SUCCESS,Player-1,"Caster",0x511,0x0,Creature-1,"Boss",0x10a48,0x0,123,"Spell",0x1,Player-1,0000000000000000,100,100,0,0,0,0,0,0,0,0,1,2,3,4,700',
    context(),
  );
  assert.equal(event.ability?.id, 123);
  assert.equal(event.payload.kind, 'unknown');
  if (event.payload.kind === 'unknown') assert.equal(event.payload.reason, 'format_state_unknown');
});

test('COMBATANT_INFO remains top-level tokenized without corrupting nested lists', () => {
  const parser = new CombatLogParser(new CombatLogTimestampResolver({ referenceDate: new Date('2026-09-01T00:00:00Z'), fixedOffsetMinutes: 120 }));
  const event = parser.parseLine(
    '9/1 20:00:00.000  COMBATANT_INFO,Player-1,100,200,(1,2,3),[(10,20,(1,2),(3,4),(5,6))],[Player-2,12345]',
    context(),
  );
  assert.equal(event.payload.kind, 'combatant_info');
  if (event.payload.kind === 'combatant_info') {
    assert.equal(event.payload.playerGuid, 'Player-1');
    assert.equal(event.payload.topLevelFields[3], '(1,2,3)');
  }
});

test('wire conversion serializes bigint sequences as decimal strings', () => {
  const parser = new CombatLogParser(new CombatLogTimestampResolver({ referenceDate: new Date('2026-11-21T00:00:00Z'), fixedOffsetMinutes: 60 }));
  const event = parser.parseLine(
    '11/21 12:01:34.071  COMBAT_LOG_VERSION,19,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,12.0.5,PROJECT_ID,1',
    context(9007199254740993n),
  );
  const wire = toWireEvent(event);
  assert.equal(wire.sequence, '9007199254740993');
  assert.equal(wire.rawRef.sequence, '9007199254740993');
  assert.doesNotThrow(() => JSON.stringify(wire));
});
