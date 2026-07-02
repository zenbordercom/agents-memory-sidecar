# Contributing

Contributions are welcome.

Before opening a pull request:

```bash
npm run typecheck
npm run build
npm run smoke
npm run http:smoke
npm run http:bridge-smoke
```

Do not commit:

- full bearer tokens
- private keys
- database credentials
- backup passphrases
- machine-specific production runbooks
- raw `.env` files
