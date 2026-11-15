import assert from 'node:assert/strict';

export async function checkSumPage(browser,base,html,module,checks){
  const clearTotals=checks.includes('clearTotals');
  const runningTotals=checks.includes('runningTotals') || clearTotals;
  for(const width of [320,1280]){
    const context=await browser.newContext({viewport:{width,height:800},serviceWorkers:'block'});
    try{
      const errors=[];
      await context.route('**/*',route=>{
        switch(route.request().url()){
          case base:return route.fulfill({contentType:'text/html; charset=utf-8',body:html});
          case base+'sum.js':return route.fulfill({contentType:'text/javascript',body:module});
          default:errors.push('unexpected network request');return route.abort();
        }
      });
      const page=await context.newPage();page.setDefaultTimeout(4000);
      page.on('pageerror',()=>errors.push('uncaught page exception'));
      await page.goto(base);
      const input=page.locator('#values'),total=page.locator('#total');
      for(const [text,expected,sequence] of [['2, -1, 3','4',[2,1,4]],['','0',[]]]){
        await input.fill(text);await input.press('Enter');
        assert.equal((await total.innerText()).trim(),expected);
        if(runningTotals){
          const output=page.locator('#running-totals');
          assert.equal(await output.count(),1,'Missing running totals');
          const numbers=(await output.innerText()).match(/-?\d+(?:\.\d+)?/g)??[];
          assert.deepEqual(numbers.map(Number),sequence,'Unexpected running totals');
          assert.ok((await page.locator('main,body').last().innerText()).includes('Промежуточные суммы'),'Missing result label');
        }
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
      console.log('PASS sum page at '+width+'px: keyboard, mixed numbers → 4, empty input → 0'+(runningTotals?', running totals [2, 1, 4] then empty':'')+'; no overflow.');
    }finally{await context.close();}
  }
}
