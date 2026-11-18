import { describe, expect, it } from 'vitest';
import { veniceLLM, type LLMUsage } from '../src/llm';

type Call = { url: string; init: RequestInit };

function fakeFetch(steps: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return steps[calls.length - 1]!();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = (content: string) => () =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 120, completion_tokens: 30 } }), { status: 200 });
const networkError = () => {
  throw new TypeError('fetch failed');
};

const messages = [{ role: 'user' as const, content: 'hi' }];

describe('veniceLLM', () => {
  it('posts a chat-completions request with a token cap and reports usage', async () => {
    const usage: LLMUsage[] = [];
    const { fn, calls } = fakeFetch([ok('{"a":1}')]);
    const llm = veniceLLM('qwen-3-8-flash', 'sk-test', { fetch: fn, onUsage: (u) => usage.push(u) });

    expect(await llm.complete(messages, { maxTokens: 900, json: true })).toBe('{"a":1}');
    expect(calls[0]!.url).toBe('https://api.venice.ai/api/v1/chat/completions');
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer sk-test');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      model: 'qwen-3-8-flash',
      messages,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      venice_parameters: { include_venice_system_prompt: false },
    });
    expect(usage).toEqual([{ model: 'qwen-3-8-flash', promptTokens: 120, completionTokens: 30, ms: expect.any(Number) }]);
  });

  it('omits the JSON response format for plain completions', async () => {
    const { fn, calls } = fakeFetch([ok('hello')]);
    await veniceLLM('m', 'k', { fetch: fn }).complete(messages, { maxTokens: 50, json: false });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.response_format).toBeUndefined();
    expect(body.venice_parameters.disable_thinking).toBeUndefined();
  });

  it('can switch off the reasoning pass', async () => {
    const { fn, calls } = fakeFetch([ok('{}')]);
    await veniceLLM('m', 'k', { fetch: fn, disableThinking: true }).complete(messages, { maxTokens: 50, json: true });
    expect(JSON.parse(String(calls[0]!.init.body)).venice_parameters).toEqual({
      include_venice_system_prompt: false,
      disable_thinking: true,
      strip_thinking_response: true,
    });
  });

  it('retries a network failure exactly once', async () => {
    const { fn, calls } = fakeFetch([networkError, ok('done')]);
    expect(await veniceLLM('m', 'k', { fetch: fn }).complete(messages, { maxTokens: 10, json: false })).toBe('done');
    expect(calls).toHaveLength(2);

    const twice = fakeFetch([networkError, networkError, ok('never')]);
    await expect(veniceLLM('m', 'k', { fetch: twice.fn }).complete(messages, { maxTokens: 10, json: false })).rejects.toThrow('fetch failed');
    expect(twice.calls).toHaveLength(2);
  });

  it('never retries a call the server answered or that timed out', async () => {
    const http = fakeFetch([() => new Response('overloaded', { status: 503 }), ok('never')]);
    await expect(veniceLLM('m', 'k', { fetch: http.fn }).complete(messages, { maxTokens: 10, json: false })).rejects.toMatchObject({
      name: 'LLMHttpError',
      status: 503,
      message: 'venice 503: overloaded',
    });
    expect(http.calls).toHaveLength(1);

    const timeout = fakeFetch([
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      ok('never'),
    ]);
    await expect(veniceLLM('m', 'k', { fetch: timeout.fn }).complete(messages, { maxTokens: 10, json: false })).rejects.toThrow('timeout');
    expect(timeout.calls).toHaveLength(1);
  });

  it('returns an empty string when the reply has no content', async () => {
    const { fn } = fakeFetch([() => new Response(JSON.stringify({ choices: [] }), { status: 200 })]);
    expect(await veniceLLM('m', 'k', { fetch: fn }).complete(messages, { maxTokens: 10, json: true })).toBe('');
  });
});
