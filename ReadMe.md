# Integrated Mod Manager (IMM)

IMM 是一个面向多游戏的桌面 Mod 管理器，专注于三件事：本地管理更快、在线下载更稳、更新维护更省心。

![IMM](./preview/IMM.png)

## 支持游戏

- Wuthering Waves (鸣潮)
- Zenless Zone Zero (绝区零)
- Genshin Impact (原神)
- Honkai: Star Rail (崩坏：星穹铁道)
- Arknights Endfield (明日方舟：终末地)

## 主要能力

### 1. 本地 Mod 管理

- 自动扫描游戏目录并识别 Mod
- 一键启用/禁用，支持批量操作
- 预设组合（Presets）快速切换
- 搜索、筛选、删除、重命名等基础管理
- 冲突检测与处理
- 还原点备份/恢复

### 2. 在线模式

- 集成 GameBanana 资源浏览
- 支持分类筛选与详情查看
- 下载队列管理与进度展示
- 下载完成后自动解压与安装
- 失败任务支持手动重试（避免无意义循环）

### 3. 设置与体验

- 每个游戏独立路径与启动设置
- 可选内容过滤（如 NSFW）
- 快捷键绑定预设
- 内置更新检查与版本日志

## 环境要求（开发）

- Windows 10/11
- Node.js 20+
- Rust toolchain（`rustup` / `cargo` / `rustc`）
- Microsoft C++ Build Tools
- Microsoft Edge WebView2 Runtime

## 本地开发

```bash
git clone https://github.com/cyc20050130/integrated-mod-manager.git
cd integrated-mod-manager
npm install
npm run tauri:dev
```

## 生产构建

```bash
npm run build
npm run tauri:build
```

## 自动更新说明

应用内自动更新依赖 GitHub Release 的三个发布资产：

- `latest.json`
- `Integrated.Mod.Manager.IMM._x64-setup.exe`
- `Integrated.Mod.Manager.IMM._x64-setup.exe.sig`

只要新版本发布时包含这三项，已安装 IMM 的用户在打开应用后就能检测并执行更新。

## 7-Zip 说明

本项目使用 7-Zip（`7z.exe`）进行部分压缩/解压流程。
7-Zip 为开源软件，遵循 GNU LGPL，版权所有 (C) 1999-2024 Igor Pavlov。
官网：https://www.7-zip.org

## 社区与反馈

- GameBanana 页面：https://gamebanana.com/mods/593490
- Discord：https://discord.gg/QGkKzNapXZ
- Releases：https://github.com/cyc20050130/integrated-mod-manager/releases
