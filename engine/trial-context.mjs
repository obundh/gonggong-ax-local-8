const UNKNOWN = 'unknown';

function text(value) {
  if (typeof value === 'bigint') return value.toString();
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonNegativeBytes(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function observedIdentity(observation) {
  if (!observation || typeof observation !== 'object') return null;
  return text(observation.identity) ?? text(observation.sourceIdentity) ?? text(observation.deviceIdentity);
}

function knownText(value) {
  const normalized = text(value);
  return normalized && normalized.toLowerCase() !== UNKNOWN ? normalized : null;
}

function knownNumber(value) {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function knownList(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const observed = [...new Set(values.map(knownText).filter(Boolean))].sort();
  return observed.length ? observed : null;
}

function layerObservation(observation) {
  if (!observation || typeof observation !== 'object') return null;
  const physicalFromRows = Array.isArray(observation.physicalDisks)
    ? observation.physicalDisks.map(disk => disk?.identity) : [];
  return {
    diskIds: knownList(observation.diskIds),
    physicalDiskIdentities: knownList(observation.physicalDiskIdentities ?? observation.physicalDiskIdentity ?? physicalFromRows),
    partitionOffset: knownNumber(observation.partitionOffset ?? observation.startingOffset),
    partitionNumber: knownNumber(observation.partitionNumber),
    partitionSize: knownNumber(observation.partitionSize ?? observation.rawVolumeSize),
    logicalSectorSize: knownNumber(observation.logicalSectorSize ?? observation.sectorSize ?? observation.bytesPerSector),
    physicalSectorSize: knownNumber(observation.physicalSectorSize ?? observation.physicalBytesPerSector),
    fileSystem: knownText(observation.fileSystem),
    encryption: knownText(observation.encryption ?? observation.encryptionStatus ?? observation.bitLockerStatus),
    interface: knownText(observation.interface ?? observation.interfaceType ?? observation.busType)
  };
}

function compareLayer(before, after) {
  const beforeLayer = layerObservation(before);
  const afterLayer = layerObservation(after);
  const fields = Object.keys(beforeLayer ?? afterLayer ?? {});
  const changes = Object.fromEntries(fields.map(field => {
    const beforeValue = beforeLayer?.[field] ?? null;
    const afterValue = afterLayer?.[field] ?? null;
    return [field, beforeValue === null || afterValue === null ? UNKNOWN : JSON.stringify(beforeValue) !== JSON.stringify(afterValue)];
  }));
  const values = Object.values(changes);
  return {
    before: beforeLayer,
    after: afterLayer,
    fieldChanges: changes,
    changed: values.includes(true) ? true : values.length && values.every(value => value === false) ? false : UNKNOWN,
    observed: values.length > 0 && values.some(value => value !== UNKNOWN)
  };
}

function serializable(value, seen = new WeakSet()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(item => serializable(item, seen));
  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = serializable(item, seen);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

/**
 * Describes what a trial's observations can support.  This is intentionally a
 * classification contract: it neither opens a device nor checks a hash.
 */
export function describeTrialContext({ sourceKind, system, sourceIdentity, device } = {}) {
  const normalizedSourceKind = knownText(sourceKind)?.toLowerCase();
  const fixedImage = normalizedSourceKind === 'image' || normalizedSourceKind === 'fixed-image';
  const liveVolume = normalizedSourceKind === 'volume' || normalizedSourceKind === 'live-volume';
  const group = fixedImage ? 'fixed-image' : liveVolume && system === true ? 'live-system-volume' : liveVolume ? 'live-volume' : 'unclassified-source';

  return {
    group,
    sourceKind: text(sourceKind) ?? UNKNOWN,
    sourceIdentity: text(sourceIdentity),
    device: device && typeof device === 'object' ? serializable(device) : null,
    consistencyLimitations: fixedImage
      ? [
          'A fixed image comparison applies only to the exact identified image bytes and recorded hash method.',
          'The comparison does not prove properties of the original device after the image was created.'
        ]
      : liveVolume ? [
          'A live volume can change while it is observed or read by Windows and other software.',
          'A read-only handle only describes this reader access request; it does not freeze the host, file system, or storage device.',
          'Device metadata observations cannot establish a globally static source snapshot.'
        ] : [
          'The source kind is not classified as a fixed image or live volume.',
          'No comparison or preservation conclusion is selected for an unclassified source.'
        ],
    sourceHashComparison: fixedImage
      ? {
          allowed: true,
          policy: 'before-after-fixed-image',
          statement: 'A whole-image hash may be compared before and after the fixed-image trial.'
        }
      : liveVolume ? {
          allowed: false,
          policy: 'no-global-static-snapshot-assertion',
          statement: 'Do not assert that a live volume was globally static or unchanged from a source hash comparison.'
        } : {
          allowed: false,
          policy: 'source-kind-required',
          statement: 'Classify the source as a fixed image or live volume before choosing a trial comparison method.'
        }
  };
}

/**
 * Compares only supplied device metadata.  It deliberately has no positive
 * data-integrity conclusion, even when identities and free space match.
 */
export function compareDeviceObservations(before, after) {
  const beforeIdentity = observedIdentity(before);
  const afterIdentity = observedIdentity(after);
  const beforeBytes = nonNegativeBytes(before?.freeSpace ?? before?.freeSpaceBytes);
  const afterBytes = nonNegativeBytes(after?.freeSpace ?? after?.freeSpaceBytes);
  const freeSpaceObserved = beforeBytes !== null && afterBytes !== null;

  return {
    metadataOnly: true,
    beforeIdentity,
    afterIdentity,
    identityChanged: beforeIdentity === null || afterIdentity === null ? UNKNOWN : beforeIdentity !== afterIdentity,
    freeSpace: {
      beforeBytes,
      afterBytes,
      deltaBytes: freeSpaceObserved ? afterBytes - beforeBytes : null,
      observed: freeSpaceObserved
    },
    freeSpaceDeltaBytes: freeSpaceObserved ? afterBytes - beforeBytes : null,
    deviceLayer: compareLayer(before, after),
    dataUnchanged: 'not-proven',
    conclusion: 'Metadata observations cannot prove source data unchanged.'
  };
}
