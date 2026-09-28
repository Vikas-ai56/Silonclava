import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './paths.mjs';
import { OPERATOR_PHONES, LOGOUT_WEBHOOK_URL } from './config.mjs';

const OPS_DIR = path.join(ROOT, 'ops');
const ALERT_LOG = path.join(OPS_DIR, 'alerts.jsonl');

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

export function summarizeDisconnect(err, statusCode) {
  const boom = err && typeof err === 'object' ? err : null;
  const output = boom?.output || null;
  const data = boom?.data || output?.payload || null;
  const content = data?.content || data?.attrs || null;

  return {
    at: new Date().toISOString(),
    statusCode: statusCode ?? output?.statusCode ?? null,
    message: boom?.message || String(err || 'unknown'),
    isBoom: Boolean(boom?.isBoom),
    errorName: boom?.name || null,
    output: output
      ? {
          statusCode: output.statusCode,
          payload: safeJson(output.payload),
        }
      : null,
    data: safeJson(data),
    content: safeJson(content),
    // Common Baileys conflict shapes
    conflictType:
      content?.attrs?.type ||
      data?.attrs?.type ||
      (Array.isArray(content)
        ? content.find((c) => c?.attrs?.type)?.attrs?.type
        : null) ||
      null,
  };
}

export async function appendOpsAlert(type, detail) {
  await fs.mkdir(OPS_DIR, { recursive: true });
  const row = { type, ...detail };
  await fs.appendFile(ALERT_LOG, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

export async function postLogoutWebhook(detail) {
  if (!LOGOUT_WEBHOOK_URL) return false;
  try {
    const res = await fetch(LOGOUT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `Rocky WhatsApp LOGOUT ${detail.statusCode}: ${detail.message}`,
        detail,
      }),
    });
    return res.ok;
  } catch (err) {
    console.warn('[ops] logout webhook failed:', err?.message || err);
    return false;
  }
}
