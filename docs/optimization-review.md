# 优化评审与修复计划（v0.3.1 基线）

- 基线 commit：`49f6e95`（main，与 GitHub / npm 0.3.1 一致）
- 评审日期：2026-08-05
- 评审方式：Sisyphus（Qwen3.8-Max）代码分析 → Grok CLI 对照磁盘源码逐条敌意审核 → 人工复核 Grok 反驳点
- 结论：10 条原始建议中 8 条 CONFIRM、2 条 PARTIAL、0 条 REJECT；Grok 另发现 7 处遗漏问题，其中 1 处（migrate 假事务）列为 P0

本文档记录**经审核后**的最终问题清单与修复方向。每条附源码证据与实现陷阱；被推翻或修正的原始说法单独列在「对原始分析的纠正」。

---

## 最终优先级总览

| # | 问题 | 级别 | 位置 |
|---|------|------|------|
| 1 | `memoryAdd` check-then-insert 竞态 | **P0** | `src/pg-store.ts:235-251` |
| 2 | `migrate()` 假事务（迁移原子性失效） | **P0** | `src/db.ts:37-45` |
| 3 | 库名 / 角色名三套分裂 | **P0** | `src/db.ts:8`、`migrations/002_observation_prune_grant.sql`、docs/CI |
| 4 | 写操作与审计非事务 | P1 | `src/pg-store.ts` 各写路径 |
| 5 | Token registry 明文落盘 | P1 | `src/http.ts`、`scripts/upsert-http-token.mjs` |
| 6 | `pg-store.ts` 零单元测试，coverage 门禁刻意排除 | P1 | `package.json` coverage 脚本 |
| 7 | HTTP 六端点 auth 样板重复 | P1 | `src/http.ts:426-641` |
| 8 | MCP 声明版本停留在 0.2.1 | P1 | `src/mcp.ts:19` |
| 9 | 连接池零调优 | P2 | `src/db.ts:5-12` |
| 10 | 秘密扫描规则弱、无归因、易误报 | P2 | `src/security.ts` |
| 11 | 语义/混合搜索无 ANN 索引 | P2 | `migrations/001_initial.sql` |
| 12 | hybrid 搜索可全表扫 scope 内所有行 | P2 | `src/pg-store.ts:160-187` |
| 13 | HTTP 与 MCP 两条入口校验契约不一致 | P2 | `src/http.ts` vs `src/mcp.ts` |
| 14 | FakeStore JSON 无文件锁 | P2 | `src/store.ts` |
| 15 | schema 有 `deleted_at` 但无软删/恢复 API | P2 | store 接口 |
| 16 | 其余细节（见 P2 明细） | P2 | 各处 |

---

## P0 明细

### 1. `memoryAdd` 并发竞态 → 500 而非 `duplicate_content`

`src/pg-store.ts:235-251` 先 SELECT 查重再 INSERT，两步无事务、无 `ON CONFLICT`、无 `23505` 捕获。`migrations/001_initial.sql` 已有 partial unique index：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS memory_items_content_hash_unique
  ON memory_items (tenant, project, namespace, content_hash)
  WHERE content_hash IS NOT NULL AND deleted_at IS NULL;
```

并发路径：两请求同时 SELECT 空 → 双 INSERT → 第二个撞索引 → Postgres `23505` → 顶层 catch（`src/http.ts:131-150`）统一返回 `500 internal_error`。多 agent 并发写正是本产品核心场景，必然触发。

**修复（含审核补强的细节）：**

- 用 `INSERT ... ON CONFLICT (tenant, project, namespace, content_hash) WHERE deleted_at IS NULL DO NOTHING RETURNING id`。注意 partial index 的 `ON CONFLICT` 必须带**与索引谓词一致的 inference + WHERE**，裸 `DO NOTHING` 不能命中。
- `DO NOTHING RETURNING` 冲突时返回空集，需回查已有 id 并补 `memory.duplicate` audit，再返回 `{ accepted: false, warnings: ["duplicate_content"] }`。
- 等价替代：保持现有写法但 `catch (err) { if (err.code === "23505") ... }`，通常更简单。
- 仅去重不需要包大事务；事务需求见第 4 条。

### 2. `migrate()` 假事务（初审遗漏，Grok 发现）

`src/db.ts:37-45`：

```ts
await pool.query("BEGIN");
await pool.query(sql);          // migration DDL
await pool.query("INSERT INTO schema_migrations ...");
await pool.query("COMMIT");     // catch 中 pool.query("ROLLBACK")
```

node-pg 的 `Pool#query` 每次可能租用**不同连接**，BEGIN / DDL / COMMIT 不保证落在同一会话 → 迁移原子性是假的，**半应用 migration 有真实风险**。同仓库 `scripts/prune-observations.mjs` 才是正确写法（`pool.connect()` + `client.query`）。

**修复：**

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(sql);
  await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}
```

另：`schema_migrations` 的 check-then-insert 无并发保护，两个进程同时 `npm run db:migrate` 可竞态。建议迁移前取 `pg_advisory_lock(hashtext('agents_memory_migrate'))`，结束后释放。

### 3. 库名 / 角色名三套分裂（初审只报了一半）

实测对照：

| 位置 | 使用的名字 |
|------|-----------|
| `src/db.ts:8` 默认库名 | `agent_memory` |
| `scripts/backup-postgres.sh`、`scripts/restore-rehearsal.sh` | `agent_memory` |
| README、`.env.example`、CI `POSTGRES_DB`、docs | `agents_memory` |
| `migrations/002_observation_prune_grant.sql` 授权角色 | `agent_memory_app` |
| docs（postgres-quickstart 等）创建的角色 | `agents_memory_app` |

后果不是笔误级别：

- 裸跑 `npm run db:migrate` 会连到/建出与文档不同的库。
- 按文档建库后，migration 002 的 `IF EXISTS` 检查找不到 `agent_memory_app` → **GRANT 静默空转**，prune 脚本之后以该角色 DELETE 时无权限。

**修复：** 统一为一套名字（建议全部向 `agents_memory` / `agents_memory_app` 靠拢，与文档和 CI 一致），改 `src/db.ts` 默认值、备份脚本、并新增 migration 003 把 grant 补授给正确角色（不能只改 002，已部署环境不会重放）。

---

## P1 明细

### 4. 写操作与审计非事务（原 P0，审核后降级）

`src/pg-store.ts` 三个写路径均为两次独立 `pool.query`：

| 方法 | 写 | audit |
|------|----|-------|
| `memoryAdd` | :254-280 | :281-285 |
| `contextSet` | :324-333 | :335-338 |
| `observationAdd` | :360-378 | :379-381 |

两面后果：audit 失败 → 数据已落库但客户端收到 500（读己之写/重试语义变脏）；数据失败 → 审计缺口。

**修复：** 每个写路径包 client 级事务（写法同第 2 条）。**禁止**在 `pool.query("BEGIN")` 上假装事务。降级理由：不损坏主数据，属审计完整性问题；若把 audit 当合规硬要求可回升 P0。

### 5. Token registry 明文落盘（原 P0，审核后降级）

`src/http.ts:26`（`TokenRegistry = Record<string, TokenRegistryEntry>`，key 即明文 token）、`:319-398`（校验后原样写入）、`:783-792`（明文查表）；`scripts/upsert-http-token.mjs` 仅用 SHA-256 做**展示指纹**，落盘仍是明文（文件 mode `0o640`）。

**修复：** registry 的 key 改存 `SHA-256(token)`，lookup 时哈希后比对。注意两点（审核纠正）：

- 对象属性查找**不是**常数时间比对；若声称 timing-safe，须对固定长度 digest 显式 `crypto.timingSafeEqual`。
- 迁移面：`upsert-http-token.mjs`、README/docs 中读文件取 token 的示例、compose smoke 解析 key 的脚本都要同步改。

对 local-first、以文件为信任根的模型，明文 + 文件权限是有意设计；此项是「密钥材料落盘」加固，不是远程可利用漏洞，故 P1。

### 6. `pg-store.ts` 零单元测试

单测仅 `actor.test.ts`、`http.test.ts`、`security.test.ts`、`store.test.ts`（后者测 FakeStore）。`package.json` coverage 门禁只圈了 `src/actor.ts`、`src/security.ts`、`src/http.ts`，**刻意排除** pg-store / db / mcp / store。CI 已有 `pgvector/pgvector:pg16` service job。

**修复：** 在 CI postgres job 增加 PgStore 测试（事务回滚夹具优于 mock SQL），coverage 门禁纳入 `src/pg-store.ts` 与 `src/db.ts`。

### 7. HTTP auth 样板重复

`src/http.ts:426-641` 六个端点各自重复：解析 tenant/project → `setLogContext` → `canRead|canWrite|canAdmin` → `auditHttp(permission_denied)` → `send(403)`。顶层 catch 已支持 `HttpRequestError`（`:134-136`），403 路径却手写 return。

**修复：** 抽 `authorize(actor, tenant, project, role, operation)`，失败写审计并抛 `HttpRequestError(403, "permission_denied")`。删行预期修正为 **80–120 行**（初审估 ~150 偏乐观），新增端点不再容易漏审计。

### 8. MCP 声明版本脱节

`src/mcp.ts:19` 仍为 `version: "0.2.1"`，package.json 已是 0.3.1。协议/遥测侧显示错误版本，排障误导。**修复：** 与 package.json 同步（理想做法是构建时注入，避免再犯）。

---

## P2 明细

### 9. 连接池零调优（原 P0，审核后降级）

`src/db.ts:5-12` 无 `max` / `connectionTimeoutMillis` / `statement_timeout`。实测 pg 默认 `max: 10`、连接等待无超时。本地 sidecar 默认值尚可，故 P2。**修复：** 显式 pool 上限 + `options: "-c statement_timeout=..."`；同时明确 `DATABASE_URL` 与离散 `PGHOST/PGDATABASE` 参数的优先级（二者并存时行为依赖 pg 内部逻辑，易踩坑）。

### 10. 秘密扫描规则弱

`src/security.ts` 恰好 7 条 regex；命中只返回笼统 `suspected_secret`（`break` 掉，不归因）；缺 AWS `AKIA`、JWT（`eyJ...`）、Slack `xox[baprs]-` 等；env 赋值模式 `(?:^|\n)[A-Z0-9_]{3,}=...{16,}` 对普通长配置值易误报；`security.test.ts` 几乎无 FP 用例。**修复：** 扩模式库 + 返回命中规则名（不泄露内容）+ 高误报规则加白名单。定位仍是 guardrail，不要吹成完整 DLP。

### 11. 语义搜索无 ANN 索引

`migrations/001_initial.sql` 中 `embedding vector` **无固定维度**，无 HNSW/IVFFLAT；`<=>` 排序实质顺序扫描。**注意：** 不能照抄「加一条 HNSW」——多维并存时需每模型一张表、分区或 partial index，或先强制单一维度。先定维度策略再建索引。

### 12. hybrid 搜索全表扫风险（初审遗漏）

`src/pg-store.ts:160-187`：hybrid 的 CTE 在 tenant/project 过滤后**未强制** tsquery 命中，`WHERE keyword_score > 0 OR semantic_score IS NOT NULL` 在 CTE 外，LEFT JOIN 语义侧可拉出 scope 内全量行再排序。数据增长后比缺 HNSW 更早疼。**修复：** CTE 内收口过滤（keyword 命中或 embedding 存在），或先取 keyword top-N 与 vector top-N 再合并。

### 13. HTTP / MCP 入口校验不一致（初审遗漏）

MCP 侧：body ≤ 64_000、observation ≤ 32_000、confidence 0..1（`src/mcp.ts`）。HTTP 侧：仅整包 256KB（`src/http.ts:12`），`optionalNumber` 接受任意 number（含 NaN/Infinity）。同一 store 两条入口契约不一致。**修复：** 字段级约束下沉到共享校验层（两入口复用同一 schema 才有价值；zod 已是依赖，MCP SDK 也需要它——初审「zod 近似死重量」的说法不成立）。

### 14. FakeStore 无文件锁（初审遗漏）

`src/store.ts` load/modify/save 无锁；多进程 MCP/CLI 并发写 `data/fake-store.json` 可丢更新。Postgres 路径有 unique index 兜底，fake 路径没有。**修复：** 原子写（临时文件 + rename）+ `O_EXCL` 锁文件或 proper-lockfile 类方案；至少文档标明 fake store 不支持多进程并发。

### 15. 软删能力空洞（初审遗漏）

schema 有 `deleted_at` 且 partial unique 依赖它，但 store 接口无 delete/undelete；运维只能手搓 SQL。**修复：** 增加 admin-only 的 `memory_delete`（软删）+ 审计事件，或明确从 schema 移除该能力。

### 16. 其余细节

- `/healthz` 返回 `backend` 字段（`src/http.ts:411-412`），比 liveness 多泄露一层部署形态；loopback 下可接受，收紧则只回 `{ ok: true }`。
- `send()`（`src/http.ts:716-718`）2-space pretty-print JSON，多 agent 轮询时浪费带宽；可接受但建议可配置。
- `createHttpApp` 的 `Actor | CreateHttpAppOptions` 重载 + `isActor` 鸭子判断（`src/http.ts:235-269`）是遗留 API 负担，v0.4 移除旧签名。
- `prepare` 与 `prepack` 都跑 build：两者生命周期不同（install/clone vs pack/publish），属有意双保险，不是 bug；可择一保留（初审「冗余」说法过重）。

---

## 对原始分析的纠正（Grok 审核记录）

| 原始说法 | 纠正 |
|----------|------|
| P0-2/P0-3/P0-4 全部维持 P0 | 分别降级 P1/P1/P2；真 P0 只有竞态 + migrate 假事务 + 命名分裂 |
| 「token 哈希化顺带获得 timing-safe」 | 错。对象属性查找不是常数时间比对，须显式 `timingSafeEqual` |
| 暗示 zod 是未被利用的运行时依赖 | 不准确。MCP SDK 工具注册必须用 zod；HTTP 手写校验是风格问题不是正确性缺陷，`as any` 最小修法是 `as SourceType` |
| auth 重构可删 ~150 行 | 高估，实际 80–120 行 |
| `prepare`/`prepack` 冗余 | 过重。两个钩子生命周期不同，属双保险 |
| HNSW「加一条索引」 | 过度简化。embedding 无固定维度，需先定维度策略 |
| 库名不一致是 README 笔误 | 低估。代码默认 / 备份脚本 / grant 角色 / 文档 CI 共三套名字，会真搞挂部署 |
| 遗漏 | migrate 假事务、MCP 版本号、hybrid 全表扫、入口校验不一致、FakeStore 无锁、软删空洞、`/healthz` 泄露 |

---

## 建议修复顺序

1. **Batch 1（正确性，一个 PR）**：#1 `ON CONFLICT` 去重、#2 migrate client 事务 + advisory lock、#3 命名统一 + migration 003 补 grant、#8 MCP 版本号。
2. **Batch 2（完整性）**：#4 写路径事务、#5 token 哈希化（含脚本/文档/示例同步）。
3. **Batch 3（质量基建）**：#6 pg-store 测试进 CI + coverage 扩围、#7 auth helper。
4. **Batch 4（性能与长尾）**：#11 维度策略 + ANN、#12 hybrid 收口、#13 校验下沉、其余 P2。

每个 Batch 完成后跑全套验证：`npm run typecheck && npm test && npm run coverage && npm run docs:check`，postgres/compose smoke 依赖 CI。

## 仓库卫生（与运行时无关）

5 条已合并的远端分支可删（已用 `git merge-base --is-ancestor` 验证全部合入 main）：

```bash
git push origin --delete \
  codex/close-license-gate \
  codex/record-trusted-publishing \
  codex/release-compose-port-fix \
  codex/release-registry-retry \
  codex/v0.3-release-readiness
```
