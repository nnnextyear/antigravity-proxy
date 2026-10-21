<div align="center">

# ⚡ Antigravity Proxy

**面向 Google Antigravity 原生模型的高吞吐量企业级多账号反向代理与智能调度网关**

[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node Version](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-brightgreen.svg?logo=node.js&style=flat-square)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6.svg?logo=typescript&style=flat-square)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-4.28-black.svg?logo=fastify&style=flat-square)](https://fastify.dev/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg?logo=docker&style=flat-square)](https://www.docker.com/)
[![Tests](https://img.shields.io/badge/Tests-65%20Passing-success.svg?logo=node.js&style=flat-square)](https://github.com/nnnextyear/antigravity-proxy)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/nnnextyear/antigravity-proxy/pulls)

<p align="center">
  <a href="#-核心优势">核心优势</a> •
  <a href="#-系统架构">系统架构</a> •
  <a href="#-控制台体验">控制台体验</a> •
  <a href="#-快速开始">快速开始</a> •
  <a href="#-账号导入与池化管理">账号导入</a> •
  <a href="#-模型矩阵与动态思考">动态思考</a> •
  <a href="#-客户端接入指南">客户端接入</a> •
  <a href="#-企业级生产安全与网络隔离">生产安全</a> •
  <a href="#-配置参考">配置参考</a> •
  <a href="#-常见问题-faq">FAQ</a>
</p>

</div>

---

## 📖 简介

**Antigravity Proxy** 是一款专为 Google Antigravity 官方底座打造的高性能、企业级 AI 反向代理与多账号调度网关。底层采用 **TypeScript + Node.js 22 + Fastify + Undici / HTTP2 双传输层** 架构，对外提供工业级兼容的：
- 🌟 **Anthropic Messages API**（完美适配 **Claude Code CLI** 原生环境、Token 预检、实时压缩及流式长思考）
- 🚀 **OpenAI Chat Completions**（无缝接入 **Cursor、NextChat、Cherry Studio、OneAPI / NewAPI、Cline / Roo Code**）
- ⚡ **Codex Responses API**（原生适配新版 **Codex / Responses API** 协议）

凭借独创的**纯净会话粘性缓存锁定 (Session Sticky)**、**上游 5h 滚动双配额智能调度**、**HTTP/2 保活流式长思考防断连**与**单账号独立出口网络隔离**，Antigravity Proxy 让多账号集群兼具「高可用高并发」与「单账号 80%~90%+ 官方 Prompt Cache 极速命中」的极致体验。

---

## ✨ 核心优势

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       🚀 为什么选择 Antigravity Proxy？                       │
├──────────────────────────┬──────────────────────────┬───────────────────────┤
│ 🎯 85%+ Prompt Cache 命中 │ ⚡ 0 浪费智能调度水坝     │ 🛡️ 账号隔离与零连坐   │
│ 基于上下文指纹强粘性锁定 │ 5h 滚动双配额实时感知    │ 独立代理出口与连接池  │
│ 彻底告别轮询带来的缓存击穿│ 45分钟临期额度抢救机制   │ 429遵守退避杜绝封号   │
├──────────────────────────┼──────────────────────────┼───────────────────────┤
│ 🧠 动态思考强度原生注入  │ 🌊 HTTP/2 保活流式隧道   │ 🛠️ 工具调用与结构净化 │
│ 拒绝伪造 -high/-low 模型 │ 15s 心跳杜绝长思考断流   │ Protobuf 深度规整净化 │
│ 六档 Effort 毫秒级原生直达│ 客户端/代理超时全面防护  │ thought_signature 闭环│
└──────────────────────────┴──────────────────────────┴───────────────────────┘
```

| 核心维度 | 传统第三方反代 / 简单轮询 | ⚡ Antigravity Proxy 现代化网关 |
| :--- | :--- | :--- |
| **Prompt Cache 命中率** | ❌ 随机切号导致 Google Prompt Cache 命中率几乎为 0，响应慢且费 Token | ✅ **会话强粘性锁定 (Session Sticky)**，缓存命中率高达 **85%~90%+**，首字延迟骤降 |
| **突发并发处理** | ❌ 账号占满即漂移到新号，直接击穿上游缓存 | ✅ **会话队列平滑等待 (最多 120s)**，排队等待当前账号租约，绝不随意跳号 |
| **模型命名体系** | ❌ 充斥虚构模型或强制加 `-high/-low` 后缀 | ✅ **直连上游模型目录 (`agentModelSorts`)**，官方真实版本，杜绝魔改与伪造 |
| **动态思考控制 (Thinking)** | ❌ 只能写死或切不同模型名 | ✅ **全框架动态映射**：支持 `/effort`、`reasoning_effort` 六档映射与 Token 预算约束 |
| **长思考 / 长文本连接** | ❌ 超过 60s 客户端静默超时断开（长思考痛点） | ✅ **HTTP/2 传输层 + SSE 预先保活**：15s 心跳帧护航，轻松支撑 15 分钟+ 复杂推理 |
| **工具调用 (Function Calling)** | ❌ 频发 Protobuf 400 校验错误或丢失 tool 调用 | ✅ **Google Schema 深度净化**、`thought_signature` 签名自动回传、冒号工具名双向转译 |
| **配额管理与防封** | ❌ 黑盒盲猜，耗尽后疯狂报错甚至连环被封 | ✅ **官方配额接口同步 (5h 双族群)**，明确额度耗尽时有限切换可用账号，普通限频遵守冷却 |
| **网络出口与隔离** | ❌ 所有账号共用单 IP，极易触发风控关联连坐 | ✅ **单账号独立出口代理 (`proxyUrl`)**，支持独立认证与独立连接池，环境高度隔离 |

---

## 🏛️ 系统架构

```mermaid
flowchart TD
    classDef client fill:#1e293b,stroke:#475569,stroke-width:2px,color:#f8fafc;
    classDef gateway fill:#312e81,stroke:#6366f1,stroke-width:2px,color:#f8fafc;
    classDef engine fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#f8fafc;
    classDef pool fill:#14532d,stroke:#22c55e,stroke-width:2px,color:#f8fafc;
    classDef upstream fill:#701a75,stroke:#d946ef,stroke-width:2px,color:#f8fafc;

    subgraph Clients["🌐 全生态客户端接入层"]
        C1["Claude Code CLI\nPOST /v1/messages"]:::client
        C2["CC Switch\nAnthropic / OpenAI / Balance"]:::client
        C3["Codex / Cursor\nPOST /v1/responses"]:::client
        C4["NextChat / OneAPI / Cline\nPOST /v1/chat/completions"]:::client
    end

    Clients -->|"统一接入 (Bearer / x-api-key)"| GW["⚡ Fastify 高性能网关核心\n(连接保活 / SSE 心跳 / 跨域 / 错误规整)"]:::gateway

    subgraph Core["🧠 核心调度与协议编排引擎"]
        GW --> Adapters["多协议转换器\n• Anthropic ↔ Google\n• OpenAI ↔ Google\n• Codex Responses ↔ Google"]
        Adapters --> Fingerprint["会话指纹生成 (Session Key)\nHeader / Body / User / Context Hash"]
        Fingerprint --> Scheduler["🚀 零浪费智能调度水坝 (Zero-Waste Engine)"]

        subgraph Strategies["调度流水线 (Pipeline)"]
            S1["1. 强会话粘性判定\n锁定绑定账号，捍卫 Google Prompt Cache"]
            S2["2. 45分钟临期抢救\n优先消耗即将过期的 5h 滚动窗口"]
            S3["3. 额度健康状态优选\n隔离冷却与耗尽账号，规避无序探测"]
        end
        Scheduler --> Strategies
    end

    subgraph AccountCluster["🛡️ 账号隔离与集群治理 (Account Pool)"]
        Acc1["账号 A (Active)\nClaude 5h: 88% | 独立代理 A"]:::pool
        Acc2["账号 B (Active)\nGemini 5h: 95% | 独立代理 B"]:::pool
        Acc3["账号 C (429 冷却隔离中)\n遵守上游 Retry-After 冷却"]:::pool
        Acc4["账号 D (已休眠/额度枯竭)"]:::pool
        
        Governance["治理协程\n• Token 自动续期 (每 3 分钟)\n• 官方配额同步 (retrieveUserQuotaSummary)\n• 熔断器 (Breaker & Error Policy)"]
    end
    Strategies --> AccountCluster
    Governance -.-> AccountCluster

    subgraph Network["🌐 智能网络传输网格 (Transport Grid)"]
        H2["HTTP/2 传输通道\n(Ping 心跳保活 / 防空闲断开)"]
        Tunnel["HTTP CONNECT 专用隧道\n(单账号独立出口隔离 / TLS 包装)"]
    end
    AccountCluster --> Network

    Network -->|"认证请求与流式交互"| Upstream["☁️ Google CloudCode 生产端集群\n(daily-cloudcode-pa.googleapis.com)"]:::upstream
```

---

## 🖥️ 控制台体验

项目内置现代化极简高精玻璃拟态仪表盘（`http://localhost:3000/admin`），支持全维度监控与热操作运维：

```
+----------------------------------------------------------------------------------------------------+
| ⚡ Antigravity Gateway   [BASE URL: /v1]  [API KEY: sk-antigravity]  [纯粘性水坝调度 ▼]  [+添加账号]  |
+----------------------------------------------------------------------------------------------------+
|                                                                                                    |
|  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────────────────┐   |
|  │ 账号池规模        │  │ 实时并发吞吐     │  │ 24小时请求量     │  │ 5小时滚动平均额度         │   |
|  │   5 个账号       │  │   2 / 25 Req     │  │   1,248 次调用   │  │   89.5% 充足 (回满 28m)   │   |
|  │  ● 4正常 1冷却   │  │  ● 运行负载平稳   │  │  ✓ 99.8% 成功率 │  │  Claude: 84% | Gemini: 95% │   |
|  └──────────────────┘  └──────────────────┘  └──────────────────┘  └───────────────────────────┘   |
|                                                                                                    |
|  [ 账号管理与配额明细 ] -------------------------------------------------------------------------  |
|  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐  |
|  │ 账号: dev-alpha@example.com  [Active]  [独占代理: 127.0.0.1:7890]    [刷新Token] [查额度] [操作▼]│  |
|  │ ├─ Claude/GPT 5h 配额: [████████████████░░░░] 82.5% (将在 42 分钟后重置)                     │  |
|  │ └─ Gemini 5h 配额:     [████████████████████] 100.0% (满额就绪)                              │  |
|  ├──────────────────────────────────────────────────────────────────────────────────────────────┤  |
|  │ 账号: team-prod@example.com  [Active]  [独占代理: 127.0.0.1:7891]    [刷新Token] [查额度] [操作▼]│  |
|  │ ├─ Claude/GPT 5h 配额: [██████████████████░░] 91.0% (将在 1 小时 15 分后重置)                │  |
|  │ └─ Gemini 5h 配额:     [██████████████████░░] 92.0%                                          │  |
|  └──────────────────────────────────────────────────────────────────────────────────────────────┘  |
+----------------------------------------------------------------------------------------------------+
```

- 📊 **多维配额可视监控**：精确掌握每个账号的 **Claude/GPT 5小时额度** 与 **Gemini 5小时额度** 百分比及下次回满倒计时。
- 🔄 **动态调度策略热切换**：
  - **🚀 纯粘性水坝调度 (`zero-waste`)**：会话强粘性锁死最大化 Prompt Cache，新会话临期抢救 + 深度耗尽（**推荐首选**）。
  - **🔄 顺序耗尽模式 (`sequential-drain`)**：集中打满单号 5h 额度，留出整整 5 小时自然回满周期。
  - **⚖️ 经典负载轮询 (`round-robin`)**：全池均匀打散，适合高并发无上下文关联的短文本任务。
- ⚡ **快捷运维操作**：单账号一键健康探测、Token 手动刷新、429 冷却状态处理、独立代理出口热修改与账号剔除。

---

## 🚀 快速开始

### 方式 1：Docker Compose 部署 (推荐，2分钟就绪)

在任意装有 Docker 的服务器或本地机器上创建 `docker-compose.yml`：

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

启动容器：
```bash
docker compose up -d
docker compose logs -f
```

---

### 方式 2：本地 Node.js 源码运行

#### 1. 环境准备
- **Node.js**: `v20.0.0` 或更高版本（强烈推荐 Node.js 22 LTS）
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
根据需要修改 `config.json`（保留默认配置即可开箱即用）。

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

## 🔑 账号导入与池化管理

系统支持多种便捷的凭据录入方式：

### 途径 1：一键同步本机 Antigravity 已登录凭据 (最快)
如果你已经在当前设备上使用过 Antigravity 官方客户端：
1. 打开浏览器访问 `http://localhost:3000/admin`，点击顶部导航栏 **【⚡ 一键同步本机账号】**；
2. 或在控制台终端直接执行：
   ```bash
   npm run extract-local
   ```
   脚本会自动定位本机持久化安全存储，提取 Refresh Token 并同步加入账号池。

### 途径 2：通过 Google OAuth 向导多账号授权录入
适合在服务器或无 GUI 环境添加任意数量的 Google 账号：
1. 执行内置 OAuth 引导程序：
   ```bash
   npm run login
   ```
2. 终端将输出 Google 官方 OAuth 授权 URL，复制并在浏览器中打开；
3. 完成登录授权后，系统会自动截获回调并录入持久化池；
4. 重复此操作即可轻松录入多套账号。

### 途径 3：Web 控制台手动录入
访问 `http://localhost:3000/admin`，点击右上角 **+ 添加账号**，填入账号邮箱、Refresh Token，以及可选的**独占出口代理 (Proxy URL)**。

---

## 🧠 模型矩阵与动态思考

### 1. 纯净官方实时模型目录
Antigravity Proxy 的 `/v1/models` **直接从 Antigravity 上游的 `agentModelSorts` 实时拉取最新模型目录**：
- 自动剔除 internal 搜索和补全通道，仅暴露当前真实可用的 Agent 模型；
- 自动将带有 `-low`、`-medium`、`-high`、`-thinking` 的冗余上游入口合并为同一个标准模型；
- 保留官方原始版本编号，杜绝模型替换与伪造版本。

### 2. 多协议动态思考强度映射 (Thinking Effort)
你不再需要在模型名称后硬拼 `-high` 或 `-low`。只需通过框架原生指令，网关即可毫秒级动态将思考配置下发给上游底座：
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

### 1. CC Switch (Claude Code 客户端管理利器)

- **服务商类型**：选择 `Anthropic` 或 `OpenAI`
- **API Base URL**：`http://127.0.0.1:3000/v1`
- **API Key**：`sk-antigravity`
- **模型同步**：点击“获取模型”直接拉取实时模型列表。

#### 📊 配置 CC Switch 实时用量与回血监控
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

---

### 2. Claude Code CLI 官方直连
设置环境变量后直接唤起：

**macOS / Linux (Bash / Zsh):**
```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3000"
export ANTHROPIC_API_KEY="sk-antigravity"
claude
```

**Windows (PowerShell):**
```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:3000"
$env:ANTHROPIC_API_KEY="sk-antigravity"
claude
```

---

### 3. Codex / Cursor / Cline / Roo Code

- **Provider**: 选择 `OpenAI Compatible`
- **Base URL**: `http://127.0.0.1:3000/v1`
- **API Key**: `sk-antigravity`
- **Model**: `claude-3-7-sonnet` 或 `gemini-3.8-flash`
- *(新版 Codex)*: 原生支持 `POST /v1/responses`，直接填入 base URL 即可识别。

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

<details>
<summary><strong>cURL 验证命令</strong></summary>

```bash
# 测试 OpenAI 兼容端点
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-antigravity" \
  -d '{
    "model": "gemini-3.8-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# 测试模型列表
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer sk-antigravity"
```
</details>

---

## 🛡️ 企业级生产安全与网络隔离

1. **绑定独占出口代理 (`proxyUrl`) 告别连坐**：
   - 可以在 Web 控制台为每个账号单独指定代理出口（例如 `http://user:pass@residential-node1:port`）。
   - **未单独配置的账号会共用 `defaultProxyUrl` 的出口 IP 与连接池**——这是上游关联多账号的主要特征。启动时若检测到多账号共用出口，控制台会主动打印隔离告警。
2. **遵守上游频率限制与熔断策略**：
   - **429 分类处理**：明确的 `QUOTA_EXHAUSTED` / `Individual quota reached` 会暂停该账号对应模型族，按上游恢复时间排除，并在生成尚未成功时有限切换其他有额度账号；每个耗尽账号在一次请求内只尝试一次。普通限频或无法明确分类的 429 遵守冷却，不轮换账号。Google 429 正文不直接返回客户端；无法完成时返回带原因与重试时间的本地 503。
   - **403 细分治理**：策略类封禁（TOS_VIOLATION / disabled）自动判死隔离；权限/配额型 403 进入恢复期，等待配额刷新自动复原。
   - **断线防重放机制**：已发送至上游且在传输中的生成请求，连接异常断开时不自动重发，杜绝上游产生重复计费与幽灵生成。
3. **安全存储与凭证保护**：
   - 账号凭据文件保存在 `data/accounts.json`，已在 `.gitignore` 严格忽略，杜绝凭据误推至公共仓库风险。

---

## ⚙️ 配置参考

你可以通过 `config.json` 或环境变量（支持 `.env`）定制系统行为：

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
| accountQueueTimeoutMs | ACCOUNT_QUEUE_TIMEOUT_MS | 120000 | 等待槽位的最长时间（毫秒）；预检与生成共用同一个槽位 |
| maxAccountQueue | MAX_ACCOUNT_QUEUE | 100 | 单账号等待上限；尚未绑定账号的请求共用一个待分配队列 |
| maxConversationQueue | MAX_CONVERSATION_QUEUE | 32 | 单主对话等待上限，包含子智能体 |
| maxTotalQueue | MAX_TOTAL_QUEUE | 1000 | 当前进程等待请求总上限 |
| activeConversationTtlMs | ACTIVE_CONVERSATION_TTL_MS | 900000 | 新对话分配时统计近期活跃对话的窗口（毫秒）；不主动迁移已有绑定 |

新对话优先使用尚未承载近期活跃对话且有空闲槽位的可用账号；所有候选账号都有对话后，先比较执行数、等待数相对容量的负载，再比较近期对话数，最后应用所选路由策略。已有健康绑定继续复用；子智能体保留自身身份并继承父对话账号。同账号等待请求按主对话轮转，每个主对话内按到达顺序派发。正在执行的请求不会被抢占，因此公平排队仍可能产生等待。

Anthropic 生成请求从预检、生成到响应消费结束持有同一个并发槽位，预检不会额外占名额或先抢占一个账号再重新排队。独立的 `/v1/messages/count_tokens` 仍为辅助调用，不排队且不留下新的长期对话绑定。额度耗尽需要迁移时，替代账号会成为后续对话的新绑定；原账号恢复后不会主动迁回。

账号绑定按“主对话 + 模型家族（Gemini / Claude-GPT）”独立保存。同一模型家族的主对话和子智能体共用绑定；另一家族的额度耗尽、失败迁移或辅助计数不会清掉它。两类额度均可用时优先使用同一账号。并发满时继续在绑定账号排队，少量正余额不会触发提前迁移；明确耗尽、账号冷却、禁用或认证失败仍会阻止继续使用该账号。调度日志中的 `family`、`unbound reason` 和 `generation_start` 可用来区分真实换号与前端并发槽位的变化。

这些队列与并发限制只在当前进程内生效；账号绑定在重启后不保留。没有显式会话 ID 时使用首条用户消息哈希作弱回退，相同内容仍可能被视作同一对话，应尽量提供稳定 ID。


---

## ❓ 常见问题 (FAQ)

<details>
<summary><strong>Q1: 会话粘性如何帮助缓存命中？</strong></summary>

同一会话保持账号绑定，有利于复用上游已有的请求前缀缓存。命中还取决于模型、请求前缀、上游缓存有效期及其他调度条件，不能保证固定比例、计费节省或响应时间。一次同账号换 sessionId 的实验仍观察到了前缀缓存命中，跨账号缓存共享则尚未验证。

繁忙时请求在绑定账号排队；账号失效、冷却或对应模型族额度不可用时，仍按现有失败策略处理。缓存字段缺失应视为未知，不能仅用缺失字段判断未命中。
</details>

<details>
<summary><strong>Q2: 如何区分账号繁忙、排队超时与额度耗尽？</strong></summary>

本地调度错误通过 error.code 区分：queue_full 表示队列达到上限；queue_timeout 表示等待超过时限；quota_exhausted 表示当前可选账号的请求模型族额度不可用；rate_limited 表示上游普通限频；unavailable 表示没有健康且可选择的账号。它们返回 HTTP 503；流式响应已开始时通过带状态的错误事件返回。明确的额度 429 会先尝试切换可用账号，所有账号都不可用时仍如实返回失败。403、认证、地区、上下文错误继续分类处理。

访问管理控制台检查并发、账号状态与额度。排队超时不代表额度耗尽，也不能仅凭这些本地错误判断出口网络故障。
</details>

<details>
<summary><strong>子智能体遇到上下文超限怎么办？</strong></summary>

Claude Code 子智能体支持自动压缩，各自维护上下文；主对话压缩不会自动压缩子智能体。代理将 Google 的输入超限转换为客户端可识别的 `400 invalid_request_error`、`context_length_exceeded` 和 `prompt is too long`，预检超限也采用同一格式。仅提示“请自行压缩”的自定义错误可能被客户端识别为普通 API 错误，无法进入恢复流程。

预检不可用时，流式结束事件仍会补上 Google 返回的真实输入 token 数。代理不截断或替换对话历史；自动压缩由 Claude Code 执行，结果取决于客户端版本、自动压缩设置及摘要请求能否成功。`[1M]` 是客户端的窗口提示，不会扩大上游模型实际允许的输入。

诊断日志 `context_overflow` 包含请求 ID、模型、账号、已知输入 token 数、输出预算与上游超限详情，可用于区分窗口配置和实际超限。参考 [Claude Code 子智能体自动压缩](https://code.claude.com/docs/en/sub-agents#auto-compaction)。
</details>

<details>
<summary><strong>Q3: 上游返回 "User location is not supported" 或 403 地区限制？</strong></summary>

Google CloudCode 对请求出口 IP 所在地区有严格限制。  
**解决方式**：在 `config.json` 中配置 `defaultProxyUrl`，或在 Web 控制台为账号绑定支持地区的代理出口（推荐台湾、日本、美西等受支持区域节点，避免香港节点或直连）。
</details>

<details>
<summary><strong>Q4: 长思考 / 深度推理任务为什么容易在客户端超时断开？本项目如何解决？</strong></summary>

传统反代在发起上游请求后，若上游思考超过 60 秒未输出第一个字，客户端（或反代软件）会触发静默超时直接切断连接。  
本项目引入双重保障：
1. **预先 SSE 保活心跳**：发起上游请求伊始立即建立 SSE 管道，每 `streamKeepaliveMs`（默认 15s）自动注入心跳帧，保证客户端连接永远处于活跃态；
2. **HTTP/2 底层 Transport**：底层采用 HTTP/2 PING 机制维持与上游的 TCP 通道活性，彻底攻克长思考断流难题。
</details>

---

## 🤝 贡献与社区

欢迎参与 Antigravity Proxy 的建设！

- 🐛 **提交 Bug 或建议**：请直接创建 [GitHub Issue](https://github.com/nnnextyear/antigravity-proxy/issues)
- 💡 **提交代码**：欢迎 Fork 仓库并创建 Pull Request
- ⭐ **支持项目**：如果这个项目对你的日常开发或团队提效有所帮助，请为本项目点亮一颗 **Star**！

---

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
