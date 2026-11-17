# DSH Codex Mirror

一个可跨电脑安装的 DSH 插件，提供：

- 实时只读读取本机 Codex Desktop/CLI 会话；
- 右键把 Codex 会话或消息引用到当前 DSH 草稿；
- 右键新建独立 DSH 会话并自动填入引用，无需复制粘贴；
- 从当前 DSH 会话读取最近已落盘的用户/助手文本；
- 用户确认后生成带版本、来源和校验的进展交接文件，供 Codex 读取。

插件不会改写 Codex 原始 JSONL、SQLite、认证文件或 Codex 窗口，也不会自动提交 DSH 任务。引用动作只填入未发送草稿；新会话或当前会话中的任务仍需用户点击发送。

## 安装

1. 将整个 `dsh-plugin-codex-mirror` 文件夹解压到目标电脑的任意固定目录，例如：

   `D:\Tools\dsh-plugin-codex-mirror`

2. 在 PowerShell 中进入该目录，运行：

   ```powershell
   node .\install.mjs
   ```

   如果系统没有 `node`，可以使用 DSH 自带 Node：

   ```powershell
   $node = Get-ChildItem "$env:USERPROFILE\.dsh\dsh-runtimes" -Filter node.exe -Recurse | Select-Object -First 1 -ExpandProperty FullName
   & $node .\install.mjs
   ```

3. 刷新 DSH 页面。如果 DSH 没有自动重组 profile，再完全退出并重新打开 DSH。

安装脚本会：

- 在 `~/.dsh/profiles/desktop/package.json` 中加入本地 link；
- 把插件加入 desktop profile bundles；
- 在 profile 的 `node_modules` 中建立 junction/symlink；
- 修改前自动生成带时间戳的备份；
- 不覆盖已有同名且指向其他位置的插件目录。

卸载：

```powershell
node .\install.mjs --uninstall
```

卸载只移除本插件写入的 dependency、bundle 和 link，不恢复整个 profile 文件，避免覆盖其他配置。

## 使用

打开 DSH 左侧的“Codex 实时镜像”。首次扫描会读取 `~/.codex/sessions` 和 `~/.codex/archived_sessions`，之后每秒检查更新。只显示已经落盘的用户消息和助手文本，忽略系统提示、内部推理、工具调用和图片正文。

在会话或消息上右键：

- **新建 DSH 会话并引用此会话**：创建独立 DSH 会话、自动填入最近对话摘录并切换过去；
- **新建 DSH 会话并引用此消息**：只引用右键选中的消息；
- **引用会话到当前 DSH 草稿**／**引用消息到当前 DSH 草稿**：追加到当前未发送草稿，保留已有文字和附件。

引用内容包含 Codex 标题、会话 ID、工作目录和文本摘录。引用不会自动发送，补充“本次任务要求”后再点击 DSH 发送按钮。

点击“写入 DSH 进展”可把当前 DSH 主会话最近已落盘的用户任务和助手回复做成可编辑预览。保存后，交接文件默认放在：

```text
~/.dsh/codex-mirror/handoffs/<codexSessionId>/<dshSessionId>/
  latest.md
  manifest.json
  history/<sha256>.md
```

随后把界面给出的接续指令发送到原 Codex 会话。它会主动读取交接文件；原 Codex 对话不会被插件直接追加。

## 兼容性和边界

- 需要支持 DSH profile bundles、`dsh.client` 和本地插件 link 的 DSH 版本；当前开发环境为 DSH 0.2.x 系列。
- 需要 Codex 使用默认本地目录 `~/.codex`。如果目标电脑修改了 Codex 数据目录，需要修改 `index.mjs` 的 `MirrorStore` root 后重新加载插件。
- 首次读取大量历史文件可能较慢；后续读取只处理新增字节。
- 当前 DSH 的公开 API 没有可靠的“外部追加 Codex 原生 rollout 并让窗口实时重载”能力，因此反向同步使用交接文件。
- 客户端资源和 HTTP 接口复用 DSH 登录认证，并限制本机 Host/Origin；交接 POST 只接受 JSON、GET/POST 约束和大小限制。

## 文件

- `index.mjs`：宿主路由、认证、实时读取和交接保存；
- `client.js`：DSH 侧栏、镜像面板、右键引用、新会话创建和 DSH 进展读取；
- `view.html`：镜像界面、右键菜单和交接预览；
- `store.mjs`：Codex JSONL 增量读取器；
- `handoff.mjs`：按会话对隔离的交接存储；
- `install.mjs`：跨电脑安装/卸载脚本；
- `cordis.patch.yml`：DSH bundle 注册。

## 本地验证

```powershell
$node = 'C:\path\to\node.exe'
& $node --test-isolation=none --test .\store.test.mjs .\handoff.test.mjs
& $node .\verify.mjs
& $node .\verify-new-session.mjs
& $node .\verify-progress.mjs
& $node .\verify-handoff-http.mjs
```
