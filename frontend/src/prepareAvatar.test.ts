import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_AVATAR_CROP,
  avatarCropRect,
  normalizeAvatarCrop,
} from './prepareAvatar.ts';

test('default crop is the centered cover square', () => {
  const { sx, sy, side } = avatarCropRect(800, 600, DEFAULT_AVATAR_CROP);
  assert.equal(side, 600);
  assert.equal(sx, 100);
  assert.equal(sy, 0);
});

test('zoom 2 halves the crop window and stays centered by default', () => {
  const { sx, sy, side } = avatarCropRect(800, 600, { zoom: 2, panX: 0, panY: 0 });
  assert.equal(side, 300);
  assert.equal(sx, 250);
  assert.equal(sy, 150);
});

test('panX -1 / 1 flush the crop to the horizontal edges', () => {
  const left = avatarCropRect(800, 600, { zoom: 1, panX: -1, panY: 0 });
  const right = avatarCropRect(800, 600, { zoom: 1, panX: 1, panY: 0 });
  assert.equal(left.sx, 0);
  assert.equal(right.sx, 200);
  assert.equal(left.side, 600);
  assert.equal(right.side, 600);
});

test('panY -1 / 1 flush the crop on a portrait image', () => {
  const top = avatarCropRect(400, 800, { zoom: 1, panX: 0, panY: -1 });
  const bottom = avatarCropRect(400, 800, { zoom: 1, panX: 0, panY: 1 });
  assert.equal(top.sy, 0);
  assert.equal(bottom.sy, 400);
  assert.equal(top.side, 400);
});

test('normalizeAvatarCrop clamps zoom and pan', () => {
  const crop = normalizeAvatarCrop({ zoom: 99, panX: -4, panY: 3 });
  assert.equal(crop.zoom, 4);
  assert.equal(crop.panX, -1);
  assert.equal(crop.panY, 1);
});

test('square image with zoom 1 has no pan travel', () => {
  const { sx, sy, side } = avatarCropRect(512, 512, { zoom: 1, panX: 1, panY: -1 });
  assert.equal(side, 512);
  assert.equal(sx, 0);
  assert.equal(sy, 0);
});
