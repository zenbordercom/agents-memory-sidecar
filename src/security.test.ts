import { strict as assert } from "node:assert";
import test from "node:test";
import { scanForSecrets } from "./security.js";

test("secret scanner accepts ordinary operational memory", () => {
  assert.deepEqual(scanForSecrets({ body: "The API listens on localhost:18790." }), []);
  assert.deepEqual(scanForSecrets(""), []);
  assert.deepEqual(scanForSecrets(undefined), []);
});

test("secret scanner attributes representative credentials by rule name", () => {
  assert.deepEqual(
    scanForSecrets("sk-proj-abcdefghijklmnopqrstuvwxyz123456"),
    ["suspected_secret:openai_api_key"],
  );
  assert.deepEqual(
    scanForSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key"),
    ["suspected_secret:private_key_block"],
  );
  assert.deepEqual(
    scanForSecrets("authorization: abcdefghijklmnopqrstuvwxyz0123456789"),
    ["suspected_secret:web_session_credential"],
  );
});

test("secret scanner covers the extended pattern library", () => {
  assert.deepEqual(scanForSecrets("key AKIAIOSFODNN7EXAMPLE in config"), [
    "suspected_secret:aws_access_key_id",
  ]);
  assert.deepEqual(
    scanForSecrets("token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
    ["suspected_secret:jwt"],
  );
  assert.deepEqual(scanForSecrets("slack xoxb-123456789012-abcdef"), [
    "suspected_secret:slack_token",
  ]);
  assert.deepEqual(scanForSecrets("bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"), [
    "suspected_secret:telegram_bot_token",
  ]);
  assert.deepEqual(scanForSecrets("ghp_abcdefghijklmnopqrstuvwxyz1234567890"), [
    "suspected_secret:github_token",
  ]);
});

test("env assignment rule whitelists benign keys but not suspicious ones", () => {
  // Benign terminal noise: not a secret.
  assert.deepEqual(
    scanForSecrets("PATH=/usr/local/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin"),
    [],
  );
  assert.deepEqual(scanForSecrets("LANG=zh_CN.UTF-8\nHOME=/home/ubuntu"), []);

  // A suspicious assignment elsewhere in the text still trips even when a
  // benign PATH= appears first.
  assert.deepEqual(
    scanForSecrets("PATH=/usr/local/bin:/usr/bin\nDATABASE_PASSWORD=correct-horse-battery-staple"),
    ["suspected_secret:env_assignment"],
  );
});
