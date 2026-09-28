#!/usr/bin/env node
/**
 * Simulate a WhatsApp inbound against the running gateway.
 * Usage: npm run mock -- +15551234567 "hello"
 * Or against in-process channel if gateway is not used — prefers HTTP.
 */
const [from, ...rest] = process.argv.slice(2);
const text = rest.join(' ');
if (!from || !text) {
  console.error('Usage: npm run mock -- <phone> <message>');
  process.exit(1);
}

const port = process.env.ROCKY_PORT || 8787;
const res = await fetch(`http://127.0.0.1:${port}/api/dev/message`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ from, text }),
});
const body = await res.json();
console.log(JSON.stringify(body, null, 2));
if (!res.ok) process.exit(1);
