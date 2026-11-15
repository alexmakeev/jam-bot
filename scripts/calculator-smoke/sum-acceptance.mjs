import assert from 'node:assert/strict';

import {fork} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export async function checkSumPage(browser,html,module,server,checks){
  // Only the operator-reviewed static server may execute in the browser validation container.
  const digest=createHash('sha256').update(server).digest('hex');
  assert.equal(digest,'1133195da7ee1a980be7e9a99b77ee55a0b6c21b69e6eef38cbe75d1aa876cef','Sandbox static server changed; review before accepting a different server');
  const temp=await mkdtemp(join(tmpdir(),'jam-sum-preview-'));
  const base='http://127.0.0.1:8080/';
  let child;
  try{
    await Promise.all([['index.html',html],['sum.js',module],['server.mjs',server]].map(([name,content])=>writeFile(join(temp,name),content)));
    child=fork(join(temp,'server.mjs'),[],{cwd:temp,env:{},stdio:'ignore',execArgv:[]});
    for(let i=0;i<60;i++){
      if(child.exitCode!==null)throw Error('Preview server exited');
      if(await fetch(base+'health').then(r=>r.ok,()=>false))break;
      await delay(50);
    }
    const asset=await fetch(base+'sum.js');
    assert.equal(asset.status,200);
    assert.match(asset.headers.get('content-type'),/javascript/i);
    assert.equal(await asset.text(),module);
    console.log('Isolated candidate HTTP server (node '+process.version+' server.mjs, Chromium '+browser.version()+') '+base+' and '+base+'sum.js (200 '+asset.headers.get('content-type')+').');
    await exercise(browser,base,checks);
  }finally{
    if(child)child.kill();
    await rm(temp,{recursive:true,force:true});
  }
}

async function exercise(browser,base,checks){
  const clearTotals=checks.includes('clearTotals');
  const runningTotals=checks.includes('runningTotals') || clearTotals;
  for(const [width,dpr] of [[320,1],[1280,1],[640,2]]){
    const context=await browser.newContext({viewport:{width,height:800},deviceScaleFactor:dpr,serviceWorkers:'block'});
    try{
      const errors=[];
      await context.route('**/*',route=>{
        if(route.request().url()===base || route.request().url()===base+'sum.js')return route.continue();
        errors.push('unexpected network request');return route.abort();
      });
      const page=await context.newPage();page.setDefaultTimeout(4000);
      page.on('pageerror',()=>errors.push('uncaught page exception'));
      page.on('console',message=>{if(message.type()==='error')errors.push('browser console error');});
      const response=await page.goto(base);
      assert.equal(response.status(),200);
      const input=page.locator('#values'),total=page.locator('#total');
      const submit=page.getByRole('button',{name:'Посчитать',exact:true});
      if(runningTotals){
        assert.equal(await page.getByRole('list',{name:'Промежуточные суммы',exact:true}).evaluate(el=>el.tagName),'OL');
        assert.ok(await page.getByRole('heading',{name:'Промежуточные суммы',exact:true}).isVisible());
        assert.equal(await page.evaluate(async()=>typeof (await import('./sum.js')).runningTotals),'function');
      }
      assert.equal((await input.inputValue()).replace(/\s/g,''),'2,3,5','Initial list changed');
      for(const [text,expected,sequence] of [[null,'10',[2,5,10]],['2, -1, 3','4',[2,1,4]],['2, nope','Проверьте числа',[]],['','0',[]],['   ','0',[]]]){
        if(text!==null){await input.fill(text);await input.press('Enter');}
        assert.equal((await total.innerText()).trim(),expected);
        if(runningTotals){
          const output=page.locator('#running-totals');
          assert.equal(await output.count(),1,'Missing running totals');
          assert.deepEqual(await output.locator(':scope > li').allTextContents(),sequence.map(String),'Unexpected list items');
          assert.ok((await page.locator('main,body').last().innerText()).includes('Промежуточные суммы'),'Missing result label');
        }
      }
      if(runningTotals){
        await input.fill('2, -1, 3');await submit.click();
        assert.equal((await total.innerText()).trim(),'4');
        assert.deepEqual(await page.locator('#running-totals > li').allTextContents(),['2','1','4']);
        await input.fill('2, 5');await input.press('Tab');
        assert.ok(await submit.evaluate(el=>el===document.activeElement && getComputedStyle(el).outlineStyle!=='none'),'Visible submit focus after Tab');
        await submit.press('Space');assert.ok(await submit.evaluate(el=>el===document.activeElement));
        assert.equal((await total.innerText()).trim(),'7');
        await input.fill('-1.2345678901234567e-300, 0.30000000000000004, 1e21');await input.press('Enter');
        assert.ok(await input.evaluate(el=>el===document.activeElement));
        const layout=await page.evaluate(()=>{
          const main=document.querySelector('main'),rect=main.getBoundingClientRect();
          const boxes=[...document.querySelectorAll('main h2,main input,main button,main output,#running-totals li')].map(el=>el.getBoundingClientRect());
          const rows=[...document.querySelectorAll('#running-totals li')].map(el=>el.getBoundingClientRect());
          return {withinColumn:rect.width<=34*parseFloat(getComputedStyle(document.documentElement).fontSize)+1,
            visible:boxes.every(b=>b.width>0 && b.height>0 && b.left>=0 && b.right<=innerWidth+1 && b.top>=0 && b.bottom<=innerHeight+1),
            rows:rows.length===3 && rows.every((r,i)=>i===0||r.top>=rows[i-1].bottom-1)};
        });
        assert.ok(layout.visible && layout.rows,'Scientific notation values or controls clipped at '+width);
        if(width===1280)assert.ok(layout.withinColumn,'Desktop content exceeds 34rem');
        console.log('PASS '+width+' CSS px DPR '+dpr+': named ordered list and heading; true list items; pointer, Tab, Space, Enter + focus; long scientific values fit with separate rows.');
      }
      if(clearTotals){
        const clear=page.getByRole('button',{name:'Очистить',exact:true});
        assert.equal(await clear.count(),1,'Missing clear button');
        await input.fill('1, 2');await input.press('Enter');
        assert.equal((await total.innerText()).trim(),'3');
        for(const activation of ['click','Space']){
          if(activation==='click')await clear.click();
          else {await clear.focus();await clear.press(activation);}
          assert.equal(await input.inputValue(),'');
          assert.equal((await total.innerText()).trim(),'0');
          assert.doesNotMatch(await page.locator('#running-totals').innerText(),/\d/);
          assert.ok(await input.evaluate(el=>el===document.activeElement),'Clear must restore input focus');
        }
        console.log('PASS clear populated and empty list via pointer and keyboard; value, total, intermediate results and focus restored.');
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow');
      assert.deepEqual(errors,[]);
      console.log('PASS sum page at '+width+'px: initial 2,3,5 → 10; keyboard mixed → 4; invalid token → Проверьте числа; empty and whitespace → 0'+(runningTotals?', running totals [2,5,10] → [2,1,4] → empty':'')+'; no console or page errors; no overflow.');
    }finally{await context.close();}
  }
}
