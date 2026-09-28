import crypto from 'node:crypto';
import { createTenantAgentClient } from './tenant-cli/client.mjs';

export const AGENT_MCP_PATH = '/internal/agent/mcp';
const PROTOCOL_VERSION = '2025-06-18';

/**
 * Rocky's own tools, exposed to the tenant's agent over MCP.
 *
 * Composio serves external SaaS. These are Rocky's control plane — "what do I
 * have connected", "start connecting one" — which no external provider can
 * offer because none of them knows Rocky exists. Handing the model tools is what
 * lets any phrasing work; matching "connect calendar" by regex only ever
 * matched the phrasing we guessed.
 *
 * Every tool runs under the tenant's `agent` grant, so the scope here cannot
 * exceed what `agentActions` permits no matter what the model asks for.
 */
export const AGENT_TOOLS = [
  {
    name: 'start_new_session',
    description:
      'Start a fresh conversation for this user: the next message begins with no history from ' +
      'the current one. The earlier conversation is kept and stays searchable. Use this when the ' +
      'user asks for a new session, a clean slate, or to start over. This is the ONLY way to do ' +
      'it — delegating to a subagent does not clear the user\'s conversation.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (client) => (await client.session().new()).result,
  },
  {
    name: 'list_scheduled_jobs',
    description:
      'List this user\'s scheduled jobs (recurring reminders, digests, checks). Call this before '
      + 'saying whether something is scheduled, and to find the id of a job they want stopped.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (client) => (await client.cron().list()).result,
  },
  {
    name: 'schedule_job',
    description:
      'Schedule work to run later for this user, once or repeatedly. Use this whenever they ask '
      + 'to be reminded, to get something regularly, or for anything to happen at a time or on a '
      + 'schedule. Give exactly one of cron, every or at. The message is the instruction you will '
      + 'be given when it runs, so write it as a complete instruction to yourself, not a note. '
      + 'The result is delivered to this user automatically — do not also promise to message them.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short label, e.g. "morning brief"' },
        message: { type: 'string', description: 'The instruction to run when it fires' },
        cron: { type: 'string', description: '5-field cron expression, e.g. "0 9 * * 1-5"' },
        every: { type: 'string', description: 'Repeat interval, e.g. "15m", "2h", "1d"' },
        at: { type: 'string', description: 'One-shot time: ISO with offset, or "+30m"' },
        tz: { type: 'string', description: 'IANA timezone, e.g. "Asia/Kolkata"' },
      },
      required: ['name', 'message'],
      additionalProperties: false,
    },
    run: async (client, args) => (await client.cron().create({
      name: String(args.name),
      message: String(args.message),
      cron: args.cron ? String(args.cron) : null,
      every: args.every ? String(args.every) : null,
      at: args.at ? String(args.at) : null,
      tz: args.tz ? String(args.tz) : null,
    })).result,
  },
  {
    name: 'cancel_scheduled_job',
    description:
      'Stop one of this user\'s scheduled jobs. Use list_scheduled_jobs first to get the id — '
      + 'never guess one.',
    inputSchema: {
      type: 'object',
      properties: { job: { type: 'string', description: 'The job id from list_scheduled_jobs' } },
      required: ['job'],
      additionalProperties: false,
    },
    run: async (client, args) => (await client.cron().remove(String(args.job))).result,
  },
  {
    name: 'place_call',
    description:
      'Place a phone call to THIS user and hold a spoken conversation, then report what was '
      + 'said. Use it only when they ask to be called. You cannot choose who is called: it '
      + 'always rings this user\'s own registered number. Say plainly that you are an AI '
      + 'assistant when the call connects.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'What to say on the call and what to find out',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    run: async (client, args) => (await client.voice().call(String(args.task))).result,
  },
  {
    name: 'list_connected_accounts',
    description:
      'List the external accounts (email, calendar, tasks) currently connected for this user, ' +
      'and whether each is active. Call this before claiming something is or is not connected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (client) => (await client.mcp().list()).result,
  },
  {
    name: 'list_available_toolkits',
    description:
      'List the external services this user is permitted to connect, whether or not they have ' +
      'connected them yet.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (client) => (await client.mcp().available()).result,
  },
  {
    name: 'connection_status',
    description: 'Check whether one named service is connected for this user.',
    inputSchema: {
      type: 'object',
      properties: { toolkit: { type: 'string', description: 'e.g. gmail, outlook, googlecalendar, googledrive, asana, linear' } },
      required: ['toolkit'],
      additionalProperties: false,
    },
    run: async (client, args) => (await client.mcp().status(String(args.toolkit))).result,
  },
  {
    name: 'connect_account',
    description:
      'Start connecting an external service for this user. Returns an authorisation link that ' +
      'you must give them verbatim — they open it themselves. Use this whenever they ask to ' +
      'connect, link, hook up or authorise a service, however they phrase it.',
    inputSchema: {
      type: 'object',
      properties: { toolkit: { type: 'string', description: 'e.g. gmail, outlook, googlecalendar, googledrive, asana, linear' } },
      required: ['toolkit'],
      additionalProperties: false,
    },
    run: async (client, args) => (await client.mcp().connect(String(args.toolkit))).result,
  },
  {
    name: 'send_file_to_user',
    description:
      'Send a file from your workspace to the user on WhatsApp — a document you generated, ' +
      'a report, a spreadsheet. Give the path relative to your workspace. Use this instead of ' +
      'describing a document you cannot deliver; if it fails, say so plainly.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path, e.g. "nda-draft.docx"' },
        caption: { type: 'string', description: 'Optional one-line message sent with the file' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    needs: ['channel', 'recipient'],
    run: async (_client, args, ctx) => {
      if (!ctx?.channel || typeof ctx.channel.sendMedia !== 'function') {
        throw new Error('This channel cannot send files.');
      }
      if (!ctx?.recipient) throw new Error('No recipient is associated with this conversation.');

      const { mediaLinkFor, resolveWorkspaceFile } = await import('./media-host.mjs');
      const fsp = await import('node:fs/promises');

      // Fail here rather than letting Twilio fetch a 404 and report a code the
      // model cannot interpret.
      const { target, relPath } = resolveWorkspaceFile(ctx.tenantId, String(args.path));
      await fsp.stat(target);

      const { deliverableBy } = await import('./outbox.mjs');
      const check = deliverableBy(ctx.channel, relPath);
      if (!check.ok) {
        throw new Error(
          `WhatsApp does not accept ${check.type}, so this file cannot be delivered. `
          + 'Convert it to PDF and send that instead. Do not tell the user it was sent.',
        );
      }

      const { url, expiresAt } = mediaLinkFor(ctx.tenantId, relPath);
      const receipt = await ctx.channel.sendMedia(ctx.recipient, url, {
        caption: String(args.caption || ''),
        tenantId: ctx.tenantId,
      });
      if (!receipt?.ok) {
        throw new Error(`WhatsApp refused the file (${receipt?.errorCode || 'unknown'}).`);
      }
      return { sent: true, file: relPath, expiresAt: new Date(expiresAt).toISOString() };
    },
  },
];

const BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

function publicTool({ name, description, inputSchema }) {
  return { name, description, inputSchema };
}

/**
 * Tools that deliver to the user need the live channel and the address the
 * turn is bound to. They are supplied by the caller, never by the model, so a
 * model cannot redirect a file to an address of its choosing.
 */
let deliveryContext = { channel: null, recipientFor: () => null };

export function configureAgentDelivery({ channel, recipientFor }) {
  deliveryContext = { channel, recipientFor: recipientFor || (() => null) };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Constant-time compare so a wrong token cannot be discovered by timing.
 */
export function tokenMatches(presented, expected) {
  const a = Buffer.from(String(presented || ''));
  const b = Buffer.from(String(expected || ''));
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function bearerToken(authorization) {
  const raw = String(authorization || '');
  return raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
}

/**
 * Handle one JSON-RPC message. `resolveTenant` maps a bearer token to a tenant
 * id, so a container can only ever act as the tenant it was issued for.
 *
 * @returns {Promise<{status:number, body:object|null}>}
 */
export async function handleAgentMcpRequest({ message, authorization, resolveTenant }) {
  const tenantId = await resolveTenant(bearerToken(authorization));
  if (!tenantId) return { status: 401, body: { error: 'unauthorized' } };

  const { id = null, method } = message || {};

  // Notifications carry no id and expect no response body.
  if (method === 'notifications/initialized') return { status: 202, body: null };

  if (method === 'initialize') {
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'rocky-agent', version: '1' },
      }),
    };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: AGENT_TOOLS.map(publicTool) }) };
  }

  if (method === 'tools/call') {
    const name = message?.params?.name;
    const tool = BY_NAME.get(name);
    if (!tool) return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name}`) };

    const client = createTenantAgentClient({ tenantId });
    try {
      const out = await tool.run(client, message?.params?.arguments || {}, {
        tenantId,
        channel: deliveryContext.channel,
        recipient: deliveryContext.recipientFor(tenantId),
      });
      return {
        status: 200,
        body: rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(out) }] }),
      };
    } catch (err) {
      // A refused capability or an upstream failure is a tool result, not a
      // transport error: the model should read it and tell the user.
      return {
        status: 200,
        body: rpcResult(id, {
          isError: true,
          content: [{ type: 'text', text: String(err?.message || err).slice(0, 400) }],
        }),
      };
    }
  }

  return { status: 200, body: rpcError(id, -32601, `Unsupported method: ${method}`) };
}
