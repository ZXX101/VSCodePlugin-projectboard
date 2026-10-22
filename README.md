# 项目看板 ProjectBoard · VS Code 扩展

以 Markdown 笔记为数据源的项目卡片看板。需求与验收基准见《需求规格书》。

## 开发

```bash
npm install      # 安装依赖
npm run build    # 编译到 dist/extension.js
npm run watch    # 监听模式编译
npm run typecheck
```

## 更新已安装的插件（一键部署）

```bash
npm run deploy   # 编译 + 覆盖安装到本机所有 VS Code 扩展目录
```

自动部署到 Windows 宿主（`~/.vscode/extensions`）与 WSL 远程宿主（`~/.vscode-server/extensions`，自动探测发行版）。部署后在 VS Code 中 `Ctrl+Shift+P` →「Developer: Reload Window」即生效，无需再手动 Install from VSIX。

## 调试

1. 用 VS Code 打开本目录，按 `F5` 启动扩展开发宿主（Extension Development Host）
2. 在开发宿主中打开你的笔记根目录（含 `.projectboard.json` 的文件夹）
3. 点击左侧活动栏的看板图标，或命令面板执行「打开项目看板」

## 笔记目录启用方式

在笔记根目录创建 `.projectboard.json`（示例如下，未配置的字段使用默认值）：

```json
{
  "projectDirs": ["MyProj"],
  "projects": {
    "MyProj": { "name": "我的项目", "type": "web", "status": "doing", "workspace": [] }
  },
  "projectsRoot": ".",
  "hubFile": "README.md",
  "staleDays": 30,
  "archiveFolder": "已完成"
}
```

看板只读取 `projectDirs` 列出的目录，相对路径以 `projectsRoot` 为基准。每个项目的配置统一写在 `projects` 中，对象键与目录列表中的路径一致；Markdown 只保留正文。

升级后自动迁移旧 Markdown 开头的项目配置，并移除旧字段（包括 `focus`）。迁移前保留 `.projectboard.json.projectboard.bak` 和各项目下的 `.README.md.projectboard.bak`，正文与修改时间保留。已有根配置时以根配置为准。

右键修改项目状态会更新根配置；“编辑工作区配置”直接打开根配置。完整字段与正文约定见《需求规格书》第 3、5 节。

## 打包

```bash
npm run package   # 生成 projectboard-x.y.z.vsix，可离线安装
```

## 目录结构

```
src/extension.ts   入口：激活、命令、文件监听
src/store.ts       数据层：配置发现、集中配置与旧版迁移、进度统计、文档树、写操作
src/launcher.ts    工作区启动器：app / vscode / url / explorer / powertoys
src/panel.ts       看板 Webview 面板（三栏）
src/sidebar.ts     活动栏侧边卡片列表
src/paths.ts       WSL / Windows 路径互转
media/             看板前端（board.css / board.js）与 Vditor 资源
```
