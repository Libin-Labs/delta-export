import {
  createDeltaCheckpoint,
  createDeltaExport,
  readDeltaBatch,
  type DeltaChange,
} from '@lp-labs/delta-export';

const changes: DeltaChange<{ value: number }>[] = [
  { sequence: 2, kind: 'upsert', key: 'k', value: { value: 1 } },
];
const manifest = createDeltaExport({
  exportId: 'export',
  watermarkFrom: 1,
  watermarkTo: 2,
  snapshot: 'snapshot',
  changes,
});
void readDeltaBatch(manifest, createDeltaCheckpoint(manifest), 10);
