/** 集中配置与旧版迁移回归：node scripts/test-config-migration.js */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const sandboxRoot = path.resolve(__dirname, '..', 'test-fixtures');
  fs.mkdirSync(sandboxRoot, { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(sandboxRoot, 'config-migration-'));
  const originalLoad = Module._load;
  const errors = [];
  const stub = {
    EventEmitter: class { event = () => {}; fire() {} },
    window: { showErrorMessage: (message) => errors.push(message) },
  };
  try {
    const bundle = path.join(sandbox, 'store.cjs');
    esbuild.buildSync({
      entryPoints: [path.resolve(__dirname, '..', 'src/store.ts')],
      bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle,
    });
    Module._load = function (request, ...args) {
      return request === 'vscode' ? stub : originalLoad.call(this, request, ...args);
    };
    const { Store } = require(bundle);
    const root = path.join(sandbox, 'notes');
    const parent = path.join(root, 'projects');
    const external = path.join(sandbox, 'external');
    const workspace = [
      { name: '代码', type: 'vscode', path: 'D:/code' },
      { name: '终端', type: 'app', run: 'wt.exe', args: 'wsl -e codex', delay: 2 },
      { name: '布局', type: 'powertoys', lnk: 'C:/desktop/work.lnk' },
    ];
    const body = '\r\n## 需求\r\n- [ ] 任务\r\n- [x] 完成\r\n\r\n## 问题\r\n问题描述\r\n## 草稿\r\n- [ ] 不统计\r\n';
    function hub(dir, content) {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'README.md');
      fs.writeFileSync(file, content);
      fs.utimesSync(file, new Date('2025-01-01'), new Date('2025-01-01'));
      return file;
    }
    const oldContent = '\uFEFF---\r\nname: 旧项目\r\ntype: qt\r\nstatus: paused\r\ncode: ""\r\nrepo: https://example.com/repo\r\nbranch: fallback\r\ntags: [中文, qt]\r\nfocus: 废弃\r\nworkspace: ' + JSON.stringify(workspace) + '\r\n---\r\n' + body;
    const oldHub = hub(path.join(parent, '分类', '旧项目'), oldContent);
    const extraHub = hub(external, '---\nname: 外部\ncustom: 保留元信息\n---\n## 笔记\n正文\n');
    const conflictHub = hub(path.join(parent, '冲突'), '---\nname: 旧名称\ntype: ros\nfocus: 废弃\n---\n## 笔记\n原文');
    hub(path.join(parent, '普通正文'), '## 需求\n- [ ] 普通任务');
    hub(path.join(parent, '未登记'), '---\nname: 不迁移\n---\n正文');
    const cfgPath = path.join(root, '.projectboard.json');
    const original = JSON.stringify({
      projectDirs: ['分类/旧项目', external, '冲突', '普通正文', '不存在'],
      projectsRoot: 'projects', customGlobal: { keep: true },
      projects: { 冲突: { name: '根配置优先', type: '自定义', status: 'blocked', focus: '废弃' } },
    }, null, 2);
    fs.writeFileSync(cfgPath, original);
    const store = new Store();
    store.root = root;
    await store.refresh();
    assert.deepEqual(errors, []);
    assert.equal(store.projects.length, 4);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.deepEqual(cfg.customGlobal, { keep: true });
    assert.deepEqual(cfg.projects['分类/旧项目'].workspace, workspace);
    assert.deepEqual(cfg.projects['分类/旧项目'].tags, ['中文', 'qt']);
    assert.equal('focus' in cfg.projects['分类/旧项目'], false);
    assert.equal('focus' in cfg.projects.冲突, false);
    assert.equal(cfg.projects.冲突.name, '根配置优先');
    assert.equal(cfg.projects.冲突.type, '自定义');
    assert.equal(cfg.projects[external].name, '外部');
    assert.equal(fs.readFileSync(oldHub, 'utf8'), body);
    assert.equal(fs.readFileSync(path.join(path.dirname(oldHub), '.README.md.projectboard.bak'), 'utf8'), oldContent);
    assert.equal(fs.readFileSync(path.join(root, '.projectboard.json.projectboard.bak'), 'utf8'), original);
    assert.ok(fs.readFileSync(extraHub, 'utf8').includes('custom: 保留元信息'));
    assert.ok(fs.readFileSync(extraHub, 'utf8').endsWith('## 笔记\n正文\n'));
    assert.equal(fs.readFileSync(conflictHub, 'utf8'), '## 笔记\n原文');
    assert.equal(fs.statSync(oldHub).mtimeMs, new Date('2025-01-01').getTime());
    const oldProject = store.projects.find((project) => project.name === '旧项目');
    assert.equal(oldProject.progress, 50);
    assert.equal(oldProject.problems, 1);
    assert.equal(oldProject.branch, 'fallback');
    assert.equal(oldProject.stale, true);
    assert.equal(fs.existsSync(path.join(parent, '未登记', '.README.md.projectboard.bak')), false);
    const afterMigration = fs.readFileSync(cfgPath, 'utf8');
    const configMtime = fs.statSync(cfgPath).mtimeMs;
    await store.refresh();
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), afterMigration);
    assert.equal(fs.statSync(cfgPath).mtimeMs, configMtime);

    store.setStatus(oldProject.id, 'done');
    assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).projects['分类/旧项目'].status, 'done');
    assert.equal(fs.readFileSync(oldHub, 'utf8'), body);
    assert.equal(store.insertWorkspaceTemplate(oldProject.id), false);
    const plain = store.projects.find((project) => project.dirName === '普通正文');
    assert.equal(store.insertWorkspaceTemplate(plain.id), true);
    assert.equal(store.insertWorkspaceTemplate(plain.id), false);
    assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).projects.普通正文.workspace.length, 3);
    const panelBundle = path.join(sandbox, 'panel.cjs');
    esbuild.buildSync({
      entryPoints: [path.resolve(__dirname, '..', 'src/panel.ts')],
      bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: panelBundle,
    });
    const opened = [];
    stub.workspace = { openTextDocument: async (file) => { opened.push(file); return {}; } };
    stub.ViewColumn = { Beside: 2 };
    stub.window.showTextDocument = async () => {};
    stub.window.showInformationMessage = () => {};
    const { BoardPanel } = require(panelBundle);
    const panel = new BoardPanel({}, store);
    await panel.onCardAction(oldProject.id, 'workspaceEdit');
    const conflict = store.projects.find((project) => project.dirName === '冲突');
    await panel.onCardAction(conflict.id, 'workspace');
    assert.deepEqual(opened, [cfgPath, cfgPath]);
    assert.equal(fs.readFileSync(conflictHub, 'utf8'), '## 笔记\n原文');
    const configBeforeError = fs.readFileSync(cfgPath, 'utf8');
    for (const broken of ['{invalid', '{"projectDirs":null}', '{"projects":null}']) {
      fs.writeFileSync(cfgPath, broken);
      await store.refresh();
      assert.throws(() => store.setStatus(oldProject.id, 'doing'));
      assert.equal(fs.readFileSync(cfgPath, 'utf8'), broken);
      assert.equal(fs.readFileSync(oldHub, 'utf8'), body);
    }
    assert.equal(errors.length, 3);
    fs.writeFileSync(cfgPath, configBeforeError);

    // 任意旧项目解析失败时，整个迁移尚未写入，不丢失其他项目的配置。
    hub(path.join(parent, '损坏'), '---\nname: [损坏\n---\n正文');
    const pendingHub = hub(path.join(parent, '待迁移'), '---\nname: 待迁移\n---\n正文');
    const badConfig = JSON.stringify({ projectDirs: ['待迁移', '损坏'], projectsRoot: 'projects' });
    fs.writeFileSync(cfgPath, badConfig);
    await store.refresh();
    assert.equal(errors.length, 4);
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), badConfig);
    assert.ok(fs.readFileSync(pendingHub, 'utf8').startsWith('---'));
    const pendingConfig = JSON.stringify({ projectDirs: ['待迁移'], projectsRoot: 'projects' });
    fs.writeFileSync(cfgPath, pendingConfig);
    const originalWrite = fs.writeFileSync;
    try {
      fs.writeFileSync = function (file, ...args) {
        if (String(file).includes('待迁移') && String(file).endsWith('.projectboard.bak')) {
          throw new Error('模拟备份不可写');
        }
        return originalWrite.call(this, file, ...args);
      };
      await store.refresh();
      assert.equal(errors.length, 5);
      assert.equal(fs.readFileSync(cfgPath, 'utf8'), pendingConfig);
      assert.ok(fs.readFileSync(pendingHub, 'utf8').startsWith('---'));
    } finally {
      fs.writeFileSync = originalWrite;
    }
    console.log('✓ 集中配置回归通过：迁移、备份、正文和时间保留、冲突优先级、状态/工作区写入、重复加载、损坏保护');
  } finally {
    Module._load = originalLoad;
    assert.equal(path.dirname(sandbox), sandboxRoot);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
