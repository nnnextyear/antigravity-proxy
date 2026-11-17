# 修复与验证记录（2026-11-17）

本轮修复代码中已确认的传输、重试、状态管理和凭证泄露缺陷。结合 GitHub 上针对同类 `RESOURCE_EXHAUSTED` 的新提交，将调用方 system prompt 放到带 `<system-instructions>` 标签的首个 user turn，避免把 Claude Code 提示直接放进 CloudCode 的 `systemInstruction`。按该项目实现，对 system prompt 中 `Claude Code`、`Anthropic` 等已知身份词做整词替换；普通对话消息和工具定义不改写。提示移位会降低其在 Gemini 中的原生优先级。

## 真实请求结果

取实际 Claude Code 请求，经当前 Anthropic 转换器生成请求体，在同一账号、同一出口、同一实时目录模型 `gemini-3.8-flash-high` 上串行对照：

| 测试 | 结果 |
| --- | --- |
| 原有自写 HTTP/2，完整系统提示 | `ERR_HTTP2_STREAM_ERROR` |
| 原有自写 HTTP/2，简短系统提示 | `ERR_HTTP2_STREAM_ERROR` |
| 标准 HTTP 客户端，完整原生系统提示 | HTTP 429，`RESOURCE_EXHAUSTED` |
| 标准 HTTP 客户端，仅把系统提示换为 `Be helpful.` | HTTP 200，返回“你好！很高兴见到你。” |
| 最终生产传输代码，完整原生系统提示 | HTTP 429，约 1.6 秒 |
| 最终生产传输代码，简短系统提示对照 | HTTP 200，约 15.4 秒，返回“你好！很高兴见到你。” |
| 当前生产路由，GitHub 报告的安全测试与 `<pasted_content>` 段落、14 个工具定义，提示移位并 scrub 身份词 | countTokens 607；生成 HTTP 200，返回“你好！很高兴为您提供帮助。请问有什么我可以协助您的吗？” |
| 当前生成路由 HTTP/2 + 周期 PING，14 个工具及相同触发提示，输出预算 256 | countTokens 607；生成 HTTP 200，返回“你好！请问有什么我可以帮你的吗？” |

上表记录的是本次位置调整前的原生 systemInstruction 结果。简短提示只用于隔离故障；新的生产路径将 system 文本作为首个 user turn 的独立部分发送，保留结构和其他内容，只替换名单命中的身份词。

新增的 14 工具上游回归通过 Fastify `inject` 调用当前生产路由，未绑定本地端口；它验证了已报告的触发段落和工具定义能随新请求结构获得真实文本响应。该合成用例不是此前 18.3 KB / 14 个真实工具 schema 的逐字段复放。

这说明传输缺陷与上游拒绝是两个独立现象；不能从现有错误体确定 Google 的具体判断依据，也不能据此断言是模型下架、账号额度耗尽、共享项目限流或封禁反代。此次实验未证明某位开发者的改动导致了账号封禁。

## 追加诊断与修正

检查本机 Antigravity 安装包中随附的 Google GCA 适配器（`chrome-devtools-mcp/build/src/third_party/index.js`）发现：它把 `preamble` 放在 `systemInstruction` 中，结构为 `{ role: "user", parts }`，并将 picker 的 `model_id` 原样传给 GCA。该文件使用的是 GCA `v1beta:streamGenerateContent` 适配器，不等同于主 Agent 的完整实现，但为 system instruction 结构提供了第一方参照。

当前账号的 Antigravity CloudCode 实时目录包含 `gemini-3.8-flash-high`、`-medium`、`-low` 和 `-tiered`；Agent Picker 只列 high/medium/low。直接向当前 `v1internal` 端点请求无后缀 `gemini-3.8-flash` 返回 `404 NOT_FOUND`。因此外部公开模型 ID 仍可用无后缀名称，但上游必须选实时 picker 中可见的项；现在会按请求 thinking effort 选择 high/medium/low，不再一律选择 high。短请求的 `-medium` 实测返回 HTTP 200 和文本；无后缀 ID 则不可用。

为区分长度与内容影响，使用相同模型和 medium effort，发送 77,000 字符的合成系统指令（`systemInstruction.role="user"`，4096 输出预算）。Google 返回 HTTP 200，候选以 `STOP` 结束并产生可见文本。这个结果说明提示长度本身不足以解释完整 Claude Code 系统提示的 429；具体原生提示文本或其交互因素仍未定位，Google 的 `RESOURCE_EXHAUSTED` 错误体没有更细原因，不能断言是系统提示封禁或账号额度问题。

实时计数对照发现，Google `countTokens` 忽略了结构化的 `systemInstruction` 和 `tools`：77 KB system instruction 加短 user 内容得到 4 tokens；同一文本放进 contents 得到 14,001 tokens；24 个 function declarations（约 43.9 KB）加短内容也只得到 4 tokens。count_tokens 与生成现在使用同一条提示放置逻辑；计数器继续将工具 schema 折成文本补计。生成日志记录 payload、contents、调用方 system prompt、tools 的字节数，不记录提示内容。

另外捕获了非 bare Claude Code 2.1.289 的真实请求摘要（不记录正文）：14 个工具、两个 message、`max_tokens=32000`、`output_config.effort=medium`。把原始请求注入旧转换器后，countTokens 成功返回 18,482，generation 使用实时 picker 的 `gemini-3.8-flash-medium`，但在原生 systemInstruction 下得到 HTTP 429 `RESOURCE_EXHAUSTED`；无 RetryInfo/QuotaFailure 等细分原因。生成 payload 约 73.9 KB，其中 system instruction 18.3 KB、tool 定义 54.2 KB、contents 1.2 KB。

追加的等长对照在同一活跃账号上以内存刷新 access token 后执行，没有写入 `data/accounts.json`。保持 `gemini-3.8-flash-medium`、medium 思考、32,000 输出预算、14 个工具、两条对话内容和约 73.9 KB 总请求量；中性 system instruction 为 18,300 bytes，工具与 toolConfig 共 54,200 bytes，contents 为 1,200 bytes。Google 返回 HTTP 200 和文本“你好！请问有什么我可以帮你的吗？”。工具定义是按实际字节量合成的，不能视为原始 Claude Code schema 的逐字段复刻；此前 `Be helpful.` 对照保留了原始 14 工具请求并返回 200。因此请求长度和工具数量不足以解释 429；Google 错误体仍不能证明具体策略原因。

GitHub 上 [antigravity-claude-proxy 的 11 月 16 日提交](https://github.com/badrisnarayanan/antigravity-claude-proxy/commit/252da0d428113bf728f6fe1d7f0c7785cd42c7f5)报告：Claude Code 2.1.325 的某些 systemInstruction 段落触发泛化 429，而同一文本放进 contents 可通过。提交将调用方提示单独放进首个 user turn，并覆盖首条为 model 或 function response 的情况；其请求构造器还会将 `Claude Code`、`Anthropic`、`Hermes`、`Nous Research` 等身份词替换为中性词。本项目现已采用同样的 system prompt scrub，且支持 `ANTIGRAVITY_SCRUB_IDENTITY` 自定义替换规则；没有复制其额外的 Antigravity 指令文本。检查本机 2.1.289 默认系统提示确认其中含相同的安全测试段落，但仅单独测试该句时原生和 user 位置都返回 200，说明触发依赖完整提示或其上下文，不能归因于某一个孤立词句。

按本机 Claude Code 2.1.289 实际默认请求，经本项目修改后的 Anthropic 转换器生成 CloudCode 请求并发送一次：系统文本 6,074 bytes、22 个工具、两条 message，使用 `gemini-3.8-flash-medium` 和 medium 思考。Google 返回 HTTP 200，候选以 `STOP` 结束，实际文本为“你好！请问有什么我可以帮你的？无论是关于代码开发、项目维护、调试还是其他技术问题，随时告诉我。”该请求与此前用户捕获的 14 工具、18.3 KB 系统提示不完全相同；尚未对那份原始完整 payload 做移位后的逐字段重放，因此不能将这次结果称为原始失败请求的完整复验。

检查本机 Antigravity 安装包内的 Google GCA 适配器 `chrome-devtools-mcp/build/src/third_party/index.js`：它把 Google 侧 `preamble` 写入 `{ role: "user", parts: [{ text }] }` 的 `systemInstruction`，把 `options.model_id` 原样映射为 model，并把 function declarations 映射到 `tools`；其 `GcaClient` 使用 GCA 的 `/v1beta:streamGenerateContent`。这是随 Antigravity 安装的 GCA/DevTools 适配器，不是主 Agent 完整源码，也不代表 `v1internal` 的全部契约。公开反代 [balakumardev/antigravity-reverseproxy-api](https://github.com/balakumardev/antigravity-reverseproxy-api/blob/main/src/cloudcode/request-builder.js) 会另外注入自定义 Antigravity system instruction、重复的 `[ignore]` 文本以及 `userAgent`/`requestType`/`requestId` 字段；这是第三方实现，不能当作 Google 官方行为。

## 已修复缺陷

| 缺陷 | 最终行为 |
| --- | --- |
| CloudCode 对 Claude Code systemInstruction 返回泛化 429 | 将调用方提示移入带边界标记的首个 user turn，并按已知名单替换身份词；普通消息和工具定义不改写，count_tokens 使用相同提示转换并补计工具 schema |
| HTTP/2 PING 保活及生成响应流处理 | 生成请求单独使用 Node HTTP/2 并每 15 秒发 PING，PING ACK 最长等 30 秒；代理 CONNECT、TLS、取消、响应超时和流清理由当前传输模块统一管理；模型目录和 countTokens 保持 Undici HTTP/1.1 |
| 直连每次新建 Agent 并长期保存 | 按配置复用连接池，并支持关闭与退役 |
| 生成 429 重试释放租约、重新选账号、重复 countTokens | 一次请求持有同一账号并发槽，预检一次，默认最多三次生成尝试 |
| 忽略 Retry-After/RetryInfo | 使用指数退避与抖动，等待时间不得短于上游提示；累计退避预算 15 秒，超出则交还客户端 |
| 泛化 429 扫账号池、伪装成 503、强制冷却至少五分钟 | 不轮换账号重放；返回真实 429 和错误正文；无提示时使用 cooldownSeconds |
| 请求可能已发送后自动重放 | 结果未知时返回 502，停止自动重放 |
| 预检成功或中间重试被当成生成成功 | 只有生成响应消费成功后重置连续错误计数，租约只释放一次 |
| 待验证账号仍参与调度 | 统一排除，支持 Google 未提供验证 URL 的情况；前端显示需验证 |
| 迟到的 401/403 可将已禁用/封禁账号改回冷却 | 保持终态及原有封禁原因 |
| 本地额度阻断覆盖 Google 额度快照 | 调度阻断单独记录，保留上游报告的剩余比例 |
| 管理接口添加脱敏字段但仍返回完整 OAuth token | 所有账号列表及变更响应统一通过字段白名单序列化 |
| 启动日志输出管理密码及客户端密钥 | 移除这些敏感输出 |
| 端口绑定失败前已启动后台刷新 | 成功监听后才启动；启动失败清理资源并非零退出 |
| 非法入参触发上游调用；空转换自动插入 Hello | 提前校验，空内容明确拒绝，不构造虚假用户输入 |
| 模型选择可能使用实时 picker 外的预设或 effort 错配 | 只从实时可见项选取；Gemini 3.8 Flash 的 picker 项按请求 effort 匹配 |

## 验证范围

- 25 项自动化测试：系统指令与历史、countTokens system/tools 补计、thinking preset 映射、429 后成功和持续失败、等待提示、取消、认证刷新、并发租约、未知网络结果、验证状态、终态保护、输入校验、管理接口凭证、流完整性、超时、连接池复用。
- TypeScript 构建、前端 JavaScript 语法检查及 Git 差异空白检查。
- 在已有进程占用 3000 时验证重复启动：非零退出，未启动 TokenRefresher/QuotaManager。
- 上述 Claude Code 对照、实时模型目录、长系统提示、thinking preset 和 countTokens Google 请求。
- 生成 HTTP/2 周期 PING、PING ACK、延迟消费响应体、客户端取消和响应体超时的本地回归测试；HTTP/2 Google 模型目录探测和带 14 个工具的真实生成请求均成功。

没有验证原生完整 Claude Code 提示的成功多轮对话，也没有证明 10–15 分钟长思考连接一定稳定。旧诊断服务已停止，3000 端口已释放；代码未提交或推送。
