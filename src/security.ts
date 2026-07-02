const secretPatterns = [
  /(?:^|\b)\d{8,12}:[A-Za-z0-9_-]{30,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /(?:^|\n)[A-Z0-9_]{3,}=(?:['"]?)[^\s'"]{16,}/,
  /\b(?:session|cookie|authorization)\s*[:=]\s*[A-Za-z0-9._~+/-]{20,}/i,
];

export function scanForSecrets(value: unknown): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const warnings: string[] = [];

  for (const pattern of secretPatterns) {
    if (pattern.test(text)) {
      warnings.push("suspected_secret");
      break;
    }
  }

  return warnings;
}
