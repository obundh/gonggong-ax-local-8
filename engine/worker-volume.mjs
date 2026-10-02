import { RecoveryError } from './ntfs-image.mjs';

const failure = (code, message) => new RecoveryError(code, message);
const cancelled = () => failure('CANCELLED', '장치 읽기를 중단했어요.');
const commands = new Set(['open', 'read', 'assertUnchanged', 'queryJournal', 'readJournal', 'close']);

// Only the main process owns privileged connections. Each worker is bound to
// its already-selected device; messages cannot supply another path or helper.
export class WorkerVolumeBroker {
  constructor({ session, device, elevate, onPermission, onOpened, send, preparedOpen, owner }) {
    Object.assign(this, { session, device, elevate, onPermission, onOpened, send, preparedOpen, owner });
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
  }
  handle(message) {
    if (message.type === 'volume-cancel') {
      this.pending.get(message.requestId)?.abort();
      return;
    }
    if (message.type !== 'volume-request') return;
    const { requestId, command, args = {} } = message;
    const reply = value => {
      try { this.send({ type: 'volume-response', requestId, ...value }); } catch { void this.dispose().catch(() => {}); }
    };
    if (typeof requestId !== 'string' || requestId.length > 80 || this.pending.has(requestId)) return;
    if (this.closed || !commands.has(command) || this.pending.size >= 8) {
      reply({ error: { code: this.closed ? 'HELPER_CLOSED' : 'INVALID_REQUEST', message: '장치 읽기 요청을 처리할 수 없어요.' } });
      return;
    }
    const control = new AbortController();
    this.pending.set(requestId, control);
    const operation = this.queue.then(async () => {
      if (this.closed || control.signal.aborted) throw cancelled();
      if (command === 'open') {
        if (!this.provider) {
          const preparedOpen = this.preparedOpen;
          this.preparedOpen = undefined;
          this.provider = await this.session.open(this.device, {
            elevate: this.elevate, preparedOpen, owner: this.owner,
            onPermission: () => { if (!this.closed && !control.signal.aborted) this.onPermission?.(); }
          });
          // Main service can bind optional native identity evidence here.  The
          // worker only receives the resulting read-only info after this check.
          try { await this.onOpened?.(this.provider.info); }
          catch (error) { await this.provider.close(); this.provider = null; throw error; }
        }
        if (this.closed || control.signal.aborted) {
          await this.provider.close(); this.provider = null; throw cancelled();
        }
        return { info: this.provider.info };
      }
      if (!this.provider) throw failure('HELPER_CLOSED', '장치 읽기 연결이 닫혔어요.');
      if (command === 'close') { await this.provider.close(); this.provider = null; return { closed: true }; }
      if (command === 'read') {
        if (!Number.isSafeInteger(args.offset) || args.offset < 0 || !Number.isSafeInteger(args.length) || args.length < 1 || args.length > 1024 * 1024) {
          throw failure('INVALID_READ', '장치 읽기 범위가 잘못됐어요.');
        }
        return this.provider.read(args.offset, args.length, { signal: control.signal });
      }
      if (command === 'readJournal') return this.provider.readJournal({ startUsn: args.startUsn, journalId: args.journalId, maxBytes: args.maxBytes, signal: control.signal });
      if (command === 'queryJournal') return this.provider.queryJournal({ signal: control.signal });
      return this.provider.assertUnchanged();
    });
    this.queue = operation.then(result => {
      if (control.signal.aborted) throw cancelled();
      reply({ result });
    }).catch(error => reply({ error: { code: error.code ?? 'HELPER_FAILED', message: error.message } }))
      .finally(() => this.pending.delete(requestId));
    return this.queue;
  }
  dispose() {
    if (this.disposal) return this.disposal;
    this.closed = true;
    if (this.preparedOpen) this.session.revokePreparedOpen(this.preparedOpen);
    this.preparedOpen = undefined;
    for (const control of this.pending.values()) control.abort();
    this.disposal = this.queue.then(async () => { await this.provider?.close(); this.provider = null; });
    return this.disposal;
  }
}

export async function openWorkerVolume(port, { signal } = {}) {
  let serial = 0, closed = false, queue = Promise.resolve();
  const pending = new Map();
  const stop = error => {
    closed = true;
    for (const item of pending.values()) item.reject(error);
    pending.clear();
    port.off('message', receive); port.off('close', disconnected);
  };
  const disconnected = () => stop(failure('HELPER_CLOSED', '장치 읽기 연결이 끊겼어요.'));
  function receive(message) {
    if (message.type !== 'volume-response') return;
    const item = pending.get(message.requestId);
    if (!item) return;
    if (message.error) item.reject(Object.assign(new Error(message.error.message), message.error));
    else item.resolve(message.result);
  }
  port.on('message', receive); port.on('close', disconnected);
  function request(command, args = {}, signal) {
    if (closed) return Promise.reject(failure('HELPER_CLOSED', '장치 읽기 연결이 닫혔어요.'));
    if (signal?.aborted) return Promise.reject(cancelled());
    const requestId = `volume-${++serial}`;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(requestId); };
      const settle = fn => value => { cleanup(); fn(value); };
      const abort = () => { try { port.postMessage({ type: 'volume-cancel', requestId }); } catch {} pending.get(requestId)?.reject(cancelled()); };
      const timer = setTimeout(() => {
        try { port.postMessage({ type: 'volume-cancel', requestId }); } catch {}
        pending.get(requestId)?.reject(failure('HELPER_TIMEOUT', '장치 읽기 응답 시간이 초과됐어요.'));
      }, command === 'open' ? 150000 : 65000);
      pending.set(requestId, { resolve: settle(resolve), reject: settle(reject) });
      signal?.addEventListener('abort', abort, { once: true });
      try { port.postMessage({ type: 'volume-request', requestId, command, args }); }
      catch (error) { pending.get(requestId)?.reject(error); }
    });
  }
  function run(command, args, signal) {
    const result = queue.then(() => request(command, args, signal));
    queue = result.catch(() => {});
    return result;
  }
  try {
    const { info } = await request('open', {}, signal);
    return {
      info: Object.freeze(info),
      async read(offset, length, { signal } = {}) { return Buffer.from(await run('read', { offset, length }, signal)); },
      assertUnchanged() { return run('assertUnchanged'); },
      queryJournal({ signal } = {}) { return run('queryJournal', {}, signal); },
      async readJournal({ signal, startUsn, journalId, maxBytes } = {}) {
        const result = await run('readJournal', { startUsn, journalId, maxBytes }, signal);
        return { ...result, data: Buffer.from(result.data) };
      },
      async close() { if (!closed) try { await run('close'); } finally { stop(failure('HELPER_CLOSED', '장치 읽기 연결이 닫혔어요.')); } }
    };
  } catch (error) { stop(error); throw error; }
}
