'use strict';

// D 组：工程卫生
//
// 这一组不打接口，只查「仓库里的东西是不是干净、文档里的命令是不是真能跑」。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const util = require('../lib/util');
const servers = require('../lib/servers');
const dbcheck = require('../lib/dbcheck');
const { expect } = require('../lib/runner');

/**
 * 递归找出所有 .js 文件（跳过 .git / node_modules / data / docs / qa）。
 * @param {string} root 根目录
 * @returns {string[]} 相对路径数组
 */
function walkJs(root) {
  const out = [];
  const skip = new Set(['.git', 'node_modules', 'data', 'docs', 'qa', 'screenshots', '.workbuddy']);
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relPath = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(full, relPath);
      else if (/\.js$/.test(entry.name)) out.push(relPath);
    }
  };
  walk(root, '');
  return out.sort();
}

/**
 * 注册 D 组用例。
 * @param {object} runner Runner
 * @param {object} ctx 共享上下文
 */
function register(runner, ctx) {
  const repoRoot = ctx.repoRoot;
  runner.section('D 工程卫生');

  runner.test('D1', 'git 里没有任何数据库/备份文件被跟踪，data/ 被 .gitignore 覆盖', async () => {
    const tracked = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
    expect.eq(tracked.status, 0, 'git ls-files 应能跑');
    const bad = tracked.stdout.split('\n').filter((f) =>
      /\.(db|db-wal|db-shm)$|^data\//.test(f) && f.trim());
    expect.eq(bad.length, 0, '不应有数据库/数据文件被跟踪，实际：' + bad.join(', '));

    const ignored = spawnSync('git', ['check-ignore', 'data/homebox.db', 'data/db.json.migrated'],
      { cwd: repoRoot, encoding: 'utf8' });
    expect.eq(ignored.status, 0, 'data/ 下的文件应被 .gitignore 命中');

    const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
    const suspicious = status.stdout.split('\n').filter((line) =>
      line.trim() && !/^\?\?\s+(qa\/|docs\/|\.workbuddy\/)/.test(line) &&
      /\.(db|db-wal|db-shm)$|db\.json/.test(line));
    expect.eq(suspicious.length, 0, '工作区不应出现数据库/数据文件，实际：' + suspicious.join(' | '));
  }, { repro: 'node qa/qa-p1.js --only D1' });

  runner.test('D2', '.gitignore 明确忽略 data/ 与日志', async () => {
    const text = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
    expect.ok(/^data\/$/m.test(text), '.gitignore 应有 data/ 一行');
    expect.ok(/\.log/.test(text), '.gitignore 应忽略 *.log');
  }, { repro: 'node qa/qa-p1.js --only D2' });

  runner.test('D3', 'package.json：零依赖、engines >=22.13、脚本名齐全', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect.deep(pkg.dependencies || {}, {}, 'dependencies 必须为空');
    expect.deep(pkg.devDependencies || {}, {}, 'devDependencies 必须为空');
    expect.eq(pkg.engines && pkg.engines.node, '>=22.13', 'engines.node');
    const scripts = pkg.scripts || {};
    ['start', 'migrate', 'export', 'smoke'].forEach((name) => {
      expect.ok(scripts[name], 'package.json 缺少脚本 ' + name);
    });
    expect.includes(scripts.start, '--disable-warning=ExperimentalWarning',
      'start 脚本应关掉 ExperimentalWarning');
    ['migrate', 'export', 'smoke'].forEach((name) => {
      expect.ok(scripts[name].indexOf('scripts/') !== -1, name + ' 脚本应直接跑 scripts/ 下的文件');
    });
  }, { repro: 'node qa/qa-p1.js --only D3' });

  runner.test('D4', "require('node:sqlite') 在生产代码里只出现一次（lib/db.js）", async () => {
    const files = walkJs(repoRoot);
    expect.ok(files.length > 3, '应扫到足够多的 js 文件，实际 ' + files.length);
    const hits = [];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      // 注释里提到 require('node:sqlite') 不算（例如 lib/db.js 的说明性注释），
      // 所以先把块注释与行注释剥掉再匹配。
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''));
      stripped.forEach((line, i) => {
        if (/require\(\s*['"]node:sqlite['"]\s*\)/.test(line)) {
          hits.push(rel + ':' + (i + 1));
        }
      });
    }
    expect.eq(hits.length, 1, '生产代码里 node:sqlite 应只被 require 一次，实际：' +
      hits.join(', '));
    expect.eq(hits[0].split(':')[0], 'lib/db.js', '唯一那一处应在 lib/db.js');
  }, { repro: 'node qa/qa-p1.js --only D4' });

  runner.test('D5', '启动日志干净：npm start 不刷 ExperimentalWarning，只打自己的信息',
    async () => {
      const dir = util.makeTempDir('hb-qa-log-');
      const dataDir = path.join(dir, 'data');
      servers.prepareDataDir(repoRoot, dataDir);
      try {
        const srv = await servers.startNewServer({ repoRoot, dataDir });
        try {
          const all = srv.stdout + srv.stderr;
          expect.ok(all.indexOf('ExperimentalWarning') === -1,
            '启动输出里不应有 ExperimentalWarning，实际：' + all.slice(0, 400));
          expect.includes(srv.stdout, 'HomeBox 已启动', '应有启动横幅');
          expect.includes(srv.stdout, '数据文件：', '应打印数据文件路径');
          expect.includes(srv.stdout, '运行环境：', '应打印 Node/SQLite 版本');
          expect.ok(srv.stderr.trim() === '', 'stderr 应该是干净的，实际：' + srv.stderr.slice(0, 400));
          // 首次启动（有 db.json）应报告迁移结果
          expect.includes(srv.stdout, '已从 data/db.json 迁移到 SQLite', '首次启动应报告迁移');
        } finally {
          await servers.stopServer(srv);
        }
      } finally {
        util.rmrf(dir);
      }
    }, { repro: 'node qa/qa-p1.js --only D5' });

  runner.test('D6', 'npm run smoke：工程师自测的 72 条全部通过（我不只看，还要复跑）', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect.includes(pkg.scripts.smoke, 'scripts/smoke-test.js', 'smoke 脚本指向');
    const res = spawnSync('npm', ['run', 'smoke'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
      timeout: 240000,
      env: Object.assign({}, process.env)
    });
    const output = (res.stdout || '') + (res.stderr || '');
    expect.eq(res.status, 0, 'npm run smoke 退出码应为 0，实际 ' + res.status + '\n' +
      output.slice(-1200));
    // 只看最后那行汇总：「通过 72 / 72」
    const m = output.match(/通过\s*(\d+)\s*\/\s*(\d+)/);
    expect.ok(m, '应能解析出「通过 N / M」汇总行，实际输出尾部：' + output.slice(-400));
    expect.eq(m[1], m[2], 'smoke 应全部通过，实际 ' + m[1] + '/' + m[2]);
    expect.ok(Number(m[2]) >= 50, 'smoke 用例数应不少于 50 条，实际 ' + m[2]);
  }, { repro: 'node qa/qa-p1.js --only D6' });

  runner.test('D7', 'npm run export 能跑；导出内容与库一致，且能原样回灌成新库', async () => {
    const dir = util.makeTempDir('hb-qa-export-');
    const dataDir = path.join(dir, 'data');
    servers.prepareDataDir(repoRoot, dataDir);
    try {
      const mig = servers.runMigrate(repoRoot, dataDir);
      expect.eq(mig.code, 0, '先迁移成功');
      const outFile = path.join(dir, 'export.json');
      const exp = servers.runNodeSync({
        cwd: repoRoot,
        args: [path.join(repoRoot, 'scripts', 'export.js'), '--data', dataDir, '--out', outFile],
        timeoutMs: 30000
      });
      expect.eq(exp.code, 0, 'export 退出码，输出：' + exp.stdout + exp.stderr);
      const doc = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      expect.eq(doc.locations.length, 19, '导出位置数');
      expect.eq(doc.items.length, 26, '导出物品数');
      expect.eq(doc.items.filter((i) => i.wear).length, 14, '导出衣物数');
      expect.eq(doc.items.filter((i) => i.photo).length, 1, '导出照片引用数');
      expect.eq(doc.settings.planWidthM, 12, '导出 planWidthM');
      expect.ok(!doc.items.some((i) => 'path' in i), '导出不应带派生字段 path');
      // 坐标精度不能丢
      const living = doc.locations.filter((l) => l.id === 'l_living')[0];
      expect.eq(living.box.x, 4.080385852090036, '导出后房间坐标精度');

      // 回灌：把导出的 JSON 当 db.json，再迁一次
      const backDir = path.join(dir, 'backfill');
      fs.mkdirSync(backDir, { recursive: true });
      fs.writeFileSync(path.join(backDir, 'db.json'), JSON.stringify(doc), 'utf8');
      util.copyDir(path.join(repoRoot, 'data', 'photos'), path.join(backDir, 'photos'));
      const back = servers.runMigrate(repoRoot, backDir);
      expect.eq(back.code, 0, '回灌迁移应成功，输出：' + back.stdout.slice(-500));
      const backDb = path.join(backDir, 'homebox.db');
      expect.eq(dbcheck.countRows(backDb, 'locations'), 19, '回灌后位置数');
      expect.eq(dbcheck.countRows(backDb, 'items'), 26, '回灌后物品数');
      const backLiving = dbcheck.query(backDb,
        'SELECT box_x FROM locations WHERE id = ?', ['l_living'])[0];
      expect.eq(Number(backLiving.box_x), 4.080385852090036, '回灌后坐标精度');
    } finally {
      util.rmrf(dir);
    }
  }, { repro: 'node qa/qa-p1.js --only D7' });

  runner.test('D8', 'README 里的命令与实现一致；备份建议与 WAL 实现不打架', async () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const mentioned = Array.from(new Set(
      (readme.match(/npm run ([a-z-]+)/g) || []).map((s) => s.replace('npm run ', ''))
    ));
    expect.ok(mentioned.length > 0, 'README 应至少提到一个 npm run 命令');
    mentioned.forEach((name) => {
      expect.ok(pkg.scripts[name], 'README 提到了 npm run ' + name + '，但 package.json 里没有');
    });
    // 迁移相关的说法必须与实际实现一致
    expect.includes(readme, 'db.json.migrated', 'README 应说明原文件改名留档');
    expect.includes(readme, 'data/backup/', 'README 应说明备份位置');

    // 备份章节现在必须是「export 为主、tar 为备选」，且不能自相矛盾：
    //   1) 推荐做法（export）出现在 tar 之前，第一个 cron 示例就是导 JSON；
    //   2) 定时导出的目标必须在 data/ 树外，否则日包会把自己再套一层；
    //   3) tar 方案必须明确要求先停服务（WAL 运行中拷库不安全）；
    //   4) 默认的 data/backup/ 必须被标注成「只适合手动」。
    const cronExport = (readme.match(/^0 3 \* \* \* .*$/m) || [''])[0];
    expect.ok(/npm run export/.test(cronExport),
      '每天 3 点的任务应该导出 JSON，实际：' + cronExport);
    const outArg = (cronExport.match(/--out (\S+)/) || [])[1] || '';
    expect.ok(!!outArg, '定时导出必须显式 --out，实际：' + cronExport);
    expect.ok(!/(^|\/)data\//.test(outArg),
      '导出目标必须在 data/ 树外，实际：' + outArg);
    expect.ok(readme.indexOf('npm run export') < readme.indexOf('tar czf'),
      '推荐做法（export）必须排在「停服后 tar」之前');
    expect.ok(/必须先停|先停服务/.test(readme), 'tar 方案必须写明先停服务');
    expect.ok(readme.indexOf('只适合') !== -1 && readme.indexOf('手动') !== -1,
      '默认的 data/backup/ 必须标注成只适合手动导出');
    expect.ok(/--out/.test(readme), 'README 应说明 --out 可以指到树外目录');
  }, { repro: 'node qa/qa-p1.js --only D8' });
}

module.exports = { register };
