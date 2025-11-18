// Base backend URL for API calls.
// Change this to your EC2 public IP + port when deploying (e.g. "http://54.xx.xx.xx:5000")
const BACKEND = "http://127.0.0.1:5000";

document.addEventListener("DOMContentLoaded", () => {
    // Cache all important DOM elements in a single UI object for easy reuse.
    const UI = {
        status: document.getElementById("statusBadge"),
        dropZone: document.getElementById("dropZone"),
        browseBtn: document.getElementById("browseBtn"),
        fileInput: document.getElementById("fileInput"),

        backToFoldersBtn: document.getElementById("backToFoldersBtn"),
        currentFolderLabel: document.getElementById("currentFolderLabel"),
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
    };

    // ===========
    // STATE
    // ===========
    let allFiles = [];        // Flat list of all files returned by backend
    let customRules = {};     // Custom folder rules: { folderName: [ext1, ext2, ...] }
    let currentFolder = null; // null => folder grid view; string => a specific folder is open

    // ==========================
    // HELPER FUNCTIONS
    // ==========================

    // Convert file size in bytes to human-readable format (e.g. "1.2 MB")
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

    // Safely parse an ISO date string into a Date object, or return null if invalid
    function parseDate(iso) {
        if (!iso) return null;
        const d = new Date(iso);
        return isNaN(d.getTime()) ? null : d;
    }

    // Format ISO date string into a localized date/time string for display
    function formatDate(iso) {
        const d = parseDate(iso);
        return d ? d.toLocaleString() : "";
    }

    // Extract file extension from a filename and uppercase it (e.g. "PDF")
    function getExtension(name) {
        const idx = name.lastIndexOf(".");
        if (idx === -1) return "";
        return name.slice(idx + 1).toUpperCase();
    }

    // Get the latest (most recent) timestamp among created/access/modified
    function latestActivity(file) {
        const c = parseDate(file.created_time);
        const a = parseDate(file.last_access_time);
        const m = parseDate(file.modified_time);
        // Filter out nulls, sort descending, return first
        return [c, a, m].filter(Boolean).sort((x, y) => y - x)[0] || null;
    }

    // Generic sorting logic used for folders and file lists.
    // - sort: current sort mode (name, size, date)
    // - list: array being sorted
    // - isFolderView: if true, uses folder.lastActivity instead of per-file timestamps
    function applySort(sort, list, isFolderView = false) {
        list.sort((a, b) => {
            switch (sort) {
                case "name-asc":
                    return a.name.localeCompare(b.name);
                case "name-desc":
                    return b.name.localeCompare(a.name);
                case "size-asc":
                    return (a.size_bytes || a.totalSize || 0) -
                           (b.size_bytes || b.totalSize || 0);
                case "size-desc":
                    return (b.size_bytes || b.totalSize || 0) -
                           (a.size_bytes || a.totalSize || 0);
                case "created-new":
                case "access-new": {
                    // Newest first
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
                    // Oldest first
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
    // SERVER STATUS (ONLINE / OFFLINE)
    // ==========================

    // Ping /health to show a live status badge in the header.
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
        } catch (e) {
            UI.status.textContent = "Offline";
            UI.status.className = "status-badge status-offline";
        }
    }

    // Run once immediately, then every 5 seconds.
    updateStatus();
    setInterval(updateStatus, 5000);

    // ==========================
    // DATA LOADING FROM BACKEND
    // ==========================

    // Fetch the list of all files from backend and refresh the current view
    async function loadFiles() {
        try {
            const res = await fetch(`${BACKEND}/files`);
            const data = await res.json();
            allFiles = Array.isArray(data.files) ? data.files : [];
            renderView();
        } catch (e) {
            console.error("Failed to load files:", e);
        }
    }

    // Fetch custom rules (folder → extensions) from backend and render them
    async function loadRules() {
        if (!UI.rulesList) return;
        try {
            const res = await fetch(`${BACKEND}/rules`);
            const data = await res.json();
            customRules = data.custom_rules || {};
            renderRules();
        } catch (e) {
            console.error("Failed to load rules:", e);
        }
    }

    // ==========================
    // FOLDER GRID VIEW
    // ==========================

    // Render the "folders" overview (categories) with counts + last activity
    function renderFolders() {
        if (!UI.folderGrid) return;
        UI.folderGrid.innerHTML = "";

        // Search term (filter by folder name)
        const search = UI.searchInput
            ? UI.searchInput.value.trim().toLowerCase()
            : "";

        // Build a folder map: { folderName: { name, count, totalSize, lastActivity } }
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
            // Keep the most recent activity time
            if (!entry.lastActivity || (la && la > entry.lastActivity)) {
                entry.lastActivity = la;
            }
            // pick a representative thumbnail for the folder (first available)
            if (!entry.thumbnail && f.thumbnail) {
                entry.thumbnail = f.thumbnail;
            }
        }

        let folders = Array.from(folderMap.values());

        // Apply folder name search
        if (search) {
            folders = folders.filter((f) =>
                f.name.toLowerCase().includes(search)
            );
        }

        // Apply sort (name / size / last activity)
        const sort = UI.sortSelect ? UI.sortSelect.value : "name-asc";
        applySort(sort, folders, true);

        // If no folders exist yet, show friendly empty state
        if (!folders.length) {
            const empty = document.createElement("div");
            empty.className = "empty-state";
            empty.textContent = "No folders yet. Upload some files!";
            UI.folderGrid.appendChild(empty);
            return;
        }

        // Create a card for each folder
        folders.forEach((folder) => {
            const card = document.createElement("button");
            card.className = "folder-card";
            card.dataset.folderName = folder.name;

            const last = folder.lastActivity
                ? folder.lastActivity.toLocaleString()
                : "—";

            const thumbHtml = folder.thumbnail
                ? `<img src="${BACKEND}/view?path=${encodeURIComponent(folder.thumbnail)}" class="folder-thumb" alt="${folder.name} thumbnail"/>`
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

            // When user clicks folder card → switch to file view for that folder
            card.addEventListener("click", () => {
                currentFolder = folder.name;
                renderView();
            });

            UI.folderGrid.appendChild(card);
        });
    }

    // ==========================
    // FILE TABLE VIEW (INSIDE A FOLDER)
    // ==========================

    // Render the files belonging to the currently selected folder
    function renderFilesInFolder() {
        if (!UI.fileTableBody) return;
        UI.fileTableBody.innerHTML = "";

        // Text to search inside file names
        const search = UI.searchInput
            ? UI.searchInput.value.trim().toLowerCase()
            : "";

        // Filter by current folder
        let list = allFiles.filter(
            (f) => f.category === currentFolder
        );

        // Apply search filter (case-insensitive)
        if (search) {
            list = list.filter((f) =>
                f.name.toLowerCase().includes(search)
            );
        }

        // Apply sort mode
        const sort = UI.sortSelect ? UI.sortSelect.value : "name-asc";
        applySort(sort, list, false);

        // If no files, show table empty message row
        if (!list.length) {
            const tr = document.createElement("tr");
            tr.className = "empty-row";
            tr.innerHTML =
                '<td colspan="7">No files in this folder yet.</td>';
            UI.fileTableBody.appendChild(tr);
            return;
        }

        // Build a row per file
        list.forEach((file) => {
            const tr = document.createElement("tr");
            // Store backend path in data attribute for download/delete
            tr.dataset.relpath = file.relative_path;

            const fileThumb = file.thumbnail ? `<img src="${BACKEND}/view?path=${encodeURIComponent(file.thumbnail)}" class="file-thumb" alt="thumb"/>` : '<div class="file-icon">📄</div>';

            tr.innerHTML = `
                <td class="col-name"><div class="file-cell">${fileThumb}<span class="file-name">${file.name}</span></div></td>
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
    // SEARCH RESULTS (ACROSS ALL FOLDERS)
    // ==========================

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

            // Filter across allFiles by filename, relative path, or exact extension match
            list = allFiles.filter((f) => {
                const name = (f.name || "").toLowerCase();
                const rel = (f.relative_path || "").toLowerCase();
                const ext = getExtension(f.name).toLowerCase();

                return (
                    name.includes(term) ||
                    rel.includes(term) ||
                    // match extension exactly when user types 'pdf' or '.pdf'
                    (ext && ext === termNoDot)
                );
            });
        }

        // Apply sort mode
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

            const fileThumb2 = file.thumbnail ? `<img src="${BACKEND}/view?path=${encodeURIComponent(file.thumbnail)}" class="file-thumb" alt="thumb"/>` : '<div class="file-icon">📄</div>';

            tr.innerHTML = `
                <td class="col-name"><div class="file-cell">${fileThumb2}<span class="file-name">${file.name}</span></div></td>
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

    // Render a small set of matching folders above the file table when searching
    function renderMatchingFolders(folderNames, search) {
        if (!UI.searchFolderMatches) return;
        UI.searchFolderMatches.innerHTML = "";

        if (!Array.isArray(folderNames) || !folderNames.length) {
            UI.searchFolderMatches.classList.add("hidden");
            return;
        }

        UI.searchFolderMatches.classList.remove("hidden");

        // For each folder name produce a card similar to renderFolders
        folderNames.forEach((folderName) => {
            // compute some quick stats for display
            const filesInFolder = allFiles.filter((f) => (f.category || "") === folderName);
            const count = filesInFolder.length;
            const totalSize = filesInFolder.reduce((s, f) => s + (f.size_bytes || 0), 0);
            let lastActivity = null;
            filesInFolder.forEach((f) => {
                const la = latestActivity(f);
                if (!lastActivity || (la && la > lastActivity)) lastActivity = la;
            });

            const card = document.createElement("button");
            card.className = "folder-card";
            card.dataset.folderName = folderName;

            const last = lastActivity ? lastActivity.toLocaleString() : "—";

            // try to find a thumbnail among files in the folder
            const rep = filesInFolder.find((f) => f.thumbnail) || filesInFolder[0];
            const thumbHtml = rep && rep.thumbnail
                ? `<img src="${BACKEND}/view?path=${encodeURIComponent(rep.thumbnail)}" class="folder-thumb" alt="${folderName} thumbnail"/>`
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
                // clear the search input when the user navigates into a folder
                if (UI.searchInput) UI.searchInput.value = "";
                renderView();
            });

            UI.searchFolderMatches.appendChild(card);
        });
    }

    // ==========================
    // VIEW TOGGLING (FOLDERS <-> FILES)
    // ==========================

    // Decide which view to show based on currentFolder value
    function renderView() {
        const search = UI.searchInput ? UI.searchInput.value.trim() : "";
        const isSearching = !!search;
        const inFolder = !!currentFolder && !isSearching; // true when user is inside a folder (not searching)

        // Update breadcrumb / label
        if (UI.currentFolderLabel) {
            UI.currentFolderLabel.textContent = isSearching
                ? `Search: "${search}"`
                : inFolder
                ? currentFolder
                : "Folders";
        }

        // Back button enabled when inside a folder or when viewing search results
        if (UI.backToFoldersBtn) {
            UI.backToFoldersBtn.disabled = !(inFolder || isSearching);
        }

        // Toggle the DOM views and render appropriate data
        if (UI.folderView && UI.fileView) {
            if (isSearching) {
                UI.folderView.classList.add("hidden");
                UI.fileView.classList.remove("hidden");
                // Prefer showing file matches if any exist; otherwise fall back to filtered folders
                const termNoDot = search.replace(/^\./, "").toLowerCase();
                const fileMatches = allFiles.filter((f) => {
                    const name = (f.name || "").toLowerCase();
                    const rel = (f.relative_path || "").toLowerCase();
                    const ext = getExtension(f.name).toLowerCase();
                    return (
                        name.includes(search.toLowerCase()) ||
                        rel.includes(search.toLowerCase()) ||
                        (ext && ext === termNoDot)
                    );
                });

                // Always show file view for search results
                renderSearchResults(search, fileMatches);

                // Also compute matching folders (by folder name contains search)
                const folderMap = new Map();
                for (const f of allFiles) {
                    const folder = f.category || "Uncategorized";
                    if (!folderMap.has(folder)) folderMap.set(folder, true);
                }

                const searchLower = search.toLowerCase();
                const matchingFolders = Array.from(folderMap.keys()).filter((fn) => fn.toLowerCase().includes(searchLower));
                renderMatchingFolders(matchingFolders, search);
            } else if (inFolder) {
                UI.folderView.classList.add("hidden");
                UI.fileView.classList.remove("hidden");
                renderFilesInFolder();
            } else {
                UI.fileView.classList.add("hidden");
                UI.folderView.classList.remove("hidden");
                renderFolders();
            }
        }
    }

    // ==========================
    // FILE UPLOAD (DRAG & DROP + BROWSE)
    // ==========================

    // Upload one or more File objects to the backend using /upload
    async function uploadFiles(files) {
        if (!files || !files.length) return;

        const form = new FormData();
        // Multiple files supported using "file" field name repeatedly
        for (const f of files) {
            form.append("file", f);
        }

        try {
            const res = await fetch(`${BACKEND}/upload`, {
                method: "POST",
                body: form,
            });
            const data = await res.json();

            if (!(res.ok && data.success)) {
                alert(data.message || "Upload failed.");
            } else {
                console.log("Upload OK:", data);
            }

            // Refresh file list after upload
            await loadFiles();
        } catch (e) {
            console.error("Upload error:", e);
            alert("Upload failed due to a network error.");
        }
    }

    // --- Drag & drop behavior on the visible drop zone ---
    if (UI.dropZone) {
        UI.dropZone.addEventListener("dragover", (e) => {
            e.preventDefault(); // Allow drop
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

    // --- File selection via "Browse" button + hidden file input ---
    if (UI.browseBtn && UI.fileInput) {
        // Open file picker
        UI.browseBtn.addEventListener("click", () => UI.fileInput.click());

        // When user selects files, upload them
        UI.fileInput.addEventListener("change", () =>
            uploadFiles(UI.fileInput.files)
        );
    }

    // ==========================
    // DOWNLOAD & DELETE ACTIONS
    // ==========================

    // Download a file by relative path using GET /download
    async function handleDownload(relpath) {
        try {
            // First send a HEAD request to check if file exists / is reachable
            const head = await fetch(
                `${BACKEND}/download?path=${encodeURIComponent(relpath)}`,
                { method: "HEAD" }
            );
            if (!head.ok) {
                alert("Download failed: file not found.");
                return;
            }

            // If OK, trigger browser download by navigating to the URL
            window.location.href = `${BACKEND}/download?path=${encodeURIComponent(
                relpath
            )}`;
        } catch (e) {
            alert("Download failed due to a network error.");
        }
    }

    // Delete a file by relative path using DELETE /delete
    async function handleDelete(relpath) {
        try {
            const res = await fetch(
                `${BACKEND}/delete?path=${encodeURIComponent(relpath)}`,
                { method: "DELETE" }
            );
            const data = await res.json();

            if (!(res.ok && data.success)) {
                alert(data.message || "Delete failed.");
            } else {
                console.log("Delete OK:", data);
            }

            // Reload file list after deletion
            await loadFiles();
        } catch (e) {
            console.error("Delete error:", e);
            alert("Delete failed due to a network error.");
        }
    }

    // Delegate click events inside the file table (Preview / Download / Delete)
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
    // PREVIEW HANDLING
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

        // Helper to create a container and show it
        function attach(node) {
            UI.previewBody.appendChild(node);
            showModal();
        }

        // Images
        const imageExts = ["jpg","jpeg","png","gif","webp","bmp","tiff"];
        if (imageExts.includes(ext)) {
            const img = document.createElement("img");
            img.src = url;
            img.style.maxWidth = "100%";
            img.style.maxHeight = "80vh";
            img.alt = file.name;
            attach(img);
            return;
        }

        // PDF
        if (ext === "pdf") {
            const iframe = document.createElement("iframe");
            iframe.src = url;
            iframe.style.width = "100%";
            iframe.style.height = "80vh";
            iframe.style.border = "none";
            attach(iframe);
            return;
        }

        // Audio
        const audioExts = ["mp3","wav","ogg","m4a","flac"];
        if (audioExts.includes(ext)) {
            const audio = document.createElement("audio");
            audio.controls = true;
            const src = document.createElement("source");
            src.src = url;
            audio.appendChild(src);
            attach(audio);
            return;
        }

        // Video
        const videoExts = ["mp4","webm","mov","mkv","avi"];
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

        // Text-like previews: md, txt, csv, log, json
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
                // render markdown using marked + sanitize with DOMPurify
                const html = (window.marked ? window.marked.parse(text) : '<pre>' + escapeHtml(text) + '</pre>');
                const safe = (window.DOMPurify ? DOMPurify.sanitize(html) : html);
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
                } catch (e) {
                    // fallback to raw text
                }
            }

            // fallback: render as preformatted text
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
            .replace(/\"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // ==========================
    // SEARCH & SORT CONTROLS
    // ==========================

    // Re-render current view (folder grid or file table) when filters change
    function refreshFromControls() {
        // Recompute view using the same logic as initial render (handles searching)
        renderView();
    }

    // Live search (filters folders or files depending on view)
    if (UI.searchInput) {
        UI.searchInput.addEventListener("input", refreshFromControls);
    }

    // Change sort mode
    if (UI.sortSelect) {
        UI.sortSelect.addEventListener("change", refreshFromControls);
    }

    // ==========================
    // BACK TO FOLDER GRID BUTTON
    // ==========================

    // Go back to folder overview from inside a folder
    if (UI.backToFoldersBtn) {
        UI.backToFoldersBtn.addEventListener("click", () => {
            currentFolder = null;
            renderView();
        });
    }

    // ==========================
    // CUSTOM RULES (AUTO-SORT LOGIC)
    // ==========================

    // Render rules list like:
    // MyDocs: pdf, docx
    function renderRules() {
        if (!UI.rulesList) return;

        UI.rulesList.innerHTML = "";
        const entries = Object.entries(customRules);
        if (!entries.length) {
            UI.rulesList.textContent = "No custom rules defined yet.";
            return;
        }

        // Sort by folder name alphabetically
        entries.sort((a, b) => a[0].localeCompare(b[0]));

        // Build one row per rule
        entries.forEach(([folder, exts]) => {
            const div = document.createElement("div");
            div.className = "rule-row";
            div.innerHTML = `<strong>${folder}</strong>: ${exts.join(", ")}`;
            UI.rulesList.appendChild(div);
        });
    }

    // Add or update a rule via /rules POST
    if (UI.saveRuleBtn && UI.ruleFolder && UI.ruleExtensions) {
        UI.saveRuleBtn.addEventListener("click", async () => {
            const folder = UI.ruleFolder.value.trim();
            const extsInput = UI.ruleExtensions.value.trim();

            // Validate inputs
            if (!folder || !extsInput) {
                alert("Please enter both folder name and extensions.");
                return;
            }

            // Split comma-separated extensions, clean up spaces, lowercase
            const extensions = extsInput
                .split(",")
                .map((e) => e.trim().toLowerCase())
                .filter((e) => e.length > 0);

            if (!extensions.length) {
                alert("No valid extensions found.");
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
                    // Backend returns updated custom_rules
                    customRules = data.custom_rules || {};
                    renderRules();

                    // Clear input fields
                    UI.ruleFolder.value = "";
                    UI.ruleExtensions.value = "";

                    // Reload files so any new rules are applied
                    await loadFiles();
                } else {
                    alert(data.message || "Failed to save rule.");
                }
            } catch (e) {
                console.error("Rule save error:", e);
                alert("Failed to save rule due to a network error.");
            }
        });
    }

    // ==========================
    // INITIALIZE APP
    // ==========================

    // Load rules first (for sidebar), then load files to populate views
    loadRules();
    loadFiles();
});
