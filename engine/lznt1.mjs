const CHUNK_SIZE = 4096;
const DEFAULT_MAX_OUTPUT = 1024 * 1024;

export class Lznt1Error extends Error {
  constructor(message) {
    super(message);
    this.name = 'Lznt1Error';
    this.code = 'INVALID_LZNT1';
  }
}

function valid(condition, message) {
  if (!condition) throw new Lznt1Error(message);
}

/**
 * Decode the MS-XCA LZNT1 buffer format without accepting output beyond the
 * caller's bound. Chunks are independent and produce at most 4096 bytes each.
 */
export function decompressLznt1(input, { maxOutput = DEFAULT_MAX_OUTPUT } = {}) {
  valid(Buffer.isBuffer(input), 'LZNT1 input must be a Buffer.');
  valid(Number.isSafeInteger(maxOutput) && maxOutput >= 0 && maxOutput <= 16 * 1024 * 1024,
    'LZNT1 output bound is invalid.');
  const output = [];
  let outputLength = 0;
  let cursor = 0;
  let ended = false;

  while (cursor < input.length) {
    valid(cursor + 2 <= input.length, 'LZNT1 chunk header is truncated.');
    const header = input.readUInt16LE(cursor);
    cursor += 2;
    if (header === 0) {
      ended = true;
      break;
    }
    valid((header & 0x7000) === 0x3000, 'LZNT1 chunk signature is invalid.');
    const payloadLength = (header & 0x0fff) + 1;
    valid(payloadLength >= 1 && payloadLength <= CHUNK_SIZE, 'LZNT1 chunk size is invalid.');
    valid(cursor + payloadLength <= input.length, 'LZNT1 chunk payload is truncated.');
    const chunkEnd = cursor + payloadLength;
    const chunk = [];

    if (!(header & 0x8000)) {
      valid(outputLength + payloadLength <= maxOutput, 'LZNT1 output exceeds its bound.');
      output.push(Buffer.from(input.subarray(cursor, chunkEnd)));
      outputLength += payloadLength;
      cursor = chunkEnd;
      continue;
    }

    while (cursor < chunkEnd) {
      const flags = input[cursor++];
      for (let bit = 0; bit < 8 && cursor < chunkEnd; bit += 1) {
        if (!(flags & (1 << bit))) {
          valid(chunk.length < CHUNK_SIZE, 'LZNT1 chunk expands beyond 4096 bytes.');
          chunk.push(input[cursor++]);
          continue;
        }
        valid(cursor + 2 <= chunkEnd, 'LZNT1 compressed word is truncated.');
        const word = input.readUInt16LE(cursor);
        cursor += 2;
        let lengthMask = 0x0fff;
        let displacementShift = 12;
        for (let position = chunk.length; position >= 0x10; position >>= 1) {
          lengthMask >>= 1;
          displacementShift -= 1;
        }
        const displacement = (word >> displacementShift) + 1;
        const length = (word & lengthMask) + 3;
        valid(displacement <= chunk.length, 'LZNT1 back-reference precedes the chunk.');
        valid(chunk.length + length <= CHUNK_SIZE, 'LZNT1 chunk expands beyond 4096 bytes.');
        // Copy forward one byte at a time because the source and destination
        // may overlap, as required by MS-XCA.
        for (let index = 0; index < length; index += 1) chunk.push(chunk[chunk.length - displacement]);
      }
    }
    valid(chunk.length > 0, 'LZNT1 compressed chunk produced no data.');
    valid(outputLength + chunk.length <= maxOutput, 'LZNT1 output exceeds its bound.');
    output.push(Buffer.from(chunk));
    outputLength += chunk.length;
  }

  if (ended) valid(input.subarray(cursor).every(byte => byte === 0), 'LZNT1 data follows the end marker.');
  return Buffer.concat(output, outputLength);
}
