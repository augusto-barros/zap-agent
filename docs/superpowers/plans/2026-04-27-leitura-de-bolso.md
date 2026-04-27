# Leitura de Bolso Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daily book-reading feature to the WhatsApp agent — users choose a book, set a delivery time, and receive one ~400-word excerpt per day via WhatsApp.

**Architecture:** Three new Convex tables (books, bookChunks, readingSessions) hold the catalog and per-user state. A server-side tick loop runs every 60 s and sends excerpts to users whose scheduled UTC hour matches now. Four MCP tools wire natural-language commands ("próximo", "muda para 8h") into the dispatcher.

**Tech Stack:** Convex (mutations/queries), TypeScript, Node/tsx (CLI), React + Convex React (dashboard), `sendWhatsApp` from `server/whatsapp.ts`, `createSdkMcpServer` + `tool` from `server/agent-runtime.ts`.

---

## File Map

| File | Op | Purpose |
|---|---|---|
| `convex/schema.ts` | Modify | Add `books`, `bookChunks`, `readingSessions` tables |
| `convex/books.ts` | Create | CRUD for the book catalog |
| `convex/bookChunks.ts` | Create | CRUD for pre-split chunks |
| `convex/readingSessions.ts` | Create | Per-user reading state + scheduler queries |
| `server/reading.ts` | Create | Tick loop — sends due excerpts |
| `server/reading-tools.ts` | Create | MCP server with 4 tools for the dispatcher |
| `server/index.ts` | Modify | Start `startReadingLoop()` |
| `server/interaction-agent.ts` | Modify | Register `boop-reading` MCP + system prompt block |
| `scripts/books-add.ts` | Create | CLI: chunk a `.txt` file and upload to Convex |
| `package.json` | Modify | Add `books:add` script |
| `debug/src/components/BooksPanel.tsx` | Create | Dashboard tab: list/remove books |
| `debug/src/App.tsx` | Modify | Add "Books" nav entry + panel |

---

## Task 1: Convex schema — add 3 tables

**Files:**
- Modify: `convex/schema.ts`

- [ ] **Step 1: Add the three table definitions inside `defineSchema({...})`**

Open `convex/schema.ts` and add these three tables right before the closing `});`:

```typescript
  books: defineTable({
    bookId: v.string(),
    title: v.string(),
    author: v.string(),
    language: v.string(),
    chunkCount: v.number(),
    wordCount: v.number(),
    addedAt: v.number(),
  }).index("by_book_id", ["bookId"]),

  bookChunks: defineTable({
    chunkId: v.string(),
    bookId: v.string(),
    chunkIndex: v.number(),
    content: v.string(),
    wordCount: v.number(),
  })
    .index("by_book_id", ["bookId"])
    .index("by_book_chunk", ["bookId", "chunkIndex"]),

  readingSessions: defineTable({
    conversationId: v.string(),
    bookId: v.string(),
    currentChunkIndex: v.number(),
    scheduledHour: v.number(),
    scheduledHourUtc: v.number(),
    timezone: v.string(),
    active: v.boolean(),
    startedAt: v.number(),
    lastSentAt: v.optional(v.number()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_active_hour_utc", ["active", "scheduledHourUtc"]),
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no new errors in `convex/schema.ts`.

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat: add books, bookChunks, readingSessions tables to Convex schema"
```

---

## Task 2: Convex — books.ts

**Files:**
- Create: `convex/books.ts`

- [ ] **Step 1: Create the file**

```typescript
// convex/books.ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const add = mutation({
  args: {
    bookId: v.string(),
    title: v.string(),
    author: v.string(),
    language: v.string(),
    chunkCount: v.number(),
    wordCount: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("books")
      .withIndex("by_book_id", (q) => q.eq("bookId", args.bookId))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("books", { ...args, addedAt: Date.now() });
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("books").order("desc").collect();
  },
});

export const get = query({
  args: { bookId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("books")
      .withIndex("by_book_id", (q) => q.eq("bookId", args.bookId))
      .unique();
  },
});

export const remove = mutation({
  args: { bookId: v.string() },
  handler: async (ctx, args) => {
    const book = await ctx.db
      .query("books")
      .withIndex("by_book_id", (q) => q.eq("bookId", args.bookId))
      .unique();
    if (!book) return;
    await ctx.db.delete(book._id);
    // Delete all chunks for this book
    const chunks = await ctx.db
      .query("bookChunks")
      .withIndex("by_book_id", (q) => q.eq("bookId", args.bookId))
      .collect();
    for (const chunk of chunks) {
      await ctx.db.delete(chunk._id);
    }
  },
});
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add convex/books.ts
git commit -m "feat: add Convex CRUD for books"
```

---

## Task 3: Convex — bookChunks.ts

**Files:**
- Create: `convex/bookChunks.ts`

- [ ] **Step 1: Create the file**

```typescript
// convex/bookChunks.ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Insert up to 100 chunks per call. Call repeatedly for large books.
export const addBatch = mutation({
  args: {
    chunks: v.array(
      v.object({
        chunkId: v.string(),
        bookId: v.string(),
        chunkIndex: v.number(),
        content: v.string(),
        wordCount: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (const chunk of args.chunks) {
      await ctx.db.insert("bookChunks", chunk);
    }
  },
});

export const getChunk = query({
  args: { bookId: v.string(), chunkIndex: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bookChunks")
      .withIndex("by_book_chunk", (q) =>
        q.eq("bookId", args.bookId).eq("chunkIndex", args.chunkIndex),
      )
      .unique();
  },
});
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add convex/bookChunks.ts
git commit -m "feat: add Convex CRUD for bookChunks"
```

---

## Task 4: Convex — readingSessions.ts

**Files:**
- Create: `convex/readingSessions.ts`

- [ ] **Step 1: Create the file**

```typescript
// convex/readingSessions.ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const upsert = mutation({
  args: {
    conversationId: v.string(),
    bookId: v.string(),
    currentChunkIndex: v.number(),
    scheduledHour: v.number(),
    scheduledHourUtc: v.number(),
    timezone: v.string(),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("readingSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args });
    } else {
      await ctx.db.insert("readingSessions", { ...args, startedAt: now });
    }
  },
});

export const get = query({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("readingSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
  },
});

// Returns sessions whose scheduledHourUtc matches currentHourUtc
// and that haven't been sent in the last 23 hours.
export const listDueNow = query({
  args: { scheduledHourUtc: v.number() },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - 23 * 60 * 60 * 1000;
    const sessions = await ctx.db
      .query("readingSessions")
      .withIndex("by_active_hour_utc", (q) =>
        q.eq("active", true).eq("scheduledHourUtc", args.scheduledHourUtc),
      )
      .collect();
    return sessions.filter(
      (s) => s.lastSentAt === undefined || s.lastSentAt < cutoff,
    );
  },
});

export const markSent = mutation({
  args: {
    conversationId: v.string(),
    nextChunkIndex: v.number(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("readingSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    if (!session) return;
    await ctx.db.patch(session._id, {
      currentChunkIndex: args.nextChunkIndex,
      lastSentAt: Date.now(),
    });
  },
});

export const finish = mutation({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("readingSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    if (!session) return;
    await ctx.db.patch(session._id, { active: false, lastSentAt: Date.now() });
  },
});
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add convex/readingSessions.ts
git commit -m "feat: add Convex CRUD for readingSessions"
```

---

## Task 5: Server reading scheduler (`server/reading.ts`)

**Files:**
- Create: `server/reading.ts`

- [ ] **Step 1: Create the file**

```typescript
// server/reading.ts
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { sendWhatsApp } from "./whatsapp.js";

/** Compute the UTC hour for a given local hour + IANA timezone. */
function toUtcHour(localHour: number, timezone: string): number {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: timezone,
  });
  const localNow = parseInt(formatter.format(now), 10);
  const utcNow = now.getUTCHours();
  const offset = ((utcNow - localNow) + 24) % 24;
  return (localHour + offset) % 24;
}

export { toUtcHour };

function formatChunkMessage(
  title: string,
  chunkIndex: number,
  chunkCount: number,
  content: string,
): string {
  const current = chunkIndex + 1;
  const next = current + 1;
  const footer =
    current < chunkCount
      ? `─────────────────\nAmanhã: trecho ${next}. Quer ler agora? Responda *próximo*.`
      : `─────────────────\n🎉 Você terminou "${title}"! Responda "quero ler um livro" para escolher o próximo.`;
  return `📖 *${title}* | Trecho ${current} de ${chunkCount}\n\n${content}\n\n${footer}`;
}

export async function sendNextChunk(conversationId: string): Promise<string> {
  const session = await convex.query(api.readingSessions.get, { conversationId });
  if (!session || !session.active) {
    return "Você não tem uma leitura ativa. Diga 'quero ler um livro' para começar.";
  }

  const book = await convex.query(api.books.get, { bookId: session.bookId });
  if (!book) {
    await convex.mutation(api.readingSessions.finish, { conversationId });
    return "O livro desta sessão foi removido. Diga 'quero ler um livro' para escolher outro.";
  }

  const chunk = await convex.query(api.bookChunks.getChunk, {
    bookId: session.bookId,
    chunkIndex: session.currentChunkIndex,
  });
  if (!chunk) {
    return `Não encontrei o trecho ${session.currentChunkIndex + 1} de "${book.title}".`;
  }

  const text = formatChunkMessage(book.title, session.currentChunkIndex, book.chunkCount, chunk.content);
  const toNumber = conversationId.slice(3); // strip "wa:"
  await sendWhatsApp(toNumber, text);

  const nextIndex = session.currentChunkIndex + 1;
  if (nextIndex >= book.chunkCount) {
    await convex.mutation(api.readingSessions.finish, { conversationId });
  } else {
    await convex.mutation(api.readingSessions.markSent, {
      conversationId,
      nextChunkIndex: nextIndex,
    });
  }

  return text;
}

export async function tickReadingSessions(): Promise<void> {
  const currentHourUtc = new Date().getUTCHours();
  const due = await convex.query(api.readingSessions.listDueNow, {
    scheduledHourUtc: currentHourUtc,
  });

  for (const session of due) {
    // fire-and-forget so one slow send doesn't block others
    sendNextChunk(session.conversationId).catch((err) =>
      console.error(`[reading] sendNextChunk failed for ${session.conversationId}`, err),
    );
  }
}

export function startReadingLoop(intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    tickReadingSessions().catch((err) => console.error("[reading] tick error", err));
  }, intervalMs);
  return () => clearInterval(timer);
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no new errors in `server/reading.ts`. (The Convex generated API may need a `convex dev` run to pick up the new tables — if you see missing module errors, run `npx convex dev` in another terminal first.)

- [ ] **Step 3: Commit**

```bash
git add server/reading.ts
git commit -m "feat: add reading scheduler — tickReadingSessions and startReadingLoop"
```

---

## Task 6: Server MCP tools (`server/reading-tools.ts`)

**Files:**
- Create: `server/reading-tools.ts`

- [ ] **Step 1: Create the file**

```typescript
// server/reading-tools.ts
import { tool, createSdkMcpServer } from "./agent-runtime.js";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { sendNextChunk, toUtcHour } from "./reading.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createReadingMcp(conversationId: string) {
  return createSdkMcpServer({
    name: "boop-reading",
    version: "0.1.0",
    tools: [
      tool(
        "list_books",
        "List all available books the user can read. Call this before start_reading to show options.",
        {},
        async () => {
          const books = await convex.query(api.books.list, {});
          if (books.length === 0) {
            return { content: [{ type: "text" as const, text: "Nenhum livro disponível ainda." }] };
          }
          const body = books
            .map((b) => `• [${b.bookId}] "${b.title}" — ${b.author} (${b.chunkCount} trechos)`)
            .join("\n");
          return { content: [{ type: "text" as const, text: body }] };
        },
      ),

      tool(
        "start_reading",
        "Start or replace the user's active reading session. Sends the first chunk immediately. Also use this when switching books.",
        {
          bookId: z.string().describe("bookId from list_books."),
          hour: z.number().min(0).max(23).describe("Local hour (0-23) for daily delivery."),
          timezone: z
            .string()
            .optional()
            .describe("IANA timezone, e.g. 'America/Sao_Paulo'. Defaults to 'America/Sao_Paulo'."),
        },
        async (args) => {
          const tz = args.timezone ?? "America/Sao_Paulo";
          const book = await convex.query(api.books.get, { bookId: args.bookId });
          if (!book) {
            return { content: [{ type: "text" as const, text: `Livro '${args.bookId}' não encontrado.` }] };
          }
          const utcHour = toUtcHour(args.hour, tz);
          await convex.mutation(api.readingSessions.upsert, {
            conversationId,
            bookId: args.bookId,
            currentChunkIndex: 0,
            scheduledHour: args.hour,
            scheduledHourUtc: utcHour,
            timezone: tz,
            active: true,
          });
          // Send the first chunk immediately
          const result = await sendNextChunk(conversationId);
          return {
            content: [
              {
                type: "text" as const,
                text: `Sessão iniciada para "${book.title}". Primeiro trecho enviado. Próximos às ${args.hour}h (${tz}).`,
              },
            ],
          };
        },
      ),

      tool(
        "get_next_chunk",
        "Send the next chunk of the user's active book immediately, without waiting for the scheduled time. Use when the user says 'próximo', 'manda', 'quero ler agora', etc.",
        {},
        async () => {
          const result = await sendNextChunk(conversationId);
          return { content: [{ type: "text" as const, text: result }] };
        },
      ),

      tool(
        "update_schedule",
        "Change the daily delivery hour (and optionally timezone) for the user's active reading session.",
        {
          hour: z.number().min(0).max(23).describe("New local hour (0-23) for daily delivery."),
          timezone: z
            .string()
            .optional()
            .describe("New IANA timezone. If omitted, keeps the current timezone."),
        },
        async (args) => {
          const session = await convex.query(api.readingSessions.get, { conversationId });
          if (!session || !session.active) {
            return {
              content: [{ type: "text" as const, text: "Nenhuma sessão de leitura ativa." }],
            };
          }
          const tz = args.timezone ?? session.timezone;
          const utcHour = toUtcHour(args.hour, tz);
          await convex.mutation(api.readingSessions.upsert, {
            conversationId,
            bookId: session.bookId,
            currentChunkIndex: session.currentChunkIndex,
            scheduledHour: args.hour,
            scheduledHourUtc: utcHour,
            timezone: tz,
            active: true,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `Horário atualizado para ${args.hour}h (${tz}).`,
              },
            ],
          };
        },
      ),
    ],
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add server/reading-tools.ts
git commit -m "feat: add reading MCP tools (list_books, start_reading, get_next_chunk, update_schedule)"
```

---

## Task 7: Wire reading into `server/index.ts` and `server/interaction-agent.ts`

**Files:**
- Modify: `server/index.ts`
- Modify: `server/interaction-agent.ts`

- [ ] **Step 1: Add `startReadingLoop` to `server/index.ts`**

Add the import at the top (with other loop imports):
```typescript
import { startReadingLoop } from "./reading.js";
```

Add the call inside `main()`, after `startAutomationLoop()`:
```typescript
  startReadingLoop();
```

- [ ] **Step 2: Add `createReadingMcp` to `server/interaction-agent.ts`**

Add the import (with other MCP tool imports):
```typescript
import { createReadingMcp } from "./reading-tools.js";
```

Inside `handleUserMessage`, after the `draftDecisionServer` line, add:
```typescript
  const readingServer = createReadingMcp(opts.conversationId);
```

Add `"boop-reading": readingServer` to the `mcpServers` object in the `query()` call:
```typescript
        mcpServers: {
          "boop-memory": memoryServer,
          "boop-spawn": spawnServer,
          "boop-automations": automationServer,
          "boop-draft-decisions": draftDecisionServer,
          "boop-ack": ackServer,
          "boop-reading": readingServer,
        },
```

- [ ] **Step 3: Add reading block to the dispatcher system prompt**

In `server/interaction-agent.ts`, find `INTERACTION_SYSTEM` and add this block right before the final `Format:` section:

```
Leitura de Bolso (daily reading):
- User wants to read a book → call list_books, then start_reading with bookId + hour.
- User asks for next chunk now ("próximo", "manda o trecho", "quero ler") → call get_next_chunk.
- User wants to change schedule ("muda para 8h", "às 7 da manhã") → call update_schedule.
- User wants to switch books → call list_books then start_reading with the new bookId.
- For timezone: check memory first (write_memory to save it). Default to "America/Sao_Paulo".
- NEVER invent book content. Only relay what start_reading or get_next_chunk returns.
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add server/index.ts server/interaction-agent.ts
git commit -m "feat: wire reading loop and MCP tools into server"
```

---

## Task 8: CLI upload script

**Files:**
- Create: `scripts/books-add.ts`
- Modify: `package.json`

- [ ] **Step 1: Create `scripts/books-add.ts`**

```typescript
#!/usr/bin/env tsx
/**
 * Usage: npm run books:add -- --file ./book.txt --title "Title" --author "Author" [--lang pt]
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

// Load .env.local
import { config } from "dotenv";
config({ path: resolve(new URL(".", import.meta.url).pathname, "../.env.local") });

const CONVEX_URL = process.env.CONVEX_URL;
if (!CONVEX_URL) {
  console.error("CONVEX_URL not set. Run `npm run setup` or `npx convex dev` first.");
  process.exit(1);
}

// Parse CLI args
function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const filePath = arg("--file");
const title = arg("--title");
const author = arg("--author");
const language = arg("--lang") ?? "pt";

if (!filePath || !title || !author) {
  console.error("Usage: npm run books:add -- --file <path> --title <title> --author <author> [--lang <lang>]");
  process.exit(1);
}

const absPath = resolve(filePath);
if (!existsSync(absPath)) {
  console.error(`File not found: ${absPath}`);
  process.exit(1);
}

// Chunk the text into ~400-word segments (never cuts mid-paragraph)
function chunkText(text: string, targetWords = 400): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";
  let currentWords = 0;

  for (const para of paragraphs) {
    const paraWords = para.trim().split(/\s+/).length;
    if (currentWords > 0 && currentWords + paraWords > targetWords) {
      chunks.push(current.trim());
      current = para;
      currentWords = paraWords;
    } else {
      current = current ? current + "\n\n" + para : para;
      currentWords += paraWords;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function randomId(): string {
  return `book_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  const text = readFileSync(absPath, "utf8");
  const rawChunks = chunkText(text);
  const totalWords = text.split(/\s+/).length;
  const bookId = randomId();

  const client = new ConvexHttpClient(CONVEX_URL!);

  console.log(`Uploading "${title}" — ${rawChunks.length} chunks (~${totalWords} words)...`);

  await client.mutation(api.books.add, {
    bookId,
    title: title!,
    author: author!,
    language,
    chunkCount: rawChunks.length,
    wordCount: totalWords,
  });

  // Upload chunks in batches of 50
  const BATCH = 50;
  for (let i = 0; i < rawChunks.length; i += BATCH) {
    const batch = rawChunks.slice(i, i + BATCH).map((content, j) => ({
      chunkId: `${bookId}_${i + j}`,
      bookId,
      chunkIndex: i + j,
      content,
      wordCount: content.split(/\s+/).length,
    }));
    await client.mutation(api.bookChunks.addBatch, { chunks: batch });
    process.stdout.write(`  ${Math.min(i + BATCH, rawChunks.length)}/${rawChunks.length} chunks uploaded\r`);
  }

  console.log(`\n✓ "${title}" — ${rawChunks.length} trechos adicionados (bookId: ${bookId})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add `books:add` to `package.json` scripts**

Add inside the `"scripts"` object:
```json
"books:add": "tsx scripts/books-add.ts"
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Smoke-test with a small file**

Create a small test file and run:
```bash
echo "Este é o parágrafo um.\n\nEste é o parágrafo dois.\n\nEste é o parágrafo três." > /tmp/test-book.txt
npm run books:add -- --file /tmp/test-book.txt --title "Teste" --author "Autor Teste"
```

Expected output (approximately):
```
Uploading "Teste" — 1 chunks (~15 words)...
  1/1 chunks uploaded
✓ "Teste" — 1 trechos adicionados (bookId: book_xxx)
```

- [ ] **Step 5: Commit**

```bash
git add scripts/books-add.ts package.json
git commit -m "feat: add books:add CLI script for uploading .txt books to Convex"
```

---

## Task 9: Debug dashboard — `BooksPanel.tsx`

**Files:**
- Create: `debug/src/components/BooksPanel.tsx`

- [ ] **Step 1: Create the component**

```tsx
// debug/src/components/BooksPanel.tsx
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api.js";

export function BooksPanel({ isDark }: { isDark: boolean }) {
  const books = useQuery(api.books.list, {});
  const remove = useMutation(api.books.remove);
  const [removing, setRemoving] = useState<string | null>(null);

  const cardBg = isDark
    ? "bg-slate-900/40 border-slate-800/60"
    : "bg-white border-slate-200";
  const mutedText = isDark ? "text-slate-500" : "text-slate-400";

  async function handleRemove(bookId: string, title: string) {
    if (!confirm(`Remover "${title}"? Isso apagará todos os trechos.`)) return;
    setRemoving(bookId);
    try {
      await remove({ bookId });
    } finally {
      setRemoving(null);
    }
  }

  const list = books ?? [];

  return (
    <div className="flex flex-col h-full -m-5">
      <div
        className={`shrink-0 border-b px-5 py-3 flex items-center gap-3 ${
          isDark ? "border-slate-800" : "border-slate-200"
        }`}
      >
        <h2
          className={`text-xs font-semibold uppercase tracking-wider ${mutedText}`}
        >
          Livros
        </h2>
        <span className={`text-xs ${mutedText}`}>{list.length} no catálogo</span>
      </div>

      <div className="flex-1 overflow-auto debug-scroll px-5 py-4 space-y-3">
        {list.length === 0 && (
          <p className={`text-sm ${mutedText}`}>
            Nenhum livro cadastrado. Use{" "}
            <code className="mono">npm run books:add</code> para adicionar.
          </p>
        )}
        {list.map((book: any) => (
          <div
            key={book.bookId}
            className={`rounded-lg border p-4 flex items-start justify-between gap-4 ${cardBg}`}
          >
            <div className="flex-1 min-w-0">
              <p
                className={`text-sm font-medium ${
                  isDark ? "text-slate-200" : "text-slate-800"
                } truncate`}
              >
                {book.title}
              </p>
              <p className={`text-xs ${mutedText} mt-0.5`}>
                {book.author} · {book.language.toUpperCase()} · {book.chunkCount} trechos
              </p>
              <p className={`text-xs mono ${mutedText} mt-1`}>{book.bookId}</p>
            </div>
            <button
              onClick={() => handleRemove(book.bookId, book.title)}
              disabled={removing === book.bookId}
              className={`shrink-0 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                isDark
                  ? "border-rose-800 text-rose-400 hover:bg-rose-900/30 disabled:opacity-40"
                  : "border-rose-200 text-rose-500 hover:bg-rose-50 disabled:opacity-40"
              }`}
            >
              {removing === book.bookId ? "Removendo…" : "Remover"}
            </button>
          </div>
        ))}
      </div>

      <div
        className={`shrink-0 border-t px-5 py-3 ${
          isDark ? "border-slate-800" : "border-slate-200"
        }`}
      >
        <p className={`text-xs ${mutedText}`}>
          Para adicionar um livro:{" "}
          <code className="mono">
            npm run books:add -- --file livro.txt --title "Título" --author "Autor"
          </code>
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add debug/src/components/BooksPanel.tsx
git commit -m "feat: add BooksPanel dashboard component"
```

---

## Task 10: Wire `BooksPanel` into `App.tsx`

**Files:**
- Modify: `debug/src/App.tsx`

- [ ] **Step 1: Add import**

In `debug/src/App.tsx`, add after the existing panel imports:
```typescript
import { BooksPanel } from "./components/BooksPanel.js";
```

- [ ] **Step 2: Add `"books"` to the `View` union type**

Change:
```typescript
type View =
  | "dashboard"
  | "agents"
  | "automations"
  | "memory"
  | "events"
  | "consolidation"
  | "connections";
```
To:
```typescript
type View =
  | "dashboard"
  | "agents"
  | "automations"
  | "memory"
  | "events"
  | "consolidation"
  | "connections"
  | "books";
```

- [ ] **Step 3: Add icon to `NAV_ICONS`**

Add `books` to `NAV_ICONS` (you can reuse `AiBrain02Icon` or pick another HugeIcons icon; `BookOpen02Icon` from `@hugeicons/core-free-icons` works if available, otherwise use `AiBrain02Icon`):
```typescript
  books: AiBrain02Icon,
```

- [ ] **Step 4: Add entry to `NAV` array**

Add after the `connections` entry:
```typescript
  { id: "books", label: "Books" },
```

- [ ] **Step 5: Add render in the main content area**

Add after the `connections` panel render:
```tsx
            {view === "books" && <BooksPanel isDark={isDark} />}
```

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add debug/src/App.tsx
git commit -m "feat: add Books tab to debug dashboard"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| 3 Convex tables with indexes | Task 1 |
| books CRUD | Task 2 |
| bookChunks CRUD | Task 3 |
| readingSessions CRUD + listDueNow | Task 4 |
| Scheduler tick every 60s | Task 5 |
| formatChunkMessage format | Task 5 |
| Book-removed/last-chunk edge cases | Task 5 (`sendNextChunk`) |
| list_books MCP tool | Task 6 |
| start_reading MCP tool | Task 6 |
| get_next_chunk MCP tool | Task 6 |
| update_schedule MCP tool | Task 6 |
| Wire loop into index.ts | Task 7 |
| System prompt additions | Task 7 |
| Register boop-reading MCP | Task 7 |
| CLI upload with chunking | Task 8 |
| package.json script | Task 8 |
| BooksPanel dashboard | Task 9 |
| App.tsx Books tab | Task 10 |
| Don't send twice per day | Task 4 (`listDueNow` 23h cutoff) |
| scheduledHourUtc derived field | Tasks 4, 6 (`toUtcHour`) |

**All spec requirements covered. No placeholders found.**

---

## End-to-End Verification

After all tasks are complete:

1. **Convex tables exist:** Run `npx convex dev` — no schema errors.
2. **Upload:** `npm run books:add -- --file test.txt --title "Teste" --author "Autor"` → success message.
3. **Dashboard:** Open `http://localhost:5173/debug` → "Books" tab shows the uploaded book.
4. **Start reading via chat:** POST to `http://localhost:3456/chat` with `{ "conversationId": "wa:+5511999999999", "content": "quero ler Teste" }` → response includes first chunk.
5. **Next chunk:** POST same endpoint with `"content": "próximo"` → response includes second chunk (or completion message).
6. **Scheduler:** Set `scheduledHour` to current UTC hour via `update_schedule`, wait up to 60s → chunk sent and `lastSentAt` updated in Convex dashboard.
7. **Remove:** Click "Remover" on dashboard → book disappears, its chunks are gone.
