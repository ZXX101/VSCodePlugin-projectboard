/**
 * 数据层冒烟测试：在扩展宿主之外用真实笔记数据验证 Store。
 * 运行：node scripts/smoke-test.js
 */
const path = require('path');
const Module = require('module');

// 打桩 vscode 模块（Store 只用到 EventEmitter / 少量 API）
const stub = {
  EventEmitter: class {
    constructor() { this.listeners = []; }
    get event() { return (f) => this.listeners.push(f); }
    fire(d) { this.listeners.forEach((f) => f(d)); }
  },
  window: { showInformationMessage: () => {}, showInputBox: () => {}, showQuickPick: () => {} },
  workspace: {},
};
const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'vscode') { return stub; }
  return origLoad.call(this, request, ...args);
};

const { Store } = require('../dist-test/store.cjs');

const FIXTURE = path.resolve(__dirname, '..', 'test-fixtures', 'XuFeng');

(async () => {
  const store = new Store();
  store.root = FIXTURE;
  await store.refresh();

  console.log('═══ 项目扫描结果 ═══');
  for (const p of store.projects) {
    console.log(`\n■ ${p.name}  [${p.type}]  ${p.status}${p.stale ? '（疑似搁置）' : ''}`);
    console.log(`  焦点: ${p.focus || '(空)'}`);
    console.log(`  进度: ${p.progress}%  (完成 ${p.done} / 待办 ${p.todo} / 搁置 ${p.shelved})`);
    console.log(`  问题数: ${p.problems}`);
    console.log(`  分支: ${p.branch || '(无)'}   更新于: ${new Date(p.updated).toLocaleString('zh-CN')}`);
    console.log(`  tags: [${p.tags.join(', ')}]`);
  }

  console.log('\n═══ 文档树（地面站） ═══');
  const gcs = store.projects.find((p) => p.dirName === '地面站');
  const printTree = (nodes, depth) => {
    for (const n of nodes) {
      console.log('  '.repeat(depth) + (n.isDir ? '📁 ' : '📝 ') + n.name);
      if (n.children) { printTree(n.children, depth + 1); }
    }
  };
  printTree(store.getTree(gcs.id), 0);

  console.log('\n═══ 写操作验证 ═══');
  store.setStatus(gcs.id, 'paused');
  await store.refresh();
  const after = store.projects.find((p) => p.dirName === '地面站');
  console.log(`setStatus(paused) 后 status = ${after.status}（应回写 frontmatter）`);
  store.setStatus(gcs.id, 'doing'); // 还原

  const inserted = store.insertWorkspaceTemplate(gcs.id);
  const insertedTwice = store.insertWorkspaceTemplate(gcs.id);
  await store.refresh();
  const ws = store.projects.find((p) => p.dirName === '地面站');
  console.log(`README 已含 workspace 时插入返回 ${inserted}（应为 false，防重复）`);
  console.log(`连续插入两次返回 ${insertedTwice}（应为 false）`);
  console.log(`workspace 项数 = ${ws.workspace.length}（应为 3，不被重复键破坏）`);

  // 进度统计交叉验证：主分支.md 实际复选框计数
  const fs = require('fs');
  const raw = fs.readFileSync(path.join(gcs.id, '主分支.md'), 'utf8');
  const total = (raw.match(/^[-*]\s+\[[ xX-]\]/gm) || []).length;
  console.log(`\n主分支.md 复选框总数（grep 口径）= ${total}，看板聚合应 ≥ 此值`);
  console.log(`看板聚合 待办+完成+搁置 = ${ws.todo + ws.done + ws.shelved}`);

  console.log('\n═══ 白名单机制验证 ═══');
  const cfgPath = path.join(FIXTURE, '.projectboard.json');
  const origCfg = fs.readFileSync(cfgPath, 'utf8');
  const cfgObj = JSON.parse(origCfg);

  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfgObj, projectDirs: [] }, null, 2));
  await store.refresh();
  console.log(`projectDirs 为空时项目数 = ${store.projects.length}（应为 0）`);

  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfgObj, projectDirs: ['数据大屏'] }, null, 2));
  await store.refresh();
  console.log(`只列「数据大屏」时项目数 = ${store.projects.length}（应为 1）: ${store.projects.map((p) => p.dirName).join('、')}`);

  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfgObj, projectDirs: ['不存在的目录'] }, null, 2));
  await store.refresh();
  console.log(`目录不存在时项目数 = ${store.projects.length}（应为 0，不报错）`);

  fs.writeFileSync(cfgPath, origCfg);
  await store.refresh();
  console.log(`还原配置后项目数 = ${store.projects.length}（应为 2）`);

  console.log('\n✓ 冒烟测试完成');
})().catch((e) => { console.error('✗ 测试失败:', e); process.exit(1); });
