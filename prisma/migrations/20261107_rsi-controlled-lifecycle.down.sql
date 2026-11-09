-- 下行迁移：仅删除本次新增的四张表；不动任何既有表。
-- 执行条件：四张表内数据已确认无需保留。建议先备份。
DROP TABLE IF EXISTS "SystemPause";
DROP TABLE IF EXISTS "ChangeRequest";
DROP TABLE IF EXISTS "AssetVersion";
DROP TABLE IF EXISTS "ManagedAsset";
