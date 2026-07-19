import { strict as assert } from "node:assert";
import test from "node:test";
import { scanForSecrets } from "./security.js";

test("secret scanner accepts ordinary operational memory", () => {
  assert.deepEqual(scanForSecrets({ body: "The API listens on localhost:18790." }), []);
});

test("secret scanner rejects representative credentials", () => {
  assert.deepEqual(scanForSecrets("sk-proj-abcdefghijklmnopqrstuvwxyz123456"), ["suspected_secret"]);
  assert.deepEqual(
    scanForSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key"),
    ["suspected_secret"],
  );
  assert.deepEqual(
    scanForSecrets("authorization: abcdefghijklmnopqrstuvwxyz0123456789"),
    ["suspected_secret"],
  );
});
