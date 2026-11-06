import { createDeltaExport, createDeltaCheckpoint, readDeltaBatch } from '@lp-labs/delta-export';

const manifest = createDeltaExport({
  exportId: 'cjs',
  watermarkFrom: 0,
  watermarkTo: 1,
  snapshot: 'snap',
  changes: [{ sequence: 1, kind: 'delete', key: 'gone' }],
});
const batch = readDeltaBatch(manifest, createDeltaCheckpoint(manifest), 1);
const complete: boolean = batch.done;
void complete;
