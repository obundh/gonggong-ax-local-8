import assert from 'node:assert/strict';
import test from 'node:test';

import { compareDeviceObservations, describeTrialContext } from '../engine/trial-context.mjs';

test('a stable fixed image permits only its own before/after hash comparison', () => {
  const context = describeTrialContext({
    sourceKind: 'image', sourceIdentity: 'fixture-sha256:abc', device: { label: 'fixture.raw', byteLength: 512n }
  });

  assert.equal(context.group, 'fixed-image');
  assert.equal(context.sourceHashComparison.allowed, true);
  assert.equal(context.sourceHashComparison.policy, 'before-after-fixed-image');
  assert.equal(context.sourceIdentity, 'fixture-sha256:abc');
  assert.equal(context.device.byteLength, '512');
  assert.doesNotThrow(() => JSON.stringify(context));
});

test('a changing C volume is identified as live system metadata, never a static snapshot', () => {
  const context = describeTrialContext({ sourceKind: 'volume', system: true, sourceIdentity: 'C:partition-v1' });
  const comparison = compareDeviceObservations(
    { identity: 'C:partition-v1', freeSpaceBytes: 1_000_000 },
    { identity: 'C:partition-v2', freeSpaceBytes: 999_488 }
  );

  assert.equal(context.group, 'live-system-volume');
  assert.equal(context.sourceHashComparison.allowed, false);
  assert.equal(context.sourceHashComparison.policy, 'no-global-static-snapshot-assertion');
  assert.equal(comparison.identityChanged, true);
  assert.equal(comparison.freeSpace.deltaBytes, -512);
  assert.equal(comparison.freeSpaceDeltaBytes, -512);
  assert.equal(comparison.deviceLayer.changed, 'unknown');
  assert.equal(comparison.metadataOnly, true);
  assert.equal(comparison.dataUnchanged, 'not-proven');
});

test('a live observation records physical-device and geometry changes without claiming a data result', () => {
  const before = {
    identity: 'volume-v1', diskIds: ['1'], physicalDiskIdentity: 'PHYSICAL-A', partitionOffset: 1_048_576, partitionNumber: 1, partitionSize: 251_592_704,
    logicalSectorSize: 512, physicalSectorSize: 4096, fileSystem: 'NTFS', encryption: 'unlocked', interface: 'USB'
  };
  const after = { ...before, physicalDiskIdentity: 'PHYSICAL-B', partitionSize: 251_588_608, physicalSectorSize: 512 };
  const comparison = compareDeviceObservations(before, after);

  assert.equal(comparison.identityChanged, false);
  assert.equal(comparison.deviceLayer.changed, true);
  assert.equal(comparison.deviceLayer.fieldChanges.physicalDiskIdentities, true);
  assert.equal(comparison.deviceLayer.fieldChanges.partitionSize, true);
  assert.equal(comparison.deviceLayer.fieldChanges.physicalSectorSize, true);
  assert.equal(comparison.dataUnchanged, 'not-proven');
});

test('missing device metadata remains unknown and is not converted into an integrity conclusion', () => {
  const context = describeTrialContext({ sourceKind: 'volume', device: null });
  const comparison = compareDeviceObservations({}, {});

  assert.equal(context.group, 'live-volume');
  assert.equal(context.sourceIdentity, null);
  assert.equal(comparison.identityChanged, 'unknown');
  assert.equal(comparison.deviceLayer.fieldChanges.partitionSize, 'unknown');
  assert.deepEqual(comparison.freeSpace, { beforeBytes: null, afterBytes: null, deltaBytes: null, observed: false });
  assert.equal(comparison.conclusion, 'Metadata observations cannot prove source data unchanged.');
  assert.doesNotThrow(() => JSON.stringify(comparison));
});

test('an unclassified input does not inherit a live-volume or fixed-image trial policy', () => {
  const context = describeTrialContext({ sourceKind: 'folder' });

  assert.equal(context.group, 'unclassified-source');
  assert.equal(context.sourceHashComparison.allowed, false);
  assert.equal(context.sourceHashComparison.policy, 'source-kind-required');
  assert.match(context.consistencyLimitations[0], /not classified/);
});
