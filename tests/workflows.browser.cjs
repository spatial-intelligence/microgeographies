// Run against a static server with Playwright installed. Inference is mocked;
// WebGL, navigation, exports, map overlays and tour UI use the real app code.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

function reconstruction() {
  const means=[], colors=[];
  for(let i=0;i<800;i++) {
    means.push([(i%40)/10-2,Math.floor(i/40)/10-1,4+Math.sin(i/25)*.3]);
    colors.push([.3+(i%10)/20,.6,.8]);
  }
  const ply=['ply','format ascii 1.0',`element vertex ${means.length}`,
    'property float x','property float y','property float z',
    'property uchar red','property uchar green','property uchar blue','end_header',
    ...means.map((p,i)=>[...p,...colors[i].map(v=>Math.round(v*255))].join(' '))].join('\n');
  const cameras=[{image:'a.jpg',qvec:[1,0,0,0],tvec:[0,0,0],width:100,height:80,model:'PINHOLE',params:[80,80,50,40]}];
  return {ply,cameras,point_labels:Object.fromEntries(means.map((_,i)=>[i,{label:'door',votes:1}])),photo_locations:{'a.jpg':{lat:51.5,lon:-.125}},
    registered:['a.jpg'],unregistered:[],label_objects:true,frames:2,model:'mock-da3',mock:true,
    thumbnails:{'a.jpg':'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="#267ca0"/><path d="M0 40L100 40" stroke="#ffdd88" stroke-width="12"/></svg>')},
    features:[{label:'door',geom:'point',lat:51.50001,lon:-.125,count:10,distance_m:4,bearing_deg:0}],
    location:{lat:51.5,lon:-.125},heading_deg:0,
    georeference:{available:true,origin:{lat:51.5,lon:-.125,altitude_m:0},matrix:[[1,0,0],[0,0,1],[0,-1,0]],
      translation:[0,0,0],rms_m:.2,scale_m_per_unit:1,photos_used:['a.jpg','b.jpg','c.jpg']},
    gaussians:{means,colors,scales:means.map(()=>[.025,.025,.01]),rotations:means.map(()=>[1,0,0,0]),opacities:means.map(()=>.85)}};
}

(async()=>{
  const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || undefined,headless:true});
  try {
    const page=await browser.newPage({serviceWorkers:'block',viewport:{width:1440,height:1000}});
    const errors=[], shaderErrors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.text().includes('THREE.WebGLProgram'))shaderErrors.push(m.text());});
    const fixture=reconstruction();
    let apiRequest=null, photoRequests=[];
    await page.route('**/api/health',route=>route.fulfill({json:{sfm_available:true,sfm_backend:'cli'}}));
    await page.route('**/api/sfm',route=>{photoRequests.push(route.request().postData()); return route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'result',data:fixture})+'\n'});});
    await page.route('**/api/sam',route=>route.fulfill({json:{location:fixture.location,gps_source:'exif',
      detections:[{label:'door',box:[5,5,30,30],geo:{lat:51.50001,lon:-.125,distance_m:4,bearing_deg:0}}]}}));
    await page.route('**/api/batch',route=>route.fulfill({json:{images:[],merged:{type:'FeatureCollection',features:[
      {type:'Feature',geometry:{type:'Point',coordinates:[-.125,51.5]},properties:{label:'door',count:1,merged_from:[{image:'a.jpg'}]}}
    ]}}}));
    await page.route('**/api/video-cloud',route=>{
      apiRequest=route.request().postData();
      return route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'result',data:fixture})+'\n'});
    });
    await page.goto(process.env.TEST_URL || 'http://127.0.0.1:9517',{waitUntil:'networkidle'});
    assert.equal(await page.title(),'MicroGeog Mapper v0.42');
    assert.equal(await page.getByText('Your world, mapped in detail.').count(),0);
    await page.locator('#settingsBtn').click(); await page.locator('#tokenInput').fill('test-key-only');
    await page.locator('#endpointInput').fill('/api/sam');
    await page.locator('#cfgClose').click();
    for(const mode of ['single','set-depth','set-3d','set-video']) {
      await page.locator(`.donut-quad[data-workflow="${mode}"]`).click();
      await page.waitForTimeout(100);
      assert(await page.locator('#secExport').isVisible());
      assert.equal(await page.locator('#workflowNav').isVisible(),false);
      const map=page.locator('.leaflet-container:visible').first();
      assert((await map.boundingBox()).height>=275);
      for(const width of [390,768,1440]) {
        await page.setViewportSize({width,height:1000});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${mode} overflow at ${width}`);
      }
      if(mode==='set-depth'||mode==='set-3d')await page.locator(mode==='set-3d'?'#setModelMapBtn':'#setPhotoMapBtn').click();
      const expand=mode==='single'?'[data-expand-map="map"]':mode==='set-video'?'[data-expand-map="videoMap"]':mode==='set-3d'?'#setModelMapPanel [data-expand-map]':'#setBatchMapPanel [data-expand-map]';
      await page.locator(expand).click();
      assert(await page.locator('#mapDialog').isVisible());
      assert((await page.locator('#mapDialogHost .leaflet-container').boundingBox()).height>700);
      await page.locator('#mapDialogClose').click();
      await page.locator('#homeLink').click();
    }
    await page.locator('.donut-quad[data-workflow="single"]').click();
    const photo=await page.screenshot();
    await page.locator('#fileInput').setInputFiles({name:'photo.png',mimeType:'image/png',buffer:photo});
    await page.waitForFunction(()=>document.querySelector('#exifOut').textContent!=='Reading photo metadata…');
    await page.locator('#sendBtn').click();
    await page.waitForFunction(()=>!document.querySelector('#exportBtn').disabled);
    assert.equal(await page.locator('#singleDetectorChoice').inputValue(),'api');
    await page.locator('#map .leaflet-marker-icon').last().click();
    await page.locator('#mapTagEditor [name="name"]').fill('Office door');
    await page.locator('#mapTagEditor [name="indoor"]').selectOption('indoor');
    await page.locator('#mapTagEditor [name="floor"]').fill('2');
    await page.locator('#mapTagEditor [name="lat"]').fill('51.50002');
    await page.locator('#mapTagEditor button[type="submit"]').click();
    const singleDownload=page.waitForEvent('download');
    await page.locator('#exportBtn').click();await page.locator('#exportGeoBtn').click();
    const singleExport=await singleDownload;assert(singleExport.suggestedFilename().endsWith('.geojson'));
    const singleJson=JSON.parse(await fs.readFile(await singleExport.path(),'utf8'));
    assert.equal(singleJson.features[0].properties.label,'Office door');assert.equal(singleJson.features[0].properties.floor,2);assert.equal(singleJson.features[0].geometry.coordinates[1],51.50002);
    await page.locator('#homeLink').click();
    await page.locator('.donut-quad[data-workflow="set-depth"]').click();
    await page.locator('#zipInput').setInputFiles({name:'photos.zip',mimeType:'application/zip',buffer:Buffer.from('mock')});
    await page.locator('#batchBtn').click();
    await page.waitForFunction(()=>!document.querySelector('#mergedBtn').disabled);
    assert.equal(await page.locator('#batchMap .leaflet-interactive').count(),1);
    await page.locator('#batchMap .leaflet-interactive').click();
    await page.locator('#mapTagEditor [name="name"]').fill('Mapped entrance');
    await page.locator('#mapTagEditor button[type="submit"]').click();
    const batchDownload=page.waitForEvent('download');await page.locator('#mergedBtn').click();
    const batchExport=await batchDownload;assert(batchExport.suggestedFilename().endsWith('.geojson'));
    assert.equal(JSON.parse(await fs.readFile(await batchExport.path(),'utf8')).features[0].properties.label,'Mapped entrance');
    await page.locator('#homeLink').click();
    await page.locator('.donut-quad[data-workflow="set-3d"]').click();
    await page.locator('#zipInput').setInputFiles({name:'photos.zip',mimeType:'application/zip',buffer:Buffer.from('mock')});
    await page.locator('#sfmBtn').click();
    await page.waitForSelector('#sfmView canvas');
    await page.locator('#sfmRenderMode').selectOption('tin');await page.waitForFunction(()=>Number(document.querySelector('#sfmView').getAttribute('data-tin-triangles'))>0);
    await page.locator('#sfmRenderMode').selectOption('mosaic');await page.waitForFunction(()=>Number(document.querySelector('#sfmView').getAttribute('data-mosaic-photos'))===1);
    await page.locator('#sfmRenderMode').selectOption('points');await page.locator('#sfmDensify').fill('50');await page.waitForFunction(()=>Number(document.querySelector('#sfmView').getAttribute('data-pseudo-count'))>0);
    await page.locator('#sfmDensify').fill('0');await page.waitForFunction(()=>document.querySelector('#sfmView').getAttribute('data-pseudo-count')==='0');
    assert(await page.locator('#sfmMap .cloud-map-canvas').isVisible());
    assert(await page.locator('#sfmUseSam').isChecked());
    assert(photoRequests.at(-1).includes('name="label_objects"\r\n\r\n1'));
    await page.locator('#toolColorMode').selectOption('height');
    await page.locator('#sfmBrightness').fill('1.5');
    await page.locator('#sfmPointSize').fill('2');
    await page.locator('#sfmBookmarksOpen').click();
    await page.locator('#sfmBookmarks').getByText('Add view',{exact:true}).click();
    assert.equal(await page.locator('#sfmBookmarks input').first().inputValue(),'View1');
    await page.locator('#sfmBookmarks input').first().fill('Entrance');await page.locator('#sfmBookmarks input').first().press('Enter');
    const bookmarkWindow=page.locator('#sfmBookmarksWindow'),bookmarkHeader=bookmarkWindow.locator('.tool-window-header');
    const original=await bookmarkWindow.boundingBox(),handle=await bookmarkHeader.boundingBox();
    await page.mouse.move(handle.x+80,handle.y+15);await page.mouse.down();await page.mouse.move(handle.x-20,handle.y+60,{steps:5});await page.mouse.up();
    assert((await bookmarkWindow.boundingBox()).x<original.x,'Bookmark popup can be dragged');
    await bookmarkWindow.getByRole('button',{name:'Close View bookmarks',exact:true}).click();assert(await bookmarkWindow.isHidden());
    await page.locator('#sfmBookmarksOpen').click();assert.equal(await page.locator('#sfmBookmarks input').first().inputValue(),'Entrance');
    const canvas=page.locator('#sfmView canvas'); await canvas.focus();
    await page.keyboard.down('w');await page.waitForTimeout(150);await page.keyboard.up('w');
    await page.locator('#sfmBookmarks').getByText('Add view',{exact:true}).click();
    assert.equal(await page.locator('#sfmBookmarks li').count(),2);
    assert.equal(await page.locator('#sfmBookmarks input').last().inputValue(),'View2');
    assert.equal(await page.locator('#sfmBookmarks li').first().locator('button').first().textContent(),'[x]');
    await page.locator('#sfmBookmarks li').last().getByRole('button',{name:/↑/}).click();
    await page.locator('#sfmBookmarks').getByText('Play',{exact:true}).click();
    await page.locator('#sfmBookmarks').getByText('Play',{exact:true}).waitFor({timeout:30000});
    await page.locator('#sfmBookmarks li').first().getByRole('button',{name:/Delete/}).click();
    assert.equal(await page.locator('#sfmBookmarks li').count(),1);
    await page.locator('#sfmBtn').click();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#sfmBookmarks li').count(),1,'Camera bookmarks survive reloading the same cloud');
    const downloadWait=page.waitForEvent('download');await page.locator('#mergedBtn').click();
    const download=await downloadWait;
    const geo=JSON.parse(await fs.readFile(await download.path(),'utf8'));
    assert.equal(geo.features.length,1);
    assert.equal(geo.features[0].properties.point_count,800);
    assert(Math.abs(geo.features[0].geometry.coordinates[0]+.125)<.001);
    await page.locator('#sfmGeoBtn').click();
    assert(await page.locator('#sfmExportDlg').isVisible());
    const plyWait=page.waitForEvent('download');await page.locator('#sfmExportGo').click();
    const ply=await plyWait;assert(ply.suggestedFilename().endsWith('.ply'));
    assert((await fs.readFile(await ply.path(),'utf8')).includes('element vertex 800'));
    for(const engine of ['da3-small','da3-giant']) {
      await page.locator('#sfmEngine').selectOption(engine);
      await page.locator('#sfmBtn').click();
      await page.waitForFunction(()=>!document.querySelector('#sfmBtn').disabled);
      assert(photoRequests.at(-1).includes(`name="reconstruction_engine"\r\n\r\n${engine}`));
      assert(photoRequests.at(-1).includes('name="label_objects"\r\n\r\n1'));
    }
    await page.screenshot({path:'tmp-probe/photo-set-console-desktop.png',fullPage:true});
    assert(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),'Desktop ZIP console should fit the viewport');
    await page.locator('#homeLink').click();
    await page.locator('.donut-quad[data-workflow="set-video"]').click();
    await page.locator('#videoZip').setInputFiles({name:'video.zip',mimeType:'application/zip',buffer:Buffer.from('mock')});
    await page.locator('#videoDetector').selectOption('api');
    await page.locator('#videoOutput').selectOption('gaussians');
    await page.locator('#videoBtn').click();
    await page.waitForSelector('#videoView canvas');
    assert(apiRequest.includes('test-key-only'));
    assert(apiRequest.includes('name="gaussians"\r\n\r\n1'));
    assert.equal(await page.locator('#videoRenderMode').inputValue(),'gaussians');
    await page.locator('#videoBrightness').fill('1.5');
    await page.locator('#videoColorMode').selectOption('height');
    await page.locator('#videoView').scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
    await page.screenshot({path:'tmp-probe/video-gaussians-review.png',fullPage:true});
    await page.locator('#videoRenderMode').selectOption('points');
    await page.locator('#videoBookmarksOpen').click();
    await page.locator('#videoBookmarks').getByText('Add view',{exact:true}).click();
    assert.equal(await page.locator('#videoBookmarks li').count(),1);
    assert.equal(await page.locator('#videoBookmarks input').inputValue(),'View1');
    await page.locator('#videoBookmarksWindow').getByRole('button',{name:'Close View bookmarks',exact:true}).click();
    assert(await page.locator('#videoMap .cloud-map-canvas').isVisible());
    for(const width of [390,768,1440]) {
      await page.setViewportSize({width,height:1000});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Overflow at ${width}`);
    }
    assert.deepEqual(errors,[]);assert.deepEqual(shaderErrors,[]);
    console.log('All workflows: maps, expanded maps, Settings key, geographic export, keyboard movement, bookmarks, playback and real Gaussian shader passed.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
