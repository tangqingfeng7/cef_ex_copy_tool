// Boot retries apply only before the script entry runs, avoiding duplicate UI
// and partial side effects after an exception in third-party script code.
(function (w) {
    if (w.__cefRunUserScript) return;
    var state = w.__cefUserScriptState = { status: 'idle', attempts: 0, phase: 'boot', error: null, reason: null };
    var timer = null;
    w.__cefRunUserScript = function (run) {
        if (state.status === 'loading' || state.status === 'ready') return state.promise;
        if (timer !== null) { w.clearTimeout(timer); timer = null; }
        state.status = 'loading';
        state.phase = 'boot';
        state.error = null;
        state.reason = null;
        state.attempts++;
        state.promise = Promise.resolve().then(function () {
            if (typeof w.__wnBootGM !== 'function') throw new Error('GM runtime missing');
            return w.__wnBootGM();
        }).then(function () {
            state.phase = 'run';
            return run();
        }).then(function () {
            state.status = 'ready';
            console.log('[CefHook] userscript entry completed');
        }).catch(function (e) {
            state.status = 'failed';
            state.error = String(e && e.message || e);
            state.reason = e && e.code === 'CEF_SCRIPT_PAIR_MISMATCH' ? 'script-pair-mismatch' :
                (state.phase === 'boot' ? 'boot-failed' : 'entry-failed');
            console.error('[CefHook] userscript failed (' + state.phase + '):', state.error);
            if (state.phase === 'boot' && state.attempts < 3) {
                timer = w.setTimeout(function () { timer = null; w.__cefRunUserScript(run); }, 1000 * state.attempts);
            }
        });
        return state.promise;
    };
})(window);
