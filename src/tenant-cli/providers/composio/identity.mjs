import crypto from 'node:crypto';
import {
  CONNECTOR_ASSERTION_AUDIENCE,
  CONNECTOR_ASSERTION_ISSUER,
  ENTERPRISE_ORG_ID,
} from '../../../config.mjs';

function encoded(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function createConnectorAssertion(tenantId, privateKey, { now = Date.now } = {}) {
  const subject = String(tenantId || '');
  if (!/^br_[a-f0-9]{12}$/.test(subject) && !/^__test_[A-Za-z0-9_-]+$/.test(subject)) {
    throw new Error('Connector assertion requires a valid server-resolved tenant id');
  }
  const issuedAt = Math.floor(now() / 1000);
  const header = encoded({ alg: 'ES256', typ: 'JWT' });
  const payload = encoded({
    iss: CONNECTOR_ASSERTION_ISSUER,
    aud: CONNECTOR_ASSERTION_AUDIENCE,
    sub: subject,
    org: ENTERPRISE_ORG_ID,
    iat: issuedAt,
    exp: issuedAt + 45,
    jti: crypto.randomUUID(),
  });
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}
