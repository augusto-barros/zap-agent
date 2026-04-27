#!/usr/bin/env tsx
import prompts from "prompts";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const ENV_PATH = resolve(ROOT, ".env.local");
const EXAMPLE_PATH = resolve(ROOT, ".env.example");

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const lines = readFileSync(path, "utf8").split("\n");
  const env: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function writeEnv(path: string, env: Record<string, string>): void {
  const example = existsSync(EXAMPLE_PATH) ? readFileSync(EXAMPLE_PATH, "utf8") : "";

  let out = "";
  const seen = new Set<string>();
  const sections = example.split(/\n(?=# ----)/);

  for (const section of sections) {
    const sectionKeys = [...section.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]);
    let s = section;
    for (const k of sectionKeys) {
      // Remove ALL existing occurrences of this key in the section (dedupe).
      const pattern = new RegExp(`^${k}=.*(\\r?\\n)?`, "gm");
      const matches = [...s.matchAll(pattern)];
      if (matches.length === 0) continue;

      if (seen.has(k)) {
        // Already written in an earlier section — just strip any re-occurrences.
        s = s.replace(pattern, "");
        continue;
      }

      const v = env[k] ?? "";
      // Replace first occurrence, remove the rest.
      let replaced = false;
      s = s.replace(pattern, (match) => {
        if (!replaced) {
          replaced = true;
          return `${k}=${v}` + (match.endsWith("\n") ? "\n" : "");
        }
        return "";
      });
      seen.add(k);
    }
    out += s + "\n";
  }
  writeFileSync(path, out.trim() + "\n");
}

function banner(s: string) {
  console.log("\n" + "━".repeat(60));
  console.log("  " + s);
  console.log("━".repeat(60));
}

async function runConvexDev(): Promise<void> {
  // If CONVEX_DEPLOYMENT is already set, `convex dev` reuses that deployment.
  // Only pass --configure new if this is a first-time setup — otherwise re-running
  // setup would silently create a new project and abandon all existing data.
  const existing = readEnv(ENV_PATH);
  const args = existing.CONVEX_DEPLOYMENT
    ? ["convex", "dev", "--once"]
    : ["convex", "dev", "--once", "--configure", "new"];

  console.log(`\nLaunching \`npx ${args.join(" ")}\` to configure your deployment.`);
  console.log("Convex will open a browser window if you're not logged in.");
  if (existing.CONVEX_DEPLOYMENT) {
    console.log(`Reusing existing deployment: ${existing.CONVEX_DEPLOYMENT}`);
  }

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("npx", args, { stdio: "inherit", cwd: ROOT });
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`convex dev exited ${code}`)),
    );
  });
}

function hasBinary(name: string): Promise<boolean> {
  return new Promise((ok) => {
    const lookup = process.platform === "win32" ? "where" : "which";
    const child = spawn(lookup, [name], { stdio: "ignore" });
    child.on("exit", (code) => ok(code === 0));
    child.on("error", () => ok(false));
  });
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* ignore — fall back to the printed URL */
  }
}

function runInherit(cmd: string, args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: ROOT });
    child.on("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
    child.on("error", fail);
  });
}

function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], cwd: ROOT });
    let out = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("exit", (code) =>
      code === 0 ? ok(out) : fail(new Error(`${cmd} exited ${code}`)),
    );
    child.on("error", fail);
  });
}


async function main() {
  banner("boop-agent setup");

  console.log(`
What this does:
  1. Asks for your WhatsApp (Meta Cloud API) credentials
  2. Asks about your Claude model preference
  3. Runs \`npx convex dev\` to create a Convex project
  4. Writes .env.local

Before you start:
  • A Claude Code subscription:    https://claude.com/code
  • Convex account (free tier):    https://convex.dev
  • Meta Developer app with WhatsApp: https://developers.facebook.com
`);

  const existing = readEnv(ENV_PATH);

  const whatsappDefaults = {
    WHATSAPP_TOKEN: existing.WHATSAPP_TOKEN ?? "",
    WHATSAPP_PHONE_NUMBER_ID: existing.WHATSAPP_PHONE_NUMBER_ID ?? "",
    WHATSAPP_VERIFY_TOKEN: existing.WHATSAPP_VERIFY_TOKEN ?? "boop-webhook",
  };

  const whatsappPrompts = [] as any[];
  if (!whatsappDefaults.WHATSAPP_TOKEN) {
    whatsappPrompts.push({
      type: "password",
      name: "WHATSAPP_TOKEN",
      message: "WhatsApp token (Meta Developer Console → WhatsApp → API Setup → Temporary/permanent token)",
      initial: "",
    });
  }
  if (!whatsappDefaults.WHATSAPP_PHONE_NUMBER_ID) {
    whatsappPrompts.push({
      type: "text",
      name: "WHATSAPP_PHONE_NUMBER_ID",
      message: "WhatsApp Phone Number ID (Meta Developer Console → WhatsApp → API Setup)",
      initial: "",
    });
  }
  if (!whatsappDefaults.WHATSAPP_VERIFY_TOKEN) {
    whatsappPrompts.push({
      type: "text",
      name: "WHATSAPP_VERIFY_TOKEN",
      message: "Webhook verify token (any string you choose — use the same when registering in Meta)",
      initial: "boop-webhook",
    });
  }

  const answers = await prompts(
    [
      ...whatsappPrompts,
      {
        type: "select",
        name: "BOOP_MODEL",
        message: "Which Claude model should the agent use?",
        choices: [
          { title: "claude-sonnet-4-6 (recommended)", value: "claude-sonnet-4-6" },
          { title: "claude-opus-4-6 (slowest, most capable)", value: "claude-opus-4-6" },
          { title: "claude-haiku-4-5 (fastest, cheapest)", value: "claude-haiku-4-5" },
        ],
        initial: 0,
      },
      {
        type: "text",
        name: "PORT",
        message: "Local server port",
        initial: existing.PORT ?? "3456",
      },
      {
        type: "confirm",
        name: "runConvex",
        message: "Run `convex dev` now to configure your Convex deployment?",
        initial: true,
      },
    ],
    {
      onCancel: () => {
        console.log("Setup cancelled.");
        process.exit(1);
      },
    },
  );

  // Merge defaults with what the user answered (answer wins).
  Object.assign(answers, {
    WHATSAPP_TOKEN: answers.WHATSAPP_TOKEN ?? whatsappDefaults.WHATSAPP_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: answers.WHATSAPP_PHONE_NUMBER_ID ?? whatsappDefaults.WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_VERIFY_TOKEN: answers.WHATSAPP_VERIFY_TOKEN ?? whatsappDefaults.WHATSAPP_VERIFY_TOKEN,
  });

  // ---- Composio API key ---------------------------------------------------
  banner("Composio — integrations (Gmail, Slack, GitHub, Linear, 1000+ more)");
  const composioSettingsUrl = "https://platform.composio.dev/settings";
  const existingComposio = existing.COMPOSIO_API_KEY ?? "";
  const { composioMode } = await prompts(
    {
      type: "select",
      name: "composioMode",
      message: existingComposio
        ? "Composio API key detected. Keep it or replace?"
        : "Configure Composio now? (needed to connect any integration)",
      choices: existingComposio
        ? [
            { title: "Keep existing key", value: "keep" },
            { title: "Replace (opens the Composio dashboard)", value: "replace" },
            { title: "Skip", value: "skip" },
          ]
        : [
            { title: "Yes — open the Composio dashboard and paste my key", value: "replace" },
            { title: "Skip for now", value: "skip" },
          ],
      initial: 0,
    },
    {
      onCancel: () => {
        console.log("Setup cancelled.");
        process.exit(1);
      },
    },
  );

  if (composioMode === "replace") {
    console.log(`\nOpening ${composioSettingsUrl} — grab your API key there.`);
    console.log(`(If the browser doesn't open, copy the URL above.)\n`);
    openInBrowser(composioSettingsUrl);
    const { COMPOSIO_API_KEY } = await prompts(
      {
        type: "password",
        name: "COMPOSIO_API_KEY",
        message: "Paste your Composio API key (leave blank to skip):",
        initial: "",
      },
      {
        onCancel: () => {
          console.log("Setup cancelled.");
          process.exit(1);
        },
      },
    );
    (answers as any).COMPOSIO_API_KEY = COMPOSIO_API_KEY || existingComposio;
  } else if (composioMode === "keep") {
    (answers as any).COMPOSIO_API_KEY = existingComposio;
  } else {
    (answers as any).COMPOSIO_API_KEY = existingComposio;
    console.log(
      `\nSkipped. Add COMPOSIO_API_KEY to .env.local later to enable integrations.`,
    );
  }

  // ---- Tunnel configuration ------------------------------------------------
  banner("Tunnel — public URL for Meta to reach your server");
  console.log(`
ngrok's FREE plan gives you a NEW public URL every restart, which means
re-pasting into the Meta Developer Console every time. For a stable URL, pick one of:

  1. Free ngrok             (fine for testing / demos — re-paste each restart)
  2. ngrok RESERVED domain  (paid — stays the same across restarts)
  3. Cloudflare Tunnel / other static tunnel you set up yourself
`);

  const { tunnelChoice } = await prompts(
    {
      type: "select",
      name: "tunnelChoice",
      message: "Which option are you using?",
      choices: [
        { title: "Free ngrok — I'll paste a new URL each restart", value: "free" },
        { title: "ngrok reserved domain (paid)", value: "ngrok-domain" },
        { title: "Cloudflare Tunnel or another stable URL", value: "static" },
      ],
      initial: 0,
    },
    {
      onCancel: () => {
        console.log("Setup cancelled.");
        process.exit(1);
      },
    },
  );

  if (tunnelChoice === "ngrok-domain") {
    const { NGROK_DOMAIN } = await prompts({
      type: "text",
      name: "NGROK_DOMAIN",
      message: "Your ngrok reserved domain (e.g. boop.ngrok.app, no https://):",
      initial: existing.NGROK_DOMAIN ?? "",
    });
    const clean = (NGROK_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (clean) {
      (answers as any).NGROK_DOMAIN = clean;
      (answers as any).PUBLIC_URL = `https://${clean}`;
    }
  } else if (tunnelChoice === "static") {
    const { PUBLIC_URL } = await prompts({
      type: "text",
      name: "PUBLIC_URL",
      message: "Your stable public URL (e.g. https://boop.mydomain.com):",
      initial: existing.PUBLIC_URL ?? "",
    });
    if (PUBLIC_URL) {
      (answers as any).PUBLIC_URL = PUBLIC_URL.replace(/\/$/, "");
      (answers as any).NGROK_DOMAIN = "";
    }
  } else {
    // free ngrok — clear any stale domain and keep PUBLIC_URL at the localhost default
    (answers as any).NGROK_DOMAIN = "";
  }

  const env: Record<string, string> = { ...existing, ...answers };
  delete (env as any).runConvex;
  if (!env.PUBLIC_URL) env.PUBLIC_URL = `http://localhost:${env.PORT ?? "3456"}`;
  // Clear stale / stub Convex values so `convex dev` can populate them freshly.
  // (`convex dev` uses .convex/ to identify the deployment, not these env vars.)
  if (env.CONVEX_URL?.includes("example.convex.cloud")) delete env.CONVEX_URL;
  if (env.VITE_CONVEX_URL?.includes("example.convex.cloud")) delete env.VITE_CONVEX_URL;
  writeEnv(ENV_PATH, env);

  banner("Claude authentication");
  console.log(`This project uses your Claude Code subscription — no Anthropic API key needed.

If you haven't already:
  • Install Claude Code:  npm install -g @anthropic-ai/claude-code
  • Run once:              claude
  • Sign in when prompted

The Claude Agent SDK reads the credentials Claude Code saves on disk.
You can override with ANTHROPIC_API_KEY in .env.local if you'd rather use an API key.
`);

  if (answers.runConvex) {
    await runConvexDev();
    const after = readEnv(ENV_PATH);

    // CONVEX_DEPLOYMENT is what `convex dev` writes; derive CONVEX_URL from it
    // so it matches even if a stale URL lingered from a previous setup.
    const deploymentMatch = after.CONVEX_DEPLOYMENT?.match(/^([a-z]+):([\w-]+)/);
    if (deploymentMatch) {
      const url = `https://${deploymentMatch[2]}.convex.cloud`;
      if (after.CONVEX_URL !== url || after.VITE_CONVEX_URL !== url) {
        writeEnv(ENV_PATH, {
          ...after,
          CONVEX_URL: url,
          VITE_CONVEX_URL: url,
        });
        console.log(`\n✓ Synced CONVEX_URL + VITE_CONVEX_URL → ${url}`);
      }
    }
  } else {
    console.log("\nSkipped Convex. Run `npx convex dev` yourself when ready.");
  }

  const port = answers.PORT ?? "3456";
  banner("You're set up. Here's how to actually run it.");
  console.log(`
Before you start: install ngrok (one-time).

  brew install ngrok                           # macOS
  # or download:  https://ngrok.com/download
  ngrok config add-authtoken <your-token>      # free at https://dashboard.ngrok.com

⚠ ngrok's FREE plan gives you a NEW URL every restart. That means
  re-pasting into the Meta Developer Console every time. For anything beyond
  a demo, use a stable URL:
    • ngrok paid plan (reserved domain), or
    • Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

Then run ONE command:

  npm run dev

That starts the server, Convex watcher, debug dashboard, AND ngrok all
together — color-prefixed output so you can tell who's saying what. Once
the tunnel is live, you'll see a banner with your public URL.

Wire up WhatsApp webhook (one-time, takes ~2 minutes):

  1. Copy the "WhatsApp webhook" URL printed in the banner.
  2. Meta Developer Console → your app → WhatsApp → Configuration
  3. Under Webhook, click Edit.
  4. Paste the URL as "Callback URL" and use your WHATSAPP_VERIFY_TOKEN as "Verify token".
  5. Click Verify and Save. Then subscribe to the "messages" field.

Test it:
  • Open http://localhost:5173 for the debug dashboard (Chat tab works
    without WhatsApp configured).
  • Or text your WhatsApp Business number. The agent replies.

Integrations (via Composio):
  1. Set COMPOSIO_API_KEY in .env.local (get one at https://app.composio.dev/developers?utm_source=chris&utm_medium=youtube&utm_campaign=collab).
  2. Open the debug dashboard → Connections tab.
  3. Click Connect on any toolkit (Gmail, Slack, GitHub, Linear, Notion, …).
  4. Composio handles OAuth; the toolkit becomes available to the agent.
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
