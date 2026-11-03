# 局域网共享方案

桌面端作为局域网服务端，手机 / 电视 App 通过 UDP 广播发现设备后直接访问 HTTP API，完成收藏浏览、搜索、详情、播放与进度同步。

## 1. 已确认的决策

| 项目 | 结论 |
| --- | --- |
| 发现方式 | UDP 广播，客户端广播、桌面端单播应答 |
| 配对 | 不做配对，私网内直接访问 |
| 首版客户端 | Flutter，先 Android 手机 + Android TV |
| 能力范围 | 收藏增删、搜索、详情、播放、进度同步、站点规则管理 |
| 传输 | HTTP + JSON（首版明文，后续可选 HTTPS） |

桌面端默认关闭该功能，用户需要在设置中手动开启。

## 2. 拓扑

```text
┌────────────────────┐    UDP 39393 广播发现      ┌──────────────────────────┐
│ 手机 / TV App      │ ─────────────────────────► │ 桌面端 VeloReel           │
│ (Flutter)          │ ◄───────────────────────── │  ├ UDP 发现应答            │
│                    │     announce + port        │  ├ HTTP API (8790)         │
│                    │ ─────────────────────────► │  ├ 搜索 / 详情 / 规则       │
│                    │      REST + JSON           │  ├ 流地址解析 + 缓存        │
│                    │ ◄───────────────────────── │  └ LAN 媒体代理            │
└────────────────────┘      HLS / MP4 分片        └──────────────────────────┘
```

## 3. 发现协议

- 端口：`UDP 39393`（固定，桌面端只在开启共享时监听 `0.0.0.0`）。
- 客户端向 `255.255.255.255:39393` 或子网广播地址发送：

```json
{"v":1,"type":"discover","clientId":"...","clientName":"客厅电视","platform":"android-tv"}
```

- 桌面端只对私网来源应答，单播返回：

```json
{"v":1,"type":"announce","name":"影梭","appVersion":"0.1.0","httpPort":8790}
```

- 单条报文上限 512 字节，非法 JSON / 版本不匹配直接忽略。
- 客户端建议每 2 秒广播一次，最多 3 次；收到应答即停止。
- mDNS（`_veloreel._tcp.local`）作为后续兼容项，不纳入首版。

## 4. HTTP API

基础路径 `/api/v1`；写接口使用 `POST` / `PUT` / `DELETE`，请求体上限 32 KB。响应统一为 JSON，错误格式：

```json
{"error":{"code":"INVALID_ARGUMENT","message":"关键词不能为空"}}
```

| 方法 | 路径 | 说明 | 状态 |
| --- | --- | --- | --- |
| GET | `/api/v1/info` | 服务名、版本、协议版本 | 阶段 1 |
| GET | `/api/v1/health` | 存活检查 | 阶段 1 |
| GET | `/api/v1/favorites` | 收藏列表 | 阶段 1 |
| GET | `/api/v1/sites` | 可用站点（siteId / siteName） | 阶段 1 |
| GET | `/api/v1/search?keyword=&siteId=` | 聚合搜索 | 阶段 1 |
| GET | `/api/v1/detail?siteId=&detailUrl=` | 详情与剧集 | 阶段 1 |
| POST | `/api/v1/stream/resolve` | 解析并创建播放会话，返回 LAN 清单地址 | 已完成 |
| POST | `/api/v1/stream/release` | 释放播放会话 | 未实现，靠 30 分钟空闲回收 |
| GET | `/api/v1/history?seriesId=` 或 `?siteId=&detailUrl=` | 观看记录（单条或全部） | 已完成 |
| POST | `/api/v1/progress` | 上报进度（按 `updatedAt` 做旧数据保护） | 已完成 |
| POST | `/api/v1/favorites` | 新增收藏 | 已完成 |
| DELETE | `/api/v1/favorites/:favoriteId` | 删除收藏 | 已完成 |
| GET | `/api/v1/rules` | 全部站点规则 | 已完成 |
| GET / PUT / DELETE | `/api/v1/rules/:siteId` | 单站点规则读取 / 保存 / 删除，变更后失效流缓存 | 已完成 |
| GET | `/api/v1/image?url=`（兼容 `?u=`） | 封面代理，仅允许图片类型，8 MB 上限，10 分钟内存缓存 | 已完成 |
| GET | `/api/v1/dlna/devices` | SSDP 搜索局域网 DLNA 电视（结果缓存 60 秒） | 已完成 |
| POST | `/api/v1/dlna/cast` | 把本机媒体地址推给电视并播放 | 已完成 |
| POST | `/api/v1/dlna/stop` | 停止电视上的投屏 | 已完成 |
| GET | `/api/v1/dlna/position?deviceId=` | 查询电视端播放进度（位置/总时长/状态） | 已完成 |
| POST | `/api/v1/dlna/control` | 电视遥控：action = play / pause / seek（带 positionMs） | 已完成 |

说明：

- 写接口仅接受 `Content-Type: application/json`，非法规则或非法 URL 返回 400，非图片响应返回 415。
- `/api/v1/image` 会校验目标地址、限制重定向与响应大小，并统一带 `Cache-Control: private, max-age=600`。
- HTTPS 与 mDNS 本轮不实现：明文 HTTP 仍存在同网嗅探风险，公网 / 不可信 Wi-Fi 下不要开启。

## 5. 播放链路（已实现）

- 桌面端仍只在 `127.0.0.1` 上提供渲染进程用的 `/proxy/...`，Host / Origin 校验不变。
- LAN 复用同一个 `HlsProxyServer` 实例：`LanServer` 把 `/lan/m/<sessionId>/...` 交给 `handleLanMedia`，不另开端口，也不复制缓存与预取逻辑。
- 会话由 `POST /api/v1/stream/resolve` 用 `streamResolver.resolve` 创建，ID 为不可猜的 UUID。
- **清单按请求来源重写**：`localResourceUrl` 改为接收基地址，LAN 请求用 `http://<请求来源>/lan/m/<id>`，本机请求仍用 `http://127.0.0.1:<port>/proxy/<id>`。
- LAN 媒体路由不受通用限流影响，避免 HLS 分片请求被 429；会话数量、缓存上限、Range 直通、分片预取均沿用原实现。
- `origin` 由请求 Host 校验得出（必须是私网地址且端口等于监听端口），否则回退到 TCP 来源地址，避免 Host 头注入。

## 5.1 投屏（DLNA）

- 桌面端负责 SSDP 搜索与 UPnP AVTransport 控制：`src/main/dlna.ts`。
- 手机播放页右上角“投屏”按钮列出电视，选择后由桌面端把当前会话的 `/lan/m/...` 地址通过 `SetAVTransportURI + Play` 发给电视，电视自行拉流。
- 投屏成功后手机端自动暂停本地播放，可再次打开面板“停止投屏”。
- 投屏遥控器：手机端每 4 秒通过 `GetPositionInfo` 轮询电视进度，投屏中底部控制栏切换为遥控器（进度条可拖动 seek、暂停/继续、停止）；电视端进度会同步写回观看历史，实现“电视看完手机续播”。
- 部分电视不支持 `GetPositionInfo` 或 `Seek`，此时遥控器仅显示“投屏中”，操作失败会在手机上提示。
- 只允许投递私网地址且路径为 `/lan/m/` 的本机媒体地址，避免被当作任意地址转发器。
- 兼容性：电视端需要支持 DLNA 媒体渲染器；HLS（m3u8）在部分电视上不受支持，表现为能连接但黑屏 / 报错，此时建议改用 MP4 源或系统镜像投屏。

## 6. 安全边界

必须保留：

- 只接受私网来源（10/8、172.16/12、192.168/16、169.254/16、127/8、IPv6 ULA / 链路本地）。
- 拒绝带 `Origin` 头的请求，避免任意网页在浏览器中调用本机服务。
- 提供总开关，关闭即停止 UDP 与 HTTP 监听。
- 请求限流、URL 长度限制、响应禁止缓存。
- 不暴露 API Key、模型配置、AI 规则生成 / 自动修复能力。
- 所有 URL 校验继续走 `urlSafety`，不允许任意地址转发。

风险提示：

- 同一 Wi-Fi 下的任何设备都能访问，不要在公司、咖啡厅等公共网络开启。
- 明文 HTTP 下，路径中的会话 UUID 可能被同网嗅探；后续可加自签名 HTTPS 与证书固定。
- Windows 防火墙需放行“专用网络”。

## 7. 代码结构

新增：

- `src/shared/lanProtocol.ts`：协议版本、端口、报文类型与解析
- `src/main/lanAddress.ts`：私网地址判断、本机可访问地址枚举
- `src/main/lanServer.ts`：HTTP API、限流、错误映射
- `src/main/lanDiscovery.ts`：UDP 发现应答
- `src/main/lanService.ts`：按设置启停、组合状态
- `src/main/dlna.ts`：SSDP 发现、设备描述解析、AVTransport 投屏控制

修改：

- `src/shared/types.ts`：`AppSettings` 增加 `lanEnabled` / `lanPort` / `deviceName`
- `src/main/storage.ts`、`src/main/validation.ts`：默认值与校验
- `src/shared/ipc.ts`、`src/preload/index.ts`、`src/main/ipcHandlers.ts`：`lan:status`
- `src/main/index.ts`：启动与退出时启停服务
- `src/main/hlsProxyServer.ts`：`registerLan`、`handleLanMedia`、清单基地址参数化
- `src/main/lanService.ts`：注入 `StreamResolver` 与 `HlsProxyServer`
- `src/renderer/src/views/SettingsView.vue`：局域网共享卡片

## 8. 阶段计划

1. **阶段 1（已完成）**：设置开关、UDP 发现、只读 API（收藏 / 站点 / 搜索 / 详情）。
2. **阶段 2（已完成）**：LAN 媒体入口与会话，清单按来源重写，远端可播放。
3. **阶段 3（已完成）**：Flutter Android 手机 + TV 客户端：发现、收藏、搜索、播放。
4. **阶段 4（已完成，除 HTTPS / mDNS）**：写接口（收藏增删、进度同步、规则 CRUD）、封面代理。
5. **后续（未开始）**：自签名 HTTPS + 证书固定、mDNS 发现、播放会话主动释放。

## 9. 阶段 1 验收

- 开启共享后，设置页显示运行状态与可访问地址。
- 同一局域网另一台设备发送 UDP `discover` 后能收到 `announce`，并拿到 `httpPort`。
- 直接用 curl 访问收藏、站点、搜索、详情接口均返回正确 JSON。
- 携带 `Origin` 头的请求被拒绝；关闭共享后端口立即不可访问。

## 10. 移动端工程（阶段 3）

工程位于 `mobile/`，Flutter 3.47 / Dart 3.13，目标平台 Android（手机 + TV 共用一套代码）。

已完成：

- UDP 广播发现与设备列表，支持手动输入 `IP:端口` 连接。
- 连接后加载收藏、站点列表与搜索、详情与选集。
- 手机使用底部导航，宽屏（TV / 平板）使用左侧导航。
- 网络明文 HTTP 已在 `AndroidManifest.xml` 开启，并声明局域网访问权限。
- 选集后请求 `POST /api/v1/stream/resolve`，用 `video_player` 播放返回的 LAN HLS / MP4 地址。
- 详情页可收藏 / 取消收藏，返回桌面端保存（`POST` / `DELETE /api/v1/favorites`）。
- 播放过程中每 15 秒与退出时上报进度（`POST /api/v1/progress`），详情页展示“继续观看”，同一集自动续播。
- “历史”页展示全部观看记录与进度，可直接进入详情继续播放。
- 播放器手势：左右滑动调节进度，左半屏上下滑动调节亮度（遮罩模拟），右半屏上下滑动调节音量，长按临时 2× 倍速。
- “规则”页可查看、编辑（JSON）与删除站点规则，保存后桌面端立即失效该站点流缓存。
- 封面统一走桌面端代理 `/api/v1/image`，避免防盗链与 HTTPS 混合内容。

暂未完成：

- HTTPS 与 mDNS 发现（桌面端与移动端均未实现）。
- 音乐 / 弹幕等桌面端独有能力不在移动端范围。

运行：

```bash
cd mobile
flutter pub get
flutter run
```

构建 Android APK（需 Android SDK；`flutter doctor` 中 Android toolchain 必须通过）：

```bash
cd mobile
flutter build apk --release
# 产物：build/app/outputs/flutter-apk/app-release.apk
```

安装后测试步骤：

1. 桌面端设置页开启“局域网共享”，确认显示端口 8790 与可访问地址。
2. 手机与电脑连接同一 Wi-Fi，打开 App，等待自动发现或手动输入 `IP:8790`。
3. 验证收藏、搜索、详情、播放、进度续播与规则编辑。
4. 若发现失败，检查 Windows 防火墙是否放行专用网络，以及路由器是否开启了 AP 隔离。

