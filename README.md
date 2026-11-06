# @lp-labs/delta-export

Build an ordered change manifest with upserts and explicit deletion records, then read bounded,
resumable batches tied to the exact export snapshot and watermark interval.

## Install and quick start

```sh
npm install @lp-labs/delta-export
```

```js
import { createDeltaCheckpoint, createDeltaExport, readDeltaBatch } from '@lp-labs/delta-export';

const manifest = createDeltaExport({
  exportId: 'orders-2025-03',
  watermarkFrom: 10,
  watermarkTo: 12,
  snapshot: 'db-snapshot-88',
  changes: [
    { sequence: 11, kind: 'upsert', key: 'o-4', value: { status: 'paid' } },
    { sequence: 12, kind: 'delete', key: 'o-2' },
  ],
});
const first = readDeltaBatch(manifest, createDeltaCheckpoint(manifest), 1);
if (first.records[0].kind !== 'upsert') throw new Error('Unexpected first change');
const second = readDeltaBatch(manifest, first.checkpoint, 1);
if (!second.done || second.records[0].kind !== 'delete') throw new Error('Deletion was lost');
```

## API and types

- `createDeltaExport(input)` validates and detaches an ordered manifest of `DeltaChange<T>` upsert
  and delete records.
- `createDeltaCheckpoint(manifest, nextIndex?)` starts or reconstructs an index-based resume point.
- `readDeltaBatch(manifest, checkpoint, batchSize)` returns ordered records, an advanced checkpoint,
  and `done`.
- Types: `DeltaJson`, `DeltaChange<T>`, `DeltaExport<T>`, `DeltaExportCheckpoint`, `DeltaBatch<T>`.
- Errors: `DeltaExportError` with codes `invalid-manifest`, `invalid-change`,
  `invalid-checkpoint`, `inconsistent-resume`, and `invalid-batch-size`.

Watermarks are non-negative safe integers with `watermarkTo >= watermarkFrom`. Changes must have
strictly increasing sequences in `(watermarkFrom, watermarkTo]`. A fixed non-empty snapshot token
and export ID identify the source view and export. Deletes are first-class records and carry no
value; upserts require finite JSON values. Change keys and export identifiers are bounded.

## Resume consistency and limits

Checkpoints bind the export ID, both watermarks, snapshot, manifest fingerprint, and next record
index. A changed manifest or out-of-range checkpoint is rejected rather than silently resumed. The
fingerprint is a deterministic 64-bit FNV-1a consistency check, not a cryptographic signature or
security boundary. Persist each returned checkpoint only after its batch is durably applied. The
package cannot make the source snapshot immutable, atomically commit a destination and checkpoint, or
prevent repeated application after a crash.

Batch sizes are 1–100,000 records. Input JSON is bounded to depth 64 and 100,000 nodes per copied
value; malformed records and non-finite numbers are rejected. Watermarks, snapshot tokens, and
record ordering are supplied by the caller; this package does not query databases or infer changes.
There are no runtime or peer dependencies; TypeScript and Prettier are development-only.

ESM, CommonJS, and TypeScript declarations are included.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
