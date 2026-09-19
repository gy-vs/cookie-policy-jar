/**
 * 表驱动测试：域名规范化、末尾点、IP 字面量、域匹配与公共后缀。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeDomain,
  canonicalizeRequestHost,
  domainMatch,
  isIPv4Literal,
  isIPLiteral,
} from '../src/domain.js';
import { isPublicSuffix, registrableDomain } from '../src/public-suffix.js';

test('canonicalizeDomain table', () => {
  const cases: Array<[string, string | null]> = [
    ['example.com', 'example.com'],
    // ASCII 小写
    ['EXAMPLE.COM', 'example.com'],
    ['ExAmPle.CoM', 'example.com'],
    // 末尾根点规范化掉
    ['example.com.', 'example.com'],
    ['example.com..', null],
    // 前导通号点不属于 Domain 属性的合法写法
    ['.example.com', null],
    // 标签非法
    ['-bad.com', null],
    ['bad-.com', null],
    ['exa_mple.com', null],
    ['.', null],
    ['', null],
    // 标签过长
    [`${'a'.repeat(64)}.com`, null],
    [`${'a'.repeat(63)}.com`, `${'a'.repeat(63)}.com`],
    // IP 字面量不能作为 Domain 属性
    ['1.2.3.4', null],
    ['127.0.0.1', null],
    ['999.999.999.999', null], // 也不是合法域名标签
    // IDN：转为 punycode（中文示例）
    ['例え.jp', 'xn--r8jz45g.jp'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(
      canonicalizeDomain(input),
      expected,
      `canonicalizeDomain(${JSON.stringify(input)})`,
    );
  }
});

test('canonicalizeRequestHost table', () => {
  const cases: Array<[string, string | null]> = [
    ['example.com', 'example.com'],
    ['Example.COM.', 'example.com'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['127.0.0.1', '127.0.0.1'],
    // 请求主机允许下划线
    ['my_host.local', 'my_host.local'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(
      canonicalizeRequestHost(input),
      expected,
      `canonicalizeRequestHost(${JSON.stringify(input)})`,
    );
  }
});

test('domainMatch table', () => {
  const cases: Array<[string, string, boolean]> = [
    ['example.com', 'example.com', true],
    ['www.example.com', 'example.com', true],
    ['a.b.example.com', 'example.com', true],
    ['notexample.com', 'example.com', false],
    // 前缀但标签边界不完整：example.com 不匹配 xexample.com
    ['xexample.com', 'example.com', false],
    ['example.com.org', 'example.com', false],
  ];
  for (const [host, domain, expected] of cases) {
    assert.equal(domainMatch(host, domain), expected, `${host} ~ ${domain}`);
  }
});

test('IP literal classifiers', () => {
  assert.equal(isIPv4Literal('1.2.3.4'), true);
  assert.equal(isIPv4Literal('255.255.255.255'), true);
  assert.equal(isIPv4Literal('256.1.1.1'), false);
  assert.equal(isIPLiteral('2001:db8::1'), true);
  assert.equal(isIPLiteral('example.com'), false);
});

test('public suffix table', () => {
  const suffixCases: Array<[string, boolean]> = [
    ['com', true],
    ['org', true],
    ['co.uk', true],
    ['example.com', false],
    ['www.example.com', false],
    // 通配规则 *.ck
    ['ck', false],
    ['abc.ck', true],
    ['x.abc.ck', false],
    // 例外规则 !www.ck
    ['www.ck', false],
    // IP 不是公共后缀
    ['1.2.3.4', false],
  ];
  for (const [domain, expected] of suffixCases) {
    assert.equal(isPublicSuffix(domain), expected, `isPublicSuffix(${domain})`);
  }

  const regCases: Array<[string, string]> = [
    ['example.com', 'example.com'],
    ['www.example.com', 'example.com'],
    ['a.b.example.com', 'example.com'],
    ['example.co.uk', 'example.co.uk'],
    ['x.example.co.uk', 'example.co.uk'],
    ['abc.ck', 'abc.ck'], // 通配下 abc.ck 是后缀本身，不可注册
    ['x.abc.ck', 'x.abc.ck'],
    ['www.ck', 'www.ck'],
    ['localhost', 'localhost'],
    ['1.2.3.4', '1.2.3.4'],
  ];
  for (const [domain, expected] of regCases) {
    assert.equal(registrableDomain(domain), expected, `registrableDomain(${domain})`);
  }
});
