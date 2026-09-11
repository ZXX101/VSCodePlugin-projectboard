// 验证 MyProj 文档部署后，Docs 根目录的三张卡片都能正确识别
const Module = require('module');
const stub = {
  EventEmitter: class {
    constructor() { this.l = []; }
    get event() { return (f) => this.l.push(f); }
    fire(d) { this.l.forEach((f) => f(d)); }
  },
  window: {},
  workspace: {},
};
const orig = Module._load;
Module._load = function (r, ...a) {
  if (r === 'vscode') { return stub; }
  return orig.call(this, r, ...a);
};
const { Store } = require('../dist-test/store.cjs');

(async () => {
  const store = new Store();
  store.root = '\\\\wsl$\\Ubuntu-24.04\\home\\pc\\Docs';
  await store.refresh();
  console.log('Docs 根目录扫描结果：');
  for (const p of store.projects) {
    console.log(
      ' ■', p.name, '[' + p.type + ']', p.status,
      '| 进度', p.progress + '%',
      '| 待办', p.todo, '| 分支', p.branch || '无',
      '| 目录', p.dirName,
    );
  }
  if (store.projects.length !== 3) { throw new Error('项目数应为 3'); }
  const myproj = store.projects.find((p) => p.dirName === 'MyProj');
  if (!myproj) { throw new Error('未找到 MyProj'); }
  if (myproj.branch !== 'main') { throw new Error('MyProj 分支应自动读取为 main，实际: ' + myproj.branch); }
  console.log('✓ 验证通过：MyProj 已上板，git 分支自动读取为 main');
})().catch((e) => { console.error('✗ 失败:', e.message); process.exit(1); });
