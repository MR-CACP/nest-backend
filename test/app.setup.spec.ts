import { readPkgVersion } from '../src/app.setup';

describe('readPkgVersion', () => {
  it('正常读取版本号', () => {
    expect(readPkgVersion(() => ({ version: '1.2.3' }))).toBe('1.2.3');
  });

  it('version 字段缺失时回退 0.0.0', () => {
    expect(readPkgVersion(() => ({}))).toBe('0.0.0');
  });

  it('读取抛错（部署制品缺少 package.json）时回退 0.0.0', () => {
    expect(
      readPkgVersion(() => {
        throw new Error('MODULE_NOT_FOUND');
      }),
    ).toBe('0.0.0');
  });
});
