import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  DeltaExportError,
  createDeltaCheckpoint,
  createDeltaExport,
  readDeltaBatch,
} from '../dist/esm/index.js';

const input = () => ({
  exportId: 'export-1',
  watermarkFrom: 10,
  watermarkTo: 13,
  snapshot: 'snapshot-7',
  changes: [
    { sequence: 11, kind: 'upsert', key: 'a', value: { z: 1, a: ['x'] } },
    { sequence: 12, kind: 'delete', key: 'b' },
    { sequence: 13, kind: 'upsert', key: 'c', value: null },
  ],
});

test('preserves ordered upserts and deletions across resumable batches', () => {
  const manifest = createDeltaExport(input());
  const first = readDeltaBatch(manifest, createDeltaCheckpoint(manifest), 2);
  assert.deepEqual(
    first.records.map(({ sequence }) => sequence),
    [11, 12],
  );
  assert.equal(first.records[1].kind, 'delete');
  assert.equal(first.done, false);
  const final = readDeltaBatch(manifest, first.checkpoint, 2);
  assert.deepEqual(
    final.records.map(({ sequence }) => sequence),
    [13],
  );
  assert.equal(final.done, true);
  assert.equal(final.checkpoint.nextIndex, 3);
  assert.deepEqual(readDeltaBatch(manifest, final.checkpoint, 2).records, []);
});

test('detaches values and verifies resume checkpoint matches exact manifest', () => {
  const source = input();
  const manifest = createDeltaExport(source);
  source.changes[0].value.a.push('mutated');
  assert.deepEqual(manifest.changes[0].value, { a: ['x'], z: 1 });
  const other = createDeltaExport({ ...input(), snapshot: 'snapshot-other' });
  assert.throws(
    () => readDeltaBatch(other, createDeltaCheckpoint(manifest), 1),
    (error) => error.code === 'inconsistent-resume',
  );
  const tampered = { ...manifest, changes: [{ ...manifest.changes[0], key: 'tampered' }] };
  assert.throws(() => readDeltaBatch(tampered, createDeltaCheckpoint(manifest), 1));
});

test('rejects invalid watermark ranges, ordering, missing values, and malformed deletions', () => {
  for (const changes of [
    [
      { sequence: 12, kind: 'delete', key: 'b' },
      { sequence: 11, kind: 'delete', key: 'a' },
    ],
    [{ sequence: 14, kind: 'delete', key: 'a' }],
    [{ sequence: 11, kind: 'upsert', key: 'a' }],
    [{ sequence: 11, kind: 'delete', key: 'a', value: 1 }],
    [{ sequence: 11, kind: 'upsert', key: 'a', value: Infinity }],
  ]) {
    assert.throws(() => createDeltaExport({ ...input(), changes }));
  }
  assert.throws(
    () => createDeltaExport({ ...input(), watermarkFrom: 14, watermarkTo: 13, changes: [] }),
    (error) => error instanceof DeltaExportError,
  );
  assert.throws(() => createDeltaExport({ ...input(), changes: null }));
  const accessor = Object.defineProperty(
    { exportId: 'x', watermarkFrom: 0, watermarkTo: 0, snapshot: 's', changes: [] },
    'exportId',
    { enumerable: true, get: () => 'x' },
  );
  assert.throws(() => createDeltaExport(accessor));
});

test('enforces bounded batch size and checkpoint indices', () => {
  const manifest = createDeltaExport(input());
  for (const size of [0, -1, 100_001, 1.5]) {
    assert.throws(() => readDeltaBatch(manifest, createDeltaCheckpoint(manifest), size));
  }
  assert.throws(() => createDeltaCheckpoint(manifest, 4));
  assert.throws(() =>
    readDeltaBatch(manifest, { ...createDeltaCheckpoint(manifest), nextIndex: -1 }, 1),
  );
  const accessor = Object.defineProperty({ ...createDeltaCheckpoint(manifest) }, 'nextIndex', {
    enumerable: true,
    get: () => 0,
  });
  assert.throws(() => readDeltaBatch(manifest, accessor, 1));
});

test('CommonJS exposes the same runtime API', () => {
  const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
  assert.deepEqual(Object.keys(cjs).sort(), [
    'DeltaExportError',
    'createDeltaCheckpoint',
    'createDeltaExport',
    'readDeltaBatch',
  ]);
});
