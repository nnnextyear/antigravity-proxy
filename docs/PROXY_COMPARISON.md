# 中转与反代实现对照

## 对照对象

本次对照使用了公开仓库的实际源码与文档：

- [LiteLLM](https://github.com/BerriAI/litellm)：通用多提供商代理、路由、预算和观测。
- [One-API](https://github.com/songquanpeng/one-api) / [New API](https://github.com/QuantumNous/new-api)：频道重试、令牌、分组和用量管理。
- [claude-code-proxy](https://github.com/raine/claude-code-proxy)：Claude Code 的 Anthropic 协议转换、工具调用、count tokens 和原生远程压缩。
- [OpenCodeX](https://github.com/lidge-jun/opencodex)：Claude Code/Codex 多协议路由与远程压缩实践。

## 业务逻辑对比

| 能力 | 当前项目 | 主流实现方式 | 本项目决策 |
| --- | --- | --- | --- |
| 多账号路由 | 本地号池、会话粘性、5 小时/周额度 | LiteLLM Router/least-busy；One-API channel group + retry | 保留本地 Google 额度调度，增加紧迫度高于粘性的规则 |
| 故障转移 | 429/401/403/503 分类处理 | 按可重试状态重放原请求，失败通道降权/禁用 | 保留分类；协议 400 不换号，网络/5xx/429 才重试 |
| 会话缓存 | session -> account 绑定 | sticky routing/cache key，跨 worker 通常用 Redis | 保留内存粘性；后续可插拔 Redis，不改变单机行为 |
| 上下文压缩 | 由客户端原生会话压缩负责 | Claude Code Proxy 优先原生压缩/compact 事件 | 代理不改写会话历史，只返回真实 usage 和上游错误 |
| Token 统计 | Google usageMetadata + countTokens | Provider 原始 usage，聚合层按请求结算 | 保留真实值，禁止估算值；新增工具调用后的 usage 校验 |
| 工具调用 | Anthropic 已支持；OpenAI 原先丢失 | 两种协议都保留 tool schema/call/result 状态 | 已补齐 OpenAI tools/tool_calls/tool result |
| 管理后台 | 本地 JSON、OAuth、停用、额度 | One-API/New API 常用数据库、RBAC、审计 | 保留轻量本地部署；补请求级可观测和安全边界 |
| 鉴权 | 单一 master key + admin password | API key/JWT、分组权限、限流 | 保留现有兼容字段，后续增加 key 级策略而不破坏旧客户端 |

## 已吸收的实现

1. **协议级工具调用**：OpenAI assistant `tool_calls` 转为 Google `functionCall`，tool 消息转为 `functionResponse`；上游函数调用再转回 OpenAI SSE/non-stream 响应。
2. **原生压缩信号**：Anthropic `message_start.usage.input_tokens` 使用 Google `countTokens` 实际结果，匹配 Claude Code 的自动压缩判断；`message_delta` 只发送输出 usage。
3. **原生压缩边界**：代理不实现第二套历史压缩算法，避免服务端临时改写和客户端本地会话状态分叉。
4. **重试边界**：上下文 400 不轮换账号；429/网络错误/可恢复 5xx 才进入账号级重试。
5. **额度紧迫度优先**：周重置和 5 小时临期账号可以打破普通 session sticky，避免缓存粘性造成额度浪费。

## 当前仍保留的优势

- Google 官方额度接口和双额度族群隔离。
- 每账号独立出口代理。
- 本地 OAuth/Antigravity 凭据同步。
- 原有四卡 UI、真实号池 Token 聚合、缓存命中率。
- Fastify 单进程低依赖部署和现有客户端 URL 兼容别名。

## 下一批高价值改造

1. 引入请求 ID、耗时、上游账号和重试次数的结构化日志，并在响应头返回 request id。
2. 增加 API key 级限流和并发配额，避免单客户端耗尽整个号池。
3. 把账号 JSON 写入改为原子替换，并对 refresh token 做文件权限/加密存储选项。
4. 为 OpenAI/Anthropic 增加协议回归测试：文本、工具调用、流式、非流式、429 换号、上下文溢出。
5. 多进程部署时把 session binding、额度缓存和计数聚合抽象到 Redis/SQLite 后端。

## 验收标准

- 同一会话在账号健康时保持粘性；出现临期额度时能让位。
- OpenAI 工具调用在流式和非流式模式下均可闭环。
- Claude Code 收到真实 `input_tokens` 后能在配置窗口触发自身压缩。
- Google 上游溢出后，回退请求的序列化内容和工具 schema 均在安全预算内。
- 所有失败重试都有明确边界，400 请求错误不会被伪装成网络错误。
