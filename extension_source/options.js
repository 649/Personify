// options.js - persona manager storing image bytes in chrome.storage.local to avoid sync quota limits
// Added: export/import (with image data), modal for Wipe vs Merge, preserve original ids, optional rename mapping, progress notifications.

const DEFAULT = "";
const apiEl = document.getElementById('apiUrl');

const apiModel = document.getElementById('apiModel');
const apiTemp = document.getElementById('apiTemp');
const apiTopP = document.getElementById('apiTopP');
const apiKey = document.getElementById('apiKey');
const apiToken = document.getElementById('apiToken');
const apiImg = document.getElementById('apiImg');

const msg = document.getElementById('msg');
const personaListEl = document.getElementById('personaList');
const activeSelect = document.getElementById('activePersonaSelect');

const p_name = document.getElementById('p_name');
const p_prefix = document.getElementById('p_prefix');
const p_system = document.getElementById('p_system');
const p_summary = document.getElementById('p_summary');
const p_imagefile = document.getElementById('p_imagefile');
const p_preview = document.getElementById('p_preview');
const clearImage = document.getElementById('clearImage');
const createBtn = document.getElementById('createPersona');
const updateBtn = document.getElementById('updatePersona');
const cancelBtn = document.getElementById('cancelEdit');
const saveServerBtn = document.getElementById('saveServer');

const exportBtn = document.getElementById('exportBtn');
const importFile = document.getElementById('importFile');
const importBtn = document.getElementById('importBtn');
const importWithMapBtn = document.getElementById('importWithMapBtn');
const mapFile = document.getElementById('mapFile');

const modal = document.getElementById('modal');
const modalCancel = document.getElementById('modalCancel');
const modalMerge = document.getElementById('modalMerge');
const modalWipe = document.getElementById('modalWipe');
const preserveIdsCb = document.getElementById('preserveIds');

const importProgress = document.getElementById('importProgress');
const importStatus = document.getElementById('importStatus');
const importBar = document.getElementById('importBar');

let personas = [];
let editingId = null;
let imageDataUrl = null; // temporary hold for selected image (data URL)
let imageKeyForEditing = null; // existing local key when editing

function uid(){ return Math.random().toString(36).slice(2,10); }

function ensureDefaultPersona(list){
  const existingDefault = list.find(p=>p && p.id==='__default');
  if (!existingDefault){
    list.unshift({
      id: '__default',
      name: 'Default',
      prefix: 'AI: ',
      system: 'You are a helpful assistant. Use provided images and text when answering.',
      summary_prompt: 'Summarize the page in 3 concise bullet points, reference images where useful.',
      image: null // will hold local key if any
    });
  } else {
    // move to front
    list = list.filter(p=>p.id!=='__default');
    list.unshift(existingDefault);
  }
  return list;
}

function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, (m)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function truncate(s,n){ return s && s.length>n ? s.slice(0,n-1)+'…' : (s||''); }

function loadAll(){
    chrome.storage.sync.get({
        openai_api_url: DEFAULT,
        openai_api_model: 'gpt-4o-mini-vision',
        openai_api_temp: 0.7,
        openai_api_topp: 0.9,
        openai_api_key: 'llama.cpp',
        openai_api_token: 8192,
        openai_api_img: 6,
        personas: [],
        activePersonaId: null
    }, async (items) => {
        apiEl.value = items.openai_api_url || DEFAULT;
        apiModel.value = items.openai_api_model || 'gpt-4o-mini-vision';
        apiTemp.value = typeof items.openai_api_temp !== 'undefined' ? items.openai_api_temp : 0.7;
        apiTopP.value = typeof items.openai_api_topp !== 'undefined' ? items.openai_api_topp : 0.9;
        apiKey.value = items.openai_api_key || 'llama.cpp';
        apiToken.value = typeof items.openai_api_token !== 'undefined' ? items.openai_api_token : 8192;
        apiImg.value = typeof items.openai_api_img !== 'undefined' ? items.openai_api_img : 6;
        personas = ensureDefaultPersona(items.personas || []);
        await Promise.all(personas.map(async (p) => {
            if (p.image && typeof p.image === 'string' && p.image.startsWith('persona_img_')) {
                const key = p.image;
                const res = await getLocal(key);
                p._imageData = res && res[key] ? res[key] : null;
            } else {
                p._imageData = null;
            }
        }));
        const actId = items.activePersonaId || '__default';
        const found = personas.find(p=>p.id===actId);
        if (!found) chrome.storage.sync.set({ activePersonaId: '__default' });
        renderPersonaList();
    });
}

function renderPersonaList(){
  personaListEl.innerHTML = '';
  for (const p of personas){
    const div = document.createElement('div');
    div.className = 'persona-item';

    const img = document.createElement('img');
    if (p._imageData){
      img.src = p._imageData;
      img.style.display = 'block';
    } else {
      img.style.display = 'none';
    }

    const meta = document.createElement('div');
    meta.className = 'persona-meta';
    meta.innerHTML = `<strong>${escapeHtml(p.name||'Unnamed')}</strong><div class="small">${escapeHtml(p.prefix||'')}</div><div class="small">${truncate(p.system||'',100)}</div>`;

    const actions = document.createElement('div');
    actions.className = 'persona-actions';

    const edit = document.createElement('button');
    edit.textContent = 'Edit';
    edit.addEventListener('click', ()=>startEditPersona(p.id));

    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.addEventListener('click', ()=>deletePersona(p.id));
    if (p.id === '__default') del.disabled = true;

    const setActive = document.createElement('button');
    setActive.textContent = 'Set active';
    setActive.addEventListener('click', ()=>setActivePersona(p.id));

    actions.appendChild(edit);
    actions.appendChild(del);
    actions.appendChild(setActive);

    div.appendChild(img);
    div.appendChild(meta);
    div.appendChild(actions);
    personaListEl.appendChild(div);
  }
  renderActiveSelect();
}

function renderActiveSelect(){
  activeSelect.innerHTML = '';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '(none)';
  activeSelect.appendChild(noneOpt);
  for (const p of personas){
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || p.id;
    activeSelect.appendChild(opt);
  }
  chrome.storage.sync.get({ activePersonaId: null }, (it) => {
    activeSelect.value = it.activePersonaId || '';
  });
}

function savePersonasAndNotify(cb){
  const toSave = ensureDefaultPersona(personas.slice()).map(p => {
    // only keep small metadata in sync; keep image as key (persona_img_<id>) or null
    return {
      id: p.id,
      name: p.name,
      prefix: p.prefix,
      system: p.system,
      summary_prompt: p.summary_prompt,
      image: p.image && typeof p.image === 'string' ? p.image : null
    };
  });
  chrome.storage.sync.set({ personas: toSave }, ()=>{ if (chrome.runtime.lastError) console.error(chrome.runtime.lastError); if (cb) cb(); });
}

// helpers for chrome.storage.local with promises
function setLocal(obj){ return new Promise((res)=> chrome.storage.local.set(obj, ()=> res())); }
function getLocal(key){ return new Promise((res)=> chrome.storage.local.get(key, (r)=> res(r))); }
function removeLocal(keys){ return new Promise((res)=> chrome.storage.local.remove(keys, ()=> res())); }

// ---------- persona CRUD ----------
async function createPersona(){
  const id = uid();
  const imageKey = imageDataUrl ? 'persona_img_' + id : null;
  const p = {
    id,
    name: p_name.value.trim() || 'Unnamed',
    prefix: p_prefix.value || 'AI: ',
    system: p_system.value || '',
    summary_prompt: p_summary.value || '',
    image: imageKey // store local key in sync metadata
  };
  // if there's image data, store it in local storage
  if (imageKey && imageDataUrl){
    const obj = {};
    obj[imageKey] = imageDataUrl;
    await setLocal(obj);
    p._imageData = imageDataUrl;
  } else {
    p._imageData = null;
  }
  personas.push(p);
  savePersonasAndNotify(()=>{ renderPersonaList(); clearForm(); msg.textContent='Persona created'; setTimeout(()=>msg.textContent='',1200); });
}

async function startEditPersona(id){
  const p = personas.find(x=>x.id===id);
  if(!p) return;
  editingId = id;
  p_name.value = p.name; p_prefix.value = p.prefix; p_system.value = p.system; p_summary.value = p.summary_prompt || '';
  imageDataUrl = null;
  imageKeyForEditing = p.image || null;
  if (p._imageData){
    p_preview.src = p._imageData;
    p_preview.style.display = 'block';
  } else {
    p_preview.style.display = 'none';
  }
  createBtn.style.display='none';
  updateBtn.style.display='inline-block';
  cancelBtn.style.display='inline-block';
}

async function updatePersona(){
  if (!editingId) return;
  const p = personas.find(x=>x.id===editingId);
  if (!p) return;

  // If a new image was selected (imageDataUrl), write to local under persona_img_<id>
  if (imageDataUrl){
    const imgKey = 'persona_img_' + p.id;
    const obj = {}; obj[imgKey] = imageDataUrl;
    await setLocal(obj);
    p.image = imgKey;
    p._imageData = imageDataUrl;
  } else if (imageKeyForEditing === null && p.image){
    // user cleared image (imageKeyForEditing null and no new image) -> remove previous local image
    if (p.image) {
      await removeLocal(p.image);
      p.image = null;
      p._imageData = null;
    }
  }
  // If user cleared image via clearImage button during edit, imageDataUrl will be null and imageKeyForEditing === null
  p.name = p_name.value.trim() || 'Unnamed';
  p.prefix = p_prefix.value || 'AI: ';
  p.system = p_system.value || '';
  p.summary_prompt = p_summary.value || '';
  savePersonasAndNotify(()=>{ renderPersonaList(); clearForm(); msg.textContent='Saved'; setTimeout(()=>msg.textContent='',1200); });
  editingId = null;
  imageKeyForEditing = null;
}

function cancelEdit(){
  editingId = null;
  imageKeyForEditing = null;
  clearForm();
}

function clearForm(){
  p_name.value=''; p_prefix.value='AI: '; p_system.value=''; p_summary.value=''; p_imagefile.value=''; imageDataUrl = null; p_preview.style.display='none';
  createBtn.style.display='inline-block';
  updateBtn.style.display='none';
  cancelBtn.style.display='none';
}

async function deletePersona(id){
  if (id === '__default'){ alert('Default persona cannot be deleted'); return; }
  if (!confirm('Delete persona?')) return;
  // remove local image if present
  const p = personas.find(x=>x.id===id);
  if (p && p.image) await removeLocal(p.image);
  personas = personas.filter(p=>p.id!==id);
  savePersonasAndNotify(()=>{ renderPersonaList(); msg.textContent='Deleted'; setTimeout(()=>msg.textContent='',1200); });
  chrome.storage.sync.get({ activePersonaId: null }, (it)=> {
    if (it.activePersonaId === id) chrome.storage.sync.set({ activePersonaId: '__default' });
  });
  if (id === activeSelect.value){ setActivePersona('__default'); }
}

// set action icon from data URL (tries imageData path first)
async function setExtensionIconFromDataUrl(dataUrl){
  if (!dataUrl) return;
  try {
    // Prefer imageData form (supported by chrome.action.setIcon)
    const variants = await makeIconImageDataVariants(dataUrl);
    chrome.action.setIcon({ imageData: variants }, ()=> { if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError); });
  } catch (e){
    // fallback: write temporary file approach is not available from options page,
    // so as a last resort try setIcon with path if you have a blob URL (rare).
    console.error('Failed to set icon from dataUrl', e);
  }
}

function makeIconImageDataVariants(dataUrl, sizes = [16,32,48,128]){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const result = {};
      for (const s of sizes){
        const c = document.createElement('canvas');
        c.width = s; c.height = s;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, s, s);
        result[s] = ctx.getImageData(0,0,s,s);
      }
      resolve(result);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function applyPersonaIconById(id){
  // restore manifest default icons
  const restoreDefault = () => {
    const url = chrome.runtime.getURL("icon.png");
    makeIconImageDataVariants(url).then((variants) => {
      chrome.action.setIcon({ imageData: variants }, ()=> { if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError); });
    });
  };

  if (!id || id === '__default'){
    restoreDefault();
    return;
  }

  const p = personas.find(x => x.id === id);
  if (!p){
    restoreDefault();
    return;
  }

  if (p._imageData){
    try {
      await setExtensionIconFromDataUrl(p._imageData);
      return;
    } catch (e){
      console.error('set icon from memory failed', e);
    }
  }

  if (p.image){
    try {
      const res = await getLocal(p.image);
      if (res && res[p.image]){
        p._imageData = res[p.image];
        await setExtensionIconFromDataUrl(res[p.image]);
        return;
      }
    } catch (e){
      console.error('load local image failed', e);
    }
  }

  // no image available — restore default
  restoreDefault();
}


function setActivePersona(id){
  chrome.storage.sync.set({ activePersonaId: id }, ()=>{ 
    msg.textContent='Active persona set'; 
    setTimeout(()=>msg.textContent='',1200); 
    renderActiveSelect();
    try { applyPersonaIconById(id); } catch(e){ console.error(e); }
    const p = personas.find(x => x.id === id);
    if (!p || p.id === '__default'){
      chrome.action.setTitle({ title: "Personify" });
    }else{
      chrome.action.setTitle({ title: p.name });
    }
  });
}

activeSelect.addEventListener('change', ()=> {
  const id = activeSelect.value || '__default';
  chrome.storage.sync.set({ activePersonaId: id }, () => {
    msg.textContent = 'Active persona saved';
    setTimeout(()=>msg.textContent='',1200);
    try { applyPersonaIconById(id); } catch(e){ console.error(e); }
    const p = personas.find(x => x.id === id);
    if (!p || p.id === '__default'){
      chrome.action.setTitle({ title: "Personify" });
    }else{
      chrome.action.setTitle({ title: p.name });
    }
  });
});

p_imagefile.addEventListener('change', (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (!f) { imageDataUrl = null; p_preview.style.display='none'; return; }
  const reader = new FileReader();
  reader.onload = () => {
    imageDataUrl = reader.result; // data URL
    p_preview.src = imageDataUrl;
    p_preview.style.display = 'block';
  };
  reader.readAsDataURL(f);
});

clearImage.addEventListener('click', async ()=> {
  // mark clearing: during create, simply clear imageDataUrl; during edit, mark imageKeyForEditing=null to remove existing image on save
  imageDataUrl = null;
  p_imagefile.value = '';
  p_preview.style.display = 'none';
  imageKeyForEditing = null;
});

createBtn.addEventListener('click', ()=> createPersona().catch(e=>{ console.error(e); msg.textContent='Error'; }));
updateBtn.addEventListener('click', ()=> updatePersona().catch(e=>{ console.error(e); msg.textContent='Error'; }));
cancelBtn.addEventListener('click', cancelEdit);

saveServerBtn.addEventListener('click', () => {
    const payload = {
        openai_api_url: apiEl.value && apiEl.value.trim() ? apiEl.value.trim() : DEFAULT,
        openai_api_model: apiModel.value && apiModel.value.trim() ? apiModel.value.trim() : '',
        openai_api_temp: parseFloat(apiTemp.value) || 0.0,
        openai_api_topp: parseFloat(apiTopP.value) || 1.0,
        openai_api_key: apiKey.value && apiKey.value.trim() ? apiKey.value.trim() : '',
        openai_api_token: parseInt(apiToken.value, 10) || 4096,
        openai_api_img: parseInt(apiImg.value, 10) || 0
    };
    chrome.storage.sync.set(payload, () => {
        if (chrome.runtime.lastError) console.error(chrome.runtime.lastError);
        msg.textContent = 'Settings saved';
        setTimeout(()=> msg.textContent='', 1200);
    });
});

// ---------- Export / Import ----------

function gatherAllDataForExport(){
  // gathers sync data and local images referenced by personas
  return new Promise((resolve) => {
    chrome.storage.sync.get({ openai_api_url: DEFAULT, personas: [], activePersonaId: null }, async (items) => {
      const personasList = items.personas || [];
      // collect local image keys referenced
      const imageKeys = personasList.map(p => p.image).filter(Boolean);
      // load images from local
      const localImages = {};
      if (imageKeys.length){
        const res = await getLocal(imageKeys);
        for (const k of imageKeys){
          if (res && res[k]) localImages[k] = res[k];
        }
      }
      // package
      resolve({
        meta: { exported_at: new Date().toISOString(), source: 'summarizer-extension' },
        openai_api_url: items.openai_api_url || DEFAULT,
        activePersonaId: items.activePersonaId || null,
        personas: personasList,
        images: localImages
      });
    });
  });
}

exportBtn.addEventListener('click', async () => {
  try {
    const data = await gatherAllDataForExport();
    const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'personas_export_' + (new Date().toISOString().slice(0,19).replace(/[:T]/g,'_')) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    msg.textContent = 'Export prepared';
    setTimeout(()=>msg.textContent='',1200);
  } catch (e) {
    console.error(e);
    msg.textContent = 'Export failed';
    setTimeout(()=>msg.textContent='',2000);
  }
});

// Helper to read file input as text
function readFileAsText(file){
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsText(file);
  });
}

// Show modal and return a Promise that resolves to {mode:'wipe'|'merge', preserveIds:boolean} or null if cancelled
function showImportModal(){
  return new Promise((resolve) => {
    modal.style.display = 'flex';
    const cleanup = () => {
      modal.style.display = 'none';
      modalCancel.removeEventListener('click', onCancel);
      modalMerge.removeEventListener('click', onMerge);
      modalWipe.removeEventListener('click', onWipe);
    };
    function onCancel(){ cleanup(); resolve(null); }
    function onMerge(){ const preserve = !!preserveIdsCb.checked; cleanup(); resolve({mode:'merge', preserveIds:preserve}); }
    function onWipe(){ const preserve = !!preserveIdsCb.checked; cleanup(); resolve({mode:'wipe', preserveIds:preserve}); }
    modalCancel.addEventListener('click', onCancel);
    modalMerge.addEventListener('click', onMerge);
    modalWipe.addEventListener('click', onWipe);
  });
}

// Import with optional mapping file: mapping JSON should be { "oldId1": "newId1", ... }
importBtn.addEventListener('click', ()=> handleImportFile(false));
importWithMapBtn.addEventListener('click', ()=> {
  // prompt user to pick a map file first
  mapFile.click();
  mapFile.onchange = async () => {
    if (!mapFile.files || !mapFile.files[0]) return;
    await handleImportFile(true, mapFile.files[0]);
    mapFile.value = '';
  };
});

async function handleImportFile(useMapFile, mapFileObj){
  const file = importFile.files && importFile.files[0];
  if (!file){ msg.textContent = 'No import file selected'; setTimeout(()=>msg.textContent='',1500); return; }

  let map = null;
  if (useMapFile && mapFileObj){
    try {
      const txt = await readFileAsText(mapFileObj);
      map = JSON.parse(txt);
    } catch (e) {
      console.error(e);
      msg.textContent = 'Invalid map file';
      setTimeout(()=>msg.textContent='',2000);
      return;
    }
  }

  let parsed;
  try {
    const txt = await readFileAsText(file);
    parsed = JSON.parse(txt);
  } catch (e) {
    console.error(e);
    msg.textContent = 'Invalid import file';
    setTimeout(()=>msg.textContent='',2000);
    return;
  }

  // modal: choose wipe vs merge
  const choice = await showImportModal();
  if (!choice){ msg.textContent = 'Import cancelled'; setTimeout(()=>msg.textContent='',1200); return; }

  // Begin import process with progress
  const importedPersonas = parsed.personas || [];
  const importedImages = parsed.images || {}; // { key: dataUrl }
  importProgress.classList.remove('hidden');
  importStatus.textContent = 'Importing images and personas...';
  importBar.style.width = '0%';

  try {
    // total steps: images count + persona metadata save
    const imageKeys = Object.keys(importedImages);
    const totalSteps = Math.max(1, imageKeys.length + 1);
    let done = 0;
    const step = ()=> { done++; importBar.style.width = Math.round(100 * (done/totalSteps)) + '%'; };

    // If wiping, remove all existing persona images from local first
    if (choice.mode === 'wipe'){
      // get all current images and remove them
      const currentImgKeys = personas.map(p=>p.image).filter(Boolean);
      if (currentImgKeys.length){
        await removeLocal(currentImgKeys);
      }
      personas = []; // clear in-memory; will be replaced
    } else {
      // merge: keep current personas
      // ensure personas in memory reflect latest sync store to avoid collisions
      await new Promise((res)=> chrome.storage.sync.get({personas:[]}, (it)=> { personas = it.personas || []; personas = ensureDefaultPersona(personas); res(); }));
    }

    step(); // metadata step placeholder (will be completed at end)

    // Save imported images into local storage. Preserve incoming keys unless mapping provided.
    // If preserveIds is false, we'll remap incoming persona ids to new random ones to avoid collisions.
    const idMap = {}; // oldId -> newId
    for (const p of importedPersonas){
      idMap[p.id] = p.id;
    }
    if (!choice.preserveIds){
      // generate new ids to avoid collisions
      for (const oldId of Object.keys(idMap)){
        idMap[oldId] = uid();
      }
    } else if (map){
      // if user supplied explicit map file, apply it
      for (const oldId of Object.keys(idMap)){
        if (map[oldId]) idMap[oldId] = map[oldId];
      }
    }

    // If merging, ensure no id collision with existing personas; remap imported ids when collision occurs
    if (choice.mode === 'merge'){
      const existingIds = new Set(personas.map(p=>p.id));
      for (const oldId of Object.keys(idMap)){
        let candidate = idMap[oldId];
        while (existingIds.has(candidate)){
          candidate = uid();
        }
        idMap[oldId] = candidate;
      }
    }

    // Now write images using possibly remapped persona ids for keys
    // Imported image keys may be like "persona_img_<oldid>" — handle both that and arbitrary keys.
    const localWrites = {};
    for (const key of imageKeys){
      const dataUrl = importedImages[key];
      // try to detect persona id in key
      const m = key.match(/^persona_img_(.+)$/);
      if (m && idMap[m[1]]){
        const newKey = 'persona_img_' + idMap[m[1]];
        localWrites[newKey] = dataUrl;
      } else {
        // keep original key but avoid collisions by prefixing with import timestamp
        const safeKey = 'imp_' + Date.now() + '_' + key;
        localWrites[safeKey] = dataUrl;
      }
      step();
    }

    // write local images in batches (chrome.storage.local has limits; do sequentially)
    const localKeys = Object.keys(localWrites);
    for (let i=0;i<localKeys.length;i++){
      const k = localKeys[i];
      const obj = {}; obj[k] = localWrites[k];
      await setLocal(obj);
      // small delay to allow progress UI to update smoothly
      await new Promise(r=>setTimeout(r, 60));
    }

    // Now integrate persona metadata using idMap and image key mapping
    const imageKeyReverseMap = {}; // oldImageKey -> newLocalKey
    for (const oldKey of imageKeys){
      const m = oldKey.match(/^persona_img_(.+)$/);
      if (m && idMap[m[1]]){
        imageKeyReverseMap[oldKey] = 'persona_img_' + idMap[m[1]];
      } else {
        // find the prefixed key created earlier
        const candidates = Object.keys(localWrites).filter(k => localWrites[k] === importedImages[oldKey]);
        imageKeyReverseMap[oldKey] = candidates[0] || null;
      }
    }

    // Build final persona objects to save into storage.sync
    const outPersonas = (choice.mode === 'wipe') ? [] : personas.slice(); // copy existing if merging
    for (const src of importedPersonas){
      const newId = idMap[src.id];
      const existingIndex = outPersonas.findIndex(x=>x.id===newId);
      const newPersona = {
        id: newId,
        name: src.name,
        prefix: src.prefix,
        system: src.system,
        summary_prompt: src.summary_prompt,
        image: src.image ? (imageKeyReverseMap[src.image] || null) : null
      };
      if (existingIndex >= 0){
        // overwrite existing
        outPersonas[existingIndex] = newPersona;
      } else {
        outPersonas.push(newPersona);
      }
    }

    // Ensure default persona exists and is first
    const finalPersonas = ensureDefaultPersona(outPersonas);

    // Save personas to sync and set activePersonaId (respect imported activePersonaId if wiping, else keep existing)
    const newActive = (choice.mode === 'wipe') ? (parsed.activePersonaId ? (idMap[parsed.activePersonaId]|| '__default') : '__default') : undefined;

    await new Promise((res)=> {
      const toStore = { personas: finalPersonas };
      if (newActive !== undefined) toStore.activePersonaId = newActive;
      chrome.storage.sync.set(toStore, ()=> { if (chrome.runtime.lastError) console.error(chrome.runtime.lastError); res(); });
    });

    // Update in-memory and UI
    personas = finalPersonas;
    // reload images into _imageData
    await Promise.all(personas.map(async (p) => {
      if (p.image && typeof p.image === 'string' && p.image.startsWith('persona_img_')) {
        const res = await getLocal(p.image);
        p._imageData = res && res[p.image] ? res[p.image] : null;
      } else {
        p._imageData = null;
      }
    }));

    renderPersonaList();
    importBar.style.width = '100%';
    importStatus.textContent = 'Import complete';
    msg.textContent = 'Import successful';
    setTimeout(()=>msg.textContent='',1600);
  } catch (e){
    console.error(e);
    importStatus.textContent = 'Import failed';
    msg.textContent = 'Import failed';
    setTimeout(()=>msg.textContent='',2000);
  } finally {
    // hide progress after short delay
    setTimeout(()=> importProgress.classList.add('hidden'), 800);
  }
}

// initial load
loadAll();
