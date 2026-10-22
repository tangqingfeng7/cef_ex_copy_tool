// Boot retries apply only before the script entry runs, avoiding duplicate UI
// and partial side effects after an exception in third-party script code.
(function (w) {
    if (w.__cefRunUserScript) return;
    // Keep one state object so native parse/read failures cannot detach it from
    // the promise handlers. A revision invalidates work from an older attempt.
    var state = w.__cefUserScriptState = w.__cefUserScriptState || {
        status: 'idle', attempts: 0, phase: 'boot', error: null, reason: null, failedFile: null
    };
    var timer = null, revision = 0;
    function now() { return w.performance && w.performance.now ? w.performance.now() : Date.now(); }
    function cancelTimer() {
        if (timer !== null) { w.clearTimeout(timer); timer = null; }
    }
    function blockingFailure() {
        return state.status === 'failed' &&
            (state.phase === 'read' || state.phase === 'decode' || state.phase === 'eval');
    }
    w.__cefBeginUserScriptInjection = function () {
        if (state.status === 'loading' || state.status === 'ready') return false;
        cancelTimer(); revision++;
        state.status = 'idle'; state.phase = 'read'; state.attempts = 0;
        state.error = null; state.reason = null; state.failedFile = null;
        return true;
    };
    w.__cefReportUserScriptFailure = function (file, phase, reason) {
        // Preserve the first failure in this injection, especially a broken shim.
        if (blockingFailure()) return;
        cancelTimer(); revision++;
        state.status = 'failed'; state.phase = phase; state.reason = reason;
        state.failedFile = file; state.error = null;
        console.error('[CefHook] userscript failed:', file, phase, reason);
    };
    w.__cefEvaluateScript = function (file, code) {
        if (!w.__cefInjectionAllowed || blockingFailure()) return;
        var started = now();
        try { (0, eval)(code + '\n//# sourceURL=cef-cx/embedded/' + file); }
        catch (e) {
            w.__cefReportUserScriptFailure(file, 'eval',
                e && e.name === 'SyntaxError' ? 'parse-error' : 'eval-error');
        }
        finally { state.evalMs = (state.evalMs || 0) + Math.max(0, now() - started); }
    };
    w.__cefRunUserScript = function (run) {
        if (state.status === 'loading' || state.status === 'ready') return state.promise;
        if (blockingFailure()) return Promise.resolve();
        cancelTimer();
        var ownRevision = ++revision;
        state.status = 'loading'; state.phase = 'boot';
        state.error = null; state.reason = null; state.failedFile = null;
        state.attempts++;
        var started = now(), runStarted = 0;
        state.promise = Promise.resolve().then(function () {
            if (ownRevision !== revision) return;
            if (typeof w.__wnBootGM !== 'function') throw new Error('GM runtime missing');
            return w.__wnBootGM();
        }).then(function () {
            if (ownRevision !== revision) return;
            state.phase = 'run';
            runStarted = now(); state.bootMs = Math.max(0, runStarted - started);
            return run();
        }).then(function () {
            if (ownRevision !== revision) return;
            state.status = 'ready';
            state.runMs = Math.max(0, now() - runStarted);
            state.totalMs = Math.max(0, now() - started);
            console.log('[CefHook] userscript entry completed');
        }).catch(function (e) {
            if (ownRevision !== revision) return;
            state.status = 'failed';
            state.error = String(e && e.message || e);
            state.reason = e && e.code === 'CEF_SCRIPT_PAIR_MISMATCH' ? 'script-pair-mismatch' :
                (state.phase === 'boot' ? 'boot-failed' : 'entry-failed');
            state.failedFile = state.phase === 'boot' ? 'gm_shim.js' : 'dat.js';
            console.error('[CefHook] userscript failed (' + state.phase + '):', state.error);
            if (state.phase === 'boot' && state.attempts < 3) {
                timer = w.setTimeout(function () {
                    timer = null;
                    if (ownRevision === revision) w.__cefRunUserScript(run);
                }, 1000 * state.attempts);
            }
        });
        return state.promise;
    };
})(window);
