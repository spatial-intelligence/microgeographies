const DB='microgeo-projects',STORE='projects',META='metadata';
function metadata({id,name,updatedAt}){return {id,name,updatedAt};}
function open(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB,2);req.onupgradeneeded=()=>{
  if(!req.result.objectStoreNames.contains(STORE))req.result.createObjectStore(STORE,{keyPath:'id'});
  if(!req.result.objectStoreNames.contains(META)){
    const meta=req.result.createObjectStore(META,{keyPath:'id'}),cursor=req.transaction.objectStore(STORE).openCursor();
    cursor.onsuccess=()=>{if(cursor.result){meta.put(metadata(cursor.result.value));cursor.result.continue();}};
  }
};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function transaction(mode,action,storeName=STORE){const db=await open();try{return await new Promise((resolve,reject)=>{const tx=db.transaction([STORE,META],mode),req=action(tx.objectStore(storeName),tx.objectStore(META));let result;req.onsuccess=()=>result=req.result;tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Project storage transaction aborted'));});}finally{db.close();}}
export const projectStore={
  async list(){return (await transaction('readonly',s=>s.getAll(),META)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));},
  get(id){return transaction('readonly',s=>s.get(id));},
  async save(project){if(!project.name?.trim())throw Error('Enter a project name.');const saved={...project,name:project.name.trim(),id:project.id||crypto.randomUUID(),updatedAt:new Date().toISOString()};await transaction('readwrite',(s,meta)=>{meta.put(metadata(saved));return s.put(saved);});return saved;},
  async rename(id,name){const current=await this.get(id);if(!current)throw Error('Project not found.');return this.save({...current,name});},
  delete(id){return transaction('readwrite',(s,meta)=>{meta.delete(id);return s.delete(id);});},
};
