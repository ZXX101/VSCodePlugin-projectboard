import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { WorkspaceItem } from './store';
import { isWsl, toFsPath, toWinPath } from './paths';

/** 简单命令行参数分词：支持双引号包裹的片段 */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    out.push(m[1] ?? m[2]);
  }
  return out;
}

function spawnDetached(command: string, args: string[], useShell = false): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    shell: useShell,
    windowsHide: true,
  });
  child.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 执行单个工作区启动项 */
async function runItem(item: WorkspaceItem): Promise<void> {
  switch (item.type) {
    case 'app': {
      if (!item.run) { throw new Error('缺少 run 字段'); }
      const args = item.args ? splitArgs(item.args) : [];
      // WSL 中可直接调用 Windows 可执行文件（interop）；Windows 宿主走 shell 以解析 PATH
      spawnDetached(item.run, args, !isWsl);
      break;
    }
    case 'vscode': {
      if (!item.path) { throw new Error('缺少 path 字段'); }
      // code CLI 在 Windows 宿主与 Remote-WSL 环境均可用
      spawnDetached('code', [item.path], !isWsl);
      break;
    }
    case 'url': {
      if (!item.url) { throw new Error('缺少 url 字段'); }
      await vscode.env.openExternal(vscode.Uri.parse(item.url));
      break;
    }
    case 'explorer': {
      if (!item.path) { throw new Error('缺少 path 字段'); }
      if (isWsl) {
        spawnDetached('explorer.exe', [toWinPath(item.path)]);
      } else {
        spawnDetached('explorer.exe', [item.path]);
      }
      break;
    }
    case 'powertoys': {
      if (!item.lnk) { throw new Error('缺少 lnk 字段'); }
      const lnk = toWinPath(item.lnk);
      // .lnk 通过 cmd start 启动，WSL/Windows 一致
      spawnDetached(isWsl ? 'cmd.exe' : 'cmd.exe', ['/c', 'start', '""', lnk]);
      break;
    }
    default:
      throw new Error(`未知的工作区类型：${String((item as WorkspaceItem).type)}`);
  }
}

/**
 * 顺序执行一个项目的全部工作区启动项，带进度通知与失败汇总。
 * 单项失败不阻塞后续项。
 */
export async function runWorkspace(items: WorkspaceItem[], projectName: string): Promise<void> {
  if (!items || items.length === 0) { return; }
  const failures: string[] = [];
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `启动工作区：${projectName}`,
      cancellable: false,
    },
    async (progress) => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const label = item.name || item.type;
        progress.report({ message: `(${i + 1}/${items.length}) ${label}` });
        try {
          await runItem(item);
        } catch (err) {
          failures.push(`${label}：${err instanceof Error ? err.message : String(err)}`);
        }
        // delay 表示启动下一项之前的等待秒数
        if (i < items.length - 1 && item.delay && item.delay > 0) {
          await sleep(item.delay * 1000);
        }
      }
    },
  );
  if (failures.length > 0) {
    vscode.window.showWarningMessage(`工作区启动完成，${failures.length} 项失败：\n${failures.join('\n')}`);
  } else {
    vscode.window.showInformationMessage(`工作区「${projectName}」已全部启动（${items.length} 项）`);
  }
}

/** 供数据层探测 code 目录使用（保留 toFsPath 引用，避免误删导入） */
export { toFsPath };
