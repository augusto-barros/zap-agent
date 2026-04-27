import OpenAI from "openai";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { embed } from "../embeddings.js";
import { SEGMENT_DEFAULTS, makeMemoryId, type MemorySegment } from "./types.js";

const PRICING: Record<string, { input: number; output: number; cached: number }> = {
  "gpt-4.1":      { input: 2.00,  output: 8.00,  cached: 0.50 },
  "gpt-4.1-mini": { input: 0.40,  output: 1.60,  cached: 0.10 },
  "gpt-4o":       { input: 2.50,  output: 10.00, cached: 1.25 },
  "gpt-4o-mini":  { input: 0.15,  output: 0.60,  cached: 0.075 },
};

function calcCost(model: string, inp: number, out: number, cached: number): number {
  const base = Object.keys(PRICING).find((k) => model.startsWith(k)) ?? model;
  const p = PRICING[base];
  if (!p) return 0;
  return (Math.max(0, inp - cached) * p.input + out * p.output + cached * p.cached) / 1_000_000;
}

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

const EXTRACTION_PROMPT = `You are a memory-extraction subagent.

Given a user message + assistant reply, extract any DURABLE facts worth remembering.
Return STRICT JSON:
{"facts":[
  {"content":"...","segment":"identity|preference|correction|relationship|project|knowledge|context","importance":0.0-1.0,"corrects":"what was wrong, if this is a correction"}
]}

Rules:
- Prefer fewer, higher-quality facts over many trivial ones.
- Skip anything transient ("I'm tired right now"). Context facts should describe ongoing state, not momentary feelings.
- Segment meanings:
  - identity: name, role, location, core traits (highest priority — rarely changes)
  - correction: the user explicitly corrected something. "No, it's Sarah not Sara." "Actually I prefer X not Y." Set "corrects" to the wrong value or prior belief being overturned. Use this instead of preference/identity when the user is FIXING something rather than stating it fresh.
  - preference: how they like things done (style, defaults)
  - relationship: people they know + how
  - project: ongoing work or goals
  - knowledge: facts about their world
  - context: current ongoing situation
- Importance defaults: identity 0.85, correction 0.80, relationship 0.75, preference 0.70, project 0.65, knowledge 0.60, context 0.40. Bump up or down only when you have a clear reason — trust the defaults.
- The "corrects" field is ONLY for segment="correction". Omit it (or null) for everything else.
- Return empty facts array if nothing durable.

Respond with ONLY the JSON object.`;

interface ExtractedFact {
  content: string;
  segment: MemorySegment;
  importance: number;
  corrects?: string | null;
}

export async function extractAndStore(opts: {
  conversationId: string;
  userMessage: string;
  assistantReply: string;
  turnId: string;
}): Promise<void> {
  const started = Date.now();
  const model = process.env.BOOP_CHEAP_MODEL ?? process.env.BOOP_MODEL ?? "gpt-4o-mini";
  try {
    const payload = `USER: ${opts.userMessage}\n\nASSISTANT: ${opts.assistantReply}`;
    const resp = await getOpenAI().chat.completions.create({
      model,
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: payload },
      ],
    });
    const buffer = resp.choices[0]?.message?.content ?? "";
    const inputTokens = resp.usage?.prompt_tokens ?? 0;
    const outputTokens = resp.usage?.completion_tokens ?? 0;
    const cached =
      (resp.usage as { prompt_tokens_details?: { cached_tokens?: number } })
        ?.prompt_tokens_details?.cached_tokens ?? 0;
    const costUsd = calcCost(model, inputTokens, outputTokens, cached);

    if (costUsd > 0 || inputTokens > 0) {
      await convex.mutation(api.usageRecords.record, {
        source: "extract",
        conversationId: opts.conversationId,
        turnId: opts.turnId,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens: cached,
        cacheCreationTokens: 0,
        costUsd,
        durationMs: Date.now() - started,
      });
    }

    const match = buffer.match(/\{[\s\S]*\}/);
    if (!match) return;
    const parsed = JSON.parse(match[0]) as { facts?: ExtractedFact[] };
    const facts = parsed.facts ?? [];

    for (const f of facts) {
      const defaults = SEGMENT_DEFAULTS[f.segment];
      if (!defaults) continue; // skip unknown segment rather than crashing
      // Clamp importance to [0, 1]; fall back to segment default when the
      // LLM omits it or returns garbage.
      const rawImportance =
        typeof f.importance === "number" && Number.isFinite(f.importance)
          ? Math.max(0, Math.min(1, f.importance))
          : defaults.importance;
      const memoryId = makeMemoryId();
      const embedding = (await embed(f.content)) ?? undefined;
      const metadata =
        f.segment === "correction" && f.corrects
          ? JSON.stringify({ corrects: f.corrects })
          : undefined;
      await convex.mutation(api.memoryRecords.upsert, {
        memoryId,
        content: f.content,
        tier: defaults.tier,
        segment: f.segment,
        importance: rawImportance,
        decayRate: defaults.decayRate,
        sourceTurn: opts.turnId,
        embedding,
        metadata,
      });
    }

    await convex.mutation(api.memoryEvents.emit, {
      eventType: "memory.extracted",
      conversationId: opts.conversationId,
      data: JSON.stringify({ turnId: opts.turnId, count: facts.length }),
    });
  } catch (err) {
    console.error("[memory.extract] failed", err);
  }
}
