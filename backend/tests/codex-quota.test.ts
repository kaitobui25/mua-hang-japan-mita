import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCodexQuota } from '../src/translation/codex-quota.js';
import { codexLaunch } from '../src/translation/codex-provider.js';
import { resolve } from 'node:path';

const now = new Date('2026-11-02T03:00:00Z');
const window = (minutes: number, usedPercent = 25) => ({ usedPercent, windowDurationMins: minutes, resetsAt: now.getTime() / 1000 + 10000 });
const quota = (primary: unknown, secondary: unknown = null) => ({ rateLimits: { limitId: 'codex', primary, secondary } });

test('Codex quota selects the 300-minute bucket, includes the 20% boundary and honors weekly exhaustion', () => {
  assert.deepEqual(assessCodexQuota(quota(window(10080), window(300, 80)), now, now), {
    allowed: true, reason: 'ready', remainingFiveHour: 20
  });
  assert.equal(assessCodexQuota(quota(window(300, 80.01)), now, now).reason, 'quota_low');
  assert.equal(assessCodexQuota(quota(window(300), window(10080, 100)), now, now).reason, 'quota_exhausted');
  assert.equal(assessCodexQuota({ rateLimits: { ...quota(window(300)).rateLimits, rateLimitReachedType: 'weekly' } }, now, now).reason, 'quota_exhausted');
});

test('unknown, stale, contradictory, wrong-bucket and malformed quotas never permit a request', () => {
  for (const payload of [undefined, null, {}, quota(window(15)), quota(window(300), window(300)),
    quota({ ...window(300), usedPercent: '25' }), quota({ ...window(300), usedPercent: NaN }),
    quota(window(300, -1)), quota(window(300, 101)), quota({ ...window(300), resetsAt: 1 }),
    quota({ ...window(300), windowDurationMins: 300.5 }),
    { rateLimits: { limitId: 'other', primary: window(300) } },
    { ...quota(window(300)), rateLimitsByLimitId: {} },
    { rateLimitsByLimitId: { other: quota(window(300)).rateLimits } }]) {
    assert.deepEqual(assessCodexQuota(payload, now, now), { allowed: false, reason: 'quota_unknown', remainingFiveHour: null });
  }
  assert.equal(assessCodexQuota(quota(window(300)), new Date(now.getTime() - 30001), now).allowed, false);
  assert.equal(assessCodexQuota(quota(window(300)), new Date(now.getTime() + 1), now).allowed, false);
  assert.equal(assessCodexQuota({ rateLimitsByLimitId: { codex: quota(window(300, 90)).rateLimits },
    ...quota(window(300, 0)) }, now, now).reason, 'quota_low', 'multi-bucket view is authoritative');
});

test('Codex launch is opt-in, shell-free and forwards no database or API credentials', () => {
  assert.throws(() => codexLaunch({}), /codex_not_verified/);
  for (const executable of ['codex', 'codex.cmd', 'C:\\tools\\codex.cmd']) {
    assert.throws(() => codexLaunch({ MITA_CODEX_AUTOMATION_VERIFIED: '1', MITA_CODEX_EXECUTABLE: executable }), /codex_executable_required/);
  }
  const launch = codexLaunch({ MITA_CODEX_AUTOMATION_VERIFIED: '1', MITA_CODEX_EXECUTABLE: resolve('synthetic', 'codex.exe'),
    USERPROFILE: 'C:\\synthetic', DATABASE_URL: 'never-forward', OPENAI_API_KEY: 'never-forward', OPENROUTER_API_KEY: 'never-forward' });
  assert.deepEqual(launch.env, { USERPROFILE: 'C:\\synthetic' });
  assert.ok(launch.args.includes('--listen'));
  assert.ok(launch.args.includes('stdio://'));
  assert.ok(!launch.args.includes('--ignore-user-config'));
  assert.ok(!launch.args.includes('--ephemeral'));
  assert.ok(launch.args.includes('features.shell_tool=false'));
});
