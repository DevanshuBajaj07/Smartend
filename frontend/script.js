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
    // VIEW TOGGLING (FOLDERS <-> FILES)
    // ==========================

    // Decide which view to show based on currentFolder value
    function renderView() {
        const inFolder = !!currentFolder; // true when user is inside a folder

        // Update breadcrumb / label
        if (UI.currentFolderLabel) {
            UI.currentFolderLabel.textContent = inFolder
                ? currentFolder
                : "Folders";
        }

        // Back button only enabled when inside a folder
        if (UI.backToFoldersBtn) {
            UI.backToFoldersBtn.disabled = !inFolder;
        }

        // Toggle the DOM views and render appropriate data
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

    // Delegate click events inside the file table (Download / Delete buttons)
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
    // SEARCH & SORT CONTROLS
    // ==========================

    // Re-render current view (folder grid or file table) when filters change
    function refreshFromControls() {
        if (currentFolder) {
            renderFilesInFolder();
        } else {
            renderFolders();
        }
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
