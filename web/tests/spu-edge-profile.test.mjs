import assert from 'node:assert/strict';
import { it as test } from 'vitest';
import { resolveEdgeWindow, loadEdgeProfile } from '../scripts/spu-edge-profile.mjs';

function window() {
  return { begin: { beginFrame: 4500, endFrame: 4501, report: { schemaVersion: 1, spans: [{ begin: 10, end: 13 }], edges: [[10, 11, 3], [10, 11, 2]], dropped: 1 } },
    end: { beginFrame: 5200, endFrame: 5201, report: { schemaVersion: 1, spans: [{ begin: 10, end: 13 }], edges: [[10, 11, 7], [10, 11, 4], [10, 12, 2]], dropped: 3 } } };
}
const entries = new Map([10, 11, 12].map(index => [index, { index, pc: index * 4, symbol: `program-${index}` }]));

test('sums worker slots, subtracts snapshot boundaries and retains losses', () => {
  const result = resolveEdgeWindow(window(), entries);
  assert.equal(result.samples, 8);
  assert.equal(result.dropped, 2);
  assert.equal(result.edges[0].samples, 6);
  assert.equal(result.edges[0].observedSourceShare, 0.75);
  assert.deepEqual(result.beginFrames, [4500, 4501]);
});

test('rejects counter resets, changed ownership, unknown identities and overlapping snapshots', () => {
  const reset = window(); reset.end.report.edges = [];
  assert.throws(() => resolveEdgeWindow(reset, entries), /reset/);
  const changed = window(); changed.end.report.spans[0].end++;
  assert.throws(() => resolveEdgeWindow(changed, entries), /ownership/);
  assert.throws(() => resolveEdgeWindow(window(), new Map()), /unresolved/);
  const overlap = window(); overlap.end.beginFrame = 4500;
  assert.throws(() => resolveEdgeWindow(overlap, entries), /overlapping/);
});
