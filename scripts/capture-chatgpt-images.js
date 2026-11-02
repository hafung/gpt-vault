// Evaluated only inside the verified, logged-in Desktop page. Native download
// headers never cross CDP; only file bytes and original references leave the page.
(async ({job, conversation, bindings, deadline, budget}) => {
  const sources = new Map(), known = job.known_images || {};
  const files = new Map(), knownFiles = job.known_files || {};
  const addFile = (reference, message_id) => {
    if (typeof reference !== 'string' || !reference.startsWith('sandbox:/') || reference.startsWith('sandbox://')) return;
    try { reference = 'sandbox:' + decodeURIComponent(reference.slice(8)); } catch { return; }
    if (reference.length > 4104 || /[\x00\r\n\\]/.test(reference) || !message_id) return;
    if (!knownFiles[reference] && !files.has(reference)) files.set(reference, {reference, message_id});
  };
  const add = (reference, urls = []) => {
    if (reference && !known[reference] && !sources.has(reference)) sources.set(reference, {reference, urls});
  };
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 40) return;
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
    const pointer = value.asset_pointer || value.image_asset_pointer?.asset_pointer;
    if (typeof pointer === 'string' && /^(sediment|file-service):\/\//.test(pointer)) add(pointer);
    const urls = [value.content_url, value.original_content_url, value.thumbnail_url, value.src]
      .filter(url => typeof url === 'string' && /^https?:\/\//.test(url));
    if (urls.length) add(urls[0], [...new Set(urls)]);
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  for (const source of job.images || []) add(source.reference, source.urls);
  // Job references have already been decoded once by the archive.
  for (const source of job.files || []) {
    if (!knownFiles[source.reference]) files.set(source.reference, source);
  }
  for (const message of conversation?.messages || []) {
    visit(message.content);
    for (const key of ['content_references', 'model_dil_v2']) visit(message.metadata?.[key]);
    const scan = (value, depth = 0) => {
      if (depth > 40 || value == null) return;
      if (typeof value === 'string') {
        for (const match of value.matchAll(/sandbox:\/[^\s<>"`)\]]+/g)) addFile(match[0], message.id);
      } else if (Array.isArray(value)) value.forEach(v => scan(v, depth + 1));
      else if (typeof value === 'object') Object.values(value).forEach(v => scan(v, depth + 1));
    };
    scan(message.content);
    scan(message.metadata?.model_dil_v2?.appData);
  }
  const items = [], fileItems = [];
  let bytes = 0;
  if (!sources.size && !files.size) return JSON.stringify({kind:'images', id:job.id, images:[], files:[], pending_images:0, pending_files:0, bytes});
  try {
    if (location.origin !== 'app://-' || !bindings?.module || !bindings.download) throw Error('Download module unavailable');
    const native = await import(bindings.module);
    const encode = blob => new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob);
    });
    for (const source of [...files.values()].slice(0, 24)) {
      if (!bindings.sandbox || deadline - Date.now() < 1500 || budget - bytes < 1024) break;
      try {
        const signal = AbortSignal.timeout(Math.min(10000, deadline - Date.now() - 500));
        const limit = Math.min(8 * 1024 * 1024, budget - bytes);
        const target = await native[bindings.sandbox]({conversationId:job.id, messageId:source.message_id, sandboxPath:source.reference.slice(8), signal});
        const blob = await native[bindings.download](target, signal, limit);
        if (!blob || blob.size > limit) continue;
        fileItems.push({reference:source.reference, data:await encode(blob)}); bytes += blob.size;
      } catch { /* Expired files retain their original references for later retry. */ }
    }
    const context = bindings.resolver ? native[bindings.resolver](job.id) : null;
    for (const source of [...sources.values()].slice(0, 24)) {
      if (deadline - Date.now() < 1500 || budget - bytes < 1024) break;
      const signal = AbortSignal.timeout(Math.min(10000, deadline - Date.now() - 500));
      try {
        const limit = Math.min(8 * 1024 * 1024, budget - bytes);
        let blob;
        if (/^(sediment|file-service):\/\//.test(source.reference)) {
          const file = source.reference.replace(/^[^:]+:\/\//, '');
          if (!/^[A-Za-z0-9_-]{1,256}$/.test(file)) continue;
          const target = await context.resolveAsset(file);
          if (target.kind !== 'available') continue;
          blob = await native[bindings.download](target, signal, limit);
        } else {
          for (const url of source.urls) {
            try {
              const parsed = new URL(url);
              if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
              const candidate = await native[bindings.download]({downloadUrl: url}, signal, limit);
              if (candidate.size && candidate.type.startsWith('image/')) { blob = candidate; break; }
            } catch { /* Try the original or thumbnail if a publisher blocks downloads. */ }
          }
        }
        if (!blob || !blob.size || blob.size > limit || !blob.type.startsWith('image/')) continue;
        const data = await encode(blob);
        items.push({reference:source.reference, data}); bytes += blob.size;
      } catch { /* A missing image never prevents text or other images from syncing. */ }
    }
  } catch { /* Unsupported Desktop builds retain references and can retry later. */ }
  return JSON.stringify({kind:'images', id:job.id, images:items, files:fileItems, pending_images:sources.size-items.length, pending_files:files.size-fileItems.length, bytes});
})
