# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Floatask is a lightweight, always-on-top desktop task tracker built as a Tauri v2 app (Rust backend + React/Vite frontend). It targets Windows and stays visible as a small floating panel on screen.

The project is bilingual (English + Chinese) in user-facing docs.

## Current State

The repo is in early bootstrap: the entire UI lives in a single `task-tracker.jsx` file (~1200 lines) that was originally built as a Claude.ai artifact. It has not yet been wired into the Tauri/Vite scaffold described in the README. The planned project structure (src/, src-tauri/, package.json, vite.config.js) does not exist yet.

## Architecture (task-tracker.jsx)

The file is a self-contained React component with these sections (marked by `═══` comment headers):

| Section | Lines | Purpose |
|---|---|---|
| Storage Abstraction | top | `loadStore`/`saveStore` — tries `window.storage` (Claude artifact API) then `localStorage` |
| Constants | ~28-70 | Default statuses (ip/ns/na/dn), tags, 3 themes, initial demo tasks, helper fns |
| Markdown Renderer | ~72-104 | Simple inline MD: bold, code, links, bullet lists |
| UI Components | ~106-137 | `TagPill`, `StatusBadge`, `ChevronIcon`, `DropSelect` |
| Settings | ~139-209 | `ItemManager`, `Toggle`, `SettingsPanel` (themes, prefs, status/tag management, import/export) |
| Task Card | ~211-273 | Expandable card with inline editing, status/tag dropdowns, notes |
| Archive Card | ~275-298 | Read-only card with restore button |
| Add Task | ~300-319 | Inline new-task form |
| Resize Handles | ~321-323 | Edge resize for the floating panel |
| Search Overlay | ~325-358 | Full-text search across active + archived tasks |
| Main (TaskTracker) | ~360-end | Root component: all state, drag-reorder, expand/collapse, archiving, keyboard shortcut (Ctrl+Shift+T) |

### Key data model

- **Task**: `{ id, name, status, tags[], shortNote, fullNote, order, createdAt, startedAt, completedAt }`
- **Status IDs**: `ip` (in progress), `ns` (not started), `na` (not applicable), `dn` (done)
- Status changes auto-set date fields via `applyStatusDates()`
- All state is persisted to storage on every change (useEffect in TaskTracker)

## Build Commands (once scaffolded)

```bash
npm install              # install deps
npm run tauri dev        # dev mode with hot reload
npm run tauri build      # production build (output: src-tauri/target/release/bundle/)
```

## Key Decisions

- Single-file design: all UI logic intentionally lives in one file for simplicity
- No external CSS — all styling is inline React `style={}` objects
- Storage layer abstracts over both Claude artifact storage and localStorage
- 4 built-in statuses are protected (cannot be deleted); custom statuses can be added
- Archive groups completed tasks by week using Monday-Sunday boundaries
- Drag reorder uses insert semantics (not swap)
- Collapsed view remembers its pre-expand position and restores it on collapse

---

# Role: Plan Agent

当用户给出需求时，你的职责是分析并输出结构化执行计划。

## 输出规范
- 计划写入 `.agent/plan.md`（如不存在则创建，`.agent/` 目录同理）
- 如果 `.agent/plan.md` 已有内容，将新计划追加到末尾（用 `---` 分隔），不覆盖已有内容
- 每个子任务用 `## Task N: 标题` 格式
- 每个 task 包含：目标、要修改的文件列表、具体改动描述、依赖关系
- 无依赖的任务标记 `parallel: true`

## Review 规范
- 确认已完成的任务追加到 `.agent/plan_done.md` 归档
- 从 `.agent/plan.md` 中删除已归档的任务内容

## 约束
- 不要自己执行代码修改，只输出计划
- 保持任务粒度适中（每个 task 对应 1-3 个文件）
- 标注风险点和需要 review 的关键逻辑
