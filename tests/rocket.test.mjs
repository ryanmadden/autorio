import test from 'node:test';
import assert from 'node:assert/strict';
import { launchRocket, launchRocketCommand } from '../dist/rocket.js';
import { reached } from '../dist/benchmarks.js';

const target = { x: 10, y: -12 };
const movement = { distance: 8, game_ticks: 90 };

test('rocket launch approaches the silo before sending the command and retains the engine result', async () => {
  const calls = [];
  const result = await launchRocket(target, async point => {
    calls.push('approach');
    assert.deepEqual(point, target);
    return { ok: true, movement };
  }, async command => {
    calls.push('launch');
    assert.equal(command, launchRocketCommand(target));
    return JSON.stringify({ ok: true, launch_initiated: true, rocket: { silo_status: 'launch_starting', rockets_launched: 0 } });
  }, () => false);
  assert.deepEqual(calls, ['approach', 'launch']);
  assert.equal(result.launch_initiated, true);
  assert.deepEqual(result.movement, movement);
  assert.equal(result.rocket.rockets_launched, 0);
});

test('blocked or cancelled movement never launches a rocket', async () => {
  for (const error of ['no_entity', 'path_failed', 'cancelled']) {
    const result = await launchRocket(target, async () => ({ ok: false, error, movement }),
      async () => assert.fail('launch after movement failure'), () => false);
    assert.equal(result.error, error);
    assert.deepEqual(result.movement, movement);
  }
  let cancelled = false;
  const result = await launchRocket(target, async () => {
    cancelled = true;
    return { ok: true, movement };
  }, async () => assert.fail('launch after cancellation'), () => cancelled);
  assert.equal(result.error, 'cancelled');
});

test('invalid targets and already cancelled jobs do not move or send commands', async () => {
  const unused = async () => assert.fail('unexpected game action');
  for (const x of [NaN, Infinity, undefined, null, '10']) {
    assert.equal((await launchRocket({ x, y: 1 }, unused, unused, () => false)).error, 'invalid_target');
  }
  assert.equal((await launchRocket(target, unused, unused, () => true)).error, 'cancelled');
  assert.throws(() => launchRocketCommand({ x: '1); error("injected")', y: 1 }), /Invalid rocket target/);
});

test('engine rejections remain failures and malformed replies cannot look successful', async () => {
  const approach = async () => ({ ok: true, movement });
  for (const error of ['rocket_not_ready', 'no_rocket_silo', 'wrong_force', 'out_of_reach']) {
    const result = await launchRocket(target, approach, async () => JSON.stringify({ ok: false, error }), () => false);
    assert.equal(result.ok, false);
    assert.equal(result.error, error);
  }
  for (const reply of ['Lua error', '{}', 'null']) {
    await assert.rejects(launchRocket(target, approach, async () => reply, () => false), /RCON launch-rocket returned invalid/);
  }
});

test('rocket completion requires a new recorded launch, regardless of silo construction or launch initiation', () => {
  const milestone = { kind: 'rockets', count: 1 };
  const baseline = { rockets: 2 };
  assert.equal(reached(milestone, { rockets: 2, production: { 'rocket-part': 100 }, launch_initiated: true }, baseline), false);
  assert.equal(reached(milestone, { rockets: 3 }, baseline), true);
});
