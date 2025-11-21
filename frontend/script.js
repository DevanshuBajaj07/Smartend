// Base backend URL for API calls.
// Change this to your EC2 public IP / domain if needed, e.g.
// const BACKEND = "http://<your-ec2-ip>:5000";
const BACKEND = "http://127.0.0.1:5000";

document.addEventListener("DOMContentLoaded", () => {
  const UI = {
    status: document.getElementById("statusBadge"),
    dropZone: document.getElementById("dropZone"),
    browseBtn: document.getElementById("browseBtn"),
    fileInput: document.getElementById("fileInput"),

    backToFoldersBtn: document.getElementById("backToFoldersBtn"),
    currentFolderLabel: document.getElementById("currentFolderLabel"),
    downloadFolderBtn: document.getElementById("downloadFolderBtn"),
    searchInput: document.getElementById("searchInput"),
    sortSelect: document.getElementById("sortSelect"),

    folderView: document.getElementById("folderView"),
    folderGrid: document.getElementById("folderGrid"),
    fileView: document.getElementById("fileView"),
    fileTableBody: document.getElementById("fileTableBody"),

    ruleFolder: document.getElementById("ruleFolder"),
    ruleExtensions: document.getElementById("ruleExtensions"),
    saveRuleBtn: document.getElementById("saveRuleBtn"),
    rulesList: document.getElementById("rulesList"),
    searchFolderMatches: document.getElementById("searchFolderMatches"),

    previewModal: document.getElementById("previewModal"),
    previewBody: document.getElementById("previewBody"),
    previewCloseBtn: document.getElementById("previewCloseBtn"),
    previewBackdrop: document.getElementById("previewBackdrop"),

    uploadSpinner: document.getElementById("uploadSpinner"),
    uploadProgress: document.getElementById("uploadProgress"),
    uploadProgressBar: document.getElementById("uploadProgressBar"),
    uploadProgressText: document.getElementById("uploadProgressText"),

    toastContainer: document.getElementById("toastContainer"),

    // Storage usage bar
    storageBarFill: document.getElementById("storageBarFill"),
    storageUsageLabel: document.getElementById("storageUsageLabel"),
    storageFilesCount: document.getElementById("storageFilesCount"),

    // Recent files
    recentFilesList: document.getElementById("recentFilesList"),
  };

  // ===========
  // STATE
  // ===========
  let allFiles = [];
  let customRules = {};
  let currentFolder = null; // null => folder grid, else folder/category name

  // ==========================
  // HELPER FUNCTIONS
  // ==========================

  function showToast(message, type = "info") {
    if (!UI.toastContainer) {
      console.log(`[${type.toUpperCase()}]`, message);
      return;
    }

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;

    const msg = document.createElement("div");
    msg.className = "toast-message";
    msg.textContent = message;

    const close = document.createElement("button");
    close.className = "toast-dismiss";
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss notification");

    toast.appendChild(msg);
    toast.appendChild(close);

    toast.addEventListener("click", () => {
      if (toast.parentNode === UI.toastContainer) {
        UI.toastContainer.removeChild(toast);
      }
    });

    UI.toastContainer.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode === UI.toastContainer) {
        UI.toastContainer.removeChild(toast);
      }
    }, 4000);
  }

  function formatSize(bytes) {
    if (bytes == null || isNaN(bytes)) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let value = bytes;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value.toFixed(1)} ${units[i]}`;
  }

  function parseDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }

  function formatDate(iso) {
    const d = parseDate(iso);
    return d ? d.toLocaleString() : "";
  }

  function getExtension(name) {
    const idx = name.lastIndexOf(".");
    if (idx === -1) return "";
    return name.slice(idx + 1).toUpperCase();
  }

  function latestActivity(file) {
    const c = parseDate(file.created_time);
    const a = parseDate(file.last_access_time);
    const m = parseDate(file.modified_time);
    return [c, a, m].filter(Boolean).sort((x, y) => y - x)[0] || null;
  }

  function applySort(sort, list, isFolderView = false) {
    list.sort((a, b) => {
      switch (sort) {
        case "name-asc":
          return a.name.localeCompare(b.name);
        case "name-desc":
          return b.name.localeCompare(a.name);
        case "size-asc":
          return (
            (a.size_bytes || a.totalSize || 0) -
            (b.size_bytes || b.totalSize || 0)
          );
        case "size-desc":
          return (
            (b.size_bytes || b.totalSize || 0) -
            (a.size_bytes || a.totalSize || 0)
          );
        case "created-new":
        case "access-new": {
          const da = isFolderView
            ? a.lastActivity
            : parseDate(a.created_time || a.last_access_time);
          const db = isFolderView
            ? b.lastActivity
            : parseDate(b.created_time || b.last_access_time);
          return (db || 0) - (da || 0);
        }
        case "created-old":
        case "access-old": {
          const da2 = isFolderView
            ? a.lastActivity
            : parseDate(a.created_time || a.last_access_time);
          const db2 = isFolderView
            ? b.lastActivity
            : parseDate(b.created_time || b.last_access_time);
          return (da2 || 0) - (db2 || 0);
        }
        default:
          return 0;
      }
    });
  }

  // ==========================
  // SERVER STATUS
  // ==========================

  async function updateStatus() {
    if (!UI.status) return;
    try {
      const res = await fetch(`${BACKEND}/health`);
      if (res.ok) {
        UI.status.textContent = "Online";
        UI.status.className = "status-badge status-online";
      } else {
        throw new Error("Not OK");
      }
    } catch {
      UI.status.textContent = "Offline";
      UI.status.className = "status-badge status-offline";
    }
  }

  updateStatus();
  setInterval(updateStatus, 5000);

  // ==========================
  // STORAGE STATS
  // ==========================

  async function loadStats() {
    if (!UI.storageBarFill && !UI.storageUsageLabel && !UI.storageFilesCount)
      return;
    try {
      const res = await fetch(`${BACKEND}/stats`);
      if (!res.ok) return;
      const data = await res.json();

      const used = data.total_bytes || 0;
      const max = data.max_bytes || 0;
      const files = data.total_files || 0;

      if (UI.storageFilesCount) {
        UI.storageFilesCount.textContent = `${files} file${
          files === 1 ? "" : "s"
        }`;
      }

      let percent = 0;
      if (max > 0) {
        percent = Math.min(100, Math.round((used / max) * 100));
        if (UI.storageUsageLabel) {
          UI.storageUsageLabel.textContent = `${formatSize(
            used
          )} / ${formatSize(max)} (${percent}%)`;
        }
      } else {
        // No max configured: just show used
        if (UI.storageUsageLabel) {
          UI.storageUsageLabel.textContent = `${formatSize(used)} used`;
        }
        // Assume 10 GB for percent bar
        const tenGB = 10 * 1024 * 1024 * 1024;
        percent = Math.min(100, Math.round((used / tenGB) * 100));
      }

      if (UI.storageBarFill) {
        UI.storageBarFill.style.width = `${percent}%`;
      }
    } catch (e) {
      console.error("Failed to load stats:", e);
    }
  }

  // ==========================
  // DATA LOADING FROM BACKEND
  // ==========================

  async function loadFiles() {
    try {
      const res = await fetch(`${BACKEND}/files`);
      const data = await res.json();
      allFiles = Array.isArray(data.files) ? data.files : [];
      renderView();
      renderRecentFiles();
      loadStats();
    } catch (e) {
      console.error("Failed to load files:", e);
      showToast("Failed to load files from server.", "error");
    }
  }

  async function loadRules() {
    if (!UI.rulesList) return;
    try {
      const res = await fetch(`${BACKEND}/rules`);
      const data = await res.json();
      customRules = data.custom_rules || {};
      renderRules();
    } catch (e) {
      console.error("Failed to load rules:", e);
      showToast("Failed to load custom rules.", "error");
    }
  }

  // ==========================
  // FOLDER VIEW
  // ==========================

  function renderFolders() {
    if (!UI.folderGrid) return;
    UI.folderGrid.innerHTML = "";

    const search = UI.searchInput
      ? UI.searchInput.value.trim().toLowerCase()
      : "";

    const folderMap = new Map();
    for (const f of allFiles) {
      const folder = f.category || "Uncategorized";
      if (!folderMap.has(folder)) {
        folderMap.set(folder, {
          name: folder,
          count: 0,
          totalSize: 0,
          lastActivity: null,
          thumbnail: null,
        });
      }
      const entry = folderMap.get(folder);
      entry.count += 1;
      entry.totalSize += f.size_bytes || 0;

      const la = latestActivity(f);
      if (!entry.lastActivity || (la && la > entry.lastActivity)) {
        entry.lastActivity = la;
      }
      if (!entry.thumbnail && f.thumbnail) {
        entry.thumbnail = f.thumbnail;
      }
    }

    let folders = Array.from(folderMap.values());

    if (search) {
      folders = folders.filter((f) => f.name.toLowerCase().includes(search));
    }

    const sort = UI.sortSelect ? UI.sortSelect.value : "name-asc";
    applySort(sort, folders, true);

    if (!folders.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No folders yet. Upload some files!";
      UI.folderGrid.appendChild(empty);
      return;
    }

    folders.forEach((folder) => {
      const card = document.createElement("button");
      card.className = "folder-card";
      card.dataset.folderName = folder.name;

      const last = folder.lastActivity
        ? folder.lastActivity.toLocaleString()
        : "—";

      const thumbHtml = folder.thumbnail
        ? `<img src="${BACKEND}/view?path=${encodeURIComponent(
            folder.thumbnail
          )}" class="folder-thumb" alt="${folder.name} thumbnail"/>`
        : `<div class="folder-icon">📁</div>`;

      card.innerHTML = `
                ${thumbHtml}
                <div class="folder-info">
                    <div class="folder-name">${folder.name}</div>
                    <div class="folder-meta">
                        <span>${folder.count} file(s)</span>
                        <span>· ${formatSize(folder.totalSize)}</span>
                        <span>· Last activity: ${last}</span>
                    </div>
                </div>
            `;

      card.addEventListener("click", () => {
        currentFolder = folder.name;
        renderView();
      });

      UI.folderGrid.appendChild(card);
    });
  }

  // ==========================
  // FILE VIEW
  // ==========================

  function renderFilesInFolder() {
    if (!UI.fileTableBody) return;
    UI.fileTableBody.innerHTML = "";

    const search = UI.searchInput
      ? UI.searchInput.value.trim().toLowerCase()
      : "";

    let list = allFiles.filter((f) => f.category === currentFolder);

    if (search) {
      list = list.filter((f) => f.name.toLowerCase().includes(search));
    }

    const sort = UI.sortSelect ? UI.sortSelect.value : "name-asc";
    applySort(sort, list, false);

    if (!list.length) {
      const tr = document.createElement("tr");
      tr.className = "empty-row";
      tr.innerHTML = '<td colspan="7">No files in this folder yet.</td>';
      UI.fileTableBody.appendChild(tr);
      return;
    }

    list.forEach((file) => {
      const tr = document.createElement("tr");
      tr.dataset.relpath = file.relative_path;

      const thumb = file.thumbnail
        ? `<img src="${BACKEND}/view?path=${encodeURIComponent(
            file.thumbnail
          )}" class="file-thumb" alt="thumb"/>`
        : '<div class="file-icon">📄</div>';

      tr.innerHTML = `
                <td class="col-name">
                    <div class="file-cell">
                        ${thumb}
                        <span class="file-name">${file.name}</span>
                    </div>
                </td>
                <td>${file.category}</td>
                <td>${getExtension(file.name)}</td>
                <td>${formatSize(file.size_bytes)}</td>
                <td>${formatDate(file.created_time)}</td>
                <td>${formatDate(file.last_access_time)}</td>
                <td>
                    <button class="btn-small btn-preview">Preview</button>
                    <button class="btn-small btn-download">Download</button>
                    <button class="btn-small btn-danger">Delete</button>
                </td>
            `;

      UI.fileTableBody.appendChild(tr);
    });
  }

  // ==========================
  // SEARCH RESULTS
  // ========================== }

  function renderSearchResults(search, prefilteredList) {
    if (!UI.fileTableBody) return;
    UI.fileTableBody.innerHTML = "";

    const term = (search || "").trim().toLowerCase();
    if (!term && !Array.isArray(prefilteredList)) {
      const tr = document.createElement("tr");
      tr.className = "empty-row";
      tr.innerHTML = '<td colspan="7">No search term provided.</td>';
      UI.fileTableBody.appendChild(tr);
      return;
    }

    let list = [];

    if (Array.isArray(prefilteredList)) {
      list = prefilteredList.slice();
    } else {
      const termNoDot = term.replace(/^\./, "");

      list = allFiles.filter((f) => {
        const name = (f.name || "").toLowerCase();
        const rel = (f.relative_path || "").toLowerCase();
        const ext = getExtension(f.name).toLowerCase();

        return (
          name.includes(term) ||
          rel.includes(term) ||
          (ext && ext === termNoDot)
        );
      });
    }

    const sort = UI.sortSelect ? UI.sortSelect.value : "name-asc";
    applySort(sort, list, false);

    if (!list.length) {
      const tr = document.createElement("tr");
      tr.className = "empty-row";
      tr.innerHTML = '<td colspan="7">No files match your search.</td>';
      UI.fileTableBody.appendChild(tr);
      return;
    }

    list.forEach((file) => {
      const tr = document.createElement("tr");
      tr.dataset.relpath = file.relative_path;

      const thumb = file.thumbnail
        ? `<img src="${BACKEND}/view?path=${encodeURIComponent(
            file.thumbnail
          )}" class="file-thumb" alt="thumb"/>`
        : '<div class="file-icon">📄</div>';

      tr.innerHTML = `
                <td class="col-name">
                    <div class="file-cell">
                        ${thumb}
                        <span class="file-name">${file.name}</span>
                    </div>
                </td>
                <td>${file.category}</td>
                <td>${getExtension(file.name)}</td>
                <td>${formatSize(file.size_bytes)}</td>
                <td>${formatDate(file.created_time)}</td>
                <td>${formatDate(file.last_access_time)}</td>
                <td>
                    <button class="btn-small btn-preview">Preview</button>
                    <button class="btn-small btn-download">Download</button>
                    <button class="btn-small btn-danger">Delete</button>
                </td>
            `;

      UI.fileTableBody.appendChild(tr);
    });
  }

  function renderMatchingFolders(folderNames, search) {
    if (!UI.searchFolderMatches) return;
    UI.searchFolderMatches.innerHTML = "";

    if (!Array.isArray(folderNames) || !folderNames.length) {
      UI.searchFolderMatches.classList.add("hidden");
      return;
    }

    UI.searchFolderMatches.classList.remove("hidden");

    folderNames.forEach((folderName) => {
      const filesInFolder = allFiles.filter(
        (f) => (f.category || "") === folderName
      );
      const count = filesInFolder.length;
      const totalSize = filesInFolder.reduce(
        (s, f) => s + (f.size_bytes || 0),
        0
      );
      let lastActivity = null;
      filesInFolder.forEach((f) => {
        const la = latestActivity(f);
        if (!lastActivity || (la && la > lastActivity)) lastActivity = la;
      });

      const card = document.createElement("button");
      card.className = "folder-card";
      card.dataset.folderName = folderName;

      const last = lastActivity ? lastActivity.toLocaleString() : "—";

      const rep = filesInFolder.find((f) => f.thumbnail) || filesInFolder[0];
      const thumbHtml =
        rep && rep.thumbnail
          ? `<img src="${BACKEND}/view?path=${encodeURIComponent(
              rep.thumbnail
            )}" class="folder-thumb" alt="${folderName} thumbnail"/>`
          : `<div class="folder-icon">📁</div>`;

      card.innerHTML = `
                ${thumbHtml}
                <div class="folder-info">
                    <div class="folder-name">${folderName}</div>
                    <div class="folder-meta">
                        <span>${count} file(s)</span>
                        <span>· ${formatSize(totalSize)}</span>
                        <span>· Last activity: ${last}</span>
                    </div>
                </div>
            `;

      card.addEventListener("click", () => {
        currentFolder = folderName;
        if (UI.searchInput) UI.searchInput.value = "";
        renderView();
      });

      UI.searchFolderMatches.appendChild(card);
    });
  }

  // ==========================
  // VIEW TOGGLING
  // ==========================

  function renderView() {
    const search = UI.searchInput ? UI.searchInput.value.trim() : "";
    const isSearching = !!search;
    const inFolder = !!currentFolder && !isSearching;

    if (UI.currentFolderLabel) {
      UI.currentFolderLabel.textContent = isSearching
        ? `Search: "${search}"`
        : inFolder
        ? currentFolder
        : "Folders";
    }

    if (UI.backToFoldersBtn) {
      UI.backToFoldersBtn.disabled = !(inFolder || isSearching);
    }

    if (UI.downloadFolderBtn) {
      UI.downloadFolderBtn.disabled = !inFolder;
    }

    if (UI.folderView && UI.fileView) {
      if (isSearching) {
        UI.folderView.classList.add("hidden");
        UI.fileView.classList.remove("hidden");

        const termNoDot = search.replace(/^\./, "").toLowerCase();
        const fileMatches = allFiles.filter((f) => {
          const name = (f.name || "").toLowerCase();
          const rel = (f.relative_path || "").toLowerCase();
          const ext = getExtension(f.name).toLowerCase();
          const sLower = search.toLowerCase();
          return (
            name.includes(sLower) ||
            rel.includes(sLower) ||
            (ext && ext === termNoDot)
          );
        });

        renderSearchResults(search, fileMatches);

        const folderMap = new Map();
        for (const f of allFiles) {
          const folder = f.category || "Uncategorized";
          if (!folderMap.has(folder)) folderMap.set(folder, true);
        }

        const searchLower = search.toLowerCase();
        const matchingFolders = Array.from(folderMap.keys()).filter((fn) =>
          fn.toLowerCase().includes(searchLower)
        );
        renderMatchingFolders(matchingFolders, search);
      } else if (inFolder) {
        UI.folderView.classList.add("hidden");
        UI.fileView.classList.remove("hidden");
        UI.searchFolderMatches.classList.add("hidden");
        renderFilesInFolder();
      } else {
        UI.fileView.classList.add("hidden");
        UI.folderView.classList.remove("hidden");
        UI.searchFolderMatches.classList.add("hidden");
        renderFolders();
      }
    }
  }

  // ==========================
  // RECENT FILES PANEL
  // ==========================

  function renderRecentFiles() {
    if (!UI.recentFilesList) return;
    UI.recentFilesList.innerHTML = "";

    if (!allFiles.length) {
      const li = document.createElement("li");
      li.className = "recent-file-empty";
      li.textContent = "No files yet. Upload something to get started.";
      UI.recentFilesList.appendChild(li);
      return;
    }

    const withActivity = allFiles
      .map((f) => ({
        file: f,
        last: latestActivity(f) || parseDate(f.created_time) || null,
      }))
      .filter((x) => x.last);

    if (!withActivity.length) {
      const li = document.createElement("li");
      li.className = "recent-file-empty";
      li.textContent = "No recent activity yet.";
      UI.recentFilesList.appendChild(li);
      return;
    }

    withActivity.sort((a, b) => b.last - a.last);
    const top = withActivity.slice(0, 8);

    top.forEach(({ file, last }) => {
      const li = document.createElement("li");
      li.className = "recent-file-item";
      li.dataset.relpath = file.relative_path;

      li.innerHTML = `
                <div class="recent-file-main">
                    <span class="recent-file-name">${file.name}</span>
                    <span class="recent-file-folder">${file.category}</span>
                </div>
                <div class="recent-file-meta">
                    <span>${formatSize(file.size_bytes)}</span>
                    <span>·</span>
                    <span>Last activity: ${last.toLocaleString()}</span>
                </div>
            `;

      UI.recentFilesList.appendChild(li);
    });
  }

  if (UI.recentFilesList) {
    UI.recentFilesList.addEventListener("click", (e) => {
      const li = e.target.closest(".recent-file-item");
      if (!li) return;
      const rel = li.dataset.relpath;
      const file = allFiles.find((f) => f.relative_path === rel);
      if (file) {
        openPreview(file);
      }
    });
  }

  // ==========================
  // FILE UPLOAD
  // ==========================

  async function uploadFiles(files) {
    if (!files || !files.length) return;

    if (UI.uploadSpinner) {
      UI.uploadSpinner.classList.remove("hidden");
      UI.uploadSpinner.classList.add("show");
    }
    if (UI.dropZone) {
      UI.dropZone.classList.add("drop-zone-busy");
    }
    if (UI.browseBtn) {
      UI.browseBtn.disabled = true;
    }

    if (UI.uploadProgress) {
      UI.uploadProgress.classList.remove("hidden");
    }
    if (UI.uploadProgressBar) {
      UI.uploadProgressBar.style.width = "0%";
    }
    if (UI.uploadProgressText) {
      UI.uploadProgressText.textContent = "0%";
    }

    const form = new FormData();
    for (const f of files) {
      form.append("file", f);
    }

    try {
      const response = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${BACKEND}/upload`);
        xhr.responseType = "json";

        xhr.upload.addEventListener("progress", (e) => {
          if (!e.lengthComputable) return;
          const percent = Math.round((e.loaded / e.total) * 100);
          if (UI.uploadProgressBar) {
            UI.uploadProgressBar.style.width = `${percent}%`;
          }
          if (UI.uploadProgressText) {
            UI.uploadProgressText.textContent = `${percent}%`;
          }
        });

        xhr.addEventListener("load", () => {
          const status = xhr.status;
          const resp = xhr.response || {};
          const ok = status >= 200 && status < 300;

          if (ok && UI.uploadProgressBar) {
            UI.uploadProgressBar.style.width = "100%";
            if (UI.uploadProgressText) {
              UI.uploadProgressText.textContent = "100%";
            }
          }

          if (!ok || !resp.success) {
            const message = resp.message || "Upload failed.";
            showToast(message, "error");
          } else {
            showToast(resp.message || "Upload complete.", "success");
          }
          resolve(resp);
        });

        xhr.addEventListener("error", () => {
          reject(new Error("Upload failed due to a network error."));
        });

        xhr.send(form);
      });

      if (response && response.success) {
        await loadFiles();
      }
    } catch (e) {
      console.error("Upload error:", e);
      showToast(e.message || "Upload failed due to a network error.", "error");
    } finally {
      if (UI.uploadSpinner) {
        UI.uploadSpinner.classList.remove("show");
        UI.uploadSpinner.classList.add("hidden");
      }
      if (UI.dropZone) {
        UI.dropZone.classList.remove("drop-zone-busy");
      }
      if (UI.browseBtn) {
        UI.browseBtn.disabled = false;
      }
      if (UI.uploadProgress) {
        setTimeout(() => {
          UI.uploadProgress.classList.add("hidden");
        }, 600);
      }
    }
  }

  if (UI.dropZone) {
    UI.dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      UI.dropZone.classList.add("drop-zone-hover");
    });

    UI.dropZone.addEventListener("dragleave", () => {
      UI.dropZone.classList.remove("drop-zone-hover");
    });

    UI.dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      UI.dropZone.classList.remove("drop-zone-hover");
      uploadFiles(e.dataTransfer.files);
    });
  }

  if (UI.browseBtn && UI.fileInput) {
    UI.browseBtn.addEventListener("click", () => UI.fileInput.click());
    UI.fileInput.addEventListener("change", () =>
      uploadFiles(UI.fileInput.files)
    );
  }

  // ==========================
  // DOWNLOAD & DELETE & FOLDER ZIP
  // ==========================

  async function handleDownload(relpath) {
    try {
      const head = await fetch(
        `${BACKEND}/download?path=${encodeURIComponent(relpath)}`,
        { method: "HEAD" }
      );
      if (!head.ok) {
        showToast("Download failed: file not found.", "error");
        return;
      }
      window.location.href = `${BACKEND}/download?path=${encodeURIComponent(
        relpath
      )}`;
    } catch {
      showToast("Download failed due to a network error.", "error");
    }
  }

  async function handleDelete(relpath) {
    try {
      const res = await fetch(
        `${BACKEND}/delete?path=${encodeURIComponent(relpath)}`,
        { method: "DELETE" }
      );
      const data = await res.json();

      if (!(res.ok && data.success)) {
        showToast(data.message || "Delete failed.", "error");
      } else {
        showToast("File deleted.", "success");
      }
      await loadFiles();
    } catch (e) {
      console.error("Delete error:", e);
      showToast("Delete failed due to a network error.", "error");
    }
  }

  if (UI.downloadFolderBtn) {
    UI.downloadFolderBtn.addEventListener("click", () => {
      if (!currentFolder) return;
      const url = `${BACKEND}/download_folder?folder=${encodeURIComponent(
        currentFolder
      )}`;
      showToast(`Preparing ZIP for "${currentFolder}"...`, "info");
      window.location.href = url;
    });
  }

  if (UI.fileTableBody) {
    UI.fileTableBody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr");
      if (!tr) return;
      const relpath = tr.dataset.relpath;

      if (e.target.classList.contains("btn-download")) {
        handleDownload(relpath);
      } else if (e.target.classList.contains("btn-danger")) {
        handleDelete(relpath);
      } else if (e.target.classList.contains("btn-preview")) {
        const file = allFiles.find((f) => f.relative_path === relpath);
        if (file) openPreview(file);
      }
    });
  }

  // ==========================
  // PREVIEW
  // ==========================

  function showModal() {
    if (!UI.previewModal) return;
    UI.previewModal.classList.remove("hidden");
  }

  function hideModal() {
    if (!UI.previewModal) return;
    UI.previewModal.classList.add("hidden");
    if (UI.previewBody) UI.previewBody.innerHTML = "";
  }

  function closePreview() {
    hideModal();
  }

  if (UI.previewCloseBtn) {
    UI.previewCloseBtn.addEventListener("click", closePreview);
  }

  if (UI.previewBackdrop) {
    UI.previewBackdrop.addEventListener("click", closePreview);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePreview();
  });

  async function openPreview(file) {
    if (!file || !UI.previewBody) return;
    UI.previewBody.innerHTML = "";

    const rel = encodeURIComponent(file.relative_path);
    const url = `${BACKEND}/view?path=${rel}`;
    const ext = getExtension(file.name).toLowerCase();

    function attach(node) {
      UI.previewBody.appendChild(node);
      showModal();
    }

    const imageExts = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff"];
    if (imageExts.includes(ext)) {
      const img = document.createElement("img");
      img.src = url;
      img.style.maxWidth = "100%";
      img.style.maxHeight = "80vh";
      img.alt = file.name;
      attach(img);
      return;
    }

    if (ext === "pdf") {
      const iframe = document.createElement("iframe");
      iframe.src = url;
      iframe.style.width = "100%";
      iframe.style.height = "80vh";
      iframe.style.border = "none";
      attach(iframe);
      return;
    }

    const audioExts = ["mp3", "wav", "ogg", "m4a", "flac"];
    if (audioExts.includes(ext)) {
      const audio = document.createElement("audio");
      audio.controls = true;
      const src = document.createElement("source");
      src.src = url;
      audio.appendChild(src);
      attach(audio);
      return;
    }

    const videoExts = ["mp4", "webm", "mov", "mkv", "avi"];
    if (videoExts.includes(ext)) {
      const video = document.createElement("video");
      video.controls = true;
      video.style.maxWidth = "100%";
      video.style.maxHeight = "80vh";
      const src = document.createElement("source");
      src.src = url;
      video.appendChild(src);
      attach(video);
      return;
    }

    try {
      const res = await fetch(url);
      if (!res.ok) {
        const err = document.createElement("div");
        err.textContent = `Failed to load preview: ${res.status}`;
        attach(err);
        return;
      }

      const text = await res.text();

      if (ext === "md") {
        const html = window.marked
          ? window.marked.parse(text)
          : `<pre>${escapeHtml(text)}</pre>`;
        const safe = window.DOMPurify ? DOMPurify.sanitize(html) : html;
        const container = document.createElement("div");
        container.className = "markdown-preview";
        container.innerHTML = safe;
        attach(container);
        return;
      }

      if (ext === "json") {
        try {
          const obj = JSON.parse(text);
          const pre = document.createElement("pre");
          pre.textContent = JSON.stringify(obj, null, 2);
          attach(pre);
          return;
        } catch {
          // fall back to raw text
        }
      }

      const pre = document.createElement("pre");
      pre.textContent = text;
      pre.style.maxHeight = "70vh";
      pre.style.overflow = "auto";
      attach(pre);
    } catch (e) {
      const err = document.createElement("div");
      err.textContent = `Preview error: ${e.message}`;
      attach(err);
    }
  }

  function escapeHtml(unsafe) {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ==========================
  // SEARCH & SORT CONTROLS
  // ==========================

  function refreshFromControls() {
    renderView();
  }

  if (UI.searchInput) {
    UI.searchInput.addEventListener("input", refreshFromControls);
  }

  if (UI.sortSelect) {
    UI.sortSelect.addEventListener("change", refreshFromControls);
  }

  // ==========================
  // BACK BUTTON
  // ==========================

  if (UI.backToFoldersBtn) {
    UI.backToFoldersBtn.addEventListener("click", () => {
      currentFolder = null;
      if (UI.searchInput) UI.searchInput.value = "";
      renderView();
    });
  }

  // ==========================
  // CUSTOM RULES
  // ==========================

  function renderRules() {
    if (!UI.rulesList) return;

    UI.rulesList.innerHTML = "";
    const entries = Object.entries(customRules);
    if (!entries.length) {
      UI.rulesList.textContent = "No custom rules defined yet.";
      return;
    }

    entries.sort((a, b) => a[0].localeCompare(b[0]));

    entries.forEach(([folder, exts]) => {
      const div = document.createElement("div");
      div.className = "rule-row";
      div.innerHTML = `<strong>${folder}</strong>: ${exts.join(", ")}`;
      UI.rulesList.appendChild(div);
    });
  }

  if (UI.saveRuleBtn && UI.ruleFolder && UI.ruleExtensions) {
    UI.saveRuleBtn.addEventListener("click", async () => {
      const folder = UI.ruleFolder.value.trim();
      const extsInput = UI.ruleExtensions.value.trim();

      if (!folder || !extsInput) {
        showToast("Please enter both folder name and extensions.", "error");
        return;
      }

      const extensions = extsInput
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0);

      if (!extensions.length) {
        showToast("No valid extensions found.", "error");
        return;
      }

      try {
        const res = await fetch(`${BACKEND}/rules`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folder, extensions }),
        });
        const data = await res.json();

        if (res.ok && data.success) {
          customRules = data.custom_rules || {};
          renderRules();

          UI.ruleFolder.value = "";
          UI.ruleExtensions.value = "";

          await loadFiles();
          showToast("Rule saved successfully.", "success");
        } else {
          showToast(data.message || "Failed to save rule.", "error");
        }
      } catch (e) {
        console.error("Rule save error:", e);
        showToast("Failed to save rule due to a network error.", "error");
      }
    });
  }

  // ==========================
  // INIT
  // ==========================

  loadRules();
  loadFiles();
});
