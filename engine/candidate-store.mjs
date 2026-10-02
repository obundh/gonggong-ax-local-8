import { DatabaseSync } from 'node:sqlite';
import { deserialize, serialize } from 'node:v8';
import path from 'node:path';

import { filterCandidates, normalizeFilters, candidateSearchName, normalizeMetadataCandidate } from './candidate-filter.mjs';

// The 10,000 item limit remains for callers that deliberately use the old
// in-memory helper. Disk-backed metadata jobs use the explicit limit below.
export const MAX_JOB_CANDIDATES = 10000;
export const MAX_METADATA_CANDIDATES = 100000;
export const MAX_CARVING_CANDIDATES = 10000;
export const MAX_CANDIDATE_BATCH = 256;

export class CandidateStoreError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'CandidateStoreError';
    this.code = 'CANDIDATE_STORE_FAILED';
  }
}

function fail(message, cause) {
  if (cause?.code === 'CANDIDATE_STORE_FAILED') throw cause;
  throw new CandidateStoreError(message, cause);
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function candidateColumns(candidate) {
  candidate = normalizeMetadataCandidate(candidate);
  const name = candidateSearchName(candidate);
  const candidatePath = String(candidate.originalPath || candidate.path || '');
  return {
    source: candidate.source == null ? null : String(candidate.source),
    kind: candidate.kind == null ? null : String(candidate.kind),
    extension: path.extname(name).slice(1).toLocaleLowerCase('und'),
    nameSort: name.normalize('NFKC').toLocaleLowerCase('und'),
    pathSort: candidatePath.normalize('NFKC').toLocaleLowerCase('und'),
    size: candidate.size != null && Number.isFinite(Number(candidate.size)) ? Number(candidate.size) : null,
    modified: timestamp(candidate.modifiedAt),
    deleted: timestamp(candidate.deletedAt),
    semantic: Number.isFinite(Number(candidate.semanticScore)) ? Number(candidate.semanticScore) : null
  };
}

function sortSql(sort, hasNameQuery) {
  if (!sort) return 'sequence ASC';
  if (sort === 'semantic-desc') return 'semantic_score DESC, sequence ASC';
  const description = typeof sort === 'string'
    ? /^(score|name|size|modified|deleted|path)(?:-(asc|desc))?$/.exec(sort)
    : null;
  let by;
  let direction;
  if (description) {
    by = description[1];
    direction = description[2] ?? (by === 'name' || by === 'path' ? 'asc' : 'desc');
  } else if (sort && typeof sort === 'object' && !Array.isArray(sort)) {
    by = sort.by ?? 'score';
    direction = sort.direction ?? (by === 'name' || by === 'path' ? 'asc' : 'desc');
  } else {
    throw new TypeError(`unsupported sort: ${sort}`);
  }
  if (!['score', 'name', 'size', 'modified', 'deleted', 'path'].includes(by) || !['asc', 'desc'].includes(direction)) {
    throw new TypeError('unsupported sort description');
  }
  const order = direction.toUpperCase();
  if (by === 'score') return `${hasNameQuery ? `match_rank ${order}, ` : ''}score ${order}, sequence ASC`;
  if (by === 'deleted') return `deleted_known DESC, deleted_at ${order}, sequence ASC`;
  if (by === 'modified') return `modified_at ${order}, sequence ASC`;
  if (by === 'size') return `size_value ${order}, sequence ASC`;
  if (by === 'path') return `path_sort ${order}, sequence ASC`;
  return `name_sort ${order}, sequence ASC`;
}

function decode(row) {
  return row ? deserialize(Buffer.from(row.data)) : undefined;
}

function pageQueryKey(normalized, keepNameMismatches) {
  return JSON.stringify({
    ...normalized,
    extensions: [...normalized.extensions].sort(),
    keepNameMismatches: Boolean(keepNameMismatches)
  });
}

/** A per-job candidate collection that materializes only the requested page. */
export class DiskCandidateStore {
  constructor(filePath, { maxCandidates = MAX_METADATA_CANDIDATES } = {}) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('candidate store path is required');
    if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > MAX_METADATA_CANDIDATES) {
      throw new RangeError(`candidate store limit must be between 1 and ${MAX_METADATA_CANDIDATES}`);
    }
    this.filePath = path.resolve(filePath);
    this.maxCandidates = maxCandidates;
    try {
      this.db = new DatabaseSync(this.filePath);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA temp_store = MEMORY;
        CREATE TABLE IF NOT EXISTS candidates (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          data BLOB NOT NULL,
          source TEXT,
          kind TEXT,
          extension TEXT,
          name_sort TEXT NOT NULL,
          path_sort TEXT NOT NULL,
          size_value REAL,
          modified_at REAL,
          deleted_at REAL,
          semantic_score REAL
        );
        CREATE INDEX IF NOT EXISTS candidates_source ON candidates(source);
        CREATE INDEX IF NOT EXISTS candidates_kind ON candidates(kind);
        CREATE INDEX IF NOT EXISTS candidates_extension ON candidates(extension);
        CREATE INDEX IF NOT EXISTS candidates_size ON candidates(size_value);
        CREATE INDEX IF NOT EXISTS candidates_modified ON candidates(modified_at);
        CREATE INDEX IF NOT EXISTS candidates_deleted ON candidates(deleted_at);
      `);
      this.getStatement = this.db.prepare('SELECT data FROM candidates WHERE id = ?');
      this.hasStatement = this.db.prepare('SELECT 1 AS present FROM candidates WHERE id = ?');
      this.countStatement = this.db.prepare('SELECT COUNT(*) AS total FROM candidates');
      this.dataVersionStatement = this.db.prepare('PRAGMA data_version');
      this.insertStatement = this.db.prepare(`INSERT INTO candidates
        (id, data, source, kind, extension, name_sort, path_sort, size_value, modified_at, deleted_at, semantic_score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data, source=excluded.source, kind=excluded.kind,
          extension=excluded.extension, name_sort=excluded.name_sort, path_sort=excluded.path_sort,
          size_value=excluded.size_value, modified_at=excluded.modified_at, deleted_at=excluded.deleted_at,
          semantic_score=excluded.semantic_score`);
      this.deleteStatement = this.db.prepare('DELETE FROM candidates WHERE id = ?');
      this.deleteSourceStatement = this.db.prepare('DELETE FROM candidates WHERE id = ? AND source = ?');
      this.clearStatement = this.db.prepare('DELETE FROM candidates');
      this.localRevision = 0;
      this.pageCache = null;
    } catch (error) {
      try { this.db?.close(); } catch { /* preserve the opening failure */ }
      fail('후보 저장소를 열지 못했어요. 작업 공간을 확인해주세요.', error);
    }
  }

  get size() {
    this.assertOpen();
    try { return Number(this.countStatement.get().total); }
    catch (error) { fail('후보 저장소의 개수를 읽지 못했어요.', error); }
  }

  assertOpen() {
    if (this.closed) fail('후보 저장소가 이미 닫혔어요.');
  }

  has(id) {
    this.assertOpen();
    try { return Boolean(this.hasStatement.get(String(id))); }
    catch (error) { fail('후보 저장소에서 파일을 확인하지 못했어요.', error); }
  }

  get(id) {
    this.assertOpen();
    try { return decode(this.getStatement.get(String(id))); }
    catch (error) { fail('후보 저장소에서 파일을 읽지 못했어요.', error); }
  }

  dataVersion() {
    return Number(this.dataVersionStatement.get().data_version);
  }

  invalidatePageCache() {
    this.localRevision++;
    this.pageCache = null;
  }

  set(id, candidate) {
    this.assertOpen();
    if (!candidate || typeof candidate !== 'object') throw new TypeError('candidate is required');
    const candidateId = String(id ?? candidate.id ?? '');
    if (!candidateId) throw new TypeError('candidate id is required');
    const stored = candidate.id === candidateId ? candidate : { ...candidate, id: candidateId };
    const columns = candidateColumns(stored);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      if (!this.hasStatement.get(candidateId) && Number(this.countStatement.get().total) >= this.maxCandidates) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.insertStatement.run(candidateId, serialize(stored), columns.source, columns.kind, columns.extension,
        columns.nameSort, columns.pathSort, columns.size, columns.modified, columns.deleted, columns.semantic);
      this.db.exec('COMMIT');
      this.invalidatePageCache();
      return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the storage failure */ }
      fail('후보를 작업 저장소에 기록하지 못했어요.', error);
    }
  }

  delete(id) {
    this.assertOpen();
    try {
      const deleted = this.deleteStatement.run(String(id)).changes > 0;
      if (deleted) this.invalidatePageCache();
      return deleted;
    }
    catch (error) { fail('후보 저장소에서 파일을 제거하지 못했어요.', error); }
  }

  // Each bounded group is committed before the worker publishes one refresh
  // notification. Existing rows can still be updated at the capacity limit.
  setBatch(items) {
    this.assertOpen();
    if (!Array.isArray(items) || items.length > MAX_CANDIDATE_BATCH) throw new RangeError('candidate batch must contain at most 256 items');
    const rows = items.map(candidate => {
      if (!candidate || typeof candidate !== 'object' || !String(candidate.id ?? '')) throw new TypeError('candidate id is required');
      const stored = { ...candidate, id: String(candidate.id) };
      return { id: stored.id, data: serialize(stored), columns: candidateColumns(stored) };
    });
    let imported = 0, skippedByLimit = 0;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      let count = Number(this.countStatement.get().total);
      for (const { id, data, columns } of rows) {
        const exists = Boolean(this.hasStatement.get(id));
        if (!exists && count >= this.maxCandidates) { skippedByLimit++; continue; }
        this.insertStatement.run(id, data, columns.source, columns.kind, columns.extension,
          columns.nameSort, columns.pathSort, columns.size, columns.modified, columns.deleted, columns.semantic);
        if (!exists) count++;
        imported++;
      }
      this.db.exec('COMMIT');
      if (imported > 0) this.invalidatePageCache();
      return { imported, skippedByLimit, truncated: skippedByLimit > 0 };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve the storage failure */ }
      fail('후보 묶음을 작업 저장소에 기록하지 못했어요.', error);
    }
  }

  deleteIfSource(id, source) {
    this.assertOpen();
    try {
      const deleted = this.deleteSourceStatement.run(String(id), String(source)).changes > 0;
      if (deleted) this.invalidatePageCache();
      return deleted;
    }
    catch (error) { fail('후보 저장소에서 갱신된 파일을 제거하지 못했어요.', error); }
  }

  clear() {
    this.assertOpen();
    try {
      const changed = this.clearStatement.run().changes;
      if (changed > 0) this.invalidatePageCache();
    } catch (error) { fail('후보 저장소를 비우지 못했어요.', error); }
  }

  *values() {
    this.assertOpen();
    try {
      for (const row of this.db.prepare('SELECT data FROM candidates ORDER BY sequence').iterate()) yield decode(row);
    } catch (error) { fail('후보 저장소를 순회하지 못했어요.', error); }
  }

  ensurePageDb() {
    if (this.pageDb) return this.pageDb;
    try {
      this.pageStorePath = `${this.filePath}.pages`;
      this.pageDb = new DatabaseSync(this.pageStorePath);
      this.pageDb.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA temp_store = MEMORY;
        CREATE TABLE IF NOT EXISTS page_results (
          sequence INTEGER PRIMARY KEY,
          data BLOB NOT NULL,
          name_match TEXT NOT NULL,
          match_rank INTEGER NOT NULL,
          score REAL NOT NULL,
          semantic_score REAL,
          name_sort TEXT NOT NULL,
          path_sort TEXT NOT NULL,
          size_value REAL,
          modified_at REAL,
          deleted_at REAL,
          deleted_known INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS page_semantic_desc ON page_results(semantic_score DESC, sequence ASC);
        CREATE INDEX IF NOT EXISTS page_match_desc ON page_results(match_rank DESC, score DESC, sequence ASC);
        CREATE INDEX IF NOT EXISTS page_match_asc ON page_results(match_rank ASC, score ASC, sequence ASC);
        CREATE INDEX IF NOT EXISTS page_score_desc ON page_results(score DESC, sequence ASC);
        CREATE INDEX IF NOT EXISTS page_score_asc ON page_results(score ASC, sequence ASC);
        CREATE INDEX IF NOT EXISTS page_name_asc ON page_results(name_sort ASC, sequence ASC);
        CREATE INDEX IF NOT EXISTS page_name_desc ON page_results(name_sort DESC, sequence ASC);
        CREATE INDEX IF NOT EXISTS page_path_asc ON page_results(path_sort ASC, sequence ASC);
        CREATE INDEX IF NOT EXISTS page_path_desc ON page_results(path_sort DESC, sequence ASC);
        CREATE INDEX IF NOT EXISTS page_size_asc ON page_results(size_value ASC, sequence ASC);
        CREATE INDEX IF NOT EXISTS page_size_desc ON page_results(size_value DESC, sequence ASC);
        CREATE INDEX IF NOT EXISTS page_modified_asc ON page_results(modified_at ASC, sequence ASC);
        CREATE INDEX IF NOT EXISTS page_modified_desc ON page_results(modified_at DESC, sequence ASC);
        CREATE INDEX IF NOT EXISTS page_deleted_asc ON page_results(deleted_known DESC, deleted_at ASC, sequence ASC);
        CREATE INDEX IF NOT EXISTS page_deleted_desc ON page_results(deleted_known DESC, deleted_at DESC, sequence ASC);
      `);
      this.pageInsertStatement = this.pageDb.prepare(`INSERT INTO page_results
        (sequence, data, name_match, match_rank, score, semantic_score, name_sort, path_sort, size_value, modified_at, deleted_at, deleted_known)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      this.pageDataVersionStatement = this.pageDb.prepare('PRAGMA data_version');
      return this.pageDb;
    } catch (error) { fail('후보 페이지 저장소를 열지 못했어요. 작업 공간을 확인해주세요.', error); }
  }

  page({ offset = 0, limit = 5, filters = {}, sort, keepNameMismatches = false } = {}) {
    this.assertOpen();
    const normalized = normalizeFilters(filters);
    try {
      const ordering = sortSql(sort, Boolean(normalized.name));
      const noFilters = !normalized.name && normalized.extensions.length === 0 && normalized.kind === 'all'
        && normalized.minSize === null && normalized.maxSize === null && normalized.modifiedAfter === null
        && normalized.modifiedBefore === null && normalized.deletedAfter === null && normalized.deletedBefore === null
        && normalized.includeUnknownDeletedAt && !normalized.pathContains;
      const directSort = !sort || sort === 'semantic-desc' || typeof sort === 'string' && /^(?:name|size|modified|deleted|path)(?:-(?:asc|desc))?$/.test(sort)
        || sort && typeof sort === 'object' && ['name', 'size', 'modified', 'deleted', 'path'].includes(sort.by ?? 'score');
      if (noFilters && directSort) {
        const total = this.size;
        const directOrdering = ordering.replace('deleted_known', '(deleted_at IS NOT NULL)');
        const items = this.db.prepare(`SELECT data FROM candidates ORDER BY ${directOrdering} LIMIT ? OFFSET ?`).all(limit, offset)
          .map(decode).map(candidate => filterCandidates([candidate], normalized)[0]);
        const unknownDeletedTimeTotal = Number(this.db.prepare('SELECT COUNT(*) AS total FROM candidates WHERE deleted_at IS NULL').get().total);
        const hasMore = offset + items.length < total;
        return { items, total, scannedTotal: total, matchCounts: { exact: 0, partial: 0, similar: 0, unknown: 0, none: total },
          unknownDeletedTimeTotal, offset, limit, hasMore, nextOffset: hasMore ? offset + items.length : null };
      }
      const pageDb = this.ensurePageDb();
      const queryKey = pageQueryKey(normalized, keepNameMismatches);
      const externalVersion = this.dataVersion();
      const scratchVersion = Number(this.pageDataVersionStatement.get().data_version);
      let summary = this.pageCache?.queryKey === queryKey
        && this.pageCache.localRevision === this.localRevision
        && this.pageCache.externalVersion === externalVersion
        && this.pageCache.scratchVersion === scratchVersion ? this.pageCache : null;
      if (summary) {
        const items = pageDb.prepare(`SELECT data FROM page_results ORDER BY ${ordering} LIMIT ? OFFSET ?`)
          .all(limit, offset).map(decode);
        // A worker may change the candidates, or another reader may replace
        // the shared scratch rows, between the first checks and this read.
        if (this.dataVersion() === externalVersion
          && Number(this.pageDataVersionStatement.get().data_version) === scratchVersion) {
          const hasMore = offset + items.length < summary.total;
          return { items, total: summary.total, scannedTotal: summary.scannedTotal,
            matchCounts: { ...summary.matchCounts }, unknownDeletedTimeTotal: summary.unknownDeletedTimeTotal,
            offset, limit, hasMore, nextOffset: hasMore ? offset + items.length : null };
        }
        this.pageCache = null;
      }

      const buildVersion = this.dataVersion();
      const scratchBuildVersion = Number(this.pageDataVersionStatement.get().data_version);
      pageDb.exec('BEGIN IMMEDIATE; DELETE FROM page_results');
      const matchCounts = { exact: 0, partial: 0, similar: 0, unknown: 0, none: 0 };
      const matchRanks = { exact: 4, partial: 3, similar: 2, unknown: 1, none: 0 };
      let total = 0;
      let scannedTotal = 0;
      let unknownDeletedTimeTotal = 0;
      for (const row of this.db.prepare('SELECT sequence, data FROM candidates ORDER BY sequence').iterate()) {
        scannedTotal++;
        const candidate = decode(row);
        const [listed] = filterCandidates([candidate], normalized, { keepNameMismatches });
        if (!listed) continue;
        const columns = candidateColumns(listed);
        this.pageInsertStatement.run(row.sequence, serialize(listed), listed.nameMatch.kind, matchRanks[listed.nameMatch.kind], Number(listed.score) || 0,
          columns.semantic, columns.nameSort, columns.pathSort, columns.size, columns.modified, columns.deleted,
          columns.deleted === null ? 0 : 1);
        total++;
        matchCounts[listed.nameMatch.kind]++;
        if (columns.deleted === null) unknownDeletedTimeTotal++;
      }
      // Read the requested page before releasing the scratch write lock. This
      // response therefore belongs to the materialization summarized below,
      // even if a second reader replaces the shared table immediately after.
      const items = pageDb.prepare(`SELECT data FROM page_results ORDER BY ${ordering} LIMIT ? OFFSET ?`)
        .all(limit, offset).map(decode);
      pageDb.exec('COMMIT');
      summary = { queryKey, localRevision: this.localRevision, externalVersion: buildVersion, scratchVersion: scratchBuildVersion,
        total, scannedTotal, matchCounts, unknownDeletedTimeTotal };
      // If either database changed during the scan, this result remains a
      // consistent snapshot for this call but must not become reusable.
      if (this.dataVersion() === buildVersion
        && Number(this.pageDataVersionStatement.get().data_version) === scratchBuildVersion) this.pageCache = summary;
      const hasMore = offset + items.length < total;
      return { items, total, scannedTotal, matchCounts: { ...matchCounts }, unknownDeletedTimeTotal,
        offset, limit, hasMore, nextOffset: hasMore ? offset + items.length : null };
    } catch (error) {
      try { this.pageDb?.exec('ROLLBACK'); } catch { /* preserve the page failure */ }
      fail('후보 페이지를 만들지 못했어요. 필터와 작업 저장소를 확인해주세요.', error);
    }
  }

  count(filters = {}, options = {}) {
    this.assertOpen();
    const normalized = normalizeFilters(filters);
    let total = 0;
    try {
      for (const row of this.db.prepare('SELECT data FROM candidates ORDER BY sequence').iterate()) {
        if (filterCandidates([decode(row)], normalized, { keepNameMismatches: options.keepNameMismatches === true }).length) total++;
      }
      return total;
    } catch (error) { fail('후보 저장소의 필터 결과 개수를 읽지 못했어요.', error); }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pageCache = null;
    try { this.pageDb?.close(); this.db.close(); }
    catch (error) { fail('후보 저장소를 닫지 못했어요.', error); }
  }
}

export function openCandidateStore(filePath, options) {
  return new DiskCandidateStore(filePath, options);
}

export function setBoundedCandidate(store, candidate) {
  if (!candidate || typeof candidate.id !== 'string' || !candidate.id) throw new TypeError('candidate id is required');
  if (store instanceof DiskCandidateStore) return store.set(candidate.id, candidate);
  if (!store.has(candidate.id) && store.size >= MAX_JOB_CANDIDATES) return false;
  store.set(candidate.id, candidate);
  return true;
}

export function mergeCandidateBatch(items, add) {
  let imported = 0;
  let skippedByLimit = 0;
  for (const candidate of items) {
    if (add(candidate)) imported++;
    else skippedByLimit++;
  }
  return { imported, skippedByLimit, truncated: skippedByLimit > 0 };
}
