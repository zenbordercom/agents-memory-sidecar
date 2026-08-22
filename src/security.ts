// Guardrail, not DLP: best-effort rejection of obvious secret-like payloads
// before they land in shared memory (review finding #10). Matches are
// attributed by rule name so operators can tune without seeing the payload.

type SecretRule = {
  name: string;
  pattern: RegExp;
};

const secretRules: SecretRule[] = [
  { name: "telegram_bot_token", pattern: /(?:^|\b)\d{8,12}:[A-Za-z0-9_-]{30,}\b/ },
  { name: "openai_api_key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "anthropic_api_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "aws_access_key_id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/,
  },
  { name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    name: "private_key_block",
    pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  },
  {
    // High false-positive rule: plain KEY=value lines. Benign keys commonly
    // present in pasted terminal output are whitelisted below.
    name: "env_assignment",
    pattern: /(?:^|\n)([A-Z0-9_]{3,})=(?:['"]?)[^\s'"]{16,}/,
  },
  {
    name: "web_session_credential",
    pattern: /\b(?:session|cookie|authorization)\s*[:=]\s*[A-Za-z0-9._~+/-]{20,}/i,
  },
];

/** Environment keys whose values are routinely long but never secret. */
const benignEnvKeys = new Set([
  "PATH",
  "HOME",
  "PWD",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "HOSTNAME",
  "TMPDIR",
  "EDITOR",
  "NODE_ENV",
]);

export function scanForSecrets(value: unknown): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return [];

  for (const rule of secretRules) {
    if (rule.name === "env_assignment") {
      // Check every assignment; a whitelisted key must not mask a suspicious
      // one elsewhere in the text.
      const global = new RegExp(rule.pattern.source, "g");
      let match: RegExpExecArray | null;
      while ((match = global.exec(text))) {
        const key = match[1];
        if (!key || !benignEnvKeys.has(key)) {
          return ["suspected_secret:env_assignment"];
        }
      }
      continue;
    }

    if (rule.pattern.test(text)) {
      return [`suspected_secret:${rule.name}`];
    }
  }

  return [];
}
