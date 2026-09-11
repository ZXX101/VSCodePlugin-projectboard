/**
 * 一键部署：编译（production）→ 覆盖安装到本机所有 VS Code 扩展目录。
 * 覆盖 Windows 宿主（~/.vscode/extensions）与 WSL 远程宿主（~/.vscode-server/extensions）。
 * 部署后在 VS Code 中执行「Developer: Reload Window」即生效。
 *
 * 运行：npm run deploy
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const EXT_ID = `${pkg.publisher}.${pkg.name}-${pkg.version}`;
// 部署内容：gray-matter 已打包进 dist，无需 node_modules
const INCLUDE = ['package.json', 'dist', 'media', 'README.md'];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function deployTo(extensionsDir) {
  const target = path.join(extensionsDir, EXT_ID);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const item of INCLUDE) {
    copyRecursive(path.join(ROOT, item), path.join(target, item));
  }
  return target;
}

console.log(`[1/3] 编译 ${pkg.name}@${pkg.version}（production）…`);
execSync('node esbuild.js --production', { cwd: ROOT, stdio: 'inherit' });

console.log('[2/3] 查找 VS Code 扩展目录…');
const targets = [];

// Windows 宿主
const winExt = path.join(os.homedir(), '.vscode', 'extensions');
if (fs.existsSync(winExt)) { targets.push(winExt); }

// WSL 远程宿主：UNC 根目录（\\wsl$\）无法枚举，改用 wsl -l -q 拿发行版列表后逐个探测
try {
  const out = execSync('wsl -l -q', { encoding: 'ucs2' });
  const distros = out.split('\n').map((s) => s.replace(/\0|\r/g, '').trim()).filter(Boolean);
  for (const distro of distros) {
    const wslExt = `\\\\wsl$\\${distro}\\home\\pc\\.vscode-server\\extensions`;
    if (fs.existsSync(wslExt)) { targets.push(wslExt); }
  }
} catch { /* 无 WSL 或无权限时跳过 */ }

if (!targets.length) {
  console.error('未找到任何 VS Code 扩展目录');
  process.exit(1);
}

console.log('[3/3] 部署中…');
for (const dir of targets) {
  const dest = deployTo(dir);
  console.log(`  ✓ ${dest}`);
}
console.log('\n部署完成。在 VS Code 中按 Ctrl+Shift+P →「Developer: Reload Window」生效。');
