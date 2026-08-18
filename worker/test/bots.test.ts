import assert from "node:assert/strict";
import test from "node:test";
import { botSystemAddon, validateBotInput } from "../src/bots.ts";

test("validateBotInput accepts yololobster-style profiles", () => {
  const result = validateBotInput(
    {
      handle: "yololobster",
      display_name: "Yolo Lobster",
      persona: "High risk, high reward",
      system_prompt_extra: "Chase asymmetric upside.",
      seed_prompts: ["Find lottery-ticket calls with real flow."],
      enabled: true,
    },
    { requireHandle: true },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.handle, "yololobster");
  assert.equal(result.value.persona, "High risk, high reward");
  assert.deepEqual(result.value.seed_prompts, ["Find lottery-ticket calls with real flow."]);
});

test("validateBotInput rejects bad handles and empty persona", () => {
  assert.equal(validateBotInput({ handle: "1yolo", display_name: "X", persona: "Y" }, { requireHandle: true }).ok, false);
  assert.equal(validateBotInput({ handle: "ab", display_name: "X", persona: "Y" }, { requireHandle: true }).ok, false);
  assert.equal(validateBotInput({ handle: "yolo-lobster", display_name: "X", persona: "Y" }, { requireHandle: true }).ok, false);
  assert.equal(validateBotInput({ handle: "yololobster", display_name: "X", persona: "  " }, { requireHandle: true }).ok, false);
});

test("botSystemAddon includes handle and persona", () => {
  const text = botSystemAddon({
    handle: "yololobster",
    display_name: "Yolo Lobster",
    persona: "High risk, high reward",
    system_prompt_extra: "Be loud about upside.",
  });
  assert.match(text, /@yololobster/);
  assert.match(text, /High risk, high reward/);
  assert.match(text, /Be loud about upside/);
});
