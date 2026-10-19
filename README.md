# 麦麦管家 · maimai-butler

**用麦当劳中国 MCP 帮你决定这一餐：选门店、按预算搭配、核对营养，再给两个替换方案。**

这是[麦当劳程序员创意开发大赛](https://github.com/M-China/mcd-developer-innovation-challenge)参赛作品。公开交付以可直接加载的[只读 Skill](skills/maimai-butler/SKILL.md)为主，同时提供 Python 推荐后端、微信小程序与 CloudBase 云函数源码，方便复现和二次开发。微信小程序不进行正式发布；使用 Skill 不需要安装小程序或部署云服务。

## 适合谁

适合准备吃工作日午餐、下班晚餐，却不想逐项比较菜单的学生和上班族。告诉麦麦管家城市、位置关键词、预算和不想吃的东西，确认餐厅后，它从该店本次返回的菜单中选一份一人餐，并说明价格、营养来源与缺失信息。

## 能做什么

- 查询附近门店，先确认营业餐厅，再读取对应渠道的菜单。
- 根据预算、口味和明确排除项，推荐一份完整一人餐和两个替换方案。
- 查询套餐默认搭配与规格，匹配热量、蛋白质、钠等官方营养字段；无法可靠匹配时显示“暂无数据”。
- 按需查询指定日期的活动，标注适用日期、门店、渠道与更新时间。
- 区分“实时 MCP”和“非实时快照”；只读 Skill 不创建或取消订单，不领券、抽奖、兑换积分或付款。

## 快速使用 Skill

1. 下载或克隆本仓库到任意本地目录。下文路径均相对仓库根目录；Windows、macOS、Linux 不需要使用开发者的盘符或目录。
2. 在支持 Skill 与 MCP 的客户端中加载 `skills/maimai-butler/SKILL.md`。可按客户端的导入方式安装整个 `maimai-butler` 文件夹；需要查看项目说明时，保留本仓库目录结构。也可以在当前仓库会话中直接要求助手读取该文件执行。
3. 在[麦当劳 MCP 控制台](https://open.mcd.cn/mcp)申请自己的 Token，并通过客户端的本机凭据配置或环境变量 `MCD_MCP_TOKEN` 提供。不要把实际 Token 放入聊天、代码、截图或提交记录。
4. 配置 `mcd-mcp`：Endpoint 为 `https://mcp.mcd.cn`，Transport 为 Streamable HTTP，认证头由本机凭据注入。通用结构见 [`mcp-config.example.json`](mcp-config.example.json)；环境变量占位符是否支持自动替换须按客户端确认。Codex 项目配置位于 `.codex/config.toml`，审批模式保持 `prompt`。
5. 只启用 Skill 列出的六个查询工具，开始对话。实时查询需要有效 Token 与可访问 MCP 的网络；离线演示无需 Token。

示例请求：

```text
请使用 skills/maimai-butler/SKILL.md。
我在北京望京，想到店自取，预算 40 元，不吃辣。
先让我选餐厅，再推荐一份一人餐和两个替换方案。
标明价格、营养来源与查询时间，不要下单。
```

选定门店后，可以继续说：

```text
饮料换一个，其他尽量不变；如果没有满足预算的方案，请直接说明。
```

输出应包含餐品组成、适用门店与渠道、价格、可核实的营养字段、替换方案和数据状态。示例中的预算只是输入条件，不代表实时菜单存在对应套餐。营养与价格缺失时应如实说明，不能为了凑齐卡片而编造数值。

## 不联网体验推荐逻辑

需要 Python 3.10 或更高版本。在仓库根目录执行下列命令；部分系统使用 `python3` 代替 `python`：

```shell
python -m pip install -r requirements.txt
python -m backend.server
```

浏览器打开 `http://127.0.0.1:8787/health` 检查服务。`POST /api/recommend` 接受如下 JSON：

```json
{
  "preferences": {"budget": "light", "mood": "balanced"},
  "locationLabel": "演示门店"
}
```

也可直接在终端生成一份 fixture 推荐：

```shell
python -c "import json; from backend.recommendation import recommend; print(json.dumps(recommend({'budget':'light','mood':'balanced'}, location_label='demo fixture'), ensure_ascii=False, indent=2))"
```

该路径使用固定演示样本，不接收 Token，不查询实时门店或菜单。`/api/agent` 也支持本地规则对话。Python 实时只读适配器须显式启用 `MCD_MCP_LIVE_MODE=1`，并由后端进程读取 `MCD_MCP_TOKEN`；它与默认 fixture 路径分开，详见 [`backend/README.md`](backend/README.md)。

## 可选：小程序与云函数源码

[`src/`](src/) 提供原生 WXML、WXSS、JavaScript 界面；[`cloudfunctions/mcd-token/`](cloudfunctions/mcd-token/) 提供用户身份隔离、加密凭据、自然语言推荐、偏好和报价等开发实现。用微信开发者工具导入**仓库根目录**前，将 `project.config.example.json` 复制为 `project.config.json`，具体步骤见 [`src/README.md`](src/README.md)。实时云端功能需要使用者自行配置 AppID、CloudBase、数据库和密钥。

源码中还保留受控订单实验分支。这些分支不属于本次只读 Skill，代码与模拟测试不代表公开订单服务、支付闭环或退款流程已验收。本仓库不提供已正式上线的小程序入口，也不承诺现有开发环境对公众开放。

## 验证范围

2026-10-19 投稿前验收：97 项 Node 测试、18 项 Python 测试通过；WXML/WXSS 编译和本地 HTTP 演示通过；重新调用营养工具成功。检查范围、公开文件扫描和限制见 [`ACCEPTANCE.md`](ACCEPTANCE.md)。

| 范围 | 已有证据 | 边界 |
| --- | --- | --- |
| MCP 只读查询 | 2026-10-09 至 10-17 的时间、门店、菜单、详情、营养、活动查询记录 | 历史成功不保证所有门店、渠道或未来日期都有数据 |
| 小程序只读推荐 | 2026-10-17 的真实用户上下文、门店选择、推荐与营养匹配记录 | 不等于正式发布或任意账号可用 |
| 报价与订单查询 | 2026-10-17 的 `calculate-price`、`order-list`、`query-order` 记录 | 不属于公开 Skill 的六工具范围，不证明写订单或支付闭环 |
| 自动测试 | 仓库包含 Python 契约测试和 Node 隔离测试 | fake/fixture 测试不当作实时 MCP 调用证据 |

真实工具、调用流与 planned 项目集中记录于 [`MCP_INTEGRATION.md`](MCP_INTEGRATION.md)。历史产品设计见 [`PRD.md`](PRD.md)，开发验收记录见 [`specs/agent-checkout/`](specs/agent-checkout/)；其中关于正式发布与订单扩展的计划，不是本次公开交付承诺。

## 仓库导航

| 路径 | 内容 |
| --- | --- |
| [`skills/maimai-butler/SKILL.md`](skills/maimai-butler/SKILL.md) | 参赛核心：只读推荐 Skill |
| [`MCP_INTEGRATION.md`](MCP_INTEGRATION.md) | MCP 工具、流程、业务价值和验证边界 |
| [`backend/`](backend/) | fixture 服务、只读 MCP 适配器与测试 |
| [`src/`](src/) / [`cloudfunctions/`](cloudfunctions/) | 可选小程序与云函数源码 |
| [`scripts/`](scripts/) | 回归测试与交付凭据扫描 |
| [`assets/manifest.md`](assets/manifest.md) | 数据与素材来源说明 |
| [`CONTEST_DECLARATION.md`](CONTEST_DECLARATION.md) | 官方参赛声明，保持原文 |

本项目是独立参赛作品。实际价格、供应、活动与账户权益以麦当劳官方本次返回信息为准。
