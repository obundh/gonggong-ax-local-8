import { readFile, writeFile } from 'node:fs/promises';
import { createFreedIndexFixture } from './directory-freed-fixture.mjs';
import { slackBlock, slackEntry } from './directory-slack-fixture.mjs';

export const allocatedTailNames = Array.from(
  { length: 128 },
  (_, index) => `할당-꼬리-${String(index).padStart(3, '0')}.txt`,
);

export const freedIndexNames = Array.from(
  { length: 128 },
  (_, index) => `해제-인덱스-${String(index).padStart(3, '0')}.txt`,
);

function entry(name, index, sequenceBase) {
  return slackEntry({
    name,
    number: 48 + index % 16,
    sequence: sequenceBase + Math.floor(index / 16),
  });
}

/**
 * Builds one deterministic NTFS image with eight bitmap-allocated $I30 nodes
 * containing exactly 128 unused-tail names, followed by eight bitmap-free but
 * volume-allocated nodes containing another 128 historical names.
 */
export async function createDirectoryPhaseBudgetFixture(folder) {
  const fixture = await createFreedIndexFixture(folder, {
    blockCount: 16,
    freedIndexes: Array.from({ length: 8 }, (_, index) => index + 8),
    evidenceIndexes: [],
  });
  const image = await readFile(fixture.imagePath);

  for (let blockIndex = 0; blockIndex < 8; blockIndex++) {
    const start = blockIndex * 16;
    slackBlock({
      vcn: blockIndex,
      remnants: allocatedTailNames
        .slice(start, start + 16)
        .map((name, slot) => entry(name, start + slot, 20)),
    }).copy(image, (150 + blockIndex) * 4096);
  }

  for (let blockIndex = 8; blockIndex < 16; blockIndex++) {
    const start = (blockIndex - 8) * 16;
    const entries = freedIndexNames
      .slice(start, start + 16)
      .map((name, slot) => entry(name, start + slot, 40));
    slackBlock({
      vcn: blockIndex,
      active: entries.slice(0, 1),
      remnants: entries.slice(1),
    }).copy(image, (150 + blockIndex) * 4096);
  }

  await writeFile(fixture.imagePath, image);
  return fixture;
}
