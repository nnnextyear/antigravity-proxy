# ⚡ Antigravity Proxy (多账号高性能反向代理与管理系统)

> 基于 **TypeScript + Node.js 22 + Fastify** 构建的企业级 Google Antigravity 模型反向代理系统。对外提供标准 **OpenAI 兼容接口** 与 **Anthropic Messages 协议**，支持在 **CC Switch、Claude Code、Codex、Cline、Cursor、NextChat、OneAPI** 等任意第三方框架中无缝调用 Google 原生旗舰模型（**Claude 3 Opus、Claude 3.7 Sonnet、Gemini 3.8 全系列**），内置**零浪费智能调度引擎（防 Cache 穿透 + 临期抢救 + 流水线永动机）**、原生 Function Calling / Tool Use 深度加固、实时 5小时/周双额度监控、额度用尽自动无感换号、动态思考强度调度、Token 自动保活与现代化 Web 管理控制台。

---

## 📑 目录

- [🌟 核心功能特性](#-核心功能特性)
- [🚀 零浪费智能调度引擎 (Zero-Waste Engine)](#-零浪费智能调度引擎-zero-waste-engine)
- [🛠️ 原生 Agent 工具调用与上游协议加固](#️-原生-agent-工具调用与上游协议加固)
- [🧠 纯净官方模型矩阵与动态思考调度](#-纯净官方模型矩阵与动态思考调度)
- [📊 Google 官方双重额度监控机制](#-google-官方双重额度监控机制)
- [🏛️ 系统架构设计](#️-系统架构设计)
- [🚀 快速开始与部署](#-快速开始与部署)
- [🔑 账号凭证录入与管理 (三种途径)](#-账号凭证录入与管理-三种途径)
- [💻 第三方客户端接入指南](#-第三方客户端接入指南)
  - [1. CC Switch (Claude Code 切换器)](#1-cc-switch-claude-code-切换器)
  - [2. Claude Code CLI 官方直连](#2-claude-code-cli-官方直连)
  - [3. Codex / Cline / Roo Code / Cursor](#3-codex--cline--roo-code--cursor)
  - [4. NextChat / Cherry Studio / OneAPI](#4-nextchat--cherry-studio--oneapi)
- [🖥️ Web 可视化管理控制台](#️-web-可视化管理控制台)
- [⚙️ 配置说明 (config.json / .env)](#️-配置说明-configjson--env)
- [🛡️ 多账号防关联与防封指南](#️-多账号防关联与防封指南)
- [❓ 常见问题排查 (FAQ)](#-常见问题排查-faq)

---

## 🌟 核心功能特性

1. **🚀 零浪费智能调度引擎 (Zero-Waste Smart Scheduler)**
   - **会话粘性防穿透 (Session Affinity)**：基于会话指纹自动锁定同一账号，吃满 Google 上游 Prompt Cache，**节省 80%~90% 的上下文 Token 损耗**。
   - **临期额度优先抢救 (Time-to-Reset Aware)**：对 45 分钟内即将重置 5 小时配额且仍有余量的账号进行优先派发，防止残余额度被 Google 自动抹平作废。
   - **流水线回血永动机 (Sequential Pipeline)**：集中打透主力账号，为前序账号留出整整 5 小时自然回满周期，形成水车式不间断流水线。
2. **🛠️ 原生 Agent 工具调用深度兼容 (Full Native Tool Use)**
   - 完整支持 Claude Code、Cline 等 Agent 框架的原生工具调用，支持 SSE `content_block_start` tool_use / `input_json_delta` / `stop_reason: tool_use`。
   - **Google Schema 自动清洗**：递归剔除 Google Protobuf 拒绝的 `$schema`、`propertyNames` 等 Draft-07 字段。
   - **Gemini 3.x 思考签名支持**：自动注入真实 `thought_signature` 或 `skip_thought_signature_validator` 哨兵，杜绝 400 校验异常。
   - **工具名双向映射**：自动转换带冒号的工具名（如 `default_api:Write` $\leftrightarrow$ `default_api_Write`），满足 Claude 严格正则命名规范。
3. **⚡ 标准 OpenAI & Anthropic 双协议全兼容**
   - 完整支持 `POST /v1/chat/completions`（毫秒级 **SSE 流式**与非流式响应）。
   - 原生兼容 Anthropic `POST /v1/messages` 接口（Claude Code 官方通信协议）。
   - 完整支持 `GET /v1/models`，供 CC Switch、OneAPI 等客户端免密一键拉取模型列表。
4. **🧠 纯净官方模型名 + 框架动态思考调控**
   - 严格遵循官方正规带版本号命名，彻底清除了非官方的无号伪模型与 `-high`、`-medium`、`-low` 后缀。
   - **动态思考强度引擎**：在 Claude Code（通过 `/effort`）或 Codex（通过 `reasoning_effort` / `budget_tokens`）中随时调整思考深度，代理服务在请求级别毫秒级动态路由至底层对应的思考底座。
5. **📊 Google 官方真实额度监控（5小时额度 + 周期总额度）**
   - 直连 Google 生产端配额接口 `v1internal:retrieveUserQuotaSummary`，Web 控制台精确展示每个账号的 Claude/GPT 与 Gemini **5小时滚动额度**与**周期总额度**进度条与回满倒计时。
6. **🔄 额度用尽与 429 毫秒级无感智能换号**
   - 当某个账号 5小时额度耗尽或遭遇 Google 429 限流时，调度池**自动解绑会话并毫秒级无感轮换至下一个健康账号**重试，客户端无需手动干预。
7. **🛡️ 独立出口代理隔离 (防关联防封号)**
   - 允许为账号池中的每个账号独立绑定专属 HTTP/SOCKS5 代理出口（如静态住宅 IP），避免同 IP 高频并发请求 Google 触发批量风控。
8. **🔄 Token 异步自动保活守护进程**
   - 后台协程每 3 分钟自动巡检，在 Token 过期前自动调用 Google OAuth 凭据换取新令牌，实现全年 7×24 小时零人工干预。

---

## 🚀 零浪费智能调度引擎 (Zero-Waste Engine)

针对多账号在 Google Antigravity 配额体系下普遍存在的“闲置作废”、“频繁换号打散导致 Prompt Cache 失效”等严重浪费问题，系统实现了**三级调度流水线**：

```mermaid
flowchart TD
    Req["客户端请求入站 (Anthropic / OpenAI)"] --> FP["提取会话指纹 (Session Fingerprint)"]
    FP --> S1{"会话粘性判定 (Session Sticky)"}
    S1 -->|历史会话且账号健康| Reuse["复用绑定账号 (命中 Google Prompt Cache，省 80%~90% Token)"]
    S1 -->|新会话或原账号已耗尽| S2{"临期抢救判定 (Time-to-Reset)"}
    S2 -->|45分钟内即将重置且有余量| Imminent["优先调度临近重置账号 (防止额度清零作废)"]
    S2 -->|无临期账号| S3["流水线深度耗尽 (集中跑满主力号，留出 5 小时完整回血期)"]
    Reuse --> Exec["上游调用"]
    Imminent --> Exec
    S3 --> Exec
    Exec -->|429 限频| Failover["自动解绑会话，冷却 60s，秒级无感换号重试"]
```

### 三大调度策略对比（可在 Web 控制台随时一键切换）

| 策略标识 | 策略名称 | 适用场景与工作机制 |
| :--- | :--- | :--- |
| **`zero-waste`** *(默认推荐)* | **🚀 智能零浪费** | 综合会话粘性（防 Prompt Cache 穿透）、临期额度抢救（防清零蒸发）与流水线深度耗尽，最大限度压榨并兑现账号总额度。 |
| **`sequential-drain`** | **🔄 流水线顺序耗尽** | 严格按顺序集中打满单账号的 5 小时配额，打满后顺位切下一个，适合账号数较多、希望流水线时间差回血的用户。 |
| **`round-robin`** | **⚖️ 传统均衡轮询** | 全池请求均匀打散，结合最小并发数（Least-Connections），适合压力测试与高并发短任务。 |

---

## 🛠️ 原生 Agent 工具调用与上游协议加固

针对在 Claude Code CLI、Atlas 等 Agent 运行复杂任务（调用 Bash 命令、文件读写等）时出现的卡顿或报错，代理层完成了深度协议治理：

1. **解决模型“自言自语输出普通文本”而非真正执行命令**：
   - 入站自动解析 Anthropic 请求中的 `tools` 定义并完整转译给上游底层；
   - 出站自动将底座生成的 `functionCall` 包装为标准的 Anthropic SSE 事件（`content_block_start` tool_use、`input_json_delta`、`content_block_stop`、`stop_reason: "tool_use"`）。
2. **规避 Gemini 3.x 400 校验错误**：
   - 自动嗅探上游生成的真实 `thought_signature` 并在多轮交互中智能回传；对离线或无签名轮次，自动带上 Google 标准标记 `skip_thought_signature_validator`。
3. **消除特殊工具名冒号报错**：
   - 自动双向映射 `default_api:Write` $\leftrightarrow$ `default_api_Write`，既符合 Claude 命名正则规范，又满足客户端原样识别。
4. **Google Protobuf Schema 严格清洗**：
   - 过滤 Schema 中所有 `$schema`、`propertyNames`、`exclusiveMinimum` 等不支持属性。

---

## 🧠 纯净官方模型矩阵与动态思考调度

向客户端暴露的 `/v1/models` 仅包含 15 款真实官方模型，思考强度完全由客户端在发起请求时按需动态控制：

| 客户端模型 ID (`model`) | 官方全称 | 上游真实底座 | 特性与动态思考支持 |
| :--- | :--- | :--- | :--- |
| **`claude-3-7-sonnet`** | Claude 3.7 Sonnet | `claude-sonnet-4-6` | Anthropic 最新旗舰编程模型，支持 1M 上下文 |
| **`claude-3-5-sonnet`** | Claude 3.5 Sonnet | `claude-sonnet-4-6` | Anthropic 主力编程模型 (CC Switch 推荐) |
| **`claude-3-opus`** | Claude 3 Opus | `claude-opus-4-6-thinking` | Anthropic 官方正统 Opus 旗舰推理底座 |
| **`claude-3-5-haiku`** | Claude 3.5 Haiku | `claude-sonnet-4-6` | 高速轻量模型，映射高速 Sonnet 底座 |
| **`gemini-3.8-flash`** | Gemini 3.8 Flash | `gemini-3.8-flash-{low/med/high}` | 纯净旗舰底座，思考强度由 CC/Codex 动态调节 |
| **`gemini-3.7-flash`** | Gemini 3.7 Flash | `gemini-3.7-flash-{low/med/high}` | 纯净底座，思考强度由 CC/Codex 动态调节 |
| **`gemini-3.6-flash`** | Gemini 3.6 Flash | `gemini-3.6-flash-{low/med/high}` | 纯净底座，思考强度由 CC/Codex 动态调节 |
| **`gemini-3.1-pro`** | Gemini 3.1 Pro | `gemini-pro-agent` / `3.1-pro-low` | 深度推理与 Agent 专用底座 |
| **`gemini-2.5-pro`** | Gemini 2.5 Pro | `gemini-2.5-pro` | 经典大上下文模型 |
| **`gemini-2.5-flash`** | Gemini 2.5 Flash | `gemini-2.5-flash` | 极速轻量模型 |
| **`gpt-4o`** | GPT-4o | `gpt-oss-120b-medium` | OpenAI 官方旗舰标识 (映射 Google 120B 开源底座) |
| **`gpt-4o-mini`** | GPT-4o Mini | `gpt-oss-120b-medium` | OpenAI 轻量标识 |
| **`gpt-oss-120b`** | GPT-OSS 120B | `gpt-oss-120b-medium` | Google 官方开源 120B 旗舰模型 |
| **`claude-opus-4-6-thinking`** | Claude Opus 4.6 (Thinking) | `claude-opus-4-6-thinking` | Google 内部原生全称 |
| **`claude-sonnet-4-6`** | Claude Sonnet 4.6 | `claude-sonnet-4-6` | Google 内部原生全称 |

> **💡 如何在客户端动态调节思考强度？**
> - **在 Claude Code (CC) 中**：直接输入 `/effort low`、`/effort medium` 或 `/effort high`，服务会自动向 Google 上游匹配对应的思考深度；
> - **在 Codex / Cline / OpenAI SDK 中**：在请求体中附带 `"reasoning_effort": "low" | "medium" | "high"`，网关会自动路由至对应的思考底座。

---

## 📊 Google 官方双重额度监控机制

系统直接对接 Google 生产端配额接口 `v1internal:retrieveUserQuotaSummary`：

1. **两大独立配额池**：
   - **Claude / GPT 额度池**：共享 Opus、Sonnet 与 GPT-OSS，包含 5小时滚动平滑限额（`3p-5h`）与周期总额度（`3p-weekly`）。
   - **Google Gemini 额度池**：共享 Gemini 系列，包含 5小时滚动平滑限额（`gemini-5h`）与周期总额度（`gemini-weekly`）。
2. **控制台双进度条展示**：
   - 打开 `http://localhost:3000/admin`，每个账号直观展示 Claude/GPT 与 Gemini 各自的进度条与回满倒计时（例如 `⏳ 2小时40分后回满`、`🔄 5天后刷新`）。

---

## 🏛️ 系统架构设计

```mermaid
flowchart TD
    Client[第三方客户端\nCC Switch / Claude Code / Codex / NextChat] -->|OpenAI /v1/chat/completions\n或 Anthropic /v1/messages| Gateway[Fastify 协议适配网关]
    
    subgraph Core [Antigravity Proxy 核心调度层]
        Gateway --> Fingerprint[会话指纹提取器\nSession Fingerprint Identifier]
        Fingerprint --> ZeroWaste[零浪费智能调度器\nZero-Waste Scheduler]
        
        subgraph Strategies [调度算法库]
            SessSticky[会话粘性缓存]
            TimeReset[临期抢救感知]
            SeqDrain[流水线深度耗尽]
        end
        ZeroWaste --> Strategies
        
        subgraph AccountPool [多账号池管理中心]
            Acc1[账号 A (Active)\nClaude 5h: 98% / Gemini 5h: 54%\n独立出口代理 Proxy A]
            Acc2[账号 B (Active)\nClaude 5h: 100% / Gemini 5h: 90%\n独立出口代理 Proxy B]
            Acc3[账号 C (Exhausted / 额度耗尽自动避让)]
            Acc4[账号 D (Cooldown / 429 冷却隔离)]
        end
        
        Strategies -->|选出最优健康账号| AccountPool
        Refresher[Token 自动保活协程] -.->|每 3 分钟检测| AccountPool
        QuotaManager[Google 官方配额监控巡检] -.->|实时拉取双额度| AccountPool
        Breaker[熔断器 Circuit Breaker] -.->|429/503 秒级无感换号| AccountPool
    end
    
    subgraph AdminLayer [管理控制台与持久化]
        WebConsole[Web 控制台 /admin] --> AdminAPI[REST API /api/admin/*]
        AdminAPI --> Storage[(本地存储 data/accounts.json)]
        Storage --> AccountPool
    end

    Acc1 -->|HTTPS + SSE| Upstream[Google CloudCode 上游生产端\ndaily-cloudcode-pa.googleapis.com]
    Acc2 -->|HTTPS + SSE| Upstream
```

---

## 🚀 快速开���与部署

### 1. 运行环境要求
- **Node.js**: `v20.0.0` 或更高版本（推荐 Node 22+）
- **包管理器**: `npm` / `pnpm` / `yarn`
- **操作系统**: Windows / macOS / Linux

---

### 2. 本地直接部署 (推荐)

#### 步骤一：克隆仓库并安装依赖
```bash
git clone https://github.com/nnnextyear/antigravity-proxy.git
cd antigravity-proxy

# 安装依赖
npm install

# 构建生产产物
npm run build
```

#### 步骤二：配置文件准备
项目根目录提供了配置模板，首次运行可直接基于模板复制：
```bash
# 复制配置文件
cp config.example.json config.json
# （可选）也可以通过环境变量或 .env 配置
cp .env.example .env
```

`config.json` 核心字段说明：
```json
{
  "port": 3000,
  "host": "0.0.0.0",
  "apiMasterKey": "sk-antigravity",
  "adminPassword": "admin123",
  "upstreamUrl": "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
  "defaultMaxConcurrency": 5,
  "cooldownSeconds": 60,
  "tokenRefreshIntervalMs": 180000,
  "routingStrategy": "zero-waste"
}
```

#### 步骤三：启动��务
```bash
# 启动生产代理服务
npm start

# 或开发环境热重载 (开发模式)
npm run dev
```

#### 步骤四：后台守护进程部署 (PM2)
如需在 VPS / Linux 服务器上持续后台运行：
```bash
# 全局安装 PM2
npm install -g pm2

# 启动并命名
pm2 start "npm start" --name antigravity-proxy

# 查看状态与日志
pm2 status
pm2 logs antigravity-proxy

# 设置开机自启
pm2 save
pm2 startup
```

---

### 3. Docker 容器化部署

本项目提供了官方 `Dockerfile` 与 `docker-compose.yml`，支持一键容器化运行：

#### 方式一：Docker Compose（推荐）
```bash
# 1. 启动容器
docker compose up -d

# 2. 查看运行日志
docker compose logs -f
```

#### 方式二：直接使用 Docker CLI 构建运行
```bash
# 构建镜像
docker build -t antigravity-proxy:latest .

# 运行容器并挂载数据持久化目录
docker run -d \
  --name antigravity-proxy \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  antigravity-proxy:latest
```

---

### 4. 服务入口与默认凭证

服务启动成功后：
- 🌐 **Web 管理���制台**：`http://localhost:3000/admin` （默认密码：`admin123`）
- 🔌 **OpenAI 兼容端点**：`http://localhost:3000/v1/chat/completions`
- 📨 **Anthropic 兼容端点**：`http://localhost:3000/v1/messages`
- 📋 **模型列表端点**：`http://localhost:3000/v1/models`
- 🔑 **默认客户端 API Key**：`sk-antigravity`

---

## 🔑 账号凭证录入与管理 (三种途径)

### 途径 1：一键自动同步本机 Antigravity 已登录账号 (最推荐)
如果您本地电脑上已安装并登录了 Antigravity IDE：
- **Web 界面一键点击**：打开 `http://localhost:3000/admin`，在顶部导航栏点击 **【⚡ 一键同步本机账号】**，系统将自动读取凭据并完成握手。
- **命令行脚本执行**：
  ```powershell
  npm run extract-local
  ```

### 途径 2：使用官方 OAuth 网页向导添加多账号 (多号池化轮换)
如果您准备开 2 个、5 个或更多 Google 账号做账号池轮换：
1. 执行：
   ```powershell
   npm run login
   ```
2. 终端会生成官方授权链接，直接在浏览器中打开。
3. 登录并选择您的**任意 Google 账号**完成授权。
4. 授权完毕后会自动提取长效 `refresh_token` 并存入账号池。重复执行即可依次添加多个账号。

### 途径 3：在 Web 控制台手动录入
1. 访问 `http://localhost:3000/admin`；
2. 点击右上角 **+ 手动添加**；
3. 填入邮箱、Refresh Token，以及可选的**独立出口代理 (Proxy URL)**。

---

## 💻 第三方客户端接入指南

### 1. CC Switch (Claude Code 切换器)
- **服务商类型**：选择 `Anthropic` 或 `OpenAI`
- **API Base URL**：`http://127.0.0.1:3000/v1`（自动支持 `/v1/messages`、`/v1/models` 以及 `/v1/user/balance`）
- **API Key / Token**：`sk-antigravity`
- **获取模型**：直接点击“获取模型”，秒级同步包含 `claude-3-opus`、`claude-3-7-sonnet`、`gemini-3.8-flash` 在内的全部真实模型。

#### 📊 在 CC Switch 中配置「用量查询」
将鼠标悬停在 CC Switch 的供应商卡片上，点击 **用量查询**（图表图标），打开配置面板：
1. 打开顶部的 **“启用用量查询”** 开关；
2. **方式一（自定义脚本，最推荐，信息最丰富）**：
   - 模板选择：**“自定义”**（Custom）；
   - 在代码框中填入以下标准配置（可直接点击“测试脚本”）：
   ```javascript
   ({
     request: {
       url: "http://127.0.0.1:3000/v1/user/balance",
       method: "GET",
       headers: {
         "Authorization": "Bearer {{apiKey}}"
       }
     },
     extractor: function (response) {
       const data = typeof response === "string" ? JSON.parse(response) : response;
       return {
         isValid: data.isValid ?? true,
         remaining: data.remaining ?? 100, // 5小时配额剩余百分比（如 96.1%）
         unit: data.unit ?? "%",
         used: data.used ?? 0,
         total: data.total ?? 100,
         planName: data.planName ?? "Antigravity Proxy"
       };
     }
   })
   ```
   *注：若你的 CC Switch UI 为表单拆分模式：*
   - **请求地址 (URL)**：`http://127.0.0.1:3000/v1/user/balance`
   - **请求方法**：`GET`
   - **请求头**：`{"Authorization": "Bearer {{apiKey}}"}`
   - **提取器**：
     ```javascript
     function (response) {
       const data = typeof response === "string" ? JSON.parse(response) : response;
       return {
         isValid: true,
         remaining: data.remaining ?? 100,
         unit: "%",
         planName: data.planName ?? "Antigravity Proxy"
       };
     }
     ```
3. **方式二（内置模板）**：
   - 模板下拉直接选择 **NewAPI** 或 **OneAPI**，系统将自动适配 `/v1/user/balance` 并解析配额。
4. 点击 **“测试脚本”**，测试成功后点击 **“保存”**。卡片上将实时显示当前账号池的剩余额度百分比、在线账号数与回血状态！


### 2. Claude Code CLI 官方直连
直接通过环境变量指定第三方端点：
```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:3000"
$env:ANTHROPIC_API_KEY="sk-antigravity"
claude
```

### 3. Codex / Cline / Roo Code / Cursor
- **API Provider**：选择 `OpenAI Compatible`
- **Base URL**：`http://127.0.0.1:3000/v1`
- **API Key**：`sk-antigravity`
- **Model ID**：填写 `claude-3-7-sonnet` 或 `gemini-3.8-flash`

### 4. NextChat / Cherry Studio / OneAPI
- **接口地址**：`http://127.0.0.1:3000/v1`
- **API Key**：`sk-antigravity`
- **拉取模型**：点击“从服务商拉取模型”即可同步全部可用列表。

---

## 🖥️ Web 可视化管理控制台

访问 `http://localhost:3000/admin` 并输入管理密码 `admin123`：

### 核心功能与操作
- **实时调度策略切换**：导航栏右侧快速切换 `🚀 智能零浪费` / `🔄 流水线顺序耗尽` / `⚖️ 传统均衡轮询`。
- **大盘指标监控**：总账号数、可用数、冷却数、失效数、并发数，以及 Claude 与 Gemini 的平均剩余额度。
- **多维额度进度条**：每个账号独立展示 Claude/GPT 与 Gemini 的 5小时额度与周期总额度，悬停查看精确重置时间。
- **快捷管理操作**：
  - **📊 查额度**：针对单个账号向 Google 发起实时探测并更新额度进度条；
  - **🔄 刷新**：重新向 Google 兑换最新 Access Token；
  - **⚡ 激活**：强制解除 429 冷却或异常状态；
  - **🗑️ 删除**：移出账号池。

---

## ⚙️ 配置说明 (config.json / .env)

| 配置项 | 环境变量名 | 默认值 | 作用描述 |
| :--- | :--- | :--- | :--- |
| `port` | `PORT` | `3000` | 代理服务监听端口 |
| `host` | `HOST` | `0.0.0.0` | 监听接口 (0.0.0.0 允许局域网共享) |
| `apiMasterKey` | `API_MASTER_KEY` | `sk-antigravity` | 客户端调用 API 时的 Bearer Key |
| `adminPassword` | `ADMIN_PASSWORD` | `admin123` | 管理控制台登录密码 |
| `upstreamUrl` | `UPSTREAM_URL` | Google 官方端点 | Google CloudCode 生产端接口 |
| `routingStrategy` | `ROUTING_STRATEGY` | `zero-waste` | 调度策略 (`zero-waste` / `sequential-drain` / `round-robin`) |
| `defaultMaxConcurrency`| - | `5` | 单账号并发上限 |
| `cooldownSeconds` | - | `60` | 429 冷却隔离时长（秒） |

---

## 🛡️ 多账号防关联与防封指南

1. **绑定独立出口代理 (`proxyUrl`)**：
   - 在控制台或 `data/accounts.json` 中，为每个账号填写独立代理（例如 `http://user:pass@127.0.0.1:7890` 或住宅 SOCKS5 代理）；
   - 请求发往 Google 时将使用不同 IP，杜绝同 IP 集中并发导致批量风控。
2. **并发削峰**：
   - 保持单个账号的 `maxConcurrency` 在 3~5 之间，平稳消耗 5小时配额。

---

## ❓ 常见问题排查 (FAQ)

### Q1: 什么是“零浪费智能调度”？
- 普通代理在多轮会话中会随机切号，导致 Google 上游 Prompt Cache 全部失效，多耗费数倍 Token；
- 零浪费智能引擎通过“**会话粘性**”锁定当前上下文，同时结合“**临期额度抢救**”（在账号重置前吃完残余配额）与“**流水线深度耗尽**”，让每个账号的 5小时回满机制形成无缝流水线。

### Q2: 提示 `All accounts in the pool are busy, in cooldown, or exhausted`？
- 说明当前账号池中所有账号的额度已耗尽或触发 429。
- **解决方式**：打开控制台 `http://localhost:3000/admin` 查看重置时间；或通过 `npm run login` 增加备用账号，系统会自动多号轮换。

### Q3: 为什么模型列表中没有 `-high`、`-low` 或 `claude-opus`？
- 本代理严格遵循官方标准：移除了无号伪模型 `claude-opus`，替换为 Anthropic 官方正式命名的 `claude-3-opus`；
- 思考强度由客户端框架（Claude Code 的 `/effort` 或 Codex 的 `reasoning_effort`）在请求时动态决定，模型名称不包含任何 `-high`/`-low` 污染。
