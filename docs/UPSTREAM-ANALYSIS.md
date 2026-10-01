# 上游工作流分析

来源：[fakhar-iqbal/Job-Automation-with-n8n](https://github.com/fakhar-iqbal/Job-Automation-with-n8n)（MIT）。
以下全部是**静态读 JSON 得出的**，上游工作流没有真正跑过。

## 流程（41 个节点）

触发器是 `When chat message received`（手动发一条聊天消息才跑，**没有定时**），同时扇出两条分支：

```
LinkedIn 分支                               Jooble 分支
RSS Read (rss.app)                          HTTP Request3 (Jooble API)
 -> Loop Over Items                          -> Code（拆出 jobs 数组）
 -> HTTP Request（抓职位页 HTML）             -> Loop Over Items1
 -> JOB parser (Gemini：抽公司/福利/描述)      -> JOB parser2 (Gemini)
 -> Wait -> HTTP Request2 (Serper 搜 HR 邮箱) -> HTTP Request4/5 (Serper) -> Merge
 -> Message a model (Gemini：从搜索结果摘邮箱) -> Message a model1 (Gemini)
 -> HTTP Request7 (MailboxLayer 验邮箱)       -> HTTP Request8 (MailboxLayer)
 -> If2 (mx_found/smtp_check/disposable)     -> If3
 -> Get row(s) in sheet（按 Email 去重）      -> Get row(s) in sheet1
 -> If -> Rate you (Gemini 打 1-5 分)         -> If1
 -> Cover letter (Gemini 写求职信)            -> Cover letter2
 -> Append or update row（写 Sheets）         -> Append or update row in sheet1
 -> HTTP Request1（从 Drive 下简历）          -> HTTP Request6
 -> Send a message1 (Gmail 发给 HR)           -> Send a message2
两条分支跑完 -> Merge1 -> Send a message（给作者本人发"已投递"通知）
```

## 发现的问题（按严重度）

1. **评分不起作用**：`Rate you` 打出的分数没有任何节点判断，LinkedIn 分支对**所有**职位都发求职信；Jooble 分支压根没有评分步骤。
2. **Jooble 分支搜错公司**：`HTTP Request4/5` 的 Serper 查询里公司名写死成 `CLoudelligent`，不是当前职位的公司，所以这条分支找到的 HR 邮箱永远是同一家公司的。
3. **HR 邮箱靠 LLM 从搜索摘要里"摘"**，可能是编的、通用邮箱或过期邮箱；MailboxLayer 的 `smtp_check` 只能说明邮箱存在，不代表那是对的人。
4. **求职信不经人工审核直接发**（提示词里明说 "I will send this cover letter directly"）。
5. **去重只按 HR 邮箱**：同一个邮箱以后永远不会再收到任何职位；而职位本身（链接）不去重，RSS 每次重跑都会重复处理。
6. **主题固定**写死 `Application for AI/ML Engineer Role`，不管职位是什么。
7. **Gemini 模型名过时**：`gemini-1.5-flash`、`gemini-2.0-flash`、`gemini-2.5-flash-lite-preview-06-17`，导入后大概率要换。
8. 作者的密钥、简历、邮箱、Drive/Sheet ID 都硬编码在 JSON 里（已在基线中清除）。作者这几把密钥已经公开泄露，不要使用。
9. 没有错误处理：任何一步失败整个批次中断，没有失败记录。

## 我们怎么处理（重写，没有沿用）

基线清洗版（去密钥、去个人信息、Gmail 全禁用）一度做出来，但问题 1、2、5 是结构性的，补丁补不完，所以改为重写，沿用了它的思路和数据源：

| 上游问题 | 现在 |
|---|---|
| 1 评分不生效 | 评分是独立阶段，低于 `MIN_SCORE` 的直接跳过并记录 |
| 2 公司名写死 | 两条分支合并成一条，公司名来自每个岗位 |
| 3 AI 摘邮箱 | 邮箱由正则从岗位正文/网页提取并过滤；搜索 HR 邮箱（Serper + MailboxLayer）保留但默认关闭 |
| 4 不审核直接发 | 按你的要求不需要人工确认，但加了占位符检查、每日上限、收件人冷却、发送记账 |
| 5 去重只看邮箱 | 按岗位链接去重，历史记录在 `applications.jsonl` |
| 6 主题写死 | AI 按岗位写主题 |
| 7 模型过时 | 任意 OpenAI 兼容接口，模型名由配置决定 |
| 8 密钥硬编码 | 全部走 `config.local.env`；作者的泄露密钥一个都没有用 |
| 9 无错误处理 | 单个来源/岗位失败只记提示；AI 连续 3 次失败即停；所有来源都失败会标记失败并在补跑时段重试 |
| 手动触发 | launchd 每天 08:00 |
| Google Sheets / Gmail 节点 | 本地 jsonl + csv；SMTP 直发（零 Google 依赖） |
