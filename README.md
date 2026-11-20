# Gemini Usage HUD

一个轻量级用户脚本（Userscript），在 [Gemini](https://gemini.google.com/) 对话页面右下角以悬浮胶囊形式优雅展示 **5 小时**与**每周**剩余额度百分比、精确点数及重置倒计时。

## 效果预览

![Gemini Usage HUD 实际效果](./assets/preview.png)

- **`5h余`**：5 小时滚动窗口剩余百分比、精确剩余点数（通过 RPC 获取时显示）及重置倒计时。
- **`周余`**：每周额度窗口剩余百分比、精确剩余点数（通过 RPC 获取时显示）及重置倒计时。
- **悬停提示**：鼠标悬停在对应项上，可查看具体剩余信息与精确重置时间（`M/D HH:mm`）。

## 功能特性

- **双窗口额度监控**：同时展示 `5h余` 与 `周余` 的剩余百分比、精确点数及重置倒计时（如 `3天21时`、`2时43分`、`即将重置`）。
- **状态色阶提示**：根据剩余比例自动切换状态圆点与百分比颜色：
  - 绿色 (`#34a853`)：剩余 ≥ 50%（充裕）
  - 黄色 (`#fbbc04`)：20% ≤ 剩余 < 50%（注意）
  - 红色 (`#ea4335`)：剩余 < 20%（紧张）
  - 灰色 (`#9aa0a6`)：数据未就绪 / 未知
- **双引擎获取与自动降级**：
  - 优先调用同域 `/_/BardChatUi/data/batchexecute` RPC 接口（`rpcids=jSf9Qc`，复用页面 `window.WIZ_global_data` 参数，带 12 秒请求超时控制），可获取精确剩余点数、比例与重置时间；
  - 当 RPC 不可用时，自动降级抓取 `https://gemini.google.com/usage` 页面 HTML 并解析 `GXU_FIVE_HOURLY` 与 `GXU_WEEKLY`（降级模式下不显示精确点数，仍保留剩余百分比与重置倒计时）。
- **低频轮询与智能更新**：页面可见时每 2 分钟自动刷新一次用量数据；每 30 秒本地更新一次倒计时显示；切回标签页且距上次更新超过 1 分钟时自动刷新；支持左键点击立即手动刷新。
- **Shadow DOM 隔离与深浅色自适应**：使用 Shadow DOM（`all: initial`）隔离宿主页面样式，通过 `color-scheme: light dark` 与 CSS `color-mix()` / `Canvas` / `CanvasText` 自动适配系统与页面的浅色/深色主题，并带有毛玻璃背景（`backdrop-filter: blur(14px)`）。
- **拖拽定位与记忆**：默认停靠在页面右下角（`right: 20px; bottom: 16px`），按住左键拖拽超过 4px 即可自由移动位置并持久化至 `localStorage`（键 `gemini-usage-hud:pos`）；浏览器窗口缩放（`resize`）时自动将悬浮窗约束在可视区域内。

## 安装方法

1. 在浏览器中安装任意用户脚本管理器扩展，例如 [Tampermonkey](https://www.tampermonkey.net/)、[Violentmonkey](https://violentmonkey.github.io/) 或 [ScriptCat](https://docs.scriptcat.org/)。
2. 打开脚本管理器面板，点击「新建脚本」。
3. 复制本仓库 [main.js](./main.js) 的完整代码，覆盖编辑器中的默认模板并保存。
4. 打开或刷新 `https://gemini.google.com/`，页面右下角即可出现悬浮窗。

## 交互说明

- **左键单击**：立即刷新额度（当发生「请求超时」或「获取失败」时点击重试）。
- **按住拖拽**：自由移动悬浮窗位置，松开鼠标后自动保存当前位置。
- **鼠标悬停**：悬停在 `5h余` 或 `周余` 区域可查看精确重置日期与时间。
- **恢复默认位置**：在浏览器开发者工具控制台中执行以下命令并刷新页面：
  ```js
  localStorage.removeItem('gemini-usage-hud:pos');
  ```

## 自定义参数

如需调整刷新频率或超时时间，可直接修改 [main.js](./main.js) 顶部的常量配置：

| 常量 | 默认值 | 说明 |
| --- | --- | --- |
| `REFRESH_INTERVAL_MS` | `2 * 60 * 1000`（2 分钟） | 页面可见时的自动轮询间隔 |
| `STALE_THRESHOLD_MS` | `60 * 1000`（1 分钟） | 切回标签页后触发自动刷新的过期阈值 |
| `REQUEST_TIMEOUT_MS` | `12000`（12 秒） | RPC 单次请求超时时间 |

## 隐私与说明

- 脚本声明 `@grant none`，零第三方依赖；所有网络请求仅发往同域 `gemini.google.com` 并复用浏览器当前登录态（`credentials: 'include'`），不会收集或向任何外部服务器发送数据。
- 本地仅使用 `localStorage` 中的 `gemini-usage-hud:pos` 键保存悬浮窗坐标。
- 额度数据依赖 Gemini 网页端内部 RPC（`jSf9Qc`）及 `/usage` 页面结构，若官方接口后续调整可能需要同步更新脚本；本脚本仅适用于具备 5 小时 / 每周额度统计的账号。
