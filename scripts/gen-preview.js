/**
 * 生成看板前端预览页：用真实数据 + 打桩 acquireVsCodeApi，
 * 使 media/board.js 可以脱离扩展宿主在纯浏览器里运行，用于 UI 验证。
 * 运行：node scripts/gen-preview.js  →  test-fixtures/webview-preview.html
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const stub = {
  EventEmitter: class {
    constructor() { this.listeners = []; }
    get event() { return (f) => this.listeners.push(f); }
    fire(d) { this.listeners.forEach((f) => f(d)); }
  },
  window: {},
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
  const gcs = store.projects.find((p) => p.dirName === '地面站');
  // 用长文档 主分支.md 作为切换目标，同时验证滚动
  const secondPath = path.join(gcs.id, '主分支.md');
  const data = {
    projects: store.projects,
    config: store.config,
    activeId: gcs.id,
    tree: store.getTree(gcs.id),
    docPath: path.join(gcs.id, 'README.md'),
    docContent: store.readDoc(path.join(gcs.id, 'README.md')),
    secondDocPath: secondPath,
    secondDocContent: store.readDoc(secondPath),
  };

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="../media/vditor/dist/index.css">
<link rel="stylesheet" href="../media/board.css">
<title>看板 UI 预览（打桩数据）</title>
</head>
<body>
<div id="app">
  <div class="toolbar">
    <div class="tb-title">▦ 项目看板</div>
    <input id="search" class="search" placeholder="搜索项目名 / 标签 / 焦点…" />
    <select id="filterStatus" class="dropdown">
      <option value="">状态: 全部</option>
      <option value="doing">进行中</option>
      <option value="paused">暂停</option>
      <option value="blocked">卡住</option>
      <option value="done">完结</option>
      <option value="stale">疑似搁置</option>
    </select>
    <select id="filterType" class="dropdown"><option value="">类型: 全部</option></select>
    <button id="btnRefresh" class="icon-btn" title="刷新">⟳</button>
    <div class="grow"></div>
    <button id="btnNew" class="primary-btn">＋ 新建项目</button>
  </div>
  <div class="columns">
    <div class="col-cards">
      <div class="col-header">项目卡片 <span class="count" id="cardCount">0</span></div>
      <div class="card-list" id="cardList"></div>
    </div>
    <div class="col-files">
      <div class="col-header" id="treeHeader">文档</div>
      <div class="tree" id="tree"></div>
    </div>
    <div class="col-doc">
      <div class="doc-header">
        <span id="docPath" class="doc-path">未选择文档</span>
        <span id="saveState" class="save-state"></span>
        <button id="btnOpenExternal" class="icon-btn" title="在编辑器中打开">↗</button>
      </div>
      <div id="editor"></div>
      <div id="editorEmpty" class="editor-empty">点击左侧文档树中的文件开始预览与编辑</div>
    </div>
  </div>
</div>
<div id="ctxMenu" class="ctx-menu"></div>
<script>
  window.VDITOR_CDN = '../media/vditor';
  window.__DATA__ = ${JSON.stringify(data).replace(/<\//g, '<\\/')};
  // 回归测试：3 秒后自动切换到第二篇文档，验证切换渲染（bug: 切换后空白）
  window.__AUTO_SWITCH__ = ${JSON.stringify({ delayMs: 3000 })};
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) {
        var D = window.__DATA__;
        var respond = function (data) {
          window.dispatchEvent(new MessageEvent('message', { data: data }));
        };
        setTimeout(function () {
          if (msg.type === 'ready') {
            respond({ type: 'state', projects: D.projects, config: D.config, activeId: D.activeId });
            respond({ type: 'tree', id: D.activeId, nodes: D.tree });
            respond({ type: 'doc', path: D.docPath, content: D.docContent });
          } else if (msg.type === 'selectProject') {
            respond({ type: 'tree', id: msg.id, nodes: D.tree });
            respond({ type: 'doc', path: D.docPath, content: D.docContent });
          } else if (msg.type === 'openDoc') {
            respond({ type: 'doc', path: msg.path, content: D.docContent });
          } else if (msg.type === 'saveDoc') {
            respond({ type: 'saved', path: msg.path, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          }
        }, 50);
      },
    };
  };
  // 模拟宿主在 3 秒后推送另一篇文档（等价于用户点击文档树切换）
  window.addEventListener('load', function () {
    setTimeout(function () {
      var D = window.__DATA__;
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'doc', path: D.secondDocPath, content: D.secondDocContent },
      }));
    }, window.__AUTO_SWITCH__.delayMs);
    // 调试：4.5 秒后测量布局链并实际滚动编辑区
    setTimeout(function () {
      var sels = ['#editor', '.vditor-content', '.vditor-ir', '.vditor-ir .vditor-reset', '.vditor-ir pre', '.vditor-ir [contenteditable]'];
      var dbg = document.createElement('div');
      dbg.id = 'debug';
      var parts = sels.map(function (sel) {
        var el = document.querySelector(sel);
        if (!el) { return sel + ':none'; }
        var cs = getComputedStyle(el);
        return sel + ' h=' + el.clientHeight + '/' + el.scrollHeight + ' ovY=' + cs.overflowY;
      });
      var ir = document.querySelector('.vditor-ir');
      parts.push('ir子节点数=' + (ir ? ir.children.length : '-'));
      parts.push('ir首子元素=' + (ir && ir.children[0] ? ir.children[0].tagName + '.' + ir.children[0].className : '-'));
      var reset = document.querySelector('.vditor-ir [contenteditable]') || document.querySelector('.vditor-ir .vditor-reset');
      if (reset) { reset.scrollTop = 800; parts.push('reset scrollTop=' + reset.scrollTop); }
      if (ir) { ir.scrollTop = 800; parts.push('ir scrollTop=' + ir.scrollTop); }
      dbg.textContent = 'CHAIN ' + parts.join(' | ');
      document.body.appendChild(dbg);
    }, 4500);
  });
</script>
<script src="../media/vditor/dist/index.min.js"></script>
<script src="../media/vditor/dist/js/icons/ant.js"></script>
<script src="../media/board.js"></script>
</body>
</html>`;

  const out = path.resolve(__dirname, '..', 'test-fixtures', 'webview-preview.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log('预览页已生成:', out);
})();
