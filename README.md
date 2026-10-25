# 详情图工作台

给电商产品（中式摆件、茶器、工艺品等）批量生成**整套详情页模块图**的本地工具。

核心解决两个问题：一是详情页模块多、每张都要单独写提示词；二是多张图拼在一起容易风格不统一。

## 它怎么工作

1. **上传产品图**（1–6 张，第一张为主图）
2. **上传风格样板**（客户现有详情图 1–4 张）→ 点「提取统一风格」
   模型会提炼出这套图的色板（含色值）、背景材质、光位与光质、道具语言、构图规则、字体性格、质感与禁忌，生成一段可编辑的**风格锁定描述**
3. **逐模块准备提示词**——三种方式可以混用：
   - **批量导入**：点「批量导入参考图」一次选一堆图，按文件名自动对位（`01-首屏.jpg`、`03_细节.jpg`、`size-参数.jpg`、`颜色款式.png` 都认），弹窗里可以逐张改到别的模块或跳过，确认后自动按模块并发分析
   - **单个模块上传参考图**：卡片里点「上传参考图」，工具自动把这张图的版式、信息层级、文字区位置、机位、光线和文案反推成这个模块的提示词，文案同时填进标题/副标题/正文
   - **手写**：直接在模块里写提示词、填文案
   - 提示词只描述画面与版式，**不写死具体文案**，文案由独立字段注入，改文案不用改提示词
4. **逐个模块生成**：每个模块有独立提示词、比例、质量、文案
5. **风格绝对统一**靠两层机制：
   - 文字层：风格锁定描述注入每个模块的提示词
   - 图像层：第一张成功生成的图自动成为**风格锚图**，后续每张都作为参考图一起送进模型，只借它的色调/光影/氛围
   - 统一的是**色板、光位光质、后期质感、字体性格**；**布景与构图不入风格锁**，见下一条
6. **每张图有自己的背景，但整页还是同一套风格**：
   - 每个模块有一份独立的「背景场景」（`scene`），生成时以 `=== BACKGROUND SET — THIS MODULE ONLY ===` 段落单独注入，位置在风格锁和模块提示词之后，优先级更高
   - 有参考图的模块，场景由参考图的背景反推（点模块里的「从参考图提取」）；没参考图的可以点「生成背景建议」，模型按已锁定的色板光线另设计一套不重复的布景
   - 顶栏「补齐背景场景」可以一次性给所有还没有场景的模块补上
   - **风格锁会做布景清洗**：锁定描述里的句子、色板的用途注释（`主墙面`/`石材台面`/`藤编屏风`…）、光效里的「树叶投影扫过墙面」、后期里的具体材质，只要出现布景词就整句剔除；`composition`（构图规则）在有参考图时整段不进。否则这些字会把每张图按回同一个布景
   - 参考图是**纯色无缝背景**时会明确要求「不要补任何道具、植物、家具、墙面纹理」，只留产品与接触阴影；参考图是实景时则要求重建同类实景
   - 锚图的角色被收窄成「只借调色、光线、颗粒、后期」，明确禁止复制它的背景与道具
   - 没有参考图也没有手写场景的模块，退回整页基础布景，但要求「换边角道具、换裁切、换机位」，避免几张图读起来是同一张
7. **产品绝不跑偏**同样靠两层机制：
   - **产品锁**：上传产品图后自动提取「产品特征」（轮廓、高宽比、配色分区、材质、标志性细节、底座），提取结果逐字注入每个模块的**最高优先级**段落，并列出 3–6 条「绝对不能改」；面板里可以手动补充或改写
   - **图像层分工**：Image 1 永远是产品图；锚图和模块参考图在提示词里被明确标注为「另一个品牌的产品，必须整块擦除」，并附带冲突裁决规则（参考图与产品图冲突时无条件以产品图为准）+ 返回前的自检清单
   - 换了主图会自动作废旧锚图，避免上一个产品的画面继续被当成风格参考
8. 不满意就改那个模块的提示词或文案，单张重生成；其余不受影响
9. 长图预览按模块顺序拼接，可一键导出整张 PNG。**任何图片都能点开看大图**（产品图、样板图、模块参考图、模块成图、风格锚图、长图预览），放大层右上角有关闭按钮，点深色空白处或按 Esc 也能关
10. 窗口窄于 1360px 时，长图预览不再挤在页面底部，而是变成**从右侧滑出的抽屉**，由顶栏「长图预览」按钮开关，中间模块列表可以用满整个宽度

## 提示词怎么复用

- 模块提示词可以直接编辑；点「存为模板」写进本机模板库
- 新建产品时自动带上模板库里的模块，等于一套自己的详情页配方
- 「从样板图新增模块」：丢一张别家的详情图进去，自动反推出可复用的模块提示词、文案和版式

## 启动

浏览器方式（开发用）：

```bash
npm install        # 首次
npm start          # 打开 http://127.0.0.1:8930
```

桌面窗口方式：`npm run desktop`，或直接双击打包好的便携版 exe。

### 打包 Windows 便携版 exe

```bash
npm install
npm run package:win
```

产物：`dist/Detail-Image-Studio-0.1.0-portable.exe`（约 91 MB，单文件，双击即用，不写注册表、不需要安装）。

国内网络建议带上镜像，否则下载 Electron 会卡：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
ELECTRON_BUILDER_CACHE=.builder-cache \
npm run package:win
```

重新打包前如果 `dist/win-unpacked` 已存在，建议先手动 `rm -rf dist` 再打包，避免旧文件残留。

### 应用图标

图标已经生成好放在 `build/` 下，打包时 electron-builder 自动读取：

| 文件 | 用途 |
|---|---|
| `build/icon.ico` | Windows（16/24/32/48/64/128/256 多尺寸） |
| `build/icon.icns` | macOS（16~1024 共 10 个尺寸，内容按 HIG 缩到 82% 留边距） |
| `build/icon.png` | 1024×1024 通用版 |
| `build/icon-source.png` | 出图原稿，换图标时改这个 |

换图标：把新的 1024 方形 PNG 覆盖掉 `build/icon-source.png`，然后

```bash
pip install pillow            # 只有这一步需要 Pillow
python scripts/make-icons.py build/icon-source.png
```

脚本会重新生成 ico / icns / png。两个平台的规范不同（Windows 满幅、macOS 留 18% 边距），脚本里已经分开处理，不要直接拿一张 png 塞给两个平台。

### 打包 macOS 版（dmg / zip）

**必须在 macOS 上执行**，Windows 上交叉编译不出 dmg。需要 Node 18+ 与 Xcode 命令行工具（`xcode-select --install`）。

```bash
npm install
npm run package:mac          # 出 arm64（Apple 芯片）+ x64（Intel）的 .app 和 zip
npm run package:mac:dmg      # 上面那步 + 封装成 dmg（推荐，一步到位）
npm run package:mac:arm64    # 只出 Apple 芯片版，体积小一半，日常够用
```

产物：`dist/Detail-Image-Studio-0.1.0-mac-arm64.dmg` / `-mac-x64.dmg`，同名的 `.zip`，以及未压缩的 `.app`（在 `dist/mac-arm64/`、`dist/mac/`）。双击 dmg 把 `详情图工作台.app` 拖进「应用程序」即可。

> **为什么 dmg 不用 electron-builder 自带的 `dmg` target**：它内部依赖 `dmgbuild`（自带一份 Python），在 GitHub 的 macOS 14 runner 上会报 `plistlib.InvalidFileException` 让整个打包失败。所以 dmg 由 `scripts/make-dmg.sh` 调系统 `hdiutil` 封装，只多几行，没有这层依赖。
>
> 另外别在命令行上追加 `dmg zip`（`electron-builder --mac dmg zip`）——那样会覆盖 `package.json` 里 `mac.target` 的架构列表，只出当前机器那一种架构。

**签名与公证（分发给别人时的关键）**

- 没有账号：electron-builder 会**自动做 ad-hoc 签名**（日志里 `falling back to ad-hoc signature`），Apple 芯片上能正常启动，只是没有公证。别人首次打开会被 Gatekeeper 拦一下，在「系统设置 → 隐私与安全性」里点「仍要打开」即可，不需要手动 `codesign`。
- 有 Apple 开发者账号（$99/年）：设 `CSC_LINK`（.p12 路径）和 `CSC_KEY_PASSWORD`，electron-builder 自动正式签名；公证再配 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`。配好之后用户双击就能开，没有任何提示。

**Mac 版与 Windows 版的差异（已处理）**

- 数据目录：Windows 是 `%APPDATA%\Detail Image Studio`，macOS 是 `~/Library/Application Support/Detail Image Studio`，Linux 是 `~/.local/share/Detail Image Studio`。之前这里回退到了应用包内部（asar 只读），Mac 上会写不进去，已改成按平台取可写目录。
- 机器码：macOS 改用主板 UUID（`IOPlatformUUID`）而不是网卡 MAC。原因是 macOS 的「私有 Wi-Fi 地址」会让 MAC 随网络变化，用 MAC 当指纹会出现「换个网络就提示机器码不匹配」。Windows 的算法完全没动，已有激活码继续有效。
- 网络层：Windows 走 PowerShell 桥接（为了兼容系统代理），macOS/Linux 走 Node 原生 `fetch`，两套分支本来就都在，Mac 上自动走后者。
- 硬件加速：Windows 默认关闭（绕开 GPU 进程崩溃），macOS 保持开启。

### 自动打包（GitHub Actions，不需要 Mac）

仓库：`haitain1688/detail-image-studio`（私有）。云端流水线在 `.github/workflows/build.yml`，一台机器都不占。

| 触发方式 | 结果 |
|---|---|
| 往 `main` 推代码 | 自动跑 Windows + macOS 两路打包，验证代码能出包 |
| 手动 Run workflow | 同上，随时打一个包 |
| 推 `v*` 标签（如 `git tag v0.1.1 && git push --tags`） | 额外自动创建 Release，两个平台的安装包挂在 Release 里，下载链接不过期 |

拿产物：仓库 **Actions → 选一次运行 → 页面底部 Artifacts**，下载 `windows-portable` / `macos-dmg`。

配额（注意这里容易踩坑）：

- **运行时间**：私有仓库每月 2000 分钟，**macOS 按 10 倍计算**（实际约 200 分钟 macOS 时间）。一次完整打包 Windows ≈ 3 分钟、macOS ≈ 8 分钟，够用二十来次。仓库转公开则不限额。
- **存储**：私有仓库 Actions 产物总额只有 **500 MB**。一次运行 Windows exe 87 MB + 两个 dmg 250 MB，所以产物**只保留 1 天**（`retention-days: 1`），并且**不上传 zip**（和 dmg 内容重复）。长期保存的包请走 Release（推 tag），Release 附件不占这个额度。
- 提示存储超限时，去 Actions 页面把旧的 Artifacts 删掉即可。

要签名 + 公证，在 **Settings → Secrets and variables → Actions** 里加这 5 个，流水线会自动切到签名分支，不用改 YAML：

```
CSC_LINK                      # .p12 证书的 base64（macOS 上 `base64 -i cert.p12 | pbcopy`）
CSC_KEY_PASSWORD              # 证书密码
APPLE_ID                      # 苹果账号邮箱
APPLE_APP_SPECIFIC_PASSWORD   # 专用密码，appleid.apple.com 生成
APPLE_TEAM_ID                 # 团队 ID
```

> 踩过的坑：这 5 个 secrets 不存在时，YAML 里写成 `CSC_LINK: ${{ secrets.CSC_LINK }}` 会得到**空字符串**，electron-builder 会把空字符串当成证书路径，报 `<项目目录> not a file` 并中止打包。所以 workflow 里用 `HAS_CERT` 分流成两条打包命令，不要直接透传空值。

### 桌面版行为

- 启动时在 `127.0.0.1` 上随机取一个空闲端口起本地服务，窗口直接连它，不占用固定端口，也不会和 `npm start` 的 8930 冲突
- 启动过程（版本、监听地址、加载失败原因）写在 `%APPDATA%\Detail Image Studio\startup.log`（macOS 为 `~/Library/Application Support/Detail Image Studio/startup.log`）；启动失败会弹窗提示并指向这个日志，不会静默无反应
- 默认关闭硬件加速（`app.disableHardwareAcceleration()`），绕开 Windows 上一类「GPU process isn't usable」直接闪退的问题。想启用 GPU：设环境变量 `DETAIL_STUDIO_GPU=1`（macOS 默认就是开启状态）
- 上传图片走主进程的原生文件选择器（`preload.cjs` 暴露 `desktopStudio.pickImages`，`desktop.mjs` 里 `dialog.showOpenDialog`），不再依赖页面里的 `<input type=file>`。每次打开/关闭选择器、读了几张、跳过几张，都记在 `startup.log` 里；浏览器版（`npm start`）仍走原来的 `<input>`。单张上限 30MB，每次最多 12 张
- 数据目录与浏览器版共用 `%APPDATA%\Detail Image Studio`，项目、模板库、BaseURL 设置都能带过去；**API Key 不在其中**，桌面版首次启动需要重新填一次

## API Key 与 BaseURL

右上角「API 设置」里可以填两项：

- **BaseURL**：网关地址，默认 `https://api.apikey.fan/v1`。填到版本路径这一层即可，末尾斜杠会被自动去掉；填非法地址（没有 `http://` / `https://`）会被拒绝；**留空即恢复默认**。写在本机 `settings.json` 里，重启后仍在。
- **API Key**：`sk-` 开头。只存在本机服务进程内存里，重启需重填；留空表示沿用当前 Key。

弹窗里还有「测试连接」：用 BaseURL + Key 请求一次 `GET /models`（不产生生成计费），能立刻看出是地址不通、Key 被拒，还是网关正常（并提示配置的绘图模型在不在返回列表里）。

也可以用环境变量起：

```bash
set APIKEY_FAN_API_KEY=sk-xxxx     # Windows cmd
set APIKEY_IMAGE_BASE_URL=https://api.apikey.fan/v1
```

优先级：运行时设置（弹窗保存）> 环境变量 > 内置默认。

## 授权与发码

软件按机器授权，可以给每个使用者设置到期日。**完全离线**，不需要服务器，客户机器也不用联网校验。

**客户侧**

- 首次打开有 **14 天试用**，功能不受限。
- 顶栏「授权」按钮显示剩余天数；试用或到期后点开弹窗，里面有一串**机器码**（形如 `207C-B3A5-CF1B-1EB1`），点「复制」发给你。
- 拿到激活码后粘贴进同一个弹窗，点「激活」立即生效，不用重启。
- 到期后：**已有项目、长图预览、导出 JSON、导出长图都照常可用**，只有「生成模块」和各类分析会被拦住，并在页面顶部显示提示条。不会把客户的数据锁死。

> 机器码由网卡 MAC + 主机名 + 系统平台算出，只用 Node 自带能力，不调 `reg.exe` / `wmic` / PowerShell——这类外部命令在部分安全策略下会被拦，一旦取不到就会退化成随机值，激活码当场失效。换网卡或改主机名会改变机器码，需要重新发一次。

**你侧（发码）**

双击 `tools/发码.bat`，按提示输入机器码、有效天数、客户名，会打印一整段以 `DS1.` 开头的激活码，复制发给客户。

也可以直接命令行：

```bash
node tools/issue-license.mjs --machine 207C-B3A5-CF1B-1EB1 --days 365 --name "张三"
node tools/issue-license.mjs --machine 207C-B3A5-CF1B-1EB1 --expires 2027-10-24 --name "张三"
node tools/issue-license.mjs --machine ANY --days 30 --name "临时演示"   # 不限机器
```

**安全边界**

- 签名用 Ed25519。**私钥只在 `tools/license-private.pem`**，已加进 `.gitignore`，且 `package.json` 的 `files` 白名单不含 `tools/`，所以**私钥不会被打进 exe**。exe 里只有公钥。
- 所以：`tools/` 整个目录只留在你自己电脑上，**不要跟 exe 一起发给客户**。丢了私钥就得重新生成密钥对（那样已经发出去的激活码全部作废）。
- 激活码绑机器码，改机器码、改到期日、少复制一个字符，验签都会失败。
- 防系统时间回拨：本地记录上次运行时间，判定时取 `max(当前时间, 上次运行时间)`，把系统时间调回过去不会延长授权。检测到回拨会在弹窗里提示。

**文件位置**

```
license.json    机器码、激活码、首次运行时间、上次运行时间（跟 projects 在同一目录）
```

## 默认模块

内置 8 个模块骨架（首屏 / 卖点 / 细节 / 场景 / 尺寸 / 包装服务 / 颜色款式 / 收尾），全部可改名、改提示词、调比例、增删。

## 数据存放

项目与模板库写在 `%APPDATA%\Detail Image Studio\`：

```
library.json          模块模板库
settings.json         BaseURL 等非敏感设置
license.json          机器码、激活码、运行时间记录
projects\<id>.json    每个产品的产品图、风格规范、模块与生成结果
```

可用环境变量 `DETAIL_STUDIO_DATA_DIR` 改到别的目录。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APIKEY_FAN_API_KEY` | – | API Key |
| `APIKEY_IMAGE_BASE_URL` | `https://api.apikey.fan/v1` | 默认网关（界面里填了 BaseURL 时以界面为准） |
| `APIKEY_IMAGE_MODEL` | `gpt-image-2.5-sunburst` | 绘图模型 |
| `APIKEY_ANALYSIS_MODEL` | `gpt-5.6-sol` | 风格/模块分析模型 |
| `DETAIL_STUDIO_PORT` | `8930` | 本地端口 |
| `DETAIL_STUDIO_DATA_DIR` | `%APPDATA%\Detail Image Studio` | 数据目录 |
| `DETAIL_STUDIO_TRIAL_DAYS` | `14` | 未激活时的试用天数 |
