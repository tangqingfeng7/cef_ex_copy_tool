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
    function getAIConfig() {
        const status = window.__cefDeepSeek.status();
        return { apiKey: status.enabled && status.configured ? '[dll-configured]' : '', source: 'DLL目录 config.json' };
    }

    // 设置面板是否已自动弹出过（避免每次自动获取答案都弹出）
    let settingsDialogShown = false;
    let autoTimer = null;
    let autoObserver = null;
    let rerunRequested = false;
    let rerunForced = false;
    let lastRequestedSignature = '';
    let imageLoadListenerInstalled = false;

    function reportStatus(message, state) {
        if (window.__cefDeepSeek.reportStatus) window.__cefDeepSeek.reportStatus(message, state);
    }

    function questionSignature() {
        const questions = Array.from(document.querySelectorAll('div.questionLi'));
        if (!questions.length) return '';
        return questions.map((question, index) => {
            const title = question.querySelector('h3.mark_name');
            const images = Array.from(question.querySelectorAll('img')).map(img => [
                img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || '',
                !!img.complete, img.naturalWidth || 0, img.naturalHeight || 0
            ].join(':')).join('|');
            return `${question.dataset.questionId || index}:${title ? title.textContent.trim() : ''}:${collectBlankTargets(question).length}:${images}`;
        }).join('\n');
    }

    function observeQuestions() {
        if (autoObserver || !document.documentElement) return;
        autoObserver = new MutationObserver(() => {
            if (!window.__cefDeepSeek.enabled() || !questionSignature()) return;
            scheduleAutoAnswer(false, 120);
        });
        autoObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-url'] });
        if (!imageLoadListenerInstalled) {
            imageLoadListenerInstalled = true;
            document.addEventListener('load', event => {
                if (event.target && event.target.tagName === 'IMG' && window.__cefDeepSeek.enabled()) scheduleAutoAnswer(false, 50);
            }, true);
        }
    }

    function scheduleAutoAnswer(force, delay = 0) {
        if (!window.__cefDeepSeek.enabled()) return;
        observeQuestions();
        if (autoTimer) clearTimeout(autoTimer);
        autoTimer = setTimeout(() => {
            autoTimer = null;
            requestAutoAnswer(!!force);
        }, delay);
    }

    function requestAutoAnswer(force) {
        if (!window.__cefDeepSeek.enabled()) return;
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

    // All notices stay inside the Ctrl+G panel. Do not cover the exam page with
    // a centered toast while the user is reading or filling an answer.
    function showAIToast(message, isError) {
        reportStatus(String(message || '').replace(/^\[AI答题\]\s*/, ''), isError ? 'error' : 'success');
    }

    function reportProgress(item) {
        if (window.__cefDeepSeek.progress) window.__cefDeepSeek.progress(item);
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

    function collectBlankTargets(question) {
        const targets = [];
        Array.from(question.querySelectorAll('textarea')).forEach(node => {
            addUnique(targets, node.closest('.eidtDiv,.textDIV,.Cy_ulTk li,.fill_blank') || node);
        });
        Array.from(question.querySelectorAll('iframe,[contenteditable=true],input[type=text],input:not([type])')).forEach(node => {
            if (!targets.some(target => target === node || target.contains(node)))
                addUnique(targets, node.closest('.eidtDiv,.textDIV,.Cy_ulTk li,.fill_blank') || node);
        });
        return targets;
    }

    function detectQuestionType(question, titleText, blankTargets, optionNodes) {
        // Some Chaoxing banks wrap a fill-in prompt in a generic "简答题"
        // container while the actual stem explicitly says [填空题]. The stem
        // marker is more specific than the host container metadata.
        if (/\[\s*填空题\s*\]|【\s*填空题\s*】/.test(titleText)) return { name: '填空题', code: 2 };
        const named = question.querySelector('input[name^="type"],input[name^="answertype"],input[class^="que-type"]');
        const parsed = named && Number(named.value);
        if (Number.isFinite(parsed)) {
            if (parsed === 0 || parsed === 66) return { name: '单选题', code: parsed };
            if (parsed === 1) return { name: '多选题', code: 1 };
            if (parsed === 2) return { name: '填空题', code: 2 };
            if (parsed === 3) return { name: '判断题', code: 3 };
            if ([4, 5, 6, 7, 8].includes(parsed)) return { name: '简答题', code: 4 };
        }
        if (titleText.includes('多选题')) return { name: '多选题', code: 1 };
        if (titleText.includes('判断题')) return { name: '判断题', code: 3 };
        if (titleText.includes('填空题') || blankTargets.length > 1) return { name: '填空题', code: 2 };
        if (titleText.includes('简答题') || blankTargets.length === 1) return { name: '简答题', code: 4 };
        return { name: '单选题', code: optionNodes.length > 0 ? 0 : 4 };
    }

    function buildQuestionModel(question, index) {
        const titleElement = question.querySelector('h3.mark_name,h3,.mark_name');
        if (!titleElement) return null;
        const titleText = titleElement.textContent.trim();
        const optionNodes = Array.from(question.querySelectorAll('div.answerBg'));
        const blankTargets = collectBlankTargets(question);
        const type = detectQuestionType(question, titleText, blankTargets, optionNodes);
        const options = optionNodes.map(option => {
            const content = option.querySelector('div.clearfix,.answer_p') || option;
            return content.textContent.trim();
        });
        const targets = type.code === 2 || type.code === 4 ? blankTargets : optionNodes;
        const data = { question: titleText, options, type: type.code, root: question, $options: targets };
        return { question, index, key: question.dataset.questionId || `q-${index}`, titleText, optionNodes, blankTargets, type, data,
            imageCount: question.querySelectorAll('img,canvas').length };
    }

    async function fetchQuestionAnswer(model) {
        const result = await window.__cefDeepSeek.answer(model.data);
        const answers = result && result.list && Array.isArray(result.list[0]) ? result.list[0].map(cleanMarkdownFormat) : [];
        if (!answers.length) throw new Error('AI 未返回可用答案');
        return { answers, answer: model.type.code === 0 || model.type.code === 1 || model.type.code === 66 ? answers.join('') : answers.join('；'),
            validate: model.data.__cefAIValidate, needsReview: result.needsReview === true };
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
            window.aiAnswersData = null; window.copiedAIAnswer = null; window.copiedAIContext = null;
            document.body.style.cursor = 'default';
        });
        document.addEventListener('cef-ai-config-changed', function () {
            window.aiAnswersData = null; window.copiedAIAnswer = null; window.copiedAIContext = null;
            lastRequestedSignature = '';
            scheduleAutoAnswer(true);
        });
        ;

        // 监听鼠标中键 - 填充AI答案
        document.addEventListener('mousedown', function(event) {
            if (event.button === 1) { // 鼠标中键
                event.preventDefault();
                ;

                if (window.aiAnswersData && Object.keys(window.aiAnswersData).length > 0) {
                    ;
                    fillAnswersFromAI(window.aiAnswersData);
                    // 填充后清除数据
                    window.aiAnswersData = null;
                } else {
                    ;
                    lastRequestedSignature = '';
                    scheduleAutoAnswer(true);
                }
            }
        });

        // 监听复制操作 - 用户复制内容后自动获取AI答案
        let lastClipboardText = '';

        // 方式1: 监听copy事件
        document.addEventListener('copy', async function(event) {
            if (!window.__cefDeepSeek.enabled()) return;
            const sourceRoot = selectedQuestion();
            // 延迟读取剪贴板，确保复制操作已完成
            setTimeout(async () => {
                try {
                    const clipboardText = await navigator.clipboard.readText();
                    const copiedText = clipboardText.trim();

                    // 检查内容是否变化，避免重复处理
                    if (copiedText && copiedText.length > 0 && copiedText !== lastClipboardText) {
                        lastClipboardText = copiedText;
                        ;
                        // 自动获取AI答案
                        await handleCopyAIRequest(copiedText, sourceRoot);
                    }
                } catch (error) {
                    ;
                }
            }, 150); // 延迟150ms确保复制完成
        });

        // 方式2: 监听Ctrl+C快捷键（备用方式，提高兼容性）
        document.addEventListener('keydown', async function(event) {
            if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'c' && window.__cefDeepSeek.enabled()) {
                const sourceRoot = selectedQuestion();
                // 延迟读取剪贴板
                setTimeout(async () => {
                    try {
                        const clipboardText = await navigator.clipboard.readText();
                        const copiedText = clipboardText.trim();

                        // 检查内容是否变化，避免重复处理
                        if (copiedText && copiedText.length > 0 && copiedText !== lastClipboardText) {
                            lastClipboardText = copiedText;
                            ;
                            // 自动获取AI答案
                            await handleCopyAIRequest(copiedText, sourceRoot);
                        }
                    } catch (error) {
                        ;
                        // 如果剪贴板API不可用，尝试使用选中的文本
                        const selectedText = window.getSelection().toString().trim();
                        if (selectedText && selectedText.length > 0 && selectedText !== lastClipboardText) {
                            lastClipboardText = selectedText;
                            ;
                            await handleCopyAIRequest(selectedText, sourceRoot);
                        }
                    }
                }, 150);
            }
        });

        // 监听点击事件 - 当用户点击输入框时自动填充答案
        document.addEventListener('click', function(event) {
            if (event.composedPath && event.composedPath().some(node => node.id === 'cef-deepseek-settings')) return;
            const targetElement = event.target;

            // 延迟执行，确保元素已获得焦点
            setTimeout(() => {
                // 使用点击的目标元素，因为activeElement在iframe情况下可能不准确
                const elementToFill = targetElement;

                // 如果有存储的答案
                if (elementToFill && elementToFill !== document.body && window.copiedAIAnswer) {
                    // 尝试填充答案（使用与自动答题相同的逻辑）
                    const context = window.copiedAIContext;
                    if (!context || !context.validate || !context.validate()) { window.copiedAIAnswer = null; document.body.style.cursor = 'default'; return; }
                    const targetRoot = elementToFill.closest && elementToFill.closest('div.questionLi');
                    if (context.root && context.root !== targetRoot) return;
                    const answerToFill = window.copiedAIAnswer;
                    const filled = fillToInputElementForChaoxing(elementToFill, answerToFill);

                    if (filled) {
                        ;

                        // 填充后清除存储的答案，恢复鼠标指针
                        window.copiedAIAnswer = null;
                        document.body.style.cursor = 'default';
                        ;
                    } else {
                        // 如果超星填充方式失败，使用通用填充方式
                        ;
                        const activeElement = document.activeElement;
                        if (activeElement && activeElement !== document.body) {
                            fillToInputElement(activeElement, answerToFill);
                            // 清除缓存
                            window.copiedAIAnswer = null;
                            document.body.style.cursor = 'default';
                        }
                    }
                }
            }, 50);
        });

        // 页面加载后自动获取答案
        ;
        if (window.__cefDeepSeek.enabled()) scheduleAutoAnswer(true);

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
            window.copiedAIContext = context;

            ;

            // 存储答案到全局变量
            window.copiedAIAnswer = aiAnswer;

            // 改变鼠标指针为指针样式（表示答案已准备好，可以点击输入框填充）
            document.body.style.cursor = 'pointer';

            ;

        } catch (error) {
            ;
            showAIToast('[AI答题] 获取答案失败：' + (error.message || '未知错误'), true);
            // 清除存储的答案
            window.copiedAIAnswer = null;
        } finally {
            isProcessing = false;
        }
    }

    /**
     * 专门用于超星学习通的填充函数（按照原有自动答题的填充逻辑）
     * 查找题目容器内的iframe和p标签进行填充
     * @param {Element} element - 用户点击的元素
     * @param {string} answer - 要填充的答案
     * @returns {boolean} - 是否成功填充
     */
    function fillToInputElementForChaoxing(element, answer) {
        if (!element || !answer) return false;
        if (window.__cefDeepSeek.fillText(element, answer)) return true;
        const question = element.closest && element.closest('div.questionLi');
        return !!question && window.__cefDeepSeek.fillText(question, answer);
    }

    /**
     * 将答案填充到用户点击的元素（通用填充函数，支持所有可输入元素）
     * @param {Element} element - 目标元素（用户点击的元素）
     * @param {string} answer - 要填充的答案
     */
    function fillToInputElement(element, answer) {
        return window.__cefDeepSeek.fillText(element, answer);
    }

    /**
     * 获取所有题目的AI答案
     */
    async function fetchAllAnswers() {
        if (!window.__cefDeepSeek.enabled()) return;
        ;

        // 检查是否正在处理中
        if (isProcessing) {
            rerunRequested = true;
            return;
        }

        // 设置处理状态
        isProcessing = true;

        // 检查API Key
        const config = getAIConfig();
        if (!config.apiKey) {
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
        const answersData = {};

        const questions = Array.from(document.querySelectorAll('div.questionLi'));
        if (questions.length === 0) {
            reportStatus('已启用 · 等待题目加载…');
            observeQuestions();
            isProcessing = false;
            return;
        }

        clearProgress();
        reportStatus(`准备逐题识别，共 ${questions.length} 道…`);

        try {
            let filledCount = 0;
            let matchedCount = 0;
            // Strictly await and fill one question before the next request starts.
            for (let index = 0; index < questions.length; index++) {
                const question = questions[index];
                const model = buildQuestionModel(question, index);
                if (!model) continue;
                const questionText = compactQuestion(model.titleText);
                const imageText = model.imageCount ? ` · ${model.imageCount} 张题图` : '';
                reportStatus(`正在处理第 ${index + 1}/${questions.length} 题…`);
                reportProgress({ key: model.key, index: index + 1, question: questionText,
                    answer: `正在识别${imageText}…`, state: 'pending' });
                try {
                    const result = await fetchQuestionAnswer(model);
                    const answerData = {
                        answer: result.answer, answers: result.answers, root: question, validate: result.validate,
                        type: model.type.name, typeCode: model.type.code, targets: model.blankTargets,
                        progressKey: model.key, progressIndex: index + 1, questionText, needsReview: result.needsReview
                    };
                    answersData[model.key] = answerData;
                    window.aiAnswersData = answersData;
                    reportProgress({ key: model.key, index: index + 1, question: questionText,
                        answer: `已识别：${result.answer}${result.needsReview ? '（建议核对）' : ''}`, state: 'pending' });
                    const currentFill = fillAnswersFromAI({ [model.key]: answerData });
                    filledCount += currentFill.filledCount;
                    matchedCount += currentFill.matchedCount;
                } catch (error) {
                    answersData[model.key] = {
                        error: true, message: error.message || '请求失败', type: model.type.name,
                        progressKey: model.key, progressIndex: index + 1, questionText
                    };
                    reportProgress({ key: model.key, index: index + 1, question: questionText,
                        answer: `失败：${error.message || '请求失败'}`, state: 'error' });
                }
            }

            const allResults = Object.values(answersData);
            const failedResults = allResults.filter(item => item && item.error);
            window.aiAnswersData = answersData;
            const successCount = allResults.length - failedResults.length;
            if (matchedCount > 0 && failedResults.length === 0) {
                reportStatus(`逐题处理完成：${matchedCount} 道，写入 ${filledCount} 项 · 请提交前核对`, 'success');
            } else if (matchedCount > 0) {
                reportStatus(`已逐题处理 ${matchedCount} 道，写入 ${filledCount} 项；${failedResults.length} 道失败`, 'error');
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
            isProcessing = false;
            if (rerunRequested && window.__cefDeepSeek.enabled()) {
                const force = rerunForced;
                rerunRequested = false;
                rerunForced = false;
                scheduleAutoAnswer(force);
            }
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

    function fillBlankTarget(target, value) {
        if (!target || !String(value).trim()) return false;
        const textarea = target.tagName === 'TEXTAREA' ? target : target.querySelector && target.querySelector('textarea');
        const name = textarea && textarea.getAttribute('name');
        if (name && window.UE && typeof window.UE.getEditor === 'function') {
            try {
                const editor = window.UE.getEditor(name);
                const current = editor && typeof editor.getContentTxt === 'function' ? editor.getContentTxt().trim() : '';
                if (current) return current === String(value).trim() ? 'present' : false;
                if (editor && typeof editor.setContent === 'function') {
                    editor.setContent(editorHtml(value));
                    if (typeof editor.fireEvent === 'function') editor.fireEvent('contentchange');
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    textarea.dispatchEvent(new Event('change', { bubbles: true }));
                    const save = document.getElementById(name.replace('answerEditor', 'save_'));
                    if (save) save.click();
                    return 'filled';
                }
            } catch (_) { /* Try the DOM/editor iframe path below. */ }
        }
        return window.__cefDeepSeek.fillText(target, value) ? 'filled' : false;
    }

    function fillAnswersFromAI(answersData = {}) {
        ;
        ;

        const questions = document.querySelectorAll('div.questionLi');

        if (questions.length === 0) {
            ;
            return { filledCount: 0, matchedCount: 0 };
        }

        ;

        let filledCount = 0;
        let matchedCount = 0;

        questions.forEach((question, index) => {
            const questionHash = question.dataset.questionId || `q-${index}`;
            const answerData = answersData[questionHash];

            if (!answerData || answerData.error || answerData.root !== question || !answerData.validate || !answerData.validate()) {
                return;
            }

            const aiAnswer = answerData.answer;
            const aiAnswers = Array.isArray(answerData.answers) ? answerData.answers : [aiAnswer];
            const questionType = answerData.type;
            let matched = false;
            let progressAnswer = aiAnswer;

            if (questionType === '单选题' || questionType === '多选题') {
                const optionDivs = question.querySelectorAll('div.answerBg');
                const canonical = aiAnswers.join('').toUpperCase().replace(/[\s,，、]/g, '');
                if (!/^[A-Z]+$/.test(canonical) || (questionType === '单选题' && canonical.length !== 1) ||
                    Array.from(canonical).some(letter => letter.charCodeAt(0) - 65 >= optionDivs.length)) return;
                const answerLetters = Array.from(new Set(canonical.split('')));

                answerLetters.forEach(letter => {
                    const optionIndex = letter.charCodeAt(0) - 65; // A=0, B=1, C=2, D=3

                    if (optionIndex >= 0 && optionIndex < optionDivs.length) {
                        const targetDiv = optionDivs[optionIndex];

                        // 检查选项是否已经被选择（通过查找check_answer_dx或check_answer类）
                        const isAlreadySelected = targetDiv.querySelector('.check_answer_dx') !== null ||
                            targetDiv.querySelector('.check_answer') !== null;

                        if (!isAlreadySelected) {
                            // 直接点击整个answerBg div来选择选项
                            try {
                                targetDiv.click();
                                filledCount++;
                            } catch (error) {
                                // 静默处理错误
                            }
                        }
                    }
                });
                matched = optionDivs.length > 0;
                progressAnswer = canonical;
            } else if (questionType === '判断题') {
                const optionDivs = question.querySelectorAll('div.answerBg');
                const judgeAnswer = String(aiAnswers[0] || '').trim();
                if (!/^(对|错|正确|错误|true|false|√|×)$/i.test(judgeAnswer)) return;
                const isCorrect = /^(对|正确|true|√)$/i.test(judgeAnswer);
                const targetIndex = isCorrect ? 0 : 1; // 对=0, 错=1

                if (targetIndex < optionDivs.length) {
                    const targetDiv = optionDivs[targetIndex];

                    // 检查选项是否已经被选择（通过查找check_answer_dx或check_answer类）
                    const isAlreadySelected = targetDiv.querySelector('.check_answer_dx') !== null ||
                        targetDiv.querySelector('.check_answer') !== null;

                    if (!isAlreadySelected) {
                        // 直接点击整个answerBg div来选择判断选项
                        try {
                            targetDiv.click();
                            filledCount++;
                        } catch (error) {
                            // 静默处理错误
                        }
                    }
                    matched = true;
                }
            } else if (questionType === '填空题' || questionType === '简答题') {
                const targets = answerData.targets && answerData.targets.length ? answerData.targets : collectBlankTargets(question);
                if (!targets.length || targets.length !== aiAnswers.length) {
                    progressAnswer = `答案 ${aiAnswers.length} 项，页面空格 ${targets.length} 个，未写入`;
                } else {
                    const writes = targets.map((target, targetIndex) => fillBlankTarget(target, aiAnswers[targetIndex]));
                    matched = writes.every(Boolean);
                    filledCount += writes.filter(result => result === 'filled').length;
                    progressAnswer = aiAnswers.join('；');
                }
            }
            if (matched) {
                matchedCount++;
                reportProgress({ key: answerData.progressKey || questionHash, index: answerData.progressIndex || index + 1,
                    question: answerData.questionText || '',
                    answer: `已填入：${progressAnswer}${answerData.needsReview ? '（模型建议核对）' : ''}`,
                    state: answerData.needsReview ? 'review' : 'success' });
            } else {
                reportProgress({ key: answerData.progressKey || questionHash, index: answerData.progressIndex || index + 1,
                    question: answerData.questionText || '', answer: `未填入：${progressAnswer}`, state: 'error' });
            }
        });

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
        return { root: root || null, options: nodes.map(node => node.textContent.trim()), $options: nodes };
    }
    window.__cxUpstreamAI = {
        sourceCommit: '3b534edae5208f1b3bdb256142491a6cd28de4a0',
        active: () => window.__cefDeepSeek.enabled() && isChaoxingExamPage(),
        fetchAllAnswers, handleCopyAIRequest, fillAnswersFromAI
    };
    // 立即初始化脚本（不等待DOMContentLoaded）
    ;
    initScript();
})();
