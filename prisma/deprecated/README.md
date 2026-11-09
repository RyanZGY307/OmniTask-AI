# 已停用文件

`migrations-rsi-20261107.down.sql` —— 早期写在 migrations/ 目录外的孤儿下行迁移副本，
内容与 `migrations/20261107_rsi-controlled-lifecycle.down.sql` 重复。
正式执行器只读 migrations/ 目录（scripts/applyRsiMigrations.js），该文件永不被引用，
按「停用」分类移入此处并保留 git 历史，未删除。
