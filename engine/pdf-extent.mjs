// Bounded extent checks, not a PDF renderer or proof of original identity.
const WS = /[\x00\t\n\f\r ]/;
const DELIMITER = /[\x00\t\n\f\r ()<>\[\]{}\/%]/;

function lexer(text) {
  let at = 0, count = 0;
  function next() {
    if (++count > 2048) throw Error('token limit');
    while (at < text.length) {
      if (WS.test(text[at])) { at++; continue; }
      if (text[at] !== '%') break;
      while (at < text.length && !/[\r\n]/.test(text[at])) at++;
    }
    if (at >= text.length) throw Error('bounded header exhausted');
    const start = at++, c = text[start];
    if (c === '(') {
      let depth = 1;
      while (at < text.length && depth) {
        const v = text[at++];
        if (v === '\\') at++;
        else if (v === '(') depth++;
        else if (v === ')') depth--;
      }
      if (depth) throw Error('unfinished string');
      return { kind: 'string' };
    }
    if (c === '<' || c === '>') {
      if (text[at] === c) { at++; return { kind: c + c }; }
      if (c === '>') throw Error('unexpected delimiter');
      while (at < text.length && /[\da-fA-F\x00\t\n\f\r ]/.test(text[at])) at++;
      if (text[at++] !== '>') throw Error('unfinished hex string');
      return { kind: 'string' };
    }
    if (c === '[' || c === ']') return { kind: c };
    if (c === '/') {
      while (at < text.length && !DELIMITER.test(text[at])) at++;
      return { kind: 'name', value: text.slice(start + 1, at).replace(/#([\da-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))) };
    }
    if (DELIMITER.test(c)) throw Error('unexpected delimiter');
    while (at < text.length && !DELIMITER.test(text[at])) at++;
    const value = text.slice(start, at);
    return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)
      ? { kind: 'number', value: Number(value) } : { kind: 'word', value };
  }
  let queued = [];
  return { next: () => queued.shift() ?? next(), put: (...tokens) => { queued = [...tokens, ...queued]; } };
}

function value(tokens, token, depth = 0) {
  if (depth > 12) throw Error('nesting limit');
  if (token.kind === '<<') {
    const entries = new Map();
    for (let key = tokens.next(); key.kind !== '>>'; key = tokens.next()) {
      if (key.kind !== 'name' || entries.has(key.value)) throw Error('invalid or duplicate dictionary key');
      entries.set(key.value, value(tokens, tokens.next(), depth + 1));
    }
    return { kind: 'dictionary', value: entries };
  }
  if (token.kind === '[') {
    const entries = [];
    for (let item = tokens.next(); item.kind !== ']'; item = tokens.next()) entries.push(value(tokens, item, depth + 1));
    return { kind: 'array', value: entries };
  }
  if (token.kind === 'number') {
    const second = tokens.next();
    if (second.kind === 'number') {
      const third = tokens.next();
      if (third.kind === 'word' && third.value === 'R') return { kind: 'reference' };
      tokens.put(second, third);
    } else tokens.put(second);
    return token;
  }
  if (['name', 'string'].includes(token.kind) || (token.kind === 'word' && ['true', 'false', 'null'].includes(token.value))) return token;
  throw Error('invalid value');
}

function linearization(header) {
  const tokens = lexer(header.toString('latin1'));
  const number = tokens.next(), generation = tokens.next(), obj = tokens.next();
  if (number.kind !== 'number' || generation.kind !== 'number' || obj.value !== 'obj') throw Error('first object missing');
  const start = tokens.next();
  if (start.kind !== '<<') return null;
  const dictionary = value(tokens, start).value;
  if (!dictionary.has('Linearized')) return null;
  if (tokens.next().value !== 'endobj') throw Error('linearization dictionary is not a direct object');
  const numeric = key => {
    const entry = dictionary.get(key);
    if (entry?.kind !== 'number' || !Number.isSafeInteger(entry.value) || entry.value <= 0) throw Error(`invalid ${key}`);
    return entry.value;
  };
  if (numeric('Linearized') !== 1) throw Error('unsupported linearization version');
  const length = numeric('L'), end = numeric('E'), mainXref = numeric('T');
  numeric('O'); numeric('N');
  if (end >= length || mainXref >= length) throw Error('invalid linearization bounds');
  const hints = dictionary.get('H');
  if (hints?.kind !== 'array' || ![2, 4].includes(hints.value.length)) throw Error('invalid hints');
  for (let i = 0; i < hints.value.length; i += 2) {
    const pair = hints.value.slice(i, i + 2);
    if (!pair.every(x => x.kind === 'number' && Number.isSafeInteger(x.value) && x.value > 0)
      || pair[0].value >= length || pair[1].value > length - pair[0].value) throw Error('invalid hint bounds');
  }
  return { length, mainXref };
}

export async function linearizedPdfExtent(read, available, maxFileBytes) {
  const unsupported = reason => ({ state: 'unsupported', reason: `PDF 선형화 구조를 안전하게 구분하지 못했어요: ${reason}` });
  let info;
  try { info = linearization(await read(0, Math.min(4096, available))); }
  catch { return unsupported('머리말 사전이 손상됐거나 지원 범위를 넘어요.'); }
  if (!info) return null;
  const { length, mainXref } = info;
  if (length > maxFileBytes) return { state: 'limit', reason: 'PDF가 파일별 크기 제한을 넘어요.' };
  if (length > available) return unsupported('선언된 파일 끝이 선택한 검색 범위 밖이에요.');
  const tail = (await read(Math.max(0, length - 2048), Math.min(2048, length))).toString('latin1');
  const footer = /(?:^|[\r\n])startxref[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+%%EOF[\x00\t\n\f\r ]*$/.exec(tail);
  if (!footer) return unsupported('선언된 길이에서 마지막 종료 표시를 확인하지 못했어요.');
  const xref = Number(footer[1]);
  if (!Number.isSafeInteger(xref) || xref <= 0 || xref >= mainXref) return unsupported('교차 참조 위치가 맞지 않아요.');
  const firstTable = (await read(xref, Math.min(128, length - xref))).toString('latin1');
  const mainEntry = (await read(mainXref, Math.min(64, length - mainXref))).toString('latin1');
  if (!/^xref[\x00\t\n\f\r ]+\d+[\x00\t\n\f\r ]+\d+[\x00\t\n\f\r ]+\d{10} \d{5} [nf](?:\r|\n| )/.test(firstTable)
    || !/^[\x00\t\n\f\r ]*\d{10} \d{5} [nf](?:\r|\n| )/.test(mainEntry)) {
    return unsupported('기본 교차 참조 표가 없거나 지원하지 않는 교차 참조 스트림이에요.');
  }
  // Recognizable immediately appended revisions invalidate /L. Do not call the
  // old prefix a complete current document. Arbitrary fragment joining is out of scope.
  if (available > length) {
    const following = (await read(length, Math.min(4096, available - length))).toString('latin1');
    const afterComments = following.replace(/^(?:[\x00\t\n\f\r ]|%(?!PDF-)[^\r\n]*(?:\r\n|[\r\n]))*/, '');
    if (/^(?:\d+\s+\d+\s+obj\b|xref\b|trailer\b)/.test(afterComments)) return unsupported('추가 저장 이력이 있어 원래 길이를 확정할 수 없어요.');
  }
  return { state: 'complete', length, extension: 'pdf', kind: 'document', validation: 'pdf-linearized-length-xref-eof' };
}
