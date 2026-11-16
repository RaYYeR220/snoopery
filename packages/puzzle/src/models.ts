/** Venice list prices in USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
}

export const VENICE_PRICES: Record<string, ModelPrice> = {
  'qwen-3-8-flash': { input: 0.14, output: 0.49 },
  'z-ai-glm-5-3-flash': { input: 0.15, output: 0.5 },
  'qwen3-235b-a22b-instruct-2507': { input: 0.15, output: 0.75 },
};

/** Model the room designer uses by default (picked by the eval pilot), run with its reasoning pass off. */
export const DESIGN_MODEL = 'qwen-3-8-flash';
export const DESIGN_DISABLE_THINKING = true;

export function costUsd(model: string, promptTokens: number, completionTokens: number): number {
  const price = VENICE_PRICES[model];
  if (!price) throw new Error(`no price for model ${model}`);
  return (promptTokens * price.input + completionTokens * price.output) / 1e6;
}
