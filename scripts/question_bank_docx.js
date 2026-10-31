// Word question-bank reader. OOXML is data; no HTML or macros are executed.
(function (w) {
    'use strict';
    var W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    var A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    var R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    function xml(bytes) {
        var text = cefBankZip.strFromU8(bytes);
        if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Word 文件包含不支持的 XML 实体');
        var result = new DOMParser().parseFromString(text, 'application/xml');
        if (result.getElementsByTagName('parsererror').length) throw new Error('Word 文档 XML 损坏');
        return result;
    }
    w.__cefParseBankDocx = function (bytes, filename) {
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
        var warnings = [], paragraphs = [], currentImages = [];
        function image(id) {
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
            if (!currentImages.some(function (item) { return item.id === media[path].id; })) currentImages.push(media[path]);
            return '[图片:' + media[path].id + ']';
        }
        function read(node) {
            if (node.nodeType !== 1) return '';
            if (node.namespaceURI === W && node.localName === 't') return node.textContent;
            if (node.namespaceURI === W && (node.localName === 'br' || node.localName === 'cr')) return '\n';
            if (node.namespaceURI === W && node.localName === 'tab') return '\t';
            if (node.namespaceURI === A && node.localName === 'blip') return image(node.getAttributeNS(R, 'embed'));
            if (node.localName === 'imagedata') return image(node.getAttributeNS(R, 'id'));
            if (node.namespaceURI === W && node.localName === 'del') return '';
            return Array.prototype.map.call(node.childNodes, read).join('');
        }
        var body = documentXml.getElementsByTagNameNS(W, 'body')[0];
        if (!body) throw new Error('Word 文档没有正文');
        Array.prototype.forEach.call(body.getElementsByTagNameNS(W, 'p'), function (p) {
            currentImages = [];
            var value = read(p).replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').trim();
            if (value) paragraphs.push({ text: value, images: currentImages.slice() });
        });
        var questions = [], q = null, field = 'stem';
        var types = { '单选题': 'single', '选择题': 'single', '多选题': 'multiple', '判断题': 'boolean', '填空题': 'blank', '简答题': 'text', '问答题': 'text', '论述题': 'text', '编程题': 'text' };
        function append(value) { q[field] = (q[field] ? q[field] + '\n' : '') + value; }
        function finish() {
            if (!q) return;
            var prefix = '第 ' + q.number + ' 题：';
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
                var numbered = /[（(]\s*\d+\s*[）)]\s*/g, matches = Array.from(q.rawAnswer.matchAll(numbered)), parts;
                if (matches.length) parts = matches.map(function (match, i) { return q.rawAnswer.slice(match.index + match[0].length, i + 1 < matches.length ? matches[i + 1].index : undefined).replace(/[；;\s]+$/, '').trim(); });
                else parts = q.rawAnswer.split(/[；;]/).map(function (part) { return part.trim(); });
                if (parts.some(function (part) { return !part; })) throw new Error(prefix + '填空答案为空');
                q.answer = parts.map(function (part) { return [part]; });
                var blanks = (q.stem.match(/_{2,}/g) || []).length;
                if (blanks && blanks !== parts.length) warnings.push(prefix + blanks + ' 个空但答案为 ' + parts.length + ' 组，保留原答案供核对，自动答题将跳过空数不符的题');
            } else q.answer = q.rawAnswer;
            delete q.number; delete q.rawAnswer; questions.push(q); q = null;
        }
        paragraphs.forEach(function (paragraph) {
            var lines = paragraph.text.split('\n');
            lines.forEach(function (line) {
                var heading = /^\s*(\d+)\s*[.、．]\s*【([^】]+)】\s*(.*)$/.exec(line);
                if (heading) {
                    finish();
                    if (!types[heading[2]]) throw new Error('第 ' + heading[1] + ' 题：不支持题型 ' + heading[2]);
                    q = { number: heading[1], type: types[heading[2]], stem: heading[3].replace(/^(?:【[^】]+】\s*)+/, ''), options: [], rawAnswer: '', explanation: '', tags: [], images: [] };
                    field = 'stem';
                } else if (!q) return;
                else if (/^\s*(?:答案解析|解析)\s*[:：]/.test(line)) { field = 'explanation'; append(line.replace(/^\s*(?:答案解析|解析)\s*[:：]\s*/, '')); }
                else if (/^\s*(?:正确答案|参考答案|答案)\s*[:：]/.test(line)) { field = 'rawAnswer'; append(line.replace(/^\s*(?:正确答案|参考答案|答案)\s*[:：]\s*/, '')); }
                else if (/^\s*(?:难易程度|难易度|难度|课程目标|标签|知识点)\s*[:：]/.test(line)) { field = 'ignored'; }
                else {
                    var option = /^\s*([A-Z])[.、．]\s*(.*)$/.exec(line);
                    if (option && field !== 'rawAnswer' && field !== 'explanation' && ['single', 'multiple', 'boolean'].indexOf(q.type) >= 0) {
                        if (q.options.some(function (o) { return o.id === option[1]; })) throw new Error('第 ' + q.number + ' 题：选项编号重复');
                        q.options.push({ id: option[1], text: option[2] }); field = 'option';
                    } else if (field === 'option') q.options[q.options.length - 1].text += '\n' + line;
                    else if (field !== 'ignored') append(line);
                }
                if (q) paragraph.images.forEach(function (image) { if (!q.images.some(function (existing) { return existing.id === image.id; })) q.images.push(image); });
            });
        });
        finish();
        if (!questions.length) throw new Error('未找到“1.【单选题】题干”格式的题目');
        questions.forEach(function (item) { delete item.ignored; if (!item.images.length) delete item.images; });
        return { payload: { schemaVersion: 1, name: filename.replace(/\.docx$/i, ''), questions: questions }, warnings: warnings };
    };
})(window);
