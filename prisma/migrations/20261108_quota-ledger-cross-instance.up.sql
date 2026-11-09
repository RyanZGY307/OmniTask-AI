-- 跨实例三级额度账本（替代进程内滑动窗口）。幂等；down 只删这两张表。
CREATE TABLE IF NOT EXISTS "QuotaLedger" (
  "id"             TEXT NOT NULL,
  "scopeKey"       TEXT NOT NULL,
  "level"          TEXT NOT NULL,
  "scopeId"        TEXT NOT NULL,
  "windowKind"     TEXT NOT NULL,
  "windowKey"      TEXT NOT NULL,
  "reqCount"       INTEGER NOT NULL DEFAULT 0,
  "tokReserved"    INTEGER NOT NULL DEFAULT 0,
  "tokCommitted"   INTEGER NOT NULL DEFAULT 0,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuotaLedger_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "QuotaLedger_scopeKey_key" ON "QuotaLedger"("scopeKey");
CREATE INDEX IF NOT EXISTS "QuotaLedger_scopeId_windowKind_windowKey_idx" ON "QuotaLedger"("scopeId", "windowKind", "windowKey");

CREATE TABLE IF NOT EXISTS "QuotaReservation" (
  "id"              TEXT NOT NULL,
  "reservationKey"  TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'reserved',
  "estTokens"       INTEGER NOT NULL DEFAULT 0,
  "committedTokens" INTEGER NOT NULL DEFAULT 0,
  "scopes"          TEXT NOT NULL DEFAULT '[]',
  "origin"          TEXT NOT NULL DEFAULT 'other',
  "provider"        TEXT,
  "tier"            TEXT,
  "apiKey"          TEXT,
  "modelKey"        TEXT,
  "requestId"       TEXT,
  "note"            TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt"       TIMESTAMP(3),
  "expiresAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QuotaReservation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "QuotaReservation_reservationKey_key" ON "QuotaReservation"("reservationKey");
CREATE INDEX IF NOT EXISTS "QuotaReservation_status_expiresAt_idx" ON "QuotaReservation"("status", "expiresAt");
CREATE INDEX IF NOT EXISTS "QuotaReservation_origin_createdAt_idx" ON "QuotaReservation"("origin", "createdAt");
CREATE INDEX IF NOT EXISTS "QuotaReservation_requestId_idx" ON "QuotaReservation"("requestId");
