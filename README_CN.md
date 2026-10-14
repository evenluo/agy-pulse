<div align="center">
  <img src="assets/logo.svg" width="108" height="108" alt="Context & TPS Monitor Logo" />
  <h1>Antigravity Context & TPS Monitor</h1>
  <p>
    <strong>面向 Google Antigravity 2.0 的原生 Sidecar UI 扩展与插件</strong><br/>
    实时监控双轨 Context 窗口水位（<code>1.05M</code> 物理窗口 & <code>256k</code> 自动压缩线）、Prompt Cache 缓存命中率、分模型 API 费用与缓存立省估算（含 <code>&gt;200k</code> 阶梯翻倍计价）、首字延迟（TTFT）以及体感 E2E / 流式 Decode TPS。
  </p>
  <p>
    <a href="README.md"><strong>🌐 English Documentation (README.md)</strong></a> ·
    <a href="#快速安装"><strong>⚡ 快速安装</strong></a> ·
    <a href="#核心特性"><strong>✨ 核心特性</strong></a> ·
    <a href="#架构设计"><strong>🏗️ 架构设计</strong></a>
  </p>
</div>

---

## 为什么需要这个扩展？

在 **Google Antigravity 2.0** 中进行长链路多步 Agent 编程时，开发者最常遇到两个痛点：
1. **“明明 Gemini 3.1 / 4 Pro 标称 1M Context，为什么到 20 多万 Token 就会触发自动压缩，或者 API 等效成本突然翻倍？”**
   - Antigravity 内置的 Checkpointer 默认在 **`256k` Token** 附近触发上下文自动压缩；而 Gemini 与 Claude 官方 API 均在单轮输入超过 **`200k` Token** 时触发阶梯翻倍计价。
2. **“当前回复变慢，到底慢在首字延迟（TTFT）、隐式思考（Thinking Tokens）过多，还是流式解码（Decode TPS）降速？”**

**Antigravity Context & TPS Monitor** 基于 Antigravity 2.0 原生 **Sidecar UI Extension (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`)** 机制构建，直接内嵌在右侧辅助栏（Auxiliary Pane），**零外部依赖、100% 离线内联样式、自动同步宿主深浅色主题、支持中英双语一键切换**。

---

## ✨ 核心特性

- **双轨 Context 窗口水位（Option A 严格对齐设计）**：
  - **主轨（`1.05M` 物理窗口进度条）**：进度条宽度与物理窗口百分比严格 1:1 对齐，并内嵌 **`▲ 200k 阶梯价线 (19.1%)`** 与 **`▲ 256k 自动压缩线 (24.4%)`** 双标尺。
  - **副轨（`256k` Checkpointer 自动压缩水位条）**：按压缩风险自动三色预警（`<60%` 绿色安全区 · `60–85%` 黄色预警 · `>85%` 红色即将压缩），并自动统计会话已发生的 `CHECKPOINT` 压缩次数。
- **实时体感速度（E2E TPS）、纯流式解码（Decode TPS）与首字延迟（TTFT）**：
  - 严格区分 **含 TTFT 的端到端体感速度（`E2E TPS`）**、**纯流式解码速度（`Decode TPS`）** 以及 **扣除 Thinking Token 后的可见正文速度（`Visible TPS`）**。
  - 自动剔除异常中断轮次（`ERROR_MESSAGE`）与单包缓冲假峰值（`streamSec < 0.15s`），采用总 Token / 总有效耗时的时间加权均值。
- **Prompt Cache 缓存命中率 & 分模型 API 费用精算（含 `>200k` 阶梯价）**：
  - 自动识别会话中途切换模型（支持 **Gemini 3.1 / 4 Pro**、**Gemini 2.5 Pro**、**Gemini Flash**、**Claude Sonnet 4.x**、**Claude Opus 4.x**），按每一轮实际使用的模型与是否超过 `200k` 阶梯线分别计费。
  - 直观展示分模型费用占比、吞吐分布，以及 **Prompt Cache 命中为你节省的真实美元金额与折扣比例**。
- **RPC 毫秒级遥测 + 本地 Transcript JSONL 双源融合**：
  - 在线时通过 Sidecar 注入的 `ANTIGRAVITY_LS_ADDRESS` 与 `ANTIGRAVITY_CSRF_TOKEN` 直连本地 Language Server (`GetCascadeTrajectoryGeneratorMetadata`) 获取毫秒级 TTFT 与流式耗时。
  - 自动融合并支持回退读取 `~/.gemini/antigravity-*/brain/<id>/.system_generated/logs/transcript.jsonl`，可随时切换查看历史会话。

---

## ⚡ 快速安装

> **环境要求**：Node.js `>= 18.0.0`（仅使用 Node.js 标准库内置模块，无需 `npm install` 任何第三方依赖）。

### 方式一：一行命令极速安装（推荐）

克隆仓库并运行零依赖安装脚本（自动部署 Sidecar 并安全合并启用 `~/.gemini/config/config.json`，严格保留 `0600` 权限与原有配置）：

```bash
git clone https://github.com/evenluo/antigravity-context-monitor.git
node antigravity-context-monitor/install.mjs
```

或者以**完整 Antigravity Plugin 插件包**模式安装（同时安装 UI Sidecar 与配套 Agent Skill）：

```bash
node antigravity-context-monitor/install.mjs --plugin
```

### 方式二：通过 Antigravity CLI (`agy`) 安装

```bash
agy plugin install https://github.com/evenluo/antigravity-context-monitor
# 随后运行插件内置脚本开启 config.json 中的 sidecar 开关：
node ~/.gemini/config/plugins/context-monitor/install.mjs
```

### 方式三：团队代码库共享（`.agents/`）

将本仓库放入项目根目录的 `.agents/plugins/context-monitor/`，团队成员打开项目即可自动加载。

---

## 🚀 使用方式

1. 首次创建 Sidecar 目录后，**重启一次 Antigravity 2.0**（或重新打开窗口）以完成 Sidecar 注册。
2. 在 Antigravity 2.0 右侧辅助栏（Auxiliary Pane）顶部标签页点击 **`Context & TPS`**，或者直接在聊天框对 Agent 说：
   > *“打开 Context & TPS 监控面板”*
   Agent 会自动调用内置 Skill 并输出一键打开胶囊 `[Context & TPS](sidecar://context-monitor/)`。
3. 点击面板右上角的 **`EN` / `中文`** 按钮可随时切换中英文界面。

### 常用维护命令

```bash
# 查看当前安装状态与 config.json 启用状态
node install.mjs --status

# 卸载并自动在 config.json 中关闭 Sidecar
node install.mjs --uninstall
```

---

## 🏗️ 架构设计

```text
antigravity-context-monitor/
├── plugin.json                         # Antigravity 标准插件清单
├── install.mjs                         # 零依赖安装与 config.json 生命周期管理脚本
├── assets/
│   └── logo.svg                        # 预留 >10% 安全边距的高对比度方形 SVG 图标
├── sidecars/
│   └── context-monitor/
│       ├── sidecar.json                # 声明 SIDECAR_UI_ENTRYPOINT_AUX_PANE 辅助栏视图
│       └── server.mjs                  # 零依赖 Node.js 遥测服务与中英双语离线 UI
├── skills/
│   └── context-monitor/
│       └── SKILL.md                    # 配套 Agent Skill（支持胶囊唤起与自动启用引导）
└── test/
    └── server.test.mjs                 # 自动化单元与集成测试套件 (node --test)
```

---

## 🧪 本地开发与测试

```bash
# 运行完整单元测试与集成测试
npm test

# 独立启动监控服务用于浏览器本地调试 (http://127.0.0.1:18990)
npm start
```

## 📄 开源协议

[MIT License](./LICENSE) © 2026 evenluo
