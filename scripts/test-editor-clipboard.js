/** 用真实 Edge 验证剪切/粘贴（会使用本机剪贴板）。先 gen-preview，再运行本脚本。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const profile = fs.mkdtempSync(path.join(root, 'test-fixtures', 'edge-clipboard-'));
  let page = fs.readFileSync(path.join(root, 'test-fixtures/webview-preview.html'), 'utf8');
  page = page.replace('"delayMs":3000', '"delayMs":300000');
  page = page.replace('<script src="../media/board.js">', `<script>
    const OriginalVditor = window.Vditor;
    window.Vditor = class extends OriginalVditor {
      constructor(...args) { super(...args); window.testEditor = this; }
    };
    const originalAcquire = window.acquireVsCodeApi;
    window.testSaves = [];
    window.acquireVsCodeApi = function () {
      const api = originalAcquire();
      const post = api.postMessage;
      api.postMessage = function (message) {
        if (message.type === 'saveDoc') window.testSaves.push(message.content);
        post(message);
      };
      return api;
    };
  </script><script src="../media/board.js">`);
  const server = http.createServer((req, res) => {
    const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1);
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      res.setHeader('Content-Type', type + '; charset=utf-8');
      res.end(relative === 'test-fixtures/webview-preview.html' ? page : fs.readFileSync(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/test-fixtures/webview-preview.html`;
  const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless', '--disable-gpu', '--no-first-run', '--window-size=2048,1152', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, url,
  ], { windowsHide: true, stdio: 'ignore' });
  let ws;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let n = 0; !fs.existsSync(portFile) && n < 200; n++) { await delay(100); }
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    let target;
    for (let n = 0; !target && n < 100; n++) {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page');
      if (!target) { await delay(100); }
    }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        message.error ? request.reject(message.error) : request.resolve(message.result);
      }
    };
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        pending.set(requestId, { resolve, reject });
        ws.send(JSON.stringify({ id: requestId, method, params }));
      });
    }
    async function evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) { throw new Error(JSON.stringify(result.exceptionDetails)); }
      return result.result.value;
    }
    for (let n = 0; n < 200; n++) {
      if (await evaluate('!!window.testEditor && !!document.querySelector(".vditor-ir [contenteditable]")')) { break; }
      await delay(100);
    }
    await send('Page.bringToFront');
    await send('Browser.grantPermissions', { origin: new URL(url).origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await delay(1000);
    await evaluate(`window.testEditor.setValue('剪切测试内容\\n\\n- [x] 已完成任务\\n- [ ] 待办任务\\n')`);
    await delay(1000);
    // execCommand('cut') 模拟 VS Code 转发剪切命令，触发 Vditor 的真实 cut 监听器。
    const cut = await evaluate(`(() => {
      const el=document.querySelector('.vditor-ir > .vditor-reset'); el.focus();
      const text=el.querySelector('p').firstChild; const range=document.createRange();
      range.selectNodeContents(text); const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      return {ok:document.execCommand('cut'), before: text.textContent};
    })()`);
    await delay(1000);
    const afterCut = await evaluate('window.testEditor.getValue()');
    assert.equal(cut.ok, true);
    assert.equal(await evaluate('navigator.clipboard.readText()'), '剪切测试内容');
    await send('Input.dispatchKeyEvent', { type:'keyDown',key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:2 });
    await send('Input.dispatchKeyEvent', { type:'keyUp',key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:2 });
    await delay(1000);
    assert.ok((await evaluate('window.testEditor.getValue()')).includes('剪切测试内容'), '剪切后可撤销');
    await send('Input.dispatchKeyEvent', { type:'keyDown',key:'y',code:'KeyY',windowsVirtualKeyCode:89,modifiers:2 });
    await send('Input.dispatchKeyEvent', { type:'keyUp',key:'y',code:'KeyY',windowsVirtualKeyCode:89,modifiers:2 });
    await delay(1000);
    assert.equal((await evaluate('window.testEditor.getValue()')).includes('剪切测试内容'), false, '剪切后可重做');
    // 首次 Ctrl+V 后发送真实剪贴板事件，观察任务复选框是否仍为 input。
    await evaluate(`(() => {
      const el=document.querySelector('.vditor-ir > .vditor-reset');el.focus();
      const li=el.querySelector('li');const walker=document.createTreeWalker(li,NodeFilter.SHOW_TEXT);
      let text;while(walker.nextNode()){if(walker.currentNode.textContent.includes('已完成任务')){text=walker.currentNode;break;}}
      const range=document.createRange();range.setStart(text,text.length);range.collapse(true);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    })()`);
    await send('Input.dispatchKeyEvent', { type:'keyDown',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2 });
    await send('Input.dispatchKeyEvent', { type:'keyUp',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2 });
    await delay(1000);
    const pasted = await evaluate(`({value:window.testEditor.getValue(),check:document.querySelectorAll('.vditor-ir input[type=checkbox]').length})`);
    assert.equal(afterCut.includes('剪切测试内容'), false, '剪切应删除原文');
    assert.ok(pasted.value.includes('已完成任务剪切测试内容'), '第一次粘贴应插入到任务文本');
    assert.equal(pasted.check, 2, '复选框应保持渲染');
    for (const position of ['beforeCheckbox', 'afterCheckbox', 'textStart', 'replaceText']) {
      await evaluate(`window.testEditor.setValue('- [x] 已完成任务\\n- [ ] 待办任务\\n')`);
      await delay(350);
      await evaluate(`(() => {
        const el=document.querySelector('.vditor-ir > .vditor-reset');el.focus();
        const li=el.querySelector('li');const range=document.createRange();
        const position=${JSON.stringify(position)};
        if(position==='beforeCheckbox'){range.setStart(li,0);}
        else if(position==='afterCheckbox'){range.setStartAfter(li.querySelector('input'));}
        else{range.setStart(li.querySelector('input').nextSibling,0);}
        if(position==='replaceText'){range.setEnd(li.querySelector('input').nextSibling,li.querySelector('input').nextSibling.length);}
        else{range.collapse(true);}
        getSelection().removeAllRanges();getSelection().addRange(range);
      })()`);
      await send('Input.dispatchKeyEvent', { type:'keyDown',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2 });
      await send('Input.dispatchKeyEvent', { type:'keyUp',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2 });
      await delay(350);
      const result = await evaluate(`({value:window.testEditor.getValue(),check:document.querySelectorAll('.vditor-ir input[type=checkbox]').length})`);
      assert.equal(result.check, 2, `${position}: 粘贴后复选框不能退化为文本`);
      assert.ok(result.value.includes('剪切测试内容'), `${position}: 首次粘贴内容不能丢失`);
      if (position === 'replaceText') { assert.equal(result.value.includes('已完成任务'), false, '粘贴应替换选中文字'); }
    }
    await delay(1800);
    assert.equal(await evaluate('window.testSaves.at(-1)'), await evaluate('window.testEditor.getValue()'), '粘贴内容应触发自动保存');
    await evaluate(`window.testEditor.setValue('富文本粘贴测试\\n')`);
    await delay(1000);
    await evaluate(`(async () => {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob(['<b>加粗内容</b>'],{type:'text/html'}),
        'text/plain': new Blob(['加粗内容'],{type:'text/plain'})
      })]);
      const el=document.querySelector('.vditor-ir > .vditor-reset');el.focus();
      const range=document.createRange();range.selectNodeContents(el.querySelector('p'));range.collapse(false);
      getSelection().removeAllRanges();getSelection().addRange(range);
    })()`);
    await send('Input.dispatchKeyEvent', { type:'keyDown',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2 });
    await send('Input.dispatchKeyEvent', { type:'keyUp',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2 });
    await delay(1000);
    assert.ok((await evaluate('window.testEditor.getValue()')).includes('**加粗内容**'), '保留富文本转 Markdown 的原生粘贴能力');
    await send('Page.captureScreenshot', { format: 'png' }).then((result) => {
      fs.writeFileSync(path.join(root, 'test-fixtures/editor-clipboard.png'), Buffer.from(result.data, 'base64'));
    });
    console.log('✓ 剪贴板浏览器回归通过：剪切、撤销/重做、任务行首次粘贴、选区替换、自动保存、富文本');
    await send('Browser.close');
  } finally {
    ws?.close();
    edge.kill();
    await new Promise((resolve) => server.close(resolve));
    // 浏览器进程退出前不删除用户数据目录；本次目录仅位于被忽略的 test-fixtures 中。
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
