# 投稿验收记录

验收日期：2026-10-19（Asia/Tashkent）。交付为公开只读 Skill、离线演示和小程序/云函数源码；不发布微信正式版，也不新部署云服务。

## 本轮验证

| 检查 | 结果 |
| --- | --- |
| Node 隔离回归 | 97/97 通过：会话、偏好、营养、账号、报价、订单状态、权限与防重复 |
| Python 契约回归 | 18/18 通过 |
| 小程序文件 | 4 个页面，WXML/WXSS 本地编译通过；前端与后端修改的 JS 语法检查通过 |
| 离线入口 | 默认不初始化云开发；`GET /health`、`POST /api/recommend` 均返回 HTTP 200 |
| 本次真实 MCP | `list-nutrition-foods` 返回 `code=200`，160 条营养记录；未调用写工具 |
| 官方声明 | 从官方仓库重新取得原始字节，未编辑措辞；Git 禁止该文件的换行转换 |
| 公开集合 | `.gitignore` 排除本机配置、预览、备份、调研副本和私人发布记录；扫描覆盖待提交源码、脚本、SQL、配置、文档与资产 |

官方声明 SHA-256：`cd28101bcb29cc8fb24b372fe91ce6b42c4a1487a54e01f7ade0c8c6a84241b7`。

可复跑：

```shell
node --test scripts/test_checkout.cjs scripts/test_state_store.cjs scripts/test_conversation.cjs scripts/test_preferences.cjs scripts/test_miniprogram_account.cjs scripts/test_mcd_nutrition.cjs scripts/test_order_access.cjs scripts/test_payment_page.cjs
python -B -m unittest backend.test_recommendation backend.test_agent_runtime
node scripts/check_delivery_secrets.cjs
```

提交前另运行 `node scripts/check_delivery_secrets.cjs --staged` 检查 Git 暂存区的实际字节。扫描仅输出文件路径与数量，包含本机已配置 Token 的精确比较和常见凭据格式检测；不输出凭据。模式检测不能证明不存在任何种类的敏感内容，因此同时审查了公开文件清单。

## 本轮修正

- README 与 MCP 集成说明统一为最终交付范围，保留历史真实调用与 planned 的区别。
- 小程序源码默认 `cloudEnabled=false`、空环境标识；自己的 AppID 使用被忽略的本地 `project.config.json`，公开示例仅供测试模式导入。
- 服务端更换 AI 接口 URL 必须重新提供密钥，拒绝 URL 内嵌凭据、localhost 和 IP 字面量；新增三项回归。
- 官方声明原先缺少一个空行，已直接用官方原文恢复。

## 验证边界

- 本轮模拟测试不会产生订单或消费；历史订单查询成功不能证明真实创建、取消、支付、退款的完整闭环。
- 不把本地编译当作此次真机操作或正式上线验收，也不保证克隆后无需配置即可连接云服务。
- 自定义模型 URL 的校验未实现 DNS 绑定、重绑定及重定向的完整防护；多用户公共托管和生产安全评估尚未验收。
- `workbuddy.md` 仅记录已知实际连接调试与时间工具调用，专项奖励资格以主办方核验为准。

官方要求与报名入口见[活动仓库](https://github.com/M-China/mcd-developer-innovation-challenge)。本文件是技术验收记录，不是主办方报名成功通知。
