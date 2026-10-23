'use strict';

// 离线缓存策略说明
//
// 之前用的是 cache-first：命中缓存就不走网络。这在开发迭代期是个陷阱——
// 一旦某个旧版本抢先控制了页面，它就会一直把陈旧的 app.js 还给你，
// 新功能再怎么部署都看不到，只能手动硬刷新。
//
// 现在改成：
//   · 页面导航（HTML）：网络优先，拿不到才回退缓存 —— 保证入口永远是最新的
//   · 其它静态资源：stale-while-revalidate —— 先用缓存秒开，同时后台换新，下次就是新的
//   · API 请求：永不缓存
//   · /photos/ 物品照片：同样走 stale-while-revalidate。家里断网或香橙派重启的
//     那几十秒照样能翻照片找东西；文件名每次上传都重新生成，不会看到旧图。

var CACHE = 'homebox-v14';
var LEGACY = ['homebox-v1', 'homebox-v2', 'homebox-v3', 'homebox-v4', 'homebox-v5', 'homebox-v6', 'homebox-v7', 'homebox-v8'];

// 一次性自愈：早于 v6 的版本都是 cache-first，会死死抓住旧资源不放。
// 装到新版时先把它们的缓存全部铲掉，断掉这个死循环。
// install 里记一下有没有真的铲掉过旧缓存，只有铲过才需要对页面做一次重载，
// 否则每次发新版本都无条件刷新，会平白打断用户正在填的表单。
var needReload = false;

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        var stale = keys.filter(function (k) {
          return k !== CACHE && (LEGACY.indexOf(k) !== -1 || k.indexOf('homebox-') === 0);
        });
        needReload = stale.length > 0;
        return Promise.all(stale.map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === CACHE ? Promise.resolve(false) : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
      .then(function () {
        if (!needReload) return null;
        needReload = false;
        // 页面上跑的还是旧代码，重载一次让用户立刻吃到新版本
        return self.clients.matchAll({ type: 'window' }).then(function (list) {
          list.forEach(function (c) { c.navigate(c.url); });
        });
      })
  );
});

function put(cache, req, res) {
  var copy = res.clone();
  caches.open(CACHE).then(function (c) { c.put(req, copy); });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') !== -1) return;

  // 页面导航：网络优先。入口新了，引用的资源版本号才会跟着更新。
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.status === 200) put(CACHE, req, res);
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('./index.html');
        });
      })
    );
    return;
  }

  // 静态资源与照片：先用缓存秒开，同时后台去网络取新版本，下次生效
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') put(CACHE, req, res);
        return res;
      }).catch(function () { return hit; });

      return hit || net;
    })
  );
});
