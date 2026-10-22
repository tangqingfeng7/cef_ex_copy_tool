/*
 * gm_shim.js —— 迷你「油猴运行时」垫片
 * 由 winmm.dll 在页面主框架加载完成后注入，先于 dat.js 执行。
 * 作用：在普通页面环境里补齐 Tampermonkey 的 GM_* API、加载 @require 依赖库、
 *       预拉取 @resource 资源，使「万能全平台自动答题脚本」(dat.js) 能直接运行。
 *
 * 注意：
 *  - GM_xmlhttpRequest 目前用 fetch 直连实现，依赖目标后端允许跨域(CORS)。
 *    若搜题请求报跨域错误，需要改用其它方案（见 README）。
 *  - 发布构建的固定 @resource 已内嵌；题库/API 仍需要联网。
 */
(function () {
    var w = window;
    if (w.__wnGMReady) {
        return;
    }

    // unsafeWindow 在 CEF 注入环境里就是真实 window
    w.unsafeWindow = w;

    // GM_info 版本信息（dat.js 会读取 version 作为请求头）
    var metadata = w.__cefUserScriptMetadata || {
        script: { version: '5.4.2', name: '【万能】全平台自动答题脚本', namespace: '自动答题' },
        requires: [],
        resources: {
            Img: 'https://cdn.jsdelivr.net/npm/tiku-static-assets@1.0.0/6.png',
            Table: 'https://cdn.jsdelivr.net/npm/tiku-static-assets@1.0.0/cx_table.json'
        }
    };
    w.GM_info = {
        script: metadata.script,
        scriptHandler: 'cx-cef-shim',
        version: metadata.script.version
    };

    // ---- GM_setValue / GM_getValue：用 localStorage 持久化 ----
    var KP = '__wngm_';
    w.GM_setValue = function (k, v) {
        try { localStorage.setItem(KP + k, JSON.stringify(v)); } catch (e) {}
    };
    w.GM_getValue = function (k, d) {
        try {
            var s = localStorage.getItem(KP + k);
            if (s === null || s === undefined) { return d; }
            return JSON.parse(s);
        } catch (e) { return d; }
    };
    w.GM_deleteValue = function (k) {
        try { localStorage.removeItem(KP + k); } catch (e) {}
    };
    w.GM_listValues = function () {
        var arr = [];
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var key = localStorage.key(i);
                if (key && key.indexOf(KP) === 0) { arr.push(key.slice(KP.length)); }
            }
        } catch (e) {}
        return arr;
    };

    // ---- GM_addStyle ----
    w.GM_addStyle = function (css) {
        var s = document.createElement('style');
        s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
        return s;
    };

    // ---- GM_xmlhttpRequest：fetch 直连实现（依赖后端允许跨域）----
    w.GM_xmlhttpRequest = function (o) {
        o = o || {};
        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var init = {
            method: o.method || 'GET',
            headers: o.headers || {},
            body: (o.method && o.method.toUpperCase() !== 'GET') ? o.data : undefined,
            signal: ctrl ? ctrl.signal : undefined,
            credentials: 'omit',
            mode: 'cors'
        };
        var timeout = o.timeout && ctrl ? setTimeout(function () { ctrl.abort(); }, o.timeout) : null;
        var rt = (o.responseType || '').toLowerCase();
        var request = fetch(o.url, init).then(function (resp) {
            // 根据 responseType 用不同方式读取响应体：
            //  - blob：广告图、OCR 图片转 base64 依赖它（FileReader.readAsDataURL 需要 Blob）
            //  - arraybuffer：二进制资源
            //  - 其它：按文本（json 时再 parse）
            var bodyP;
            if (rt === 'blob') {
                bodyP = resp.blob().then(function (b) { return { kind: 'blob', val: b }; });
            } else if (rt === 'arraybuffer') {
                bodyP = resp.arrayBuffer().then(function (a) { return { kind: 'ab', val: a }; });
            } else {
                bodyP = resp.text().then(function (t) { return { kind: 'text', val: t }; });
            }
            return bodyP.then(function (body) {
                var hdr = '';
                try { resp.headers.forEach(function (v, k) { hdr += k + ': ' + v + '\r\n'; }); } catch (e) {}
                var r = {
                    readyState: 4,
                    status: resp.status,
                    statusText: resp.statusText,
                    responseHeaders: hdr,
                    finalUrl: resp.url,
                    responseText: '',
                    response: null
                };
                if (body.kind === 'blob' || body.kind === 'ab') {
                    r.response = body.val;
                } else {
                    r.responseText = body.val;
                    r.response = body.val;
                    if (rt === 'json') {
                        try { r.response = JSON.parse(body.val); } catch (e) {}
                    }
                }
                if (resp.status >= 200 && resp.status < 300) {
                    if (o.onload) { o.onload(r); }
                } else if (o.onerror) {
                    o.onerror(r);
                } else if (o.onload) {
                    o.onload(r);
                }
                if (o.onloadend) { o.onloadend(r); }
            });
        }).catch(function (e) {
            var r = { readyState: 4, status: 0, statusText: String(e), responseText: '', response: '', responseHeaders: '' };
            if (o.onerror) { o.onerror(r); }
            if (o.onloadend) { o.onloadend(r); }
        });
        request.then(function () { if (timeout !== null) clearTimeout(timeout); },
            function () { if (timeout !== null) clearTimeout(timeout); });
        return { abort: function () { if (ctrl) { try { ctrl.abort(); } catch (e) {} } } };
    };
    w.GM = w.GM || {};
    w.GM.xmlHttpRequest = w.GM_xmlhttpRequest;

    // ---- @require 依赖库（<script> 执行不受 CORS 限制）----
    // 每项给多个源，按顺序尝试，第一个成功即用（lib.baomitu.com 已失效，改用 jsdelivr 等）。
    // 5.4.2 bundles its libraries; resources follow the userscript metadata.
    var REQUIRES = metadata.requires;
    var RESOURCES = {};
    Object.keys(metadata.resources).forEach(function (name) { RESOURCES[name] = [metadata.resources[name]]; });

    var resText = {};
    var resURL = {};
    var embeddedResources = w.__cefEmbeddedResources || {};
    var resourceStatus = w.__cefResourceStatus = {};
    w.GM_getResourceText = function (name) {
        return (resText[name] !== undefined && resText[name] !== null) ? resText[name] : '';
    };
    w.GM_getResourceURL = function (name) {
        if (resURL[name]) { return resURL[name]; }
        var r = RESOURCES[name];
        return (r && r[0]) || '';
    };

    var TIMEOUT_MS = 10000;
    var loadedRequires = {};
    function loadScript(url) {
        if (loadedRequires[url]) return Promise.resolve();
        return new Promise(function (resolve, reject) {
            var script = document.createElement('script');
            var done = false;
            function finish(error) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                script.onload = script.onerror = null;
                if (script.parentNode) script.parentNode.removeChild(script);
                if (error) reject(error);
                else { loadedRequires[url] = true; resolve(); }
            }
            var timer = setTimeout(function () { finish(new Error('Dependency timeout')); }, TIMEOUT_MS);
            script.onload = function () { finish(); };
            script.onerror = function () { finish(new Error('Dependency load failed')); };
            script.src = url;
            (document.head || document.documentElement).appendChild(script);
        });
    }
    function fetchText(url) {
        return new Promise(function (resolve, reject) {
            var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            var timer = setTimeout(function () {
                if (controller) controller.abort();
                reject(new Error('Resource timeout'));
            }, TIMEOUT_MS);
            fetch(url, { credentials: 'omit', mode: 'cors', signal: controller ? controller.signal : undefined })
                .then(function (r) { if (!r.ok) throw new Error('Resource HTTP ' + r.status); return r.text(); })
                .then(function (text) { clearTimeout(timer); resolve(text); },
                    function (error) { clearTimeout(timer); reject(error); });
        });
    }
    var bootPromise = null;
    w.__wnBootGM = function () {
        if (bootPromise) return bootPromise;
        var pageDollar = w.$, pageJQ = w.jQuery;
        function restorePage() { w.$ = pageDollar; w.jQuery = pageJQ; }
        var chain = Promise.resolve();
        REQUIRES.forEach(function (url) {
            chain = chain.then(function () { return loadScript(url); });
        });
        bootPromise = chain.then(function () {
            w.__wnJQ = w.jQuery || w.$;
            restorePage();
            return Promise.all(Object.keys(RESOURCES).map(function (name) {
                var embedded = embeddedResources[name];
                if (embedded) {
                    if (typeof embedded.text === 'string') {
                        if (name === 'Table') JSON.parse(embedded.text);
                        resText[name] = embedded.text;
                    } else if (typeof embedded.dataUrl === 'string') resURL[name] = embedded.dataUrl;
                    else throw new Error('Invalid embedded resource: ' + name);
                    resourceStatus[name] = 'embedded';
                    return;
                }
                var url = RESOURCES[name][0];
                if (name === 'Img') { resURL[name] = url; return; }
                return fetchText(url).then(function (text) {
                    if (name === 'Table') JSON.parse(text); // Invalid resource must not mark boot as ready.
                    resText[name] = text;
                    resourceStatus[name] = 'network';
                });
            }));
        }).catch(function (error) {
            restorePage();
            bootPromise = null;
            throw error;
        });
        return bootPromise;
    };
    w.__wnGMReady = true;

    console.log('[gm_shim] GM 垫片已就绪');
})();
