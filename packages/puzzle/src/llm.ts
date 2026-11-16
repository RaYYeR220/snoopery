export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLM {
  complete(messages: ChatMessage[], opts: { maxTokens: number; json: boolean }): Promise<string>;
}

export interface LLMUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  ms: number;
}

export interface VeniceOptions {
  onUsage?: (u: LLMUsage) => void;
  timeoutMs?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Turn off the hidden reasoning pass on models that think by default (faster, far fewer output tokens). */
  disableThinking?: boolean;
}

export const VENICE_BASE_URL = 'https://api.venice.ai/api/v1';

/** The provider answered with a non-2xx status. */
export class LLMHttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`venice ${status}: ${body.slice(0, 300)}`);
    this.name = 'LLMHttpError';
    this.status = status;
  }
}

/** Venice chat completions (OpenAI-compatible). */
export function veniceLLM(model: string, apiKey: string, options: VeniceOptions = {}): LLM {
  const url = `${options.baseUrl ?? VENICE_BASE_URL}/chat/completions`;
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    async complete(messages, { maxTokens, json }) {
      const body = JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        venice_parameters: {
          include_venice_system_prompt: false,
          ...(options.disableThinking ? { disable_thinking: true, strip_thinking_response: true } : {}),
        },
      });
      const started = Date.now();
      const res = await postOnce(() =>
        send(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
      if (!res.ok) {
        throw new LLMHttpError(res.status, await res.text().catch(() => ''));
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      options.onUsage?.({
        model,
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        ms: Date.now() - started,
      });
      const content = data.choices?.[0]?.message?.content;
      return typeof content === 'string' ? content : '';
    },
  };
}

/**
 * One retry, and only when the request never got an answer because of a network failure.
 * Timeouts and HTTP errors are not retried: the provider may already have billed the call.
 */
async function postOnce(request: () => Promise<Response>): Promise<Response> {
  try {
    return await request();
  } catch (err) {
    if (err instanceof TypeError) return request();
    throw err;
  }
}
