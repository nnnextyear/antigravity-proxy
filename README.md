# ⚡ Antigravity Proxy

<p align="center">
  <strong>面向 Google Antigravity 原生模型的高性能企业级多账号反向代理与智能调度网关</strong>
</p>

<p align="center">
  <a href="https://github.com/nnnextyear/antigravity-proxy/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D20.0.0-brightgreen.svg?logo=node.js" alt="Node Version"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.5-3178C6.svg?logo=typescript" alt="TypeScript"></a>
  <a href="https://fastify.dev/"><img src="https://img.shields.io/badge/Fastify-4.28-000000.svg?logo=fastify" alt="Fastify"></a>
  <a href="https://www.docker.com/"><img src="https://img.shields.io/badge/Docker-Ready-2496ED.svg?logo=docker" alt="Docker"></a>
  <img src="https://img.shields.io/badge/Tests-Passing-success.svg?logo=node.js" alt="Tests Status">
</p>

<p align="center">
  <a href="#-为什么选择-antigravity-proxy">核心优势</a> •
  <a href="#-系统架构">系统架构</a> •
  <a href="#-快速开始">快速开始</a> •
  <a href="#-模型矩阵与动态思考">动态思考与模型</a> •
  <a href="#-客户端接入指南">客户端接入</a> •
  <a href="#-web-管理控制台">管理控制台</a> •
  <a href="#-配置参考">配置参考</a> •
  <a href="#-常见问题-faq">FAQ</a>
</p>

---

**Antigravity Proxy** 是一款基于 **TypeScript + Node.js 22 + Fastify** 打造的高吞吐量 AI 网关系统。它专为 Google Antigravity 官方底座打造，对外提供标准 **Anthropic Messages API**、**OpenAI Chat Completions** 以及新版 Codex **Responses API**。

无论你在使用 **Claude Code、CC Switch、Codex、Cursor、Cline、NextChat** 还是 **OneAPI / NewAPI**，都能无缝调用 Google 原生旗舰模型（**Claude 3 Opus、Claude 3.7 / 3.5 Sonnet、Gemini 3.8 全系列**），并在多账号轮换下获得媲美单账号官方直连的 **Prompt Cache 极速命中**与**零浪费调度**体验。

---

## 🌟 为什么选择 Antigravity Proxy？

普通反代在多账号轮转时，往往因为随机切号导致 Google 上游 Prompt Cache 彻底失效，不仅延迟飙升，更浪费高达 80% 的配额。**Antigravity Proxy** 专为解决多账号生产落地痛点而生：

| 对比维度 | 传统第三方反代 / 简单轮询 | ⚡ Antigravity Proxy |
| :--- | :--- | :--- |
| **Prompt Cache 命中** | ❌ 每次请求随机切号，缓存穿透率 90%+ | ✅ **纯净会话粘性 (Session Sticky)**，单会话死锁账号，**保留 80%~90%+ 缓存** |
| **瞬态并发满载** | ❌ 账号并发占满立即漂移换号，丢掉前缀缓存 | ✅ **会话队列等待（最多 120s）**，平稳等待当前租约，绝不随意跳号 |
| **模型命名体系** | ❌ 充斥虚假无号模型或强制带 `-high/-low` 后缀 | ✅ **实时直连上游模型选择器**，无缝聚合思考档位，杜绝过期/伪造版本 |
| **思考强度控制 (Thinking)** | ❌ 只能写死或切不同模型名 | ✅ **全框架动态解析**：支持 `/effort`、`reasoning_effort` 六档映射与 Token 预算约束 |
| **Agent 工具调用加固** | ❌ 频繁触发 Protobuf Schema 400 或丢失工具调用 | ✅ **Google Schema 深度净化**、`thought_signature` 签名自动流转、冒号工具名双向转译 |
| **配额利用与监控** | ❌ 黑盒盲猜，额度耗尽直接报错崩溃 | ✅ **直连 Google 5小时/周期双额度监控**，已知耗尽额度自动避让，429 遵守上游冷却 |
| **账号与网络隔离** | ❌ 状态混乱，错误会被重复放大 | ✅ **单账号独立出口代理 (HTTP/SOCKS5)** 可选配置，配合会话粘性与错误隔离 |

---

## 🏛️ 系统架构

```mermaid
flowchart TD
    subgraph Clients [客户端生态]
        C1["Claude Code CLI\n(POST /v1/messages)"]
        C2["CC Switch\n(Anthropic / OpenAI / Balance)"]
        C3["Codex / Cursor\n(POST /v1/responses)"]
        C4["NextChat / OneAPI / Cline\n(POST /v1/chat/completions)"]
    end

    Clients -->|统一接入| Gateway["⚡ Fastify 高性能网关层"]

    subgraph Core [Antigravity Proxy 核心层]
        Gateway --> Auth["鉴权校验与协议适配\n(Anthropic / OpenAI / Responses)"]
        Auth --> Session["会话指纹提取 (Session Key)\nHeader / Body / User / Context Hash"]
        Session --> Engine["🚀 零浪费智能调度引擎 (Zero-Waste Engine)"]

        subgraph Strategies [调度流水线]
            S1["1. 会话粘性判定\n(锁定原账号，保留 Google Prompt Cache)"]
            S2["2. 临期额度抢救\n(45分钟内重置账号优先消费)"]
            S3["3. 按额度状态调度\n(优先使用已知可用额度，避免重复探测)"]
        end
        Engine --> Strategies

        subgraph Pool [多账号池与健康治理]
            Acc1["账号 A (Active)\n5h 滚动配额: 92% | 出口代理: IP-1"]
            Acc2["账号 B (Active)\n5h 滚动配额: 100% | 出口代理: IP-2"]
            Acc3["账号 C (429 冷却隔离 60s)"]
            Acc4["账号 D (额度枯竭自动避让)"]
        end
        Strategies --> Pool

        Refresher["Token 自动保活协程\n(每 3 分钟自动续期)"] -.-> Pool
        QuotaSync["Google 官方配额同步\n(retrieveUserQuotaSummary)"] -.-> Pool
        Breaker["熔断与重试器\n(429 冷却返回；401/503 有限重试)"] -.-> Pool
    end

    Pool -->|专用 Dispatcher 连接池| Upstream["Google CloudCode 生产端接口\ndaily-cloudcode-pa.googleapis.com"]
```

---

## 🚀 快速开始

### 方式 1：Docker Compose 部署 (推荐，2分钟就绪)

在任意装有 Docker 的服务器或本地机器上创建 `docker-compose.yml`：

```yaml
services:
  antigravity-proxy:
    image: ghcr.io/nnnextyear/antigravity-proxy:latest # 或自行 docker build
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
- **Node.js**: `v20.0.0` 或更高版本（推荐 Node.js 22 LTS）
- **Git**

#### 2. 克隆与安装
```bash
git clone https://github.com/nnnextyear/antigravity-proxy.git
cd antigravity-proxy

# 安装依赖
npm install

# 生产构建
npm run build
```

#### 3. 配置文件初始化
```bash
cp config.example.json config.json
```
根据需要修改 `config.json`（可保留默认值即可快速体验）。

#### 4. 启动服务
```bash
# 启动生产服务
npm start

# 或使用 PM2 守护进程后台运行 (VPS 部署推荐)
npm install -g pm2
pm2 start "npm start" --name antigravity-proxy
pm2 save
```

服务就绪后控制台输出：
```text
[Server] Antigravity Proxy listening on http://0.0.0.0:3000
[Server] Web Dashboard: http://localhost:3000/admin
[Server] OpenAI API: http://localhost:3000/v1/chat/completions
[Server] Anthropic API: http://localhost:3000/v1/messages
```

---

## 🔑 账号导入与池化管理 (3 种方式)

系统支持多账号池管理，你可以选择最顺手的添加方式：

### 途径 1：一键同步本机 Antigravity 已登录凭据 (最快)
如果你已经在当前电脑上使用过 Antigravity 官方客户端并完成登录：
- 打开浏览器访问 `http://localhost:3000/admin`，点击顶部导航栏 **【⚡ 一键同步本机账号】**；
- 或直接在终端运行：
  ```bash
  npm run extract-local
  ```
  脚本会自动定位系统持久化凭证，提取长效凭据并同步至账号池。

### 途径 2：通过 Google OAuth 向导多账号授权录入
如果你需要管理多个账号：
1. 运行内置 OAuth 交互程序：
   ```bash
   npm run login
   ```
2. 终端将输出 Google 官方 OAuth 授权 URL，复制至浏览器打开；
3. 登录并授权你的任意 Google 账号，系统会自动截获回调并提取长效 `refresh_token`；
4. 多次运行即可轻松录入第 2、第 3、第 N 个账号。

### 途径 3：Web 控制台手动录入
访问 `http://localhost:3000/admin`，点击右上角 **+ 手动添加**，填入账号邮箱、Refresh Token，以及可选的**独立出口代理 (Proxy URL)**。

---

## 🧠 模型矩阵与动态思考调度

### 1. 纯净官方实时模型目录
不同于其他反代服务返回写死、硬编码的静态模型名，Antigravity Proxy 的 `/v1/models` **直接从 Antigravity 上游的 `agentModelSorts` 实时拉取最新模型目录**：
- 自动剔除 internal 搜索和补全通道，仅暴露当前真实可用的 Agent 模型；
- 自动将带有 `-low`、`-medium`、`-high`、`-thinking`、`-tiered` 的多个上游入口合并为同一个标准模型；
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

*注：若未指定思考参数，系统自动遵循上游默认设定；Gemini 3 与 Gemini 2.5 Pro 无法完全关闭思考时，将自动采用底座允许的最低挡位保证稳定运行。*

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
# 测试 OpenAI 协议
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

## 🖥️ Web 管理控制台

访问 `http://localhost:3000/admin`，输入管理员密码（默认：`admin123`）即可进入现代化仪表盘：

- 📊 **多维配额可视监控**：精确掌握每个账号的 **Claude/GPT 5小时额度** 与 **Gemini 5小时额度** 百分比及下次回满倒计时。
- 🔄 **动态调度策略热切换**：
  - **🚀 零浪费智能调度 (`zero-waste`)**：综合会话粘性和已知额度状态，减少重复探测（默认推荐）。
  - **🔄 流水线顺序耗尽 (`sequential-drain`)**：集中打透单账号，留出整整 5 小时自然回满周期。
  - **⚖️ 传统均衡轮询 (`round-robin`)**：全池均匀打散，适合高并发短文本任务。
- ⚡ **快捷运维操作**：单账号一键健康探测、Token 手动刷新、429 冷却状态处理、代理出口动态配置与账号剔除。

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
| `defaultProxyUrl` | `DEFAULT_PROXY_URL` | `null` | 全局兜底代理出口（支持 HTTP/HTTPS/SOCKS5） |
| `routingStrategy` | `ROUTING_STRATEGY` | `zero-waste` | 调度策略 (`zero-waste` / `sequential-drain` / `round-robin`) |
| `defaultMaxConcurrency` | - | `5` | 单个账号允许的最大并发请求数 |
| `cooldownSeconds` | - | `60` | 遇到 429 限流时的静默冷却时间（秒） |
| `tokenRefreshIntervalMs`| - | `180000` | 后台 Token 自动续期轮询周期（毫秒，默认 3 分钟） |

---

## 🛡️ 账号隔离与生产安全

1. **绑定独立出口代理 (`proxyUrl`)**：
   - 可以在 Web 控制台为每个账号单独指定代理出口（例如 `http://user:pass@residential-node1:port`）。
   - 请求发往 Google 上游时可使用独立的专用代理，便于网络隔离和故障排查；代理配置不会规避 Google 的账号政策或服务限制。
2. **合理控制并发上限**：
   - 建议单个账号的并发维持在 3~5，平稳匀速消耗 5 小时滚动配额，避免突发大并发被上游风控阻断。
3. **保护数据与凭据目录**：
   - 项目将账号池持久化存储在 `data/accounts.json`。生产环境请确保该目录拥有正确的读写权限，且**绝对不要提交至公共代码仓库**（已在 `.gitignore` 中默认保护）。

---

## ❓ 常见问题 (FAQ)

<details>
<summary><strong>Q1: 什么是“纯净会话粘性”？为什么说它能节省 80%~90% 的 Token？</strong></summary>

Google 上游大模型具备内置的 Prompt Cache 机制。当同一段对话（例如长文件代码、系统 Prompt）在**同一个账号**上连续请求时，上游能直接命中内存中的缓存前缀，响应速度从数秒骤降至几百毫秒，且消耗的计费 Token 大幅削减。  
如果反代随意轮询切号，每个新账号都必须重新完整读入上下文，导致缓存反复击穿。Antigravity Proxy 通过深度解析请求指纹锁定会话，确保同一任务始终由同一账号提供服务。
</details>

<details>
<summary><strong>Q2: 提示 "All accounts in the pool are busy, in cooldown, or exhausted" 怎么处理？</strong></summary>

这说明账号池内所有可用账号的 5 小时额度均已暂时用尽，或短时间内触发了上游频控：
1. 访问 `http://localhost:3000/admin` 查看各个账号的回满倒计时；
2. 运行 `npm run login` 录入更多备用账号，系统会按健康状态和已知额度参与调度；收到 429 时会遵守上游冷却并返回，不会继续放大请求。
</details>

<details>
<summary><strong>Q3: 上游返回 "User location is not supported" 或 403 地区限制？</strong></summary>

Google CloudCode 对请求出口 IP 所在的国家和地区有严格限制。  
**解决方式**：在 `config.json` 中配置 `defaultProxyUrl`，或在 Web 控制台为账号绑定支持地区的代理出口（推荐台湾、日本、美西等受支持区域节点）。
</details>

<details>
<summary><strong>Q4: 为什么在 `/v1/models` 中看不到带有 `-high` 或 `-low` 的模型？</strong></summary>

这是本代理经过重构后的规范设计：思考档位属于请求级别的参数（Reasoning Effort），不应当污染模型名。你可以直接选择 `gemini-3.8-flash` 或 `claude-3-7-sonnet`，并通过框架原生选项自由切换高、中、低思考深度，网关会自动将参数注入到底层请求中。
</details>

---

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE) 开源。欢迎 Star、Fork 并提交 Issue 与 PR 共同完善！
