const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('../tools/transpile/node_modules/playwright');
const source=fs.readFileSync(require('node:path').join(__dirname,'../scripts/deepseek.js'),'utf8');
const snapshot=source.slice(source.indexOf('    function mediaPosition('),source.indexOf('    function isCurrent(s)'));
test('question media preserves repeated formulas, excludes answers and analysis, and maps sibling option images',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
 const page=await browser.newPage();
 await page.setContent('<div id="q"><h3><img src="data:,6653"><img src="data:,6653"></h3><ul><li><div class="answerBg">A</div><img src="data:,optionA"></li><li><div class="answerBg">B</div><canvas></canvas></li></ul><div class="qtAnalysis"><img src="data:,8080"></div><div class="rightAnswerContent"><img src="data:,answer"></div><div class="stuAnswerContent"><canvas></canvas></div></div>');
 const result=await page.evaluate(({snapshot,normalize})=>{
  const rootOf=d=>d.root,plain=x=>String(x||''),imageSource=n=>n.getAttribute('src'),attached=new Map(),doc=document,revision=1,bankRevision=0,domStamp=()=>'',fail=(c,m)=>new Error(m);
  const fn=eval(normalize+snapshot+'; snapshot');
  return fn({root:document.querySelector('#q'),$options:document.querySelectorAll('.answerBg'),options:['A','B'],type:0}).images.map(x=>({src:x.src,label:x.label}));
 },{snapshot,normalize});
 assert.equal(result.length,4);
 assert.deepEqual(result.map(x=>x.label),['题干图片','题干图片','选项 A 图片','选项 B 图片']);
 assert.equal(result.filter(x=>x.src==='data:,6653').length,2);
 }finally{await browser.close();}
});

const matching=source.slice(source.indexOf('    async function bankImagePixels'),source.indexOf('    async function execute(s, c)'));
const normalize=source.slice(source.indexOf('    function bankMatchText'),source.indexOf('    function cleanQuestionStem'));
test('image matching remaps shuffled choices and rejects conflicting or damaged content',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
 const page=await browser.newPage();
 const results=await page.evaluate(async({matching,normalize})=>{
  const doc=document,active=new Set(),isCurrent=()=>true,expectedType=()=> 'single',captureImage=async i=>i.src,fail=(c,m)=>new Error(m);
  eval(normalize+matching+'; window.runMatch=matchImageBank');
  function picture(color){let c=document.createElement('canvas');c.width=40;c.height=20;let x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,40,20);return c.toDataURL()}
  const red=picture('red'),blue=picture('blue');
  const q={stem:'[图片:x][图片:y]',options:[{id:'A',text:'alpha'},{id:'B',text:'beta'}],answer:['A'],images:[{id:'x',dataUrl:red},{id:'y',dataUrl:blue}]};
  const s={options:['beta','alpha'],images:[{label:'题干图片',src:red},{label:'题干图片',src:blue}]};
  const cand={question:q,bank:'test',conflict:false};
  const exact=await runMatch(s,{},[cand]);
  const partial=await runMatch({...s,images:s.images.slice(0,1)},{},[cand]);
  const extra=await runMatch({...s,images:s.images.concat(s.images[0])},{},[cand]);
  const missing=await runMatch({...s,options:['alpha']},{},[cand]);
  const conflict=await runMatch(s,{},[cand,{...cand,question:{...q,answer:['B']}}]);
  const changed=await runMatch({...s,images:[s.images[1],s.images[0]]},{},[cand]);
  return {exact,partial,extra,missing,conflict,changed};
 },{matching,normalize});
 assert.deepEqual(results.exact.answer.choices,['B']);
 assert.equal(results.partial.answer.needsReview,true);
 assert.equal(results.extra.matched,false);assert.match(results.extra.detail,/3.*2/);
 assert.equal(results.missing.matched,false);assert.match(results.missing.detail,/1.*2/);
 assert.equal(results.conflict.reason,'ambiguous');
 assert.equal(results.changed.matched,false);
 }finally{await browser.close()}
});

test('extra preview formula requires unique candidate, complete options and unique stored image',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{const page=await browser.newPage();const r=await page.evaluate(async({matching,normalize})=>{
 const doc=document,active=new Set(),isCurrent=()=>true,expectedType=()=> 'single',captureImage=async i=>i.src,fail=(c,m)=>new Error(m);eval(normalize+matching+'; window.runMatch=matchImageBank');
 function picture(color){const c=document.createElement('canvas');c.width=40;c.height=20;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,40,20);return c.toDataURL()}
 const red=picture('red'),blue=picture('blue');const q={stem:'port [图片:x]',options:['local','floodlight','remote6653','remote8080'].map((text,i)=>({id:String.fromCharCode(65+i),text})),answer:['C'],images:[{id:'x',dataUrl:red}]};const cand={question:q,bank:'test',conflict:false};const s={options:['remote8080','local','remote6653','floodlight'],images:[{label:'题干图片',src:blue},{label:'题干图片',src:red}]};
 const mixed={...q,stem:'port [图片:x] destination [图片:y]',images:[...q.images,{id:'y',dataUrl:picture('green')}]};
 const allStored = {...s,images:[...s.images,{label:'题干图片',src:mixed.images[1].dataUrl}]};
 const replaced = {...s,images:[...s.images,{label:'题干图片',src:picture('orange')}]};
 return {mixed:await runMatch(s,{},[{...cand,question:mixed}]),allStored:await runMatch(allStored,{},[{...cand,question:mixed}]),replaced:await runMatch(replaced,{},[{...cand,question:mixed}]),ok:await runMatch(s,{},[cand]),ambiguous:await runMatch(s,{},[cand,cand]),wrong:await runMatch({...s,options:['unknown',...s.options.slice(1)]},{},[cand]),absent:await runMatch({...s,images:[s.images[0],s.images[0]]},{},[cand]),repeated:await runMatch({...s,images:[s.images[1],s.images[1]]},{},[cand])};
 },{matching,normalize});assert.deepEqual(r.ok.answer.choices,['C']);assert.equal(r.ok.answer.needsReview,true);assert.equal(r.allStored.answer.needsReview,true);for(const key of ['mixed','replaced','ambiguous','wrong','absent','repeated'])assert.equal(r[key].matched,false,key);
 }finally{await browser.close()}
});

test('image-only preview with omitted formulas and a stray fragment needs a unique complete choice match', async () => {
 const browser = await chromium.launch({channel:'msedge',headless:true});
 try {
  const page = await browser.newPage();
  const results = await page.evaluate(async ({matching,normalize}) => {
   const doc = document, active = new Set(), isCurrent = () => true, expectedType = () => 'single', captureImage = async item => item.src;
   const fail = (code, message) => new Error(message);
   const match = eval(normalize + matching + '; matchImageBank');
   function picture(value, width) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = 16;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, 16);
    ctx.fillStyle = '#000'; ctx.font = '14px Arial'; ctx.fillText(value, 0, 13);
    return canvas.toDataURL();
   }
   const port = picture('1', 12), ip = picture('10.0.0.1', 66), output = picture('2', 12), stray = picture('200', 31);
   const choices = ['nw_dst,mod_dl_dst', 'nw_dst,set_mac', 'ip_dst,mod_dl_dst', 'nw_dst,change_dl_dst'];
   const question = {stem:'从端口 [图片:p] 转发目的 IP 为 [图片:i] 的数据包到端口 [图片:o]',
    options:choices.map((text,i) => ({id:String.fromCharCode(65+i),text})), answer:['A'],
    images:[{id:'p',dataUrl:port},{id:'i',dataUrl:ip},{id:'o',dataUrl:output}]};
   const candidate = {question,bank:'网络',exactStem:false};
   const run = (pictures, candidates = [candidate], options = choices) =>
    match({options,images:pictures.map(src => ({label:'题干图片',src}))}, {}, candidates);
   return {
    partial: await run([stray,port], [candidate], [choices[2],choices[0],choices[3],choices[1]]),
    noEvidence: await run([stray,picture('999',31)]),
    ambiguous: await run([stray,port], [candidate,{...candidate,bank:'其他题库'}]),
    changedOptions: await run([stray,port], [candidate], [choices[0],choices[1],choices[2],'其他选项']),
    changedFullStem: await run([stray,port,ip]),
    textStem: await run([stray,port], [{...candidate,exactStem:true}])
   };
  }, {matching,normalize});
  assert.deepEqual(results.partial.answer.choices, ['B']);
  assert.equal(results.partial.answer.needsReview, true);
  for (const name of ['noEvidence','ambiguous','changedOptions','changedFullStem','textStem'])
   assert.equal(results[name].matched, false, name);
 } finally { await browser.close(); }
});

test('a changed formula sign misses while resizing and slight compression still match', async () => {
 const browser = await chromium.launch({channel:'msedge',headless:true});
 try {
  const page = await browser.newPage();
  const results = await page.evaluate(async ({matching,normalize}) => {
   const doc = document, active = new Set(), isCurrent = () => true, expectedType = () => 'single', captureImage = async item => item.src, fail = (code, message) => new Error(message);
   const match = eval(normalize + matching + '; matchImageBank');
   function formula(sign) {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 60;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 240, 60);
    ctx.fillStyle = '#000'; ctx.font = '28px Arial'; ctx.fillText('24', 63, 39); ctx.fillText('12', 121, 39);
    ctx.fillRect(100, 30, 11, 2);
    if (sign === '+') ctx.fillRect(105, 25, 2, 12);
    return canvas;
   }
   const original = formula('-');
   const resized = document.createElement('canvas'); resized.width = 360; resized.height = 90;
   resized.getContext('2d').drawImage(original, 0, 0, resized.width, resized.height);
   const question = {stem:'[图片:formula]', options:[{id:'A',text:'12'}, {id:'B',text:'36'}], answer:['A'], images:[{id:'formula',dataUrl:original.toDataURL()}]};
   const run = src => match({options:['12','36'],images:[{label:'题干图片',src}]}, {}, [{question,bank:'公式'}]);
   return {changed:await run(formula('+').toDataURL()), scaled:await run(resized.toDataURL()), compressed:await run(original.toDataURL('image/jpeg',0.9)), scaledCompressed:await run(resized.toDataURL('image/jpeg',0.9))};
  }, {matching,normalize});
  assert.equal(results.changed.reason, 'image-mismatch');
  for (const key of ['scaled', 'compressed', 'scaledCompressed']) {
   assert.deepEqual(results[key].answer?.choices, ['A'], key);
   assert.equal(results[key].answer.needsReview, false, key);
  }
 } finally { await browser.close(); }
});

test('missing distractor recovery requires exact stem and intact correct option',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});try{const page=await browser.newPage();const result=await page.evaluate(async({matching,normalize})=>{
 const doc=document,active=new Set(),isCurrent=()=>true,expectedType=()=> 'single',captureImage=async i=>i.src,fail=(c,m)=>new Error(m);eval(normalize+matching+'; window.runMatch=matchImageBank');
 const canvas=document.createElement('canvas');canvas.width=40;canvas.height=20;const image=canvas.toDataURL();
 const q={stem:'exact stem',options:[{id:'A',text:'correct'},{id:'B',text:'wrong one'},{id:'C',text:'wrong two'},{id:'D',text:'port [图片:x] occupied'}],answer:['A'],images:[{id:'x',dataUrl:image}]};const cand={question:q,bank:'test',exactStem:true};const s={options:['wrong two','correct','wrong one'],images:[{label:'选项 A 图片',src:image}]};
 return {ok:await runMatch(s,{},[cand]),noStem:await runMatch(s,{},[{...cand,exactStem:false}]),missingCorrect:await runMatch(s,{},[{...cand,question:{...q,answer:['D']}}]),changedCorrect:await runMatch({...s,images:[{label:'选项 B 图片',src:image}]},{},[cand])};
 },{matching,normalize});assert.deepEqual(result.ok.answer.choices,['B']);assert.equal(result.ok.answer.needsReview,true);for(const key of ['noStem','missingCorrect','changedCorrect'])assert.equal(result[key].matched,false,key);
 }finally{await browser.close()}
});

test('curl hidden URL placeholder preserves command semantics and remaps shuffled options',()=>{
 const fn=eval(normalize+'; bankMatchText');
 const bank={options:[
  '`curl -X PUT -u admin:admin -H "Content-Type: application/json" -d body <URL>`',
  '`curl -X POST -u admin:admin -H "Accept: application/xml" -d body <URL>`',
  '`curl -X PUT -U admin:admin -H "Content-Type: text/plain" -d body <URL>`',
  '`curl -X GET -u admin:password -H "Content-Type: application/json" -d body <URL>`'
 ].map(text=>({text}))};
 const page=[2,1,3,0].map(i=>bank.options[i].text.replace(' <URL>',''));
 const matches=bank.options.map(o=>page.map((p,i)=>fn(p)===fn(o.text)?i:-1).filter(i=>i>=0));
 assert.deepEqual(matches,[[3],[1],[0],[2]]);
 assert.notEqual(fn('`curl -u admin:admin`'),fn('`curl -U admin:admin`'));
 assert.notEqual(fn('`curl https://a.invalid`'),fn('`curl https://b.invalid`'));
 assert.notEqual(fn('x <URL>'),fn('x'));
});

test('partial boolean stem matches uniquely and never uses explanation-only images',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});try{const page=await browser.newPage();const r=await page.evaluate(async({matching,normalize})=>{
 const doc=document,active=new Set(),isCurrent=()=>true,expectedType=()=> 'judge',captureImage=async i=>i.src,fail=(c,m)=>new Error(m);eval(normalize+matching+'; window.runMatch=matchImageBank');
 function pic(color){const c=document.createElement('canvas');c.width=40;c.height=20;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,40,20);return c.toDataURL()}
 const red=pic('red'),blue=pic('blue'),green=pic('green');const q={stem:'switches [图片:x] hosts [图片:y]',options:[],answer:true,images:[{id:'x',dataUrl:red},{id:'y',dataUrl:blue},{id:'analysis',dataUrl:green}]};const cand={question:q,bank:'test'};const s={options:['对','错'],images:[{label:'题干图片',src:red}]};
 return {ok:await runMatch(s,{},[cand]),sameAnswer:await runMatch(s,{},[cand,cand]),conflict:await runMatch(s,{},[{...cand,conflict:true}]),explanation:await runMatch({...s,images:[{label:'题干图片',src:green}]},{},[cand])};
 },{matching,normalize});assert.equal(r.ok.matched,true);assert.deepEqual(r.ok.answer.answers,['正确']);assert.equal(r.ok.answer.needsReview,true);assert.equal(r.sameAnswer.reason,'ambiguous');assert.equal(r.conflict.reason,'ambiguous');assert.equal(r.explanation.matched,false);
 }finally{await browser.close()}
});

test('repeated stem formulas are occurrences, but distinct matching questions remain ambiguous',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});try{const page=await browser.newPage();const r=await page.evaluate(async({matching,normalize})=>{
 const doc=document,active=new Set(),isCurrent=()=>true,expectedType=()=> 'judge',captureImage=async i=>i.src,fail=(c,m)=>new Error(m);eval(normalize+matching+'; window.runMatch=matchImageBank');
 const c=document.createElement('canvas');c.width=40;c.height=20;const img=c.toDataURL();const q={stem:'switches [图片:a] hosts [图片:b]',options:[],answer:true,images:[{id:'a',dataUrl:img},{id:'b',dataUrl:img}]};const candidate={question:q,bank:'test'};const s={options:['对','错'],images:[{label:'题干图片',src:img}]};
 return {one:await runMatch(s,{},[candidate]),two:await runMatch({...s,images:[...s.images,...s.images]},{},[candidate]),tooMany:await runMatch({...s,images:[...s.images,...s.images,...s.images]},{},[candidate]),ambiguous:await runMatch(s,{},[candidate,{...candidate,question:{...q,stem:'different [图片:a][图片:b]',answer:false}}])};
 },{matching,normalize});assert.equal(r.one.matched,true);assert.equal(r.one.answer.needsReview,true);assert.equal(r.two.matched,true);assert.equal(r.tooMany.matched,false);assert.equal(r.ambiguous.reason,'ambiguous');
 }finally{await browser.close()}
});
