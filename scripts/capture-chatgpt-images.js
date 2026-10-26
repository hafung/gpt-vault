// Evaluated only inside the verified, logged-in Desktop page. Native download
// headers never cross CDP; only validated image bytes leave the page.
(async ({job, conversation, bindings, deadline, budget}) => {
  const sources = new Map(), known = job.known_images || {};
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
  for (const message of conversation?.messages || []) {
    visit(message.content);
    for (const key of ['content_references', 'model_dil_v2']) visit(message.metadata?.[key]);
  }
  const items = [];
  let bytes = 0;
  if (!sources.size) return JSON.stringify({kind:'images', id:job.id, images:[], pending_images:0, bytes});
  try {
    if (location.origin !== 'app://-' || !bindings?.module || !bindings.download || !bindings.resolver) throw Error('Image module unavailable');
    const native = await import(bindings.module);
    const context = native[bindings.resolver](job.id);
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
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob);
        });
        items.push({reference:source.reference, data}); bytes += blob.size;
      } catch { /* A missing image never prevents text or other images from syncing. */ }
    }
  } catch { /* Unsupported Desktop builds retain references and can retry later. */ }
  return JSON.stringify({kind:'images', id:job.id, images:items, pending_images:sources.size-items.length, bytes});
})
