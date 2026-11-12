// Word question-bank reader. OOXML is data; no HTML or macros are executed.
(function (w) {
    'use strict';
    var W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    var A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    var R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    var M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
    var types = { '单选题': 'single', '选择题': 'single', '多选题': 'multiple', '判断题': 'boolean', '填空题': 'blank', '简答题': 'text', '问答题': 'text', '论述题': 'text', '编程题': 'text', '程序设计题': 'text' };
    var typeHeading = new RegExp('^\\s*(?:(?:第\\s*)?\\d+\\s*[.、．:：]\\s*)?[（(【\\[]\\s*(?:' + Object.keys(types).join('|') + ')(?:\\s*[,，]\\s*\\d+(?:[.．]\\d+)?\\s*分)?\\s*[）)】\\]]\\s*');
    var sectionHeading = /^\s*【\s*(?:背景(?:资料|材料)?|(?:案例|情境)(?:背景|资料|材料)?|(?:阅读)?材料|题干)\s*[:：]?\s*】\s*[:：]?\s*/;
    function stripStemHeadings(value) {
        var text = value.trim();
        for (;;) {
            var rest = text.replace(typeHeading, '').replace(sectionHeading, '');
            if (rest === text) return text;
            text = rest;
        }
    }
    function xml(bytes) {
        var text = cefBankZip.strFromU8(bytes);
        if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Word 文件包含不支持的 XML 实体');
        var result = new DOMParser().parseFromString(text, 'application/xml');
        if (result.getElementsByTagName('parsererror').length) throw new Error('Word 文档 XML 损坏');
        return result;
    }
    w.__cefParseBankDocx = function (bytes, filename, options) {
        var preview = !!(options && options.preview), errors = [], locations = [];
        var selectedBytes = 0;
        var files = cefBankZip.unzipSync(bytes, { filter: function (entry) {
            var selected = entry.name === 'word/document.xml' || entry.name === 'word/_rels/document.xml.rels' || /^word\/media\/[^/]+$/.test(entry.name);
            if (selected) {
                selectedBytes += entry.originalSize;
                if (entry.originalSize > 20 * 1024 * 1024 || selectedBytes > 32 * 1024 * 1024) throw new Error('Word 解压内容过大，请拆分导入');
            }
            return selected;
        } });
        if (!files['word/document.xml']) throw new Error('这不是有效的 DOCX 文件；旧版 .doc 请另存为 .docx');
        var documentXml = xml(files['word/document.xml']), relationships = {}, media = {}, imageIndex = 0;
        if (files['word/_rels/document.xml.rels']) {
            Array.prototype.forEach.call(xml(files['word/_rels/document.xml.rels']).documentElement.children, function (rel) {
                if (rel.getAttribute('TargetMode') === 'External') return;
                var target = rel.getAttribute('Target') || '';
                if (/^media\/[^/]+$/.test(target)) relationships[rel.getAttribute('Id')] = 'word/' + target;
            });
        }
        var warnings = [], paragraphs = [], references = [];
        function image(id, question) {
            var path = relationships[id], data = path && files[path];
            if (!data) throw new Error('文档中有无法读取的图片，请嵌入图片后重新保存 Word');
            if (!media[path]) {
                var mime = data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71 ? 'png' : data[0] === 255 && data[1] === 216 ? 'jpeg' :
                    data[0] === 71 && data[1] === 73 && data[2] === 70 ? 'gif' : data[0] === 82 && data[1] === 73 && data[8] === 87 && data[9] === 69 ? 'webp' : '';
                if (!mime) throw new Error('题图格式不支持，请把图片转为 PNG/JPEG 后保存 Word');
                if (data.length > 4 * 1024 * 1024) throw new Error('单张题图不能超过 4 MiB');
                var chunks = [];
                for (var i = 0; i < data.length; i += 8192) chunks.push(String.fromCharCode.apply(null, data.subarray(i, i + 8192)));
                media[path] = { id: 'img' + (++imageIndex), dataUrl: 'data:image/' + mime + ';base64,' + btoa(chunks.join('')) };
            }
            if (!question.images.some(function (item) { return item.id === media[path].id; })) question.images.push(media[path]);
            return '[图片:' + media[path].id + ']';
        }
        function reference(id) {
            // XML text cannot contain NUL. Resolve references only in lines assigned to a question.
            return '\0' + (references.push(id) - 1) + '\0';
        }
        function questionText(text, question, paragraph) {
            try {
                return text.replace(/\0(\d+)\0/g, function (_, index) {
                    var id = references[index];
                    if (id === false) throw new Error('Word 原生公式请转为 PNG/JPEG 并嵌入后重新导入');
                    return image(id, question);
                });
            } catch (error) {
                var message = 'Word 第 ' + paragraph + ' 段：' + error.message;
                if (!preview) throw new Error(message);
                question.parseError = question.parseError || message;
                return '';
            }
        }
        function read(node) {
            if (node.nodeType !== 1) return '';
            if (node.namespaceURI === W && node.localName === 't') return node.textContent;
            if (node.namespaceURI === W && (node.localName === 'br' || node.localName === 'cr')) return '\n';
            if (node.namespaceURI === W && node.localName === 'tab') return '\t';
            if (node.namespaceURI === A && node.localName === 'blip') return reference(node.getAttributeNS(R, 'embed'));
            if (node.localName === 'imagedata') return reference(node.getAttributeNS(R, 'id'));
            if (node.namespaceURI === W && node.localName === 'del') return '';
            if (node.namespaceURI === M && (node.localName === 'oMath' || node.localName === 'oMathPara')) return reference(false);
            return Array.prototype.map.call(node.childNodes, read).join('');
        }
        var body = documentXml.getElementsByTagNameNS(W, 'body')[0];
        if (!body) throw new Error('Word 文档没有正文');
        Array.prototype.forEach.call(body.getElementsByTagNameNS(W, 'p'), function (p, paragraphIndex) {
            var value = read(p).replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
            paragraphs.push({ text: value, number: paragraphIndex + 1 });
        });
        var questions = [], q = null, field = 'stem';
        function append(value) { q[field] = (q[field] ? q[field] + '\n' : '') + value; }
        function finish() {
            if (!q) return;
            var prefix = '第 ' + q.number + ' 题：';
            try {
            if (q.parseError) throw new Error(prefix + q.parseError);
            if (!q.stem.trim()) throw new Error(prefix + '题干为空');
            if (!q.rawAnswer.trim()) throw new Error(prefix + '缺少“答案：”');
            if (q.type === 'single' || q.type === 'multiple') {
                var letters = q.rawAnswer.replace(/[\s,，、;；]/g, '').toUpperCase();
                if (!/^[A-Z]+$/.test(letters) || new Set(letters).size !== letters.length || q.type === 'single' && letters.length !== 1 || q.type === 'multiple' && letters.length < 2 ||
                    Array.from(letters).some(function (id) { return !q.options.some(function (option) { return option.id === id; }); })) throw new Error(prefix + '答案与选项不匹配');
                q.answer = Array.from(letters);
            } else if (q.type === 'boolean') {
                var token = q.rawAnswer.trim().toLowerCase();
                if (/^(对|正确|是|true|t|√|✓)$/.test(token)) q.answer = true;
                else if (/^(错|错误|否|false|f|×|✗)$/.test(token)) q.answer = false;
                else throw new Error(prefix + '判断题答案无法识别');
                q.options = [];
            } else if (q.type === 'blank') {
                var numbered = /(^|[；;\s]+)[（(]\s*(\d+)\s*[）)]/g, candidates = Array.from(q.rawAnswer.matchAll(numbered)), matches = [], parts;
                if (candidates.length && candidates[0].index === 0 && Number(candidates[0][2]) === 1) {
                    matches.push(candidates[0]);
                    var labels = new Map();
                    candidates.slice(1).forEach(function (match) {
                        var number = Number(match[2]), previous = labels.get(number);
                        if (!previous || /[；;\r\n]/.test(match[1]) && !/[；;\r\n]/.test(previous[1])) labels.set(number, match);
                    });
                    for (var number = 2, label; (label = labels.get(number)) && label.index > matches[matches.length - 1].index; number++) {
                        matches.push(label);
                    }
                }
                if (matches.length) parts = matches.map(function (match, i) { return q.rawAnswer.slice(match.index + match[0].length, i + 1 < matches.length ? matches[i + 1].index : undefined).replace(/[；;\s]+$/, '').trim(); });
                else parts = q.rawAnswer.split(/[；;]/).map(function (part) { return part.trim(); });
                if (parts.some(function (part) { return !part; })) throw new Error(prefix + '填空答案为空');
                q.answer = parts.map(function (part) { return [part]; });
                var blanks = (q.stem.match(/_{2,}/g) || []).length;
                if (blanks && blanks !== parts.length) warnings.push(prefix + blanks + ' 个空但答案为 ' + parts.length + ' 组，保留原答案供核对，自动答题将跳过空数不符的题');
            } else q.answer = q.rawAnswer.replace(/\n[\s]*$/, '');
            } catch (error) {
                if (!preview) throw error;
                errors.push({ index: questions.length + 1, error: error.message }); q.answer = null;
            }
            locations.push({ number: q.number, paragraph: q.paragraph });
            delete q.number; delete q.paragraph; delete q.parseError; delete q.rawAnswer; questions.push(q); q = null;
        }
        paragraphs.forEach(function (paragraph) {
            var lines = paragraph.text.split('\n');
            lines.forEach(function (line) {
                var text = line.trim(), preserveIndent = q && q.type === 'text' && field === 'rawAnswer';
                if (!text && !preserveIndent) return;
                var heading = /^(\d+)\s*[.、．]\s*【([^】]+)】\s*(.*)$/.exec(text);
                if (heading) {
                    finish();
                    if (!types[heading[2]] && !preview) throw new Error('第 ' + heading[1] + ' 题：不支持题型 ' + heading[2]);
                    q = { number: heading[1], paragraph: paragraph.number, type: types[heading[2]] || heading[2], stem: '', options: [], rawAnswer: '', explanation: '', tags: [], images: [] };
                    q.stem = stripStemHeadings(questionText(heading[3], q, paragraph.number));
                    if (!types[heading[2]]) q.parseError = '不支持题型 ' + heading[2];
                    field = 'stem';
                } else if (!q) return;
                else if (/^(?:答案解析|解析)\s*[:：]/.test(text)) { field = 'explanation'; append(questionText(text.replace(/^(?:答案解析|解析)\s*[:：]\s*/, ''), q, paragraph.number)); }
                else if (/^(?:正确答案|参考答案|答案)\s*[:：]/.test(text)) {
                    field = 'rawAnswer';
                    var answer = line.replace(/^\s*(?:正确答案|参考答案|答案)\s*[:：]/, '');
                    append(questionText(q.type === 'text' ? answer.replace(/^ (?=\S)/, '') : answer.trim(), q, paragraph.number));
                }
                else if (/^(?:难易程度|难易度|难度|课程目标|标签|知识点)\s*[:：]/.test(text)) { field = 'ignored'; }
                else {
                    var option = /^([A-Z])[.、．]\s*(.*)$/.exec(text);
                    if (option && field !== 'rawAnswer' && field !== 'explanation' && ['single', 'multiple', 'boolean'].indexOf(q.type) >= 0) {
                        if (q.options.some(function (o) { return o.id === option[1]; })) {
                            if (!preview) throw new Error('第 ' + q.number + ' 题：选项编号重复');
                            q.parseError = '选项编号重复';
                        }
                        q.options.push({ id: option[1], text: questionText(option[2], q, paragraph.number) }); field = 'option';
                    } else if (field === 'option') q.options[q.options.length - 1].text += '\n' + questionText(text, q, paragraph.number);
                    else if (field !== 'ignored') append(questionText(preserveIndent ? line : text, q, paragraph.number));
                }
            });
        });
        finish();
        if (!questions.length) throw new Error('未找到“1.【单选题】题干”格式的题目');
        questions.forEach(function (item) { delete item.ignored; if (!item.images.length) delete item.images; });
        return { payload: { schemaVersion: 1, name: filename.replace(/\.docx$/i, ''), questions: questions }, warnings: warnings, errors: errors, locations: locations };
    };
    w.__cefParseBankDocx.stripStemHeadings = stripStemHeadings;
})(window);
