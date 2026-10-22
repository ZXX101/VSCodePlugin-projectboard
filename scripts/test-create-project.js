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

    let typeAction;
    function createQuickPick() {
      const handlers = {};
      const picker = {
        value: '', items: [], selectedItems: [], disposed: false,
        onDidChangeValue: (fn) => { handlers.change = fn; return { dispose() {} }; },
        onDidAccept: (fn) => { handlers.accept = fn; return { dispose() {} }; },
        onDidHide: (fn) => { handlers.hide = fn; return { dispose() {} }; },
        hide: () => handlers.hide(),
        dispose: () => { picker.disposed = true; },
        show: () => { typeAction(picker, handlers); assert.equal(picker.disposed, true); },
      };
      return picker;
    }
    async function create(parent, name, cancelAt, type = 'web', inspect) {
      typeAction = (picker, handlers) => {
        inspect?.(picker);
        if (cancelAt === 'type') { picker.hide(); return; }
        picker.value = `  ${type}  `;
        handlers.change(picker.value);
        assert.equal(picker.items.filter((item) => item.label === type).length, 1);
        picker.selectedItems = picker.items.filter((item) => item.label === type);
        handlers.accept();
      };
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
        createQuickPick,
        showInformationMessage: () => {},
        showErrorMessage: (message) => { throw new Error(message); },
      };
      await store.createProjectInteractive();
    }

    for (const parent of [defaultParent, nestedParent, outsideParent]) {
      await create(parent, '项目 #1');
      const dir = path.join(parent, '项目 #1');
      assert.equal(store.projects.find((project) => project.id === dir)?.name, '项目 #1');
      assert.equal(/^focus:/m.test(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')), false);
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.ok(cfg.projectDirs.includes(path.relative(defaultParent, dir)));
      assert.equal(cfg.projectsRoot, 'projects');
    }
    const customType = '嵌入式: C++ #1';
    await create(outsideParent, '自定义类型', undefined, customType);
    assert.equal(store.projects.find((project) => project.dirName === '自定义类型')?.type, customType);
    // 重新初始化 Store 后仍能从项目中发现自定义类型，无需额外类型配置。
    store.projects = [];
    await store.refresh();
    await create(outsideParent, '复用自定义类型', undefined, customType, (picker) => {
      assert.equal(picker.items.filter((item) => item.label === customType).length, 1);
    });
    assert.equal(store.projects.find((project) => project.dirName === '复用自定义类型')?.type, customType);
    // 兼容旧笔记：清理 focus 字段并备份原文件，任务统计仍排除草稿。
    const legacyHub = path.join(outsideParent, '自定义类型', 'README.md');
    const legacyContent = fs.readFileSync(legacyHub, 'utf8')
      .replace('## 需求', '---\nfocus: 旧焦点\n---\n## 需求')
      .replace('## 需求\n\n- [ ] ', '## 需求\n\n- [ ] 待办任务\n- [x] 完成任务\n- [-] 搁置任务')
      .replace('## 草稿\n', '## 草稿\n- [ ] 草稿任务');
    fs.writeFileSync(legacyHub, legacyContent);
    await store.refresh();
    const legacyProject = store.projects.find((project) => project.dirName === '自定义类型');
    assert.equal('focus' in legacyProject, false);
    assert.equal('focusAuto' in legacyProject, false);
    assert.equal(legacyProject.todo, 1);
    assert.equal(legacyProject.done, 1);
    assert.equal(legacyProject.shelved, 1);
    assert.equal(legacyProject.progress, 50);
    assert.equal(fs.readFileSync(legacyHub, 'utf8'), legacyContent.replace('---\nfocus: 旧焦点\n---\n', ''));
    assert.equal(fs.readFileSync(path.join(path.dirname(legacyHub), '.README.md.projectboard.bak'), 'utf8'), legacyContent);
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
    typeAction = (picker, handlers) => {
      picker.value = '   ';
      handlers.change(picker.value);
      assert.equal(picker.items.some((item) => !item.label.trim()), false);
      handlers.accept();
      assert.equal(picker.disposed, false);
      fs.mkdirSync(collision);
      fs.writeFileSync(path.join(collision, 'README.md'), '原始内容');
      picker.selectedItems = [{ label: 'web' }];
      handlers.accept();
    };
    let errorShown = false;
    stub.window.showErrorMessage = () => { errorShown = true; };
    await store.createProjectInteractive();
    assert.equal(errorShown, true);
    assert.equal(fs.readFileSync(path.join(collision, 'README.md'), 'utf8'), '原始内容');
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    console.log('✓ 新建项目回归通过：目录选择、自定义类型创建与复用、空白校验、取消、重名保护');
  } finally {
    Module._load = originalLoad;
    // 仅清理本次在 test-fixtures 内创建的独立沙盒。
    assert.equal(path.dirname(sandbox), sandboxRoot);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
