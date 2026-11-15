// This trusted driver receives only the committed calculator HTML and arithmetic module.
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import ts from 'typescript';
import {checkSumPage} from './sum-acceptance.mjs';
import {checkDragonSpec} from './dragon-acceptance.mjs';

let payload='';
for await (const chunk of process.stdin) payload+=chunk;
const {html,source,sha,checks=[],site}=JSON.parse(payload);
const module=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const base='http://calculator.test/';
const browser=await chromium.launch({args:['--disable-dev-shm-usage']});
try {
  if(site==='sum')await checkSumPage(browser,base,html,module,checks.includes('runningTotals'));
  else for(const [width,height] of [[1440,900],[390,844],[320,740]]){
    const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block',reducedMotion:'reduce'});
    const errors=[];
    const page=await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror',()=>errors.push('uncaught page error'));
    await context.route('**/*',route=>{
      switch(route.request().url()){
        case base:return route.fulfill({contentType:'text/html; charset=utf-8',body:html});
        case base+'triangular.js':return route.fulfill({contentType:'text/javascript',body:module});
        default:errors.push('unexpected asset request');return route.abort();
      }
    });
    await page.goto(base);
    const form=page.locator('form'),input=form.locator('input'),output=form.locator('output');
    for(const [value,expected] of [['0',/\b1$/],['5',/\b120$/],['6',/\b720$/],['-1',/целое/i]]){
      await input.fill(value);
      await input.press('Enter');
      assert.match((await output.innerText()).trim(),expected,'Keyboard result for '+value);
    }
    if(checks.includes('reset')){
      const reset=form.getByRole('button',{name:/^Сбросить$/i});
      assert.equal(await reset.count(),1,'Expected one Russian reset button');
      for(const value of ['6','-1']){
        await input.fill(value);await input.press('Enter');
        await reset.focus();await reset.press('Space');
        assert.equal(await input.inputValue(),'5','Reset restores initial input');
        assert.match((await output.innerText()).trim(),/\b120$/,'Reset restores initial product');
        assert.ok(await input.evaluate(el=>document.activeElement===el),'Reset restores keyboard focus');
      }
      console.log('PASS reset at '+width+': valid and invalid results restored by keyboard, focus returned to input');
    }
    const metrics=await page.evaluate(()=>{
      const form=document.querySelector('form').getBoundingClientRect();
      const panels=[...document.querySelectorAll('canvas')].filter(c=>c.offsetWidth && c.offsetHeight);
      const sides=[];
      for(const c of panels){
        const ctx=c.getContext('2d');
        if(!ctx)continue;
        const pixels=ctx.getImageData(0,0,c.width,c.height).data,box=c.getBoundingClientRect();
        // Desktop has one panel on each side. Compact screens share a panel above the form.
        const pieces=panels.length===1?2:1;
        for(let piece=0;piece<pieces;piece++){
          let count=0;
          for(let y=0;y<c.height;y+=2)for(let x=Math.floor(piece*c.width/pieces);x<(piece+1)*c.width/pieces;x+=2){
            const i=4*(y*c.width+x);
            if(pixels[i+3]>32 && Math.max(...pixels.subarray(i,i+3))-Math.min(...pixels.subarray(i,i+3))>12)count++;
          }
          sides.push({pixels:count,left:Math.round(box.left),right:Math.round(box.right),bottom:Math.round(box.bottom)});
        }
      }
      return {scroll:document.documentElement.scrollWidth,form:{left:Math.round(form.left),right:Math.round(form.right),top:Math.round(form.top)},sides};
    });
    assert.ok(metrics.scroll<=width,'Horizontal overflow at '+width);
    assert.equal(metrics.sides.length,2,'Expected two rendered dragon regions at '+width);
    assert.ok(metrics.sides.every(r=>r.pixels>=32),'Empty dragon region at '+width);
    const [left,right]=metrics.sides;
    if(width>=1024)assert.ok(left.right<=metrics.form.left && right.left>=metrics.form.right,'Dragon regions overlap desktop form');
    else assert.ok(left.bottom<=metrics.form.top,'Compact art overlaps form');
    const controls=form.locator('input,button');
    for(const control of await controls.all()){
      await control.scrollIntoViewIfNeeded();
      assert.ok(await control.evaluate(el=>{
        const r=el.getBoundingClientRect();
        return r.width>0 && r.height>0 && el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));
      }),'Obscured form control at '+width);
    }
    assert.deepEqual(errors,[]);
    console.log('PASS '+width+'x'+height+' scrollWidth='+metrics.scroll+' colored dragon samples='+metrics.sides.map(r=>r.pixels).join('/')+'; controls reachable; keyboard factorial and invalid input passed');
    await context.close();
  }
  if(checks.includes('dragons'))await checkDragonSpec(browser,base,html,module);
  console.log('Candidate Chromium preview passed for '+sha+' (production deployment checked separately).');
}finally{await browser.close();}
