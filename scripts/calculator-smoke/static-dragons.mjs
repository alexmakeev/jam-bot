import assert from 'node:assert/strict';
import pngjs from 'pngjs';
import {createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export async function staticDragons(browser,{html,module,server,baseline,deployed}){
  const url='http://127.0.0.1:8080/';
  const digest=text=>createHash('sha256').update(text).digest('hex');
  let child,temp;
  try{
    if(!deployed){
      assert.ok(['2f744b25781a9787fbe91fc5640352ba98779e1818226a6b606880105b8c3824','6e04b6c3345cd4dd5a850fc69aee9f2e5548b4d520ab1d37f86b7dc8099079cb'].includes(digest(server)),'Unreviewed static server');
      assert.equal(html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi)?.join(),baseline.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi)?.join(),'Original module script changed');
      const oldStyle=baseline.match(/<style>([\s\S]*?)<\/style>/i)?.[1].trim();
      assert.ok(oldStyle && html.includes(oldStyle),'Original calculator rules changed');
      temp=await mkdtemp(join(tmpdir(),'svg-'));
      for(const [file,bytes] of [['server.mjs',server],['index.html',html],['triangular.js',module]])await writeFile(join(temp,file),bytes);
      child=fork(join(temp,'server.mjs'),[],{cwd:temp,env:{},stdio:'ignore',execArgv:[]});
      for(let i=0;i<60;i++){if(await fetch(url+'health').then(r=>r.ok,()=>false))break;await delay(50);}
    }
    const actual=await fetch(url);assert.equal(actual.status,200);assert.equal(digest(await actual.text()),digest(html));
    const asset=await fetch(url+'triangular.js');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/i);
    assert.doesNotMatch(html,/requestAnimationFrame|<canvas\b|<(animate(?:Motion|Transform)?|set)\b/i);
    console.log('HTTP 200 HTML SHA-256 '+digest(html)+'; triangular.js 200 JS MIME. '+(deployed?'Live app container':'Isolated candidate')+' '+url);
    for(const width of [320,390,700,959,960,1280,1440]){
      const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
      try{
        const errors=[];
        await context.route('**/*',route=>{
          if([url,url+'triangular.js',url+'favicon.ico'].includes(route.request().url()))return route.continue();
          errors.push('unexpected resource');return route.abort();
        });
        await context.routeWebSocket('**/*',socket=>{errors.push('unexpected socket');socket.close();});
        await context.addInitScript(()=>{
          const boxes=()=>[...document.querySelectorAll('svg')].map(el=>[el.clientWidth,el.clientHeight]);
          window.svgProbe={before:null,after:null,shift:0};
          addEventListener('DOMContentLoaded',()=>{window.svgProbe.before=boxes();});
          addEventListener('load',()=>{window.svgProbe.after=boxes();});
          new PerformanceObserver(list=>{for(const e of list.getEntries())window.svgProbe.shift+=e.value;}).observe({type:'layout-shift',buffered:true});
        });
        const page=await context.newPage();page.setDefaultTimeout(4000);
        page.on('console',m=>{if(m.type()==='error')errors.push('console error');});
        page.on('pageerror',()=>errors.push('page error'));page.on('response',r=>{if(r.status()>=400)errors.push('HTTP '+r.status());});
        await page.goto(url,{waitUntil:'networkidle'});
        const input=page.locator('#n'),button=page.getByRole('button',{name:'Посчитать'}),output=page.locator('output');
        assert.equal((await output.innerText()).trim(),'Произведение: 120');
        await page.keyboard.press('Tab');assert.ok(await input.evaluate(e=>document.activeElement===e && getComputedStyle(e).outlineStyle!=='none'));
        await page.keyboard.press('Tab');assert.ok(await button.evaluate(e=>document.activeElement===e && getComputedStyle(e).outlineStyle!=='none'));
        const m=await page.evaluate(()=>{
          const box=e=>{const {x,y,width:w,height:h}=e.getBoundingClientRect();return {x,y,w,h,r:x+w,b:y+h,mid:y+h/2};};
          const main=document.querySelector('main'),form=document.querySelector('form'),els=[...document.querySelectorAll('svg')];
          const controls=[...form.querySelectorAll('input,button,output')].map(box);
          return {scroll:document.documentElement.scrollWidth,main:box(main),form:box(form),head:box(main.querySelector('h1')),controls,probe:window.svgProbe,
            order:els[0]?.nextElementSibling===main && main.nextElementSibling===els[1],animations:document.getAnimations().length,
            unique:new Set([...document.querySelectorAll('[id]')].map(el=>el.id)).size===document.querySelectorAll('[id]').length,
            dragons:els.map(el=>{
              const used=[...el.querySelectorAll('*')].flatMap(n=>[...n.attributes].flatMap(a=>[...a.value.matchAll(/url\(#([^)]+)\)/g)].map(m=>m[1])));
              const grads=[...el.querySelectorAll('linearGradient,radialGradient')];
              return {box:box(el),local:used.every(id=>el.contains(document.getElementById(id))),gradients:grads.length,
                stops:grads.every(g=>g.querySelectorAll('stop').length>=2),static:getComputedStyle(el).animationName==='none' && parseFloat(getComputedStyle(el).transitionDuration)===0,
                shadow:[...el.querySelectorAll('ellipse')].some(n=>+n.getAttribute('cy')>=145 && +n.getAttribute('opacity')>=.12 && +n.getAttribute('opacity')<=.18),
                accessible:el.getAttribute('aria-hidden')==='true' && el.getAttribute('focusable')==='false' && !el.querySelector('title,text,[tabindex]') && getComputedStyle(el).pointerEvents==='none',
                view:el.getAttribute('viewBox')};
            })};
        });
        assert.equal(m.dragons.length,2);assert.ok(m.order && m.unique);assert.equal(m.animations,0);
        assert.equal(m.probe.shift,0);assert.deepEqual(m.probe.before,m.probe.after);assert.ok(m.scroll<=width);
        for(const d of m.dragons){
          const g=d.box;assert.ok(d.local && d.static && d.stops && d.gradients>=3 && d.shadow && d.accessible && d.view==='0 0 160 200','SVG references, gradients, shadow or accessibility at '+width);
          assert.ok(g.w>0 && g.x>=0 && g.r<=width+1 && Math.abs(g.w/g.h-.8)<.01,'Clipped or distorted figure at '+width);
          assert.ok(m.controls.every(c=>g.r<=c.x-5||g.x>=c.r+5||g.b<=c.y-5||g.y>=c.b+5),'SVG overlaps control outline at '+width);
        }
        const [a,b]=m.dragons.map(d=>d.box);
        if(width>=960){assert.ok(a.r<m.main.x && b.x>m.main.r && [a,b].every(g=>Math.abs(g.mid-m.form.mid)<=48),'Desktop alignment at '+width);if(width===960)assert.ok(Math.abs(m.controls[0].y-m.controls[1].y)<=1);}
        else{const target=width<480?120:140;assert.ok([a,b].every(g=>Math.abs(g.w-target)<=1 && g.b<=m.head.y) && Math.abs(a.y-b.y)<=1 && Math.abs((b.x-a.r)-16)<=1 && Math.abs((a.x+b.r)/2-width/2)<=1,'Narrow row at '+width);}
        await input.fill('0');await button.click();assert.equal((await output.innerText()).trim(),'Произведение: 1');
        await input.fill('4');await input.press('Enter');assert.equal((await output.innerText()).trim(),'Произведение: 24');
        await input.fill('2.5');await input.press('Enter');assert.equal((await output.innerText()).trim(),'Введите целое неотрицательное число.');
        await input.fill('5');await input.press('Enter');await input.blur();
        assert.deepEqual(errors,[]);
        const png=await page.screenshot();
        const pixels=pngjs.PNG.sync.read(png);
        const results=[a,b].map(g=>{
          let painted=0,edge=0;const levels=new Set();
          for(let y=Math.ceil(g.y);y<Math.floor(g.b);y++)for(let x=Math.ceil(g.x);x<Math.floor(g.r);x++){
            const i=(y*pixels.width+x)*4;
            const [r,green,blue]=pixels.data.subarray(i,i+3);
            if(blue-r<18 || blue-green<8)continue;
            painted++;levels.add((r>>3)+':'+(green>>3)+':'+(blue>>3));
            if(x<g.x+1 || x>=g.r-1 || y<g.y+1 || y>=g.b-1)edge++;
          }
          assert.ok(painted>g.w*g.h*.08 && levels.size>16 && edge===0,'Blank, clipped or flat rasterized SVG at '+width);
          return painted+'/'+levels.size;
        });
        console.log('PASS rasterized blue silhouettes at '+width+'px; colored pixels / quantized colors '+results.join(', '));
        if([320,390,960,1440].includes(width)){
          console.log('JAM_SCREEN '+width+' '+png.toString('base64'));
        }
        console.log('PASS SVG '+width+'px: both 4:5 figures, form clearance, row alignment, gradients and ground shadows, static, focus, zero layout shift, calculator keyboard/mouse/errors.');
      }finally{await context.close();}
    }
  }finally{child?.kill();if(temp)await rm(temp,{recursive:true,force:true});}
}
