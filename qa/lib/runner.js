'use strict';

// 极简测试运行器：登记用例、执行、收集结果、汇总打印。
// 每条用例自己带 reproCommand，失败时直接贴出来，方便一条命令复现。

const PASS = 'pass';
const FAIL = 'fail';
const SKIP = 'skip';

class Runner {
  constructor(title) {
    this.title = title || 'HomeBox P1 QA';
    this.cases = [];
    this.results = [];
    this.currentSection = '';
    this.findings = [];
  }

  /**
   * 记录一条「不算失败但必须让人知道」的观察（行为变更 / 风险 / 改进建议）。
   * @param {string} id 编号
   * @param {string} title 一句话结论
   * @param {string} detail 细节
   * @param {'info'|'warn'|'risk'} [severity] 级别
   */
  finding(id, title, detail, severity) {
    this.findings.push({ id, title, detail, severity: severity || 'info' });
    console.log('  [NOTE] ' + id + ' ' + title);
  }

  /**
   * 声明一个分组。
   * @param {string} name 分组名
   */
  section(name) {
    this.currentSection = name;
  }

  /**
   * 登记用例（同步或异步）。
   * @param {string} id 如 A1
   * @param {string} name 用例名
   * @param {Function} fn 用例体，可返回 Promise；抛错即失败
   * @param {object} [opts] 选项
   * @param {string} [opts.repro] 复现说明
   * @param {boolean} [opts.skip] 跳过
   * @param {string} [opts.skipReason] 跳过原因
   */
  test(id, name, fn, opts) {
    const cfg = opts || {};
    this.cases.push({
      id,
      name,
      fn,
      section: this.currentSection,
      repro: cfg.repro || '',
      skip: !!cfg.skip,
      skipReason: cfg.skipReason || ''
    });
  }

  async run() {
    const startedAt = Date.now();
    for (const c of this.cases) {
      const record = {
        id: c.id,
        name: c.name,
        section: c.section,
        repro: c.repro,
        status: PASS,
        error: null,
        detail: null,
        durationMs: 0
      };
      if (c.skip) {
        record.status = SKIP;
        record.detail = c.skipReason || '跳过';
        this.results.push(record);
        console.log('  [SKIP] ' + c.id + ' ' + c.name + (record.detail ? '  —— ' + record.detail : ''));
        continue;
      }
      const t0 = Date.now();
      try {
        await c.fn();
        record.durationMs = Date.now() - t0;
        console.log('  [PASS] ' + c.id + ' ' + c.name + '  (' + record.durationMs + 'ms)');
      } catch (err) {
        record.durationMs = Date.now() - t0;
        record.status = FAIL;
        record.error = err && err.message ? err.message : String(err);
        if (err && err.evidence) record.evidence = err.evidence;
        console.log('  [FAIL] ' + c.id + ' ' + c.name + '  (' + record.durationMs + 'ms)');
        console.log('         ' + record.error.split('\n').join('\n         '));
      }
      this.results.push(record);
    }
    this.totalMs = Date.now() - startedAt;
    return this.summary();
  }

  summary() {
    const counts = { total: this.results.length, pass: 0, fail: 0, skip: 0 };
    for (const r of this.results) {
      if (r.status === PASS) counts.pass += 1;
      else if (r.status === FAIL) counts.fail += 1;
      else counts.skip += 1;
    }
    return { counts, results: this.results, findings: this.findings, totalMs: this.totalMs };
  }
}

/**
 * 断言失败时抛出的错误（带证据字段，报告里能贴出来）。
 */
class AssertionError extends Error {
  constructor(message, evidence) {
    super(message);
    this.name = 'AssertionError';
    if (evidence) this.evidence = evidence;
  }
}

const expect = {
  /**
   * 严格相等。
   * @param {*} actual 实际值
   * @param {*} expected 期望值
   * @param {string} msg 说明
   */
  eq(actual, expected, msg) {
    if (actual !== expected) {
      throw new AssertionError((msg || '值不相等') + '：期望 ' + fmt(expected) +
        '，实际 ' + fmt(actual));
    }
  },

  deep(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
      throw new AssertionError((msg || '结构不相等') + '\n期望：' + b + '\n实际：' + a);
    }
  },

  ok(value, msg) {
    if (!value) throw new AssertionError(msg || '期望为真，实际为假');
  },

  /**
   * 断言状态码，失败时把响应体前半截贴出来。
   * @param {object} res httpc.request 的返回
   * @param {number} status 期望状态码
   * @param {string} msg 说明
   */
  status(res, status, msg) {
    if (res.status !== status) {
      throw new AssertionError((msg || '状态码不符') + '：期望 ' + status + '，实际 ' +
        res.status + '，响应体 ' + clip(res.text),
        { status: res.status, body: res.text.slice(0, 800) });
    }
  },

  includes(haystack, needle, msg) {
    if (String(haystack).indexOf(needle) === -1) {
      throw new AssertionError((msg || '缺少子串') + '：在 ' + clip(haystack) +
        ' 里找不到 ' + fmt(needle));
    }
  }
};

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(clip(v, 200));
  if (v === undefined) return 'undefined';
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : clip(s, 400);
}

function clip(s, n) {
  const str = String(s);
  const max = n || 300;
  return str.length > max ? str.slice(0, max) + '…(' + str.length + ' 字符)' : str;
}

module.exports = { Runner, expect, AssertionError, PASS, FAIL, SKIP, fmt, clip };
