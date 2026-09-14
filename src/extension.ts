import * as vscode from 'vscode';
import { Store } from './store';
import { BoardPanel } from './panel';
import { CardsViewProvider } from './sidebar';

let refreshTimer: NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new Store();
  const found = await store.init();
  if (!found) {
    // 工作区中没有 .projectboard.json，插件静默待命
    return;
  }

  const panel = new BoardPanel(context, store);
  const cardsProvider = new CardsViewProvider(context, store, panel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('projectboard.cards', cardsProvider),
    vscode.commands.registerCommand('projectboard.openBoard', () => panel.show()),
    vscode.commands.registerCommand('projectboard.refresh', () => store.refresh()),
    vscode.commands.registerCommand('projectboard.newProject', () => store.createProjectInteractive()),
  );

  // 监听 md 文件与配置文件变更，防抖刷新看板
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{md,json}');
  const scheduleRefresh = (uri: vscode.Uri): void => {
    if (store.isSelfWrite(uri.fsPath)) { return; }
    if (refreshTimer) { clearTimeout(refreshTimer); }
    refreshTimer = setTimeout(() => { void store.refresh(); }, 500);
    // 外部修改的文件若是看板当前打开的文档，同步重载其内容
    panel.externalFileChanged(uri.fsPath);
  };
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  context.subscriptions.push(watcher);
}

export function deactivate(): void {
  if (refreshTimer) { clearTimeout(refreshTimer); }
}
