// Read-only snapshots for DevTools; never include page URLs or clipboard data.
(function (w) {
    w.__cefGetDiagnostics = function () {
        var metadata = w.__cefUserScriptMetadata || {};
        var state = w.__cefUserScriptState || {};
        return JSON.parse(JSON.stringify({
            dll: w.__cefBuildInfo || null,
            runtime: w.__cefRuntimeInfo || { cef: 'unknown', chromium: 'unknown' },
            native: w.__cefNativeInfo || {
                host: { process: 'unknown', pid: null, architecture: 'x86' },
                lifecycle: { status: 'unknown', stopRequested: false, lastError: 0 },
                hooks: { status: 'unknown', phase: 'none', lastError: 0 },
                crashDump: { status: 'unknown', directory: '', lastError: 0 }
            },
            clipboard: w.__cefPasteFixDocument === w.document ? 'installed' : 'not-installed',
            userscript: {
                version: metadata.script && metadata.script.version || null,
                build: metadata.build || null,
                loadedBuild: w.__cefDatBuild || null,
                status: state.status || 'idle',
                phase: state.phase || null,
                attempts: state.attempts || 0,
                reason: state.reason || null,
                failedFile: state.failedFile || null
            },
            injection: w.__cefInjectionMetrics || null,
            ai: w.__cefDeepSeek ? w.__cefDeepSeek.status() : { enabled: false, status: 'not-loaded' },
            assets: w.__cefResourceStatus || {},
            resourceHashes: metadata.embeddedAssets || {},
            timings: { bootMs: state.bootMs || 0, runMs: state.runMs || 0,
                totalMs: state.totalMs || 0, evalMs: state.evalMs || 0 }
        }));
    };
    if (!w.__cefDiagnosticsAnnounced) {
        w.__cefDiagnosticsAnnounced = true;
        console.log('[CefHook] diagnostics: run __cefGetDiagnostics()', w.__cefGetDiagnostics());
    }
})(window);
