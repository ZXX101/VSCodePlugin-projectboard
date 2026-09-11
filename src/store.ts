import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { toFsPath } from './paths';

export interface BoardConfig {
  /** 检测目录白名单：只统计列表中的项目目录；为空则不读取任何目录 */
  projectDirs: string[];
  /** 新建项目的存放位置，兼作 projectDirs 相对条目的解析基准 */
  projectsRoot: string;
  hubFile: string;
  staleDays: number;
  archiveFolder: string;
}

export interface WorkspaceItem {
  name?: string;
  type: 'app' | 'vscode' | 'url' | 'explorer' | 'powertoys';
  run?: string;
  args?: string;
  path?: string;
  url?: string;
  lnk?: string;
  delay?: number;
}

export interface Project {
  id: string;            // 项目文件夹绝对路径
  dirName: string;
  name: string;
  type: string;
  status: string;        // doing / paused / blocked / done
  focus: string;
  /** focus 为自动识别（frontmatter 未填写）时为 true */
  focusAuto: boolean;
  code: string;
  repo: string;
  branch: string;
  tags: string[];
  workspace: WorkspaceItem[];
  todo: number;
  done: number;
  shelved: number;
  progress: number;      // 0-100
  problems: number;
  updated: number;       // 最近编辑时间戳 ms
  stale: boolean;        // 疑似搁置
}

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
}

const DEFAULT_CONFIG: BoardConfig = {
  projectDirs: [],
  projectsRoot: '.',
  hubFile: 'README.md',
  staleDays: 30,
  archiveFolder: '已完成',
};

const CONFIG_FILE = '.projectboard.json';
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.vscode', 'dist', 'out']);

export class Store {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  root = '';                       // 笔记根目录
  config: BoardConfig = { ...DEFAULT_CONFIG };
  projects: Project[] = [];
  /** 记录插件自己写文件的时间，避免文件监听把正在编辑的文档回灌 */
  private selfWrites = new Map<string, number>();

  /** 在工作区中寻找含 .projectboard.json 的根目录并初始化 */
  async init(): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const candidate = folder.uri.fsPath;
      if (fs.existsSync(path.join(candidate, CONFIG_FILE))) {
        this.root = candidate;
        break;
      }
    }
    if (!this.root) { return false; }
    this.loadConfig();
    await this.refresh();
    return true;
  }

  loadConfig(): void {
    this.config = { ...DEFAULT_CONFIG };
    try {
      const raw = fs.readFileSync(path.join(this.root, CONFIG_FILE), 'utf8');
      const userCfg = JSON.parse(raw);
      this.config = { ...DEFAULT_CONFIG, ...userCfg };
    } catch {
      // 配置文件缺失或损坏时使用默认值
    }
  }

  projectsRootAbs(): string {
    return path.resolve(this.root, this.config.projectsRoot);
  }

  async refresh(): Promise<void> {
    this.loadConfig();
    this.projects = this.scanProjects();
    this._onDidChange.fire();
  }

  // ── 项目扫描 ──────────────────────────────────────────────

  private scanProjects(): Project[] {
    // 白名单机制：只统计 projectDirs 中显式列出的目录；为空则不读取任何目录
    const dirs = this.config.projectDirs ?? [];
    if (!dirs.length) { return []; }
    const result: Project[] = [];
    for (const entry of dirs) {
      if (!entry || typeof entry !== 'string') { continue; }
      const dir = path.isAbsolute(entry) ? entry : path.resolve(this.projectsRootAbs(), entry);
      const hub = path.join(dir, this.config.hubFile);
      if (!fs.existsSync(hub)) { continue; }
      try {
        result.push(this.parseProject(dir, path.basename(dir), hub));
      } catch {
        // 单个项目解析失败不拖垮整个看板
      }
    }
    // 排序：疑似搁置沉底，其余按最近更新倒序
    result.sort((a, b) => {
      if (a.stale !== b.stale) { return a.stale ? 1 : -1; }
      return b.updated - a.updated;
    });
    return result;
  }

  private parseProject(dir: string, dirName: string, hub: string): Project {
    const raw = fs.readFileSync(hub, 'utf8');
    const parsed = matter(raw);
    const d = parsed.data as Record<string, unknown>;

    const stats = this.computeStats(dir, hub);
    const code = str(d.code);
    const branch = this.resolveBranch(code, str(d.branch));
    const updated = stats.updated || mtime(hub);
    const staleDays = this.config.staleDays;
    // focus：frontmatter 手动填写优先；留空时自动识别最新至多两条未勾选任务
    const manualFocus = str(d.focus);
    const autoFocus = stats.focusItems.join('；');

    return {
      id: dir,
      dirName,
      name: str(d.name) || dirName,
      type: str(d.type) || 'other',
      status: str(d.status) || 'doing',
      focus: manualFocus || autoFocus,
      focusAuto: !manualFocus && autoFocus.length > 0,
      code,
      repo: str(d.repo),
      branch,
      tags: Array.isArray(d.tags) ? (d.tags as unknown[]).map(String) : [],
      workspace: Array.isArray(d.workspace) ? (d.workspace as WorkspaceItem[]) : [],
      todo: stats.todo,
      done: stats.done,
      shelved: stats.shelved,
      progress: stats.todo + stats.done > 0
        ? Math.round((stats.done / (stats.todo + stats.done)) * 100)
        : 0,
      problems: stats.problems,
      updated,
      stale: staleDays > 0 && Date.now() - updated > staleDays * 86400_000,
    };
  }

  /** 统计项目文件夹内全部 md 的复选框（跳过归档目录与草稿区块）、问题数与自动焦点 */
  private computeStats(dir: string, hub: string): { todo: number; done: number; shelved: number; problems: number; updated: number; focusItems: string[] } {
    let todo = 0, done = 0, shelved = 0, updated = 0;
    const focusItems: string[] = [];
    // 按修改时间升序处理：最近编辑的文件排在最后，其未勾选项最"新"
    const files = this.walkMd(dir)
      .map((f) => ({ f, t: mtime(f) }))
      .sort((a, b) => a.t - b.t);
    for (const { f: file, t } of files) {
      updated = Math.max(updated, t);
      let content: string;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const stripped = stripSection(content.split('\n'), '草稿').join('\n');
      const re = /^[-*]\s+\[([ xX-])\]\s*(.*)$/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stripped)) !== null) {
        if (m[1] === ' ') {
          todo++;
          // 自动焦点候选：未勾选项的文本（过滤空占位项）
          const text = cleanTaskText(m[2]);
          if (text.length >= 2) { focusItems.push(text); }
        }
        else if (m[1] === '-') { shelved++; }
        else { done++; }
      }
    }
    // 问题数：README 的「问题」区块内非空非标题行
    let problems = 0;
    try {
      const hubLines = fs.readFileSync(hub, 'utf8').split('\n');
      problems = extractSection(hubLines, '问题')
        .filter((l) => l.trim() && !/^#{1,6}\s/.test(l)).length;
    } catch { /* ignore */ }
    // 取最后（最新）至多两条作为自动焦点
    return { todo, done, shelved, problems, updated, focusItems: focusItems.slice(-2) };
  }

  private walkMd(dir: string): string[] {
    const out: string[] = [];
    const walk = (current: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(current, e.name);
        if (e.isDirectory()) {
          if (e.name === this.config.archiveFolder || e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) { continue; }
          walk(full);
        } else if (/\.md$/i.test(e.name)) {
          out.push(full);
        }
      }
    };
    walk(dir);
    return out;
  }

  /** git 分支：优先读 code 目录的 .git/HEAD，兜底 frontmatter 的 branch 字段 */
  private resolveBranch(code: string, fallback: string): string {
    if (code) {
      try {
        const head = fs.readFileSync(path.join(toFsPath(code), '.git', 'HEAD'), 'utf8').trim();
        const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
        if (m) { return m[1]; }
        if (/^[0-9a-f]{7,40}$/i.test(head)) { return head.slice(0, 7) + '（游离）'; }
      } catch { /* 目录不存在或不是 git 仓库 */ }
    }
    return fallback;
  }

  // ── 文档树与读写 ──────────────────────────────────────────

  getTree(projectId: string): TreeNode[] {
    const build = (dir: string): TreeNode[] => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
      const nodes: TreeNode[] = [];
      for (const e of entries) {
        if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) { continue; }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          nodes.push({ name: e.name, path: full, isDir: true, children: build(full) });
        } else {
          nodes.push({ name: e.name, path: full, isDir: false });
        }
      }
      // 文件夹在前，各自按名称排序
      nodes.sort((a, b) => {
        if (a.isDir !== b.isDir) { return a.isDir ? -1 : 1; }
        return a.name.localeCompare(b.name, 'zh-CN');
      });
      return nodes;
    };
    return build(projectId);
  }

  readDoc(filePath: string): string {
    return fs.readFileSync(filePath, 'utf8');
  }

  saveDoc(filePath: string, content: string): void {
    this.selfWrites.set(filePath, Date.now());
    fs.writeFileSync(filePath, content, 'utf8');
  }

  /** 文件监听回调用：判断是否插件自己刚写的文件 */
  isSelfWrite(filePath: string): boolean {
    const t = this.selfWrites.get(filePath);
    if (!t) { return false; }
    this.selfWrites.delete(filePath);
    return Date.now() - t < 2000;
  }

  // ── frontmatter 写操作（正则原位修改，保留用户格式与注释） ──

  /** 在 frontmatter 中更新或插入顶层标量字段 */
  private writeFmField(hub: string, key: string, value: string): void {
    const raw = fs.readFileSync(hub, 'utf8');
    const m = raw.match(/^(---\r?\n)([\s\S]*?)(^---\s*$)/m);
    if (!m) { return; }
    let body = m[2];
    const lineRe = new RegExp(`^${key}:.*$`, 'm');
    if (lineRe.test(body)) {
      body = body.replace(lineRe, `${key}: ${value}`);
    } else {
      body = body.replace(/\s*$/, '') + `\n${key}: ${value}\n`;
    }
    fs.writeFileSync(hub, m[1] + body + m[3] + raw.slice(m[0].length), 'utf8');
  }

  setStatus(projectId: string, status: string): void {
    this.writeFmField(path.join(projectId, this.config.hubFile), 'status', status);
  }

  /** 向 frontmatter 插入工作区配置模板；已存在 workspace 字段时跳过，返回是否实际插入 */
  insertWorkspaceTemplate(projectId: string): boolean {
    const hub = path.join(projectId, this.config.hubFile);
    const raw = fs.readFileSync(hub, 'utf8');
    const m = raw.match(/^(---\r?\n)([\s\S]*?)(^---\s*$)/m);
    if (!m) { return false; }
    // 防重复：frontmatter 中已有 workspace 字段时不再插入（重复键会导致 YAML 解析失败）
    if (/^workspace\s*:/m.test(m[2])) { return false; }
    const template =
      `workspace:\n` +
      `  - name: 代码            # 用 VS Code 打开代码目录\n` +
      `    type: vscode\n` +
      `    path: \n` +
      `  - name: 终端            # 任意程序+参数，例如 wt.exe 配合 args: wsl -e codex\n` +
      `    type: app\n` +
      `    run: wt.exe\n` +
      `    args: \n` +
      `  - name: 参考文档         # 浏览器打开网页\n` +
      `    type: url\n` +
      `    url: \n` +
      `  # - name: 窗口布局       # PowerToys Workspaces 桌面快捷方式（窗口位置记忆）\n` +
      `  #   type: powertoys\n` +
      `  #   lnk: C:\\Users\\PC\\Desktop\\工作区.lnk\n` +
      `  # - name: 文件夹         # 文件管理器打开\n` +
      `  #   type: explorer\n` +
      `  #   path: \n`;
    const body = m[2].replace(/\s*$/, '') + '\n' + template;
    fs.writeFileSync(hub, m[1] + body + m[3] + raw.slice(m[0].length), 'utf8');
    return true;
  }

  // ── 新建项目 ──────────────────────────────────────────────

  async createProjectInteractive(): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: '新建项目（1/2）',
      prompt: '项目名称（将作为文件夹名）',
      validateInput: (v) => {
        if (!v.trim()) { return '名称不能为空'; }
        if (/[\\/:*?"<>|]/.test(v)) { return '名称不能包含 \\ / : * ? " < > |'; }
        if (fs.existsSync(path.join(this.projectsRootAbs(), v.trim()))) { return '同名文件夹已存在'; }
        return undefined;
      },
    });
    if (!name) { return; }
    const type = await vscode.window.showQuickPick(['web', 'qt', 'ros', 'other'], {
      title: '新建项目（2/2）',
      placeHolder: '项目类型',
    });
    if (!type) { return; }

    const dir = path.join(this.projectsRootAbs(), name.trim());
    fs.mkdirSync(dir, { recursive: true });
    const template =
      `---\n` +
      `name: ${name.trim()}\n` +
      `type: ${type}\n` +
      `status: doing\n` +
      `focus: \n` +
      `code: \n` +
      `repo: \n` +
      `branch: \n` +
      `tags: []\n` +
      `---\n\n` +
      `## 需求\n\n- [ ] \n\n` +
      `## 问题\n\n\n` +
      `## 笔记\n\n\n` +
      `## 草稿\n`;
    fs.writeFileSync(path.join(dir, this.config.hubFile), template, 'utf8');
    this.registerProjectDir(name.trim());
    await this.refresh();
    vscode.window.showInformationMessage(`项目「${name.trim()}」已创建并加入检测列表`);
  }

  /** 把新项目目录登记进 .projectboard.json 的 projectDirs 白名单 */
  private registerProjectDir(dirName: string): void {
    const cfgPath = path.join(this.root, CONFIG_FILE);
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* 损坏则重建 */ }
    const list = Array.isArray(cfg.projectDirs) ? (cfg.projectDirs as string[]) : [];
    if (!list.includes(dirName)) {
      list.push(dirName);
      cfg.projectDirs = list;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    }
  }
}

// ── 工具函数 ────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function mtime(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** 清理任务文本用于焦点展示：去 Markdown 语法、去尾部标点、截断 30 字 */
function cleanTaskText(raw: string): string {
  let t = raw.trim();
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');   // [文字](链接) → 文字
  t = t.replace(/[`*]/g, '');                        // 行内代码/粗体标记
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/[。；;，,.\s]+$/, '');               // 尾部标点
  if (t.length > 30) { t = t.slice(0, 30) + '…'; }
  return t;
}

/** 删除指定名称的区块（从标题行到下一个同级或更高级标题之前） */
function stripSection(lines: string[], sectionName: string): string[] {
  const out: string[] = [];
  let skipping = false;
  let skipLevel = 0;
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const level = m[1].length;
      if (skipping && level <= skipLevel) { skipping = false; }
      if (!skipping && m[2].includes(sectionName)) {
        skipping = true;
        skipLevel = level;
        continue;
      }
    }
    if (!skipping) { out.push(line); }
  }
  return out;
}

/** 提取指定名称区块的内容行（不含标题行本身） */
function extractSection(lines: string[], sectionName: string): string[] {
  const out: string[] = [];
  let inSection = false;
  let level = 0;
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const lv = m[1].length;
      if (inSection && lv <= level) { break; }
      if (!inSection && m[2].includes(sectionName)) {
        inSection = true;
        level = lv;
        continue;
      }
    }
    if (inSection) { out.push(line); }
  }
  return out;
}
