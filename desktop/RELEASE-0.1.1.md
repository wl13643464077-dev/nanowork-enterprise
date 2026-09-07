# 桌面客户端 0.1.1 交付记录

日期：2026-09-06。构建主机：macOS Apple Silicon。以下是实际生成的安装文件，不能把构建成功等同于所有操作系统的安装验收。

## 默认连接

- 新安装默认 `https://xn--work-9r3ko5i.cn`（纳米work.cn）。
- 保留已有 `desktop-config.json` 中用户保存的企业或本机地址，不自动覆盖。
- 客户端是服务器薄客户端，安装包不包含后端、API 密钥、数据库、上传图片或业务记录。需要联网和有效账号。
- 自动更新仍默认关闭；业务页面来自正式服务。

## 首页下载文件

统一目录：`desktop/dist-download-0.1.1/`。`manifest.json` 使用 `{releases:[{id,file,version,sha256}]}`，仅登记实际文件。

| 平台 | 文件 | 字节数 | SHA256 |
|---|---|---:|---|
| Mac Apple 芯片 | `NanoWork-0.1.1-mac-arm64.dmg` | 120260402 | `eacd748ddc9c2a1440cbe81182908fc4e8f6440199fe24ab693f86c5ea99deab` |
| Mac Intel | `NanoWork-0.1.1-mac-x64.dmg` | 122256506 | `7ce09ffa272ecfbe049b3e9adaa9825be1a10ce205acd0ee92f875af3fe4d568` |
| Windows x64 | `NanoWork-0.1.1-win-x64.exe` | 112806622 | `2274333403bab3aad10adf48e49772dc8bc24b6c3f988b260e1e76b5a36238b6` |

Mac ZIP 位于同目录；Windows 完整解包应用及便携 ZIP 位于 `desktop/dist-download-win-0.1.1/`。

## 已完成验证

1. `npm --prefix desktop run verify`：构建配置和 **39 项测试通过**。
2. 两份 Mac DMG 的 `hdiutil verify` 均通过；两份只读挂载镜像内应用均真实启动，连接本机服务并打开设置页，退出码 0。
3. 正式 HTTPS 开通后，两种架构再次从 DMG 只读挂载内启动：使用全新临时 `userData`，明确移除服务器 URL 环境覆盖，按包内默认正式域名访问主页面和设置页，退出码均为 0。Intel 路径通过本机 Rosetta 验证，未声称 Intel 实体机器验收。
4. `verify-artifacts.mjs mac` 和 `win` 均通过包内白名单检查。三种平台的 `app.asar` 相同，SHA256 为 `7f7c063b1d4afd6a2adc4d9bc0e74734c11e0d7a23267c922620e0c06260b44c`；版本 0.1.1、默认域名和工作区源码匹配。
5. Windows EXE 和 ZIP 均通过独立 `7zz t` 完整性检查。安装器识别为真实 NSIS 自解压程序，安装器引导程序为 x86，内部主应用为 PE32+ x86-64；两者 Authenticode 证书表均为空。
6. Electron 43.4.1 三种运行时均按锁定依赖自带的官方 `checksums.json` 校验。Windows 运行时从镜像下载，但实际 SHA256 必须匹配官方值：`c2ef9a5f65472c34d14bd3e67b7d14e66b0c01f124aba45263d6a4232160e13a`。

## 签名与安装边界

- 本次没有购买、使用发行签名证书，也没有执行自动发布。
- Mac 无 Developer ID 签名和 Apple 公证。Apple 芯片可执行文件只有链接器 ad-hoc 标记，完整资源签名检查未通过；Intel 应用未签名。不能宣称 Gatekeeper 放行或无信任提示。
- Windows 未 Authenticode 签名，未在 Windows 真机执行安装、启动和卸载；不能宣称 SmartScreen 放行。
- 首次运行验证证明了包内默认正式地址可用，未自动登录用户、创建账号或调用付费 AI。

最初桌面“2026-08-23-最终内测包”目录已经只剩说明、哈希清单和 blockmap；本轮没有把不存在的旧安装文件计为可下载产物。

## 本地复现

```sh
npm --prefix desktop run verify
node desktop/scripts/verify-artifacts.mjs mac desktop/dist-download-0.1.1
node desktop/scripts/verify-artifacts.mjs win desktop/dist-download-win-0.1.1
```

打包使用锁定 Electron 缓存、`--publish never`。Mac 使用 `CSC_IDENTITY_AUTO_DISCOVERY=false`；Windows 使用 `win.signExecutable=false`，保留应用品牌和版本资源编辑。未放宽应用沙箱、远程 HTTPS 和证书校验。
