import * as vscode from 'vscode';
import * as path from 'path';
import { Store } from './store';
import { runWorkspace } from './launcher';
import { isWsl } from './paths';

export class BoardPanel {
  private panel?: vscode.WebviewPanel;
  private activeProjectId = '';
  private currentDoc = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: Store,
  ) {
    store.onDidChange(() => this.pushState());
  }

  /** 打开（或聚焦）看板，可选定位到指定项目 */
  show(projectId?: string): void {
    if (projectId) { this.activeProjectId = projectId; }
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.pushState();
      if (this.activeProjectId) { this.selectProject(this.activeProjectId); }
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'projectboard.board',
      '项目看板',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))],
      },
    );
    this.panel.iconPath = vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'icon.svg'));
    this.panel.webview.html = this.renderHtml(this.panel.webview);
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
  }

  private post(msg: unknown): void {
    this.panel?.webview.postMessage(msg);
  }

  private pushState(): void {
    if (!this.panel) { return; }
    this.post({
      type: 'state',
      projects: this.store.projects,
      config: this.store.config,
      activeId: this.activeProjectId,
    });
  }

  private selectProject(id: string): void {
    this.activeProjectId = id;
    this.post({ type: 'tree', id, nodes: this.store.getTree(id) });
    const hub = path.join(id, this.store.config.hubFile);
    this.openDoc(hub);
  }

  /** 外部（如原生编辑器）修改了文件：若是当前打开的文档则重载内容 */
  externalFileChanged(filePath: string): void {
    if (!this.panel || filePath !== this.currentDoc) { return; }
    if (this.reloadTimer) { clearTimeout(this.reloadTimer); }
    this.reloadTimer = setTimeout(() => this.openDoc(filePath), 300);
  }

  private reloadTimer?: NodeJS.Timeout;

  private openDoc(filePath: string): void {
    try {
      this.currentDoc = filePath;
      this.post({ type: 'doc', path: filePath, content: this.store.readDoc(filePath) });
    } catch (err) {
      vscode.window.showErrorMessage(`无法读取文档：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async onMessage(msg: { type: string; [k: string]: string }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.pushState();
        if (this.activeProjectId) { this.selectProject(this.activeProjectId); }
        break;
      case 'selectProject':
        this.selectProject(msg.id);
        break;
      case 'openDoc':
        this.openDoc(msg.path);
        break;
      case 'editDoc': {
        const doc = await vscode.workspace.openTextDocument(msg.path);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        break;
      }
      case 'saveDoc':
        try {
          this.store.saveDoc(msg.path, msg.content);
          this.post({ type: 'saved', path: msg.path, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
        } catch (err) {
          vscode.window.showErrorMessage(`保存失败：${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      case 'openUrl':
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case 'refresh':
        await this.store.refresh();
        // 修复：刷新按钮也要重载当前打开的文档内容（之前只重扫项目统计）
        if (this.currentDoc) { this.openDoc(this.currentDoc); }
        break;
      case 'newProject':
        await this.store.createProjectInteractive();
        break;
      case 'setStatus':
        this.store.setStatus(msg.id, msg.status);
        await this.store.refresh();
        break;
      case 'action':
        await this.onCardAction(msg.id, msg.action);
        break;
    }
  }

  private async onCardAction(id: string, action: string): Promise<void> {
    const project = this.store.projects.find((p) => p.id === id);
    if (!project) { return; }
    const hub = path.join(id, this.store.config.hubFile);
    const openHub = async (): Promise<void> => {
      const doc = await vscode.workspace.openTextDocument(hub);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    };

    switch (action) {
      case 'code':
        if (!project.code) { return; }
        await runWorkspace([{ type: 'vscode', path: project.code, name: '代码目录' }], project.name);
        break;
      case 'codeExplorer':
        if (!project.code) { return; }
        await runWorkspace([{ type: 'explorer', path: project.code, name: '代码目录' }], project.name);
        break;
      case 'repo':
        if (!project.repo) { return; }
        vscode.env.openExternal(vscode.Uri.parse(project.repo));
        break;
      case 'repoCopy':
        if (!project.repo) { return; }
        await vscode.env.clipboard.writeText(project.repo);
        vscode.window.showInformationMessage('仓库地址已复制到剪贴板');
        break;
      case 'workspace':
        if (!project.workspace || project.workspace.length === 0) {
          this.store.insertWorkspaceTemplate(id);
          await this.store.refresh();
          vscode.window.showInformationMessage('已在 README 中插入工作区配置模板，请填写后重试');
          await openHub();
          return;
        }
        await runWorkspace(project.workspace, project.name);
        break;
      case 'workspaceEdit':
        await openHub();
        break;
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const media = (p: string): string =>
      webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', p))).toString();
    const nonce = String(Date.now()) + String(Math.random()).slice(2);
    const vditorBase = media('vditor');
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `font-src ${webview.cspSource} data:`,
      `connect-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${vditorBase}/dist/index.css">
<link rel="stylesheet" href="${media('board.css')}">
<title>项目看板</title>
</head>
<body>
<div id="app">
  <div class="toolbar">
    <div class="tb-title">▦ 项目看板</div>
    <input id="search" class="search" placeholder="搜索项目名 / 标签 / 焦点…" />
    <select id="filterStatus" class="dropdown">
      <option value="">状态: 全部</option>
      <option value="doing">进行中</option>
      <option value="paused">暂停</option>
      <option value="blocked">卡住</option>
      <option value="done">完结</option>
      <option value="stale">疑似搁置</option>
    </select>
    <select id="filterType" class="dropdown"><option value="">类型: 全部</option></select>
    <button id="btnRefresh" class="icon-btn" title="刷新">⟳</button>
    <div class="grow"></div>
    <button id="btnNew" class="primary-btn">＋ 新建项目</button>
  </div>
  <div class="columns">
    <div class="col-cards" id="colCards">
      <div class="col-header"><span class="col-title">项目卡片 <span class="count" id="cardCount">0</span></span><button class="col-toggle" id="toggleCards" title="收起卡片栏">«</button></div>
      <div class="card-list" id="cardList"></div>
      <div class="mini-list" id="cardsMini"></div>
    </div>
    <div class="col-files" id="colFiles">
      <div class="col-header"><span class="col-title" id="treeTitle">文档</span><button class="col-toggle" id="toggleFiles" title="收起文档栏">«</button></div>
      <div class="tree" id="tree"></div>
      <div class="mini-list" id="filesMini"></div>
    </div>
    <div class="col-doc">
      <div class="doc-header">
        <span id="docPath" class="doc-path">未选择文档</span>
        <span id="saveState" class="save-state"></span>
        <button id="btnOpenExternal" class="icon-btn" title="在编辑器中打开">↗</button>
      </div>
      <div id="editor"></div>
      <div id="editorEmpty" class="editor-empty">点击左侧文档树中的文件开始预览与编辑</div>
    </div>
  </div>
</div>
<div id="ctxMenu" class="ctx-menu"></div>
<script nonce="${nonce}">
  window.VDITOR_CDN = ${JSON.stringify(vditorBase)};
  window.IS_WSL = ${JSON.stringify(isWsl)};
</script>
<script nonce="${nonce}" src="${vditorBase}/dist/index.min.js"></script>
<script nonce="${nonce}" src="${vditorBase}/dist/js/icons/ant.js"></script>
<script nonce="${nonce}" src="${media('board.js')}"></script>
</body>
</html>`;
  }
}
