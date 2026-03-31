# Floatask

A lightweight, always-on-top desktop task tracker for people who juggle multiple tasks at once.

一个轻量级桌面浮窗任务追踪器，为同时进行多个任务的人而设计。

---

> **Screenshots coming soon** — collapsed view, expanded view, dark mode

---

## Why Floatask? / 为什么做这个？

When you're running a simulation, waiting for an AI response, and compiling code all at once — it's easy to forget what you were doing 10 minutes ago. Floatask stays visible on your screen as a tiny floating panel, showing you exactly what's active and where you left off.

当你同时跑模拟、等 AI 返回结果、编译代码的时候，很容易忘记 10 分钟前在干什么。Floatask 以一个小浮窗常驻在屏幕上，随时告诉你现在在做什么、做到哪了。

## Features / 功能

- **Collapsed / Expanded** — tiny floating pill showing active tasks, click header to expand full panel; window auto-resizes between modes and remembers custom sizes
  小浮窗显示当前任务，点击切换完整面板；窗口自动调整大小并记住自定义尺寸
- **Always-on-top pin** — pin the window above everything else, persists across restarts
  置顶功能，重启后自动恢复
- **System tray** — click X to hide to tray, click tray icon to restore
  系统托盘常驻，点 X 隐藏，点托盘恢复
- **Drag & resize** — move by dragging the header, resize from any edge or corner
  拖拽标题移动，边缘和角落缩放
- **Drag reorder & status change** — drag tasks to reorder or move between status groups to change status
  拖拽任务排序或拖到其他状态组切换状态
- **Right-click context menu** — Edit, Duplicate, or Delete any task via right-click
  右键菜单：编辑、复制、删除
- **Custom statuses & tags** — single-select status, multi-select tags, fully customizable
  自定义状态（单选）和标签（多选）
- **Smart dates** — auto-tracks created / started / completed dates per status change
  自动追踪创建、开始、完成日期
- **Archive** — one-click archive done tasks, browse by week, restore anytime
  一键归档已完成任务，按周浏览，随时恢复
- **Markdown notes** — supports **bold**, `code`, [links](url), and bullet lists in task notes; links open in default browser
  备注支持 Markdown 格式，链接可点击在浏览器打开
- **Search** — real-time search across all tasks including archived ones
  全局实时搜索，包括已归档任务
- **3 themes** — Ocean Blue, Slate Dark, Coral
  三套主题
- **Import / Export** — JSON backup and restore with dated filenames
  JSON 导入导出
- **Auto-start** — toggle system boot auto-start from Settings
  设置中可开关开机自启
- **Keyboard shortcut** — `Ctrl+Shift+T` to toggle the panel
  快捷键切换面板
- **Smart positioning** — expanding near screen edge auto-repositions to stay visible; collapsing restores original position
  展开时自动检测屏幕边界，折叠时恢复原位

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

Toggle the auto-start switch in Settings, or manually copy a shortcut of the built `.exe` to:

在设置中开启自动启动，或手动复制快捷方式到：

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
```

## Project Structure / 项目结构

```
floatask/
├── src/
│   ├── main.jsx            # React entry point
│   └── App.jsx             # All UI logic (single-file design)
├── src-tauri/
│   ├── src/lib.rs          # Tray icon, autostart & opener plugins (Rust)
│   ├── tauri.conf.json     # Window config: frameless, skip taskbar
│   ├── capabilities/       # Tauri v2 permissions
│   └── Cargo.toml          # Rust dependencies
├── index.html
├── package.json
└── vite.config.js
```

## Tech Stack / 技术栈

- **Frontend**: React 18 + Vite 6 (single-file component, inline styles)
- **Backend**: Tauri v2 (Rust) — frameless window, system tray, autostart
- **Plugins**: `tauri-plugin-autostart`, `tauri-plugin-opener`
- **Storage**: localStorage (persists all state on every change)

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
