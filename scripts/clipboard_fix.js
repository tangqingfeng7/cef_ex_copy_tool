// Standalone paste repair, compatible with Chrome 70. No remote dependencies.
// Embedded into winmm.dll by CMake; also usable with older DLLs as gm_shim.js.
(function () {
    function install(w) {
        try {
            var d = w.document;
            if (w.__cefPasteFixDocument === d && w.__cefPasteFixRefresh) {
                w.__cefPasteFixRefresh();
                return;
            }
            w.__cefPasteFixDocument = d;
            var listeners = [];
            var rawAdd = w.EventTarget.prototype.addEventListener;
            function listen(target, type, listener) {
                listeners.push({ target: target, type: type, listener: listener });
            }
            var proto = w.Event.prototype;
            var prevent = proto.preventDefault;
            var stop = proto.stopPropagation;
            var stopImmediate = proto.stopImmediatePropagation;
            function editable(e) {
                var el = e.target;
                if (!el || el.disabled || el.readOnly) return null;
                if (el.tagName === 'TEXTAREA') return el;
                if (el.tagName === 'INPUT' && /^(text|search|url|tel|password)$/.test(el.type)) return el;
                if (el.isContentEditable) return el;
                return null;
            }
            function shortcut(e) {
                return ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey &&
                    (e.keyCode === 86 || String(e.key).toLowerCase() === 'v')) ||
                    (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.keyCode === 45);
            }
            var controls = 'label,button,select,option,a[href],[role="button"],[role="checkbox"],input[type="checkbox"],input[type="radio"],input[type="button"],input[type="submit"],input[type="reset"]';
            function controlTarget(e) {
                var el = e.target;
                return el && el.closest ? el.closest(controls) : null;
            }
            function protectedEvent(e) {
                // Labels/buttons should keep their normal selection behavior.
                if (e.type === 'selectstart' && controlTarget(e) && !editable(e)) return false;
                return /^(copy|selectstart|contextmenu|beforecopy)$/.test(e.type) ||
                    (editable(e) && (/^(paste|cut|beforepaste|beforecut)$/.test(e.type) ||
                    (/^key(down|press|up)$/.test(e.type) && shortcut(e))));
            }
            // Applies to earlier listeners without wrapping addEventListener,
            // so removeEventListener and listener identity retain native behavior.
            proto.preventDefault = function () {
                if (!protectedEvent(this)) return prevent.call(this);
            };
            proto.stopPropagation = function () {
                if (!protectedEvent(this)) return stop.call(this);
            };
            proto.stopImmediatePropagation = function () {
                if (!protectedEvent(this)) return stopImmediate.call(this);
            };
            ['copy', 'cut', 'selectstart', 'contextmenu', 'beforecopy', 'beforecut', 'beforepaste'].forEach(function (type) {
                listen(w, type, function (e) {
                    if (protectedEvent(e)) stopImmediate.call(e);
                });
            });
            ['keydown', 'keypress', 'keyup'].forEach(function (type) {
                listen(w, type, function (e) {
                    if (editable(e) && shortcut(e)) stopImmediate.call(e);
                });
            });
            listen(w, 'paste', function (e) {
                var el = editable(e);
                if (!e.isTrusted) return;
                if (!el || !e.clipboardData) {
                    console.warn('[CefHook] paste skipped', e.target && e.target.nodeName,
                        'readonly=', !!(e.target && e.target.readOnly), 'disabled=', !!(e.target && e.target.disabled));
                    return;
                }
                // Recover even when an earlier inline handler returned false.
                // insertText preserves the browser undo stack and input events.
                var text = e.clipboardData.getData('text/plain');
                if (!text) return;
                stopImmediate.call(e);
                var inserted = false;
                try { inserted = d.execCommand('insertText', false, text); } catch (_) {}
                if (!inserted && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
                    var start = el.selectionStart;
                    var end = el.selectionEnd;
                    if (el.maxLength >= 0) text = text.slice(0, Math.max(0, el.maxLength - el.value.length + end - start));
                    el.setRangeText(text, start, end, 'end');
                    el.dispatchEvent(new w.Event('input', { bubbles: true }));
                    inserted = true;
                }
                if (inserted) {
                    prevent.call(e); // Avoid a second default insertion.
                    console.log('[CefHook] paste inserted', el.tagName);
                }
            });
            var mouseMode = false;
            function updateFocusMode() {
                if (!d.documentElement) return;
                if (mouseMode) d.documentElement.setAttribute('data-cef-pointer-mode', '');
                else d.documentElement.removeAttribute('data-cef-pointer-mode');
            }
            // Focus may land on a tabindex/contenteditable ancestor of the text,
            // rather than a label/button. Cover the actual :focus target in CSS.
            listen(d, 'mousedown', function () { mouseMode = true; updateFocusMode(); });
            // Copy/paste shortcuts must not bring the pointer outline back.
            // Chrome 75 lacks :focus-visible, so Tab restores keyboard cues.
            listen(d, 'keydown', function (e) {
                if (e.key === 'Tab' || e.keyCode === 9) { mouseMode = false; updateFocusMode(); }
            });
            function ensureStyle() {
                var root = d.head || d.documentElement;
                if (!root || d.getElementById('__cefClipboardStyle')) return;
                var style = d.createElement('style');
                style.id = '__cefClipboardStyle';
                style.textContent = '*{user-select:text!important;-webkit-user-select:text!important;}' +
                    controls.split(',').map(function (selector) { return selector + ',' + selector + ' *'; }).join(',') +
                    '{user-select:none!important;-webkit-user-select:none!important;}' +
                    'textarea,input:not([type]),input[type="text"],input[type="search"],input[type="url"],input[type="email"],input[type="tel"],input[type="password"],[contenteditable="true"],[contenteditable="true"] *' +
                    '{user-select:text!important;-webkit-user-select:text!important;}' +
                    'html[data-cef-pointer-mode]:focus,html[data-cef-pointer-mode] :focus{outline:none!important;}';
                root.appendChild(style);
            }
            function discover(node) {
                if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
                    try { install(node.contentWindow); } catch (_) {}
                }
                if (node.querySelectorAll) {
                    var frames = node.querySelectorAll('iframe,frame');
                    for (var i = 0; i < frames.length; i++) {
                        try { install(frames[i].contentWindow); } catch (_) {}
                    }
                }
            }
            var lastRoot;
            function refresh() {
                // document.open clears Window/Document listeners but may retain
                // both objects and our marker. Native listener identity makes
                // registration repeatable without stacking handlers.
                listeners.forEach(function (entry) {
                    rawAdd.call(entry.target, entry.type, entry.listener, true);
                });
                ensureStyle();
                updateFocusMode();
                lastRoot = d.documentElement;
            }
            w.__cefPasteFixRefresh = refresh;
            // Watch only added subtrees. No repeating page/frame scans.
            var observer = new w.MutationObserver(function (records) {
                if (lastRoot !== d.documentElement) refresh();
                else ensureStyle();
                records.forEach(function (r) {
                    for (var i = 0; i < r.addedNodes.length; i++) discover(r.addedNodes[i]);
                });
            });
            observer.observe(d, { childList: true, subtree: true });
            listen(d, 'load', function (e) { discover(e.target); });
            refresh();
            discover(d);
            console.log('[CefHook] paste repair installed');
        } catch (_) { /* Cross-origin frames require injection in their own realm. */ }
    }
    install(window);
})();
