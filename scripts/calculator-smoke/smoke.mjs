// This trusted driver receives only the committed calculator HTML and arithmetic module.
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import pngjs from 'pngjs';
import ts from 'typescript';
import {checkSumPage} from './sum-acceptance.mjs';
import {staticDragons} from './static-dragons.mjs';
import {checkDragonSpec} from './dragon-acceptance.mjs';

let payload='';
for await (const chunk of process.stdin) payload+=chunk;
const {html,source,sha,checks=[],site,server,baseline,deployed}=JSON.parse(payload);
const module=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const base='http://calculator.test/';
const browser=await chromium.launch({args:['--disable-dev-shm-usage']});
try {
  if(checks.includes('staticSvg'))await staticDragons(browser,{html,module,server,baseline,deployed});
  else if(site==='sum')await checkSumPage(browser,html,module,server,checks);
  else for(const [width,height] of [[1440,900],[390,844],[320,740],[1280,900],[800,900],[375,844]]){
    const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block',reducedMotion:'reduce'});
    const errors=[];
    const page=await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror',()=>errors.push('uncaught page error'));
    page.on('console',message=>{if(message.type()==='error')errors.push('console error');});
    await context.route('**/*',route=>{
      switch(route.request().url()){
        case base:return route.fulfill({contentType:'text/html; charset=utf-8',body:html});
        case base+'triangular.js':return route.fulfill({contentType:'text/javascript',body:module});
        default:errors.push('unexpected asset request');return route.abort();
      }
    });
    await page.goto(base);
    const form=page.locator('form'),input=form.locator('input'),output=form.locator('output');
    assert.match((await output.innerText()).trim(),/\b120$/,'Initial factorial result');
    if(await input.getAttribute('aria-describedby')){
      assert.equal(await input.getAttribute('type'),'number');
      assert.equal(await input.getAttribute('step'),'any');
      assert.equal(await input.getAttribute('value'),'5');
      assert.equal(await input.evaluate(el=>el.required),true);
      const description=await input.evaluate(el=>{
        const ids=el.getAttribute('aria-describedby').trim().split(/\s+/);
        const all=[...document.querySelectorAll('[id]')];
        if(new Set(all.map(e=>e.id)).size!==all.length)throw Error('Duplicate document id');
        const targets=ids.map(id=>document.getElementById(id));
        if(targets.some(e=>!e||e.tagName!=='P'||!e.closest('main')))throw Error('Description must resolve to an intro paragraph');
        return targets.map(e=>e.textContent.trim()).join(' ');
      });
      const cdp=await context.newCDPSession(page);
      try{
        const tree=await cdp.send('Accessibility.getFullAXTree');
        const node=tree.nodes.find(n=>n.role?.value==='spinbutton');
        assert.equal(node?.name?.value,'Последнее число');
        assert.equal(node?.description?.value,description,'Accessible input description');
      }finally{await cdp.detach();}
      console.log('PASS input description at '+width+': unique ids, intro paragraph target, spinbutton name and full description verified; '+description);
      const withoutDescription=text=>text.replace(/\s(?:id|aria-describedby)="[^"]*"/g,'');
      if(baseline && withoutDescription(html).trim()===withoutDescription(baseline).trim()){
        const reference=await context.newPage();
        await reference.route(base,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:baseline}));
        await reference.goto(base);
        assert.equal(await page.locator('h1').innerText(),await reference.locator('h1').innerText());
        assert.equal(await page.locator('main p').first().innerText(),await reference.locator('main p').first().innerText());
        const current=pngjs.PNG.sync.read(await page.screenshot({caret:'hide'}));
        const original=pngjs.PNG.sync.read(await reference.screenshot({caret:'hide'}));
        assert.equal(current.width,original.width);assert.equal(current.height,original.height);
        let changed=0;
        for(let i=0;i<current.data.length;i+=4)if([0,1,2].some(c=>Math.abs(current.data[i+c]-original.data[i+c])>24))changed++;
        const fraction=changed/(current.width*current.height);
        assert.ok(fraction<=0.01,'Visual parity against base at '+width+': changed pixel fraction '+fraction);
        console.log('PASS screenshot parity at '+width+': changed pixel fraction '+fraction+' (maximum 0.01)');
        await reference.close();
        console.log('PASS baseline parity at '+width+': heading, intro copy and rendered screenshot unchanged');
      }
      console.log('PASS HTML acceptance: intro target and document id uniqueness; aria-describedby resolution; type=number step=any value=5 required; heading and paragraph preserved for description-only changes');
    }
    for(const [value,expected] of [['0',/\b1$/],['4',/\b24$/],['5',/\b120$/],['6',/\b720$/],['-1',/целое/i],['2.5',/целое/i]]){
      await input.fill(value);
      await input.press('Enter');
      assert.match((await output.innerText()).trim(),expected,'Keyboard result for '+value);
      console.log('PASS keyboard input '+value+' at '+width+': '+(await output.innerText()).trim());
    }
    const previousOutput=await output.innerText();
    await input.fill('');await input.press('Enter');
    assert.equal(await input.evaluate(el=>el.validity.valueMissing),true);
    assert.equal(await output.innerText(),previousOutput,'Empty required input preserves output');
    console.log('PASS empty input at '+width+': valueMissing, submission blocked, output preserved; initial result 120');
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
    // Ordinary follow-up cards exercise the artwork actually published by the prior card.
    // Card-specific assertions below still enforce the approved rendering implementation.
    if(!metrics.sides.length && !checks.includes('dragons')){
      for(const svg of await page.locator('main ~ svg, svg:has(~ main)').all()){
        const box=await svg.boundingBox();if(!box)continue;
        const raster=pngjs.PNG.sync.read(await svg.screenshot());
        let painted=0;
        for(let i=0;i<raster.data.length;i+=4)if(raster.data[i+2]-raster.data[i]>18)painted++;
        metrics.sides.push({pixels:painted,left:box.x,right:box.x+box.width,bottom:box.y+box.height});
      }
    }
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
    const artwork=page.locator('svg');
    assert.equal(await artwork.count(),2,'Exactly two SVG dragons');
    for(const svg of await artwork.all())assert.equal(await svg.getAttribute('aria-hidden'),'true','Decorative dragon is aria-hidden');
    console.log('PASS browser integrity at '+width+': no console or page errors; both SVG dragons present and aria-hidden=true');
    console.log('PASS '+width+'x'+height+' scrollWidth='+metrics.scroll+' colored dragon pixel counts (left, right)='+metrics.sides.map(r=>r.pixels).join(', ')+'; controls reachable; keyboard factorial and invalid input passed');
    await context.close();
  }
  if(checks.includes('dragons'))await checkDragonSpec(browser,base,html,module);
  console.log('Candidate Chromium preview passed for '+sha+' (production deployment checked separately).');
}finally{await browser.close();}
