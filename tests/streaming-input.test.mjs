import test from 'node:test';
import assert from 'node:assert/strict';
import { videoCoordinates } from '../src/lib/input.ts';

test('absolute mouse coordinates follow the streamed picture rather than black letterbox bars', () => {
  const video = {
    videoWidth: 1920, videoHeight: 1080,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 1000, height: 1000 }),
  };
  assert.deepEqual(videoCoordinates(video, 600, 550), { x: 0.5, y: 0.5 });
  assert.equal(videoCoordinates(video, 600, 100), null);
  assert.equal(videoCoordinates(video, 600, 1000), null);
  const topLeft = videoCoordinates(video, 100, 268.75);
  const bottomRight = videoCoordinates(video, 1100, 831.25);
  assert.ok(topLeft && Math.abs(topLeft.x) < 1e-10 && Math.abs(topLeft.y) < 1e-10);
  assert.ok(bottomRight && Math.abs(bottomRight.x - 1) < 1e-10 && Math.abs(bottomRight.y - 1) < 1e-10);
});

test('input mapping stays unavailable until the remote video has real dimensions', () => {
  const video = { videoWidth: 0, videoHeight: 0, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 }) };
  assert.equal(videoCoordinates(video, 300, 300), null);
});
