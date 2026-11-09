-- down: 删除受控 RSI 新增的 5 张表（均为本次新建，不影响既有表）
DROP TABLE IF EXISTS "RsiJob";
DROP TABLE IF EXISTS "SystemPause";
DROP TABLE IF EXISTS "ChangeRequest";
DROP TABLE IF EXISTS "AssetVersion";
DROP TABLE IF EXISTS "ManagedAsset";
