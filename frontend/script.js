// Change BACKEND to your EC2 IP if needed:
const BACKEND = "http://127.0.0.1:5000";

document.addEventListener("DOMContentLoaded", () => {
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
    };

    let allFiles = [];
    let customRules = {};
    let currentFolder = null; // null = folder view; string = folder name

    // ==========================
    // Helpers
    // ==========================
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
                    return (a.size_bytes || a.totalSize || 0) -
                           (b.size_bytes || b.totalSize || 0);
                case "size-desc":
                    return (b.size_bytes || b.totalSize || 0) -
                           (a.size_bytes || a.totalSize || 0);
                case "created-new":
                case "access-new": {
                    const da = isFolderView ? a.lastActivity : parseDate(a.created_time || a.last_access_time);
                    const db = isFolderView ? b.lastActivity : parseDate(b.created_time || b.last_access_time);
                    return (db || 0) - (da || 0);
                }
                case "created-old":
                case "access-old": {
                    const da2 = isFolderView ? a.lastActivity : parseDate(a.created_time || a.last_access_time);
                    const db2 = isFolderView ? b.lastActivity : parseDate(b.created_time || b.last_access_time);
                    return (da2 || 0) - (db2 || 0);
                }
                default:
                    return 0;
            }
        });
    }

    // ==========================
    // STATUS
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
        } catch (e) {
            UI.status.textContent = "Offline";
            UI.status.className = "status-badge status-offline";
        }
    }
    updateStatus();
    setInterval(updateStatus, 5000);

    // ==========================
    // DATA LOADING
    // ==========================
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
    // FOLDER VIEW
    // ==========================
    function renderFolders() {
        if (!UI.folderGrid) return;
        UI.folderGrid.innerHTML = "";

        const search = UI.searchInput
            ? UI.searchInput.value.trim().toLowerCase()
            : "";

        // accumulate stats per folder
        const folderMap = new Map();
        for (const f of allFiles) {
            const folder = f.category || "Uncategorized";
            if (!folderMap.has(folder)) {
                folderMap.set(folder, {
                    name: folder,
                    count: 0,
                    totalSize: 0,
                    lastActivity: null,
                });
            }
            const entry = folderMap.get(folder);
            entry.count += 1;
            entry.totalSize += f.size_bytes || 0;
            const la = latestActivity(f);
            if (!entry.lastActivity || (la && la > entry.lastActivity)) {
                entry.lastActivity = la;
            }
        }

        let folders = Array.from(folderMap.values());

        if (search) {
            folders = folders.filter((f) =>
                f.name.toLowerCase().includes(search)
            );
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

            card.innerHTML = `
                <div class="folder-icon">📁</div>
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

        let list = allFiles.filter(
            (f) => f.category === currentFolder
        );

        if (search) {
            list = list.filter((f) =>
                f.name.toLowerCase().includes(search)
            );
        }

        const sort = UI.sortSelect ? UI.sortSelect.value : "name-asc";
        applySort(sort, list, false);

        if (!list.length) {
            const tr = document.createElement("tr");
            tr.className = "empty-row";
            tr.innerHTML =
                '<td colspan="7">No files in this folder yet.</td>';
            UI.fileTableBody.appendChild(tr);
            return;
        }

        list.forEach((file) => {
            const tr = document.createElement("tr");
            tr.dataset.relpath = file.relative_path;

            tr.innerHTML = `
                <td class="col-name">${file.name}</td>
                <td>${file.category}</td>
                <td>${getExtension(file.name)}</td>
                <td>${formatSize(file.size_bytes)}</td>
                <td>${formatDate(file.created_time)}</td>
                <td>${formatDate(file.last_access_time)}</td>
                <td>
                    <button class="btn-small btn-download">Download</button>
                    <button class="btn-small btn-danger">Delete</button>
                </td>
            `;

            UI.fileTableBody.appendChild(tr);
        });
    }

    // ==========================
    // TOGGLE VIEW
    // ==========================
    function renderView() {
        const inFolder = !!currentFolder;

        if (UI.currentFolderLabel) {
            UI.currentFolderLabel.textContent = inFolder
                ? currentFolder
                : "Folders";
        }
        if (UI.backToFoldersBtn) {
            UI.backToFoldersBtn.disabled = !inFolder;
        }

        if (UI.folderView && UI.fileView) {
            if (inFolder) {
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
    // UPLOAD
    // ==========================
    async function uploadFiles(files) {
        if (!files || !files.length) return;

        const form = new FormData();
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

            await loadFiles();
        } catch (e) {
            console.error("Upload error:", e);
            alert("Upload failed due to a network error.");
        }
    }

    // Drag & drop
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

    // Browse
    if (UI.browseBtn && UI.fileInput) {
        UI.browseBtn.addEventListener("click", () => UI.fileInput.click());
        UI.fileInput.addEventListener("change", () =>
            uploadFiles(UI.fileInput.files)
        );
    }

    // ==========================
    // DOWNLOAD & DELETE
    // ==========================
    async function handleDownload(relpath) {
        try {
            const head = await fetch(
                `${BACKEND}/download?path=${encodeURIComponent(relpath)}`,
                { method: "HEAD" }
            );
            if (!head.ok) {
                alert("Download failed: file not found.");
                return;
            }
            window.location.href = `${BACKEND}/download?path=${encodeURIComponent(
                relpath
            )}`;
        } catch (e) {
            alert("Download failed due to a network error.");
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
                alert(data.message || "Delete failed.");
            } else {
                console.log("Delete OK:", data);
            }

            await loadFiles();
        } catch (e) {
            console.error("Delete error:", e);
            alert("Delete failed due to a network error.");
        }
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
            }
        });
    }

    // ==========================
    // SEARCH & SORT
    // ==========================
    function refreshFromControls() {
        if (currentFolder) {
            renderFilesInFolder();
        } else {
            renderFolders();
        }
    }

    if (UI.searchInput) {
        UI.searchInput.addEventListener("input", refreshFromControls);
    }
    if (UI.sortSelect) {
        UI.sortSelect.addEventListener("change", refreshFromControls);
    }

    // ==========================
    // BACK TO FOLDERS
    // ==========================
    if (UI.backToFoldersBtn) {
        UI.backToFoldersBtn.addEventListener("click", () => {
            currentFolder = null;
            renderView();
        });
    }

    // ==========================
    // RULES
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
                alert("Please enter both folder name and extensions.");
                return;
            }

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
                    customRules = data.custom_rules || {};
                    renderRules();
                    UI.ruleFolder.value = "";
                    UI.ruleExtensions.value = "";
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
    // INIT
    // ==========================
    loadRules();
    loadFiles();
});
