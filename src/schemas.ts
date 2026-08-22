import { z } from "zod";

// Field-level contracts shared by the MCP and HTTP entry points so both
// enforce identical rules regardless of transport (review finding #13).
// Entry-specific behaviour such as defaults (tenant -> "default", namespace
// -> "ops", limit -> 5) stays at each entry point; only the constraints live
// here.

export const tenantSchema = z.string().min(1);
export const projectSchema = z.string().min(1);
export const namespaceSchema = z.string().min(1);

/** Memory bodies are capped at 64 KB of text. */
export const memoryBodySchema = z.string().min(1).max(64_000);
/** Memory summaries are capped at 4 KB of text. */
export const memorySummarySchema = z.string().min(1).max(4_000);
/** Observations are capped at 32 KB of text. */
export const observationTextSchema = z.string().min(1).max(32_000);

/** Confidence is a finite number between 0 and 1 inclusive. */
export const confidenceSchema = z.number().finite().min(0).max(1);
/** Search page size: integer 1..20. */
export const searchLimitSchema = z.number().int().finite().min(1).max(20);
/** Observation TTL: whole days, 1..180. */
export const ttlDaysSchema = z.number().int().finite().min(1).max(180);

export const searchModeSchema = z.enum(["keyword", "semantic", "hybrid"]);
export const sourceTypeSchema = z.enum([
  "user",
  "agent",
  "file",
  "command",
  "url",
  "system",
  "manual",
  "import",
]);

/** Query embeddings must be a non-empty array of finite numbers. */
export const embeddingVectorSchema = z.array(z.number().finite()).min(1);

export const metadataSchema = z.record(z.string(), z.unknown());
