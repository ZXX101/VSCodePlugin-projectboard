import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { toFsPath } from './paths';

export interface BoardConfig {
  /** 检测目录白名单：只统计列表中的项目目录；为空则不读取任何目录 */
  projectDirs: string[];
  /** 以 projectDirs 中的路径为键，集中存放各项目配置 */
  projects: Record<string, ProjectSettings>;
  /** 新建项目时的默认存放位置，兼作 projectDirs 相对条目的解析基准 */
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

export interface ProjectSettings {
  name?: string;
  type?: string;
  status?: string;
  code?: string;
  repo?: string;
  branch?: string;
  tags?: string[];
  workspace?: WorkspaceItem[];
}

export interface Project {
  id: string;            // 项目文件夹绝对路径
  dirName: string;
  name: string;
  type: string;
  status: string;        // doing / paused / blocked / done
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
  projects: {},
  projectsRoot: '.',
  hubFile: 'README.md',
  staleDays: 30,
  archiveFolder: '已完成',
};

const CONFIG_FILE = '.projectboard.json';
const PROJECT_FIELDS = ['name', 'type', 'status', 'code', 'repo', 'branch', 'tags', 'workspace'] as const;
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
    await this.refresh();
    return true;
  }

  get configPath(): string { return path.join(this.root, CONFIG_FILE); }

  private readConfig(): Record<string, unknown> {
    // 写操作必须读取最新配置；解析失败时停止，不能用默认值覆盖用户文件。
    const cfg: unknown = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    if (!isRecord(cfg) || ['projectsRoot', 'hubFile', 'archiveFolder'].some((key) =>
      cfg[key] !== undefined && typeof cfg[key] !== 'string') || (cfg.projectDirs !== undefined &&
      (!Array.isArray(cfg.projectDirs) || !cfg.projectDirs.every((entry) => typeof entry === 'string'))) ||
      (cfg.projects !== undefined && (!isRecord(cfg.projects) ||
        !Object.values(cfg.projects).every(isRecord)))) {
      throw new Error('.projectboard.json 格式错误：目录与文件名应为字符串，projectDirs 应为路径数组，projects 应为项目配置对象');
    }
    return cfg;
  }

  private writeConfig(cfg: Record<string, unknown>): void {
    // 先写临时文件再替换，避免进程中断留下半份 JSON。
    const temp = this.configPath + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    fs.renameSync(temp, this.configPath);
  }

  loadConfig(): void {
    this.config = { ...DEFAULT_CONFIG, ...this.readConfig() } as BoardConfig;
  }

  private projectKey(projectId: string): string {
    const key = this.config.projectDirs.find((entry) =>
      path.resolve(this.projectsRootAbs(), entry) === path.resolve(projectId));
    if (key === undefined) { throw new Error('项目不在检测列表中'); }
    return key;
  }

  /** 自动迁移旧 frontmatter：先备份，再保存集中配置，最后清理 Markdown 中的插件字段。 */
  private migrateLegacyProjects(): void {
    const cfg = this.readConfig();
    const settings = { ...(cfg.projects as Record<string, ProjectSettings> ?? {}) };
    const cleanup: { hub: string; raw: string; content: string }[] = [];
    let changed = false;
    for (const key of this.config.projectDirs) {
      const hub = path.join(path.resolve(this.projectsRootAbs(), key), this.config.hubFile);
      if (!fs.existsSync(hub)) { continue; }
      const raw = fs.readFileSync(hub, 'utf8');
      const header = raw.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/);
      if (/^\uFEFF?---\r?\n/.test(raw) && !header) {
        throw new Error(`无法迁移 ${hub}：frontmatter 缺少结束分隔符`);
      }
      let data: Record<string, unknown> = {};
      if (header) {
        try { data = matter(raw.replace(/^\uFEFF/, '')).data; }
        catch (error) { throw new Error(`无法迁移 ${hub}：${String(error)}`); }
      }
      if (!Object.prototype.hasOwnProperty.call(settings, key)) {
        const project: ProjectSettings = {};
        for (const field of PROJECT_FIELDS) {
          if (data[field] !== undefined && data[field] !== null) {
            Object.assign(project, { [field]: data[field] });
          }
        }
        Object.defineProperty(settings, key, { value: project, enumerable: true, configurable: true, writable: true });
        changed = true;
      }
      // 根配置已经存在时仍以根配置为准；旧字段先备份再清理，focus 直接废弃。
      if (header && [...PROJECT_FIELDS, 'focus'].some((field) => Object.prototype.hasOwnProperty.call(data, field))) {
        const extra = { ...data };
        for (const field of [...PROJECT_FIELDS, 'focus']) { delete extra[field]; }
        const body = raw.slice(header[0].length);
        const prefix = Object.keys(extra).length ? matter.stringify('', extra) : '';
        cleanup.push({ hub, raw, content: prefix + body });
      }
    }
    // 集中配置中的废弃字段也一并清理。
    for (const [key, value] of Object.entries(settings)) {
      if (Object.prototype.hasOwnProperty.call(value, 'focus') || Object.prototype.hasOwnProperty.call(value, 'focusAuto')) {
        const cleaned = { ...value } as Record<string, unknown>;
        delete cleaned.focus;
        delete cleaned.focusAuto;
        settings[key] = cleaned;
        changed = true;
      }
    }
    if (!changed && !cleanup.length) { return; }
    const backup = (file: string, content: string): void => {
      let dest = path.join(path.dirname(file), '.' + path.basename(file).replace(/^\./, '') + '.projectboard.bak');
      if (fs.existsSync(dest)) {
        if (fs.readFileSync(dest, 'utf8') === content) { return; }
        // 旧编辑器可能重新写回配置头；原备份不同则另存版本，避免清理掉未备份的改动。
        dest += '.' + Date.now();
      }
      fs.writeFileSync(dest, content, { encoding: 'utf8', flag: 'wx' });
    };
    backup(this.configPath, fs.readFileSync(this.configPath, 'utf8'));
    for (const item of cleanup) { backup(item.hub, item.raw); }
    if (changed) { this.writeConfig({ ...cfg, projects: settings }); }
    for (const item of cleanup) {
      const times = fs.statSync(item.hub);
      fs.writeFileSync(item.hub, item.content, 'utf8');
      // 迁移配置不算笔记更新，保持原来的排序与“疑似搁置”时间。
      fs.utimesSync(item.hub, times.atime, times.mtime);
    }
    this.loadConfig();
  }

  projectsRootAbs(): string {
    return path.resolve(this.root, this.config.projectsRoot);
  }

  async refresh(): Promise<void> {
    try {
      this.loadConfig();
      this.migrateLegacyProjects();
    } catch (error) {
      void vscode.window.showErrorMessage(`项目看板配置读取或迁移失败：${String(error)}`);
      return;
    }
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
        result.push(this.parseProject(dir, path.basename(dir), hub, this.config.projects[entry] ?? {}));
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

  private parseProject(dir: string, dirName: string, hub: string, d: ProjectSettings): Project {

    const stats = this.computeStats(dir, hub);
    const code = str(d.code);
    const branch = this.resolveBranch(code, str(d.branch));
    const updated = stats.updated || mtime(hub);
    const staleDays = this.config.staleDays;

    return {
      id: dir,
      dirName,
      name: str(d.name) || dirName,
      type: str(d.type) || 'other',
      status: str(d.status) || 'doing',
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

  /** 统计项目文件夹内全部 md 的复选框（跳过归档目录与草稿区块）与问题数 */
  private computeStats(dir: string, hub: string): { todo: number; done: number; shelved: number; problems: number; updated: number } {
    let todo = 0, done = 0, shelved = 0, updated = 0;
    for (const file of this.walkMd(dir)) {
      updated = Math.max(updated, mtime(file));
      let content: string;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const stripped = stripSection(content.split(/\r?\n/), '草稿').join('\n');
      const re = /^[-*]\s+\[([ xX-])\]\s*(.*)$/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stripped)) !== null) {
        if (m[1] === ' ') { todo++; }
        else if (m[1] === '-') { shelved++; }
        else { done++; }
      }
    }
    // 问题数：README 的「问题」区块内非空非标题行
    let problems = 0;
    try {
      const hubLines = fs.readFileSync(hub, 'utf8').split(/\r?\n/);
      problems = extractSection(hubLines, '问题')
        .filter((l) => l.trim() && !/^#{1,6}\s/.test(l)).length;
    } catch { /* ignore */ }
    return { todo, done, shelved, problems, updated };
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

  /** git 分支：优先读 code 目录的 .git/HEAD，兜底根配置中的 branch 字段 */
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

  // ── 集中项目配置写操作 ──────────────────────────────────────

  private updateProjectSettings(projectId: string, update: (settings: ProjectSettings) => void): void {
    this.loadConfig();
    const key = this.projectKey(projectId);
    const cfg = this.readConfig();
    const projects = { ...(cfg.projects as Record<string, ProjectSettings> ?? {}) };
    const settings = { ...projects[key] };
    update(settings);
    Object.defineProperty(projects, key, { value: settings, enumerable: true, configurable: true, writable: true });
    this.writeConfig({ ...cfg, projects });
  }

  setStatus(projectId: string, status: string): void {
    this.updateProjectSettings(projectId, (settings) => { settings.status = status; });
  }

  /** 工作区模板写入根配置；已有启动项时不重复插入。 */
  insertWorkspaceTemplate(projectId: string): boolean {
    let inserted = false;
    this.updateProjectSettings(projectId, (settings) => {
      if (settings.workspace?.length) { return; }
      settings.workspace = [
        { name: '代码', type: 'vscode', path: '' },
        { name: '终端', type: 'app', run: 'wt.exe', args: '' },
        { name: '参考文档', type: 'url', url: '' },
      ];
      inserted = true;
    });
    return inserted;
  }

  // ── 新建项目 ──────────────────────────────────────────────

  private async pickProjectType(): Promise<string | undefined> {
    const types = [...new Set(['web', 'qt', 'ros', 'other', ...this.projects.map((p) => p.type)])];
    const picker = vscode.window.createQuickPick();
    picker.title = '新建项目（3/3）';
    picker.placeholder = '选择已有类型，或输入新类型后按回车创建';
    picker.items = types.map((label) => ({ label }));
    return new Promise((resolve) => {
      let result: string | undefined;
      const subscriptions = [
        picker.onDidChangeValue((value) => {
          const input = value.trim();
          const items: vscode.QuickPickItem[] = types.map((label) => ({ label }));
          // 保留原始类型名作为 label，避免把“新建类型”的提示文字写入项目配置。
          if (input && !types.includes(input)) {
            items.unshift({ label: input, description: '新类型（回车创建）', alwaysShow: true });
          }
          picker.items = items;
        }),
        picker.onDidAccept(() => {
          const value = picker.selectedItems[0]?.label ?? picker.value;
          if (!value.trim()) { return; }
          result = value.trim();
          picker.hide();
        }),
        picker.onDidHide(() => {
          subscriptions.forEach((subscription) => subscription.dispose());
          picker.dispose();
          resolve(result);
        }),
      ];
      picker.show();
    });
  }

  async createProjectInteractive(): Promise<void> {
    this.loadConfig();
    const folders = await vscode.window.showOpenDialog({
      title: '新建项目（1/3）：选择存放文件夹',
      openLabel: '在此文件夹下新建项目',
      defaultUri: vscode.Uri.file(this.projectsRootAbs()),
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
    });
    if (!folders?.length) { return; }
    const parentDir = folders[0].fsPath;
    const name = await vscode.window.showInputBox({
      title: '新建项目（2/3）',
      prompt: `项目名称（将在 ${parentDir} 下新建同名文件夹）`,
      validateInput: (v) => {
        if (!v.trim()) { return '名称不能为空'; }
        if (v.trim() === '.' || v.trim() === '..') { return '名称不能为 . 或 ..'; }
        if (/[\\/:*?"<>|]/.test(v)) { return '名称不能包含 \\ / : * ? " < > |'; }
        if (fs.existsSync(path.join(parentDir, v.trim()))) { return '所选位置已有同名文件或文件夹'; }
        return undefined;
      },
    });
    if (!name) { return; }
    const type = await this.pickProjectType();
    if (!type) { return; }

    const dir = path.join(parentDir, name.trim());
    // 不递归创建：用户填完后目录可能已被其他程序创建，必须避免覆盖已有项目。
    try {
      fs.mkdirSync(dir);
    } catch (error) {
      void vscode.window.showErrorMessage(`无法创建项目：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const template =
      `## 需求\n\n- [ ] \n\n` +
      `## 草稿\n\n\n` +
      `## 问题\n\n\n` +
      `## 笔记\n`;
    fs.writeFileSync(path.join(dir, this.config.hubFile), template, 'utf8');
    // 白名单相对路径始终以 projectsRoot 为基准；跨盘时 relative 返回绝对路径。
    this.registerProjectDir(path.relative(this.projectsRootAbs(), dir), {
      name: name.trim(), type, status: 'doing', code: '', repo: '', branch: '', tags: [], workspace: [],
    });
    await this.refresh();
    vscode.window.showInformationMessage(`项目「${name.trim()}」已创建并加入检测列表`);
  }

  /** 把新项目目录及配置一起写入根配置，保留所有其他项目和全局设置。 */
  private registerProjectDir(dirName: string, settings: ProjectSettings): void {
    const cfg = this.readConfig();
    const list = Array.isArray(cfg.projectDirs) ? [...cfg.projectDirs] : [];
    if (!list.includes(dirName)) { list.push(dirName); }
    const projects = { ...(cfg.projects as Record<string, ProjectSettings> ?? {}) };
    Object.defineProperty(projects, dirName, { value: settings, enumerable: true, configurable: true, writable: true });
    this.writeConfig({ ...cfg, projectDirs: list, projects });
  }

}

// ── 工具函数 ────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function mtime(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
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
