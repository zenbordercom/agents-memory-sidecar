#!/usr/bin/env node
import { migrate } from "./db.js";

migrate().catch((error) => {
  console.error(error);
  process.exit(1);
});
