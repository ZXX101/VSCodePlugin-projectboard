/* 项目看板 · 前端逻辑（原生 JS，与扩展宿主通过 postMessage 通信） */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  // ── 全局状态 ──
  let projects = [];
  let activeId = '';
  let treeNodes = [];
  let currentDocPath = '';
  let vditor = null;
  let saveTimer = null;
  let loadingDoc = false;   // 文档装载期间屏蔽 input 事件
  let docDirty = false;     // Vditor 中有未保存的编辑（防外部重载覆盖）
  let lastDocContent = '';  // 当前文档已知内容（内容未变时不重载，避免打断光标）
  let searchText = '';
  let filterStatus = '';
  let filterType = '';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const STATUS_TEXT = { doing: '进行中', paused: '暂停', blocked: '卡住', done: '完结' };

  // ── 卡片列表 ──
  function renderCards() {
    const list = $('cardList');
    const kw = searchText.trim().toLowerCase();
    const shown = projects.filter((p) => {
      if (filterStatus === 'stale' && !p.stale) { return false; }
      if (filterStatus && filterStatus !== 'stale' && p.status !== filterStatus) { return false; }
      if (filterType && p.type !== filterType) { return false; }
      if (kw) {
        const hay = (p.name + ' ' + p.dirName + ' ' + p.focus + ' ' + (p.tags || []).join(' ')).toLowerCase();
        if (!hay.includes(kw)) { return false; }
      }
      return true;
    });
    $('cardCount').textContent = String(shown.length);
    list.innerHTML = '';
    if (!shown.length) {
      list.innerHTML = '<div class="cards-empty">没有匹配的项目<br>点击右上角「新建项目」开始</div>';
      return;
    }
    for (const p of shown) {
      const el = document.createElement('div');
      el.className = 'card' + (p.stale ? ' dimmed' : '') + (p.id === activeId ? ' selected' : '');
      el.dataset.id = p.id;

      const dotCls = p.stale ? 'stale' : p.status;
      const statusText = p.stale
        ? '疑似搁置 · ' + daysAgo(p.updated) + ' 未更新'
        : (STATUS_TEXT[p.status] || p.status) + ' · 更新于 ' + fmtDate(p.updated);
      const branchTag = p.branch ? '<div class="tag branch">⎇ ' + esc(p.branch) + '</div>' : '';
      const metaBits = [];
      if (p.todo) { metaBits.push('待办 ' + p.todo); }
      if (p.problems) { metaBits.push('问题 ' + p.problems); }

      el.innerHTML =
        '<div class="card-top">' +
          '<div class="card-name" title="' + esc(p.name) + '">' + esc(p.name) + '</div>' +
          branchTag +
          '<div class="tag type ' + esc(p.type) + '">' + esc(p.type) + '</div>' +
        '</div>' +
        '<div class="status-line"><span class="dot ' + dotCls + '"></span>' + esc(statusText) + '</div>' +
        (p.focus ? '<div class="focus-line" title="' + esc(p.focus) + '"><b>焦点</b> ' + esc(p.focus) + '</div>' : '') +
        '<div class="progress"><div style="width:' + p.progress + '%"></div></div>' +
        '<div class="card-meta"><span>' + esc(metaBits.join(' · ') || '暂无待办') + '</span><span>' + p.progress + '%</span></div>' +
        '<div class="card-actions">' +
          '<div class="chip' + (p.code ? '' : ' disabled') + '" data-action="code" title="左键：VS Code 打开代码目录｜右键：文件管理器打开">📂 代码</div>' +
          '<div class="chip" data-action="workspace" title="左键：启动工作区｜右键：编辑工作区配置">🚀 启动工作区</div>' +
          '<div class="chip' + (p.repo ? '' : ' disabled') + '" data-action="repo" title="左键：浏览器打开仓库｜右键：复制地址">🔗 Repo</div>' +
        '</div>';

      el.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (chip) {
          e.stopPropagation();
          if (chip.classList.contains('disabled')) { return; }
          vscode.postMessage({ type: 'action', id: p.id, action: chip.dataset.action });
          return;
        }
        selectProject(p.id);
      });
      // 按钮右键 = 备用动作
      el.addEventListener('contextmenu', (e) => {
        const chip = e.target.closest('.chip');
        if (chip) {
          e.preventDefault();
          e.stopPropagation();
          if (chip.classList.contains('disabled')) { return; }
          const alt = { code: 'codeExplorer', repo: 'repoCopy', workspace: 'workspaceEdit' }[chip.dataset.action];
          if (alt) { vscode.postMessage({ type: 'action', id: p.id, action: alt }); }
          return;
        }
        e.preventDefault();
        showCtxMenu(e.clientX, e.clientY, p);
      });
      list.appendChild(el);
    }
    renderCardsMini(shown);
  }

  /** 取名称的首个汉字或字母（用于收起态缩略徽章） */
  function firstChar(name) {
    const m = String(name || '').match(/[A-Za-z0-9一-鿿]/);
    return m ? m[0].toUpperCase() : '?';
  }

  /** 收起态：卡片栏的项目首字徽章列表 */
  function renderCardsMini(shown) {
    const mini = $('cardsMini');
    mini.innerHTML = '';
    for (const p of shown) {
      const el = document.createElement('div');
      el.className = 'mini-item' + (p.id === activeId ? ' sel' : '');
      el.title = p.name;
      const dotCls = p.stale ? 'stale' : p.status;
      el.innerHTML = esc(firstChar(p.name)) + '<span class="mini-dot dot ' + dotCls + '"></span>';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        selectProject(p.id);
      });
      mini.appendChild(el);
    }
  }

  // ── 卡片右键菜单（修改状态） ──
  const ctxMenu = $('ctxMenu');
  function showCtxMenu(x, y, p) {
    const items = [
      ['doing', '● 标记为 进行中'],
      ['paused', '● 标记为 暂停'],
      ['blocked', '● 标记为 卡住'],
      ['done', '● 标记为 完结'],
    ];
    ctxMenu.innerHTML = '';
    for (const [status, label] of items) {
      const item = document.createElement('div');
      item.className = 'ctx-item';
      item.textContent = label + (p.status === status && !p.stale ? ' ✓' : '');
      item.addEventListener('click', () => {
        hideCtxMenu();
        vscode.postMessage({ type: 'setStatus', id: p.id, status });
      });
      ctxMenu.appendChild(item);
    }
    ctxMenu.style.display = 'block';
    const rect = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
    ctxMenu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  }
  function hideCtxMenu() { ctxMenu.style.display = 'none'; }
  document.addEventListener('click', (e) => { if (!ctxMenu.contains(e.target)) { hideCtxMenu(); } });

  // ── 文档树 ──
  function renderTree() {
    const tree = $('tree');
    tree.innerHTML = '';
    if (!treeNodes.length) {
      tree.innerHTML = '<div class="tree-empty">选择左侧项目卡片查看文档</div>';
      renderFilesMini();
      return;
    }
    const frag = document.createDocumentFragment();
    appendNodes(frag, treeNodes, 0);
    tree.appendChild(frag);
    renderFilesMini();
  }

  /** 收起态：文档树首字徽章列表（子目录内容统一显示所属根目录文件夹首字） */
  function renderFilesMini() {
    const mini = $('filesMini');
    mini.innerHTML = '';
    const walk = (nodes, rootName) => {
      for (const node of nodes) {
        const isRoot = !rootName;
        const charName = isRoot ? node.name : rootName;
        const el = document.createElement('div');
        el.className = 'mini-item' + (node.isDir ? ' folder-mini' : '');
        el.title = node.path.split(/[\\/]/).pop();
        el.textContent = firstChar(charName);
        mini.appendChild(el);
        if (node.isDir && node.children) { walk(node.children, isRoot ? node.name : rootName); }
      }
    };
    walk(treeNodes, null);
  }

  function appendNodes(parent, nodes, depth) {
    for (const node of nodes) {
      const el = document.createElement('div');
      el.className = 'tree-item' + (node.isDir ? ' folder' : '') + (node.path === currentDocPath ? ' active' : '');
      el.style.paddingLeft = (8 + depth * 20) + 'px';
      el.title = node.path;
      el.innerHTML = node.isDir
        ? '<span class="arrow">▾</span><span class="fi">📁</span><span class="fname">' + esc(node.name) + '</span>'
        : '<span class="fi">📝</span><span class="fname">' + esc(node.name) + '</span>';
      if (node.isDir) {
        // 默认全部展开；点击文件夹名折叠/展开其子节点
        const childBox = document.createElement('div');
        parent.appendChild(el);
        parent.appendChild(childBox);
        appendNodes(childBox, node.children || [], depth + 1);
        el.addEventListener('click', () => {
          const collapsed = childBox.style.display === 'none';
          childBox.style.display = collapsed ? '' : 'none';
          el.querySelector('.arrow').textContent = collapsed ? '▾' : '▸';
        });
      } else {
        parent.appendChild(el);
        el.addEventListener('click', () => vscode.postMessage({ type: 'openDoc', path: node.path }));
        el.addEventListener('dblclick', () => vscode.postMessage({ type: 'editDoc', path: node.path }));
      }
    }
  }

  // ── Vditor 编辑器 ──
  function loadDoc(filePath, content) {
    currentDocPath = filePath;
    lastDocContent = content;
    docDirty = false;
    renderTree(); // 刷新高亮
    $('docPath').textContent = filePath;
    $('saveState').textContent = '';
    $('editorEmpty').style.display = 'none';
    // 注意：不要给 #editor 写内联 display——它会压过 .vditor 的 flex 布局导致内容层无法滚动

    const container = $('editor');
    try {
      if (!vditor) {
        vditor = createVditor(container, content);
      } else {
        // 复用实例，仅替换内容；destroy+重建会导致二次渲染空白
        loadingDoc = true;
        vditor.setValue(content);
        setTimeout(() => { loadingDoc = false; }, 200);
      }
    } catch (e) {
      // 实例状态异常：销毁后重建一次；仍失败则纯文本兜底（只读也比空白强）
      try { if (vditor && vditor.destroy) { vditor.destroy(); } } catch (_) { /* 忽略 */ }
      container.innerHTML = '';
      vditor = null;
      try {
        vditor = createVditor(container, content);
      } catch (e2) {
        const pre = document.createElement('pre');
        pre.style.cssText = 'padding:16px;white-space:pre-wrap;overflow:auto;height:100%;font-size:13px;';
        pre.textContent = content;
        container.innerHTML = '';
        container.appendChild(pre);
        loadingDoc = false;
      }
    }
  }

  function createVditor(container, content) {
    loadingDoc = true;
    return new Vditor(container, {
      mode: 'ir',
      theme: 'dark',
      cdn: window.VDITOR_CDN,
      lang: 'zh_CN',
      value: content,
      cache: { enable: false },
      height: '100%',
      toolbar: [
        'headings', 'bold', 'italic', 'strike', '|',
        'list', 'ordered-list', 'check', 'quote', '|',
        'code', 'inline-code', 'link', 'table', '|',
        'undo', 'redo', '|', 'edit-mode',
      ],
      toolbarConfig: { pin: true },
      preview: {
        theme: { current: 'dark' },
        hljs: { style: 'github-dark' },
      },
      after: () => { loadingDoc = false; },
      input: () => {
        if (loadingDoc) { return; }
        docDirty = true;
        $('saveState').textContent = '编辑中…';
        if (saveTimer) { clearTimeout(saveTimer); }
        saveTimer = setTimeout(() => {
          vscode.postMessage({ type: 'saveDoc', path: currentDocPath, content: vditor.getValue() });
        }, 800);
      },
    });
  }

  // 编辑视图中的外部链接交给系统浏览器打开
  document.addEventListener('click', (e) => {
    const a = e.target.closest('#editor a[href^="http"]');
    if (a) {
      e.preventDefault();
      vscode.postMessage({ type: 'openUrl', url: a.href });
    }
  });

  // ── 选中项目 ──
  function selectProject(id) {
    activeId = id;
    renderCards();
    const p = projects.find((x) => x.id === id);
    $('treeTitle').textContent = (p ? p.name : '') + ' · 文档';
    vscode.postMessage({ type: 'selectProject', id });
  }

  // ── 栏目展开/收起（状态持久化到 webview state） ──
  const HOVER_OPEN_DELAY = 400; // 收起态下悬停超过该阈值自动展开（ms）

  function setupColToggle(colId, btnId, stateKey) {
    const col = $(colId);
    const btn = $(btnId);
    const apply = (collapsed) => {
      col.classList.toggle('collapsed', collapsed);
      btn.textContent = collapsed ? '»' : '«';
      btn.title = collapsed ? '展开' : '收起';
    };
    const persisted = (vscode.getState() || {})[stateKey];
    apply(!!persisted);
    const toggle = () => {
      const collapsed = !col.classList.contains('collapsed');
      apply(collapsed);
      col.classList.remove('hover-open');
      vscode.setState(Object.assign({}, vscode.getState(), { [stateKey]: collapsed }));
    };
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    // 收起态下点击窄条空白处也可展开
    col.addEventListener('click', () => { if (col.classList.contains('collapsed') && !col.classList.contains('hover-open')) { toggle(); } });
    // 悬停意图：仅收起态生效，超过阈值自动展开，移开自动收回（不改变持久化的收起状态）
    let hoverTimer = null;
    col.addEventListener('mouseenter', () => {
      if (!col.classList.contains('collapsed')) { return; }
      hoverTimer = setTimeout(() => col.classList.add('hover-open'), HOVER_OPEN_DELAY);
    });
    col.addEventListener('mouseleave', () => {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      col.classList.remove('hover-open');
    });
  }
  setupColToggle('colCards', 'toggleCards', 'cardsCollapsed');
  setupColToggle('colFiles', 'toggleFiles', 'filesCollapsed');

  // ── 工具栏 ──
  $('search').addEventListener('input', (e) => { searchText = e.target.value; renderCards(); });
  $('filterStatus').addEventListener('change', (e) => { filterStatus = e.target.value; renderCards(); });
  $('filterType').addEventListener('change', (e) => { filterType = e.target.value; renderCards(); });
  $('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('btnNew').addEventListener('click', () => vscode.postMessage({ type: 'newProject' }));
  $('btnOpenExternal').addEventListener('click', () => {
    if (currentDocPath) { vscode.postMessage({ type: 'editDoc', path: currentDocPath }); }
  });

  // ── 消息处理 ──
  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'state': {
        projects = msg.projects || [];
        if (msg.activeId) { activeId = msg.activeId; }
        if (activeId && !projects.some((p) => p.id === activeId)) { activeId = ''; }
        // 类型筛选下拉从现有项目自动收集
        const typeSel = $('filterType');
        const types = [...new Set(projects.map((p) => p.type))];
        const cur = typeSel.value;
        typeSel.innerHTML = '<option value="">类型: 全部</option>' +
          types.map((t) => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join('');
        typeSel.value = types.includes(cur) ? cur : '';
        renderCards();
        break;
      }
      case 'tree':
        if (msg.id === activeId) {
          treeNodes = msg.nodes || [];
          renderTree();
        }
        break;
      case 'doc':
        // 正在编辑时不被外部重载覆盖；内容未变化时不重载（避免打断光标）
        if (msg.path === currentDocPath && (docDirty || msg.content === lastDocContent)) { break; }
        loadDoc(msg.path, msg.content);
        break;
      case 'saved':
        if (msg.path === currentDocPath) {
          docDirty = false;
          if (vditor) { lastDocContent = vditor.getValue(); }
          $('saveState').textContent = '已保存 ' + msg.time;
        }
        break;
    }
  });

  // ── 工具函数 ──
  function fmtDate(ts) {
    if (!ts) { return '-'; }
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function daysAgo(ts) {
    if (!ts) { return ''; }
    const days = Math.floor((Date.now() - ts) / 86400000);
    return days <= 0 ? '今天' : days + ' 天';
  }

  // 启动
  $('editorEmpty').style.display = 'flex';
  vscode.postMessage({ type: 'ready' });
})();
