# 付款链路验证页

`payment-check.html` 不是第二套客户端，只用于 G2 订单闭环通过前的受控兼容性测试。

```powershell
python -m http.server 8765 --directory web
```

然后打开 `http://127.0.0.1:8765/payment-check.html`。只有在获得明确批准并取得测试订单付款链接后，才可以粘贴链接测试；不要把真实链接写入日志、截图或仓库。
