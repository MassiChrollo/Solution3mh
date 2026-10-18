// ==UserScript==
// @name         IKEA 3D Model Downloader
// @namespace    https://cabinet-studio.local/
// @version      1.1.0
// @description  Adds an authorized 3D model download button to IKEA product pages.
// @match        https://www.ikea.com/*
// @match        https://*.ikea.com/*
// @match        https://www.ikea.ca/*
// @match        https://*.ikea.ca/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const modelUrls = new Set();
  const observedViewers = new WeakSet();
  const modelPattern = /\.glb(?:$|[?#])|glb_draco/i;
  let attachedButton;
  let currentRoute = location.pathname + location.search;

  function rememberModelUrl(value) {
    if (!value) return;
    try {
      const url = new URL(value, location.href);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && modelPattern.test(url.href)) {
        modelUrls.add(url.href);
      }
    } catch (error) {
      console.debug('IKEA 3D downloader ignored an invalid model URL.', error);
    }
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    rememberModelUrl(args[0] instanceof Request ? args[0].url : args[0]?.toString());
    return originalFetch.apply(this, args);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    rememberModelUrl(url?.toString());
    return originalOpen.call(this, method, url, ...rest);
  };

  if ('PerformanceObserver' in window) {
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) rememberModelUrl(entry.name);
      }).observe({ entryTypes: ['resource'] });
    } catch (error) {
      console.debug('IKEA 3D downloader could not observe resource loads.', error);
    }
  }

  function inspectModelViewer(element) {
    if (observedViewers.has(element)) return;
    observedViewers.add(element);
    const update = () => rememberModelUrl(element.getAttribute('src'));
    update();
    new MutationObserver(update).observe(element, { attributes: true, attributeFilter: ['src'] });
  }

  function findViewerButton() {
    const button = document.querySelector('.pipf-xr-button, .pip-xr-button');
    if (button) return button;
    for (const path of document.querySelectorAll('button svg path')) {
      const data = path.getAttribute('d') || '';
      if (data.includes('M11 16.9766') && data.includes('3.5146-3.864')) {
        return path.closest('button');
      }
    }
    return null;
  }

  function productFilename(url) {
    const title = document.querySelector('title')?.textContent?.trim() || 'ikea_product';
    const parts = title.split(' - IKEA')[0].split(',');
    const productName = parts[0].trim() || 'ikea_product';
    const variant = parts.length > 1 ? parts.slice(1).join(',').trim() : '';
    const productId = url.match(/\/(\d+)_/)?.[1] || url.match(/\/(\d+)\//)?.[1] || '';
    const name = [productName, variant, productId ? `(${productId})` : ''].filter(Boolean).join(' ');
    return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'ikea_product';
  }

  async function downloadModel(url) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`Model download failed (HTTP ${response.status}).`);

    const data = await response.arrayBuffer();
    if (data.byteLength < 12) throw new Error('The selected resource is not a valid GLB file.');
    const signature = new DataView(data).getUint32(0, true);
    if (signature !== 0x46546c67) {
      throw new Error('The selected resource is not a valid GLB file.');
    }

    const objectUrl = URL.createObjectURL(new Blob([data], { type: 'model/gltf-binary' }));
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `${productFilename(url)}.glb`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }

  function newestModelUrl() {
    const urls = Array.from(modelUrls);
    return urls[urls.length - 1];
  }

  async function downloadFromProduct(viewerButton) {
    try {
      let url = newestModelUrl();
      if (!url) {
        viewerButton.click();
        for (let attempt = 0; attempt < 30 && !url; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 500));
          for (const viewer of document.querySelectorAll('model-viewer')) {
            rememberModelUrl(viewer.getAttribute('src'));
          }
          url = newestModelUrl();
        }
      }
      if (!url) throw new Error('No 3D model was found. Try refreshing the product page and opening its 3D viewer.');
      await downloadModel(url);
    } catch (error) {
      console.error('IKEA 3D model download failed.', error);
      alert(`IKEA 3D model download failed: ${error.message}`);
    }
  }

  function addDownloadButton(viewerButton) {
    if (attachedButton?.isConnected && attachedButton.previousElementSibling === viewerButton) return;
    attachedButton?.remove();

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Download 3D model';
    button.setAttribute('aria-label', 'Download 3D model');
    button.style.cssText = 'margin:8px;padding:10px 16px;border:0;border-radius:4px;background:#0058a3;color:white;font:inherit;font-weight:600;cursor:pointer;';
    button.addEventListener('click', () => downloadFromProduct(viewerButton));
    viewerButton.insertAdjacentElement('afterend', button);
    attachedButton = button;
  }

  function scanPage() {
    for (const viewer of document.querySelectorAll('model-viewer')) inspectModelViewer(viewer);
    const viewerButton = findViewerButton();
    if (viewerButton) addDownloadButton(viewerButton);
  }

  function handleRouteChange() {
    const nextRoute = location.pathname + location.search;
    if (nextRoute !== currentRoute) {
      currentRoute = nextRoute;
      modelUrls.clear();
      attachedButton?.remove();
      attachedButton = null;
    }
    setTimeout(scanPage, 0);
  }

  function start() {
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        handleRouteChange();
        return result;
      };
    }
    window.addEventListener('popstate', handleRouteChange);
    window.addEventListener('hashchange', handleRouteChange);
    scanPage();
    new MutationObserver(scanPage).observe(document.documentElement, { subtree: true, childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
