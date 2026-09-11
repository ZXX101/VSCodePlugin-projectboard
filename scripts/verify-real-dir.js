// 用数据层直接扫描 WSL 真实笔记目录（UNC 路径）验证部署结果
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
  store.root = '\\\\wsl$\\Ubuntu-24.04\\home\\pc\\Docs\\XuFeng';
  await store.refresh();
  console.log('真实笔记目录扫描结果：');
  for (const p of store.projects) {
    console.log(
      ' ■', p.name, '[' + p.type + ']', p.status,
      '| 进度', p.progress + '%',
      '| 待办', p.todo, '| 问题', p.problems,
      '| 分支', p.branch || '无',
      '| 搁置', p.stale ? '是' : '否',
    );
  }
  if (store.projects.length !== 2) { throw new Error('项目数应为 2'); }
  console.log('✓ 真实目录验证通过');
})().catch((e) => { console.error('✗ 失败:', e.message); process.exit(1); });
