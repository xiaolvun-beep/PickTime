/* Original input photos for the first statistics pane. Cached on this device and synced to the account. */
(function () {
  'use strict';
  var dbPromise;
  var selectedDate = null;
  var photos = [];
  var urls = [];
  var noteCache = Object.create(null);
  var repairTried = Object.create(null);
  var loadId = 0;
  var loadedOwner = '';
  var pendingRefreshDate = null;
  var pendingRows = null;
  var open = false;
  var returning = false;
  var viewerIndex = -1;
  var viewerFlipped = false;
  var viewerSaving = false;
  var viewerSource = null;
  var viewerReturnTarget = null;
  var viewerClosing = false;
  var viewerCloseAnimation = null;
  var viewerCloseFlight = null;
  var viewerCloseRun = 0;
  var viewerRestoreFocus = false;
  var viewerPointerId = null;
  var viewerStartX = 0;
  var viewerStartY = 0;
  var viewerDragged = false;
  var suppressViewerClickUntil = 0;
  var timers = [];
  var saveQueue = Promise.resolve();
  var opsQueue = Promise.resolve();
  var nodes;
  var FOLDER_IMAGE_MAX = 3000000;

  function enqueue(task) {
    var run = opsQueue.catch(function () {}).then(task);
    opsQueue = run.catch(function () {});
    return run;
  }

  function el(id) { return document.getElementById(id); }
  function bindNodes() {
    if (nodes) return nodes;
    var card = el('statsFolderCard');
    if (!card) return null;
    nodes = {
      card: card, back: el('statsFolderBack'), front: el('statsFolderFront'),
      gallery: el('statsFolderGallery'), backdrop: el('statsFolderBackdrop'),
      head: el('statsFolderGalleryHead'), date: el('statsFolderGalleryDate'),
      scroll: el('statsFolderGalleryScroll'), grid: el('statsFolderGalleryGrid'),
      cover: el('statsFolderReturnCover'), viewer: el('statsFolderViewer'),
      viewerViewport: el('statsFolderViewerViewport'), viewerTrack: el('statsFolderViewerTrack'),
      viewerDots: el('statsFolderViewerDots'), viewerDone: el('statsFolderViewerDone')
    };
    card.addEventListener('click', function () { if (open) close(); else show(); });
    nodes.backdrop.addEventListener('click', close);
    nodes.grid.addEventListener('click', function (e) {
      var paper = e.target.closest('.stats-folder-gallery__paper');
      if (paper && !paper.classList.contains('is-empty')) openViewer(Number(paper.dataset.index), paper);
    });
    nodes.scroll.addEventListener('click', function (e) {
      if (!e.target.closest('.stats-folder-gallery__paper')) close();
    });
    nodes.viewerDots.addEventListener('click', function (e) {
      var dot = e.target.closest('.stats-folder-viewer__dot');
      if (dot) changeViewer(Number(dot.dataset.index));
    });
    nodes.viewerDone.addEventListener('click', finishViewerNote);
    nodes.viewerViewport.addEventListener('click', function (e) {
      if (Date.now() < suppressViewerClickUntil) return;
      if (viewerFlipped) {
        if (e.target.closest('.stats-folder-viewer__face--back')) {
          nodes.viewerTrack.children[viewerIndex].querySelector('.stats-folder-viewer__editor').focus({ preventScroll: true });
        } else if (!e.target.closest('.stats-folder-viewer__paper')) finishViewerNote();
        return;
      }
      if (e.target.closest('.stats-folder-viewer__face--front')) { flipViewer(); return; }
      if (!e.target.closest('.stats-folder-viewer__paper')) closeViewer();
    });
    nodes.viewerViewport.addEventListener('pointerdown', viewerPointerDown);
    nodes.viewerViewport.addEventListener('pointermove', viewerPointerMove);
    nodes.viewerViewport.addEventListener('pointerup', viewerPointerEnd);
    nodes.viewerViewport.addEventListener('pointercancel', viewerPointerEnd);
    document.addEventListener('keydown', function (e) {
      if (!open) return;
      if (e.key === 'Escape') { e.preventDefault(); if (viewerFlipped) finishViewerNote(); else if (viewerIndex >= 0) closeViewer(false, true); else close(); }
      else if (viewerIndex >= 0 && !viewerFlipped && e.key === 'ArrowLeft') { e.preventDefault(); changeViewer(viewerIndex - 1); }
      else if (viewerIndex >= 0 && !viewerFlipped && e.key === 'ArrowRight') { e.preventDefault(); changeViewer(viewerIndex + 1); }
    });
    window.addEventListener('resize', function () { if (viewerIndex >= 0) updateViewer(false); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) reset(); });
    window.addEventListener('pagehide', reset);
    new MutationObserver(function () {
      if (open && (!document.body.classList.contains('is-stats') || document.body.classList.contains('stats-page2'))) reset();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return nodes;
  }
  function token() {
    try { return localStorage.getItem('picktime-token') || sessionStorage.getItem('picktime-token') || ''; } catch (e) { return ''; }
  }
  function account() {
    var value = token();
    return value ? value.split('.')[0] : '';
  }
  function authHeaders() {
    return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() };
  }
  function dateKey(date) {
    return date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate();
  }
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      var req = indexedDB.open('picktime-folder-photos', 2);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains('photos')) req.result.createObjectStore('photos', { keyPath: 'id' });
        if (!req.result.objectStoreNames.contains('notes')) req.result.createObjectStore('notes', { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('Could not open photo storage')); };
      req.onblocked = function () { reject(new Error('Photo storage blocked')); };
    }).catch(function (err) { dbPromise = null; throw err; });
    return dbPromise;
  }
  function all() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction('photos', 'readonly').objectStore('photos').getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function getRow(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction('photos', 'readonly').objectStore('photos').get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function allNotes() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction('notes', 'readonly').objectStore('notes').getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function getNoteRow(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction('notes', 'readonly').objectStore('notes').get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function noteTransaction(action) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('notes', 'readwrite');
        action(tx.objectStore('notes'));
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error('Note write failed')); };
        tx.onabort = function () { reject(tx.error || new Error('Note write aborted')); };
      });
    });
  }
  function transaction(action) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('photos', 'readwrite');
        action(tx.objectStore('photos'));
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error('Photo write failed')); };
        tx.onabort = function () { reject(tx.error || new Error('Photo write aborted')); };
      });
    });
  }
  function markSynced(id, blob, savedAt) {
    return transaction(function (store) {
      var req = store.get(id);
      req.onsuccess = function () {
        var row = req.result;
        if (!row) return;
        if (blob) row.blob = blob;
        if (savedAt) row.savedAt = savedAt;
        row.synced = 1;
        row.recompressed = 1;
        store.put(row);
      };
    });
  }
  function releaseUrls() {
    urls.forEach(function (url) { URL.revokeObjectURL(url); });
    urls = [];
  }
  function timer(fn, delay) { timers.push(setTimeout(fn, delay)); }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function reset() {
    clearTimers();
    open = false;
    returning = false;
    if (!bindNodes()) return;
    closeViewer(true);
    nodes.gallery.classList.remove('is-open', 'is-entered', 'is-returning', 'is-handed-off');
    nodes.gallery.setAttribute('aria-hidden', 'true');
    nodes.card.classList.remove('is-open', 'is-returning');
    document.body.classList.remove('has-folder-gallery', 'is-folder-returning');
    var refreshDate = pendingRefreshDate;
    var rows = pendingRows;
    pendingRefreshDate = null;
    pendingRows = null;
    if (refreshDate) refresh(refreshDate, true);
    else if (rows) applyRows(rows.owner, rows.key, rows.run, rows.rows);
  }
  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('Could not read photo')); };
      reader.readAsDataURL(blob);
    });
  }
  function dataUrlToBlob(dataUrl) {
    var parts = String(dataUrl || '').split(',');
    var mime = (parts[0] || '').match(/^data:([^;]+)/);
    var binary;
    try { binary = atob(parts[1] || ''); } catch (e) { return null; }
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime ? mime[1] : 'image/jpeg' });
  }
  function repairPhoto(recordId) {
    var owner = account();
    var id = owner + '|' + recordId;
    if (!owner || !recordId || !token() || Date.now() - (repairTried[id] || 0) < 30000) return;
    repairTried[id] = Date.now();
    enqueue(function () {
      if (account() !== owner) return;
      return fetch('/api/folder-photos/' + encodeURIComponent(recordId), { headers: authHeaders() })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          var remote = data && data.photo;
          var blob = remote && dataUrlToBlob(remote.image);
          if (!blob || !blob.size || !blob.type.startsWith('image/')) throw new Error('No recoverable photo');
          return transaction(function (store) {
            var req = store.get(id);
            req.onsuccess = function () {
              var row = req.result;
              if (!row || account() !== owner) return;
              row.blob = blob;
              row.savedAt = Number(remote.savedAt) || row.savedAt;
              row.synced = 1;
              row.recompressed = 1;
              store.put(row);
            };
          }).then(function () {
            if (account() !== owner) return;
            var url = URL.createObjectURL(blob);
            urls.push(url);
            photos.forEach(function (photo, index) {
              if (photo.recordId !== recordId) return;
              photo.url = url;
              var gridImage = nodes.grid.children[index] && nodes.grid.children[index].querySelector('img');
              var viewerImage = nodes.viewerTrack.children[index] && nodes.viewerTrack.children[index].querySelector('.stats-folder-viewer__face--front img');
              if (gridImage) gridImage.src = url;
              if (viewerImage) viewerImage.src = url;
            });
            renderPreview();
          });
        });
    }).catch(function (err) { console.warn('[文件夹照片] 恢复失败:', err); });
  }
  function compressBlob(blob, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        try {
          var sw = img.naturalWidth || img.width;
          var sh = img.naturalHeight || img.height;
          var scale = Math.min(1, maxSide / Math.max(sw, sh));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(sw * scale));
          canvas.height = Math.max(1, Math.round(sh * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not decode photo')); };
      img.src = url;
    });
  }
  function encodeOriginal(blob) {
    if (!blob) return Promise.resolve('');
    // 一律压到最长边 1600px / JPEG 0.82 再传：接近 3M 字符的原图会让小程序端下载中断
    var levels = [[1600, .82], [1280, .78], [1024, .75], [800, .7]];
    return levels.reduce(function (chain, level) {
      return chain.then(function (result) {
        if (result) return result;
        return compressBlob(blob, level[0], level[1]).catch(function () { return ''; });
      });
    }, Promise.resolve('')).then(function (dataUrl) {
      if (dataUrl && dataUrl.length <= FOLDER_IMAGE_MAX) return dataUrl;
      return blobToDataUrl(blob).then(function (raw) {
        return raw && raw.length <= FOLDER_IMAGE_MAX ? raw : '';
      });
    });
  }
  function uploadRow(owner, row, bumpSavedAt) {
    if (!token() || account() !== owner || !row || !row.blob) return Promise.resolve('fail');
    return encodeOriginal(row.blob).then(function (dataUrl) {
      if (!dataUrl) return 'fail';
      // 旧的大图压缩后重传时把 savedAt 抬高，确保覆盖云端旧数据
      var savedAt = bumpSavedAt ? Math.max(Date.now(), Number(row.savedAt) || 0) : row.savedAt;
      return fetch('/api/folder-photos', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ recordId: row.recordId, dateKey: row.dateKey, savedAt: savedAt, image: dataUrl })
      }).then(function (res) {
        if (res.status === 409) return 'gone';
        return res.ok ? { ok: true, dataUrl: dataUrl, savedAt: savedAt } : 'fail';
      }).catch(function () { return 'fail'; });
    }).then(function (state) {
      if (state === 'gone') {
        return transaction(function (store) { store.delete(row.id); })
          .then(function () { return 'gone'; }).catch(function () { return 'gone'; });
      }
      if (!state || state.ok !== true) return 'fail';
      // 上传成功后本地也换成压缩版：省空间，且避免每次同步重复压缩上传
      var blob = dataUrlToBlob(state.dataUrl);
      return markSynced(row.id, blob, state.savedAt).then(function () { return 'ok'; }).catch(function () { return 'fail'; });
    });
  }
  function pushNote(owner, recordId) {
    if (!token() || account() !== owner) return Promise.resolve(false);
    var id = owner + '|' + recordId;
    return Promise.all([getRow(id), getNoteRow(id)]).then(function (result) {
      var photoRow = result[0];
      var noteRow = result[1];
      if (!photoRow || account() !== owner) return false;
      var note = noteRow && Number(noteRow.updatedAt) > (Number(photoRow.noteUpdatedAt) || 0)
        ? noteRow : { note: photoRow.note || '', updatedAt: Number(photoRow.noteUpdatedAt) || 0 };
      if (!note.updatedAt) return false;
      return fetch('/api/folder-photos/' + encodeURIComponent(recordId) + '/note', {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({ note: note.note || '', updatedAt: note.updatedAt })
      }).then(function (res) { return res.ok; }).catch(function () { return false; });
    }).catch(function () { return false; });
  }
  function saveAlbumNote(recordId, note) {
    var owner = account();
    if (!owner || !recordId || note.length > 5000) return Promise.reject(new Error('Could not save album note'));
    var savedAt = 0;
    var id = owner + '|' + recordId;
    return Promise.all([getRow(id), getNoteRow(id)]).then(function (result) {
      if (!result[0] || account() !== owner) throw new Error('Album photo unavailable');
      savedAt = Math.max(Date.now(), (Number(result[0].noteUpdatedAt) || 0) + 1,
        (Number(result[1] && result[1].updatedAt) || 0) + 1);
      var noteRow = { id: id, owner: owner, recordId: recordId, note: note, updatedAt: savedAt };
      // Keep text separate so saving a note never rewrites the photo Blob.
      return noteTransaction(function (store) { store.put(noteRow); }).then(function () { noteCache[id] = noteRow; });
    }).then(function () {
      photos.forEach(function (photo) {
        if (photo.recordId === recordId) { photo.note = note; photo.noteUpdatedAt = savedAt; }
      });
      if (open) pendingRefreshDate = selectedDate;
      enqueue(function () { return pushNote(owner, recordId); }).catch(function () {});
    });
  }
  function flushPending(owner) {
    if (!token() || account() !== owner) return Promise.resolve();
    return enqueue(function () {
      return all().then(function (rows) {
        var pending = rows.filter(function (row) {
          if (row.owner !== owner || !row.blob) return false;
          if (Number(row.synced) !== 1) return true;
          // 旧版上传过的原图未压缩：压缩后覆盖云端，否则小程序端下载会中断
          return !row.recompressed && row.blob.size > 600 * 1024;
        });
        return pending.reduce(function (chain, row) {
          return chain.then(function () { return uploadRow(owner, row, Number(row.synced) === 1); });
        }, Promise.resolve());
      }).catch(function () {});
    });
  }
  function applyRows(owner, key, run, rows) {
    if (run !== loadId || owner !== account()) return;
    if (open) { pendingRows = { owner: owner, key: key, run: run, rows: rows }; return; }
    releaseUrls();
    photos = rows.filter(function (row) { return row.owner === owner && row.dateKey === key && row.blob; })
      .sort(function (a, b) { return b.savedAt - a.savedAt; })
      .map(function (row) {
        var url = URL.createObjectURL(row.blob);
        urls.push(url);
        var cachedNote = noteCache[row.id];
        var useCachedNote = cachedNote && Number(cachedNote.updatedAt) >= (Number(row.noteUpdatedAt) || 0);
        return { url: url, savedAt: row.savedAt, recordId: row.recordId,
          note: useCachedNote ? cachedNote.note || '' : row.note || '',
          noteUpdatedAt: useCachedNote ? Number(cachedNote.updatedAt) || 0 : Number(row.noteUpdatedAt) || 0 };
      });
    renderPreview();
  }
  function syncDate(owner, key, run) {
    if (!token() || account() !== owner) return Promise.resolve();
    return enqueue(function () {
    return fetch('/api/folder-photos?date=' + encodeURIComponent(key), { headers: authHeaders() })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.ok || !Array.isArray(data.photos)) return;
        if (run !== loadId || owner !== account()) return;
        var serverMap = {};
        data.photos.forEach(function (photo) { serverMap[photo.recordId] = photo; });
        return all().then(function (rows) {
          var local = rows.filter(function (row) { return row.owner === owner && row.dateKey === key && row.blob; });
          var localMap = {};
          local.forEach(function (row) { localMap[row.recordId] = row; });
          var downloads = data.photos.filter(function (photo) {
            var row = localMap[photo.recordId];
            return !row || (Number(row.savedAt) || 0) < (Number(photo.savedAt) || 0);
          });
          var uploads = local.filter(function (row) {
            if (!serverMap[row.recordId]) return Number(row.synced) !== 1;
            // 已同步但体积过大的旧原图：压缩重传一次
            return Number(row.synced) === 1 && !row.recompressed && row.blob.size > 600 * 1024;
          });
          var drops = local.filter(function (row) { return Number(row.synced) === 1 && !serverMap[row.recordId]; });
          var chain = Promise.resolve();
          downloads.forEach(function (photo) {
            chain = chain.then(function () {
              if (run !== loadId || owner !== account()) return;
              return fetch('/api/folder-photos/' + encodeURIComponent(photo.recordId), { headers: authHeaders() })
                .then(function (res) { return res.ok ? res.json() : null; })
                .then(function (detail) {
                  if (!detail || !detail.ok || !detail.photo || !detail.photo.image) return;
                  var blob = dataUrlToBlob(detail.photo.image);
                  if (!blob) return;
                  return transaction(function (store) {
                    var id = owner + '|' + photo.recordId;
                    var req = store.get(id);
                    req.onsuccess = function () {
                      var existing = req.result;
                      var cachedNote = noteCache[id];
                      var localNoteAt = Math.max(Number(existing && existing.noteUpdatedAt) || 0,
                        Number(cachedNote && cachedNote.updatedAt) || 0);
                      var remoteNoteAt = Number(detail.photo.noteUpdatedAt) || 0;
                      var localNote = cachedNote && Number(cachedNote.updatedAt) >= (Number(existing && existing.noteUpdatedAt) || 0)
                        ? cachedNote.note || '' : existing && existing.note || '';
                      store.put({ id: id, owner: owner, recordId: photo.recordId,
                        dateKey: photo.dateKey || key, savedAt: Number(photo.savedAt) || Date.now(),
                        blob: blob, synced: 1,
                        note: localNoteAt > remoteNoteAt ? localNote : detail.photo.note || '',
                        noteUpdatedAt: Math.max(localNoteAt, remoteNoteAt) });
                    };
                  });
                }).catch(function () {});
            });
          });
          uploads.forEach(function (row) {
            chain = chain.then(function () { return uploadRow(owner, row, !!serverMap[row.recordId]); });
          });
          drops.forEach(function (row) {
            chain = chain.then(function () {
              if (run !== loadId || owner !== account()) return;
              return transaction(function (store) { store.delete(row.id); });
            });
          });
          return chain.then(function () { return all(); }).then(function (fresh) {
            return fresh.filter(function (row) { return row.owner === owner && row.dateKey === key && row.blob; })
              .reduce(function (notesChain, row) {
                return notesChain.then(function () {
                  var remote = serverMap[row.recordId];
                  var cachedNote = noteCache[row.id];
                  var localAt = Math.max(Number(row.noteUpdatedAt) || 0,
                    Number(cachedNote && cachedNote.updatedAt) || 0);
                  var remoteAt = Number(remote && remote.noteUpdatedAt) || 0;
                  if (remoteAt > localAt) {
                    var noteRow = { id: row.id, owner: owner, recordId: row.recordId,
                      note: remote.note || '', updatedAt: remoteAt };
                    return noteTransaction(function (store) { store.put(noteRow); })
                      .then(function () { noteCache[row.id] = noteRow; });
                  }
                  if (localAt > remoteAt) return pushNote(owner, row.recordId);
                });
              }, Promise.resolve());
          }).then(function () {
            if (run !== loadId || owner !== account()) return;
            return all().then(function (fresh) { applyRows(owner, key, run, fresh); });
          });
        });
      }).catch(function () {});
    });
  }
  function refresh(date, force) {
    if (!bindNodes()) return Promise.resolve();
    var nextDate = date instanceof Date ? new Date(date.getTime()) : new Date(date);
    if (isNaN(nextDate.getTime())) nextDate = new Date();
    var owner = account();
    var key = dateKey(nextDate);
    if (open && !force && selectedDate && dateKey(selectedDate) === key && loadedOwner === owner) {
      pendingRefreshDate = nextDate;
      return Promise.resolve();
    }
    pendingRefreshDate = null;
    pendingRows = null;
    reset();
    selectedDate = nextDate;
    loadedOwner = owner;
    var run = ++loadId;
    releaseUrls();
    photos = [];
    renderPreview();
    if (!owner) return Promise.resolve();
    return Promise.all([all(), allNotes()]).then(function (result) {
      var rows = result[0];
      noteCache = Object.create(null);
      result[1].forEach(function (noteRow) {
        if (noteRow.owner === owner) noteCache[noteRow.id] = noteRow;
      });
      applyRows(owner, key, run, rows);
      return syncDate(owner, key, run);
    }).catch(function () { renderPreview(); });
  }
  function renderPreview() {
    if (!bindNodes()) return;
    var first = photos[0] && photos[0].url;
    var second = photos[1] && photos[1].url;
    var firstRecordId = photos[0] && photos[0].recordId;
    var secondRecordId = photos[1] && photos[1].recordId;
    var frontImage = nodes.front.querySelector('img');
    var backImage = nodes.back.querySelector('img');
    frontImage.onerror = first ? function () { repairPhoto(firstRecordId); } : null;
    backImage.onerror = second ? function () { repairPhoto(secondRecordId); } : null;
    frontImage.removeAttribute('src');
    backImage.removeAttribute('src');
    if (first) frontImage.src = first;
    if (second) backImage.src = second;
    nodes.front.querySelector('.stats-folder-polaroid-image').classList.toggle('is-placeholder', !first);
    nodes.back.querySelector('.stats-folder-polaroid-image').classList.toggle('is-placeholder', !second);
    nodes.back.style.display = second || !first ? '' : 'none';
  }
  function save(record, blob, expectedOwner) {
    var owner = account();
    if (!owner || owner !== expectedOwner || !record || !record.id || !blob) {
      return Promise.reject(new Error('Original photo unavailable or account changed'));
    }
    var key = dateKey(new Date(record.ts));
    var pending = saveQueue.catch(function () {}).then(function () {
      return all().then(function (rows) {
        var latest = rows.filter(function (row) { return row.owner === owner; })
          .reduce(function (value, row) { return Math.max(value, Number(row.savedAt) || 0); }, 0);
        if (owner !== account()) throw new Error('Account changed');
        var savedAt = Math.max(Date.now(), latest + 1);
        return transaction(function (store) {
          store.put({ id: owner + '|' + record.id, owner: owner, recordId: record.id,
            dateKey: key, savedAt: savedAt, blob: blob, synced: 0 });
        });
      });
    });
    saveQueue = pending;
    return pending.then(function () {
      return flushPending(owner);
    }).then(function () { return refresh(selectedDate || new Date(), true); });
  }
  function remove(recordId) {
    var owner = account();
    if (!owner) return Promise.resolve();
    return saveQueue.catch(function () {}).then(function () {
      return transaction(function (store) { store.delete(owner + '|' + recordId); });
    }).then(function () {
      delete noteCache[owner + '|' + recordId];
      return noteTransaction(function (store) { store.delete(owner + '|' + recordId); });
    })
      .then(function () {
        if (token() && account() === owner) {
          return enqueue(function () {
            return fetch('/api/folder-photos/' + encodeURIComponent(recordId), { method: 'DELETE', headers: authHeaders() })
              .catch(function () {});
          });
        }
      })
      .then(function () { return refresh(selectedDate || new Date(), true); });
  }
  function clearAccount() {
    var owner = account();
    if (!owner) { return refresh(selectedDate || new Date(), true); }
    return saveQueue.catch(function () {}).then(function () {
      return Promise.all([all(), allNotes()]).then(function (result) {
        return transaction(function (store) {
          result[0].forEach(function (row) { if (row.owner === owner) store.delete(row.id); });
        }).then(function () {
          return noteTransaction(function (store) {
            result[1].forEach(function (row) { if (row.owner === owner) store.delete(row.id); });
          });
        });
      });
    }).then(function () { noteCache = Object.create(null); return refresh(selectedDate || new Date(), true); });
  }
  function clearCloud() {
    var owner = account();
    if (!owner || !token()) return Promise.resolve();
    return enqueue(function () {
      return fetch('/api/folder-photos', { method: 'DELETE', headers: authHeaders() }).catch(function () {});
    });
  }
  function setOrigin(paper, source, index) {
    var target = paper.getBoundingClientRect();
    var rect = source.getBoundingClientRect();
    var card = nodes.card.getBoundingClientRect();
    var scale = card.width / 170 || .7;
    var currentTransform = getComputedStyle(paper).transform;
    var matrix = currentTransform === 'none' ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(currentTransform);
    var targetX = target.left + target.width / 2 - matrix.m41;
    var targetY = target.top + target.height / 2 - matrix.m42;
    paper.style.setProperty('--from-x', Math.round(rect.left + rect.width / 2 - targetX) + 'px');
    paper.style.setProperty('--from-y', Math.round(rect.top + rect.height / 2 - targetY) + 'px');
    paper.style.setProperty('--source-scale-x', (88 * scale / paper.offsetWidth).toFixed(3));
    paper.style.setProperty('--source-scale-y', (132 * scale / paper.offsetHeight).toFixed(3));
    paper.style.setProperty('--source-rotation', (index === 0 ? 9 : -9) + 'deg');
    paper.style.setProperty('--paper-delay', Math.min(index * 65, 390) + 'ms');
    paper.style.zIndex = String(nodes.grid.children.length - index);
  }
  function updateViewer(animate, rebound) {
    if (viewerIndex < 0 || viewerClosing) return;
    var width = nodes.viewerViewport.clientWidth;
    if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      nodes.viewerTrack.getBoundingClientRect();
      nodes.viewerTrack.style.transition = rebound
        ? 'transform .42s cubic-bezier(.18,1.24,.35,1)'
        : 'transform .38s cubic-bezier(.2,.75,.25,1)';
    } else nodes.viewerTrack.style.transition = 'none';
    nodes.viewerTrack.style.transform = 'translate3d(' + (-viewerIndex * width) + 'px, 0, 0)';
    Array.prototype.forEach.call(nodes.viewerTrack.children, function (slide, index) {
      slide.setAttribute('aria-hidden', index === viewerIndex ? 'false' : 'true');
      slide.querySelector('.stats-folder-viewer__face--front').tabIndex = index === viewerIndex && !viewerFlipped ? 0 : -1;
      slide.querySelector('.stats-folder-viewer__editor').tabIndex = index === viewerIndex && viewerFlipped ? 0 : -1;
    });
    Array.prototype.forEach.call(nodes.viewerDots.children, function (dot, index) {
      dot.classList.toggle('is-active', index === viewerIndex);
      dot.setAttribute('aria-current', index === viewerIndex ? 'true' : 'false');
    });
  }
  function changeViewer(index) {
    if (viewerIndex < 0 || viewerClosing || viewerFlipped) return;
    if (index < 0 || index >= photos.length || index === viewerIndex) { updateViewer(true, true); return; }
    viewerIndex = index;
    updateViewer(true);
  }
  function openViewer(index, source) {
    if (!open || returning || viewerIndex >= 0 || !photos[index] || !photos[index].url) return;
    var sourceRect = source.getBoundingClientRect();
    viewerIndex = index;
    viewerSource = source;
    viewerClosing = false;
    viewerFlipped = false;
    viewerSaving = false;
    nodes.viewerDone.disabled = false;
    viewerRestoreFocus = false;
    nodes.viewerTrack.innerHTML = '';
    nodes.viewerDots.innerHTML = '';
    photos.forEach(function (photo, position) {
      var slide = document.createElement('div');
      slide.className = 'stats-folder-viewer__slide';
      slide.setAttribute('role', 'group');
      slide.setAttribute('aria-label', '第' + (position + 1) + '张，共' + photos.length + '张');
      var paper = document.createElement('div');
      paper.className = 'stats-folder-viewer__paper';
      var flipper = document.createElement('div');
      flipper.className = 'stats-folder-viewer__flipper';
      var front = document.createElement('button');
      front.type = 'button';
      front.className = 'stats-folder-viewer__face stats-folder-viewer__face--front';
      front.setAttribute('aria-label', '翻转第' + (position + 1) + '张相册');
      var img = document.createElement('img');
      img.src = photo.url;
      img.alt = '';
      img.draggable = false;
      img.onerror = function () { repairPhoto(photo.recordId); };
      front.appendChild(img);
      var back = document.createElement('div');
      back.className = 'stats-folder-viewer__face stats-folder-viewer__face--back';
      back.setAttribute('aria-hidden', 'true');
      var editor = document.createElement('textarea');
      editor.className = 'stats-folder-viewer__editor';
      editor.setAttribute('aria-label', '相册背面文字');
      editor.maxLength = 5000;
      editor.value = photo.note || '';
      editor.tabIndex = -1;
      back.appendChild(editor);
      var brand = document.createElement('span');
      brand.className = 'stats-folder-viewer__brand';
      brand.textContent = 'PickTime拾光';
      brand.setAttribute('aria-hidden', 'true');
      back.appendChild(brand);
      flipper.appendChild(front);
      flipper.appendChild(back);
      paper.appendChild(flipper);
      slide.appendChild(paper);
      nodes.viewerTrack.appendChild(slide);
      var dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'stats-folder-viewer__dot';
      dot.dataset.index = String(position);
      dot.setAttribute('aria-label', '查看第' + (position + 1) + '张相册');
      nodes.viewerDots.appendChild(dot);
    });
    nodes.gallery.classList.add('is-viewing');
    nodes.viewer.classList.remove('is-closing', 'is-flipped', 'is-editing');
    nodes.viewer.classList.add('is-open');
    nodes.viewer.setAttribute('aria-hidden', 'false');
    updateViewer(false);
    var enlarged = nodes.viewerTrack.children[index].firstChild;
    var targetRect = enlarged.getBoundingClientRect();
    source.classList.add('is-viewed');
    if (enlarged.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      enlarged.animate([
        { transform: 'translate3d(' + (sourceRect.left + sourceRect.width / 2 - targetRect.left - targetRect.width / 2) + 'px,' + (sourceRect.top + sourceRect.height / 2 - targetRect.top - targetRect.height / 2) + 'px,0) scale(' + (sourceRect.width / targetRect.width) + ',' + (sourceRect.height / targetRect.height) + ')' },
        { transform: 'translate3d(0,0,0) scale(1)' }
      ], { duration: 380, easing: 'cubic-bezier(.2,.75,.25,1)' });
    }
    nodes.viewerViewport.focus({ preventScroll: true });
  }
  function flipViewer() {
    if (viewerIndex < 0 || viewerClosing || viewerFlipped) return;
    var paper = nodes.viewerTrack.children[viewerIndex].firstChild;
    viewerFlipped = true;
    paper.classList.add('is-flipped');
    paper.querySelector('.stats-folder-viewer__face--front').tabIndex = -1;
    paper.querySelector('.stats-folder-viewer__face--front').setAttribute('aria-hidden', 'true');
    paper.querySelector('.stats-folder-viewer__face--back').setAttribute('aria-hidden', 'false');
    paper.querySelector('.stats-folder-viewer__editor').tabIndex = 0;
    nodes.viewer.classList.add('is-flipped');
    timer(function () { if (viewerFlipped && !viewerClosing) nodes.viewer.classList.add('is-editing'); }, 620);
  }
  function finishViewerNote() {
    if (!viewerFlipped || viewerSaving || viewerIndex < 0) return;
    var index = viewerIndex;
    var photo = photos[index];
    var paper = nodes.viewerTrack.children[index].firstChild;
    var editor = paper.querySelector('.stats-folder-viewer__editor');
    viewerSaving = true;
    nodes.viewerDone.disabled = true;
    saveAlbumNote(photo.recordId, editor.value).then(function () {
      if (viewerIndex !== index || !paper.isConnected) return;
      editor.blur();
      editor.tabIndex = -1;
      paper.querySelector('.stats-folder-viewer__face--front').tabIndex = 0;
      paper.querySelector('.stats-folder-viewer__face--front').setAttribute('aria-hidden', 'false');
      paper.querySelector('.stats-folder-viewer__face--back').setAttribute('aria-hidden', 'true');
      paper.classList.remove('is-flipped');
      nodes.viewer.classList.remove('is-flipped', 'is-editing');
      viewerFlipped = false;
      nodes.viewerViewport.focus({ preventScroll: true });
    }).catch(function (err) {
      console.error('[文件夹背面文字] 保存失败:', err);
      if (window.__picktimeToast) window.__picktimeToast('保存失败，请重试');
    }).then(function () {
      viewerSaving = false;
      nodes.viewerDone.disabled = false;
    });
  }
  function finishViewerClose() {
    if (!nodes || viewerIndex < 0) return;
    viewerCloseRun++;
    if (viewerCloseAnimation) {
      viewerCloseAnimation.onfinish = null;
      viewerCloseAnimation.cancel();
      viewerCloseAnimation = null;
    }
    if (viewerCloseFlight) {
      viewerCloseFlight.remove();
      viewerCloseFlight = null;
    }
    var source = viewerReturnTarget || viewerSource;
    var returnFocus = viewerRestoreFocus && nodes.viewer.contains(document.activeElement);
    if (!returnFocus && nodes.viewer.contains(document.activeElement)) document.activeElement.blur();
    viewerIndex = -1;
    viewerFlipped = false;
    viewerSaving = false;
    nodes.viewerDone.disabled = false;
    viewerSource = null;
    viewerReturnTarget = null;
    viewerClosing = false;
    viewerRestoreFocus = false;
    viewerPointerId = null;
    viewerDragged = false;
    nodes.viewerViewport.classList.remove('is-dragging');
    nodes.viewer.classList.remove('is-open', 'is-closing', 'is-flipped', 'is-editing');
    nodes.viewer.setAttribute('aria-hidden', 'true');
    nodes.gallery.classList.remove('is-viewing');
    nodes.viewerTrack.innerHTML = '';
    nodes.viewerDots.innerHTML = '';
    Array.prototype.forEach.call(nodes.grid.children, function (paper) { paper.classList.remove('is-viewed'); });
    if (source) {
      if (returnFocus) source.focus({ preventScroll: true });
    }
  }
  function closeViewer(immediate, restoreFocus) {
    if (!nodes || viewerIndex < 0) return;
    if (viewerFlipped && !immediate) { finishViewerNote(); return; }
    viewerRestoreFocus = !!restoreFocus;
    if (immediate) { finishViewerClose(); return; }
    if (viewerClosing) return;
    var target = nodes.grid.children[viewerIndex] || viewerSource;
    var enlarged = nodes.viewerTrack.children[viewerIndex] && nodes.viewerTrack.children[viewerIndex].firstChild;
    if (!target || !enlarged || !enlarged.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finishViewerClose();
      return;
    }
    viewerClosing = true;
    viewerReturnTarget = target;
    viewerPointerId = null;
    nodes.viewerViewport.classList.remove('is-dragging');
    var enlargedRect = enlarged.getBoundingClientRect();
    nodes.viewerTrack.style.transition = 'none';
    nodes.viewerTrack.style.transform = 'translate3d(' + (-viewerIndex * nodes.viewerViewport.clientWidth) + 'px,0,0)';
    Array.prototype.forEach.call(enlarged.getAnimations(), function (animation) { animation.cancel(); });
    var scrollRect = nodes.scroll.getBoundingClientRect();
    var targetRect = target.getBoundingClientRect();
    if (targetRect.top < scrollRect.top) nodes.scroll.scrollTop += targetRect.top - scrollRect.top - 12;
    else if (targetRect.bottom > scrollRect.bottom) nodes.scroll.scrollTop += targetRect.bottom - scrollRect.bottom + 12;
    targetRect = target.getBoundingClientRect();
    var flight = document.createElement('div');
    flight.className = 'stats-folder-viewer__flight';
    flight.style.left = enlargedRect.left + 'px';
    flight.style.top = enlargedRect.top + 'px';
    flight.style.width = enlargedRect.width + 'px';
    flight.style.height = enlargedRect.height + 'px';
    var flightImage = document.createElement('img');
    flightImage.src = photos[viewerIndex].url;
    flightImage.alt = '';
    flight.appendChild(flightImage);
    nodes.viewer.appendChild(flight);
    viewerCloseFlight = flight;
    target.classList.add('is-viewed');
    enlarged.style.visibility = 'hidden';
    nodes.viewerTrack.children[viewerIndex].classList.add('is-current');
    nodes.viewer.classList.add('is-closing');
    var run = ++viewerCloseRun;
    viewerCloseAnimation = flight.animate([
      { left: enlargedRect.left + 'px', top: enlargedRect.top + 'px', width: enlargedRect.width + 'px', height: enlargedRect.height + 'px', boxShadow: '0 12px 42px rgba(32,43,62,.18)' },
      { left: targetRect.left + 'px', top: targetRect.top + 'px', width: targetRect.width + 'px', height: targetRect.height + 'px', boxShadow: '0 0 0 rgba(32,43,62,0)' }
    ], { duration: 420, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'forwards' });
    viewerCloseAnimation.onfinish = function () { if (run === viewerCloseRun) finishViewerClose(); };
  }
  function viewerPointerDown(e) {
    if (viewerIndex < 0 || viewerClosing || viewerFlipped || photos.length < 2 || (e.pointerType === 'mouse' && e.button !== 0)) return;
    viewerPointerId = e.pointerId;
    viewerStartX = e.clientX;
    viewerStartY = e.clientY;
    viewerDragged = false;
  }
  function viewerPointerMove(e) {
    if (e.pointerId !== viewerPointerId || viewerIndex < 0 || viewerClosing) return;
    var dx = e.clientX - viewerStartX;
    var dy = e.clientY - viewerStartY;
    if (!viewerDragged && (Math.abs(dx) < 7 || Math.abs(dx) <= Math.abs(dy))) return;
    if (!viewerDragged) {
      viewerDragged = true;
      nodes.viewerViewport.setPointerCapture(e.pointerId);
    }
    nodes.viewerViewport.classList.add('is-dragging');
    var atEdge = (viewerIndex === 0 && dx > 0) || (viewerIndex === photos.length - 1 && dx < 0);
    nodes.viewerTrack.style.transition = 'none';
    nodes.viewerTrack.style.transform = 'translate3d(' + (-viewerIndex * nodes.viewerViewport.clientWidth + dx * (atEdge ? .25 : 1)) + 'px,0,0)';
    e.preventDefault();
  }
  function viewerPointerEnd(e) {
    if (e.pointerId !== viewerPointerId) return;
    viewerPointerId = null;
    nodes.viewerViewport.classList.remove('is-dragging');
    var dx = e.clientX - viewerStartX;
    var dy = e.clientY - viewerStartY;
    if (viewerDragged) {
      suppressViewerClickUntil = Date.now() + 350;
      var threshold = Math.min(70, nodes.viewerViewport.clientWidth * .16);
      if (e.type !== 'pointercancel' && Math.abs(dx) > threshold && Math.abs(dx) > Math.abs(dy)) {
        changeViewer(viewerIndex + (dx < 0 ? 1 : -1));
      } else updateViewer(true);
    }
    viewerDragged = false;
  }
  function show() {
    if (!bindNodes() || open || returning || !document.body.classList.contains('is-stats')) return;
    open = true;
    var title = el('statsTitle').getBoundingClientRect();
    var top = Math.max(82, Math.round(title.bottom + 42));
    var width = (window.innerWidth - 54) / 2;
    var height = Math.round(width * 1.42);
    nodes.head.style.top = title.top + 'px';
    nodes.head.style.height = title.height + 'px';
    nodes.date.textContent = selectedDate ? selectedDate.getFullYear() + '年' + (selectedDate.getMonth() + 1) + '月' + selectedDate.getDate() + '日' : '';
    nodes.scroll.style.top = top + 'px';
    nodes.scroll.scrollTop = 0;
    nodes.grid.innerHTML = '';
    var list = photos.length ? photos : [{ url: '' }, { url: '' }];
    list.forEach(function (photo, index) {
      var paper = document.createElement(photo.url ? 'button' : 'div');
      paper.className = 'stats-folder-gallery__paper' + (index > 1 ? ' is-extra' : '') + (photo.url ? '' : ' is-empty');
      paper.dataset.index = String(index);
      if (photo.url) {
        paper.type = 'button';
        paper.setAttribute('aria-label', '查看第' + (index + 1) + '张相册');
      }
      paper.style.setProperty('--paper-height', height + 'px');
      if (photo.url) {
        var img = document.createElement('img');
        img.className = 'stats-folder-gallery__image';
        img.src = photo.url;
        img.alt = '';
        img.onerror = function () { repairPhoto(photo.recordId); };
        paper.appendChild(img);
      } else {
        var blank = document.createElement('div');
        blank.className = 'stats-folder-gallery__image is-placeholder';
        paper.appendChild(blank);
      }
      nodes.grid.appendChild(paper);
    });
    nodes.gallery.classList.add('is-open');
    nodes.gallery.setAttribute('aria-hidden', 'false');
    Array.prototype.forEach.call(nodes.grid.children, function (paper, index) {
      setOrigin(paper, index === 0 ? nodes.front : nodes.back, index);
    });
    nodes.card.classList.add('is-open');
    document.body.classList.add('has-folder-gallery');
    timer(function () { if (open && !returning) nodes.gallery.classList.add('is-entered'); }, 40);
    Array.prototype.forEach.call(nodes.grid.children, function (paper, index) {
      if (index < 2) return;
      timer(function () { if (open && !returning) paper.classList.add('is-flying'); }, 40 + Math.min(index * 65, 390));
    });
  }
  function close() {
    if (!open || returning) return;
    if (viewerIndex >= 0) { closeViewer(); return; }
    returning = true;
    clearTimers();
    Array.prototype.forEach.call(nodes.grid.children, function (paper, index) {
      setOrigin(paper, index === 0 ? nodes.front : nodes.back, index);
    });
    var rect = nodes.card.getBoundingClientRect();
    nodes.cover.style.left = rect.left + 'px';
    nodes.cover.style.top = rect.top + 'px';
    nodes.cover.style.transform = 'scale(' + (rect.width / 170).toFixed(3) + ')';
    nodes.cover.classList.remove('is-closed');
    document.body.classList.add('is-folder-returning');
    nodes.card.classList.add('is-returning');
    nodes.gallery.classList.remove('is-entered');
    nodes.gallery.classList.add('is-returning');
    timer(function () { nodes.cover.classList.add('is-closed'); }, 230);
    timer(function () { nodes.gallery.classList.add('is-handed-off'); nodes.card.classList.remove('is-open'); }, 780);
    timer(reset, 980);
  }
  window.PicktimeFolder = { refresh: refresh, save: save, remove: remove,
    clearAccount: clearAccount, clearCloud: clearCloud, close: close, reset: reset };
})();
