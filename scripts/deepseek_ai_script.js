// SPDX-License-Identifier: GPL-3.0-only
// Copied from SJYssr/CxExam_automatic_answering, commit 3b534edae5208f1b3bdb256142491a6cd28de4a0.
// Local changes: vision transport, safe text fill, persistent DLL config, sequential answering, Ctrl+G panel/chat.
// 超星学习通考试AI辅助填充脚本
// 功能：获取题目和选项，发送给DeepSeek AI解答，支持快捷键操作

(function() {
    'use strict';
    if (!window.document || !window.location || !window.__cefDeepSeek) return;

    ;

    // =====页面检测逻辑=====
    function isChaoxingExamPage() {
        const hostname = window.location.hostname;
        const pathname = window.location.pathname;

        ;

        // 检查域名和路径是否符合考试页面
        return (
            (hostname === 'chaoxing.com' || hostname.endsWith('.chaoxing.com') || hostname.endsWith('.edu.cn')) &&
            (
                pathname.includes('/exam/test/') ||
                pathname.includes('/exam-ans/exam/test/') ||
                pathname.includes('/exam-ans/mooc2/exam/preview')
            )
        );
    }

    // 若不是考试页面，不执行
    if (!isChaoxingExamPage()) {
        ;
        return;
    }

    ;

    // 检查是否已加载，避免重复加载
    if (window.__deepseekAILoaded) {
        ;
        return;
    }
    window.__deepseekAILoaded = true;

    // Persistent DLL configuration and vision-capable model are provided by deepseek.js.
    // The Key is stored in the DLL-adjacent config.json, never in page localStorage.
    function answeringEnabled() { return window.__cefDeepSeek.answeringEnabled(); }
    function getAIConfig() {
        const status = window.__cefDeepSeek.status();
        return { apiKey: status.enabled && status.configured ? '[dll-configured]' : '', source: 'DLL目录 config.json' };
    }

    // 设置面板是否已自动弹出过（避免每次自动获取答案都弹出）
    let settingsDialogShown = false;
    let autoTimer = null;
    let autoTimerForced = false;
    let autoObserver = null;
    let rerunRequested = false;
    let rerunForced = false;
    let lastRequestedSignature = '';
    let imageLoadListenerInstalled = false;
    let answeringPaused = window.__cefDeepSeek.status().answeringPaused === true;
    let pauseGeneration = 0;
    let pauseWaiters = [];
    let runEpoch = 0;
    const failedQuestions = new Set(), manualSaves = new Map();
    const retryKey = question => question.dataset.questionId || question;
    const saveButtonSelector = 'button,a,input[type=button],input[type=submit],[id^=save_],[onclick]';
    const saveButtonLabel = node => String(node.tagName === 'INPUT' ? node.value : node.textContent || '').replace(/\s+/g, '');
    const savedLabel = /^(保存成功|已保存)$/;
    const failedLabel = /^(保存失败|保存出错)/;
    const saveButtonKey = button => button.id || button;
    function isSaveButton(node) {
        if (!node || node.closest('.edui-toolbar,.edui-editor-toolbarbox')) return false;
        const label = saveButtonLabel(node);
        return /^(保存|保存答案|保存答题|保存中[…\.]*)$/.test(label) || savedLabel.test(label) ||
            failedLabel.test(label) || /^save_/.test(node.id || '');
    }

    function setAnsweringPaused(paused, persist = true) {
        if (answeringPaused === !!paused) return answeringPaused;
        answeringPaused = !!paused;
        if (persist && window.__cefDeepSeek.rememberPause) window.__cefDeepSeek.rememberPause(answeringPaused);
        if (!answeringPaused) {
            const waiters = pauseWaiters.splice(0);
            waiters.forEach(resolve => resolve());
            reportStatus('继续逐题答题…', 'success');
            // A previous round can still be waiting at the pause gate after
            // AI was disabled/re-enabled. Queue through the signature guard;
            // the obsolete round will exit before the new timer runs.
            scheduleAutoAnswer(false);
        } else {
            pauseGeneration++;
            reportStatus(isProcessing ? '已暂停 · 当前题写入前等待继续' : '已暂停答题', 'success');
        }
        document.dispatchEvent(new CustomEvent('cef-ai-pause-changed', { detail: { paused: answeringPaused } }));
        return answeringPaused;
    }

    function waitForAnsweringPermission() {
        if (!answeringPaused) return Promise.resolve();
        return new Promise(resolve => pauseWaiters.push(resolve));
    }

    function answerDelayMs() {
        const status = window.__cefDeepSeek.status();
        const value = Number(status && status.answerDelayMs);
        return Number.isFinite(value) ? Math.max(0, Math.min(10000, Math.floor(value))) : 1000;
    }

    function sleep(ms) { return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve(); }

    async function waitBetweenQuestions(ms, nextIndex, total, epoch) {
        let elapsed = 0;
        while (true) {
            await waitForAnsweringPermission();
            if (!answeringEnabled() || epoch !== runEpoch) return false;
            const remaining = Math.max(0, answerDelayMs() - elapsed);
            if (!remaining) break;
            const seconds = (remaining / 1000).toFixed(1).replace(/\.0$/, '');
            reportStatus(`本题处理结束 · ${seconds} 秒后处理第 ${nextIndex}/${total} 题…`);
            const step = Math.min(remaining, 200);
            await sleep(step);
            elapsed += step;
        }
        return answeringEnabled();
    }

    function reportStatus(message, state) {
        if (window.__cefDeepSeek.reportStatus) window.__cefDeepSeek.reportStatus(message, state);
    }

    function questionSignature() {
        const questions = Array.from(document.querySelectorAll('div.questionLi'));
        if (!questions.length) return '';
        return questions.map((question, index) => {
            const title = question.querySelector('h3.mark_name,h3,.mark_name');
            const images = Array.from(question.querySelectorAll('img')).map(img => [
                img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || '',
                !!img.complete, img.naturalWidth || 0, img.naturalHeight || 0
            ].join(':')).join('|');
            const options = Array.from(question.querySelectorAll('div.answerBg'), optionText);
            return JSON.stringify([question.dataset.questionId || index, title ? title.textContent.trim() : '', collectBlankTargets(question).length, images, options]);
        }).join('\n');
    }

    function observeQuestions() {
        if (autoObserver || !document.documentElement) return;
        function touchesQuestions(record) {
            const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            if (target && target.closest('div.questionLi')) return true;
            if (record.type !== 'childList') return false;
            const containsQuestion = node => node.nodeType === 1 && (node.matches('div.questionLi') || node.querySelector('div.questionLi'));
            return Array.from(record.addedNodes).some(containsQuestion) || Array.from(record.removedNodes).some(containsQuestion);
        }
        autoObserver = new MutationObserver(records => {
            if (!answeringEnabled() && !manualSaves.size) return;
            let needsAnswer = false;
            for (const record of records) {
                const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
                const valueChanged = record.type === 'attributes' && record.attributeName === 'value';
                const textOnly = valueChanged || record.type === 'characterData' || record.type === 'childList' &&
                    [...record.addedNodes, ...record.removedNodes].every(node => node.nodeType === 3);
                let button = textOnly && target && target.closest(saveButtonSelector);
                if (!button && record.type === 'childList' && record.addedNodes.length === 1 && record.removedNodes.length === 1) {
                    const added = record.addedNodes[0], removed = record.removedNodes[0];
                    if (added.id && added.id === removed.id && added.matches(saveButtonSelector) && removed.matches(saveButtonSelector) &&
                        isSaveButton(added) && isSaveButton(removed)) button = added;
                }
                const question = button && button.closest('div.questionLi');
                if (question && isSaveButton(button) && !button.closest('h3,.mark_name,.answerBg')) {
                    if (savedLabel.test(saveButtonLabel(button))) acknowledgeManualSave(button, question);
                } else if (!valueChanged && answeringEnabled() && touchesQuestions(record)) needsAnswer = true;
            }
            if (needsAnswer) scheduleAutoAnswer(false, 120);
        });
        autoObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-url', 'value'] });
        if (!imageLoadListenerInstalled) {
            imageLoadListenerInstalled = true;
            document.addEventListener('load', event => {
                const node = event.target;
                if (node && (node.tagName === 'IMG' || node.tagName === 'IFRAME' && answerFrameBody(node)) &&
                    node.closest('div.questionLi') && answeringEnabled()) scheduleAutoAnswer(false, 50);
            }, true);
        }
    }

    function scheduleAutoAnswer(force, delay = 0) {
        if (!answeringEnabled() || (!window.__cefDeepSeek.status().bankAnswerEnabled && !window.__cefDeepSeek.status().configured)) return;
        observeQuestions();
        if (autoTimer) clearTimeout(autoTimer);
        autoTimerForced = autoTimerForced || !!force;
        autoTimer = setTimeout(() => {
            autoTimer = null;
            const forceRun = autoTimerForced;
            autoTimerForced = false;
            requestAutoAnswer(forceRun);
        }, delay);
    }

    // An explicit restart may answer kept questions again; the overwrite policy still guards their content.
    function restartAnswering() {
        manualSaves.clear();
        scheduleAutoAnswer(true);
    }

    function requestAutoAnswer(force) {
        if (!answeringEnabled()) return;
        if (answeringPaused) {
            reportStatus(`已暂停答题 · ${window.__cefDeepSeek.status().hotkeys.pause} 继续`, 'success');
            return;
        }
        const signature = questionSignature();
        if (!signature) {
            reportStatus('已启用 · 等待题目加载…');
            observeQuestions();
            return;
        }
        if (!force && signature === lastRequestedSignature) return;
        if (isProcessing) {
            rerunRequested = true;
            rerunForced = rerunForced || !!force;
            return;
        }
        lastRequestedSignature = signature;
        fetchAllAnswers();
    }

    function finishProcessing() {
        isProcessing = false;
        if (!rerunRequested) return;
        const force = rerunForced;
        rerunRequested = false;
        rerunForced = false;
        scheduleAutoAnswer(force);
    }

    // All notices stay inside the Ctrl+G panel. Do not cover the exam page with
    // a centered toast while the user is reading or filling an answer.
    function showAIToast(message, isError) {
        reportStatus(String(message || '').replace(/^\[AI答题\]\s*/, ''), isError ? 'error' : 'success');
    }

    function reportProgress(item) {
        if (window.__cefDeepSeek.progress) window.__cefDeepSeek.progress(item);
    }

    function keepManualAnswer(question, progress, message, pending = null) {
        const entry = { progress, message, pending, clicked: pending && new Set() };
        manualSaves.set(retryKey(question), entry);
        return entry;
    }

    function reportManualAnswer(question, entry) {
        reportProgress({ ...entry.progress, root: question, answer: entry.message,
            state: entry.pending && !entry.pending.size ? 'success' : 'review' });
    }

    function acknowledgeManualSave(button, question) {
        const entry = manualSaves.get(retryKey(question));
        const key = saveButtonKey(button);
        if (!entry || !entry.clicked || !entry.clicked.delete(key) || !entry.pending.delete(key) || entry.pending.size) return;
        entry.message = '手工答案已保存';
        reportManualAnswer(question, entry);
        const results = Object.values(window.aiAnswersData || {});
        if (!isProcessing && !results.some(item => item.error || item.writeFailed || item.manualSave && item.manualSave.pending && item.manualSave.pending.size))
            reportStatus(entry.message, 'success');
    }

    function clearProgress() {
        if (window.__cefDeepSeek.clearProgress) window.__cefDeepSeek.clearProgress();
    }

    function compactQuestion(text) {
        const value = String(text || '').replace(/\s+/g, ' ').trim();
        return value.length > 120 ? value.slice(0, 117) + '…' : value;
    }

    function addUnique(list, node) {
        if (node && !list.includes(node)) list.push(node);
    }

    const answerEditorWrapper = '.eidtDiv,.textDIV,.Cy_ulTk li,.fill_blank';
    function answerFrameBody(frame) {
        if (frame.closest('h3,.mark_name,.qtContent')) return null;
        const frameDoc = frame.contentDocument, body = frameDoc && frameDoc.body;
        if (!body) return null;
        if (body.isContentEditable || frameDoc.designMode === 'on') return body;
        const editable = body.querySelector('[contenteditable=true]');
        if (editable) return editable;
        const wrapper = frame.closest(answerEditorWrapper);
        return wrapper && wrapper.querySelector('textarea') ? body : null;
    }

    function collectBlankTargets(question) {
        const targets = [];
        Array.from(question.querySelectorAll('textarea,iframe,[contenteditable=true],input[type=text],input:not([type])')).forEach(node => {
            if (node.closest('.edui-toolbar,.edui-editor-toolbarbox')) return;
            if (node.tagName === 'IFRAME' && !answerFrameBody(node)) return;
            if (node.tagName === 'INPUT') { addUnique(targets, node); return; }
            const wrapper = node.closest(answerEditorWrapper);
            const richEditor = wrapper && wrapper.querySelectorAll('textarea').length === 1 &&
                (wrapper.querySelector('[contenteditable=true]') || Array.from(wrapper.querySelectorAll('iframe')).some(answerFrameBody));
            addUnique(targets, richEditor ? wrapper : node);
        });
        return targets;
    }
    function optionText(option) {
        const content = option.querySelector('.answer_p') || option.querySelector('div.clearfix') || option;
        if (!content.querySelector('.mark_letter')) return content.textContent.trim();
        const copy = content.cloneNode(true);
        copy.querySelectorAll('.mark_letter').forEach(label => label.remove());
        return copy.textContent.trim();
    }

    function detectQuestionType(question, titleText, blankTargets, optionNodes) {
        // Some Chaoxing banks wrap a fill-in prompt in a generic "简答题"
        // container while the actual stem explicitly says [填空题]. The stem
        // marker is more specific than the host container metadata.
        if (/\[\s*填空题\s*\]|【\s*填空题\s*】/.test(titleText)) return { name: '填空题', code: 2 };
        const heading = titleText.replace(/^\s*(?:第?\d+|[一二三四五六七八九十]+)\s*[.、．:：]?\s*/, '');
        const labels = [
            ['多选题', '多选题', 1], ['单选题', '单选题', 0], ['判断题', '判断题', 3], ['填空题', '填空题', 2],
            ['简答题', '简答题', 4], ['问答题', '简答题', 4], ['论述题', '简答题', 4], ['编程题', '简答题', 4], ['程序设计题', '简答题', 4]
        ];
        for (const [label, name, code] of labels) {
            if (new RegExp('^[（(【\\[]?\\s*' + label).test(heading)) return { name, code };
        }
        // Empty strings coerce to 0; editor toolbar fields such as typeface are
        // not question metadata. Never let either silently select single-choice.
        const candidates = Array.from(question.querySelectorAll('input[name^="type"],input[name^="answertype"],input[class*="que-type"]'));
        for (const named of candidates) {
            const validName = /^(?:type|answertype)(?:\d+|_\d+|\[\d+\])?$/.test(named.name || '');
            const validClass = Array.from(named.classList).some(value => /^que-type(?:-\d+)?$/.test(value));
            const value = String(named.value || '').trim();
            if ((!validName && !validClass) || !/^\d+$/.test(value)) continue;
            const parsed = Number(value);
            if (parsed === 0 || parsed === 66) return { name: '单选题', code: parsed };
            if (parsed === 1) return { name: '多选题', code: 1 };
            if (parsed === 2) return { name: '填空题', code: 2 };
            if (parsed === 3) return { name: '判断题', code: 3 };
            if ([4, 5, 6, 7, 8].includes(parsed)) return { name: '简答题', code: 4 };
        }
        if (titleText.includes('多选题')) return { name: '多选题', code: 1 };
        if (titleText.includes('判断题')) return { name: '判断题', code: 3 };
        if (titleText.includes('简答题')) return { name: '简答题', code: 4 };
        if (titleText.includes('填空题') || blankTargets.length > 1) return { name: '填空题', code: 2 };
        if (blankTargets.length === 1 || !optionNodes.length) return { name: '简答题', code: 4 };
        return { name: '单选题', code: 0 };
    }

    function buildQuestionModel(question, index) {
        const titleElement = question.querySelector('h3.mark_name,h3,.mark_name');
        if (!titleElement) return null;
        const rawTitleText = titleElement.textContent.trim();
        const optionNodes = Array.from(question.querySelectorAll('div.answerBg'));
        const blankTargets = collectBlankTargets(question);
        const type = detectQuestionType(question, rawTitleText, blankTargets, optionNodes);
        const stemElement = titleElement.querySelector('.qtContent');
        const stemClone = (stemElement || titleElement).cloneNode(true);
        stemClone.querySelectorAll('.mark_letter,.answerBg,.mark_answer,.aiAssistant').forEach(node => node.remove());
        const titleText = window.__cefDeepSeek.cleanQuestionStem(stemClone.textContent, type.code);
        const options = optionNodes.map(optionText);
        const targets = type.code === 2 || type.code === 4 ? blankTargets : optionNodes;
        const data = { question: titleText, options, type: type.code, root: question, stemNode: stemElement || titleElement,
            $options: targets, __cefAILegacyFallback: true };
        return { question, index, key: question.dataset.questionId || `q-${index}`, titleText, optionNodes, blankTargets, type, data,
            imageCount: question.querySelectorAll('img,canvas').length };
    }

    async function fetchQuestionAnswer(model, epoch, publish) {
        let retriedCanvas = false, retriedBank = false;
        lookup: for (;;) {
            if (answeringPaused) await waitForAnsweringPermission();
            if (!answeringEnabled() || epoch !== runEpoch) return false;
            let checkedPause = pauseGeneration;
            let result, canvasError;
            try { result = await window.__cefDeepSeek.answer(model.data); }
            catch (error) {
                if (error.code !== 'STALE_CANVAS' || retriedCanvas) throw error;
                canvasError = error;
            }
            if (!answeringEnabled() || epoch !== runEpoch) return false;
            if (result) {
                const answers = result.list && Array.isArray(result.list[0]) ? result.list[0] : [];
                if (!answers.length) throw new Error('AI 未返回可用答案');
                const choice = model.type.code === 0 || model.type.code === 1 || model.type.code === 66;
                publish({ answers, answer: answers.join(choice ? '' : '；'), validate: model.data.__cefAIValidate,
                    answerState: model.data.__cefAIState, bankDataRevision: result.bankDataRevision,
                    source: result.source || 'DeepSeek', needsReview: result.needsReview === true });
            }
            const bankDataRevision = result && result.bankDataRevision;
            while (answeringPaused || canvasError || bankDataRevision != null && checkedPause !== pauseGeneration) {
                await waitForAnsweringPermission();
                if (!answeringEnabled() || epoch !== runEpoch) return false;
                const state = model.data.__cefAIState();
                if (state === 'STALE_CANVAS' && !retriedCanvas) { retriedCanvas = true; continue lookup; }
                if (state || canvasError) {
                    const error = new Error('题目或输入已变化，旧结果不会填充');
                    error.code = state || canvasError.code;
                    throw error;
                }
                if (bankDataRevision != null && checkedPause !== pauseGeneration) {
                    checkedPause = pauseGeneration;
                    if (!await window.__cefDeepSeek.bankDataIsCurrent(bankDataRevision)) {
                        if (!answeringEnabled() || epoch !== runEpoch) return false;
                        const currentState = model.data.__cefAIState();
                        if (currentState === 'STALE' || currentState === 'STALE_EDIT') {
                            const error = new Error('题目或输入已变化，旧结果不会填充');
                            error.code = currentState;
                            throw error;
                        }
                        if (retriedBank) throw new Error('暂停期间题库再次变化，请重新查询本题');
                        retriedBank = true;
                        continue lookup;
                    }
                }
            }
            return true;
        }
    }

    /**
     * 对 API Key 做脱敏显示
     */
    function maskApiKey(key) {
        if (!key) {
            return '（未设置）';
        }
        if (key.length <= 10) {
            return key.slice(0, 3) + '****';
        }
        return key.slice(0, 6) + '****' + key.slice(-4);
    }

    /**
     * 打开 API Key 设置面板
     * @param {string} notice - 打开原因说明（如错误信息），可为空
     */
    function openAISettingsDialog(notice) {
        window.__cefDeepSeek.openSettings();
        if (notice) showAIToast(notice, true);
    }

    // 初始化脚本
    function initScript() {
        document.addEventListener('cef-ai-invalidated', function () {
            runEpoch++; failedQuestions.clear();
            window.aiAnswersData = null; clearCopiedAnswer();
        });
        document.addEventListener('cef-ai-config-changed', function () {
            window.aiAnswersData = null; clearCopiedAnswer();
            lastRequestedSignature = '';
            setAnsweringPaused(window.__cefDeepSeek.status().answeringPaused === true, false);
            if (answeringEnabled()) scheduleAutoAnswer(true);
        });
        ;

        // 监听鼠标中键 - 填充AI答案
        document.addEventListener('mousedown', async function(event) {
            if (!answeringEnabled()) return;
            if (event.button === 1) { // 鼠标中键
                event.preventDefault();
                ;

                if (window.aiAnswersData && Object.keys(window.aiAnswersData).length > 0) {
                    ;
                    await fillAnswersFromAI(window.aiAnswersData);
                    // 填充后清除数据
                    window.aiAnswersData = null;
                } else {
                    ;
                    lastRequestedSignature = '';
                    restartAnswering();
                }
            }
        });

        function askCopiedSelection(event) {
            if (!event.isTrusted || isProcessing || !window.__cefDeepSeek.enabled() ||
                event.composedPath().some(node => node.id === 'cef-deepseek-settings')) return;
            const text = window.__cefDeepSeek.selectedText().trim();
            if (text) handleCopyAIRequest(text, selectedQuestion());
        }
        document.addEventListener('copy', askCopiedSelection);
        document.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !event.repeat && String(event.key).toLowerCase() === 'c')
                askCopiedSelection(event);
        });

        document.addEventListener('click', event => fillCopiedAnswer(event.target));
        document.addEventListener('click', event => {
            const button = event.target.closest && event.target.closest(saveButtonSelector);
            const question = button && button.closest('div.questionLi');
            const entry = question && manualSaves.get(retryKey(question));
            if (entry && entry.pending && entry.pending.has(saveButtonKey(button))) entry.clicked.add(saveButtonKey(button));
        }, true);

        // 页面加载后自动获取答案
        ;
        if (answeringEnabled()) scheduleAutoAnswer(true);

        // Ctrl+G / opacity / drag are supplied by the shared panel adapter.

        ;
        ;
    }

    // 全局变量用于防止重复执行
    let isProcessing = false;

    /**
     * 处理复制操作的AI请求：将复制的内容发送给AI，获取答案并存储，改变鼠标指针
     * @param {string} copiedText - 用户复制的文本内容（来自剪贴板）
     */
    async function handleCopyAIRequest(copiedText, sourceRoot) {
        // 检查API Key
        const { apiKey } = getAIConfig();
        if (!apiKey) {
            ;
            showAIToast('[AI答题] 未配置 API Key，按 Ctrl+G 打开设置面板填写后，重新复制题目即可。', true);
            return;
        }

        // 防止重复请求
        if (isProcessing) {
            ;
            return;
        }

        isProcessing = true;

        try {
            // 检测题目类型（仅支持填空题和简答题）
            let questionType = '未知类型';
            if (copiedText.includes('填空题')) {
                questionType = '填空题';
            } else if (copiedText.includes('简答题')) {
                questionType = '简答题';
            }

            // 构建提示词（与自动答题保持一致）
            let prompt = `你是AI答题助手，分析以下试题，给出最合适的答案。仅返回答案，不要解释(如果解释将会导致返回格式错误)。规则：如果填空题或简答题，请给出简洁的填充内容（如：1，苹果;香蕉，等等），并且不能带有md格式字符。\n\n题目：${copiedText}\n`;

            // 根据题目类型调整提示词（与自动答题逻辑一致）
            if (questionType === '简答题') {
                prompt += `\n请直接给出完整的答案内容，不要有任何限制。如果是程序题，请输出完整的、可运行的代码。如果是普通简答题，请给出详细的解答。不要有任何字数限制，直接输出答案内容：`;
            } else if (questionType === '填空题') {
                prompt += `请根据题目类型，给出最佳答案。答案格式为：\n填空题： 建议填充内容，如 "1"\n\n你的答案：`;
            } else {
                // 如果无法判断类型，默认按填空题处理
                prompt += `请根据题目，给出简洁的填充内容，不要带有md格式字符。\n\n你的答案：`;
            }

            ;

            // 调用AI获取答案（内部已自动清理Markdown格式）
            const context = questionContext(sourceRoot);
            const aiAnswer = await fetchDeepSeekAnswer(prompt, context);
            clearCopiedAnswer();
            window.copiedAIContext = context;
            window.copiedAIAnswer = aiAnswer;
            context.frameClicks = [];
            (context.root || document).querySelectorAll('iframe').forEach(frame => {
                const editor = answerFrameBody(frame);
                if (!editor) return;
                const frameDoc = editor.ownerDocument;
                const click = event => { if (editor.contains(event.target)) fillCopiedAnswer(frame); };
                frameDoc.addEventListener('click', click);
                context.frameClicks.push(() => frameDoc.removeEventListener('click', click));
            });
            document.body.style.cursor = 'pointer';

            ;

        } catch (error) {
            ;
            showAIToast('[AI答题] 获取答案失败：' + (error.message || '未知错误'), true);
            // 清除存储的答案
            clearCopiedAnswer();
        } finally {
            finishProcessing();
        }
    }

    function clearCopiedAnswer() {
        const context = window.copiedAIContext;
        if (context && context.frameClicks) context.frameClicks.forEach(remove => remove());
        window.copiedAIAnswer = null;
        window.copiedAIContext = null;
        document.body.style.cursor = 'default';
    }

    function fillCopiedAnswer(target) {
        const context = window.copiedAIContext;
        const answer = window.copiedAIAnswer;
        if (!context || !answer || !target.closest) return;
        const editor = target.closest('textarea,input:not([type]),input[type=text],input[type=search],input[type=email],input[type=url],input[type=tel],input[type=number],[contenteditable=true],iframe');
        if (!editor || !editor.getClientRects().length || editor.closest('.edui-toolbar,.edui-editor-toolbarbox') ||
            editor.tagName === 'IFRAME' && !answerFrameBody(editor)) return;
        if (context.root && context.root !== editor.closest('div.questionLi')) return;
        if (!context.validate() || window.__cefDeepSeek.fillText(editor, answer)) clearCopiedAnswer();
    }

    /**
     * 获取所有题目的AI答案
     */
    async function fetchAllAnswers(options = {}) {
        if (!answeringEnabled()) return;
        ;

        // 检查是否正在处理中
        if (isProcessing) {
            if (!options.failedOnly) rerunRequested = true;
            else reportStatus('当前题正在处理，请等待本轮结束后再重试', 'error');
            return;
        }

        // 设置处理状态
        isProcessing = true;

        // 检查API Key
        const config = getAIConfig();
        if (!config.apiKey && !window.__cefDeepSeek.status().bankAnswerEnabled) {
            ;
            showAIToast('[AI答题] 未配置 API Key：按 Ctrl+G 打开设置面板填写，或在 winmm.dll 同目录的 config.json 中配置。', true);
            if (!settingsDialogShown) {
                settingsDialogShown = true;
                openAISettingsDialog('尚未配置 API Key，AI 答题功能未启用。可在此粘贴 DeepSeek API Key，或改用 winmm.dll 同目录的 config.json 配置。');
            }
            isProcessing = false;
            return;
        }

        ;

        // 使用局部变量存储答案数据
        const epoch = runEpoch;
        const answersData = options.failedOnly ? Object.assign({}, window.aiAnswersData || {}) : {};

        const allQuestions = Array.from(document.querySelectorAll('div.questionLi'));
        const indexedQuestions = Array.from(allQuestions.entries());
        const questions = options.failedOnly ? indexedQuestions.filter(([, question]) => failedQuestions.has(retryKey(question))) : indexedQuestions;
        if (options.failedOnly && !questions.length) {
            reportStatus('没有可重试的失败题'); isProcessing = false; return;
        }
        if (questions.length === 0) {
            reportStatus('已启用 · 等待题目加载…');
            observeQuestions();
            isProcessing = false;
            return;
        }

        if (!options.failedOnly) clearProgress();
        reportStatus(`准备逐题识别，共 ${questions.length} 道…`);

        try {
            let filledCount = 0;
            let matchedCount = 0;
            // Strictly await and fill one question before the next request starts.
            for (let index = 0; index < questions.length; index++) {
                await waitForAnsweringPermission();
                if (!answeringEnabled() || epoch !== runEpoch) break;
                const [originalIndex, question] = questions[index];
                if (!question.isConnected) { rerunRequested = true; rerunForced = true; continue; }
                const failureKey = retryKey(question);
                const model = buildQuestionModel(question, originalIndex);
                if (!model) continue;
                if (options.failedOnly) model.data.__cefAIRetry = true;
                const questionText = compactQuestion(model.titleText);
                const manual = manualSaves.get(failureKey);
                if (manual) {
                    manual.progress = { key: model.key, index: originalIndex + 1, question: questionText };
                    answersData[model.key] = { manualSave: manual };
                    reportManualAnswer(question, manual);
                    continue;
                }
                const imageText = model.imageCount ? ` · ${model.imageCount} 张题图` : '';
                reportStatus(`正在处理第 ${index + 1}/${questions.length} 题…`);
                reportProgress({ key: model.key, root: question, index: originalIndex + 1, question: questionText,
                    answer: `正在识别${imageText}…`, state: 'pending' });
                try {
                    const ready = await fetchQuestionAnswer(model, epoch, result => {
                        answersData[model.key] = { ...result, root: question, type: model.type.name, typeCode: model.type.code,
                            targets: model.blankTargets, progressKey: model.key, progressIndex: originalIndex + 1, questionText };
                        window.aiAnswersData = answersData;
                        reportProgress({ key: model.key, root: question, index: originalIndex + 1, question: questionText,
                            answer: `${result.source}：${result.answer}${result.needsReview ? '（建议核对）' : ''}`, state: 'pending' });
                    });
                    if (!ready || !answeringEnabled() || epoch !== runEpoch) break;
                    const answerData = answersData[model.key];
                    const currentFill = await fillAnswersFromAI({ [model.key]: answerData }, [[originalIndex, question]]);
                    filledCount += currentFill.filledCount;
                    matchedCount += currentFill.matchedCount;
                    if (currentFill.matchedCount || answerData.skippedExisting || answerData.manualSave) failedQuestions.delete(failureKey);
                    else {
                        if (!question.isConnected) { rerunRequested = true; rerunForced = true; }
                        answerData.writeFailed = true; answerData.message = answerData.message || '页面控件回读不一致，未确认写入';
                        failedQuestions.add(failureKey);
                    }
                } catch (error) {
                    if (epoch !== runEpoch) break;
                    if (['STALE', 'STALE_CANVAS', 'STALE_EDIT'].includes(error.code) && !question.isConnected) {
                        rerunRequested = true; rerunForced = true;
                    }
                    if (error.code === 'STALE_EDIT') {
                        const entry = keepManualAnswer(question, { key: model.key, index: originalIndex + 1, question: questionText },
                            '输入已变化，保留手工答案');
                        answersData[model.key] = { manualSave: entry };
                        reportManualAnswer(question, entry);
                        failedQuestions.delete(failureKey);
                    } else {
                        failedQuestions.add(failureKey);
                        answersData[model.key] = {
                            error: true, message: error.message || '请求失败', type: model.type.name,
                            progressKey: model.key, progressIndex: originalIndex + 1, questionText
                        };
                        reportProgress({ key: model.key, root: question, index: originalIndex + 1, question: questionText,
                            answer: `失败：${error.message || '请求失败'}`, state: 'error' });
                    }
                }
                if (index < questions.length - 1 && !await waitBetweenQuestions(answerDelayMs(), index + 2, questions.length, epoch)) break;
            }

            if (epoch !== runEpoch) return;
            const allResults = Object.values(answersData);
            const failedResults = allResults.filter(item => item && (item.error || item.writeFailed));
            const skippedCount = allResults.filter(item => item && item.skippedExisting).length;
            const manualAnswers = allResults.filter(item => item && item.manualSave);
            const pendingSaves = manualAnswers.filter(item => item.manualSave.pending && item.manualSave.pending.size).length;
            window.aiAnswersData = answersData;
            const successCount = allResults.length - failedResults.length;
            if (pendingSaves && !failedResults.length) {
                reportStatus(`${pendingSaves} 道题已保留当前内容，请手动保存`, 'review');
            } else if (manualAnswers.length && !failedResults.length) {
                reportStatus(`已保留 ${manualAnswers.length} 道手工答案`, 'success');
            } else if (matchedCount > 0 && failedResults.length === 0) {
                reportStatus(`逐题处理完成：${matchedCount} 道，写入 ${filledCount} 项 · 请提交前核对`, 'success');
            } else if (matchedCount > 0) {
                reportStatus(`已逐题处理 ${matchedCount} 道，写入 ${filledCount} 项；${failedResults.length} 道失败`, 'error');
            } else if (skippedCount && !failedResults.length) {
                reportStatus(`按覆盖策略保留 ${skippedCount} 道已有答案`, 'success');
            } else if (successCount > 0) {
                reportStatus(`已得到 ${successCount} 道答案，但页面控件未匹配`, 'error');
            } else if (failedResults.length > 0) {
                const lastFailed = failedResults[failedResults.length - 1];
                reportStatus(failedResults.length + '/' + allResults.length + ' 道题目获取失败。' +
                    (lastFailed.message ? '最后错误：' + lastFailed.message : ''), 'error');
            }

        } catch (error) {
            ;

            // 获取答案失败，恢复鼠标指针
            document.body.style.cursor = 'default';

        } finally {
            // 重置处理状态
            finishProcessing();
            ;
        }
    }

    /**
     * 清理答案中的Markdown格式符号
     * @param {string} text - 需要清理的文本
     * @returns {string} - 清理后的文本
     */
    function cleanMarkdownFormat(text) {
        // Preserve code, quotes, decimal points and underscores. Do not run the
        // upstream destructive Markdown/quote/dot substitutions over answers.
        return String(text || '').trim();
    }

    /**
     * 向 DeepSeek API 发送请求获取答案
     */
    async function fetchDeepSeekAnswer(prompt, context) {
        const config = getAIConfig();
        if (!config.apiKey) throw new Error('未启用 AI 或未配置 Key，请按 Ctrl+G');
        return cleanMarkdownFormat(await window.__cefDeepSeek.requestText(prompt, context || {}));
    }

    /**
     * 根据AI答案数据填充到页面表单中
     */
    function editorHtml(value) {
        return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\r?\n/g, '<br>');
    }

    function editorText(value, read = editorNodeText) {
        const probe = document.createElement('div');
        probe.innerHTML = String(value == null ? '' : value);
        return read(probe);
    }

    const hasEditorMedia = node => !!node.querySelector('img,canvas,svg,video,audio,iframe,object,embed');

    function editorNodeText(node) {
        function read(current, last) {
            if (current.nodeType === 3) return current.nodeValue || '';
            if (current.nodeType !== 1) return '';
            if (current.tagName === 'BR') return '\n';
            const text = Array.from(current.childNodes).map((child, index, children) => read(child, last && index === children.length - 1)).join('');
            return !last && /^(P|DIV|LI|PRE|TR)$/.test(current.tagName) && !text.endsWith('\n') ? text + '\n' : text;
        }
        // textContent drops <br> and paragraph boundaries. innerText would
        // instead collapse indentation; walk the DOM to retain both.
        return read(node, true).replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
    }

    function dispatchValueEvents(node) {
        if (!node || !node.dispatchEvent) return;
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        node.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    function setFormValue(node, value) {
        if (!node || node.disabled || node.readOnly) return false;
        const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (!descriptor || !descriptor.set) return false;
        descriptor.set.call(node, value); dispatchValueEvents(node);
        return String(node.value) === String(value);
    }

    function readSaveTarget(target) {
        const selector = 'textarea,input[type=text],input:not([type]),[contenteditable=true],iframe';
        const fields = target.matches(selector) ? [target] : Array.from(target.querySelectorAll(selector));
        return JSON.stringify(fields.map(field => {
            if (field.tagName === 'IFRAME') {
                const body = answerFrameBody(field);
                return body && body.innerHTML;
            }
            return field.value == null ? field.innerHTML : field.value;
        }));
    }

    async function saveFilledQuestion(question, targets, epoch, allTargets, changed, bankDataRevision) {
        const buttons = [];
        const eligible = node => isSaveButton(node) && question.contains(node);
        function add(node) { if (eligible(node) && !buttons.includes(node)) buttons.push(node); }
        function liveButton(button) {
            if (button.isConnected) return question.contains(button) ? button : null;
            const replacement = button.id && document.getElementById(button.id);
            return replacement && question.contains(replacement) ? replacement : null;
        }
        const unavailable = button => button.disabled || button.getAttribute('aria-disabled') === 'true';
        targets.forEach(target => {
            const fields = target.matches('textarea,input') ? [target] : Array.from(target.querySelectorAll('textarea,input'));
            fields.forEach(field => {
                [field.id, field.getAttribute('name')].filter(Boolean).forEach(name => {
                    if (name.includes('answerEditor')) add(document.getElementById(name.replace('answerEditor', 'save_')));
                });
            });
        });
        if (!buttons.length) question.querySelectorAll(saveButtonSelector)
            .forEach(node => { if (eligible(node) && !Array.from(node.children).some(eligible)) add(node); });
        if (!buttons.length) return { clicked: false, reason: '内容已填入，但未找到本题保存按钮，请手动保存' };
        const pending = changed ? buttons : buttons.filter(button => !savedLabel.test(saveButtonLabel(button)));
        if (!pending.length) return { saved: true, clicked: false };
        const contents = allTargets.map(readSaveTarget);
        let checkedPause = answeringPaused ? -1 : pauseGeneration;
        // All blanks are written first, then each question-local save control is clicked once.
        await sleep(120);
        const current = () => question.isConnected && answeringEnabled() && epoch === runEpoch;
        for (const [index, original] of pending.entries()) {
            let waited = 0;
            let bankError = '';
            while (current()) {
                const button = liveButton(original);
                if (!button) break;
                if (answeringPaused) {
                    await waitForAnsweringPermission(); continue;
                }
                if (unavailable(button) && waited < 8000) { await sleep(200); waited += 200; continue; }
                if (bankDataRevision != null && checkedPause !== pauseGeneration) {
                    checkedPause = pauseGeneration;
                    try {
                        if (!await window.__cefDeepSeek.bankDataIsCurrent(bankDataRevision))
                            bankError = '暂停期间题库已变化，当前内容未保存，请核对后重试';
                    } catch (error) {
                        bankError = '题库复查失败，当前内容未保存：' + error.message;
                    }
                    if (bankError) break;
                    continue;
                }
                break;
            }
            if (!current() || allTargets.some(target => !question.contains(target))) return { clicked: false, reason: '保存前页面或设置发生变化，请核对本题' };
            if (allTargets.some((target, i) => readSaveTarget(target) !== contents[i]))
                return { clicked: false, manual: true, pending: new Set(pending.slice(index).map(button => saveButtonKey(liveButton(button) || button))),
                    reason: '保存前答案已修改，已保留当前内容，请手动保存' };
            if (bankError) return { clicked: false, reason: bankError };
            const button = liveButton(original);
            if (!button || unavailable(button))
                return { clicked: false, reason: '本题保存按钮不可用，请手动核对保存状态' };
            const before = saveButtonLabel(button);
            try { button.click(); } catch (_) { return { clicked: false, reason: '点击本题保存失败，请手动保存' }; }
            waited = 0;
            for (;;) {
                const live = liveButton(button), label = saveButtonLabel(live || button);
                if (label !== before || live && live !== button || waited >= 600) {
                    if (failedLabel.test(label)) return { clicked: false, reason: '页面提示保存失败，可重试保存' };
                    if (savedLabel.test(label)) break;
                }
                if (waited >= 600 && (!live || !unavailable(live) && !/保存中/.test(label))) break;
                if (waited >= 8600) return { clicked: false, reason: '已点击保存，但保存状态等待超时，请核对后重试' };
                await sleep(200); waited += 200;
            }
        }
        return { clicked: true };
    }

    function allowOverwrite(current) {
        if (!String(current || '').trim()) return true;
        const status = window.__cefDeepSeek.status && window.__cefDeepSeek.status();
        const policy = status && status.overwritePolicy || 'always';
        if (policy === 'empty-only') return false;
        if (policy === 'ask') {
            try { return window.confirm('此题已有内容，是否使用获取到的答案替换？'); }
            catch (_) { return false; }
        }
        return true;
    }

    function optionSelected(option) {
        return !!(option.matches('.check_answer,.check_answer_dx,[aria-checked=true]') ||
            option.querySelector('.check_answer,.check_answer_dx,input:checked,[aria-checked=true]'));
    }

    function selectOneOption(options, targetIndex) {
        const matches = () => options.every((option, index) => optionSelected(option) === (index === targetIndex));
        if (matches()) return { matched: true, changed: 0 };
        if (options.some(optionSelected) && !allowOverwrite('已有选项')) return { matched: false, changed: 0, skipped: true };
        try { options[targetIndex].click(); } catch (_) { /* Read back the selected option. */ }
        const matched = matches();
        return { matched, changed: matched ? 1 : 0 };
    }

    function syncMultipleChoices(options, desired) {
        const original = options.map(optionSelected);
        const expected = options.map((_, index) => desired.includes(String.fromCharCode(65 + index)));
        const matches = values => values.every((selected, index) => optionSelected(options[index]) === selected);
        if (matches(expected)) return { matched: true, changed: 0 };
        if (original.some(Boolean) && !allowOverwrite('已有选项')) return { matched: false, changed: 0, skipped: true };
        let changed = 0;
        try {
            options.forEach((option, index) => {
                if (optionSelected(option) !== expected[index]) { option.click(); changed++; }
            });
            if (matches(expected)) return { matched: true, changed };
        } catch (_) { /* Readback, not click success, decides the outcome. */ }
        // Best effort restoration if the host ignores clicks or rejects updates.
        options.forEach((option, index) => {
            try { if (optionSelected(option) !== original[index]) option.click(); } catch (_) {}
        });
        return { matched: false, changed: 0 };
    }

    function fillBlankTarget(target, value) {
        if (!target || !String(value).trim()) return false;
        value = String(value).replace(/\r\n?/g, '\n');
        const expected = value.replace(/\u00a0/g, ' ');
        const preserveSpacing = /\n|^\s|\s$| {2,}/.test(value);
        const textarea = target.tagName === 'TEXTAREA' ? target : target.querySelector && target.querySelector('textarea');
        const name = textarea && (textarea.getAttribute('name') || textarea.id);
        if (name && window.UE && typeof window.UE.getEditor === 'function') {
            try {
                const editor = window.UE.getEditor(name);
                if (editor && typeof editor.setContent === 'function') {
                    const oldHtml = typeof editor.getContent === 'function' ? editor.getContent() : editor.body && editor.body.innerHTML;
                    const read = () => typeof editor.getContent === 'function' ? editorText(editor.getContent()) : editor.body ? editorNodeText(editor.body) :
                        typeof editor.getContentTxt === 'function' ? String(editor.getContentTxt()).replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n') : null;
                    const current = read();
                    if (current == null || oldHtml == null) throw new Error('Editor cannot be safely read and restored');
                    if (current === expected) return 'present';
                    const occupied = current.trim() || editorText(oldHtml, hasEditorMedia);
                    if (!allowOverwrite(occupied)) return 'skipped-existing';
                    const oldWhiteSpace = editor.body && editor.body.style.whiteSpace;
                    let verified = false;
                    try {
                        editor.setContent(editorHtml(value));
                        if (editor.body && preserveSpacing) editor.body.style.whiteSpace = 'pre-wrap';
                        if (typeof editor.fireEvent === 'function') editor.fireEvent('contentchange');
                        if (typeof editor.sync === 'function') editor.sync();
                        dispatchValueEvents(textarea);
                        if (read() === expected) {
                            verified = true; return occupied ? 'overwritten' : 'filled';
                        }
                    } finally {
                        if (!verified) {
                            editor.setContent(oldHtml || '');
                            if (editor.body) editor.body.style.whiteSpace = oldWhiteSpace || '';
                            if (typeof editor.sync === 'function') editor.sync();
                        }
                    }
                    return false;
                }
            } catch (_) { /* Try the DOM/editor iframe path below. */ }
        }
        const frames = target.tagName === 'IFRAME' ? [target] : Array.from(target.querySelectorAll && target.querySelectorAll('iframe') || []);
        for (const frame of frames) {
            try {
                const body = answerFrameBody(frame);
                if (!body) continue;
                const current = editorNodeText(body);
                if (current === expected) return 'present';
                const occupied = current.trim() || hasEditorMedia(body);
                if (!allowOverwrite(occupied)) return 'skipped-existing';
                const oldHtml = body.innerHTML, oldWhiteSpace = body.style.whiteSpace, oldValue = textarea && textarea.value;
                let verified = false;
                try {
                    body.innerHTML = editorHtml(value); dispatchValueEvents(body);
                    if (preserveSpacing) body.style.whiteSpace = 'pre-wrap';
                    if (editorNodeText(body) !== expected) continue;
                    if ((textarea && !setFormValue(textarea, editorHtml(value))) || editorNodeText(body) !== expected) continue;
                    verified = true;
                    return occupied ? 'overwritten' : 'filled';
                } finally {
                    if (!verified) {
                        body.innerHTML = oldHtml; body.style.whiteSpace = oldWhiteSpace;
                        if (textarea) setFormValue(textarea, oldValue);
                    }
                }
            } catch (_) { /* Try a native form control below. */ }
        }
        const input = target.matches && target.matches('textarea,input') ? target : target.querySelector &&
            target.querySelector('textarea,input[type=text],input:not([type])');
        if (input && !input.hidden && input.type !== 'hidden' && input.getClientRects().length) {
            const current = input.value;
            if (current === value) return 'present';
            if (!allowOverwrite(current)) return 'skipped-existing';
            const oldValue = input.value;
            if (setFormValue(input, value)) { return current.trim() ? 'overwritten' : 'filled'; }
            setFormValue(input, oldValue);
        }
        const editable = target.isContentEditable ? target : target.querySelector && target.querySelector('[contenteditable=true]');
        if (editable) {
            const current = editorNodeText(editable);
            if (current === expected) return 'present';
            const occupied = current.trim() || hasEditorMedia(editable);
            if (!allowOverwrite(occupied)) return 'skipped-existing';
            const oldHtml = editable.innerHTML, oldWhiteSpace = editable.style.whiteSpace;
            if (preserveSpacing) editable.style.whiteSpace = 'pre-wrap';
            editable.textContent = value; dispatchValueEvents(editable);
            if (editorNodeText(editable) === expected) return occupied ? 'overwritten' : 'filled';
            editable.innerHTML = oldHtml; editable.style.whiteSpace = oldWhiteSpace;
        }
        return false;
    }

    async function fillAnswersFromAI(answersData = {}, questions = Array.from(document.querySelectorAll('div.questionLi')).entries()) {
        let filledCount = 0;
        let matchedCount = 0;
        const epoch = runEpoch;

        for (const [index, question] of questions) {
            if (epoch !== runEpoch || !answeringEnabled()) break;
            const questionHash = question.dataset.questionId || `q-${index}`;
            const answerData = answersData[questionHash];

            if (!answerData || answerData.error || manualSaves.has(retryKey(question)) || answerData.root !== question) continue;
            const state = answerData.answerState ? answerData.answerState() : answerData.validate && answerData.validate() ? '' : 'STALE';
            if (state) {
                const progress = { key: questionHash, index: index + 1, question: answerData.questionText || '' };
                if (state === 'STALE_EDIT') {
                    answerData.manualSave = keepManualAnswer(question, progress, '输入已变化，保留手工答案');
                    reportManualAnswer(question, answerData.manualSave);
                } else {
                    answerData.message = '题目或输入已变化';
                    reportProgress({ ...progress, root: question, answer: '未填入：' + answerData.message, state: 'error' });
                }
                continue;
            }

            const aiAnswer = answerData.answer;
            const aiAnswers = Array.isArray(answerData.answers) ? answerData.answers : [aiAnswer];
            const questionType = answerData.type;
            let matched = false;
            let progressAnswer = aiAnswer, writeFailure = '';

            if (questionType === '单选题' || questionType === '多选题') {
                const optionDivs = Array.from(question.querySelectorAll('div.answerBg'));
                const canonical = aiAnswers.join('').toUpperCase().replace(/[\s,，、]/g, '');
                if (!/^[A-Z]+$/.test(canonical) || (questionType === '单选题' && canonical.length !== 1) ||
                    Array.from(canonical).some(letter => letter.charCodeAt(0) - 65 >= optionDivs.length)) continue;
                const result = questionType === '多选题'
                    ? syncMultipleChoices(optionDivs, canonical.split(''))
                    : selectOneOption(optionDivs, canonical.charCodeAt(0) - 65);
                matched = result.matched; filledCount += result.changed;
                answerData.skippedExisting = result.skipped === true;
                progressAnswer = canonical + (result.skipped ? '（已有选项，按覆盖策略保留）' : !matched ? '（选项回读不一致，未确认写入）' : '');
            } else if (questionType === '判断题') {
                const optionDivs = Array.from(question.querySelectorAll('div.answerBg'));
                const judgeAnswer = window.__cefDeepSeek.judgeValue(aiAnswers[0]);
                const values = optionDivs.map(option => window.__cefDeepSeek.judgeValue(optionText(option)));
                const targetIndex = values.indexOf(judgeAnswer);
                if (judgeAnswer != null && values.length === 2 && values.includes(true) && values.includes(false) && targetIndex >= 0) {
                    const result = selectOneOption(optionDivs, targetIndex);
                    matched = result.matched; filledCount += result.changed;
                    answerData.skippedExisting = result.skipped === true;
                    if (result.skipped) progressAnswer += '（已有选项，按覆盖策略保留）';
                    else if (!matched) progressAnswer += '（判断选项回读不一致，未确认写入）';
                } else {
                    progressAnswer += '（页面判断选项无法映射为对/错，未写入）';
                }
            } else if (questionType === '填空题' || questionType === '简答题') {
                const targets = answerData.targets && answerData.targets.length ? answerData.targets : collectBlankTargets(question);
                if (!targets.length || targets.length !== aiAnswers.length) {
                    progressAnswer = `答案 ${aiAnswers.length} 项，页面空格 ${targets.length} 个，未写入`;
                } else {
                    const emptyOnly = window.__cefDeepSeek.status().overwritePolicy === 'empty-only';
                    const locked = targets.findIndex((target, i) => target.matches('input,textarea') && (target.disabled || target.readOnly) &&
                        !(emptyOnly && target.value.trim()) && target.value !== String(aiAnswers[i]).replace(/\r\n?/g, '\n'));
                    const writes = locked < 0 ? targets.map((target, i) => fillBlankTarget(target, aiAnswers[i])) : [];
                    const changed = writes.filter(result => result === 'filled' || result === 'overwritten').length;
                    answerData.skippedExisting = locked < 0 && writes.every(result => result === 'skipped-existing');
                    matched = locked < 0 && writes.every(Boolean) && !answerData.skippedExisting;
                    filledCount += changed;
                    progressAnswer = aiAnswers.map((answer, i) => writes[i] === 'skipped-existing' ? '（保留已有内容）' : answer).join('；');
                    if (locked >= 0) writeFailure = `第 ${locked + 1} 个填写位置不可写，本题未填入`;
                    else if (writes.some(result => !result)) {
                        const failed = writes.map((result, i) => result ? null : i + 1).filter(Boolean).join('、');
                        writeFailure = changed ? `已填入 ${changed} 项，第 ${failed} 项写入失败，请核对` : `第 ${failed} 项写入失败，本题未填入`;
                    }
                    if (writes.includes('overwritten')) progressAnswer += '（已替换原内容）';
                    if (matched) {
                        reportProgress({ key: answerData.progressKey || questionHash, root: question, index: answerData.progressIndex || index + 1,
                            question: answerData.questionText || '', answer: '内容已填入，正在点击保存…', state: 'pending' });
                        const saved = await saveFilledQuestion(question, targets.filter((_, i) => writes[i] !== 'skipped-existing'), epoch, targets, changed, answerData.bankDataRevision);
                        answerData.saveClicked = saved.clicked;
                        answerData.alreadySaved = saved.saved;
                        if (saved.manual) {
                            answerData.manualSave = keepManualAnswer(question,
                                { key: questionHash, index: index + 1, question: answerData.questionText || '' }, saved.reason, saved.pending);
                        }
                        if (!saved.clicked && !saved.saved) { matched = false; writeFailure = saved.reason; answerData.message = saved.reason; }
                    }
                }
            }
            if (matched) {
                matchedCount++;
                reportProgress({ key: answerData.progressKey || questionHash, root: question, index: answerData.progressIndex || index + 1,
                    question: answerData.questionText || '',
                    answer: `${answerData.source || 'DeepSeek'} · ${answerData.alreadySaved ? '答案已保存' : answerData.saveClicked ? '已填入并点击保存' : '已填入'}：${progressAnswer}${answerData.needsReview ? '（模型建议核对）' : ''}`,
                    state: answerData.needsReview ? 'review' : 'success' });
            } else if (answerData.skippedExisting) {
                reportProgress({ key: answerData.progressKey || questionHash, root: question, index: answerData.progressIndex || index + 1,
                    question: answerData.questionText || '', answer: '已有内容，按覆盖策略未替换', state: 'review' });
            } else {
                reportProgress({ key: answerData.progressKey || questionHash, root: question, index: answerData.progressIndex || index + 1,
                    question: answerData.questionText || '', answer: writeFailure || `未填入：${progressAnswer}`, state: answerData.manualSave ? 'review' : 'error' });
            }
        }

        ;

        // 填充完成后，恢复鼠标指针
        document.body.style.cursor = 'default';
        return { filledCount, matchedCount };
    }

    function selectedQuestion() {
        const selection = window.getSelection();
        let node = selection && selection.rangeCount ? selection.getRangeAt(0).commonAncestorContainer : null;
        if (node && node.nodeType !== 1) node = node.parentElement;
        return node && node.closest ? node.closest('div.questionLi') : null;
    }
    function questionContext(root) {
        const nodes = root ? Array.from(root.querySelectorAll('div.answerBg')) : [];
        return { root: root || null, options: nodes.map(optionText), $options: nodes };
    }
    window.__cxUpstreamAI = {
        sourceCommit: '3b534edae5208f1b3bdb256142491a6cd28de4a0',
        active: () => answeringEnabled() && isChaoxingExamPage(),
        fetchAllAnswers, handleCopyAIRequest, fillAnswersFromAI,
        start: restartAnswering,
        retryFailed: () => fetchAllAnswers({ failedOnly: true }),
        isPaused: () => answeringPaused,
        setPaused: setAnsweringPaused,
        togglePause: () => setAnsweringPaused(!answeringPaused)
    };
    // 立即初始化脚本（不等待DOMContentLoaded）
    ;
    initScript();
})();
