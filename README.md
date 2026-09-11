# 项目看板 ProjectBoard · VS Code 扩展

以 Markdown 笔记为数据源的项目卡片看板。需求与验收基准见《需求规格书》。

## 开发

```bash
npm install      # 安装依赖
npm run build    # 编译到 dist/extension.js
npm run watch    # 监听模式编译
npm run typecheck
```

## 调试

1. 用 VS Code 打开本目录，按 `F5` 启动扩展开发宿主（Extension Development Host）
2. 在开发宿主中打开你的笔记根目录（含 `.projectboard.json` 的文件夹）
3. 点击左侧活动栏的看板图标，或命令面板执行「打开项目看板」

## 笔记目录启用方式

在笔记根目录创建 `.projectboard.json`（字段均可省略，默认值如下）：

```json
{
  "projectsRoot": ".",
  "hubFile": "README.md",
  "staleDays": 30,
  "archiveFolder": "已完成"
}
```

`projectsRoot` 下每个含 `README.md`（带 frontmatter）的子文件夹即一张项目卡片。
frontmatter 字段与 README 区块约定见《需求规格书》第 3 节。

## 打包

```bash
npm run package   # 生成 projectboard-x.y.z.vsix，可离线安装
```

## 目录结构

```
src/extension.ts   入口：激活、命令、文件监听
src/store.ts       数据层：配置发现、frontmatter 解析、进度统计、文档树、写操作
src/launcher.ts    工作区启动器：app / vscode / url / explorer / powertoys
src/panel.ts       看板 Webview 面板（三栏）
src/sidebar.ts     活动栏侧边卡片列表
src/paths.ts       WSL / Windows 路径互转
media/             看板前端（board.css / board.js）与 Vditor 资源
```
