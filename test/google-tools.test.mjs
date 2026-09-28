import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

describe('removed Google REST agent bypass', () => {
  it('has no agent-facing Google REST tools or intent matcher', async () => {
    await assert.rejects(fs.access('src/google/tools.mjs'), { code: 'ENOENT' });
    const agent = await fs.readFile('src/agent.mjs', 'utf8');
    const connect = await fs.readFile('src/connect.mjs', 'utf8');
    assert.doesNotMatch(agent, /Google REST|runGoogleToolIntent|matchGoogleToolIntent/);
    assert.doesNotMatch(connect, /gmailApi|calendarApi|matchGoogleToolIntent/);
  });
});
