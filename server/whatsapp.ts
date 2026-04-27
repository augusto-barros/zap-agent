import express from "express";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";

const GRAPH_API_BASE = "https://graph.facebook.com/v18.0";
const MAX_CHUNK = 4096;

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .trim();
}

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// WhatsApp numbers come without '+' from Meta webhooks; add it back for storage/display.
function normalizeFromNumber(n: string): string {
  return n.startsWith("+") ? n : `+${n}`;
}

// Strip '+' for the 'to' field in Meta send API.
function toApiNumber(n: string): string {
  return n.startsWith("+") ? n.slice(1) : n;
}

export async function sendWhatsApp(toNumber: string, text: string): Promise<void> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    console.warn("[whatsapp] missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID — not sending");
    return;
  }
  const plain = stripMarkdown(text);
  for (const part of chunk(plain)) {
    const res = await fetch(`${GRAPH_API_BASE}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toApiNumber(toNumber),
        type: "text",
        text: { body: part },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[whatsapp] send failed ${res.status}: ${body}`);
    } else {
      console.log(`[whatsapp] → sent ${part.length} chars to ${toNumber}`);
    }
  }
}

// WhatsApp Business API does not support typing indicators — no-op.
export function startTypingLoop(_toNumber: string): () => void {
  return () => {};
}

export function createWhatsappRouter(): express.Router {
  const router = express.Router();

  // Meta webhook verification handshake.
  router.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      console.log("[whatsapp] webhook verified");
      res.status(200).send(challenge);
    } else {
      console.warn("[whatsapp] webhook verification failed");
      res.sendStatus(403);
    }
  });

  // Incoming messages from Meta.
  router.post("/webhook", async (req, res) => {
    // Always respond 200 immediately so Meta doesn't retry.
    res.json({ ok: true });

    const body = req.body ?? {};
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        for (const message of value.messages ?? []) {
          if (message.type !== "text") continue;

          const rawFrom: string = message.from;
          const messageId: string = message.id;
          const content: string = message.text?.body ?? "";

          if (!content || !rawFrom) continue;

          // Dedup using the wamid as handle — same table as before.
          const { claimed } = await convex.mutation(api.sendblueDedup.claim, {
            handle: messageId,
          });
          if (!claimed) continue;

          const fromNumber = normalizeFromNumber(rawFrom);
          const conversationId = `wa:${fromNumber}`;
          const turnTag = Math.random().toString(36).slice(2, 8);
          const preview = content.length > 100 ? content.slice(0, 100) + "…" : content;
          console.log(`[turn ${turnTag}] ← ${fromNumber}: ${JSON.stringify(preview)}`);
          const start = Date.now();

          broadcast("message_in", { conversationId, content, from_number: fromNumber, handle: messageId });

          const stopTyping = startTypingLoop(fromNumber);
          try {
            const reply = await handleUserMessage({
              conversationId,
              content,
              turnTag,
              onThinking: (t) => broadcast("thinking", { conversationId, t }),
            });
            if (reply) {
              const elapsed = ((Date.now() - start) / 1000).toFixed(1);
              const replyPreview = reply.length > 100 ? reply.slice(0, 100) + "…" : reply;
              console.log(
                `[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
              );
              await sendWhatsApp(fromNumber, reply);
              await convex.mutation(api.messages.send, {
                conversationId,
                role: "assistant",
                content: reply,
              });
            } else {
              console.log(`[turn ${turnTag}] → (no reply)`);
            }
          } catch (err) {
            console.error(`[turn ${turnTag}] handler error`, err);
          } finally {
            stopTyping();
          }
        }
      }
    }
  });

  return router;
}
