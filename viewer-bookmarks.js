import {createToolWindow} from './floating-windows.js';

// A tour stores camera poses only. No geometry or image data is duplicated.
export function attachBookmarks(host, getViewer) {
  let bookmarks = [], running = false, generation = 0, storageKey = null, nextView = 1;
  const trigger = document.getElementById(`${host.id}Open`);
  host.hidden = false;
  const popup = createToolWindow({id:`${host.id}Window`,title:'View bookmarks',content:host,width:370,left:Math.max(16,innerWidth-410),top:110,className:'bookmarks-window',onClose:()=>{stop();popup.hide();trigger?.focus({preventScroll:true});}});
  trigger?.addEventListener('click',()=>popup.show());
  function save() {
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, JSON.stringify(bookmarks)); } catch (_) { /* unavailable storage */ }
  }
  const add = document.createElement("button"); add.type = "button"; add.textContent = "Add view";
  const play = document.createElement("button"); play.type = "button"; play.textContent = "Play";
  const list = document.createElement("ol");
  const status = document.createElement("p"); status.className = "hint"; status.setAttribute("role", "status");
  host.append(add, play, list, status);
  function stop() {
    running = false; generation++; getViewer()?.cancelFlight();
    play.textContent = "Play";
  }
  function render() {
    list.replaceChildren();
    bookmarks.forEach((bookmark, i) => {
      const row = document.createElement("li");
      const name = document.createElement("input"); name.type = "text"; name.value = bookmark.name;
      name.setAttribute("aria-label", `Bookmark ${i + 1} name`);
      name.addEventListener("input", () => { bookmark.name = name.value.trim() || `View${i + 1}`; save(); });
      name.addEventListener("change", () => { name.value = bookmark.name; go.setAttribute('aria-label',`Go ${bookmark.name}`); remove.setAttribute('aria-label',`Delete ${bookmark.name}`); });
      name.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();name.blur();}});
      const button = (label, action, disabled = false) => {
        const el = document.createElement("button"); el.type = "button"; el.textContent = label;
        el.setAttribute("aria-label", `${label} ${bookmark.name}`); el.disabled = disabled;
        el.addEventListener("click", () => { stop(); action(); save(); }); return el;
      };
      const remove=button("[x]", () => { bookmarks.splice(i, 1); render(); });
      remove.className='bookmark-delete';remove.setAttribute('aria-label',`Delete ${bookmark.name}`);remove.title='Delete view';
      const go=button("Go", () => getViewer()?.flyTo(bookmark.pose));
      row.append(remove,name,go,
        button("↑", () => { [bookmarks[i-1], bookmarks[i]] = [bookmarks[i], bookmarks[i-1]]; render(); }, i === 0),
        button("↓", () => { [bookmarks[i+1], bookmarks[i]] = [bookmarks[i], bookmarks[i+1]]; render(); }, i === bookmarks.length-1));
      list.append(row);
    });
    play.disabled = bookmarks.length < 2;
    status.textContent = bookmarks.length ? `${bookmarks.length} saved view(s) · 0.1 s pause between views` : "Add a view after loading a cloud.";
  }
  add.addEventListener("click", () => {
    const pose = getViewer()?.getPose();
    if (!pose) { status.textContent = "Load a cloud first."; return; }
    stop();
    while(bookmarks.some(bookmark=>bookmark.name===`View${nextView}`))nextView++;
    bookmarks.push({name: `View${nextView++}`, pose}); save(); render();
  });
  play.addEventListener("click", async () => {
    if (running) { stop(); return; }
    running = true; const id = ++generation; play.textContent = "Stop";
    for (const bookmark of bookmarks.slice()) {
      if (id !== generation) break;
      const completed = await getViewer()?.flyTo(bookmark.pose, 1400);
      if (!completed || id !== generation) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (id === generation) stop();
  });
  render();
  return {stop, hide(){stop();popup.hide();}, setScene(positions) {
    stop(); let hash = 2166136261;
    for (let i=0;i<positions.length;i+=Math.max(1,Math.floor(positions.length/512))) {
      hash = Math.imul(hash ^ Math.round(positions[i]*10000),16777619);
    }
    storageKey = `mg.bookmarks.${host.id}.${positions.length}.${hash >>> 0}`;
    bookmarks = [];
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
      if (Array.isArray(stored)) bookmarks = stored.filter(item => item && typeof item.name === "string" &&
        ["position","target","up"].every(key => Array.isArray(item.pose?.[key]) && item.pose[key].length === 3 && item.pose[key].every(Number.isFinite)) && Number.isFinite(item.pose.roll));
    } catch (_) { /* ignore corrupt or unavailable storage */ }
    nextView=1;for(const bookmark of bookmarks){const number=bookmark.name.match(/^View\s*(\d+)$/i);if(number)nextView=Math.max(nextView,Number(number[1])+1);}
    if(trigger)trigger.disabled=false;
    host.hidden=false;render();
  }};
}
