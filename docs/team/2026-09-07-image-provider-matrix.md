# 360 五类生图示例与同 Key 对照实测

北京时间 2026-09-07 12:45:41–12:45:42，在香港线上服务器用 Python http.client 直接 POST `/v1/images/generations`。五项各一次，不查模型列表，不自动重试。模型与字段层级来自当次重新读取的 https://ai.360.com/docs/413292017e0.md ；提示词统一为赤狐题材，组图要求四张。

| 示例 | 模型 | 实际结果 |
|---|---|---|
| Image2 | openai/gpt-image-2 | HTTP400 / 1001 / 无图 |
| Nano Banana | google/gemini-3-pro-image-preview | HTTP400 / 1001 / 无图 |
| 万相2.7 | alibaba/wan2.7-image | HTTP400 / 1001 / 无图 |
| Seedream单图 | volcengine/doubao-seedream-5.0-lite | HTTP400 / 1001 / 无图 |
| Seedream组图 | volcengine/doubao-seedream-5.0-lite | HTTP400 / 1001 / 无图 |

万相沿用 `extra_body.input.messages` 和 `extra_body.parameters`，无顶层prompt；其他模型保持各自专有参数。五份返回体逐字节相同：`{"error":{"code":"1001","message":"参数错误:model参数对应模型不存在或未授权"}}`。没有返回usage或扣款金额，不按零成本处理。

12:48:55–12:48:57又用相同服务器、同份Key配置做对照：Flash新文本请求HTTP200、正文OK、usage.amount=0.00003；已有万相3.0任务只查询状态，HTTP200、SUCCEEDED、查询amount=0，没有重新生成视频。

结论限于：认证与连接并非整体失效；失败集中在图片生成接口的模型参数处理。合并错误未给出内部判断条件，无法据此确定账号权限、参数映射或模型识别的具体原因；模型目录缺失不参与判断。

完整脱敏请求头、HTTP请求、实际JSON请求体、原始响应体、响应头、时间摘要、Python复测脚本与zip位于桌面 `360生图五类模型实测-2026-09-07`。Host曾由记录器存成Python bytes表示，已按实际字节解码为HTTP文本，未重发请求；记录摘要注明，网络传输本身未受影响。所有Content-Length与原始body字节数相符，真实Key未出现在交付文件中。

本轮仅做接口测试和证据交付，没有更换产品默认图片模型，也未新增应用部署。

## 用户指定仅传 model 与 prompt 的复测

北京时间 2026-09-07 12:57:58–12:57:59，同一香港服务器和同份 Key 配置再次直连上述端点，五项各一次。实际 JSON 请求体均且仅有 `model`、`prompt`，鉴权仍使用 HTTP Authorization。五项全部 HTTP400 / 1001，原始返回体与上轮相同，返回图片0张；未返回usage，不推断扣费为零。

Image2取消n、size、quality、response_format、style后错误未变，因此仅删除这些附加参数没有解决本次调用。错误本身仍不足以区分模型路由与授权等原因。万相此次顶层prompt是用户指定的最小兼容格式实验；Seedream取消组图auto/max_images，只在提示词中要求四张，不能由该实验推断组图能力。

五份真实请求体与两字段测试配置逐项核验一致，请求头正确、没有目录查询或额外模型头。证据独立保存在桌面 `360生图最小参数实测-2026-09-07`，包含HTML报告、完整请求/响应、JSON汇总、无内嵌Key的复测脚本与ZIP。Key脱敏检查和ZIP完整性校验通过。此前完整参数记录保留；没有修改或部署应用代码。

## 再次确认模型名后的单项复测

用户再次指定 `openai/gpt-image-2` 后，北京时间2026-09-07 13:11:46从香港服务器以同一Key、仅model/prompt单独提交一次，0.402秒返回HTTP400/1001，没有图片、没有usage。模型字符串与前次真实请求逐字节相同，不能描述为已经修正前次错误模型名。最新脱敏请求响应随桌面技术交接包保存于 `证据/Image2模型名再次确认-131146/`。无应用改动或新增部署。
