/**
 * Drop-in replacement for @anthropic-ai/claude-agent-sdk using OpenAI.
 * Exports the same function signatures (tool, createSdkMcpServer, query)
 * so existing call sites change only their import path.
 */
import OpenAI from "openai";
import { z } from "zod";

// ---------- Types ----------------------------------------------------------

export interface BoopTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  handler: (args: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

/** Replaces McpSdkServerConfigWithInstance from the Claude SDK. */
export interface ToolServer {
  name: string;
  tools: BoopTool[];
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown };

export type AgentMessage =
  | { type: "assistant"; message: { content: ContentBlock[] } }
  | { type: "user"; message: { content: [{ type: "tool_result"; content: string }] } }
  | { type: "result"; _usage: OpenAI.Completions.CompletionUsage | null; _model: string };

// ---------- Zod → JSON Schema (handles all schemas used in this codebase) --

function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const desc = schema.description;
  const withDesc = (s: Record<string, unknown>) => (desc ? { ...s, description: desc } : s);

  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(schema.shape)) {
      const val = value as z.ZodTypeAny;
      const isOptional = val instanceof z.ZodOptional || val instanceof z.ZodDefault;
      properties[key] = zodToJsonSchema(val);
      if (!isOptional) required.push(key);
    }
    return withDesc({
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
    });
  }
  if (schema instanceof z.ZodString) return withDesc({ type: "string" });
  if (schema instanceof z.ZodNumber) return withDesc({ type: "number" });
  if (schema instanceof z.ZodBoolean) return withDesc({ type: "boolean" });
  if (schema instanceof z.ZodArray) {
    return withDesc({ type: "array", items: zodToJsonSchema(schema.element) });
  }
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema._def.innerType);
  if (schema instanceof z.ZodEnum) return withDesc({ type: "string", enum: schema.options });
  if (schema instanceof z.ZodNativeEnum) {
    return withDesc({ type: "string", enum: Object.values(schema.enum) });
  }
  if (schema instanceof z.ZodUnion) {
    return withDesc({ anyOf: (schema.options as z.ZodTypeAny[]).map(zodToJsonSchema) });
  }
  if (schema instanceof z.ZodLiteral) {
    return withDesc({ type: typeof schema.value, const: schema.value });
  }
  return {}; // fallback for any unhandled type
}

// ---------- Public API — same signatures as @anthropic-ai/claude-agent-sdk -

/**
 * Define a tool. Same signature as the Claude SDK's tool().
 * The handler return value is { content: [{type:"text", text:"..."}] }.
 */
export function tool<T extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: T,
  handler: (args: z.infer<z.ZodObject<T>>) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
): BoopTool {
  const zodObj = z.object(schema);
  return {
    name,
    description,
    parameters: zodToJsonSchema(zodObj),
    handler: handler as BoopTool["handler"],
  };
}

/**
 * Group tools into a named server. Same signature as createSdkMcpServer().
 * (version is accepted but ignored — kept for API compat.)
 */
export function createSdkMcpServer(opts: {
  name: string;
  version: string;
  tools: BoopTool[];
}): ToolServer {
  return { name: opts.name, tools: opts.tools };
}

// Re-export type alias for consumers that import it from the old SDK path
export type McpSdkServerConfigWithInstance = ToolServer;

// ---------- OpenAI client (lazy singleton) ----------------------------------

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("[agent-runtime] OPENAI_API_KEY is not set");
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

function toOpenAITool(t: BoopTool): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
    },
  };
}

function extractText(
  content: Array<{ type: string; text?: string }> | string | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("");
}

// ---------- query() — replaces the Claude SDK's agentic loop ---------------

export interface QueryOptions {
  systemPrompt?: string;
  model: string;
  mcpServers?: Record<string, ToolServer>;
  // Accepted but ignored (Claude-specific):
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  settingSources?: string[];
  abortController?: AbortController;
}

/**
 * Agentic loop compatible with the Claude SDK's query() iterator.
 * Emits assistant / user / result messages in the same shape.
 */
export async function* query(opts: {
  prompt: string;
  options: QueryOptions;
}): AsyncGenerator<AgentMessage> {
  const client = getClient();
  const { prompt, options } = opts;

  // Flatten all tools from all servers
  const toolMap = new Map<string, BoopTool>();
  for (const server of Object.values(options.mcpServers ?? {})) {
    for (const t of server.tools) toolMap.set(t.name, t);
  }
  const openAiTools = [...toolMap.values()].map(toOpenAITool);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...(options.systemPrompt
      ? [{ role: "system" as const, content: options.systemPrompt }]
      : []),
    { role: "user" as const, content: prompt },
  ];

  let totalUsage: OpenAI.Completions.CompletionUsage | null = null;

  while (true) {
    const response = await client.chat.completions.create(
      {
        model: options.model,
        messages,
        ...(openAiTools.length
          ? { tools: openAiTools, tool_choice: "auto" }
          : {}),
      },
      { signal: options.abortController?.signal },
    );

    // Accumulate usage across turns
    if (response.usage) {
      totalUsage = totalUsage
        ? {
            prompt_tokens: totalUsage.prompt_tokens + response.usage.prompt_tokens,
            completion_tokens: totalUsage.completion_tokens + response.usage.completion_tokens,
            total_tokens: totalUsage.total_tokens + response.usage.total_tokens,
            prompt_tokens_details: response.usage.prompt_tokens_details,
          }
        : response.usage;
    }

    const choice = response.choices[0];
    const msg = choice.message;
    messages.push(msg);

    // Build content blocks for the assistant event
    const contentBlocks: ContentBlock[] = [];
    if (msg.content) {
      contentBlocks.push({ type: "text", text: msg.content });
    }
    const fnToolCalls = (msg.tool_calls ?? []).filter(
      (tc): tc is typeof tc & { type: "function"; function: { name: string; arguments: string } } =>
        tc.type === "function",
    );
    if (fnToolCalls.length) {
      for (const tc of fnToolCalls) {
        let parsedInput: unknown = {};
        try {
          parsedInput = JSON.parse(tc.function.arguments || "{}");
        } catch {
          parsedInput = {};
        }
        contentBlocks.push({
          type: "tool_use",
          name: tc.function.name,
          input: parsedInput,
        });
      }
    }

    if (contentBlocks.length) {
      yield { type: "assistant", message: { content: contentBlocks } };
    }

    // Execute tool calls
    if (fnToolCalls.length) {
      for (const tc of fnToolCalls) {
        const toolDef = toolMap.get(tc.function.name);
        let resultText: string;

        try {
          let args: unknown = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            args = {};
          }
          if (toolDef) {
            const res = await toolDef.handler(args);
            resultText = extractText(res.content);
          } else {
            resultText = `{"error": "unknown tool: ${tc.function.name}"}`;
          }
        } catch (err) {
          resultText = `{"error": ${JSON.stringify(String(err))}}`;
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: resultText,
        });

        yield {
          type: "user",
          message: { content: [{ type: "tool_result", content: resultText }] },
        };
      }
    }

    if (choice.finish_reason === "stop" || !fnToolCalls.length) {
      yield { type: "result", _usage: totalUsage, _model: options.model };
      break;
    }
  }
}
