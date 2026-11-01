// 토스트의 기본·사용자 지정 이미지와 비활성화·잘못된 경로의 대체 동작을 결정한다.
import { statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';

export function toastImagePath(extensionPath: string, enabled: boolean, configuredPath = '', workspacePath?: string,
  invalid?: (message: string) => void): string | undefined {
  if (!enabled) return undefined;
  const defaultPath = join(extensionPath, 'resources', 'icon', 'toast-default.png');
  const customPath = configuredPath.trim();
  if (!customPath) return defaultPath;
  try {
    if (!isAbsolute(customPath) && !workspacePath) throw new Error('Relative image paths require an open workspace');
    const path = isAbsolute(customPath) ? customPath : resolve(workspacePath!, customPath);
    if (!/\.(png|jpe?g|gif|bmp)$/i.test(extname(path)) || !statSync(path).isFile()) throw new Error('Select a local PNG, JPEG, GIF or BMP image');
    return path;
  } catch (error) {
    invalid?.(`Toast image unavailable; using default image: ${String(error)}`);
    return defaultPath;
  }
}
