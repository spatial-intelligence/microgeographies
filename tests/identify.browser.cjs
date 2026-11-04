const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
  try{
    const page=await browser.newPage({serviceWorkers:'block',viewport:{width:1600,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    const vertices=Array.from({length:600},(_,i)=>[i%30*.2-3,Math.floor(i/30)*.2-2,4]);
    const ply=['ply','format ascii 1.0','element vertex 600','property float x','property float y','property float z','property uchar red','property uchar green','property uchar blue','end_header',...vertices.map(p=>[...p,140,180,220].join(' '))].join('\n');
    const data={ply,cameras:[{image:'a',qvec:[1,0,0,0],tvec:[0,0,0],width:100,height:80,params:[80,80,50,40]}],source_frames:[{image:'a',url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="skyblue"/></svg>'),depth:new Array(1024).fill(4)}],frames:1,model:'mock',metric:true,features:[],georeference:{available:false},point_labels:{285:{label:'door',votes:1},286:{label:'radiator',votes:1}}};
    await page.route('**/api/health',r=>r.fulfill({json:{}}));await page.route('**/api/video-cloud',r=>r.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'result',data})+'\n'}));
    await page.goto('http://127.0.0.1:9517/?workflow=video-survey');await page.locator('#videoOnly').setInputFiles({name:'clip.mp4',mimeType:'video/mp4',buffer:Buffer.from('stub')});await page.locator('#videoBtn').click();await page.waitForSelector('#videoView .viewer-tool-identify');
    async function pick(index,view='videoView'){
      const position=await page.evaluate(async({point,view})=>{const T=await import('./vendor/three.module.js'),r=document.querySelector('#'+view+' canvas').getBoundingClientRect(),center=new T.Vector3(-.1,-.1,4),span=Math.hypot(5.8,3.8),c=new T.PerspectiveCamera(55,r.width/r.height,.001,1000);c.up.set(0,-1,0);c.position.copy(center).add(view==='videoView'?new T.Vector3(span*.45,-span*.35,-span*.65):new T.Vector3(0,0,-span));c.lookAt(center);c.updateMatrixWorld();const p=new T.Vector3(...point).project(c);return {x:r.x+(p.x+1)*r.width/2,y:r.y+(1-p.y)*r.height/2};},{point:Array.isArray(index)?index:vertices[index],view});await page.mouse.click(position.x,position.y);
    }
    await page.locator('#videoView .viewer-tool-identify').click();
    for(const [index,label] of [[285,'door'],[286,'radiator'],[315,'Unclassified']]){await pick(index);await page.waitForFunction(expected=>{const t=document.querySelector('#videoView .identify-tooltip');return !t.hidden&&t.textContent.includes(expected);},label);}
    await page.locator('#videoView .viewer-identify-button').click();assert.equal(await page.locator('#videoView .viewer-tool-identify').getAttribute('aria-pressed'),'false');
    await page.locator('#videoView .viewer-identify-button').click();assert.equal(await page.locator('#videoView .viewer-tool-identify').getAttribute('aria-pressed'),'true');
    await page.locator('#videoView .viewer-tool-measure').click();await pick(285);await pick(315);
    assert.match(await page.locator('#videoView .viewer-pick-status').textContent(),/Distance: 0.200 m/);
    assert.equal(await page.locator('#videoView .measurement-marker.endpoint').count(),2);
    await page.locator('#videoView .viewer-tool-photos').click();await pick(285);await page.waitForSelector('#surveyWindow-photos');assert.match(await page.locator('#surveyPhotoInfo').textContent(),/1 \/ 1/);
    await page.locator('#videoRenderMode').selectOption('points');await page.locator('#videoDensify').fill('5');await page.waitForFunction(()=>Number(document.querySelector('#videoView').getAttribute('data-pseudo-count'))>0);
    await page.locator('#videoView .viewer-tool-measure').click();await pick([0,-.1,4]);await pick([.2,.1,4]);assert.match(await page.locator('#videoView .viewer-pick-status').textContent(),/Distance:/);
    await page.locator('#videoRenderMode').selectOption('tin');await page.waitForFunction(()=>Number(document.querySelector('#videoView').getAttribute('data-tin-triangles'))>0);await pick([0,-.1,4]);await pick([.2,.1,4]);assert.match(await page.locator('#videoView .viewer-pick-status').textContent(),/Distance:/);
    await page.locator('#videoRenderMode').selectOption('mosaic');await page.waitForFunction(()=>Number(document.querySelector('#videoView').getAttribute('data-mosaic-photos'))===1);await page.locator('#videoView .viewer-tool-photos').click();await pick([0,-.1,4]);assert.match(await page.locator('#surveyPhotoInfo').textContent(),/1 \/ 1/);
    await page.locator('#videoView .viewer-tool-identify').click();
    await page.locator('#videoSecondFloat').click();await page.locator('#videoSecondPreset').selectOption('front');await page.waitForSelector('#videoOverviewWindow');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await pick(286,'videoSecondView');
    await page.waitForFunction(()=>{const t=document.querySelector('#videoSecondView .identify-tooltip');return !t.hidden&&t.textContent.includes('radiator');});
    await page.screenshot({path:'tmp-probe/identify-class-review.png',fullPage:true});
    assert.deepEqual(errors,[]);console.log('Main-view Identify, Measure and Photos: original/synthetic points, TIN, photo mosaic, classes and floating overview passed.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
