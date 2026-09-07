# 域名与香港部署记录（含初期调研）

初次查询时间：2026-09-06 08:06 UTC（北京时间 2026-09-06 16:06）。下文候选和价格表保留当时的只读调研结果，不代表当前库存；用户随后已完成购买、实名、DNS 和公网部署。当前状态更新于 2026-09-06，见下节。

## 已购买与当前上线状态

- **域名：纳米work.cn**，已支付 ¥99/年并完成实名，有效期至 **2027-09-06**。
- **服务器：阿里云中国香港标准 BGP 轻量服务器**，4 vCPU / 8GB / 70GB / Ubuntu 24.04；订单 **2003165228980749** 已支付 **¥224/月**，自动续费关闭，控制台到期时间 **2026-10-06 08:59:59**。实际购买方案替代下文腾讯候选，低于用户每月 ¥500 上限。
- 公网 IPv4 为 **8.210.177.200**；apex 与 `www` 的 A 记录均指向该 IP，TTL 600。
- 正式入口为 **[https://xn--work-9r3ko5i.cn](https://xn--work-9r3ko5i.cn)**，已启用有效 HTTPS 证书；`www` 永久跳转到主域。release **20260906183112** 的 systemd 服务健康，生产 preflight **28 PASS / 3 WARN / 0 FAIL**。
- 历史数据已迁入生产：7 个账号、226 条内容、232 条预授权、233 条积分流水、14 个媒体任务、175822 积分；54 个被引用文件完成哈希核验。生产真实老板登录、任务列表 350 项、详情、余额与视频 ZIP 接口均返回 200；服务器通过正式 HTTPS 完整获取了视频 ZIP（30,633,185 字节）和小红书 ZIP（10,308,656 字节），压缩包完整性与实际媒体条目通过。测试机外网完整视频 ZIP 在 240 秒超时，属于仍保留的慢链路验收边界。
- Mac 双架构安装包已真实启动并连接正式 HTTPS；Windows EXE 已独立核验。三款 0.1.1 安装包均已上架首页，上传前后 SHA256 一致，公开 HEAD/Range 下载通过。均未发行签名，Windows 真机安装尚未验证。
- 每天北京时间 03:00 的本机备份 timer 已通过 Ubuntu 校验，首次真实 DB + uploads 备份完整性为 `ok`、服务退出码为 0，保留 14 天。客户端原件在本地另存，**尚未配置异地备份**。
- 生产 `ENABLE_SCHEDULER=false`，避免迁入的旧测试任务自动产生费用。按用户最新确认口径，上游钱包实际扣费经上游公开人民币换算后 ×2 的模式已启用，当前 1 积分 = 0.01 元；不再依赖采购充值人民币实付金额；商户支付未配置，当前只支持平台人工确认收款。
- 标准 BGP 不等于大陆到香港全时稳定链路。本轮 HTTPS 和业务实测不构成所有大陆实际网络均可用的承诺。

[阿里云轻量购买页](https://swasnext.console.aliyun.com/buy#/)、[官方套餐说明](https://help.aliyun.com/zh/simple-application-server/product-overview/instance-families/)、[创建服务器说明](https://help.aliyun.com/zh/simple-application-server/user-guide/create-a-server)。

## 初期域名调研（历史记录）

用户指定的 `纳米work.餐饮` 暂不能作为标准互联网域名注册：IANA 根区目录没有 `.餐饮`。相近但不同的 `.餐厅` 已获正式委派；不能将营销网址关键字当作域名。

- [IANA 根区目录](https://www.iana.org/domains/root/db)
- [IANA .餐厅委派记录](https://www.iana.org/domains/root/db/xn--imr513n.html)

以下结果记录初次查询时阿里云万网页面的名称、价格与“立即注册”按钮，未依靠 DNS 判断；其中纳米work.cn 随后已由用户购买：

| 名字 | 初次查询结果 | 首年 | 查询时续费/年 |
| --- | --- | ---: | ---: |
| 纳米work.cn | 当时可注册，现已购买 | ¥99 | ¥99 |
| 纳米work.com | 可注册 | ¥99 | ¥99 |
| 纳米work.餐厅 | 可注册，仍需注册局审核 | ¥1,200 | ¥1,200 |
| mynamiwork.cn | 可注册 | ¥38 | ¥42 |
| mynamiwork.com | 可注册 | ¥85 | ¥95 |
| namiwork.work | 可注册 | ¥15 | ¥45 |
| namiwork.hk | 可注册 | ¥108 | ¥145 |

购买查询入口：[纳米work.cn](https://wanwang.aliyun.com/domain/searchresult/?keyword=%E7%BA%B3%E7%B1%B3work.cn&suffix=)、[纳米work.com](https://wanwang.aliyun.com/domain/searchresult/?keyword=%E7%BA%B3%E7%B1%B3work.com&suffix=)、[纳米work.餐厅](https://wanwang.aliyun.com/domain/searchresult/?keyword=%E7%BA%B3%E7%B1%B3work.%E9%A4%90%E5%8E%85&suffix=)、[万网域名查询](https://wanwang.aliyun.com/domain/)。中文域名使用中文名报价，不能套用同后缀英文名活动价。

`namiwork.com` 和 `namiwork.cn` 万网查询为已注册；`namiwork.ai` 的[注册局 RDAP](https://rdap.identitydigital.services/rdap/domain/namiwork.ai)返回已注册记录（注册 2026-06-12，到期 2028-06-12）。因此三者不能按普通新注册价直接买；本轮没有联系持有人或开展二手交易。

`.餐厅` 有命名或资质审核，页面“可注册”不保证最终审核通过；[阿里云官方退款说明](https://help.aliyun.com/zh/dws/refunds)明确列出这一边界。当时为尽快上线且节省费用，优先比较 `纳米work.cn` 与 `纳米work.com`；用户最终选择并购买了前者，没有购买 `.餐厅`。

中文名可使用 HTTPS：[Let's Encrypt 官方支持 IDN 证书](https://letsencrypt.org/2016/10/21/introducing-idn-support)。`纳米work.cn` 的 ASCII 形式为 `xn--work-9r3ko5i.cn`，`.com` 同前缀；`.餐厅` 的 ASCII 后缀为 `xn--imr513n`。部署建议将证书、反代、PUBLIC_BASE_URL 和 CORS 使用一致的 ASCII hostname；浏览器或第三方表单可能显示 Punycode 或拒收中文输入，不能承诺每个平台都原样显示中文。

## 初期服务器比较（历史记录，未购买腾讯方案）

用户预算服务器每月不超过 ¥500。初期比较的腾讯云中国香港 Linux 轻量通用型为：4 核 / 8GB / 180GB SSD / 30Mbps 峰值 / 每月 5120GB 流量，查询时标准月付 ¥320。官方当时同时适用于新购与续费，1–5 个月无时长折扣；12 个月及以上 85 折，按当时单价计算一年 ¥3,264。此方案未购买，当前运行的是上节已付款的阿里云 ¥224/月实例。

备选腾讯香港锐驰型 4 核 / 8GB / 120GB SSD / 200Mbps 峰值 / 无限流量，标准月付 ¥280。峰值带宽不代表大陆全时稳定速率。未在账号内核验当前库存、镜像可选项及最终订单。

以上来自[腾讯云官方价格总览](https://cloud.tencent.com/document/product/1207/73452/)，更新于 2026-06-15。香港套餐外流量 ¥1/GB；备份、额外磁盘另计。官网明确香港“入门型”不能保障跨境网络质量，因此不推荐以其 ¥38/¥90 入门价作为本项目大陆访问方案。

可选[优选流量包](https://cloud.tencent.com/document/product/1207/104332)专门优化香港到大陆出方向链路，需要购买后给实例开启；[官方价格](https://cloud.tencent.com/document/product/1207/104334)为 10GB ¥19.5、50GB ¥94.9，6 个月有效。它是额外加速流量，不等于套餐内全部流量都获得优化。可用 ¥320 + ¥94.9 的首次支出试验 50GB，不能把有限包描述成无限大陆优化带宽。购买入口：[腾讯云轻量服务器](https://buy.cloud.tencent.com/lighthouse)，当前跳转登录，需用户本人注册/验证/付款。

初期阿里云规格核验依据：[轻量实例套餐](https://help.aliyun.com/zh/simple-application-server/product-overview/instance-families/)提供香港标准 BGP；国际型 BGP_NCO 明确不适合面向大陆访问。当时公开页尚未取得香港最终月付报价，因此没有套用国内促销价；后续已在登录后的购买页和实际订单核实并支付 ¥224/月，详见上节。

## ICP 与部署边界

香港源站可以不等待大陆服务器的 ICP 备案；域名实名和云账号实名认证仍是注册商/云商流程。将来使用大陆源站或大陆 CDN 时需按对应要求备案。[腾讯官方备案问答](https://cloud.tencent.com/document/api/243/19630)。香港跨境链路仍可能出现延迟、丢包或个别网络不可达，不能保证所有国内网络 100% 可用。

部署已复用仓库 `ops/deploy/` 的 Ubuntu、Caddy、systemd、迁移与备份脚本。生产 preflight 与正式域名登录验收已完成，当前仍按上节列出的 ZIP 下载、实际成本和支付配置边界记录，不将未验收项视为完成。

部署使用 `current` 发布链接和 `server/data -> /var/lib/nanowork/data` 持久目录链接。迁移与服务均配置 `NANOWORK_DATA_DIR=/var/lib/nanowork/data` 作为精确信任锚；数据库及 sidecar 文件链接、目录越界仍拒绝。该兼容修复已通过 11 项定向测试并用于本次部署。FFmpeg 可执行文件链接与最终产物文件链接仍采用不同校验，未全局放宽符号链接保护。
