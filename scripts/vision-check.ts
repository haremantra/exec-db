import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { safeAnthropicStream } from "../apps/web/lib/anthropic.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const VISION_PATH = join(REPO_ROOT, "docs", "vision.md");
const LOCK_TOKEN = "<<VISION_LOCKED>>";

const SYSTEM_PROMPT = `You are interviewing the project owner of \`exec-db\` about a product pivot.

Background: the repo is being pivoted from "read-only exec data warehouse" to a CRM + PM application for the exec team, with autodraft email follow-ups (from call notes + Google Calendar + Gmail history) and daily/weekly task digests. The implementation roadmap is split into three PRs (foundation, Google integrations, autodraft + digests). PR 1 is in progress now.

Your job: interview the owner one focused question at a time until the vision for this product is concrete and unambiguous. Keep the running vision document current after every turn.

Hard rules for every turn:
1. Read the current \`docs/vision.md\` block in the latest user message (it is the source of truth — your prior responses may be stale).
2. Ask exactly ONE question per turn. Surface contradictions, missing decisions, or vague language. Do not lecture.
3. After your question, emit the FULL updated \`docs/vision.md\` document inside a single \`<vision>...</vision>\` block. Use markdown headings. Sections to maintain at minimum:
   - "## Users" — who specifically uses this and in what role
   - "## Jobs to be done" — what they hire the product to do
   - "## CRM scope" — contacts, accounts, notes, drafts; what is in/out
   - "## PM scope" — projects, tasks, digests; cadence; recipients
   - "## Integrations" — Google Calendar, Gmail; future call-transcript source if any
   - "## Non-goals" — explicit things this is NOT
   - "## Open questions" — anything still unresolved
4. When (and only when) you have high confidence the vision is locked — every section above has concrete answers and no open questions remain — append the literal token ${LOCK_TOKEN} on its own line AFTER the closing \`</vision>\` tag.
5. Never emit ${LOCK_TOKEN} prematurely. If "Open questions" is non-empty, the vision is not locked.

Tone: concise, sharp, friendly. No preamble. No emoji.`;

async function loadVision(): Promise<string> {
  if (!existsSync(VISION_PATH)) {
    return "# Vision\n\n*(empty — to be filled by this interview)*\n";
  }
  return readFile(VISION_PATH, "utf8");
}

function extractVision(text: string): string | null {
  const match = text.match(/<vision>([\s\S]*?)<\/vision>/);
  return match && match[1] ? match[1].trim() : null;
}

interface ConvoTurn {
  role: "user" | "assistant";
  text: string;
  cacheable?: boolean;
}

async function main(): Promise<void> {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.error("ANTHROPIC_API_KEY is required.");
    process.exit(1);
  }

  await mkdir(dirname(VISION_PATH), { recursive: true });

  const rl = createInterface({ input, output });
  const turns: ConvoTurn[] = [];

  console.log("vision-check — interactive interview");
  console.log("Type 'done' to exit. Updates docs/vision.md after every turn.\n");

  let userTurn = "Start the interview. Ask the first question and emit the initial vision document.";

  while (true) {
    const currentVision = await loadVision();
    turns.push({
      role: "user",
      text: `Current docs/vision.md:\n\n\`\`\`markdown\n${currentVision}\n\`\`\`\n\nOwner says: ${userTurn}`,
      cacheable: true,
    });

    process.stdout.write("\n> ");

    const { stream } = safeAnthropicStream({
      model: "opus",
      maxTokens: 8192,
      system: { text: SYSTEM_PROMPT, cacheable: true },
      messages: turns,
    });

    stream.on("text", (delta: string) => process.stdout.write(delta));
    const final = await stream.finalMessage();
    process.stdout.write("\n");

    const fullText = final.content
      .filter(
        (b: { type: string }): b is { type: "text"; text: string } => b.type === "text",
      )
      .map((b: { text: string }) => b.text)
      .join("");

    turns.push({ role: "assistant", text: fullText });

    const vision = extractVision(fullText);
    if (vision) {
      await writeFile(VISION_PATH, vision + "\n", "utf8");
    }

    if (final.usage.cache_read_input_tokens > 0) {
      console.log(
        `[cache: read ${final.usage.cache_read_input_tokens}, write ${final.usage.cache_creation_input_tokens}, fresh ${final.usage.input_tokens}]`,
      );
    }

    if (fullText.includes(LOCK_TOKEN)) {
      console.log("\n[vision locked — exiting]");
      break;
    }

    const next = (await rl.question("\nyou> ")).trim();
    if (next.toLowerCase() === "done" || next === "") {
      console.log("[exiting]");
      break;
    }
    userTurn = next;
  }

  rl.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
