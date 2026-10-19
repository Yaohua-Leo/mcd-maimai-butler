# 四阶段自动验证记录（2026-10-17）

本记录区分已运行的测试、真实只读调用与尚待人工完成的订单验收。日期按 Asia/Tashkent；部署时间保留平台返回值。

## 代码与运行边界

- 后端：`cloudfunctions/mcd-token/{index,state-store,conversation,preferences,quote,checkout}.js`；前端：`src/pages/index` 与 `src/pages/payment`。
- 管理面 `updateFunctionCode` 更新后，`mcd-token` 状态为 `Active`，最后核验的 `ModTime=2026-10-17 04:46:53`，运行时 Nodejs18.15、超时60秒。环境变量仍只有既有环境ID和加密密钥；没有启用订单写入变量或测试用户白名单。
- 新增 `maimai_agent_state` 的权限与现有 Token 表均再次核验为 `ADMINONLY`。服务端查询包含平台身份、记录类型和记录ID；状态载荷用已有 AES-GCM 密钥加密，不保存原始聊天。会话/报价使用逻辑有效期；尚未增加定期物理清理任务。
- 小程序真实调用中附带伪造的 `userInfo.openId` 与 `owner_id` 后，仍读取到真实调用者自己的会话，未切换身份。管理面调用具有管理员权限，不能拿管理面身份注入当作普通客户端的隔离证明。

## 自动测试

命令：

```powershell
node --test scripts/test_checkout.cjs scripts/test_state_store.cjs scripts/test_conversation.cjs scripts/test_preferences.cjs scripts/test_miniprogram_account.cjs scripts/test_mcd_nutrition.cjs
```

70 项通过，覆盖连续补丁/局部锁定/相对预算、偏好授权/恢复/停用/删除、SQL 账号和版本边界、菜单规格与营养、报价单位/金额/数量、报价变化重新确认、创建并发去重、未知创建阻止重发、候选订单人工关联、支付URL与状态校验、取消单独确认及未知结果、页面等待与旧回调保护。

订单写工具全部使用本地替身，测试不访问真实 `create-order` 或 `cancel-order`。跨账号数据隔离的不同 owner 检查是隔离测试，尚未用两部真机账号互测。

JavaScript 语法检查通过；微信开发者工具 WXML/WXSS 编译通过，最终 WXML 摘要 `codeLength=166211`。后续如模板继续修改，应以重新编译的记录为准。

## 真实联调

1. 小程序平台身份、已绑定 Token、已保存供应商配置均能读取；不重新绑定 Token 或改写供应商。
2. 手动查询北京望京返回5家餐厅，选择营业的“麦当劳北京南湖北一街餐厅”。首轮40元预算返回麦香鸡、麦乐鸡5块、纯悦，菜单合计39.50元。最终前端重新编译后再次走通此链路。
3. 同一会话继续“不要饮料，主食和配餐保持不变”，页面从等待自动进入新结果，版本1→2，保留主食1450与配餐1401，移除饮料3757，菜单合计39.50→32.00元。变更摘要与服务端保存一致。
4. 真实 `query-meal-detail → calculate-price` 返回3200分（32.00元），商品小计1700+1500分，优惠0分；可用取餐方式 `eat-in`（堂食）、`take-in-store`（外带）。未返回的包装/配送/餐具费用显示“—”，不当作0。确认页实际显示 gate.disabled，不能创建订单。
5. 真实偏好测试：确认原来没有偏好后，创建带“测试偏好”标记的临时记录；重新读取预算37，更新为38、版本1→2，旧版本请求返回 `version_conflict`；停用后 enabled=false；删除后 saved=false。测试记录已清除。删除同时清除测试会话，后续重新创建了新的验收会话。
6. 最终确认页把麦香鸡数量从1增加为2：真实报价变为4900分（商品3400+1500分），`overBudget=true`，显示超过40元预算。调整触发新报价，旧报价不继续用于确认。

## 联调中修复的兼容问题

- CloudBase 参数化 SQL 层拒绝 `IS NULL`，改用其[SQL 模板文档](https://docs.cloudbase.net/model/sql-template)列出的 `<=> NULL`；[服务端 SQL 文档](https://docs.cloudbase.net/model/db-raw-query)确认 `$runSQL` 参数化调用与更新能力。实际会话更新随后成功。
- 本环境将绑定参数中的 JavaScript null 写成零日期，导致永久偏好记录无法通过到期条件更新；改成固定 SQL `NULL` 字面量，用户值仍全部参数化。实际完整偏好周期随后通过，故障测试记录已删除。此项是本次环境观察，不推广成所有 SDK 版本的结论。
- 可疑创建结果的时间/门店/餐品/金额匹配仅产生候选；必须用户确认关联，不将单一匹配当成该次提交的确定证据。

## 交付检查与待人工项目

- `node scripts/check_delivery_secrets.cjs` 最后检查56份交付源码/文档；本机环境中的真实 MCP Token 精确比较可用，候选凭据模式检查结果为0条。扫描不输出任何匹配内容或凭据。
- 未修改官方 `CONTEST_DECLARATION.md`，未提交Git、未发布仓库、未上传体验版或正式版。
- 真机头像/定位权限、支付H5业务域名兼容性、真实创建/付款/取消、退款不由这些测试证明。真实G2步骤见 `G2_RUNBOOK.md`；统一人工清单见项目根目录 `MOBILE_ACCEPTANCE.md`。
- 截图与预览二维码仅保存在 Git 忽略的 `evidence/local/`。真实报价截图：`20261017-checkout-live.jpg`、`20261017-checkout-options.jpg`。最终确认页版式检查 `20261017-checkout-layout-final.jpg` 使用已取得报价数据回放，检查全宽按钮与取餐选中状态，不增加真实算价证据。订单页 `20261017-order-layout-controlled.jpg` 使用明确标注的模拟订单，只作版式检查，未创建真实订单；检查后已清除模拟页面状态。模拟器 console 的 error 过滤为空。
- 最终原生 `create_preview_qrcode` 返回 `success=true`，文件 `evidence/local/20261017-agent-checkout-preview.jpg` 已目视核对，入口 `pages/index/index`；未上传体验版或发布正式版。订单列表实际读取完成且为空、无错误，模拟器已返回首页。
