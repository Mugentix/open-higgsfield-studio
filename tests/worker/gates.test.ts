import { describe, expect, it } from "vitest";

import { commandHeadline, paidGate } from "../../worker/gates";

describe("paidGate", () => {
  it.each([
    ["python3 scripts/kie.py watch --confirm-paid --max-new-jobs 2", "runs a paid step (--confirm-paid)"],
    ["cd engine && python3 engine/batch.py --plan plan.json", "a drama-ad engine step that generates on KIE"],
    ["python3 engine/make_take.py 3", "a drama-ad engine step that generates on KIE"],
    ["python engine/make_images.py", "a drama-ad engine step that generates on KIE"],
    ["python3 engine/cast_soul.py --actor a", "a drama-ad engine step that generates on KIE"],
    ["python3 scripts/kie.py submit jobs.json", "submits KIE jobs"],
    ["python3 scripts/kie.py watch", "submits KIE jobs"],
    ["curl -X POST https://api.kie.ai/api/v1/jobs/createTask -d @body.json", "calls KIE createTask directly"],
    ["python3 -c 'import higgsfield_client; higgsfield_client.run()'", "calls the Higgsfield API"],
    /* The token wherever it sits: quoted, assigned, or with the host split from the path. */
    ['python3 scripts/kie.py "watch" --max-new-jobs 2', "submits KIE jobs"],
    ["F=--confirm-paid; python3 engine/run.py $F", "runs a paid step (--confirm-paid)"],
    ["python3 -c \"from engine.batch import main; main(['--confirm-paid'])\"", "runs a paid step (--confirm-paid)"],
    ["B=https://api.kie.ai; curl -X POST $B/api/v1/jobs/createTask -d @body.json", "calls KIE createTask directly"],
    ["python3 - <<'EOF'\nimport httpx\nhttpx.post(f'{base}/api/v1/jobs/createTask', json=body)\nEOF", "calls KIE createTask directly"],
  ])("holds %s", (command, reason) => {
    expect(paidGate(command)).toEqual({ reason });
  });

  it.each([
    "ls -la outputs/",
    "ffmpeg -i in.mp4 -vf scale=1080:-2 out.mp4",
    "python3 scripts/kie.py status --job 123",
    "curl https://api.kie.ai/api/v1/jobs/recordInfo?taskId=abc",
    "pip install httpx pillow",
    "python3 scripts/qc.py --frames 0.25",
    "echo '--confirm-paid-later' > notes.txt",
    "whisper inputs/take.wav --model base",
  ])("lets %s through", (command) => {
    expect(paidGate(command)).toBeNull();
  });

  it("sees a paid call on a later line of a multi-line command", () => {
    expect(paidGate("set -e\ncd project\npython3 scripts/kie.py watch --confirm-paid --max-new-jobs 1\n")).not.toBeNull();
  });
});

describe("commandHeadline", () => {
  it("takes the first non-empty line and cuts a long one", () => {
    expect(commandHeadline("\n\n  cd engine && python3 batch.py\nmore")).toBe("cd engine && python3 batch.py");
    expect(commandHeadline("x".repeat(200), 20)).toBe(`${"x".repeat(19)}…`);
    expect(commandHeadline("")).toBe("");
  });
});
