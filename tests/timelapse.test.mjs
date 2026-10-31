import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTimelapseMetadata } from '../dist/timelapse.js';

test('timelapse verification accepts AVFoundation frame-rate rounding', () => {
  for (const fps of [30, 30.000001907348633, 29.999998]) {
    assert.doesNotThrow(() => verifyTimelapseMetadata({ fps, frames: 35856 }));
  }
});

test('timelapse verification still rejects wrong frame rates and invalid frame counts', () => {
  for (const fps of [5, 24, 29.97, 60, NaN, Infinity, undefined]) {
    assert.throws(() => verifyTimelapseMetadata({ fps, frames: 10 }), /verification failed/);
  }
  for (const frames of [0, -1, 1.5, NaN, Infinity, undefined]) {
    assert.throws(() => verifyTimelapseMetadata({ fps: 30, frames }), /verification failed/);
  }
  assert.throws(() => verifyTimelapseMetadata(null), /verification failed/);
});
