# User Instruction Memory

## Format

### Project Knowledge Entry
Project knowledge entries should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: [Scenario or time when mentioned]
- Category: [Operations/Deployment|Build/Compile|Troubleshooting/Debugging|Workflow/Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, each item on a separate line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[Project Knowledge Summary]
- Date: 2026-10-02
- Context: Agent discovered during 4-Postgres Layerbase DB migration
- Category: Operations/Deployment
- Instructions:
  - Layerbase Postgres poolers sleep when idle; first connect can stall 10-30s. Always use a 45s connection timeout + 5x retry loop for boot and migrations.
  - All 4 Layerbase DBs use port 5432 + sslmode=require (not 6543).
  - The pg module is not in server/package.json deps; it was installed with --no-save for the migration scripts. Scripts under scripts/ rely on it at runtime.
  - 4-DB env vars: DATABASE_URL_USER, DATABASE_URL_CONVERSATION, DATABASE_URL_KNOWLEDGE, DATABASE_URL_OVERFLOW (all in server/.env, gitignored).
  - prisma:generate runs 5 schemas; @prisma/client-user backs prismaUser (default @prisma/client is stale, do NOT import it in db.ts).
  - prisma/migrations-*.sql are generated with `prisma migrate diff --from-empty --to-schema-datamodel`; apply via scripts/applyMigrations.js (idempotent, CREATE TABLE IF NOT EXISTS + per-statement fallback on batch failure).
  - db.ts exports startKeepAlive(60_000) which must be called once at boot to keep all 4 poolers warm.
