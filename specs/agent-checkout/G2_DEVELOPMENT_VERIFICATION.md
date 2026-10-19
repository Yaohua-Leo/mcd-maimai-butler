# 真实订单测试阶段开发记录（2026-10-17）

用户反馈前一版人工验收无误后，继续开发真实创建、官方付款和未付款订单取消。具体订单的实际写调用仍须逐笔明确确认。

## 本轮实现

- 新增服务端 `order-access.js` 和管理员专用 `maimai_order_access` 表。用户指纹从平台可信身份计算，客户端不得选择授权主体；默认无授权、到期、数据库失败、非法金额上限时均关闭写入。`MCD_ORDER_WRITE_ENABLED=false` 保留为全局关闭开关。
- 已为当前微信用户上下文开启一条授权：单笔10000分，7天有效；未输出或写入文档原始OpenID、账号指纹或凭据。现有环境变量和加密密钥未修改。
- 创建和取消在长时间核价/查询后再次核对确认有效期与账号权限；确认到期或权限撤销时不发送写工具。
- 创建弹窗补全餐品数量；取消弹窗补全门店和金额。创建成功后读一次官方状态，取消受理后再查询，不用受理标志冒充取消成功。
- 付款链接须经最新订单状态、金额和官方截止时间校验。H5失败时允许用户主动重试或复制官方链接；复制前再次查状态，不把付款跳转/复制/返回视为付款成功。

## 已验证

- 79项Node测试通过，包括账号隔离、授权有效期、金额上限、总开关、权限撤销、长核价导致确认过期、付款截止时间、复制前再查询、卸载后忽略旧响应和既有70项回归。
- JavaScript语法与WXML编译通过，最终WXML摘要codeLength=168978；模拟器console的error过滤为空。
- `maimai_order_access` 读回为ADMINONLY。
- 更新后的 `mcd-token` 状态Active，ModTime=2026-10-17 11:38:49（平台返回值）；环境变量键仍只有既有环境ID及加密密钥。
- 真实小程序身份下 `order-access` 返回 enabled=true、maxTotalCents=10000、expiresAt=1792813191000，即2026-10-24 08:39:51 Asia/Tashkent。
- `order-readiness` 使用真实绑定账号调用麦当劳 `order-list` 成功，返回就绪状态；不返回历史订单内容或完整身份。
- 在真实用户、实时门店和方案下，`checkout-quote` 返回40.00元，gate.enabled=true；选取官方取餐方式后，`checkout-prepare` 成功生成一次性凭据并将版本更新至2，未发送`checkout-create`。截图 `evidence/local/20261017-g2-enabled-checkout.jpg` 已检查，显示单笔100元限制与可用的确认按钮，不包含确认凭据。
- 管理面聚合检查有效授权账号数为1、金额上限10000分；58份交付文件的凭据扫描无命中，可用真实环境Token作精确比较，未输出凭据。
- 本轮尚未调用真实 `create-order`、`cancel-order`、`query-order`，尚未进行付款。相关分支的模拟通过不代替真实G2验收，参见 `G2_RUNBOOK.md`。
- 最终 `create_preview_qrcode` 返回success=true，二维码 `evidence/local/20261017-real-order-preview.jpg` 已目视核对；只生成预览，没有正式/体验版发布。模拟器已回到首页，不保留测试清单供误操作。

## 验证命令

```powershell
node --test scripts/test_order_access.cjs scripts/test_payment_page.cjs scripts/test_checkout.cjs scripts/test_state_store.cjs scripts/test_conversation.cjs scripts/test_preferences.cjs scripts/test_miniprogram_account.cjs scripts/test_mcd_nutrition.cjs
node scripts/check_delivery_secrets.cjs
```

源码修改前副本位于Git忽略的 `evidence/local/backups/g2-live-20261017-083139`。没有提交Git或发布仓库，官方参赛声明未修改。
