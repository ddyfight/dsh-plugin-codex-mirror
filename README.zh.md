# DSH Codex 实时镜像

[English](README.md) | 中文

在 DeepSeek Harness 里实时只读查看本机 Codex 会话，把会话或消息引用到当前 DSH 工作里，
再把 DSH 的进展整理成一份经你确认的交接文件交回 Codex。不用复制粘贴，也不会改动 Codex 的任何东西。

## 功能

- **实时只读镜像。** 每秒读取 `~/.codex/sessions` 与 `~/.codex/archived_sessions`，并且是增量的：
  首次扫描之后只解析新追加的字节。
- **一份看得懂的会话列表。** Codex 会把子代理和自动审查的记录写进同一棵会话树，本插件会把它们
  识别出来并默认隐藏，列表里只留下你自己的对话；切到「全部」时会用徽标标出内部会话。
- **只看真实对话，不看模板。** `# AGENTS.md instructions`、`<environment_context>`、权限说明块、
  附件前言和 Guardian 审查提示都会标为「系统上下文」并折叠；附件清单会被剥离，但你在附件之后
  写的正文会保留。
- **引用到 DSH。** 右键会话或消息（也可以点悬停出现的按钮），把引用追加到当前草稿，或者新建一个
  已经填好引用的独立 DSH 会话。插件不会替你发送——任务要求由你补充后自己点发送。
- **把进展交接回 Codex。** 点「写入 DSH 进展」会读取当前 DSH 会话最近已落盘的用户与助手正文，
  让你核对、编辑，然后写出一份带哈希、历史版本不可变的交接文件，并给出可直接粘贴到原 Codex
  会话的接续指令。
- **搜索与导航。** 搜索框既过滤会话列表，也会在当前对话里高亮匹配；`j`/`k` 切换会话，`/` 聚焦搜索，
  `r` 刷新，`q` 引用当前会话，`Shift+Q` 引用到新会话。
- **跟随主题。** 面板会读取 DSH 的明暗主题，并在主题切换时同步更新。

## 安装

从 GitHub 安装：

```sh
dsh plugin --profile <profile> add github:ddyfight/dsh-plugin-codex-mirror
```

用 Release 里附带的预构建 tarball：

```sh
dsh plugin --profile <profile> add https://github.com/ddyfight/dsh-plugin-codex-mirror/releases/download/v1.1.2/dsh-plugin-codex-mirror-1.1.2.tgz
```

DSH Desktop 可以在「插件 → 添加插件」里直接填同一个 GitHub 地址或本地文件夹。

包内没有安装脚本和构建脚本：就是普通 ESM 加一个预构建好的浏览器模块。

## 使用

从左侧栏打开「Codex 实时镜像」。Codex 历史很大时首次扫描需要几秒，面板会显示扫描进度；
之后每次只读新增内容。

- 左侧列表：按「对话 / 全部 / 归档」筛选；搜索标题、工作目录或最后一条消息。
- 右侧：选中的会话，带日期分隔线，超长消息默认折叠，工作目录和会话 ID 可一键复制。
- 在会话或消息上右键会出引用菜单；鼠标悬停消息可见「引用 / 新会话 / 复制」。
- 「写入 DSH 进展」会针对当前选中的 Codex 会话准备交接对话框。

交接文件位于 `~/.dsh/codex-mirror/handoffs/<codexSessionId>/<dshSessionId>/`：
`latest.md`、`manifest.json`，以及不可变的 `history/<sha256>.md`。

## 配置

Codex 数据目录默认是 `~/.codex`。如果 Codex 把会话存在别处，可以在插件行上覆盖：

```yaml
- id: codex-mirror
  name: dsh-plugin-codex-mirror
  config:
    root: D:\other\codex-home
```

`~` 会展开。目录不存在时会当作空库处理并给出提示，而不是报错。

## 隐私与边界

- 只读：不会写入 `~/.codex`，不会碰 Codex 的认证信息、SQLite 数据库或窗口，也不会替你发送
  DSH 任务。
- HTTP 接口只接受本机回环请求，并校验 Host 与 Origin、复用 DSH 自身的认证；`POST` 只接受
  有大小上限的 JSON 请求体。
- 只镜像已经落盘的用户与助手正文。系统提示、推理、工具调用、图片和临时片段按设计排除；
  面板不会声称一个仍在运行的任务已经完成。
- Codex 没有可确认的「向运行中会话追加消息」接口，所以反向同步是文件交接，不会伪造 Codex 原生消息。
- 历史很大时，每轮只解析有限字节；首次扫描是最慢的一段，面板会显示出来。

## 开发

```sh
node --test-isolation=none --test store.test.mjs handoff.test.mjs
node verify.mjs && node verify-new-session.mjs && node verify-progress.mjs && node verify-handoff-http.mjs
```

`verify-new-session.mjs` 与 `verify-progress.mjs` 用假 context 验证 DSH 客户端桥接；
`verify.mjs` 覆盖 HTTP 处理器、CSP、来源校验和面板里的纯函数。

## 许可证

MIT
