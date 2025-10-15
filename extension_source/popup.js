/* popup.js */
const DEFAULT_API = "";
const DEFAULT_MODEL = 'gpt-4o-mini-vision';
const DEFAULT_TEMP = 0.7;
const DEFAULT_TOPP = 0.9;
const DEFAULT_TOKEN = 'llama.cpp';
const MAX_IMAGES = 6;
const STREAM_MAX_TOKENS = 8192; // large but configurable
let convo = []; // array of {role, content}
let lastPayload = null;

// persona cache + loader that resolves image keys from local storage
window._ACTIVE_PERSONA = null;
window._PERSONAS = null;

function updateAvatarUI(){
  let hdr = document.querySelector('header');
  if (!hdr) return;
  let avatar = document.getElementById('personaAvatar');
  if (!avatar){
    avatar = document.createElement('img');
    avatar.id = 'personaAvatar';
    avatar.style.width = '42px';
    avatar.style.height = '42px';
    avatar.style.borderRadius = '8px';
    avatar.style.objectFit = 'cover';
    avatar.style.position = 'absolute';
    avatar.style.right = '12px';
    avatar.style.top = '12px';
    hdr.appendChild(avatar);
  }
  const p = window._ACTIVE_PERSONA || {};
  if (p._imageData){
    avatar.src = p._imageData;
    avatar.style.display = 'block';
    avatar.title = p.name || 'AI';
  } else {
    avatar.style.display = 'none';
  }
  document.getElementById('header-title').textContent = avatar.title || 'Personify';
}

async function loadPersonasCache() {
  chrome.storage.sync.get({ personas: [], activePersonaId: null }, async (items) => {
    let raw = items.personas || [];
    // ensure default present
    const hasDefault = raw.some(p=>p && p.id==='__default');
    if (!hasDefault){
      raw.unshift({
        id: '__default',
        name: 'Default',
        prefix: 'AI: ',
        system: 'You are a helpful assistant. Use provided images and text when answering.',
        summary_prompt: 'Summarize the page in 3 concise bullet points, reference images where useful.',
        image: null
      });
    }
    // resolve local image keys to actual data URLs into _imageData
    const loadKeys = {};
    for (const p of raw){
      if (p.image && typeof p.image === 'string' && p.image.startsWith('persona_img_')) loadKeys[p.image] = true;
    }
    const keys = Object.keys(loadKeys);
    let localMap = {};
    if (keys.length){
      localMap = await new Promise(res => chrome.storage.local.get(keys, (r)=> res(r || {})));
    }
    for (const p of raw){
      p._imageData = p.image && localMap[p.image] ? localMap[p.image] : null;
    }
    window._PERSONAS = raw;
    const actId = items.activePersonaId || '__default';
    window._ACTIVE_PERSONA = window._PERSONAS.find(p=>p.id===actId) || window._PERSONAS[0] || null;
    updateAvatarUI();
  });
}
loadPersonasCache();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.personas || changes.activePersonaId)) loadPersonasCache();
  if (area === 'local' && changes) loadPersonasCache(); // refresh when local images change
});



document.getElementById('optionsLink').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', (e)=> {
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
  e.currentTarget.classList.add('active');
  const tab = e.currentTarget.dataset.tab;
  document.getElementById('tab-chat').style.display = tab==='chat' ? '' : 'none';
  document.getElementById('tab-transcript').style.display = tab==='transcript' ? '' : 'none';
}));

document.addEventListener('DOMContentLoaded', function() {
  const userInput = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const chatBtn = document.getElementById('askStartButton');
  userInput.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') {
      event.preventDefault(); // Prevent form submission (if it was a form)
      sendBtn.click();
    }
  });
  chatBtn.click();
  chatBtn.style.display = "none";
});


async function getApiUrl() {
  return new Promise(res => chrome.storage.sync.get({ openai_api_url: DEFAULT_API }, items => res(items.openai_api_url || DEFAULT_API)));
}

async function getApiModel() {
  return new Promise(res => chrome.storage.sync.get({ openai_api_model: DEFAULT_MODEL }, items => res(items.openai_api_model || DEFAULT_MODEL)));
}

async function getApiTemp() {
  return new Promise(res => chrome.storage.sync.get({ openai_api_temp: DEFAULT_TEMP }, items => res(items.openai_api_temp || DEFAULT_TEMP)));
}

async function getApiTopP() {
  return new Promise(res => chrome.storage.sync.get({ openai_api_topp: DEFAULT_TOPP }, items => res(items.openai_api_topp || DEFAULT_TOPP)));
}

async function getApiKey() {
  return new Promise(res => chrome.storage.sync.get({ openai_api_key: DEFAULT_TOKEN }, items => res(items.openai_api_key || DEFAULT_TOKEN)));
}

async function getApimaxTokens() {
  return new Promise(res => chrome.storage.sync.get({ openai_api_token: STREAM_MAX_TOKENS }, items => res(items.openai_api_token || STREAM_MAX_TOKENS)));
}

async function getApimaxImg() {
  return new Promise(res => chrome.storage.sync.get({ openai_api_img: MAX_IMAGES }, items => res(items.openai_api_img || MAX_IMAGES)));
}

// Persona-aware UI helpers
function getActivePersonaSync() {
  // synchronous read from cached personas; ensure options page writes to chrome.storage.sync.personas and chrome.storage.sync.activePersonaId
  return window._ACTIVE_PERSONA || { id: null, name: 'AI', prefix: 'AI: ', system: 'You are a helpful assistant. Use provided images and text when answering.', summary_prompt: 'Summarize the page in 3 concise bullet points, reference images where useful.' };
}

// Minimal Markdown -> HTML renderer (supports headings, bold, italics, links, lists, code blocks)
function mdEscape(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function renderMarkdownToHtml(md){
  // Normalize input to string
  md = md == null ? '' : String(md);

  // simple block-splitting
  const lines = md.split(/\r?\n/);
  let out = '';
  let inCode = false, codeLang = '', inList = false, listType = '';
  for (let raw of lines){
    if (raw.startsWith('```')) {
      if (!inCode) { inCode = true; codeLang = raw.slice(3).trim(); out += `<pre><code class="lang-${mdEscape(codeLang)}">`; }
      else { inCode = false; out += `</code></pre>`; }
      continue;
    }
    if (inCode) { out += mdEscape(raw) + '\n'; continue; }

    // headings
    const h = raw.match(/^(#{1,6})\s+(.*)/);
    if (h) { const lvl = h[1].length; out += `<h${lvl}>${inline(mdEscape(h[2]))}</h${lvl}>`; continue; }

    // unordered list
    const ul = raw.match(/^\s*[-*+]\s+(.*)/);
    if (ul) {
      if (!inList) { inList = true; listType = 'ul'; out += '<ul>'; }
      out += `<li>${inline(mdEscape(ul[1]))}</li>`;
      continue;
    }
    // ordered list
    const ol = raw.match(/^\s*\d+\.\s+(.*)/);
    if (ol) {
      if (!inList) { inList = true; listType = 'ol'; out += '<ol>'; }
      out += `<li>${inline(mdEscape(ol[1]))}</li>`;
      continue;
    }
    if (inList) { out += listType === 'ul' ? '</ul>' : '</ol>'; inList = false; listType = ''; }

    // blank line => paragraph break
    if (raw.trim() === '') { out += '<p></p>'; continue; }

    // paragraph
    out += `<span>${inline(mdEscape(raw))}</span><br />`;
  }
  if (inList) out += listType === 'ul' ? '</ul>' : '</ol>';
  if (inCode) out += '</code></pre>';
  return out;

  // inline formatting: links, bold, italics, inline code
  function inline(text){
    // text already escaped by mdEscape before call in block-level code above
    // Protect against operating on HTML tags we've already introduced:
    // We'll avoid transforming inside existing tags by temporarily marking them.
    const placeholders = [];
    const pushPlaceholder = (s) => {
      const key = `@@PH${placeholders.length}@@`;
      placeholders.push(s);
      return key;
    };
    // Temporarily hide code tags (we won't get here for fenced code, but inline code must be handled)
    // handle inline code first and replace with placeholder
    text = text.replace(/`([^`]+)`/g, (m, g1) => pushPlaceholder(`<code>${mdEscape(g1)}</code>`));

    // handle standard markdown links [text](url) - non-greedy label and url
    text = text.replace(/$$([^$$]+?)\]$\s*(<)?([^)>\s]+?)(>)?\s*$/g, (m, label, lbr, url) => {
      // url may be percent-encoded or contain entities; it was escaped earlier, so unescape for href then re-escape properly
      const href = mdEscape(url);
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });

    // handle autolinks like <http://...> where mdEscape turned < into &lt;, so match that
    text = text.replace(/&lt;(https?:\/\/[^>]+)&gt;/g, (m,g1)=>`<a href="${mdEscape(g1)}" target="_blank" rel="noopener noreferrer">${mdEscape(g1)}</a>`);

    // handle plain URLs (avoid those already inside an anchor)
    // We avoid matching URLs that are already inside tags by ensuring preceding char isn't '>' (end of a tag) or part of href
    text = text.replace(/(^|[^">])((https?:\/\/)[\w\-@:%._+~#=\/?&()[\]\u00A0-\uFFFF,:;!*'~-]+)(?=$|[\s<])/g, (m, p1, p2) => {
      return `${p1}<a href="${mdEscape(p2)}" target="_blank" rel="noopener noreferrer">${mdEscape(p2)}</a>`;
    });

    // bold (strong) — handle **text**
    text = text.replace(/\*\*([^*]+)\*\*/g, (m,g1)=>`<strong>${g1}</strong>`);

    // italics (single asterisks) but avoid clobbering bold (already processed)
    text = text.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, (m,a,b,c)=>`${a}<em>${b}</em>${c}`);

    // restore placeholders
    placeholders.forEach((p, i) => {
      text = text.replace(`@@PH${i}@@`, p);
    });

    return text;
  }
}


function setStatus(msg, isErr=false){ const s=document.getElementById('status'); s.textContent=msg; s.style.color=isErr? '#ff7a7a':''; }

// DOM helpers for styled label + message
function appendChat(role, text, isHtml=false){
  const persona = getActivePersonaSync();
  const prefix = role === 'user' ? 'You: ' : (persona && persona.prefix) ? persona.prefix : 'AI: ';
  const div = document.createElement('div');
  div.className = 'chat-line '+role;

  const label = document.createElement('span');
  label.className = 'chat-label';
  label.textContent = prefix;

  const msg = document.createElement('span');
  msg.className = 'chat-text';
  if (isHtml) msg.innerHTML = text;
  else msg.textContent = text;

  div.appendChild(label);
  div.appendChild(msg);

  const win = document.getElementById('chatWindow');
  win.appendChild(div);
  win.scrollTop = win.scrollHeight;
}


function ensureAssistantBubbleAndSetText(accHtml){
  const persona = getActivePersonaSync();
  const prefix = (persona && persona.prefix) ? persona.prefix : 'AI: ';
  const win = document.getElementById('chatWindow');
  let last = win.lastElementChild;
  if (!last || !last.classList.contains('assistant')) {
    appendChat('assistant', accHtml, true);
    return;
  }
  if (!last.querySelector('.chat-label')) {
    const label = document.createElement('span');
    label.className = 'chat-label';
    label.textContent = prefix;
    last.insertBefore(label, last.firstChild);
  } else {
    const lbl = last.querySelector('.chat-label');
    if (lbl) lbl.textContent = prefix;
  }
  let msg = last.querySelector('.chat-text');
  if (!msg) {
    msg = document.createElement('span');
    msg.className = 'chat-text';
    last.appendChild(msg);
  }
  accHtml = String(accHtml).replace(/^\s*assistant[:\s-]*/i, '');
  accHtml = accHtml.replace(/^\n/, '');
  msg.innerHTML = accHtml;
  win.scrollTop = win.scrollHeight;
}


function showTranscript(payload){
  lastPayload = payload;
  const container = document.getElementById('transcript');
  container.textContent = ''; // clear previous

  // text block
  const textBlock = document.createElement('pre');
  textBlock.className = 'transcript-text';
  textBlock.textContent = 'TEXT SENT:\n' + (payload.text || '(none)') + '\n';
  container.appendChild(textBlock);

  // images
  if (payload.images && payload.images.length){
    const gallery = document.createElement('div');
    gallery.className = 'transcript-gallery';
    payload.images.forEach((im, i) => {
      // create wrapper with caption
      const wrap = document.createElement('figure');
      wrap.style.display = 'inline-block';
      wrap.style.margin = '6px';
      wrap.style.textAlign = 'center';
      wrap.style.verticalAlign = 'top';

      const img = document.createElement('img');
      img.src = im.data_url;              // expected data URL like "data:image/png;base64,..."
      img.alt = `Image ${i+1}`;
      img.loading = 'lazy';
      img.style.maxWidth = '220px';      // adjust size as desired
      img.style.maxHeight = '160px';
      img.style.objectFit = 'contain';
      img.style.display = 'block';
      img.style.border = '1px solid #ddd';
      img.style.borderRadius = '4px';
      img.style.background = '#fff';

      const cap = document.createElement('figcaption');
      cap.style.fontSize = '11px';
      cap.style.color = '#666';
      cap.textContent = `${i+1}. size:${im.size} bytes ${im.width}x${im.height}`;

      wrap.appendChild(img);
      wrap.appendChild(cap);
      gallery.appendChild(wrap);
    });
    container.appendChild(gallery);
  }
}


async function capturePage() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id === undefined) throw new Error('No active tab');

  // capture visible tab screenshot (PNG data URL)
  let screenshotDataUrl = null;
  try {
    // captureVisibleTab is available to extension pages/service worker (popup); windowId null = current window
    screenshotDataUrl = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(dataUrl);
      });
    });
  } catch (e) {
    // ignore screenshot failure, continue without screenshot
    screenshotDataUrl = null;
  }

  // inject content script
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_capture.js'] });

  // call capturePageContent and pass screenshotDataUrl as second arg (content script signature:
  // capturePageContent(maxImages, providedScreenshotDataUrl, maxImageWidth))
  const apimaxImg = await getApimaxImg();

  const res = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (max, screenshot) => capturePageContent(max, screenshot),
    args: [apimaxImg, screenshotDataUrl]
  });

  return res && res[0] && res[0].result ? res[0].result : { text: '', images: [] };
}

// Build OpenAI-compatible messages array with multimodal content and persona system prompt
function buildMessagesForRequest(pageText, images, userPrompt, history=[]){
  const persona = window._ACTIVE_PERSONA || { system:'You are a helpful assistant. Use provided images and text when answering.' };
  const content = [];
  if (images && images.length) {
    for (const im of images) {
      content.push({ type: 'image_url', image_url: { url: im.data_url } });
    }
  }
  if (pageText && pageText.length) {
    content.push({ type: 'text', text: pageText });
  }
  content.push({ type: 'text', text: userPrompt });

  const messages = [];
  // Use persona.system if present
  messages.push({ role: 'system', content: [{ type:'text', text: persona.system || 'You are a helpful assistant. Use provided images and text when answering.' }] });
  for (const m of history) {
    messages.push({ role: m.role, content: [{ type:'text', text: m.content }] });
  }
  messages.push({ role: 'user', content });
  return messages;
}


// Send chat/completions JSON; tries streaming (stream=true), parsing SSE/ndjson
async function sendChatRequest(messages, stream=true, onChunk=null) {
  const apiUrl = await getApiUrl();
  const apiModel = await getApiModel(); // gpt-4o-mini-vision
  const apimaxTokens = await getApimaxTokens(); // STREAM_MAX_TOKENS
  const apiTemp = await getApiTemp(); // 0.7
  const apiTopP = await getApiTopP(); // 0.9
  const apiKey = await getApiKey(); // llama.cpp
  const endpoint = apiUrl.replace(/\/+$/,'') + '/v1/chat/completions';

  // Build base body with original keys (kept for compatibility)
  const baseBody = {
    model: apiModel, // server ignores model names but keep compatible; change if needed
    messages,
    stream: !!stream,
    max_tokens: apimaxTokens,
    temperature: apiTemp,
    top_p: apiTopP
  };

  // Persistent compatibility flag for this endpoint URL: once we detect the need to
  // use compat keys/values, we keep using them until the endpoint changes.
  // Store on the function object keyed by endpoint to avoid global state collisions.
  sendChatRequest._compat = sendChatRequest._compat || {};
  const endpointKey = endpoint;
  const endpointCompat = sendChatRequest._compat[endpointKey] || { useCompat: false };

  // Build a compatibility body from an original body:
  const buildCompatBody = (orig) => {
    const b = { ...orig };
    // Replace unsupported keys with newer names
    if ('max_tokens' in b) {
      b.max_completion_tokens = b.max_tokens;
      delete b.max_tokens;
    }
    // Remove top_p if server doesn't support it for the model
    if ('top_p' in b) {
      // some servers/models don't accept top_p; remove to be safe in compat mode
      delete b.top_p;
    }
    // If temperature is present but the model only supports default 1,
    // set temperature to 1 (server may still reject unknown values, so use default).
    if ('temperature' in b) {
      b.temperature = 1;
    }
    return b;
  };

  // Determine which body to send based on persistent compat flag
  const initialBody = endpointCompat.useCompat ? buildCompatBody(baseBody) : baseBody;

  const headers = { 'Content-Type': 'application/json', 'Authorization':'Bearer ' + apiKey };

  // Helper to perform request and return response; don't throw here so caller can inspect status/text
  const doRequestRaw = async (body) => {
    return fetch(endpoint, { method:'POST', headers, body: JSON.stringify(body) });
  };

  // Helper to check if error text indicates any of the known unsupported params/values
  const needsCompatFromErrorText = (txt) => {
    if (!txt) return false;
    // look for messages indicating unsupported parameters or unsupported temperature value
    const checks = [
      /Unsupported parameter:\s*'max_tokens'/i,
      /Unsupported parameter:\s*'top_p'/i,
      /Unsupported value:\s*'temperature'/i,
      /does not support .*temperature/i
    ];
    return checks.some((r) => r.test(txt));
  };

  // Try initial request (may be original or already compat depending on stored flag)
  let resp = await doRequestRaw(initialBody);

  // If we get a 400 and we hadn't already been in compat mode, try compat body and set persistent flag.
  if (resp.status === 400 && !endpointCompat.useCompat) {
    const txt = await resp.text().catch(()=>null) || '';
    if (needsCompatFromErrorText(txt)) {
      // mark compat mode for this endpoint so future requests use compat body automatically
      sendChatRequest._compat[endpointKey] = { useCompat: true };
      const compatBody = buildCompatBody(baseBody);
      resp = await doRequestRaw(compatBody);
    } else {
      // Reconstruct error body text for thrown error
      throw new Error(`Server ${resp.status}: ${txt}`);
    }
  }

  // If still not ok, throw with body text
  if (!resp.ok) {
    const txt = await resp.text().catch(()=>null);
    throw new Error(`Server ${resp.status}: ${txt}`);
  }

  if (!stream) return resp.json();

  // streaming path: parse SSE-ish "data: ..." or ndjson lines
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx+1);
      if (!line) continue;
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const obj = JSON.parse(payload);
          // Chat-completions stream shape: choices[].delta.{content} or choices[].delta?.content
          const delta = obj.choices?.[0]?.delta;
          let text = delta?.content ?? obj.choices?.[0]?.message?.content ?? obj.choices?.[0]?.text ?? obj.content;
          if (typeof text === 'object' && text !== null) {
            if (text.content) text = text.content;
            else text = JSON.stringify(text);
          }
          if (text && onChunk) {
            // strip leading role tokens like "assistant" that some servers include
            text = String(text).replace(/^\s*assistant[:\s-]*/i, '');
            onChunk(text);
          }
        } catch (e) { if (onChunk) onChunk(payload); }
      } else {
        try {
          const obj = JSON.parse(line);
          let text = obj.choices?.[0]?.delta?.content ?? obj.choices?.[0]?.message?.content ?? obj.content ?? obj.choices?.[0]?.text;
          if (typeof text === 'object' && text !== null) {
            if (text.content) text = text.content;
            else text = JSON.stringify(text);
          }
          if (text && onChunk) {
            text = String(text).replace(/^\s*assistant[:\s-]*/i, '');
            onChunk(text);
          }
        } catch (e) { if (onChunk) onChunk(line); }
      }
    }
    if (buf.length > 10000) { if (onChunk) onChunk(buf); buf=''; }
  }
  if (buf.trim()) {
    try { const obj = JSON.parse(buf); let text = obj.choices?.[0]?.message?.content ?? obj.choices?.[0]?.delta?.content ?? obj.content ?? obj.choices?.[0]?.text; if (typeof text === 'object' && text !== null) { if (text.content) text = text.content; else text = JSON.stringify(text); } if (text && onChunk) onChunk(String(text).replace(/^\s*assistant[:\s-]*/i, '')); }
    catch(e){ if (onChunk) onChunk(buf); }
  }
}

// UI handlers
document.getElementById('summarizeButton').addEventListener('click', async () => {
  try {
    setStatus('Capturing page...');
    const page = await capturePage();
    setStatus('Preparing request...');
    const persona = window._ACTIVE_PERSONA || {};
    const userPrompt = persona.summary_prompt || 'Summarize the page in 3 concise bullet points, reference images where useful.';
    const messages = buildMessagesForRequest(page.text, page.images, userPrompt, convo.slice(-6));
    showTranscript({ text: page.text, images: page.images });
    document.getElementById('chatWindow').textContent = '';
    appendChat('user', (persona && persona.prefix) ? persona.prefix.replace(/:\s*$/,'') + ': Summarize page (multimodal)' : 'You: Summarize page (multimodal)');
    convo.push({ role:'user', content: userPrompt });

    let acc = '';
    await sendChatRequest(messages, true, (chunk) => {
      acc += chunk;
      const html = renderMarkdownToHtml(acc);
      ensureAssistantBubbleAndSetText(html);
      setStatus('Streaming...');
    });
    setStatus('Done');
    convo.push({ role:'assistant', content: acc });
  } catch (err) {
    setStatus(err.message || String(err), true);
    // fallback non-stream
    try {
      const page = await capturePage();
      const persona = window._ACTIVE_PERSONA || {};
      const messages = buildMessagesForRequest(page.text, page.images, persona.summary_prompt || 'Summarize the page in 3 concise bullet points.', convo.slice(-6));
      const data = await sendChatRequest(messages, false, null);
      let out = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? JSON.stringify(data);
      if (typeof out === 'object') out = out.content ?? JSON.stringify(out);
      out = String(out).replace(/^\s*assistant[:\s-]*/i, '');
      const html = renderMarkdownToHtml(out);
      appendChat('assistant', html, true);
      convo.push({ role:'assistant', content: out });
      showTranscript({ text: page.text, images: page.images });
    } catch(e2){ setStatus(e2.message||String(e2), true); }
  }
});

document.getElementById('askStartButton').addEventListener('click', () => {
  document.getElementById('chatInputRow').style.display = '';
  document.getElementById('userInput').value = '';
  appendChat('user', 'Start chat about page');
  setStatus('Chat mode active');
});

document.getElementById('sendBtn').addEventListener('click', async () => {
  const input = document.getElementById('userInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendChat('user', text);
  convo.push({ role:'user', content: text });
  setStatus('Capturing page...');
  const page = await capturePage();
  showTranscript({ text: page.text, images: page.images });

  // include recent convo in messages
  const history = convo.slice(-6);
  const messages = buildMessagesForRequest(page.text, page.images, text, history);

  let acc = '';
  try {
    await sendChatRequest(messages, true, (chunk) => {
      acc += chunk;
      const html = renderMarkdownToHtml(acc);
      ensureAssistantBubbleAndSetText(html);
      setStatus('Streaming...');
    });
    setStatus('Done');
    convo.push({ role:'assistant', content: acc });
  } catch (e) {
    setStatus(e.message || String(e), true);
    try {
      const data = await sendChatRequest(messages, false, null);
      let out = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? JSON.stringify(data);
      if (typeof out === 'object') out = out.content ?? JSON.stringify(out);
      out = String(out).replace(/^\s*assistant[:\s-]*/i, '');
      const html = renderMarkdownToHtml(out);
      appendChat('assistant', html, true);
      convo.push({ role:'assistant', content: out });
    } catch (e2) {
      setStatus(e2.message || String(e2), true);
    }
  }
});
