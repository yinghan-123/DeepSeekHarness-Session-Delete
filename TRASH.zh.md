# 回收站改造（本目录 = 上游 1.6.2 的本地修改版）

上游插件 `dsh-session-clean@1.6.2` 的「删除会话」是**硬删除**：卸载活会话 → 从注册表移除 → `rm -rf` 会话目录与缓存。
这份修改版把第 3 步换成**移入回收站**，并新增回收站面板，删错了可以捡回来。

> 目录里的 `README.md` / `README.zh.md` 是上游原文，仍描述"永久删除"，以本文为准。

## 改了什么

| 文件 | 改动 |
|---|---|
| `index.js` | `delete` 从"删除载荷"改为"移动载荷"；新增 `/trash`、`/trash/restore`、`/trash/purge`、`/trash/empty` 四条路由 |
| `client.js` | 侧栏底部新增「回收站」入口；新增回收站面板（列表 / 恢复 / 彻底删除 / 清空）；删除确认文案改为"移入回收站" |
| `package.json` | 版本 `1.6.3-trash.1`，`meta.title` 改为「删除会话（含回收站）」 |

## 回收站长什么样

```
$DSH_HOME/session-trash/
  session-<uuid>/
    meta.json          # 标题、原工作区 id/标题/路径、磁盘目录名、删除时间、归档/置顶标记
    payload/           # 原来 sessions/<workspaceDir>/<sessionId>/ 的整个目录，rename 过来的
    projcache.json     # 被删掉的投影缓存记录的字节副本（恢复时写回）
    spill/<root>/      # 该会话的溢出工具输出目录（原来在系统临时目录里）
```

`meta.json` 是恢复的唯一依据：`workspaceDir` 决定放回哪个磁盘目录，`workspaceId` 决定放回哪个分组，
`archived` / `pinned` 决定恢复后是否还在归档/置顶里。

## 恢复是怎么做到的

1. `payload/` 原路 `rename` 回 `$DSH_HOME/sessions/<workspaceDir>/<sessionId>/`；
2. 缓存副本写回 `storages/session_projcache/sessions/`（缓存本身可自愈，写回只是省一次重算）；
3. 溢出目录放回同名 spill 根（该根已不存在就跳过并记日志）；
4. 分组用**公开接口** `workspaceRegistry.get(wsId).attachSession(sessionId)` 恢复：
   它会读回会话 header、把路径记进 registry 的 `sessionPaths` 索引、换掉 record 快照并
   发 `domain/changed`。这一步不能用"直接写 domain 表"代替——`WorkspaceEntity.sessionIds`
   的 getter 会按 `sessionPaths` 过滤，绕过它只在当前页面看起来恢复了，重连 baseline
   与下次启动会掉回「未分组」。attach 失败时（原目录已不存在、realpath 对不上等）才回退
   成直接写表，并在响应里带上 `attached:false`，界面如实提示"会出现在未分组"；
5. 归档/置顶用 registry 自己的 `archiveSession` / `pinSession`（内存 state 与持久化一起走）；
6. 投影缓存优先 `session_projcache` 域 `table.put(id, record)`——运行中域的内存表才是权威，
   只把文件放回去要等重启才生效；put 失败再退回文件拷贝（缓存本身可自愈）；
7. 客户端收到结果后调 `sessions.refresh()` 重新拉列表。

DSH 的会话列表是 `session-query` 的 `listSessions` = **磁盘持久层 ∪ 活会话**，
且每次拉取都重扫磁盘（无持久索引），所以目录一回去、注册表一 attach，列表就能重新列出它
——**不需要重启**（若侧栏没刷新，刷一下页面即可）。恢复的会话排在分组最前面。

## 边界（如实说明）

- **仍驻留内存的会话不能恢复**：会返回 409 并提示重启后再恢复，否则列表里会出现两份。
- **正在运行的会话删不了**（沿用上游的忙碌闸门）；批量清空分组也是整批拦下。
- **没有落盘数据的新会话**（刚建、一个字都没写）没有可恢复内容，删除会直接消失，客户端会如实提示。
- 会话目录里只有 `session.lock` + `session.v4.jsonl.zstd`，附件在 `attachments/` 按哈希共享，**不进回收站、也不删**（与上游一致）。
- 回收站**不会自动过期清理**：永久删除只有「彻底删除」「清空回收站」两个动作。
- 上游的 `README` 里"删除不可恢复"的说法在修改版里只对回收站内动作成立。

## 部署与回滚

- 安装位置：`$DSH_HOME/profiles/ondevice/node_modules/dsh-session-clean/`
- 本次部署的三个文件：`index.js`、`client.js`、`package.json`
- 原始 1.6.2 备份在 `.orig-1.6.2/`，回滚 = 把这三个文件拷回去再重启 DSH
- **改完必须重启 DSHM 才生效**（host 半的插件没有热重载）；重启前旧进程仍在跑旧代码，此时的删除仍是硬删除

## 验证记录

见 `$DSH_HOME/logs/session-delete.log`：`已移入回收站 …` / `已恢复会话 …` / `彻底删除 …` / `清空回收站: N 个条目`。
