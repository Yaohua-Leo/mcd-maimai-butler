# 本地推荐后端

这是麦麦管家推荐版的本地 fixture 服务。它提供一个稳定的后端接口契约，
默认不连接 MCP、不接收任何 Token，也不会调用 `create-order`、`cancel-order`
或其他写工具。实时只读联调路径必须由后端进程显式开启。

## 运行

在本仓库根目录执行：

```powershell
python -m backend.server
```

健康检查：`GET http://127.0.0.1:8787/health`

推荐接口：`POST http://127.0.0.1:8787/api/recommend`

## Agent Runtime（第一阶段）

Agent 接口：`POST http://127.0.0.1:8787/api/agent`

它先用 `provider_adapter.py` 中的确定性 Provider 作为无模型安全回退，再通过有白名单的只读 Tool Broker 调用门店、菜单、餐品详情和营养工具。后续 CloudBase 或用户自带模型只需实现同一个 Provider 契约。请求示例：

```json
{
  "message": "北京望京，预算30元，清淡一点",
  "context": {}
}
```

需要实时 MCP 时，在后端进程设置 `MCD_MCP_LIVE_MODE=1`，并在请求中加入 `X-MCD-Agent-Mode: live`。实时模式仍只允许只读工具；没有城市/位置关键词时返回 `clarifying`，不会猜测门店。当前默认 Provider 不调用模型、不持有前端凭据、不生成或执行真实订单；CloudBase AI 模型接入需先通过资源包和模型组预检。

```json
{
  "preferences": {"budget": "light", "mood": "balanced"},
  "locationLabel": "北京 · 演示门店"
}
```

返回值中的菜单、价格和营养均明确标为 `demo fixture; 待 MCP 验证`。

## 受控实时只读联调

仅在后端进程中设置 `MCD_MCP_LIVE_MODE=1` 且已有 `MCD_MCP_TOKEN` 时，才使用：

`POST http://127.0.0.1:8787/api/recommend-live`

请求需要 `city`、`keyword`、`beType` 和 `preferences`。此路径只调用门店、菜单、餐品详情和营养查询；小程序默认仍使用 fixture，不会把 Token 传到客户端。

Token 生命周期契约位于 `backend/token_manager.py`，当前只用于本地验证。CloudBase 环境、用户身份和生产密钥托管未配置前，不开放真实 Token 提交接口。
