-- 下行：只删本迁移建的两张表（不碰其它额度表）。
DROP INDEX IF EXISTS "QuotaReservation_requestId_idx";
DROP INDEX IF EXISTS "QuotaReservation_origin_createdAt_idx";
DROP INDEX IF EXISTS "QuotaReservation_status_expiresAt_idx";
DROP INDEX IF EXISTS "QuotaReservation_reservationKey_key";
DROP TABLE IF EXISTS "QuotaReservation";
DROP INDEX IF EXISTS "QuotaLedger_scopeId_windowKind_windowKey_idx";
DROP INDEX IF EXISTS "QuotaLedger_scopeKey_key";
DROP TABLE IF EXISTS "QuotaLedger";
