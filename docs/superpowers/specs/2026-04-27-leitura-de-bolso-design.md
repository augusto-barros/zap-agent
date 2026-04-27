# Leitura de Bolso — Design Spec

**Data:** 2026-04-27  
**Status:** Aprovado

## Visão Geral

Extensão do zap-agent que transforma o agente WhatsApp em um companheiro de leitura diária. Usuários recebem um trecho de ~400 palavras do livro escolhido, no horário que definiram, todo dia. Toda a interação acontece em linguagem natural via WhatsApp.

**Modelo de IA:** Mantém Claude (não migra para OpenAI). O `@anthropic-ai/claude-agent-sdk` é o núcleo do sistema e a migração não traz benefício claro para este caso de uso.

---

## Arquitetura

O Leitura de Bolso é adicionado ao zap-agent como uma feature independente dentro do mesmo servidor e banco Convex. Três novos componentes:

1. **Banco de dados** — 3 novas tabelas Convex
2. **Scheduler** — loop paralelo ao de automações, envia trechos no horário certo
3. **MCP tools** — 4 ferramentas para o dispatcher Claude interpretar comandos do usuário

---

## 1. Modelo de Dados (Convex)

### `books`
Catálogo de livros cadastrados pelo administrador.

```typescript
books: defineTable({
  bookId: v.string(),
  title: v.string(),
  author: v.string(),
  language: v.string(),       // "pt", "en", etc.
  chunkCount: v.number(),     // total de trechos
  wordCount: v.number(),      // total de palavras
  addedAt: v.number(),
})
  .index("by_book_id", ["bookId"])
```

### `bookChunks`
Conteúdo pré-dividido em trechos de ~400 palavras, gerado no upload.

```typescript
bookChunks: defineTable({
  chunkId: v.string(),
  bookId: v.string(),
  chunkIndex: v.number(),     // 0-based
  content: v.string(),        // texto do trecho
  wordCount: v.number(),
})
  .index("by_book_id", ["bookId"])
  .index("by_book_chunk", ["bookId", "chunkIndex"])
```

### `readingSessions`
Estado de leitura por usuário (um por `conversationId`).

```typescript
readingSessions: defineTable({
  conversationId: v.string(),   // "wa:+5511999999999"
  bookId: v.string(),
  currentChunkIndex: v.number(),
  scheduledHour: v.number(),    // 0-23 (hora local do usuário)
  scheduledHourUtc: v.number(), // 0-23 convertido para UTC (derivado, usado pelo índice)
  timezone: v.string(),         // IANA timezone, ex: "America/Sao_Paulo"
  active: v.boolean(),
  startedAt: v.number(),
  lastSentAt: v.optional(v.number()),
})
  .index("by_conversation", ["conversationId"])
  .index("by_active_hour_utc", ["active", "scheduledHourUtc"])
```

**Nota:** `scheduledHourUtc` é derivado de `scheduledHour + timezone` e recalculado toda vez que o usuário muda horário ou timezone. O scheduler usa `scheduledHourUtc` para queries eficientes sem precisar varrer todas as sessões.

---

## 2. Upload de Livros

### CLI (`scripts/books-add.mjs`)

```bash
npm run books:add -- --file ./livros/dom-casmurro.txt --title "Dom Casmurro" --author "Machado de Assis" --lang pt
```

**Algoritmo de chunking:**
1. Divide o texto por parágrafos (`\n\n`)
2. Agrupa parágrafos até atingir ~400 palavras
3. Nunca corta no meio de um parágrafo
4. Salva via Convex HTTP API (`/api/books/add`)

**Output:**
```
✓ "Dom Casmurro" — 287 trechos (~114.800 palavras) adicionado (bookId: book_abc123)
```

### Aba no Debug Dashboard (`/debug/src/components/BooksPanel.tsx`)

- Lista todos os livros com título, autor, nº de trechos
- Botão "Adicionar livro" → input de título/autor + upload de `.txt`
- Botão "Remover livro" com confirmação
- Sem edição de chunks individuais (sempre re-upload completo)

---

## 3. Scheduler de Leitura (`server/reading.ts`)

Loop que roda a cada **60 segundos** (iniciado em `server/index.ts` junto com `startAutomationLoop`).

### Lógica de `tickReadingSessions()`

```
1. Obtém hora atual em UTC (0-23)
2. Busca sessões WHERE active = true AND scheduledHourUtc = currentHourUtc
   (índice eficiente, sem varredura completa)
3. Filtra: lastSentAt < startOfToday (no timezone do usuário, para não enviar duas vezes no mesmo dia)
4. Para cada sessão elegível (fire-and-forget):
   a. Busca bookChunk pelo (bookId, currentChunkIndex)
   b. Formata mensagem
   c. sendWhatsApp(number, text)
   d. Salva mensagem no histórico (api.messages.send)
   e. Incrementa currentChunkIndex, atualiza lastSentAt
   f. Se currentChunkIndex >= book.chunkCount: envia conclusão, active = false
```

**Nota sobre timezone:** `scheduledHour` guarda a hora local do usuário (legível), `scheduledHourUtc` é o valor derivado usado pelo índice. Quando o usuário muda horário ou timezone, ambos são atualizados juntos.

### Formato da mensagem enviada

```
📖 *Dom Casmurro* | Trecho 14 de 287

Capítulo XIV — Uma visita

[...texto do trecho aqui...]

─────────────────
Amanhã: trecho 15. Quer ler agora? Responda *próximo*.
```

### Tratamento de erros
- Falha no envio: loga erro, não incrementa index (tenta novamente no próximo tick)
- Livro removido: marca sessão como `active = false`, envia aviso ao usuário
- Último trecho enviado: `"🎉 Você terminou Dom Casmurro! Responda 'quero ler um livro' para escolher o próximo."`

---

## 4. Ferramentas MCP para o Dispatcher

Novo MCP server `boop-reading` criado em `server/reading-tools.ts`, registrado no `handleUserMessage` junto com os outros servidores.

### Ferramentas

#### `list_books`
Retorna lista de livros disponíveis. Sem parâmetros.

Output: `[{ bookId, title, author, chunkCount }]`

#### `start_reading({ bookId, hour, timezone? })`
Cria ou substitui a sessão de leitura do usuário. Envia o primeiro trecho imediatamente (chunkIndex = 0).

- Se já existe uma sessão ativa → substitui (reseta progresso)
- Se `timezone` não fornecido → usa `"America/Sao_Paulo"` como padrão
- Retorna confirmação com preview do livro e horário formatado

#### `get_next_chunk`
Envia o próximo trecho imediatamente, sem esperar o horário agendado. Incrementa o índice normalmente. Usado quando o usuário pede "próximo" ou "manda o de hoje".

#### `update_schedule({ hour, timezone? })`
Atualiza `scheduledHour` (e opcionalmente `timezone`) na sessão ativa. Não interrompe o progresso atual.

### Adições ao System Prompt do Dispatcher

```
Leitura diária (Leitura de Bolso):
- Se o usuário quiser ler um livro: use list_books e depois start_reading.
- Se pedir o próximo trecho agora ("próximo", "manda", "quero ler agora"): use get_next_chunk.
- Para mudar horário: use update_schedule.
- Para trocar de livro: use list_books e start_reading com o novo bookId.
- Timezone: use da memória do usuário se souber, senão pergunte e salve com write_memory.
- NUNCA invente trechos de livros. Só envie o que get_next_chunk ou start_reading retornar.
```

---

## 5. Comandos de Linguagem Natural Suportados

| O que o usuário diz | Ferramenta acionada |
|---|---|
| "quero ler um livro" | `list_books` → `start_reading` |
| "quero ler Dom Casmurro" | `list_books` (para achar bookId) → `start_reading` |
| "próximo" / "manda o trecho" / "lê pra mim" | `get_next_chunk` |
| "muda para 8h" / "receber às 7 da manhã" | `update_schedule(7)` |
| "troca o livro" / "outro livro" | `list_books` → `start_reading` |

---

## 6. Arquivos a Criar/Modificar

| Arquivo | Operação |
|---|---|
| `convex/schema.ts` | Adicionar 3 tabelas |
| `convex/books.ts` | CRUD: addBook, listBooks, getBook, removeBook |
| `convex/bookChunks.ts` | CRUD: addChunks, getChunk |
| `convex/readingSessions.ts` | CRUD: upsertSession, getSession, listDueNow, markSent, finish |
| `server/reading.ts` | startReadingLoop, tickReadingSessions, sendChunk |
| `server/reading-tools.ts` | createReadingMcp (MCP server com 4 tools) |
| `server/index.ts` | Adicionar startReadingLoop() |
| `server/interaction-agent.ts` | Registrar boop-reading MCP, adicionar tools à allowedTools, adicionar bloco ao system prompt |
| `scripts/books-add.mjs` | CLI de upload |
| `debug/src/components/BooksPanel.tsx` | Aba de gerenciamento de livros |
| `debug/src/App.tsx` | Adicionar aba Livros |
| `package.json` | Script `books:add` |

---

## 7. Verificação

1. **Upload:** `npm run books:add -- --file test.txt --title "Teste" --author "Autor"` deve salvar chunks no Convex
2. **Dashboard:** Aba Livros aparece no debug dashboard, exibe o livro cadastrado
3. **Comando de início:** Enviar "quero ler Teste" via dashboard → agente responde com primeiro trecho
4. **Próximo trecho:** Enviar "próximo" → agente envia trecho 2 sem esperar agendamento
5. **Scheduler:** Configurar horário = hora atual + 1 min, aguardar → trecho enviado automaticamente
6. **Troca de livro:** "troca o livro" → lista livros → escolhe → reinicia do início
7. **Conclusão:** Setar sessão com `currentChunkIndex = chunkCount - 1`, aguardar envio → mensagem de conclusão, sessão desativada
