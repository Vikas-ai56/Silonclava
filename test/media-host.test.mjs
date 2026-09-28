import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
process.env.ROCKY_MEDIA_SIGNING_KEY = process.env.ROCKY_MEDIA_SIGNING_KEY || 'test-media-signing-key';
import path from 'node:path';
import { mediaLinkFor, serveMedia, resolveWorkspaceFile, MEDIA_PATH_PREFIX } from '../src/media-host.mjs';
import { TENANTS_DIR } from '../src/paths.mjs';

const TENANT = `br_media_${process.pid}`;
const workspace = path.join(TENANTS_DIR, TENANT, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'nda.txt'), 'CONFIDENTIAL');
fs.mkdirSync(path.join(TENANTS_DIR, TENANT, 'vault'), { recursive: true });
fs.writeFileSync(path.join(TENANTS_DIR, TENANT, 'vault', 'secret.json'), 'KEY');
after(() => fs.rmSync(path.join(TENANTS_DIR, TENANT), { recursive: true, force: true }));

function parse(url) {
  const u = new URL(url);
  return { pathname: u.pathname, searchParams: u.searchParams };
}

/**
 * Twilio fetches outbound media from a public URL, so these links are reachable
 * by anyone who has one. They are tenant documents, so the link must be
 * unguessable, scoped to one file, and short-lived.
 */
describe('outbound media links', () => {
  it('serves a signed link to a workspace file', async () => {
    const { url } = mediaLinkFor(TENANT, 'nda.txt');
    const { pathname, searchParams } = parse(url);
    assert.ok(pathname.startsWith(`${MEDIA_PATH_PREFIX}/`));
    const out = await serveMedia(pathname, searchParams);
    assert.equal(out.status, 200);
    assert.match(out.headers['Content-Disposition'], /nda\.txt/);
  });

  it('refuses a tampered signature', async () => {
    const { url } = mediaLinkFor(TENANT, 'nda.txt');
    const { pathname, searchParams } = parse(url);
    searchParams.set('s', 'x'.repeat(43));
    assert.equal((await serveMedia(pathname, searchParams)).status, 403);
  });

  it('refuses a link whose expiry was extended', async () => {
    const { url } = mediaLinkFor(TENANT, 'nda.txt');
    const { pathname, searchParams } = parse(url);
    searchParams.set('e', String(Date.now() + 86_400_000));
    assert.equal((await serveMedia(pathname, searchParams)).status, 403,
      'expiry is inside the signature, so moving it must invalidate the link');
  });

  it('expires', async () => {
    const { url } = mediaLinkFor(TENANT, 'nda.txt', { ttlMs: -1 });
    const { pathname, searchParams } = parse(url);
    assert.equal((await serveMedia(pathname, searchParams)).status, 410);
  });

  it('cannot escape the workspace, so the vault is unreachable', () => {
    // Traversal is refused outright.
    for (const bad of ['../vault/secret.json', '../../etc/passwd', '..', '../../../root']) {
      assert.throws(() => resolveWorkspaceFile(TENANT, bad), /outside the workspace/,
        `${bad} must not resolve`);
    }
    // An absolute path is coerced to workspace-relative rather than rejected —
    // it lands inside the workspace, so it can never read a host file.
    const abs = resolveWorkspaceFile(TENANT, '/etc/passwd');
    assert.ok(abs.target.startsWith(abs.workspace), 'an absolute path must stay inside');
    assert.equal(abs.relPath, 'etc/passwd');
  });

  it('a link for one tenant does not serve another tenant', async () => {
    const { url } = mediaLinkFor(TENANT, 'nda.txt');
    const { pathname, searchParams } = parse(url);
    const swapped = pathname.replace(TENANT, 'br_someone_else');
    assert.notEqual((await serveMedia(swapped, searchParams)).status, 200);
  });

  it('404s a file that does not exist', async () => {
    const { url } = mediaLinkFor(TENANT, 'missing.pdf');
    const { pathname, searchParams } = parse(url);
    assert.equal((await serveMedia(pathname, searchParams)).status, 404);
  });
});
