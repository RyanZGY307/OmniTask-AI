// ================================================================
// Load .env into process.env as early as possible.
//
// This module MUST be imported before any module that reads
// process.env (notably ./config, which reads process.env at
// import time). Prisma reads .env itself for its schema URLs; the
// app code must see the same values.
//
// dotenv ships transitively via the Prisma toolchain; guard so a
// missing dep never blocks startup (in that case the surrounding
// shell/CI env vars are used as-is).
// ================================================================

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv');
  dotenv.config();
} catch {
  // No dotenv available — fall back to whatever env the runtime has.
}

export {};
