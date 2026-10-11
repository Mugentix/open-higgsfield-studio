/* Prints the createTask body every catalog entry would send, or submits one
   task per entry and polls it. Nothing is submitted without --live --confirm.

     pnpm probe                          # every entry, every shape, dry run
     pnpm probe --model nano-banana-pro  # one entry
     pnpm probe --live --confirm --model nano-banana-pro --prompt "a red mug"
     pnpm probe --live --confirm --model seedance-2-fast --start https://…/frame.png

   Reads KIE_API_KEY from the environment; `pnpm probe` loads .env.local. */

import { MODELS, getModel, parseSettings } from "../src/generation/catalog";
import type { GenerationPlane, KieShape, MediaRole, ModelEntry } from "../src/generation/catalog/types";
import { createKieClient } from "../src/generation/kie/client";
import { toStatus } from "../src/generation/platform";
import { toKieFor } from "../src/generation/to-kie";

type Args = {
  models: string[];
  shapes: KieShape[];
  live: boolean;
  confirm: boolean;
  prompt: string;
  media: Partial<Record<MediaRole, string[]>>;
  pollMs: number;
  timeoutMs: number;
};

const PLACEHOLDER: Record<MediaRole, string> = {
  start: "https://example.com/start.png",
  end: "https://example.com/end.png",
  reference: "https://example.com/reference.png",
  video: "https://example.com/clip.mp4",
  audio: "https://example.com/track.wav",
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    models: [],
    shapes: [],
    live: false,
    confirm: false,
    prompt: "A matte ceramic espresso cup on wet slate, rim light, product photo",
    media: {},
    pollMs: 5000,
    timeoutMs: 15 * 60_000,
  };
  const roles: Record<string, MediaRole> = {
    "--start": "start",
    "--end": "end",
    "--ref": "reference",
    "--video": "video",
    "--audio": "audio",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--model") args.models.push(next());
    else if (arg === "--shape") args.shapes.push(next() as KieShape);
    else if (arg === "--live") args.live = true;
    else if (arg === "--confirm") args.confirm = true;
    else if (arg === "--prompt") args.prompt = next();
    else if (arg in roles) {
      const role = roles[arg]!;
      (args.media[role] ??= []).push(next());
    } else throw new Error(`Unknown argument ${arg}`);
  }
  return args;
}

/** The media a shape needs, from the flags or from placeholders in a dry run. */
function mediaFor(model: ModelEntry, shape: KieShape, args: Args): GenerationPlane["media"] | null {
  const want: MediaRole[] =
    shape === "text" ? [] : shape === "image" ? ["start"] : shape === "firstLast" ? ["start", "end"] : ["reference"];
  const media: GenerationPlane["media"] = {};
  for (const role of want) {
    if (!model.roles[role]) continue;
    const urls = args.media[role] ?? (args.live ? [] : [PLACEHOLDER[role]]);
    if (urls.length === 0) return null;
    media[role] = urls.map((url, index) => ({ id: `${role}-${index}`, url, role }));
  }
  if (shape === "reference") {
    for (const role of ["video", "audio"] as const) {
      /* A tool that takes only a clip has no reference to stand in for it, so
         the dry run gets the clip placeholder instead of a refusal. */
      const fallback = role === "video" && !model.roles.reference && !args.live ? [PLACEHOLDER.video] : [];
      const urls = args.media[role] ?? fallback;
      if (urls.length && model.roles[role]) {
        media[role] = urls.map((url, index) => ({ id: `${role}-${index}`, url, role }));
      }
    }
  }
  return media;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const entries = args.models.length ? args.models.map(getModel) : [...MODELS];
  const apiKey = process.env.KIE_API_KEY?.trim();
  if (args.live && !apiKey) throw new Error("KIE_API_KEY is not set");
  if (args.live && !args.confirm) throw new Error("--live submits paid tasks; add --confirm");
  const kie = args.live && apiKey ? createKieClient({ apiKey }) : null;

  if (kie) console.log(`credits before: ${await kie.credits()}`);

  for (const model of entries) {
    const shapes = (Object.keys(model.kie.models) as KieShape[]).filter(
      (shape) => args.shapes.length === 0 || args.shapes.includes(shape),
    );
    for (const shape of shapes) {
      const media = mediaFor(model, shape, args);
      if (!media) {
        console.log(`\n## ${model.id} [${shape}] skipped: pass --start/--end/--ref for this shape`);
        continue;
      }
      const plane: GenerationPlane = {
        model: model.id,
        prompt: { text: args.prompt },
        media,
        settings: parseSettings(model, {}),
      };
      let request;
      try {
        request = toKieFor(plane, model);
      } catch (caught) {
        console.log(`\n## ${model.id} [${shape}] refused: ${(caught as Error).message}`);
        continue;
      }
      console.log(`\n## ${model.id} [${shape}] → ${request.model}${model.kie.enabled === false ? " (gated)" : ""}`);
      console.log(JSON.stringify(request.input, null, 2));
      if (!kie) continue;

      const { taskId } = await kie.createTask(request);
      console.log(`task ${taskId}`);
      const deadline = Date.now() + args.timeoutMs;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, args.pollMs));
        const record = await kie.recordInfo(taskId);
        const status = toStatus(record);
        if (status.status === "running") {
          if (Date.now() > deadline) {
            console.log(`  still ${record.state} after ${args.timeoutMs / 60_000} min; giving up the watch`);
            break;
          }
          continue;
        }
        console.log(`  ${record.state}: ${JSON.stringify(status)}`);
        if (record.lastFrameUrls.length) console.log(`  last frame: ${record.lastFrameUrls.join(", ")}`);
        break;
      }
      /* Live runs are one shape per entry: the text shape proves the route,
         the rest is the mapper's job and the tests' job. */
      break;
    }
  }

  if (kie) console.log(`\ncredits after: ${await kie.credits()}`);
}

main().catch((caught) => {
  console.error(caught instanceof Error ? caught.message : caught);
  process.exit(1);
});
