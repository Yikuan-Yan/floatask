# Floatask

A lightweight, always-on-top desktop task tracker for people who juggle multiple tasks at once.

一个轻量级桌面浮窗任务追踪器，为同时进行多个任务的人而设计。

---

<!-- Replace with actual screenshots -->
> **Screenshots coming soon** — collapsed view, expanded view, dark mode

---

## Why Floatask? / 为什么做这个？

When you're running a simulation, waiting for an AI response, and compiling code all at once — it's easy to forget what you were doing 10 minutes ago. Floatask stays visible on your screen as a tiny floating panel, showing you exactly what's active and where you left off.

当你同时跑模拟、等 AI 返回结果、编译代码的时候，很容易忘记 10 分钟前在干什么。Floatask 以一个小浮窗常驻在屏幕上，随时告诉你现在在做什么、做到哪了。

## Features / 功能

- **Collapsed / Expanded** — tiny pill showing active tasks, click to expand full panel
  小面板显示当前任务，点击展开完整列表
- **Always-on-top pin** — pin the window above everything else
  置顶功能，不被其他窗口遮挡
- **System tray** — click X to hide, click tray icon to restore (Tauri build)
  系统托盘常驻，点 X 隐藏，点托盘恢复
- **Drag & resize** — move by dragging the header, resize from any edge
  拖拽移动和缩放
- **Custom statuses & tags** — create your own, single-select status, multi-select tags
  自定义状态（单选）和标签（多选）
- **Smart dates** — auto-tracks created / started / completed dates per status
  自动追踪创建、开始、完成日期
- **Archive** — clean up done tasks, browse archived items grouped by week
  归档已完成任务，按周分组浏览
- **Markdown notes** — supports **bold**, `code`, and [links](url) in task notes
  备注支持 Markdown 格式
- **Search** — search across all tasks including archived ones
  全局搜索，包括已归档任务
- **3 themes** — Ocean Blue, Slate Dark, Coral
  三套主题
- **Import / Export** — JSON backup and restore
  JSON 导入导出
- **Keyboard shortcut** — `Ctrl+Shift+T` to toggle the panel
  快捷键切换面板

## Getting Started / 快速开始

### Prerequisites / 环境要求

- [Node.js](https://nodejs.org/) v18+
- [Rust](https://rustup.rs/) (stable)
- Windows: [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)

### Install & Run / 安装运行

```bash
git clone https://github.com/Yikuan-Yan/floatask.git
cd floatask
npm install

# Development mode (hot reload)
npm run tauri dev

# Build for production
npm run tauri build
```

The built installer is in `src-tauri/target/release/bundle/`.

打包后的安装程序在 `src-tauri/target/release/bundle/` 目录下。

### Auto-start on boot / 开机自启

Copy a shortcut of the built `.exe` to:

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
```

Or toggle the auto-start switch in Settings.

也可以在设置中开启自动启动。

## Project Structure / 项目结构

```
floatask/
├── src/
│   ├── main.jsx          # React entry point
│   └── App.jsx           # All UI logic
├── src-tauri/
│   ├── src/lib.rs         # Tray icon & autostart (Rust)
│   ├── tauri.conf.json    # Window & bundle config
│   └── capabilities/      # Tauri v2 permissions
├── index.html
├── package.json
└── vite.config.js
```

## Roadmap / 路线图

- [ ] iOS / Android PWA with cloud sync
- [ ] Supabase multi-device sync
- [ ] Global hotkey (Tauri native)
- [ ] Subtasks
- [ ] Recurring tasks

## License / 许可证

[GPL-3.0](LICENSE) — free to use, modify, and distribute. Derivative works must also be open source.

GPL-3.0 许可证 — 可自由使用、修改和分发，衍生作品必须同样开源。

## Author / 作者

Made by [Yikuan Yan](https://github.com/Yikuan-Yan)
