export type DeltaJson =
  null | boolean | number | string | DeltaJson[] | { [key: string]: DeltaJson };

export type DeltaChange<T extends DeltaJson = DeltaJson> =
  | {
      readonly sequence: number;
      readonly kind: 'upsert';
      readonly key: string;
      readonly value: T;
    }
  | {
      readonly sequence: number;
      readonly kind: 'delete';
      readonly key: string;
    };

export interface DeltaExport<T extends DeltaJson = DeltaJson> {
  readonly exportId: string;
  readonly watermarkFrom: number;
  readonly watermarkTo: number;
  readonly snapshot: string;
  readonly manifestId: string;
  readonly changes: readonly DeltaChange<T>[];
}

export interface DeltaExportCheckpoint {
  readonly version: 1;
  readonly exportId: string;
  readonly watermarkFrom: number;
  readonly watermarkTo: number;
  readonly snapshot: string;
  readonly manifestId: string;
  readonly nextIndex: number;
}

export interface DeltaBatch<T extends DeltaJson> {
  readonly records: readonly DeltaChange<T>[];
  readonly checkpoint: DeltaExportCheckpoint;
  readonly done: boolean;
}

export class DeltaExportError extends Error {
  constructor(
    readonly code:
      | 'invalid-manifest'
      | 'invalid-change'
      | 'invalid-checkpoint'
      | 'inconsistent-resume'
      | 'invalid-batch-size',
    message: string,
  ) {
    super(message);
    this.name = 'DeltaExportError';
  }
}

function cloneCanonical<T>(input: T, maxNodes = 100_000): T {
  let count = 0;
  const active = new Set<object>();
  const visit = (value: unknown, depth: number): DeltaJson => {
    if (++count > maxNodes || depth > 64) {
      throw new DeltaExportError('invalid-change', 'Delta values exceed the configured bounds.');
    }
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      return value;
    }
    if (Array.isArray(value)) {
      if (active.has(value)) {
        throw new DeltaExportError('invalid-change', 'Delta values cannot contain cycles.');
      }
      active.add(value);
      const result = Array.from(value, (entry) => visit(entry, depth + 1));
      active.delete(value);
      return result;
    }
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new DeltaExportError(
        'invalid-change',
        'Delta values must contain only finite JSON and plain objects.',
      );
    }
    if (active.has(value)) {
      throw new DeltaExportError('invalid-change', 'Delta values cannot contain cycles.');
    }
    active.add(value);
    const result: Record<string, DeltaJson> = {};
    for (const key of Reflect.ownKeys(value).sort((a, b) =>
      String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
    )) {
      const descriptor =
        typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : null;
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new DeltaExportError(
          'invalid-change',
          'Delta objects must contain enumerable string data fields.',
        );
      }
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    active.delete(value);
    return result;
  };
  return visit(input, 0) as T;
}

function fingerprint(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function validText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new DeltaExportError(
      'invalid-manifest',
      `${field} must be a non-empty string of at most 256 characters.`,
    );
  }
}

function assertDataRecord(
  value: unknown,
  name: string,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  errorCode: DeltaExportError['code'] = 'invalid-change',
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new DeltaExportError(errorCode, `${name} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new DeltaExportError(errorCode, `${name} contains unknown fields.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new DeltaExportError(errorCode, `${name} must contain enumerable data fields.`);
    }
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new DeltaExportError(errorCode, `${name} is missing required fields.`);
  }
}

export function createDeltaExport<T extends DeltaJson>(input: {
  readonly exportId: string;
  readonly watermarkFrom: number;
  readonly watermarkTo: number;
  readonly snapshot: string;
  readonly changes: readonly DeltaChange<T>[];
}): DeltaExport<T> {
  if (!input || typeof input !== 'object') {
    throw new DeltaExportError('invalid-manifest', 'Delta manifest input must be an object.');
  }
  assertDataRecord(
    input,
    'Delta manifest',
    new Set(['exportId', 'watermarkFrom', 'watermarkTo', 'snapshot', 'changes']),
    ['exportId', 'watermarkFrom', 'watermarkTo', 'snapshot', 'changes'],
    'invalid-manifest',
  );
  validText(input.exportId, 'exportId');
  validText(input.snapshot, 'snapshot');
  if (
    !Number.isSafeInteger(input.watermarkFrom) ||
    input.watermarkFrom < 0 ||
    !Number.isSafeInteger(input.watermarkTo) ||
    input.watermarkTo < input.watermarkFrom
  ) {
    throw new DeltaExportError(
      'invalid-manifest',
      'Watermarks must be non-negative safe integers with watermarkTo >= watermarkFrom.',
    );
  }
  if (!Array.isArray(input.changes)) {
    throw new DeltaExportError('invalid-manifest', 'changes must be an array.');
  }
  let previous = input.watermarkFrom;
  const changes = input.changes.map((change) => {
    assertDataRecord(change, 'Delta change', new Set(['sequence', 'kind', 'key', 'value']), [
      'sequence',
      'kind',
      'key',
    ]);
    const entry = change as DeltaChange<T>;
    if (
      !Number.isSafeInteger(entry.sequence) ||
      entry.sequence <= previous ||
      entry.sequence > input.watermarkTo
    ) {
      throw new DeltaExportError(
        'invalid-change',
        'Change sequences must be strictly increasing inside the watermark interval.',
      );
    }
    previous = entry.sequence;
    if (typeof entry.key !== 'string' || entry.key.length < 1 || entry.key.length > 1_024) {
      throw new DeltaExportError('invalid-change', 'Change keys must be non-empty strings.');
    }
    if (entry.kind === 'upsert') {
      if (!Object.hasOwn(entry, 'value')) {
        throw new DeltaExportError('invalid-change', 'Upsert changes require a value.');
      }
      return {
        sequence: entry.sequence,
        kind: 'upsert' as const,
        key: entry.key,
        value: cloneCanonical(entry.value),
      };
    }
    if (entry.kind === 'delete' && !Object.hasOwn(entry, 'value')) {
      return { sequence: entry.sequence, kind: 'delete' as const, key: entry.key };
    }
    throw new DeltaExportError(
      'invalid-change',
      'Change kind must be upsert with a value or delete without a value.',
    );
  });
  const fingerprintInput = JSON.stringify([
    input.exportId,
    input.watermarkFrom,
    input.watermarkTo,
    input.snapshot,
    changes,
  ]);
  return {
    exportId: input.exportId,
    watermarkFrom: input.watermarkFrom,
    watermarkTo: input.watermarkTo,
    snapshot: input.snapshot,
    manifestId: fingerprint(fingerprintInput),
    changes,
  };
}

export function createDeltaCheckpoint<T extends DeltaJson>(
  manifest: DeltaExport<T>,
  nextIndex = 0,
): DeltaExportCheckpoint {
  const valid = validateManifest(manifest);
  if (!Number.isSafeInteger(nextIndex) || nextIndex < 0 || nextIndex > valid.changes.length) {
    throw new DeltaExportError('invalid-checkpoint', 'nextIndex is outside the manifest.');
  }
  return {
    version: 1,
    exportId: valid.exportId,
    watermarkFrom: valid.watermarkFrom,
    watermarkTo: valid.watermarkTo,
    snapshot: valid.snapshot,
    manifestId: valid.manifestId,
    nextIndex,
  };
}

function validateManifest<T extends DeltaJson>(manifest: DeltaExport<T>): DeltaExport<T> {
  if (!manifest || typeof manifest !== 'object') {
    throw new DeltaExportError('invalid-manifest', 'Malformed delta manifest.');
  }
  try {
    assertDataRecord(
      manifest,
      'Delta manifest',
      new Set(['exportId', 'watermarkFrom', 'watermarkTo', 'snapshot', 'manifestId', 'changes']),
      ['exportId', 'watermarkFrom', 'watermarkTo', 'snapshot', 'manifestId', 'changes'],
      'invalid-manifest',
    );
  } catch {
    throw new DeltaExportError('invalid-manifest', 'Malformed delta manifest.');
  }
  if (!Array.isArray(manifest.changes)) {
    throw new DeltaExportError('invalid-manifest', 'Malformed delta manifest.');
  }
  const validated = createDeltaExport<T>({
    exportId: manifest.exportId,
    watermarkFrom: manifest.watermarkFrom,
    watermarkTo: manifest.watermarkTo,
    snapshot: manifest.snapshot,
    changes: manifest.changes,
  });
  if (validated.manifestId !== manifest.manifestId) {
    throw new DeltaExportError('invalid-manifest', 'Delta manifest fingerprint does not match.');
  }
  return validated;
}

export function readDeltaBatch<T extends DeltaJson>(
  manifest: DeltaExport<T>,
  checkpoint: DeltaExportCheckpoint,
  batchSize: number,
): DeltaBatch<T> {
  const valid = validateManifest(manifest);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100_000) {
    throw new DeltaExportError(
      'invalid-batch-size',
      'batchSize must be an integer from 1 through 100000.',
    );
  }
  try {
    assertDataRecord(
      checkpoint,
      'Delta checkpoint',
      new Set([
        'version',
        'exportId',
        'watermarkFrom',
        'watermarkTo',
        'snapshot',
        'manifestId',
        'nextIndex',
      ]),
      [
        'version',
        'exportId',
        'watermarkFrom',
        'watermarkTo',
        'snapshot',
        'manifestId',
        'nextIndex',
      ],
      'inconsistent-resume',
    );
  } catch {
    throw new DeltaExportError('inconsistent-resume', 'Malformed delta export checkpoint.');
  }
  if (
    !checkpoint ||
    checkpoint.version !== 1 ||
    checkpoint.exportId !== valid.exportId ||
    checkpoint.watermarkFrom !== valid.watermarkFrom ||
    checkpoint.watermarkTo !== valid.watermarkTo ||
    checkpoint.snapshot !== valid.snapshot ||
    checkpoint.manifestId !== valid.manifestId ||
    !Number.isSafeInteger(checkpoint.nextIndex) ||
    checkpoint.nextIndex < 0 ||
    checkpoint.nextIndex > valid.changes.length
  ) {
    throw new DeltaExportError(
      'inconsistent-resume',
      'Checkpoint does not match this manifest or is outside its record range.',
    );
  }
  const end = Math.min(checkpoint.nextIndex + batchSize, valid.changes.length);
  return {
    records: valid.changes.slice(checkpoint.nextIndex, end),
    checkpoint: createDeltaCheckpoint(valid, end),
    done: end === valid.changes.length,
  };
}
