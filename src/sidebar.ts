import * as vscode from 'vscode';
import * as path from 'path';
import { Store, Project } from './store';
import { BoardPanel } from './panel';

/** 左侧边栏：项目卡片精简列表，点击卡片打开看板并定位到该项目 */
export class CardsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly panel: BoardPanel,
  ) {
    store.onDidChange(() => this.pushState());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: { type: string; id?: string }) => {
      // 修复：侧边栏初次打开时没有任何数据变更事件，必须由前端发 ready 主动拉取初始状态，
      // 否则卡片列表要等下一次刷新才会出现
      if (msg.type === 'ready') {
        this.pushState();
      } else if (msg.type === 'select' && msg.id) {
        this.panel.show(msg.id);
      } else if (msg.type === 'openBoard') {
        this.panel.show();
      }
    });
  }

  private pushState(): void {
    this.view?.webview.postMessage({ type: 'state', projects: this.store.projects });
  }

  private statusText(p: Project): string {
    if (p.stale) { return '疑似搁置'; }
    return { doing: '进行中', paused: '暂停', blocked: '卡住', done: '完结' }[p.status] ?? p.status;
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now()) + String(Math.random()).slice(2);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; font-family: var(--vscode-font-family); }
  body { padding: 8px; color: var(--vscode-foreground); }
  .open-btn {
    width: 100%; padding: 7px; margin-bottom: 10px; border: none; border-radius: 4px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-size: 13px;
  }
  .open-btn:hover { background: var(--vscode-button-hoverBackground); }
  .card {
    padding: 10px 12px; margin-bottom: 8px; border-radius: 6px; cursor: pointer;
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-widget-border, transparent);
  }
  .card:hover { border-color: var(--vscode-focusBorder); }
  .card.dimmed { opacity: .45; }
  .name { font-size: 13px; font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot.doing { background: #4ec96b; } .dot.paused { background: #e2c08d; }
  .dot.blocked { background: #e51400; } .dot.done { background: #3794ff; } .dot.stale { background: #6a6a6a; }
  .meta { font-size: 11px; opacity: .75; margin-bottom: 6px; }
  .progress { height: 4px; border-radius: 2px; background: var(--vscode-input-background); overflow: hidden; }
  .progress > div { height: 100%; background: var(--vscode-progressBar-background, #007acc); }
  .empty { font-size: 12px; opacity: .6; text-align: center; margin-top: 20px; }
</style>
</head>
<body>
<button class="open-btn" id="openBoard">▦ 打开项目看板</button>
<div id="list"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');
  document.getElementById('openBoard').addEventListener('click', () => vscode.postMessage({ type: 'openBoard' }));
  window.addEventListener('message', (e) => {
    if (e.data.type !== 'state') return;
    const projects = e.data.projects || [];
    list.innerHTML = '';
    if (!projects.length) {
      list.innerHTML = '<div class="empty">未发现项目<br>点击看板右上角「新建项目」开始</div>';
      return;
    }
    for (const p of projects) {
      const el = document.createElement('div');
      el.className = 'card' + (p.stale ? ' dimmed' : '');
      const cls = p.stale ? 'stale' : p.status;
      const statusText = p.stale ? '疑似搁置'
        : ({ doing: '进行中', paused: '暂停', blocked: '卡住', done: '完结' })[p.status] || p.status;
      el.innerHTML =
        '<div class="name"><span class="dot ' + cls + '"></span>' + esc(p.name) + '</div>' +
        '<div class="meta">' + esc(p.type) + ' · ' + statusText + ' · 待办 ' + p.todo + '</div>' +
        '<div class="progress"><div style="width:' + p.progress + '%"></div></div>';
      el.addEventListener('click', () => vscode.postMessage({ type: 'select', id: p.id }));
      list.appendChild(el);
    }
  });
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // 加载完成，主动向宿主拉取初始数据
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
