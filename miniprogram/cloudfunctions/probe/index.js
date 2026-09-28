'use strict';

/**
 * 云端目录探测（零依赖，必定可运行）
 *
 * 用途：api 云函数报 `Cannot find module './lib/response'`，
 *      但下载下来的代码包里 lib/ 明明存在 —— 需要看**运行时**真实的目录结构。
 *      本函数不 require 任何本地模块，只读文件系统，所以不会因缺模块而挂掉。
 *
 * 部署：
 *   node cloud/scripts/sync.js
 *   cd /d/dev/wx-devtools && ./cli.bat cloud functions deploy \
 *     --env jy-radio-d1gdwmptl816ee6a9 --names probe \
 *     --project "C:\Users\Administrator\radio-backend\miniprogram" -r
 */

const fs = require('fs');
const path = require('path');

function tree(dir, depth) {
  const maxDepth = depth === undefined ? 3 : depth;
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return ['ERR ' + e.message];
  }
  for (const e of entries) {
    if (e.name === 'node_modules') {
      out.push('node_modules/ (skipped)');
      continue;
    }
    if (e.isDirectory()) {
      out.push(e.name + '/');
      if (maxDepth > 0) {
        tree(path.join(dir, e.name), maxDepth - 1).forEach((x) => out.push('  ' + x));
      }
    } else {
      out.push(e.name);
    }
  }
  return out;
}

exports.main = async () => {
  const here = __dirname;
  const libDir = path.join(here, 'lib');

  const readSafe = (p) => {
    try {
      return fs.readdirSync(p);
    } catch (e) {
      return 'ERR ' + e.message;
    }
  };

  return {
    __dirname: here,
    cwd: process.cwd(),
    node: process.version,
    libExists: fs.existsSync(libDir),
    libFiles: readSafe(libDir),
    handlersFiles: readSafe(path.join(here, 'handlers')),
    servicesFiles: readSafe(path.join(here, 'services')),
    root: tree(here, 3),
    // 关键：看运行时是否把整棵 api 目录拍平/搬到了别处
    pkg: (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
      } catch (e) {
        return 'ERR ' + e.message;
      }
    })(),
  };
};
