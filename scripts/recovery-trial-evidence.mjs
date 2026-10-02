// Trial reporting only. Never used to discover or authorize recovery candidates.
export function eventsForCandidate(events, candidate) {
  if (!candidate) return { generationEvents: [], matchedDeletes: [] };
  const generationEvents = events.filter(event => event.recordNumber === candidate.recordNumber
    && event.sequence > 0 && event.sequence < 65535 && event.sequence + 1 === candidate.sequence);
  const matchedDeletes = generationEvents.filter(event => (event.reason & 0x200) !== 0
    && candidate.nameReferences.some(ref => ref.name === event.name
      && ref.parent.recordNumber === event.parent.recordNumber && ref.parent.sequence === event.parent.sequence));
  return { generationEvents, matchedDeletes };
}

export function eventsForOriginalFileId(events, fileId) {
  const identity = BigInt(fileId);
  const recordNumber = Number(identity & 0xffffffffffffn), sequence = Number(identity >> 48n);
  return events.filter(event => event.recordNumber === recordNumber && event.sequence === sequence);
}
