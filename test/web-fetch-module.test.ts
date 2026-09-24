import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebFetchModule, htmlToText, isPublicIp } from '../src/modules/web-fetch-module.js';

const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];
const PRIVATE = async () => [{ address: '127.0.0.1', family: 4 }];

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

function call(module: WebFetchModule, input: unknown, name = 'fetch') {
  return module.handleToolCall({ id: 'test', name, input });
}

describe('WebFetchModule', () => {
  test('recognizes public and non-public IP ranges', () => {
    expect(isPublicIp('93.184.216.34')).toBe(true);
    expect(isPublicIp('127.0.0.1')).toBe(false);
    expect(isPublicIp('10.2.3.4')).toBe(false);
    expect(isPublicIp('169.254.169.254')).toBe(false);
    expect(isPublicIp('::1')).toBe(false);
    expect(isPublicIp('fc00::1')).toBe(false);
    expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
  });

  test('turns ordinary HTML into compact readable text', () => {
    expect(htmlToText('<h1>Hello &amp; hi</h1><script>bad()</script><p>Second&nbsp;line</p>'))
      .toBe('Hello & hi\nSecond line');
  });

  test('fetches public HTTPS text and labels it untrusted', async () => {
    const module = new WebFetchModule({}, {
      resolve: PUBLIC,
      fetch: async () => new Response('<h1>Example</h1><p>Reference</p>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    });
    const result = await call(module, { url: 'https://example.com/page' });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.text).toBe('Example\nReference');
    expect(data.notice).toContain('UNTRUSTED WEB CONTENT');
  });

  test('rejects HTTP, credentials, literal loopback, and private DNS', async () => {
    const publicModule = new WebFetchModule({}, { resolve: PUBLIC, fetch: async () => new Response('ok') });
    expect((await call(publicModule, { url: 'http://example.com' })).success).toBe(false);
    expect((await call(publicModule, { url: 'https://u:p@example.com' })).success).toBe(false);
    expect((await call(publicModule, { url: 'https://127.0.0.1' })).success).toBe(false);
    const privateModule = new WebFetchModule({}, { resolve: PRIVATE, fetch: async () => new Response('ok') });
    expect((await call(privateModule, { url: 'https://internal.example' })).success).toBe(false);
  });

  test('revalidates redirect targets and blocks a redirect to private space', async () => {
    const module = new WebFetchModule({}, {
      resolve: async (hostname) => hostname === 'public.example'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '10.0.0.8', family: 4 }],
      fetch: async () => new Response('', {
        status: 302,
        headers: { location: 'https://private.example/secret', 'content-type': 'text/plain' },
      }),
    });
    const result = await call(module, { url: 'https://public.example' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('public internet addresses');
  });

  test('caps returned characters and rejects non-text bodies', async () => {
    const textModule = new WebFetchModule({ maxOutputChars: 20 }, {
      resolve: PUBLIC,
      fetch: async () => new Response('abcdefghijklmnopqrstuvwxyz', {
        headers: { 'content-type': 'text/plain' },
      }),
    });
    const textResult = await call(textModule, { url: 'https://example.com', max_chars: 5 });
    expect((textResult.data as Record<string, unknown>).text).toBe('abcde');
    expect((textResult.data as Record<string, unknown>).truncated).toBe(true);

    const imageModule = new WebFetchModule({}, {
      resolve: PUBLIC,
      fetch: async () => new Response('png', { headers: { 'content-type': 'image/png' } }),
    });
    expect((await call(imageModule, { url: 'https://example.com/a.png' })).success).toBe(false);
  });

  test('keeps the deadline active while a response body is streaming', async () => {
    const module = new WebFetchModule({ timeoutMs: 10 }, {
      resolve: PUBLIC,
      fetch: async (_input, init) => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('started'));
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      }), { headers: { 'content-type': 'text/plain' } }),
    });
    const result = await call(module, { url: 'https://example.com/slow' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  test('downloads opaque bytes into an authorized root with provenance and no-clobber publication', async () => {
    const root = temp('web-download-root-');
    const body = new Uint8Array([0, 1, 2, 255, 17]);
    const module = new WebFetchModule({
      downloadRoots: [{ name: 'library', path: root }],
      maxDownloadBytes: 100,
    }, {
      resolve: PUBLIC,
      fetch: async () => new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': String(body.byteLength) },
      }),
    });
    await module.start({} as never);

    const result = await call(module, {
      url: 'https://example.com/source.pdf', root: 'library', path: 'incoming/source.pdf',
    }, 'download');

    expect(result.success).toBe(true);
    expect(readFileSync(join(root, 'incoming', 'source.pdf'))).toEqual(Buffer.from(body));
    const data = result.data as Record<string, unknown>;
    expect(data.destination).toBe('library/incoming/source.pdf');
    expect(data.bytes).toBe(body.byteLength);
    expect(data.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(data.notice).toContain('UNTRUSTED WEB CONTENT');

    writeFileSync(join(root, 'already.txt'), 'keep me');
    const overwrite = await call(module, {
      url: 'https://example.com/replacement', root: 'library', path: 'already.txt',
    }, 'download');
    expect(overwrite.success).toBe(false);
    expect(overwrite.error).toContain('never overwrite');
    expect(readFileSync(join(root, 'already.txt'), 'utf8')).toBe('keep me');
  });

  test('rejects path escapes, symlink parents, and excluded private subtrees', async () => {
    const root = temp('web-download-safe-root-');
    const outside = temp('web-download-outside-');
    mkdirSync(join(root, 'private'), { recursive: true });
    symlinkSync(outside, join(root, 'escape'));
    const module = new WebFetchModule({
      downloadRoots: [{ name: 'library', path: root, exclude: ['private'] }],
    }, { resolve: PUBLIC, fetch: async () => new Response('data') });
    await module.start({} as never);

    for (const path of ['../outside.txt', '/tmp/absolute.txt', 'escape/via-link.txt', 'private/secret.txt']) {
      const result = await call(module, {
        url: 'https://example.com/file', root: 'library', path,
      }, 'download');
      expect(result.success).toBe(false);
    }
    expect(() => readFileSync(join(outside, 'via-link.txt'))).toThrow();
  });

  test('fails rather than saving a truncated download when the byte cap is crossed', async () => {
    const root = temp('web-download-cap-root-');
    const module = new WebFetchModule({
      downloadRoots: [{ name: 'library', path: root }],
      maxDownloadBytes: 4,
    }, {
      resolve: PUBLIC,
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('abc'));
          controller.enqueue(new TextEncoder().encode('def'));
          controller.close();
        },
      }), { headers: { 'content-type': 'application/octet-stream' } }),
    });
    await module.start({} as never);

    const result = await call(module, {
      url: 'https://example.com/large.bin', root: 'library', path: 'large.bin',
    }, 'download');
    expect(result.success).toBe(false);
    expect(result.error).toContain('byte limit');
    expect(() => readFileSync(join(root, 'large.bin'))).toThrow();
  });
});
