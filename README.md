<div align="center">

# ⚡ Antigravity Proxy

**面向 Google Antigravity 原生模型的高吞吐量企业级多账号反向代理与智能调度网关**

[![Node Version](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933?logo=node.js&logoColor=white&style=flat-square)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript&logoColor=white&style=flat-square)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-4.28-000000?logo=fastify&logoColor=white&style=flat-square)](https://fastify.dev/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white&style=flat-square)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/nnnextyear/antigravity-proxy/pulls)

<p align="center">
  让 <b>Claude Code</b>、<b>Cursor</b>、<b>Codex</b> 及各类 AI 客户端无缝运行在 Google Antigravity 多账号集群上。<br/>
  兼具 <b>85%+ 官方 Prompt Cache 极速命中</b>、<b>5h 双族群配额滚动治理</b> 与 <b>企业级单号网络物理隔离</b>。
</p>

<p align="center">
  <a href="#-核心优势">核心优势</a> •
  <a href="#-系统架构">系统架构</a> •
  <a href="#-控制台体验">控制台体验</a> •
  <a href="#-快速开始">快速开始</a> •
  <a href="#-账号导入与管理">账号导入</a> •
  <a href="#-客户端接入">客户端接入</a> •
  <a href="#-配置参考">配置参考</a> •
  <a href="#-常见问题-faq">FAQ</a>
</p>

</div>

---

## 📖 简介

**Antigravity Proxy** 是一款专为 Google Antigravity 官方底座打造的高性能、企业级 AI 反向代理与多账号调度网关。底层采用 **TypeScript + Node.js 22 + Fastify + Undici / 原生 HTTP/2 双传输层** 架构，对外提供工业级多协议接口：

- 🌟 **Anthropic Messages API**：深度适配 **Claude Code CLI** 原生环境、Token 预检、上下文自动压缩及流式长思考；
- 🚀 **OpenAI Chat Completions**：无缝接入 **Cursor、NextChat、Cherry Studio、OneAPI / NewAPI、Cline / Roo Code**；
- ⚡ **Codex Responses API**：原生适配新版 **Codex / Responses API** 协议。

系统凭借**纯净会话粘性缓存锁定 (Session Sticky)**、**上游 5h 滚动双配额智能调度**、**HTTP/2 保活流式长思考防断连**与**单账号独立出口网络隔离**，让多账号集群兼具「高可用并发吞吐」与「单账号 85%~90%+ 官方 Prompt Cache 极速命中」的极致体验。

---

## ✨ 核心优势

| 🎯 会话强粘性与缓存优先 | 🌊 HTTP/2 长思考保活隧道 | 🛡️ 单账号独立出口隔离 |
| :--- | :--- | :--- |
| **85%+ Prompt Cache 命中率**<br/>基于上下文指纹强粘性锁定，同会话请求稳定路由至同一账号，彻底告别轮询击穿。 | **15s 心跳杜绝长思考断流**<br/>原生 HTTP/2 传输通道搭配预先 SSE 保活心跳帧，轻松支撑 15 分钟+ 复杂推理。 | **专号专代物理防连坐**<br/>支持为每个账号配置独立出口代理 (`proxyUrl`) 与独立连接池，上游无从关联多账号。 |

| 🧠 六档动态思考强度注入 | ⚡ 零浪费水坝调度管道 | 🛠️ 原生协议与自动压缩对齐 |
| :--- | :--- | :--- |
| **原生 `/effort` 毫秒级直达**<br/>支持 `minimal` 到 `max` 六档映射与 Token 预算约束，拒绝伪造 `-high/-low` 模型名。 | **5h 双族群滚动配额感知**<br/>实时追踪 Claude 与 Gemini 双额度，自动执行 45 分钟临期抢救与流水线顺序消耗。 | **Claude Code 自动压缩激活**<br/>精准映射上游超限至 `prompt is too long`，原生唤起客户端历史截断重试。 |

### 对比传统方案

| 核心维度 | 传统第三方反代 / 简单轮询 | ⚡ Antigravity Proxy 现代化网关 |
| :--- | :--- | :--- |
| **Prompt Cache 命中率** | ❌ 随机切号导致 Google Prompt Cache 命中率几乎为 0，响应慢且费 Token | ✅ **会话强粘性锁定 (Session Sticky)**，缓存命中率高达 **85%~90%+**，首字延迟骤降 |
| **突发并发处理** | ❌ 账号占满即漂移到新号，直接击穿上游缓存 | ✅ **账号队列平滑等待 (默认 120s)**，同对话严格 FIFO，不同根对话轮转公平派发 |
| **模型命名体系** | ❌ 充斥虚构模型或强制加 `-high/-low` 后缀 | ✅ **直连上游真实模型目录 (`agentModelSorts`)**，官方纯净版本，杜绝魔改与伪造 |
| **动态思考控制 (Thinking)** | ❌ 只能写死或切不同模型名 | ✅ **全框架动态映射**：原生支持 `/effort`、`reasoning_effort` 六档映射与 Token 预算约束 |
| **长思考 / 长文本连接** | ❌ 超过 60s 客户端静默超时断开（长思考痛点） | ✅ **HTTP/2 传输层 + SSE 预先保活**：15s 心跳帧护航，轻松支撑 15 分钟+ 复杂长思考 |
| **预检与生成流** | ❌ 预检和生成分别抢占不同槽位，引发两次排队 | ✅ **单租约贯穿整个请求**：预检与生成共用一个并发槽位，零争抢、零账号分裂 |
| **配额管理与防封** | ❌ 黑盒盲猜，耗尽后疯狂报错甚至连环被封 | ✅ **官方配额接口同步 (5h 双族群)**，真实耗尽平滑故障转移，短时限频遵守冷却退避 |
| **网络出口与隔离** | ❌ 所有账号共用单 IP，极易触发风控关联连坐 | ✅ **单账号独立出口代理 (`proxyUrl`)**，支持独立认证与独立连接池，环境高度隔离 |

---

## 🏛️ 系统架构

```mermaid
flowchart TD
    classDef client fill:#1e293b,stroke:#475569,stroke-width:1.5px,color:#f8fafc;
    classDef gateway fill:#312e81,stroke:#6366f1,stroke-width:2px,color:#f8fafc;
    classDef engine fill:#0f172a,stroke:#38bdf8,stroke-width:1.5px,color:#f8fafc;
    classDef pool fill:#14532d,stroke:#22c55e,stroke-width:1.5px,color:#f8fafc;
    classDef upstream fill:#701a75,stroke:#d946ef,stroke-width:2px,color:#f8fafc;

    subgraph Clients["🌐 全生态客户端接入层"]
        C1["Claude Code CLI\n(POST /v1/messages)"]:::client
        C2["CC Switch\n(Anthropic / OpenAI / Balance)"]:::client
        C3["Codex / Cursor\n(POST /v1/responses)"]:::client
        C4["NextChat / OneAPI / Cline\n(POST /v1/chat/completions)"]:::client
    end

    Clients -->|"统一鉴权 (Bearer / x-api-key)"| GW["⚡ Fastify 高性能网关核心\n(连接保活 / SSE 心跳 / 跨域 / 错误规整)"]:::gateway

    subgraph Core["🧠 核心调度与编排引擎"]
        GW --> Adapters["多协议双向转换器\n• Anthropic ↔ Google CloudCode\n• OpenAI ↔ Google CloudCode\n• Codex Responses ↔ Google CloudCode"]
        Adapters --> Fingerprint["会话指纹生成 (Session Key)\nHeader / Body / User / Context Hash"]
        Fingerprint --> Scheduler["🚀 零浪费智能调度引擎 (Zero-Waste Engine)"]

        subgraph Pipeline["调度与分配流水线"]
            P1["1. 强会话粘性判定\n锁定绑定账号，捍卫 Google Prompt Cache"]
            P2["2. 空闲号优先打散\n新主对话 1-to-1 均分至就绪账号"]
            P3["3. 45分钟临期抢救\n优先消耗即将到期的 5h 滚动窗口"]
            P4["4. 多主对话公平轮转\n同对话 FIFO，不同对话轮流调度"]
        end
        Scheduler --> Pipeline
    end

    subgraph AccountCluster["🛡️ 账号隔离与集群治理 (Account Pool)"]
        Acc1["账号 A (Active)\nClaude 5h: 88% | 独占代理 A"]:::pool
        Acc2["账号 B (Active)\nGemini 5h: 95% | 独占代理 B"]:::pool
        Acc3["账号 C (冷却隔离)\n遵守上游 Retry-After"]:::pool
        
        Governance["集群守护协程\n• Token 自动续期 (每 3 分钟)\n• 官方配额同步 (retrieveUserQuotaSummary)\n• 熔断器 (Breaker & Error Policy)"]
    end
    Pipeline --> AccountCluster
    Governance -.-> AccountCluster

    subgraph Network["🌐 传输网格与上游通信 (Transport Layer)"]
        H2["HTTP/2 传输通道\n(15s PING 心跳保活 / 防空闲断开)"]
        Tunnel["HTTP CONNECT 专用隧道\n(单账号独立出口隔离 / TLS 包装)"]
    end
    AccountCluster --> Network

    Network -->|"长连接与流式交互"| Upstream["☁️ Google CloudCode 生产端集群\n(daily-cloudcode-pa.googleapis.com)"]:::upstream
```

---

## 🖥️ 控制台体验

项目内置现代化暗黑科技质感管理后台（`http://localhost:3000/admin`），开箱即用，支持全维度指标监控与热操作运维：

- 🌊 **双模型水仓物理监控**：左侧水仓以动态波浪水位实时映射 **Claude 5h** 与 **Gemini 5h** 可用额度，右侧展示 7 天周度长期进度条及回满倒计时；
- 🔄 **动态调度策略热切换**：
  - **纯粘性水坝调度 (`zero-waste`)**：会话强粘性锁死最大化 Prompt Cache，新会话临期抢救 + 深度耗尽（**推荐首选**）；
  - **顺序耗尽模式 (`sequential-drain`)**：集中打满单号 5h 额度，留出整整 5 小时自然回满周期；
  - **经典负载轮询 (`round-robin`)**：全池均匀打散，适合高并发无上下文关联的短文本任务。
- ⚡ **便捷一键操作**：全局一键同步本机已登录凭据、全池真实额度同步刷新、单账号健康探测、独立代理出口热配置与账号停用/删除。
- 📋 **全环境一键复制**：顶栏原生 Base URL 与 API Key 胶囊点击即复制，内置三层降级兜底，兼容 VPS 纯 HTTP、内网 IP 及移动端环境。

---

## 🚀 快速开始

### 方式 1：Docker Compose 部署（推荐，2 分钟就绪）

在项目根目录下或任意目录创建 `docker-compose.yml`：

```yaml
version: '3.8'

services:
  antigravity-proxy:
    image: ghcr.io/nnnextyear/antigravity-proxy:latest
    build: .
    container_name: antigravity-proxy
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - HOST=0.0.0.0
      - API_MASTER_KEY=sk-antigravity
      - ADMIN_PASSWORD=admin123
      - ROUTING_STRATEGY=zero-waste
      - STREAM_KEEPALIVE_MS=15000
      - UPSTREAM_TIMEOUT_MS=900000
      - DEFAULT_PROXY_URL=http://127.0.0.1:7897
    volumes:
      - ./data:/app/data
      - ./config.json:/app/config.json
```

启动服务：
```bash
docker compose up -d
docker compose logs -f
```

---

### 方式 2：本地 Node.js 源码运行

#### 1. 环境准备
- **Node.js**: `>= v20.0.0`（推荐 Node.js 22 LTS）
- **Git**

#### 2. 克隆与安装
```bash
git clone https://github.com/nnnextyear/antigravity-proxy.git
cd antigravity-proxy

# 安装完整依赖
npm install

# 生产级构建
npm run build
```

#### 3. 配置文件初始化
```bash
cp config.example.json config.json
```
根据需要修改 `config.json`（保留默认配置即可直接运行）。

#### 4. 启动服务
```bash
# 直接启动
npm start

# 或通过 PM2 守护进程后台稳定运行 (生产环境推荐)
npm install -g pm2
pm2 start "npm start" --name antigravity-proxy
pm2 save
```

启动成功后终端输出：
```text
[Server] Antigravity Proxy listening on http://0.0.0.0:3000
[Server] Web Dashboard: http://localhost:3000/admin
[Server] OpenAI API: http://localhost:3000/v1/chat/completions
[Server] Anthropic API: http://localhost:3000/v1/messages
[Server] Responses API: http://localhost:3000/v1/responses
```

---

## 🔑 账号导入与管理

系统支持三种便捷的账号录入方式：

### 途径 1：一键同步本机 Antigravity 已登录凭据（最快）
若当前设备上已经安装并登录过 Antigravity 官方客户端：
1. 访问 `http://localhost:3000/admin`，点击顶部导航栏 **【同步本机】** 按钮；
2. 或在控制台终端直接执行：
   ```bash
   npm run extract-local
   ```
   脚本会自动定位本机安全存储，提取 Refresh Token 并同步加入调度池。

### 途径 2：通过 Google OAuth 向导多账号授权录入
适合在服务器或无 GUI 环境添加任意数量的 Google 账号：
```bash
npm run login
```
终端将输出 Google 官方 OAuth 授权 URL，复制到浏览器中完成登录，系统会自动截获回调并录入持久化账号池。重复执行即可快速添加多套账号。

### 途径 3：Web 控制台手动录入
访问 `http://localhost:3000/admin`，点击右上角 **+ 添加账号**，填入邮箱、Refresh Token，以及可选的**独立出口代理 (Proxy URL)**。

---

## 🧠 模型矩阵与动态思考

### 1. 官方纯净实时模型目录
Antigravity Proxy 的 `/v1/models` **直接从 Antigravity 上游的 `agentModelSorts` 实时拉取最新目录**：
- 自动剔除 internal 搜索和补全通道，仅暴露当前真实可用的 Agent 模型；
- 自动将带有 `-low`、`-medium`、`-high`、`-thinking` 的冗余上游入口合并为同一个标准模型；
- 保留官方原始版本编号，杜绝模型替换与伪造版本。

### 2. 多协议动态思考强度映射 (Thinking Effort)
你不再需要在模型名称后手动拼接 `-high` 或 `-low`。只需通过框架原生指令，网关即可毫秒级动态将思考配置下发给上游底座：
- **Claude Code 客户端**：通过 `/effort <level>` 或 `output_config.effort` / `thinking` 协议控制；
- **Codex / OpenAI SDK**：通过 `reasoning_effort` 或 Responses API 的 `reasoning.effort` 控制；
- **显式 Token 预算**：传入 `budget_tokens` 时，网关会自动适配上下游预算约束。

#### 思考档位对齐映射表
系统支持 `minimal / low / medium / high / xhigh / max` 六档标准请求：

| 客户端请求级别 | Gemini 3 映射档位 (`thinkingLevel`) | Gemini 2.5 / Claude 预算约束 (`budgetTokens`) |
| :--- | :--- | :--- |
| **`minimal`** | `low` | 4,096 tokens |
| **`low`** | `low` | 8,192 tokens |
| **`medium`** | `medium` | 16,384 tokens |
| **`high`** | `high` | 24,576 tokens |
| **`xhigh`** | `high` (或模型支持最高档) | 32,768 tokens |
| **`max`** | `high` (或模型支持最高档) | 32,768 tokens (受最大输出截断保护) |

---

## 💻 客户端接入指南

### 1. Claude Code CLI 官方直连（推荐）

设置环境变量后即可直接唤起 Claude Code：

<details open>
<summary><strong>macOS / Linux (Bash / Zsh)</strong></summary>

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3000"
export ANTHROPIC_API_KEY="sk-antigravity"
claude
```
</details>

<details open>
<summary><strong>Windows (PowerShell)</strong></summary>

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:3000"
$env:ANTHROPIC_API_KEY="sk-antigravity"
claude
```
</details>

---

### 2. CC Switch（Claude Code 切换利器）

- **服务商类型**：选择 `Anthropic` 或 `OpenAI`
- **API Base URL**：`http://127.0.0.1:3000/v1`
- **API Key**：`sk-antigravity`
- **模型同步**：点击“获取模型”直接拉取实时模型列表。

<details>
<summary><strong>📊 配置 CC Switch 实时用量与回血监控</strong></summary>

在 CC Switch 中点击服务商卡片上的 **用量查询** 图标，开启开关并配置自定义提取器：
- **请求地址 (URL)**：`http://127.0.0.1:3000/v1/user/balance`
- **请求方法**：`GET`
- **请求头**：`{"Authorization": "Bearer {{apiKey}}"}`
- **提取脚本**：
  ```javascript
  ({
    request: {
      url: "http://127.0.0.1:3000/v1/user/balance",
      method: "GET",
      headers: { "Authorization": "Bearer {{apiKey}}" }
    },
    extractor: function (response) {
      const data = typeof response === "string" ? JSON.parse(response) : response;
      return {
        isValid: data.isValid ?? true,
        remaining: data.remaining ?? 100, // 5小时滚动剩余百分比 (如 95.5%)
        unit: "%",
        used: data.used ?? 0,
        total: 100,
        planName: data.planName ?? "Antigravity Proxy"
      };
    }
  })
  ```
保存后，CC Switch 卡片将实时显示账号池在线数、剩余额度及回满倒计时。
</details>

---

### 3. Codex / Cursor / Cline / Roo Code

- **Provider**: 选择 `OpenAI Compatible`
- **Base URL**: `http://127.0.0.1:3000/v1`
- **API Key**: `sk-antigravity`
- **Model**: `claude-3-7-sonnet` 或 `gemini-3.8-flash`
- *(新版 Codex)*: 原生支持 `POST /v1/responses`，直接填入 base URL 即可自动适配。

---

### 4. NextChat / Cherry Studio / OneAPI / Dify

- **接口地址**: `http://127.0.0.1:3000/v1`
- **API Key**: `sk-antigravity`
- 在模型管理中点击“从服务商拉取”，系统将自动同步全部有效模型。

---

### 5. 代码与 SDK 快速调用

<details>
<summary><strong>Python (OpenAI SDK)</strong></summary>

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3000/v1",
    api_key="sk-antigravity"
)

response = client.chat.completions.create(
    model="gemini-3.8-flash",
    messages=[{"role": "user", "content": "9.11 和 9.8 谁大？请给出详细思考过程。"}],
    reasoning_effort="high",
    stream=True
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)
```
</details>

<details>
<summary><strong>Node.js / TypeScript (Anthropic SDK)</strong></summary>

```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  baseURL: 'http://127.0.0.1:3000',
  apiKey: 'sk-antigravity'
});

async function main() {
  const stream = await anthropic.messages.stream({
    model: 'claude-3-7-sonnet',
    max_tokens: 4096,
    messages: [{ role: 'user', content: '写一段高性能的快速排序算法' }]
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      process.stdout.write(event.delta.text);
    }
  }
}
main();
```
</details>

---

## 🛡️ 企业级生产安全与网络隔离

1. **绑定独占出口代理 (`proxyUrl`) 告别连坐**：
   - 可在 Web 控制台为每个账号单独指定代理出口（例如 `http://user:pass@node1:port`）。
   - 未单独配置的账号会共用 `defaultProxyUrl` 的出口 IP 与连接池；多账号共用单出口会在启动时主动发出隔离告警。
2. **上游频率限制与智能熔断策略**：
   - **429 分类处理**：明确的 `QUOTA_EXHAUSTED` / `Individual quota reached` 会暂停该账号对应模型族，按上游恢复时间排除并有限切换其他有额度账号；普通限频遵守冷却退避，不盲目轮换。
   - **403 细分治理**：策略类封禁（TOS_VIOLATION / disabled）自动隔离；权限/配额型 403 进入恢复期，等待配额刷新自动复原。
   - **断线防重放机制**：已发送至上游且在传输中的生成请求，连接异常断开时不自动重发，杜绝上游产生重复计费与幽灵生成。
3. **安全存储与凭证保护**：
   - 账号凭据文件保存在 `data/accounts.json`，已被 `.gitignore` 严格忽略，绝不泄露敏感凭证。

---

## ⚙️ 配置参考

可以通过 `config.json` 或环境变量定制网关行为：

| 配置项 (`config.json`) | 环境变量名 | 默认值 | 作用描述 |
| :--- | :--- | :--- | :--- |
| `port` | `PORT` | `3000` | HTTP 服务监听端口 |
| `host` | `HOST` | `0.0.0.0` | 监听地址（`0.0.0.0` 允许局域网或公网访问） |
| `apiMasterKey` | `API_MASTER_KEY` | `sk-antigravity` | 客户端访问接口时鉴权的 Bearer 密钥 |
| `adminPassword` | `ADMIN_PASSWORD` | `admin123` | Web 后台管理登录密码 |
| `upstreamUrl` | `UPSTREAM_URL` | 官方 CloudCode 端点 | 上游流式生成与模型调度端点 |
| `defaultProxyUrl` | `DEFAULT_PROXY_URL` | `http://127.0.0.1:7897` | 全局兜底代理出口（支持 HTTP/HTTPS 协议） |
| `routingStrategy` | `ROUTING_STRATEGY` | `zero-waste` | 调度策略 (`zero-waste` / `sequential-drain` / `round-robin`) |
| `defaultMaxConcurrency` | - | `5` | 单个账号允许的最大并发请求数 |
| `cooldownSeconds` | - | `60` | 上游无 Retry-After 时的默认 429 冷却时长（秒） |
| `tokenRefreshIntervalMs`| - | `180000` | 后台 Token 自动续期轮询周期（毫秒，默认 3 分钟） |
| `streamKeepaliveMs` | - | `15000` | 长思考 SSE 流向客户端发送保活注释的间隔（毫秒） |
| `upstreamTimeoutMs` | - | `900000` | 单次生成等待响应头 / 等待下一块的上限（毫秒，默认 15 分钟） |
| `minRequestIntervalMs` | - | `1000` | 同一账号两次生成启动之间的最小间隔（毫秒），抹平瞬时并发 |
| `accountQueueTimeoutMs` | `ACCOUNT_QUEUE_TIMEOUT_MS` | `120000` | 等待槽位的最长时间（毫秒）；预检与生成共用同一个槽位 |
| `maxAccountQueue` | `MAX_ACCOUNT_QUEUE` | `100` | 单账号等待上限；尚未绑定账号的请求共用一个待分配队列 |
| `maxConversationQueue` | `MAX_CONVERSATION_QUEUE` | `32` | 单主对话等待上限，包含子智能体 |
| `maxTotalQueue` | `MAX_TOTAL_QUEUE` | `1000` | 当前进程等待请求总上限 |
| `activeConversationTtlMs` | `ACTIVE_CONVERSATION_TTL_MS` | `900000` | 新对话分配时统计近期活跃对话的窗口（毫秒） |

<details>
<summary><strong>🔍 点击展开：核心调度与队列运作机制详解</strong></summary>

1. **新对话就绪优选**：新对话优先使用尚未承载近期活跃对话且有空闲槽位的可用账号；所有候选账号都有对话后，先比较执行数、等待数相对容量的负载，再比较近期对话数，最后应用所选路由策略。
2. **会话粘性稳定复用**：已有健康绑定继续复用；子智能体保留自身身份并继承父对话账号。同账号等待请求按主对话轮转，每个主对话内按到达顺序派发。
3. **单租约贯穿整个请求**：Anthropic 生成请求从预检、生成到响应消费结束持有同一个并发槽位，预检不会额外占名额或先抢占一个账号再重新排队。独立的 `/v1/messages/count_tokens` 仍为辅助调用，不排队且不留下新的长期对话绑定。
4. **模型族解耦绑定**：账号绑定按“主对话 + 模型家族（Gemini / Claude-GPT）”独立保存。同一模型家族的主对话和子智能体共用绑定；另一家族的额度耗尽、失败迁移或辅助计数不会清掉它。两类额度均可用时优先使用同一账号。
</details>

---

## ❓ 常见问题 (FAQ)

<details>
<summary><strong>Q1: 会话粘性如何帮助缓存命中？</strong></summary>

同一会话保持账号绑定，有利于复用上游已有的请求前缀缓存。实际命中率还取决于模型、请求前缀稳定性、上游缓存有效期等条件。在长对话或多轮工具调用场景下，保持账号稳定可以显著降低首字延迟并节省 Token 消耗。

当账号繁忙时请求会在绑定账号专属队列排队；账号失效、冷却或对应模型族额度耗尽时，会平滑迁移至可用账号。
</details>

<details>
<summary><strong>Q2: 子智能体（Sub-agent）遇到上下文超限怎么办？</strong></summary>

Claude Code 子智能体支持自动压缩，各自维护独立上下文。网关将 Google 上游的输入超限精准转换为客户端官方识别的 `400 invalid_request_error`、`code: context_length_exceeded` 与 `prompt is too long`，预检超限也采用同一格式。

Claude Code 收到此标准响应后会自动唤起内置的上下文压缩流程，完成历史提炼后自动重试。
</details>

<details>
<summary><strong>Q3: 上游返回 "User location is not supported" 或 403 地区限制？</strong></summary>

Google CloudCode 对请求出口 IP 所在地区有严格限制。  
**解决方式**：在 `config.json` 中配置 `defaultProxyUrl`，或在 Web 控制台为账号单独绑定支持地区的代理出口（推荐台湾、日本、美西、新加坡等受支持区域节点，避免香港节点或大陆直连）。
</details>

<details>
<summary><strong>Q4: 长思考 / 深度推理任务为什么容易在客户端超时断开？本项目如何解决？</strong></summary>

传统反代在发起上游请求后，若上游思考超过 60 秒未输出第一个字符，客户端（或反代层）会触发静默超时直接切断连接。  
本项目引入双重保障：
1. **预先 SSE 保活心跳**：发起上游请求伊始立即建立 SSE 管道，每 15s 自动注入心跳帧（`: keepalive\n\n`），保持客户端连接活跃；
2. **HTTP/2 底层 Transport**：底层采用 HTTP/2 PING 机制维持与上游的 TCP 通道活性，彻底攻克长思考断流难题。
</details>

---

## 🤝 贡献与社区

欢迎参与 Antigravity Proxy 的建设！

- 🐛 **提交 Bug 或建议**：请直接创建 [GitHub Issue](https://github.com/nnnextyear/antigravity-proxy/issues)
- 💡 **提交代码**：欢迎 Fork 仓库并创建 Pull Request
- ⭐ **支持项目**：如果这个项目对你的日常开发或团队提效有所帮助，请为本项目点亮一颗 **Star**！

---

<div align="center">

Made with ❤️ by [nnnextyear](https://github.com/nnnextyear) and the open source community.

</div>
