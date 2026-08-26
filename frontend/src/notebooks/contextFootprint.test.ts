import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateImageTokens,
  estimateTextTokens,
  imageFootprint,
  multimodalFootprint,
  textFootprint,
  visionTileCount,
} from './contextFootprint.ts';

test('text tokens use chars/4', () => {
  assert.equal(estimateTextTokens('abcd'), 1);
  assert.equal(estimateTextTokens('abcde'), 2);
  assert.equal(textFootprint('tool_summary', 'x'.repeat(400)).total_tokens, 100);
});

test('1024×1024 high-detail image is 4 tiles → 765 tokens', () => {
  assert.equal(visionTileCount(1024, 1024), 4);
  assert.equal(estimateImageTokens(1024, 1024).tokens, 765);
});

test('small image still counts at least one tile', () => {
  assert.equal(visionTileCount(100, 80), 1);
  assert.equal(estimateImageTokens(100, 80).tokens, 255);
});

test('2048×2048 caps then short-side scales to 4 tiles', () => {
  // Fit already at 2048; shortest > 768 → scale to 768×768 → 4 tiles.
  assert.equal(visionTileCount(2048, 2048), 4);
  assert.equal(imageFootprint('x', 2048, 2048).total_tokens, 765);
});

test('hybrid sums text + image context tokens', () => {
  const fp = multimodalFootprint('overlay_color_keyed', 'a'.repeat(400), 1024, 1024);
  assert.equal(fp.text_tokens, 100);
  assert.equal(fp.image_tokens, 765);
  assert.equal(fp.total_tokens, 865);
  assert.equal(fp.mode, 'multimodal');
});
