/* content_capture.js */
async function capturePageContent(maxImages = 6, providedScreenshotDataUrl = null, maxImageWidth = 1024) {
  const text = document.body ? document.body.innerText.replace(/\s{2,}/g, ' ').trim() : '';

  async function dataURLFromBlobAndMeta(blob, hintSrc = '') {
    try {
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, maxImageWidth / Math.max(1, bitmap.width));
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, w, h);
      const resizedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
      const arr = await resizedBlob.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(arr);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const b64 = btoa(binary);
      return { data_url: `data:image/jpeg;base64,${b64}`, width: w, height: h, size: resizedBlob.size, src: hintSrc };
    } catch (e) {
      return null;
    }
  }

  async function fetchToDataURL(src) {
    try {
      const resp = await fetch(src, { mode: 'cors' });
      if (!resp.ok) throw new Error('fetch failed');
      const blob = await resp.blob();
      return await dataURLFromBlobAndMeta(blob, src);
    } catch (e) {
      return null;
    }
  }

  const imgs = Array.from(document.images || []).filter(i => i.src);
  const results = [];

  // prefer provided screenshot (from chrome.tabs.captureVisibleTab)
  if (providedScreenshotDataUrl) {
    // resize screenshot if needed by drawing it to OffscreenCanvas
    try {
      const img = new Image();
      img.src = providedScreenshotDataUrl;
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
      const scale = Math.min(1, maxImageWidth / Math.max(1, img.width || window.innerWidth));
      const w = Math.round((img.width || window.innerWidth) * scale);
      const h = Math.round((img.height || window.innerHeight) * scale);
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
      const meta = await dataURLFromBlobAndMeta(blob, 'screenshot');
      if (meta) results.push(meta);
    } catch (e) {
      // ignore screenshot failure and continue
    }
  }

  for (const img of imgs) {
    if (results.length >= maxImages) break;
    if (!img.src) continue;
    const r = await fetchToDataURL(img.src);
    if (r) results.push(r);
  }

  return { text, images: results.slice(0, maxImages) };
}
