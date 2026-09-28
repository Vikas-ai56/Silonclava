import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fileLockOwnerMatches(owner, ownedStat, currentToken, currentStat) {
  return Boolean(
    ownedStat &&
    currentStat &&
    currentToken === owner?.token &&
    currentStat.dev === ownedStat.dev &&
    currentStat.ino === ownedStat.ino,
  );
}

export async function acquireFileLock(
  lockFile,
  { waitMs = 5_000, retryMs = 25 } = {},
) {
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    try {
      const handle = await fs.open(lockFile, 'wx', 0o600);
      const token = `${process.pid}:${crypto.randomBytes(16).toString('hex')}`;
      try {
        await handle.writeFile(`${token}\n`);
        return { handle, token, lockFile };
      } catch (err) {
        await handle.close().catch(() => {});
        await fs.unlink(lockFile).catch(() => {});
        throw err;
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      // Never auto-break a lock based on age. The previous owner may still be
      // running, and unlinking its inode can admit a second writer.
      await sleep(retryMs);
    }
  }
  throw new Error(`Timed out waiting for file lock: ${lockFile}`);
}

export async function releaseFileLock(owner) {
  let ownedStat = null;
  try {
    ownedStat = await owner?.handle?.stat().catch(() => null);
    await owner?.handle?.close();
  } finally {
    try {
      const currentToken = (await fs.readFile(owner.lockFile, 'utf8')).trim();
      const currentStat = await fs.stat(owner.lockFile);
      if (fileLockOwnerMatches(owner, ownedStat, currentToken, currentStat)) {
        await fs.unlink(owner.lockFile);
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
}

export async function withFileLock(lockFile, operation, options) {
  const owner = await acquireFileLock(lockFile, options);
  try {
    return await operation();
  } finally {
    await releaseFileLock(owner);
  }
}
