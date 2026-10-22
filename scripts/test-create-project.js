/** 新建项目交互回归：node scripts/test-create-project.js（独立沙盒，不访问真实笔记） */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const sandboxRoot = path.resolve(__dirname, '..', 'test-fixtures');
  fs.mkdirSync(sandboxRoot, { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(sandboxRoot, 'create-project-'));
  const originalLoad = Module._load;
  const stub = {
    EventEmitter: class { event = () => {}; fire() {} },
    Uri: { file: (fsPath) => ({ fsPath }) },
    window: {},
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
    const defaultParent = path.join(root, 'projects');
    const nestedParent = path.join(defaultParent, '分类');
    const outsideParent = path.join(sandbox, 'elsewhere');
    for (const dir of [nestedParent, outsideParent]) { fs.mkdirSync(dir, { recursive: true }); }
    const configPath = path.join(root, '.projectboard.json');
    fs.writeFileSync(configPath, JSON.stringify({ projectsRoot: 'projects', projectDirs: [] }));
    const store = new Store();
    store.root = root;
    await store.refresh();

    async function create(parent, name, cancelAt) {
      stub.window = {
        showOpenDialog: async (options) => {
          assert.equal(options.defaultUri.fsPath, defaultParent);
          assert.equal(options.canSelectFiles, false);
          assert.equal(options.canSelectFolders, true);
          return cancelAt === 'folder' ? undefined : [{ fsPath: parent }];
        },
        showInputBox: async (options) => {
          assert.ok(options.validateInput('.'));
          assert.ok(options.validateInput('..'));
          assert.ok(options.validateInput('a/b'));
          assert.equal(options.validateInput(name), undefined);
          return cancelAt === 'name' ? undefined : name;
        },
        showQuickPick: async () => cancelAt === 'type' ? undefined : 'web',
        showInformationMessage: () => {},
        showErrorMessage: (message) => { throw new Error(message); },
      };
      await store.createProjectInteractive();
    }

    for (const parent of [defaultParent, nestedParent, outsideParent]) {
      await create(parent, '项目 #1');
      const dir = path.join(parent, '项目 #1');
      assert.equal(store.projects.find((project) => project.id === dir)?.name, '项目 #1');
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.ok(cfg.projectDirs.includes(path.relative(defaultParent, dir)));
      assert.equal(cfg.projectsRoot, 'projects');
    }
    const before = fs.readFileSync(configPath, 'utf8');
    for (const step of ['folder', 'name', 'type']) {
      await create(outsideParent, '取消测试', step);
      assert.equal(fs.existsSync(path.join(outsideParent, '取消测试')), false);
      assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    }

    // 用户填写期间出现同名目录时，保留原文档且不登记项目。
    const collision = path.join(outsideParent, '重名测试');
    stub.window.showInputBox = async (options) => {
      assert.ok(options.validateInput('项目 #1'));
      return '重名测试';
    };
    stub.window.showQuickPick = async () => {
      fs.mkdirSync(collision);
      fs.writeFileSync(path.join(collision, 'README.md'), '原始内容');
      return 'web';
    };
    let errorShown = false;
    stub.window.showErrorMessage = () => { errorShown = true; };
    await store.createProjectInteractive();
    assert.equal(errorShown, true);
    assert.equal(fs.readFileSync(path.join(collision, 'README.md'), 'utf8'), '原始内容');
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    console.log('✓ 新建项目回归通过：默认/嵌套/外部目录、名称解析、取消、重名保护');
  } finally {
    Module._load = originalLoad;
    // 仅清理本次在 test-fixtures 内创建的独立沙盒。
    assert.equal(path.dirname(sandbox), sandboxRoot);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
