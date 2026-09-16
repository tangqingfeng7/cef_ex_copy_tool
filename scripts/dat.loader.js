// dat.loader.js —— 方案8 的「加载器」，部署时请改名/复制为 dat.js 放到客户端 exe 同目录。
//
// 它取代原来内联的全量答题脚本：被 winmm.dll 注入并包在
//   (function($, jQuery){ ...这里... }).call(window, __wnJQ, __wnJQ)
// 闭包里执行；本加载器从本地服务（tools/transpile/serve.js）拉取转译好的
// 全量 dat.js，再用「直接 eval」执行，使其继承被隔离的 $/jQuery 与已就绪的 GM_*。
//
// 好处：改根目录 dat.js 保存 + 刷新页面即可热更新，无需重编译 DLL、无需手动转译拷贝。
// 前提：本机已运行 `npm run serve`（见 tools/transpile/serve.js）。
(function () {
    var fetchDat = window.__wnFetchDat;
    var url = window.__wnDatRemoteURL;
    if (typeof fetchDat !== 'function') {
        console.error('[dat-loader] gm_shim 未提供 __wnFetchDat，请更新 gm_shim.js');
        return;
    }
    console.log('[dat-loader] 从', url, '拉取主脚本…');
    fetchDat(url).then(function (code) {
        console.log('[dat-loader] 已拉取', code.length, '字符，开始执行');
        try {
            // 必须用「直接 eval」(不是 (0,eval))，才能让全量脚本继承本闭包的 $/jQuery。
            eval(code);
        } catch (e) {
            console.error('[dat-loader] 执行失败:', e && (e.stack || e.message || e));
        }
    }).catch(function (e) {
        console.error('[dat-loader] 拉取失败:', e && (e.message || e),
            '——请确认本机已运行 npm run serve，且端口与 __wnDatRemoteURL 一致');
    });
})();
