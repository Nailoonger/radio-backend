'use strict';
// Isolated native-page checks only. Never requests or stores real credentials.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const base=path.join(__dirname,'..','miniprogram','pages-partner','login');
const source=fs.readFileSync(path.join(base,'login.js'),'utf8');
const wxml=fs.readFileSync(path.join(base,'login.wxml'),'utf8');
/** 顺着 @import 把样式拼成一份 —— 伙伴端登录页的 wxss 只有一行 @import，
 *  直接读本页文本会让下面所有 CSS 断言对着空文件跑（假绿）。跨文件用 seen 防循环。 */
function readWxss(file,seen=new Set()){
  const target=path.resolve(file);
  if(seen.has(target))return '';
  seen.add(target);
  return fs.readFileSync(target,'utf8').replace(/@import\s+["']([^"']+)["']\s*;/g,(_,rel)=>readWxss(path.resolve(path.dirname(target),rel),seen));
}
const wxss=readWxss(path.join(base,'login.wxss'));
const json=JSON.parse(fs.readFileSync(path.join(base,'login.json'),'utf8'));
let checks=0;
async function test(label,fn){await fn();checks++;console.log('✓ '+label);}
const plain=value=>JSON.parse(JSON.stringify(value));
const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
function page(options={}){
  const auth=[],launches=[],backs=[],modals=[];let definition;
  const app={globalData:{statusBarHeight:options.statusBarHeight??28},isAdminLoggedIn:()=>Boolean(options.loggedIn),adminLogin(username,password){auth.push({username,password});return options.login?options.login(username,password):Promise.resolve();}};
  const context=vm.createContext({Page:value=>{definition=value;},getApp:()=>app,getCurrentPages:()=>Array.from({length:options.depth??1},()=>({})),wx:{reLaunch:value=>launches.push(value),navigateBack:value=>backs.push(value),showModal:value=>modals.push(value)},console});
  vm.runInContext(source,context,{filename:'pages-partner/login/login.js'});assert.ok(definition,'Page definition');
  const instance={data:plain(definition.data),setData(value,callback){Object.assign(this.data,plain(value));callback?.();}};
  for(const [key,value] of Object.entries(definition))if(typeof value==='function')instance[key]=value.bind(instance);
  return {instance,definition,auth,launches,backs,modals};
}
function cssRules(){
  const rules=[];
  for(const match of wxss.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
    const selectors=match[1].replace(/\/\*[\s\S]*?\*\//g,'').trim().split(',').map(value=>value.trim());
    const declarations={};for(const item of match[2].split(';')){const colon=item.indexOf(':');if(colon>0)declarations[item.slice(0,colon).trim()]=item.slice(colon+1).trim();}
    rules.push({selectors,declarations});
  }
  return rules;
}

(async()=>{
  await test('未登录按真实状态栏高度布局，不发登录请求',()=>{
    const p=page();p.instance.onLoad();assert.equal(p.instance.data.statusBarHeight,28);assert.equal(p.auth.length,0);assert.equal(p.launches.length,0);
  });
  await test('已有独立管理员登录态直接进入伙伴工作台',()=>{
    const p=page({loggedIn:true});p.instance.onLoad();assert.deepEqual(plain(p.launches),[{url:'/pages-partner/desk/desk'}]);assert.equal(p.auth.length,0);
  });
  await test('账号为空或仅空格时就地提示，不调用 adminLogin',()=>{
    for(const username of ['', ' \t ']){const p=page();p.instance.data.username=username;p.instance.data.password='mock-only';p.instance.doLogin();assert.equal(p.auth.length,0);assert.ok(p.instance.data.loginError);assert.equal(p.instance.data.loading,false);assert.equal(p.launches.length,0);}
  });
  await test('密码为空时就地提示，保留已输入账号',()=>{
    const p=page();p.instance.data.username=' mock-user ';p.instance.doLogin();assert.equal(p.auth.length,0);assert.ok(p.instance.data.loginError);assert.equal(p.instance.data.username,' mock-user ');assert.equal(p.launches.length,0);
  });
  await test('请求中阻止重复提交，沿用 adminLogin 并只 trim 账号',async()=>{
    let complete;const p=page({login:()=>new Promise(resolve=>{complete=resolve;})});p.instance.data.username='  mock-user\t';p.instance.data.password=' mock-only-password ';
    p.instance.doLogin();p.instance.doLogin();assert.equal(p.auth.length,1);assert.deepEqual(p.auth[0],{username:'mock-user',password:' mock-only-password '});assert.equal(p.instance.data.loading,true);assert.equal(p.launches.length,0);
    complete();await settle();assert.deepEqual(plain(p.launches),[{url:'/pages-partner/desk/desk'}]);assert.equal(p.instance.data.username,'  mock-user\t');assert.equal(p.instance.data.password,' mock-only-password ');
  });
  await test('接口失败保留输入、显示后端文案并恢复重试',async()=>{
    const p=page({login:()=>Promise.reject({message:'账号已停用，请联系管理员'})});p.instance.data.username='mock-user';p.instance.data.password='mock-only';p.instance.doLogin();await settle();assert.equal(p.instance.data.loginError,'账号已停用，请联系管理员');assert.equal(p.instance.data.loading,false);assert.equal(p.instance.data.username,'mock-user');assert.equal(p.instance.data.password,'mock-only');assert.equal(p.launches.length,0);
    p.instance.doLogin();await settle();assert.equal(p.auth.length,2);
  });
  await test('无错误正文时仍提供可重试提示',async()=>{
    const p=page({login:()=>Promise.reject(null)});p.instance.data.username='mock-user';p.instance.data.password='mock-only';p.instance.doLogin();await settle();assert.ok(p.instance.data.loginError);assert.equal(p.instance.data.loading,false);assert.equal(p.launches.length,0);
  });
  await test('账号和密码输入各自更新并清除错误，不互相覆盖',()=>{
    const p=page();p.instance.data.password='password-unchanged';p.instance.data.loginError='旧错误';p.instance.inputUsername({detail:{value:'mock-user'}});assert.equal(p.instance.data.username,'mock-user');assert.equal(p.instance.data.password,'password-unchanged');assert.equal(p.instance.data.loginError,'');p.instance.data.loginError='新错误';p.instance.inputPassword({detail:{value:'new mock password'}});assert.equal(p.instance.data.username,'mock-user');assert.equal(p.instance.data.password,'new mock password');assert.equal(p.instance.data.loginError,'');assert.equal(p.auth.length,0);
  });
  await test('密码显隐往返不丢内容或触发登录',()=>{
    const p=page();p.instance.data.password='mock-only';p.instance.togglePwd();assert.equal(p.instance.data.showPwd,true);p.instance.togglePwd();assert.equal(p.instance.data.showPwd,false);assert.equal(p.instance.data.password,'mock-only');assert.equal(p.auth.length,0);
  });
  await test('存在上级页面时返回一层',()=>{
    const p=page({depth:2});p.instance.goBack();assert.deepEqual(plain(p.backs),[{delta:1}]);assert.equal(p.launches.length,0);
  });
  await test('直接进入时返回学生登录，学生入口仍可使用',()=>{
    const p=page();p.instance.goBack();p.instance.goStudentLogin();assert.deepEqual(plain(p.launches),[{url:'/pages/login/login'},{url:'/pages/login/login'}]);assert.equal(p.auth.length,0);
  });
  await test('登录帮助仅打开本机说明，不提交或改动输入',()=>{
    const p=page();p.instance.data.username='mock-user';p.instance.data.password='mock-only';const before=plain(p.instance.data);assert.equal(typeof p.instance.showLoginHelp,'function');p.instance.showLoginHelp();assert.equal(p.modals.length,1);assert.ok(p.modals[0].content);assert.deepEqual(p.instance.data,before);assert.equal(p.auth.length,0);assert.equal(p.launches.length,0);
  });
  await test('所有 WXML 事件均绑定实际原生 Page 方法',()=>{
    const p=page(),bindings=[...wxml.matchAll(/\b(?:bind|catch)(?::)?[a-z]+\s*=\s*"([A-Za-z_$][\w$]*)"/g)].map(match=>match[1]);assert.ok(bindings.length>=6);for(const method of bindings)assert.equal(typeof p.definition[method],'function','未实现事件 '+method);
    assert.ok(bindings.includes('doLogin'));assert.ok(bindings.includes('showLoginHelp'));assert.ok(bindings.includes('goStudentLogin'));assert.match(wxml,/bindconfirm="doLogin"/);
  });
  await test('WXML 不使用函数调用或对括号表达式取下标',()=>{
    const expressions=[...wxml.matchAll(/\{\{([\s\S]*?)\}\}/g)].map(match=>match[1]);for(const expression of expressions){assert.doesNotMatch(expression,/[A-Za-z_$][\w$.]*\s*\(/);assert.doesNotMatch(expression,/\)\s*\[/);}
  });
  await test('站徽复用存在的本地图片',()=>{
    // 2026-10-31 起不再有背景大图（.login-backdrop 已随「复用学生端设计」删掉），只剩站徽
    const assets=[...wxml.matchAll(/<image\b[^>]*\bsrc="([^"]+)"/g)].map(match=>match[1]);assert.ok(assets.includes('/assets/station-badge.png'));for(const asset of assets){assert.ok(asset.startsWith('/assets/'));assert.ok(fs.statSync(path.join(__dirname,'..','miniprogram',asset.slice(1))).isFile());}
  });
  await test('原生页面不混入虚构凭据或隐含协议同意',()=>{
    assert.doesNotMatch(source+wxml,/demo123456|data-demo-account|guqing|linyao|使用演示账号|演示身份/);assert.doesNotMatch(wxml,/登录即(?:表示)?同意|登录.*即.*同意/);assert.doesNotMatch(source,/wx\.(?:request|setStorageSync|setStorage)\s*\(/);
  });
  await test('自定义导航保留且短屏允许纵向滚动',()=>{
    assert.equal(json.navigationStyle,'custom');assert.notEqual(json.disableScroll,true);assert.match(wxml,/statusBarHeight/);
  });
  await test('两个单行输入都有显式 rpx 高度（防止输入框塌成一行字）',()=>{
    // 原断言还要求「行高等于高度、上下内边距为 0」—— 那是旧版伙伴页自己那套输入的写法，
    // 2026-10-31 复用学生端后输入框是 .ipt（height 80rpx + 外层 .input 承担描边和内边距），
    // 学生端本来就没有显式 line-height，所以这里只盯「有没有显式高度」这个真正防塌的点。
    const inputs=[...wxml.matchAll(/<input\b[^>]*>/g)].map(match=>match[0]);assert.equal(inputs.length,2);const rules=cssRules();
    for(const input of inputs){const classes=/\bclass="([^"]+)"/.exec(input)?.[1].split(/\s+/)||[];const declarations={};for(const rule of rules){if(rule.selectors.some(selector=>/^(?:input)?\.[\w-]+$/.test(selector)&&classes.includes(selector.replace(/^input\./,'').replace(/^\./,''))))Object.assign(declarations,rule.declarations);}
      assert.match(declarations.height||'',/^\d+(?:\.\d+)?rpx$/,'输入缺少显式高度：'+classes.join('.'));
    }
  });
  await test('铺满主按钮使用 button 加类选择器确保微信优先级',()=>{
    const button=/<button\b[^>]*\bbindtap="doLogin"[^>]*>/.exec(wxml)?.[0]||[...wxml.matchAll(/<button\b[^>]*>/g)].map(match=>match[0]).find(value=>value.includes('doLogin'));assert.ok(button);const classes=/\bclass="([^"]+)"/.exec(button)?.[1].split(/\s+/)||[];
    assert.ok(cssRules().some(rule=>rule.declarations.width==='100%'&&rule.selectors.some(selector=>classes.some(name=>selector==='button.'+name))));
  });
  await test('存在入场动画时填充模式使用 both',()=>{
    for(const rule of cssRules()){if(rule.declarations.animation&&rule.declarations.animation!=='none')assert.ok(/\bboth\b/.test(rule.declarations.animation)||rule.declarations['animation-fill-mode']==='both','动画需 both：'+rule.selectors.join(','));}
  });
  console.log('\n伙伴小程序登录校验：'+checks+' 项通过。');
})().catch(error=>{console.error(error);process.exitCode=1;});
