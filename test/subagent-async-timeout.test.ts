/**
 * Empirical test for the async-subagent timeout claim in commit 2169410.
 *
 * Schema text (since that commit) claims:
 *   "Sync tasks default to 600s (auto-detaches to background).
 *    Async tasks have no default timeout."
 *
 * Rather than routing through a mock LLM (the plain text it emits leaves the
 * ephemeral agent stuck in `streaming` state because `subagent--return` is
 * never called, so `runEphemeralToCompletion` only resolves on a fallback
 * event), we stub `runEphemeralToCompletion` directly with a promise that
 * just sleeps for `subagentRunMs`. That's the smallest faithful surrogate for
 * "the subagent's LLM call is long-running" and it keeps the test focused on
 * SubagentModule's timeout wiring.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule } from '../src/modules/subagent-module.js';

async function makeHarness(opts: { maxExecutionMs: number; subagentRunMs: number; maxConcurrent?: number }) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-timeout-'));
  const adapter = new MockAdapter({ defaultResponse: 'ok' });
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
  const subagent = new SubagentModule({
    parentAgentName: 'parent',
    defaultModel: 'mock',
    defaultMaxTokens: 256,
    maxExecutionMs: opts.maxExecutionMs,
    maxConcurrent: opts.maxConcurrent,
    maxRetries: 0, // don't let retries mask the timeout result
  });
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane,
    agents: [{
      name: 'parent',
      model: 'mock',
      systemPrompt: 'parent',
      maxTokens: 256,
    }],
    modules: [subagent as unknown as Module],
  });

  // Stub runEphemeralToCompletion: pretend the subagent's LLM work takes
  // `subagentRunMs` to finish, then resolves like a normal completion.
  // This isolates SubagentModule's timeout wiring from the agent state
  // machine / membrane streaming machinery.
  const fw = framework as unknown as {
    runEphemeralToCompletion: (
      agent: unknown,
      ctxMgr: unknown,
    ) => Promise<{ speech: string; toolCallsCount: number }>;
    agents: Map<string, unknown>;
  };
  fw.runEphemeralToCompletion = (agent: unknown) => {
    // Register ephemeral agent into the framework's agents map the way the
    // real implementation does, so any downstream dispatch still works.
    const a = agent as { name: string };
    fw.agents.set(a.name, agent);
    return new Promise((resolve) => {
      setTimeout(() => {
        fw.agents.delete(a.name);
        resolve({ speech: 'ok', toolCallsCount: 0 });
      }, opts.subagentRunMs);
    });
  };

  subagent.setFramework(framework);
  framework.start();

  return {
    framework,
    subagent,
    cleanup: async () => {
      try { await framework.stop(); } catch { /* noop */ }
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    },
  };
}

function makeToolCall(name: string, input: Record<string, unknown>): ToolCall {
  return {
    id: `test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    input,
    callerAgentName: 'parent',
  };
}

type InternalSubagent = SubagentModule & {
  asyncHandles: Map<string, { promise: Promise<unknown> }>;
};

/**
 * Harness variant focused on the maxTokens cascade.
 *
 * Intercepts `createEphemeralAgent` so we can observe what budget the module
 * actually asked for, and short-circuits `runEphemeralToCompletion` so the
 * promise settles immediately — we only care about the ephemeral config.
 */
async function makeBudgetHarness(opts: {
  parentMaxTokens: number;
  moduleDefaultMaxTokens?: number;
  moduleDefaultModel?: string;
  allowedModels?: string[];
}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-budget-'));
  const adapter = new MockAdapter({ defaultResponse: 'ok' });
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
  const subagent = new SubagentModule({
    parentAgentName: 'parent',
    defaultModel: opts.moduleDefaultModel ?? 'mock',
    allowedModels: opts.allowedModels,
    defaultMaxTokens: opts.moduleDefaultMaxTokens,
    maxRetries: 0,
  });
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane,
    agents: [{
      name: 'parent',
      model: 'mock',
      systemPrompt: 'parent',
      maxTokens: opts.parentMaxTokens,
    }],
    modules: [subagent as unknown as Module],
  });

  const captured: Array<{ name: string; model: string; maxTokens: number }> = [];
  const fw = framework as unknown as {
    createEphemeralAgent: (config: { name: string; model: string; maxTokens: number; [k: string]: unknown }) => Promise<{
      agent: { name: string; maxTokens: number };
      contextManager: { addMessage: (...a: unknown[]) => void; compile: () => Promise<{ messages: unknown[] }> };
      cleanup: () => void;
    }>;
    runEphemeralToCompletion: (agent: unknown, cm: unknown) => Promise<{ speech: string; toolCallsCount: number }>;
    getAllTools: () => Array<{ name: string }>;
    agents: Map<string, unknown>;
  };
  const originalCreate = fw.createEphemeralAgent.bind(fw);
  fw.createEphemeralAgent = async (config) => {
    captured.push({ name: config.name, model: config.model, maxTokens: config.maxTokens });
    return originalCreate(config);
  };
  fw.runEphemeralToCompletion = (agent: unknown) => {
    const a = agent as { name: string };
    fw.agents.set(a.name, agent);
    return new Promise((resolve) => setTimeout(() => {
      fw.agents.delete(a.name);
      resolve({ speech: 'ok', toolCallsCount: 0 });
    }, 20));
  };

  subagent.setFramework(framework);
  framework.start();

  return {
    framework,
    subagent,
    captured,
    cleanup: async () => {
      try { await framework.stop(); } catch { /* noop */ }
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    },
  };
}

describe('SubagentModule timeout behaviour (async vs sync default)', () => {
  test('accepted async work waits for a free slot and reports its queue position', async () => {
    const { subagent, cleanup } = await makeHarness({
      maxExecutionMs: 1_000,
      subagentRunMs: 150,
      maxConcurrent: 1,
    });
    try {
      const first = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'slot-holder',
        systemPrompt: 'you are a test subagent',
        task: 'hold the only slot briefly',
      }));
      expect(first.success).toBe(true);

      const second = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'queued-worker',
        systemPrompt: 'you are a test subagent',
        task: 'run when the slot is free',
        timeoutMs: 500,
      }));
      expect(second.success).toBe(true);
      const receipt = typeof second.data === 'string' ? second.data : JSON.stringify(second.data);
      expect(receipt).toMatch(/queued at position 1/i);
      expect(receipt).toMatch(/no admission timeout/i);

      const handles = (subagent as unknown as InternalSubagent).asyncHandles;
      const firstHandle = handles.get('slot-holder');
      const secondHandle = handles.get('queued-worker');
      expect(firstHandle).toBeDefined();
      expect(secondHandle).toBeDefined();

      await expect(firstHandle!.promise).resolves.toMatchObject({ summary: 'ok' });
      await expect(secondHandle!.promise).resolves.toMatchObject({
        summary: expect.stringMatching(/Concurrency notice: this agent waited/),
      });
    } finally {
      await cleanup();
    }
  }, 10_000);

  test('ASYNC spawn, no explicit timeoutMs, subagent runs longer than maxExecutionMs', async () => {
    const MAX_EXEC = 1_000;
    const SUBAGENT_WORK = 3_000;
    const { subagent, cleanup } = await makeHarness({
      maxExecutionMs: MAX_EXEC,
      subagentRunMs: SUBAGENT_WORK,
    });
    try {
      const t0 = Date.now();
      const ack = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'async-slowpoke',
        systemPrompt: 'you are a test subagent',
        task: 'reply',
        // sync: false (default), timeoutMs: undefined
      }));
      expect(ack.success).toBe(true);
      const ackElapsed = Date.now() - t0;
      expect(ackElapsed).toBeLessThan(500); // truly returned early
      const ackText = typeof ack.data === 'string' ? ack.data : JSON.stringify(ack.data);
      expect(ackText).toMatch(/background/i);

      const handles = (subagent as unknown as InternalSubagent).asyncHandles;
      const handle = handles.get('async-slowpoke');
      expect(handle).toBeDefined();

      const settled = await handle!.promise.then(
        r => ({ ok: true as const, r }),
        e => ({ ok: false as const, e: e as Error }),
      );
      const elapsed = Date.now() - t0;
      console.log(
        `[async-no-timeout] settled=${settled.ok ? 'ok' : 'error'} ` +
        `elapsed=${elapsed}ms ` +
        (settled.ok ? '' : `err=${settled.e.message}`),
      );

      // Schema claim: "Async tasks have no default timeout."
      // If the claim holds → settled.ok === true, elapsed ≈ SUBAGENT_WORK (~3s).
      // If the claim is wrong → settled.ok === false, err "timed out after 1000ms".
      expect(settled.ok).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(SUBAGENT_WORK - 200);
    } finally {
      await cleanup();
    }
  }, 15_000);

  test('SYNC spawn, no explicit timeoutMs: hard timeout fires at maxExecutionMs', async () => {
    const MAX_EXEC = 1_000;
    const SUBAGENT_WORK = 3_000;
    const { subagent, cleanup } = await makeHarness({
      maxExecutionMs: MAX_EXEC,
      subagentRunMs: SUBAGENT_WORK,
    });
    try {
      const t0 = Date.now();
      const res = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'sync-slowpoke',
        systemPrompt: 'you are a test subagent',
        task: 'reply',
        sync: true,
      }));
      const elapsed = Date.now() - t0;
      console.log(
        `[sync-default] success=${res.success} elapsed=${elapsed}ms ` +
        `data=${typeof res.data === 'string' ? res.data : JSON.stringify(res.data)} ` +
        `error=${res.error ?? '—'}`,
      );

      // Current (post-2169410) code: sync path arms withTimeout at maxExecutionMs
      // and the auto-detach timer is gated on input.timeoutMs being explicit.
      // Expected observation: error "timed out after 1000ms", NOT a "moved to
      // background" ack — contradicting the schema's "auto-detaches" promise.
      expect(res.success).toBe(false);
      expect(res.error ?? '').toMatch(/timed out/i);
      expect(elapsed).toBeLessThan(SUBAGENT_WORK);
    } finally {
      await cleanup();
    }
  }, 10_000);

  test('SYNC spawn WITH explicit timeoutMs shorter than work: auto-detach vs hard-timeout race', async () => {
    // Both `timeoutMs` parameters in handleSpawn resolve to the same value
    // when input.timeoutMs is explicit — so withTimeout (reject) and
    // autoDetachMs (detach→ack) race at the same deadline. This test
    // documents which side wins in practice.
    const { subagent, cleanup } = await makeHarness({
      maxExecutionMs: 60_000, // large, so input.timeoutMs is what matters
      subagentRunMs: 3_000,
    });
    try {
      const t0 = Date.now();
      const res = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'sync-explicit',
        systemPrompt: 'you are a test subagent',
        task: 'reply',
        sync: true,
        timeoutMs: 500,
      }));
      const elapsed = Date.now() - t0;
      console.log(
        `[sync-explicit-race] success=${res.success} elapsed=${elapsed}ms ` +
        `data=${typeof res.data === 'string' ? res.data : JSON.stringify(res.data)} ` +
        `error=${res.error ?? '—'}`,
      );
      // Observation recorded below by the assertion the implementation actually
      // passes — we intentionally don't enforce which side wins, because that's
      // exactly the undefined-behaviour question we're investigating.
      expect(elapsed).toBeLessThan(2_500);
      // The orphaned subagent promise will itself hard-timeout shortly after;
      // wait for its deliverAsyncError to flush so shutdown doesn't race a
      // "Queue is closed" push. (A small but interesting latent bug: when
      // autoDetachMs == hard timeout, the post-detach promise rejection
      // arrives after the parent has already moved on.)
      await new Promise(r => setTimeout(r, 300));
    } finally {
      await cleanup();
    }
  }, 10_000);
});

describe('SubagentModule maxTokens cascade', () => {
  test('SPAWN inherits parent.maxTokens when no per-call and no module default', async () => {
    const { subagent, captured, cleanup } = await makeBudgetHarness({
      parentMaxTokens: 12_345,
      // moduleDefaultMaxTokens intentionally omitted
    });
    try {
      const res = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'inherit-spawn',
        systemPrompt: 'sp',
        task: 'reply',
        sync: true,
      }));
      expect(res.success).toBe(true);
      expect(captured.length).toBe(1);
      expect(captured[0].maxTokens).toBe(12_345);
    } finally {
      await cleanup();
    }
  }, 10_000);

  test('FORK inherits parent.maxTokens when no per-call and no module default', async () => {
    const { subagent, captured, cleanup } = await makeBudgetHarness({
      parentMaxTokens: 12_345,
    });
    try {
      const res = await subagent.handleToolCall(makeToolCall('fork', {
        name: 'inherit-fork',
        task: 'reply',
        sync: true,
      }));
      expect(res.success).toBe(true);
      expect(captured.length).toBe(1);
      expect(captured[0].maxTokens).toBe(12_345);
    } finally {
      await cleanup();
    }
  }, 10_000);

  test('per-call maxTokens wins over recipe default and parent', async () => {
    const { subagent, captured, cleanup } = await makeBudgetHarness({
      parentMaxTokens: 12_345,
      moduleDefaultMaxTokens: 8_000,
    });
    try {
      // spawn side
      const resSpawn = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'override-spawn',
        systemPrompt: 'sp',
        task: 'reply',
        maxTokens: 3_333,
        sync: true,
      }));
      expect(resSpawn.success).toBe(true);

      // fork side
      const resFork = await subagent.handleToolCall(makeToolCall('fork', {
        name: 'override-fork',
        task: 'reply',
        maxTokens: 4_444,
        sync: true,
      }));
      expect(resFork.success).toBe(true);

      expect(captured.length).toBe(2);
      expect(captured[0].maxTokens).toBe(3_333);
      expect(captured[1].maxTokens).toBe(4_444);
    } finally {
      await cleanup();
    }
  }, 10_000);

  test('recipe-level defaultMaxTokens wins over parent.maxTokens', async () => {
    const { subagent, captured, cleanup } = await makeBudgetHarness({
      parentMaxTokens: 12_345,
      moduleDefaultMaxTokens: 8_000,
    });
    try {
      const res = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'recipe-default',
        systemPrompt: 'sp',
        task: 'reply',
        sync: true,
      }));
      expect(res.success).toBe(true);
      expect(captured.length).toBe(1);
      expect(captured[0].maxTokens).toBe(8_000);
    } finally {
      await cleanup();
    }
  }, 10_000);

  test('model policy is visible in schemas and rejects models outside the allowlist', async () => {
    const allowedModels = ['haiku-test', 'sonnet-test', 'opus-test'];
    const subagent = new SubagentModule({
      defaultModel: 'sonnet-test',
      allowedModels,
      defaultMaxTokens: 8_192,
    });

    for (const toolName of ['spawn', 'fork']) {
      const tool = subagent.getTools().find((candidate) => candidate.name === toolName);
      const modelSchema = (tool?.inputSchema.properties as Record<string, Record<string, unknown>>).model;
      expect(modelSchema.enum).toEqual(allowedModels);
      expect(String(modelSchema.description)).toContain('sonnet-test');
      expect(String(modelSchema.description)).toContain('default');
    }

    const rejected = await subagent.handleToolCall(makeToolCall('spawn', {
      name: 'too-expensive-mystery',
      systemPrompt: 'sp',
      task: 'reply',
      model: 'unknown-test',
    }));
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain('not allowed');
    expect(rejected.error).toContain('haiku-test, sonnet-test, opus-test');
  });

  test('default and explicit model choices reach the provider and appear in launch receipts', async () => {
    const allowedModels = ['haiku-test', 'sonnet-test', 'opus-test'];
    const { subagent, captured, cleanup } = await makeBudgetHarness({
      parentMaxTokens: 12_345,
      moduleDefaultModel: 'sonnet-test',
      moduleDefaultMaxTokens: 8_192,
      allowedModels,
    });
    try {
      const defaultAck = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'default-model',
        systemPrompt: 'sp',
        task: 'reply',
      }));
      expect(defaultAck.success).toBe(true);
      expect(String(defaultAck.data)).toContain('sonnet-test');
      expect(String(defaultAck.data)).toContain('8,192');
      expect(String(defaultAck.data)).toContain('Fresh context');

      const explicit = await subagent.handleToolCall(makeToolCall('fork', {
        name: 'explicit-model',
        task: 'reply',
        model: 'haiku-test',
        maxTokens: 4_096,
        sync: true,
      }));
      expect(explicit.success).toBe(true);

      const defaultHandle = (subagent as unknown as InternalSubagent).asyncHandles.get('default-model');
      await defaultHandle?.promise;

      expect(captured.map(({ model, maxTokens }) => ({ model, maxTokens }))).toEqual([
        { model: 'sonnet-test', maxTokens: 8_192 },
        { model: 'haiku-test', maxTokens: 4_096 },
      ]);
    } finally {
      await cleanup();
    }
  }, 10_000);
});
