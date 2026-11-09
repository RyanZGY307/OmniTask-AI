-- 回滚：仅删本表，不碰任何既有表
DROP TABLE IF EXISTS "ConcurrencyLease";
DROP TABLE IF EXISTS "QuotaSwitchLog";
