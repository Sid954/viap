# Phase 2 classification — 2026-10-24

Entry classes: {"U":1298,"B":7,"A":7} (A+B = exact-match and substring both)

## A / B / C occurrence table (logic sites only)

| class | literal | site | decision |
|---|---|---|---|
| A | `安装目录` | src-tauri/src/app_manager/uninstall_snapshot.rs:356 | exact-match compare == — translate via shared id |
| A | `安装目录` | src-tauri/src/app_manager/uninstall_snapshot.rs:502 | exact-match compare == — translate via shared id |
| C | `需要提升` | src-tauri/src/app_manager/uninstaller.rs:1694 | deny occurrence (.contains on "normalized") |
| C | `卸载` | src-tauri/src/app_manager/uninstaller.rs:2979 | deny occurrence (.contains on "lower") |
| A | `系统目录` | src-tauri/src/migration/danger_rules.rs:199 | exact-match match-arm — translate via shared id |
| A | `浏览器` | src-tauri/src/migration/danger_rules.rs:200 | exact-match match-arm — translate via shared id |
| A | `GPU驱动` | src-tauri/src/migration/danger_rules.rs:201 | exact-match match-arm — translate via shared id |
| A | `办公软件` | src-tauri/src/migration/danger_rules.rs:202 | exact-match match-arm — translate via shared id |
| A | `运行时` | src-tauri/src/migration/danger_rules.rs:203 | exact-match match-arm — translate via shared id |
| A | `开发工具` | src-tauri/src/migration/danger_rules.rs:204 | exact-match match-arm — translate via shared id |
| C | `拒绝访问` | src-tauri/src/migration/mod.rs:628 | deny occurrence (.contains on "e") |
| B | `取消` | src/components/LinkRecoveryModal.tsx:163 | pin fragment (TS .includes on backend message "message") |
| A | `系统目录` | src/hooks/useDangerousPathCheck.ts:385 | exact-match object-key — translate via shared id |
| A | `浏览器` | src/hooks/useDangerousPathCheck.ts:386 | exact-match object-key — translate via shared id |
| A | `GPU驱动` | src/hooks/useDangerousPathCheck.ts:387 | exact-match object-key — translate via shared id |
| A | `办公软件` | src/hooks/useDangerousPathCheck.ts:388 | exact-match object-key — translate via shared id |
| A | `运行时` | src/hooks/useDangerousPathCheck.ts:389 | exact-match object-key — translate via shared id |
| A | `开发工具` | src/hooks/useDangerousPathCheck.ts:390 | exact-match object-key — translate via shared id |
| B | `卸载命令执行失败` | src/pages/AppMigration.tsx:1086 | pin fragment (TS .includes on backend message "errStr") |
| B | `仍检测到应用存在` | src/pages/AppMigration.tsx:1086 | pin fragment (TS .includes on backend message "errStr") |
| B | `检测到以下程序正在运行` | src/pages/AppMigration.tsx:1342 | pin fragment (TS .includes on backend message "result.message") |
| B | `检测到以下程序` | src/pages/AppMigration.tsx:1346 | pin fragment (TS .includes on backend message "l") |
| B | `用户取消了迁移` | src/pages/AppMigration.tsx:1374 | pin fragment (TS .includes on backend message "errStr") |
| B | `检测到以下程序正在运行` | src/pages/AppMigration.tsx:1591 | pin fragment (TS .includes on backend message "result.message") |
| B | `检测到以下程序` | src/pages/AppMigration.tsx:1593 | pin fragment (TS .includes on backend message "l") |
| B | `用户取消了迁移` | src/pages/AppMigration.tsx:1684 | pin fragment (TS .includes on backend message "errStr") |
| B | `用户取消了迁移` | src/pages/LargeFolders.tsx:680 | pin fragment (TS .includes on backend message "errStr") |
| B | `检测到以下程序正在运行` | src/pages/LargeFolders.tsx:835 | pin fragment (TS .includes on backend message "result.message") |
| B | `检测到以下程序` | src/pages/LargeFolders.tsx:837 | pin fragment (TS .includes on backend message "l") |
| B | `用户取消了迁移` | src/pages/LargeFolders.tsx:927 | pin fragment (TS .includes on backend message "errStr") |
| B | `另一个恢复任务` | src/pages/MigrationHistory.tsx:581 | pin fragment (TS .includes on backend message "result.message") |

## B fragments → pinned messages

### `卸载命令执行失败` (20df82c095d66141)
- `{P1}：{0}` (b2e9656a3ccdbbfb)

### `用户取消了迁移` (3936f6a6e6949adb)
- `{P1}（目标路径已存在）` (01a6e2daab56e278)
- `{P1}（目标路径已存在残留目录）` (ac9315ea705e2261)

### `取消` (4d0b4688c787cf6c) deps: 3936f6a6e6949adb
- `用户{P1}了迁移（目标路径已存在）` (01a6e2daab56e278)
- `检测已{P1}` (0b003e14aa50f068)
- `{P1}迁移` (1017b0536616f2cd)
- `正在{P1}迁移...` (31e0537932d73f09)
- `用户{P1}了迁移` (3936f6a6e6949adb)
- `迁移被{P1}` (61a71035949b27d4)
- `{P1}下载` (7115f2e29d8e214c)
- `{P1}全选` (78fe5b036cd3d99f)
- … 7 more

### `另一个恢复任务` (7cf0c5b6b19c8be3)
- `{P1}正在进行中，请等待完成后再试` (d96841454ca90cfe)

### `检测到以下程序` (9277248a3ee83cf8) deps: b4af90d71ac41eb3
- `{P1}正在运行，请关闭后重试：
{0}` (8d29239f7e2d9765)
- `{P1}正在运行` (b4af90d71ac41eb3)
- `{P1}正在运行，请关闭后重试：
{0}

恢复前必须关闭相关程序，否则文件移动可能失败并导致数据损坏。` (c27522dff73428ff)
- `{P1}正在运行，请关闭后重试：
{0}

恢复前必须关闭应用，否则文件移动可能失败并导致数据损坏。` (ebb4465fa57b6443)

### `检测到以下程序正在运行` (b4af90d71ac41eb3)
- `{P1}，请关闭后重试：
{0}` (8d29239f7e2d9765)
- `{P1}，请关闭后重试：
{0}

恢复前必须关闭相关程序，否则文件移动可能失败并导致数据损坏。` (c27522dff73428ff)
- `{P1}，请关闭后重试：
{0}

恢复前必须关闭应用，否则文件移动可能失败并导致数据损坏。` (ebb4465fa57b6443)

### `仍检测到应用存在` (dbc7ec2a7a0f3dc1)
- `卸载命令已执行，但{P1}：可能卸载程序还在后台运行，或未在卸载向导中确认完成：{0}` (a3487eed76a4a664)

