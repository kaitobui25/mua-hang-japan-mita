import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./review-carousel.tsx', import.meta.url), 'utf8');
// Exercise the exact positioning expressions without requiring React or a browser.
const positioning = source.match(/let offset = [\s\S]*?const isNeighbor = [^;]+;/)[0];
const position = new Function('index', 'selected', 'count', `${positioning} return { offset, isCurrent, isNeighbor };`);

test('each gallery size has exactly one center and no duplicated image positions', () => {
  for (const count of [1, 2, 3, 4, 5, 12]) {
    for (let selected = 0; selected < count; selected++) {
      const slots = Array.from({ length: count }, (_, index) => position(index, selected, count));
      assert.equal(slots.filter(slot => slot.isCurrent).length, 1);
      assert.equal(slots[selected].offset, 0);
      assert.equal(new Set(slots.map(slot => slot.offset)).size, count);
      assert.equal(slots.filter(slot => slot.isNeighbor).length, Math.min(count - 1, 2));
    }
  }
});

test('next and previous images transition to the center, including wraparound', () => {
  for (const count of [2, 3, 5, 12]) {
    for (let selected = 0; selected < count; selected++) {
      const next = (selected + 1) % count;
      assert.equal(position(next, selected, count).offset, 1);
      assert.equal(position(next, next, count).offset, 0);
      if (count > 2) assert.equal(position((selected - 1 + count) % count, selected, count).offset, -1);
    }
  }
});

test('slide roots retain identity and empty galleries return before positioning', () => {
  assert.match(source, /return <figure key=\{index\}/);
  assert.ok(source.indexOf('if (count === 0)') < source.indexOf('const selected'));
  assert.doesNotMatch(source, /key=\{position\}/);
  assert.match(source, /Ảnh mô phỏng/);
});
