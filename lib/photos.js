'use strict';

// 照片文件管线
//
// 图片以独立文件存在 data/photos 下，数据库里只留文件名。P1 迁移完全不动这个目录，
// 老照片一个字节都没变，所以这块是零风险区。
//
// 之所以单开一个文件：写图 / 删图 / 读图这三件事被 server.js 和迁移脚本同时用到，
// 放在 HTTP 工具里会让「协议」和「磁盘 IO」混在一起。

const fs = require('fs');
const path = require('path');
const { genId } = require('./util');

// 单张图片的最终体积上限，防止有人直接塞一张原图进来把 TF 卡写满
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

// 文件名只允许这一个形状，杜绝 ../ 之类的路径穿越
const PHOTO_NAME_RE = /^[a-zA-Z0-9_-]{1,40}\.(jpg|png|webp)$/;

let photoDir = null;

/**
 * 注入照片目录（server.js / 迁移脚本在启动时调用）。
 * @param {{dir:string}} opts 配置
 */
function configure(opts) {
  const cfg = opts || {};
  if (cfg.dir) photoDir = cfg.dir;
}

function getDir() {
  if (!photoDir) throw new Error('照片目录还没配置，先调用 photos.configure()');
  return photoDir;
}

/**
 * 不看客户端给的后缀，直接读文件头判断，避免有人拿 .jpg 的名字传别的东西上来。
 * @param {Buffer} buf 图片内容
 * @returns {string} 'jpg' | 'png' | 'webp'
 */
function sniffImage(buf) {
  if (buf.length < 12) throw new Error('图片内容不完整');
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  if (buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  throw new Error('不支持的图片格式，请用 jpg / png / webp');
}

/**
 * 把 base64 图片落盘。允许前端直接把整个 dataURL 传过来。
 * @param {string} base64 纯 base64 或 dataURL
 * @returns {{file:string, bytes:number, ext:string}} 落盘结果
 */
function writePhotoFile(base64) {
  if (typeof base64 !== 'string' || !base64.length) throw new Error('没有收到图片内容');
  const pure = base64.indexOf('base64,') !== -1 ? base64.split('base64,')[1] : base64;
  if (!/^[A-Za-z0-9+/=]+$/.test(pure)) throw new Error('图片编码格式不对');
  const buf = Buffer.from(pure, 'base64');
  if (!buf.length) throw new Error('图片内容是空的');
  if (buf.length > MAX_PHOTO_BYTES) throw new Error('图片超过 6MB，请在手机上重拍一张小的');
  const ext = sniffImage(buf);
  const file = genId('p') + '.' + ext;
  const dir = getDir();
  fs.mkdirSync(dir, { recursive: true });
  // 图片不是关键数据，写坏一张大不了重新拍，没必要走临时文件那套
  fs.writeFileSync(path.join(dir, file), buf);
  return { file, bytes: buf.length, ext };
}

/**
 * 删照片文件。文件名不合法直接跳过，文件本来就不存在也算删成功。
 * @param {string|null} file 文件名
 */
function deletePhotoFile(file) {
  if (!file || typeof file !== 'string') return;
  if (!PHOTO_NAME_RE.test(file)) return;
  try {
    fs.unlinkSync(path.join(getDir(), file));
  } catch (err) {
    // 文件本来就不存在也算删成功了
  }
}

/**
 * 照片是否存在（迁移验收第 4 条要用）。
 * @param {string} file 文件名
 * @returns {boolean}
 */
function exists(file) {
  if (!file || !PHOTO_NAME_RE.test(file)) return false;
  try {
    return fs.statSync(path.join(getDir(), file)).isFile();
  } catch (err) {
    return false;
  }
}

/**
 * 输出照片。文件名即内容唯一 id，不会重名，可以放心长期缓存。
 * @param {import('http').ServerResponse} res 响应
 * @param {string} pathname 已解码的 /photos/xxx 路径
 */
function servePhoto(res, pathname) {
  let raw = pathname;
  try { raw = decodeURIComponent(pathname); } catch (err) { /* 用原值 */ }
  const name = path.basename(raw);
  if (!PHOTO_NAME_RE.test(name)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400');
  }
  const full = path.join(getDir(), name);
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    const ext = path.extname(name);
    res.writeHead(200, {
      'Content-Type': 'image/' + (ext === '.png' ? 'png' : (ext === '.webp' ? 'webp' : 'jpeg')),
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    res.end(data);
  });
}

module.exports = {
  MAX_PHOTO_BYTES,
  PHOTO_NAME_RE,
  configure,
  getDir,
  sniffImage,
  writePhotoFile,
  deletePhotoFile,
  exists,
  servePhoto
};
