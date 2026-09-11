/**
 * 路径工具：处理 WSL 远程环境与 Windows 宿主之间的路径互转。
 * 笔记在 WSL 时扩展宿主运行在 Linux，但 code/lnk 等路径可能是 Windows 格式。
 */

/** 当前扩展宿主是否运行在 WSL 中 */
export const isWsl =
  process.platform === 'linux' &&
  !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

/** 是否为 Windows 风格路径，如 D:\Dev\x 或 D:/Dev/x */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * 转换为可供 Node fs 读写的路径。
 * WSL 中读取 Windows 路径时转为 /mnt/<盘符>/... ；其余情况原样返回。
 */
export function toFsPath(p: string): string {
  if (!p) { return p; }
  if (isWsl && isWindowsPath(p)) {
    const drive = p[0].toLowerCase();
    const rest = p.slice(2).replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
  }
  return p;
}

/**
 * 转换为 Windows 路径（供 explorer.exe / cmd.exe 等 Windows 程序使用）。
 * WSL 中把 /mnt/d/x 转回 D:\x ；其余情况原样返回。
 */
export function toWinPath(p: string): string {
  if (!p) { return p; }
  if (isWsl) {
    const m = p.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (m) {
      return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
    }
  }
  return p;
}
