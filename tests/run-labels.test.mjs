import test from 'node:test';
import assert from 'node:assert/strict';
import {pacificTimestamp,modelLabel} from '../dist/run-labels.js';
test('run timestamps use Pacific time with seasonal offsets and unambiguous repeated hours',()=>{
 assert.equal(pacificTimestamp(new Date('2026-01-16T20:00:00Z')),'2026-01-16 12:00:00 PST');
 assert.equal(pacificTimestamp(new Date('2026-07-16T20:00:00Z')),'2026-07-16 13:00:00 PDT');
 assert.equal(pacificTimestamp(new Date('2026-11-01T08:30:00Z')),'2026-11-01 01:30:00 PDT');
 assert.equal(pacificTimestamp(new Date('2026-11-01T09:30:00Z')),'2026-11-01 01:30:00 PST');
});
test('agent labels retain thinking level and distinguish manual/default agents',()=>{
 assert.equal(modelLabel({agent:'codex',model:'test-model',reasoning_effort:'high'}),'test-model (high)');
 assert.equal(modelLabel({agent:'codex',reasoning_effort:'medium'}),'Codex default (medium)');
 assert.equal(modelLabel({agent:'manual'}),'Manual');
});
