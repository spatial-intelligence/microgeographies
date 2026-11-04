import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
let submit,request,response,download;
const form={addEventListener(_type,handler){submit=handler;}};
const status={classList:{remove(){},add(){}},textContent:''},button={disabled:false};
const file={files:[{name:'Survey photos.ZIP'}]};
const elements={resizeZipForm:form,resizeZipStatus:status,resizeZipRun:button,resizeZipFile:file};
const context=vm.createContext({
  document:{getElementById:id=>elements[id],createElement:()=>download={click(){this.clicked=true;}}},
  FormData:class {constructor(value){assert.equal(value,form);}},
  URL:{createObjectURL:()=> 'blob:zip',revokeObjectURL(){}},setTimeout(){},
  fetch:async(url,options)=>{request={url,options};return response;}
});
vm.runInContext(readFileSync(new URL('../image-resize.js',import.meta.url),'utf8'),context);
response={ok:true,blob:async()=>({}),headers:{get:key=>({'X-Images-Resized':'3','X-Images-Unchanged':'1','X-Files-Skipped':'0'}[key])}};
await submit({preventDefault(){}});
assert.equal(request.url,'/api/resize-images');assert.equal(request.options.method,'POST');
assert.equal(download.download,'Survey photos_resize.zip');assert.equal(download.clicked,true);
assert.match(status.textContent,/3 resized, 1 already small/);assert.equal(button.disabled,false);
response={ok:false,status:422,json:async()=>({detail:'No supported images in ZIP'})};
await submit({preventDefault(){}});
assert.match(status.textContent,/No supported images/);assert.equal(button.disabled,false);
console.log('PASS image ZIP upload, output filename, summary and error handling');
