#!/usr/bin/env node
/**
 * Create a disposable tenant for the Phase 3C live gates (BL-007).
 *
 * There is deliberately no `tenant user create` CLI action — tenants are
 * created by web signup or WhatsApp onboarding, both of which enforce the
 * allow-list. This script is the operator equivalent for gate testing only.
 *
 *   node scripts/create-gate-tenant.mjs --phone 919632754524 --name "Gate Test"
 *
 * It prints the tenant id, which is the only thing needed to run the gates.
 * It never prints or handles a credential.
 */
import { signupFromWeb } from '../src/onboarding.mjs';
import { ALLOWED_PHONES } from '../src/config.mjs';
import { normalizePhone } from '../src/phone.mjs';

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const phone = arg('--phone');
const name = arg('--name', 'Gate Test');
if (!phone) {
  console.error('usage: node scripts/create-gate-tenant.mjs --phone <e164-digits> [--name "..."]');
  process.exit(2);
}

// Signup checks the allow-list; admit this number for the run so gate testing
// does not require editing the deployed allow-list.
const normalized = normalizePhone(phone);
ALLOWED_PHONES.add(normalized.phone);

const { tenant, created } = await signupFromWeb({ name, phone, plan: 'claude' });

console.log('');
console.log('  tenant id : ' + tenant.id);
console.log('  phone     : ' + tenant.phone);
console.log('  state     : ' + tenant.state + (created ? ' (created)' : ' (already existed)'));
console.log('  workspace : ' + tenant.workspacePath);
console.log('');
console.log('  Next:');
console.log('    ./bin/tenant.mjs auth login --tenant ' + tenant.id);
console.log('');
