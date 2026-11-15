// The host selects this recipe for calculator card 21. All page code stays in the isolated browser.
import assert from 'node:assert/strict';

export async function checkDragonSpec(browser, base, html, module) {
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block',reducedMotion:'reduce'});
  const errors=[];
  await context.route('**/*',route=>{
    const u=route.request().url();
    if(u===base)return route.fulfill({contentType:'text/html; charset=utf-8',body:html});
    if(u===base+'triangular.js')return route.fulfill({contentType:'text/javascript',body:module});
    if(u===base+'favicon.ico')return route.fulfill({status:204});
    errors.push('Unexpected asset '+new URL(u).pathname);return route.abort();
  });
  const page=await context.newPage();
  page.on('pageerror',()=>errors.push('Uncaught page exception'));
  try {
    await page.goto(base+'#dragon-debug');
    for(const [w,h] of [[320,568],[360,740],[375,812],[414,896],[479,800],[480,800],[768,1024],[1023,768],[1024,768],[1280,800],[1440,900]]){
      await page.setViewportSize({width:w,height:h});
      await page.waitForFunction(()=>[...document.querySelectorAll('canvas')].filter(c=>c.clientWidth).every(c=>c.width===c.clientWidth));
      const m=await page.evaluate(()=>{
        const art=[...document.querySelectorAll('canvas')],main=document.querySelector('main').getBoundingClientRect();
        return {scroll:document.documentElement.scrollWidth,panels:art.filter(c=>c.clientWidth).map(c=>{
          const b=c.getBoundingClientRect(),data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let border=0,green=0,red=0;
          const thirds=[0,0,0];
          for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){
            const i=4*(y*c.width+x);
            if(!data[i+3])continue;
            if(x<2||y<2||x>=c.width-2||y>=c.height-2)border++;
            thirds[Math.min(2,Math.floor(3*x/c.width))]++;
            if(data[i+3]===255 && data[i+1]>data[i]*1.15)green++;
            if(data[i+3]===255 && data[i]>data[i+1]*1.15)red++;
          }
          const faces=window.__dragonDebug?.faces([...c.classList].find(s=>s.startsWith('dragon--')))??[];
          const mean=group=>group.length?group.reduce((v,f)=>v+0.2126*f.rgb[0]+0.7152*f.rgb[1]+0.0722*f.rgb[2],0)/group.length:0;
          const body=faces.filter(f=>f.material==='body'),light=body.filter(f=>f.nl>.6),dark=body.filter(f=>f.nl<.2);
          return {width:b.width,height:b.height,left:b.left,right:b.right,bottom:b.bottom,border,thirds:thirds.map(n=>n*3/(c.width*c.height)),red,green,
            inaccessible:c.getAttribute('aria-hidden')==='true' && !c.hasAttribute('tabindex') && getComputedStyle(c).pointerEvents==='none',
            lit:light.length,shaded:dark.length,ratio:mean(light)/mean(dark),front:faces.every(f=>f.material==='membrane'||f.f>0),frill:faces.some(f=>f.material==='frill')};
        }),mainLeft:main.left,mainRight:main.right,title:document.querySelector('h1').getBoundingClientRect().top};
      });
      assert.equal(m.scroll,w,'Document overflow at '+w);
      assert.ok(m.panels.every(p=>p.inaccessible&&p.border===0&&p.left>=0&&p.right<=w),'Canvas border, bounds or accessibility failure at '+w);
      if(w<1024){
        assert.equal(m.panels.length,1);assert.equal(m.panels[0].height,w<480?140:200);assert.ok(m.panels[0].bottom<=m.title+1);
      }else{
        assert.equal(m.panels.length,2);
        const [a,b]=m.panels;
        assert.ok(a.right<=m.mainLeft+1 && b.left>=m.mainRight-1 && a.width>=200 && b.width>=200);
        assert.ok(a.green>a.red && b.red>b.green && !a.frill && b.frill,'Dragon identity failure');
        assert.ok(m.panels.every(p=>p.lit>=5&&p.shaded>=5&&p.ratio>=1.3&&p.front),'Shading/winding failure');
        assert.ok(m.panels.every(p=>p.thirds.every(v=>v>.05)),'Insufficient occupancy in canvas thirds');
      }
    }
    console.log('D1-D3/M1-M3/A1: eleven viewports spanning 320–1440 px; side and band sizes, no intersections, inaccessible decoration, identity, RGB shading, face winding and canvas thirds passed. R1: zero painted pixels in outer 2px across still poses.');
    const first=await page.locator('canvas:visible').first().screenshot();
    await page.waitForTimeout(1000);
    assert.ok(first.equals(await page.locator('canvas:visible').first().screenshot()),'Reduced motion changed');
    await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForTimeout(450);
    assert.ok(!first.equals(await page.locator('canvas:visible').first().screenshot()),'Normal-motion artwork unchanged');
    await page.emulateMedia({reducedMotion:'reduce'});
    const runForm=async p=>{
      const input=p.locator('form input'),button=p.locator('form button').first(),output=p.locator('form output');
      for(const action of ['click','enter']){
        for(const [v,want] of [['0','Произведение: 1'],['5','Произведение: 120'],['6','Произведение: 720'],['-1','Введите целое неотрицательное число.'],['2.5','Введите целое неотрицательное число.'],['6','Произведение: 720'],['','Произведение: 720']]){
          await input.fill(v);if(action==='click')await button.click();else await input.press('Enter');
          assert.equal((await output.innerText()).trim(),want,'Input '+v+' by '+action);
        }
      }
      assert.ok(await input.evaluate(el=>el.validity.valueMissing && !el.form.checkValidity() && !el.form.noValidate));
    };
    await runForm(page);
    for(const mode of ['init','frame','resize']){
      const p=await context.newPage();
      p.on('pageerror',()=>errors.push(mode+' uncaught exception'));
      const inject=()=>{CanvasRenderingContext2D.prototype.fill=()=>{throw Error('Injected render failure');};};
      if(mode==='init')await p.addInitScript(()=>{HTMLCanvasElement.prototype.getContext=()=>{throw Error('Simulated context unavailable');};});
      await p.goto(base);
      if(mode!=='init'){
        await p.evaluate(inject);
        if(mode==='frame')await p.emulateMedia({reducedMotion:'no-preference'});
        else await p.setViewportSize({width:375,height:812});
        await p.waitForTimeout(170);
      }
      await runForm(p);await p.close();
    }
    assert.deepEqual(errors,[]);
    console.log('N1/F1-F3/A2-A3: same-origin local assets only; keyboard and pointer valid/invalid/required input; calculator survives context creation, frame and resize failures; reduced motion stable and animation resumes.');
  } finally {await context.close();}
}
