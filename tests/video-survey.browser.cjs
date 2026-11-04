const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
  try {
    const page=await browser.newPage({serviceWorkers:'block',viewport:{width:1600,height:1100}}),errors=[];
    page.setDefaultTimeout(8000);
    page.on('pageerror',e=>errors.push(e.message));
    const points=Array.from({length:900},(_,i)=>[(i%30)/5-3,0,Math.floor(i/30)/5+1]);
    const ply=['ply','format ascii 1.0','element vertex 900','property float x','property float y','property float z','property uchar red','property uchar green','property uchar blue','end_header',...points.map(p=>[...p,100,180,220].join(' '))].join('\n');
    const camera={image:'f.jpg',qvec:[1,0,0,0],tvec:[0,0,0],width:100,height:80,params:[40,40,50,40]};
    const fixture={ply,cameras:[camera],frames:2,metric:true,model:'mock',features:[],georeference:{available:false},source_frames:[0,1].map(i=>({image:'f.jpg',time_s:i,url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="skyblue"/></svg>')}))};
    // Different names ensure browsing includes both camera/frame records.
    fixture.cameras.push({...camera,image:'g.jpg'});fixture.source_frames[1].image='g.jpg';
    let request='';
    await page.route('**/api/health',r=>r.fulfill({json:{}}));
    await page.route('**/api/video-cloud',r=>{request=r.request().postData();return r.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'result',data:fixture})+'\n'});});
    await page.goto('http://127.0.0.1:9517/?workflow=video-survey');
    try{await page.waitForSelector('#videoOnlyRow');}catch(error){console.log('startup',errors,await page.evaluate(()=>({mode:document.body.dataset.mode,view:document.body.dataset.view,url:location.href})));throw error;}
    assert(await page.locator('#videoOnlyRow').isVisible());
    assert(!await page.locator('#videoZip').isVisible());
    await page.locator('#videoOnly').setInputFiles({name:'office.mp4',mimeType:'video/mp4',buffer:Buffer.from('stub')});
    await page.locator('#videoBtn').click();
    await page.waitForSelector('#surveyRegister',{state:'attached'});
    assert(request.includes('name="video"'));
    assert(request.includes('name="concepts"\r\n\r\n[]'));
    async function pick(index,view='videoView') {
      await page.locator('#'+view).scrollIntoViewIfNeeded();
      const p=await page.evaluate(async ({point,view})=>{
        const THREE=await import('./vendor/three.module.js'),canvas=document.querySelector('#'+view+' canvas'),rect=canvas.getBoundingClientRect();
        const center=new THREE.Vector3(-.1,0,3.9),span=Math.hypot(5.8,5.8),camera=new THREE.PerspectiveCamera(55,rect.width/rect.height,span/10000,span*100);
        if(view==='videoSecondView'){camera.up.set(0,0,1);camera.position.copy(center).add(new THREE.Vector3(0,-span,0));}
        else{camera.up.set(0,-1,0);camera.position.copy(center).add(new THREE.Vector3(span*.45,-span*.35,-span*.65));}
        camera.lookAt(center);camera.updateMatrixWorld();
        const q=new THREE.Vector3(...point).project(camera);return {x:rect.left+(q.x+1)*rect.width/2,y:rect.top+(1-q.y)*rect.height/2};
      },{point:points[index],view});
      await page.mouse.click(p.x,p.y);
    }
    await page.locator('[data-tool="control"]').click();
    await page.screenshot({path:'tmp-probe/survey-workspace-initial.png',fullPage:true});
    for(const [i,index] of [155,175,755].entries()){
      await pick(index);assert.match(await page.locator('#surveyStatus').textContent(),/matching map/);
      await page.locator('#videoMap').click({position:{x:150+(i===1?100:0),y:35+(i===2?60:0)}});
    }
    assert.equal(await page.locator('#surveyControls li').count(),3);
    await page.locator('#surveyRegister').click();
    assert.match(await page.locator('#surveyStatus').textContent(),/Registered 3 pairs/);
    assert(await page.locator('#videoMap .cloud-map-canvas').isVisible());
    assert(await page.locator('#videoSecondPane').isHidden());assert.equal(await page.locator('#videoSecondFloat').getAttribute('aria-expanded'),'false');
    assert.equal(await page.locator('#videoSecondView .gcp-source-marker').count(),3);
    await page.locator('#videoSecondFloat').click();
    await page.locator('#videoSecondView .gcp-source-marker[aria-label="Control point 1"]').click();
    assert.match(await page.locator('#surveyStatus').textContent(),/Move control 1/);
    await page.locator('#surveyCancelEdit').click();
    const firstControl=page.locator('#surveyControls li').first();
    await firstControl.getByRole('button',{name:'Move 3D',exact:true}).click();
    await pick(156,'videoSecondView');
    assert.match(await page.locator('#surveyStatus').textContent(),/3D position for control 1 moved/);
    assert(await page.locator('#surveyExport').isDisabled());
    assert.equal(await page.locator('#videoMap .cloud-map-canvas').count(),0,'Old registration overlay is cleared after editing');
    await page.locator('#surveyRegister').click();
    assert.match(await page.locator('#surveyStatus').textContent(),/Registered 3 pairs/);
    const secondControl=page.locator('#surveyControls li').nth(1),beforeMap=await secondControl.textContent();
    await secondControl.getByRole('button',{name:'Move map',exact:true}).click();
    await page.locator('#videoMap').click({position:{x:255,y:125}});
    assert.notEqual(await secondControl.textContent(),beforeMap);
    assert.match(await page.locator('#surveyStatus').textContent(),/Map position for control 2 moved/);
    await firstControl.getByRole('button',{name:'Move 3D',exact:true}).click();await page.keyboard.press('Escape');
    assert(await page.locator('#surveyCancelEdit').isHidden());
    await secondControl.getByRole('button',{name:'Delete',exact:true}).click();
    assert.equal(await page.locator('#surveyControls li').count(),2);
    await page.locator('#surveyRegister').click();assert.match(await page.locator('#surveyStatus').textContent(),/at least three/);
    await pick(175);await page.locator('#videoMap').click({position:{x:255,y:125}});
    await page.locator('#surveyRegister').click();assert.match(await page.locator('#surveyStatus').textContent(),/Registered 3 pairs/);
    const mapMarker=page.locator('#videoMap .survey-map-control').nth(1);await mapMarker.scrollIntoViewIfNeeded();
    const box=await mapMarker.boundingBox();await page.mouse.move(box.x+13,box.y+13);await page.mouse.down();await page.mouse.move(box.x+25,box.y+20,{steps:8});await page.mouse.up();
    assert.match(await page.locator('#surveyStatus').textContent(),/Registered 3 pairs/);
    await page.locator('#surveyRegister').click();
    // Preset changes and free orbit in view two leave the main camera untouched.
    await page.locator('#videoView').scrollIntoViewIfNeeded();
    const mainBefore=await page.locator('#videoView canvas').screenshot({mask:[page.locator('#videoSecondPane')]});
    for(const preset of ['left','right','front','back','bottom','perspective','top'])await page.locator('#videoSecondPreset').selectOption(preset);
    await page.waitForTimeout(100);
    const mainAfter=await page.locator('#videoView canvas').screenshot({mask:[page.locator('#videoSecondPane')]});
    assert(mainBefore.equals(mainAfter),'Second-view presets must not change the main view');
    const secondCanvas=page.locator('#videoSecondView canvas'),beforeOrbit=await secondCanvas.screenshot(),secondBox=await secondCanvas.boundingBox();
    await page.keyboard.down('Control');await page.mouse.move(secondBox.x+secondBox.width*.5,secondBox.y+secondBox.height*.5);await page.mouse.down();await page.mouse.move(secondBox.x+secondBox.width*.7,secondBox.y+secondBox.height*.6,{steps:12});await page.mouse.up();await page.keyboard.up('Control');await page.waitForTimeout(300);
    assert(!beforeOrbit.equals(await secondCanvas.screenshot()),'Second view can orbit to arbitrary angles');
    await page.locator('#videoSecondCopy').click();await page.waitForTimeout(400);
    assert(mainAfter.equals(await page.locator('#videoView canvas').screenshot({mask:[page.locator('#videoSecondPane')]})),'Copying the main angle leaves the main camera unchanged');
    await page.locator('#videoSecondPreset').selectOption('top');
    await page.getByRole('button',{name:'Close Second 3D view',exact:true}).click();
    await page.locator('#videoView .viewer-tool-measure').click();await pick(155);await pick(175);
    assert.match(await page.locator('#surveyStatus').textContent(),/Distance:.*m/);
    await page.locator('#videoView .viewer-tool-tag').click();await pick(155);
    await page.locator('#surveyTagName').fill('Office printer');await page.locator('#surveyIndoor').selectOption('indoor');await page.locator('#surveyFloor').fill('2');
    await page.locator('#surveyTagForm button').click();
    assert.match(await page.locator('#surveyTags').textContent(),/Office printer.*floor 2/);
    const downloadEvent=page.waitForEvent('download');await page.locator('#surveyExport').click();const download=await downloadEvent;
    const fs=require('node:fs/promises'),exported=JSON.parse(await fs.readFile(await download.path(),'utf8'));
    assert.equal(exported.features[0].properties.floor,2);assert.equal(exported.features[0].geometry.type,'Point');assert.equal(exported.georeference.controls.length,3);
    assert.equal(exported.georeference.controls[0].index,156,'Cloud position edited through second view is exported');
    await page.locator('#videoView .viewer-tool-photos').click();await pick(155);
    assert.match(await page.locator('#surveyPhotoInfo').textContent(),/1 \/ 2/);
    await page.keyboard.press('.');assert.match(await page.locator('#surveyPhotoInfo').textContent(),/2 \/ 2/);
    await page.keyboard.press(',');assert.match(await page.locator('#surveyPhotoInfo').textContent(),/1 \/ 2/);
    const photoWindow=page.locator('#surveyWindow-photos'),photoBounds=await photoWindow.boundingBox();
    assert(photoBounds.y>=0&&photoBounds.y+photoBounds.height<=1100,'Source photos remain inside the viewport');
    await page.screenshot({path:'tmp-probe/survey-photos-window.png',fullPage:true});
    const photoHeader=page.locator('#surveyWindow-photos .tool-window-header');
    const headerBounds=await photoHeader.boundingBox();await page.mouse.move(headerBounds.x+70,headerBounds.y+15);await page.mouse.down();await page.mouse.move(headerBounds.x-30,headerBounds.y+45,{steps:8});await page.mouse.up();
    assert.notEqual((await photoWindow.boundingBox()).x,photoBounds.x,'Tool pages are movable');
    await page.locator('#videoView .viewer-tool-tag').click();await page.locator('#surveyTags').getByRole('button',{name:'Edit',exact:true}).click();
    await page.locator('#surveyTagName').fill('Shared printer');await page.locator('#surveyFloor').fill('3');
    const tagLat=Number(await page.locator('#surveyTagLat').inputValue());await page.locator('#surveyTagLat').fill(String(tagLat+.00001));
    await page.locator('#surveyTagForm button').click();assert.match(await page.locator('#surveyTags').textContent(),/Shared printer.*floor 3/);
    await page.locator('#surveyWindow-tag').getByRole('button',{name:'Close Tags'}).click();
    const cameraPanel=page.locator('#videoView .viewer-camera-panel');await cameraPanel.locator('summary').click();
    await cameraPanel.locator('[data-ground-barrier]').check();await cameraPanel.locator('[data-ground-level]').fill('0.7');await cameraPanel.locator('[data-ground-level]').press('Tab');
    assert.equal(await cameraPanel.locator('[data-ground-level]').inputValue(),'0.7');
    await page.screenshot({path:'tmp-probe/viewer-bottom-tools.png',fullPage:true});
    await cameraPanel.locator('[data-fov]').fill('90');await cameraPanel.locator('[data-camera-mode]').selectOption('walk');
    await cameraPanel.locator('[data-depth-max]').fill('2');await cameraPanel.locator('[data-depth-min]').fill('10');
    assert.equal(Number(await cameraPanel.locator('[data-depth-max]').inputValue())-Number(await cameraPanel.locator('[data-depth-min]').inputValue()),1);
    await cameraPanel.locator('[data-depth-min]').fill('0');await cameraPanel.locator('[data-depth-max]').fill(await cameraPanel.locator('[data-depth-max]').getAttribute('max'));
    await cameraPanel.locator('summary').click();
    async function projectMenu(){if(!await page.locator('#videoProjectMenu').evaluate(e=>e.open))await page.locator('#videoProjectMenu > summary').click();}
    async function saveProject(name,asNew=false){if(asNew){await projectMenu();await page.locator('#videoProjectSaveAs').click();}else await page.locator('#videoProjectSave').click();await page.locator('#videoProjectName').fill(name);await page.locator('#videoProjectNameConfirm').click();await page.waitForFunction(name=>document.querySelector('#videoProjectStatus').textContent.startsWith('Saved '+name),name);}
    await saveProject('Office survey');assert.equal(await page.locator('#videoProjectList .project-menu-row').count(),1);
    await saveProject('Office copy',true);assert.equal(await page.locator('#videoProjectList .project-menu-row').count(),2);
    await projectMenu();await page.getByRole('button',{name:'Rename Office copy',exact:true}).click();await page.locator('#videoProjectName').fill('Third floor survey');await page.locator('#videoProjectNameConfirm').click();
    await page.waitForFunction(()=>document.querySelector('#videoProjectStatus').textContent.startsWith('Renamed project'));
    assert.equal(await page.locator('#videoProjectList .project-load').filter({hasText:'Third floor survey'}).count(),1);
    await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelectorAll('#videoProjectList .project-menu-row').length===2);
    await projectMenu();await page.getByRole('button',{name:'Third floor survey',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#videoProjectStatus').textContent.startsWith('Loaded Third floor survey'));
    assert.equal(await page.locator('#surveyControls li').count(),3);assert.match(await page.locator('#surveyTags').textContent(),/Shared printer.*floor 3/);
    assert.equal(await page.locator('#videoView [data-fov]').inputValue(),'90');assert.equal(await page.locator('#videoView [data-camera-mode]').inputValue(),'walk');
    assert(await page.locator('#videoView [data-ground-barrier]').isChecked());assert.equal(await page.locator('#videoView [data-ground-level]').inputValue(),'0.7');
    await projectMenu();await page.getByRole('button',{name:'Delete Third floor survey',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('#videoProjectList .project-menu-row').length===1);
    // The optional API path and the expanded frame budget must reach the backend.
    await page.locator('#videoSetup > summary').click();await page.locator('#videoUseSam').check();await page.locator('#videoDetector').selectOption('api');await page.locator('#videoConcepts').fill('printer');await page.locator('#videoSetup .advanced-options > summary').click();await page.locator('#videoMaxFrames').fill('250');
    await page.locator('#settingsBtn').click();await page.locator('#tokenInput').fill('sam31-ui-test-key');await page.locator('#cfgClose').click();
    await page.locator('#videoOnly').setInputFiles({name:'office.mp4',mimeType:'video/mp4',buffer:Buffer.from('stub')});
    await page.locator('#videoBtn').click();await page.waitForFunction(()=>document.body.classList.contains('has-video-cloud')&&!document.querySelector('#videoBtn').disabled);
    assert(request.includes('name="concepts"\r\n\r\n["printer"]'));assert(request.includes('sam31-ui-test-key'));assert(request.includes('name="max_frames"\r\n\r\n250'));assert(request.includes('name="detector"\r\n\r\napi'));
    await saveProject('API labelled project',true);
    const serialized=await page.evaluate(async()=>{const {projectStore}=await import('./project-store.js');const rows=await projectStore.list();return JSON.stringify(await projectStore.get(rows.find(p=>p.name==='API labelled project').id));});
    assert(!serialized.includes('sam31-ui-test-key'),'Saved projects do not contain API keys');
    for(const width of [390,768,1600]){await page.setViewportSize({width,height:1100});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
    await page.screenshot({path:'tmp-probe/video-survey-review.png',fullPage:true});
    assert.deepEqual(errors,[]);console.log('Video survey: movable tool pages, persistent project CRUD, editable tag metadata/position, SAM API/250 frames, camera/depth controls, dual views, registration and photos passed.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
