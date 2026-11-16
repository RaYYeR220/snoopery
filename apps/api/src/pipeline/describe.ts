import { z } from 'zod';
import type { ObjectDescription } from './context';

const schema = z.object({
  label: z.string().min(2).max(60),
  category: z.string().min(2).max(30),
  parts: z
    .array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/), joint: z.enum(['revolute', 'prismatic']) }))
    .min(1)
    .max(4),
  motionPrompt: z.string().min(20).max(400),
});

const SYSTEM = `You look at one photo of a piece of furniture or a household object and describe how it opens.
Return JSON only: {"label": string, "category": string, "parts": [{"name": string, "joint": "revolute"|"prismatic"}], "motionPrompt": string}.
- label: a short human name with material and type, e.g. "Oak three-drawer dresser".
- category: one lowercase word, e.g. dresser, nightstand, wardrobe, chest, box, cabinet, desk, safe.
- parts: 1 to 4 parts that clearly open in the photo. Drawers slide (prismatic). Doors, lids and flaps hinge (revolute). snake_case names that say which one, e.g. top_drawer, left_door, lid.
- motionPrompt: instructions for a 3D articulation tool, in this style: "Keep the cabinet body fixed. The top drawer slides straight out about 30 cm and back. The left door swings open about 100 degrees on its left-edge hinge and closes." Mention every listed part, its hinge edge or slide direction, and a realistic travel.
If nothing in the photo opens, pick the single most plausible opening part.`;

export interface VisionLLM {
  (messages: unknown[], maxTokens: number): Promise<string>;
}

export function veniceVision(apiKey: string, model = 'qwen3-vl-235b-a22b'): VisionLLM {
  return async (messages, maxTokens) => {
    const res = await fetch('https://api.venice.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        venice_parameters: { include_venice_system_prompt: false },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`vision model HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { choices: { message: { content: string } }[] };
    return j.choices[0]?.message.content ?? '';
  };
}

function firstJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model reply');
  return JSON.parse(text.slice(start, end + 1));
}

/** Photo → what opens and how, plus the articulation prompt. Two attempts, then a clear error. */
export async function describeObject(llm: VisionLLM, photoUrl: string, hint?: string): Promise<ObjectDescription> {
  const messages: unknown[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: hint ? `Owner's note: ${hint}` : 'Describe this object.' },
        { type: 'image_url', image_url: { url: photoUrl } },
      ],
    },
  ];
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await llm(messages, 500);
    try {
      return schema.parse(firstJson(reply));
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      messages.push({ role: 'assistant', content: reply }, { role: 'user', content: `That reply was invalid (${lastError.slice(0, 300)}). Return only the corrected JSON.` });
    }
  }
  throw new Error(`could not describe the object: ${lastError.slice(0, 200)}`);
}
