import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyboardHeight, keyboardShown } from './dist/keyboard.js';

test('the keyboard covers the page below the visual viewport', () => {
  // The sizes of an iPhone 17 simulator in Safari.
  assert.equal(keyboardHeight(714, { height: 384, scale: 1 }), 330);
  assert.equal(keyboardHeight(714, { height: 714, scale: 1 }), 0);
  // The visual viewport is higher than the page while the browser toolbar is small.
  assert.equal(keyboardHeight(714, { height: 749, scale: 1 }), 0);
});

test('a low bar is not a keyboard', () => {
  // The bar of a hardware keyboard, and a browser toolbar.
  assert.equal(keyboardHeight(749, { height: 694, scale: 1 }), 0);
  assert.equal(keyboardHeight(749, { height: 600, scale: 1 }), 0);
  assert.equal(keyboardHeight(749, { height: 599, scale: 1 }), 150);
});

test('a zoomed page has no keyboard height', () => {
  assert.equal(keyboardHeight(749, { height: 374, scale: 2 }), 0);
  assert.equal(keyboardHeight(749, { height: 374, scale: 1.005 }), 375);
});

test('no keyboard shows before a page follows it', () => {
  assert.equal(keyboardShown(), false);
});
