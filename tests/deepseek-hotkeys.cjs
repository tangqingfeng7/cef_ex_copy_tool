const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require('../tools/transpile/node_modules/playwright');
const {readResource}=require('../tools/embedded-resources.cjs');
const {decodeResource}=require('../tools/resource-codec.cjs');
const root=path.resolve(__dirname,'..');
async function fixture(){
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1100,height:900}}),state={disk:null,wires:[],requests:[],hold:null,syncFail:false};const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());
  if(url.pathname==='/__cef_cx_ai_proxy__/hotkeys'){state.wires.push(req.postData());return route.fulfill({status:state.syncFail?500:200,contentType:'application/json',body:JSON.stringify({updated:!state.syncFail})});}
  if(url.pathname==='/__cef_cx_ai_proxy__/health')return route.fulfill({contentType:'application/json',body:'{"cefCxAiProxy":1}'});
  if(url.pathname==='/__cef_cx_ai_proxy__/config'){state.disk=JSON.parse(req.postData());return route.fulfill({contentType:'application/json',body:'{"saved":true}'});}
  if(url.hostname==='api.fixture.invalid'){state.requests.push(JSON.parse(req.postData()));const hold=state.hold;state.hold=null;if(hold)await hold;return route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{finish_reason:'stop',message:{content:'本地对话回复'}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}})});}
  return route.fulfill({contentType:'text/html;charset=utf-8',body:'<!doctype html><meta charset="utf-8"><p id="selected">明确选中的文字</p><input id="pageInput" value="输入框选中内容"><input type="password" id="password" value="fixture-secret"><iframe id="frame" srcdoc="<p>iframe文本</p>"></iframe>'});
 });
 const shim=decodeResource(readResource(fs.readFileSync(path.join(root,'out/build/x86-integrated/src/Release/winmm.dll')),10,201)).toString('utf8');
 async function load(config){await page.goto('https://mooc1.chaoxing.com/exam-ans/exam/test/hotkeys');await page.evaluate(c=>{window.__CX_AI_CONFIG__=c;window.__cefNativeAiProxy={version:1,configWrite:true,hotkeysWrite:true};},config||{enabled:false,apiKey:'fixture-only',baseUrl:'https://api.fixture.invalid',panelOpacity:1,panelBounds:{left:100,top:40,width:480,height:760}});await page.evaluate(shim);await page.evaluate(()=>__cefDeepSeek.openSettings());await page.waitForFunction(()=>__cefDeepSeek.status().hotkeySync==='ready');}
 await load();const panel=page.locator('#cef-deepseek-settings');
 async function settings(){await panel.locator('#tabAnswer').click();await panel.locator('#advanced').evaluate(el=>el.open=true);await panel.locator('#hotkeySettings').evaluate(el=>el.open=true);}
 async function record(id,keys){await panel.locator('#'+id).click();await panel.locator('#'+id).press(keys);}
 async function select(){await page.evaluate(()=>{const r=document.createRange();r.selectNodeContents(document.querySelector('#selected'));const s=getSelection();s.removeAllRanges();s.addRange(r);document.querySelector('#selected').focus();});}
 return{browser,page,panel,state,errors,load,settings,record,select,async close(){await browser.close();}};
}

test('default Ctrl+D sends once, preserves the draft and ignores empty/password/repeated keys; Ctrl+R pauses without reload',{timeout:30000},async()=>{
 const f=await fixture();try{
  assert.equal(await f.panel.locator('#titlebar strong').textContent(),'DeepSeek');assert.equal(await f.panel.locator('#titlebar .badge').count(),0);
  await f.panel.locator('#tabChat').click();await f.panel.locator('#chatInput').fill('未发送的草稿');
  let release;f.state.hold=new Promise(resolve=>release=resolve);
  await f.select();await f.page.keyboard.press('Control+d');await f.page.waitForFunction(()=>__cefDeepSeek.status().chatRequest.state==='waiting');
  await f.page.keyboard.press('Control+d');assert.equal(f.state.requests.length,1);
  assert.equal(f.state.requests[0].messages.at(-1).content,'明确选中的文字');
  assert.equal(await f.panel.locator('#chatInput').inputValue(),'未发送的草稿');release();
  await f.page.waitForFunction(()=>__cefDeepSeek.status().chatRequest.state==='completed');
  await f.page.locator('#password').evaluate(el=>{el.focus();el.setSelectionRange(0,10);});await f.page.keyboard.press('Control+d');
  await f.page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'d',code:'KeyD',ctrlKey:true,repeat:true,bubbles:true,cancelable:true})));
  assert.equal(f.state.requests.length,1);
  const before=await f.page.evaluate(()=>__cxUpstreamAI.isPaused()),url=f.page.url();
  await f.page.keyboard.press('Control+r');assert.equal(await f.page.evaluate(()=>__cxUpstreamAI.isPaused()),!before);assert.equal(f.page.url(),url);
  await f.page.keyboard.press('Control+r');assert.equal(await f.page.evaluate(()=>__cxUpstreamAI.isPaused()),before);
  assert.match(await f.panel.locator('#pause').textContent(),/Ctrl\+R/);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('custom shortcut recording saves only bindings, synchronizes native wire and restores after reload',{timeout:30000},async()=>{
 const f=await fixture();try{
  await f.settings();await f.panel.locator('#key').fill('unsaved-private-draft');
  await f.record('hotkeyPanel','Alt+p');await f.record('hotkeySelection','Control+Alt+k');await f.record('hotkeyPause','Control+F8');
  await f.panel.locator('#hotkeySave').click();await f.page.waitForFunction(()=>document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#status').textContent==='快捷键已保存并生效');
  assert.equal(f.state.disk.apiKey,'fixture-only');assert.equal(f.state.disk.hotkeys.selection,'Ctrl+Alt+K');
  assert(f.state.wires.at(-1).includes('selection=Ctrl+Alt+K\npause=Ctrl+F8'));
  await f.load(f.state.disk);assert.equal(await f.panel.locator('#hotkeySelection').inputValue(),'Ctrl+Alt+K');
  const url=f.page.url();await f.select();await f.page.keyboard.press('Control+Alt+k');await f.page.waitForFunction(()=>__cefDeepSeek.status().chatRequest.state==='completed');assert.equal(f.state.requests.length,1);
  const old=await f.page.evaluate(()=>{const e=new KeyboardEvent('keydown',{key:'r',code:'KeyR',ctrlKey:true,bubbles:true,cancelable:true});document.dispatchEvent(e);return e.defaultPrevented;});assert.equal(old,false);
  const before=await f.page.evaluate(()=>__cxUpstreamAI.isPaused());await f.page.keyboard.press('Control+F8');assert.equal(await f.page.evaluate(()=>__cxUpstreamAI.isPaused()),!before);assert.equal(f.page.url(),url);
  await f.page.keyboard.press('Alt+p');assert.equal(await f.panel.isVisible(),false);await f.page.keyboard.press('Alt+p');assert.equal(await f.panel.isVisible(),true);
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('recording a currently bound shortcut does not trigger it; reserved/duplicate combinations do not save',{timeout:30000},async()=>{
 const f=await fixture();try{
  await f.settings();await f.record('hotkeySelection','Control+g');assert.equal(await f.panel.isVisible(),true);assert.equal(await f.panel.locator('#hotkeySelection').inputValue(),'Ctrl+G');
  await f.panel.locator('#hotkeySave').click();assert.equal(f.state.disk,null);assert.match(await f.panel.locator('#status').textContent(),/重复/);
  await f.record('hotkeySelection','Control+v');assert.equal(await f.panel.locator('#hotkeySelection').inputValue(),'Ctrl+G');assert.match(await f.panel.locator('#status').textContent(),/保留/);
  await f.record('hotkeyPause','Control+r');assert.equal(await f.page.evaluate(()=>__cxUpstreamAI.isPaused()),false,'recording Ctrl+R must not pause');
  await f.panel.locator('#hotkeyReset').click();assert.equal(await f.panel.locator('#hotkeySelection').inputValue(),'Ctrl+D');assert.equal(f.state.disk,null);
  await f.panel.locator('#hotkeySave').click();await f.page.waitForFunction(()=>document.querySelector('#cef-deepseek-settings').shadowRoot.querySelector('#status').textContent==='快捷键已保存并生效');
  assert.equal(f.state.disk.hotkeys.pause,'Ctrl+R');assert.equal(f.state.requests.length,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('native iframe auto-send requires a one-use prepared token and tolerates message/arm ordering',{timeout:30000},async()=>{
 const f=await fixture();try{
  await f.page.evaluate(()=>{const frame=document.querySelector('#frame');frame.contentWindow.eval("top.postMessage({type:'cef-cx-selection-draft',text:'forged',token:'b'.repeat(32)},'*')");});
  await f.page.waitForTimeout(60);assert.equal(f.state.requests.length,0);
  await f.page.evaluate(()=>{window.postMessage({type:'cef-cx-selection-draft',text:'原生选中文字',token:'a'.repeat(32)},'*');});await f.page.waitForTimeout(30);assert.equal(f.state.requests.length,0);
  await f.page.evaluate(()=>__cefDeepSeek.prepareSelection('a'.repeat(32),'Ctrl+D'));await f.page.waitForFunction(()=>__cefDeepSeek.status().chatRequest.state==='completed');
  assert.equal(f.state.requests.length,1);assert.equal(f.state.requests[0].messages.at(-1).content,'原生选中文字');
  await f.page.evaluate(()=>window.postMessage({type:'cef-cx-selection-draft',text:'replay',token:'a'.repeat(32)},'*'));await f.page.waitForTimeout(60);assert.equal(f.state.requests.length,1);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

test('native sync failure is explicit and retry applies persisted bindings without saving a draft key',{timeout:30000},async()=>{
 const f=await fixture();try{
  await f.settings();await f.record('hotkeyPause','Control+F8');f.state.syncFail=true;
  await f.panel.locator('#hotkeySave').click();await f.page.waitForFunction(()=>__cefDeepSeek.status().hotkeySync==='failed');
  assert.equal(f.state.disk.hotkeys.pause,'Ctrl+F8');assert.match(await f.panel.locator('#status').textContent(),/原生同步失败/);
  f.state.syncFail=false;await f.panel.locator('#hotkeySave').click();await f.page.waitForFunction(()=>__cefDeepSeek.status().hotkeySync==='ready');
  assert.equal(f.state.disk.apiKey,'fixture-only');assert.equal(f.state.requests.length,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
