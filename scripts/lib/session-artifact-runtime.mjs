import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The private persistence lease protocol was audited against these releases.
// 0.2.2-rc.1 keeps the exact Windows named-semaphore protocol and the POSIX
// flock protocol (it adds a post-lock inode re-verification this adapter
// already performs). A later host can still validate a dry run, but must not
// acquire an unverified lock.
export const SUPPORTED_LEASE_VERSIONS = ['0.2.1-rc.5', '0.2.2-rc.1'];
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;

function ownershipError(id) {
  return Object.assign(new Error(`Session "${id}" already has a writer; stop that writer before repairing its log.`), {
    code: 'SESSION_ALREADY_OWNED', sessionId: id,
  });
}

function win32Error(operation, errorCode) {
  return Object.assign(new Error(`${operation} failed (Win32 error ${errorCode})`), {
    code: 'ERR_SESSION_LEASE_WIN32', syscall: operation, win32Code: errorCode,
  });
}

async function loadWin32(hostRequire) {
  const imported = await import(pathToFileURL(hostRequire.resolve('koffi')).href);
  const library = (imported.default ?? imported).load('kernel32.dll');
  return {
    createSemaphore: library.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']),
    wait: library.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']),
    releaseSemaphore: library.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']),
    close: library.func('__stdcall', 'CloseHandle', 'int', ['intptr']),
    lastError: library.func('__stdcall', 'GetLastError', 'uint', []),
  };
}

async function acquireWin32(api, lockPath, id) {
  // Must match dsh-session-persistence-jsonl SessionWriteLease exactly.
  const name = `Local\\dsh-session-lock-${createHash('sha256').update(resolve(lockPath).toLowerCase()).digest('hex')}`;
  const handle = api.createSemaphore(null, 1, 1, name);
  if (!handle) throw win32Error('CreateSemaphoreW', api.lastError());
  const status = api.wait(handle, 0);
  if (status !== WAIT_OBJECT_0) {
    const errorCode = api.lastError();
    api.close(handle);
    if (status === WAIT_TIMEOUT) throw ownershipError(id);
    throw win32Error('WaitForSingleObject', errorCode);
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      const releasedSemaphore = api.releaseSemaphore(handle, 1, null);
      const releaseError = releasedSemaphore ? undefined : api.lastError();
      const closed = api.close(handle);
      const closeError = closed ? undefined : api.lastError();
      if (!releasedSemaphore) throw win32Error('ReleaseSemaphore', releaseError);
      if (!closed) throw win32Error('CloseHandle', closeError);
    },
  };
}

async function acquirePosix(tryLockExclusive, lockPath, id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const handle = await open(lockPath, 'w');
    try {
      await tryLockExclusive(handle.fd);
      const held = await handle.stat({ bigint: true });
      let current;
      try {
        current = await stat(lockPath, { bigint: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (current && held.ino === current.ino && held.dev === current.dev) {
        let releasePromise;
        return {
          release() {
            // Closing releases flock. Never unlink the shared lock inode.
            return releasePromise ??= handle.close();
          },
        };
      }
    } catch (error) {
      await handle.close();
      if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK') throw ownershipError(id);
      throw error;
    }
    await handle.close();
  }
  throw ownershipError(id);
}

/**
 * Load the installed host's public full-artifact validator and compatible write lease.
 * @param {string} dshRoot Absolute host dsh directory, including an app.asar path when applicable.
 * @returns {Promise<{validateRows(rows: unknown[]): void, acquireLease(dir: string, id: string): Promise<{release(): Promise<void>}>}>}
 */
export async function loadArtifactRuntime(dshRoot) {
  if (typeof dshRoot !== 'string' || !isAbsolute(dshRoot)) throw new TypeError('dshRoot must be an absolute host dsh directory');
  const hostRequire = createRequire(join(dshRoot, 'package.json'));
  const catalogEntry = hostRequire.resolve('@deepseek-ai/dsh-session-format-catalog');
  const persistenceEntry = hostRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl');
  const { sessionFormatCatalog } = await import(pathToFileURL(catalogEntry).href);
  const persistenceManifest = JSON.parse(await readFile(join(dirname(persistenceEntry), '..', 'package.json'), 'utf8'));
  if (!sessionFormatCatalog || typeof sessionFormatCatalog.createRestore !== 'function') {
    throw new Error('Installed host does not expose the full session artifact validator');
  }
  let platformApi;
  return {
    validateRows(rows) {
      if (!Array.isArray(rows) || rows.length === 0) throw new TypeError('Session artifact must contain a header');
      const restore = sessionFormatCatalog.createRestore(rows[0], { recovery: 'strict', validation: 'current' });
      for (const row of rows.slice(1)) restore.decodeRow(row);
      restore.finish();
    },
    async acquireLease(dir, id) {
      if (!SUPPORTED_LEASE_VERSIONS.includes(persistenceManifest.version) || sessionFormatCatalog.currentVersion !== 4) {
        throw new Error(`Refusing repair: session write lease protocol is unverified for host ${persistenceManifest.version} / format ${sessionFormatCatalog.currentVersion}`);
      }
      if (typeof dir !== 'string' || !isAbsolute(dir) || typeof id !== 'string' || !id) {
        throw new TypeError('acquireLease requires an absolute session directory and a nonempty session id');
      }
      if (process.platform !== 'win32' && process.platform !== 'linux' && process.platform !== 'darwin') {
        throw new Error(`Refusing repair: unsupported session write lease platform ${process.platform}`);
      }
      if (!platformApi) {
        platformApi = process.platform === 'win32'
          ? loadWin32(hostRequire)
          : import(pathToFileURL(hostRequire.resolve('@deepseek-ai/node-addon-system/flock')).href);
      }
      const api = await platformApi;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const lockPath = join(dir, 'session.lock');
      return process.platform === 'win32'
        ? acquireWin32(api, lockPath, id)
        : acquirePosix(api.tryLockExclusive, lockPath, id);
    },
  };
}
