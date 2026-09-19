/**
 * 表驱动测试：默认路径、路径匹配、站点键与安全方法。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultPath,
  isSafeMethod,
  isSecureScheme,
  pathMatch,
  siteKey,
} from '../src/path.js';

test('defaultPath table', () => {
  const cases: Array<[string, string]> = [
    ['http://example.com/', '/'],
    ['http://example.com', '/'],
    ['http://example.com/index.html', '/'],
    ['http://example.com/a/b/c', '/a/b'],
    ['http://example.com/a/b/', '/a/b'],
    ['http://example.com/a', '/'],
    ['http://example.com/a/', '/a'],
  ];
  for (const [url, expected] of cases) {
    assert.equal(defaultPath(new URL(url)), expected, url);
  }
});

test('pathMatch table', () => {
  const cases: Array<[string, string, boolean]> = [
    ['/', '/', true],
    ['/a', '/a', true],
    ['/a/', '/a/', true],
    ['/a/b', '/a', true], // cookie-path 不以 / 结尾，下一个字符是 '/'
    ['/a/', '/a', true],
    ['/ab', '/a', false], // 下一个字符是 'b'
    ['/abc', '/a', false],
    ['/b', '/a', false],
    ['/a/b/c', '/a/b', true],
  ];
  for (const [requestPath, cookiePath, expected] of cases) {
    assert.equal(pathMatch(requestPath, cookiePath), expected, `${requestPath} ~ ${cookiePath}`);
  }
});

test('siteKey table', () => {
  const cases: Array<[string, string]> = [
    ['https://www.example.com/a', 'https://example.com'],
    ['http://www.example.com/a', 'http://example.com'], // scheme 参与
    ['https://sub.example.co.uk/', 'https://example.co.uk'],
    ['https://localhost/', 'https://localhost'],
    ['https://1.2.3.4/path', 'https://1.2.3.4'],
    ['https://[2001:db8::1]/', 'https://2001:db8::1'],
    ['https://x.abc.ck/', 'https://x.abc.ck'],
  ];
  for (const [url, expected] of cases) {
    assert.equal(siteKey(new URL(url)), expected, url);
  }
});

test('scheme and method predicates', () => {
  assert.equal(isSecureScheme('https:'), true);
  assert.equal(isSecureScheme('wss:'), true);
  assert.equal(isSecureScheme('http:'), false);
  assert.equal(isSafeMethod('GET'), true);
  assert.equal(isSafeMethod('head'), true);
  assert.equal(isSafeMethod('POST'), false);
});
