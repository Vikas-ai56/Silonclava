#!/usr/bin/env node
import { computeSignature } from '../src/twilio-channel.mjs';

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const target = arg('--target', process.env.ROCKY_PUBLIC_BASE_URL || 'http://127.0.0.1:8787');
const publicBase = arg('--public-base', process.env.ROCKY_PUBLIC_BASE_URL || target);
const from = arg('--from');
const text = arg('--text', 'hello from twilio-simulate');
const replyTo = arg('--reply-to');
const status = arg('--status');
const tenant = arg('--tenant');
const authToken = process.env.TWILIO_AUTH_TOKEN;
const badSignature = process.argv.includes('--bad-signature');

if (!authToken) {
  console.error('TWILIO_AUTH_TOKEN must be set (it is the HMAC key; never pass it as an argument)');
  process.exit(2);
}
if (!status && !from) {
  console.error(`usage:
  node scripts/twilio-simulate.mjs --from +919632754524 [--text "..."] [--reply-to SMxxx]
  node scripts/twilio-simulate.mjs --status delivered --tenant br_xxx [--sid SMxxx]

  --target       where to send      (default $ROCKY_PUBLIC_BASE_URL or http://127.0.0.1:8787)
  --public-base  what to sign with  (must equal the deployment's ROCKY_PUBLIC_BASE_URL)
  --bad-signature  send a deliberately invalid signature; expect 403`);
  process.exit(2);
}

const sid = arg('--sid', `SM${Date.now().toString().padStart(32, '0')}`.slice(0, 34));
const path = status ? '/webhooks/twilio/status' : '/webhooks/twilio/inbound';
const query = status && tenant ? `?t=${encodeURIComponent(tenant)}` : '';

const params = status
  ? { MessageSid: sid, MessageStatus: status, AccountSid: process.env.TWILIO_ACCOUNT_SID || 'AC0' }
  : {
      MessageSid: sid,
      SmsMessageSid: sid,
      AccountSid: process.env.TWILIO_ACCOUNT_SID || 'AC0',
      From: `whatsapp:${from}`,
      To: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || '+14155238886'}`,
      Body: text,
      NumMedia: '0',
      ...(replyTo ? { OriginalRepliedMessageSid: replyTo } : {}),
    };

const signedUrl = `${String(publicBase).replace(/\/+$/, '')}${path}${query}`;
const signature = badSignature
  ? 'deadbeefdeadbeefdeadbeefdeadbeef'
  : computeSignature(signedUrl, params, authToken);

const res = await fetch(`${String(target).replace(/\/+$/, '')}${path}${query}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    'x-twilio-signature': signature,
  },
  body: new URLSearchParams(params).toString(),
});

const body = await res.text().catch(() => '');
console.log(`  signed as : ${signedUrl}`);
console.log(`  sent to   : ${target}${path}${query}`);
console.log(`  MessageSid: ${sid}`);
console.log(`  response  : ${res.status}${body ? ` ${body.slice(0, 200)}` : ''}`);

if (res.status === 403) {
  console.log('\n  403 means the signature did not match. Almost always this is');
  console.log('  --public-base not matching the deployment\'s ROCKY_PUBLIC_BASE_URL exactly.');
}
process.exit(res.status === 204 || res.status === 200 ? 0 : 1);
